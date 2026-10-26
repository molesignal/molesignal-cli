import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ConfigStore, OAUTH_SCOPE, pageLanguage, readConfig, signIn, signInPage } from '../dist/index.js';

/** An authorization server the way MoleSignal publishes one, with a client registered on demand. */
async function fakeAuthorizationServer() {
  const seen = { registered: null, exchanged: null };
  const server = createServer(async (request, response) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const url = new URL(request.url, base);
    const json = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    const body = async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      return Buffer.concat(chunks).toString('utf8');
    };
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      return json(200, { resource: `${base}/api/v1/mcp`, authorization_servers: [base] });
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json(200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: ['mcp', 'offline_access'],
      });
    }
    if (url.pathname === '/register' && request.method === 'POST') {
      seen.registered = JSON.parse(await body());
      return json(201, { ...seen.registered, client_id: 'client-1' });
    }
    if (url.pathname === '/token' && request.method === 'POST') {
      seen.exchanged = Object.fromEntries(new URLSearchParams(await body()));
      return json(200, {
        access_token: 'access-1',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'refresh-1',
        scope: OAUTH_SCOPE,
      });
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() };
}

test('a browser sign-in registers the machine, sends the person off and keeps the tokens in the profile', { timeout: 15_000 }, async () => {
  const authorization = await fakeAuthorizationServer();
  const path = join(await mkdtemp(join(tmpdir(), 'molesignal-cli-')), 'config.json');
  const store = await ConfigStore.open(path);
  let opened = null;
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));

  await signIn(store, 'work', `${authorization.url}/`, {
    // The person approves at once: the browser comes back with a code and the same state.
    open: (url) => {
      opened = url;
      const back = new URL(url.searchParams.get('redirect_uri'));
      back.searchParams.set('code', 'code-1');
      back.searchParams.set('state', url.searchParams.get('state'));
      void fetch(back);
    },
  });

  assert.equal(opened.origin, authorization.url);
  assert.equal(opened.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(opened.searchParams.get('scope'), OAUTH_SCOPE);
  assert.equal(opened.searchParams.get('resource'), `${authorization.url}/api/v1/mcp`);
  assert.deepEqual(authorization.seen.registered.redirect_uris, [opened.searchParams.get('redirect_uri')]);
  assert.equal(authorization.seen.exchanged.grant_type, 'authorization_code');
  assert.equal(authorization.seen.exchanged.code, 'code-1');
  assert.ok(authorization.seen.exchanged.code_verifier);

  const saved = await readConfig(path);
  assert.equal(saved.current, 'work');
  const profile = saved.profiles.work;
  assert.equal(profile.url, authorization.url);
  assert.equal(profile.oauth.client.client_id, 'client-1');
  assert.equal(profile.oauth.tokens.access_token, 'access-1');
  assert.equal(profile.oauth.tokens.refresh_token, 'refresh-1');
  assert.equal(profile.oauth.codeVerifier, undefined);
  // The authorization server found when the browser was sent off is kept, so the code is redeemed with it.
  assert.equal(profile.oauth.discovery.authorizationServerUrl, authorization.url);
  console.warn = warn;
  assert.deepEqual(warnings.filter((line) => line.includes('mcp-sdk')), []);
  authorization.close();
});

test('a sign-in that does not finish leaves the saved one as it was', { timeout: 15_000 }, async () => {
  const authorization = await fakeAuthorizationServer();
  const path = join(await mkdtemp(join(tmpdir(), 'molesignal-cli-')), 'config.json');
  const store = await ConfigStore.open(path);
  store.config = { current: 'default', profiles: { default: { url: 'https://molesignal.example.com', token: 'saved-token' } } };
  await store.save();

  await assert.rejects(
    signIn(store, 'default', authorization.url, {
      // The person refuses in the browser.
      open: (url) => {
        const back = new URL(url.searchParams.get('redirect_uri'));
        back.searchParams.set('error', 'access_denied');
        back.searchParams.set('state', url.searchParams.get('state'));
        void fetch(back);
      },
    }),
    /refused: access_denied/,
  );

  assert.deepEqual(await readConfig(path), {
    current: 'default',
    profiles: { default: { url: 'https://molesignal.example.com', token: 'saved-token' } },
  });
  assert.equal(store.config.profiles.default.token, 'saved-token');
  authorization.close();
});

test('the page the browser comes back to speaks the reader\'s language and says what happened', () => {
  assert.equal(pageLanguage('zh-CN,zh;q=0.9,en;q=0.8'), 'zh');
  assert.equal(pageLanguage('en-US,en;q=0.9'), 'en');
  assert.equal(pageLanguage(undefined), 'en');

  assert.match(signInPage('signed-in', 'zh'), /<h1>已登录 MoleSignal<\/h1>/);
  assert.match(signInPage('signed-in', 'en'), /<html lang="en">/);
  const refused = signInPage('refused', 'en');
  assert.match(refused, /Sign-in not completed/);
  assert.match(refused, /<code>molesignal login<\/code>/);
  assert.match(refused, /class="state no"/);
});
