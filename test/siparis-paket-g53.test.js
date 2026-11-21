'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument, rgb } = require('pdf-lib');
const { PNG } = require('pngjs');
const { vectorize } = require('../agent/siparis/vector');

const MM = 72 / 25.4;
// Invented proof: a 25:1 word of white bars, optionally on a full-page ground.
async function proof({ ground = rgb(0, 0, 0), inset = 0, before = false } = {}) {
  const doc = await PDFDocument.create(), page = doc.addPage([600, 200]);
  if (before) page.drawRectangle({ x: 10, y: 10, width: 5, height: 5, color: rgb(1, 1, 1) });
  if (ground) page.drawRectangle({ x: inset, y: inset, width: 600 - 2 * inset, height: 200 - 2 * inset, color: ground });
  for (let i = 0; i < 10; i++) page.drawRectangle({ x: 50 + i * 50, y: 90, width: 40, height: 20, color: rgb(1, 1, 1) });
  // A counter in the ground colour inside the first letter is not ink.
  page.drawRectangle({ x: 60, y: 95, width: 20, height: 10, color: ground || rgb(0, 0, 0) });
  return Buffer.from(await doc.save());
}
async function render(buffer) {
  const lib = await import('pdfjs-dist/legacy/build/pdf.mjs'), canvas = require('@napi-rs/canvas');
  for (const k of ['DOMMatrix', 'ImageData', 'Path2D']) globalThis[k] ||= canvas[k];
  const doc = await lib.getDocument({ data: Uint8Array.from(buffer), isEvalSupported: false, verbosity: 0 }).promise;
  try {
    const page = await doc.getPage(1), viewport = page.getViewport({ scale: 4 });
    const c = canvas.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvasContext: c.getContext('2d'), viewport, background: 'rgba(0,0,0,0)' }).promise;
    return PNG.sync.read(c.toBuffer('image/png'));
  } finally { await doc.destroy(); }
}
const sizeMm = async pdf => { const p = (await PDFDocument.load(pdf)).getPage(0); return [p.getWidth() / MM, p.getHeight() / MM]; };

test('G53-1 a full-page ground in the garment colour is not artwork: ink-only box, transparent vector, no ratio change', async () => {
  const result = await vectorize({ buffer: await proof(), mime: 'application/pdf', targetMm: { w: 250, h: 10 }, manualVector: true, garmentColor: '#000000' });
  assert.equal(result.report.ground.removed, true);
  assert.deepEqual(result.report.ground.pages, [{ page: 1, color: '#000000' }]);
  assert.ok(result.report.aspectRatioError <= 0.01, String(result.report.aspectRatioError));
  assert.ok(!result.report.reasons.includes('oran_bozuldu'));
  assert.ok(!result.report.reasons.includes('zemin_cikarildi'));
  const [w, h] = await sizeMm(result.pdf);
  assert.ok(Math.abs(w - 250) < 0.01 && Math.abs(h - 10) < 0.01);
  // Along the middle row: ten opaque bars separated by clear gaps; the ground is gone, not cropped around.
  const image = await render(result.pdf), y = Math.round(image.height / 2);
  let runs = 0, clear = 0, inside = false;
  for (let x = 0; x < image.width; x++) {
    const alpha = image.data[(y * image.width + x) * 4 + 3];
    if (alpha === 0) clear++;
    if (alpha > 200 && !inside) runs++;
    inside = alpha > 200;
  }
  assert.equal(runs, 10);
  assert.ok(clear > image.width * 0.1, String(clear));
});

test('G53-1 a ground in another colour, or with an unknown garment colour, is removed but opens a confirmation', async () => {
  for (const [ground, garmentColor] of [[rgb(0.8, 0, 0), '#000000'], [rgb(0, 0, 0), null], [rgb(0, 0, 0), 'kırmızı']]) {
    const result = await vectorize({ buffer: await proof({ ground }), mime: 'application/pdf', targetMm: { w: 250, h: 10 }, manualVector: true, garmentColor });
    assert.equal(result.report.ground?.removed, true);
    assert.ok(result.report.reasons.includes('zemin_cikarildi'), JSON.stringify(result.report.reasons));
  }
});

test('G53-1 a box that does not reach every edge, or is not the first paint, stays part of the artwork', async () => {
  for (const options of [{ inset: 20 }, { before: true }]) {
    const result = await vectorize({ buffer: await proof(options), mime: 'application/pdf', targetMm: { w: 250, h: 10 }, manualVector: true, garmentColor: '#000000' });
    assert.equal(result.report.ground, undefined);
    // The kept box is the artwork's box, so a 25:1 target distorts it and says so.
    assert.ok(result.report.reasons.includes('oran_bozuldu'));
  }
});

