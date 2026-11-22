'use strict';
// G61b: the scale from the eye's garment points and the pattern's known widths; sleeve prints on
// their own axis; a measured small mark is never replaced by the standard. Invented data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createCanvas } = require('@napi-rs/canvas');
const { pointScale, gozLimbMeasure } = require('../agent/siparis/autoMeasure');
const { decide } = require('../agent/siparis/olcuKarar');
const standards = require('../agent/siparis/konumStandartlari');
const goz = require('../agent/siparis/goz');
const documents = require('../agent/siparis/documents');
const { setup } = require('./fixtures/siparis/belge-fixture');
const { mockup } = require('./fixtures/siparis/oto-mockup');

const table = standards.validate(JSON.parse(fs.readFileSync(standards.BUILT_IN, 'utf8')));
// Points as fractions of a 1000 x 1000 picture.
const pt = (x, y) => ({ x: x / 1000, y: y / 1000 });

test('G61b agreeing shoulder, chest and hem widths give their median scale', () => {
  const pts = { omuz_sol: pt(300, 100), omuz_sag: pt(700, 100), koltuk_sol: pt(280, 300), koltuk_sag: pt(720, 300), etek_sol: pt(290, 800), etek_sag: pt(710, 800) };
  // Pattern: shoulder 40, chest 44, hem 42 cm -> 1.0, 1.0, 1.0 mm/px.
  const r = pointScale(pts, { omuz: 40, gogus: 44, etek: 42 }, 1000, 1000);
  assert.ok(Math.abs(r.mmPerPx - 1) < 1e-9);
  assert.deepEqual(r.adaylar.map(c => c.k), ['omuz', 'gogus', 'etek']);
  assert.equal(r.yaklasik, undefined);
});

test('G61b disagreeing candidates: shoulder/hem mean or the most consistent pair, approximate; height alone is no scale', () => {
  // Shoulder 1.2 and hem 1.0 mm/px: their mean, approximate (the chest does not join).
  const pts = { omuz_sol: pt(300, 100), omuz_sag: pt(700, 100), koltuk_sol: pt(280, 300), koltuk_sag: pt(720, 300), etek_sol: pt(290, 800), etek_sag: pt(710, 800) };
  const r = pointScale(pts, { omuz: 48, gogus: 44, etek: 42 }, 1000, 1000);
  assert.deepEqual(r.secilen, ['omuz', 'etek']); assert.ok(Math.abs(r.mmPerPx - 1.1) < 1e-9); assert.match(r.yaklasik, /ortalamaları/);
  // No hem: shoulder 1.54 against chest 1.0 and nothing else -> the most consistent pair is that pair.
  const noHem = pointScale({ ...pts, etek_sol: null, etek_sag: null, yaka: pt(500, 90) }, { omuz: 61.5, gogus: 44, omuzdan_boy: 70 }, 1000, 1000);
  assert.deepEqual(noHem.secilen, ['omuz', 'gogus']); assert.match(noHem.yaklasik, /en tutarlı ikili/);
  const single = pointScale({ etek_sol: pt(290, 800), etek_sag: pt(710, 800) }, { etek: 42 }, 1000, 1000);
  assert.ok(Math.abs(single.mmPerPx - 1) < 1e-9); assert.match(single.yaklasik, /tek yatay aday/);
  const heightOnly = pointScale({ yaka: pt(500, 90), etek_sol: pt(290, 800) }, { omuzdan_boy: 70 }, 1000, 1000);
  assert.equal(heightOnly.mmPerPx, undefined); assert.match(heightOnly.reason, /tek eksenli ölçek kullanılmaz/);
});

