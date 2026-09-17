'use strict';

// Run: node test/uretim-signals.js
// Free: no Anthropic call, no network, no live panel access. Synthetic fixture.

const assert = require('assert');
const { buildPlanSignals, buildProductionPlan } = require('../agent/uretim/planSignals');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; console.log('  ok  ' + name); }
  catch (e) { failures.push({ name, error: e }); console.log('FAIL  ' + name + '\n      ' + (e && e.message)); }
}

const TODAY = '2026-09-17';

const panel = {
  customers: [{ id: 1, name: 'Lady Crow' }, { id: 2, name: 'İTÜ Kulüp' }],
  jobs: [
    {
      id: 101, job_no: 'IS-101', status: 'Üretimde', customer_id: 1,
      product_type: 'Tişört', quantity: 250, delivery_date: '2026-09-30',
      baski_nakis_secim: { items: [{ type: 'baski', size: 'A4' }, { type: 'nakis', size: 'Küçük' }] },
    },
    {
      id: 102, job_no: 'IS-102', status: 'Onaylandı', customer_id: 2,
      product_type: 'Tam Fermuarlı Sweat', quantity: 120, delivery_date: '2026-10-06',
      baski_nakis_secim: { items: [{ type: 'nakis', size: 'Göğüs' }] },
    },
    {
      id: 103, job_no: 'IS-103', status: 'Üretimde', customer_id: null,
      customer_name_free: 'Bilinmeyen Ürün Test', product_type: 'Bere', quantity: 50,
      delivery_date: '2026-10-01', baski_nakis_secim: null,
    },
  ],
  uretimTakip: [
    {
      id: 11, customer_name: 'Lady Crow', status: 'Kesimde', quantity: 250,
      est_delivery: '2026-09-28', problem_note: 'Kumaş renginde ton farkı var',
    },
  ],
};

console.log('\n-- üretim plan sinyalleri --');

test('panel verisinden metin tablo üretiliyor', () => {
  const text = buildPlanSignals(panel, TODAY, { panelUpdatedAt: '2026-09-17T06:00:00Z' });
  assert.ok(text.length > 300, 'tablo boş olmamalı');
  assert.ok(text.includes('DOĞRULANMIŞ ÜRETİM PLANI TABLOSU'), 'başlık olmalı');
  assert.ok(text.includes('Perşembe'), 'gün adı Türkçe olmalı');
});

test('bugün yapılacaklar bölümü operasyon içeriyor', () => {
  const text = buildPlanSignals(panel, TODAY, {});
  assert.ok(/## BUGÜN YAPILACAK OPERASYONLAR/.test(text));
  assert.ok(text.includes('Lady Crow'), 'aktif iş listelenmeli');
});

test('parça ayrıntısı tabloya giriyor (sahadaki kişi için)', () => {
  const text = buildPlanSignals(panel, TODAY, {});
  assert.ok(/Yaka ribanası|Kaşkorse/.test(text), 'ek parça adı görünmeli:\n' + text.slice(0, 800));
});

test('baskı ve nakış birlikte okunuyor', () => {
  const { sourceJobs } = buildProductionPlan(panel, TODAY, {});
  const lady = sourceJobs.find((j) => j.id === 101);
  assert.strictEqual(lady.options.printing, true);
  assert.strictEqual(lady.options.embroidery, true);
});

test('tam fermuar sweat doğru ürüne eşleşiyor (kapasite 70)', () => {
  const { sourceJobs } = buildProductionPlan(panel, TODAY, {});
  const itu = sourceJobs.find((j) => j.id === 102);
  assert.strictEqual(itu.product, 'tam_fermuar_sweat');
});

test('tanınmayan ürün plana girmiyor, eksik veri olarak raporlanıyor', () => {
  const text = buildPlanSignals(panel, TODAY, {});
  assert.ok(/EŞLEŞTİRİLEMEYEN \/ EKSİK VERİ/.test(text));
  assert.ok(/Bere/.test(text), 'bilinmeyen ürün adı raporlanmalı');
});

test('paneldeki problem notu tabloya aktarılıyor', () => {
  const text = buildPlanSignals(panel, TODAY, {});
  assert.ok(text.includes('ton farkı'), 'problem notu görünmeli');
});

test('veri güveni bölümü var ve modele hesap yasağı veriliyor', () => {
  const text = buildPlanSignals(panel, TODAY, {});
  assert.ok(/## VERİ GÜVENİ/.test(text));
  assert.ok(/HESAPLAMA/.test(text), 'modele hesaplama yasağı yazılmalı');
});

test('dikim yükü bölümü paylaşımlı kapasiteyi anlatıyor', () => {
  const text = buildPlanSignals(panel, TODAY, {});
  assert.ok(/DİKİM ATÖLYESİ YÜKÜ/.test(text));
  assert.ok(/paylaş/i.test(text));
});

test('boş panel çökmüyor', () => {
  const text = buildPlanSignals({}, TODAY, {});
  assert.ok(text.includes('Planlanan aktif iş: 0'));
});

console.log('\n' + passed + ' test geçti, ' + failures.length + ' başarısız.\n');
if (failures.length) { console.error(failures[0].error); process.exit(1); }
