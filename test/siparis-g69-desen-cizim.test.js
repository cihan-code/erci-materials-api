'use strict';
// G69: redrawing a print before tracing. A fake provider stands for the image model (no network, no CLI).
// Invented artwork only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const dc = require('../agent/siparis/desenCizim');
const documents = require('../agent/siparis/documents');
const { setup } = require('./fixtures/siparis/belge-fixture');
const { mockup } = require('./fixtures/siparis/oto-mockup');

const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.data)); return r.data; };
const ENV = { DESEN_CIZIM: '1' };
// An invented ring-and-bar mark. `ground`/`ink` colours, `tilt` skews it, `bold` thickens the lines.
function mark({ w = 300, h = 200, ground = '#7a1e3a', ink = '#ffffff', ratio = 1, bold = 6, shape = 'ring', noise = 0 } = {}) {
  const c = createCanvas(Math.round(w * ratio), h), x = c.getContext('2d');
  x.fillStyle = ground; x.fillRect(0, 0, c.width, c.height);
  if (noise) for (let i = 0; i < noise; i++) { x.fillStyle = `rgba(0,0,0,${Math.random() * 0.08})`; x.fillRect(Math.random() * c.width, Math.random() * c.height, 3, 3); }
  x.strokeStyle = ink; x.fillStyle = ink; x.lineWidth = bold;
  const cx = c.width / 2, cy = h / 2;
  if (shape === 'ring') {
    x.beginPath(); x.ellipse(cx, cy, c.width * 0.3, h * 0.35, 0, 0, Math.PI * 2); x.stroke();
    x.fillRect(cx - c.width * 0.25, cy - 3, c.width * 0.5, 6);
  } else { // a different drawing of the same size: a solid block in one corner and a thin diagonal
    x.fillRect(c.width * 0.05, h * 0.05, c.width * 0.25, h * 0.4);
    x.beginPath(); x.moveTo(c.width * 0.95, h * 0.1); x.lineTo(c.width * 0.45, h * 0.95); x.stroke();
  }
  return c.toBuffer('image/png');
}
const sizeOf = async b => { const i = await loadImage(b); return [i.width, i.height]; };
const png = c => c.toBuffer('image/png');
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'g69-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
function fake(t, fn) {
  const calls = [];
  dc.setTestProvider(async req => { calls.push(req); return fn(req); });
  t.after(() => dc.setTestProvider(null));
  return calls;
}

test('G69 off by default: no provider, no key tag, no call', async t => {
  const calls = fake(t, () => { throw new Error('çağrılmamalı'); });
  assert.equal(dc.provider({}), null);
  assert.equal(dc.keyTag({}), null);
  assert.equal(dc.enabled({}), false);
  const r = await dc.apply({ crop: mark(), position: 'sirt', env: {} });
  assert.deepEqual([r.used, r.off], [false, true]);
  assert.equal(calls.length, 0);
  assert.equal(dc.mode({ DESEN_CIZIM_KIP: 'tam' }), 'kirpik'); // openai: one image per request
  assert.equal(dc.mode({ DESEN_CIZIM_SAGLAYICI: 'codex' }), 'tam');
  dc.setTestProvider(null);
  assert.equal(dc.provider(ENV), null); // flag on but no key: still the old path
  assert.equal(dc.provider({ ...ENV, OPENAI_API_KEY: 'x' }), 'openai');
  assert.equal(dc.provider({ ...ENV, DESEN_CIZIM_SAGLAYICI: 'codex', NODE_ENV: 'production' }), null); // Codex CLI never in production
  assert.equal(dc.provider({ ...ENV, DESEN_CIZIM_SAGLAYICI: 'kayit' }), null);
});