test('G61b a slanted sleeve print is measured along and across its sleeve axis', () => {
  // Grey garment, a sleeve axis at 45° from (200,200) to (500,500), a white bar 150 x 30 px along it.
  const c = createCanvas(700, 700), x = c.getContext('2d');
  x.fillStyle = '#5a1020'; x.fillRect(0, 0, 700, 700);
  x.save(); x.translate(350, 350); x.rotate(Math.PI / 4); x.fillStyle = '#f4f4f4'; x.fillRect(-75, -15, 150, 30); x.restore();
  const p = x.getImageData(0, 0, 700, 700);
  const box = { x: 230 / 700, y: 230 / 700, w: 240 / 700, h: 240 / 700 };
  const points = { kol_sol_omuz: { x: 200 / 700, y: 200 / 700 }, kol_sol_agiz: { x: 500 / 700, y: 500 / 700 }, kol_sag_omuz: { x: 650 / 700, y: 50 / 700 }, kol_sag_agiz: { x: 690 / 700, y: 60 / 700 } };
  // Sleeve 424 px long = 63.6 cm in the pattern -> 1.5 mm/px.
  const m = gozLimbMeasure(p, { print: { box }, product: { points } }, 'sol_kol', { kol_boyu: Math.hypot(300, 300) * 0.15 });
  assert.equal(m.eksen.taraf, 'sol'); assert.equal(m.olcek, 'kol_boyu'); assert.equal(m.fit, 'murekkep');
  assert.ok(Math.abs(m.width_mm - 225) <= 6, JSON.stringify(m)); // 150 px along the arm
  assert.ok(Math.abs(m.height_mm - 45) <= 6, JSON.stringify(m)); // 30 px across
  // Without the pattern's sleeve length the body scale is used, approximate.
  const body = gozLimbMeasure(p, { print: { box }, product: { points: { ...points, koltuk_sol: pt(0, 0), koltuk_sag: { x: 600 / 700, y: 0 } } } }, 'sol_kol', { gogus: 60 });
  assert.equal(body.olcek, 'noktalar'); assert.match(body.olcekYaklasik, /kol boyu yok/);
  assert.match(gozLimbMeasure(p, { print: { box }, product: { points: {} } }, 'sol_kol', {}).reason, /ekseninin noktalarını vermedi/);
});

test('G61b a measured small mark keeps its size: out of band is only approximate', () => {
  const eye = { width_mm: 30, height_mm: 30, reasons: [], measure_source: { method: 'otomatik', goz: { width_mm: 12, height_mm: 10, eksen: { taraf: 'sol' } } } };
  const mark = decide({ ...eye, width_mm: null, height_mm: null }, { position: 'ense', standards: table });
  assert.deepEqual([mark.width_mm, mark.measure_source.durum, mark.measure_source.olcuKaynagi], [10, 'yaklasik', 'görselden (göz)']);
  // The pixel path's number is still replaced when it is beyond twice the band.
  const pixel = decide({ width_mm: 12, height_mm: 10, reasons: [], measure_source: { method: 'otomatik', views: [{ page: 1, view: 'arka' }] } }, { position: 'ense', standards: table });
  assert.deepEqual([pixel.width_mm, pixel.measure_source.durum], [80, 'standart']);
  // Point-scale doubts and order pairing travel to the record.
  const doubt = decide({ width_mm: null, height_mm: null, reasons: [], measure_source: { method: 'otomatik', goz: { width_mm: 300, height_mm: 120, olcekYaklasik: 'Ölçek adayları %20 ayrışıyor', pairing: 'yukarıdan aşağı sırayla eşlendi' } } }, { position: 'sirt', standards: table });
  assert.equal(doubt.measure_source.durum, 'yaklasik');
  assert.ok(['ayrışıyor', 'sırayla'].every(w => doubt.measure_source.notlar.some(n => n.includes(w))));
});

test('G61b end to end: the eye\'s points size the chest print without a pixel scale; no points keeps the old path', async t => {
  process.env.GOZ_OLCU = '1';
  const answer = withPoints => ({ urunler: [{ kutu: { x: 60, y: 45, w: 480, h: 560 }, gorunum: 'on', tur: 'tişört',
    noktalar: withPoints ? { omuz_sol: null, omuz_sag: null, koltuk_sol: { x: 450, y: 215 }, koltuk_sag: { x: 150, y: 215 }, etek_sol: { x: 450, y: 605 }, etek_sag: { x: 150, y: 605 } } : null }],
    baskilar: [{ konum: 'gogus', urun: 0, kutu: { x: 232, y: 258, w: 136, h: 82 }, aciklama: 'logo', guven: 'yuksek' }] });
  let current = answer(true);
  goz.setTestProvider(async () => ({ answer: current }));
  t.after(() => { goz.setTestProvider(null); delete process.env.GOZ_OLCU; });
  const f = await setup();
  t.after(async () => { await documents.settled(); await f.close(); fs.rmSync(f.dir, { recursive: true, force: true }); });
  // The flat has a chest and hem width but no usable pixel scale (no flat drawing, refBeden L).
  f.db.prepare('INSERT INTO document_flats(id,ad,urun,gorunum,dosya,refBeden,olculerL) VALUES(?,?,?,?,?,?,?)').run('t', 'Sentetik', 'tisort', 'on', 'yok.png', 'L', JSON.stringify({ gogus: 60, etek: 60 }));
  const o = await f.order(), v = o.version.id, line = o.version.lines[0].id;
  const up = await f.upload(v, { kind: 'urun_gorsel', lineId: line, gorunum: 'on', buffer: mockup().image }); assert.equal(up.status, 201);
  const app = (await f.post(`/satirlar/${line}/uygulamalar`, { kind: 'baski', position: 'gogus' })).data;
  const s = JSON.parse(app.measure_source);
  assert.equal(s.goz.olcek, 'noktalar', app.measure_source);
  assert.equal(app.width_mm, 240); // 120 px of ink at 2 mm/px (300 px = 60 cm)
  // An answer without points: the eye's box with the old silhouette scale, as in G61.
  current = answer(false); goz.setTestProvider(async () => ({ answer: current }));
  f.db.prepare('DELETE FROM goz_cache').run();
  assert.equal((await f.post(`/surumler/${v}/otomatik-olc?yeniden=1`, {})).status, 200);
  const again = JSON.parse(f.db.prepare('SELECT measure_source FROM applications WHERE id=?').get(app.id).measure_source);
  assert.equal(again.goz.olcek, undefined);
});

