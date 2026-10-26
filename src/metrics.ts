import { type Command, CONNECTION, CONNECTION_HELP, keyValues, parse, parseCount, UsageError } from './command.js';
import { withSession } from './context.js';
import { formatValues } from './fields.js';
import { rowsOf } from './logs.js';
import { columnsOf } from './query.js';
import { cell, csv, evenly, formatCount, print, printJson, printJsonLines, say, sparkline, table, terminalWidth } from './output.js';
import { timeWindow } from './time.js';

/** One series of a PromQL result: its labels, and its points oldest first. */
export interface Series {
  labels: Record<string, string>;
  points: [number, number][];
}

/**
 * The series of a `query_metrics` result. A range result has the columns
 * `_timestamp`, `value` and one column a label; an instant one has no time.
 */
export function seriesOf(result: unknown): Series[] {
  const rows = rowsOf(result);
  const columns = columnsOf(result, rows).filter((column) => column !== '_timestamp' && column !== 'value');
  const byLabels = new Map<string, Series>();

  for (const row of rows) {
    const labels: Record<string, string> = {};
    for (const column of columns) {
      if (row[column] !== null && row[column] !== undefined) labels[column] = String(row[column]);
    }
    const key = JSON.stringify(labels);
    let series = byLabels.get(key);
    if (!series) {
      series = { labels, points: [] };
      byLabels.set(key, series);
    }
    const time = typeof row._timestamp === 'number' ? row._timestamp : 0;
    series.points.push([time, Number(row.value)]);
  }

  const all = [...byLabels.values()];
  for (const series of all) series.points.sort((left, right) => left[0] - right[0]);
  return all;
}

/** A series' labels as PromQL writes them: `http_requests_total{job="api"}`. */
export function seriesName(labels: Record<string, string>): string {
  const { __name__: name = '', ...rest } = labels;
  const pairs = Object.entries(rest).map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  return pairs.length ? `${name}{${pairs.join(', ')}}` : name || '{}';
}

/** A sample value for people: four significant digits, large ones shortened. */
export function formatValue(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Math.abs(value) >= 1_000_000) return formatCount(value);
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toPrecision(4)));
}

/** The series as a table: name, last value, lowest, highest, and a sparkline of the window. */
export function formatSeries(series: Series[], options: { width?: number | undefined } = {}): string[] {
  const ranged = series.some((one) => one.points.length > 1 || one.points.some(([time]) => time > 0));
  if (!ranged) {
    return table(
      ['VALUE', 'SERIES'],
      series.map((one) => [formatValue(one.points.at(-1)?.[1] ?? Number.NaN), seriesName(one.labels)]),
      options,
    );
  }
  const rows = series.map((one) => {
    const values = one.points.map(([, value]) => value);
    return [
      formatValue(values.at(-1) ?? Number.NaN),
      formatValue(Math.min(...values)),
      formatValue(Math.max(...values)),
      sparkline(evenly(values, 30)),
      seriesName(one.labels),
    ];
  });
  return table(['LAST', 'MIN', 'MAX', 'TREND', 'SERIES'], rows, options);
}

const usage = `Usage: molesignal metrics <query|names|labels|values|series> [options]

  molesignal metrics query '<PromQL>'          Run a PromQL range query; one line a series
  molesignal metrics names [text]              List metric names, those that contain the text
  molesignal metrics labels <metric>           List a metric's labels
  molesignal metrics values <metric> <label>   List a label's values, with how often each occurs
  molesignal metrics series <metric>           List a metric's series; --match label=value narrows them

Options:
  --since <duration>    How far back to look: 30s, 10m, 2h, 1d (default 1h)
  --from <time>         Start at a time instead
  --to <time>           End at a time instead of now
  -n, --limit <count>   The most points, names or values (default 1000 points, 200 otherwise)
  --match <label=value> With series: only series with this label value; may be given more than once
  --csv                 With query: print the points as CSV
  --json                Print JSON
${CONNECTION_HELP}

Examples:
  molesignal metrics query 'sum by (service) (rate(http_server_requests_total[5m]))' --since 6h
  molesignal metrics names http
  molesignal metrics values http_server_requests_total service`;

