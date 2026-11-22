'use strict';
// G74: design source order, a preview for every print, the vector gate and the very high resolution PNG, the choice rule.
// Invented pictures and orders only; the image model is a fake (no network, no CLI).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PNG } = require('pngjs');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { PDFDocument, PDFName } = require('pdf-lib');
const documents = require('../agent/siparis/documents');
const orders = require('../agent/siparis/orders');
const isci = require('../agent/siparis/desenIsci');
const dc = require('../agent/siparis/desenCizim');
const cikti = require('../agent/siparis/desenCikti');
const { vectorize } = require('../agent/siparis/vector');
const { extractArtwork, gozCutAgrees } = require('../agent/siparis/autoMeasure');
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
const ISCI = { DESEN_CIZIM: '1', DESEN_CIZIM_SAGLAYICI: 'isci', DESEN_ISCI_ANAHTARI: KEY, DESEN_ISCI_ZAYIF_PUAN: '0.0001' };
async function pdfText(buffer) {
  const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await lib.getDocument({ data: Uint8Array.from(buffer), isEvalSupported: false, verbosity: 0 }).promise;
  try {
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) pages.push((await (await doc.getPage(i)).getTextContent()).items.map(x => x.str).join(' '));
    return pages.join('\n');
  } finally { await doc.destroy(); }
}
// An order on the invented garment picture (mockup: the print sits at x 240..360, y 265..332 of 600 x 650).
// apps: [{position, measure}] -> measured by hand or by the eye's box on the picture.
async function fixture(t, apps) {
  const f = await setup();
  t.after(async () => { await documents.settled(); await f.close(); fs.rmSync(f.dir, { recursive: true, force: true }); });
  const o = await f.order(), v = o.version.id, line = o.version.lines[0].id;
  const img = ok(await f.upload(v, { kind: 'urun_gorsel', lineId: line, gorunum: 'on', buffer: mockup().image }), 201);
  f.apps = {};
  for (const a of apps) {
    const ms = { method: a.method || 'elle', ...(a.method ? {} : { kaynak: 'atölye' }), gorselFileId: img.id, goz: { boxPx: a.box || { x: 232, y: 258, w: 136, h: 82 }, rasterWidth: 600, rasterHeight: 650, confidence: 'yuksek' } };
    f.apps[a.position] = orders.addApplication(f.db, line, { kind: 'baski', position: a.position, width_mm: a.w || 90, height_mm: a.h || 55, measure_source: JSON.stringify(ms) }, f.team).id;
  }
  Object.assign(f, { v, line, imgId: img.id });
  f.prepare = () => f.post(`/surumler/${v}/hazirla?yeniden=1`);
  f.files = () => f.db.prepare('SELECT f.*,m.application_id,m.mime FROM files f JOIN document_file_meta m ON m.file_id=f.id WHERE f.version_id=?').all(v);
  f.audit = () => JSON.parse(f.db.prepare("SELECT detail_json FROM audit_log WHERE action='belgeler_hazirla' ORDER BY id DESC LIMIT 1").get().detail_json);
  f.W = (url, opt = {}) => f.request(`/desen-isci${url}`, { token: KEY, ...opt });
  f.claim = async () => ok(await f.W('/al', { method: 'POST', body: {} })).is;
  f.upload1 = (j, konum, png) => f.W(`/is/${j.id}/sonuc`, { method: 'POST', body: { kiralama: j.kiralama, sonuclar: konum ? [{ konum, png: png.toString('base64') }] : [] } });
  return f;
}
// An invented two-ink mark on a transparent ground: a red ring and a blue bar (anti-aliased edges).
function mark({ w = 1600, h = 1000, bar = true, ring = true } = {}) {
  const c = createCanvas(w, h), x = c.getContext('2d');
  x.lineWidth = w / 40;
  if (ring) { x.strokeStyle = '#d0202a'; x.beginPath(); x.ellipse(w / 2, h / 2, w * 0.35, h * 0.38, 0, 0, Math.PI * 2); x.stroke(); }
  if (bar) { x.fillStyle = '#1f3fa0'; x.fillRect(w * 0.2, h * 0.45, w * 0.6, h * 0.1); }
  return c.toBuffer('image/png');
}
const vectorOf = async (buffer, targetMm) => (await vectorize({ buffer, mime: 'image/png', ...(targetMm ? { targetMm } : {}) })).pdf;

