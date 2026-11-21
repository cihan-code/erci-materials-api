'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const flats = require('../agent/siparis/flats');
const { openDb } = require('../agent/siparis/db');
const { bodyRows, validSizeChart } = require('../agent/siparis/sizeChart');

// Invented values only: whole millimetres, one source cell per value.
const record = (over = {}) => ({
  ad:'Sentetik Tişört', urun:'tisort', kaynakTuru:'excel', dosya:'sentetik.xls', sayfa:'S1', kalipAdlari:['TİŞÖRT'], gogusTuru:'belirsiz',
  bedenler:{ S:{ boy:691, gogus:503, omuz:402, kol_boyu:213 }, M:{ boy:705, gogus:521, omuz:421, kol_boyu:222 } },
  hucreler:{ S:{ boy:'C23', gogus:'C21' }, M:{ boy:'G23', gogus:'G21' } },
  etiketler:{ boy:'OMUZDAN BOY', gogus:'GÖĞÜS' }, ...over });
const file = (...r) => ({ surum:1, birim:'mm', kaliplar:r });
function setup(names = ['TİŞÖRT', 'Oversize Tişört']) {
  const db = openDb(':memory:'); flats.init(db);
  for (const [i, ad] of names.entries()) db.prepare('INSERT INTO document_flats(id,ad,urun,gorunum,dosya) VALUES(?,?,?,?,?)').run(`f${i}`, ad, 'tisort', 'on', 'sentetik.png');
  return db;
}
const setChart = (db, id, chart) => db.prepare('UPDATE document_flats SET bedenTablosu=? WHERE id=?').run(JSON.stringify(chart), id);

test('G66 extra measurement points load as cm with source cells; mm round-trips exactly', () => {
  const db = setup();
  try {
    assert.equal(flats.loadMeasurementFile(db, file(record()), { dry:true }).filled, 1);
    assert.equal(flats.get(db, 'f0').bedenTablosu, null);
    const r = flats.loadMeasurementFile(db, file(record()));
    assert.equal(r.filled, 1); assert.deepEqual(r.unused, []);
    const chart = flats.get(db, 'f0').bedenTablosu;
    assert.equal(chart.birim, 'cm'); assert.equal(chart.kaynakTuru, 'excel'); assert.equal(chart.bedenler.S.omuz, 40.2);
    const m = flats.kalipOlculeri(db, 'f0', ' s ');
    assert.deepEqual(m.olculerMm, { boy:691, gogus:503, omuz:402, kol_boyu:213 });
    assert.equal(m.hucreler.gogus, 'C21'); assert.equal(m.kaynakTuru, 'excel'); assert.equal(m.gogusTuru, 'belirsiz');
    assert.equal(flats.kalipOlculeri(db, 'f0', 'XL'), null);
    assert.equal(flats.get(db, 'f1').bedenTablosu, null);
  } finally { db.close(); }
});

test('G66 source priority: Excel replaces a picture chart, never a hand-entered or Excel one', () => {
  const db = setup(['TİŞÖRT', 'Oversize Tişört', 'POLO']);
  try {
    const picture = { birim:'cm', kaynak:'eski.png', sha256:'ab', bedenler:{ S:{ boy:60, gogus:48 } } };
    const hand = { birim:'cm', kaynak:'elle', bedenler:{ S:{ boy:61, gogus:49 } } };
    setChart(db, 'f0', picture); setChart(db, 'f1', hand);
    const second = record({ ad:'Ikinci', kalipAdlari:['Oversize Tişört'] }), third = record({ ad:'Ucuncu', kalipAdlari:['POLO'], urun:'tisort' });
    const r = flats.loadMeasurementFile(db, file(record(), second, third));
    assert.deepEqual(Object.fromEntries(r.rows.map(x => [x.ad, x.durum])), { 'TİŞÖRT':'guncellendi', 'Oversize Tişört':'tam', POLO:'dolduruldu' });
    assert.equal(flats.get(db, 'f0').bedenTablosu.kaynakTuru, 'excel');
    assert.deepEqual(flats.get(db, 'f1').bedenTablosu, hand);
    assert.equal(flats.loadMeasurementFile(db, file(record(), second, third)).filled, 0);
    // A picture record never replaces an Excel chart or fills over a picture chart.
    setChart(db, 'f2', picture);
    assert.equal(flats.loadMeasurementFile(db, file(record({ ad:'R', kaynakTuru:'resim', kalipAdlari:['POLO'] }))).rows.find(x => x.ad === 'POLO').durum, 'tam');
    assert.equal(flats.get(db, 'f0').bedenTablosu.kaynakTuru, 'excel');
  } finally { db.close(); }
});

