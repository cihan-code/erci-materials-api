'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recipes-'));
process.env.DATA_DIR = dir;
process.env.TYPESAFE_API_KEY = 'synthetic-typesafe-key-for-tests';
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const recipes = require('../agent/operations/recipes');
const core = require('../agent/operations/core');
const service = require('../agent/operations/service');
const context = require('../agent/operations/jev-context');
const panel = require('../agent/store');
const journal = require('../agent/operations/store');

const saved = (entries = [], status) => ({ entries, stale: false, revision: status ? { status } : null, basis: {} });
const task = key => ({ key, type: 'work', action: 'x' });
const done = op => ({ op, status: 'completed', remaining: null, reason: '', issue: null });

test('material need is grams per unit converted to approximate kg; no invented amounts', () => {
  const sweat = recipes.forTask({ product_type: 'sweat', quantity: 250, status: 'Kumaş Geldi' }, saved(), task('cut'));
  assert.deepEqual(sweat.materials.items.map(i => [i.key, i.kg, i.condition]),
    [['kumas', 180, null], ['kaskorse', 31, null], ['astar', 13, 'modelde astar varsa']]);
  assert.equal(sweat.materials.message, 'Malzeme (fire hariç): ≈180 kg kumaş, ≈31 kg kaşkorse, modelde astar varsa ≈13 kg astar.');
  const lined = recipes.materialNeed({ product_type: 'sweat', lining: 'var' }, 250);
  assert.equal(lined.items[2].condition, null);
  assert.deepEqual(recipes.materialNeed({ product_type: 'sweat', lining: 'yok' }, 250).items.map(i => i.key), ['kumas', 'kaskorse']);
  const tisort = recipes.materialNeed({ product_type: 'tisort' }, 20);
  assert.deepEqual(tisort.items.map(i => [i.key, i.kg]), [['kumas', 5], ['ribana', 0.2]]);
  assert.match(tisort.message, /≈5 kg kumaş, ≈0,2 kg ribana/);
  const esofman = recipes.materialNeed({ product_type: 'esofman' }, 100);
  assert.equal(esofman.items[1].kg, null);
  assert.match(esofman.message, /paçada kaşkorse varsa kaşkorse \(miktarı reçetede yok\)/);
  assert.equal(recipes.materialNeed({ product_type: 'sweat' }, null).status, 'unavailable');
  assert.equal(recipes.materialNeed({ product_type: '' }, 100).status, 'unavailable');
  // A partially cut job with an explicit remaining count uses the remainder.
  const partial = recipes.forTask({ product_type: 'polar', quantity: 300, status: 'Kesimde' },
    saved([{ op: 'cut', status: 'partial', remaining: 100, reason: '', issue: null }]), task('reported_remaining'));
  assert.equal(partial.materials.quantity, 100);
});

test('no product, stale record or no task yields no recipe summary', () => {
  assert.equal(recipes.forTask({ product_type: '', quantity: 100, status: 'Kumaş Geldi' }, saved(), task('cut')), null);
  assert.equal(recipes.forTask({ product_type: 'sweat', quantity: 100, status: 'Kumaş Geldi' }, { ...saved(), stale: true }, task('cut')), null);
  assert.equal(recipes.forTask({ product_type: 'sweat', quantity: 100, status: 'Kumaş Geldi' }, saved(), null), null);
  const noQty = recipes.forTask({ product_type: 'sweat', quantity: 0, status: 'Kumaş Geldi' }, saved(), task('cut'));
  assert.match(noQty.text, /Adet yok; malzeme ihtiyacı hesaplanamadı/);
});

