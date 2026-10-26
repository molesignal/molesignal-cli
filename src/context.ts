import type { FetchLike } from '@modelcontextprotocol/client';

import { type Connection, ConfigStore, DEFAULT_PROFILE, profileName, resolveConnection } from './config.js';
import { serverAddress } from './endpoint.js';
import type { Credentials } from './mcp.js';
import { networkFetch } from './net.js';
import { StoredOAuthProvider } from './oauth.js';
import { type SessionOptions, ToolSession } from './tools.js';
import { VERSION } from './version.js';

/** The connection options a command was given. */
export interface ConnectionOptions {
  url?: string | undefined;
  token?: string | undefined;
  profile?: string | undefined;
}

/** A command's sign-in: the configuration, the profile it uses, and how it authenticates. */
export interface SignedIn {
  store: ConfigStore;
  profile: string;
  credentials: Credentials;
}

/**
 * The connection and how it authenticates, from the options, the environment
 * and the saved profile: an API token when one is given, else the profile's
 * browser sign-in.
 */
export async function signedIn(options: ConnectionOptions, env: NodeJS.ProcessEnv = process.env): Promise<SignedIn> {
  const store = await ConfigStore.open();
  const profile = profileName(options.profile, env, store.config);
  const saved = store.config.profiles?.[profile] ?? {};
  const connection = resolveConnection(options, env, saved);
  const browser =
    !connection.token && saved.oauth?.tokens && saved.url && serverAddress(saved.url) === connection.url;

  if (!connection.token && !browser) {
    const which = profile === DEFAULT_PROFILE ? '' : ` --profile ${profile}`;
    throw new Error(
      `Not signed in to ${connection.url}: run \`molesignal login --url ${connection.url}${which}\`, or set MOLESIGNAL_TOKEN`,
    );
  }

  return {
    store,
    profile,
    credentials: {
      connection,
      ...(browser ? { authProvider: new StoredOAuthProvider(store, profile, undefined) } : {}),
      fetch: await networkFetch(env),
    },
  };
}

/** Opens a tool session for a command, runs it, and closes the session however it ends. */
export async function withSession<T>(
  options: ConnectionOptions,
  run: (session: ToolSession, signed: SignedIn) => Promise<T>,
  sessionOptions: SessionOptions = {},
): Promise<T> {
  const signed = await signedIn(options);
  const session = await ToolSession.open(signed.credentials, VERSION, sessionOptions);
  try {
    return await run(session, signed);
  } finally {
    await session.close().catch(() => undefined);
  }
}

/** What a command needs to call MoleSignal's API: the address, an API token, and what makes requests. */
export interface Api {
  connection: Connection & { token: string };
  fetch: FetchLike;
}

/**
 * The API connection of a command that uploads or writes data. Those calls
 * take an API token: a browser sign-in is good for the MCP endpoint only.
 */
export async function apiAccess(options: ConnectionOptions, env: NodeJS.ProcessEnv = process.env): Promise<Api> {
  const store = await ConfigStore.open();
  const profile = profileName(options.profile, env, store.config);
  const connection = resolveConnection(options, env, store.config.profiles?.[profile] ?? {});
  if (!connection.token) {
    throw new Error(
      'This command needs an API token: set MOLESIGNAL_TOKEN, add --token, or run `molesignal login --with-token`. ' +
        'Create one in MoleSignal under Identity and access → API tokens.',
    );
  }
  return { connection: { url: connection.url, token: connection.token }, fetch: await networkFetch(env) };
}
