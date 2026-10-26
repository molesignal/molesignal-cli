import type { Readable, Writable } from 'node:stream';

import {
  type FetchLike,
  type JSONRPCMessage,
  type OAuthClientProvider,
  SdkHttpError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client';

import type { Connection } from './config.js';
import { mcpEndpoint } from './endpoint.js';

/** How a connection to MoleSignal's MCP endpoint authenticates. */
export interface Credentials {
  connection: Connection;
  /** The browser sign-in, used when the connection carries no API token. */
  authProvider?: OAuthClientProvider | undefined;
  /** What makes the HTTP requests: Node's fetch, one through a proxy, or a stand-in in tests. */
  fetch?: FetchLike | undefined;
}

/** The transport to MoleSignal's MCP endpoint, with the API token or the browser sign-in. */
export function remoteTransport(credentials: Credentials): StreamableHTTPClientTransport {
  const { connection, authProvider, fetch } = credentials;
  return new StreamableHTTPClientTransport(mcpEndpoint(connection.url), {
    ...(connection.token
      ? { requestInit: { headers: { authorization: `Bearer ${connection.token}` } } }
      : authProvider
        ? { authProvider }
        : {}),
    ...(fetch ? { fetch } : {}),
  });
}

/** What MoleSignal said when it refused a request: the message of its JSON answer, else its text. */
export function refusalOf(text: unknown): string | undefined {
  if (typeof text !== 'string' || !text.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && 'message' in parsed && typeof parsed.message === 'string') {
      return parsed.message;
    }
  } catch {
    // Not JSON: the text itself, shortened.
  }
  return text.trim().slice(0, 300);
}

/**
 * What went wrong, said so that the person at the agent tool knows what to do.
 * Without the connection, a refused sign-in names both ways of signing in.
 */
