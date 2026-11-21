'use strict';
// G61 C: a print without a design or a size no longer stops the forms; only its own PDF and
// print card wait. Such a package never goes to the workshop by itself. Plus the one-call
// "accept the suggestion" answer of the panel contract. Invented data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pdfParse = require('pdf-parse');
const documents = require('../agent/siparis/documents');
const orders = require('../agent/siparis/orders');
const { setup } = require('./fixtures/siparis/belge-fixture');
const { mockup } = require('./fixtures/siparis/oto-mockup');

const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.data)); return r.data; };
async function fixture(t) {
  const f = await setup();
  t.after(async () => { await documents.settled(); await f.close(); fs.rmSync(f.dir, { recursive: true, force: true }); });
  const root = path.join(fs.realpathSync(f.dir), 'siparis', 'flats'); fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'tisort.png'); fs.writeFileSync(file, mockup({ missing: true }).image);
  f.db.prepare('INSERT INTO document_flats(id,ad,urun,gorunum,dosya,refLengthCm,refLengthPx,refBeden,olculerL) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('tisorton', 'Sentetik tisort', 'tisort', 'on', file, 60, 300, 'L', JSON.stringify({ omuzdan_boy: 112.2, etek: 60 }));
  return f;
}
const download = async (f, file) => Buffer.from(ok(await f.request(`/dosyalar/${file.id}`, { token: f.token })));
// Vector quality is judged elsewhere (G14-4); these tests settle it to reach approval.
async function settleQuality(f) {
  for (const c of f.db.prepare("SELECT id FROM confirmations WHERE kind='vektor_kalite' AND status='acik'").all()) ok(await f.post(`/teyitler/${c.id}/coz`));
}
const text = async (f, files, kind) => (await pdfParse(await download(f, files.find(x => x.kind === kind)))).text.replace(/\s+/g, ' ');

test('G61 a print waiting for its design leaves the forms and the other prints going; its package waits for a person', async t => {
  const f = await fixture(t), o = await f.order(), v = o.version.id, line = o.version.lines[0].id, m = mockup();
  ok(await f.upload(v, { kind: 'urun_gorsel', lineId: line, gorunum: 'on', buffer: m.image }), 201);
  // The design belongs to the chest print only.
  const chest = ok(await f.post(`/satirlar/${line}/uygulamalar`, { kind: 'baski', position: 'gogus' }), 201);
  ok(await f.upload(v, { lineId: line, applicationId: chest.id, buffer: m.design }), 201);
  assert.equal(f.db.prepare('SELECT needs_confirmation FROM applications WHERE id=?').get(chest.id).needs_confirmation, 0);
  // A back print with a workshop size but no back picture and no design: its design cannot be separated.
  const back = orders.addApplication(f.db, line, { kind: 'baski', position: 'sirt', width_mm: 280, height_mm: 230, measure_source: JSON.stringify({ method: 'elle', kaynak: 'atölye' }) }, f.team);
  const files = ok(await f.post(`/surumler/${v}/hazirla`));
  for (const kind of ['onay_formu', 'uretim_formu', 'baski_formu']) assert.ok(files.some(x => x.kind === kind), kind);
  const vectors = files.filter(x => x.kind === 'desen_vektor');
  assert.equal(vectors.length, 1);
  assert.equal(f.db.prepare('SELECT application_id FROM document_file_meta WHERE file_id=?').get(vectors[0].id).application_id, chest.id);
  assert.match(await text(f, files, 'onay_formu'), /Desen dosyası bekleniyor/);
  const workshop = await text(f, files, 'baski_formu');
  assert.match(workshop, /Sırt baskı uygulaması için desen dosyası bekleniyor; forma alınmadı/);
  // Approval is not blocked by the missing design, but the workshop jobs are parked for a person.
  await settleQuality(f);
  ok(await f.post(`/surumler/${v}/gonder`));
  ok(await f.post(`/surumler/${v}/onay`, { fileId: files.find(x => x.kind === 'onay_formu').id }, f.managerToken));
  const jobs = f.db.prepare("SELECT status,payload_json FROM outbox WHERE version_id=? AND kind='atolye_dosya'").all(v);
  assert.ok(jobs.length >= 2);
  assert.ok(jobs.every(j => j.status === 'manuel_bekliyor'), JSON.stringify(jobs.map(j => j.status)));
  assert.deepEqual(JSON.parse(jobs[0].payload_json).eksikBaskilar, [back.id]);
  assert.ok(f.db.prepare("SELECT 1 FROM audit_log WHERE action='atolye_paketi_eksik'").get());
});

