import assert from 'node:assert/strict';
import { test } from 'node:test';

import { serverEntry, withJsonServer, withTomlServer } from '../dist/index.js';

test('an agent tool starts the command through npx, or the installed one, for a profile when named', () => {
  assert.deepEqual(serverEntry({}), { command: 'npx', args: ['-y', '@molesignal/cli', 'mcp'] });
  assert.deepEqual(serverEntry({ installed: true, profile: 'staging' }), {
    command: 'molesignal',
    args: ['mcp', '--profile', 'staging'],
  });
});

test('a JSON configuration gets the server added, its other servers and settings kept', () => {
  const before = JSON.stringify({ theme: 'dark', mcpServers: { github: { command: 'gh' }, molesignal: { command: 'old' } } });
  const after = JSON.parse(withJsonServer(before, 'mcpServers', { command: 'npx', args: ['mcp'] }));
  assert.deepEqual(after, {
    theme: 'dark',
    mcpServers: { github: { command: 'gh' }, molesignal: { command: 'npx', args: ['mcp'] } },
  });
  assert.deepEqual(JSON.parse(withJsonServer(undefined, 'servers', { type: 'stdio' })), { servers: { molesignal: { type: 'stdio' } } });
  assert.throws(() => withJsonServer('// a comment\n{}', 'servers', {}), /JSON/);
});

test("Codex's TOML gets the table added, or put in place of the one there", () => {
  const entry = serverEntry({});
  assert.equal(
    withTomlServer('model = "o4"\n', entry),
    'model = "o4"\n\n[mcp_servers.molesignal]\ncommand = "npx"\nargs = ["-y", "@molesignal/cli", "mcp"]\n',
  );
  const before = [
    'model = "o4"',
    '',
    '[mcp_servers.molesignal]',
    'command = "molesignal"',
    'args = ["mcp"]',
    '',
    '[mcp_servers.github]',
    'command = "gh"',
    '',
  ].join('\n');
  assert.equal(
    withTomlServer(before, entry),
    [
      'model = "o4"',
      '',
      '[mcp_servers.molesignal]',
      'command = "npx"',
      'args = ["-y", "@molesignal/cli", "mcp"]',
      '',
      '[mcp_servers.github]',
      'command = "gh"',
      '',
    ].join('\n'),
  );
});
