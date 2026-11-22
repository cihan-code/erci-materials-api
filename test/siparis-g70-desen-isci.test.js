'use strict';
// G70: the redraw queue + worker. Invented pictures only; the worker's Codex call is a fake (no network, no CLI).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const documents = require('../agent/siparis/documents');
const isci = require('../agent/siparis/desenIsci');
const worker = require('../agent/siparis/tools/desen-isci');
const { setup } = require('./fixtures/siparis/belge-fixture');
const { mockup } = require('./fixtures/siparis/oto-mockup');

const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.data)); return r.data; };
const KEY = crypto.randomBytes(24).toString('hex'); // generated per run, never a real secret
const ENVS = ['DESEN_CIZIM', 'DESEN_CIZIM_SAGLAYICI', 'DESEN_ISCI_ANAHTARI', 'DESEN_ISCI_KUCUK_PX', 'DESEN_ISCI_ZAYIF_PUAN'];
function useEnv(t, values) {
  const before = Object.fromEntries(ENVS.map(k => [k, process.env[k]]));
  for (const k of ENVS) delete process.env[k];
  Object.assign(process.env, values);
  t.after(() => { for (const k of ENVS) { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k]; } });
}
// KUCUK_PX=1: the invented crops are small; G71 (second attempt) has its own tests, here a fidelity-passing drawing is final.
const ISCI = { DESEN_CIZIM: '1', DESEN_CIZIM_SAGLAYICI: 'isci', DESEN_ISCI_ANAHTARI: KEY, DESEN_ISCI_KUCUK_PX: '1', DESEN_ISCI_ZAYIF_PUAN: '0.0001' };
async function fixture(t) {
  const f = await setup();
  t.after(async () => { await documents.settled(); await f.close(); fs.rmSync(f.dir, { recursive: true, force: true }); });
  const root = path.join(fs.realpathSync(f.dir), 'siparis', 'flats'); fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'tisort.png'); fs.writeFileSync(file, mockup({ missing: true }).image);
  f.db.prepare('INSERT INTO document_flats(id,ad,urun,gorunum,dosya,refLengthCm,refLengthPx,refBeden,olculerL) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('tisorton', 'Sentetik tisort', 'tisort', 'on', file, 60, 300, 'L', JSON.stringify({ omuzdan_boy: 112.2, etek: 60 }));
  const o = await f.order(), v = o.version.id, line = o.version.lines[0].id;
  ok(await f.upload(v, { kind: 'urun_gorsel', lineId: line, gorunum: 'on', buffer: mockup().image }), 201);
  const app = ok(await f.post(`/satirlar/${line}/uygulamalar`, { kind: 'baski', position: 'gogus' }), 201);
  f.v = v; f.appId = app.id; f.orderId = o.id;
  f.prepare = (again) => f.post(`/surumler/${v}/hazirla${again ? '?yeniden=1' : ''}`);
  f.report = () => f.db.prepare('SELECT report_json FROM document_extracted_previews WHERE application_id=?').get(f.appId);
  f.W = (url, opt = {}) => f.request(`/desen-isci${url}`, { token: KEY, ...opt });
  return f;
}
// A clean redraw of a stored crop: the same drawing flat on white, twice the size (what the model is asked for).
async function cleanOf(file) {
  const img = await loadImage(fs.readFileSync(file)), c = createCanvas(img.width * 2, img.height * 2), x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, img.width / 2, img.height / 2, img.width, img.height); // centred, with a clean margin like a real redraw
  return c.toBuffer('image/png');
}
const crop = f => f.db.prepare('SELECT kirpim_yol FROM desen_isci_konum').get().kirpim_yol;

test('G70 provider off: nothing is queued, the order answer says kapali', async t => {
  useEnv(t, {});
  const f = await fixture(t);
  ok(await f.prepare());
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM desen_isci_is').get().n, 0);
  const o = ok(await f.request(`/siparisler/${f.orderId}`, { token: f.token }));
  assert.equal(o.versions[0].lines[0].applications[0].desenCizim, 'kapali');
  assert.equal(JSON.parse(f.report().report_json).desenYolu, undefined);
});

test('G70 worker routes: no key configured 503, wrong or missing key 401, right key 200', async t => {
  useEnv(t, {});
  const f = await fixture(t);
  assert.equal((await f.W('/is')).status, 503);
  useEnv(t, { DESEN_ISCI_ANAHTARI: 'kisa' });
  assert.equal((await f.W('/is')).status, 503); // a short key never opens
  useEnv(t, ISCI);
  assert.equal((await f.request('/desen-isci/is')).status, 401);
  assert.equal((await f.request('/desen-isci/is', { token: 'x'.repeat(40) })).status, 401);
  assert.equal((await f.request('/desen-isci/is', { token: f.token })).status, 401); // a person's session does not open them
  assert.deepEqual(ok(await f.W('/is')).sayilar, {});
});

