'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { PDFDocument, rgb, degrees, PDFName } = require('pdf-lib');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { vectorize, compareDirectory } = require('../agent/siparis/vector');
const { createWorkshopHandler, buildWorkshopMessage } = require('../agent/siparis/workshop');
const { createMemoryStore, createTestAdapter } = require('../agent/siparis/workshop/test');

function png({ thin = false, width = 120, height = 60 } = {}) {
  const canvas = createCanvas(width, height), ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white'; ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#d02030'; ctx.fillRect(10, 10, width - 20, thin ? 1 : height - 20);
  if (!thin && height >= 40) {
    ctx.fillStyle = '#2040d0'; ctx.beginPath(); ctx.arc(width/2, height/2, 8, 0, Math.PI*2); ctx.fill();
  }
  return canvas.toBuffer('image/png');
}

async function vectorPdf({ thin = false, text = false, pages = 1, form = false, rotate = false } = {}) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([200, 100]);
    if (rotate) page.setRotation(degrees(90));
    if (thin) page.drawLine({ start: { x: 10, y: 10 }, end: { x: 190, y: 10 }, thickness: 0.1 });
    else page.drawRectangle({ x: 10, y: 10, width: 180, height: 80, color: rgb(1, 0, 0) });
    if (text) page.drawText('Ornek Kulup MRC-T001', { x: 15, y: 40, size: 8 });
  }
  if (form) {
    const textField = doc.getForm().createTextField('uydurma-form');
    textField.setText('MRC-T001');
    textField.addToPage(doc.getPage(0), { x: 20, y: 20, width: 90, height: 15 });
  }
  return Buffer.from(await doc.save());
}

const files = [ { kind: 'desen', name: 'ornek-desen.pdf', mime: 'application/pdf', buffer: Buffer.from('fixture') },
  { kind: 'atolye', name: 'ornek-atolye.pdf', mime: 'application/pdf', buffer: Buffer.from('fixture') } ];
function job(extra = {}) {
  return { idempotency_key: 'atolye:V-T001', payload_json: { order: { order_no: 'MRC-T001', version_no: 2,
    lines: [{ product: 'Forma', color: 'Kirmizi', quantity: 12 }] }, files, groupId: 'fake-group' }, ...extra };
}

test('PNG -> actual paths without any image objects, target is full 280x120 mm page', async () => {
  const result = await vectorize({ buffer: png(), mime: 'image/png', targetMm: { w: 280, h: 120 } });
  assert.equal(result.kind, 'raster'); assert.ok(Buffer.isBuffer(result.pdf));
  assert.ok(result.report.pathCount >= 1); assert.ok(result.report.colorCount >= 2);
  assert.equal(result.report.pages[0].imageCount, 0);
  assert.equal(result.report.aspectRatioPreserved, true);
  const doc = await PDFDocument.load(result.pdf);
  assert.ok(!doc.context.enumerateIndirectObjects().some(([, value]) => value.dict?.get(PDFName.of('Subtype'))?.toString() === '/Image'));
  assert.ok(Math.abs(doc.getPage(0).getWidth() * 25.4 / 72 - 280) <= 0.5);
  assert.ok(Math.abs(doc.getPage(0).getHeight() * 25.4 / 72 - 120) <= 0.5);
});

test('JPEG locally traces to paths', async () => {
  const image = await loadImage(png()); const canvas = createCanvas(image.width, image.height);
  canvas.getContext('2d').drawImage(image, 0, 0);
  const result = await vectorize({ buffer: canvas.toBuffer('image/jpeg'), mime: 'image/jpeg' });
  assert.equal(result.kind, 'raster'); assert.ok(result.report.pathCount > 0);
  assert.equal(result.report.pages[0].imageCount, 0);
});

