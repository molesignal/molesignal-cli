import { CHANGE, CHANGE_HELP, changeOptions, confirmations, makeChange, reportChange } from './changes.js';
import { type Command, CONNECTION, CONNECTION_HELP, onePositional, parse, parseCount, UsageError } from './command.js';
import { signedIn, withSession } from './context.js';
import { labelled, paint, print, printJson, printJsonLines, say, stateColor, table, terminalWidth, useColor } from './output.js';
import { ago, minute, timeWindow } from './time.js';
import { openInBrowser, pageOf } from './web.js';

/** An incident as MoleSignal keeps it. */
export interface Incident {
  id: string;
  rule_id?: string | undefined;
  status?: string | undefined;
  severity?: string | undefined;
  summary?: string | undefined;
  labels?: Record<string, string> | undefined;
  annotations?: Record<string, string> | undefined;
  affected_services?: string[] | undefined;
  trace_ids?: string[] | undefined;
  created_at?: number | undefined;
  acknowledged_at?: number | null | undefined;
  resolved_at?: number | null | undefined;
}

/** The incidents of a `list_incidents` result. */
export function incidentsOf(result: unknown): Incident[] {
  const incidents = result && typeof result === 'object' && 'incidents' in result ? (result.incidents as unknown) : undefined;
  return Array.isArray(incidents) ? incidents.filter((incident): incident is Incident => typeof incident?.id === 'string') : [];
}

/** Incidents as a table: id, status, severity, when, services and summary. */
export function formatIncidents(incidents: Incident[], options: { color?: boolean; width?: number | undefined; now?: number } = {}): string[] {
  const color = options.color ?? false;
  const rows = incidents.map((incident) => [
    incident.id,
    paint(color, stateColor(incident.status ?? ''), incident.status ?? ''),
    paint(color, incident.severity === 'critical' ? '31' : incident.severity === 'warning' ? '33' : undefined, incident.severity ?? ''),
    incident.created_at ? ago(incident.created_at, options.now) : '',
    (incident.affected_services ?? []).join(', '),
    incident.summary ?? '',
  ]);
  return table(['INCIDENT', 'STATUS', 'SEVERITY', 'OPENED', 'SERVICES', 'SUMMARY'], rows, options);
}

/** One incident as lines: what it is, its times, services, labels, notes and traces. */
export function formatIncident(incident: Incident, rule: Record<string, unknown> | undefined, options: { color?: boolean } = {}): string[] {
  const color = options.color ?? false;
  const lines = [
    `${incident.id} · ${paint(color, stateColor(incident.status ?? ''), incident.status ?? '')} · ${incident.severity ?? ''}`,
    incident.summary ?? '',
    '',
  ];
  const field = (name: string, value: string | undefined) => {
    if (value) lines.push(labelled(name, value, 14));
  };
  field('Rule', typeof rule?.name === 'string' ? `${rule.name} (${incident.rule_id})` : incident.rule_id);
  field('Opened', incident.created_at ? minute(incident.created_at) : undefined);
  field('Acknowledged', incident.acknowledged_at ? minute(incident.acknowledged_at) : undefined);
  field('Resolved', incident.resolved_at ? minute(incident.resolved_at) : undefined);
  field('Services', incident.affected_services?.join(', '));
  field('Labels', Object.entries(incident.labels ?? {}).map(([key, value]) => `${key}=${value}`).join(' '));
  for (const [key, value] of Object.entries(incident.annotations ?? {})) field(key, value);
  field('Traces', incident.trace_ids?.slice(0, 5).join(' '));
  return lines;
}

