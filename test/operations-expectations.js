'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expectations-'));
process.env.DATA_DIR = dir;
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const expectations = require('../agent/operations/expectations');
const core = require('../agent/operations/core');
const service = require('../agent/operations/service');
const context = require('../agent/operations/jev-context');
const panel = require('../agent/store');
const journal = require('../agent/operations/store');
const { istanbulDay } = require('../agent/lib/util');

test('day words resolve in code from the report day (Friday 09.10.2026)', () => {
  const day = '2026-10-09', r = w => expectations.resolve(w, day);
  assert.equal(r('pazartesi'), '2026-10-12'); assert.equal(r('Salı akşam'), '2026-10-13');
  assert.equal(r('cuma'), '2026-10-09'); assert.equal(r('cumartesi'), '2026-10-10'); assert.equal(r('pazar'), '2026-10-11');
  assert.equal(r('haftaya pazartesi'), '2026-10-19'); assert.equal(r('yarın'), '2026-10-10'); assert.equal(r('öbür gün'), '2026-10-11');
  assert.equal(r('bugün'), day); assert.equal(r('13.10'), '2026-10-13'); assert.equal(r('13 Ekim'), '2026-10-13');
  assert.equal(r('05.01'), '2027-01-05'); assert.equal(r('pazartesi 17.30'), '2026-10-12');
  for (const bad of ['31.02', '01.10.2026', 'gelecek ay', '', '20.03.2027']) assert.equal(r(bad), null, bad);
});

test('expectations need exact evidence containing the day words; one per operation', () => {
  const text = 'Nakış pazartesi bitecek, dikim de çarşamba biter. Salı teslim.';
  const list = expectations.validate([
    { op: 'embroidery', when: 'pazartesi', evidence: 'Nakış pazartesi bitecek' },
    { op: 'embroidery', when: 'çarşamba', evidence: 'dikim de çarşamba biter' },
    { op: 'sewing', when: 'perşembe', evidence: 'dikim de çarşamba biter' },
    { op: 'delivery', when: 'Salı', evidence: 'Salı teslim edilecek' },
    { op: 'unknown', when: 'pazartesi', evidence: 'Nakış pazartesi bitecek' }, null, 'x'], text, '2026-10-09', core.OPS);
  assert.deepEqual(list.map(x => [x.op, x.date]), [['embroidery', '2026-10-14']]);
});

test('reminders are upcoming, due on the day, overdue after it, and close when done', () => {
  const record = { id: 1, status: 'Baskı/Nakışta' };
  const events = [{ id: 'e1', record_id: 1, date: '2026-10-09', entries: [{ op: 'embroidery_dropoff', status: 'completed' }],
    expectations: [{ op: 'embroidery', when: 'pazartesi', date: '2026-10-12', evidence: 'kalanı da pazartesi akşam bitecek' },
      { op: 'delivery', when: 'Salı', date: '2026-10-13', evidence: 'Salı teslim' }] }];
  const at = day => expectations.open(record, events, day, core.OPS);
  assert.deepEqual(at('2026-10-10').map(x => [x.op, x.status]), [['embroidery', 'upcoming']]);
  assert.equal(at('2026-10-12')[0].text, 'Bugün bekleniyor: Nakış — “kalanı da pazartesi akşam bitecek” (09.10 bildirimi).');
  assert.match(at('2026-10-13')[0].text, /^Nakış 12\.10 tarihinde bitecekti; durumu teyit et/);
  const done = [...events, { id: 'e2', record_id: 1, date: '2026-10-12', entries: [{ op: 'embroidery', status: 'completed' }] }];
  assert.deepEqual(expectations.open(record, done, '2026-10-13', core.OPS), []);
  assert.deepEqual(expectations.open({ ...record, status: 'Dikimde' }, events, '2026-10-13', core.OPS), []);
  assert.deepEqual(expectations.open(record, [{ ...events[0], voided: 'x' }], '2026-10-13', core.OPS), []);
  assert.deepEqual(expectations.open({ ...record, status: 'Teslim Edildi' }, events, '2026-10-13', core.OPS), []);
});