test('zipper and collar reminders stay until reported; product-specific steps', () => {
  const tam = recipes.forTask({ product_type: 'tam_fermuar', quantity: 50, status: 'Kumaş Geldi' }, saved(), task('cut'));
  assert.match(tam.text, /Tam fermuar temini teyit edilsin\./);
  assert.match(tam.text, /Modelde astar varsa astar kesimi de yapılsın\./);
  assert.match(tam.text, /Kesimden sonra, model kordonluysa kapüşonu ilikçiye gönder\./);
  const arrived = recipes.forTask({ product_type: 'tam_fermuar', quantity: 50, status: 'Dikimde' }, saved([done('zipper')]), task('finish_sewing'));
  assert.equal(arrived.preparations[0].status, 'confirmed');
  assert.doesNotMatch(arrived.text, /fermuar/i);
  const waiting = recipes.forTask({ product_type: 'yarim_fermuar', quantity: 50, status: 'Dikimde' },
    saved([{ op: 'zipper', status: 'blocked', remaining: null, reason: 'tedarikçi gecikti', issue: 'material' }]), task('finish_sewing'));
  assert.match(waiting.text, /Yarım fermuar temini bekleniyor \(tedarikçi gecikti\); teyit edilsin\./);
  const half = recipes.forTask({ product_type: 'yarim_fermuar', quantity: 50, status: 'Kumaş Geldi', cord: 'var', lining: 'var' }, saved(), task('cut'));
  assert.match(half.text, /Yaka kesimi de yapılsın\./);
  assert.doesNotMatch(half.text, /astar|kapüşon/i);
  assert.equal(half.cord, null); assert.equal(half.lining, null);
  const polo = recipes.forTask({ product_type: 'polo', quantity: 40, status: 'Kumaş Geldi' }, saved(), task('cut'));
  assert.match(polo.text, /Yaka-kol ve tela kesimi de yapılsın\..*Yaka-kol siparişi teyit edilsin\./);
  const polar = recipes.forTask({ product_type: 'polar', quantity: 40, status: 'Kumaş Geldi' }, saved(), task('cut'));
  assert.match(polar.text, /Modelde fermuar varsa fermuar temini teyit edilsin\./);
  const sewn = recipes.forTask({ product_type: 'tam_fermuar', quantity: 50, status: 'Ütü-Pakette-Teslimat Bekliyor' }, saved([done('sewing')]), task('pack'));
  assert.deepEqual(sewn.preparations, []);
});

test('cord and lining fields make reminders definite; tişört biyelik and eşofman kemerleme', () => {
  const cut = st => ({ product_type: 'sweat', quantity: 10, status: 'Kesimde', ...st });
  assert.match(recipes.forTask(cut({ cord: 'var' }), saved([done('cut')]), task('cut_handoff')).text, /^Kapüşonu ilikçiye gönder\./);
  assert.match(recipes.forTask(cut({}), saved([done('cut')]), task('cut_handoff')).text, /^Model kordonluysa kapüşonu ilikçiye gönder\./);
  assert.equal(recipes.forTask(cut({ cord: 'yok' }), saved([done('cut')]), task('cut_handoff')).text, '');
  assert.doesNotMatch(recipes.forTask(cut({ cord: 'var' }), saved([done('cut'), done('buttonhole')]), task('cut_handoff')).text, /ilik/);
  const tisort = recipes.forTask({ product_type: 'tisort', quantity: 10, status: 'Baskı/Nakışta' }, saved([done('cut'), done('print')]), task('sewing_handoff'));
  assert.equal(tisort.text, 'Biyelik kumaşı da dikime gönder.');
  const plain = recipes.forTask({ product_type: 'tisort', quantity: 10, status: 'Kesimde' }, { ...saved([done('cut')]), basis: { decoration: 'yok' } }, task('cut_handoff'));
  assert.equal(plain.text, 'Biyelik kumaşı da dikime gönder.');
  const sweatHandoff = recipes.forTask({ product_type: 'sweat', cord: 'var', quantity: 10, status: 'Baskı/Nakışta' }, saved([done('cut'), done('print')]), task('sewing_handoff'));
  assert.equal(sweatHandoff.text, 'İlikçideki kapüşon parçaları da dikime alınsın.');
  const sort = recipes.forTask({ product_type: 'sort', quantity: 10, status: 'Dikimde' }, saved(), task('finish_sewing'));
  assert.equal(sort.text, 'Dikimde kemerleme yapılır; tüm paçalar reçme.');
  const polo = recipes.forTask({ product_type: 'polo', quantity: 10, status: 'Dikimde' }, saved([done('collar')]), task('finish_sewing'));
  assert.equal(polo.text, 'Dikimden sonra ilik-düğmeye gönder.');
});

