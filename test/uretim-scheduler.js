'use strict';

// Dependency-free tests. Run: node uretim/test/scheduler.test.js
// No Anthropic call, no network, no panel access.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const cal = require('../agent/uretim/lib/calendar');
const {
  buildPlan, expandRoute, openQuestions, accessoryBlockers,
  decorationFromPanel, optionsFromPanelJob,
} = require('../agent/uretim/scheduler');

const rota = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'agent', 'uretim', 'rota.json'), 'utf8'));
const calendar = rota.calendar;

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ok  ' + name);
  } catch (e) {
    failures.push({ name, error: e });
    console.log('FAIL  ' + name + '\n      ' + (e && e.message));
  }
}

// Reference dates (verified below): 2026-09-19 is a Saturday.
const SATURDAY = '2026-09-19';
const SUNDAY = '2026-09-20';
const MONDAY = '2026-09-21';
const THURSDAY = '2026-09-17';

console.log('\n-- takvim --');

test('referans tarihler doğru gün adlarına denk geliyor', () => {
  assert.strictEqual(cal.dayName(SATURDAY), 'saturday');
  assert.strictEqual(cal.dayName(SUNDAY), 'sunday');
  assert.strictEqual(cal.dayName(MONDAY), 'monday');
  assert.strictEqual(cal.dayName(THURSDAY), 'thursday');
});

test('Pazar kapalı, Cumartesi yarım gün', () => {
  assert.strictEqual(cal.dayFactor(calendar, SUNDAY), 0);
  assert.strictEqual(cal.dayFactor(calendar, SATURDAY), 0.5);
  assert.strictEqual(cal.dayFactor(calendar, THURSDAY), 1);
});

test('dikim atölyesi Cumartesi tam gün çalışıyor', () => {
  assert.strictEqual(cal.dayFactor(calendar, SATURDAY, 'sewing'), 1);
  assert.strictEqual(cal.dayFactor(calendar, SUNDAY, 'sewing'), 0);
});

test('Cumartesi başlayan 1 günlük iş Pazartesiye taşar', () => {
  const span = cal.addWorkDays(calendar, SATURDAY, 1, 'cut_main');
  assert.strictEqual(span.start, SATURDAY);
  assert.strictEqual(span.end, MONDAY, 'yarım Cumartesi + yarım Pazartesi');
});

test('Cumartesi başlayan 1 günlük DİKİM aynı gün biter', () => {
  const span = cal.addWorkDays(calendar, SATURDAY, 1, 'sewing');
  assert.strictEqual(span.end, SATURDAY);
});

console.log('\n-- rota genişletme --');

const tisortJob = {
  id: 1,
  customer_name: 'Test A',
  product: 'tisort',
  quantity: 250,
  est_delivery: '2026-09-30',
  options: { printing: true, embroidery: false, parts: {} },
  completed_operations: [],
};

test('tişörtte yalnız baskı varsa nakış adımları düşer', () => {
  const ops = expandRoute(rota, tisortJob).map((o) => o.op_id || o.id);
  assert.ok(ops.includes('print_work'), 'baskı olmalı');
  assert.ok(!ops.includes('embroidery_work'), 'nakış olmamalı');
});

test('tişörtte ek parça kesimi yaka ribanası olarak adlandırılıyor', () => {
  const extra = expandRoute(rota, tisortJob).find((o) => o.id === 'cut_extra_parts');
  assert.ok(extra, 'ek parça kesimi olmalı');
  assert.strictEqual(extra.label, 'Yaka ribanası kesimi');
});

test('polarda ek parça kesimi hiç yok', () => {
  const job = Object.assign({}, tisortJob, { product: 'polar' });
  const ops = expandRoute(rota, job).map((o) => o.id);
  assert.ok(!ops.includes('cut_extra_parts'));
});

test('poloda ilik-düğme ayrı operasyon olarak var', () => {
  const job = Object.assign({}, tisortJob, { product: 'polo' });
  const ops = expandRoute(rota, job).map((o) => o.id);
  assert.ok(ops.includes('buttonhole_button'));
});

test('tişörtte ilik-düğme yok', () => {
  const ops = expandRoute(rota, tisortJob).map((o) => o.id);
  assert.ok(!ops.includes('buttonhole_button'));
});

