import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { serveStdio } from '../dist/index.js';

/**
 * A MoleSignal MCP endpoint that answers initialize and tools/list for one token.
 * Like the real one it takes nothing but initialize before the session exists,
 * and it answers initialize a little late, as a server across a network does.
 */
async function fakeMoleSignal() {
  const seen = { deleted: false, sessions: [] };
  const server = createServer(async (request, response) => {
    if (request.url !== '/api/v1/mcp') return response.writeHead(404).end();
    if (request.headers.authorization !== 'Bearer good') return response.writeHead(401).end();
    if (request.method === 'GET') return response.writeHead(405).end();
    if (request.method === 'DELETE') {
      seen.deleted = true;
      return response.writeHead(200).end();
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    seen.sessions.push(request.headers['mcp-session-id'] ?? null);
    if (message.method !== 'initialize' && !request.headers['mcp-session-id']) {
      return response.writeHead(400, { 'content-type': 'application/json' }).end(
        JSON.stringify({ jsonrpc: '2.0', id: message.id ?? null, error: { code: -32600, message: 'expect initialize request' } }),
      );
    }
    if (message.method === 'initialize') await new Promise((resolve) => setTimeout(resolve, 150));
    if (!('id' in message)) return response.writeHead(202).end();
    const result =
      message.method === 'initialize'
        ? {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'MoleSignal', version: 'test' },
          }
        : { tools: [{ name: 'query_logs', inputSchema: { type: 'object' } }] };
    response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'session-1' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() };
}

/** The lines written to a stream, one JSON message at a time. */
function messages(stream) {
  let buffered = '';
  const waiting = [];
  const ready = [];
  stream.on('data', (chunk) => {
    buffered += chunk.toString('utf8');
    let index;
    while ((index = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      const message = JSON.parse(line);
      const next = waiting.shift();
      if (next) next(message);
      else ready.push(message);
    }
  });
  return () => (ready.length ? Promise.resolve(ready.shift()) : new Promise((resolve) => waiting.push(resolve)));
}

const initialize = (id) =>
  `${JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  })}\n`;

test('messages go to MoleSignal and its answers come back on stdout', { timeout: 10_000 }, async () => {
  const molesignal = await fakeMoleSignal();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const next = messages(stdout);
  const serving = serveStdio(
    { connection: { url: molesignal.url, token: 'good' } },
    { stdin, stdout, log: () => undefined },
  );

  stdin.write(initialize(1));
  const initialized = await next();
  assert.equal(initialized.id, 1);
  assert.equal(initialized.result.serverInfo.name, 'MoleSignal');

  stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  const listed = await next();
  assert.equal(listed.id, 2);
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['query_logs']);
  // After initialize every request carries the session MoleSignal gave.
  assert.deepEqual(molesignal.seen.sessions, [null, 'session-1', 'session-1']);

  stdin.end();
  await serving;
  assert.equal(molesignal.seen.deleted, true);
  molesignal.close();
});

test('a request MoleSignal refuses is answered with an error, not left waiting', { timeout: 10_000 }, async () => {
  const molesignal = await fakeMoleSignal();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const next = messages(stdout);
  const logged = [];
  const serving = serveStdio(
    { connection: { url: molesignal.url, token: 'bad' } },
    { stdin, stdout, log: (line) => logged.push(line) },
  );

  stdin.write(initialize(7));
  const answer = await next();
  assert.equal(answer.id, 7);
  assert.match(answer.error.message, /refused the API token/);
  assert.ok(logged.length > 0);

  stdin.end();
  await serving;
  molesignal.close();
});

test('a tool that writes initialize and its next messages at once still gets its answers', { timeout: 10_000 }, async () => {
  const molesignal = await fakeMoleSignal();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const next = messages(stdout);
  const logged = [];
  const serving = serveStdio(
    { connection: { url: molesignal.url, token: 'good' } },
    { stdin, stdout, log: (line) => logged.push(line) },
  );

  stdin.write(
    initialize(1) +
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n` +
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`,
  );

  assert.equal((await next()).id, 1);
  const listed = await next();
  assert.equal(listed.id, 2);
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['query_logs']);
  assert.deepEqual(logged, []);
  assert.deepEqual(molesignal.seen.sessions, [null, 'session-1', 'session-1']);

  stdin.end();
  await serving;
  molesignal.close();
});

test('a session MoleSignal lost, as after a restart, is opened again and the request sent again', { timeout: 10_000 }, async () => {
  let session = 1;
  let restarted = false;
  const initializes = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'DELETE') return response.writeHead(200).end();
    if (request.method === 'GET') return response.writeHead(405).end();
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const known = request.headers['mcp-session-id'] === `session-${session}`;
    if (message.method === 'initialize') {
      initializes.push(message.id);
      response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': `session-${session}` });
      return response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'MoleSignal', version: 'test' } },
        }),
      );
    }
    if (!known) return response.writeHead(404).end('Not Found: Session not found');
    if (!('id' in message)) return response.writeHead(202).end();
    // The first list is answered, then the server restarts and forgets its sessions.
    const tools = [{ name: restarted ? 'after' : 'before', inputSchema: { type: 'object' } }];
    if (!restarted) {
      restarted = true;
      session = 2;
    }
    response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': `session-${session}` });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const next = messages(stdout);
  const logged = [];
  const serving = serveStdio(
    { connection: { url: `http://127.0.0.1:${server.address().port}`, token: 'good' } },
    { stdin, stdout, log: (line) => logged.push(line) },
  );

  stdin.write(initialize(1));
  assert.equal((await next()).id, 1);
  stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  assert.deepEqual((await next()).result.tools.map((tool) => tool.name), ['before']);

  stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })}\n`);
  const after = await next();
  assert.equal(after.id, 3);
  assert.deepEqual(after.result.tools.map((tool) => tool.name), ['after']);
  // The tool saw only its own answers: the second initialize was answered to the bridge.
  assert.deepEqual(initializes, [1, 'molesignal-reopen-1']);
  assert.match(logged.join('\n'), /opened a new one/);

  stdin.end();
  await serving;
  server.close();
});
