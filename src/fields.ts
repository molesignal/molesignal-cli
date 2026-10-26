import { type Command, CONNECTION, CONNECTION_HELP, parse, parseCount, UsageError } from './command.js';
import { withSession } from './context.js';
import { cell, cut, print, printJsonLines, say, table, terminalWidth } from './output.js';
import { streamType } from './streams.js';
import { timeWindow } from './time.js';

/** A field as a stream's schema describes it. */
export interface FieldInfo {
  name: string;
  data_type?: string | undefined;
  nullable?: boolean | undefined;
  index_type?: string | null | undefined;
  indexed?: boolean | undefined;
}

/** The fields of a `get_stream_schema` result. */
export function fieldsOf(result: unknown): FieldInfo[] {
  const schema = result && typeof result === 'object' && 'schema' in result ? (result.schema as unknown) : undefined;
  const fields = schema && typeof schema === 'object' && 'fields' in schema ? (schema.fields as unknown) : undefined;
  return Array.isArray(fields)
    ? fields.filter((field): field is FieldInfo => Boolean(field) && typeof field === 'object' && typeof field.name === 'string')
    : [];
}

/** How a field is indexed, in a word: its index type, `yes` from an older schema, or nothing. */
function indexOf(field: FieldInfo): string {
  if (field.index_type && field.index_type !== 'none') return field.index_type;
  return field.index_type === undefined && field.indexed ? 'yes' : '';
}

/** The values of a `search_field_values` result, most common first. */
export function valuesOf(result: unknown): { value: unknown; count: number }[] {
  const values = result && typeof result === 'object' && 'values' in result ? (result.values as unknown) : undefined;
  return Array.isArray(values)
    ? values
        .filter((value) => Boolean(value) && typeof value === 'object')
        .map((value) => ({ value: (value as { value?: unknown }).value, count: Number((value as { count?: unknown }).count ?? 0) }))
    : [];
}

/** Values and their counts as a table, each with a bar the length of its count against the most common. */
export function formatValues(values: { value: unknown; count: number }[], options: { width?: number | undefined } = {}): string[] {
  const most = Math.max(1, ...values.map((value) => value.count));
  const rows = values.map(({ value, count }) => [
    String(count),
    '█'.repeat(Math.max(1, Math.round((count / most) * 20))),
    value === null || value === undefined ? '(none)' : cut(cell(value), 120),
  ]);
  return table(['COUNT', '', 'VALUE'], rows, options);
}

export const fieldsCommand: Command = {
  name: 'fields',
  group: 'Logs and queries',
  summary: "List a stream's fields, or the most common values of one field",
  usage: `Usage: molesignal fields <stream> [field] [options]

Without a field, lists the stream's fields: name, type and index. With a
field, lists its most common values over the time window, with their counts.

Options:
  --type <type>         logs (default), metrics, traces, profiles or extend
  --since <duration>    How far back to count values (default 1h)
  --from <time>         Start at a time instead
  --to <time>           End at a time instead of now
  -n, --limit <count>   How many values to list (default 20, at most 500)
  --match <text>        Only values that contain this text
  --json                Print each field or value as one line of JSON
${CONNECTION_HELP}

Examples:
  molesignal fields app_logs
  molesignal fields app_logs service --since 1d`,

  async run(args) {
    const { values, positionals } = parse('fields', args, {
      ...CONNECTION,
      type: { type: 'string' },
      since: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      limit: { type: 'string', short: 'n' },
      match: { type: 'string' },
      json: { type: 'boolean' },
    });
    const [stream, field, ...extra] = positionals;
    if (!stream || extra.length > 0) throw new UsageError('Run `molesignal fields <stream> [field]`');
    const type = streamType(values.type);

    if (!field) {
      const fields = await withSession(values, async (session) =>
        fieldsOf(await session.call('get_stream_schema', { stream, stream_type: type })),
      );
      if (values.json) printJsonLines(fields);
      else if (fields.length === 0) say(`${stream} has no fields yet`);
      else {
        const rows = fields.map((info) => [info.name, info.data_type ?? '', indexOf(info)]);
        print(table(['FIELD', 'TYPE', 'INDEX'], rows, { width: terminalWidth() }));
      }
      return;
    }

    const window = timeWindow(values, '1h');
    const limit = parseCount(values.limit ?? '20', '--limit', 500);
    const found = await withSession(values, async (session) =>
      valuesOf(
        await session.read('search_field_values', {
          stream,
          field,
          stream_type: type,
          time_range: window,
          limit,
          ...(values.match ? { query: values.match } : {}),
        }),
      ),
    );

    if (values.json) printJsonLines(found);
    else if (found.length === 0) say(`No values of ${field} in that time`);
    else print(formatValues(found, { width: terminalWidth() }));
  },
};
