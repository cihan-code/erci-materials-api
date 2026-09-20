'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const rota = require('../agent/uretim/rota.json');
const { STAGE_COMPLETED } = require('../agent/uretim/panelAdapter');
const { addReport, prepareReport, buildProgressPlan } = require('../agent/uretim/progress');
const { readReports, saveReport } = require('../agent/uretim/progressStore');

function job(id = 1) {
  return { id, job_no: 'TEST-' + id, customer_name: 'Synthetic customer ' + id,
    product: 'tisort', quantity: 300, est_delivery: '2026-09-25',
    options: { printing: true, embroidery: false },
    completed_operations: [...STAGE_COMPLETED.Dikimde] };
}
function report(quantity = 120, extra = {}) {
  return { id: 'monday-1', date: '2026-09-21', entries: [{
    job_id: 1, op_id: 'sewing', status: 'in_progress', completed_quantity: quantity, ...extra }] };
}
const TUESDAY = '2026-09-22';

test('Monday partial work leaves 180 for Tuesday and preserves order/packing quantities', () => {
  const jobs = [job()];
  const before = JSON.stringify(jobs);
  const reports = addReport([], report(), jobs, rota);
  const plan = buildProgressPlan(rota, jobs, reports, TUESDAY);
  const row = plan.today_plan.find((r) => r.op_id === 'sewing');
  assert.equal(row.quantity, 300);
  assert.equal(row.remaining_quantity, 180);
  assert.equal(row.carried_over, true);
  assert.equal(plan.jobs[0].timeline.find((o) => o.op_id === 'sewing').end, '2026-09-23');
  assert.equal(JSON.stringify(jobs), before);
  assert.equal(plan.jobs[0].quantity, 300);
});

test('completed sewing does not repeat next morning; packing still remains', () => {
  const reports = addReport([], report(300, { status: 'completed' }), [job()], rota);
  const plan = buildProgressPlan(rota, [job()], reports, TUESDAY);
  assert.ok(!plan.today_plan.some((r) => r.op_id === 'sewing'));
  assert.equal(plan.today_plan.find((r) => r.op_id === 'iron_pack').remaining_quantity, 300);
});

test('not started and unreported work are never silently completed', () => {
  const reports = addReport([], report(0, { status: 'not_started', note: 'Vakit kalmadı' }), [job()], rota);
  const plan = buildProgressPlan(rota, [job(), job(2)], reports, TUESDAY);
  assert.equal(plan.today_plan[0].remaining_quantity, 300);
  assert.equal(plan.today_plan[0].progress_note, 'Vakit kalmadı');
  assert.ok(plan.jobs[1].timeline.some((o) => o.op_id === 'sewing'));
});

test('blocked work reserves no capacity and waits until explicitly released', () => {
  const jobs = [job(), job(2)];
  let reports = addReport([], report(120, { status: 'blocked', note: 'Atölye bekliyor' }), jobs, rota);
  const plan = buildProgressPlan(rota, jobs, reports, TUESDAY);
  assert.equal(plan.jobs.length, 1);
  assert.equal(plan.today_plan[0].job_id, 2);
  assert.equal(plan.needs_attention[0].kind, 'progress_blocked');
  reports = addReport(reports, { ...report(), id: 'release', date: TUESDAY }, jobs, rota);
  assert.equal(buildProgressPlan(rota, jobs, reports, TUESDAY).jobs.length, 2);
});

test('future progress cannot change an earlier plan', () => {
  const reports = addReport([], report(), [job()], rota);
  const plan = buildProgressPlan(rota, [job()], reports, '2026-09-19');
  assert.equal(plan.today_plan[0].remaining_quantity, 300);
});

test('idempotent retries and cumulative totals never double subtract', () => {
  const reports = addReport([], report(), [job()], rota);
  assert.equal(addReport(reports, report(), [job()], rota), reports);
  const twice = addReport(reports, { ...report(), id: 'same-total' }, [job()], rota);
  assert.equal(buildProgressPlan(rota, [job()], twice, TUESDAY).today_plan[0].remaining_quantity, 180);
  assert.throws(() => addReport(reports, report(150), [job()], rota), /farklı içerik/);
});