// ---- 1. source order ------------------------------------------------------------------------------------
test('G74 a print with its own design file is never asked of the model; the job key keeps every print', async t => {
  useEnv(t, { DESEN_CIZIM: '1', DESEN_CIZIM_SAGLAYICI: 'codex' }); // test provider, whole-picture mode
  const calls = [];
  dc.setTestProvider(async req => { calls.push(req); throw new Error('yok'); });
  t.after(() => dc.setTestProvider(null));
  const f = await fixture(t, [{ position: 'gogus' }, { position: 'sirt', w: 300, h: 200 }]);
  ok(await f.upload(f.v, { kind: 'desen_kaynak', lineId: f.line, applicationId: f.apps.sirt, buffer: mark() }), 201);
  await documents.settled();
  ok(await f.prepare());
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].outputs, ['gogus']); // the design file of the back print is its design: not redrawn, not invented
  const files = f.files();
  // The file is placed without the model: its vector and its high resolution picture are there, the form has its preview.
  assert.ok(files.some(x => x.kind === 'desen_vektor' && x.application_id === f.apps.sirt));
  assert.ok(files.some(x => x.kind === 'desen_png' && x.application_id === f.apps.sirt && x.mime === 'image/png'));
  assert.equal(f.audit().desenBekleyen, undefined);
  // The 30 x 20 cm box would stretch the design (ink 1160 x 800 px, 1.45:1) by 3.4%: the faithful trace is made again at its own ratio inside the box.
  const out = f.audit().desenCikti.find(o => o.applicationId === f.apps.sirt);
  assert.equal(out.cikti, 'vektor', JSON.stringify(out));
  assert.match(out.kapi.neden ?? '', /^$/);
  const vec = await PDFDocument.load(fs.readFileSync(files.find(x => x.kind === 'desen_vektor' && x.application_id === f.apps.sirt).path));
  const p = vec.getPage(0);
  assert.ok(Math.abs(p.getWidth() / p.getHeight() - 1.45) < 0.01 && p.getWidth() < 300 * 72 / 25.4 - 5, `${p.getWidth()} x ${p.getHeight()}`);
});

test('G74 worker queue: the design-file print stays out of the job, a late design file does not start a new job', async t => {
  useEnv(t, ISCI);
  const f = await fixture(t, [{ position: 'gogus' }, { position: 'sirt', w: 300, h: 200 }]);
  ok(await f.prepare());
  const first = f.db.prepare('SELECT * FROM desen_isci_is').all();
  assert.equal(first.length, 1);
  assert.deepEqual(JSON.parse(first[0].konumlar_json).sort(), ['gogus', 'sirt']);
  ok(await f.upload(f.v, { kind: 'desen_kaynak', lineId: f.line, applicationId: f.apps.sirt, buffer: mark() }), 201);
  await documents.settled();
  ok(await f.prepare());
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM desen_isci_is').get().n, 1); // same key: the drawings already made stay valid
  const f2 = await fixture(t, [{ position: 'gogus' }, { position: 'sirt', w: 300, h: 200 }]);
  ok(await f2.upload(f2.v, { kind: 'desen_kaynak', lineId: f2.line, applicationId: f2.apps.sirt, buffer: mark() }), 201);
  await documents.settled();
  ok(await f2.prepare());
  assert.deepEqual(JSON.parse(f2.db.prepare('SELECT konumlar_json FROM desen_isci_is').get().konumlar_json), ['gogus']);
});

