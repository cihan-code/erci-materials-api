'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseInvoiceDescription, fabricKey, defaultFabricFor, matchInvoiceLine } = require('../agent/siparis/matching');

// Invented data only: "Örnek Kulüp" orders MRC-T001…, purchases PO-…
let seq = 0;
const line = (description, extra = {}) => ({ sourceInvoiceId: 'FAT-T1', sourceLineId: String(++seq), description, unit: 'kg', ...extra });
const need = (orderLineId, productKey, colorName, shortageMilli, extra = {}) =>
  ({ orderLineId, orderNo: 'MRC-T' + String(orderLineId).padStart(3, '0'), productKey, fabricKey: null, colorName, shortageMilli, ...extra });
const said = r => r.reasons.join(' ');

test('kabul testi 4: 7 kg siyah and 35 kg pembe needs take 8 kg and 40 kg lines; surplus stays unallocated', () => {
  const needs = [need(1, 'sweat', 'Siyah', 20 * 350), need(2, 'sweat', 'Pembe', 100 * 350)];
  const black = matchInvoiceLine({ line: line('Siyah şardonlu 3 iplik 8 kg', { qtyMilli: 8000 }), openNeeds: needs });
  const pink = matchInvoiceLine({ line: line('Pembe şardonlu 3 iplik 40 kg', { qtyMilli: 40000 }), openNeeds: needs });
  assert.equal(black.status, 'eslesti');
  assert.equal(pink.status, 'eslesti');
  assert.equal(black.fabricKey, 'sardonlu_3_iplik|siyah');
  assert.equal(pink.fabricKey, 'sardonlu_3_iplik|pembe');
  assert.deepEqual(black.allocations, [{ orderLineId: 1, qtyMilli: 7000 }]);
  assert.deepEqual(pink.allocations, [{ orderLineId: 2, qtyMilli: 35000 }]);
  assert.equal(black.unallocatedMilli, 1000);
  assert.equal(pink.unallocatedMilli, 5000);
  assert.match(said(black), /MRC-T001 için 7 kg ayrıldı/);
  assert.match(said(pink), /5 kg dağıtılmadan kullanılabilir stoğa kalır/);
});

test('belirsiz satır: "kumaş 10 kg" with two colour candidates for the same product goes to teyit', () => {
  const needs = [need(1, 'sweat', 'Siyah', 7000), need(2, 'sweat', 'Pembe', 35000)];
  const r = matchInvoiceLine({ line: line('kumaş 10 kg', { qtyMilli: 10000 }), openNeeds: needs });
  assert.equal(r.status, 'teyit');
  assert.deepEqual(r.allocations, []);
  assert.equal(r.unallocatedMilli, null);
  assert.match(said(r), /renk okunamadı/);
});

test('çelişen referans: reference points at the pembe order but the text says siyah → teyit, never the siyah order', () => {
  const needs = [need(1, 'sweat', 'Siyah', 7000), need(2, 'sweat', 'Pembe', 35000, { purchaseRef: 'PO-12' })];
  const text = 'Siyah şardonlu 3 iplik 8 kg';
  const r = matchInvoiceLine({ line: line(text, { qtyMilli: 8000, purchaseRef: 'PO-12' }), openNeeds: needs });
  assert.equal(r.status, 'teyit');
  assert.deepEqual(r.allocations, []);
  assert.match(said(r), /Referans PO-12 MRC-T002 siparişini gösteriyor ama .*çelişiyor/);
  // Without the reference the same line would bind to the siyah order.
  assert.equal(matchInvoiceLine({ line: line(text, { qtyMilli: 8000 }), openNeeds: needs }).status, 'eslesti');
});

