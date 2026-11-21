'use strict';
// G58: a candidate the measurement will not vouch for reaches the confirmation as a proposal. Invented values.
const test = require('node:test');
const assert = require('node:assert/strict');
const { explain, measureSuggestion } = require('../agent/siparis/documents');

const input = { position: 'sirt', image: { gorunum: 'arka' } };
const refused = (extra = {}) => ({ width_mm: null, height_mm: null, needs_confirmation: true,
  reasons: ['Renk adayının en-boy oranı (1.51) bağlı desenin oranıyla (2.77) uyuşmuyor.'],
  measure_source: { method: 'otomatik_renk', candidateBoxPx: { x: 943, y: 303, w: 101, h: 67 }, mmPerPx: 0.98, ...extra } });

test('G58 a refused candidate with a scale is proposed in the confirmation; the size itself stays empty', () => {
  const r = explain(refused(), input);
  assert.equal(r.width_mm, null);
  assert.equal(r.height_mm, null);
  assert.equal(r.needs_confirmation, true);
  assert.deepEqual(r.measure_source.oneri, { width_mm: 99, height_mm: 66 });
  assert.match(r.reason, /uyuşmuyor\..*Sistem önerisi \(bulunan aday kutudan\): 9,9 × 6,6 cm/);
});

test('G58 no proposal without a candidate, without a scale, or when a size was measured', () => {
  assert.equal(measureSuggestion(refused({ candidateBoxPx: null })), null);
  assert.equal(measureSuggestion(refused({ mmPerPx: null })), null);
  assert.equal(measureSuggestion(refused({ candidateBoxPx: { x: 0, y: 0, w: 0, h: 5 } })), null);
  assert.equal(measureSuggestion({ ...refused(), width_mm: 120, height_mm: 40 }), null);
  const plain = explain({ width_mm: null, height_mm: null, reasons: ['Ürün görünümü ayrılamadı.'], measure_source: { method: 'otomatik' } }, input);
  assert.equal(plain.measure_source.oneri, undefined);
  assert.doesNotMatch(plain.reason, /Sistem önerisi/);
});