test('G69 fidelity: same drawing on another ground passes; other shape, ratio or colour fail', async () => {
  const src = mark({ noise: 400 });
  const same = await dc.fidelity(src, mark({ ground: '#000000', bold: 9 }));
  assert.equal(same.ok, true, JSON.stringify(same));
  const shape = await dc.fidelity(src, mark({ ground: '#000000', shape: 'blocks' }));
  assert.ok(!shape.ok && shape.reasons.some(r => /Biçim/.test(r)), JSON.stringify(shape));
  const ratio = await dc.fidelity(src, mark({ ratio: 3 }));
  assert.ok(!ratio.ok, JSON.stringify(ratio)); // stretched: ratio and/or shape refuse it
  const colour = await dc.fidelity(mark({ bold: 16 }), mark({ ground: '#ffffff', ink: '#206030', bold: 16 }));
  assert.ok(!colour.ok && colour.reasons.some(r => /renk/i.test(r)), JSON.stringify(colour));
  const dark = mark({ ground: '#000000' }), copy = await dc.fidelity(dark, dark);
  assert.ok(!copy.ok && /kopyası/.test(copy.reasons[0]), JSON.stringify(copy)); // handed back untouched
  const fabric = await dc.fidelity(src, mark()); // a redraw that still has the garment colour as its ground
  assert.ok(!fabric.ok && /Zemin/.test(fabric.reasons[0]), JSON.stringify(fabric));
  const empty = await dc.fidelity(src, png(Object.assign(createCanvas(100, 100), {})));
  assert.equal(empty.ok, false);
});

test('G69 crop mode: redraw is enlarged to >= 2000 px, checked, and cached by bytes (no second call)', async t => {
  const calls = fake(t, () => new Map([['print', mark({ ground: '#000000', w: 700, h: 466 })]]));
  const dir = tmp(t), crop = mark({ noise: 300 });
  const a = await dc.apply({ crop, position: 'sirt', cacheDir: dir, env: ENV });
  assert.equal(a.used, true, JSON.stringify(a.report));
  assert.equal(a.report.yol, 'yeniden-cizim');
  assert.ok(Math.max(...await sizeOf(a.buffer)) >= 2000);
  assert.equal(a.report.buyutuldu, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt, /Do NOT change, correct, translate/);
  assert.deepEqual(calls[0].files.map(f => f.name), ['print']); // only the print leaves the server
  const b = await dc.apply({ crop, position: 'sirt', cacheDir: dir, env: ENV });
  assert.equal(b.used, true);
  assert.equal(b.report.onbellek, true);
  assert.equal(calls.length, 1);
});

test('G69 a failing provider, a timeout or a dissimilar redraw never throws: old path + reason', async t => {
  const logs = [], log = m => logs.push(m);
  let behaviour = 'hata';
  fake(t, () => { if (behaviour === 'hata') throw new Error('zaman aşımı'); return new Map([['print', mark({ shape: 'blocks', ground: '#000000' })]]); });
  const crop = mark();
  const r1 = await dc.apply({ crop, position: 'sirt', env: ENV, log });
  assert.deepEqual([r1.used, r1.report.yol, r1.report.elleKontrol], [false, 'dogrudan-izleme', true]);
  assert.match(r1.report.neden, /zaman aşımı/);
  behaviour = 'benzemiyor';
  const r2 = await dc.apply({ crop, position: 'sirt', env: ENV, log });
  assert.equal(r2.used, false);
  assert.match(r2.report.neden, /kaynağa benzemiyor/);
  assert.equal(logs.length, 2);
  // An empty answer (no file produced) is also only a fallback.
  behaviour = 'bos'; dc.setTestProvider(async () => new Map());
  assert.match((await dc.apply({ crop, position: 'sirt', env: ENV, log })).report.neden, /Çıktı yok/);
});

test('G69 whole-picture mode: one request for every print; a print that did not come back falls to the old path', async t => {
  const calls = fake(t, req => new Map(req.outputs.filter(n => n !== 'sag_kol').map(n => [n, mark({ ground: '#000000', w: 640, h: 430 })])));
  const dir = tmp(t), env = { ...ENV, DESEN_CIZIM_SAGLAYICI: 'codex', DESEN_CIZIM_KIP: 'tam' }, image = mockup().image;
  const prints = [{ position: 'sirt' }, { position: 'sol_gogus' }, { position: 'sag_kol' }];
  const crop = mark();
  const [a, b, c] = await Promise.all(prints.map(p => dc.apply({ crop, image, position: p.position, prints, cacheDir: dir, env })));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].files.map(f => f.name), ['product']);
  assert.deepEqual(calls[0].outputs, ['sag_kol', 'sirt', 'sol_gogus']);
  assert.match(calls[0].prompt, /sirt\.png: the print at "sirt"/);
  assert.deepEqual([a.used, b.used, c.used], [true, true, false]);
  assert.match(c.report.neden, /sag_kol/);
  assert.equal(c.report.yol, 'dogrudan-izleme');
});

