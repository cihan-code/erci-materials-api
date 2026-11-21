'use strict';
// G61 rule 2: only the width is measured; with a design file the height follows the design's own ratio.
const test = require('node:test');
const assert = require('node:assert/strict');
const { decide } = require('../agent/siparis/olcuKarar');
const standards = require('../agent/siparis/konumStandartlari');

const table = standards.validate(JSON.parse(require('node:fs').readFileSync(standards.BUILT_IN, 'utf8')));
const views = [{ page: 1, view: 'arka' }];
const result = (w, h, reasons = []) => ({ width_mm: w, height_mm: h, needs_confirmation: reasons.length > 0, reasons, measure_source: { method: 'otomatik', views } });
const run = (r, designRatio, position = 'sirt') => decide(r, { position, product: 'tisort', standards: table, designRatio });

test('G61 a box matching the design keeps its width; the height comes from the design ratio', () => {
  const r = run(result(300, 151), 2);
  assert.deepEqual([r.width_mm, r.height_mm, r.measure_source.olcuDurumu, r.measure_source.boyKaynagi], [300, 150, 'otomatik', 'desen_orani']);
});

test('G61 a box cut short in width takes the width from its height and the design ratio', () => {
  // Only part of the print was found: 200 x 150 mm box, the design is 2:1 -> 300 x 150.
  const r = run(result(200, 150), 2);
  assert.deepEqual([r.width_mm, r.height_mm, r.needs_confirmation], [300, 150, false]);
  assert.equal(r.measure_source.olcuDurumu, 'yaklasik');
  assert.match(r.measure_source.olcuNotu, /en kutunun boyundan desen oranıyla alındı/);
});

test('G61 a box cut short in height keeps its width; the ratio mismatch is a note, not a confirmation', () => {
  const r = run(result(300, 90, ['Renk adayının en-boy oranı (3,33) bağlı desenin 1. sayfasındaki içerik oranıyla (2,00) uyuşmuyor']), 2);
  assert.deepEqual([r.width_mm, r.height_mm, r.needs_confirmation, r.measure_source.olcuDurumu], [300, 150, false, 'yaklasik']);
  assert.ok(r.measure_source.notlar.some(n => /en kutunun eninden/.test(n)));
  assert.ok(r.measure_source.notlar.some(n => /uyuşmuyor/.test(n)));
});

test('G61 without a design the measured height stays; sleeves keep their own along/across sizing', () => {
  const r = run(result(300, 151), null);
  assert.deepEqual([r.width_mm, r.height_mm, r.measure_source.boyKaynagi], [300, 151, undefined]);
  const sleeve = run(result(150, 30), 2, 'sag_kol');
  assert.deepEqual([sleeve.width_mm, sleeve.height_mm], [150, 30]);
  // A long text along the sleeve is judged by the vertical band (120–200 mm), not the badge band.
  assert.equal(sleeve.measure_source.olcuDurumu, 'otomatik');
  assert.equal(sleeve.measure_source.konumStandardi.dikey, true);
});