test('referans: a matching reference binds and lends the need colour; a reference with no open need is not re-routed', () => {
  const needs = [need(1, 'sweat', 'Siyah', 7000), need(2, 'sweat', 'Pembe', 35000, { purchaseRef: 'PO-12' })];
  const ok = matchInvoiceLine({ line: line('Şardonlu 3 iplik 40 kg', { qtyMilli: 40000, purchaseRef: 'po 12' }), openNeeds: needs });
  assert.equal(ok.status, 'eslesti');
  assert.equal(ok.fabricKey, 'sardonlu_3_iplik|pembe');
  assert.deepEqual(ok.allocations, [{ orderLineId: 2, qtyMilli: 35000 }]);
  assert.match(said(ok), /Referans po 12 açık ihtiyaçla eşleşti \(MRC-T002\)/);
  const byOrderNo = matchInvoiceLine({ line: line('Siyah şardonlu 3 iplik 5 kg', { qtyMilli: 5000, purchaseRef: 'MRC-T001' }), openNeeds: needs });
  assert.deepEqual(byOrderNo.allocations, [{ orderLineId: 1, qtyMilli: 5000 }]);
  const stale = matchInvoiceLine({ line: line('Siyah şardonlu 3 iplik 5 kg', { qtyMilli: 5000, purchaseRef: 'PO-99' }), openNeeds: needs });
  assert.equal(stale.status, 'teyit');
  assert.match(said(stale), /Referans PO-99 açık bir ihtiyaçla eşleşmedi/);
  const closed = [need(1, 'sweat', 'Siyah', 7000), need(2, 'sweat', 'Siyah', 0, { purchaseRef: 'PO-12' })];
  assert.equal(matchInvoiceLine({ line: line('Siyah şardonlu 3 iplik 5 kg', { qtyMilli: 5000, purchaseRef: 'PO-12' }), openNeeds: closed }).status, 'teyit');
});

test('varsayılan: "Lacivert 12 kg" with no fabric type binds to the polo need as lakost|lacivert', () => {
  const needs = [need(3, 'polo', 'Lacivert', 5000), need(4, 'sweat', 'Pembe', 9000)];
  const r = matchInvoiceLine({ line: line('Lacivert 12 kg', { qtyMilli: 12000 }), openNeeds: needs });
  assert.equal(r.status, 'eslesti');
  assert.equal(r.fabricKey, 'lakost|lacivert');
  assert.deepEqual(r.allocations, [{ orderLineId: 3, qtyMilli: 5000 }]);
  assert.equal(r.unallocatedMilli, 7000);
  assert.match(said(r), /ürün varsayılanı lakost kullanıldı/);
});

test('açık seçim önde: a polo with supren_30_1 chosen never falls back to the lakost default', () => {
  const needs = [need(5, 'polo', 'Lacivert', 6000, { fabricKey: 'supren_30_1|lacivert' })];
  const r = matchInvoiceLine({ line: line('Lacivert 12 kg', { qtyMilli: 12000 }), openNeeds: needs });
  assert.equal(r.status, 'eslesti');
  assert.equal(r.fabricKey, 'supren_30_1|lacivert');
  assert.match(said(r), /siparişte seçilen supren_30_1 kullanıldı/);
  // A lakost line is a different stock item: it is not reserved for this order.
  const lakost = matchInvoiceLine({ line: line('Lacivert lacoste 12 kg', { qtyMilli: 12000 }), openNeeds: needs });
  assert.equal(lakost.status, 'eslesti');
  assert.equal(lakost.fabricKey, 'lakost|lacivert');
  assert.deepEqual(lakost.allocations, []);
  assert.equal(lakost.unallocatedMilli, 12000);
});

test('normalleştirme: Turkish case and characters, fabric synonyms, colour dictionary', () => {
  const p = parseInvoiceDescription('ŞARDONLU ÜÇ İPLİK Gri Melanj 25,5 KG');
  assert.equal(p.fabricType, 'sardonlu_3_iplik');
  assert.equal(p.colorName, 'gri melanj');
  assert.equal(p.colorKey, 'gri_melanj');
  assert.equal(p.quantity, 25.5);
  assert.equal(p.unit, 'kg');
  assert.equal(p.qtyMilli, 25500);
  assert.deepEqual(p.issues, []);
  const types = ['şardonlu üç iplik', '3 iplik şardonlu', '30/1 süprem', 'süprem 30 / 1', 'LACOSTE', 'Lakost', 'KAŞKORSE', 'Ribana']
    .map(t => parseInvoiceDescription(t).fabricType);
  assert.deepEqual(types, ['sardonlu_3_iplik', 'sardonlu_3_iplik', 'supren_30_1', 'supren_30_1', 'lakost', 'lakost', 'kaskorse', 'ribana']);
  assert.equal(parseInvoiceDescription('KIRMIZI penye 3KG').colorName, 'kırmızı');
  assert.equal(parseInvoiceDescription('1.250,5 kg').qtyMilli, 1250500);
  assert.equal(parseInvoiceDescription('750 gr').qtyMilli, 750);
  assert.equal(fabricKey('lakost', 'Lacivert'), 'lakost|lacivert');
  assert.equal(fabricKey('Şardonlu 3 İplik', 'GRİ MELANJ'), 'sardonlu_3_iplik|gri_melanj');
  assert.equal(fabricKey('lakost', ''), null);
});

