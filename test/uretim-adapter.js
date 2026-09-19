'use strict';

// Run: node uretim/test/panelAdapter.test.js
// Fixtures below are synthetic - they mimic the panel's shape, not real orders.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const rota = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'agent', 'uretim', 'rota.json'), 'utf8'));
const { buildJobsFromPanel, matchProduct, normalize } = require('../agent/uretim/panelAdapter');
const { buildPlan } = require('../agent/uretim/scheduler');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; console.log('  ok  ' + name); }
  catch (e) { failures.push({ name, error: e }); console.log('FAIL  ' + name + '\n      ' + (e && e.message)); }
}

console.log('\n-- ürün adı eşleştirme --');

test('Türkçe büyük/küçük harf farkı sorun çıkarmıyor', () => {
  assert.strictEqual(matchProduct(rota, 'Tişört'), 'tisort');
  assert.strictEqual(matchProduct(rota, 'TİŞÖRT'), 'tisort');
  assert.strictEqual(matchProduct(rota, 'tisort'), 'tisort');
});

test('serbest metin varyasyonları eşleşiyor', () => {
  assert.strictEqual(matchProduct(rota, 'Oversize Tişört'), 'tisort');
  assert.strictEqual(matchProduct(rota, 'Polo Yaka'), 'polo');
  assert.strictEqual(matchProduct(rota, 'Sweatshirt'), 'sweat');
  assert.strictEqual(matchProduct(rota, 'Şort'), 'sort');
});

test('en uzun eşleşme kazanıyor - tam fermuar sweat, sweat sanılmıyor', () => {
  assert.strictEqual(matchProduct(rota, 'Tam Fermuarlı Sweat'), 'tam_fermuar_sweat');
  assert.strictEqual(matchProduct(rota, 'Yarım Fermuar Sweat'), 'yarim_fermuar_sweat');
});

test('tanınmayan ürün tahmin edilmiyor', () => {
  assert.strictEqual(matchProduct(rota, 'Bilinmeyen Kıyafet'), null);
  assert.strictEqual(matchProduct(rota, ''), null);
});

console.log('\n-- panel verisinden iş çıkarma --');

const basePanel = () => ({
  customers: [{ id: 1, name: 'Lady Crow' }, { id: 2, name: 'İTÜ Kulüp' }],
  jobs: [
    {
      id: 101, job_no: 'IS-101', status: 'Üretimde', customer_id: 1,
      product_type: 'Tişört', quantity: 250, delivery_date: '2026-09-30',
      baski_nakis_secim: { items: [{ type: 'baski', size: 'A4' }] },
    },
  ],
  uretimTakip: [
    { id: 11, customer_name: 'Lady Crow', status: 'Dikimde', quantity: 250, est_delivery: '2026-09-28' },
  ],
});

test('tek eşleşme varsa aşama uretimTakip\'ten alınıyor', () => {
  const { jobs, needs_attention } = buildJobsFromPanel(rota, basePanel());
  assert.strictEqual(jobs.length, 1);
  assert.strictEqual(jobs[0].product, 'tisort');
  assert.strictEqual(jobs[0].panel_stage, 'Dikimde');
  assert.strictEqual(jobs[0].stage_source, 'ad eşleşmesi');
  assert.ok(jobs[0].completed_operations.includes('sewing_dropoff'), 'dikim öncesi adımlar bitmiş sayılmalı');
  assert.strictEqual(needs_attention.length, 0);
});

test('baskı bilgisi panelden okunuyor, sorulmuyor', () => {
  const { jobs } = buildJobsFromPanel(rota, basePanel());
  assert.strictEqual(jobs[0].options.printing, true);
  assert.strictEqual(jobs[0].options.embroidery, false);
});

test('aynı müşterinin iki işi varsa adet ayırt ediyor', () => {
  const panel = basePanel();
  panel.jobs.push({
    id: 102, job_no: 'IS-102', status: 'Üretimde', customer_id: 1,
    product_type: 'Sweatshirt', quantity: 80, delivery_date: '2026-10-05',
    baski_nakis_secim: { items: [{ type: 'nakis', size: 'Küçük' }] },
  });
  const { jobs } = buildJobsFromPanel(rota, panel);
  const tisort = jobs.find((j) => j.job_no === 'IS-101');
  const sweat = jobs.find((j) => j.job_no === 'IS-102');
  assert.strictEqual(tisort.panel_stage, 'Dikimde', '250 adet üretim kaydıyla eşleşmeli');
  assert.strictEqual(sweat.panel_stage, null, '80 adetlik işin eşleşecek kaydı yok');
});

