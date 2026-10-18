import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  formatLog,
  formatStreams,
  LogFollower,
  logsSql,
  parseDuration,
  readLogs,
  rowsOf,
  ToolError,
} from '../dist/index.js';

const SECOND = 1_000_000;
const row = (seconds, message, extra = {}) => ({ _timestamp: seconds * SECOND, message, ...extra });

test('durations are written with their unit', () => {
  assert.equal(parseDuration('30s'), 30_000);
  assert.equal(parseDuration('10m'), 600_000);
  assert.equal(parseDuration('2h'), 7_200_000);
  assert.equal(parseDuration('1d'), 86_400_000);
  assert.equal(parseDuration('500ms'), 500);
  for (const wrong of ['10', 'm', '0s', '-5m', '1w']) assert.throws(() => parseDuration(wrong), /not a duration/);
});

test('a read is one SQL statement over the quoted stream', () => {
  assert.equal(
    logsSql('app_logs', "level = 'error'", 'newest', 100),
    `SELECT * FROM "app_logs" WHERE (level = 'error') ORDER BY _timestamp DESC LIMIT 100`,
  );
  assert.equal(logsSql('we"ird', '  ', 'oldest', 5), `SELECT * FROM "we""ird" ORDER BY _timestamp ASC LIMIT 5`);
});

test('result rows become objects by column', () => {
  assert.deepEqual(rowsOf({ columns: ['_timestamp', 'message'], rows: [[1, 'a'], [2, 'b']] }), [
    { _timestamp: 1, message: 'a' },
    { _timestamp: 2, message: 'b' },
  ]);
  assert.deepEqual(rowsOf({ rows: [{ message: 'x' }, 'not a row'] }), [{ message: 'x' }]);
  assert.deepEqual(rowsOf('nothing'), []);
});

