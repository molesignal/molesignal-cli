import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatImport, importCounts } from '../dist/index.js';

const REPORT = {
  format: 'prometheus',
  items: [
    { name: 'HighErrorRate', action: 'create', rule_id: 'r1' },
    { name: 'DiskFull', action: 'update', changes: ['query', 'trigger'], rule_id: 'r2' },
    { name: 'TargetDown', action: 'error', error: 'no escalation policy is named `ops`' },
    { name: 'Latency', action: 'unchanged', rule_id: 'r3' },
  ],
  notes: ['recording rule `job:errors` in group `api` is not imported'],
  applied: false,
};

test('an import report counts what it writes and what is wrong', () => {
  assert.deepEqual(importCounts(REPORT), { writes: 2, errors: 1 });
  assert.deepEqual(importCounts({ ...REPORT, items: [] }), { writes: 0, errors: 0 });
});

test('an import report reads as a table of actions, names and details', () => {
  const lines = formatImport(REPORT);
  assert.match(lines[0], /^ACTION\s+NAME\s+DETAIL/);
  assert.match(lines[1], /create\s+HighErrorRate/);
  assert.match(lines[2], /update\s+DiskFull\s+query, trigger/);
  assert.match(lines[3], /error\s+TargetDown\s+no escalation policy is named `ops`/);
});
