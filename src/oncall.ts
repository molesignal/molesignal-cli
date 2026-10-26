import { type Command, CONNECTION, CONNECTION_HELP, parse, UsageError } from './command.js';
import { withSession } from './context.js';
import { print, printJson, say, table, terminalWidth } from './output.js';
import { minute, parseTime } from './time.js';

/** Who is on call for one schedule, as `get_current_on_call` says it. */
export interface OnCall {
  schedule_id?: string | undefined;
  schedule_name?: string | undefined;
  user?: { id?: string | undefined; display_name?: string | null | undefined } | null | undefined;
}

/** The people on call of a `get_current_on_call` result. */
export function onCallOf(result: unknown): OnCall[] {
  const rows = result && typeof result === 'object' && 'on_call' in result ? (result.on_call as unknown) : undefined;
  return Array.isArray(rows) ? (rows as OnCall[]) : [];
}

export const oncallCommand: Command = {
  name: 'oncall',
  group: 'On-call and changes',
  summary: 'Who is on call now, for every schedule or one',
  usage: `Usage: molesignal oncall [options]

Prints who is on call for each enabled on-call schedule.

Options:
  --schedule <id>   Only this schedule
  --at <time>       Who is on call at another time: 2026-10-27 09:00, an ISO time
  --json            Print JSON
${CONNECTION_HELP}`,

  async run(args) {
    const { values, positionals } = parse('oncall', args, {
      ...CONNECTION,
      schedule: { type: 'string' },
      at: { type: 'string' },
      json: { type: 'boolean' },
    });
    if (positionals.length > 0) throw new UsageError(`Unexpected "${positionals[0]}"; see \`molesignal oncall --help\``);

    const at = values.at ? parseTime(values.at) : undefined;
    const result = await withSession(values, (session) =>
      session.read('get_current_on_call', {
        ...(values.schedule ? { schedule_id: values.schedule } : {}),
        ...(at !== undefined ? { at_micros: at } : {}),
      }),
    );
    if (values.json) {
      printJson(result);
      return;
    }
    const rows = onCallOf(result);
    if (rows.length === 0) {
      say('Nobody is on call: no enabled schedule has anyone at that time');
      return;
    }
    if (at !== undefined) say(`On call at ${minute(at)}`);
    print(
      table(
        ['SCHEDULE', 'ON CALL', 'SCHEDULE ID'],
        rows.map((row) => [row.schedule_name ?? '', row.user?.display_name ?? row.user?.id ?? '', row.schedule_id ?? '']),
        { width: terminalWidth() },
      ),
    );
  },
};
