"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTodos, normalizeLedger, creditFocus } = require('../personal-data.js');
test('existing todos keep their content and completion state while gaining stable unique identities', () => {
  const migrated = normalizeTodos([{ text: '数学练习', done: false }, { text: '整理笔记', done: true }, { id: 'same', text: 'A' }, { id: 'same', text: 'B' }]);
  assert.equal(migrated.length, 4); assert.equal(new Set(migrated.map(t => t.id)).size, 4);
  assert.equal(migrated[1].done, true); assert.equal(migrated[0].text, '数学练习');
  assert.deepEqual(normalizeTodos(JSON.parse(JSON.stringify(migrated))), migrated);
  assert.deepEqual(normalizeTodos({}), []);
});
test('task credit is cumulative, separate by task and idempotent after storage round trips', () => {
  let ledger = creditFocus(null, { id: 'run1', taskId: 'math', ms: 90000 });
  ledger = creditFocus(JSON.parse(JSON.stringify(ledger)), { id: 'run1', taskId: 'math', ms: 90000 });
  assert.equal(ledger.totals.math, 90000);
  ledger = creditFocus(ledger, { id: 'run2', taskId: 'math', ms: 30000 });
  ledger = creditFocus(ledger, { id: 'run3', taskId: 'english', ms: 20000 });
  assert.equal(ledger.totals.math, 120000); assert.equal(ledger.totals.english, 20000);
  for (const run of [{ id: 'bad1', taskId: 'math', ms: NaN }, { id: 'bad2', taskId: 'math', ms: -1 }, { id: 'bad3', ms: 1000 }]) ledger = creditFocus(ledger, run);
  assert.equal(ledger.totals.math, 120000); assert.equal(ledger.receipts.length, 3);
  const safe = creditFocus(normalizeLedger({ totals: { bad: -1 }, receipts: [] }), { id: 'prototype', taskId: '__proto__', ms: 1000 });
  assert.equal(safe.totals.__proto__, 1000); assert.equal({}.ms, undefined);
});
