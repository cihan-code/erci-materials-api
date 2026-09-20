'use strict';

// Synthetic integration tests; no server, credentials, or model requests.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'merci-progress-integration-'));
process.env.DATA_DIR = directory;
process.env.PANEL_TODAY = '2026-09-21';
after(() => fs.rmSync(directory, { recursive: true, force: true }));

let response;
let request;
let calls = 0;
const claudePath = require.resolve('../agent/claude');
require.cache[claudePath] = { id: claudePath, filename: claudePath, loaded: true,
  exports: { callClaude: async (options) => {
    calls++;
    request = options;
    return { text: JSON.stringify(response), model: 'test', costUsd: 0 };
  } } };

const { interpretAndAct } = require('../agent/act');
const actions = require('../agent/actions');
const { buildProductionPlan } = require('../agent/uretim/planSignals');
const { OP } = require('../agent/generate');
const { readReports } = require('../agent/uretim/progressStore');
const file = path.join(directory, 'panel-data.json');
const data = { jobs: [{ id: 101, job_no: 'TEST-101', status: 'Üretimde',
  customer_name_free: 'Synthetic workshop order', quantity: 300, product_type: 'Tişört',
  delivery_date: '2026-09-30', baski_nakis_secim: { items: [{ type: 'baski' }] } }],
  uretimTakip: [{ id: 55, job_id: 101, status: 'Dikimde', quantity: 300 }] };

function reset() {
  fs.rmSync(path.join(directory, 'uretim'), { recursive: true, force: true });
  fs.writeFileSync(file, JSON.stringify({ data, updatedAt: '2026-09-21T12:00:00Z' }));
  process.env.PANEL_TODAY = '2026-09-21';
  calls = 0;
}
function params(status = 'not_started', extras = {}) {
  return { date: '2026-09-21', entries: [{ job_id: 101, kind: 'operation', op_id: 'sewing',
    status, ...extras }] };
}
function respond(p) {
  response = { reply: 'Model must not claim success itself', actions: [{
    type: 'record_production_progress', params_json: JSON.stringify(p), reason: 'Reported stage' }] };
}
function printingPanel() {
  const copy = JSON.parse(JSON.stringify(data));
  copy.uretimTakip[0].status = 'Baskı/Nakışta';
  fs.writeFileSync(file, JSON.stringify({ data: copy, updatedAt: '2026-09-21T12:00:00Z' }));
  return copy;
}

test('Ajana söyle -> unfinished stage -> next morning plan without quantity input', async () => {
  reset();
  const original = fs.readFileSync(file, 'utf8');
  respond(params('not_started', { note: 'Vakit kalmadı' }));
  const result = await interpretAndAct('TEST-101 dikilemedi, vakit kalmadı.');
  assert.equal(calls, 1);
  assert.equal(result.errors.length, 0);
  assert.equal(result.applied.length, 1);
  assert.match(result.reply, /Başlanmadı/);
  assert.ok(!result.reply.includes('adet'));
  assert.ok(request.user.includes('TEST-101'));
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.ok(!fs.existsSync(path.join(directory, 'paneldata-backups')));
  const plan = buildProductionPlan(data, '2026-09-22').plan;
  assert.equal(plan.today_plan[0].carried_over, true);
  const signals = OP['gunluk-uretim-plani'].signals(data, '2026-09-22', null);
  assert.match(signals, /ÖNCEKİ GÜNDEN KALAN/);
  assert.ok(!signals.includes('bu işlemde kalan'));
});

test('completed whole-order stage disappears without asking how many pieces', async () => {
  reset();
  respond(params('completed'));
  const result = await interpretAndAct('TEST-101 dikildi.');
  assert.match(result.reply, /Tamamlandı/);
  const plan = buildProductionPlan(data, '2026-09-22').plan;
  assert.ok(!plan.today_plan.some((r) => r.op_id === 'sewing'));
  assert.ok(plan.today_plan.some((r) => r.op_id === 'iron_pack'));
});

