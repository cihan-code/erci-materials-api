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
const MONDAY = '2026-09-21', TUESDAY = '2026-09-22';
function job(stage = 'Dikimde', id = 1) {
  return { id, job_no: 'TEST-' + id, customer_name: 'Synthetic ' + id,
    product: 'tisort', quantity: 300, est_delivery: '2026-09-30',
    options: { printing: true, embroidery: false }, completed_operations: [...STAGE_COMPLETED[stage]] };
}
function report(entry = {}, id = 'monday') {
  return { id, date: MONDAY, entries: [{ job_id: 1, kind: 'operation', op_id: 'sewing',
    status: 'not_started', ...entry }] };
}
function check(status = 'confirmed', id = 'files', check_id = 'print_files_sent') {
  return { id, date: MONDAY, entries: [{ job_id: 1, kind: 'check', check_id, status }] };
}

test('unfinished Monday stage is carried to Tuesday without piece-count inputs', () => {
  const jobs = [job()];
  const original = JSON.stringify(jobs);
  const reports = addReport([], report({ note: 'Vakit kalmadı' }), jobs, rota);
  const plan = buildProgressPlan(rota, jobs, reports, TUESDAY);
  const row = plan.today_plan.find((r) => r.op_id === 'sewing');
  assert.equal(row.quantity, 300);
  assert.equal(row.carried_over, true);
  assert.equal(row.progress_note, 'Vakit kalmadı');
  assert.ok(!('remaining_quantity' in row));
  assert.equal(JSON.stringify(jobs), original);
});

test('sewing completed means the whole operation, while packing remains', () => {
  const jobs = [job()];
  const reports = addReport([], report({ status: 'completed' }), jobs, rota);
  const plan = buildProgressPlan(rota, jobs, reports, TUESDAY);
  assert.ok(!plan.today_plan.some((r) => r.op_id === 'sewing'));
  assert.ok(plan.today_plan.some((r) => r.op_id === 'iron_pack'));
  assert.equal(plan.progress_rows[0].status_label, 'Tamamlandı');
});

test('in-progress stays open and does not pretend to know remaining duration', () => {
  const jobs = [job()];
  const reports = addReport([], report({ status: 'in_progress' }), jobs, rota);
  const plan = buildProgressPlan(rota, jobs, reports, TUESDAY);
  assert.equal(plan.today_plan[0].progress_status, 'in_progress');
  assert.equal(plan.jobs[0].provisional, true);
  assert.ok(plan.jobs[0].unknowns.some((s) => s.includes('kalan süresi')));
});

test('unreported work is never automatically completed', () => {
  const plan = buildProgressPlan(rota, [job()], [], TUESDAY);
  assert.ok(plan.today_plan.some((r) => r.op_id === 'sewing'));
  assert.equal(plan.today_plan[0].carried_over, false);
});

test('blocked stage holds the order until an explicit release', () => {
  const jobs = [job(), job('Dikimde', 2)];
  let reports = addReport([], report({ status: 'blocked', note: 'Atölye kapalı' }), jobs, rota);
  const plan = buildProgressPlan(rota, jobs, reports, TUESDAY);
  assert.equal(plan.jobs.length, 1);
  assert.equal(plan.today_plan[0].job_id, 2);
  assert.equal(plan.needs_attention[0].kind, 'progress_blocked');
  reports = addReport(reports, report({ status: 'in_progress' }, 'release'), jobs, rota);
  assert.equal(buildProgressPlan(rota, jobs, reports, TUESDAY).jobs.length, 2);
});

test('files are requested when printing is near, but not for distant work', () => {
  const near = buildProgressPlan(rota, [job('Kesimde')], [], MONDAY);
  assert.equal(near.reminders[0].check_id, 'print_files_sent');
  assert.ok(near.today_plan.filter((r) => r.op_id.startsWith('cut_')).every((r) => r.actionable));
  const distant = { ...job('Kesimde'), completed_operations: [] };
  assert.equal(buildProgressPlan(rota, [distant], [], MONDAY).reminders.length, 0);
});

test('unknown printing files produce a question and conditional printing', () => {
  const plan = buildProgressPlan(rota, [job('Baskı/Nakışta')], [], TUESDAY);
  assert.equal(plan.reminders[0].status, 'unknown');
  assert.match(plan.reminders[0].message, /gönderildi mi/);
  const print = plan.today_plan.find((r) => r.op_id === 'print_work');
  assert.equal(print.actionable, false);
  assert.equal(print.readiness, 'confirmation_required');
  assert.equal(plan.jobs[0].provisional, true);
});

test('known missing files are an action, and confirmation persists next day', () => {
  const jobs = [job('Baskı/Nakışta')];
  let reports = addReport([], check('missing'), jobs, rota);
  let plan = buildProgressPlan(rota, jobs, reports, TUESDAY);
  assert.equal(plan.today_plan.find((r) => r.op_id === 'print_work').readiness, 'blocked');
  assert.match(plan.reminders[0].message, /gönderilmeli/);
  reports = addReport(reports, check('confirmed', 'sent'), jobs, rota);
  plan = buildProgressPlan(rota, jobs, reports, TUESDAY);
  assert.equal(plan.reminders.length, 0);
  assert.equal(plan.today_plan.find((r) => r.op_id === 'print_work').actionable, true);
});