test('şortta ilik var ama düğme yok', () => {
  const job = Object.assign({}, tisortJob, { product: 'sort' });
  const op = expandRoute(rota, job).find((o) => o.id === 'buttonhole_button');
  assert.ok(op, 'şortta ilik operasyonu olmalı');
  assert.strictEqual(op.label, 'İlik açılması');
  assert.ok(!/düğme/i.test(op.label), 'şortta düğme olmamalı');
});

test('düğme yalnız poloda', () => {
  const withButton = Object.keys(rota.products).filter((k) => {
    const p = rota.products[k];
    return p.has_buttonhole && /düğme/i.test(p.buttonhole_label || 'İlik ve düğme');
  });
  assert.deepStrictEqual(withButton, ['polo']);
});

test('eşofman altında ilik var, düğme yok', () => {
  const job = Object.assign({}, tisortJob, { product: 'esofman_alti' });
  const op = expandRoute(rota, job).find((o) => o.id === 'buttonhole_button');
  assert.strictEqual(op.label, 'İlik açılması');
});

test('ne baskı ne nakış işaretliyse veri hatası olarak uyarılıyor', () => {
  const job = {
    id: 20, customer_name: 'F', product: 'tisort', quantity: 100, est_delivery: '2026-10-10',
    options: { printing: false, embroidery: false, parts: {} },
  };
  const blockers = accessoryBlockers(rota, job);
  assert.ok(blockers.some((b) => b.kind === 'no_decoration'), 'düz ürün uyarısı olmalı');
});

test('cevaplanmamış baskı/nakış için veri hatası uyarısı verilmiyor', () => {
  const job = { id: 21, customer_name: 'G', product: 'tisort', quantity: 100, est_delivery: '2026-10-10', options: {} };
  const blockers = accessoryBlockers(rota, job);
  assert.ok(!blockers.some((b) => b.kind === 'no_decoration'), 'sorulmamış olmak hata değil');
});

test('sweatte kapüşon astarı sorulmadıysa kesime eklenmiyor', () => {
  const job = Object.assign({}, tisortJob, { product: 'sweat' });
  const extra = expandRoute(rota, job).find((o) => o.id === 'cut_extra_parts');
  assert.strictEqual(extra.label, 'Kaşkorse (etek ve kol) kesimi');
});

test('sweatte kapüşon astarı onaylandıysa kesime ekleniyor', () => {
  const job = Object.assign({}, tisortJob, {
    product: 'sweat',
    options: { printing: true, embroidery: false, parts: { hood_lining: true } },
  });
  const extra = expandRoute(rota, job).find((o) => o.id === 'cut_extra_parts');
  assert.ok(/Kapüşon astarı/.test(extra.label), 'astar kesimi eklenmeli: ' + extra.label);
});

console.log('\n-- kumaş cutoff kuralı --');

test('09:00 öncesi sipariş: kumaş aynı gün gelir, kesim ertesi gün', () => {
  const plan = buildPlan(rota, [tisortJob], THURSDAY);
  const tl = plan.jobs[0].timeline;
  const arrival = tl.find((o) => o.op_id === 'fabric_arrival');
  const cut = tl.find((o) => o.op_id === 'cut_main');
  assert.strictEqual(arrival.start, THURSDAY, 'aynı gün gelmeli');
  assert.strictEqual(cut.start, '2026-09-18', 'kesim ertesi gün başlamalı');
});

test('09:00 sonrası sipariş kumaşı bir gün geciktirir', () => {
  const job = Object.assign({}, tisortJob, { fabric_order_after_cutoff: true });
  const plan = buildPlan(rota, [job], THURSDAY);
  const arrival = plan.jobs[0].timeline.find((o) => o.op_id === 'fabric_arrival');
  assert.strictEqual(arrival.start, '2026-09-18');
});

console.log('\n-- paylaşımlı dikim kapasitesi --');

test('iki iş aynı kapasiteyi paylaşır, ikincisi geç biter', () => {
  const a = Object.assign({}, tisortJob, { id: 1, customer_name: 'A', est_delivery: '2026-09-28' });
  const b = Object.assign({}, tisortJob, { id: 2, customer_name: 'B', est_delivery: '2026-09-30' });
  const plan = buildPlan(rota, [a, b], THURSDAY);

  const sewA = plan.jobs[0].timeline.find((o) => o.op_id === 'sewing');
  const sewB = plan.jobs[1].timeline.find((o) => o.op_id === 'sewing');

  assert.ok(sewA.end < sewB.end, 'erken teslimli iş önce bitmeli: ' + sewA.end + ' vs ' + sewB.end);
});

