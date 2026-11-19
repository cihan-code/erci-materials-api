'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const parse = require('pdf-parse');
const { PNG } = require('pngjs');
const { measureApplication, designBoxFromPng } = require('../agent/siparis/measure');
const { renderProductionForm, renderApprovalForm, renderPrintForm, renderEmbroideryForm } = require('../agent/siparis/pdf');
const { makeExampleOrder, raster } = require('./fixtures/siparis/example-order');

const renders = { production: renderProductionForm, approval: renderApprovalForm, print: renderPrintForm, embroidery: renderEmbroideryForm };

async function extract(buffer) {
  const pages = [];
  const result = await parse(buffer, {
    pagerender: async page => {
      const content = await page.getTextContent();
      const pageText = content.items.map(item => item.str).join('\n');
      pages.push(pageText);
      return pageText;
    },
  });
  return { ...result, pages };
}

test('kabul: 280 px = 56 cm; en ve boy bağımsız, en yakın mm', () => {
  const result = measureApplication({ refLengthPx: 280, refLengthCm: 56, designBoxPx: { w: 140, h: 60 }, imageKind: 'flat' });
  assert.equal(result.width_mm, 280);
  assert.equal(result.height_mm, 120);
  assert.equal(result.scaleCmPerPx, 0.2);
  assert.equal(result.needsConfirmation, false);
  const rounded = measureApplication({ refLengthPx: 3, refLengthCm: 1, designBoxPx: { w: 10, h: 20 }, imageKind: 'flat' });
  assert.equal(rounded.width_mm, 33);
  assert.equal(rounded.height_mm, 67);
  const tiny = measureApplication({ refLengthPx: 100, refLengthCm: 1, designBoxPx: { w: 1, h: 10 }, imageKind: 'flat' });
  assert.equal(tiny.width_mm, 0); // Nearest mm can be zero for submillimetre art.
  assert.equal(tiny.height_mm, 1);
});

test('fotoğraf, perspektif ve kırışıklık ayrı gerekçelerle teyit ister', () => {
  for (const extra of [{ imageKind: 'photo' }, { flags: { perspective: true } }, { flags: { wrinkled: true } }]) {
    const result = measureApplication({ refLengthPx: 280, refLengthCm: 56, designBoxPx: { w: 140, h: 60 }, imageKind: 'flat', ...extra });
    assert.equal(result.needsConfirmation, true);
    assert.ok(result.reason.length > 5);
    assert.equal(result.width_mm, 280);
  }
  const all = measureApplication({ refLengthPx: 0, refLengthCm: 56, designBoxPx: { w: 140, h: 60 }, imageKind: 'photo', flags: { perspective: true, wrinkled: true } });
  assert.equal(all.reasons.length, 4);
});

test('eksik/sıfır/geçersiz referans gerçek ölçü üretmez', () => {
  for (const [refLengthPx, refLengthCm] of [[undefined, 56], [280, undefined], [0, 56], [280, 0], [-1, 2], [Infinity, 2], [10, NaN]]) {
    const result = measureApplication({ refLengthPx, refLengthCm, designBoxPx: { w: 140, h: 60 }, imageKind: 'flat' });
    assert.equal(result.needsConfirmation, true);
    assert.equal(result.width_mm, null);
    assert.equal(result.height_mm, null);
    assert.match(result.reason, /Referans/);
  }
});

test('geçersiz desen kutusu ve hesap taşması reddedilir', () => {
  for (const designBoxPx of [null, { w: 0, h: 1 }, { w: 2, h: -1 }, { w: NaN, h: 2 }]) {
    assert.throws(() => measureApplication({ designBoxPx }), RangeError);
  }
  assert.throws(() => measureApplication({ refLengthPx: 1, refLengthCm: Number.MAX_VALUE, designBoxPx: { w: 2, h: 2 }, imageKind: 'flat' }), RangeError);
});

