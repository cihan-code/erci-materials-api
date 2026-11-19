'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const parse = require('pdf-parse');
const { PNG } = require('pngjs');
const { renderProductionForm, renderApprovalForm, renderPrintForm, parseEmphasis, colorLabel } = require('../agent/siparis/pdf');
const { makeExampleOrder } = require('./fixtures/siparis/example-order');

const PDF_DIR = path.join(__dirname, '..', 'agent', 'siparis', 'pdf');

async function pagesOf(buffer) {
  const pages = [];
  await parse(buffer, { pagerender: async page => {
    const content = await page.getTextContent();
    const value = content.items.map(item => item.str).join('\n');
    pages.push(value);
    return value;
  } });
  return pages;
}

test('varsayılan logo kırpılmış MerciCo PNG dosyasıdır ve brand.logo ile değişebilir', async () => {
  const logo = PNG.sync.read(fs.readFileSync(path.join(PDF_DIR, 'assets', 'mercico-logo.png')));
  assert.ok(logo.width <= 1200 && logo.height <= 1200);
  assert.ok(logo.width > 100 && logo.height > 100);
  assert.equal(fs.existsSync(path.join(PDF_DIR, 'assets', 'placeholder-logo.png')), false);
  const order = makeExampleOrder({ twoColors: false });
  const withDefault = await renderApprovalForm(order);
  const custom = new PNG({ width: 4, height: 4 });
  custom.data.fill(255);
  const withCustom = await renderApprovalForm(order, { brand: { logo: PNG.sync.write(custom) } });
  assert.notEqual(withDefault.length, withCustom.length);
  assert.ok(withDefault.length > fs.statSync(path.join(PDF_DIR, 'assets', 'mercico-logo.png')).size / 2);
});

test('varsayılan şartlar 10 başlığı içerir, tek sayfaya sığar ve yer tutucu yoktur', async () => {
  const source = fs.readFileSync(path.join(PDF_DIR, 'sartlar.txt'), 'utf8');
  assert.equal((source.match(/^\d+\.\s/gm) || []).length, 10);
  const pages = await pagesOf(await renderApprovalForm(makeExampleOrder({ twoColors: false })));
  assert.equal(pages.length, 2);
  const terms = pages[1];
  assert.match(terms, /SİPARİŞ ONAY FORMU – ŞARTLAR VE KOŞULLAR/);
  for (const heading of ['Sipariş ve Üretim Onayı', 'Ödeme Koşulları', 'Üretim Süresi ve Teslimat', 'Numune ve Onay Süreci',
    'Ürün Toleransları', 'İptal ve Değişiklik Politikası', 'İade ve Kabul Şartları', 'Sevkiyat ve Lojistik',
    'Fikri Haklar ve Tasarım Koruması', 'Onay ve Kabul']) assert.ok(terms.includes(heading), heading);
  assert.match(terms, /beyan eder\./);
  assert.doesNotMatch(terms, /yer tutucu/);
});

test('çok uzun özel şartlar kesilmez, devam sayfasına akar', async () => {
  const termsText = Array.from({ length: 80 }, (_, i) => `${i + 1}. Madde ${i}\nBu maddenin gövde metni burada durur.`).join('\n\n');
  const pages = await pagesOf(await renderApprovalForm(makeExampleOrder({ twoColors: false }), { brand: { termsText } }));
  assert.ok(pages.length > 2);
  assert.match(pages.join('\n'), /80\. Madde 79/);
});

test('*vurgu* ayrıştırması', () => {
  assert.deepEqual(parseEmphasis('Kahverengi *YENİ KALIP*'), [{ text: 'Kahverengi ', red: false }, { text: 'YENİ KALIP', red: true }]);
  assert.deepEqual(parseEmphasis('a *b* c *d e* f').map(s => s.red), [false, true, false, true, false]);
  assert.deepEqual(parseEmphasis('çift yok *açık'), [{ text: 'çift yok *açık', red: false }]);
  assert.deepEqual(parseEmphasis('düz'), [{ text: 'düz', red: false }]);
});

test('vurgulu açıklama metni PDF\'te yıldızsız ve eksiksiz basılır', async () => {
  const order = makeExampleOrder({ twoColors: false });
  order.description = ['Kapüşon *astarı ve kordon* olacak'];
  const [page] = await pagesOf(await renderProductionForm(order));
  assert.ok(page.includes('astarı ve kordon'));
  assert.ok(!page.includes('*'));
  assert.match(page, /Ürün Açıklaması:/);
  assert.match(page, /Teslim Tarihi/);
  assert.match(page, /Kesilmesi Gerekenler/);
  assert.match(page, /toplam adet:/);
});

test('Kartela no metni: numara varsa "Renk (Kartela N)", yoksa yalnız renk', async () => {
  assert.equal(colorLabel('Lacivert', '14'), 'Lacivert (Kartela 14)');
  assert.equal(colorLabel('Lacivert', ''), 'Lacivert');
  assert.equal(colorLabel('Lacivert', null), 'Lacivert');
  assert.equal(colorLabel(' Lacivert ', ' 14 '), 'Lacivert (Kartela 14)');
  const order = makeExampleOrder({ twoColors: false });
  order.lines[0].color = colorLabel('Lacivert', '14');
  const [page] = await pagesOf(await renderApprovalForm(order));
  assert.match(page, /Lacivert \(Kartela 14\)/);
});

test('atölye formu aynı vurgu ve başlık diline sahiptir, içerik korunur', async () => {
  const order = makeExampleOrder({ twoColors: false });
  order.description = ['Nakış *KEÇE OLACAK*'];
  const pages = await pagesOf(await renderPrintForm(order));
  assert.match(pages[0], /Baskı Formu/);
  assert.match(pages[0], /KEÇE OLACAK/);
  assert.match(pages[0], /Toplam adet: 10/);
});
