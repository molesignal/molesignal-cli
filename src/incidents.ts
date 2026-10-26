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

Lists incidents, newest first. \`show\` prints one, with its root-cause analysis
when --rca is given. \`ack\` and \`resolve\` change it through MoleSignal's tool
policy: at once, after you confirm, or once reviewers approve.

Options:
  --status <status>     active (default), resolved or all
  --since <duration>    Only incidents opened since then: 1h, 7d
  -n, --limit <count>   How many incidents (default 50, at most 500)
  --rca                 With show: print the root-cause analysis too
  --json                Print JSON
  --web                 With show: open the incident in MoleSignal instead
${CHANGE_HELP}
${CONNECTION_HELP}

Exit status of ack and resolve: 0 when done, 3 when it waits for approval.`;

export const incidentsCommand: Command = {
  name: 'incidents',
  group: 'On-call and changes',
  summary: 'Incidents: list, show with root cause, acknowledge, resolve',
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

    if (action) throw new UsageError(`Unknown "${action}": use show, ack or resolve; see \`molesignal incidents --help\``);

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