test('PNG sınır kutusu: beyaz/saydam dışlanır, yarı saydam renk dahil edilir', () => {
  const png = new PNG({ width: 12, height: 10 });
  png.data.fill(255);
  function pixel(x, y, rgba) { png.data.set(rgba, (y * png.width + x) * 4); }
  pixel(0, 0, [0, 0, 0, 0]);
  pixel(3, 2, [0, 0, 0, 255]);
  pixel(7, 6, [40, 80, 120, 128]);
  pixel(10, 9, [255, 255, 255, 128]);
  assert.deepEqual(designBoxFromPng(PNG.sync.write(png)), { x: 3, y: 2, w: 5, h: 5 });
});

test('boş PNG null döner; köşe pikseli 1×1 kutu verir; bozuk PNG reddedilir', () => {
  assert.equal(designBoxFromPng(raster(3, 3, () => [255, 255, 255, 255])), null);
  assert.equal(designBoxFromPng(raster(3, 3, () => [10, 20, 30, 0])), null);
  assert.deepEqual(designBoxFromPng(raster(3, 3, (x, y) => [0, 0, 0, x === 2 && y === 2 ? 255 : 0])), { x: 2, y: 2, w: 1, h: 1 });
  assert.throws(() => designBoxFromPng(Buffer.from('PNG değil')));
});

test('dört PDF Buffer; iki renk onayı ve iki sayfalı atölye formları', async () => {
  const order = makeExampleOrder();
  const expectedPages = { production: 2, approval: 3, print: 2, embroidery: 2 };
  for (const [name, render] of Object.entries(renders)) {
    const buffer = await render(order);
    assert.ok(Buffer.isBuffer(buffer));
    assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
    const result = await extract(buffer);
    assert.equal(result.numpages, expectedPages[name], name);
    for (const page of result.pages) assert.match(page, /MRC-T001 · sürüm 2/);
    assert.match(result.text, /[İıŞşğ]/, name);
  }
});

test('müşteri ve atölye ölçüleri tek kaynaktan gelir; en/boy yer değiştirmez', async () => {
  const order = makeExampleOrder({ twoColors: false });
  order.applications[0].width_mm = 281;
  order.applications[0].height_mm = 123;
  for (const render of [renderProductionForm, renderApprovalForm, renderPrintForm]) {
    const result = await extract(await render(order));
    assert.match(result.text, /28,1 × 12,3 cm/);
    assert.doesNotMatch(result.text, /12\.3 × 28\.1/);
  }
  for (const render of [renderProductionForm, renderApprovalForm, renderEmbroideryForm]) {
    const result = await extract(await render(order));
    assert.match(result.text, /7,5 × 4 cm/);
  }
});

test('kabul ölçüsü 28 × 12 cm üretim/onay/baskıda aynıdır; toplamlar bedenlerden hesaplanır', async () => {
  const order = makeExampleOrder();
  for (const render of [renderProductionForm, renderApprovalForm, renderPrintForm]) {
    const { text } = await extract(await render(order));
    assert.match(text, /28 × 12 cm/);
  }
  const production = await extract(await renderProductionForm(order));
  assert.match(production.pages[0], /Toplam adet: 10 · Sipariş toplamı: 16/);
  assert.match(production.pages[1], /Toplam adet: 6 · Sipariş toplamı: 16/);
  const approval = await extract(await renderApprovalForm(order));
  assert.match(approval.pages[0], /XS:3  S:2  M:4.*Toplam:10/);
  assert.match(approval.pages[1], /XS:1  S:0  M:2.*Toplam:6/);
  assert.match(approval.pages[2], /Şartlar ve Koşullar/);
  assert.match((await extract(await renderPrintForm(order))).pages[0], /Toplam adet: 16/);
});

test('uygulama türü yoksa doğrudan null döner', () => {
  const order = makeExampleOrder();
  order.applications = order.applications.filter(app => app.type !== 'nakis');
  assert.equal(renderEmbroideryForm(order), null);
  order.applications = [];
  assert.equal(renderPrintForm(order), null);
});

test('satıra özel uygulama yalnız ilgili renk ve atölye satırında görünür', async () => {
  const order = makeExampleOrder();
  order.applications[0].lineIds = ['ornek-kirmizi'];
  const approval = await extract(await renderApprovalForm(order));
  assert.doesNotMatch(approval.pages[0], /28 × 12 cm/);
  assert.match(approval.pages[1], /28 × 12 cm/);
  const workshop = await extract(await renderPrintForm(order));
  assert.doesNotMatch(workshop.pages[0], /Gece Mavisi/);
  assert.match(workshop.pages[0], /Kiremit/);
  assert.match(workshop.pages[0], /Toplam adet: 6/);
});

