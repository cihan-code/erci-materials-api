'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const capacity = require('../agent/operations/capacity');
const context = require('../agent/operations/jev-context');
const cfg = capacity.loadConfig();
const facts = (id, quantity = 250, type = 'sweat', station = 'sewing', extras = {}) => ({
  record_id: id, code: 'IS-' + id, key: station === 'sewing' ? 'finish_sewing' : 'cut', type: 'work', action: 'Original',
  capacity_input: { station, queue: station === 'sewing' ? 'existing' : null, product_type: type,
    product_label: cfg.products[type]?.label || '', quantity, order_quantity: quantity, delivery_date: null,
    reason: '', blocked: false, ...extras },
});
function run(tasks, day = '2026-10-08', previous = 'sweat', choices = {}) {
  const decisions = tasks.map((t, i) => ({ record_id: t.record_id, task_key: t.key, priority: i + 1,
    action: 'Original', disposition: 'do', urgent: false, source: 'jev', ...choices[t.record_id] }));
  return capacity.allocate({ tasks, date: day, capacity_config: cfg, sewing_setup: { product_type: previous } }, decisions);
}
test('250 + 250 sweat share one 200-piece day; next day splits 50 + 150', () => {
  const today = run([facts(1), facts(2)]);
  assert.deepEqual(today.decisions.map(d => d.capacity.today_quantity), [200, 0]);
  assert.deepEqual(today.decisions.map(d => d.capacity.remaining_after_today), [50, 250]);
  assert.deepEqual(today.decisions.map(d => d.capacity.estimated_finish), ['2026-10-09', '2026-10-10']);
  assert.equal(today.decisions[1].disposition, 'defer');
  const tomorrow = run([facts(1, 50), facts(2)], '2026-10-09');
  assert.deepEqual(tomorrow.decisions.map(d => d.capacity.today_quantity), [50, 150]);
  assert.ok(today.decisions.every(d => !d.action.includes('dikimi bitir')));
});
test('a t-shirt to sweat transition leaves seven productive hours and carries across midnight', () => {
  const plan = run([facts(1)], '2026-10-08', 'tisort');
  assert.equal(plan.decisions[0].capacity.today_quantity, 140);
  assert.equal(plan.capacity.transitions_today[0].hours, 3);
  assert.equal(plan.capacity.transitions_today[0].from_label, 'Tişört');
  const following = run([facts(1, 230, 'tisort'), facts(2, 200)], '2026-10-08', 'tisort');
  assert.equal(following.decisions[1].capacity.estimated_finish, '2026-10-10');
  assert.equal(following.decisions[1].capacity.today_quantity, 0);
});
test('same product jobs incur no setup cost; setup can straddle a workday boundary', () => {
  const same = run([facts(1, 100), facts(2, 100)]);
  assert.equal(same.capacity.transitions_today.length, 0);
  assert.equal(same.decisions[1].capacity.today_quantity, 100);
  const split = run([facts(1, 190), facts(2, 230, 'tisort')]);
  assert.equal(split.capacity.transitions_today[0].hours, .5);
  assert.equal(split.decisions[1].capacity.estimated_finish, '2026-10-10');
});
test('Saturday has ten sewing hours; Sunday production is zero and skipped', () => {
  const sat = run([facts(1, 200), facts(2, 200)], '2026-10-10');
  assert.equal(sat.decisions[0].capacity.today_quantity, 200);
  assert.equal(sat.decisions[1].capacity.estimated_finish, '2026-10-12');
  const sun = run([facts(1, 200)], '2026-10-11');
  assert.equal(sun.decisions[0].capacity.today_quantity, 0);
  assert.equal(sun.decisions[0].capacity.estimated_finish, '2026-10-12');
});
test('missing product or amount is explicit and cannot invent a queue completion date', () => {
  for (const task of [facts(1, 250, ''), facts(1, null)]) {
    const plan = run([task, facts(2)]);
    assert.equal(plan.decisions[0].capacity.status, 'unavailable');
    assert.equal(plan.decisions[0].capacity.estimated_finish, null);
    assert.equal(plan.decisions[1].capacity.estimated_finish, null);
    assert.match(plan.decisions[1].action, /Önceki işin yükü/);
  }
});
test('blocked sewing never invents a release time or consumes a fictitious amount', () => {
  const plan = run([facts(1, 100, 'sweat', 'sewing', { blocked: true, reason: 'Malzeme yok' }), facts(2)]);
  assert.equal(plan.decisions[0].capacity.status, 'blocked');
  assert.equal(plan.decisions[0].capacity.today_quantity, null);
  assert.equal(plan.decisions[1].capacity.estimated_finish, null);
});
test('+15 percent is a labeled alternative only for late work, not the baseline', () => {
  const plan = run([facts(1, 230, 'sweat', 'sewing', { delivery_date: '2026-10-08' })]);
  const c = plan.decisions[0].capacity;
  assert.equal(c.today_quantity, 200); assert.equal(c.remaining_after_today, 30);
  assert.equal(c.risk_days, 1); assert.equal(c.boost.today_quantity, 230);
  assert.equal(c.boost.estimated_finish, '2026-10-08'); assert.equal(c.boost.risk_days, 0);
  assert.match(plan.decisions[0].action, /zorlanmış kapasite \(\+%15\)/);
  assert.equal(run([facts(1, 200, 'sweat', 'sewing', { delivery_date: '2026-10-08' })]).decisions[0].capacity.boost, null);
  assert.ok(run([facts(1, 100, 'sweat', 'sewing', { delivery_date: '2026-10-07' })]).decisions[0].capacity.boost);
});
test('handoffs remain behind jobs already in sewing, regardless of global priority', () => {
  const plan = run([facts(1, 250, 'sweat', 'sewing', { queue: 'handoff' }), facts(2, 250)]);
  assert.equal(plan.decisions[0].capacity.today_quantity, 0);
  assert.equal(plan.decisions[1].capacity.today_quantity, 200);
});
test('explicit deferral respects tomorrow and scheduled zero-amount deferral is idempotent', () => {
  const tasks = [facts(1), facts(2)];
  const first = run(tasks);
  const again = capacity.allocate({ tasks, date: '2026-10-08', capacity_config: cfg, sewing_setup: { product_type: 'sweat' } }, first.decisions.map(d => ({ ...d })));
  assert.deepEqual(again, first);
  assert.equal(run([facts(1)], '2026-10-08', 'sweat', { 1: { disposition: 'defer' } }).decisions[0].capacity.today_quantity, 0);
});
test('normal cutting allows two small orders or one large, with a strict 50 threshold', () => {
  assert.deepEqual(run([facts(1, 40, 'sweat', 'cut'), facts(2, 49, 'sweat', 'cut'), facts(3, 20, 'sweat', 'cut')]).decisions.map(d => d.capacity.today_quantity), [40, 49, 0]);
  assert.deepEqual(run([facts(1, 50, 'sweat', 'cut'), facts(2, 49, 'sweat', 'cut')]).decisions.map(d => d.capacity.today_quantity), [50, 0]);
  assert.deepEqual(run([facts(1, 40, 'sweat', 'cut'), facts(2, 100, 'sweat', 'cut')]).decisions.map(d => d.capacity.today_quantity), [40, 0]);
});
test('model urgency permits at most two cuts, including large-small mixes', () => {
  const tasks = [facts(1, 250, 'sweat', 'cut'), facts(2, 20, 'sweat', 'cut'), facts(3, 200, 'sweat', 'cut')];
  const plan = run(tasks, '2026-10-08', 'sweat', { 2: { urgent: true } });
  assert.deepEqual(plan.decisions.map(d => d.capacity.today_quantity), [250, 20, 0]);
  assert.match(plan.decisions[1].action, /Acil kesim kapasitesi/);
});
test('remaining sewing amount comes from a report when present, else the whole order', () => {
  const record = { quantity: 250, status: 'Dikimde', product_type: 'sweat' }, task = { type: 'work', key: 'reported_remaining' };
  const saved = { stale: false, entries: [{ op: 'sewing', status: 'partial', remaining: 5 }], revision: null };
  assert.equal(capacity.input(record, saved, task, cfg).quantity, 5);
  saved.entries[0].remaining = null;
  assert.equal(capacity.input(record, saved, task, cfg).quantity, 250);
});
test('only non-retracted actual sewing reports establish the last product across days', () => {
  const journal = { events: [{ date: '2026-10-07', product_type: 'tisort', entries: [{ op: 'sewing', status: 'completed' }] },
    { date: '2026-10-08', product_type: 'sweat', voided: 'now', entries: [{ op: 'sewing', status: 'partial' }] }] };
  assert.equal(capacity.previousSetup(journal, '2026-10-08').product_type, 'tisort');
  assert.equal(capacity.previousSetup({ events: [] }, '2026-10-08').source, 'unknown');
});
test('rates, product inputs and setup are part of the model context and cache identity', () => {
  const data = { uretimTakip: [{ id: 1, quantity: 250, status: 'Dikimde', product_type: 'sweat' }] };
  const snapshot = { revision: 0, knowledge: [], records: [{ record_id: 1, basis: { status: 'Dikimde' }, entries: [], reminders: [], revision: null }] };
  const one = context.prepare(data, snapshot, 'test', '2026-10-08');
  assert.equal(one.state.production_records[0].capacity_estimate.required_workdays, 1.25);
  assert.equal(one.state.capacity_rules.sewing.transition_hours, 3);
  const original = capacity.loadConfig;
  try {
    capacity.loadConfig = () => ({ ...cfg, products: { ...cfg.products, sweat: { label: 'Sweatshirt', sewing_per_day: 201 } } });
    assert.notEqual(context.prepare(data, snapshot, 'test', '2026-10-08').state_hash, one.state_hash);
  } finally { capacity.loadConfig = original; }
  data.uretimTakip[0].product_type = 'tisort';
  assert.notEqual(context.prepare(data, snapshot, 'test', '2026-10-08').state_hash, one.state_hash);
});
test('a model-deferred cut never holds today\'s slot; the next do-job is cut today', () => {
  const plan = run([facts(1, 100, 'sweat', 'cut'), facts(2, 100, 'sweat', 'cut')], '2026-10-08', 'sweat', { 1: { disposition: 'defer' } });
  const [first, second] = plan.decisions;
  assert.equal(second.disposition, 'do'); assert.equal(second.capacity.today_quantity, 100);
  assert.equal(first.disposition, 'defer'); assert.equal(first.capacity.estimated_finish, '2026-10-09');
});
test('unknown product or amount keeps the model decision without inventing amounts', () => {
  // Cutting limits depend on order size only: a job without a product still uses today's single large slot.
  const cut = run([facts(1, 100, '', 'cut'), facts(2, 100, 'sweat', 'cut')]);
  assert.equal(cut.decisions[0].disposition, 'do'); assert.equal(cut.decisions[0].capacity.today_quantity, 100);
  assert.equal(cut.decisions[1].disposition, 'defer');
  const noAmount = run([facts(1, null, 'sweat', 'cut', { order_quantity: null })]);
  assert.equal(noAmount.decisions[0].disposition, 'do'); assert.equal(noAmount.decisions[0].capacity.status, 'unavailable');
  assert.equal(noAmount.decisions[0].capacity.today_quantity, null);
  assert.match(noAmount.decisions[0].action, /^Original Adet yok/);
  const sewing = run([facts(1, 100, ''), facts(2, 100)]);
  assert.deepEqual(sewing.decisions.map(d => d.disposition), ['do', 'do']);
  assert.ok(sewing.decisions.every(d => d.capacity.status === 'unavailable' && d.capacity.today_quantity === null));
  assert.match(sewing.decisions[0].action, /^Dikime devam et\. Ürün seçilmemiş/);
  // A real obstacle still defers and uses no cutting capacity.
  const blocked = run([facts(1, 100, 'sweat', 'cut', { blocked: true, reason: 'kumaş eksik' }), facts(2, 100, 'sweat', 'cut')]);
  assert.equal(blocked.decisions[0].disposition, 'defer'); assert.equal(blocked.decisions[0].capacity.status, 'blocked');
  assert.equal(blocked.decisions[1].disposition, 'do'); assert.equal(blocked.decisions[1].capacity.today_quantity, 100);
});
