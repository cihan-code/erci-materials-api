'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-plan-test-'));
process.env.DATA_DIR = directory;
process.env.TYPESAFE_API_KEY = 'synthetic-typesafe-key-for-tests';
after(() => fs.rmSync(directory, { recursive: true, force: true }));
const service = require('../agent/operations/service');
const core = require('../agent/operations/core');
const context = require('../agent/operations/jev-context');
const store = require('../agent/operations/store');
const panelPath = path.join(directory, 'panel-data.json');
const records = [
  { id: 1, customer_name: 'SYNTHETIC PRIVATE NAME', quantity: 100, status: 'Kumaş Geldi', decoration: 'baski', assigned_to: 'PRIVATE OWNER' },
  { id: 2, customer_name: 'B', quantity: 100, status: 'Baskı/Nakışta', decoration: 'baski' },
  { id: 3, customer_name: 'C', quantity: 80, status: 'Dikimde', decoration: 'yok' },
  { id: 4, customer_name: 'D', quantity: 50, status: 'Teslim Edildi', decoration: 'yok' },
];
function writePanel(value = records) { fs.writeFileSync(panelPath, JSON.stringify({ data: { jobs: [], uretimTakip: value } })); }
function reset() {
  fs.rmSync(path.join(directory, 'operations'), { recursive: true, force: true }); writePanel();
  fs.mkdirSync(path.join(directory, 'operations'));
  store.write({ version: 1, revision: 1, rules: {}, events: [{ id: 'actual-report', record_id: 2,
    fingerprint: core.fingerprint(records[1], []), date: '2026-10-02', entries: [
      { op: 'print_dropoff', status: 'completed', remaining: null, reason: '', issue: null },
      { op: 'print', status: 'partial', remaining: 5, reason: 'baskı kağıdı eksik', issue: 'print_paper' },
    ] }] });
}
function response(questions) {
  return { model: 'jev-1.13.0', answers: Object.fromEntries(Object.entries(questions).map(([name, question]) => {
    const keys = Object.keys(question.criteria), selected = name === 'global_priority' ? 'IS-2' : keys[0];
    return [name, { type: 'choice', choice: selected, confidence: 0.8,
      probabilities: Object.fromEntries(keys.map(key => [key, key === selected ? 1 : 0])) }];
  })) };
}
test('one final evaluation sees all stages, actual progress, blockers and accepted rules', async () => {
  reset();
  const data = { uretimTakip: records, jobs: [] }, view = service.snapshot(data, store.read(), false);
  view.knowledge.push({ issue: 'print_file', status: 'accepted', samples: 3, reminder: 'Dosyayı teyit et.' });
  view.records[1].reminders.push({ issue: 'print_file', message: 'Dosyayı teyit et.', samples: 3 });
  const prepared = context.prepare(data, view, 'jev-latest');
  assert.equal(prepared.state.production_records.length, 4);
  assert.equal(prepared.state.production_records[1].reported_operations[1].remaining, 5);
  assert.equal(prepared.state.production_records[1].blockers[0].issue, 'print_paper');
  assert.equal(prepared.state.production_records[1].approved_reminders[0].issue, 'print_file');
  assert.equal(prepared.state.production_records[3].next_safe_task, null);
  assert.equal(Object.keys(prepared.questions).length, 4);
  assert.match(prepared.questions['action_IS-2'].instructions, /IS-2/);
});
test('panel and daily consumers reuse one current result; ordinary reads never evaluate', async () => {
  reset(); let calls = 0;
  const infer = async (state, questions) => { calls++; return response(questions); };
  const first = await service.finalPlan(infer), second = await service.finalPlan(infer);
  assert.equal(calls, 1); assert.equal(first.plan.status, 'ready');
  assert.equal(first.plan.record_count, 3); assert.equal(first.plan.considered_count, 4);
  assert.equal(first.plan.state_hash, first.state_hash);
  const printed = first.plan.decisions.find(d => d.record_id === 2);
  assert.equal(printed.priority, 1); assert.match(printed.action, /Önce engeli gider/); assert.match(printed.action, /kalan 5/);
  assert.equal(first.plan.state_hash, second.plan.state_hash);
  assert.equal(service.snapshot().plan.source, 'jev'); assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(first.plan), /synthetic-typesafe-key|credential_fingerprint/);
});
test('global planning context hides customer and owner names', () => {
  reset(); const prepared = context.prepare({ uretimTakip: records, jobs: [] }, service.snapshot(undefined, undefined, false), 'jev-latest');
  assert.doesNotMatch(JSON.stringify({ state: prepared.state, questions: prepared.questions }), /PRIVATE NAME|PRIVATE OWNER/);
  assert.equal(prepared.state.production_records[0].owner, 'SORUMLU-1');
});
test('duplicate callers share an in-flight evaluation and changed state rejects its result', async () => {
  reset(); let finish, calls = 0;
  const infer = (state, questions) => { calls++; return new Promise(resolve => { finish = () => resolve(response(questions)); }); };
  const first = service.finalPlan(infer), second = service.finalPlan(infer);
  finish(); await Promise.all([first, second]); assert.equal(calls, 1);
  reset();
  const pending = service.finalPlan(infer);
  writePanel(records.map(r => r.id === 3 ? { ...r, note: 'New planning constraint' } : r));
  finish(); await assert.rejects(pending, /değişti/);
  assert.equal(service.snapshot().plan.status, 'stale');
});
test('edited notes, ownership, deadlines and rules invalidate cached global decisions', async () => {
  reset(); const infer = async (state, questions) => response(questions);
  await service.finalPlan(infer);
  for (const changes of [{ note: 'Changed' }, { assigned_to: 'Changed' }, { follow_up_date: '2026-10-03' }, { est_delivery: '2026-10-04' }]) {
    writePanel(records.map(r => r.id === 1 ? { ...r, ...changes } : r));
    assert.equal(service.snapshot().plan.status, 'stale'); writePanel();
  }
  const ledger = store.read(); ledger.revision++; store.write(ledger);
  assert.equal(service.snapshot().plan.status, 'stale');
});
test('invalid complete response falls back without fabricating progress or Jev source', async () => {
  reset(); const before = fs.readFileSync(panelPath, 'utf8');
  const result = await service.finalPlan(async () => ({ model: 'jev-1.13.0', answers: {} }));
  assert.equal(result.plan.status, 'fallback'); assert.equal(result.plan.source, 'rules');
  assert.match(result.plan.decisions.find(d => d.record_id === 2).action, /kalan 5/);
  assert.equal(store.read().revision, 1); assert.equal(fs.readFileSync(panelPath, 'utf8'), before);
});
test('completion removes legal tasks, stale reports only allow confirmation, closed jobs remain context', () => {
  reset(); const data = { uretimTakip: records, jobs: [] }, view = service.snapshot(data, store.read(), false);
  view.records[1].entries[1] = { ...view.records[1].entries[1], status: 'completed', remaining: null, reason: '', issue: null };
  view.records[1].revision = core.revision(records[1], view.records[1].entries, 'baski');
  let prepared = context.prepare(data, view, 'jev-latest');
  assert.equal(prepared.tasks.find(t => t.record_id === 2).key, 'sewing_handoff');
  assert.doesNotMatch(prepared.tasks.find(t => t.record_id === 2).action, /kalan 5/);
  view.records[1].stale = true; prepared = context.prepare(data, view, 'jev-latest');
  assert.deepEqual(Object.keys(prepared.questions['action_IS-2'].criteria), ['confirm', 'defer']);
  const earlier = core.revision(records[2], [{ op: 'cut', status: 'completed' }], 'yok');
  assert.equal(earlier.status, 'Kesimde'); assert.equal(earlier.previous_stage_report, undefined);
});
test('empty planning makes no paid call; limit overflow never silently drops jobs', async () => {
  reset(); writePanel([records[3]]);
  const result = await service.finalPlan(async () => assert.fail('No work means no model call'));
  assert.equal(result.plan.status, 'empty'); assert.equal(result.plan.record_count, 0); assert.equal(result.plan.considered_count, 1);
  const many = Array.from({ length: 256 }, (_, id) => ({ ...records[0], id: id + 100 }));
  const prepared = context.prepare({ uretimTakip: many, jobs: [] }, service.snapshot({ uretimTakip: many, jobs: [] }, store.read(), false), 'jev-latest');
  assert.equal(prepared.tasks.length, 256); assert.ok(prepared.limit_reason);
});

test('corrupted cached decisions are discarded and never presented as a valid final plan', async () => {
  reset(); const infer = async (state, questions) => response(questions);
  await service.finalPlan(infer);
  const cacheFile = path.join(directory, 'operations/jev-plan.json');
  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); cache.decisions.pop();
  fs.writeFileSync(cacheFile, JSON.stringify(cache));
  assert.equal(service.snapshot().plan.status, 'stale');
  let calls = 0; const result = await service.finalPlan(async (state, questions) => { calls++; return response(questions); });
  assert.equal(calls, 1); assert.equal(result.plan.decisions.length, 3);
});


test('null cache values and null decision entries are disposable without breaking the journal', async () => {
  reset(); const infer = async (state, questions) => response(questions);
  await service.finalPlan(infer);
  const cacheFile = path.join(directory, 'operations/jev-plan.json');
  const valid = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  for (const invalid of [null, { ...valid, decisions: [null, ...valid.decisions.slice(1)] }]) {
    fs.writeFileSync(cacheFile, JSON.stringify(invalid));
    assert.equal(service.snapshot().plan.status, 'stale');
    assert.equal(store.read().revision, 1);
  }
});