// ---- 2. a preview for every print ------------------------------------------------------------------------
test('G74 eye-box cut: strokes past a narrow box are followed, the photo ground in a box corner is left out', async () => {
  // A white photo ground, a dark sleeve, a light stroke print that runs past the right edge of the eye's box.
  const c = createCanvas(600, 600), x = c.getContext('2d');
  x.fillStyle = '#ffffff'; x.fillRect(0, 0, 600, 600);
  x.fillStyle = '#5a1020'; x.beginPath(); x.moveTo(200, 50); x.lineTo(560, 50); x.lineTo(560, 550); x.lineTo(280, 550); x.closePath(); x.fill();
  x.strokeStyle = '#f0d0d8'; x.lineWidth = 5; x.beginPath(); x.moveTo(260, 300); x.lineTo(420, 300); x.stroke(); x.beginPath(); x.moveTo(300, 270); x.lineTo(300, 330); x.stroke();
  const image = { buffer: c.toBuffer('image/png'), mime: 'image/png', gorunum: 'on' };
  const eye = { x: 200, y: 250, w: 200, h: 100 }; // its top-left corner lies on the photo ground, its right edge cuts the stroke at 400
  const cut = await extractArtwork({ image, position: 'sag_kol', gozBox: { x: eye.x / 600, y: eye.y / 600, w: eye.w / 600, h: eye.h / 600 } });
  const box = cut.placement.designBoxPx;
  assert.ok(box.x >= 255 && box.x <= 262, JSON.stringify(box)); // starts at the stroke, not at the white corner (x 200)
  assert.ok(box.x + box.w >= 420, JSON.stringify(box)); // the stroke is followed to its end
  const png = PNG.sync.read(cut.buffer);
  for (let i = 3; i < png.data.length; i += 4) if (png.data[i]) assert.ok(!(png.data[i - 3] > 245 && png.data[i - 2] > 245 && png.data[i - 1] > 245), 'no photo ground in the design');
  assert.equal(gozCutAgrees(eye, box), true);
  assert.equal(gozCutAgrees(eye, { x: 400, y: 250, w: 60, h: 40 }), false); // the eye's centre is not in it: another print
  assert.equal(gozCutAgrees(eye, { x: 20, y: 240, w: 330, h: 100 }), false); // past the growth limit
});

test('G74 an eye-measured sleeve print whose cut differs from the eye box gets its vector and its preview (not "desen dosyası bekleniyor")', async t => {
  useEnv(t, {});
  // The eye's box is narrower than the print (x 260..340 of 240..360) and 30% taller: the old size check refused the cut.
  const f = await fixture(t, [{ position: 'sol_kol', method: 'otomatik', box: { x: 260, y: 255, w: 80, h: 87 }, w: 80, h: 45 }]);
  ok(await f.prepare());
  assert.equal(f.audit().desenBekleyen, undefined);
  const files = f.files();
  assert.ok(files.some(x => x.kind === 'desen_vektor' && x.application_id === f.apps.sol_kol));
  const form = files.find(x => x.kind === 'baski_formu');
  const text = await pdfText(fs.readFileSync(form.path));
  assert.doesNotMatch(text, /Desen dosyası bekleniyor|Önizleme yok/);
  // The 120 px cut is far below what a vector needs: the picture goes, and the form says so.
  assert.match(text, /yüksek çözünürlüklü görsel \(vektör değil\)/);
  const out = f.audit().desenCikti.find(o => o.applicationId === f.apps.sol_kol);
  assert.equal(out.cikti, 'png');
  assert.match(out.kapi.neden, /kaynak \d+ px/);
  assert.ok(out.png.dpi >= 600 && Math.max(out.png.genislik, out.png.yukseklik) >= 6000, JSON.stringify(out));
  const vec = files.find(x => x.kind === 'desen_vektor' && x.application_id === f.apps.sol_kol);
  const doc = await PDFDocument.load(fs.readFileSync(vec.path));
  assert.equal(doc.getTitle(), 'Desen (yüksek çözünürlüklü görsel, vektör değil)'); // the PDF that embeds the picture, not a broken vector
});

