import assert from 'node:assert/strict';
import { test } from 'node:test';

import { submitRequest, UsageError } from '../dist/index.js';

const now = Date.UTC(2026, 9, 28) * 1000;

test('a PromQL job reads a point every --step', () => {
  const request = submitRequest('rate(http_requests_total[5m])', { promql: true, step: '1m', since: '1h' }, now);
  assert.equal(request.language, 'promql');
  assert.equal(request.step, 60_000_000);
  assert.deepEqual(request.timeRange, { startTime: now - 3_600_000_000, endTime: now });
  assert.equal(request.stream, undefined);
});

test('a PromQL job without --step reads the value at the end of the window', () => {
  const request = submitRequest('up', { promql: true }, now);
  assert.equal('step' in request, false);
});

test('--step goes with --promql only', () => {
  assert.throws(() => submitRequest('SELECT * FROM app_logs', { step: '1m' }, now), UsageError);
});

test('a SQL job reads the stream after FROM, up to --limit rows', () => {
  const request = submitRequest('SELECT * FROM app_logs', { limit: '500' }, now);
  assert.deepEqual(request.stream, { name: 'app_logs', streamType: 'logs' });
  assert.equal(request.limit, 500);
});
