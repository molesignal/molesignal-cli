import { type Command, CONNECTION, CONNECTION_HELP, parse, parseCount, UsageError } from './command.js';
import { signedIn, withSession } from './context.js';
import { formatCount, formatPercent, paint, print, printJson, printJsonLines, say, stateColor, table, terminalWidth, useColor } from './output.js';
import { formatDuration, timeWindow } from './time.js';
import { openInBrowser, pageOf } from './web.js';

/** The rate, errors and latency of requests, as APM sums them up. */
export interface Red {
  request_count?: number | undefined;
  error_count?: number | undefined;
  error_rate?: number | undefined;
  p50_micros?: number | null | undefined;
  p95_micros?: number | null | undefined;
  p99_micros?: number | null | undefined;
  apdex?: number | null | undefined;
}

interface Identity {
  namespace?: string | undefined;
  name?: string | undefined;
  environment?: string | undefined;
}

/** A service as `list_apm_services` sums it up. */
export interface ServiceSummary {
  service: Identity;
  red?: Red | undefined;
  health?: string | undefined;
  current_version?: string | null | undefined;
}

const micros = (value: number | null | undefined) => (typeof value === 'number' ? formatDuration(value / 1000) : '');
const rate = (value: number | undefined) => (typeof value === 'number' ? formatPercent(value) : '');
const count = (value: number | undefined) => (typeof value === 'number' ? formatCount(value) : '');

/** A service's name as people write it: `namespace/name`. */
export function serviceName(identity: Identity | undefined): string {
  if (!identity) return '';
  return identity.namespace ? `${identity.namespace}/${identity.name ?? ''}` : (identity.name ?? '');
}

/** The items of an APM page. */
function itemsOf<T>(result: unknown): T[] {
  const items = result && typeof result === 'object' && 'items' in result ? (result.items as unknown) : undefined;
  return Array.isArray(items) ? (items as T[]) : [];
}

/** Services as a table: name, environment, requests, error rate, p95, health and version. */
export function formatServices(services: ServiceSummary[], options: { color?: boolean; width?: number | undefined } = {}): string[] {
  const color = options.color ?? false;
  const rows = services.map((summary) => [
    serviceName(summary.service),
    summary.service.environment ?? '',
    count(summary.red?.request_count),
    rate(summary.red?.error_rate),
    micros(summary.red?.p95_micros),
    paint(color, stateColor(summary.health ?? ''), (summary.health ?? '').replace('_', ' ')),
    summary.current_version ?? '',
  ]);
  return table(['SERVICE', 'ENV', 'REQUESTS', 'ERRORS', 'P95', 'HEALTH', 'VERSION'], rows, options);
}

/** A comparison of two versions as lines: each side's figures, the change, and the verdict. */
export function formatComparison(result: Record<string, unknown>, options: { color?: boolean } = {}): string[] {
  const side = (key: string) => (result[key] ?? {}) as { version?: string; red?: Red };
  const baseline = side('baseline');
  const candidate = side('candidate');
  const rows = [baseline, candidate].map((one) => [
    one.version ?? '',
    count(one.red?.request_count),
    rate(one.red?.error_rate),
    micros(one.red?.p95_micros),
  ]);
  const status = String(result.status ?? '');
  const regressed = Array.isArray(result.regressed_transactions) ? result.regressed_transactions.length : 0;
  return [
    ...table(['VERSION', 'REQUESTS', 'ERRORS', 'P95'], rows),
    '',
    `${paint(options.color ?? false, stateColor(status), status.replace('_', ' '))}` +
      (regressed ? ` · ${regressed} endpoint${regressed === 1 ? '' : 's'} slower or failing more` : ''),
  ];
}

const usage = `Usage: molesignal services [options]
       molesignal services show <service> [options]
       molesignal services compare <service> <baseline-version> <candidate-version> [options]

Lists APM services with their requests, error rate, p95 latency, health and
version. \`show\` sums up one service: its endpoints, dependencies, errors and
versions. \`compare\` sets two versions side by side and says whether the
candidate regressed, improved or held.

Options:
  --env <environment>      Only this environment
  --namespace <namespace>  Only this namespace
  --sort <field>           requests (default), errors, p95 or name
  --since <duration>       How far back to look (default 1h)
  --from <time>            Start at a time instead
  --to <time>              End at a time instead of now
  -n, --limit <count>      How many services (default 25, at most 100)
  --fail-on-regression     With compare: exit with 1 when the candidate regressed
  --json                   Print JSON
  --web                    With show: open the service in MoleSignal instead
${CONNECTION_HELP}

Examples:
  molesignal services --env production --sort errors
  molesignal services compare checkout 2.3.9 2.4.0 --since 2h --fail-on-regression`;

const SORTS: Record<string, string> = { requests: 'request_count', errors: 'error_rate', p95: 'p95_micros', name: 'name' };