test('G53-1 whole-millimetre rounding of a small print keeps the artwork ratio; a larger difference is still reported', async () => {
  // Ink box 500 x 20 pt = 25:1. At 163 mm wide the true height is 6.52 mm.
  const exact = await vectorize({ buffer: await proof(), mime: 'application/pdf', targetMm: { w: 163, h: 7 }, manualVector: true, garmentColor: '#000000' });
  assert.equal(exact.report.aspectRatioError, 0);
  assert.ok(!exact.report.reasons.includes('oran_bozuldu'));
  const [w, h] = await sizeMm(exact.pdf);
  assert.ok(Math.abs(w - 163) < 0.01 && Math.abs(h - 7) < 0.01);
  const changed = await vectorize({ buffer: await proof(), mime: 'application/pdf', targetMm: { w: 163, h: 8 }, manualVector: true, garmentColor: '#000000' });
  assert.ok(changed.report.aspectRatioError > 0.01);
  assert.ok(changed.report.reasons.includes('oran_bozuldu'));
});

// HTTP flow helpers on the shared synthetic fixture (invented users, orders and artwork).
const fs = require('node:fs');
const { setup } = require('./fixtures/siparis/belge-fixture');
const documents = require('../agent/siparis/documents');
async function fixture(t) {
  const f = await setup();
  t.after(async () => { await documents.settled(); await f.close(); fs.rmSync(f.dir, { recursive: true, force: true }); });
  return f;
}
function ok(result, status = 200) { assert.equal(result.status, status, JSON.stringify(result.data)); return result.data; }
async function pdfText(buffer) {
  const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await lib.getDocument({ data: Uint8Array.from(buffer), isEvalSupported: false, verbosity: 0 }).promise;
  try {
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) pages.push((await (await doc.getPage(i)).getTextContent()).items.map(x => x.str).join(' '));
    return pages;
  } finally { await doc.destroy(); }
}
async function formOf(f, files, kind) { return ok(await f.request(`/dosyalar/${files.find(x => x.kind === kind).id}`, { token: f.token })); }

test('G53-2 a vector PDF design gets a preview on the print form from its vector, not a product crop', async t => {
  const f = await fixture(t), o = await f.order(), id = o.version.id, lineId = o.version.lines[0].id;
  for (const kind of ['desen_kaynak_vektor', 'desen_kaynak']) {
    const source = ok(await f.upload(id, { kind, name: `${kind}.pdf`, mime: 'application/pdf', buffer: await proof() }), 201);
    ok(await f.measure(lineId, { desenDosyaId: source.id, designBoxPx: { w: 125, h: 5 } }), 201);
  }
  const files = ok(await f.post(`/surumler/${id}/hazirla`));
  const text = (await pdfText(await formOf(f, files, 'baski_formu'))).join('\n');
  assert.doesNotMatch(text, /Desen önizlemesi sağlanmadı/);
  assert.doesNotMatch(text, /Ürün görselinden kırpıldı/);
  // The draft preview (no vectors traced) uses the same vector previews.
  await documents.settled();
  const preview = ok(await f.post(`/surumler/${id}/onizleme`));
  const draft = (await pdfText(Buffer.from(preview.formlar.find(x => x.kind === 'baski_formu').pdf, 'base64'))).join('\n');
  assert.doesNotMatch(draft, /Desen önizlemesi sağlanmadı/);
});

