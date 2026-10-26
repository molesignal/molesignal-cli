import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ago, clock, formatDuration, parseDuration, parseTime, timeWindow } from '../dist/index.js';

const NOW = Date.UTC(2026, 9, 26, 12, 0, 0) * 1000;

test('durations are written with their unit', () => {
  assert.equal(parseDuration('30s'), 30_000);
  assert.equal(parseDuration('10m'), 600_000);
  assert.equal(parseDuration('2h'), 7_200_000);
  assert.equal(parseDuration('1d'), 86_400_000);
  assert.equal(parseDuration('1w'), 604_800_000);
  assert.equal(parseDuration('500ms'), 500);
  for (const wrong of ['10', 'm', '0s', '-5m', '1y']) assert.throws(() => parseDuration(wrong), /not a duration/);
});

test('a time is an ISO time, a local date and time, an epoch number, or a duration back', () => {
  assert.equal(parseTime('2026-10-26T11:00:00Z', NOW), NOW - 3_600_000_000);
  assert.equal(parseTime('2h', NOW), NOW - 7_200_000_000);
  // Seconds, milliseconds and microseconds since the epoch, told apart by size.
  assert.equal(parseTime('1761476400', NOW), 1_761_476_400_000_000);
  assert.equal(parseTime('1761476400000', NOW), 1_761_476_400_000_000);
  assert.equal(parseTime('1761476400000000', NOW), 1_761_476_400_000_000);
  // Without a zone, local time, as the clock shows it.
  assert.equal(clock(parseTime('2026-10-26 14:03:12.345', NOW)), '2026-10-26 14:03:12.345');
  assert.equal(clock(parseTime('2026-10-26', NOW)), '2026-10-26 00:00:00.000');
  assert.throws(() => parseTime('yesterday', NOW), /not a time/);
});

test('a window runs from --from or --since back to --to or now', () => {
  assert.deepEqual(timeWindow({}, '1h', NOW), { start_micros: NOW - 3_600_000_000, end_micros: NOW });
  assert.deepEqual(timeWindow({ since: '15m' }, '1h', NOW), { start_micros: NOW - 900_000_000, end_micros: NOW });
  assert.deepEqual(timeWindow({ from: '2h', to: '1h' }, '1h', NOW), {
    start_micros: NOW - 7_200_000_000,
    end_micros: NOW - 3_600_000_000,
  });
  assert.throws(() => timeWindow({ since: '1h', from: '2h' }, '1h', NOW), /not both/);
  assert.throws(() => timeWindow({ from: '1h', to: '2h' }, '1h', NOW), /ends before it starts/);
});

test('lengths of time and ages read the way people say them', () => {
  assert.equal(formatDuration(0.25), '250µs');
  assert.equal(formatDuration(850), '850ms');
  assert.equal(formatDuration(1234), '1.23s');
  assert.equal(formatDuration(42_000), '42s');
  assert.equal(formatDuration(185_000), '3m 05s');
  assert.equal(formatDuration(7_800_000), '2h 10m');
  assert.equal(formatDuration(3 * 86_400_000 + 4 * 3_600_000), '3d 4h');
  assert.equal(ago(NOW - 10_000_000, NOW), 'just now');
  assert.equal(ago(NOW - 300_000_000, NOW), '5m ago');
  assert.equal(ago(NOW - 2 * 86_400_000_000, NOW), '2d ago');
});