test('recipe configuration is validated', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '../agent/operations/recipes.json'), 'utf8'));
  assert.doesNotThrow(() => recipes.validate(structuredClone(cfg)));
  assert.deepEqual(Object.keys(cfg.products).sort(), ['esofman', 'polar', 'polo', 'sort', 'sweat', 'tam_fermuar', 'tisort', 'yarim_fermuar']);
  for (const broken of [c => { c.version = 2; }, c => { c.products.sweat.materials[0].g_per_unit = -1; },
    c => { c.products.sweat.materials[0].key = 'iplik'; }, c => { c.products.polo.post_sewing_op = 'pack'; },
    c => { c.products.polar.preparations[0].op = 'cut'; }, c => { c.products.sort.steps = []; }]) {
    const copy = structuredClone(cfg); broken(copy);
    assert.throws(() => recipes.validate(copy), /Reçete yapılandırması geçersiz/);
  }
});

// Service-level: kanban behaviour with real journal/panel files.
const base = { id: 7, customer_name: 'Synthetic', quantity: 100, status: 'Dikimde', decoration: 'yok', product_type: 'polo' };
function reset(record = base) {
  fs.rmSync(path.join(dir, 'operations'), { recursive: true, force: true });
  fs.writeFileSync(panel.PANEL_DATA_FILE, JSON.stringify({ data: { uretimTakip: [record], jobs: [] }, updatedAt: '2026-10-08T05:00:00Z' }));
}
function params(text, id) { const s = service.snapshot(); return { record_id: 7, request_id: id, text, revision: s.revision, fingerprint: s.records[0].fingerprint }; }
const infer = (op, status = 'completed', reason = '', issue = null) => async text => ({ entries: [{ op, status, remaining: null, reason, issue, evidence: text }] });
const current = () => panel.loadPanelData().data.uretimTakip[0];

test('polo stays in Dikimde until ilik-düğme is done; undo returns step by step', async () => {
  reset();
  let res = await service.submit(params('Dikim bitti.', 'polo-report-001'), infer('sewing'));
  assert.equal(current().status, 'Dikimde');
  assert.match(res.snapshot.records[0].revision.action, /ilik-düğmeye gönder/);
  assert.equal(context.taskFor(current(), res.snapshot.records[0]).key, 'buttonhole');
  res = await service.submit(params('İlik düğme bitti.', 'polo-report-002'), infer('buttonhole'));
  assert.equal(current().status, 'Ütü-Pakette-Teslimat Bekliyor');
  assert.equal(res.stage_sync.status, 'applied');
  assert.equal(context.taskFor(current(), res.snapshot.records[0]).key, 'pack');
  const undone = await service.undo({ event_id: 'polo-report-002', revision: res.snapshot.revision });
  assert.equal(current().status, 'Dikimde');
  assert.equal(undone.records[0].stale, false);
  // Other products keep the existing rule: finished sewing moves to ütü-paket.
  reset({ ...base, product_type: 'sweat' });
  await service.submit(params('Dikim bitti.', 'sweat-report-001'), infer('sewing'));
  assert.equal(current().status, 'Ütü-Pakette-Teslimat Bekliyor');
  reset({ ...base, product_type: 'polo', status: 'Dikimde' });
  await service.submit(params('İlik düğmeye başlandı.', 'polo-report-003'), infer('buttonhole', 'in_progress'));
  assert.equal(current().status, 'Dikimde');
});