test('printing file reminder is answered through existing chat and persists', async () => {
  reset();
  const panel = printingPanel();
  const original = fs.readFileSync(file, 'utf8');
  let plan = buildProductionPlan(panel, '2026-09-22').plan;
  assert.equal(plan.reminders[0].check_id, 'print_files_sent');
  respond({ date: '2026-09-21', entries: [{ job_id: 101, kind: 'check',
    check_id: 'print_files_sent', status: 'confirmed' }] });
  const result = await interpretAndAct('TEST-101 baskı dosyaları baskıcıya gönderildi.');
  assert.match(result.reply, /Teyit edildi/);
  assert.ok(request.user.includes('print_files_sent'));
  plan = buildProductionPlan(panel, '2026-09-22').plan;
  assert.equal(plan.reminders.length, 0);
  assert.ok(plan.today_plan.some((r) => r.op_id === 'print_work'));
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('missing files produce preparation action, not a fictitious ready-to-print job', async () => {
  reset();
  const panel = printingPanel();
  respond({ date: '2026-09-21', entries: [{ job_id: 101, kind: 'check',
    check_id: 'print_files_sent', status: 'missing' }] });
  await interpretAndAct('TEST-101 baskı dosyaları henüz gönderilmedi.');
  const plan = buildProductionPlan(panel, '2026-09-22').plan;
  assert.equal(plan.today_plan.find((r) => r.op_id === 'print_work').actionable, false);
  const signals = OP['gunluk-uretim-plani'].signals(panel, '2026-09-22', null);
  assert.match(signals, /HAZIRLIK EKSİK/);
  assert.match(signals, /dosyaları baskıcıya gönderilmeli/);
});

test('same instruction retries do not create duplicate stage reports', async () => {
  reset();
  respond(params());
  const text = 'TEST-101 dikilemedi.';
  await interpretAndAct(text);
  const result = await interpretAndAct(text);
  assert.equal(readReports(path.join(directory, 'uretim')).length, 1);
  assert.match(result.reply, /zaten kaydedilmiş/);
});

test('piece-count payloads fail explicitly rather than returning fake success', async () => {
  reset();
  respond(params('in_progress', { completed_quantity: 120 }));
  const result = await interpretAndAct('TEST-101 dikimde.');
  assert.equal(result.applied.length, 0);
  assert.match(result.errors[0].error, /adetle/);
  assert.match(result.reply, /kaydedilemedi/);
});

test('blocked stage stays visible to the morning planner', async () => {
  reset();
  respond(params('blocked', { note: 'Atölye kapalı' }));
  await interpretAndAct('TEST-101 dikimi atölye kapalı olduğu için bekliyor.');
  const built = buildProductionPlan(data, '2026-09-22');
  assert.equal(built.plan.today_plan.length, 0);
  assert.equal(built.needs_attention[0].job_no, 'TEST-101');
});

test('dry-run does not save, invalid multi-entry batches are atomic', () => {
  reset();
  assert.match(actions.dryRun('record_production_progress', params()), /Başlanmadı/);
  assert.equal(readReports(path.join(directory, 'uretim')).length, 0);
  const mixed = params();
  mixed.entries.push({ ...mixed.entries[0], job_id: 999 });
  assert.throws(() => actions.applyAction('record_production_progress', mixed), /Aktif iş/);
  assert.equal(readReports(path.join(directory, 'uretim')).length, 0);
});

test('future actual-stage reports are rejected', () => {
  reset();
  assert.throws(() => actions.applyAction('record_production_progress', {
    ...params(), date: '2026-09-22' }), /Gelecekteki/);
});

test('clarification-only model response does not mutate the ledger', async () => {
  reset();
  response = { reply: 'Hangi siparişin baskı dosyasını kastediyorsunuz?', actions: [] };
  const result = await interpretAndAct('Evet gönderdik.');
  assert.match(result.reply, /Hangi sipariş/);
  assert.equal(result.applied.length, 0);
  assert.equal(readReports(path.join(directory, 'uretim')).length, 0);
});

test('malformed model parameters return a normal action error', async () => {
  reset();
  respond(null);
  const result = await interpretAndAct('TEST-101 ilerleme bildirimi');
  assert.equal(result.applied.length, 0);
  assert.match(result.errors[0].error, /nesne/);
});
