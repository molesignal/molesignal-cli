import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  auth,
  type FetchLike,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type OAuthTokens,
} from '@modelcontextprotocol/client';

import { type ConfigStore, PendingConfigStore, type StoredOAuth } from './config.js';
import { mcpEndpoint, serverAddress } from './endpoint.js';
import { pageLanguage, signInPage } from './page.js';
import { openInBrowser } from './web.js';

/** What MoleSignal grants a client: MCP, and refresh tokens to stay signed in. */
export const OAUTH_SCOPE = 'mcp offline_access';

/** How long a browser sign-in may take before the command gives up. */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

/**
 * The browser sign-in, kept in a profile of the configuration: the client
 * registered for this machine, its tokens, and the PKCE verifier while a
 * sign-in is under way. Without a way to open a browser (as when serving MCP),
 * a sign-in that has run out asks for `molesignal login` instead.
 */
export class StoredOAuthProvider implements OAuthClientProvider {
  private pendingState: string | undefined;

  constructor(
    private readonly store: ConfigStore,
    private readonly profile: string,
    private readonly redirect: string | undefined,
    private readonly openBrowser?: (url: URL) => void,
  ) {}

  private get oauth(): StoredOAuth {
    const profile = this.store.profile(this.profile);
    profile.oauth ??= {};
    return profile.oauth;
  }

  get redirectUrl(): string | undefined {
    return this.redirect ?? this.oauth.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'MoleSignal CLI',
      redirect_uris: this.redirectUrl ? [this.redirectUrl] : [],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: OAUTH_SCOPE,
    };
  }

  state(): string {
    this.pendingState = randomBytes(16).toString('base64url');
    return this.pendingState;
  }

  /** The state sent with the sign-in that is under way. */
  get expectedState(): string | undefined {
    return this.pendingState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.oauth.client;
  }

  async saveClientInformation(client: OAuthClientInformationMixed): Promise<void> {
    this.oauth.client = client as StoredOAuth['client'];
    await this.store.save();
  }

  tokens(): OAuthTokens | undefined {
    return this.oauth.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.oauth.tokens = tokens;
    this.oauth.codeVerifier = undefined;
    await this.store.save();
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    if (!this.openBrowser) {
      throw new Error('The MoleSignal sign-in has run out: run `molesignal login` again');
    }
    this.openBrowser(authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.oauth.codeVerifier = codeVerifier;
    await this.store.save();
  }

  codeVerifier(): string {
    const verifier = this.oauth.codeVerifier;
    if (!verifier) throw new Error('No sign-in is under way');
    return verifier;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    this.oauth.discovery = state;
    await this.store.save();
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.oauth.discovery;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'all' || scope === 'client') this.oauth.client = undefined;
    if (scope === 'all' || scope === 'tokens') this.oauth.tokens = undefined;
    if (scope === 'all' || scope === 'verifier') this.oauth.codeVerifier = undefined;
    if (scope === 'all' || scope === 'discovery') this.oauth.discovery = undefined;
    await this.store.save();
  }
}

/** A one-off listener on this machine for the browser to come back to with the code. */
async function callbackListener(): Promise<{
  redirectUrl: string;
  code: (expectedState: () => string | undefined) => Promise<string>;
  close: () => void;
}> {
  let server: Server | undefined;
  let timer: NodeJS.Timeout | undefined;
  const listening = new Promise<number>((resolve, reject) => {
    server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server!.address() as AddressInfo).port));
  });
  const port = await listening;
  const redirectUrl = `http://127.0.0.1:${port}/callback`;

  const code = (expectedState: () => string | undefined) =>
    new Promise<string>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error('The sign-in did not finish within five minutes')),
        SIGN_IN_TIMEOUT_MS,
      );
      server!.on('request', (request, response) => {
        const url = new URL(request.url ?? '/', redirectUrl);
        if (url.pathname !== '/callback') {
          response.writeHead(404).end();
          return;
        }
        const error = url.searchParams.get('error');
        const received = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const expected = expectedState();
        const language = pageLanguage(request.headers['accept-language']);
        if (error || !received || (expected && state !== expected)) {
          response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
          response.end(signInPage(error === 'access_denied' ? 'refused' : 'invalid', language));
          clearTimeout(timer);
          reject(new Error(error ? `The sign-in was refused: ${error}` : 'The sign-in came back without a valid code'));
          return;
        }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(signInPage('signed-in', language));
        clearTimeout(timer);
        resolve(received);
      });
    });

  // Closing drops the browser's kept-alive connection too, so the command can end.
  const close = () => {
    clearTimeout(timer);
    server?.close();
    server?.closeAllConnections();
  };

  return { redirectUrl, code, close };
}

/**
 * Signs in in the browser: registers this machine as a client, sends the
 * person to MoleSignal to approve it, and keeps the tokens it comes back with
 * in the profile, which becomes the current one. An API token saved in the
 * profile is dropped in favour of the sign-in. The sign-in saved before stays
 * until this one succeeds: a refusal, a timeout or Ctrl+C leaves it as it was.
 */
export async function signIn(
  store: ConfigStore,
  profile: string,
  address: string,
  options: { open?: (url: URL) => void; log?: (line: string) => void; fetch?: FetchLike } = {},
): Promise<void> {
  const url = serverAddress(address);
  const log = options.log ?? (() => undefined);
  const listener = await callbackListener();

  try {
    // A new registration each time: the port the browser comes back to changes.
    const pending = new PendingConfigStore(store.path, {
      profiles: { [profile]: { url, oauth: { redirectUrl: listener.redirectUrl } } },
    });
    const provider = new StoredOAuthProvider(pending, profile, listener.redirectUrl, (authorizationUrl) => {
      log(`Opening ${authorizationUrl.toString()}`);
      (options.open ?? openInBrowser)(authorizationUrl);
    });
    const serverUrl = mcpEndpoint(url);
    const fetchFn = options.fetch ? { fetchFn: options.fetch } : {};
    const code = listener.code(() => provider.expectedState);
    const first = await auth(provider, { serverUrl, scope: OAUTH_SCOPE, ...fetchFn });
    if (first !== 'AUTHORIZED') {
      await auth(provider, { serverUrl, scope: OAUTH_SCOPE, authorizationCode: await code, ...fetchFn });
    }

    store.setProfile(profile, pending.profile(profile));
    store.config.current = profile;
    await store.save();
  } finally {
    listener.close();
  }
}