test('supply reports never move, pin or later revert the kanban stage', async () => {
  reset({ ...base, product_type: 'tam_fermuar', status: 'Kumaş Geldi' });
  const res = await service.submit(params('Fermuarlar geldi.', 'zip-report-001'), infer('zipper'));
  assert.equal(res.saved, true); assert.equal(res.stage_sync, null);
  assert.equal(current().status, 'Kumaş Geldi');
  assert.equal(res.snapshot.records[0].revision, null); assert.equal(res.snapshot.records[0].stale, false);
  // A later manual stage change is ordinary work, not a stale report.
  const { data, updatedAt } = panel.loadPanelData(); data.uretimTakip[0].status = 'Kesimde'; panel.writePanelData(data, updatedAt);
  const view = service.snapshot();
  assert.equal(view.records[0].stale, false);
  assert.equal(context.taskFor(current(), view.records[0]).key, 'finish_cut');
  const undone = await service.undo({ event_id: 'zip-report-001', revision: view.revision });
  assert.equal(undone.stage_sync, null); assert.equal(current().status, 'Kesimde');
  const again = await service.undo({ event_id: 'zip-report-001', revision: undone.revision });
  assert.equal(again.reused, true);
  // A blocked supply does not replace the next production task.
  reset({ ...base, product_type: 'tam_fermuar', status: 'Kumaş Geldi' });
  const blocked = await service.submit(params('Fermuar gelmedi, tedarikçi gecikti.', 'zip-report-002'),
    infer('zipper', 'blocked', 'tedarikçi gecikti', 'material'));
  assert.equal(current().status, 'Kumaş Geldi');
  assert.equal(context.taskFor(current(), blocked.snapshot.records[0]).key, 'cut');
  // Undo of a stage report ignores earlier supply-only events for its basis stage.
  reset({ ...base, product_type: 'tam_fermuar', status: 'Kumaş Geldi' });
  await service.submit(params('Fermuarlar geldi.', 'zip-report-003'), infer('zipper'));
  const moved = panel.loadPanelData(); moved.data.uretimTakip[0].status = 'Kesimde'; panel.writePanelData(moved.data, moved.updatedAt);
  const cut = await service.submit(params('Kesim bitti.', 'cut-report-001'), infer('cut'));
  const back = await service.undo({ event_id: 'cut-report-001', revision: cut.snapshot.revision });
  assert.equal(current().status, 'Kesimde'); assert.equal(back.stage_sync.to_status, 'Kesimde');
});

function respond(questions) {
  return { model: 'jev-1.13.0', answers: Object.fromEntries(Object.entries(questions).map(([name, q]) => {
    const keys = Object.keys(q.criteria);
    return [name, { type: 'choice', choice: keys[0], confidence: 0.8, probabilities: Object.fromEntries(keys.map((k, i) => [k, i ? 0 : 1])) }];
  })) };
}
test('Jev sees each recipe once, decisions carry the code-computed recipe, cache stays valid', async () => {
  const records = [
    { id: 1, customer_name: 'A', quantity: 250, status: 'Kumaş Geldi', decoration: 'baski', product_type: 'sweat', cord: 'var' },
    { id: 2, customer_name: 'B', quantity: 250, status: 'Kumaş Geldi', decoration: 'yok', product_type: 'sweat' },
    { id: 3, customer_name: 'C', quantity: 60, status: 'Dikimde', decoration: 'yok', product_type: 'tam_fermuar' },
    { id: 4, customer_name: 'D', quantity: 30, status: 'Kesimde', decoration: 'yok' },
  ];
  fs.rmSync(path.join(dir, 'operations'), { recursive: true, force: true });
  fs.writeFileSync(panel.PANEL_DATA_FILE, JSON.stringify({ data: { uretimTakip: records, jobs: [] }, updatedAt: '2026-10-08T05:00:00Z' }));
  const data = panel.loadPanelData().data, view = service.snapshot(data, journal.read(), false);
  const prepared = context.prepare(data, view, 'jev-latest');
  assert.deepEqual(Object.keys(prepared.state.product_recipes), ['sweat', 'tam_fermuar']);
  assert.equal(prepared.state.product_recipes.sweat.g_per_unit.kumas, 720);
  assert.equal(prepared.state.production_records[0].recipe.material_need.items[0].kg, 180);
  assert.equal(prepared.state.production_records[2].recipe.preparations[0].status, 'unconfirmed');
  assert.equal(prepared.state.production_records[3].recipe, null);
  let calls = 0;
  const first = await service.finalPlan(async (state, questions) => { calls++; return respond(questions); });
  const second = await service.finalPlan(async (state, questions) => { calls++; return respond(questions); });
  assert.equal(calls, 1); assert.equal(first.plan.status, 'ready');
  assert.equal(second.plan.generated_at, first.plan.generated_at);
  const sweat = first.plan.decisions.find(d => d.record_id === 1);
  assert.match(sweat.recipe.text, /≈180 kg kumaş/);
  assert.match(sweat.recipe.text, /Kesimden sonra kapüşonu ilikçiye gönder/);
  assert.match(first.plan.decisions.find(d => d.record_id === 3).recipe.text, /Tam fermuar temini teyit edilsin/);
  assert.equal(first.plan.decisions.find(d => d.record_id === 4).recipe, null);
  // Changing a recipe-relevant panel field changes the plan inputs.
  const changed = structuredClone(data); changed.uretimTakip[1].lining = 'var';
  const again = context.prepare(changed, service.snapshot(changed, journal.read(), false), 'jev-latest');
  assert.notEqual(again.state_hash, prepared.state_hash);
});

