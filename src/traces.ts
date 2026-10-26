import { type Command, CONNECTION, CONNECTION_HELP, parse, parseCount, UsageError } from './command.js';
import { signedIn, withSession } from './context.js';
import { cut, displayWidth, padTo, paint, print, printJson, printJsonLines, say, table, terminalWidth, useColor } from './output.js';
import { formatDuration, minute, parseDuration, timeWindow } from './time.js';
import { openInBrowser, pageOf } from './web.js';

/** A trace as `list_traces` sums it up. */
export interface TraceSummary {
  trace_id: string;
  service?: string | null | undefined;
  started_at_micros?: number | undefined;
  duration_ms?: number | undefined;
  span_count?: number | undefined;
  has_error?: boolean | null | undefined;
}

/** A span as `get_trace` returns it. */
export interface Span {
  span_id: string;
  parent_span_id?: string | null | undefined;
  service?: string | undefined;
  operation?: string | undefined;
  start_ns: number;
  end_ns: number;
  duration_ns?: number | undefined;
  status?: string | undefined;
  status_message?: string | null | undefined;
}

/** The traces of a `list_traces` result. */
export function tracesOf(result: unknown): TraceSummary[] {
  const traces = result && typeof result === 'object' && 'traces' in result ? (result.traces as unknown) : undefined;
  return Array.isArray(traces) ? traces.filter((trace): trace is TraceSummary => typeof trace?.trace_id === 'string') : [];
}

/** The spans of a `get_trace` result. */
export function spansOf(result: unknown): Span[] {
  const spans = result && typeof result === 'object' && 'spans' in result ? (result.spans as unknown) : undefined;
  return Array.isArray(spans)
    ? spans.filter((span): span is Span => typeof span?.span_id === 'string' && typeof span.start_ns === 'number')
    : [];
}

const failed = (span: Span) => /^(error|status_code_error|2)$/i.test(span.status ?? '');

/** The spans in the order a waterfall shows them, each with the tree lines before its name. */
export function waterfallOrder(spans: Span[]): { span: Span; prefix: string }[] {
  const ids = new Set(spans.map((span) => span.span_id));
  const children = new Map<string, Span[]>();
  const roots: Span[] = [];
  for (const span of spans) {
    const parent = span.parent_span_id;
    if (parent && ids.has(parent) && parent !== span.span_id) {
      children.set(parent, [...(children.get(parent) ?? []), span]);
    } else {
      roots.push(span);
    }
  }

  const byStart = (left: Span, right: Span) => left.start_ns - right.start_ns;
  const ordered: { span: Span; prefix: string }[] = [];
  const visited = new Set<string>();
  const visit = (span: Span, lead: string, branch: string) => {
    if (visited.has(span.span_id)) return;
    visited.add(span.span_id);
    ordered.push({ span, prefix: lead + branch });
    const below = [...(children.get(span.span_id) ?? [])].sort(byStart);
    const next = lead + (branch === '└─ ' ? '   ' : branch === '├─ ' ? '│  ' : '');
    below.forEach((child, index) => visit(child, next, index === below.length - 1 ? '└─ ' : '├─ '));
  };
  roots.sort(byStart).forEach((root) => visit(root, '', ''));
  return ordered;
}

/**
 * A trace as a waterfall: a line a span, under its parent, with a bar for
 * when it ran within the whole trace and how long it took. Failed spans are
 * marked, and red when colours are on.
 */
export function formatWaterfall(spans: Span[], options: { color?: boolean; width?: number | undefined } = {}): string[] {
  if (spans.length === 0) return [];
  const color = options.color ?? false;
  const start = Math.min(...spans.map((span) => span.start_ns));
  const end = Math.max(...spans.map((span) => span.end_ns));
  const total = Math.max(1, end - start);

  const lines = waterfallOrder(spans).map(({ span, prefix }) => ({
    span,
    label: `${prefix}${failed(span) ? '! ' : ''}${span.service ?? ''} ${span.operation ?? ''}`.trimEnd(),
  }));
  const room = options.width ?? 120;
  const labelWidth = Math.min(Math.max(...lines.map((line) => displayWidth(line.label))), Math.max(24, Math.floor(room * 0.45)));
  const track = Math.max(10, Math.min(60, room - labelWidth - 12));

  return lines.map(({ span, label }) => {
    const offset = Math.min(track - 1, Math.floor(((span.start_ns - start) / total) * track));
    const length = Math.max(1, Math.min(track - offset, Math.round(((span.end_ns - span.start_ns) / total) * track)));
    const bar = `${' '.repeat(offset)}${'█'.repeat(length)}${' '.repeat(track - offset - length)}`;
    const took = formatDuration((span.duration_ns ?? span.end_ns - span.start_ns) / 1_000_000);
    const name = padTo(cut(label, labelWidth), labelWidth);
    const code = failed(span) ? '31' : undefined;
    return `${paint(color, code, name)}  ${paint(color, code ?? '36', bar)}  ${took}`;
  });
}