test('G70 a missing drawing queues ONE job per picture; the old path runs meanwhile and nobody waits', async t => {
  useEnv(t, ISCI);
  const f = await fixture(t);
  ok(await f.prepare());
  ok(await f.prepare(true));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM desen_isci_is').get().n, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM desen_isci_konum').get().n, 1);
  const r = JSON.parse(f.report().report_json);
  assert.equal(r.desenYolu, 'dogrudan-izleme');
  assert.equal(r.desenCizim.durum, 'bekliyor');
  assert.ok(!(r.reasons || []).some(x => /Yeniden çizim kullanılmadı/.test(x)), 'waiting is not a failure');
  const o = ok(await f.request(`/siparisler/${f.orderId}`, { token: f.token }));
  assert.equal(o.versions[0].lines[0].applications[0].desenCizim, 'bekliyor');
  assert.equal(ok(await f.W('/is')).bekleyen.length, 1);
});

test('G70 a lease expires: the job returns to the queue, the old lease is dead, tries are counted', async t => {
  useEnv(t, ISCI);
  const f = await fixture(t);
  ok(await f.prepare());
  const a = ok(await f.W('/al', { method: 'POST', body: {} })).is;
  assert.deepEqual([a.deneme, a.kip, a.konumlar], [1, 'tam', ['gogus']]);
  assert.equal(ok(await f.W('/al', { method: 'POST', body: {} })).is, null); // leased: nobody else gets it
  assert.equal((await f.W(`/is/${a.id}/gorsel?kiralama=yanlis`)).status, 409);
  const img = await f.W(`/is/${a.id}/gorsel?kiralama=${a.kiralama}`);
  assert.equal(img.status, 200);
  assert.ok(Buffer.isBuffer(img.data) && img.data.length > 100);
  f.db.prepare('UPDATE desen_isci_is SET kiralama_bitis=1 WHERE id=?').run(a.id); // the worker died long ago
  const b = ok(await f.W('/al', { method: 'POST', body: {} })).is;
  assert.deepEqual([b.id, b.deneme], [a.id, 2]);
  assert.notEqual(b.kiralama, a.kiralama);
  assert.equal((await f.W(`/is/${a.id}/sonuc`, { method: 'POST', body: { kiralama: a.kiralama, sonuclar: [] } })).status, 409);
});

test('G70 three failed tries: the job is given up, the print stays on the old path with a manual-check note', async t => {
  useEnv(t, ISCI);
  const f = await fixture(t);
  ok(await f.prepare());
  for (let i = 1; i <= 3; i++) {
    const j = ok(await f.W('/al', { method: 'POST', body: {} })).is;
    assert.equal(j.deneme, i);
    const r = ok(await f.W(`/is/${j.id}/hata`, { method: 'POST', body: { kiralama: j.kiralama, mesaj: 'codex hatası' } }));
    assert.equal(r.durum, i < 3 ? 'bekliyor' : 'vazgecildi');
  }
  assert.equal(ok(await f.W('/al', { method: 'POST', body: {} })).is, null);
  assert.equal(f.db.prepare('SELECT durum FROM desen_isci_is').get().durum, 'vazgecildi');
  ok(await f.prepare(true));
  const r = JSON.parse(f.report().report_json);
  assert.equal(r.desenYolu, 'dogrudan-izleme');
  assert.match(r.desenCizim.neden, /vazgecildi/);
  assert.ok(r.reasons.some(x => /elle kontrol/.test(x)));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM desen_isci_is').get().n, 1); // no new job
  const o = ok(await f.request(`/siparisler/${f.orderId}`, { token: f.token }));
  assert.equal(o.versions[0].lines[0].applications[0].desenCizim, 'reddedildi');
});

