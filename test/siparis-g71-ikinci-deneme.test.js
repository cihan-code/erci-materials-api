'use strict';
// G71: second (cut-out) attempt of a redraw job, sleeve prints through the eye's box, and the rule that picks between the two drawings.
// Invented pictures only; the worker's Codex call is a fake.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const documents = require('../agent/siparis/documents');
const isci = require('../agent/siparis/desenIsci');
const desenCizim = require('../agent/siparis/desenCizim');
const worker = require('../agent/siparis/tools/desen-isci');
const orders = require('../agent/siparis/orders');
const { setup } = require('./fixtures/siparis/belge-fixture');
const { mockup } = require('./fixtures/siparis/oto-mockup');

const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.data)); return r.data; };
const KEY = crypto.randomBytes(24).toString('hex');
const ENVS = ['DESEN_CIZIM', 'DESEN_CIZIM_SAGLAYICI', 'DESEN_ISCI_ANAHTARI', 'DESEN_ISCI_KUCUK_PX', 'DESEN_ISCI_ZAYIF_PUAN'];
function useEnv(t, values) {
  const before = Object.fromEntries(ENVS.map(k => [k, process.env[k]]));
  for (const k of ENVS) delete process.env[k];
  Object.assign(process.env, values);
  t.after(() => { for (const k of ENVS) { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k]; } });
}
// Defaults of the rule (small crop under 150 px = second attempt); the mock crop is about 120 x 68 px.
const ISCI = { DESEN_CIZIM: '1', DESEN_CIZIM_SAGLAYICI: 'isci', DESEN_ISCI_ANAHTARI: KEY, DESEN_ISCI_ZAYIF_PUAN: '0.0001' };
async function fixture(t, { position = 'gogus' } = {}) {
  const f = await setup();
  t.after(async () => { await documents.settled(); await f.close(); fs.rmSync(f.dir, { recursive: true, force: true }); });
  const root = path.join(fs.realpathSync(f.dir), 'siparis', 'flats'); fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'tisort.png'); fs.writeFileSync(file, mockup({ missing: true }).image);
  f.db.prepare('INSERT INTO document_flats(id,ad,urun,gorunum,dosya,refLengthCm,refLengthPx,refBeden,olculerL) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('tisorton', 'Sentetik tisort', 'tisort', 'on', file, 60, 300, 'L', JSON.stringify({ omuzdan_boy: 112.2, etek: 60 }));
  const o = await f.order(), v = o.version.id, line = o.version.lines[0].id;
  const img = ok(await f.upload(v, { kind: 'urun_gorsel', lineId: line, gorunum: 'on', buffer: mockup().image }), 201);
  let app;
  if (position === 'gogus') app = ok(await f.post(`/satirlar/${line}/uygulamalar`, { kind: 'baski', position }), 201);
  else { // a sleeve print: measured by hand, with the eye's cut-out box on the picture (the box the real eye gives for sleeves)
    const ms = { method: 'elle', kaynak: 'atölye', gorselFileId: img.id, goz: { boxPx: { x: 232, y: 258, w: 136, h: 82 }, rasterWidth: 600, rasterHeight: 650, confidence: 'yuksek' } };
    app = orders.addApplication(f.db, line, { kind: 'baski', position, width_mm: 90, height_mm: 55, measure_source: JSON.stringify(ms) }, f.team);
  }
  Object.assign(f, { v, appId: app.id, orderId: o.id });
  f.prepare = again => f.post(`/surumler/${v}/hazirla${again ? '?yeniden=1' : ''}`);
  f.report = () => JSON.parse(f.db.prepare('SELECT report_json FROM document_extracted_previews WHERE application_id=?').get(f.appId).report_json);
  f.W = (url, opt = {}) => f.request(`/desen-isci${url}`, { token: KEY, ...opt });
  f.claim = async () => ok(await f.W('/al', { method: 'POST', body: {} })).is;
  f.upload1 = (j, konum, png) => f.W(`/is/${j.id}/sonuc`, { method: 'POST', body: { kiralama: j.kiralama, sonuclar: [{ konum, png: png.toString('base64') }] } });
  return f;
}
async function cleanOf(file, k = 2) {
  const img = await loadImage(fs.readFileSync(file)), c = createCanvas(img.width * k, img.height * k), x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, img.width * (k - 1) / 2, img.height * (k - 1) / 2, img.width, img.height);
  return c.toBuffer('image/png');
}
const cropFile = f => f.db.prepare('SELECT kirpim_yol FROM desen_isci_konum').get().kirpim_yol;
const cacheFiles = f => { const d = isci.cacheDir(fs.realpathSync(f.dir)); return fs.existsSync(d) ? fs.readdirSync(d) : []; };
const konum = f => f.db.prepare('SELECT * FROM desen_isci_konum').get();
const job = f => f.db.prepare('SELECT * FROM desen_isci_is').get();

