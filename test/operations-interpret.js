'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const providerPath = require.resolve('../agent/claude');
let calls = [], answer;
require.cache[providerPath] = { id: providerPath, filename: providerPath, loaded: true, exports: {
  callClaude: async options => { calls.push(options); return { text: JSON.stringify(answer), model: 'synthetic', costUsd: 0 }; },
} };
const { interpret } = require('../agent/operations/interpret');
const core = require('../agent/operations/core');
test('real adapter omits quantity, permits both component reports and retains one-call budget', async () => {
  for (const text of ['260 adet Kesim yapıldı ama kapşon astarı henüz kesilmedi', 'Kesim yapıldı ama kapşon astarı henüz kesilmedi']) {
    calls = [];
    answer = { clarification: '', entries: [{ op: 'cut', status: 'partial', remaining: null,
      reason: 'kapşon astarı henüz kesilmedi', issue: null, evidence: text }] };
    const result = await interpret(text, { customer_name: 'Synthetic', quantity: 250, status: 'Kumaş Geldi' }, [], '2026-10-02');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].maxAttempts, 1); assert.equal(calls[0].maxTokens, 1500);
    assert.equal('quantity' in JSON.parse(calls[0].user).selected_record, false);
    assert.match(calls[0].system, /Quantities NEVER block/);
    assert.match(calls[0].system, /remaining is OPTIONAL/);
    assert.match(calls[0].system, /Turkish clarification example/);
    assert.equal(core.validateEntries(result.entries, {}, text)[0].remaining, null);
  }
});
test('adapter preserves approved Turkish clarifications and replaces any other language', async () => {
  for (const clarification of ['Please specify the operation.', 'Hangi üretim işlemi yapıldı? Bugün yapılan işlemi ve varsa kalan işi açıkça yazın.']) {
    calls = []; answer = { clarification, entries: [] };
    const result = await interpret('İş halledildi.', {}, [], '2026-10-02');
    assert.equal(calls.length, 1); assert.match(result.clarification, /Hangi üretim işlemi/);
    assert.doesNotMatch(result.clarification, /Please/);
  }
});

test('native provider-independent failures are Turkish while existing Turkish errors survive', () => {
  const { publicError } = require('../agent/operations/clarification');
  for (const error of [new SyntaxError('Unexpected token'), new TypeError('Cannot read properties'), Object.assign(new Error('permission denied'), { code: 'EACCES' })]) {
    assert.match(publicError(error), /Üretim işlemi tamamlanamadı/);
    assert.doesNotMatch(publicError(error), /Unexpected|Cannot|permission/);
  }
  assert.equal(publicError(new Error('Plan değişti; yenileyip tekrar kaydedin.')), 'Plan değişti; yenileyip tekrar kaydedin.');
});
test('today\'s work mixed with plans: entries hold today, dated plans become expectations', async () => {
  const text = 'Kumaş kesimi bitti kaşkorse kaldı fermuar siparişi verildi ve nakışa bırakıldı. Yarın nakıştan ürünlerin bir kısmı alınacak kalanı da pazartesi akşam bitecek Salı akşam teslim edilmesi gerekiyor';
  calls = [];
  answer = { clarification: '', entries: [
    { op: 'cut', status: 'partial', remaining: null, reason: 'kaşkorse kaldı', issue: null, evidence: 'Kumaş kesimi bitti kaşkorse kaldı' },
    { op: 'zipper', status: 'in_progress', remaining: null, reason: '', issue: null, evidence: 'fermuar siparişi verildi' },
    { op: 'embroidery_dropoff', status: 'completed', remaining: null, reason: '', issue: null, evidence: 'nakışa bırakıldı' }],
    expectations: [{ op: 'embroidery', when: 'pazartesi', evidence: 'kalanı da pazartesi akşam bitecek' },
      { op: 'delivery', when: 'Salı', evidence: 'Salı akşam teslim edilmesi gerekiyor' }] };
  const result = await interpret(text, { customer_name: 'Synthetic', status: 'Kesimde', product_type: 'yarim_fermuar' }, [], '2026-10-09');
  assert.match(calls[0].system, /entries hold ONLY today's actual events/);
  assert.match(calls[0].system, /Never compute or convert dates/);
  assert.match(calls[0].system, /fermuar siparişi verildi\) is in_progress/);
  assert.deepEqual(calls[0].schema.required, ['clarification', 'entries', 'expectations']);
  assert.equal(JSON.parse(calls[0].user).selected_record.product, 'Yarım fermuarlı');
  assert.deepEqual(core.validateEntries(result.entries, {}, text).map(e => [e.op, e.status]),
    [['cut', 'partial'], ['zipper', 'in_progress'], ['embroidery_dropoff', 'completed']]);
  const expectations = require('../agent/operations/expectations');
  assert.deepEqual(expectations.validate(result.expectations, text, '2026-10-09', core.OPS).map(x => [x.op, x.date]),
    [['embroidery', '2026-10-12'], ['delivery', '2026-10-13']]);
});
