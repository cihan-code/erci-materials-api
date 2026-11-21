'use strict';
// G58: a PNG logo on an opaque flat field is traced with that field; the report now asks about it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PNG } = require('pngjs');
const { vectorize } = require('../agent/siparis/vector');

// Invented two-colour mark: a navy disc with a white counter, on a field, or a filled navy box.
function mark(ground, box = false) {
  const png = new PNG({ width: 240, height: 240 });
  for (let y = 0; y < 240; y++) for (let x = 0; x < 240; x++) {
    const i = (y * 240 + x) * 4, d = Math.hypot(x - 120, y - 120);
    const inside = box ? x >= 30 && x < 210 && y >= 30 && y < 210 : d < 90, counter = d < 30;
    const rgba = inside && !counter ? [24, 40, 90, 255] : inside ? [255, 255, 255, 255] : ground;
    for (let c = 0; c < 4; c++) png.data[i + c] = rgba[c];
  }
  return PNG.sync.write(png);
}
const FIELD = /^Desende düz zemin var \(#[0-9a-f]{6}\); baskıya dahil mi\? Teyit edin\.$/;

test('G58 an opaque white field behind the mark is reported and needs a look; nothing is removed', async () => {
  const r = await vectorize({ buffer: mark([255, 255, 255, 255]), mime: 'image/png', targetMm: { w: 60, h: 60 } });
  const field = r.report.reasons.filter(x => FIELD.test(x));
  assert.equal(field.length, 1, JSON.stringify(r.report.reasons));
  assert.equal(r.report.quality, 'teyit');
});

test('G58 a mark on a transparent ground, or a box mark filling its corners, raises no field question', async () => {
  for (const buffer of [mark([0, 0, 0, 0]), mark([255, 255, 255, 255], true)]) {
    const r = await vectorize({ buffer, mime: 'image/png', targetMm: { w: 60, h: 60 } });
    assert.ok(!r.report.reasons.some(x => FIELD.test(x)), JSON.stringify(r.report.reasons));
  }
});
