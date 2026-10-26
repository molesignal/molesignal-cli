import { type Command, CONNECTION, CONNECTION_HELP, parse, parseCount, splitList, UsageError } from './command.js';
import { signedIn, withSession } from './context.js';
import { fieldQuerySql } from './fieldQuery.js';
import { paint, print, say, stateColor, useColor } from './output.js';
import { clock, parseDuration, parseTime } from './time.js';
import { ToolError, ToolSession } from './tools.js';
import { VERSION } from './version.js';
import { logsPage, openInBrowser, timeParam } from './web.js';

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
  /** The fields to read; all of them when none are named. */
  fields?: string[] | undefined;
  /** How far back the first read goes, in milliseconds. */
  since: number;
  /** Where the first read starts and ends, in microseconds, instead of `since` back from now. */
  from?: number | undefined;
  to?: number | undefined;
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

/** A stream or field name as an SQL identifier. */
export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** The SQL of one read: the newest logs first, or, when following, the oldest first. */
export function logsSql(
  stream: string,
  where: string | undefined,
  order: 'newest' | 'oldest',
  limit: number,
  fields?: string[] | undefined,
): string {
  const columns = fields?.length ? ['_timestamp', ...fields.filter((field) => field !== '_timestamp')].map(quoteIdent).join(', ') : '*';
  const condition = where?.trim() ? ` WHERE (${where.trim()})` : '';
  const direction = order === 'newest' ? 'DESC' : 'ASC';
  return `SELECT ${columns} FROM ${quoteIdent(stream)}${condition} ORDER BY _timestamp ${direction} LIMIT ${limit}`;
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

  const end = options.to ?? now();
  const start = options.from ?? end - Math.round(options.since * 1000);
  const first = rowsOf(
    await tools.call('query_logs', {
      stream: options.stream,
      sql: logsSql(options.stream, options.where, 'newest', options.lines, options.fields),
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
        sql: logsSql(options.stream, options.where, 'oldest', batch, options.fields),
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

/** The logs just before and after a moment, as `search_around` returns them, oldest first. */
export async function readAround(
  tools: LogTools,
  options: { stream: string; at: number; before: number; after: number; where?: string | undefined },
): Promise<{ before: LogRow[]; after: LogRow[] }> {
  const result = await tools.call('call_read_tool', {
    name: 'search_around',
    arguments: {
      stream: options.stream,
      anchor_micros: options.at,
      before: options.before,
      after: options.after,
      ...(options.where?.trim() ? { filter_sql: options.where.trim() } : {}),
    },
  });
  const rows = (key: 'before' | 'after') =>
    isRow(result) && Array.isArray(result[key]) ? (result[key] as unknown[]).filter(isRow) : [];
  return { before: rows('before'), after: rows('after') };
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

/** `name=value`, the value quoted when it holds spaces, quotes or `=`. */
const pair = (key: string, value: unknown) => {
  const shown = text(value);
  return `${key}=${/[\s"=]/.test(shown) ? JSON.stringify(shown) : shown}`;
};

/**
 * One log as one line: its time, level and service, then its message. A log
 * without a message field shows its other fields as `name=value`; with
 * `fields`, the line is the time and those fields.
 */
export function formatLog(
  row: LogRow,
  options: { color?: boolean; utc?: boolean; fields?: string[] | undefined } = {},
): string {
  const color = options.color ?? false;
  const parts = [paint(color, '90', clock(timeOf(row), options.utc ?? false))];

  if (options.fields?.length) {
    for (const field of options.fields) {
      if (field !== '_timestamp' && row[field] !== undefined && row[field] !== null) parts.push(pair(field, row[field]));
    }
    return parts.join(' ');
  }

  const used = new Set(['_timestamp']);
  const level = pick(row, LEVEL_FIELDS);
  if (level) {
    used.add(level[0]);
    const name = text(level[1]).toUpperCase();
    parts.push(paint(color, stateColor(name) === '32' ? undefined : stateColor(name), name.padEnd(5)));
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
      .map(([key, value]) => pair(key, value));
    parts.push(rest.join(' '));
  }

  return parts.join(' ');
}

/** The condition of `--where` and `-q` together: both must hold. */
export function logCondition(where: string | undefined, query: string | undefined): string | undefined {
  const conditions = [where?.trim(), query?.trim() ? fieldQuerySql(query) : undefined].filter(
    (condition): condition is string => Boolean(condition),
  );
  if (conditions.length === 0) return undefined;
  return conditions.length === 1 ? conditions[0] : conditions.map((condition) => `(${condition})`).join(' AND ');
}

export const logsCommand: Command = {
  name: 'logs',
  group: 'Logs and queries',
  summary: "Print a stream's newest logs; -f keeps printing new ones",
  usage: `Usage: molesignal logs <stream> [options]

Prints the newest logs of a stream, oldest first, one a line: time, level,
service and message.

Options:
  -f, --follow            Keep printing new logs until Ctrl+C
  -n, --lines <count>     How many of the newest logs to print first (default 100, at most 5000)
  -q, --query <query>     A field query as the Logs page takes it: level = 'error' AND timeout
  --where <condition>     An SQL condition the logs must meet, such as "level = 'error'"
  --since <duration>      How far back to look: 30s, 10m, 2h, 1d (default 15m)
  --from <time>           Start at a time instead: 2026-10-26 14:00, an ISO time, or 2h (ago)
  --to <time>             End at a time instead of now (not with --follow)
  --fields <a,b,c>        Print only these fields
  --around <time>         Print the logs just before and after a moment instead
  -B, --before <count>    With --around: how many logs before it (default 10, at most 250)
  -A, --after <count>     With --around: how many logs after it (default 10, at most 250)
  --interval <duration>   How often a follow looks for new logs (default 2s)
  --json                  Print each log as one line of JSON
  --utc                   Print times in UTC instead of local time
  --web                   Open the logs in the Logs page instead
${CONNECTION_HELP}

Examples:
  molesignal logs app_logs -f -q "level = 'error'"
  molesignal logs app_logs --since 2h -q 'timeout AND service = "checkout"'
  molesignal logs app_logs --around "2026-10-26 14:03:12" -B 20 -A 20
  molesignal logs app_logs -n 1000 --json | jq .message`,

  async run(args) {
    const { values, positionals } = parse('logs', args, {
      ...CONNECTION,
      follow: { type: 'boolean', short: 'f' },
      lines: { type: 'string', short: 'n' },
      query: { type: 'string', short: 'q' },
      since: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      where: { type: 'string' },
      fields: { type: 'string' },
      around: { type: 'string' },
      before: { type: 'string', short: 'B' },
      after: { type: 'string', short: 'A' },
      interval: { type: 'string' },
      json: { type: 'boolean' },
      utc: { type: 'boolean' },
      web: { type: 'boolean' },
    });

    const [stream, ...extra] = positionals;
    if (!stream || extra.length > 0) {
      throw new UsageError('Which stream? Run `molesignal logs <stream>`; `molesignal streams` lists them');
    }
    if (values.follow && values.to) throw new UsageError('--to and --follow do not go together: a follow has no end');
    if (values.around && values.follow) throw new UsageError('--around and --follow do not go together');

    const where = logCondition(values.where, values.query);
    const fields = splitList(values.fields);
    const now = Date.now() * 1000;
    const from = values.from ? parseTime(values.from, now) : undefined;
    const to = values.to ? parseTime(values.to, now) : undefined;
    const since = parseDuration(values.since ?? '15m');

    if (values.web) {
      const signed = await signedIn(values);
      const url = logsPage(signed.credentials.connection.url, {
        stream,
        ...(values.where ? { sql: `SELECT * FROM ${quoteIdent(stream)} WHERE ${where}` } : { query: values.query }),
        time: timeParam({ since, from, to }),
      });
      say(`Opening ${url}`);
      openInBrowser(url);
      return;
    }

    const color = useColor();
    const write = (row: LogRow) =>
      values.json ? JSON.stringify(row) : formatLog(row, { color, utc: values.utc ?? false, fields });

    if (values.around) {
      const at = parseTime(values.around, now);
      const around = await withSession(values, (session) =>
        readAround(session, {
          stream,
          at,
          before: parseCount(values.before ?? '10', '--before', 250),
          after: parseCount(values.after ?? '10', '--after', 250),
          where,
        }),
      );
      print(around.before.map(write));
      if (!values.json) print(paint(color, '90', `── ${clock(at, values.utc ?? false)} ──`));
      print(around.after.map(write));
      return;
    }

    const options: LogsOptions = {
      stream,
      where,
      fields,
      since,
      from,
      to,
      lines: parseCount(values.lines ?? '100', '--lines', 5000),
      follow: values.follow ?? false,
      interval: parseDuration(values.interval ?? '2s'),
    };

    const signed = await signedIn(values);
    let session = await ToolSession.open(signed.credentials, VERSION);

    // Ctrl+C, or a reader such as `head` that has read enough, ends a follow quietly.
    const stop = new AbortController();
    const quit = () => stop.abort();
    process.once('SIGINT', quit);
    process.once('SIGTERM', quit);
    process.stdout.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE') quit();
    });

    const tools: LogTools = {
      call: (name, input) => session.call(name, input),
      reconnect: async () => {
        await session.close().catch(() => undefined);
        session = await ToolSession.open(signed.credentials, VERSION);
      },
    };

    try {
      await readLogs(tools, options, {
        write: (row) => {
          if (!stop.signal.aborted) process.stdout.write(`${write(row)}\n`);
        },
        notice: say,
        signal: stop.signal,
      });
    } finally {
      process.off('SIGINT', quit);
      process.off('SIGTERM', quit);
      await session.close().catch(() => undefined);
    }
  },
};
