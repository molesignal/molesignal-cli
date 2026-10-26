import { type Command, CONNECTION, CONNECTION_HELP, parse, UsageError } from './command.js';
import { withSession } from './context.js';
import { print, printJsonLines, say, table, terminalWidth } from './output.js';

/** A stream as `list_streams` describes it. */
export interface StreamSummary {
  name: string;
  stream_type?: string | undefined;
  field_count?: number | undefined;
  retention?: { days?: number | undefined } | null | undefined;
  description?: string | null | undefined;
}

/** The kinds of stream MoleSignal keeps. */
export const STREAM_TYPES = ['logs', 'metrics', 'traces', 'profiles', 'extend'];

/** The streams of a `list_streams` result. */
export function streamsOf(result: unknown): StreamSummary[] {
  if (!result || typeof result !== 'object' || !('streams' in result) || !Array.isArray(result.streams)) return [];
  return result.streams.filter(
    (stream: unknown): stream is StreamSummary =>
      Boolean(stream) && typeof stream === 'object' && typeof (stream as StreamSummary).name === 'string',
  );
}

/** The streams as a table: name, fields, retention and description, columns aligned. */
export function formatStreams(streams: StreamSummary[], options: { width?: number | undefined } = {}): string[] {
  const rows = streams.map((stream) => [
    stream.name,
    stream.field_count === undefined ? '' : String(stream.field_count),
    stream.retention?.days ? `${stream.retention.days}d` : 'default',
    stream.description?.trim() ?? '',
  ]);
  return table(['STREAM', 'FIELDS', 'RETENTION', 'DESCRIPTION'], rows, options);
}

/** A stream kind as an option names it, checked. */
export function streamType(value: string | undefined, fallback = 'logs'): string {
  const type = value ?? fallback;
  if (!STREAM_TYPES.includes(type)) throw new UsageError(`--type is one of ${STREAM_TYPES.join(', ')}`);
  return type;
}

export const streamsCommand: Command = {
  name: 'streams',
  group: 'Logs and queries',
  summary: 'List the streams you can read',
  usage: `Usage: molesignal streams [options]

Lists the streams you can read: name, fields, retention and description.

Options:
  --type <type>   logs (default), metrics, traces, profiles or extend
  --names         Print only the names, one a line
  --json          Print each stream as one line of JSON
${CONNECTION_HELP}`,

  async run(args) {
    const { values } = parse('streams', args, {
      ...CONNECTION,
      type: { type: 'string' },
      names: { type: 'boolean' },
      json: { type: 'boolean' },
    });
    const type = streamType(values.type);
    const list = await withSession(values, async (session) =>
      streamsOf(await session.call('list_streams', { stream_type: type, limit: 1000 })),
    );

    if (values.json) printJsonLines(list);
    else if (values.names) print(list.map((stream) => stream.name));
    else if (list.length === 0) say(`No ${type} streams you can read yet`);
    else print(formatStreams(list, { width: terminalWidth() }));
  },
};