test('G71 the choice rule: higher score wins, the cut-out drawing wins a near tie, nothing usable gives null', () => {
  assert.equal(isci.pick(0.60, 0.61), 'kirpik');
  assert.equal(isci.pick(0.60, 0.56), 'kirpik'); // within 0.05 of the whole-picture score: the cut-out one cannot invent beyond its source
  assert.equal(isci.pick(0.60, 0.54), 'tam');
  assert.equal(isci.pick(0.90, 0.20), 'tam');
  assert.equal(isci.pick(null, 0.10), 'kirpik'); // the whole-picture drawing was refused
  assert.equal(isci.pick(0.40, null), 'tam'); // the cut-out drawing was refused or missing
  assert.equal(isci.pick(null, null), null);
});

test('G71 fidelity gives a 0..1 score that falls as the drawing drifts', async () => {
  const mark = (ratio = 1) => { const c = createCanvas(300 * ratio, 200), x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.strokeStyle = '#123'; x.lineWidth = 8; x.beginPath(); x.ellipse(c.width / 2, 100, c.width * 0.3, 70, 0, 0, Math.PI * 2); x.stroke(); x.fillStyle = '#123'; x.fillRect(c.width * 0.25, 96, c.width * 0.5, 8); return c.toBuffer('image/png'); };
  const scaled = await desenCizim.fidelity(mark(), await (async () => { const i = await loadImage(mark()), c = createCanvas(i.width * 2, i.height * 2), x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(i, c.width * 0.1, c.height * 0.1, c.width * 0.8, c.height * 0.8); return c.toBuffer('image/png'); })());
  assert.ok(scaled.ok && scaled.metrics.puan > 0.8, JSON.stringify(scaled));
  const stretched = await desenCizim.fidelity(mark(), mark(2.2));
  assert.ok(!stretched.metrics.puan || stretched.metrics.puan < scaled.metrics.puan, JSON.stringify(stretched));
});

test('G71 a small cut-out gets a second, cut-out attempt in the same job; the near-tie goes to the cut-out drawing', async t => {
  useEnv(t, ISCI);
  const f = await fixture(t);
  ok(await f.prepare());
  const j = await f.claim();
  assert.deepEqual([j.kip, j.konumlar], ['tam', ['gogus']]);
  const tam = await cleanOf(cropFile(f), 2);
  const up = ok(await f.upload1(j, 'gogus', tam));
  assert.deepEqual(up.sonuc, { gogus: 'ikinci' });
  assert.deepEqual(up.ikinciDeneme, ['gogus']);
  assert.equal(cacheFiles(f).length, 0); // nothing final yet; the old path still serves the print
  assert.deepEqual([job(f).durum, job(f).asama, job(f).deneme, konum(f).durum], ['bekliyor', 'kirpik', 0, 'ikinci']);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM desen_isci_is').get().n, 1); // same job
  // Second stage: only the weak print, its cut-out can be downloaded, only with the live lease.
  const j2 = await f.claim();
  assert.deepEqual([j2.id, j2.kip, j2.konumlar], [j.id, 'kirpik', ['gogus']]);
  assert.equal((await f.W(`/is/${j2.id}/kirpim/gogus?kiralama=yanlis`)).status, 409);
  const cut = await f.W(`/is/${j2.id}/kirpim/gogus?kiralama=${j2.kiralama}`);
  assert.equal(cut.status, 200); assert.ok(cut.data.length > 50);
  assert.equal((await f.W(`/is/${j2.id}/kirpim/yok?kiralama=${j2.kiralama}`)).status, 404);
  const kirpik = await cleanOf(cropFile(f), 3);
  const up2 = ok(await f.upload1(j2, 'gogus', kirpik));
  assert.deepEqual(up2.sonuc, { gogus: 'hazir' });
  const row = konum(f);
  assert.equal(row.secilen, 'kirpik');
  assert.ok(row.tam_puan !== null && row.kirpik_puan !== null);
  assert.deepEqual(cacheFiles(f).length, 1);
  assert.equal(job(f).durum, 'hazir');
  ok(await f.prepare(true));
  assert.equal(f.report().desenYolu, 'yeniden-cizim');
});

