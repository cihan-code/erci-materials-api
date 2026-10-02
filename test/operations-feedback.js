'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operations-test-'));
process.env.DATA_DIR = dir;
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const service = require('../agent/operations/service');
const journal = require('../agent/operations/store');
const core = require('../agent/operations/core');
const record = { id: 7, customer_name: 'Örnek A ürünü', quantity: 100, status: 'Kesimde', decoration: 'baski' };
const panelPath = path.join(dir, 'panel-data.json');
const text = 'Baskıya götürüldü. Beş tanesinin baskı kağıdı eksik, diğerleri basıldı.';
const entries = [
  { op: 'print_dropoff', status: 'completed', remaining: null, reason: '', issue: null, evidence: 'Baskıya götürüldü.' },
  { op: 'print', status: 'partial', remaining: 5, reason: 'baskı kağıdı eksik', issue: 'print_paper', evidence: 'Beş tanesinin baskı kağıdı eksik, diğerleri basıldı.' },
];
function reset() {
  fs.rmSync(path.join(dir, 'operations'), { recursive: true, force: true });
  fs.writeFileSync(panelPath, JSON.stringify({ data: { uretimTakip: [record] }, updatedAt: 'test' }));
}
function params(id = 'report-0001', value = text) {
  const view = service.snapshot();
  return { record_id: 7, request_id: id, text: value, revision: view.revision, fingerprint: view.records[0].fingerprint };
}
const interpreter = async () => ({ entries, clarification: '', usage: { costUsd: 0 } });

test('partial printing -> remaining 5 -> revise -> completed -> next step; only kanban stage changes', async () => {
  reset(); const before = fs.readFileSync(panelPath, 'utf8');
  let result = await service.submit(params(), interpreter);
  assert.match(result.snapshot.records[0].revision.action, /kalan 5/);
  assert.equal(result.snapshot.records[0].revision.hold, true);
  assert.match(result.summary, /Baskıya sevk: Tamamlandı/);
  result = await service.submit(params('report-0002', 'Kalan baskılar tamamlandı.'), async () => ({ entries: [
    { op: 'print', status: 'completed', remaining: null, reason: '', issue: null, evidence: 'Kalan baskılar tamamlandı.' },
  ] }));
  assert.match(result.snapshot.records[0].revision.action, /dikime götür/);
  assert.equal(JSON.parse(fs.readFileSync(panelPath, 'utf8')).data.uretimTakip[0].status, 'Baskı/Nakışta');
  assert.equal(result.snapshot.records[0].stale, false);
  const undone = await service.undo({ event_id: 'report-0002', revision: result.snapshot.revision });
  assert.match(undone.records[0].revision.action, /kalan 5/);
});
test('idempotency avoids repeated inference and rejects changed payload', async () => {
  reset(); let calls = 0;
  const infer = async () => { calls++; return interpreter(); };
  const p = params(); await service.submit(p, infer); await service.submit(p, infer);
  await service.submit(params('report-0002'), infer);
  assert.equal(calls, 1); assert.equal(journal.read().events.length, 1);
  await assert.rejects(service.submit({ ...p, text: 'Başka' }, infer), /farklı içerik/);
});
test('ambiguity and malformed or invented counts do not write', async () => {
  reset();
  const result = await service.submit(params(), async () => ({ clarification: 'Hangi işlem?', entries: [] }));
  assert.equal(result.saved, false); assert.equal(journal.read().events.length, 0);
  for (const remaining of [6, -1, 100, 2.5]) {
    await assert.rejects(service.submit(params(), async () => ({ entries: [{ ...entries[1], remaining }] })), /Kalan adet/);
  }
  assert.equal(journal.read().events.length, 0);
});
test('concurrent submissions, stale views and changed panel data are protected', async () => {
  reset(); let release;
  const pending = service.submit(params(), () => new Promise(r => { release = r; }));
  await assert.rejects(service.submit(params('report-0002'), interpreter), /işleniyor/);
  release(await interpreter()); await pending;
  await assert.rejects(service.submit({ ...params('report-0003'), revision: 0 }, interpreter), /Plan değişti/);
  await assert.rejects(service.submit(params('report-0003', text + '!'), async () => {
    fs.writeFileSync(panelPath, JSON.stringify({ data: { uretimTakip: [{ ...record, quantity: 200 }] } }));
    return interpreter();
  }), /yorumlama sırasında değişti/);
  assert.equal(journal.read().events.length, 1);
  assert.equal(service.snapshot().records[0].stale, true);
});
test('broken ledger is not silently reset, transport failure does not save', async () => {
  reset();
  await assert.rejects(service.submit(params(), async () => { throw new Error('offline'); }), /offline/);
  assert.equal(journal.read().events.length, 0);
  fs.writeFileSync(path.join(dir, 'operations', 'journal.json'), '{bad');
  assert.throws(() => service.snapshot());
});
test('dispatch does not complete printing and both decorations require both completions', () => {
  const one = core.revision(record, [entries[0]], 'baski');
  assert.equal(one.hold, true); assert.match(one.action, /tamamlandığını teyit/);
  assert.equal(core.revision(record, [{ ...entries[1], status: 'completed' }], 'ikisi').hold, true);
});
test('Turkish number phrases are not mistaken for their component digits', () => {
  const e = { ...entries[1], evidence: 'Yirmi beş adet kaldı, baskı kağıdı eksik' };
  assert.throws(() => core.validateEntries([e], record, e.evidence), /Kalan adet/);
  assert.equal(core.validateEntries([{ ...e, remaining: 25 }], record, e.evidence)[0].remaining, 25);
});
test('a preparation obstacle cannot be assigned to an unrelated operation', () => {
  assert.throws(() => core.validateEntries([{ ...entries[1], op: 'sewing' }], record, text), /işleme uymuyor/);
});
test('explicit dry-run validates extraction without saving production progress', async () => {
  reset();
  const result = await service.submit({ ...params(), dry_run: true }, interpreter);
  assert.equal(result.saved, false); assert.equal(result.dry_run, true);
  assert.equal(result.entries[1].remaining, 5);
  assert.equal(journal.read().events.length, 0);
  assert.equal(journal.read().revision, 0);
  await assert.rejects(service.submit({ ...params(), dry_run: 'true' }, interpreter), /Önizleme/);
});
test('synthetic connection check reads no business records and saves no events', async () => {
  reset(); fs.unlinkSync(panelPath);
  const result = await service.checkConnection(async (text, selected, previous) => {
    assert.equal(selected.customer_name, 'Sentetik bağlantı test ürünü');
    assert.equal(selected.quantity, 100); assert.deepEqual(previous, []);
    return { entries: entries.map((e, i) => ({ ...e, evidence: i === 0 ? 'Baskıya götürüldü.' : text.slice('Baskıya götürüldü. '.length) })) };
  });
  assert.equal(result.ok, true); assert.equal(result.saved, false);
  assert.equal(journal.read().revision, 0); assert.equal(journal.read().events.length, 0);
});
test('process restart recovers its previous abandoned lock', async () => {
  reset(); const lock = path.join(dir, 'operations', '.lock');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, instance: 'previous-process' }));
  const result = await service.submit(params(), interpreter);
  assert.equal(result.saved, true);
});
