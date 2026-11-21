'use strict';
// G58: a white garment on a white ground is not found; the confirmation says why. Invented pictures only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCanvas } = require('@napi-rs/canvas');
const auto = require('../agent/siparis/autoMeasure');

const flat = { id: 'x', ad: 'Sentetik TİŞÖRT', refBeden: 'L', refLengthCm: 54, olculerL: { omuzdan_boy: 72, etek: 51, gogus: 54 } };
function picture(ground, shirt) {
  const c = createCanvas(600, 650), x = c.getContext('2d');
  x.fillStyle = ground; x.fillRect(0, 0, 600, 650);
  // A barely visible shirt: the same white as the ground with a faint outline and a dark print.
  x.fillStyle = shirt; x.fillRect(150, 120, 300, 440);
  x.fillStyle = '#1b2440'; x.fillRect(250, 250, 100, 40);
  return c.toBuffer('image/png');
}
const measure = buffer => auto.autoMeasure({ image: { id: 1, buffer, mime: 'image/png' }, design: null, flat, product: 'tisort', position: 'gogus' });

test('G58 a garment lost in a pale ground stays unmeasured, with the pale ground named as the reason', async () => {
  const r = await measure(picture('#fbfbfb', '#fbfbfb'));
  assert.equal(r.width_mm, null);
  assert.equal(r.needs_confirmation, true);
  assert.match(r.reason, /Ürün zeminden ayrılamadı: görselin zemini açık renkli \(#f[0-9a-f]{5}\); beyaz veya açık renkli ürünün kenarı güvenilir bulunamadı/);
  assert.match(r.reason, /0 ürün/);
});

test('G58 the pale-ground note is only for pale grounds', () => {
  const page = (rgb) => { const w = 20, h = 20, data = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) data.set([...rgb, 255], i * 4); return { width: w, height: h, data }; };
  assert.equal(auto.paleGroundReason(page([250, 250, 250])).length, 1);
  assert.deepEqual(auto.paleGroundReason(page([40, 60, 120])), []);
  assert.deepEqual(auto.paleGroundReason(page([200, 200, 200])), []);
});