test('G66 bad records are rejected; unmatched names and other products are reported, not written', () => {
  const db = setup();
  try {
    for (const bad of [record({ bedenler:{ S:{ boy:69.1 } } }), record({ bedenler:{ S:{ boy:-5 } } }), record({ kaynakTuru:'tahmin' }), record({ dosya:'' }), record({ bedenler:{ S:{ 'Boy':690 } } })])
      assert.throws(() => flats.loadMeasurementFile(db, file(bad)));
    assert.throws(() => flats.loadMeasurementFile(db, { kaliplar:'x' }));
    const r = flats.loadMeasurementFile(db, file(record({ urun:'sweat' }), record({ ad:'Yok', kalipAdlari:['Olmayan'] }), record({ ad:'Cocuk', kalipAdlari:[] })));
    assert.equal(r.filled, 0); assert.equal(r.rows.find(x => x.ad === 'TİŞÖRT').neden, 'ürün farklı');
    assert.deepEqual(r.unused.sort(), ['Cocuk', 'Yok'].sort());
  } finally { db.close(); }
});

test('G66 old chart format still reads; the form size table is unchanged by extra points', () => {
  const old = { birim:'cm', kaynak:'eski.png', bedenler:{ S:{ boy:63.2, gogus:47 }, L:{ yan_boy:90, basen:55 } } };
  assert.equal(validSizeChart(old), true); assert.equal(bodyRows(old).length, 1);
  const db = setup();
  try {
    flats.loadMeasurementFile(db, file(record()));
    const chart = flats.get(db, 'f0').bedenTablosu;
    assert.deepEqual(bodyRows(chart).map(([s, v]) => [s, v.boy, v.gogus]), [['S', 69.1, 50.3], ['M', 70.5, 52.1]]);
    assert.equal(validSizeChart({ ...chart, kaynakTuru:'tahmin' }), false);
    setChart(db, 'f1', old);
    assert.equal(flats.kalipOlculeri(db, 'f1', 'S').kaynakTuru, 'elle');
    assert.deepEqual(flats.kalipOlculeri(db, 'f1', 'l').olculerMm, { yan_boy:900, basen:550 });
  } finally { db.close(); }
});

test('G66 CLI kalip-olcu-yukle: --kuru writes nothing, real run loads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g66-')), f = path.join(dir, 'olcu.json');
  const db = openDb(path.join(dir, 'siparis.sqlite'));
  try {
    flats.init(db);
    db.prepare('INSERT INTO document_flats(id,ad,urun,gorunum,dosya) VALUES(?,?,?,?,?)').run('a', 'TİŞÖRT', 'tisort', 'on', 'sentetik.png');
    fs.writeFileSync(f, JSON.stringify(file(record())));
    const run = (...x) => spawnSync(process.execPath, ['agent/siparis/cli.js', 'kalip-olcu-yukle', f, ...x], { env:{ ...process.env, DATA_DIR:dir }, encoding:'utf8' });
    const dry = run('--kuru'); assert.equal(dry.status, 0, dry.stderr); assert.match(dry.stdout, /doldurulacak/);
    assert.equal(flats.get(db, 'a').bedenTablosu, null);
    const real = run(); assert.equal(real.status, 0, real.stderr); assert.match(real.stdout, /dolduruldu/);
    assert.equal(flats.get(db, 'a').bedenTablosu.bedenler.M.kol_boyu, 22.2);
  } finally { db.close(); fs.rmSync(dir, { recursive:true, force:true }); }
});
