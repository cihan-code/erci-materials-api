'use strict';
// G61 rule 3: the position width table (mm) and its use in the measurement decision. Invented values.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const standards = require('../agent/siparis/konumStandartlari');
const { decide } = require('../agent/siparis/olcuKarar');

const table = standards.load(fs.mkdtempSync(path.join(os.tmpdir(), 'g61-bos-')));
const views = [{ page: 1, view: 'on' }];
const measured = (w, h, extra = {}) => ({ width_mm: w, height_mm: h, needs_confirmation: false, reasons: [], measure_source: { method: 'otomatik', views, ...extra } });
const run = (result, position, extra = {}) => decide(result, { position, product: 'tisort', standards: table, ...extra });

test('G61 the built-in table holds the starting bands and the sleeve text band', () => {
  assert.deepEqual(standards.standardFor(table, 'tisort', 'sol_gogus'), { min: 70, max: 120, varsayilan: 100 });
  assert.deepEqual(standards.standardFor(table, 'sweat', 'sirt'), { min: 250, max: 360, varsayilan: 300, kasaMax: 400 });
  assert.deepEqual(standards.standardFor(table, 'tisort', 'sag_kol', { dikey: true }), { min: 120, max: 200, varsayilan: 150, dikey: true });
  assert.equal(standards.standardFor(table, 'tisort', 'kapuson'), null);
  const custom = { konumlar: { sirt: { min: 200, max: 300, varsayilan: 250 } }, urunler: { sweat: { sirt: { min: 280, max: 380, varsayilan: 320 } } } };
  assert.equal(standards.standardFor(standards.validate(custom), 'Sweat', 'sirt').varsayilan, 320);
  assert.equal(standards.standardFor(custom, 'tisort', 'sirt').varsayilan, 250);
});

