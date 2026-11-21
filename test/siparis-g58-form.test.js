'use strict';
// G58: findings from the five-product end-to-end run. Invented data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const parse = require('pdf-parse');
const { renderPrintForm, renderEmbroideryForm } = require('../agent/siparis/pdf');
const { garmentCrop } = require('../agent/siparis/documents');
const { makeExampleOrder } = require('./fixtures/siparis/example-order');

const text = async buffer => (await parse(buffer)).text;

test('G58 workshop form without notes, description or missing items prints no empty "Ürün Açıklaması:" heading', async () => {
  const order = makeExampleOrder({ twoColors: false });
  order.description = [];
  for (const line of order.lines) delete line.note;
  const print = await text(await renderPrintForm(order));
  assert.doesNotMatch(print, /Ürün Açıklaması/);
  assert.match(print, /Ürün Görseli:/);
  assert.doesNotMatch(await text(await renderEmbroideryForm(order)), /Ürün Açıklaması/);
  // Any item brings the heading back with it.
  order.lines[0].note = 'Sentetik kalıp notu.';
  assert.match((await text(await renderPrintForm(order))).replace(/\s+/g, ' '), /Ürün Açıklaması:.*Sentetik kalıp notu\./);
  order.lines[0].note = undefined;
  order.applications = [order.applications[0], { ...order.applications[0], width_mm: 0, height_mm: 0, pending: true, preview: undefined }];
  assert.match((await text(await renderPrintForm(order))).replace(/\s+/g, ' '), /Ürün Açıklaması:.*Eksik:/);
});

// Invented two-garment sheet: the garments touch at x = 742, like a tight two-view mockup.
const W = 1491, H = 1055;
const app = (views, view = 'on') => ({ measure_source: JSON.stringify({ method: 'otomatik', gorselFileId: 7, selectedView: view, selectedPage: 1,
  rasterWidth: W, rasterHeight: H, views }) });
const sideBySide = (left = 'on', right = 'arka') => [
  { page: 1, index: 0, view: left, productBoxPx: { x: 18, y: 124, w: 724, h: 871 } },
  { page: 1, index: 1, view: right, productBoxPx: { x: 742, y: 123, w: 732, h: 873 } }];

test('G58 a garment crop keeps its margin but stops at the neighbouring garment', () => {
  const front = garmentCrop([app(sideBySide())], 7, 'on');
  const back = garmentCrop([app(sideBySide())], 7, 'arka');
  // No sleeve of the other garment in either slot.
  assert.ok(front.x + front.w <= 742, JSON.stringify(front));
  assert.ok(back.x >= 742, JSON.stringify(back));
  // Margin is kept where nothing is next to the garment (4 % of 871 = 35 px).
  assert.equal(front.x, 0);
  assert.equal(front.y, 124 - 35);
  assert.equal(front.y + front.h, Math.min(H, 124 + 871 + 35));
  assert.equal(back.x + back.w, Math.min(W, 742 + 732 + 35));
  // Mirrored order: the front on the right stops at the back on its left.
  const mirrored = garmentCrop([app(sideBySide('arka', 'on'))], 7, 'on');
  assert.ok(mirrored.x >= 742, JSON.stringify(mirrored));
});

test('G58 stacked garments: the crop stops at the garment above or below', () => {
  const views = [
    { page: 1, index: 0, view: 'on', productBoxPx: { x: 100, y: 20, w: 400, h: 480 } },
    { page: 1, index: 1, view: 'arka', productBoxPx: { x: 110, y: 505, w: 400, h: 480 } }];
  const front = garmentCrop([app(views)], 7, 'on'), back = garmentCrop([app(views)], 7, 'arka');
  assert.ok(front.y + front.h <= 505, JSON.stringify(front));
  assert.ok(back.y >= 500, JSON.stringify(back));
  // Sideways margin is untouched by a garment that is only above or below.
  assert.equal(front.x, 100 - Math.round(480 * .04));
});

test('G58 an undecided pairing still gives no crop', () => {
  assert.equal(garmentCrop([app(sideBySide('teyit', 'teyit'))], 7, 'on'), null);
});