export function describeError(error: unknown, connection?: Connection): string {
  if (error instanceof UnauthorizedError) {
    return 'MoleSignal needs you to sign in again: run `molesignal login`';
  }
  if (error instanceof SdkHttpError) {
    const said = refusalOf(error.data.text);
    const because = said ? `: ${said}` : '';
    if (error.status === 401) {
      if (!connection) return `MoleSignal refused the sign-in (HTTP 401${because}); check the API token, or run \`molesignal login\``;
      return connection.token
        ? `MoleSignal refused the API token (HTTP 401${because}); create a new one, or run \`molesignal login\``
        : `MoleSignal refused the request (HTTP 401${because}); run \`molesignal login\``;
    }
    return `MoleSignal refused the request (HTTP ${error.status}${because})`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Whether MoleSignal no longer knows the session a request was sent in, as after it restarted. */
function sessionLost(error: unknown): boolean {
  return error instanceof SdkHttpError && error.status === 404;
}

function isRequest(message: JSONRPCMessage): message is JSONRPCMessage & { id: string | number; method: string } {
  return 'method' in message && 'id' in message;
}

function isInitialize(message: JSONRPCMessage): boolean {
  return isRequest(message) && message.method === 'initialize';
}

function isInitialized(message: JSONRPCMessage): boolean {
  return 'method' in message && !('id' in message) && message.method === 'notifications/initialized';
}

/** Calls `onmessage` with each message the stream carries, one JSON-RPC message a line. */
function readLines(stream: Readable, onmessage: (message: JSONRPCMessage) => void, log: (line: string) => void): void {
  let buffered = '';
  stream.on('data', (chunk: Buffer | string) => {
    buffered += chunk.toString();
    let end: number;
    while ((end = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, end).replace(/\r$/, '');
      buffered = buffered.slice(end + 1);
      if (!line.trim()) continue;
      let message: JSONRPCMessage;
      try {
        message = JSON.parse(line) as JSONRPCMessage;
      } catch (error) {
        log(`a line on stdin is not a JSON-RPC message: ${(error as Error).message}`);
        continue;
      }
      onmessage(message);
    }
  });
}

/**
 * Serves MoleSignal's MCP tools over stdio: every message the agent tool writes
 * goes to MoleSignal, every message MoleSignal sends comes back on stdout. A
 * request MoleSignal cannot be reached for is answered with an error, so the
 * tool does not wait for nothing. Ends when the tool closes the input.
 *
 * Until the tool has said `initialized`, messages go one after the other:
 * MoleSignal opens the session with its answer to `initialize` and takes
 * nothing else before it, and a tool may write them all at once. After that
 * they go as they come, so one slow tool call does not hold up the others.
 *
 * When MoleSignal no longer knows the session, as after it restarted, the
 * session is opened again with the tool's own `initialize` and the message
 * sent again, so the tool goes on without being restarted.
 */
export async function serveStdio(
  credentials: Credentials,
  options: { stdin?: Readable; stdout?: Writable; log?: (line: string) => void } = {},
): Promise<void> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const log = options.log ?? ((line: string) => process.stderr.write(`molesignal: ${line}\n`));
  const write = (message: JSONRPCMessage) => {
    stdout.write(`${JSON.stringify(message)}\n`);
  };

  // Closing the session at the end aborts its event stream; that is not worth telling.
  let closing = false;
  let initialize: JSONRPCMessage | undefined;
  let initialized = false;
  let reopening: Promise<void> | undefined;
  let reopened = 0;
  const waiting = new Map<string, (message: JSONRPCMessage) => void>();

  const connect = async () => {
    const transport = remoteTransport(credentials);
    transport.onmessage = (message) => {
      const id = 'id' in message ? String(message.id) : undefined;
      const answer = id === undefined ? undefined : waiting.get(id);
      if (answer) {
        waiting.delete(id!);
        answer(message);
        return;
      }
      write(message);
    };
    transport.onerror = (error) => {
      if (!closing) log(describeError(error, credentials.connection));
    };
    await transport.start();
    return transport;
  };

  let remote = await connect();

  /** Opens the session again the way the tool opened it, answering MoleSignal's `initialize` here. */
  const reopen = async () => {
    const lost = remote;
    remote = await connect();
    void lost.close().catch(() => undefined);
    if (!initialize || !isRequest(initialize)) return;

    reopened += 1;
    const id = `molesignal-reopen-${reopened}`;
    const answered = new Promise<JSONRPCMessage>((resolve) => waiting.set(id, resolve));
    await remote.send({ ...initialize, id } as JSONRPCMessage);
    const answer = await answered;
    if ('error' in answer) throw new Error(`MoleSignal did not open the session again: ${answer.error.message}`);
    if (initialized) await remote.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    log('MoleSignal lost the session, as after a restart; opened a new one');
  };

  const forward = async (message: JSONRPCMessage) => {
    try {
      try {
        await remote.send(message);
      } catch (error) {
        if (!sessionLost(error) || isInitialize(message) || !initialize) throw error;
        reopening ??= reopen().finally(() => {
          reopening = undefined;
        });
        await reopening;
        await remote.send(message);
      }
    } catch (error) {
      const reason = describeError(error, credentials.connection);
      log(reason);
      if (isRequest(message)) {
        write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: reason } });
      }
    }
  };

  let opening: Promise<void> = Promise.resolve();
  let open = false;

  readLines(
    stdin,
    (message) => {
      if (isInitialize(message)) initialize = message;
      if (isInitialized(message)) initialized = true;
      if (open) {
        void forward(message);
        return;
      }
      opening = opening.then(() => forward(message));
      if (isInitialized(message)) {
        opening = opening.then(() => {
          open = true;
        });
      }
    },
    log,
  );

  await new Promise<void>((resolve) => {
    const finish = () => {
      stdin.off('end', finish);
      stdin.off('close', finish);
      resolve();
    };
    stdin.on('end', finish);
    stdin.on('close', finish);
  });
  await opening;

  // The session at MoleSignal ends with the tool that used it.
  closing = true;
  await remote.terminateSession().catch(() => undefined);
  await remote.close().catch(() => undefined);
}