// ---- 3. vector gate and PNG ----------------------------------------------------------------------------
test('G74 vector gate: a faithful trace passes; a lost stroke, a stretched vector or a small source fails', async () => {
  const source = mark();
  const good = await cikti.vectorGate({ source, pdf: await vectorOf(source) });
  assert.equal(good.gecti, true, JSON.stringify(good));
  assert.ok(good.olcum.ortusme >= cikti.GATE.ortusme && good.olcum.ince >= cikti.GATE.ince);
  const lost = await cikti.vectorGate({ source, pdf: await vectorOf(mark({ bar: false })) });
  assert.equal(lost.gecti, false);
  assert.match(lost.neden, /örtüşme|parça|ince yapı/);
  const stretched = await cikti.vectorGate({ source, pdf: await vectorOf(source, { w: 200, h: 60 }) });
  assert.equal(stretched.gecti, false);
  assert.match(stretched.neden, /en\/boy oranı/);
  const small = mark({ w: 320, h: 200 });
  const tiny = await cikti.vectorGate({ source: small, pdf: await vectorOf(small) });
  assert.equal(tiny.gecti, false);
  assert.match(tiny.neden, /kaynak 320 px/);
});

test('G74 high resolution PNG: >= 600 dpi and >= 6000 px, transparent, only the design inks, embedded in a print-size PDF', async () => {
  const r = await cikti.highResPng({ source: mark({ w: 800, h: 500 }), widthMm: 100, heightMm: 70 });
  assert.ok(Math.max(r.width, r.height) >= 6000 && r.dpi >= 600, JSON.stringify(r));
  assert.equal(r.inks, 2);
  const png = PNG.sync.read(r.png);
  assert.equal(r.png[25], 3); // indexed colour
  const colours = new Set();
  for (let i = 0; i < png.data.length; i += 4) if (png.data[i + 3]) { assert.equal(png.data[i + 3], 255); colours.add(png.data.readUIntBE(i, 3)); }
  assert.equal(colours.size, 2); // every edge pixel is one ink or transparent: no blur, no blend colours
  assert.equal(png.data[3], 0); assert.equal(png.data[png.data.length - 1], 0); // transparent corners
  const doc = await PDFDocument.load(r.pdf), page = doc.getPage(0);
  assert.ok(Math.abs(page.getWidth() - 100 * 72 / 25.4) < 0.01 && Math.abs(page.getHeight() - 70 * 72 / 25.4) < 0.01);
  const xo = page.node.Resources().lookup(PDFName.of('XObject')), img = doc.context.lookup(xo.get(xo.keys()[0]));
  assert.equal(img.dict.get(PDFName.of('Width')).asNumber(), r.width);
  // A 47.5 cm back print: 600 dpi decides (above 6000 px).
  const back = cikti.pngSize(1600, 1100, 475, 329);
  assert.ok(back.W >= Math.ceil(475 / 25.4 * 600) && back.dpi >= 600, JSON.stringify(back));
  assert.deepEqual([cikti.pngSize(100, 200, 50, 50).H, cikti.pngSize(100, 200, 50, 50).dpi >= 600], [6000, true]);
  // Pixel budget (DESEN_PNG_MP): the back print at 40 MP stays within it, keeps 6000 px and says its lower dpi.
  const capped = cikti.pngSize(1600, 1100, 475, 329, { DESEN_PNG_MP: '40' });
  assert.ok(capped.W * capped.H <= 40e6 && Math.max(capped.W, capped.H) >= 6000 && capped.dpi < 600, JSON.stringify(capped));
  assert.deepEqual(cikti.pngSize(1600, 1100, 475, 329), back); // default 100 MP: 600 dpi
});

// ---- 4. choice rule ------------------------------------------------------------------------------------
test('G74 choice rule: a straightened whole-picture drawing beats a cut-out drawing that kept the tilt', () => {
  const turned = { donus: 55, ortusme: 0.94, duz: 0 }, kept = { donus: 0, ortusme: 0.9, duz: 0.9 };
  assert.equal(isci.pick(0.17, 0.8, { tamDonus: turned, kirpikDonus: kept }), 'tam'); // G72 left sleeve: the copy won on score
  assert.equal(isci.pick(0.17, 0.8, { tamDonus: { donus: 25, ortusme: 0.67, duz: 0.6 }, kirpikDonus: kept }), 'kirpik'); // a poor fit at an angle is no straightening
  assert.equal(isci.pick(0.5, 0.8, { tamDonus: turned, kirpikDonus: { donus: 50, ortusme: 0.9, duz: 0.2 } }), 'kirpik'); // both straightened: the score decides
  assert.equal(isci.pick(0.6, 0.58), 'kirpik'); // upright prints: G71 unchanged
});