test('tek iş dikimi, iki işin toplamından hızlı biter', () => {
  const a = Object.assign({}, tisortJob, { id: 1, est_delivery: '2026-09-28' });
  const b = Object.assign({}, tisortJob, { id: 2, est_delivery: '2026-09-30' });
  const alone = buildPlan(rota, [a], THURSDAY).jobs[0].timeline.find((o) => o.op_id === 'sewing');
  const shared = buildPlan(rota, [a, b], THURSDAY).jobs[0].timeline.find((o) => o.op_id === 'sewing');
  assert.strictEqual(alone.end, shared.end, 'öncelikli iş etkilenmemeli');

  const second = buildPlan(rota, [a, b], THURSDAY).jobs[1].timeline.find((o) => o.op_id === 'sewing');
  assert.ok(second.end > alone.end, 'ikinci iş beklemeli');
});

console.log('\n-- teslim/bırakma kuralları --');

test('kesim geç bittiyse baskıya ertesi sabah bırakılır (varsayılan)', () => {
  const plan = buildPlan(rota, [tisortJob], THURSDAY);
  const tl = plan.jobs[0].timeline;
  const cut = tl.find((o) => o.op_id === 'cut_main');
  const drop = tl.find((o) => o.op_id === 'print_dropoff');
  assert.ok(drop.start > cut.end, 'bırakma kesimden sonraki gün olmalı: ' + cut.end + ' → ' + drop.start);
});

test('kesim erken bittiyse aynı gün baskıya bırakılır', () => {
  const job = Object.assign({}, tisortJob, { early_handoffs: ['print_dropoff'] });
  const plan = buildPlan(rota, [job], THURSDAY);
  const tl = plan.jobs[0].timeline;
  const cut = tl.find((o) => o.op_id === 'cut_main');
  const drop = tl.find((o) => o.op_id === 'print_dropoff');
  assert.strictEqual(drop.start, cut.end, 'aynı gün bırakılmalı');
});

test('erken bırakma tüm zinciri öne çeker', () => {
  const normal = buildPlan(rota, [tisortJob], THURSDAY).jobs[0];
  const early = buildPlan(
    rota,
    [Object.assign({}, tisortJob, { early_handoffs: ['print_dropoff', 'embroidery_dropoff'] })],
    THURSDAY
  ).jobs[0];
  assert.ok(early.finish_earliest <= normal.finish_earliest, 'erken bırakma bitişi geciktirmemeli');
});

test('yüksek adet eşiği 150: üstündeki iş ütü-pakete yarım gün ekler', () => {
  const small = Object.assign({}, tisortJob, { id: 1, quantity: 100, est_delivery: '2026-10-20' });
  const big = Object.assign({}, tisortJob, { id: 2, quantity: 400, est_delivery: '2026-10-20' });
  const a = buildPlan(rota, [small], THURSDAY).jobs[0];
  const b = buildPlan(rota, [big], THURSDAY).jobs[0];
  const ironA = a.timeline.find((o) => o.op_id === 'iron_pack');
  const ironB = b.timeline.find((o) => o.op_id === 'iron_pack');
  assert.strictEqual(ironA.start, ironA.end, '150 altı: ek süre yok');
  assert.ok(ironB.end >= ironB.start, '150 üstü: yarım gün eklenmiş olmalı');
  assert.ok(!a.unknowns.some((u) => /yüksek adet/.test(u)), 'eşik artık tanımsız olmamalı');
});

test('dikime bırakma ayrı bir gün tüketmiyor', () => {
  const plan = buildPlan(rota, [tisortJob], THURSDAY);
  const tl = plan.jobs[0].timeline;
  const print = tl.find((o) => o.op_id === 'print_work');
  const drop = tl.find((o) => o.op_id === 'sewing_dropoff');
  assert.strictEqual(drop.start, print.end, 'baskının bittiği gün bırakılmalı');
  assert.strictEqual(drop.start, drop.end, 'gün tüketmemeli');
});