test('G53-3 the same PDF behaves the same as desen_kaynak and as desen_kaynak_vektor: judged at the target size, one rule', async t => {
  const f = await fixture(t), o = await f.order(), id = o.version.id, lineId = o.version.lines[0].id;
  const { PDFDocument: Doc } = require('pdf-lib');
  // Invented artwork: a block and a 0.6 pt bar, measured as 280 x 120 mm: the ratio changes and the bar prints ~0.7 mm.
  const doc = await Doc.create(), page = doc.addPage([300, 200]);
  page.drawRectangle({ x: 50, y: 50, width: 150, height: 100, color: rgb(0.1, 0.2, 0.6) });
  page.drawRectangle({ x: 240, y: 50, width: 0.6, height: 100, color: rgb(0.1, 0.2, 0.6) });
  const buffer = Buffer.from(await doc.save()), apps = {}, sources = {};
  for (const kind of ['desen_kaynak', 'desen_kaynak_vektor'])
    sources[kind] = ok(await f.upload(id, { kind, name: `${kind}.pdf`, mime: 'application/pdf', buffer }), 201);
  await documents.settled();
  // Before a size is known neither kind opens a confirmation for unmeasurable fill widths.
  const previews = f.db.prepare("SELECT report_json FROM document_vector_previews").all().map(r => JSON.parse(r.report_json));
  assert.deepEqual(previews.map(r => r.quality), ['beklemede', 'beklemede']);
  assert.equal(f.db.prepare("SELECT count(*) n FROM confirmations WHERE kind='vektor_kalite' AND status='acik'").get().n, 0);
  for (const kind of Object.keys(sources)) {
    const measured = ok(await f.measure(lineId, { desenDosyaId: sources[kind].id }), 201);
    apps[kind] = (measured.application || measured).id;
  }
  await documents.settled();
  // Once measured, both previews are judged at the target size the same way.
  const judged = f.db.prepare("SELECT report_json FROM document_vector_previews").all().map(r => JSON.parse(r.report_json));
  assert.deepEqual(judged.map(r => r.quality), ['teyit', 'teyit']);
  ok(await f.post(`/surumler/${id}/hazirla`));
  const open = f.db.prepare("SELECT c.message,m.application_id FROM confirmations c JOIN document_file_meta m ON m.file_id=c.ref_id WHERE c.kind='vektor_kalite' AND c.status='acik'").all();
  const byApp = Object.fromEntries(open.map(c => [c.application_id, JSON.parse(c.message.slice(c.message.indexOf('{')))]));
  for (const kind of Object.keys(apps)) {
    const report = byApp[apps[kind]];
    assert.ok(report, `${kind}: vektör kalite teyidi açılmalı`);
    assert.ok(report.reasons.includes('oran_bozuldu'));
    assert.ok(report.reasons.some(r => /En ince çizgi 0\.[0-7]\d* mm/.test(r)), JSON.stringify(report.reasons));
    assert.equal(report.vectorQuality.measurementSize, 'target');
    assert.equal(report.vectorQuality.iou, null);
  }
  assert.deepEqual(byApp[apps.desen_kaynak].reasons, byApp[apps.desen_kaynak_vektor].reasons);
});

test('G53-4 all three forms print the recipe label of the product, not its key', async t => {
  const f = await fixture(t), o = await f.order(), id = o.version.id, lineId = o.version.lines[0].id;
  const source = ok(await f.upload(id), 201);
  ok(await f.measure(lineId, { desenDosyaId: source.id }), 201);
  const files = ok(await f.post(`/surumler/${id}/hazirla`));
  for (const kind of ['onay_formu', 'uretim_formu', 'baski_formu']) {
    const text = (await pdfText(await formOf(f, files, kind))).join('\n');
    assert.match(text, /Tişört/, kind);
    assert.doesNotMatch(text, /\btisort\b/, kind);
  }
});

// Dimension label rectangles (the light-blue fill) on every page of a rendered form.
async function labelRects(buffer) {
  const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await lib.getDocument({ data: Uint8Array.from(buffer), isEvalSupported: false, verbosity: 0 }).promise;
  const pages = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n), ops = await page.getOperatorList(), rects = [];
      // PDFKit writes the rectangle, then its fill colour, then the fill.
      let path = null;
      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i], args = ops.argsArray[i];
        if (fn === lib.OPS.constructPath) path = args;
        else if (fn === lib.OPS.setFillRGBColor && path && Array.from(args).join() === '148,220,255' && Array.from(path[0]).join() === '19') {
          const [x0, y0, x1, y1] = Array.from(path[2]);
          rects.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
          path = null;
        }
      }
      pages.push({ rects, width: page.view[2], height: page.view[3] });
    }
  } finally { await doc.destroy(); }
  return pages;
}
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test('G53-5 dimension labels never overlap and stay on the page in all three forms', async () => {
  const pdf = require('../agent/siparis/pdf');
  // Invented back view: a small neck print just above a wide back print (the EXE layout), plus a label at the right edge.
  const canvas = require('@napi-rs/canvas').createCanvas(1478, 794), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 1478, 794); ctx.fillStyle = '#222222'; ctx.fillRect(784, 61, 676, 657);
  const back = { fileId: 7, view: 'arka', mime: 'image/png', buffer: canvas.toBuffer('image/png') };
  const placement = box => ({ fileId: 7, view: 'arka', page: 1, rasterWidth: 1478, rasterHeight: 794, box, swapAxes: false });
  const order = () => ({ orderNo: 'G53-T1', name: 'Örnek', version: 1, date: '21.11.2026', deliveryDate: 'Teslim tarihi belirtilmedi', description: [],
    lines: [{ id: '1', product: 'Tişört', color: 'Siyah', fabric: 'Örnek kumaş', quantity: 1, sizes: { M: 1 }, images: { back } }],
    applications: [
      { type: 'baski', position: 'ense', width_mm: 28, height_mm: 21, lineIds: ['1'], placement: placement({ x: 1116, y: 103, w: 23, h: 17 }) },
      { type: 'baski', position: 'sirt', width_mm: 487, height_mm: 379, lineIds: ['1'], placement: placement({ x: 922, y: 172, w: 393, h: 306 }) },
      { type: 'baski', position: 'kapuson', width_mm: 120, height_mm: 40, lineIds: ['1'], placement: placement({ x: 1380, y: 600, w: 95, h: 60 }) }] });
  for (const render of [pdf.renderProductionForm, pdf.renderApprovalForm, pdf.renderPrintForm]) {
    const pages = await labelRects(await render(order()));
    const rects = pages.flatMap(p => p.rects);
    assert.equal(rects.length, 6, render.name);
    for (const page of pages) for (const r of page.rects) {
      assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= page.width + 0.01 && r.y + r.h <= page.height + 0.01, `${render.name} sayfa dışı`);
      for (const o of page.rects) if (o !== r) assert.ok(!overlaps(r, o), `${render.name}: ${JSON.stringify(r)} ${JSON.stringify(o)}`);
    }
  }
});