test('G61b a design the colour separation cannot isolate is cut from the eye\'s box, the garment made transparent', async () => {
  const { extractArtwork } = require('../agent/siparis/autoMeasure');
  const { PNG } = require('pngjs');
  const c = createCanvas(600, 600), x = c.getContext('2d');
  x.fillStyle = '#5a1020'; x.fillRect(0, 0, 600, 600);
  x.fillStyle = '#f4f4f4'; x.fillRect(100, 300, 80, 20); x.fillRect(100, 330, 40, 10);
  const image = { buffer: c.toBuffer('image/png'), mime: 'image/png', gorunum: 'on' };
  // A sleeve position: the colour path refuses it; without the eye's box the reason stays.
  assert.match((await extractArtwork({ image, position: 'sol_kol' })).reason, /ayrıştırılamadı/);
  const cut = await extractArtwork({ image, position: 'sol_kol', gozBox: { x: 90 / 600, y: 290 / 600, w: 100 / 600, h: 60 / 600 } });
  assert.equal(cut.placement.gozKesit, true);
  assert.deepEqual(cut.placement.designBoxPx, { x: 100, y: 300, w: 80, h: 40 });
  const png = PNG.sync.read(cut.buffer), alpha = (px, py) => png.data[(py * png.width + px) * 4 + 3];
  assert.equal(alpha(5, 5), 255); assert.equal(alpha(70, 30), 0); // ink kept, garment between the bars transparent
  assert.match(cut.notes[0], /gözün kutusundan kesildi/);
});

test('G61b shoulder and hem agreeing outweigh a narrow-reading chest; a mirrored side is taken when the order leaves it free', () => {
  const pts = { omuz_sol: pt(300, 100), omuz_sag: pt(700, 100), koltuk_sol: pt(330, 300), koltuk_sag: pt(670, 300), etek_sol: pt(290, 800), etek_sag: pt(710, 800) };
  // Chest 44 cm over 340 px (1.29 mm/px) against shoulder and hem at 1.0: the chest is left out.
  const r = pointScale(pts, { omuz: 40, gogus: 44, etek: 42 }, 1000, 1000);
  assert.ok(Math.abs(r.mmPerPx - 1) < 1e-9); assert.equal(r.yaklasik, undefined);
  assert.equal(r.adaylar.length, 3); // all candidates stay on the record
  const answer = goz.normalize({ urunler: [{ kutu: { x: 0, y: 0, w: 100, h: 100 }, gorunum: 'on', tur: 't', noktalar: null }],
    baskilar: [{ konum: 'sag_gogus', urun: 0, kutu: { x: 60, y: 20, w: 10, h: 10 }, aciklama: 'logo', guven: 'yuksek' }] }, { width: 100, height: 100 });
  const swapped = goz.forPrint(answer, 'sol_gogus', 1, 0, new Set(['sol_gogus', 'sirt']));
  assert.match(swapped.print.pairing, /sag_gogus konumunda gördü/);
  assert.ok(goz.forPrint(answer, 'sol_gogus', 1, 0, new Set(['sol_gogus', 'sag_gogus'])).baskiYok);
});