async function tilted(file, deg, k = 3) { // the cut-out redrawn upright from a tilted print: the drawing turned by deg, larger, on white
  const img = await loadImage(fs.readFileSync(file)), s = Math.max(img.width, img.height) * k, c = createCanvas(s, s), x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, s, s); x.translate(s / 2, s / 2); x.rotate(deg * Math.PI / 180); x.scale(k * 0.8, k * 0.8); x.drawImage(img, -img.width / 2, -img.height / 2);
  return c.toBuffer('image/png');
}
async function enlarged(file, k = 2) {
  const img = await loadImage(fs.readFileSync(file)), c = createCanvas(img.width * k, img.height * k), x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, img.width * (k - 1) / 2, img.height * (k - 1) / 2, img.width, img.height);
  return c.toBuffer('image/png');
}
const konum = f => f.db.prepare('SELECT * FROM desen_isci_konum').get();

test('G74 a straightened drawing of a small tilted print is final: no cut-out attempt, the whole-picture drawing is chosen', async t => {
  useEnv(t, ISCI);
  const f = await fixture(t, [{ position: 'sol_kol' }]); // cut from the eye's box: about 120 x 68 px
  ok(await f.prepare());
  const j = await f.claim();
  const up = ok(await f.upload1(j, 'sol_kol', await tilted(konum(f).kirpim_yol, 40)));
  assert.deepEqual(up.sonuc, { sol_kol: 'hazir' }); // the small cut-out alone would have asked for a second drawing (G71)
  assert.equal(konum(f).secilen, 'tam');
});

test('G74 a missing whole-picture drawing gets the cut-out attempt; the report names the drawing chosen (kip)', async t => {
  useEnv(t, ISCI);
  const f = await fixture(t, [{ position: 'gogus' }]);
  ok(await f.prepare());
  const j = await f.claim();
  const up = ok(await f.upload1(j, null)); // the model left this print out
  assert.deepEqual(up.sonuc, { gogus: 'ikinci' });
  const j2 = await f.claim();
  assert.equal(j2.kip, 'kirpik');
  ok(await f.upload1(j2, 'gogus', await enlarged(konum(f).kirpim_yol, 3)));
  assert.equal(konum(f).secilen, 'kirpik');
  ok(await f.prepare());
  const rep = JSON.parse(f.db.prepare('SELECT report_json FROM document_extracted_previews WHERE application_id=?').get(f.apps.gogus).report_json);
  assert.equal(rep.desenYolu, 'yeniden-cizim');
  assert.equal(rep.desenCizim.kip, 'kirpik'); // was always "tam" for the worker
});

test('G74 a whole-picture drawing refused as a copy of the input also gets the cut-out attempt', async t => {
  useEnv(t, ISCI);
  const f = await fixture(t, [{ position: 'gogus' }]);
  ok(await f.prepare());
  const j = await f.claim();
  const up = ok(await f.upload1(j, 'gogus', fs.readFileSync(konum(f).kirpim_yol)));
  assert.deepEqual(up.sonuc, { gogus: 'ikinci' });
  assert.match(konum(f).neden, /kopyası|Zemin/);
});

// ---- G74b: review round ----------------------------------------------------------------------------------
function badge({ w = 800, h = 400, left = null } = {}) { // an invented opaque navy badge filling the picture, white lettering in the middle
  const c = createCanvas(w, h), x = c.getContext('2d');
  x.fillStyle = '#1a2a6c'; x.fillRect(0, 0, w, h);
  if (left) { x.fillStyle = left; x.fillRect(0, 0, w / 2, h); }
  x.fillStyle = '#ffffff'; x.font = `bold ${Math.round(h * 0.28)}px sans-serif`; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('MERC', w / 2, h / 2);
  return c.toBuffer('image/png');
}
const navyShare = png => { let n = 0, all = 0; for (let i = 0; i < png.data.length; i += 4) { all++; if (png.data[i + 3] && png.data[i + 2] > 80 && png.data[i] < 60) n++; } return n / all; };