test('G61 a broken table is refused; the CLI installs a valid one in DATA_DIR and the decision reads it', () => {
  for (const bad of [{}, { konumlar: { sirt: { min: 300, max: 200, varsayilan: 250 } } }, { konumlar: { sirt: { min: 1.5, max: 200, varsayilan: 100 } } },
    { konumlar: { sirt: { min: 100, max: 200, varsayilan: 150, kasaMax: 150 } } }, { konumlar: { sirt: { min: 100, max: 200, varsayilan: 150, en: 1 } } }])
    assert.throws(() => standards.validate(bad));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g61-tablo-')), file = path.join(dir, 'yeni.json');
  fs.writeFileSync(file, JSON.stringify({ konumlar: { sol_gogus: { min: 60, max: 90, varsayilan: 80 } } }));
  const cli = path.join(__dirname, '../agent/siparis/tools/konum-standartlari.js');
  const out = childProcess.spawnSync(process.execPath, [cli, 'yukle', file], { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /sol_gogus\t60\t90\t80/);
  const loaded = standards.load(dir);
  const unmeasured = { width_mm: null, height_mm: null, reasons: [], measure_source: { method: 'otomatik', views: [] } };
  assert.equal(decide(unmeasured, { position: 'sol_gogus', standards: loaded }).width_mm, 80);
  fs.writeFileSync(path.join(dir, standards.FILE), '{bozuk');
  assert.throws(() => standards.load(dir));
  const refused = childProcess.spawnSync(process.execPath, [cli, 'yukle', path.join(dir, standards.FILE)], { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
});

test('G61 in band stays automatic, out of band is approximate, beyond twice the band takes the default', () => {
  const inBand = run(measured(100, 50), 'sol_gogus');
  assert.deepEqual([inBand.width_mm, inBand.height_mm, inBand.needs_confirmation, inBand.measure_source.olcuDurumu], [100, 50, false, 'otomatik']);
  assert.equal(inBand.measure_source.durum, 'otomatik');
  const wide = run(measured(150, 50), 'sol_gogus');
  assert.deepEqual([wide.width_mm, wide.measure_source.olcuDurumu], [150, 'yaklasik']);
  assert.match(wide.measure_source.olcuNotu, /olağan aralığın \(7–12 cm\) dışında/);
  const absurd = run(measured(260, 130), 'sol_gogus');
  assert.deepEqual([absurd.width_mm, absurd.height_mm, absurd.measure_source.olcuDurumu, absurd.measure_source.durum], [100, 50, 'standart', 'standart']);
  assert.deepEqual(absurd.measure_source.hamOlcu, { width_mm: 260, height_mm: 130 });
  const tiny = run(measured(30, 30), 'sol_gogus');
  assert.equal(tiny.measure_source.olcuDurumu, 'standart');
  // The print frame limit of the back.
  const frame = run(measured(420, 300), 'sirt');
  assert.equal(frame.measure_source.olcuDurumu, 'yaklasik');
  assert.ok(frame.measure_source.notlar.some(n => /baskı kasası sınırını \(40 cm\)/.test(n)));
});

test('G61 nothing measured: the standard width with the height from the design, never an empty print', () => {
  // White garment on white: no product, no candidate.
  const pale = { width_mm: null, height_mm: null, needs_confirmation: true, reasons: ['Açık zeminde ürün bulunamadı'], measure_source: { method: 'otomatik', views: [] } };
  const r = run(pale, 'gogus', { designRatio: 2 });
  assert.deepEqual([r.width_mm, r.height_mm, r.needs_confirmation, r.measure_source.olcuDurumu], [280, 140, false, 'standart']);
  assert.equal(r.measure_source.olcuKaynagi, 'standart ölçü (ölçülemedi)');
  // A located box without a scale still gives the shape.
  const noScale = { ...pale, measure_source: { method: 'otomatik', views, candidateBoxPx: { x: 0, y: 0, w: 90, h: 30 }, mmPerPx: null } };
  assert.deepEqual([run(noScale, 'sirt').width_mm, run(noScale, 'sirt').height_mm], [300, 100]);
  // No ratio at all: the width is written, the height waits (forms show "Ölçü bekleniyor").
  const bare = run(pale, 'sirt');
  assert.deepEqual([bare.width_mm, bare.height_mm, bare.needs_confirmation], [300, null, false]);
  // A position without a usual width keeps the confirmation.
  const hood = run(pale, 'kapuson');
  assert.deepEqual([hood.width_mm, hood.needs_confirmation], [null, true]);
});

test('G61 only an unclear print presence opens a confirmation', () => {
  // Garments found and searched, no print at the position.
  const empty = { width_mm: null, height_mm: null, needs_confirmation: true, reasons: ['Ürün maskesi veya görselde desen bulunamadı (2 ürün, 0 uygun desen adayı).'],
    measure_source: { method: 'otomatik', views: [{ page: 1, view: 'on' }, { page: 1, view: 'arka' }] } };
  const r = run(empty, 'gogus');
  assert.deepEqual([r.width_mm, r.needs_confirmation], [null, true]);
  assert.match(r.reason, /konumda baskı olup olmadığı teyit edilmeli/);
  // A sleeve searched with its design and nothing found is the same question.
  const sleeve = { ...empty, reasons: ['Kol konumu ayrı kol görselde ölçülemedi: Kol üzerinde desen adayı bulunamadı (0 eşleşme); yerleşim teyit edilmeli.'], measure_source: { method: 'otomatik' } };
  assert.equal(run(sleeve, 'sag_kol').needs_confirmation, true);
  // A candidate with a scale but many doubts is written as approximate, with the old suggestion removed.
  const doubtful = { width_mm: null, height_mm: null, needs_confirmation: true, reasons: ['Desen eşleştirme güveni %60', 'Sistem önerisi (bulunan aday kutudan): 10 × 5 cm'],
    measure_source: { method: 'otomatik', views, candidateBoxPx: { x: 0, y: 0, w: 50, h: 25 }, mmPerPx: 2, oneri: { width_mm: 100, height_mm: 50 } } };
  const d = run(doubtful, 'sol_gogus');
  assert.deepEqual([d.width_mm, d.height_mm, d.needs_confirmation, d.measure_source.olcuDurumu, d.measure_source.oneri], [100, 50, false, 'yaklasik', undefined]);
  assert.ok(d.measure_source.notlar.every(n => !n.startsWith('Sistem önerisi')));
});

test('G61 a sleeve without a design is not "no print": the standard width, along-the-arm text by the eye\'s box', () => {
  const noDesign = { width_mm: null, height_mm: null, needs_confirmation: true, measure_source: { method: 'otomatik' },
    reasons: ['Kol konumu ön görselde ölçülemedi: Kol desen dosyası yok veya boş; en-boy oranı ve desen eşleşmesi doğrulanamadı. Kol üzerinde desen adayı bulunamadı (0 eşleşme); yerleşim teyit edilmeli.'] };
  const badge = run(noDesign, 'sol_kol');
  assert.deepEqual([badge.width_mm, badge.height_mm, badge.needs_confirmation, badge.measure_source.durum], [90, null, false, 'standart']);
  // The eye saw a slanted script 4 times longer than wide: the sleeve text band (150 mm).
  const script = run(noDesign, 'sag_kol', { gozKol: { aspect: 1 / 4 } });
  assert.deepEqual([script.width_mm, script.height_mm, script.measure_source.konumStandardi.dikey], [150, 38, true]);
  const missing = run(noDesign, 'sag_kol', { gozKol: { baskiYok: 'sag_kol konumunda baskı yok' } });
  assert.deepEqual([missing.width_mm, missing.needs_confirmation], [null, true]);
});