test('vector PDF keeps original bytes without target; resize keeps paths and no images', async () => {
  const original = await vectorPdf();
  const unchanged = await vectorize({ buffer: original, mime: 'application/pdf' });
  assert.equal(unchanged.kind, 'vector'); assert.deepEqual(unchanged.pdf, original);
  const resized = await vectorize({ buffer: original, mime: 'application/pdf', targetMm: { w: 280, h: 120 } });
  assert.equal(resized.report.pathCount, unchanged.report.pathCount);
  assert.equal(resized.report.pages[0].imageCount, 0);
  assert.ok(Math.abs(resized.report.pages[0].widthMm - 280) < 0.5);
});

test('image-only PDF page composition traces locally, retains source physical page size', async () => {
  const doc = await PDFDocument.create(); const page = doc.addPage([200, 100]);
  page.drawImage(await doc.embedPng(png()), { x: 0, y: 0, width: 200, height: 100 });
  const result = await vectorize({ buffer: Buffer.from(await doc.save()), mime: 'application/pdf' });
  assert.equal(result.kind, 'raster'); assert.ok(result.report.pathCount > 0);
  assert.equal(result.report.pages[0].imageCount, 0);
  assert.ok(Math.abs(result.report.pages[0].widthMm - 200 * 25.4 / 72) < 0.01);
  assert.match(result.report.rasterPdfMethod, /144 dpi/);
  const output = await PDFDocument.load(result.pdf);
  assert.ok(!output.context.enumerateIndirectObjects().some(([, value]) => value.dict?.get(PDFName.of('Subtype'))?.toString() === '/Image'));
});

test('mixed PDF preserves vectors/text and image, flags retained raster', async () => {
  const doc = await PDFDocument.load(await vectorPdf({ text: true }));
  doc.getPage(0).drawImage(await doc.embedPng(png()), { x: 0, y: 0, width: 10, height: 5 });
  const result = await vectorize({ buffer: Buffer.from(await doc.save()), mime: 'application/pdf' });
  assert.equal(result.kind, 'vector'); assert.ok(result.report.pathCount > 0);
  assert.ok(result.report.pages[0].imageCount > 0); assert.ok(result.report.pages[0].textCount > 0);
  assert.ok(result.report.reasons.includes('karma_sayfada_raster_korundu'));
});

test('thin lines, text, unknown fill detail and suspicious ratio request confirmation', async () => {
  const line = await vectorize({ buffer: await vectorPdf({ thin: true }), mime: 'application/pdf' });
  assert.ok(line.report.minLineWidth < 0.2); assert.ok(line.report.colorCount >= 1);
  assert.equal(line.report.quality, 'teyit'); assert.ok(line.report.reasons.includes('ince_cizgi'));
  const text = await vectorize({ buffer: await vectorPdf({ text: true }), mime: 'application/pdf' });
  assert.equal(text.report.quality, 'teyit'); assert.ok(text.report.reasons.includes('metin'));
  const ratio = await vectorize({ buffer: png({ width: 600, height: 20 }), mime: 'image/png' });
  assert.ok(ratio.report.reasons.includes('supheli_oran'));
  const rasterThin = await vectorize({ buffer: png({ thin: true }), mime: 'image/png' });
  assert.ok(rasterThin.report.minLineWidth < 0.3);
});

test('multipage vector, rotated page and AcroForm survive physical fit', async () => {
  const original = await vectorPdf({ pages: 2, form: true });
  const result = await vectorize({ buffer: original, mime: 'application/pdf', targetMm: { w: 280, h: 120 } });
  const doc = await PDFDocument.load(result.pdf);
  assert.equal(doc.getPageCount(), 2); assert.equal(doc.getForm().getTextField('uydurma-form').getText(), 'MRC-T001');
  assert.ok(result.report.pathCount >= 2); assert.equal(result.report.pages[0].imageCount, 0);
  const rotated = await vectorize({ buffer: await vectorPdf({ rotate: true }), mime: 'application/pdf', targetMm: { w: 280, h: 120 } });
  assert.ok(Math.abs(rotated.report.pages[0].widthMm - 280) < 0.5);
  assert.ok(Math.abs(rotated.report.pages[0].heightMm - 120) < 0.5);
});

