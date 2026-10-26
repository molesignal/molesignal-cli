import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

import { type Command, CONNECTION, CONNECTION_HELP, keyValues, parse, parseCount, UsageError } from './command.js';
import { type Api, apiAccess } from './context.js';
import { signalStatus } from './deploy.js';
import { say } from './output.js';
import { ApiError, apiRequest } from './rest.js';
import { formatDuration } from './time.js';

/** One log as intake takes it: fields by name, `_timestamp` in microseconds when it has one. */
export type IntakeLog = Record<string, unknown>;

/** The most a batch holds before it is sent: logs, bytes, and time since its first log. */
const BATCH_BYTES = 1024 * 1024;
const BATCH_WAIT_MS = 1000;

/** What intake answered for the logs sent. */
interface IntakeResult {
  accepted?: number;
  rejected?: number;
  errors?: { index?: number; reason?: string }[];
}

/**
 * Sends logs to a stream in batches: a batch goes when it is full, a second
 * after its first log, or at the end. A batch that meets a lost connection, a
 * busy server or a rate limit is tried again, three times at most.
 */
export class IntakeSender {
  accepted = 0;
  rejected = 0;
  private batch: IntakeLog[] = [];
  private bytes = 0;
  private timer: NodeJS.Timeout | undefined;
  private sending: Promise<void> = Promise.resolve();
  private failure: Error | undefined;

  constructor(
    private readonly send: (records: IntakeLog[]) => Promise<IntakeResult>,
    private readonly size = 500,
    private readonly notice: (line: string) => void = say,
  ) {}

  /** Adds a log; the batch goes when it is full. */
  add(record: IntakeLog): void {
    if (this.failure) throw this.failure;
    this.batch.push(record);
    this.bytes += JSON.stringify(record).length + 1;
    if (this.batch.length >= this.size || this.bytes >= BATCH_BYTES) this.flush();
    else this.timer ??= setTimeout(() => this.flush(), BATCH_WAIT_MS);
  }

  /** Sends what is waiting, after the batches before it. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.batch.length === 0) return this.sending;
    const records = this.batch;
    this.batch = [];
    this.bytes = 0;
    this.sending = this.sending.then(() => this.deliver(records));
    return this.sending;
  }

  /** Sends the rest and says how it went; throws when a batch could not be sent at all. */
  async close(): Promise<void> {
    await this.flush();
    if (this.failure) throw this.failure;
  }

  private async deliver(records: IntakeLog[]): Promise<void> {
    if (this.failure) return;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const result = await this.send(records);
        this.accepted += result.accepted ?? records.length;
        this.rejected += result.rejected ?? 0;
        for (const error of result.errors?.slice(0, 3) ?? []) this.notice(`log ${error.index ?? '?'} was rejected: ${error.reason ?? ''}`);
        return;
      } catch (error) {
        const retry = !(error instanceof ApiError) || error.status === 429 || error.status >= 500;
        if (!retry || attempt >= 3) {
          this.failure = error as Error;
          return;
        }
        this.notice(`sending failed (${(error as Error).message}); trying again`);
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      }
    }
  }
}

/** A line of input as a log: a JSON object as it is, any other line as its message. */
export function lineRecord(line: string, options: { raw?: boolean | undefined; fields?: Record<string, string> | undefined }): IntakeLog {
  let record: IntakeLog | undefined;
  if (!options.raw && line.trimStart().startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) record = parsed as IntakeLog;
    } catch {
      // Not JSON after all: the line is the message.
    }
  }
  record ??= { message: line };
  return { ...options.fields, ...record };
}

/** The time now in microseconds, a microsecond on from the last one given, so lines keep their order. */
function clockFrom(): () => number {
  let last = 0;
  return () => {
    last = Math.max(Date.now() * 1000, last + 1);
    return last;
  };
}

/** The sending side of intake for a stream. */
function intakeTo(api: Api, stream: string): (records: IntakeLog[]) => Promise<IntakeResult> {
  return async (records) =>
    ((await apiRequest(api, 'POST', `/intake/logs/${encodeURIComponent(stream)}`, { json: records })) ?? {}) as IntakeResult;
}

/** Reads the lines of a stream, each as it comes. */
async function* lines(input: Readable): AsyncGenerator<string> {
  const reader = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of reader) yield line;
}

