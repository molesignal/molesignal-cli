import { spawn } from 'node:child_process';

import { serverAddress } from './endpoint.js';

/** Opens a page in the default browser, the way each system does it. */
export function openInBrowser(url: URL): void {
  const target = url.toString();
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [target]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', target]]
        : ['xdg-open', [target]];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => undefined);
  child.unref();
}

/** A page of the MoleSignal web app at this address, with its query. */
export function webPage(address: string, path: string, query: Record<string, string | undefined> = {}): URL {
  const url = new URL(`${serverAddress(address)}${path}`);
  for (const [name, value] of Object.entries(query)) {
    if (value) url.searchParams.set(name, value);
  }
  return url;
}

/** A time window as the web app writes it in its address: `now-15m..now`, or two moments. */
export function timeParam(window: { since?: number | undefined; from?: number | undefined; to?: number | undefined }): string | undefined {
  if (window.from !== undefined) {
    const to = window.to === undefined ? 'now' : new Date(window.to / 1000).toISOString();
    return `${new Date(window.from / 1000).toISOString()}..${to}`;
  }
  if (window.since === undefined) return undefined;
  const minutes = Math.max(1, Math.round(window.since / 60_000));
  return minutes % 1440 === 0
    ? `now-${minutes / 1440}d..now`
    : minutes % 60 === 0
      ? `now-${minutes / 60}h..now`
      : `now-${minutes}m..now`;
}

/** The Logs page with a stream and its query: a field query (`q`) or a statement (`sql`). */
export function logsPage(
  address: string,
  options: { stream?: string | undefined; query?: string | undefined; sql?: string | undefined; time?: string | undefined },
): URL {
  return webPage(address, '/logs', { stream: options.stream, q: options.query, sql: options.sql, time: options.time });
}

/** The pages `molesignal open` knows, and the path of each, with the id it may take. */
export const PAGES: Record<string, { path: string; withId?: (id: string) => string; about: string }> = {
  home: { path: '/home', about: 'the home page' },
  logs: { path: '/logs', about: 'Logs, of a stream when one is named' },
  metrics: { path: '/metrics', about: 'Metrics' },
  traces: { path: '/traces', withId: (id) => `/traces/${encodeURIComponent(id)}`, about: 'Traces, or one trace' },
  services: {
    path: '/apm/services',
    withId: (id) => `/apm/services/${encodeURIComponent(id)}`,
    about: 'APM services, or one service',
  },
  incidents: {
    path: '/alerts/incidents',
    withId: (id) => `/alerts/incidents/${encodeURIComponent(id)}`,
    about: 'incidents, or one incident',
  },
  oncall: {
    path: '/alerts/schedules',
    withId: (id) => `/alerts/schedules/${encodeURIComponent(id)}`,
    about: 'on-call schedules, or one schedule',
  },
  synthetics: {
    path: '/synthetics/checks',
    withId: (id) => `/synthetics/checks/${encodeURIComponent(id)}`,
    about: 'synthetic checks, or one check',
  },
  dashboards: {
    path: '/dashboards',
    withId: (id) => `/dashboards/${encodeURIComponent(id)}`,
    about: 'dashboards, or one dashboard',
  },
  approvals: { path: '/agent/approvals', about: 'Mole Agent approvals' },
  jobs: { path: '/streams/jobs', about: 'search jobs' },
  streams: { path: '/streams', about: 'streams' },
  agent: { path: '/agent/chat', about: 'Mole Agent' },
};

/** The page of `molesignal open <page> [id]`. */
export function pageOf(address: string, name: string | undefined, id: string | undefined): URL {
  const page = PAGES[name ?? 'home'];
  if (!page) {
    throw new Error(`No page "${name}": open one of ${Object.keys(PAGES).join(', ')}`);
  }
  if (name === 'logs' && id) return logsPage(address, { stream: id });
  if (id && !page.withId) throw new Error(`The ${name} page takes no id`);
  return webPage(address, id && page.withId ? page.withId(id) : page.path);
}