test('G71 a clearly better whole-picture drawing is kept over the cut-out one', async t => {
  useEnv(t, ISCI);
  const f = await fixture(t);
  ok(await f.prepare());
  const tam = await cleanOf(cropFile(f), 2);
  ok(await f.upload1(await f.claim(), 'gogus', tam));
  f.db.prepare('UPDATE desen_isci_konum SET tam_puan=0.95').run(); // the whole-picture drawing scored very well
  const j2 = await f.claim();
  const up = ok(await f.upload1(j2, 'gogus', await cleanOf(cropFile(f), 3)));
  assert.deepEqual(up.sonuc, { gogus: 'hazir' });
  assert.equal(konum(f).secilen, 'tam');
  const cached = path.join(isci.cacheDir(fs.realpathSync(f.dir)), cacheFiles(f)[0]);
  assert.deepEqual(fs.readFileSync(cached), tam); // the stored whole-picture drawing, byte for byte
});

test('G71 a weak score alone (large cut-out) also triggers the second attempt; a good one does not', async t => {
  useEnv(t, { ...ISCI, DESEN_ISCI_KUCUK_PX: '1', DESEN_ISCI_ZAYIF_PUAN: '0.9' });
  const f = await fixture(t);
  ok(await f.prepare());
  const up = ok(await f.upload1(await f.claim(), 'gogus', await cleanOf(cropFile(f), 2)));
  assert.deepEqual(up.sonuc, { gogus: 'ikinci' }); // this crop scores far below 0.9
  useEnv(t, { ...ISCI, DESEN_ISCI_KUCUK_PX: '1', DESEN_ISCI_ZAYIF_PUAN: '0.0001' });
  const g = await fixture(t);
  ok(await g.prepare());
  assert.deepEqual(ok(await g.upload1(await g.claim(), 'gogus', await cleanOf(cropFile(g), 2))).sonuc, { gogus: 'hazir' });
  assert.equal(konum(g).secilen, 'tam');
});

test('G71 when the second attempt keeps failing the whole-picture drawing is used; without a usable one the print falls back', async t => {
  useEnv(t, ISCI);
  const f = await fixture(t);
  ok(await f.prepare());
  ok(await f.upload1(await f.claim(), 'gogus', await cleanOf(cropFile(f), 2)));
  for (let i = 1; i <= 3; i++) {
    const j = await f.claim();
    assert.deepEqual([j.kip, j.deneme], ['kirpik', i]);
    const r = ok(await f.W(`/is/${j.id}/hata`, { method: 'POST', body: { kiralama: j.kiralama, mesaj: 'codex düştü' } }));
    assert.equal(r.durum, i < 3 ? 'bekliyor' : 'hazir');
  }
  assert.deepEqual([konum(f).durum, konum(f).secilen, job(f).durum], ['hazir', 'tam', 'hazir']);
  assert.equal(cacheFiles(f).length, 1);
  ok(await f.prepare(true));
  assert.equal(f.report().desenYolu, 'yeniden-cizim');
  // No usable whole-picture drawing (refused in stage 1) and the cut-out attempt refused too: back to the old path.
  const h = await fixture(t);
  ok(await h.prepare());
  const bad = createCanvas(300, 300), bx = bad.getContext('2d'); bx.fillStyle = '#fff'; bx.fillRect(0, 0, 300, 300); bx.fillStyle = '#000'; bx.fillRect(5, 5, 30, 280);
  ok(await h.upload1(await h.claim(), 'gogus', bad.toBuffer('image/png')));
  assert.equal(konum(h).tam_puan, null);
  ok(await h.upload1(await h.claim(), 'gogus', bad.toBuffer('image/png')));
  assert.deepEqual([konum(h).durum, job(h).durum], ['reddedildi', 'reddedildi']);
  ok(await h.prepare(true));
  assert.equal(h.report().desenYolu, 'dogrudan-izleme');
  assert.match(h.report().desenCizim.neden, /reddedildi/);
});