export const sendCommand: Command = {
  name: 'send',
  group: 'Releases and data (API token)',
  summary: 'Write lines or JSON from stdin into a log stream',
  usage: `Usage: <command> | molesignal send <stream> [options]

Sends each line of stdin to a log stream: a line that is a JSON object as
its fields, any other line as its message. Logs go in batches as they come,
so it can follow a file (tail -f). Needs an API token whose role holds
streams.write, such as an intake token.

Options:
  --field <name=value>   Add a field to every log; may be given more than once
  --raw                  Send every line as a message, JSON or not
  --batch <count>        The most logs in one request (default 500, at most 5000)
${CONNECTION_HELP}

Examples:
  tail -f /var/log/app.log | molesignal send app_logs --field service=billing
  kubectl logs deploy/checkout --since 1h | molesignal send k8s_logs --field cluster=prod`,

  async run(args) {
    const { values, positionals } = parse('send', args, {
      ...CONNECTION,
      field: { type: 'string', multiple: true },
      raw: { type: 'boolean' },
      batch: { type: 'string' },
    });
    const [stream, ...extra] = positionals;
    if (!stream || extra.length > 0) throw new UsageError('Which stream? Run `molesignal send <stream>`');
    if (process.stdin.isTTY) say('Reading logs from the terminal; Ctrl+D ends');

    const api = await apiAccess(values);
    const fields = keyValues(values.field, '--field');
    const sender = new IntakeSender(intakeTo(api, stream), parseCount(values.batch ?? '500', '--batch', 5000));
    const now = clockFrom();

    for await (const line of lines(process.stdin)) {
      if (!line.trim()) continue;
      const record = lineRecord(line, { raw: values.raw, fields });
      sender.add('_timestamp' in record ? record : { _timestamp: now(), ...record });
    }
    await sender.close();
    say(`Sent ${sender.accepted} log${sender.accepted === 1 ? '' : 's'} to ${stream}${sender.rejected ? `; ${sender.rejected} rejected` : ''}`);
    return sender.rejected > 0 ? 1 : 0;
  },
};

export const runCommand: Command = {
  name: 'run',
  group: 'Releases and data (API token)',
  summary: 'Run a command; send its output and how it ended to a log stream',
  usage: `Usage: molesignal run <stream> [options] -- <command>…

Runs the command, shows its output as usual, and sends each line of it to a
log stream, then one more log with how it ended: its exit status and how
long it took. Exits as the command did. For cron jobs, backups and scripts
whose output should outlive the machine. Needs an API token whose role holds
streams.write.

Each log has: message, output (stdout or stderr), command, run_id, host.

Options:
  --name <name>          What the command is called in the logs (default: the command line)
  --field <name=value>   Add a field to every log; may be given more than once
  --quiet                Do not show the command's output here
${CONNECTION_HELP}

Example:
  molesignal run jobs --name nightly-backup -- ./backup.sh --full`,

  async run(args) {
    const end = args.indexOf('--');
    if (end < 0 || end === args.length - 1) throw new UsageError('Which command? Put it after --: `molesignal run <stream> -- <command>`');
    const command = args.slice(end + 1);
    const { values, positionals } = parse('run', args.slice(0, end), {
      ...CONNECTION,
      name: { type: 'string' },
      field: { type: 'string', multiple: true },
      quiet: { type: 'boolean' },
    });
    const [stream, ...extra] = positionals;
    if (!stream || extra.length > 0) throw new UsageError('Which stream? Run `molesignal run <stream> -- <command>`');

    const api = await apiAccess(values);
    const base = {
      ...keyValues(values.field, '--field'),
      command: values.name ?? command.join(' '),
      run_id: randomUUID(),
      host: hostname(),
    };
    const sender = new IntakeSender(intakeTo(api, stream));
    const now = clockFrom();
    const started = Date.now();

    const child = spawn(command[0]!, command.slice(1), { stdio: ['inherit', 'pipe', 'pipe'] });
    const stay = () => undefined;
    const pass = () => child.kill('SIGTERM');
    process.on('SIGINT', stay);
    process.on('SIGTERM', pass);

    // Once sending has failed, the output is still shown and read to its end, so the command never
    // waits on a full pipe; the failure is said once it has ended.
    const follow = async (input: Readable, output: 'stdout' | 'stderr') => {
      for await (const line of lines(input)) {
        if (!values.quiet) (output === 'stdout' ? process.stdout : process.stderr).write(`${line}\n`);
        try {
          sender.add({ _timestamp: now(), ...base, output, message: line });
        } catch {
          // Said by close().
        }
      }
    };

    const status = await new Promise<number>((resolve, reject) => {
      const reading = Promise.all([follow(child.stdout, 'stdout'), follow(child.stderr, 'stderr')]);
      child.on('error', (error) => reject(new Error(`Could not run ${command[0]}: ${error.message}`)));
      child.on('close', (code, signal) => {
        void reading.then(() => resolve(code ?? signalStatus(signal)), reject);
      });
    }).finally(() => {
      process.off('SIGINT', stay);
      process.off('SIGTERM', pass);
    });

    const took = Date.now() - started;
    try {
      sender.add({
        _timestamp: now(),
        ...base,
        message: `${base.command} exited with ${status} after ${formatDuration(took)}`,
        level: status === 0 ? 'info' : 'error',
        exit_code: status,
        duration_ms: took,
      });
      await sender.close();
    } catch (error) {
      say(`molesignal: the output did not all reach ${stream}: ${(error as Error).message}`);
    }
    return status;
  },
};
