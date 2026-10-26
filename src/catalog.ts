import { readFile } from 'node:fs/promises';

import { CHANGE, CHANGE_HELP, changeOptions, confirmations, makeChange, reportChange } from './changes.js';
import { type Command, CONNECTION, CONNECTION_HELP, onePositional, parse, UsageError } from './command.js';
import { withSession } from './context.js';
import { print, printJson, printJsonLines, say, table, terminalWidth } from './output.js';
import { timeWindow } from './time.js';
import type { ToolSession } from './tools.js';

/** A tool as MoleSignal's catalogue describes it. */
export interface ToolInfo {
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  domain?: string | undefined;
  category?: string | undefined;
  risk?: string | undefined;
  access?: string | undefined;
  execution_mode?: string | undefined;
  required_permissions?: string[] | undefined;
  input_schema?: unknown;
}

/** The tools of a `tool_search` result or of the `molesignal://tools/catalog` resource. */
export function toolsOf(result: unknown): ToolInfo[] {
  const tools = result && typeof result === 'object' && 'tools' in result ? (result.tools as unknown) : undefined;
  return Array.isArray(tools) ? tools.filter((tool): tool is ToolInfo => typeof tool?.name === 'string') : [];
}

/** What a call to the tool does, in a word: reads, changes, or carries out an approved change. */
export function accessWord(access: string | undefined): string {
  if (access === 'read_only' || access === 'preflight') return 'read';
  if (access === 'executes_approved_operation') return 'execute';
  if (access === 'managed_mutation' || access === 'creates_approval_request') return 'change';
  return access ?? '';
}

/** Tools as a table: name, what a call does, how a change runs under the policy, and what it is for. */
export function formatTools(tools: ToolInfo[], options: { width?: number | undefined } = {}): string[] {
  const rows = tools.map((tool) => [
    tool.name,
    accessWord(tool.access),
    accessWord(tool.access) === 'change' ? (tool.execution_mode ?? '').replace('_', ' ') : '',
    tool.description ?? '',
  ]);
  return table(['TOOL', 'CALL', 'POLICY', 'DESCRIPTION'], rows, options);
}

/** The one tool of that exact name, with its input schema. */
async function findTool(session: ToolSession, name: string): Promise<ToolInfo> {
  const found = toolsOf(await session.call('tool_search', { query: name, limit: 10, include_schema: true }));
  const tool = found.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`No tool ${name} you may call: \`molesignal tools <words>\` finds tools`);
  return tool;
}

/** The JSON-schema type of a property, as a word: `integer`, `number`, `boolean`, `object`… */
function propertyType(schema: unknown, path: string[]): string | undefined {
  let node = schema;
  for (const key of path) {
    const properties = node && typeof node === 'object' && 'properties' in node ? (node.properties as Record<string, unknown>) : undefined;
    node = properties?.[key];
    if (!node) return undefined;
  }
  const type = node && typeof node === 'object' && 'type' in node ? node.type : undefined;
  return Array.isArray(type) ? type.find((one) => one !== 'null') : typeof type === 'string' ? type : undefined;
}

/** A value written as text, turned into the type its schema asks for. */
function typed(text: string, type: string | undefined, key: string): unknown {
  if (type === 'integer' || type === 'number') {
    const value = Number(text);
    if (!Number.isFinite(value) || (type === 'integer' && !Number.isInteger(value))) throw new UsageError(`${key} takes ${type === 'integer' ? 'a whole number' : 'a number'}`);
    return value;
  }
  if (type === 'boolean') {
    if (!/^(true|false)$/i.test(text)) throw new UsageError(`${key} takes true or false`);
    return /^true$/i.test(text);
  }
  if (type === 'array' || type === 'object') {
    try {
      return JSON.parse(text);
    } catch {
      if (type === 'array') return text.split(',').map((item) => item.trim());
      throw new UsageError(`${key} takes JSON: write it ${key}:='{…}'`);
    }
  }
  return text;
}

/**
 * The arguments of `molesignal call`, from `name=value` (text, turned into
 * the type the tool's schema asks for) and `name:=json` (JSON as written).
 * A dotted name sets a field inside an object: `time_range.start_micros:=0`.
 */
export function callArguments(pairs: string[], schema: unknown, base: Record<string, unknown> = {}): Record<string, unknown> {
  const args: Record<string, unknown> = structuredClone(base);
  for (const pair of pairs) {
    const match = /^([A-Za-z_][\w.-]*)(:=|=)([\s\S]*)$/.exec(pair);
    if (!match) throw new UsageError(`"${pair}" is not name=value or name:=json`);
    const [, name, sign, text] = match as unknown as [string, string, string, string];
    const path = name.split('.');
    let value: unknown;
    if (sign === ':=') {
      try {
        value = JSON.parse(text);
      } catch {
        throw new UsageError(`${name}:= takes JSON, not ${text}`);
      }
    } else {
      value = typed(text, propertyType(schema, path), name);
    }

    let node = args;
    for (const key of path.slice(0, -1)) {
      if (!node[key] || typeof node[key] !== 'object') node[key] = {};
      node = node[key] as Record<string, unknown>;
    }
    node[path.at(-1)!] = value;
  }
  return args;
}