test('more than 2000 painted paths require confirmation; ordinary thick stroke can be iyi', async () => {
  const doc = await PDFDocument.create(); const page = doc.addPage([300, 300]);
  for (let i = 0; i < 2001; i++) page.drawLine({ start: { x: i%200, y: Math.floor(i/200) },
    end: { x: i%200+1, y: Math.floor(i/200)+1 }, thickness: 2 });
  const result = await vectorize({ buffer: Buffer.from(await doc.save()), mime: 'application/pdf' });
  assert.ok(result.report.pathCount > 2000); assert.equal(result.report.quality, 'teyit');
  assert.ok(result.report.reasons.includes('cok_yol'));
  const ordinary = await PDFDocument.create(); ordinary.addPage([200,100]).drawLine({
    start: { x: 10, y: 10 }, end: { x: 100, y: 50 }, thickness: 2 });
  assert.equal((await vectorize({ buffer: Buffer.from(await ordinary.save()), mime: 'application/pdf' })).report.quality, 'iyi');
});

test('CLI reads source only, produces PDF/JSON/PNG elsewhere; rendered bounds preserve aspect', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'g4-test-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'input'); await fs.mkdir(input);
  const bytes = png(); await fs.writeFile(path.join(input, 'ornek.png'), bytes);
  const before = await fs.stat(path.join(input, 'ornek.png'));
  const output = path.join(dir, 'output');
  const { stdout } = await promisify(execFile)(process.execPath, [path.resolve('agent/siparis/vector.js'), '--karsilastir', input, '--output', output]);
  assert.equal(JSON.parse(stdout).files.length, 1);
  assert.deepEqual((await fs.readdir(output)).sort(), ['ornek.png.json', 'ornek.png.page-1.png', 'ornek.png.pdf']);
  assert.deepEqual(await fs.readFile(path.join(input, 'ornek.png')), bytes);
  assert.equal((await fs.stat(path.join(input, 'ornek.png'))).mtimeMs, before.mtimeMs);
  const image = await loadImage(await fs.readFile(path.join(output, 'ornek.png.page-1.png')));
  const canvas = createCanvas(image.width, image.height); const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
  let x1=Infinity, y1=Infinity, x2=0, y2=0;
  for (let y=0; y<image.height; y++) for (let x=0; x<image.width; x++) {
    const i=(y*image.width+x)*4;
    if (pixels[i] > 120 && pixels[i+1] < 90 && pixels[i+2] < 110) {
      x1=Math.min(x1,x); y1=Math.min(y1,y); x2=Math.max(x2,x); y2=Math.max(y2,y);
    }
  }
  assert.ok(Math.abs(((x2-x1+1)/(y2-y1+1))/(100/40)-1) <= 0.01);
  await assert.rejects(compareDirectory(input, path.join(input, 'new')), /disinda/);
  assert.deepEqual(await fs.readdir(input), ['ornek.png']);
  const link = path.join(dir, 'link'); await fs.symlink(input, link);
  await assert.rejects(compareDirectory(input, path.join(link, 'new')), /disinda/);
  assert.deepEqual(await fs.readdir(input), ['ornek.png']);
});

test('manual always waits, including two files', async () => {
  const handler = createWorkshopHandler({ OTOMATIK_GONDERIM: '1', WHATSAPP_MODE: 'manual' });
  assert.deepEqual(await handler(job()), { status: 'manuel_bekliyor' });
});

test('test delivers two files once; duplicate and concurrent jobs do not resend', async () => {
  const provider = createTestAdapter(); const handler = createWorkshopHandler({ OTOMATIK_GONDERIM: '1' }, { mode: 'test', provider });
  const results = await Promise.all([handler(job()), handler(job())]);
  assert.equal(results[0].status, 'tamam'); assert.equal(results[1].status, 'tamam');
  assert.equal(provider.records.filter(x => x.status === 'gonderildi').length, 2);
  assert.equal(provider.records.filter(x => x.status === 'ulasti').length, 2);
});

