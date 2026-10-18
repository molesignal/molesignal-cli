import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mcpEndpoint, serverAddress } from '../dist/index.js';

test('an address is kept as its origin and base path', () => {
  assert.equal(serverAddress('https://ms.example.com/'), 'https://ms.example.com');
  assert.equal(serverAddress('https://ms.example.com/logs?q=1'), 'https://ms.example.com/logs');
  assert.equal(serverAddress('https://ms.example.com/api/v1/mcp'), 'https://ms.example.com');
  assert.equal(serverAddress('https://example.com/molesignal/'), 'https://example.com/molesignal');
});

test('the MCP endpoint is under the address', () => {
  assert.equal(mcpEndpoint('https://ms.example.com').toString(), 'https://ms.example.com/api/v1/mcp');
  assert.equal(
    mcpEndpoint('http://localhost:5173/api/v1/mcp/').toString(),
    'http://localhost:5173/api/v1/mcp',
  );
});

test('an address that is not http(s) is refused', () => {
  assert.throws(() => serverAddress('ms.example.com'), /not an address/);
  assert.throws(() => serverAddress('ftp://ms.example.com'), /must start with https/);
});
