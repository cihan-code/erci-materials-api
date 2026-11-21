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
  assert.equal(result.report.aspectRatioPreserved, false);
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

test('image-only PDF page composition traces locally, crops to physical artwork size', async () => {
  const doc = await PDFDocument.create(); const page = doc.addPage([200, 100]);
  page.drawImage(await doc.embedPng(png()), { x: 0, y: 0, width: 200, height: 100 });
  const result = await vectorize({ buffer: Buffer.from(await doc.save()), mime: 'application/pdf' });
  assert.equal(result.kind, 'raster'); assert.ok(result.report.pathCount > 0);
  assert.equal(result.report.pages[0].imageCount, 0);
  assert.ok(Math.abs(result.report.pages[0].widthMm - (200*100/120) * 25.4 / 72) < 0.5);
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
  const ratio = await vectorize({ buffer: png({ width: 600, height: 24 }), mime: 'image/png', targetMm:{w:60,h:2.4} });
  assert.ok(ratio.report.reasons.some(x=>x.includes('oranı olağan sınırların dışında')));
  const rasterThin = await vectorize({ buffer: png({ thin: true }), mime: 'image/png',targetMm:{w:20,h:10} });
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
  const handler = createWorkshopHandler({ NODE_ENV: 'test', OTOMATIK_GONDERIM: '1', WHATSAPP_MODE: 'manual' });
  assert.deepEqual(await handler(job()), { status: 'manuel_bekliyor' });
});

test('test delivers two files once; duplicate and concurrent jobs do not resend', async () => {
  const provider = createTestAdapter(); const handler = createWorkshopHandler({ NODE_ENV: 'test', OTOMATIK_GONDERIM: '1' }, { mode: 'test', provider });
  const results = await Promise.all([handler(job()), handler(job())]);
  assert.equal(results[0].status, 'tamam'); assert.equal(results[1].status, 'tamam');
  assert.equal(provider.records.filter(x => x.status === 'gonderildi').length, 2);
  assert.equal(provider.records.filter(x => x.status === 'ulasti').length, 2);
});

test('temporary retry resends only the failed file; first N failures recover', async () => {
  const provider = createTestAdapter({ failures: { 'ornek-atolye.pdf': 1 } });
  const handler = createWorkshopHandler({ NODE_ENV: 'test', OTOMATIK_GONDERIM: '1' }, { mode: 'test', provider });
  await assert.rejects(handler(job()), err => err.temporary);
  assert.equal((await handler(job())).status, 'tamam');
  assert.equal(provider.records.filter(x => x.status === 'gonderildi').length, 2);
  const retryProvider = createTestAdapter({ failFirst: 2 });
  const retry = createWorkshopHandler({ NODE_ENV: 'test', OTOMATIK_GONDERIM: '1' }, { mode: 'test', provider: retryProvider });
  await assert.rejects(retry(job()), err => err.temporary); await assert.rejects(retry(job()), err => err.temporary);
  assert.equal((await retry(job())).status, 'tamam');
});

test('lost response queries providerRef after restart, does not send second time', async () => {
  const provider = createTestAdapter({ lostResponseFor: ['ornek-desen.pdf'] }); const store = {...createMemoryStore(),durable:true};
  const options = { mode: 'test', provider, store }; const env = { NODE_ENV: 'test', OTOMATIK_GONDERIM: '1' };
  await assert.rejects(createWorkshopHandler(env, options)(job()), /kayboldu/);
  assert.equal((await createWorkshopHandler(env, options)(job())).status, 'tamam');
  const queried = provider.records.find(x => x.status === 'durum_sorgulandi');
  assert.equal(queried.providerRef, 'test:1');
  assert.equal(provider.records.filter(x => x.status === 'gonderildi').length, 2);
});