test('temporary retry resends only the failed file; first N failures recover', async () => {
  const provider = createTestAdapter({ failures: { 'ornek-atolye.pdf': 1 } });
  const handler = createWorkshopHandler({ OTOMATIK_GONDERIM: '1' }, { mode: 'test', provider });
  await assert.rejects(handler(job()), err => err.temporary);
  assert.equal((await handler(job())).status, 'tamam');
  assert.equal(provider.records.filter(x => x.status === 'gonderildi').length, 2);
  const retryProvider = createTestAdapter({ failFirst: 2 });
  const retry = createWorkshopHandler({ OTOMATIK_GONDERIM: '1' }, { mode: 'test', provider: retryProvider });
  await assert.rejects(retry(job()), err => err.temporary); await assert.rejects(retry(job()), err => err.temporary);
  assert.equal((await retry(job())).status, 'tamam');
});

test('lost response queries providerRef after restart, does not send second time', async () => {
  const provider = createTestAdapter({ lostResponseFor: ['ornek-desen.pdf'] }); const store = createMemoryStore();
  const options = { mode: 'test', provider, store }; const env = { OTOMATIK_GONDERIM: '1' };
  await assert.rejects(createWorkshopHandler(env, options)(job()), /kayboldu/);
  assert.equal((await createWorkshopHandler(env, options)(job())).status, 'tamam');
  const queried = provider.records.find(x => x.status === 'durum_sorgulandi');
  assert.equal(queried.providerRef, 'test:1');
  assert.equal(provider.records.filter(x => x.status === 'gonderildi').length, 2);
});

test('unknown delivery and preexisting provider_ref never blindly resend', async () => {
  let sends = 0, queries = 0;
  const handler = createWorkshopHandler({ OTOMATIK_GONDERIM: '1' }, { mode: 'test', provider: {
    async lookupStatus({ providerRef }) { queries++; assert.equal(providerRef, 'wamid.fake'); return { status: 'unknown' }; },
    async send() { sends++; },
  } });
  const one = job({ provider_ref: 'wamid.fake' }); one.payload_json = { ...one.payload_json, files: [files[0]] };
  assert.equal((await handler(one)).status, 'manuel_bekliyor'); assert.equal(queries, 1); assert.equal(sends, 0);
});

test('kill switch avoids every cloud call, also when toggled after construction', async () => {
  let calls = 0; const env = { OTOMATIK_GONDERIM: '0', WHATSAPP_MODE: 'cloud' };
  const handler = createWorkshopHandler(env, { fetch: async () => { calls++; throw new Error('network prohibited'); } });
  assert.equal((await handler(job())).status, 'manuel_bekliyor'); assert.equal(calls, 0);
  env.OTOMATIK_GONDERIM = '1'; // Without durable store still safely manual.
  assert.equal((await handler(job())).status, 'manuel_bekliyor'); assert.equal(calls, 0);
});

test('cloud upload precedes group document send; injected fetch, env credentials only', async () => {
  const calls = [];
  const env = { OTOMATIK_GONDERIM: '1', WHATSAPP_MODE: 'cloud', WHATSAPP_ACCESS_TOKEN: 'fake-env-token',
    WHATSAPP_PHONE_NUMBER_ID: '12345', WHATSAPP_API_VERSION: 'v24.0' };
  const handler = createWorkshopHandler(env, { store: createMemoryStore(), fetch: async (url, request) => {
    calls.push({ url, request });
    return { ok: true, json: async () => url.endsWith('/media') ? { id: 'fake-media' } : { messages: [{ id: 'wamid.fake' }] } };
  } });
  const one = job(); one.payload_json = JSON.stringify({ ...one.payload_json, files: [files[0]] });
  assert.equal((await handler(one)).status, 'tamam'); assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/media$/); assert.match(calls[1].url, /\/messages$/);
  const body = JSON.parse(calls[1].request.body);
  assert.equal(body.recipient_type, 'group'); assert.equal(body.document.id, 'fake-media');
  assert.equal(body.to, 'fake-group'); assert.equal(calls[0].request.body.get('messaging_product'), 'whatsapp');
  env.OTOMATIK_GONDERIM = '0'; assert.equal((await handler(one)).status, 'manuel_bekliyor'); assert.equal(calls.length, 2);
});

