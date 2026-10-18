import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { ToolError, ToolSession } from '../dist/index.js';

/** A MoleSignal MCP endpoint whose tools answer the way the real one shapes its results. */
async function fakeMoleSignal() {
  const calls = [];
  const server = createServer(async (request, response) => {
    if (request.url !== '/api/v1/mcp') return response.writeHead(404).end();
    if (request.headers.authorization !== 'Bearer good') return response.writeHead(401).end();
    if (request.method === 'GET') return response.writeHead(405).end();
    if (request.method === 'DELETE') return response.writeHead(200).end();

    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!('id' in message)) return response.writeHead(202).end();

    let result;
    if (message.method === 'initialize') {
      result = {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'MoleSignal', version: 'test' },
      };
    } else if (message.params.name === 'list_streams') {
      calls.push(message.params);
      const streams = { streams: [{ name: 'app_logs', field_count: 9, retention: null }], limit: 1000 };
      result = { content: [{ type: 'text', text: JSON.stringify(streams) }], structuredContent: streams };
    } else {
      calls.push(message.params);
      result = {
        isError: true,
        content: [{ type: 'text', text: '{"error":"tool_execution_failed"}' }],
        structuredContent: { error: 'tool_execution_failed', message: 'missing permission for tool `query_logs`' },
      };
    }

    response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'session-1' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() };
}

test('a tool call returns its structured result, and a refusal says why', { timeout: 10_000 }, async () => {
  const molesignal = await fakeMoleSignal();
  const session = await ToolSession.open({ connection: { url: molesignal.url, token: 'good' } }, 'test');

  const listed = await session.call('list_streams', { stream_type: 'logs', limit: 1000 });
  assert.deepEqual(listed.streams.map((stream) => stream.name), ['app_logs']);
  assert.deepEqual(molesignal.calls[0], { name: 'list_streams', arguments: { stream_type: 'logs', limit: 1000 } });

  await assert.rejects(
    session.call('query_logs', { stream: 'app_logs' }),
    (error) => error instanceof ToolError && /missing permission for tool `query_logs`/.test(error.message),
  );

  await session.close();
  molesignal.close();
});