test('G70 an uploaded drawing passes the fidelity check, is cached and the preview is rebuilt from it', async t => {
  useEnv(t, ISCI);
  const f = await fixture(t);
  ok(await f.prepare());
  const before = f.db.prepare('SELECT preview_file_id FROM document_extracted_previews WHERE application_id=?').get(f.appId);
  assert.ok(before);
  const j = ok(await f.W('/al', { method: 'POST', body: {} })).is;
  const png = await cleanOf(crop(f));
  const up = ok(await f.W(`/is/${j.id}/sonuc`, { method: 'POST', body: { kiralama: j.kiralama, sonuclar: [{ konum: 'gogus', png: png.toString('base64') }] } }));
  assert.deepEqual(up.sonuc, { gogus: 'hazir' }, JSON.stringify(f.db.prepare('SELECT durum,tam_puan,neden FROM desen_isci_konum').all()));
  assert.equal(f.db.prepare('SELECT durum FROM desen_isci_is').get().durum, 'hazir');
  assert.equal(fs.readdirSync(isci.cacheDir(fs.realpathSync(f.dir))).length, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM document_extracted_previews WHERE application_id=?').get(f.appId).n, 0); // old preview dropped
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM files WHERE id=?').get(before.preview_file_id).n, 0);
  ok(await f.prepare(true));
  const r = JSON.parse(f.report().report_json);
  assert.equal(r.desenYolu, 'yeniden-cizim', JSON.stringify(r.desenCizim));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM desen_isci_is').get().n, 1);
  const o = ok(await f.request(`/siparisler/${f.orderId}`, { token: f.token }));
  assert.equal(o.versions[0].lines[0].applications[0].desenCizim, 'hazir');
});

test('G70 an upload that does not look like the source is refused: job reddedildi, nothing cached, manual-check note', async t => {
  useEnv(t, ISCI);
  const f = await fixture(t);
  ok(await f.prepare());
  const j = ok(await f.W('/al', { method: 'POST', body: {} })).is;
  const c = createCanvas(600, 600), x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 600, 600); x.fillStyle = '#000'; x.fillRect(10, 10, 40, 500); // a thin black bar: another drawing
  const up = ok(await f.W(`/is/${j.id}/sonuc`, { method: 'POST', body: { kiralama: j.kiralama, sonuclar: [{ konum: 'gogus', png: c.toBuffer('image/png').toString('base64') }] } }));
  assert.deepEqual(up.sonuc, { gogus: 'ikinci' }); // G71: a failed whole-picture drawing gets a cut-out attempt first
  const j2 = ok(await f.W('/al', { method: 'POST', body: {} })).is;
  assert.equal(j2.kip, 'kirpik');
  const up2 = ok(await f.W(`/is/${j2.id}/sonuc`, { method: 'POST', body: { kiralama: j2.kiralama, sonuclar: [{ konum: 'gogus', png: c.toBuffer('image/png').toString('base64') }] } }));
  assert.deepEqual(up2.sonuc, { gogus: 'reddedildi' });
  const row = f.db.prepare('SELECT durum,neden FROM desen_isci_konum').get();
  assert.equal(row.durum, 'reddedildi');
  assert.match(row.neden, /kaynağa benzemiyor/);
  assert.equal(f.db.prepare('SELECT durum FROM desen_isci_is').get().durum, 'reddedildi');
  assert.equal(fs.existsSync(isci.cacheDir(fs.realpathSync(f.dir))), false);
  ok(await f.prepare(true));
  const r = JSON.parse(f.report().report_json);
  assert.equal(r.desenYolu, 'dogrudan-izleme');
  assert.ok(r.reasons.some(x => /Yeniden çizim kullanılmadı/.test(x)));
  // A print the worker did not return at all is refused the same way.
  assert.equal(JSON.stringify(ok(await f.W('/is')).sayilar), '{"reddedildi":1}');
});