export const servicesCommand: Command = {
  name: 'services',
  group: 'Logs and queries',
  summary: 'APM services: health, one service, two versions compared',
  usage,

  async run(args) {
    const { values, positionals } = parse('services', args, {
      ...CONNECTION,
      env: { type: 'string' },
      namespace: { type: 'string' },
      sort: { type: 'string' },
      since: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      limit: { type: 'string', short: 'n' },
      'fail-on-regression': { type: 'boolean' },
      json: { type: 'boolean' },
      web: { type: 'boolean' },
    });
    const [action, ...rest] = positionals;
    const scope = {
      time_range: timeWindow(values, '1h'),
      ...(values.env ? { environment: values.env } : {}),
      ...(values.namespace ? { namespace: values.namespace } : {}),
    };
    const color = useColor();
    const width = terminalWidth();

    if (action === 'show') {
      const [service, ...extra] = rest;
      if (!service || extra.length > 0) throw new UsageError('Which service? Run `molesignal services show <service>`');
      if (values.web) {
        const signed = await signedIn(values);
        const url = pageOf(signed.credentials.connection.url, 'services', service);
        say(`Opening ${url}`);
        openInBrowser(url);
        return;
      }
      const detail = (await withSession(values, (session) => session.read('get_apm_service', { ...scope, service }))) as Record<
        string,
        unknown
      >;
      if (values.json) {
        printJson(detail);
        return;
      }
      const summary = (detail.service ?? {}) as ServiceSummary;
      const red = (detail.red ?? summary.red ?? {}) as Red;
      print([
        `${serviceName(summary.service)}${summary.service?.environment ? ` (${summary.service.environment})` : ''}` +
          `${summary.current_version ? ` · version ${summary.current_version}` : ''}` +
          `${summary.health ? ` · ${paint(color, stateColor(summary.health), summary.health.replace('_', ' '))}` : ''}`,
        `requests ${count(red.request_count)} · errors ${rate(red.error_rate)} · p50 ${micros(red.p50_micros)} · p95 ${micros(red.p95_micros)} · p99 ${micros(red.p99_micros)}`,
      ]);
      const section = (title: string, head: string[], rows: string[][]) => {
        if (rows.length === 0) return;
        print(['', title, ...table(head, rows.slice(0, 10), { width })]);
      };
      const list = (key: string) => (Array.isArray(detail[key]) ? (detail[key] as Record<string, unknown>[]) : []);
      section(
        'Endpoints',
        ['REQUESTS', 'ERRORS', 'P95', 'ENDPOINT'],
        list('transactions').map((item) => {
          const itemRed = (item.red ?? {}) as Red;
          return [count(itemRed.request_count), rate(itemRed.error_rate), micros(itemRed.p95_micros), String((item.transaction as { name?: string })?.name ?? '')];
        }),
      );
      section(
        'Dependencies',
        ['CALLS', 'ERRORS', 'P95', 'DEPENDENCY'],
        list('dependencies').map((item) => {
          const itemRed = (item.red ?? {}) as Red;
          const dependency = (item.dependency ?? {}) as { category?: string; target?: string };
          return [count(itemRed.request_count), rate(itemRed.error_rate), micros(itemRed.p95_micros), `${dependency.category ?? ''} ${dependency.target ?? ''}`.trim()];
        }),
      );
      section(
        'Errors',
        ['COUNT', 'TYPE', 'MESSAGE'],
        list('errors').map((item) => [
          count(Number(item.occurrence_count ?? 0)),
          String((item.error as { error_type?: string })?.error_type ?? ''),
          String(item.representative_message ?? ''),
        ]),
      );
      section(
        'Versions',
        ['VERSION', 'REQUESTS', 'ERRORS', 'P95'],
        list('versions').map((item) => {
          const itemRed = (item.red ?? {}) as Red;
          return [String(item.version ?? ''), count(itemRed.request_count), rate(itemRed.error_rate), micros(itemRed.p95_micros)];
        }),
      );
      return;
    }

    if (action === 'compare') {
      const [service, baseline, candidate, ...extra] = rest;
      if (!service || !baseline || !candidate || extra.length > 0) {
        throw new UsageError('Run `molesignal services compare <service> <baseline-version> <candidate-version>`');
      }
      const result = (await withSession(values, (session) =>
        session.read('compare_apm_versions', { ...scope, service, baseline_version: baseline, candidate_version: candidate }),
      )) as Record<string, unknown>;
      if (values.json) printJson(result);
      else print(formatComparison(result, { color }));
      return values['fail-on-regression'] && result.status === 'regressed' ? 1 : 0;
    }

    if (action) throw new UsageError(`Unknown "${action}": use show or compare; see \`molesignal services --help\``);

    const sort = SORTS[values.sort ?? 'requests'];
    if (!sort) throw new UsageError('--sort is one of requests, errors, p95, name');
    const limit = parseCount(values.limit ?? '25', '--limit', 100);
    const services = itemsOf<ServiceSummary>(
      await withSession(values, (session) => session.read('list_apm_services', { ...scope, sort, limit })),
    );
    if (values.json) printJsonLines(services);
    else if (services.length === 0) say('No services in that time');
    else print(formatServices(services, { color, width }));
  },
};
