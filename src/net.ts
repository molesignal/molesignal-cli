import type { FetchLike } from '@modelcontextprotocol/client';

const PROXY_VARIABLES = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];

/** Whether the environment names a proxy for HTTP requests. */
export function proxyConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return PROXY_VARIABLES.some((name) => Boolean(env[name]?.trim()));
}

let proxied: Promise<FetchLike> | undefined;

/**
 * What makes the HTTP requests: Node's fetch, or, when `HTTPS_PROXY` or
 * `HTTP_PROXY` is set, a fetch that goes through that proxy and leaves out
 * the hosts `NO_PROXY` lists. Node's own fetch reads none of them.
 */
export function networkFetch(env: NodeJS.ProcessEnv = process.env): Promise<FetchLike> {
  if (!proxyConfigured(env)) return Promise.resolve(fetch);

  proxied ??= import('undici').then(({ EnvHttpProxyAgent, fetch: undiciFetch }) => {
    const dispatcher = new EnvHttpProxyAgent();
    // undici's fetch speaks the same Request and Response as Node's; only its types are its own.
    return ((url: string | URL, init?: RequestInit) =>
      undiciFetch(url as Parameters<typeof undiciFetch>[0], {
        ...(init as Parameters<typeof undiciFetch>[1]),
        dispatcher,
      })) as unknown as FetchLike;
  });
  return proxied;
}
