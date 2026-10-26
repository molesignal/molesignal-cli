import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  checkProfileName,
  ConfigStore,
  configPath,
  profileName,
  readConfig,
  resolveConnection,
  writeConfig,
} from '../dist/index.js';

test('the sign-ins are saved readable by their owner only', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'molesignal-cli-'));
  const path = join(folder, 'nested', 'config.json');
  assert.deepEqual(await readConfig(path), {});

  const config = { current: 'default', profiles: { default: { url: 'https://ms.example.com', token: 'secret' } } };
  await writeConfig(path, config);
  assert.deepEqual(await readConfig(path), config);
  if (process.platform !== 'win32') {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
});

test('the configuration lives where MOLESIGNAL_CONFIG or XDG_CONFIG_HOME say', () => {
  assert.equal(configPath({ MOLESIGNAL_CONFIG: '/tmp/x.json' }), '/tmp/x.json');
  assert.equal(configPath({ XDG_CONFIG_HOME: '/cfg' }), join('/cfg', 'molesignal', 'config.json'));
});

test('options win over the environment, which wins over the saved profile', () => {
  const saved = { url: 'https://saved.example.com', token: 'saved-token' };
  assert.deepEqual(resolveConnection({}, {}, saved), {
    url: 'https://saved.example.com',
    token: 'saved-token',
  });
  assert.deepEqual(
    resolveConnection({}, { MOLESIGNAL_URL: 'https://env.example.com', MOLESIGNAL_TOKEN: 't' }, saved),
    { url: 'https://env.example.com', token: 't' },
  );
  // A token saved for one MoleSignal is not sent to another.
  assert.deepEqual(resolveConnection({ url: 'https://flag.example.com/' }, {}, saved), {
    url: 'https://flag.example.com',
  });
  assert.throws(() => resolveConnection({}, {}, {}), /No MoleSignal address/);
});

test('the profile is the one named, else MOLESIGNAL_PROFILE, else the current one, else default', () => {
  const config = { current: 'staging', profiles: { staging: {}, prod: {} } };
  assert.equal(profileName('prod', { MOLESIGNAL_PROFILE: 'ci' }, config), 'prod');
  assert.equal(profileName(undefined, { MOLESIGNAL_PROFILE: 'ci' }, config), 'ci');
  assert.equal(profileName(undefined, {}, config), 'staging');
  assert.equal(profileName(undefined, {}, {}), 'default');
  assert.throws(() => checkProfileName('no spaces'), /not a profile name/);
});

test('a store keeps profiles apart, and forgetting the current one makes the default current', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'molesignal-cli-')), 'config.json');
  const store = await ConfigStore.open(path);
  store.profile('prod').url = 'https://prod.example.com';
  store.setProfile('staging', { url: 'https://staging.example.com', token: 't' });
  store.config.current = 'staging';
  await store.save();

  const again = await ConfigStore.open(path);
  assert.deepEqual(again.names, ['prod', 'staging']);
  assert.equal(again.has('staging'), true);
  again.removeProfile('staging');
  assert.deepEqual(again.names, ['prod']);
  assert.equal(again.config.current, undefined);
});
