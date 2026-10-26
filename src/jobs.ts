import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import type { Writable } from 'node:stream';

import { CHANGE, CHANGE_HELP, changeOptions, confirmations, makeChange, reportChange } from './changes.js';
import { type Command, CONNECTION, CONNECTION_HELP, onePositional, parse, parseCount, UsageError } from './command.js';
import { withSession } from './context.js';
import { csv, formatCount, labelled, paint, print, printJson, printJsonLines, say, stateColor, table, terminalWidth, useColor } from './output.js';
import { streamOfSql } from './query.js';
import { streamType } from './streams.js';
import { ago, formatDuration, minute, parseDuration, timeWindow } from './time.js';
import type { ToolSession } from './tools.js';

/** A search job as MoleSignal keeps it. */
export interface SearchJob {
  id: string;
  state?: string | undefined;
  attempt?: number | undefined;
  result_rows?: number | null | undefined;
  error?: string | null | undefined;
  request?: { statement?: string; language?: string } | undefined;
  submitted_at?: number | undefined;
  started_at?: number | null | undefined;
  finished_at?: number | null | undefined;
  expires_at?: number | null | undefined;
}

/** The jobs of a `list_search_jobs` or `get_search_job` result. */
export function jobsOf(result: unknown): SearchJob[] {
  const jobs = result && typeof result === 'object' && 'jobs' in result ? (result.jobs as unknown) : undefined;
  return Array.isArray(jobs) ? jobs.filter((job): job is SearchJob => typeof job?.id === 'string') : [];
}

const FINISHED = new Set(['done', 'failed', 'cancelled']);

/** Jobs as a table: id, state, rows, age and statement. */
export function formatJobs(jobs: SearchJob[], options: { color?: boolean; width?: number | undefined; now?: number } = {}): string[] {
  const color = options.color ?? false;
  const rows = jobs.map((job) => [
    job.id,
    paint(color, stateColor(job.state ?? ''), job.state ?? ''),
    typeof job.result_rows === 'number' ? formatCount(job.result_rows) : '',
    job.submitted_at ? ago(job.submitted_at, options.now) : '',
    (job.request?.statement ?? '').replace(/\s+/g, ' '),
  ]);
  return table(['JOB', 'STATE', 'ROWS', 'SUBMITTED', 'STATEMENT'], rows, options);
}

async function getJob(session: ToolSession, id: string): Promise<SearchJob> {
  const job = jobsOf(await session.read('get_search_job', { job_id: id }))[0];
  if (!job) throw new Error(`No search job ${id}`);
  return job;
}

/** Writes a job's whole result, page by page: one JSON object a line, or CSV. */
export async function downloadResults(
  session: ToolSession,
  id: string,
  out: Writable,
  format: 'json' | 'csv',
): Promise<number> {
  let page = 1;
  let written = 0;
  let columns: string[] | undefined;
  const write = async (text: string) => {
    if (!out.write(text)) await once(out, 'drain');
  };

  for (;;) {
    const result = (await session.read('get_search_job_results', { job_id: id, page, page_size: 1000 })) as {
      state?: string;
      rows?: Record<string, unknown>[];
      has_more?: boolean;
      error?: string | null;
    };
    if (page === 1 && result.state !== 'done') {
      const how = result.state === 'failed' ? 'failed' : `is ${result.state ?? 'not done'}`;
      throw new Error(`Search job ${id} ${how}${result.error ? `: ${result.error}` : ''}; it has no result to download`);
    }
    const rows = result.rows ?? [];
    if (format === 'csv') {
      if (!columns) {
        columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
        await write(`${csv(columns, [])[0]}\n`);
      }
      const lines = csv(columns, rows.map((row) => columns!.map((column) => row[column]))).slice(1);
      if (lines.length) await write(`${lines.join('\n')}\n`);
    } else {
      for (const row of rows) await write(`${JSON.stringify(row)}\n`);
    }
    written += rows.length;
    if (!result.has_more || rows.length === 0) return written;
    page += 1;
  }
}

const usage = `Usage: molesignal search-jobs [options]
       molesignal search-jobs submit "<statement>" [options]
       molesignal search-jobs show <job>
       molesignal search-jobs results <job> [-o <file>] [--csv]
       molesignal search-jobs cancel <job>

Search jobs run long queries in the background, over more data and more
time than a query on the spot, and keep their result for a while. Submitting
or cancelling one goes through MoleSignal's tool policy.

Options:
  --stream <stream>     With submit: the stream (default: the first one after FROM)
  --type <type>         With submit: the stream's kind, logs (default), traces, metrics…
  --promql              With submit: the statement is PromQL, not SQL
  --since <duration>    With submit: how far back it reads (default 1d)
  --from <time>         With submit: start at a time instead
  --to <time>           With submit: end at a time instead of now
  --limit <rows>        With submit: the most rows it keeps (at most 100000)
  --keep <duration>     With submit: how long the result is kept (default the server's)
  -o, --output <file>   With results: write to a file instead of stdout
  --csv                 With results: write CSV instead of one JSON object a line
  -n <count>            How many jobs to list (default 50, at most 200)
  --json                Print JSON
${CHANGE_HELP}
  (with submit, --wait also waits for the job to finish)
${CONNECTION_HELP}

Example:
  molesignal search-jobs submit "SELECT * FROM app_logs WHERE level = 'error'" --since 30d --wait
  molesignal search-jobs results <job> --csv -o errors.csv`;

