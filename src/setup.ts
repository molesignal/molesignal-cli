import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { type Command, CONNECTION, CONNECTION_HELP, parse, UsageError } from './command.js';
import { signedIn } from './context.js';
import { serveStdio } from './mcp.js';
import { print, say } from './output.js';

/** How an agent tool starts this command as its MCP server. */
export interface ServerEntry {
  command: string;
  args: string[];
}

/** The server entry: through npx, or the installed command, for a profile when one is named. */
export function serverEntry(options: { installed?: boolean | undefined; profile?: string | undefined }): ServerEntry {
  const own = ['mcp', ...(options.profile ? ['--profile', options.profile] : [])];
  return options.installed ? { command: 'molesignal', args: own } : { command: 'npx', args: ['-y', '@molesignal/cli', ...own] };
}

/** A JSON configuration file with the server under `key` added, or put in place of the one there. */
export function withJsonServer(text: string | undefined, key: string, entry: Record<string, unknown>): string {
  let config: Record<string, unknown> = {};
  if (text?.trim()) {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('it does not hold a JSON object');
    config = parsed as Record<string, unknown>;
  }
  const servers = config[key] && typeof config[key] === 'object' ? (config[key] as Record<string, unknown>) : {};
  return `${JSON.stringify({ ...config, [key]: { ...servers, molesignal: entry } }, null, 2)}\n`;
}

const tomlString = (value: string) => JSON.stringify(value);

/** Codex's TOML configuration with the `[mcp_servers.molesignal]` table added, or put in place of the one there. */
export function withTomlServer(text: string | undefined, entry: ServerEntry): string {
  const block = [
    '[mcp_servers.molesignal]',
    `command = ${tomlString(entry.command)}`,
    `args = [${entry.args.map(tomlString).join(', ')}]`,
  ];
  const lines = (text ?? '').split('\n');
  const start = lines.findIndex((line) => line.trim() === '[mcp_servers.molesignal]');
  if (start < 0) {
    const kept = (text ?? '').replace(/\n*$/, '');
    return `${kept ? `${kept}\n\n` : ''}${block.join('\n')}\n`;
  }
  let end = start + 1;
  while (end < lines.length && !lines[end]!.trim().startsWith('[')) end += 1;
  // Keep the blank line before the next table.
  while (end > start + 1 && !lines[end - 1]!.trim()) end -= 1;
  return [...lines.slice(0, start), ...block, ...lines.slice(end)].join('\n');
}

async function readIfThere(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** The agent tools `mcp setup` knows, where each keeps its MCP servers, and how. */
const CLIENTS: Record<string, { file: (project: boolean) => string; write: (text: string | undefined, entry: ServerEntry) => string }> = {
  cursor: {
    file: (project) => (project ? join(process.cwd(), '.cursor', 'mcp.json') : join(homedir(), '.cursor', 'mcp.json')),
    write: (text, entry) => withJsonServer(text, 'mcpServers', { ...entry }),
  },
  vscode: {
    file: () => join(process.cwd(), '.vscode', 'mcp.json'),
    write: (text, entry) => withJsonServer(text, 'servers', { type: 'stdio', ...entry }),
  },
  gemini: {
    file: (project) => (project ? join(process.cwd(), '.gemini', 'settings.json') : join(homedir(), '.gemini', 'settings.json')),
    write: (text, entry) => withJsonServer(text, 'mcpServers', { ...entry }),
  },
  codex: {
    file: () => join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml'),
    write: (text, entry) => withTomlServer(text, entry),
  },
};

const run = promisify(execFile);

/** Adds the server to Claude Code with its own command; prints the command when Claude Code is not here. */
async function setupClaude(entry: ServerEntry, scope: string, printOnly: boolean): Promise<void> {
  const args = ['mcp', 'add', '--scope', scope, 'molesignal', '--', entry.command, ...entry.args];
  const written = `claude ${args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(' ')}`;
  if (printOnly) {
    print(written);
    return;
  }
  try {
    await run('claude', args, { timeout: 30_000 });
    say(`Added molesignal to Claude Code (${scope} scope)`);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string };
    if (failure.code === 'ENOENT') {
      say('Claude Code is not on the PATH here; run this where it is:');
      print(written);
      return;
    }
    const said = failure.stderr?.trim() || failure.message;
    if (/already exists/i.test(said)) throw new Error(`Claude Code has a molesignal server already: \`claude mcp remove molesignal --scope ${scope}\` first`);
    throw new Error(`claude mcp add failed: ${said}`);
  }
}

const usage = `Usage: molesignal mcp [options]
       molesignal mcp setup <claude|cursor|codex|vscode|gemini> [options]

\`molesignal mcp\` serves MoleSignal's MCP tools over stdio, for an agent tool
to start: it passes every message on to MoleSignal and its answers back.
When MoleSignal restarts and forgets the session, a new one is opened and the
tool goes on.

\`molesignal mcp setup\` adds this command as an MCP server to an agent tool:
  claude   runs \`claude mcp add\` (--scope user, project or local)
  cursor   ~/.cursor/mcp.json, or .cursor/mcp.json here with --scope project
  codex    ~/.codex/config.toml
  vscode   .vscode/mcp.json here
  gemini   ~/.gemini/settings.json, or .gemini/settings.json here with --scope project

Options:
  --scope <scope>    With setup: user (default) or project; local for Claude Code
  --installed        With setup: start the installed molesignal instead of npx
  --print            With setup: print the configuration instead of writing it
${CONNECTION_HELP}
  (with setup, --profile is written into the configuration, so the tool uses that profile)`;

export const mcpCommand: Command = {
  name: 'mcp',
  group: 'Tools and setup',
  summary: "Serve MoleSignal's MCP tools over stdio; `mcp setup` adds them to an agent tool",
  usage,

  async run(args) {
    const { values, positionals } = parse('mcp', args, {
      ...CONNECTION,
      scope: { type: 'string' },
      installed: { type: 'boolean' },
      print: { type: 'boolean' },
    });
    const [action, client, ...extra] = positionals;

    if (!action) {
      const signed = await signedIn(values);
      await serveStdio(signed.credentials);
      return;
    }
    if (action !== 'setup') throw new UsageError(`Unknown "${action}"; see \`molesignal mcp --help\``);
    if (!client || extra.length > 0) throw new UsageError('Which agent tool? claude, cursor, codex, vscode or gemini');

    const entry = serverEntry({ installed: values.installed, profile: values.profile });
    const scope = values.scope ?? 'user';
    if (client === 'claude') {
      if (!['user', 'project', 'local'].includes(scope)) throw new UsageError('--scope is user, project or local');
      await setupClaude(entry, scope, values.print ?? false);
      return;
    }

    const target = CLIENTS[client];
    if (!target) throw new UsageError(`No agent tool "${client}": claude, cursor, codex, vscode or gemini`);
    if (!['user', 'project'].includes(scope)) throw new UsageError('--scope is user or project');
    const file = target.file(scope === 'project');

    if (values.print) {
      print(target.write(undefined, entry).trimEnd());
      return;
    }
    const before = await readIfThere(file);
    let after: string;
    try {
      after = target.write(before, entry);
    } catch (error) {
      throw new Error(`Cannot add the server to ${file}: ${(error as Error).message}. Add it by hand: \`molesignal mcp setup ${client} --print\``);
    }
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, after);
    say(`${before === undefined ? 'Wrote' : 'Updated'} ${file}: ${client} starts \`${[entry.command, ...entry.args].join(' ')}\``);
  },
};
