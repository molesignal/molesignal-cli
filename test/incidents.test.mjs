import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createInput } from '../dist/index.js';

test('incidents create sends the title, severity and who takes it', () => {
  assert.deepEqual(createInput({ title: '  Checkout fails for EU cards ' }), {
    title: 'Checkout fails for EU cards',
    severity: 'error',
    assign: { kind: 'auto' },
  });

  assert.deepEqual(
    createInput({
      title: 'Customer report',
      severity: 'Critical',
      priority: 'p1',
      urgency: 'High',
      service: ['checkout', 'payments'],
      label: ['env=prod', 'region = eu'],
      user: ['u1', 'u2'],
      major: true,
      description: 'Three tickets in ten minutes.',
    }),
    {
      title: 'Customer report',
      severity: 'critical',
      priority: 'P1',
      urgency: 'high',
      services: ['checkout', 'payments'],
      labels: { env: 'prod', region: 'eu' },
      assign: { kind: 'users', user_ids: ['u1', 'u2'] },
      declare_major: true,
      description: 'Three tickets in ten minutes.',
    },
  );

  assert.deepEqual(createInput({ title: 'x', team: 't1' }).assign, { kind: 'team', team_id: 't1' });
  assert.deepEqual(createInput({ title: 'x', policy: 'p1' }).assign, { kind: 'policy', escalation_policy_id: 'p1' });
});

test('incidents create refuses what MoleSignal would refuse', () => {
  assert.throws(() => createInput({}), /--title/);
  assert.throws(() => createInput({ title: 'x', severity: 'fatal' }), /--severity/);
  assert.throws(() => createInput({ title: 'x', priority: 'P0' }), /--priority/);
  assert.throws(() => createInput({ title: 'x', urgency: 'night shift' }), /--urgency/);
  assert.throws(() => createInput({ title: 'x', team: 't1', policy: 'p1' }), /one of/);
  assert.throws(() => createInput({ title: 'x', label: ['broken'] }), /key=value/);
});
