#!/usr/bin/env node
import { parseArgs } from 'node:util';

import { ConfigStore, type Connection, resolveConnection } from './config.js';
import { serverAddress } from './endpoint.js';
import { formatLog, parseDuration, readLogs } from './logs.js';
import { type Credentials, describeError, serveStdio } from './mcp.js';
import { signIn, StoredOAuthProvider } from './oauth.js';
import { checkConnection } from './status.js';
import { formatStreams, streamsOf } from './streams.js';
import { ToolSession } from './tools.js';

declare const __VERSION__: string;
const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0';

const HELP = `molesignal ${VERSION} — MoleSignal on the command line

Usage: molesignal <command> [options]

Commands:
  login     Sign in: in the browser, or with an API token (--with-token)
  logout    Forget the saved sign-in
  status    Check the connection: who answers, and how many MCP tools it offers
  streams   List the log streams you can read
  logs      Print the newest logs of a stream; -f keeps printing new ones
  mcp       Serve MoleSignal's MCP tools over stdio, for an agent tool to start

Options:
  --url <address>   The MoleSignal address, such as https://molesignal.example.com
  --token <token>   An API token for this command only (status, streams, logs, mcp)
  --with-token      Sign in with an API token read from stdin (login)
  -h, --help        Show this help
  -v, --version     Show the version

Logs:
  molesignal logs <stream> [options]
  -f, --follow            Keep printing new logs until Ctrl+C
  -n, --lines <count>     How many of the newest logs to print first (default 100, at most 5000)
  --since <duration>      How far back to look: 30s, 10m, 2h, 1d (default 15m)
  --where <condition>     An SQL condition the logs must meet, such as "level = 'error'"
  --interval <duration>   How often a follow looks for new logs (default 2s)
  --json                  Print each log as one line of JSON
  --utc                   Print times in UTC instead of local time

Environment:
  MOLESIGNAL_URL     The address, instead of --url or the saved one
  MOLESIGNAL_TOKEN   An API token, instead of the saved sign-in
  MOLESIGNAL_CONFIG  Where the sign-in is kept (default ~/.config/molesignal/config.json)
  NO_COLOR           Print without colours; FORCE_COLOR prints them even into a pipe

Examples:
  molesignal login --url https://molesignal.example.com
  molesignal logs app_logs -f --where "level = 'error'"
  npx -y @molesignal/cli mcp     the command an agent tool such as Claude Code starts
`;
const err = (line: string) => process.stderr.write(`${line}\n`);

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

/** The connection and how it authenticates, from the options, the environment and the saved sign-in. */
async function credentials(options: { url?: string | undefined; token?: string | undefined }): Promise<{
  store: ConfigStore;
  credentials: Credentials;
}> {
  const store = await ConfigStore.open();
  const connection: Connection = resolveConnection(options, process.env, store.config);
  const signedIn =
    !connection.token &&
    store.config.oauth?.tokens &&
    store.config.url &&
    serverAddress(store.config.url) === connection.url;
  if (!connection.token && !signedIn) {
    throw new Error(
      `Not signed in to ${connection.url}: run \`molesignal login --url ${connection.url}\`, or set MOLESIGNAL_TOKEN`,
    );
  }
  return {
    store,
    credentials: {
      connection,
      ...(signedIn ? { authProvider: new StoredOAuthProvider(store, undefined) } : {}),
    },
  };
}

async function login(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { url: { type: 'string' }, 'with-token': { type: 'boolean' } },
  });
  const store = await ConfigStore.open();
  const url = values.url ?? process.env.MOLESIGNAL_URL ?? store.config.url;
  if (!url) throw new Error('Which MoleSignal? Add --url <address>');
  const address = serverAddress(url);

  if (values['with-token']) {
    const token = await readStdin();
    if (!token) throw new Error('No API token on stdin');
    store.config = { url: address, token };
    await store.save();
  } else {
    err(`Signing in to ${address} in the browser…`);
    await signIn(store, address, { log: err });
  }

  const { credentials: saved } = await credentials({});
  const status = await checkConnection(saved, VERSION);
  err(`Signed in to ${address}: ${status.tools} tools`);
}

async function logout(): Promise<void> {
  const store = await ConfigStore.open();
  store.config = store.config.url ? { url: store.config.url } : {};
  await store.save();
  err('Signed out');
}

