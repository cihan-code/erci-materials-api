'use strict';
// G61 rule 4: an automatic width is set in 5 mm steps (height from the ratio, in mm);
// sizes a person entered, workshop sizes included, are never touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { decide, roundWidth } = require('../agent/siparis/olcuKarar');
const documents = require('../agent/siparis/documents');
const { setup } = require('./fixtures/siparis/belge-fixture');
const { mockup } = require('./fixtures/siparis/oto-mockup');

const views = [{ page: 1, view: 'on' }];
test('G61 widths round to the nearest 5 mm and heights follow the ratio', () => {
  assert.deepEqual([roundWidth(97), roundWidth(97.5), roundWidth(102.4), roundWidth(1)], [95, 100, 100, 5]);
  const r = decide({ width_mm: 243, height_mm: 137, reasons: [], measure_source: { method: 'otomatik', views } }, { position: 'gogus' });
  assert.deepEqual([r.width_mm, r.height_mm], [245, Math.round(245 / (243 / 137))]);
  const d = decide({ width_mm: 243, height_mm: 120, reasons: [], measure_source: { method: 'otomatik', views } }, { position: 'gogus', designRatio: 243 / 137 });
  assert.equal(d.height_mm, Math.round(245 / (243 / 137)));
});

async function fixture(t) {
  const f = await setup();
  t.after(async () => { await documents.settled(); await f.close(); fs.rmSync(f.dir, { recursive: true, force: true }); });
  const root = path.join(fs.realpathSync(f.dir), 'siparis', 'flats'); fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'tisort.png'); fs.writeFileSync(file, mockup({ missing: true }).image);
  f.db.prepare('INSERT INTO document_flats(id,ad,urun,gorunum,dosya,refLengthCm,refLengthPx,refBeden,olculerL) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('tisorton', 'Sentetik tisort', 'tisort', 'on', file, 60, 300, 'L', JSON.stringify({ omuzdan_boy: 112.2, etek: 60 }));
  return f;
}
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.data)); return r.data; };

test('G61 an automatic chest width on the mockup is written in 5 mm steps; manual and workshop sizes stay', async t => {
  const f = await fixture(t), o = await f.order(), v = o.version.id, line = o.version.lines[0].id, m = mockup({ width: 117 });
  ok(await f.upload(v, { kind: 'urun_gorsel', lineId: line, gorunum: 'on', buffer: m.image }), 201);
  const design = ok(await f.upload(v, { lineId: line, buffer: m.design }), 201);
  const auto = ok(await f.post(`/satirlar/${line}/uygulamalar`, { kind: 'baski', position: 'gogus', desenDosyaId: design.id }), 201);
  const s = JSON.parse(auto.measure_source);
  assert.equal(auto.width_mm % 5, 0, auto.measure_source);
  // The width may move to the design-consistent edge first (rule 2), then to the 5 mm step.
  assert.ok(Math.abs(auto.width_mm - s.hamOlcu.width_mm) <= 5, auto.measure_source);
  assert.equal(auto.height_mm, Math.round(auto.width_mm / s.designContentRatio));
  // A workshop size typed by a person (93 x 41 mm, not a 5 mm step) survives every re-measurement.
  const manual = ok(await f.post(`/satirlar/${line}/uygulamalar`, { kind: 'baski', position: 'sol_gogus', width_mm: 93, height_mm: 41 }), 201);
  ok(await f.request(`/uygulamalar/${manual.id}`, { method: 'PATCH', token: f.token, body: { width_mm: 93, height_mm: 41, elleTeyit: true, kaynak: 'atölye ölçüsü' } }));
  ok(await f.post(`/surumler/${v}/otomatik-olc`, {}));
  const kept = f.db.prepare('SELECT * FROM applications WHERE id=?').get(manual.id);
  assert.deepEqual([kept.width_mm, kept.height_mm, JSON.parse(kept.measure_source).kaynak], [93, 41, 'atölye ölçüsü']);
});