test('cloud network loss without provider ref needs lookup; unknown -> manual without resend', async () => {
  let sends = 0, lookups = 0; const store = createMemoryStore();
  const env = { OTOMATIK_GONDERIM: '1', WHATSAPP_MODE: 'cloud', WHATSAPP_ACCESS_TOKEN: 'fake',
    WHATSAPP_PHONE_NUMBER_ID: '12345', WHATSAPP_API_VERSION: 'v24.0' };
  const options = { store, lookupStatus: async ({ providerRef }) => { lookups++; assert.equal(providerRef, undefined); return { status: 'unknown' }; },
    fetch: async url => { if (url.endsWith('/media')) return { ok: true, json: async () => ({ id: 'fake-media' }) };
      sends++; throw new Error('response lost'); } };
  await assert.rejects(createWorkshopHandler(env, options)(job()), err => err.temporary && err.ambiguous);
  assert.equal((await createWorkshopHandler(env, options)(job())).status, 'manuel_bekliyor');
  assert.equal(sends, 1); assert.equal(lookups, 1);
});

test('cloud lost response with trustworthy injected ledger key lookup skips second send', async () => {
  let sends = 0, lookups = 0; const store = createMemoryStore();
  const env = { OTOMATIK_GONDERIM: '1', WHATSAPP_MODE: 'cloud', WHATSAPP_ACCESS_TOKEN: 'fake',
    WHATSAPP_PHONE_NUMBER_ID: '12345', WHATSAPP_API_VERSION: 'v24.0' };
  // A trusted external correlation is injected here, NOT a built-in Meta key lookup.
  const options = { store, lookupStatus: async ({ key, providerRef }) => {
    lookups++; assert.equal(key, 'atolye:V-T001'); assert.equal(providerRef, undefined);
    return { status: 'delivered', providerRef: 'wamid.from-webhook-ledger' };
  }, fetch: async url => {
    if (url.endsWith('/media')) return { ok: true, json: async () => ({ id: 'media' }) };
    sends++; throw new Error('response lost');
  } };
  const one = job(); one.payload_json = { ...one.payload_json, files: [files[0]] };
  await assert.rejects(createWorkshopHandler(env, options)(one), err => err.temporary);
  const result = await createWorkshopHandler(env, options)(one);
  assert.equal(result.status, 'tamam'); assert.equal(result.providerRef, 'wamid.from-webhook-ledger');
  assert.equal(sends, 1); assert.equal(lookups, 1);
});

test('workshop message includes operational allowlist, excludes price/customer contact', () => {
  const order = job().payload_json.order;
  const message = buildWorkshopMessage({ ...order, lines: [{ product_key: 'Forma', color_name: 'Kirmizi', quantity: 12 }],
    price: 'SECRET-PRICE', customer: { phone: 'SECRET-PHONE' }, email: 'SECRET-EMAIL' }, files);
  for (const expected of ['MRC-T001', 'Surum: 2', 'Forma', 'Kirmizi', '12', ...files.map(x => x.name)]) assert.ok(message.includes(expected));
  assert.doesNotMatch(message, /SECRET|fiyat|price|phone|email/i);
});

test('input validation does not accept invalid dimensions or unsupported MIME', async () => {
  await assert.rejects(vectorize({ buffer: png(), mime: 'image/png', targetMm: { w: 0, h: 120 } }), /targetMm/);
  await assert.rejects(vectorize({ buffer: png(), mime: 'image/gif' }), /MIME/);
});