export const toolsCommand: Command = {
  name: 'tools',
  group: 'Tools and setup',
  summary: 'Search the tools MoleSignal offers you; show one with its arguments',
  usage: `Usage: molesignal tools [words…] [options]
       molesignal tools show <tool>

Lists the tools you may call, with what a call does (read, change), how a
change runs under your organization's tool policy, and what each is for.
Words narrow the list to the tools they best describe. \`show\` prints one
tool with the arguments it takes. Any of them runs with \`molesignal call\`.

Options:
  --domain <domain>   Only tools of this domain, such as observability or alerts_on_call
  --json              Print JSON
${CONNECTION_HELP}

Examples:
  molesignal tools incident
  molesignal tools show list_rum_sessions`,

  async run(args) {
    const { values, positionals } = parse('tools', args, { ...CONNECTION, domain: { type: 'string' }, json: { type: 'boolean' } });
    const [action, ...rest] = positionals;

    if (action === 'show') {
      const name = onePositional('tools', rest, 'tool');
      const tool = await withSession(values, (session) => findTool(session, name));
      if (values.json) {
        printJson(tool);
        return;
      }
      const lines = [`${tool.name} · ${accessWord(tool.access)}${accessWord(tool.access) === 'change' ? ` · ${tool.execution_mode ?? ''}` : ''}`, tool.description ?? '', ''];
      if (tool.required_permissions?.length) lines.push(`Permissions: ${tool.required_permissions.join(', ')}`, '');
      lines.push('Arguments:', JSON.stringify(tool.input_schema ?? {}, null, 2));
      print(lines);
      return;
    }

    const words = positionals.join(' ').trim();
    const tools = await withSession(values, async (session) => {
      if (!words) {
        const all = await session.resource('molesignal://tools/catalog').then(toolsOf, () => undefined);
        if (all) return values.domain ? all.filter((tool) => tool.domain === values.domain) : all;
      }
      return toolsOf(
        await session.call('tool_search', { query: words, limit: 50, include_schema: false, ...(values.domain ? { domain: values.domain } : {}) }),
      );
    });
    if (values.json) printJsonLines(tools);
    else if (tools.length === 0) say('No tools found');
    else print(formatTools(tools, { width: terminalWidth() }));
  },
};

export const callCommand: Command = {
  name: 'call',
  group: 'Tools and setup',
  summary: 'Call any MoleSignal tool with arguments; print its JSON',
  usage: `Usage: molesignal call <tool> [name=value | name:=json]… [options]

Calls one tool of MoleSignal's catalogue and prints what it returns as JSON.
\`name=value\` is turned into the type the tool takes; \`name:=json\` is JSON as
written; a dotted name sets a field inside an object. A tool that changes
something goes through your organization's tool policy, as with the other
commands: at once, after you confirm, or once reviewers approve.

Options:
  --input <file>        Arguments as a JSON object from a file, or - for stdin
  --since <duration>    Set time_range to this long back from now
  --from <time>         Set time_range to start at this time
  --to <time>           Set time_range to end at this time
${CHANGE_HELP}
${CONNECTION_HELP}

Examples:
  molesignal call list_rum_sessions --since 1h limit=20
  molesignal call get_apm_insights service=checkout --since 6h
  molesignal call trigger_alert_rule rule_id=01J… --reason "Testing the pager"`,

  async run(args) {
    const { values, positionals } = parse('call', args, {
      ...CONNECTION,
      ...CHANGE,
      input: { type: 'string' },
      since: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
    });
    const [name, ...pairs] = positionals;
    if (!name) throw new UsageError('Which tool? Run `molesignal call <tool> name=value…`; `molesignal tools` lists them');

    let base: Record<string, unknown> = {};
    if (values.input) {
      const text = values.input === '-' ? await readStdin() : await readFile(values.input, 'utf8');
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new UsageError('--input holds a JSON object');
      base = parsed as Record<string, unknown>;
    }

    return withSession(
      values,
      async (session, signed) => {
        const tool = await findTool(session, name);
        const callArgs = callArguments(pairs, tool.input_schema, base);
        if ((values.since || values.from || values.to) && propertyType(tool.input_schema, ['time_range'])) {
          callArgs.time_range = timeWindow(values, '1h');
        }

        const access = accessWord(tool.access);
        if (access === 'read') {
          printJson(await session.read(name, callArgs));
          return 0;
        }
        if (access === 'execute') {
          printJson(await session.call(name, callArgs));
          return 0;
        }

        const { reason, impact, ...rest } = callArgs;
        const options = changeOptions(
          { ...values, reason: typeof reason === 'string' ? reason : values.reason },
          signed.credentials.connection.url,
          {
            reason: `Called ${name} from the molesignal command line`,
            impact: typeof impact === 'string' ? impact : `${name} with ${JSON.stringify(rest)}`.slice(0, 2000),
          },
        );
        const outcome = await makeChange(session, name, rest, options);
        if (outcome.state === 'done') printJson(outcome.execution);
        return reportChange(outcome, `Called ${name}`, options);
      },
      confirmations(values),
    );
  },
};

/** All of stdin, as text. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