async function status(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { url: { type: 'string' }, token: { type: 'string' } },
  });
  const { credentials: found } = await credentials(values);
  const result = await checkConnection(found, VERSION);
  process.stdout.write(
    `${found.connection.url}\n  server: ${result.server}${result.version ? ` ${result.version}` : ''}\n  sign-in: ${
      found.connection.token ? 'API token' : 'browser'
    }\n  tools: ${result.tools}\n`,
  );
}

/** Whether to print colours: on a terminal, unless NO_COLOR says otherwise; FORCE_COLOR asks for them anyway. */
function useColor(): boolean {
  const forced = process.env.FORCE_COLOR;
  if (forced !== undefined && forced !== '' && forced !== '0' && forced !== 'false') return true;
  return process.stdout.isTTY === true && !process.env.NO_COLOR;
}

function parseCount(text: string, name: string, maximum: number): number {
  const count = Number(text);
  if (!Number.isInteger(count) || count < 1 || count > maximum) {
    throw new Error(`${name} takes a whole number from 1 to ${maximum}`);
  }
  return count;
}

async function streams(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { url: { type: 'string' }, token: { type: 'string' }, json: { type: 'boolean' } },
  });
  const { credentials: found } = await credentials(values);
  const session = await ToolSession.open(found, VERSION);

  try {
    const list = streamsOf(await session.call('list_streams', { stream_type: 'logs', limit: 1000 }));
    if (values.json) {
      for (const stream of list) process.stdout.write(`${JSON.stringify(stream)}\n`);
    } else if (list.length === 0) {
      err('No log streams you can read yet');
    } else {
      process.stdout.write(`${formatStreams(list).join('\n')}\n`);
    }
  } finally {
    await session.close();
  }
}

async function logs(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      url: { type: 'string' },
      token: { type: 'string' },
      follow: { type: 'boolean', short: 'f' },
      lines: { type: 'string', short: 'n' },
      since: { type: 'string' },
      where: { type: 'string' },
      interval: { type: 'string' },
      json: { type: 'boolean' },
      utc: { type: 'boolean' },
    },
  });

  const [stream, ...extra] = positionals;
  if (!stream || extra.length > 0) {
    throw new Error('Which stream? Run `molesignal logs <stream>`; `molesignal streams` lists them');
  }

  const options = {
    stream,
    where: values.where,
    since: parseDuration(values.since ?? '15m'),
    lines: parseCount(values.lines ?? '100', '--lines', 5000),
    follow: values.follow ?? false,
    interval: parseDuration(values.interval ?? '2s'),
  };

  const { credentials: found } = await credentials(values);
  let session = await ToolSession.open(found, VERSION);

  // Ctrl+C, or a reader such as `head` that has read enough, ends a follow quietly.
  const stop = new AbortController();
  const quit = () => stop.abort();
  process.once('SIGINT', quit);
  process.once('SIGTERM', quit);
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') quit();
  });

  const color = useColor();
  const tools = {
    call: (name: string, input: Record<string, unknown>) => session.call(name, input),
    reconnect: async () => {
      await session.close().catch(() => undefined);
      session = await ToolSession.open(found, VERSION);
    },
  };

  try {
    await readLogs(tools, options, {
      write: (row) => {
        if (stop.signal.aborted) return;
        process.stdout.write(`${values.json ? JSON.stringify(row) : formatLog(row, { color, utc: values.utc ?? false })}\n`);
      },
      notice: err,
      signal: stop.signal,
    });
  } finally {
    process.off('SIGINT', quit);
    process.off('SIGTERM', quit);
    await session.close().catch(() => undefined);
  }
}

async function mcp(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { url: { type: 'string' }, token: { type: 'string' } },
  });
  const { credentials: found } = await credentials(values);
  await serveStdio(found);
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'login':
        await login(rest);
        return 0;
      case 'logout':
        await logout();
        return 0;
      case 'status':
        await status(rest);
        return 0;
      case 'streams':
        await streams(rest);
        return 0;
      case 'logs':
        await logs(rest);
        return 0;
      case 'mcp':
        await mcp(rest);
        return 0;
      case '-v':
      case '--version':
      case 'version':
        process.stdout.write(`${VERSION}\n`);
        return 0;
      case undefined:
      case '-h':
      case '--help':
      case 'help':
        process.stdout.write(HELP);
        return 0;
      default:
        err(`Unknown command "${command}". Run \`molesignal --help\`.`);
        return 2;
    }
  } catch (error) {
    err(`molesignal: ${describeError(error, { url: '' })}`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