// Service flow with real journal/panel files; the interpreter is a stub.
const today = istanbulDay(new Date());
const plus = n => new Date(Date.parse(today + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const base = { id: 7, customer_name: 'Synthetic', quantity: 100, status: 'Kesimde', decoration: 'nakis', est_delivery: plus(10), note: 'Keep' };
function reset(record = base) {
  fs.rmSync(path.join(dir, 'operations'), { recursive: true, force: true });
  fs.writeFileSync(panel.PANEL_DATA_FILE, JSON.stringify({ data: { uretimTakip: [record], jobs: [] }, auth: { keep: 'auth' }, updatedAt: 'test' }));
}
function params(text, id) { const s = service.snapshot(); return { record_id: 7, request_id: id, text, revision: s.revision, fingerprint: s.records[0].fingerprint }; }
const current = () => panel.loadPanelData().data.uretimTakip[0];
const TEXT = 'Nakışa bırakıldı. Yarın nakış bitecek, öbür gün teslim edilmesi gerekiyor.';
const infer = (entries, list) => async () => ({ clarification: '', entries, expectations: list, usage: {} });
const DROP = [{ op: 'embroidery_dropoff', status: 'completed', remaining: null, reason: '', issue: null, evidence: 'Nakışa bırakıldı.' }];
const PLANS = [{ op: 'embroidery', when: 'Yarın', evidence: 'Yarın nakış bitecek' }, { op: 'delivery', when: 'öbür gün', evidence: 'öbür gün teslim edilmesi gerekiyor' }];

test('a stated delivery date updates Tahmini Teslimat with the stage; undo restores both', async () => {
  reset();
  const res = await service.submit(params(TEXT, 'exp-report-001'), infer(DROP, PLANS));
  assert.equal(current().status, 'Baskı/Nakışta'); assert.equal(current().est_delivery, plus(2));
  assert.equal(current().note, 'Keep'); assert.equal(panel.readPanelRaw().auth.keep, 'auth');
  assert.equal(res.stage_sync.status, 'applied'); assert.equal(res.stage_sync.to_delivery, plus(2));
  assert.match(res.summary, /Beklenti: Nakış/); assert.match(res.summary, /Tahmini teslimat: /);
  const record = res.snapshot.records[0];
  assert.equal(record.stale, false);
  assert.deepEqual(record.expectations.map(x => [x.op, x.date, x.status]), [['embroidery', plus(1), 'upcoming']]);
  assert.equal(record.history[0].delivery_change.to, plus(2));
  const undone = await service.undo({ event_id: 'exp-report-001', revision: res.snapshot.revision });
  assert.equal(current().status, 'Kesimde'); assert.equal(current().est_delivery, plus(10));
  assert.deepEqual(undone.records[0].expectations, []);
});

test('expectation-only and delivery-only reports never move the stage and never look stale', async () => {
  reset();
  let res = await service.submit(params('Yarın nakış bitecek.', 'exp-report-002'), infer([], [PLANS[0]]));
  assert.equal(res.saved, true); assert.equal(res.stage_sync, null); assert.equal(current().status, 'Kesimde');
  assert.equal(res.snapshot.records[0].stale, false); assert.equal(res.snapshot.records[0].revision, null);
  res = await service.submit(params('öbür gün teslim edilmesi gerekiyor', 'exp-report-003'), infer([], [PLANS[1]]));
  assert.equal(current().status, 'Kesimde'); assert.equal(current().est_delivery, plus(2));
  assert.equal(res.snapshot.records[0].stale, false);
  // A later manual date change is kept by undo.
  const { data, updatedAt } = panel.loadPanelData(); data.uretimTakip[0].est_delivery = plus(5); panel.writePanelData(data, updatedAt);
  const undone = await service.undo({ event_id: 'exp-report-003', revision: service.snapshot().revision });
  assert.equal(current().est_delivery, plus(5)); assert.equal(undone.stage_sync, null);
  // Nothing actual and nothing dated is still rejected.
  await assert.rejects(service.submit(params('Bakarız.', 'exp-report-004'), infer([], [])), /İşlem anlaşılamadı/);
});

test('the same date as the panel changes nothing; Jev sees open expectations', async () => {
  reset({ ...base, est_delivery: plus(2) });
  const res = await service.submit(params(TEXT, 'exp-report-005'), infer(DROP, PLANS));
  assert.equal(res.stage_sync.to_delivery, undefined); assert.equal(current().est_delivery, plus(2));
  const data = panel.loadPanelData().data;
  const prepared = context.prepare(data, service.snapshot(data, journal.read(), false), 'jev-latest');
  assert.deepEqual(prepared.state.production_records[0].expectations, [{ op: 'embroidery', date: plus(1), status: 'upcoming' }]);
});
