import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  formatComparison,
  formatIncidents,
  formatSeries,
  formatServices,
  formatWaterfall,
  logsPage,
  pageOf,
  queryTable,
  seriesName,
  seriesOf,
  streamOfSql,
  timeParam,
  waterfallOrder,
} from '../dist/index.js';

test('the stream of a statement is the first name after FROM', () => {
  assert.equal(streamOfSql('SELECT level, COUNT(*) FROM app_logs GROUP BY level'), 'app_logs');
  assert.equal(streamOfSql('select * from "my ""odd"" stream" where x = 1'), 'my "odd" stream');
  assert.equal(streamOfSql('SELECT 1'), undefined);
});

test('a query result shows times as clock times', () => {
  const lines = queryTable(['_timestamp', 'level'], [{ _timestamp: 1_000_000, level: 'error' }], { utc: true });
  assert.deepEqual(lines, ['_TIMESTAMP               LEVEL', '1970-01-01 00:00:01.000  error']);
});

test('a PromQL range result is one series a label set, with its trend', () => {
  const result = {
    columns: ['_timestamp', 'value', '__name__', 'job'],
    rows: [
      [1, 1, 'up', 'api'],
      [2, 3, 'up', 'api'],
      [1, 0, 'up', 'db'],
      [2, 0, 'up', 'db'],
    ],
  };
  const series = seriesOf(result);
  assert.equal(series.length, 2);
  assert.deepEqual(series[0], { labels: { __name__: 'up', job: 'api' }, points: [[1, 1], [2, 3]] });
  assert.equal(seriesName(series[0].labels), 'up{job="api"}');
  assert.deepEqual(formatSeries(series), [
    'LAST  MIN  MAX  TREND  SERIES',
    '3     1    3    ▁█     up{job="api"}',
    '0     0    0    ▄▄     up{job="db"}',
  ]);
});

test('a trace is drawn as a waterfall, children under their parent, failures marked', () => {
  const ms = 1_000_000;
  const spans = [
    { spanId: 'b', parentSpanId: 'a', service: 'db', operation: 'SELECT', startNs: 10 * ms, endNs: 30 * ms, status: 'OK' },
    { spanId: 'a', parentSpanId: null, service: 'api', operation: 'GET /orders', startNs: 0, endNs: 100 * ms, status: 'OK' },
    { spanId: 'c', parentSpanId: 'a', service: 'cache', operation: 'GET', startNs: 40 * ms, endNs: 50 * ms, status: 'ERROR' },
  ];
  assert.deepEqual(
    waterfallOrder(spans).map(({ span, prefix }) => `${prefix}${span.spanId}`),
    ['a', '├─ b', '└─ c'],
  );
  const lines = formatWaterfall(spans, { width: 80 });
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^api GET \/orders +█+ +100ms$/);
  assert.match(lines[2], /^└─ ! cache GET +█+ +10ms$/);
});

test('incidents and services read as tables', () => {
  const now = 10_000_000_000;
  assert.deepEqual(
    formatIncidents(
      [{ id: 'i1', status: 'open', severity: 'critical', createdAt: now - 300_000_000, affectedServices: ['checkout'], summary: 'Errors up' }],
      { now },
    ),
    ['INCIDENT  STATUS  SEVERITY  OPENED  SERVICES  SUMMARY', 'i1        open    critical  5m ago  checkout  Errors up'],
  );
  assert.deepEqual(
    formatServices([
      {
        service: { namespace: 'shop', name: 'checkout', environment: 'prod' },
        red: { requestCount: 12_345, errorRate: 0.012, p95Time: 250_000 },
        health: 'warning',
        currentVersion: '2.4.0',
      },
    ]),
    ['SERVICE        ENV   REQUESTS  ERRORS  P95    HEALTH   VERSION', 'shop/checkout  prod  12k       1.2%    250ms  warning  2.4.0'],
  );
  const comparison = formatComparison({
    baseline: { version: '2.3.9', red: { requestCount: 1000, errorRate: 0.01, p95Time: 200_000 } },
    candidate: { version: '2.4.0', red: { requestCount: 900, errorRate: 0.05, p95Time: 400_000 } },
    status: 'regressed',
    regressedTransactions: [{}, {}],
  });
  assert.equal(comparison.at(-1), 'regressed · 2 endpoints slower or failing more');
});

test('pages of the web app keep the address the app is served under', () => {
  assert.equal(pageOf('https://ms.example.com/obs/', 'traces', 'abc').toString(), 'https://ms.example.com/obs/traces/abc');
  assert.equal(pageOf('https://ms.example.com', undefined, undefined).toString(), 'https://ms.example.com/home');
  assert.throws(() => pageOf('https://ms.example.com', 'nope', undefined), /No page "nope"/);
  assert.equal(
    logsPage('https://ms.example.com', { stream: 'app_logs', query: "level = 'error'", time: timeParam({ since: 7_200_000 }) }).toString(),
    "https://ms.example.com/logs?stream=app_logs&q=level+%3D+%27error%27&time=now-2h..now",
  );
  assert.equal(timeParam({ since: 900_000 }), 'now-15m..now');
  assert.equal(timeParam({ from: 0, to: 1_000_000 }), '1970-01-01T00:00:00.000Z..1970-01-01T00:00:01.000Z');
});