// Product pictures drawn on a page: [width, height] of every image except small ones (logos stay out by size).
async function pictures(buffer, page = 1) {
  const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await lib.getDocument({ data: Uint8Array.from(buffer), isEvalSupported: false, verbosity: 0 }).promise;
  try {
    const ops = await (await doc.getPage(page)).getOperatorList(), out = [];
    let transform = null;
    for (let i = 0; i < ops.fnArray.length; i++) {
      if (ops.fnArray[i] === lib.OPS.transform) transform = Array.from(ops.argsArray[i]);
      if (ops.fnArray[i] === lib.OPS.paintImageXObject && transform) out.push({ x: transform[4], w: Math.abs(transform[0]), h: Math.abs(transform[3]) });
    }
    return out;
  } finally { await doc.destroy(); }
}
// Invented mockup: two dark garments side by side on white, 1478 x 794 like a two-view upload.
function twoGarments() {
  const canvas = require('@napi-rs/canvas').createCanvas(1478, 794), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 1478, 794);
  ctx.fillStyle = '#202020'; ctx.fillRect(12, 60, 681, 659); ctx.fillRect(784, 61, 676, 657);
  return canvas.toBuffer('image/png');
}
function measuredOn(f, appId, fileId, view, box, { pairing = ['on', 'arka'] } = {}) {
  const views = [{ page: 1, index: 0, view: pairing[0], productBoxPx: { x: 12, y: 60, w: 681, h: 659 } },
    { page: 1, index: 1, view: pairing[1], productBoxPx: { x: 784, y: 61, w: 676, h: 657 } }];
  const index = views.findIndex(v => v.view === view);
  f.db.prepare('UPDATE applications SET measure_source=?,needs_confirmation=0 WHERE id=?').run(JSON.stringify({ method: 'otomatik',
    gorselFileId: fileId, selectedView: view, selectedPage: 1, rasterWidth: 1478, rasterHeight: 794, designBoxPx: box, desenFileId: null,
    productBoxPx: views[Math.max(0, index)].productBoxPx, matchConfidence: 0.9, selectedProductIndex: Math.max(0, index), views }), appId);
  f.db.prepare("UPDATE confirmations SET status='cozuldu' WHERE kind='olcu' AND ref_table='applications' AND ref_id=?").run(appId);
}
async function twoViewOrder(f, { both = true, pairing } = {}) {
  const o = await f.order(), id = o.version.id, lineId = o.version.lines[0].id, picture = twoGarments();
  const front = ok(await f.upload(id, { kind: 'urun_gorsel', lineId, gorunum: 'on', name: 'on.png', buffer: picture }), 201);
  const back = both ? ok(await f.upload(id, { kind: 'urun_gorsel', lineId, gorunum: 'arka', name: 'arka.png', buffer: picture }), 201) : null;
  const chest = ok(await f.post(`/satirlar/${lineId}/uygulamalar`, { kind: 'baski', position: 'sol_gogus', width_mm: 113, height_mm: 46 }), 201);
  const neck = back && ok(await f.post(`/satirlar/${lineId}/uygulamalar`, { kind: 'baski', position: 'sirt', width_mm: 487, height_mm: 379 }), 201);
  // Background measurement of the invented picture finishes first; then the recorded pairing is set.
  await documents.settled();
  measuredOn(f, chest.id, front.id, 'on', { x: 416, y: 220, w: 91, h: 37 }, { pairing });
  if (back) measuredOn(f, neck.id, back.id, 'arka', { x: 922, y: 172, w: 393, h: 306 }, { pairing });
  const preview = ok(await f.post(`/surumler/${id}/onizleme`));
  return Object.fromEntries(preview.formlar.map(x => [x.kind, Buffer.from(x.pdf, 'base64')]));
}