test('ilik ütü-paketten ÖNCE yapılıyor', () => {
  const job = Object.assign({}, tisortJob, { product: 'polo' });
  const tl = buildPlan(rota, [job], THURSDAY).jobs[0].timeline;
  const hole = tl.find((o) => o.op_id === 'buttonhole_button');
  const iron = tl.find((o) => o.op_id === 'iron_pack');
  assert.ok(hole.end <= iron.start, 'ilik ütüden önce bitmeli: ' + hole.end + ' vs ' + iron.start);
});

test('kemer lastiği dikim kapasitesine dahil - ayrı süre eklemiyor', () => {
  for (const key of ['sort', 'esofman_alti']) {
    const wb = (rota.products[key].extra_operations || []).find((o) => o.id === 'waistband');
    assert.ok(wb, key + ' için kemer işlemi tanımlı olmalı');
    assert.strictEqual(wb.included_in_sewing_capacity, true, key + ': kapasiteye dahil olmalı');
    assert.strictEqual(wb.duration_days, 0, key + ': ayrı süre eklememeli');
  }
});

test('aksesuar sipariş süresi tanımlı (1-2 gün)', () => {
  const zipper = rota.products.polar.accessories.find((a) => a.id === 'zipper');
  assert.strictEqual(zipper.order_lead_days_min, 1);
  assert.strictEqual(zipper.order_lead_days_max, 2);
});

console.log('\n-- panelden baskı/nakış okuma --');

test('yeni panel formatı (items dizisi) okunuyor', () => {
  const d = decorationFromPanel({ template: 'Tişört', items: [{ type: 'baski', size: 'A4' }] });
  assert.strictEqual(d.printing, true);
  assert.strictEqual(d.embroidery, false);
});

test('hem baskı hem nakış aynı işte okunabiliyor', () => {
  const d = decorationFromPanel({
    items: [{ type: 'baski', size: 'A3' }, { type: 'nakis', size: 'Küçük' }],
  });
  assert.strictEqual(d.printing, true);
  assert.strictEqual(d.embroidery, true);
  assert.strictEqual(d.decoration_items.length, 2);
});

test('eski panel formatı (tekli baski/nakis) da okunuyor', () => {
  const d = decorationFromPanel({ template: 'Sweat', baski: 'A4', nakis: 'Göğüs' });
  assert.strictEqual(d.printing, true);
  assert.strictEqual(d.embroidery, true);
});

test('baskı/nakış panelden geldiğinde artık sorulmuyor', () => {
  const panelJob = { baski_nakis_secim: { items: [{ type: 'baski', size: 'A4' }] } };
  const job = {
    id: 30, customer_name: 'H', product: 'tisort', quantity: 100, est_delivery: '2026-10-10',
    options: optionsFromPanelJob(panelJob, { parts: {} }),
  };
  const qs = openQuestions(rota, job);
  assert.ok(!qs.some((q) => /baskı var mı/i.test(q)), 'baskı sorulmamalı: ' + qs.join(' / '));
  assert.ok(!qs.some((q) => /nakış var mı/i.test(q)), 'nakış sorulmamalı: ' + qs.join(' / '));
});

test('panel verisi yoksa baskı/nakış yine sorulur', () => {
  const job = {
    id: 31, customer_name: 'I', product: 'tisort', quantity: 100, est_delivery: '2026-10-10',
    options: {},
  };
  const qs = openQuestions(rota, job);
  assert.ok(qs.some((q) => /baskı/i.test(q)));
});

console.log('\n-- belirsizlikler ve sorular --');

test('tanımsız süre uydurulmuyor, açıkça raporlanıyor', () => {
  // Rotanın bir kopyasında teslimat süresini bilinmez yapıp mekanizmayı sına.
  const holed = JSON.parse(JSON.stringify(rota));
  holed.base_route.find((o) => o.id === 'delivery').duration_days = null;
  const plan = buildPlan(holed, [tisortJob], THURSDAY);
  const unknowns = plan.jobs[0].unknowns;
  assert.ok(unknowns.some((u) => /Teslimat/.test(u)), 'tanımsız süre bildirilmeli: ' + unknowns.join(' | '));
});

test('süreler tanımlıyken tişört işinde tanımsız kalmıyor', () => {
  const plan = buildPlan(rota, [tisortJob], THURSDAY);
  assert.deepStrictEqual(plan.jobs[0].unknowns, [], 'beklenmedik tanımsız: ' + plan.jobs[0].unknowns.join(' | '));
});

