'use strict';
// G61/G66: the measurement reads pattern points from one place. Invented values.
const test = require('node:test');
const assert = require('node:assert/strict');
const { points } = require('../agent/siparis/olcuNoktalari');

test('G61 the L list is read as before; another size or a missing L gives nothing', () => {
  const flat = { refBeden: 'L', olculerL: { omuzdan_boy: 112.2, etek: 60, bos: 0 } };
  assert.deepEqual(points(flat), { beden: 'L', cm: { omuzdan_boy: 112.2, etek: 60 }, mm: { omuzdan_boy: 1122, etek: 600 } });
  assert.deepEqual(points({ ...flat, refBeden: 'M' }).cm, {});
  assert.deepEqual(points({ ...flat, refBeden: 'M' }, { requireL: false }).cm.etek, 60);
  assert.deepEqual(points(flat, { size: 'M' }).cm, {});
});

test('G61 points resolved from the pattern tables (G66 shape) take precedence and keep the cm values exact', () => {
  const flat = { refBeden: 'L', olculerL: { etek: 50 }, olcuNoktalari: { beden: 'L', olculerMm: { omuzdan_boy: 1122, etek: 600, kol_boyu: 640 } } };
  const p = points(flat);
  assert.deepEqual(p.cm, { omuzdan_boy: 112.2, etek: 60, kol_boyu: 64 });
  assert.equal(p.mm.kol_boyu, 640);
  assert.deepEqual(points({ ...flat, olcuNoktalari: { beden: 'M', olculerMm: { etek: 580 } } }).cm, {});
});

test('G61/G66 the pattern table adds points (kol_boyu) to the L list that the scale already uses', () => {
  const flats = require('../agent/siparis/flats');
  const { openDb } = require('../agent/siparis/db');
  const { withPatternPoints } = require('../agent/siparis/documents');
  const db = openDb(':memory:'); flats.init(db);
  try {
    db.prepare('INSERT INTO document_flats(id,ad,urun,gorunum,dosya,refBeden,olculerL) VALUES(?,?,?,?,?,?,?)')
      .run('f0', 'TİŞÖRT', 'tisort', 'on', 'sentetik.png', 'L', JSON.stringify({ omuzdan_boy: 71, etek: 52 }));
    const flat = flats.get(db, 'f0');
    assert.equal(withPatternPoints(db, flat), flat); // no table yet: unchanged
    flats.loadMeasurementFile(db, { surum: 1, birim: 'mm', kaliplar: [{ ad: 'Sentetik Tişört', urun: 'tisort', kaynakTuru: 'excel', dosya: 's.xls', sayfa: 'S1',
      kalipAdlari: ['TİŞÖRT'], gogusTuru: 'belirsiz', bedenler: { L: { omuzdan_boy: 700, gogus: 600, kol_boyu: 640 } },
      hucreler: { L: { omuzdan_boy: 'C1', gogus: 'C2', kol_boyu: 'C3' } }, etiketler: { omuzdan_boy: 'BOY', gogus: 'GÖĞÜS', kol_boyu: 'KOL' } }] });
    const linked = withPatternPoints(db, flats.get(db, 'f0'));
    assert.deepEqual(points(linked).cm, { omuzdan_boy: 71, etek: 52, gogus: 60, kol_boyu: 64 });
    assert.equal(linked.olcuNoktalari.gogusTuru, 'belirsiz');
    // A flat whose list is not L contributes nothing of its own.
    db.prepare("UPDATE document_flats SET refBeden='M' WHERE id='f0'").run();
    assert.deepEqual(points(withPatternPoints(db, flats.get(db, 'f0'))).cm, { omuzdan_boy: 70, gogus: 60, kol_boyu: 64 });
  } finally { db.close(); }
});