test('report schema accepts the new supply and ilik operations', () => {
  const record = { id: 1, status: 'Kumaş Geldi' }, text = 'Fermuarlar geldi. Yaka-kol geldi. İlik açıldı.';
  const entries = core.validateEntries([
    { op: 'zipper', status: 'completed', remaining: null, reason: '', issue: null, evidence: 'Fermuarlar geldi.' },
    { op: 'collar', status: 'completed', remaining: null, reason: '', issue: null, evidence: 'Yaka-kol geldi.' },
    { op: 'buttonhole', status: 'completed', remaining: null, reason: '', issue: null, evidence: 'İlik açıldı.' },
  ], record, text);
  assert.deepEqual(entries.map(e => e.op), ['zipper', 'collar', 'buttonhole']);
  assert.doesNotThrow(() => core.validateEntries([{ op: 'zipper', status: 'blocked', remaining: null, reason: 'gelmedi', issue: 'material', evidence: 'gelmedi' }], record, 'Fermuar gelmedi'));
});

test('a waiting zipper never blocks cutting capacity; capacity action and recipe notes stay separate', async () => {
  const rec = { id: 1, customer_name: 'X', quantity: 30, status: 'Kumaş Geldi', decoration: 'yok', product_type: 'tam_fermuar' };
  fs.rmSync(path.join(dir, 'operations'), { recursive: true, force: true });
  fs.writeFileSync(panel.PANEL_DATA_FILE, JSON.stringify({ data: { uretimTakip: [rec], jobs: [] }, updatedAt: '2026-10-08T05:00:00Z' }));
  fs.mkdirSync(path.join(dir, 'operations'));
  journal.write({ version: 1, revision: 1, rules: {}, events: [{ id: 'zip-wait', record_id: 1, fingerprint: core.fingerprint(rec, []),
    basis_status: 'Kumaş Geldi', date: '2026-10-08', entries: [{ op: 'zipper', status: 'blocked', remaining: null, reason: 'tedarikçi gecikti', issue: 'material' }] }] });
  const data = panel.loadPanelData().data;
  const prepared = context.prepare(data, service.snapshot(data, journal.read(), false), 'jev-latest');
  assert.equal(prepared.tasks[0].key, 'cut');
  assert.equal(prepared.tasks[0].capacity_input.blocked, false);
  const result = await service.finalPlan(async (state, questions) => respond(questions));
  const d = result.plan.decisions[0];
  assert.equal(d.capacity.status, 'scheduled');
  assert.doesNotMatch(d.action, /fermuar/i);
  assert.match(d.recipe.text, /Tam fermuar temini bekleniyor \(tedarikçi gecikti\); teyit edilsin\./);
});
