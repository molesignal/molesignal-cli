import { stat } from 'node:fs/promises';

import { type Command, CONNECTION, CONNECTION_HELP, parse } from './command.js';
import { ConfigStore, profileName, resolveConnection } from './config.js';
import { signedIn } from './context.js';
import { describeError } from './mcp.js';
import { networkFetch, proxyConfigured } from './net.js';
import { paint, say, useColor } from './output.js';
import { checkConnection } from './status.js';
import { formatDuration } from './time.js';
import { VERSION } from './version.js';

/** One check: whether it passed, what was found, and what to do when it did not. */
interface Check {
  ok: boolean | 'warn';
  what: string;
  hint?: string | undefined;
}

/** Why a request could not reach the server, from the error under fetch's own. */
export function networkCause(error: unknown): { what: string; hint?: string } {
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  const code = cause?.code ?? '';
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/.test(code)) {
    return {
      what: `the TLS certificate was not trusted (${code})`,
      hint: 'A private certificate authority? Point NODE_EXTRA_CA_CERTS at its certificate',
    };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { what: `the name does not resolve (${code})`, hint: 'Check the address and the DNS' };
  if (code === 'ECONNREFUSED') return { what: 'nothing answers on that port (ECONNREFUSED)' };
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return { what: `the connection timed out (${code})`, hint: proxyConfigured() ? undefined : 'Behind a proxy? Set HTTPS_PROXY' };
  }
  return { what: cause?.message ?? (error as Error).message };
}

export const doctorCommand: Command = {
  name: 'doctor',
  group: 'Sign-in',
  summary: 'Check the setup: configuration, network, proxy, clock, sign-in and MCP',
  usage: `Usage: molesignal doctor [options]

Checks what this command needs, one line a check, and says what to do about
what fails: Node.js, the saved configuration, the address, the proxy, the
network and TLS, the clock, the sign-in, and MoleSignal's MCP endpoint.
Exits with 1 when a check fails.

Options:
${CONNECTION_HELP}`,

  async run(args) {
    const { values } = parse('doctor', args, CONNECTION);
    const color = useColor(process.stderr);
    const checks: Check[] = [];
    const report = (check: Check) => {
      checks.push(check);
      const mark = check.ok === true ? paint(color, '32', '✓') : check.ok === 'warn' ? paint(color, '33', '!') : paint(color, '31', '✗');
      say(`${mark} ${check.what}`);
      if (check.hint && check.ok !== true) say(`  ${check.hint}`);
    };

    const major = Number(process.versions.node.split('.')[0]);
    report({ ok: major >= 20, what: `Node.js ${process.versions.node}`, hint: 'molesignal needs Node.js 20 or newer' });

    const store = await ConfigStore.open();
    const mode = await stat(store.path).then(
      (info) => info.mode & 0o777,
      () => undefined,
    );
    if (mode === undefined) report({ ok: 'warn', what: `No configuration yet at ${store.path}`, hint: 'Run `molesignal login --url <address>`' });
    else {
      report({
        ok: process.platform === 'win32' || (mode & 0o077) === 0 ? true : 'warn',
        what: `Configuration ${store.path} (${store.names.length} profile${store.names.length === 1 ? '' : 's'})`,
        hint: `Others can read it (mode ${mode.toString(8)}): chmod 600 ${store.path}`,
      });
    }

    const profile = profileName(values.profile, process.env, store.config);
    let address: string;
    try {
      address = resolveConnection(values, process.env, store.config.profiles?.[profile] ?? {}).url;
      report({ ok: true, what: `Address ${address} (profile ${profile})` });
    } catch (error) {
      report({ ok: false, what: (error as Error).message });
      return 1;
    }

    const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
    report({ ok: true, what: proxy ? `Proxy ${proxy.replace(/\/\/[^@/]*@/, '//***@')}${process.env.NO_PROXY ? `, not for ${process.env.NO_PROXY}` : ''}` : 'No proxy' });

    const fetch = await networkFetch();
    const started = Date.now();
    let response: Response | undefined;
    try {
      response = await fetch(new URL(`${address}/api/v1/healthz`), { signal: AbortSignal.timeout(10_000) });
      const healthy = response.ok;
      report({
        ok: healthy ? true : 'warn',
        what: `MoleSignal answers in ${formatDuration(Date.now() - started)}${healthy ? '' : `, but says it is unhealthy (HTTP ${response.status})`}`,
        hint: 'It runs, yet a part of it is down: the database or the object store',
      });
    } catch (error) {
      const cause = networkCause(error);
      report({ ok: false, what: `Cannot reach ${address}: ${cause.what}`, hint: cause.hint });
      return 1;
    }

    const date = response.headers.get('date');
    if (date) {
      const skew = Math.abs(Date.parse(date) - Date.now());
      report({
        ok: skew < 60_000 ? true : 'warn',
        what: `Clock ${skew < 2000 ? 'in step with' : `${formatDuration(skew)} apart from`} MoleSignal's`,
        hint: 'Set the clock right: sign-ins expire by it',
      });
    }

    try {
      const signed = await signedIn(values);
      const status = await checkConnection(signed.credentials, VERSION);
      report({
        ok: true,
        what: `Signed in with ${signed.credentials.connection.token ? 'an API token' : 'the browser'}: MCP ${status.protocol ?? ''} with ${status.tools} tools`,
      });
    } catch (error) {
      report({ ok: false, what: describeError(error, { url: address, token: values.token ?? process.env.MOLESIGNAL_TOKEN }) });
    }

    return checks.some((check) => check.ok === false) ? 1 : 0;
  },
};