test('parser leaves partial or doubled facts unread instead of guessing', () => {
  const field = (t, f) => parseInvoiceDescription(t).issues.map(i => i.field).includes(f);
  assert.ok(field('Siyah 3 iplik 8 kg', 'fabricType'));
  assert.ok(field('Beyaz süprem 8 kg', 'fabricType'));
  assert.ok(field('Siyah-beyaz penye 8 kg', 'colorName'));
  assert.ok(field('Koyu lacivert lakost 8 kg', 'colorName'));
  assert.ok(field('Siyah penye 1.250 kg', 'quantity'));
  assert.ok(field('Siyah penye 2 x 20 kg', 'quantity'));
  assert.ok(field('Siyah penye 8 kg 9 kg', 'quantity'));
  const plain = parseInvoiceDescription('Siyah şardonlu 3 iplik 8 kg');
  assert.equal(plain.qtyMilli, 8000);
  assert.deepEqual(plain.unknownWords, []);
});

test('defaultFabricFor: sweat family, polo, tişört; nothing invented for other products', () => {
  assert.equal(defaultFabricFor('sweat'), 'sardonlu_3_iplik');
  assert.equal(defaultFabricFor('Sweatshirt'), 'sardonlu_3_iplik');
  assert.equal(defaultFabricFor('sweat_kapusonlu'), 'sardonlu_3_iplik');
  assert.equal(defaultFabricFor('polo'), 'lakost');
  assert.equal(defaultFabricFor('tisort'), 'supren_30_1');
  assert.equal(defaultFabricFor('Tişört'), 'supren_30_1');
  for (const k of ['polar', 'esofman', 'tam_fermuar', '', null]) assert.equal(defaultFabricFor(k), null);
});

test('unit and quantity: non-kg, unreadable or contradictory amounts go to teyit', () => {
  const needs = [need(1, 'sweat', 'Siyah', 7000)];
  const run = (text, extra) => matchInvoiceLine({ line: line(text, extra), openNeeds: needs });
  assert.match(said(run('Siyah şardonlu 3 iplik 8 m', { unit: 'm', qtyMilli: 8000 })), /Birim kg değil \(m\)/);
  assert.equal(run('Siyah şardonlu 3 iplik 8 m', { unit: 'kg', qtyMilli: 8000 }).status, 'teyit');
  assert.match(said(run('Siyah şardonlu 3 iplik', { qtyMilli: null })), /Miktar okunamadı/);
  assert.equal(run('Siyah şardonlu 3 iplik 1.250 kg', { qtyMilli: null }).status, 'teyit');
  assert.match(said(run('Siyah şardonlu 3 iplik 8 kg', { qtyMilli: 9000 })), /Miktar çelişiyor/);
  assert.equal(run('Siyah şardonlu 3 iplik 8 kg', { qtyMilli: 8000.5 }).status, 'teyit');
  assert.equal(run('Siyah şardonlu 3 iplik 8 kg', { qtyMilli: 0 }).status, 'teyit');
  const fromText = run('Siyah şardonlu 3 iplik 6 kg', { unit: undefined, qtyMilli: undefined });
  assert.equal(fromText.status, 'eslesti');
  assert.deepEqual(fromText.allocations, [{ orderLineId: 1, qtyMilli: 6000 }]);
  assert.equal(fromText.unallocatedMilli, 0);
});