test('a log is one line: time, level, service, message', () => {
  const line = formatLog(
    { _timestamp: Date.UTC(2026, 9, 18, 3, 4, 5, 678) * 1000, level: 'error', service: 'checkout', message: 'card declined' },
    { utc: true },
  );
  assert.equal(line, '2026-10-18 03:04:05.678 ERROR checkout card declined');

  // Without a message field the other fields are shown; values with spaces are quoted.
  assert.equal(
    formatLog({ _timestamp: 0, severity_text: 'warn', code: 503, path: '/pay now' }, { utc: true }),
    '1970-01-01 00:00:00.000 WARN  code=503 path="/pay now"',
  );

  // Colours only when asked: the level in red, the time grey.
  const coloured = formatLog(row(0, 'boom', { level: 'error' }), { utc: true, color: true });
  assert.match(coloured, /\u001b\[90m1970-01-01/);
  assert.match(coloured, /\u001b\[31mERROR\u001b\[0m/);
});

test('a follow prints each log once, reading a little back for late ones', () => {
  const follower = new LogFollower(100 * SECOND, 200 * SECOND, 10 * SECOND);
  const first = follower.begin([row(190, 'c'), row(150, 'b')], false);
  assert.deepEqual(first.map((it) => it.message), ['b', 'c']);

  // The next read starts 10 s before the end of the first.
  assert.deepEqual(follower.range(210 * SECOND), { start_micros: 190 * SECOND, end_micros: 210 * SECOND });

  // What it printed already comes back and is skipped; a late log inside the overlap is printed.
  const next = follower.take([row(190, 'c'), row(195, 'late'), row(205, 'd')], 210 * SECOND, false);
  assert.deepEqual(next.map((it) => it.message), ['late', 'd']);
  assert.equal(follower.catchingUp, false);
});

test('a first read cut at its count prints nothing older than it later', () => {
  const follower = new LogFollower(0, 200 * SECOND, 10 * SECOND);
  follower.begin([row(199, 'y'), row(198, 'x')], true);

  const later = follower.take([row(150, 'older than the cut'), row(201, 'z')], 210 * SECOND, false);
  assert.deepEqual(later.map((it) => it.message), ['z']);
});

test('a full read is read on from its last log at once', () => {
  const follower = new LogFollower(0, 100 * SECOND, 10 * SECOND);
  follower.begin([], false);

  follower.take([row(101, 'a'), row(102, 'b')], 300 * SECOND, true);
  assert.equal(follower.catchingUp, true);
  assert.deepEqual(follower.range(300 * SECOND).start_micros, 102 * SECOND);

  // A full read of nothing new moves past its time instead of coming back the same.
  follower.take([row(102, 'b'), row(102, 'b')], 300 * SECOND, true);
  assert.equal(follower.range(300 * SECOND).start_micros, 102 * SECOND + 1);

  follower.take([row(150, 'c')], 300 * SECOND, false);
  assert.equal(follower.catchingUp, false);
  assert.equal(follower.range(310 * SECOND).start_micros, 290 * SECOND);
});

/** Tools that answer reads from a script, and record what they were asked. */
function scripted(answers) {
  const asked = [];
  return {
    asked,
    reconnects: 0,
    async call(name, args) {
      asked.push({ name, args });
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next ?? { columns: ['_timestamp', 'message'], rows: [] };
    },
    async reconnect() {
      this.reconnects += 1;
    },
  };
}

const result = (...rows) => ({ columns: ['_timestamp', 'message'], rows: rows.map((it) => [it._timestamp, it.message]) });

test('without following, the newest logs print oldest first', async () => {
  const tools = scripted([result(row(30, 'three'), row(20, 'two'))]);
  const printed = [];
  let now = 100 * SECOND;

  await readLogs(
    tools,
    { stream: 'app_logs', where: "level = 'error'", since: 60_000, lines: 2, follow: false, interval: 2_000 },
    { write: (it) => printed.push(it.message), now: () => now },
  );

  assert.deepEqual(printed, ['two', 'three']);
  assert.equal(tools.asked.length, 1);
  assert.equal(tools.asked[0].args.sql, `SELECT * FROM "app_logs" WHERE (level = 'error') ORDER BY _timestamp DESC LIMIT 2`);
  assert.deepEqual(tools.asked[0].args.time_range, { start_micros: 40 * SECOND, end_micros: 100 * SECOND });
});

test('a follow prints what arrives, survives a lost connection and stops when asked', async () => {
  const stop = new AbortController();
  const notices = [];
  const printed = [];
  const tools = scripted([
    result(row(95, 'first')),
    new Error('fetch failed'),
    result(row(95, 'first'), row(101, 'second')),
    result(row(103, 'third')),
  ]);
  let now = 100 * SECOND;

  await readLogs(
    tools,
    { stream: 'app_logs', since: 60_000, lines: 10, follow: true, interval: 2_000 },
    {
      write: (it) => {
        printed.push(it.message);
        if (it.message === 'third') stop.abort();
      },
      notice: (line) => notices.push(line),
      signal: stop.signal,
      now: () => (now += SECOND),
      wait: async () => undefined,
    },
  );

  assert.deepEqual(printed, ['first', 'second', 'third']);
  assert.equal(tools.reconnects, 1);
  assert.match(notices[0], /lost the connection to MoleSignal \(fetch failed\)/);
  assert.equal(notices[1], 'connected to MoleSignal again');
  // Follow reads are oldest first and ask for one batch.
  assert.match(tools.asked[2].args.sql, /ORDER BY _timestamp ASC LIMIT 500$/);
});

test('an answer too large is read again in smaller batches; a refusal ends the follow', async () => {
  const tools = scripted([
    result(),
    new ToolError('tool response exceeds the configured response limit'),
    new ToolError('tool `query_logs` is disabled by the organization tool policy'),
  ]);

  await assert.rejects(
    readLogs(
      tools,
      { stream: 'app_logs', since: 60_000, lines: 10, follow: true, interval: 2_000 },
      { write: () => undefined, wait: async () => undefined },
    ),
    /disabled by the organization tool policy/,
  );
  assert.match(tools.asked[2].args.sql, /LIMIT 250$/);
});

test('streams are listed as aligned columns', () => {
  assert.deepEqual(
    formatStreams([
      { name: 'app_logs', field_count: 12, retention: { days: 30 }, description: 'Demo logs' },
      { name: 'k8s', field_count: 140, retention: null, description: null },
    ]),
    [
      'STREAM    FIELDS  RETENTION  DESCRIPTION',
      'app_logs  12      30d        Demo logs',
      'k8s       140     default',
    ],
  );
});