test('G69 openai provider posts the image to the edit endpoint and reads the b64 answer', async t => {
  const out = mark({ ground: '#000000', w: 700, h: 466 });
  let seen;
  const srv = http.createServer((req, res) => {
    const chunks = []; req.on('data', d => chunks.push(d)); req.on('end', () => {
      seen = { url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString('latin1') };
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ b64_json: out.toString('base64') }] }));
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); t.after(() => srv.close());
  const env = { ...ENV, OPENAI_API_KEY: 'sahte-anahtar', OPENAI_BASE_URL: `http://127.0.0.1:${srv.address().port}` };
  const r = await dc.apply({ crop: mark(), position: 'sirt', env });
  assert.equal(r.used, true, JSON.stringify(r.report));
  assert.equal(seen.url, '/v1/images/edits');
  assert.equal(seen.auth, 'Bearer sahte-anahtar');
  assert.match(seen.body, /name="model"\r\n\r\ngpt-image-1/);
  assert.match(seen.body, /name="image\[\]"; filename="print\.png"/);
  assert.equal(r.report.saglayici, 'openai');
});

test('G69 replay folder provider (kayit) serves a stored drawing', async t => {
  const dir = tmp(t); fs.writeFileSync(path.join(dir, 'print.png'), mark({ ground: '#000000', w: 700, h: 466 }));
  const r = await dc.apply({ crop: mark(), position: 'sirt', env: { ...ENV, DESEN_CIZIM_SAGLAYICI: 'kayit', DESEN_CIZIM_KAYIT_DIZIN: dir } });
  assert.equal(r.used, true, JSON.stringify(r.report));
});

test('G69 in the document flow: flag off keeps the old path; flag on records the way and prints the footnote', async t => {
  const f = await setup();
  t.after(async () => { await documents.settled(); await f.close(); fs.rmSync(f.dir, { recursive: true, force: true }); });
  const root = path.join(fs.realpathSync(f.dir), 'siparis', 'flats'); fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'tisort.png'); fs.writeFileSync(file, mockup({ missing: true }).image);
  f.db.prepare('INSERT INTO document_flats(id,ad,urun,gorunum,dosya,refLengthCm,refLengthPx,refBeden,olculerL) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('tisorton', 'Sentetik tisort', 'tisort', 'on', file, 60, 300, 'L', JSON.stringify({ omuzdan_boy: 112.2, etek: 60 }));
  const o = await f.order(), v = o.version.id, line = o.version.lines[0].id;
  ok(await f.upload(v, { kind: 'urun_gorsel', lineId: line, gorunum: 'on', buffer: mockup().image }), 201);
  ok(await f.post(`/satirlar/${line}/uygulamalar`, { kind: 'baski', position: 'gogus' }), 201);
  const reports = () => f.db.prepare('SELECT report_json FROM document_extracted_previews').all().map(r => JSON.parse(r.report_json || 'null')).filter(Boolean);
  ok(await f.post(`/surumler/${v}/hazirla`));
  assert.ok(reports().length && reports().every(r => r.desenYolu === undefined)); // off: nothing new in the record
  // On, with a provider that returns a clean redraw of the extracted print.
  const before = process.env.DESEN_CIZIM; process.env.DESEN_CIZIM = '1'; process.env.DESEN_CIZIM_KIP = 'kirpik';
  t.after(() => { delete process.env.DESEN_CIZIM_KIP; if (before === undefined) delete process.env.DESEN_CIZIM; else process.env.DESEN_CIZIM = before; });
  let calls = 0;
  dc.setTestProvider(async req => { calls++; const src = await loadImage(req.files[0].buffer), c = createCanvas(src.width * 2, src.height * 2), x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(src, 0, 0, c.width, c.height); return new Map([['print', png(c)]]); });
  t.after(() => dc.setTestProvider(null));
  ok(await f.post(`/surumler/${v}/hazirla?yeniden=1`));
  assert.ok(calls >= 1, 'provider was called');
  assert.ok(reports().some(r => r.desenYolu === 'yeniden-cizim' || r.desenYolu === 'dogrudan-izleme'), JSON.stringify(reports().map(r => r.desenYolu)));
});
