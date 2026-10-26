import assert from 'node:assert/strict';
import { test } from 'node:test';

import { csv, cut, displayWidth, formatCount, formatPercent, sparkline, table } from '../dist/index.js';

test('a table lines up columns by how wide text shows, Chinese text twice as wide', () => {
  assert.equal(displayWidth('数据流'), 6);
  assert.equal(displayWidth('\u001b[31mred\u001b[0m'), 3);
  assert.deepEqual(table(['NAME', 'N'], [['数据', '1'], ['ab', '22']]), ['NAME  N', '数据  1', 'ab    22']);
});

test('on a terminal the last column is cut to the room left', () => {
  const lines = table(['A', 'TEXT'], [['x', 'a long message that does not fit']], { width: 15 });
  assert.equal(lines[1], 'x  a long mess…');
  assert.equal(cut('数据流水线', 7), '数据流…');
});

test('CSV quotes what needs it', () => {
  assert.deepEqual(csv(['a', 'b'], [['plain', 'with, comma'], ['say "hi"', null], [{ x: 1 }, 2]]), [
    'a,b',
    'plain,"with, comma"',
    '"say ""hi""",',
    '"{""x"":1}",2',
  ]);
});

test('counts, shares and sparklines read at a glance', () => {
  assert.equal(formatCount(950), '950');
  assert.equal(formatCount(12_345), '12k');
  assert.equal(formatCount(4_500_000), '4.5M');
  assert.equal(formatPercent(0.000123), '0.01%');
  assert.equal(formatPercent(0.045), '4.5%');
  assert.equal(formatPercent(1), '100%');
  assert.equal(sparkline([1, 2, 3, 4, 5, 6, 7, 8]), '▁▂▃▄▅▆▇█');
  assert.equal(sparkline([5, 5]), '▄▄');
});
