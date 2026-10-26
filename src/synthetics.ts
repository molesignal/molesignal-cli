import { CHANGE, CHANGE_HELP, changeOptions, confirmations, makeChange, reportChange } from './changes.js';
import { type Command, CONNECTION, CONNECTION_HELP, onePositional, parse, parseCount, UsageError } from './command.js';
import { withSession } from './context.js';
import { paint, print, printJsonLines, say, stateColor, table, terminalWidth, useColor } from './output.js';
import { formatDuration, minute, parseDuration, timeWindow } from './time.js';
import type { ToolSession } from './tools.js';

/** A synthetic check as MoleSignal keeps it. */
export interface Monitor {
  id: string;
  name?: string | undefined;
  kind?: string | undefined;
  lifecycle?: string | undefined;
  state?: string | undefined;
  tags?: string[] | undefined;
  next_due_at?: number | null | undefined;
}

/** One run of a check at one location. */
export interface SyntheticResult {
  id?: string | undefined;
  task_id?: string | undefined;
  location_id?: string | undefined;
  outcome?: string | undefined;
  started_at?: number | undefined;
  finished_at?: number | undefined;
  attempts?: { error_message?: string | null; error_category?: string | null }[] | undefined;
  assertions?: { passed?: boolean; message?: string | null }[] | undefined;
}

/** The outcomes a run passes with. */
const PASSING = new Set(['healthy', 'flaky']);

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object';

/** The items of a result that is a list, or a list under `items`. */
function listOf<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (isObject(value) && Array.isArray(value.items)) return value.items as T[];
  return [];
}

/** Why a run failed, in a line: the error of its last attempt, else its first failed assertion. */
export function failureOf(result: SyntheticResult): string {
  const attempt = result.attempts?.at(-1);
  if (attempt?.error_message) return attempt.error_message;
  if (attempt?.error_category) return attempt.error_category;
  const assertion = result.assertions?.find((one) => one.passed === false);
  return assertion?.message ?? '';
}

/** Runs as a table: location, outcome, how long, when, and why it failed. */
export function formatResults(
  results: SyntheticResult[],
  locations: Map<string, string>,
  options: { color?: boolean; width?: number | undefined } = {},
): string[] {
  const color = options.color ?? false;
  const rows = results.map((result) => [
    locations.get(result.location_id ?? '') ?? result.location_id ?? '',
    paint(color, stateColor(result.outcome ?? ''), result.outcome ?? ''),
    result.started_at && result.finished_at ? formatDuration((result.finished_at - result.started_at) / 1000) : '',
    result.finished_at ? minute(result.finished_at) : '',
    PASSING.has(result.outcome ?? '') ? '' : failureOf(result),
  ]);
  return table(['LOCATION', 'OUTCOME', 'TOOK', 'FINISHED', 'WHY'], rows, options);
}

/** The check a command names: by its id, else by its name, ignoring case. */
async function findMonitor(session: ToolSession, wanted: string): Promise<Monitor> {
  const monitors = listOf<Monitor>(await session.read('list_synthetic_monitors', { limit: 500 }));
  const byId = monitors.find((monitor) => monitor.id === wanted);
  if (byId) return byId;
  const byName = monitors.filter((monitor) => monitor.name?.toLowerCase() === wanted.toLowerCase());
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) throw new Error(`${byName.length} checks are called "${wanted}": name one by its id`);
  throw new Error(`No check "${wanted}": \`molesignal synthetics\` lists them`);
}

/** Location ids to names. */
async function locationNames(session: ToolSession): Promise<Map<string, string>> {
  const locations = listOf<{ id?: string; name?: string }>(await session.read('list_synthetic_locations', { limit: 500 }).catch(() => []));
  return new Map(locations.filter((one) => one.id).map((one) => [one.id!, one.name ?? one.id!]));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until every queued run has a result, or the time is up; returns those there are. */
async function awaitResults(session: ToolSession, monitorId: string, tasks: string[], timeout: number): Promise<SyntheticResult[]> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const results = listOf<SyntheticResult>(await session.read('list_synthetic_results', { monitor_id: monitorId, limit: 100 }));
    const ours = results.filter((result) => result.task_id && tasks.includes(result.task_id));
    if (ours.length >= tasks.length || Date.now() >= deadline) return ours;
    await sleep(Math.min(3000, Math.max(0, deadline - Date.now())));
  }
}