test('G53-6 one picture uploaded as front and back prints one garment per slot; measurements follow the cut', async t => {
  const f = await fixture(t), forms = await twoViewOrder(f);
  for (const kind of ['uretim_formu', 'onay_formu', 'baski_formu']) {
    const drawn = await pictures(forms[kind]);
    assert.equal(drawn.filter(p => Math.abs(p.w / p.h - 1478 / 794) < 0.05).length, 0, `${kind}: bütün görsel basılmamalı`);
    // One garment per slot (the approval form also carries its logo).
    assert.equal(drawn.filter(p => Math.abs(p.w / p.h - 1) < 0.1).length, 2, `${kind}: ${JSON.stringify(drawn)}`);
  }
  // Both measurements are still drawn, each with two labels, inside the page.
  const labels = (await labelRects(forms.uretim_formu))[0].rects;
  assert.equal(labels.length, 4);
});

test('G53-6 a single upload holding both garments fills ÖN and ARKA from the same picture', async t => {
  const f = await fixture(t), forms = await twoViewOrder(f, { both: false });
  const shown = (await pictures(forms.uretim_formu)).filter(p => p.w > 60);
  assert.equal(shown.length, 2);
  for (const p of shown) assert.ok(Math.abs(p.w / p.h - 1) < 0.1, `${p.w}x${p.h}`);
});

test('G53-6 an undecided front/back pairing keeps the whole picture visible', async t => {
  const f = await fixture(t), forms = await twoViewOrder(f, { pairing: ['teyit', 'teyit'] });
  const shown = (await pictures(forms.uretim_formu)).filter(p => p.w > 60);
  assert.ok(shown.length >= 1);
  for (const p of shown) assert.ok(Math.abs(p.w / p.h - 1478 / 794) < 0.05, `${p.w}x${p.h}`);
});

test('G53-7 a manual size keeps an optional short source note: stored, audited, printed small beside the size', async t => {
  const f = await fixture(t), o = await f.order(), id = o.version.id, lineId = o.version.lines[0].id;
  const source = ok(await f.upload(id), 201);
  const app = ok(await f.measure(lineId, { kind: 'baski', position: 'sag_kol', desenDosyaId: source.id }), 201);
  const appId = (app.application || app).id;
  const patch = body => f.request(`/uygulamalar/${appId}`, { method: 'PATCH', token: f.token, body });
  // Not a measurement field on its own; bounded, single-line text.
  assert.equal((await patch({ kaynak: 'atölye ölçüsü' })).status, 400);
  assert.equal((await patch({ width_mm: 150, height_mm: 9, elleTeyit: true, kaynak: 'x'.repeat(61) })).status, 400);
  assert.equal((await patch({ width_mm: 150, height_mm: 9, elleTeyit: true, kaynak: 12 })).status, 400);
  ok(await patch({ width_mm: 150, height_mm: 9, elleTeyit: true, kaynak: '  atölye   ölçüsü ' }));
  const row = f.db.prepare('SELECT measure_source FROM applications WHERE id=?').get(appId);
  assert.equal(JSON.parse(row.measure_source).kaynak, 'atölye ölçüsü');
  const logged = f.db.prepare("SELECT * FROM audit_log WHERE action='uygulama_elle_olcu' ORDER BY id DESC").get();
  assert.match(JSON.stringify(logged), /atölye ölçüsü/);
  const files = ok(await f.post(`/surumler/${id}/hazirla`));
  const text = (await pdfText(await formOf(f, files, 'uretim_formu'))).join('\n');
  assert.match(text, /Sağ kol · 15 × 0,9\s+cm\s+atölye ölçüsü/);
  assert.match(text, /atölye ölçüsü/);
  // A new manual size without a note drops the old note: it described the previous size.
  ok(await patch({ width_mm: 140, height_mm: 9, elleTeyit: true }));
  assert.equal(JSON.parse(f.db.prepare('SELECT measure_source FROM applications WHERE id=?').get(appId).measure_source).kaynak, undefined);
});
