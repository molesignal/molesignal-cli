import assert from 'node:assert/strict';
import { test } from 'node:test';

import { accessWord, callArguments, formatTools } from '../dist/index.js';

const schema = {
  type: 'object',
  properties: {
    limit: { type: 'integer' },
    ratio: { type: 'number' },
    enabled: { type: 'boolean' },
    tags: { type: 'array', items: { type: 'string' } },
    note: { type: ['string', 'null'] },
    time_range: { type: 'object', properties: { start_micros: { type: 'integer' } } },
  },
};

test('name=value takes the type the tool asks for; name:=json is JSON as written', () => {
  assert.deepEqual(
    callArguments(
      ['limit=20', 'ratio=0.5', 'enabled=true', 'tags=a, b', 'note=hello', 'time_range.start_micros=5', 'extra:={"a":[1,2]}'],
      schema,
    ),
    {
      limit: 20,
      ratio: 0.5,
      enabled: true,
      tags: ['a', 'b'],
      note: 'hello',
      time_range: { start_micros: 5 },
      extra: { a: [1, 2] },
    },
  );
  assert.deepEqual(callArguments(['limit=1'], schema, { stream: 'app_logs' }), { stream: 'app_logs', limit: 1 });
});

test('a value of the wrong type, or not name=value, is refused', () => {
  assert.throws(() => callArguments(['limit=lots'], schema), /takes a whole number/);
  assert.throws(() => callArguments(['enabled=yes'], schema), /takes true or false/);
  assert.throws(() => callArguments(['just-a-word'], schema), /not name=value/);
  assert.throws(() => callArguments(['x:={broken'], schema), /takes JSON/);
});

test('tools are listed by what a call does and how the policy runs a change', () => {
  assert.equal(accessWord('read_only'), 'read');
  assert.equal(accessWord('managed_mutation'), 'change');
  assert.equal(accessWord('executes_approved_operation'), 'execute');
  assert.deepEqual(
    formatTools([
      { name: 'list_incidents', access: 'read_only', description: 'List incidents' },
      { name: 'resolve_incident', access: 'managed_mutation', execution_mode: 'single_approval', description: 'Resolve one' },
    ]),
    [
      'TOOL              CALL    POLICY           DESCRIPTION',
      'list_incidents    read                     List incidents',
      'resolve_incident  change  single approval  Resolve one',
    ],
  );
});