export const tracesCommand: Command = {
  name: 'traces',
  group: 'Logs and queries',
  summary: 'Find traces; `traces show <id>` draws one as a waterfall',
  usage: `Usage: molesignal traces [options]
       molesignal traces show <trace-id> [options]

Lists recent traces: id, service, start, duration and spans. \`show\` draws one
trace as a waterfall, a line a span under its parent.

Options:
  --service <name>         Only traces of this service
  --errors                 Only traces with a failed span
  --min-duration <time>    Only traces that took at least this long: 500ms, 2s
  --since <duration>       How far back to look (default 1h)
  --from <time>            Start at a time instead
  --to <time>              End at a time instead of now
  -n, --limit <count>      How many traces (default 20, at most 200)
  --json                   Print JSON
  --web                    With show: open the trace in MoleSignal instead
${CONNECTION_HELP}

Examples:
  molesignal traces --service checkout --errors --since 6h
  molesignal traces show 4bf92f3577b34da6a3ce929d0e0e4736`,

  async run(args) {
    const { values, positionals } = parse('traces', args, {
      ...CONNECTION,
      service: { type: 'string' },
      errors: { type: 'boolean' },
      'min-duration': { type: 'string' },
      since: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      limit: { type: 'string', short: 'n' },
      json: { type: 'boolean' },
      web: { type: 'boolean' },
    });
    const [action, id, ...extra] = positionals;

    if (action === 'show') {
      if (!id || extra.length > 0) throw new UsageError('Which trace? Run `molesignal traces show <trace-id>`');
      if (values.web) {
        const signed = await signedIn(values);
        const url = pageOf(signed.credentials.connection.url, 'traces', id);
        say(`Opening ${url}`);
        openInBrowser(url);
        return;
      }
      const timed = values.since || values.from ? { time_range: timeWindow(values, '1h') } : {};
      const result = await withSession(values, (session) => session.call('get_trace', { trace_id: id, ...timed }));
      if (values.json) {
        printJson(result);
        return;
      }
      const spans = spansOf(result);
      const first = Math.min(...spans.map((span) => span.start_ns));
      const last = Math.max(...spans.map((span) => span.end_ns));
      const failures = spans.filter(failed).length;
      say(
        `${id} · ${spans.length} span${spans.length === 1 ? '' : 's'} · ${formatDuration((last - first) / 1_000_000)}` +
          (failures ? ` · ${failures} failed` : '') +
          ((result as { truncated?: boolean })?.truncated ? ' · cut at the span limit' : ''),
      );
      print(formatWaterfall(spans, { color: useColor(), width: terminalWidth() }));
      return;
    }
    if (action) throw new UsageError(`Unknown "${action}": run \`molesignal traces\` or \`molesignal traces show <id>\``);

    const limit = parseCount(values.limit ?? '20', '--limit', 200);
    const minimum = values['min-duration'] ? parseDuration(values['min-duration']) : undefined;
    const traces = await withSession(values, async (session) =>
      tracesOf(
        await session.call('list_traces', {
          time_range: timeWindow(values, '1h'),
          limit,
          ...(values.service ? { service: values.service } : {}),
          ...(values.errors ? { error_only: true } : {}),
          ...(minimum !== undefined ? { min_duration_ms: minimum } : {}),
        }),
      ),
    );

    if (values.json) printJsonLines(traces);
    else if (traces.length === 0) say('No traces in that time');
    else {
      const rows = traces.map((trace) => [
        trace.trace_id,
        trace.started_at_micros ? minute(trace.started_at_micros) : '',
        trace.duration_ms === undefined ? '' : formatDuration(trace.duration_ms),
        trace.span_count === undefined ? '' : String(trace.span_count),
        trace.service ?? '',
      ]);
      print(table(['TRACE', 'STARTED', 'DURATION', 'SPANS', 'SERVICE'], rows, { width: terminalWidth() }));
    }
  },
};