export const metricsCommand: Command = {
  name: 'metrics',
  group: 'Logs and queries',
  summary: 'Run PromQL; list metric names, labels, values and series',
  usage,

  async run(args) {
    const { values, positionals } = parse('metrics', args, {
      ...CONNECTION,
      since: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      limit: { type: 'string', short: 'n' },
      match: { type: 'string', multiple: true },
      csv: { type: 'boolean' },
      json: { type: 'boolean' },
    });
    const [action, ...rest] = positionals;
    const width = terminalWidth();

    if (action === 'query') {
      const promql = rest.join(' ').trim();
      if (!promql) throw new UsageError("Which query? Run `molesignal metrics query 'rate(...[5m])'`");
      const limit = parseCount(values.limit ?? '1000', '--limit', 5000);
      const result = await withSession(values, (session) =>
        session.call('query_metrics', { promql, time_range: timeWindow(values, '1h'), limit }),
      );
      if (values.csv) {
        const rows = rowsOf(result);
        const columns = columnsOf(result, rows);
        print(csv(columns, rows.map((row) => columns.map((column) => row[column]))));
        return;
      }
      const series = seriesOf(result);
      if (values.json) printJsonLines(series);
      else if (series.length === 0) say('No series');
      else print(formatSeries(series, { width }));
      return;
    }

    const limit = parseCount(values.limit ?? '200', '--limit', 1000);

    if (action === 'names') {
      const result = (await withSession(values, (session) =>
        session.read('list_metric_names', { limit, ...(rest[0] ? { query: rest.join(' ') } : {}) }),
      )) as { metric_names?: string[] };
      const names = result?.metric_names ?? [];
      if (values.json) printJson(names);
      else if (names.length === 0) say('No metrics');
      else print(names);
      return;
    }

    const metric = rest[0];
    if (!metric) throw new UsageError(`Which metric? See \`molesignal metrics --help\``);

    if (action === 'labels') {
      const result = (await withSession(values, (session) => session.read('list_metric_labels', { metric }))) as {
        labels?: string[];
      };
      const labels = result?.labels ?? [];
      if (values.json) printJson(labels);
      else print(labels);
      return;
    }

    if (action === 'values') {
      const label = rest[1];
      if (!label) throw new UsageError('Which label? Run `molesignal metrics values <metric> <label>`');
      const result = (await withSession(values, (session) =>
        session.read('list_metric_label_values', { metric, label, time_range: timeWindow(values, '1h'), limit }),
      )) as { values?: { value: unknown; count: number }[] };
      const found = result?.values ?? [];
      if (values.json) printJsonLines(found);
      else if (found.length === 0) say(`No values of ${label} in that time`);
      else print(formatValues(found, { width }));
      return;
    }

    if (action === 'series') {
      const match = keyValues(values.match, '--match');
      const result = (await withSession(values, (session) =>
        session.read('list_metric_series', {
          metric,
          time_range: timeWindow(values, '1h'),
          limit,
          ...(Object.keys(match).length ? { match } : {}),
        }),
      )) as { series?: Record<string, unknown>[] };
      const series = result?.series ?? [];
      if (values.json) {
        printJsonLines(series);
        return;
      }
      const labels = [...new Set(series.flatMap((one) => Object.keys(one)))].filter((label) => label !== '__name__');
      print(table(labels.map((label) => label.toUpperCase()), series.map((one) => labels.map((label) => cell(one[label]))), { width }));
      return;
    }

    throw new UsageError(`Unknown "${action ?? ''}": use query, names, labels, values or series; see \`molesignal metrics --help\``);
  },
};