test('single candidate boundaries: exact fill, short delivery, closed need ignored, no open need goes to stock', () => {
  const needs = [need(1, 'sweat', 'Siyah', 7000), need(2, 'sweat', 'Siyah', 0)];
  const exact = matchInvoiceLine({ line: line('Siyah şardonlu 3 iplik 7 kg', { qtyMilli: 7000 }), openNeeds: needs });
  assert.deepEqual([exact.status, exact.allocations, exact.unallocatedMilli], ['eslesti', [{ orderLineId: 1, qtyMilli: 7000 }], 0]);
  const short = matchInvoiceLine({ line: line('Siyah şardonlu 3 iplik 5 kg', { qtyMilli: 5000 }), openNeeds: needs });
  assert.deepEqual([short.allocations, short.unallocatedMilli], [[{ orderLineId: 1, qtyMilli: 5000 }], 0]);
  const none = matchInvoiceLine({ line: line('Bordo şardonlu 3 iplik 5 kg', { qtyMilli: 5000 }), openNeeds: needs });
  assert.deepEqual([none.status, none.fabricKey, none.allocations, none.unallocatedMilli], ['eslesti', 'sardonlu_3_iplik|bordo', [], 5000]);
  const typeless = matchInvoiceLine({ line: line('Bordo 5 kg', { qtyMilli: 5000 }), openNeeds: needs });
  assert.equal(typeless.status, 'teyit');
});

test('several candidates: teyit without purchase allocation; purchase allocation drives the split', () => {
  const needs = [need(1, 'sweat', 'Siyah', 7000), need(2, 'sweat', 'Siyah', 10000)];
  const text = 'Siyah şardonlu 3 iplik 20 kg';
  const bare = matchInvoiceLine({ line: line(text, { qtyMilli: 20000 }), openNeeds: needs });
  assert.equal(bare.status, 'teyit');
  assert.match(said(bare), /Birden çok açık ihtiyaç aynı kumaşı bekliyor \(MRC-T001, MRC-T002\)/);
  const planned = matchInvoiceLine({ line: line(text, { qtyMilli: 20000 }), openNeeds: needs,
    purchaseAllocations: [{ orderLineId: 1, qtyMilli: 9000 }, { orderLineId: 2, qtyMilli: 8000 }] });
  assert.equal(planned.status, 'eslesti');
  assert.deepEqual(planned.allocations, [{ orderLineId: 1, qtyMilli: 7000 }, { orderLineId: 2, qtyMilli: 8000 }]);
  assert.equal(planned.unallocatedMilli, 5000);
  assert.match(said(planned), /MRC-T001 tahsisi 9 kg, açık ihtiyaç 7 kg/);
  const over = matchInvoiceLine({ line: line(text, { qtyMilli: 20000 }), openNeeds: needs,
    purchaseAllocations: [{ orderLineId: 1, qtyMilli: 12000 }, { orderLineId: 2, qtyMilli: 10000 }] });
  assert.equal(over.status, 'teyit');
  const stranger = matchInvoiceLine({ line: line(text, { qtyMilli: 20000 }), openNeeds: needs,
    purchaseAllocations: [{ orderLineId: 99, qtyMilli: 5000 }] });
  assert.equal(stranger.status, 'teyit');
  const one = matchInvoiceLine({ line: line('Siyah şardonlu 3 iplik 4 kg', { qtyMilli: 4000 }), openNeeds: needs,
    purchaseAllocations: [{ orderLineId: 2, qtyMilli: 10000 }] });
  assert.deepEqual([one.status, one.allocations], ['eslesti', [{ orderLineId: 2, qtyMilli: 4000 }]]);
  const otherPurchase = matchInvoiceLine({ line: line(text, { qtyMilli: 20000, purchaseRef: 'MRC-T001' }), openNeeds: needs,
    purchaseAllocations: [{ purchaseRef: 'PO-77', orderLineId: 2, qtyMilli: 5000 }] });
  assert.deepEqual(otherPurchase.allocations, [{ orderLineId: 1, qtyMilli: 7000 }]);
});