test('adetler de aynıysa GERÇEKTEN belirsiz - eşleştirme yapılmıyor', () => {
  const panel = basePanel();
  panel.jobs.push({
    id: 102, job_no: 'IS-102', status: 'Üretimde', customer_id: 1,
    product_type: 'Sweatshirt', quantity: 250, delivery_date: '2026-10-05',
    baski_nakis_secim: { items: [{ type: 'nakis', size: 'Küçük' }] },
  });
  const { jobs, needs_attention } = buildJobsFromPanel(rota, panel);
  for (const j of jobs) {
    assert.strictEqual(j.panel_stage, null, j.job_no + ': belirsizken aşama atanmamalı');
  }
  assert.strictEqual(needs_attention.filter((n) => n.kind === 'stage_unknown').length, 2);
});

test('job_id varsa ad eşleşmesine hiç bakılmıyor', () => {
  const panel = basePanel();
  panel.uretimTakip[0].customer_name = 'Alakasız Bir Açıklama';
  panel.uretimTakip[0].job_id = 101;
  const { jobs } = buildJobsFromPanel(rota, panel);
  assert.strictEqual(jobs[0].panel_stage, 'Dikimde');
  assert.strictEqual(jobs[0].stage_source, 'panel bağlantısı');
});

test('job_id ile bağlanan kayıt başka işe ad eşleşmesiyle verilmiyor', () => {
  const panel = basePanel();
  panel.uretimTakip[0].job_id = 999; // var olmayan is
  const { jobs } = buildJobsFromPanel(rota, panel);
  assert.strictEqual(jobs[0].panel_stage, 'Dikimde', 'gecersiz job_id ad eslesmesine dusmeli');
});

test('üretim kaydı müşteri adını İÇEREN serbest metin olsa da eşleşiyor', () => {
  const panel = basePanel();
  panel.uretimTakip[0].customer_name = 'Lady Crow Yaz Koleksiyonu Tişört';
  const { jobs } = buildJobsFromPanel(rota, panel);
  assert.strictEqual(jobs[0].panel_stage, 'Dikimde', 'gerçek panelde alan böyle doluyor');
});

test('tanınmayan ürün plana girmiyor, soru olarak çıkıyor', () => {
  const panel = basePanel();
  panel.jobs[0].product_type = 'Bere';
  const { jobs, needs_attention } = buildJobsFromPanel(rota, panel);
  assert.strictEqual(jobs.length, 0, 'ürünü bilinmeyen iş planlanmamalı');
  assert.strictEqual(needs_attention[0].kind, 'product_unknown');
});

test('planlama dışı ürün (Şapka) hata olarak raporlanmıyor', () => {
  const panel = basePanel();
  panel.jobs[0].product_type = 'Şapka';
  const { jobs, needs_attention } = buildJobsFromPanel(rota, panel);
  assert.strictEqual(jobs.length, 0, 'plana girmemeli');
  assert.strictEqual(needs_attention.length, 0, 'hata olarak da raporlanmamalı');
});

test('gerçekten tanınmayan ürün yine hata olarak çıkıyor', () => {
  const panel = basePanel();
  panel.jobs[0].product_type = 'Bilinmeyen Kıyafet';
  const { needs_attention } = buildJobsFromPanel(rota, panel);
  assert.strictEqual(needs_attention[0].kind, 'product_unknown');
});

test('teklif aşamasındaki işler plana girmiyor', () => {
  const panel = basePanel();
  panel.jobs[0].status = 'Teklif';
  const { jobs } = buildJobsFromPanel(rota, panel);
  assert.strictEqual(jobs.length, 0);
});

test('üretim kaydının teslim tarihi işin tarihine göre önceliklidir', () => {
  const { jobs } = buildJobsFromPanel(rota, basePanel());
  assert.strictEqual(jobs[0].est_delivery, '2026-09-28', 'uretimTakip tahmini teslim kullanılmalı');
});

console.log('\n-- uçtan uca: panel verisi -> plan --');

test('panel verisinden doğrudan plan üretilebiliyor', () => {
  const { jobs } = buildJobsFromPanel(rota, basePanel());
  const plan = buildPlan(rota, jobs, '2026-09-17');
  assert.strictEqual(plan.jobs.length, 1);
  assert.ok(plan.jobs[0].timeline.length > 0);
  const ops = plan.jobs[0].timeline.map((o) => o.op_id);
  assert.ok(!ops.includes('cut_main'), 'dikimdeki iş için kesim tekrar planlanmamalı');
  assert.ok(ops.includes('sewing'), 'dikim planlanmalı');
});

console.log('\n' + passed + ' test geçti, ' + failures.length + ' başarısız.\n');
if (failures.length) { console.error(failures[0].error); process.exit(1); }