test('aynı renkteki iki model tek onay sayfasında toplanır', async () => {
  const order = makeExampleOrder();
  order.lines[1].color = order.lines[0].color;
  order.lines[1].product = 'Örnek Sweat';
  const result = await extract(await renderApprovalForm(order));
  assert.equal(result.numpages, 2);
  assert.match(result.pages[0], /Örnek Tişört/);
  assert.match(result.pages[0], /Örnek Sweat/);
  assert.match(result.pages[0], /XS:4  S:2  M:6.*Toplam:16/);
});

test('options.brand logo/şartlar ve Türkçe Ş İ ğ bütün formlarda desteklenir', async () => {
  const order = makeExampleOrder({ twoColors: false });
  order.lines[0].product = 'Şİğ Örnek Tişört';
  const options = { brand: { logo: raster(30, 20, () => [90, 10, 120, 255]), termsText: 'Şirket İzni: Doğru ölçü, müşteri onayı.\nÖzel şartların tamamı.' } };
  for (const render of Object.values(renders)) {
    const result = await extract(await render(order, options));
    assert.match(result.text, /Şİğ Örnek Tişört/);
    if (render === renderApprovalForm) {
      assert.match(result.text, /Şirket İzni: Doğru ölçü/);
      assert.match(result.text, /Özel şartların tamamı/);
      assert.doesNotMatch(result.text, /yer tutucudur/);
    }
  }
});

test('uzun açıklamalar ve çok uygulama kaybolmadan devam sayfalarına akar', async () => {
  const order = makeExampleOrder({ twoColors: false });
  order.description = Array.from({ length: 45 }, (_, i) => `Açıklama ${i}: Ölçü ve dikiş kontrol edilecek.`);
  order.applications = Array.from({ length: 8 }, (_, i) => ({ ...order.applications[0], width_mm: 280 + i }));
  const production = await extract(await renderProductionForm(order));
  assert.match(production.text, /Açıklama 44/);
  assert.match(production.text, /28,7 × 12 cm/);
  assert.ok(production.numpages > 1);
  const workshop = await extract(await renderPrintForm(order));
  assert.match(workshop.text, /Açıklama 44/);
  for (let i = 0; i < 8; i++) assert.ok(workshop.text.includes(`${String((280 + i) / 10).replace('.', ',')} × 12 cm`));
  for (const page of workshop.pages) assert.match(page, /MRC-T001 · sürüm 2/);
});

test('eksik ölçü, bozuk görsel, yanlış beden/adet ve kopuk satır bağları reddedilir', async () => {
  const mutations = [
    order => { order.applications[0].width_mm = null; },
    order => { order.applications[0].height_mm = 12.4; },
    order => { order.lines[0].sizes.XS = -1; },
    order => { order.lines[0].sizes.unknown = 'invalid'; },
    order => { order.applications[0].lineIds = ['yok']; },
    order => { order.applications[0].type = 'toString'; },
    order => { order.lines[1].id = order.lines[0].id; },
    order => { order.lines[0].images.front = Buffer.from('bozuk görsel'); },
  ];
  for (const mutate of mutations) {
    const order = makeExampleOrder(); mutate(order);
    await assert.rejects(renderProductionForm(order));
  }
});

test('G14-8 all forms show totals without sizes and include other size quantities',async()=> {
  for (const render of Object.values(renders)) {
    const order=makeExampleOrder({twoColors:false});
    order.lines[0].sizes={};order.lines[0].quantity=17;
    const plain=await extract(await render(order));
    assert.match(plain.text,/Toplam(?: adet)?:\s*17/);assert.doesNotMatch(plain.text,/XS/);
    order.lines[0].sizes={'5XL':10,'7-8 yaş':7};
    const other=await extract(await render(order));assert.match(other.text,/Diğer/);assert.match(other.text,/17/);
  }
});