test('ambiguous candidates: near colour, need without fabric, unread fabric word, contradictory line fields', () => {
  const run = (text, needs, extra = {}) => matchInvoiceLine({ line: line(text, { qtyMilli: 5000, ...extra }), openNeeds: needs });
  const maybe = /MRC-T00\d için kumaş, renk ya da açık miktar net değil/;
  assert.match(said(run('Gri şardonlu 3 iplik 5 kg', [need(1, 'sweat', 'Gri Melanj', 7000)])), maybe);
  assert.match(said(run('Siyah şardonlu 3 iplik 5 kg', [need(1, 'sweat', 'Siyah', 7000), need(2, 'polar', 'Siyah', 4000)])), maybe);
  assert.match(said(run('Siyah şardonlu 3 iplik 5 kg', [need(1, 'sweat', 'Siyah', 7000), need(2, 'sweat', null, 4000)])), maybe);
  assert.match(said(run('Siyah şardonlu 3 iplik 5 kg', [need(1, 'sweat', 'Siyah', 7000), need(2, 'sweat', 'Siyah', undefined)])), maybe);
  assert.match(said(run('Siyah şardonlu 3 iplik 5 kg', [need(1, 'sweat', 'Siyah', 7000, { fabricKey: 'sardonlu_3_iplik|pembe' })])), maybe);
  const unread = run('Siyah viskon 5 kg', [need(1, 'sweat', 'Siyah', 7000)]);
  assert.equal(unread.status, 'teyit');
  assert.match(said(unread), /tanınmayan sözcük var \("viskon"\)/);
  // Polar is a fabric type since G19; "pike" alone (lakost or raşel?) is the open partial name now.
  assert.match(said(run('Siyah pike 5 kg', [need(1, 'sweat', 'Siyah', 7000)])), /Kumaş türü net değil: "pike"/);
  assert.deepEqual(run('Siyah polar 5 kg', [need(1, 'sweat', 'Siyah', 7000)]).allocations, [], 'polar never fills a şardonlu need');
  assert.match(said(run('Siyah lakost 5 kg', [need(1, 'sweat', 'Siyah', 7000)], { fabricKey: 'sardonlu_3_iplik|siyah' })), /Kumaş türü çelişiyor/);
  assert.match(said(run('Siyah şardonlu 3 iplik 5 kg', [need(1, 'sweat', 'Siyah', 7000)], { colorName: 'Pembe' })), /Renk çelişiyor/);
  // Two needs with different default fabrics share a colour: a typeless line cannot pick one.
  assert.match(said(run('Lacivert 5 kg', [need(1, 'polo', 'Lacivert', 7000), need(2, 'sweat', 'Lacivert', 7000)])), /farklı kumaş kalemlerine ait/);
  const dup = run('Siyah şardonlu 3 iplik 5 kg', [need(1, 'sweat', 'Siyah', 7000), need(1, 'sweat', 'Pembe', 7000)]);
  assert.match(said(dup), /aynı sipariş satırı birden çok kez/);
});

test('G13a-2: an unread word blocks a match even when type and colour were found; listed supplier noise does not', () => {
  const needs = [need(1, 'polo', 'Mavi', 10000, { fabricKey: 'lakost|mavi' }), need(2, 'sweat', 'Siyah', 30000)];
  // "petrol mavi" was the example here until G33 put it on the Lacoste card; "gece mavi" is still an unlisted shade.
  const petrol = matchInvoiceLine({ line: line('Lakost gece mavi 10 kg', { qtyMilli: 10000 }), openNeeds: needs });
  assert.equal(petrol.status, 'teyit');
  assert.match(said(petrol), /tanınmayan sözcük var \("gece"\)/);
  assert.deepEqual(parseInvoiceDescription('Lakost gece mavi 10 kg').unknownWords, ['gece']);
  const noisy = 'Siyah şardonlu 3 iplik kumaş 2 top en 180 cm gramaj 300 gr 25 kg';
  assert.deepEqual(parseInvoiceDescription(noisy).unknownWords, []);
  assert.equal(parseInvoiceDescription(noisy).qtyMilli, 25000, 'grammage is not a quantity');
  const ok = matchInvoiceLine({ line: line(noisy, { qtyMilli: 25000 }), openNeeds: needs });
  assert.deepEqual([ok.status, ok.fabricKey, ok.allocations], ['eslesti', 'sardonlu_3_iplik|siyah', [{ orderLineId: 2, qtyMilli: 25000 }]]);
  assert.deepEqual(parseInvoiceDescription('Siyah penye 1,5 metre en 160 cm 250 gr/m2 10 kg').unknownWords, []);
  // Composition is noise (G16); this line stays teyit because "penye" alone names no fabric.
  const combed = matchInvoiceLine({ line: line('Siyah %100 pamuk penye 10 kg', { qtyMilli: 10000 }), openNeeds: [] });
  assert.equal(combed.status, 'teyit');
  assert.match(said(combed), /Kumaş türü net değil: "penye"/);
});