test('newer cumulative totals replace rather than add to previous totals', () => {
  let reports = addReport([], report(), [job()], rota);
  reports = addReport(reports, { ...report(200), id: 'tuesday', date: TUESDAY }, [job()], rota);
  assert.equal(buildProgressPlan(rota, [job()], reports, '2026-09-23').today_plan[0].remaining_quantity, 100);
  assert.throws(() => addReport(reports, { ...report(150), id: 'late' }, [job()], rota), /daha yeni/);
});

test('invalid amounts, dates, jobs and operations are rejected', () => {
  for (const amount of [-1, 301, 1.5, '120']) {
    assert.throws(() => addReport([], report(amount), [job()], rota));
  }
  assert.throws(() => addReport([], { ...report(), date: '2026-02-30' }, [job()], rota));
  assert.throws(() => addReport([], report(120, { job_id: 999 }), [job()], rota));
  assert.throws(() => addReport([], report(120, { op_id: 'unknown' }), [job()], rota));
  assert.throws(() => addReport([], report(120, { status: 'completed' }), [job()], rota));
  assert.throws(() => addReport([], report(0, { status: 'blocked' }), [job()], rota));
});

test('progress belongs to each operation, not to the whole order', () => {
  const j = { ...job(), completed_operations: [...STAGE_COMPLETED.Kesimde] };
  const r = report(300, { op_id: 'cut_main', status: 'completed' });
  const plan = buildProgressPlan(rota, [j], addReport([], r, [j], rota), TUESDAY);
  assert.ok(!plan.today_plan.some((o) => o.op_id === 'cut_main'));
  assert.equal(plan.today_plan.find((o) => o.op_id === 'cut_extra_parts').remaining_quantity, 300);
  assert.ok(plan.jobs[0].timeline.some((o) => o.op_id === 'sewing'));
});

test('newer panel stage supersedes old partial progress without rewinding', () => {
  const reports = addReport([], report(), [job()], rota);
  const j = { ...job(), completed_operations: [...STAGE_COMPLETED['Ütü-Pakette-Teslimat Bekliyor']] };
  const plan = buildProgressPlan(rota, [j], reports, TUESDAY);
  assert.ok(!plan.jobs[0].timeline.some((o) => o.op_id === 'sewing'));
  assert.throws(() => addReport([], report(), [j], rota), /Panel/);
});

test('a reduced order quantity conflicting with progress is held for review', () => {
  const reports = addReport([], report(), [job()], rota);
  const plan = buildProgressPlan(rota, [{ ...job(), quantity: 100 }], reports, TUESDAY);
  assert.equal(plan.jobs.length, 0);
  assert.equal(plan.needs_attention[0].kind, 'progress_conflict');
});

test('daily increments are calculated in code with a known baseline', () => {
  const reports = addReport([], report(), [job()], rota);
  const draft = { id: 'today', date: TUESDAY, entries: [{ job_id: 1, op_id: 'sewing',
    status: 'in_progress', quantity_mode: 'increment', quantity: 50 }] };
  const prepared = prepareReport(draft, reports, [job()], rota);
  assert.equal(prepared.entries[0].completed_quantity, 170);
  assert.throws(() => prepareReport(draft, [], [job()], rota), /Önceki/);
  const concurrent = addReport(reports, { ...report(150), id: 'other', date: TUESDAY }, [job()], rota);
  assert.throws(() => addReport(concurrent, prepared, [job()], rota), /taslağı yenileyin/);
});

test('persistent storage is atomic, idempotent and does not hide corrupt files', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercitex-progress-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(saveReport(dir, report(), [job()], rota).saved, true);
  assert.equal(saveReport(dir, report(), [job()], rota).saved, false);
  assert.equal(readReports(dir).length, 1);
  fs.mkdirSync(path.join(dir, '.progress-lock'));
  assert.throws(() => saveReport(dir, report(), [job()], rota), /kullanımda/);
  fs.rmdirSync(path.join(dir, '.progress-lock'));
  fs.writeFileSync(path.join(dir, 'progress.json'), 'broken');
  assert.throws(() => readReports(dir));
  assert.throws(() => saveReport(dir, report(), [job()], rota));
  assert.equal(fs.readFileSync(path.join(dir, 'progress.json'), 'utf8'), 'broken');
});