const usage = `Usage: molesignal incidents [options]
       molesignal incidents show <incident> [--rca]
       molesignal incidents ack <incident>
       molesignal incidents resolve <incident>
       molesignal incidents create --title <text> [options]

Lists incidents, newest first. \`show\` prints one, with its root-cause analysis
when --rca is given. \`ack\`, \`resolve\` and \`create\` go through MoleSignal's
tool policy: at once, after you confirm, or once reviewers approve.

\`create\` opens an incident by hand, for a problem no rule caught, such as a
customer report. It is routed like an alert unless --team, --policy or --user
says who takes it.

Options:
  --status <status>     active (default), resolved or all
  --since <duration>    Only incidents opened since then: 1h, 7d
  -n, --limit <count>   How many incidents (default 50, at most 500)
  --rca                 With show: print the root-cause analysis too
  --json                Print JSON
  --web                 With show: open the incident in MoleSignal instead

Options of create:
  --title <text>        What happened (required)
  --description <text>  More about it, in Markdown
  --severity <level>    critical, error (default), warning or info
  --priority <P1…P9>    A priority level of the organization
  --urgency <key>       An urgency level (high, low, or one the organization added);
                        left out, the escalation policy decides
  --service <name>      An affected service; repeat for several
  --label <key=value>   A label; repeat for several
  --team <team id>      Page this team's on-call policy
  --policy <policy id>  Page along this escalation policy
  --user <user id>      Page these people directly; repeat for several
  --major               Declare it a major incident at once
${CHANGE_HELP}
${CONNECTION_HELP}

Exit status of ack, resolve and create: 0 when done, 3 when it waits for approval.`;

export const incidentsCommand: Command = {
  name: 'incidents',
  group: 'On-call and changes',
  summary: 'Incidents: list, show with root cause, acknowledge, resolve, open by hand',
  usage,

  async run(args) {
    const { values, positionals } = parse('incidents', args, {
      ...CONNECTION,
      ...CHANGE,
      status: { type: 'string' },
      since: { type: 'string' },
      limit: { type: 'string', short: 'n' },
      rca: { type: 'boolean' },
      json: { type: 'boolean' },
      web: { type: 'boolean' },
      title: { type: 'string' },
      description: { type: 'string' },
      severity: { type: 'string' },
      priority: { type: 'string' },
      urgency: { type: 'string' },
      service: { type: 'string', multiple: true },
      label: { type: 'string', multiple: true },
      team: { type: 'string' },
      policy: { type: 'string' },
      user: { type: 'string', multiple: true },
      major: { type: 'boolean' },
    });
    const [action, ...rest] = positionals;
    const color = useColor();

    if (action === 'show') {
      const id = onePositional('incidents', rest, 'incident');
      if (values.web) {
        const signed = await signedIn(values);
        const url = pageOf(signed.credentials.connection.url, 'incidents', id);
        say(`Opening ${url}`);
        openInBrowser(url);
        return;
      }
      const { found, rca } = await withSession(values, async (session) => ({
        found: (await session.call('get_incident', { incident_id: id })) as { incident?: Incident; rule?: Record<string, unknown> },
        rca: values.rca ? ((await session.read('get_incident_rca', { incident_id: id })) as { rca?: { summary?: string } | null }) : undefined,
      }));
      if (values.json) {
        printJson(rca ? { ...found, rca: rca.rca } : found);
        return;
      }
      if (!found.incident) throw new Error(`No incident ${id}`);
      print(formatIncident(found.incident, found.rule ?? undefined, { color }));
      if (values.rca) print(['', rca?.rca?.summary ?? 'No root-cause analysis yet']);
      return;
    }

    if (action === 'ack' || action === 'resolve') {
      const id = onePositional('incidents', rest, 'incident');
      const acknowledge = action === 'ack';
      return withSession(
        values,
        async (session, signed) => {
          const address = signed.credentials.connection.url;
          const options = changeOptions(values, address, {
            reason: acknowledge ? 'Acknowledged from the molesignal command line' : 'Resolved from the molesignal command line',
            impact: acknowledge
              ? `Incident ${id} is marked acknowledged; its escalation stops while it stays open`
              : `Incident ${id} is marked resolved`,
          });
          const outcome = await makeChange(session, acknowledge ? 'acknowledge_incident' : 'resolve_incident', { incident_id: id }, options);
          return reportChange(outcome, `${acknowledge ? 'Acknowledged' : 'Resolved'} incident ${id}`, options);
        },
        confirmations(values),
      );
    }

    if (action === 'create') {
      if (rest.length > 0) throw new UsageError(`Unexpected "${rest[0]}"; see \`molesignal incidents --help\``);
      const input = createInput(values);
      return withSession(
        values,
        async (session, signed) => {
          const options = changeOptions(values, signed.credentials.connection.url, {
            reason: 'Opened from the molesignal command line',
            impact: `A new incident "${input.title}" is opened and its responders are paged`,
          });
          const outcome = await makeChange(session, 'create_incident', input, options);
          return reportChange(outcome, `Opened incident "${input.title}"`, options);
        },
        confirmations(values),
      );
    }

    if (action) throw new UsageError(`Unknown "${action}": use show, ack, resolve or create; see \`molesignal incidents --help\``);

    const status = values.status ?? 'active';
    if (!['active', 'resolved', 'all'].includes(status)) throw new UsageError('--status is one of active, resolved, all');
    const limit = parseCount(values.limit ?? '50', '--limit', 500);
    const incidents = await withSession(values, async (session) =>
      incidentsOf(
        await session.read('list_incidents', {
          status,
          limit,
          ...(values.since ? { time_range: timeWindow(values, values.since) } : {}),
        }),
      ),
    );
    if (values.json) printJsonLines(incidents);
    else if (incidents.length === 0) say(status === 'active' ? 'No active incidents' : 'No incidents');
    else print(formatIncidents(incidents, { color, width: terminalWidth() }));
  },
};

