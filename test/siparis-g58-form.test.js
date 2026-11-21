'use strict';
// G58: findings from the five-product end-to-end run. Invented data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const parse = require('pdf-parse');
const { renderPrintForm, renderEmbroideryForm } = require('../agent/siparis/pdf');
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
