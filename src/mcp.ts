import type { Readable, Writable } from 'node:stream';

import { type OAuthClientProvider, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

import type { Connection } from './config.js';
import { mcpEndpoint } from './endpoint.js';

/** How a connection to MoleSignal's MCP endpoint authenticates. */
export interface Credentials {
  connection: Connection;
  /** The browser sign-in, used when the connection carries no API token. */
  authProvider?: OAuthClientProvider | undefined;
  /** For tests: what makes the HTTP requests. */
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

/** What went wrong, said so that the person at the agent tool knows what to do. */
export function describeError(error: unknown, connection: Connection): string {
  if (error instanceof UnauthorizedError) {
    return 'MoleSignal needs you to sign in again: run `molesignal login`';
  }
  if (error instanceof StreamableHTTPError && (error.code === 401 || error.code === 403)) {
    return connection.token
      ? `MoleSignal refused the API token (HTTP ${error.code}); create a new one, or run \`molesignal login\``
      : `MoleSignal refused the request (HTTP ${error.code}); run \`molesignal login\``;
  }
  return error instanceof Error ? error.message : String(error);
}

function isRequest(message: JSONRPCMessage): message is JSONRPCMessage & { id: string | number; method: string } {
  return 'method' in message && 'id' in message;
}

function isInitialized(message: JSONRPCMessage): boolean {
  return 'method' in message && !('id' in message) && message.method === 'notifications/initialized';
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
 */
export async function serveStdio(
  credentials: Credentials,
  options: { stdin?: Readable; stdout?: Writable; log?: (line: string) => void } = {},
): Promise<void> {
  const stdin = options.stdin ?? process.stdin;
  const log = options.log ?? ((line: string) => process.stderr.write(`molesignal: ${line}\n`));
  const remote = remoteTransport(credentials);
  const local = new StdioServerTransport(stdin, options.stdout ?? process.stdout);

  const forward = (message: JSONRPCMessage) =>
    remote.send(message).catch((error: unknown) => {
      const reason = describeError(error, credentials.connection);
      log(reason);
      if (isRequest(message)) {
        void local.send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32000, message: reason },
        });
      }
    });

  let opening: Promise<void> = Promise.resolve();
  let open = false;

  local.onmessage = (message) => {
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
  };
  remote.onmessage = (message) => {
    local.send(message).catch((error: unknown) => log(describeError(error, credentials.connection)));
  };
  // Closing the session at the end aborts its event stream; that is not worth telling.
  let closing = false;
  remote.onerror = (error) => {
    if (!closing) log(describeError(error, credentials.connection));
  };
  local.onerror = (error) => log(describeError(error, credentials.connection));

  const ended = new Promise<void>((resolve) => {
    const finish = () => {
      stdin.off('end', finish);
      stdin.off('close', finish);
      resolve();
    };
    stdin.on('end', finish);
    stdin.on('close', finish);
  });

  await remote.start();
  await local.start();
  await ended;
  await opening;

  // The session at MoleSignal ends with the tool that used it.
  closing = true;
  await remote.terminateSession().catch(() => undefined);
  await Promise.allSettled([local.close(), remote.close()]);
}