test('G61 a complete package keeps the normal queue state', async t => {
  const f = await fixture(t), o = await f.order(), v = o.version.id, line = o.version.lines[0].id, m = mockup();
  ok(await f.upload(v, { kind: 'urun_gorsel', lineId: line, gorunum: 'on', buffer: m.image }), 201);
  const design = ok(await f.upload(v, { lineId: line, buffer: m.design }), 201);
  ok(await f.post(`/satirlar/${line}/uygulamalar`, { kind: 'baski', position: 'gogus', desenDosyaId: design.id }), 201);
  const files = ok(await f.post(`/surumler/${v}/hazirla`));
  await settleQuality(f);
  ok(await f.post(`/surumler/${v}/gonder`));
  ok(await f.post(`/surumler/${v}/onay`, { fileId: files.find(x => x.kind === 'onay_formu').id }, f.managerToken));
  const jobs = f.db.prepare("SELECT status,payload_json FROM outbox WHERE version_id=? AND kind='atolye_dosya'").all(v);
  assert.ok(jobs.every(j => j.status === 'bekliyor' && !JSON.parse(j.payload_json).eksikBaskilar), JSON.stringify(jobs));
});

test('G61 oneriOnay writes the suggestion as the size in one call; the list shows oneri and onArkaSorusu', async t => {
  const f = await fixture(t), o = await f.order(), line = o.version.lines[0].id;
  const app = orders.addApplication(f.db, line, { kind: 'baski', position: 'sirt', measure_source: JSON.stringify({ method: 'otomatik', oneri: { width_mm: 290, height_mm: 120 },
    selectedPage: 1, views: [{ page: 1, view: 'teyit' }, { page: 1, view: 'teyit' }] }), needs_confirmation: true }, f.team);
  const id = f.db.prepare("INSERT INTO confirmations(kind,ref_table,ref_id,message) VALUES('olcu','applications',?,'Konumda baskı belirsiz')").run(app.id).lastInsertRowid;
  const list = ok(await f.request('/teyitler', { token: f.token })).find(c => c.id === id);
  assert.deepEqual([list.oneri, list.onArkaSorusu], [{ width_mm: 290, height_mm: 120 }, true]);
  assert.equal((await f.post(`/teyitler/${id}/coz`, { oneriOnay: 'evet' })).status, 400);
  const answer = ok(await f.post(`/teyitler/${id}/coz`, { oneriOnay: true }));
  assert.equal(answer.teyit.status, 'cozuldu');
  const saved = f.db.prepare('SELECT * FROM applications WHERE id=?').get(app.id), s = JSON.parse(saved.measure_source);
  assert.deepEqual([saved.width_mm, saved.height_mm, saved.needs_confirmation, s.method, s.kaynak], [290, 120, 0, 'elle', 'sistem önerisi (kullanıcı onayı)']);
  assert.equal((await f.post(`/teyitler/${id}/coz`, { oneriOnay: true })).status, 409);
  // Without a suggestion there is nothing to accept.
  const bare = orders.addApplication(f.db, line, { kind: 'baski', position: 'gogus', measure_source: '{}', needs_confirmation: true }, f.team);
  const other = f.db.prepare("INSERT INTO confirmations(kind,ref_table,ref_id,message) VALUES('olcu','applications',?,'x')").run(bare.id).lastInsertRowid;
  assert.equal((await f.post(`/teyitler/${other}/coz`, { oneriOnay: true })).status, 409);
  assert.equal(ok(await f.request('/teyitler', { token: f.token })).find(c => c.id === other).oneri, null);
});