test('G71 worker second stage: one Codex call per weak print from its cut-out only; a failed print is left to the server', async t => {
  useEnv(t, ISCI);
  const f = await fixture(t);
  ok(await f.prepare());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g71-')); t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const calls = [];
  const clean = await cleanOf(cropFile(f), 2);
  const draw = async rq => { calls.push(rq); return new Map(rq.outputs.map(n => [n, clean])); };
  const wenv = { SIPARIS_API: f.base, DESEN_ISCI_ANAHTARI: KEY };
  const deps = { envFile: {}, stateFile: path.join(tmp, 'd.json'), limit: () => ({ ok: true }), draw };
  assert.equal((await worker.run({ birKez: true, env: wenv, deps })).durum, 'tamam'); // stage 1: whole picture
  assert.deepEqual(calls[0].files.map(x => x.name), ['product']);
  assert.equal((await worker.run({ birKez: true, env: wenv, deps })).durum, 'tamam'); // stage 2: cut-out
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].files.map(x => x.name), ['print']);
  assert.equal(calls[1].prompt, desenCizim.promptCrop());
  assert.deepEqual(calls[1].outputs, ['print']);
  assert.equal(job(f).durum, 'hazir');
  assert.equal(konum(f).secilen, 'kirpik');
  assert.equal((await worker.run({ birKez: true, env: wenv, deps })).durum, 'yok');
  // Stage 2 where every draw fails: the job goes back to the queue (tries counted), the worker does not crash.
  const g = await fixture(t);
  ok(await g.prepare());
  const wenv2 = { SIPARIS_API: g.base, DESEN_ISCI_ANAHTARI: KEY };
  const deps2 = { ...deps, stateFile: path.join(tmp, 'd2.json') };
  await worker.run({ birKez: true, env: wenv2, deps: { ...deps2, draw: async () => new Map([['gogus', await cleanOf(cropFile(g), 2)]]) } });
  const r = await worker.run({ birKez: true, env: wenv2, deps: { ...deps2, draw: async () => { throw new Error('codex düştü'); } } });
  assert.equal(r.durum, 'hata');
  assert.deepEqual([job(g).durum, job(g).asama, job(g).deneme], ['bekliyor', 'kirpik', 1]);
});

test('G71 a sleeve print cut out through the eye\'s box is queued like any other print', async t => {
  useEnv(t, ISCI);
  const f = await fixture(t, { position: 'sag_kol' });
  ok(await f.prepare());
  const rows = f.db.prepare('SELECT konum,application_id,kirpim_yol FROM desen_isci_konum').all();
  assert.deepEqual(rows.map(r => [r.konum, r.application_id]), [['sag_kol', f.appId]]);
  assert.ok(fs.existsSync(rows[0].kirpim_yol), 'the cut-out is stored for the fidelity check and the second attempt');
  assert.equal(JSON.parse(f.db.prepare('SELECT konumlar_json FROM desen_isci_is').get().konumlar_json)[0], 'sag_kol');
  assert.equal(f.report().desenCizim.durum, 'bekliyor');
  // And it goes through the whole path: drawing, check, cache, preview rebuilt.
  const up = ok(await f.upload1(await f.claim(), 'sag_kol', await cleanOf(rows[0].kirpim_yol, 2)));
  assert.equal(up.sonuc.sag_kol, 'ikinci'); // small cut-out: second attempt
  ok(await f.upload1(await f.claim(), 'sag_kol', await cleanOf(rows[0].kirpim_yol, 3)));
  ok(await f.prepare(true));
  assert.equal(f.report().desenYolu, 'yeniden-cizim');
});
