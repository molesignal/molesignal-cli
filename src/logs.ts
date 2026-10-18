import { ToolError } from './tools.js';

/** One log, by field name, as `query_logs` returns it. */
export type LogRow = Record<string, unknown>;

/** What reads logs: a tool session, or a stand-in in tests. */
export interface LogTools {
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** Opens a new session after the connection to MoleSignal was lost. */
  reconnect?: () => Promise<void>;
}

export interface LogsOptions {
  stream: string;
  /** An SQL condition the logs must meet, such as `level = 'error'`. */
  where?: string | undefined;
  /** How far back the first read goes, in milliseconds. */
  since: number;
  /** How many of the newest logs the first read prints. */
  lines: number;
  /** Keep reading new logs until stopped. */
  follow: boolean;
  /** How long a follow waits between reads, in milliseconds. */
  interval: number;
}

export interface LogsIo {
  write: (row: LogRow) => void;
  /** Says something about the follow itself, such as a lost connection. */
  notice?: (line: string) => void;
  /** Stops a follow. */
  signal?: AbortSignal;
  /** The time now, in microseconds since the epoch. */
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** How far before the end of the last read the next one starts again, for logs that arrive late. */
export const OVERLAP_MICROS = 10_000_000;

/** How many logs one read of a follow asks for, and the least it shrinks to when answers are too large. */
const BATCH = 500;
const MIN_BATCH = 20;

/** The longest wait after the connection was lost. */
const MAX_BACKOFF_MS = 30_000;

const UNITS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `30s`, `10m`, `2h` or `1d`, in milliseconds. */
export function parseDuration(text: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(text.trim());
  const value = match ? Number(match[1]) * UNITS[match[2]!]! : Number.NaN;
  if (!(value > 0)) throw new Error(`"${text}" is not a duration: write it as 30s, 10m, 2h or 1d`);
  return value;
}

/** A stream name as an SQL identifier. */
export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** The SQL of one read: the newest logs first, or, when following, the oldest first. */
export function logsSql(stream: string, where: string | undefined, order: 'newest' | 'oldest', limit: number): string {
  const condition = where?.trim() ? ` WHERE (${where.trim()})` : '';
  const direction = order === 'newest' ? 'DESC' : 'ASC';
  return `SELECT * FROM ${quoteIdent(stream)}${condition} ORDER BY _timestamp ${direction} LIMIT ${limit}`;
}

function isRow(value: unknown): value is LogRow {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** The rows of a `query_logs` result as objects, by column name. */
export function rowsOf(result: unknown): LogRow[] {
  if (!isRow(result) || !Array.isArray(result.rows)) return [];
  const columns = Array.isArray(result.columns) ? result.columns.map(String) : undefined;

  return result.rows.flatMap((row: unknown): LogRow[] => {
    if (Array.isArray(row) && columns) {
      return [Object.fromEntries(columns.map((column, index) => [column, row[index]]))];
    }
    return isRow(row) ? [row] : [];
  });
}

/** When a log happened, in microseconds since the epoch. */
export function timeOf(row: LogRow): number {
  const value = row._timestamp;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    if (/^\d+$/.test(value)) return Number(value);
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed * 1000;
  }
  return 0;
}

const byTime = (left: LogRow, right: LogRow) => timeOf(left) - timeOf(right);

/**
 * What a follow has printed and where it reads next. Each read starts a little
 * before the end of the last one, for logs that reach MoleSignal late, and
 * skips what was printed already. A read that comes back full is read on from
 * its last log at once, before waiting again.
 */
export class LogFollower {
  /** Nothing older is printed: where the first read began, or its oldest log when it was cut at its count. */
  private floor: number;
  /** Up to where the logs have been read. */
  private edge: number;
  private draining = false;
  private readonly seen = new Map<string, number>();

  constructor(
    start: number,
    end: number,
    private readonly overlap = OVERLAP_MICROS,
  ) {
    this.floor = start;
    this.edge = end;
  }

  /** Whether the last read came back full, so the next one should not wait. */
  get catchingUp(): boolean {
    return this.draining;
  }

  /** Takes the first read (newest first, at most its count) and returns its logs oldest first. */
  begin(rows: LogRow[], cut: boolean): LogRow[] {
    const sorted = [...rows].sort(byTime);
    if (cut && sorted.length > 0) this.floor = timeOf(sorted[0]!);
    return sorted.filter((row) => this.remember(row));
  }

  /** Where the next read starts and ends, in microseconds. */
  range(now: number): { start_micros: number; end_micros: number } {
    const start = this.draining ? this.edge : Math.max(this.floor, this.edge - this.overlap);
    for (const [key, time] of this.seen) {
      if (time < start) this.seen.delete(key);
    }
    return { start_micros: start, end_micros: Math.max(now, start) };
  }

  /** Takes a read (oldest first) that ended at `end` and returns the logs not printed yet. */
  take(rows: LogRow[], end: number, full: boolean): LogRow[] {
    const sorted = [...rows].sort(byTime);
    const fresh = sorted.filter((row) => timeOf(row) >= this.floor && this.remember(row));

    if (full && sorted.length > 0) {
      const last = timeOf(sorted[sorted.length - 1]!);
      // A full read of logs printed already moves past their time, or it would come back the same.
      this.edge = fresh.length > 0 ? last : last + 1;
      this.draining = true;
    } else {
      this.edge = Math.max(this.edge, end);
      this.draining = false;
    }

    return fresh;
  }

