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
function params(quantity = 120, extras = {}) {
  return { date: '2026-09-21', entries: [{ job_id: 101, op_id: 'sewing',
    status: 'in_progress', quantity_mode: 'total', quantity, ...extras }] };
}
function respond(p) {
  response = { reply: 'Model must not claim success itself', actions: [{
    type: 'record_production_progress', params_json: JSON.stringify(p), reason: 'Reported production' }] };
}

test('Ajana söyle -> agent ledger -> next morning generator, panel untouched', async () => {
  reset();
  const original = fs.readFileSync(file, 'utf8');
  respond(params());
  const result = await interpretAndAct('TEST-101 dikiminde toplam 120 adet tamamlandı.');
  assert.equal(calls, 1);
  assert.equal(result.errors.length, 0);
  assert.equal(result.applied.length, 1);
  assert.match(result.reply, /180 adet kaldı/);
  assert.ok(request.user.includes('TEST-101'));
  assert.ok(request.user.includes('sewing'));
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.ok(!fs.existsSync(path.join(directory, 'paneldata-backups')));
  const plan = buildProductionPlan(data, '2026-09-22').plan;
  assert.equal(plan.today_plan[0].remaining_quantity, 180);
  assert.equal(plan.today_plan[0].carried_over, true);
  const signals = OP['gunluk-uretim-plani'].signals(data, '2026-09-22', null);
  assert.match(signals, /bu işlemde kalan 180 adet/);
  assert.match(signals, /ÖNCEKİ GÜNDEN KALAN/);
});

test('same instruction retry does not add another report or double count increments', async () => {
  reset();
  respond(params(80, { quantity_mode: 'increment', first_progress: true }));
  const text = 'TEST-101 dikimine ilk kez başladık, bugün 80 adet yaptık.';
  await interpretAndAct(text);
  const result = await interpretAndAct(text);
  assert.equal(readReports(path.join(directory, 'uretim')).length, 1);
  assert.match(result.reply, /zaten kaydedilmiş/);
  assert.equal(buildProductionPlan(data, '2026-09-22').plan.today_plan[0].remaining_quantity, 220);
});

test('a subsequent daily increment adds to the saved cumulative total', async () => {
  reset();
  respond(params());
  await interpretAndAct('TEST-101 toplam 120 dikildi.');
  process.env.PANEL_TODAY = '2026-09-22';
  respond({ ...params(50, { quantity_mode: 'increment' }), date: '2026-09-22' });
  const result = await interpretAndAct('TEST-101 bugün 50 daha dikildi.');
  assert.match(result.reply, /toplam 170 adet tamamlandı, 130 adet kaldı/);
});

test('invalid progress returns an error, never a false saved reply', async () => {
  reset();
  respond(params(999));
  const result = await interpretAndAct('TEST-101 toplam 999 dikildi.');
  assert.equal(result.applied.length, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.reply, /kaydedilemedi/);
  assert.equal(readReports(path.join(directory, 'uretim')).length, 0);
});

test('unknown prior total asks for clarification rather than assuming zero', async () => {
  reset();
  respond(params(80, { quantity_mode: 'increment' }));
  const result = await interpretAndAct('TEST-101 bugün 80 dikildi.');
  assert.match(result.errors[0].error, /Önceki tamamlanan toplam bilinmiyor/);
  assert.equal(readReports(path.join(directory, 'uretim')).length, 0);
});

test('the whole operation can be completed without model arithmetic', async () => {
  reset();
  respond(params(undefined, { quantity_mode: 'all', status: 'completed' }));
  await interpretAndAct('TEST-101 dikiminin tamamı bitti.');
  const plan = buildProductionPlan(data, '2026-09-22').plan;
  assert.ok(!plan.today_plan.some((r) => r.op_id === 'sewing'));
  assert.ok(plan.today_plan.some((r) => r.op_id === 'iron_pack'));
});

test('a blocked job is visible in next morning attention, not executable work', async () => {
  reset();
  respond(params(0, { status: 'blocked', note: 'Atölye kapalı' }));
  await interpretAndAct('TEST-101 hiç dikilmedi, atölye kapalı, beklet.');
  const built = buildProductionPlan(data, '2026-09-22');
  assert.equal(built.plan.today_plan.length, 0);
  assert.equal(built.needs_attention[0].job_no, 'TEST-101');
  assert.match(OP['gunluk-uretim-plani'].signals(data, '2026-09-22', null), /Atölye kapalı/);
});

test('dry-run creates no ledger and a mixed valid/invalid batch is atomic', () => {
  reset();
  assert.match(actions.dryRun('record_production_progress', params()), /180 adet kaldı/);
  assert.equal(readReports(path.join(directory, 'uretim')).length, 0);
  const mixed = params();
  mixed.entries.push({ ...mixed.entries[0], job_id: 999 });
  assert.throws(() => actions.applyAction('record_production_progress', mixed), /Aktif iş/);
  assert.equal(readReports(path.join(directory, 'uretim')).length, 0);
});

test('future-dated actual production is rejected', () => {
  reset();
  assert.throws(() => actions.applyAction('record_production_progress', {
    ...params(), date: '2026-09-22' }), /Gelecekteki/);
});

test('malformed model parameters produce an action error without saving', async () => {
  reset();
  respond(null);
  const result = await interpretAndAct('TEST-101 ilerleme bildirimi');
  assert.equal(result.applied.length, 0);
  assert.match(result.errors[0].error, /nesne/);
  assert.equal(readReports(path.join(directory, 'uretim')).length, 0);
});