test('file handoff neither sends the bundles nor completes printing', () => {
  const jobs = [job('Kesimde')];
  const reports = addReport([], check(), jobs, rota);
  const plan = buildProgressPlan(rota, jobs, reports, TUESDAY);
  assert.ok(plan.jobs[0].timeline.some((r) => r.op_id === 'print_dropoff'));
  assert.ok(plan.jobs[0].timeline.some((r) => r.op_id === 'print_work'));
});

test('bundle handoff does not imply file handoff or finished printing', () => {
  const jobs = [job('Baskı/Nakışta')];
  const reports = addReport([], report({ op_id: 'print_dropoff', status: 'completed' }), jobs, rota);
  const plan = buildProgressPlan(rota, jobs, reports, TUESDAY);
  assert.ok(plan.today_plan.some((r) => r.op_id === 'print_work'));
  assert.equal(plan.reminders[0].status, 'unknown');
});

test('printing and embroidery file checks are independent and job-specific', () => {
  const j = job('Baskı/Nakışta');
  j.options.embroidery = true;
  const jobs = [j, { ...j, id: 2, job_no: 'TEST-2' }];
  const reports = addReport([], check(), jobs, rota);
  const plan = buildProgressPlan(rota, jobs, reports, TUESDAY);
  assert.ok(!plan.reminders.some((r) => r.job_id === 1 && r.check_id === 'print_files_sent'));
  assert.ok(plan.reminders.some((r) => r.job_id === 1 && r.check_id === 'embroidery_files_sent'));
  assert.ok(plan.reminders.some((r) => r.job_id === 2 && r.check_id === 'print_files_sent'));
  assert.throws(() => addReport([], check('confirmed', 'x', 'embroidery_files_sent'), [job()], rota), /teyit/);
});

test('no file reminders after decoration is complete', () => {
  const plan = buildProgressPlan(rota, [job('Dikimde')], [], TUESDAY);
  assert.equal(plan.reminders.length, 0);
});

test('future reports do not affect earlier plans, retries are idempotent', () => {
  const jobs = [job()];
  const r = report({ status: 'completed' });
  const reports = addReport([], r, jobs, rota);
  assert.equal(addReport(reports, r, jobs, rota), reports);
  assert.ok(buildProgressPlan(rota, jobs, reports, '2026-09-19').today_plan.some((r) => r.op_id === 'sewing'));
  assert.throws(() => addReport(reports, report({ status: 'in_progress' }), jobs, rota), /farklı içerik/);
});

test('invalid IDs, conflicting stages, old quantity API and stale drafts are rejected', () => {
  const jobs = [job()];
  assert.throws(() => addReport([], report({ job_id: 99 }), jobs, rota), /Aktif iş/);
  assert.throws(() => addReport([], report({ op_id: 'bogus' }), jobs, rota), /işlem/);
  assert.throws(() => addReport([], report({ completed_quantity: 120 }), jobs, rota), /adetle/);
  assert.throws(() => addReport([], report({ status: 'blocked' }), jobs, rota), /neden/);
  assert.throws(() => addReport([], { ...report(), date: '2026-02-30' }, jobs, rota), /tarihi/);
  const draft = prepareReport(report(), [], jobs, rota);
  const reports = addReport([], report({ status: 'in_progress' }, 'other'), jobs, rota);
  assert.throws(() => addReport(reports, draft, jobs, rota), /taslağı yenileyin/);
  const done = addReport([], report({ status: 'completed' }), jobs, rota);
  assert.throws(() => addReport(done, report({}, 'rewind'), jobs, rota), /tamamlanmış/);
});

test('newer panel stage supersedes earlier unfinished stage', () => {
  const reports = addReport([], report(), [job()], rota);
  const plan = buildProgressPlan(rota, [job('Ütü-Pakette-Teslimat Bekliyor')], reports, TUESDAY);
  assert.ok(!plan.today_plan.some((r) => r.op_id === 'sewing'));
  assert.equal(plan.progress_rows[0].superseded_by_panel, true);
});

test('confirmation and stage batch is atomic, persistent and never rewrites panel data', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merci-stages-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const jobs = [job('Baskı/Nakışta')];
  const r = { id: 'mixed', date: MONDAY, entries: [
    ...report({ op_id: 'print_work', status: 'in_progress' }).entries, ...check().entries] };
  assert.equal(saveReport(dir, r, jobs, rota).saved, true);
  assert.equal(saveReport(dir, r, jobs, rota).saved, false);
  assert.equal(readReports(dir).length, 1);
  assert.equal(buildProgressPlan(rota, jobs, readReports(dir), TUESDAY).reminders.length, 0);
  fs.mkdirSync(path.join(dir, '.progress-lock'));
  assert.throws(() => saveReport(dir, r, jobs, rota), /kullanımda/);
  fs.rmdirSync(path.join(dir, '.progress-lock'));
  fs.writeFileSync(path.join(dir, 'progress.json'), '{"version":1,"reports":[]}');
  assert.throws(() => readReports(dir), /okunamadı/);
});