test('cevaplanmamış opsiyonlar soru olarak çıkıyor', () => {
  const job = { id: 9, customer_name: 'C', product: 'tam_fermuar_sweat', quantity: 100, est_delivery: '2026-10-10', options: {} };
  const qs = openQuestions(rota, job);
  assert.ok(qs.some((q) => /astar/i.test(q)), 'astar sorulmalı');
  assert.ok(qs.some((q) => /baskı/i.test(q)), 'baskı sorulmalı');
  assert.ok(qs.some((q) => /Fermuar/i.test(q)), 'fermuar sorulmalı');
});

test('stokta olmayan aksesuar blokaj olarak işaretleniyor', () => {
  const job = {
    id: 10, customer_name: 'D', product: 'polar', quantity: 100, est_delivery: '2026-10-10',
    options: { printing: true, embroidery: false, accessories_in_stock: { zipper: false } },
  };
  const blockers = accessoryBlockers(rota, job);
  assert.strictEqual(blockers.length, 1, 'yalnız fermuar blokajı beklenir: ' + JSON.stringify(blockers));
  assert.strictEqual(blockers[0].kind, 'accessory_missing');
});

console.log('\n-- günün planı --');

test('bugünün planı bugün çalışılan operasyonları listeler', () => {
  const plan = buildPlan(rota, [tisortJob], THURSDAY);
  assert.ok(plan.today_plan.length > 0, 'bugün için en az bir iş olmalı');
  for (const item of plan.today_plan) {
    assert.strictEqual(typeof item.label, 'string');
    assert.ok(item.customer_name);
  }
});

test('tahmini bitiş aralığı hiçbir zaman ters dönmüyor', () => {
  // Paylaşımlı dikim kuyruğu yüzünden kötümser senaryo bazı işleri ERKEN bitirebilir.
  // Aralık yine de en erken <= en geç olarak raporlanmalı.
  const jobs = [
    { id: 1, customer_name: 'A', product: 'tisort', quantity: 250, est_delivery: '2026-09-25', options: { printing: true, embroidery: true, parts: {} }, completed_operations: ['fabric_order', 'fabric_arrival'] },
    { id: 2, customer_name: 'B', product: 'polo', quantity: 300, est_delivery: '2026-10-08', options: { printing: false, embroidery: true, parts: {} }, completed_operations: [] },
    { id: 3, customer_name: 'C', product: 'polar', quantity: 120, est_delivery: '2026-09-29', options: { printing: false, embroidery: false, accessories_in_stock: { zipper: true } }, completed_operations: [] },
  ];
  const plan = buildPlan(rota, jobs, THURSDAY);
  for (const j of plan.jobs) {
    assert.ok(
      j.finish_earliest <= j.finish_latest,
      j.customer_name + ': aralık ters (' + j.finish_earliest + ' … ' + j.finish_latest + ')'
    );
  }
});

test('cevaplanmamış sorusu olan iş "provisional" işaretleniyor', () => {
  const job = { id: 7, customer_name: 'E', product: 'polar', quantity: 100, est_delivery: '2026-10-10', options: {} };
  const plan = buildPlan(rota, [job], THURSDAY);
  assert.strictEqual(plan.jobs[0].provisional, true);

  const answered = Object.assign({}, job, {
    options: { printing: false, embroidery: false, accessories_in_stock: { zipper: true } },
  });
  const plan2 = buildPlan(rota, [answered], THURSDAY);
  assert.strictEqual(plan2.jobs[0].provisional, false);
});

test('baskı ve nakış paralel - süreler toplanmıyor', () => {
  const both = Object.assign({}, tisortJob, {
    options: { printing: true, embroidery: true, parts: {} },
  });
  const onlyPrint = Object.assign({}, tisortJob, {
    options: { printing: true, embroidery: false, parts: {} },
  });
  const a = buildPlan(rota, [both], THURSDAY).jobs[0];
  const b = buildPlan(rota, [onlyPrint], THURSDAY).jobs[0];
  assert.strictEqual(
    a.finish_latest, b.finish_latest,
    'nakış baskıdan kısa olduğu için toplam süreyi uzatmamalı'
  );
});

console.log('\n' + passed + ' test geçti, ' + failures.length + ' başarısız.\n');
if (failures.length) {
  console.error(failures[0].error);
  process.exit(1);
}
