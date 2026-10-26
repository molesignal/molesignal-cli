import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApiError, IntakeSender, lineRecord } from '../dist/index.js';

test('a line that is a JSON object is its fields, any other line its message', () => {
  assert.deepEqual(lineRecord('{"level":"error","message":"boom"}', {}), { level: 'error', message: 'boom' });
  assert.deepEqual(lineRecord('plain text', { fields: { service: 'cron' } }), { service: 'cron', message: 'plain text' });
  assert.deepEqual(lineRecord('{"broken', {}), { message: '{"broken' });
  assert.deepEqual(lineRecord('{"a":1}', { raw: true }), { message: '{"a":1}' });
  // The line's own fields win over --field.
  assert.deepEqual(lineRecord('{"service":"api"}', { fields: { service: 'cron' } }), { service: 'api' });
});

test('logs go in batches of the size given, in order', async () => {
  const batches = [];
  const sender = new IntakeSender(async (records) => {
    batches.push(records.length);
    return { accepted: records.length, rejected: 0 };
  }, 500);
  for (let index = 0; index < 1200; index += 1) sender.add({ message: `line ${index}` });
  await sender.close();
  assert.deepEqual(batches, [500, 500, 200]);
  assert.equal(sender.accepted, 1200);
});

test('a busy server is tried again; a refusal ends the sending', async () => {
  let attempts = 0;
  const notices = [];
  const flaky = new IntakeSender(
    async (records) => {
      attempts += 1;
      if (attempts === 1) throw new ApiError(503, 'busy');
      return { accepted: records.length };
    },
    10,
    (line) => notices.push(line),
  );
  flaky.add({ message: 'one' });
  await flaky.close();
  assert.equal(attempts, 2);
  assert.equal(flaky.accepted, 1);
  assert.match(notices[0], /trying again/);

  const refused = new IntakeSender(async () => {
    throw new ApiError(403, 'no streams.write');
  }, 10, () => undefined);
  refused.add({ message: 'one' });
  await assert.rejects(refused.close(), /no streams\.write/);
});