const usage = `Usage: molesignal synthetics [options]
       molesignal synthetics results <check> [options]
       molesignal synthetics run <check> [--wait] [options]

Lists the synthetic checks with their state. \`results\` lists a check's latest
runs. \`run\` runs a check now at each of its locations, through MoleSignal's
tool policy; with --wait it waits for the runs and exits with 1 when one
failed, so a pipeline can stop a release on it.

Options:
  --lifecycle <state>   Only checks in this lifecycle: active, paused, draft, archived
  --since <duration>    With results: how far back (default 1d)
  -n, --limit <count>   With results: how many runs (default 20, at most 500)
  --json                Print JSON
${CHANGE_HELP}
  (with run, --wait also waits for the runs; --timeout bounds both, default 10m)
${CONNECTION_HELP}

Exit status of run --wait: 0 when every run passed (healthy or flaky), 1 when
one failed or none finished in time, 3 when the run waits for approval.`;

export const syntheticsCommand: Command = {
  name: 'synthetics',
  group: 'On-call and changes',
  summary: 'Synthetic checks: list, latest results, run now and wait (for CI)',
  usage,

  async run(args) {
    const { values, positionals } = parse('synthetics', args, {
      ...CONNECTION,
      ...CHANGE,
      lifecycle: { type: 'string' },
      since: { type: 'string' },
      limit: { type: 'string', short: 'n' },
      json: { type: 'boolean' },
    });
    const [action, ...rest] = positionals;
    const color = useColor();
    const width = terminalWidth();

    if (action === 'results') {
      const wanted = onePositional('synthetics', rest, 'check');
      const limit = parseCount(values.limit ?? '20', '--limit', 500);
      const { results, locations } = await withSession(values, async (session) => {
        const monitor = await findMonitor(session, wanted);
        return {
          results: listOf<SyntheticResult>(
            await session.read('list_synthetic_results', { monitor_id: monitor.id, time_range: timeWindow(values, '1d'), limit }),
          ),
          locations: await locationNames(session),
        };
      });
      if (values.json) printJsonLines(results);
      else if (results.length === 0) say('No runs in that time');
      else print(formatResults(results, locations, { color, width }));
      return;
    }

    if (action === 'run') {
      const wanted = onePositional('synthetics', rest, 'check');
      return withSession(
        values,
        async (session, signed) => {
          const monitor = await findMonitor(session, wanted);
          const label = monitor.name ?? monitor.id;
          const options = changeOptions({ ...values, timeout: values.timeout ?? '10m' }, signed.credentials.connection.url, {
            reason: 'Run from the molesignal command line',
            impact: `Runs the check "${label}" once at each of its locations`,
          });
          const outcome = await makeChange(session, 'run_synthetic_monitor', { monitor_id: monitor.id }, options);
          if (outcome.state === 'pending') return reportChange(outcome, '', options);

          const verification = outcome.execution.verification as { tasks?: { id?: string }[] } | undefined;
          const tasks = (verification?.tasks ?? []).map((task) => task.id).filter((id): id is string => Boolean(id));
          say(`Queued ${tasks.length} run${tasks.length === 1 ? '' : 's'} of "${label}"`);
          if (!values.wait || tasks.length === 0) return 0;

          const results = await awaitResults(session, monitor.id, tasks, parseDuration(values.timeout ?? '10m'));
          if (values.json) printJsonLines(results);
          else print(formatResults(results, await locationNames(session), { color, width }));
          if (results.length < tasks.length) {
            say(`${tasks.length - results.length} of ${tasks.length} runs did not finish in time`);
            return 1;
          }
          return results.every((result) => PASSING.has(result.outcome ?? '')) ? 0 : 1;
        },
        confirmations(values),
      );
    }

    if (action) throw new UsageError(`Unknown "${action}": use results or run; see \`molesignal synthetics --help\``);

    const monitors = await withSession(values, async (session) =>
      listOf<Monitor>(await session.read('list_synthetic_monitors', { limit: 500, ...(values.lifecycle ? { lifecycle: values.lifecycle } : {}) })),
    );
    if (values.json) printJsonLines(monitors);
    else if (monitors.length === 0) say('No checks');
    else {
      const rows = monitors.map((monitor) => [
        monitor.id,
        monitor.kind ?? '',
        paint(color, stateColor(monitor.state ?? ''), monitor.state ?? ''),
        monitor.lifecycle ?? '',
        monitor.name ?? '',
      ]);
      print(table(['CHECK', 'KIND', 'STATE', 'LIFECYCLE', 'NAME'], rows, { width }));
    }
  },
};
