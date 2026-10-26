import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { fakeApi, readMultipart } from './fixtures.mjs';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

/** The environment of a run: no sign-in, proxy or CI of the machine running the tests. */
function cleanEnv(extra) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(MOLESIGNAL_|GITHUB_|GITLAB_|CI|JENKINS_|CIRCLE|BUILDKITE|BITBUCKET_|TF_BUILD|HTTPS?_PROXY|https?_proxy|NO_PROXY)/.test(name),
    ),
  );
  return { ...env, NO_COLOR: '1', ...extra };
}

/** Runs the built command and resolves with how it ended, whatever the status. */
async function cli(args, { env = {}, input, config } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'molesignal-cli-run-'));
  const path = join(folder, 'config.json');
  if (config) await writeFile(path, JSON.stringify(config));
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args], { env: cleanEnv({ MOLESIGNAL_CONFIG: path, ...env }) }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr, configPath: path });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

test('the help lists every command, and each command has its own', async () => {
  const help = await cli(['--help']);
  assert.equal(help.code, 0);
  for (const name of ['login', 'logs', 'query', 'metrics', 'traces', 'incidents', 'deploy', 'source-maps', 'symbols', 'send', 'tools', 'call', 'doctor']) {
    assert.match(help.stdout, new RegExp(`\\n  ${name} `));
  }
  const logs = await cli(['logs', '--help']);
  assert.equal(logs.code, 0);
  assert.match(logs.stdout, /^Usage: molesignal logs <stream>/);
  assert.equal((await cli(['help', 'deploy'])).stdout.split('\n')[0], 'Usage: molesignal deploy --service <name> --version <version> [options] [-- <command>…]');
});

test('a mistake in a command line exits with 2 and says where the help is', async () => {
  const unknown = await cli(['frobnicate']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /Unknown command "frobnicate"/);

  const missing = await cli(['logs']);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /Which stream\?/);

  const option = await cli(['logs', 'app_logs', '--bogus']);
  assert.equal(option.code, 2);
  assert.match(option.stderr, /--bogus.*see `molesignal logs --help`/);
});

test('open prints the page of the MoleSignal the profile or the environment names', async () => {
  const opened = await cli(['open', 'logs', 'app_logs', '--print'], { env: { MOLESIGNAL_URL: 'https://ms.example.com/obs' } });
  assert.equal(opened.stdout.trim(), 'https://ms.example.com/obs/logs?stream=app_logs');
});

test('profiles are listed, chosen, signed out of and removed', async () => {
  const config = {
    current: 'default',
    profiles: {
      default: { url: 'https://prod.example.com', oauth: { tokens: { access_token: 'a', token_type: 'Bearer' } } },
      staging: { url: 'https://staging.example.com', token: 'ms_token' },
    },
  };
  const listed = await cli(['profiles'], { config });
  assert.deepEqual(listed.stdout.trimEnd().split('\n'), [
    '   PROFILE  SIGN-IN    ADDRESS',
    '*  default  browser    https://prod.example.com',
    '   staging  API token  https://staging.example.com',
  ]);

  const used = await cli(['use', 'staging'], { config });
  assert.equal(JSON.parse(await readFile(used.configPath, 'utf8')).current, 'staging');

  const out = await cli(['logout', '--profile', 'staging'], { config });
  assert.deepEqual(JSON.parse(await readFile(out.configPath, 'utf8')).profiles.staging, { url: 'https://staging.example.com' });

  const removed = await cli(['profiles', 'remove', 'staging'], { config });
  assert.deepEqual(Object.keys(JSON.parse(await readFile(removed.configPath, 'utf8')).profiles), ['default']);
  assert.equal((await cli(['use', 'nope'], { config })).code, 1);
});

test('deploy records what CI tells, and runs the deploy command to say how it went', async () => {
  const ci = {
    GITHUB_ACTIONS: 'true',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'acme/checkout',
    GITHUB_SHA: '9f2c1e7a4b3d',
    GITHUB_RUN_ID: '7',
  };
  const dry = await cli(['deploy', '--service', 'checkout', '--version', '2.4.0', '--env', 'production', '--dry-run'], { env: ci });
  assert.equal(dry.code, 0);
  assert.deepEqual(JSON.parse(dry.stdout), {
    kind: 'deployment',
    service: 'checkout',
    version: '2.4.0',
    environment: 'production',
    status: 'succeeded',
    commit: '9f2c1e7a4b3d',
    repository: 'https://github.com/acme/checkout',
    ci_url: 'https://github.com/acme/checkout/actions/runs/7',
  });

  const api = await fakeApi({ 'POST /api/v1/apm/deployments': async () => [201, { id: 'd1' }] });
  try {
    const env = { ...ci, MOLESIGNAL_URL: api.url, MOLESIGNAL_TOKEN: 'good' };
    const recorded = await cli(['deploy', '--service', 'checkout', '--version', '2.4.0'], { env });
    assert.equal(recorded.code, 0);
    assert.match(recorded.stderr, /Recorded the deployment of checkout 2\.4\.0 \(9f2c1e7a4b3d\): succeeded/);
    assert.equal(JSON.parse(api.requests[0].body).commit, '9f2c1e7a4b3d');

    const failed = await cli(['deploy', '--service', 'checkout', '--version', '2.4.1', '--', process.execPath, '-e', 'process.exit(3)'], { env });
    assert.equal(failed.code, 3);
    assert.equal(JSON.parse(api.requests[1].body).status, 'failed');

    const noToken = await cli(['deploy', '--service', 'checkout', '--version', '2.4.0'], { env: { MOLESIGNAL_URL: api.url } });
    assert.equal(noToken.code, 1);
    assert.match(noToken.stderr, /needs an API token/);
  } finally {
    api.close();
  }
});

