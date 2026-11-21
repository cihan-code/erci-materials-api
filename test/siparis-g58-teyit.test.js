'use strict';
// G58: the confirmation screen answers front/back once per picture. Invented mockups only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup } = require('./fixtures/siparis/belge-fixture');
const { multiMockup } = require('./fixtures/siparis/oto-multi');
const documents = require('../agent/siparis/documents');

const L = { omuzdan_boy: 71, etek: 52, gogus: 61, tum_omuz: 61.5 };
async function fixture(t) { const f = await setup(); t.after(async () => { await f.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }); return f; }
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.data)); return r.data; };
function addFlat(f) {
  const root = path.join(fs.realpathSync(f.dir), 'siparis', 'flats'); fs.mkdirSync(root, { recursive: true });
  const filename = path.join(root, 'sweat.png'); fs.writeFileSync(filename, multiMockup({ missing: true }).image);
  f.db.prepare('INSERT INTO document_flats(id,ad,urun,gorunum,dosya,refLengthCm,refLengthPx,refBeden,olculerL) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('sweat-l', 'Sentetik SWEAT', 'sweat', 'on', filename, 61, 300, 'L', JSON.stringify(L));
}
// No hood lining or cords on the front: the picture itself cannot tell front from back.
async function undecided(t) {
  const f = await fixture(t); addFlat(f);
  const o = await f.order({ lines: [{ product_key: 'sweat', quantity: 1, sizes: { L: 1 } }] }), v = o.version.id, line = o.version.lines[0];
  const picture = multiMockup({ ambiguous: true }).image;
  for (const gorunum of ['on', 'arka']) ok(await f.upload(v, { kind: 'urun_gorsel', lineId: line.id, gorunum, buffer: picture }), 201);
  const apps = [];
  for (const [kind, position] of [['nakis', 'gogus'], ['baski', 'sirt']]) apps.push(ok(await f.post(`/satirlar/${line.id}/uygulamalar`, { kind, position }), 201));
  await documents.settled();
  const open = () => f.db.prepare("SELECT * FROM confirmations WHERE kind='olcu' AND ref_table='applications' AND status='acik' ORDER BY id").all();
  return { f, v, apps, open };
}

test('G58 one front/back answer on the confirmation screen measures every print of the picture again', async t => {
  const { f, apps, open } = await undecided(t);
  const before = open();
  assert.equal(before.length, 2);
  assert.ok(before.every(c => /görünüm ayrılamadı/.test(c.message)), JSON.stringify(before));
  assert.ok(apps.every(a => f.db.prepare('SELECT width_mm FROM applications WHERE id=?').get(a.id).width_mm === null));
  // One answer, on one of the two confirmations: the front is the garment on the left.
  const answer = ok(await f.post(`/teyitler/${before[0].id}/coz`, { onUrun: 'sol' }));
  assert.equal(answer.onUrun, 'sol');
  assert.equal(f.db.prepare('SELECT count(*) n FROM document_image_views').get().n, 1);
  const after = apps.map(a => f.db.prepare('SELECT * FROM applications WHERE id=?').get(a.id));
  for (const a of after) {
    const s = JSON.parse(a.measure_source);
    assert.deepEqual(s.viewHint, { front: 'sol', source: 'kullanici' });
    // The left garment is the front in every record.
    const front = s.views.find(g => g.view === 'on');
    assert.ok(front.productBoxPx.x < s.views.find(g => g.view === 'arka').productBoxPx.x);
  }
  // The back print is now found and sized on the right garment (291 mm as in the decided mockup);
  // what still needs a look is named for itself, no longer the view.
  assert.ok(Math.abs(after[1].width_mm - 291) <= 3, String(after[1].width_mm));
  assert.equal(JSON.parse(after[1].measure_source).selectedView, 'arka');
  assert.ok(open().every(c => !/görünüm ayrılamadı|Ön\/arka kanıtı/.test(c.message)), JSON.stringify(open()));
  assert.ok(f.db.prepare("SELECT 1 FROM audit_log WHERE action='gorunum_teyit'").get());
});

test('G58 the answer is validated; without onUrun the confirmation closes as before', async t => {
  const { f, v, open } = await undecided(t);
  const [first, second] = open();
  assert.equal((await f.post(`/teyitler/${first.id}/coz`, { onUrun: 'orta' })).status, 400);
  assert.equal((await f.post('/teyitler/99999/coz', { onUrun: 'sol' })).status, 404);
  assert.equal(f.db.prepare('SELECT count(*) n FROM document_image_views').get().n, 0);
  const plain = ok(await f.post(`/teyitler/${second.id}/coz`, {}));
  assert.equal(plain.status, 'cozuldu');
  assert.equal((await f.post(`/teyitler/${second.id}/coz`, { onUrun: 'sol' })).status, 409);
  // A submitted version takes no answer.
  f.db.prepare("UPDATE order_versions SET status='onay_bekliyor' WHERE id=?").run(v);
  assert.ok([409, 400].includes((await f.post(`/teyitler/${first.id}/coz`, { onUrun: 'sol' })).status));
});