const SEVERITIES = ['critical', 'error', 'warning', 'info'];

/** What `incidents create` sends to the `create_incident` tool, from its options. */
export function createInput(values: {
  title?: string | undefined;
  description?: string | undefined;
  severity?: string | undefined;
  priority?: string | undefined;
  urgency?: string | undefined;
  service?: string[] | undefined;
  label?: string[] | undefined;
  team?: string | undefined;
  policy?: string | undefined;
  user?: string[] | undefined;
  major?: boolean | undefined;
}): Record<string, unknown> & { title: string } {
  const title = values.title?.trim();
  if (!title) throw new UsageError('What happened? Pass --title <text>');

  const severity = values.severity?.trim().toLowerCase() ?? 'error';
  if (!SEVERITIES.includes(severity)) throw new UsageError('--severity is one of critical, error, warning, info');

  const priority = values.priority?.trim().toUpperCase();
  if (priority !== undefined && !/^P[1-9]$/.test(priority)) throw new UsageError('--priority is P1 to P9');

  const urgency = values.urgency?.trim().toLowerCase();
  if (urgency !== undefined && !/^[a-z][a-z0-9_]{0,31}$/.test(urgency)) {
    throw new UsageError('--urgency is the key of an urgency level, such as high or low');
  }

  const chosen = [values.team, values.policy, values.user?.length ? 'users' : undefined].filter(Boolean);
  if (chosen.length > 1) throw new UsageError('Pass one of --team, --policy or --user');

  const labels: Record<string, string> = {};
  for (const pair of values.label ?? []) {
    const at = pair.indexOf('=');
    if (at <= 0) throw new UsageError(`--label ${pair}: write key=value`);
    labels[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
  }

  const assign = values.team
    ? { kind: 'team', team_id: values.team }
    : values.policy
      ? { kind: 'policy', escalation_policy_id: values.policy }
      : values.user?.length
        ? { kind: 'users', user_ids: values.user }
        : { kind: 'auto' };

  return {
    title,
    severity,
    assign,
    ...(values.description ? { description: values.description } : {}),
    ...(priority ? { priority } : {}),
    ...(urgency ? { urgency } : {}),
    ...(values.service?.length ? { services: values.service } : {}),
    ...(Object.keys(labels).length > 0 ? { labels } : {}),
    ...(values.major ? { declare_major: true } : {}),
  };
}