test('G70 worker: claims, draws with the fake Codex, uploads; daily cap, limit and --kuru never claim', async t => {
  useEnv(t, ISCI);
  const f = await fixture(t);
  ok(await f.prepare());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g70-')); t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const stateFile = path.join(tmp, 'durum.json');
  const prompts = [];
  const draw = async req => { prompts.push(req); const crop0 = await cleanOf(crop(f)); return new Map(req.outputs.map(n => [n, crop0])); };
  const env = { SIPARIS_API: f.base, DESEN_ISCI_ANAHTARI: KEY };
  const lim = ok_ => () => ({ ok: ok_, besSaat: 90, hafta: 10 });
  // --kuru: reads the queue, claims nothing, draws nothing.
  assert.deepEqual(await worker.run({ kuru: true, env, deps: { envFile: {}, stateFile, limit: lim(true) } }), { kuru: true, bekleyen: 1, bugun: 0, limitOk: true });
  assert.equal(f.db.prepare("SELECT durum FROM desen_isci_is").get().durum, 'bekliyor');
  // Codex window full: waits (returns in --bir-kez), nothing claimed.
  assert.equal((await worker.run({ birKez: true, env, deps: { envFile: {}, stateFile, limit: lim(false) } })).durum, 'limit');
  assert.equal(f.db.prepare("SELECT durum FROM desen_isci_is").get().durum, 'bekliyor');
  // Daily cap reached.
  fs.writeFileSync(stateFile, JSON.stringify({ gun: new Date().toISOString().slice(0, 10), sayi: 2 }));
  assert.equal((await worker.run({ birKez: true, env: { ...env, DESEN_ISCI_GUNLUK: '2' }, deps: { envFile: {}, stateFile, limit: lim(true) } })).durum, 'gunluk-sinir');
  assert.equal(prompts.length, 0);
  // Normal run.
  fs.rmSync(stateFile);
  assert.equal((await worker.run({ birKez: true, env, deps: { envFile: {}, stateFile, limit: lim(true), draw } })).durum, 'tamam');
  assert.equal(prompts.length, 1);
  assert.deepEqual(prompts[0].files.map(x => x.name), ['product']); // only the picture goes out
  assert.deepEqual(prompts[0].outputs, ['gogus']);
  assert.ok(!/MRC-|Örnek Kulüp/.test(prompts[0].prompt));
  assert.equal(f.db.prepare('SELECT durum FROM desen_isci_is').get().durum, 'hazir');
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).sayi, 1);
  // Queue empty.
  assert.equal((await worker.run({ birKez: true, env, deps: { envFile: {}, stateFile, limit: lim(true), draw } })).durum, 'yok');
  // A Codex error is reported to the server (the job goes back), the worker does not crash.
  ok(await f.prepare(true));
  f.db.prepare("UPDATE desen_isci_is SET durum='bekliyor' WHERE id=1").run();
  const res = await worker.run({ birKez: true, env, deps: { envFile: {}, stateFile, limit: lim(true), draw: async () => { throw new Error('codex düştü'); } } });
  assert.equal(res.durum, 'hata');
  assert.match(f.db.prepare('SELECT hata FROM desen_isci_is WHERE id=1').get().hata, /codex düştü/);
});

test('G70 worker: wrong key stops it (fatal), missing config is a clear error, limit script is parsed', async t => {
  useEnv(t, ISCI);
  const f = await fixture(t);
  await assert.rejects(worker.run({ birKez: true, env: { SIPARIS_API: f.base, DESEN_ISCI_ANAHTARI: 'y'.repeat(30) }, deps: { envFile: {}, limit: () => ({ ok: true }), stateFile: path.join(os.tmpdir(), 'g70-x.json') } }), /kabul etmedi \(401\)/);
  await assert.rejects(worker.run({ birKez: true, env: {}, deps: { envFile: {} } }), /SIPARIS_API ve DESEN_ISCI_ANAHTARI gerekli/);
  const script = path.join(os.tmpdir(), 'limitler-sahte.py'); fs.writeFileSync(script, ''); t.after(() => fs.rmSync(script, { force: true }));
  const run = out => () => ({ stdout: JSON.stringify(out) });
  assert.equal(worker.limitCheck({ script, run: run({ codex: { bes_saat: { yuzde: 79 }, hafta: { yuzde: 89 } } }) }).ok, true);
  assert.equal(worker.limitCheck({ script, run: run({ codex: { bes_saat: { yuzde: 80 }, hafta: { yuzde: 10 } } }) }).ok, false);
  assert.equal(worker.limitCheck({ script, run: run({ codex: { bes_saat: { yuzde: 5 }, hafta: { yuzde: 90 } } }) }).ok, false);
  assert.equal(worker.limitCheck({ script, run: run({ codex: { bes_saat: { yuzde: 99, sifirlandi: true }, hafta: { yuzde: 10 } } }) }).ok, true); // window reset
  assert.equal(worker.limitCheck({ script: '/yok/yok.py' }).bilinmiyor, true); // no script: only the daily cap
});

test('G70 key file must be private (mode 600) and is parsed', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g70-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'desen-isci.env');
  fs.writeFileSync(file, '# yorum\nSIPARIS_API="https://ornek.invalid/api/siparis"\nDESEN_ISCI_ANAHTARI=abc\n', { mode: 0o644 });
  assert.throws(() => worker.readEnvFile(file), /chmod 600/);
  fs.chmodSync(file, 0o600);
  assert.deepEqual(worker.readEnvFile(file), { SIPARIS_API: 'https://ornek.invalid/api/siparis', DESEN_ISCI_ANAHTARI: 'abc' });
  assert.deepEqual(worker.readEnvFile(path.join(dir, 'yok.env')), {});
});
