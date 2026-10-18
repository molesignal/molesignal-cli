import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { configPath, readConfig, resolveConnection, writeConfig } from '../dist/index.js';

test('the sign-in is saved readable by its owner only', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'molesignal-cli-'));
  const path = join(folder, 'nested', 'config.json');
  assert.deepEqual(await readConfig(path), {});

  await writeConfig(path, { url: 'https://ms.example.com', token: 'secret' });
  assert.deepEqual(await readConfig(path), { url: 'https://ms.example.com', token: 'secret' });
  if (process.platform !== 'win32') {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
});

test('the configuration lives where MOLESIGNAL_CONFIG or XDG_CONFIG_HOME say', () => {
  assert.equal(configPath({ MOLESIGNAL_CONFIG: '/tmp/x.json' }), '/tmp/x.json');
  assert.equal(configPath({ XDG_CONFIG_HOME: '/cfg' }), join('/cfg', 'molesignal', 'config.json'));
});

test('options win over the environment, which wins over the saved sign-in', () => {
  const saved = { url: 'https://saved.example.com', token: 'saved-token' };
  assert.deepEqual(resolveConnection({}, {}, saved), {
    url: 'https://saved.example.com',
    token: 'saved-token',
  });
  assert.deepEqual(
    resolveConnection({}, { MOLESIGNAL_URL: 'https://env.example.com', MOLESIGNAL_TOKEN: 't' }, saved),
    { url: 'https://env.example.com', token: 't' },
  );
  assert.deepEqual(resolveConnection({ url: 'https://flag.example.com/' }, {}, saved), {
    url: 'https://flag.example.com',
  });
  assert.throws(() => resolveConnection({}, {}, {}), /No MoleSignal address/);
});