test('G16: real invoice wording reads to knit keys; penye and örme describe, yarn count and stretch are part of the type', () => {
  const a = '30/1 PENYE SÜPREM ÖRME KUMAŞ MÜRDÜM', b = '24/1 PENYE SÜPREMÖRME KUMAŞ BEYAZ', c = '30/1 PENYE LİKRALI RİBANA ÖRME KUMAŞ BEYAZ';
  const read = t => { const p = parseInvoiceDescription(t); return [p.fabricType, p.colorKey, p.unknownWords, p.issues]; };
  assert.deepEqual(read(a), ['supren_30_1', 'murdum', [], []]);
  assert.deepEqual(read(b), ['supren_24_1', 'beyaz', [], []]);
  assert.deepEqual(read(c), ['ribana_30_1_likrali', 'beyaz', [], []]);
  assert.equal(parseInvoiceDescription(a).colorName, 'mürdüm');
  const needs = [need(1, 'tisort', 'Mürdüm', 9000, { fabricKey: 'supren_30_1|murdum' }), need(2, 'tisort', 'Beyaz', 50000, { fabricKey: 'supren_30_1|beyaz' })];
  const ra = matchInvoiceLine({ line: line(a, { qtyMilli: 7500 }), openNeeds: needs });
  assert.deepEqual([ra.status, ra.fabricKey, ra.allocations], ['eslesti', 'supren_30_1|murdum', [{ orderLineId: 1, qtyMilli: 7500 }]]);
  const rb = matchInvoiceLine({ line: line(b, { qtyMilli: 43800 }), openNeeds: needs });
  assert.deepEqual([rb.status, rb.fabricKey, rb.allocations], ['eslesti', 'supren_24_1|beyaz', []], '24/1 never fills a 30/1 need');
  const rc = matchInvoiceLine({ line: line(c, { qtyMilli: 2400 }), openNeeds: [need(3, 'tisort', 'Beyaz', 2400, { fabricKey: 'ribana_30_1_likrali|beyaz' })] });
  assert.deepEqual([rc.status, rc.fabricKey, rc.unallocatedMilli], ['eslesti', 'ribana_30_1_likrali|beyaz', 0]);
  assert.equal(fabricKey('30/1 likralı ribana', 'Beyaz'), 'ribana_30_1_likrali|beyaz', 'a panel item typed in words gets the invoice key');
  assert.equal(fabricKey('supren_24_1', 'BEYAZ'), 'supren_24_1|beyaz');
});

test('G16: open or contradictory knit wording stays teyit', () => {
  const type = t => parseInvoiceDescription(t).fabricType;
  const issue = t => parseInvoiceDescription(t).issues.map(i => i.message).join(' ');
  assert.equal(type('Siyah süprem 30 1 10 kg'), 'supren_30_1', '"30 1" written apart');
  assert.equal(type('Beyaz penye 10 kg'), null);
  assert.match(issue('Beyaz penye 10 kg'), /penye/);
  assert.match(issue('Beyaz süprem örme kumaş 10 kg'), /iplik numarası yok/);
  assert.match(issue('30/1 24/1 süprem beyaz'), /birden çok iplik numarası/);
  assert.match(issue('30/1 süprem ribana beyaz'), /birden çok kumaş türü/);
  assert.match(issue('Likralı lakost siyah'), /Kumaş türü net değil/);
  assert.equal(type('%95 pamuk %5 elastan 30/1 ribana siyah'), 'ribana_30_1_likrali', 'elastane in the content agrees with likralı');
  assert.equal(type('%95 pamuk %5 elastan 30/1 likralı ribana siyah'), 'ribana_30_1_likrali');
  assert.match(issue('%100 pamuk likralı ribana siyah'), /elastan yok ama likralı/);
  assert.match(issue('Lakost %95 pamuk %5 elastan siyah'), /likralı ayrımı yok/);
  assert.deepEqual(parseInvoiceDescription('%100 pamuk 30/1 süprem siyah').unknownWords, []);
  assert.deepEqual(parseInvoiceDescription('Siyah pamuklu süprem 30/1').unknownWords, ['pamuklu'], 'fibre words count only as a % content');
  assert.equal(matchInvoiceLine({ line: line('Lakost gece mavi 10 kg', { qtyMilli: 10000 }), openNeeds: [] }).status, 'teyit');
});

