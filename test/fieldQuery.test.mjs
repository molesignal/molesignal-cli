import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fieldQuerySql } from '../dist/index.js';

test('a field query is the SQL condition the Logs page runs', () => {
  assert.equal(fieldQuerySql(''), undefined);
  assert.equal(fieldQuerySql("level = 'error'"), `"level" = 'error'`);
  assert.equal(fieldQuerySql('status >= 500'), '"status" >= 500');
  assert.equal(fieldQuerySql('ok = true'), '"ok" = TRUE');
  assert.equal(fieldQuerySql(`name = "it's"`), `"name" = 'it''s'`);
  assert.equal(fieldQuerySql('service.name ne "checkout"'), `"service.name" != 'checkout'`);
});

test('AND binds tighter than OR, and brackets group', () => {
  assert.equal(
    fieldQuerySql("level = 'error' AND (service = 'checkout' OR service = 'payments')"),
    `"level" = 'error' AND ("service" = 'checkout' OR "service" = 'payments')`,
  );
  assert.equal(
    fieldQuerySql("a = 1 or b = 2 and c = 3"),
    `("a" = 1 OR ("b" = 2 AND "c" = 3))`,
  );
});

test('text without a field is found in the message, a quoted phrase as one', () => {
  assert.equal(
    fieldQuerySql('timeout OR "connection reset"'),
    `("message" LIKE '%timeout%' OR "message" LIKE '%connection reset%')`,
  );
});

test('contains, MATCH and MATCH_TEXT, and a field with no value', () => {
  assert.equal(fieldQuerySql("path contains '/api'"), `CAST("path" AS VARCHAR) LIKE '%/api%'`);
  assert.equal(
    fieldQuerySql("message contains 'disk full'"),
    `(CAST("message" AS VARCHAR) LIKE '%disk full%' OR regexp_replace(CAST("message" AS VARCHAR), '[[:space:]]+', ' ', 'g') LIKE '%disk full%')`,
  );
  assert.equal(fieldQuerySql("MATCH_TEXT(message, 'timeout disk')"), `MATCH_TEXT(message, 'timeout disk')`);
  assert.equal(fieldQuerySql("trace_id = ''"), `("trace_id" IS NULL OR CAST("trace_id" AS VARCHAR) = '')`);
  assert.equal(fieldQuerySql("trace_id != ''"), `CAST("trace_id" AS VARCHAR) != ''`);
});

test('a part the query cannot read is an error, not left out', () => {
  assert.throws(() => fieldQuerySql("level = 'error' AND MATCH(message, timeout)"), /Cannot read "MATCH\(message, timeout\)"/);
});