test('send and run write their lines to a stream', async () => {
  const api = await fakeApi({ 'POST /api/v1/intake/logs/app_logs': async (request) => [200, { accepted: JSON.parse(request.body).length, rejected: 0, errors: [] }] });
  try {
    const env = { MOLESIGNAL_URL: api.url, MOLESIGNAL_TOKEN: 'good' };
    const sent = await cli(['send', 'app_logs', '--field', 'service=cron'], { env, input: 'started\n{"level":"error","message":"boom"}\n' });
    assert.equal(sent.code, 0);
    assert.match(sent.stderr, /Sent 2 logs to app_logs/);
    const logs = JSON.parse(api.requests[0].body);
    assert.deepEqual(logs.map(({ _timestamp, ...rest }) => rest), [
      { service: 'cron', message: 'started' },
      { service: 'cron', level: 'error', message: 'boom' },
    ]);
    assert.ok(logs[0]._timestamp < logs[1]._timestamp);

    const ran = await cli(['run', 'app_logs', '--name', 'job', '--quiet', '--', process.execPath, '-e', "console.log('hi'); console.error('oops'); process.exit(2)"], { env });
    assert.equal(ran.code, 2);
    const lines = api.requests.slice(1).flatMap((request) => JSON.parse(request.body));
    const byOutput = Object.fromEntries(lines.filter((line) => line.output).map((line) => [line.output, line.message]));
    assert.deepEqual(byOutput, { stdout: 'hi', stderr: 'oops' });
    const last = lines.at(-1);
    assert.equal(last.exit_code, 2);
    assert.equal(last.command, 'job');
    assert.match(last.message, /^job exited with 2 after /);
    assert.ok(lines.every((line) => line.run_id === last.run_id && line.host));
  } finally {
    api.close();
  }
});

test('source maps go up one request a file, and --dry-run lists them', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'molesignal-maps-'));
  await writeFile(join(folder, 'app.1.js.map'), '{"version":3}');
  const args = ['source-maps', 'upload', folder, '--application', 'web', '--service', 'web', '--release', '1.0.0'];

  const dry = await cli([...args, '--dry-run']);
  assert.equal(dry.code, 0);
  assert.match(dry.stdout, /javascript_sourcemap\s+web\s+.*app\.1\.js\.map/);

  const api = await fakeApi({ 'POST /api/v1/debug-artifacts': async () => [200, { id: 'a1' }] });
  try {
    const uploaded = await cli(args, { env: { MOLESIGNAL_URL: api.url, MOLESIGNAL_TOKEN: 'good' } });
    assert.equal(uploaded.code, 0);
    assert.match(uploaded.stderr, /✓ app\.1\.js\.map/);
    assert.equal(readMultipart(api.requests[0]).fields.release, '1.0.0');
  } finally {
    api.close();
  }
});

test('mcp setup prints the configuration of an agent tool; completion knows the commands', async () => {
  const cursor = await cli(['mcp', 'setup', 'cursor', '--print', '--profile', 'staging']);
  assert.deepEqual(JSON.parse(cursor.stdout), {
    mcpServers: { molesignal: { command: 'npx', args: ['-y', '@molesignal/cli', 'mcp', '--profile', 'staging'] } },
  });
  const claude = await cli(['mcp', 'setup', 'claude', '--print']);
  assert.equal(claude.stdout.trim(), 'claude mcp add --scope user molesignal -- npx -y @molesignal/cli mcp');

  const bash = await cli(['completion', 'bash']);
  assert.match(bash.stdout, /complete -F _molesignal molesignal/);
  assert.match(bash.stdout, /source-maps\) \[ "\$COMP_CWORD" -eq 2 \] && COMPREPLY=\( \$\(compgen -W "upload list delete"/);
});