test('G16: added colours read as one key; shade words outside the dictionary still stop the line', () => {
  const colour = t => parseInvoiceDescription(t).colorKey;
  assert.deepEqual(['Ekru', 'HAKİ', 'hardal', 'İndigo', 'saks', 'Kiremit', 'vizon', 'TAŞ', 'füme', 'bebe mavi', 'Açık gri', 'koyu gri'].map(c => colour(`30/1 süprem ${c} 5 kg`)),
    ['ekru', 'haki', 'hardal', 'indigo', 'saks_mavi', 'kiremit', 'vizon', 'tas', 'fume', 'bebe_mavi', 'acik_gri', 'koyu_gri']);
  assert.equal(colour('30/1 süprem koyu lacivert 5 kg'), null);
  assert.equal(colour('30/1 süprem mürdüm 5 kg'), 'murdum');
});

test('G19: live stock names (name + colour field) read to clean keys; a name/colour clash stays teyit', () => {
  // importLegacyFabrics reads `${name} ${colorName}`, so the colour usually appears twice.
  const read = (name, colour) => { const p = parseInvoiceDescription(`${name} ${colour}`); return { key: p.fabricType && p.colorKey ? fabricKey(p.fabricType, p.colorKey) : null, p }; };
  const clean = (name, colour) => { const { key, p } = read(name, colour); assert.deepEqual([p.issues, p.unknownWords], [[], []], name); return key; };
  assert.equal(clean('30/1 Süprem Açık Mavi', 'Açık Mavi'), 'supren_30_1|acik_mavi');
  assert.equal(clean('30/1 Süprem Grimelanj', 'Grimelanj'), 'supren_30_1|gri_melanj');
  assert.equal(clean('Şardonlu 3 İplik Açık Mavi', 'Açık Mavi'), 'sardonlu_3_iplik|acik_mavi');
  assert.equal(clean('Şardonlu 3 İplik Nefti', 'Nefti'), 'sardonlu_3_iplik|nefti');
  assert.equal(clean('Şardonlu 3 İplik Nefti Yeşil', 'Nefti Yeşil'), 'sardonlu_3_iplik|nefti');
  assert.deepEqual([['Polar Siyah', 'Siyah'], ['Polar Mor', 'Mor'], ['Polar Kahverengi', 'Kahverengi'], ['İndigo Polar', 'İndigo']].map(([n, c]) => clean(n, c)),
    ['polar|siyah', 'polar|mor', 'polar|kahverengi', 'polar|indigo']);
  assert.equal(clean('Pike Raşel Siyah', 'Siyah'), 'pike_rasel|siyah');
  assert.equal(clean('Raşel Pike Siyah', 'Siyah'), 'pike_rasel|siyah');
  assert.notEqual(clean('Lakost Siyah', 'Siyah'), 'pike_rasel|siyah', 'lakost is a different knit');
  const clash = read('Pike Raşel Lacivert', 'İndigo');
  assert.equal(clash.key, null);
  assert.match(clash.p.issues.map(i => i.message).join(' '), /birden çok renk var: lacivert, indigo/);
  assert.match(parseInvoiceDescription('Pike siyah 10 kg').issues.map(i => i.message).join(' '), /Kumaş türü net değil: "pike"/);
  assert.equal(parseInvoiceDescription('Raşel siyah 10 kg').unknownWords.join(), 'rasel', 'raşel alone names no fabric either');
  assert.equal(parseInvoiceDescription('30/1 süprem açık lacivert').colorKey, null, 'only listed shades become colours');
});