test('unknown delivery and preexisting provider_ref never blindly resend', async () => {
  let sends = 0, queries = 0;
  const handler = createWorkshopHandler({ NODE_ENV: 'test', OTOMATIK_GONDERIM: '1' }, { mode: 'test', provider: {
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
  const env = { NODE_ENV: 'test', OTOMATIK_GONDERIM: '1', WHATSAPP_MODE: 'cloud', WHATSAPP_ACCESS_TOKEN: 'fake-env-token',
    WHATSAPP_PHONE_NUMBER_ID: '12345', WHATSAPP_API_VERSION: 'v24.0' };
  const handler = createWorkshopHandler(env, { store: {...createMemoryStore(),durable:true}, fetch: async (url, request) => {
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
  let sends = 0, lookups = 0; const store = {...createMemoryStore(),durable:true};
  const env = { NODE_ENV: 'test', OTOMATIK_GONDERIM: '1', WHATSAPP_MODE: 'cloud', WHATSAPP_ACCESS_TOKEN: 'fake',
    WHATSAPP_PHONE_NUMBER_ID: '12345', WHATSAPP_API_VERSION: 'v24.0' };
  const options = { store, lookupStatus: async ({ providerRef }) => { lookups++; assert.equal(providerRef, undefined); return { status: 'unknown' }; },
    fetch: async url => { if (url.endsWith('/media')) return { ok: true, json: async () => ({ id: 'fake-media' }) };
      sends++; throw new Error('response lost'); } };
  await assert.rejects(createWorkshopHandler(env, options)(job()), err => err.temporary && err.ambiguous);
  assert.equal((await createWorkshopHandler(env, options)(job())).status, 'manuel_bekliyor');
  assert.equal(sends, 1); assert.equal(lookups, 1);
});

test('cloud lost response with trustworthy injected ledger key lookup skips second send', async () => {
  let sends = 0, lookups = 0; const store = {...createMemoryStore(),durable:true};
  const env = { NODE_ENV: 'test', OTOMATIK_GONDERIM: '1', WHATSAPP_MODE: 'cloud', WHATSAPP_ACCESS_TOKEN: 'fake',
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
  for (const expected of ['MRC-T001', 'Sipariş: MRC-T001', 'Sürüm: 2', 'Ürün: Forma', 'Kirmizi', '12', ...files.map(x => x.name)]) assert.ok(message.includes(expected));
  assert.doesNotMatch(message, /SECRET|fiyat|price|phone|email/i);
});

test('workshop uses recipe labels for product keys and preserves the operational allowlist', () => {
  const recipes = require('../agent/operations/recipes').load();
  const message = buildWorkshopMessage({ order_no: 'MRC-T018', version_no: 1,
    lines: Object.keys(recipes.products).map(product_key => ({ product_key, color_name: 'Mavi', quantity: 3,
      unit_price: 'SECRET-PRICE', customer_phone: 'SECRET-PHONE' })) }, files);
  for (const { label } of Object.values(recipes.products)) assert.ok(message.includes(`Ürün: ${label} |`));
  assert.ok(message.includes('Ürün: Polo yaka |'));
  assert.doesNotMatch(message, /Ürün: (?:polo|sweat|tisort|esofman) \||SECRET/);
  const custom = buildWorkshopMessage({ lines: [{ product_key: 'polo', product_name: 'Eski ad' }] }, [],
    { products: { polo: { label: 'Örnek yaka' } } });
  assert.match(custom, /Ürün: Örnek yaka/);
});

test('input validation does not accept invalid dimensions or unsupported MIME', async () => {
  await assert.rejects(vectorize({ buffer: png(), mime: 'image/png', targetMm: { w: 0, h: 120 } }), /targetMm/);
  await assert.rejects(vectorize({ buffer: png(), mime: 'image/gif' }), /MIME/);
});

async function artworkMm(buffer, whiteInk = false) {
  const canvasLib=require('@napi-rs/canvas');
  for (const key of ['DOMMatrix','ImageData','Path2D']) globalThis[key] ||= canvasLib[key];
  const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc=await pdfjs.getDocument({data:Uint8Array.from(buffer),verbosity:0}).promise;
  try {
    const page=await doc.getPage(1), scale=3, viewport=page.getViewport({scale});
    const canvas=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height)),ctx=canvas.getContext('2d');
    const background=whiteInk?'rgba(0,0,0,0)':undefined;
    await page.render({canvasContext:ctx,viewport,background}).promise;
    const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
    let left=Infinity,top=Infinity,right=-1,bottom=-1;
    for(let y=0;y<canvas.height;y++) for(let x=0;x<canvas.width;x++) {
      const i=(y*canvas.width+x)*4;
      if(pixels[i+3]>32 && (whiteInk ? Math.min(...pixels.subarray(i,i+3))>240 : Math.min(...pixels.subarray(i,i+3))<200)) {
        left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
      }
    }
    return [(right-left+1)/scale*25.4/72,(bottom-top+1)/scale*25.4/72];
  } finally {await doc.destroy();}
}
test('G14-3 rendered artwork, including transparent/white margins and vector PDF, matches both target dimensions',async()=> {
  const raster=createCanvas(400,400),ctx=raster.getContext('2d');
  const inputs=[];
  for (const background of ['transparent','white']) {
    ctx.clearRect(0,0,400,400);
    if(background==='white') {ctx.fillStyle='white';ctx.fillRect(0,0,400,400);}
    ctx.fillStyle='#2350aa';ctx.fillRect(130,170,140,60);
    inputs.push({buffer:raster.toBuffer('image/png'),mime:'image/png'});
  }
  const doc=await PDFDocument.create();doc.addPage([400,400]).drawRectangle({x:130,y:170,width:140,height:60,color:rgb(0.1,0.3,0.7)});
  inputs.push({buffer:Buffer.from(await doc.save()),mime:'application/pdf'});
  inputs.push({buffer:raster.toBuffer('image/jpeg'),mime:'image/jpeg'});
  doc.getPage(0).setRotation(degrees(90));
  inputs.push({buffer:Buffer.from(await doc.save()),mime:'application/pdf',manualVector:true});
  const rasterPdf=await PDFDocument.create();
  rasterPdf.addPage([400,400]).drawImage(await rasterPdf.embedPng(raster.toBuffer('image/png')),{x:0,y:0,width:400,height:400});
  inputs.push({buffer:Buffer.from(await rasterPdf.save()),mime:'application/pdf'});
  for(const input of inputs) {
    const out=await vectorize({...input,targetMm:{w:280,h:120}}), [w,h]=await artworkMm(out.pdf);
    assert.ok(Math.abs(w-280)<=1,`${input.mime}: width ${w}`);assert.ok(Math.abs(h-120)<=1,`${input.mime}: height ${h}`);
    assert.equal(out.report.pages[0].imageCount,0);
  }
});
test('G40 beyaz vektör mürekkebi hedef ölçüyü doldurur, boş sayfa içerik sayılmaz',async()=> {
  const blank=await PDFDocument.create();blank.addPage([400,400]);
  const render=async (doc,manualVector)=>vectorize({buffer:Buffer.from(await doc.save()),mime:'application/pdf',manualVector,targetMm:{w:310,h:450}});
  await assert.rejects(render(blank,false),/PDF desen içerik kutusu boş/);
  const source=await PDFDocument.create(),page=source.addPage([400,400]);
  page.drawRectangle({x:110,y:75,width:124,height:180,color:rgb(1,1,1)});
  const result=await render(source,true),[w,h]=await artworkMm(result.pdf,true);
  assert.ok(Math.abs(w-310)<1 && Math.abs(h-450)<1,`${w} × ${h}`);
  assert.equal(result.report.pages[0].imageCount,0);
  for(const [width,height,gray] of [[400,400,1],[400.2,399.8,.99]]) {
    const flood=await PDFDocument.create();
    flood.addPage([width,height]).drawRectangle({x:0,y:0,width,height,color:rgb(gray,gray,gray)});
    await assert.rejects(render(flood,true),/PDF desen içerik kutusu boş/);
  }
});
test('G40 karma vektör PDF koyu merkezi ve iki dış beyaz işareti birlikte ölçer',async()=> {
  const source=await PDFDocument.create(),page=source.addPage([400,400]);
  page.drawRectangle({x:170,y:150,width:60,height:100,color:rgb(.08,.15,.22)});
  for(const x of [70,300])page.drawRectangle({x,y:155,width:30,height:85,color:rgb(1,1,1)});
  const out=await vectorize({buffer:Buffer.from(await source.save()),mime:'application/pdf',manualVector:true,targetMm:{w:260,h:100}});
  assert.equal(out.report.pages[0].imageCount,0);
  const [whiteWidth,whiteHeight]=await artworkMm(out.pdf,true),[darkWidth,darkHeight]=await artworkMm(out.pdf);
  for(const [actual,expected] of [[whiteWidth,260],[whiteHeight,85],[darkWidth,60],[darkHeight,100]]) {
    assert.ok(Math.abs(actual-expected)<1,`${actual} mm; ${expected} mm bekleniyor`);
  }
  const {rasterPages}=require('../agent/siparis/autoMeasure');
  const [proof]=await rasterPages({buffer:out.pdf,mime:'application/pdf'},1000,[1],{transparent:true});
  const pixel=(x,y)=>{
    const i=4*(Math.floor(y*proof.height)*proof.width+Math.floor(x*proof.width));
    return Array.from(proof.data.subarray(i,i+4));
  };
  const [left,center,right]=[.04,.5,.96].map(x=>pixel(x,.5));
  for(const edge of [left,right])assert.ok(edge[3]>240 && edge[0]-center[0]>180,JSON.stringify({left,center,right}));
});
test('G14-13 test mode cannot dispatch outside NODE_ENV=test and cloud without durable storage logs fallback',async()=> {
  for (const NODE_ENV of [undefined,'production','development']) {
    const provider=createTestAdapter();
    const handler=createWorkshopHandler({NODE_ENV,OTOMATIK_GONDERIM:'1',WHATSAPP_MODE:'test'},{provider});
    assert.equal((await handler(job())).status,'manuel_bekliyor');assert.equal(provider.records.length,0);
  }
  const logs=[];
  const handler=createWorkshopHandler({OTOMATIK_GONDERIM:'1',WHATSAPP_MODE:'cloud'},{logger:{warn:m=>logs.push(m)}});
  assert.equal((await handler(job())).status,'manuel_bekliyor');assert.match(logs.join(' '),/kalıcı|durable/i);
});

function qualityPng(draw, width = 200, height = 100) {
  const canvas = createCanvas(width,height), ctx = canvas.getContext('2d');
  draw(ctx); return canvas.toBuffer('image/png');
}

test('G27 thick two-colour logo can be iyi and target scale is measured again', async () => {
  const buffer = qualityPng(ctx => {
    ctx.fillStyle='#cc1020';ctx.fillRect(10,10,180,80);
    ctx.fillStyle='#1030cc';ctx.fillRect(70,30,60,40);
  });
  const natural = await vectorize({buffer,mime:'image/png'});
  assert.equal(natural.report.quality,'beklemede');
  assert.equal(natural.report.qualityLabel,'Kalite ölçüden sonra değerlendirilecek');
  assert.deepEqual(natural.report.reasons,[]);
  assert.equal(natural.report.rasterQuality.colorCount,2);
  assert.equal(natural.report.rasterQuality.measurementSize,'pending');
  assert.ok(natural.report.rasterQuality.iou >= .97);
  assert.ok(natural.report.rasterQuality.nodeCount >= natural.report.pathCount);
  const small = await vectorize({buffer,mime:'image/png',targetMm:{w:1.8,h:.8}});
  assert.equal(small.report.quality,'teyit');
  assert.equal(small.report.rasterQuality.measurementSize,'target');
  assert.ok(small.report.reasons.some(x=>x.includes('En ince çizgi')));
  const large = await vectorize({buffer,mime:'image/png',targetMm:{w:90,h:40}});
  assert.equal(large.report.quality,'iyi',large.report.reasons.join(' '));
});

test('G27 0.3 mm letter strokes require confirmation and embroidery is stricter', async () => {
  const buffer = qualityPng(ctx => {
    ctx.fillStyle='#102060';ctx.fillRect(10,10,180,3);ctx.fillRect(10,10,3,80);ctx.fillRect(80,10,3,80);
  });
  const result = await vectorize({buffer,mime:'image/png',targetMm:{w:18,h:8}});
  assert.equal(result.report.quality,'teyit');
  assert.ok(result.report.rasterQuality.minLineMm <= .31);
  assert.ok(result.report.reasons.some(x=>x.includes('En ince çizgi')));
  const bar = qualityPng(ctx=>{ctx.fillStyle='red';ctx.fillRect(10,10,100,5);});
  const options = {buffer:bar,mime:'image/png',targetMm:{w:20,h:1}};
  assert.equal((await vectorize(options)).report.quality,'iyi');
  const embroidery = await vectorize({...options,applicationType:'nakis'});
  assert.equal(embroidery.report.quality,'teyit');
  assert.equal(embroidery.report.rasterQuality.limits.minLineMm,1.2);
});

test('G29 exterior channels are excluded; enclosed holes and tiny closed shapes are measured', async () => {
  const channel = qualityPng(ctx=>{
    ctx.fillStyle='red';ctx.fillRect(0,0,40,60);ctx.fillRect(43,0,40,60);
  },83,60);
  const result = await vectorize({buffer:channel,mime:'image/png',targetMm:{w:8.3,h:6}});
  assert.equal(result.report.rasterQuality.minGapMm,null);
  assert.ok(!result.report.reasons.some(x=>x.includes('En küçük boşluk')));
  for (const hole of [true,false]) {
    const buffer=qualityPng(ctx=>{
      ctx.fillStyle='red';ctx.fillRect(0,0,100,100);
      if(hole) ctx.clearRect(50,50,3,3);
      else {ctx.clearRect(40,40,20,20);ctx.fillStyle='blue';ctx.fillRect(50,50,3,3);}
    },100,100);
    const tiny=await vectorize({buffer,mime:'image/png',targetMm:{w:10,h:10}});
    assert.equal(tiny.report.quality,'teyit');
    assert.ok(tiny.report.rasterQuality.minShapeMm2 <= .1);
    assert.ok(tiny.report.reasons.some(x=>x.includes('En küçük kapalı şekil')));
  }
});

test('G27 gradient and photographic colour noise require confirmation', async () => {
  for (const photograph of [false,true]) {
    const canvas=createCanvas(64,32),ctx=canvas.getContext('2d'),pixels=ctx.createImageData(64,32);
    for(let i=0;i<64*32;i++) {
      const x=i%64,y=Math.floor(i/64),p=i*4;
      pixels.data[p]=photograph ? (x*53+y*71)%256 : x*4;
      pixels.data[p+1]=photograph ? (x*97+y*29)%256 : 50;
      pixels.data[p+2]=photograph ? (x*13+y*109)%256 : 160;
      pixels.data[p+3]=255;
    }
    ctx.putImageData(pixels,0,0);
    const buffer=canvas.toBuffer(photograph ? 'image/jpeg' : 'image/png');
    const result=await vectorize({buffer,mime:photograph ? 'image/jpeg' : 'image/png',targetMm:{w:32,h:16}});
    assert.equal(result.report.quality,'teyit');
    assert.ok(result.report.rasterQuality.colorCount>6 || photograph);
    assert.ok(result.report.reasons.length>0);
  }
});

test('G27 broad translucent edge requires review despite a large opaque interior', async () => {
  const buffer=qualityPng(ctx=>{
    ctx.fillStyle='rgba(200,0,0,.5)';ctx.fillRect(0,0,1000,400);
    ctx.fillStyle='rgb(200,0,0)';ctx.fillRect(10,10,980,380);
  },1000,400);
  const result=await vectorize({buffer,mime:'image/png',targetMm:{w:100,h:40}});
  assert.equal(result.report.quality,'teyit');
  assert.ok(result.report.rasterQuality.semiTransparentRatio>.1);
  assert.ok(result.report.reasons.some(x=>x.includes('Alfa kenarında')));
});

test('G27 white and pale ink on transparency remain measurable', async () => {
  for(const color of ['white','#ededed']) {
    const buffer=qualityPng(ctx=>{ctx.fillStyle=color;ctx.fillRect(10,10,180,80);});
    const result=await vectorize({buffer,mime:'image/png',targetMm:{w:90,h:40}});
    assert.equal(result.report.quality,'iyi',result.report.reasons.join(' '));
    assert.ok(result.report.rasterQuality.minLineMm>1);
    assert.equal(result.report.rasterQuality.iou,1);
  }
});

test('G27 invalid environment limits fall back safely; valid limits apply', async t => {
  const key='SIPARIS_VECTOR_BASKI_MIN_LINE_MM',previous=process.env[key];
  t.after(()=>{if(previous===undefined) delete process.env[key];else process.env[key]=previous;});
  const buffer=qualityPng(ctx=>{ctx.fillStyle='red';ctx.fillRect(10,10,100,3);});
  for(const invalid of ['', 'NaN','-1','0','Infinity','101']) {
    process.env[key]=invalid;
    const result=await vectorize({buffer,mime:'image/png',targetMm:{w:10,h:.3}});
    assert.equal(result.report.quality,'teyit');
    assert.equal(result.report.rasterQuality.limits.minLineMm,.8);
  }
  process.env[key]='2';
  const result=await vectorize({buffer,mime:'image/png',targetMm:{w:100,h:40}});
  assert.equal(result.report.rasterQuality.limits.minLineMm,2);
  assert.equal(result.report.quality,'teyit');
  await assert.rejects(vectorize({buffer,mime:'image/png',applicationType:'unknown'}),/applicationType/);
});

 test('G27 antialias alpha coverage and minor colour noise do not create extra inks', async()=> {
  const buffer=qualityPng(ctx=>{
    ctx.fillStyle='rgba(200,0,0,.5)';ctx.fillRect(0,0,200,100);
    ctx.fillStyle='rgb(200,0,0)';ctx.fillRect(1,1,198,98);
    ctx.fillStyle='rgb(195,4,3)';ctx.fillRect(20,20,80,40);
    ctx.fillStyle='blue';ctx.fillRect(50,50,3,3);
  });
  const result=await vectorize({buffer,mime:'image/png',targetMm:{w:100,h:50}});
  assert.equal(result.report.rasterQuality.colorCount,1);
  assert.equal(result.report.rasterQuality.semiTransparentRatio,0);
  assert.ok(!result.report.reasons.some(x=>x.includes('Alfa kenarında')));
 });

test('G27 cached white preview uses its cropped page and original raster for final quality',async()=> {
  const buffer=qualityPng(ctx=>{ctx.fillStyle='white';ctx.fillRect(10,10,180,80);});
  const preview=await vectorize({buffer,mime:'image/png'});
  const result=await vectorize({buffer:preview.pdf,mime:'application/pdf',manualVector:true,targetMm:{w:90,h:40},
    qualitySource:{buffer,mime:'image/png',metrics:preview.report.rasterQuality}});
  assert.equal(result.report.quality,'iyi',result.report.reasons.join(' '));
  assert.equal(result.report.rasterQuality.widthMm,90);
  assert.ok(result.report.rasterQuality.minLineMm>1);
});

test('G27 legacy cached preview without complexity metrics cannot silently become good',async()=> {
  const buffer=qualityPng(ctx=>{ctx.fillStyle='red';ctx.fillRect(10,10,180,80);});
  const preview=await vectorize({buffer,mime:'image/png'});
  const result=await vectorize({buffer:preview.pdf,mime:'application/pdf',manualVector:true,targetMm:{w:90,h:40},
    qualitySource:{buffer,mime:'image/png'}});
  assert.equal(result.report.quality,'teyit');
  assert.equal(result.report.rasterQuality.pathCount,null);
  assert.equal(result.report.rasterQuality.nodeCount,null);
  assert.ok(result.report.reasons.some(reason=>reason.includes('ölçümleri eksik')));
});


test('G29 angular thick letters ignore corner tips while sustained 0.3 mm writing needs review',async()=> {
  for(const thickness of [20,3]) {
    const buffer=qualityPng(ctx=>{
      ctx.fillStyle='#102060';
      ctx.fillRect(10,10,thickness,80);ctx.fillRect(10,70,80,20);
      ctx.fillRect(110,10,thickness,80);ctx.fillRect(110,10,80,thickness);
    });
    const result=await vectorize({buffer,mime:'image/png',targetMm:{w:18,h:8}});
    assert.equal(result.report.quality,thickness===20 ? 'iyi':'teyit',result.report.reasons.join(' '));
    if(thickness===3) assert.ok(result.report.rasterQuality.minLineMm<=.31);
  }
});

test('G29 matching opaque ground and design colours need explicit confirmation',async()=> {
  for(const color of ['white','#172b40','#b64050']) {
    const buffer=qualityPng(ctx=>{ctx.fillStyle=color;ctx.fillRect(0,0,200,100);});
    const result=await vectorize({buffer,mime:'image/png',targetMm:{w:20,h:10}});
    assert.equal(result.report.quality,'teyit');
    assert.ok(result.report.reasons.includes('Zemin ve desen rengi ayrışmıyor; baskı alanı belirsiz'));
  }
});

test('G29 components under 0.05 percent are counted as noise rather than closed shapes',async()=> {
  const buffer=qualityPng(ctx=>{ctx.fillStyle='red';ctx.fillRect(0,0,160,100);ctx.fillRect(190,0,2,2);});
  const result=await vectorize({buffer,mime:'image/png',targetMm:{w:96,h:50}});
  assert.equal(result.report.quality,'iyi',result.report.reasons.join(' '));
  assert.ok(result.report.rasterQuality.gurultuSayisi>=1);
  assert.ok(result.report.rasterQuality.minShapeMm2>1);
});

test('G29 compact blob without a 1 mm skeleton segment is checked by closed area',async()=> {
  const buffer=qualityPng(ctx=>{ctx.fillStyle='red';ctx.fillRect(10,10,80,80);});
  const result=await vectorize({buffer,mime:'image/png',targetMm:{w:8,h:8}});
  assert.equal(result.report.quality,'iyi',result.report.reasons.join(' '));
  assert.equal(result.report.rasterQuality.minLineMm,null);
  assert.ok(result.report.rasterQuality.minShapeMm2>1);
});

test('G39b large rasters keep natural physical dimensions and require original-detail review at output size',async()=>{
  // Non-flat artwork: flat one/two-colour logos keep up to 2 MP since G49b.
  const canvas=createCanvas(1600,800),ctx=canvas.getContext('2d'),fill=ctx.createLinearGradient(0,0,1600,0);
  fill.addColorStop(0,'#d02030');fill.addColorStop(1,'#2040d0');ctx.fillStyle=fill;ctx.fillRect(0,0,1600,800);
  const buffer=canvas.toBuffer('image/png');
  const natural=await vectorize({buffer,mime:'image/png'});
  assert.ok(Math.abs(natural.report.pages[0].widthMm-1600*25.4/96)<.5);
  assert.ok(Math.abs(natural.report.pages[0].heightMm-800*25.4/96)<.5);
  const output=await vectorize({buffer,mime:'image/png',targetMm:{w:200,h:100}});
  assert.equal(output.report.quality,'teyit');assert.match(output.report.reasons.join(' '),/küçültüldü.*özgün dosyayla teyit/);
  assert.equal(output.report.pages[0].imageCount,0);
  assert.ok(output.report.designBox.w<=800);
});