test('G74b an opaque badge whose edge is its own colour keeps that colour as ink: navy in the PNG, 2:1, nothing enlarged', async () => {
  const r = await cikti.highResPng({ source: badge(), widthMm: 100, heightMm: 50 });
  assert.ok(Math.abs(r.width / r.height - 2) < 0.02, `${r.width} x ${r.height}`);
  assert.deepEqual(r.mm, { w: 100, h: 50 });
  const png = PNG.sync.read(r.png);
  assert.ok(navyShare(png) > 0.5, `lacivert pay ${navyShare(png)}`);
  // White paper around a design is still its ground (left out, transparent).
  const c = createCanvas(800, 400), x = c.getContext('2d'); x.fillStyle = '#ffffff'; x.fillRect(0, 0, 800, 400); x.fillStyle = '#1a2a6c'; x.beginPath(); x.arc(400, 200, 150, 0, 7); x.fill();
  const paper = PNG.sync.read((await cikti.highResPng({ source: c.toBuffer('image/png'), widthMm: 60, heightMm: 60 })).png);
  assert.equal(paper.data[3], 0);
  // An edge that is half white, half navy: the ground cannot be told. No picture is made; the caller asks a person.
  await assert.rejects(cikti.highResPng({ source: badge({ left: '#ffffff' }), widthMm: 100, heightMm: 50 }), e => e.code === 'ZEMIN_BELIRSIZ');
});

test('G74b a faithful one-colour full-bleed vector passes the gate (fine structure of two flat maps is equal, not 0)', async () => {
  const c = createCanvas(1600, 800), x = c.getContext('2d'); x.fillStyle = '#1a2a6c'; x.fillRect(0, 0, 1600, 800);
  const doc = await PDFDocument.create(), page = doc.addPage([800, 400]);
  page.drawRectangle({ x: 0, y: 0, width: 800, height: 400, color: require('pdf-lib').rgb(0x1a / 255, 0x2a / 255, 0x6c / 255) });
  const g = await cikti.vectorGate({ source: c.toBuffer('image/png'), pdf: Buffer.from(await doc.save()) });
  assert.equal(g.gecti, true, JSON.stringify(g));
  assert.equal(g.olcum.ince, 1);
});

test('G74b the gate draws the vector itself (no pdf.js): it works with the pdf.js renderer unavailable', async t => {
  const vector = require('../agent/siparis/vector'), keep = vector.renderFirstPage;
  vector.renderFirstPage = () => { throw new Error('pdf.js kullanılmamalı'); };
  t.after(() => { vector.renderFirstPage = keep; });
  const source = mark();
  const g = await cikti.vectorGate({ source, pdf: await vectorOf(source) });
  assert.equal(g.gecti, true, JSON.stringify(g));
  const badgeSrc = badge({ w: 1600, h: 800 });
  const doc = await PDFDocument.create(), page = doc.addPage([800, 400]); // an invented vector of the badge without its lettering
  page.drawRectangle({ x: 0, y: 0, width: 800, height: 400, color: require('pdf-lib').rgb(0x1a / 255, 0x2a / 255, 0x6c / 255) });
  const lost = await cikti.vectorGate({ source: badgeSrc, pdf: Buffer.from(await doc.save()) });
  assert.equal(lost.gecti, false); // the white lettering is missing
});