export const searchJobsCommand: Command = {
  name: 'search-jobs',
  group: 'Logs and queries',
  summary: 'Long queries in the background: submit, follow, download, cancel',
  usage,

  async run(args) {
    const { values, positionals } = parse('search-jobs', args, {
      ...CONNECTION,
      ...CHANGE,
      stream: { type: 'string' },
      type: { type: 'string' },
      promql: { type: 'boolean' },
      since: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      limit: { type: 'string' },
      keep: { type: 'string' },
      output: { type: 'string', short: 'o' },
      csv: { type: 'boolean' },
      count: { type: 'string', short: 'n' },
      json: { type: 'boolean' },
    });
    const [action, ...rest] = positionals;
    const color = useColor();

    if (action === 'submit') {
      const statement = rest.join(' ').trim();
      if (!statement) throw new UsageError('Which statement? Run `molesignal search-jobs submit "SELECT … FROM <stream>"`');
      const stream = values.promql ? undefined : (values.stream ?? streamOfSql(statement));
      if (!values.promql && !stream) throw new UsageError('Which stream does it read? Add --stream <stream>');
      const request = {
        language: values.promql ? 'promql' : 'sql',
        statement,
        time_range: timeWindow(values, '1d'),
        ...(stream ? { stream: { name: stream, stream_type: streamType(values.type) } } : {}),
        ...(values.limit ? { limit: parseCount(values.limit, '--limit', 100_000) } : {}),
        ...(values.keep ? { ttl_secs: Math.round(parseDuration(values.keep) / 1000) } : {}),
      };

      return withSession(
        values,
        async (session, signed) => {
          const options = changeOptions(values, signed.credentials.connection.url, {
            reason: 'Search job from the molesignal command line',
            impact: 'Runs the query in the background and keeps its result for download',
          });
          const outcome = await makeChange(session, 'submit_search_job', request, options);
          if (outcome.state === 'pending') return reportChange(outcome, '', options);

          const id = outcome.execution.target;
          if (!id) throw new Error('MoleSignal submitted the job without saying its id: `molesignal search-jobs` lists it');
          say(`Submitted search job ${id}`);
          if (!values.wait) {
            print(id);
            return 0;
          }

          const deadline = Date.now() + parseDuration(values.timeout ?? '30m');
          let job = await getJob(session, id);
          while (!FINISHED.has(job.state ?? '') && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 3000));
            job = await getJob(session, id);
          }
          if (!FINISHED.has(job.state ?? '')) {
            say(`Search job ${id} is still ${job.state}; \`molesignal search-jobs show ${id}\` follows it`);
            return 1;
          }
          if (job.state !== 'done') {
            say(`Search job ${id} ${job.state}${job.error ? `: ${job.error}` : ''}`);
            return 1;
          }
          say(`Search job ${id} done: ${formatCount(job.result_rows ?? 0)} rows; \`molesignal search-jobs results ${id}\` downloads them`);
          print(id);
          return 0;
        },
        confirmations(values),
      );
    }

    if (action === 'cancel') {
      const id = onePositional('search-jobs', rest, 'search job');
      return withSession(
        values,
        async (session, signed) => {
          const options = changeOptions(values, signed.credentials.connection.url, {
            reason: 'Cancelled from the molesignal command line',
            impact: `Search job ${id} stops and keeps no result`,
          });
          return reportChange(await makeChange(session, 'cancel_search_job', { job_id: id }, options), `Cancelled search job ${id}`, options);
        },
        confirmations(values),
      );
    }

    if (action === 'show') {
      const id = onePositional('search-jobs', rest, 'search job');
      const job = await withSession(values, (session) => getJob(session, id));
      if (values.json) {
        printJson(job);
        return;
      }
      const lines = [`${job.id} · ${paint(color, stateColor(job.state ?? ''), job.state ?? '')}`];
      const field = (name: string, value: string | undefined) => {
        if (value) lines.push(labelled(name, value, 12));
      };
      field('Statement', job.request?.statement);
      field('Rows', typeof job.result_rows === 'number' ? String(job.result_rows) : undefined);
      field('Submitted', job.submitted_at ? minute(job.submitted_at) : undefined);
      field('Took', job.started_at && job.finished_at ? formatDuration((job.finished_at - job.started_at) / 1000) : undefined);
      field('Kept until', job.expires_at ? minute(job.expires_at) : undefined);
      field('Error', job.error ?? undefined);
      print(lines);
      return;
    }

    if (action === 'results') {
      const id = onePositional('search-jobs', rest, 'search job');
      const out = values.output ? createWriteStream(values.output) : process.stdout;
      const rows = await withSession(values, (session) => downloadResults(session, id, out, values.csv ? 'csv' : 'json'));
      if (values.output) {
        out.end();
        await once(out, 'finish');
        say(`Wrote ${rows} rows to ${values.output}`);
      }
      return;
    }

    if (action) throw new UsageError(`Unknown "${action}": use submit, show, results or cancel`);

    const limit = parseCount(values.count ?? '50', '-n', 200);
    const jobs = await withSession(values, async (session) => jobsOf(await session.read('list_search_jobs', { limit })));
    if (values.json) printJsonLines(jobs);
    else if (jobs.length === 0) say('No search jobs');
    else print(formatJobs(jobs, { color, width: terminalWidth() }));
  },
};