  /** Marks a log printed; false when it was printed already. */
  private remember(row: LogRow): boolean {
    const time = timeOf(row);
    const key = `${time}\u0000${JSON.stringify(row)}`;
    if (this.seen.has(key)) return false;
    this.seen.set(key, time);
    return true;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Whether MoleSignal refused an answer for its size, so a smaller read may pass. */
function tooLarge(error: unknown): boolean {
  return error instanceof ToolError && /exceed|too large|response limit/i.test(error.message);
}

/**
 * Prints the newest logs of a stream, oldest first, and, when following, the
 * ones that arrive after them until stopped. A lost connection is retried; a
 * refusal by MoleSignal (permissions, tool policy, a wrong condition) ends it.
 */
export async function readLogs(tools: LogTools, options: LogsOptions, io: LogsIo): Promise<void> {
  const now = io.now ?? (() => Date.now() * 1000);
  const wait = io.wait ?? sleep;
  const signal = io.signal ?? new AbortController().signal;

  const end = now();
  const start = end - Math.round(options.since * 1000);
  const first = rowsOf(
    await tools.call('query_logs', {
      stream: options.stream,
      sql: logsSql(options.stream, options.where, 'newest', options.lines),
      time_range: { start_micros: start, end_micros: end },
      limit: options.lines,
    }),
  );

  const follower = new LogFollower(start, end);
  for (const row of follower.begin(first, first.length >= options.lines)) io.write(row);
  if (!options.follow) return;

  let batch = BATCH;
  let backoff = 0;

  while (!signal.aborted) {
    if (!follower.catchingUp) await wait(backoff || options.interval, signal);
    if (signal.aborted) break;

    const range = follower.range(now());
    let result: unknown;

    try {
      result = await tools.call('query_logs', {
        stream: options.stream,
        sql: logsSql(options.stream, options.where, 'oldest', batch),
        time_range: range,
        limit: batch,
      });
    } catch (error) {
      if (signal.aborted) break;
      if (tooLarge(error) && batch > MIN_BATCH) {
        batch = Math.max(MIN_BATCH, Math.floor(batch / 2));
        continue;
      }
      if (error instanceof ToolError) throw error;

      // The connection, not MoleSignal's answer: wait longer each time, and start a new session.
      if (!backoff) io.notice?.(`lost the connection to MoleSignal (${(error as Error).message}); trying again`);
      backoff = Math.min(MAX_BACKOFF_MS, backoff ? backoff * 2 : options.interval * 2);
      await tools.reconnect?.().catch(() => undefined);
      continue;
    }

    if (backoff) io.notice?.('connected to MoleSignal again');
    backoff = 0;

    const rows = rowsOf(result);
    for (const row of follower.take(rows, range.end_micros, rows.length >= batch)) io.write(row);
  }
}

const LEVEL_FIELDS = ['level', 'severity', 'severity_text', 'log_level', 'loglevel', 'lvl'];
const SERVICE_FIELDS = ['service', 'service.name', 'service_name', 'app', 'application'];
const MESSAGE_FIELDS = ['message', 'msg', 'body', 'log', '_raw', 'text'];

/** The first of these fields the log has, matched exactly, else ignoring case. */
function pick(row: LogRow, names: string[]): [string, unknown] | undefined {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== null && row[name] !== '') return [name, row[name]];
  }
  const lower = new Map(Object.keys(row).map((key) => [key.toLowerCase(), key]));
  for (const name of names) {
    const key = lower.get(name);
    if (key !== undefined && row[key] !== undefined && row[key] !== null && row[key] !== '') return [key, row[key]];
  }
  return undefined;
}

const text = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));

function clock(micros: number, utc: boolean): string {
  const date = new Date(Math.floor(micros / 1000));
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  const [year, month, day, hours, minutes, seconds, millis] = utc
    ? [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()]
    : [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds()];
  return `${year}-${pad(month)}-${pad(day)} ${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`;
}

function levelColor(level: string): string | undefined {
  if (/^(fatal|crit|critical|emerg|alert|err|error)/i.test(level)) return '31';
  if (/^warn/i.test(level)) return '33';
  if (/^(debug|trace)/i.test(level)) return '90';
  return undefined;
}

const paint = (on: boolean, code: string | undefined, value: string) =>
  on && code ? `\u001b[${code}m${value}\u001b[0m` : value;

/**
 * One log as one line: its time, level and service, then its message. A log
 * without a message field shows its other fields as `name=value`.
 */
export function formatLog(row: LogRow, options: { color?: boolean; utc?: boolean } = {}): string {
  const color = options.color ?? false;
  const parts = [paint(color, '90', clock(timeOf(row), options.utc ?? false))];
  const used = new Set(['_timestamp']);

  const level = pick(row, LEVEL_FIELDS);
  if (level) {
    used.add(level[0]);
    const name = text(level[1]).toUpperCase();
    parts.push(paint(color, levelColor(name), name.padEnd(5)));
  }

  const service = pick(row, SERVICE_FIELDS);
  if (service) {
    used.add(service[0]);
    parts.push(paint(color, '36', text(service[1])));
  }

  const message = pick(row, MESSAGE_FIELDS);
  if (message) {
    parts.push(text(message[1]));
  } else {
    const rest = Object.entries(row)
      .filter(([key, value]) => !used.has(key) && value !== null && value !== undefined && value !== '')
      .map(([key, value]) => {
        const shown = text(value);
        return `${key}=${/[\s"=]/.test(shown) ? JSON.stringify(shown) : shown}`;
      });
    parts.push(rest.join(' '));
  }

  return parts.join(' ');
}