test('G74b children: a child over its memory budget is stopped (BELLEK_SINIRI); its own time limit has its own code', async () => {
  const src = { buffer: mark(), mime: 'image/png' };
  await assert.rejects(documents.generateInChild({ type: 'desenPng', input: { source: src, widthMm: 475, heightMm: 329 } }, undefined, { memoryMb: 1 }), e => e.code === 'BELLEK_SINIRI');
  await assert.rejects(documents.generateInChild({ type: 'desenPng', input: { source: src, widthMm: 475, heightMm: 329 } }, undefined, { timeoutMs: 30, timeoutCode: 'COCUK_ZAMAN_ASIMI' }), e => e.code === 'COCUK_ZAMAN_ASIMI');
});

test('G74b a too small memory budget never stops the preparation: the gate counts as failed, the picture falls back', async t => {
  useEnv(t, {});
  const before = process.env.DESEN_COCUK_MB; process.env.DESEN_COCUK_MB = '1';
  t.after(() => { if (before === undefined) delete process.env.DESEN_COCUK_MB; else process.env.DESEN_COCUK_MB = before; });
  const f = await fixture(t, [{ position: 'sol_kol', method: 'otomatik', box: { x: 260, y: 255, w: 80, h: 87 }, w: 80, h: 45 }]);
  ok(await f.prepare());
  const out = f.audit().desenCikti.find(o => o.applicationId === f.apps.sol_kol);
  assert.equal(out.kapi.gecti, false);
  assert.ok(f.files().some(x => x.kind === 'desen_vektor' && x.application_id === f.apps.sol_kol));
});

test('G74b a cut from the eye box that differs from it by more than 12% rescales the size (≈ on the forms), once', async t => {
  useEnv(t, {});
  // Eye box 80 x 87 px, the print 120 x 68 px: 80 x 45 mm becomes about 120 x 35 mm (per axis: no tilted sleeve axis here).
  const f = await fixture(t, [{ position: 'sol_kol', method: 'otomatik', box: { x: 260, y: 255, w: 80, h: 87 }, w: 80, h: 45 }]);
  ok(await f.prepare());
  const app = () => f.db.prepare('SELECT width_mm,height_mm,measure_source FROM applications WHERE id=?').get(f.apps.sol_kol);
  const a1 = app(), ms = JSON.parse(a1.measure_source);
  assert.ok(a1.width_mm >= 114 && a1.width_mm <= 126 && a1.height_mm >= 32 && a1.height_mm <= 38, JSON.stringify(a1));
  assert.equal(ms.olcuDurumu, 'yaklasik');
  assert.match(ms.olcuNotu, /desen kesiti/);
  const text = await pdfText(fs.readFileSync(f.files().find(x => x.kind === 'baski_formu').path));
  assert.match(text, /≈/);
  ok(await f.prepare());
  assert.deepEqual([app().width_mm, app().height_mm], [a1.width_mm, a1.height_mm]); // not scaled twice
  ok(await f.request(`/surumler/${f.v}/onizleme`, { method: 'POST', token: f.token })); // fresh: the forms do not ask to be made again
});

test('G74b a prepared draft is not re-extracted in the background; a preview stored under an older key is still shown', async t => {
  useEnv(t, {});
  const f = await fixture(t, [{ position: 'sol_kol', method: 'otomatik', box: { x: 232, y: 258, w: 136, h: 82 }, w: 90, h: 55 }]);
  ok(await f.prepare());
  f.db.prepare("UPDATE document_extracted_previews SET input_json='eski-anahtar'").run(); // as after an extraction revision change
  const confirmations = () => f.db.prepare("SELECT COUNT(*) n FROM confirmations WHERE kind='vektor_kalite' AND status='acik'").get().n;
  const open = confirmations();
  ok(await f.request(`/surumler/${f.v}/vektor-durum`, { token: f.token }));
  await documents.settled();
  assert.deepEqual(f.db.prepare('SELECT input_json FROM document_extracted_previews').all().map(r => r.input_json), ['eski-anahtar']);
  assert.equal(confirmations(), open);
  const pv = ok(await f.request(`/surumler/${f.v}/onizleme`, { method: 'POST', token: f.token }));
  const text = await pdfText(Buffer.from(pv.formlar.find(x => x.kind === 'baski_formu').pdf, 'base64'));
  assert.doesNotMatch(text, /Önizleme yok/);
});
