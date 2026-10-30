import { readFile, writeFile } from 'node:fs/promises';

import { type Command, CONNECTION, CONNECTION_HELP, parse, splitList, UsageError } from './command.js';
import { apiAccess } from './context.js';
import { paint, print, printJson, say, table, terminalWidth, useColor } from './output.js';
import { apiRequest } from './rest.js';

/** What an imported rule would do, as MoleSignal says it. */
export interface ImportItem {
  name: string;
  action: 'create' | 'update' | 'unchanged' | 'skip' | 'error';
  changes?: string[] | undefined;
  error?: string | undefined;
  rule_id?: string | undefined;
  /** The policy, schedule or routing rule written (the other kinds). */
  id?: string | undefined;
}

/** A tried or applied import: one item a rule, notes on what the file had that is not imported. */
export interface ImportReport {
  /** `molesignal` or `prometheus` for rules; the bundle format for the other kinds. */
  format: string;
  items: ImportItem[];
  notes?: string[] | undefined;
  applied: boolean;
}

/** An import report as a table: the action, the name of the item, and what changes or what is wrong. */
export function formatImport(report: ImportReport, options: { color?: boolean; width?: number | undefined } = {}): string[] {
  const color = options.color ?? false;
  const tone = { create: '32', update: '34', unchanged: undefined, skip: undefined, error: '31' } as const;
  const rows = report.items.map((item) => [
    paint(color, tone[item.action], item.action),
    item.name,
    item.error ?? (item.changes?.length ? item.changes.join(', ') : ''),
  ]);
  return table(['ACTION', 'NAME', 'DETAIL'], rows, options);
}

/** How many rules an import writes, and whether any of them is wrong. */
export function importCounts(report: ImportReport): { writes: number; errors: number } {
  return {
    writes: report.items.filter((item) => item.action === 'create' || item.action === 'update').length,
    errors: report.items.filter((item) => item.action === 'error').length,
  };
}

/** What `alerts` moves as files: the path its bundles go out of and come back to, and what one item is called. */
interface Noun {
  path: string;
  listKey: string;
  one: string;
  many: string;
}

const NOUNS: Record<string, Noun> = {
  rules: { path: '/alerts/rules', listKey: 'rules', one: 'rule', many: 'rules' },
  policies: { path: '/alerts/escalations', listKey: 'policies', one: 'escalation policy', many: 'escalation policies' },
  schedules: { path: '/schedules', listKey: 'schedules', one: 'schedule', many: 'schedules' },
  routing: { path: '/alerts/routing/rules', listKey: 'rules', one: 'routing rule', many: 'routing rules' },
};

const USAGE = `Usage: molesignal alerts <rules|policies|schedules|routing> export [options]
       molesignal alerts <rules|policies|schedules|routing> apply -f <file> [options]

rules       Alert rules; apply also takes a Prometheus alerting rule file
            (PrometheusRule too)
policies    Escalation policies
schedules   On-call schedules (overrides and swaps stay where they are)
routing     Routing rules; those of the file go first, in its order

export   Prints the bundle, or writes it to a file. What things refer to is
         named, not given by id (users by email; policies, schedules, teams and
         holiday calendars by name), so the bundle can be applied in another
         workspace.
apply    Applies a bundle. Items are matched by name: a new name is created, a
         known one updated. The whole file is tried first; when any item is
         wrong, nothing is written and the command exits with 1. Apply
         schedules before the policies that page them, and policies before
         the rules and routing rules that name them.

Options of export:
  --ids <ids>        Only these, separated by commas
  -o, --output <file>  Write the bundle to a file

Options of apply:
  -f, --file <file>  The bundle or rule file (- reads standard input)
  --dry-run          Only show what would happen
  --create-only      Leave what already has a name as it is
  --json             Print the report as JSON
${CONNECTION_HELP}`;

const plural = (count: number, noun: Noun) => `${count} ${count === 1 ? noun.one : noun.many}`;

export const alertsCommand: Command = {
  name: 'alerts',
  group: 'Alerting',
  summary: 'Export alert rules, escalation policies, schedules and routing rules, or apply them from a file (CI)',
  usage: USAGE,

  async run(args) {
    const { values, positionals } = parse('alerts', args, {
      ...CONNECTION,
      ids: { type: 'string' },
      output: { type: 'string', short: 'o' },
      file: { type: 'string', short: 'f' },
      'dry-run': { type: 'boolean' },
      'create-only': { type: 'boolean' },
      json: { type: 'boolean' },
    });

    const [name, verb, ...extra] = positionals;
    const noun = name ? NOUNS[name] : undefined;
    if (!noun || (verb !== 'export' && verb !== 'apply')) {
      throw new UsageError('Run `molesignal alerts <rules|policies|schedules|routing> export` or `… apply -f <file>`');
    }
    if (extra.length > 0) throw new UsageError(`Unexpected "${extra[0]}"; see \`molesignal alerts --help\``);

    const api = await apiAccess(values);

    if (verb === 'export') {
      const ids = splitList(values.ids);
      const bundle = await apiRequest(api, 'GET', `${noun.path}/export`, {
        query: { ids: ids.length > 0 ? ids.join(',') : undefined },
      });
      const text = `${JSON.stringify(bundle, null, 2)}\n`;
      if (values.output) {
        await writeFile(values.output, text);
        const items = (bundle as Record<string, unknown>)[noun.listKey];
        say(`Wrote ${plural(Array.isArray(items) ? items.length : 0, noun)} to ${values.output}`);
      } else {
        process.stdout.write(text);
      }
      return 0;
    }

    if (!values.file) throw new UsageError('Which file? Pass -f <file>, or -f - for standard input');
    const content = values.file === '-' ? await readStdin() : await readFile(values.file, 'utf8');
    const createOnly = values['create-only'] ?? false;

    const tried = (await apiRequest(api, 'POST', `${noun.path}/import`, {
      json: { content, dry_run: true, create_only: createOnly },
    })) as ImportReport;
    const { writes, errors } = importCounts(tried);

    let report = tried;
    if (!values['dry-run'] && errors === 0 && writes > 0) {
      report = (await apiRequest(api, 'POST', `${noun.path}/import`, {
        json: { content, dry_run: false, create_only: createOnly },
      })) as ImportReport;
    }

    if (values.json) {
      printJson(report);
    } else {
      print(formatImport(report, { color: useColor(), width: terminalWidth() }));
      for (const note of report.notes ?? []) say(`note: ${note}`);
      if (errors > 0) say(`${plural(errors, noun)} ${errors === 1 ? 'is' : 'are'} wrong; nothing was written`);
      else if (report.applied) say(`Applied ${plural(writes, noun)}`);
      else if (writes === 0) say('Nothing to change');
      else say(`Would write ${plural(writes, noun)}; run without --dry-run to apply`);
    }

    return errors > 0 ? 1 : 0;
  },
};

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}
