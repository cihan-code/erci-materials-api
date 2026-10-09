'use strict';
const store = require('./store');
const panel = require('../store');
const core = require('./core');
const { istanbulDay } = require('../lib/util');
const { interpret } = require('./interpret');
const memory = require('./memory');
const expectations = require('./expectations');
const capacity = require('./capacity');
const { safeClarification } = require('./clarification');
const jevContext = require('./jev-context');
const jevClient = require('./jev-client');
const jevPlan = require('./jev-plan');
const stageSync = require('./stage-sync');
const today = () => istanbulDay(new Date());
// Fixed synthetic diagnostic: never reads panel records or saves progress.
async function checkConnection(interpreter = interpret) {
  const text = 'Baskıya götürüldü. Beş tanesinin baskı kağıdı eksik olduğu için onlar basılmadı, diğerleri basıldı.';
  const record = { customer_name: 'Sentetik bağlantı test ürünü', quantity: 100, status: 'Baskı/Nakışta', decoration: 'baski' };
  const output = await interpreter(text, record, [], today());
  if (output.clarification) throw new Error('Bağlantı testi kesin sonuç üretmedi.');
  let entries;
  try { entries = core.validateEntries(output.entries, record, text); }
  catch (error) {
    // Diagnostics contain only the fixed synthetic example, never business data.
    error.diagnostic = { extracted: output.entries }; throw error;
  }
  if (!entries.some(e => e.op === 'print' && e.status === 'partial' && e.remaining === 5) ||
      !entries.some(e => e.op === 'print_dropoff' && e.status === 'completed')) throw new Error('Bağlantı testi beklenen işlemleri yorumlayamadı.');
  return { ok: true, synthetic: true, saved: false, remaining: 5, usage: output.usage };
}
function getRecord(data, id) {
  const r = data?.uretimTakip?.find(r => String(r.id) === String(id));
  if (!r) throw new Error('Üretim kaydı bulunamadı.');
  return r;
}
function snapshot(data = panel.loadPanelData().data, journal = store.read(), includePlan = true) {
  if (!data) throw new Error('Panel verisi okunamadı.');
  const knowledge = memory.learn(journal);
  const records = (data.uretimTakip || []).map(record => {
    const assessed = stageSync.assessment(record, data.jobs, journal.events);
    const entries = assessed.entries;
    const events = journal.events.filter(e => String(e.record_id) === String(record.id) && !e.voided);
    const stale = assessed.stale;
    return { record_id: record.id, fingerprint: core.fingerprint(record, data.jobs), entries,
      basis: { status: record.status, quantity: record.quantity, customer: record.customer_name,
        decoration: core.decoration(record, data.jobs), est_delivery: record.est_delivery || null },
      planning_basis: jevContext.planningBasis(record),
      stage_sync: stageSync.publicChange(journal.stage_syncs?.[String(record.id)]),
      reminders: memory.reminders(record, core.decoration(record, data.jobs), entries, knowledge),
      expectations: expectations.open(record, journal.events, today(), core.OPS),
      revision: stale ? { status: record.status, section: 'Gün içi revizyon', hold: true,
        action: 'Panel kaydı bildirimden sonra değişti; son durumunu yeniden bildir.', note: '' }
        : assessed.revision,
      stale, history: events.slice(-20).reverse().map(e => ({ id: e.id, date: e.date, text: e.text, entries: e.entries,
        expectations: (e.expectations || []).map(x => ({ ...x, label: core.OPS[x.op] })), delivery_change: e.delivery_change || null })) };
  });
  const result = { version: 1, revision: journal.revision, records, knowledge, sewing_setup: capacity.previousSetup(journal, today()),
    build: process.env.RENDER_GIT_COMMIT || null,
    configured: !!process.env.ANTHROPIC_API_KEY, model: require('../pricing').HAIKU };
  if (includePlan) {
    const config = jevClient.config();
    const prepared = jevContext.prepare(data, result, config.model);
    result.state_hash = prepared.state_hash;
    result.jev = { configured: config.configured, model: config.model };
    result.plan = jevPlan.peek(prepared);
  }
  return result;
}
async function finalPlan(evaluator) {
  await jevPlan.compute(() => {
    const data = panel.loadPanelData().data;
    return { data, snapshot: snapshot(data, store.read(), false) };
  }, evaluator);
  return snapshot();
}
async function checkFinalConnection(evaluator = jevClient.evaluate) {
  const data = { jobs: [], uretimTakip: [
    { id: 9001, customer_name: 'Sentetik kesim', quantity: 100, status: 'Kumaş Geldi', decoration: 'baski' },
    { id: 9002, customer_name: 'Sentetik baskı', quantity: 100, status: 'Baskı/Nakışta', decoration: 'baski' },
    { id: 9003, customer_name: 'Sentetik dikim', quantity: 80, status: 'Dikimde', decoration: 'yok' },
    { id: 9004, customer_name: 'Sentetik teslim', quantity: 50, status: 'Teslim Edildi', decoration: 'yok' },
  ] };
  const record = data.uretimTakip[1];
  const journal = { version: 1, revision: 1, rules: {}, events: [{ id: 'synthetic-final-test', record_id: record.id,
    fingerprint: core.fingerprint(record, []), date: today(), entries: [
      { op: 'print_dropoff', status: 'completed', remaining: null, reason: '', issue: null },
      { op: 'print', status: 'partial', remaining: 5, reason: 'baskı kağıdı eksik', issue: 'print_paper' },
    ] }] };
  const view = snapshot(data, journal, false);
  const prepared = jevContext.prepare(data, view, jevClient.config().model);
  const response = jevClient.validate_choices(await evaluator(prepared.state, prepared.questions), prepared.questions);
  return { ok: true, synthetic: true, saved: false, model: response.model, considered_count: prepared.considered_count,
    record_count: prepared.tasks.length, decisions: capacity.allocate(prepared, jevContext.decisions(prepared, response)).decisions, usage: response.usage || null };
}
async function submit(params, interpreter = interpret) {
  const text = String(params.text || '').trim();
  if (!text || text.length > 2000) throw new Error('Bildirim 1–2000 karakter olmalı.');
  if (!/^[\w-]{8,100}$/.test(params.request_id || '')) throw new Error('Bildirim kimliği gerekli.');
  if (params.dry_run !== undefined && typeof params.dry_run !== 'boolean') throw new Error('Önizleme seçeneği doğru / yanlış olmalı.');
  return store.locked(async journal => {
    stageSync.recover(journal);
    const existing = journal.events.find(e => e.id === params.request_id);
    if (existing) {
      if (existing.text !== text || String(existing.record_id) !== String(params.record_id)) throw new Error('Bildirim kimliği farklı içerikle kullanılmış.');
      if (existing.voided) return { saved: false, clarification: 'Bu bildirim geri alınmış; yeni bildirim yazın.' };
      return { saved: true, reused: true, stage_sync: stageSync.publicChange(journal.stage_syncs?.[String(existing.record_id)]), snapshot: snapshot(undefined, journal) };
    }
    const { data } = panel.loadPanelData();
    const record = getRecord(data, params.record_id);
    const date = today();
    if (params.revision !== journal.revision || params.fingerprint !== core.fingerprint(record, data.jobs)) throw new Error('Plan değişti; yenileyip tekrar kaydedin.');
    const previous = core.latest(journal.events, record.id);
    const last = journal.events.filter(e => String(e.record_id) === String(record.id) && !e.voided).at(-1);
    if (last?.text === text && last.date === date && !stageSync.assessment(record, data.jobs, journal.events).stale) return { saved: true, reused: true, stage_sync: stageSync.publicChange(journal.stage_syncs?.[String(record.id)]), snapshot: snapshot(data, journal) };
    const output = await interpreter(text, { ...record, decoration: core.decoration(record, data.jobs) }, previous, date);
    if (output.clarification) return { saved: false, clarification: safeClarification(output.clarification), usage: output.usage };
    // Dated plans ("pazartesi bitecek") are kept as expectations; dates come from code, never the model.
    const expected = expectations.validate(output.expectations, text, date, core.OPS);
    const entries = (Array.isArray(output.entries) && output.entries.length) || !expected.length ? core.validateEntries(output.entries, record, text) : [];
    const fresh = panel.loadPanelData().data;
    if (core.fingerprint(getRecord(fresh, record.id), fresh.jobs) !== params.fingerprint) throw new Error('İş kaydı yorumlama sırasında değişti; yenileyip tekrar deneyin.');
    const current = getRecord(fresh, record.id);
    const deadline = expected.find(x => x.op === 'delivery');
    const delivery = deadline && deadline.date !== (current.est_delivery || null) ? { from: current.est_delivery || null, to: deadline.date } : null;
    const summary = [...entries.map(core.describe), ...expected.filter(x => x.op !== 'delivery').map(expectationText),
      ...(delivery ? [deliveryText(delivery)] : [])].join('\n');
    if (params.dry_run) return { saved: false, dry_run: true, entries, expectations: expected, delivery_change: delivery, summary, usage: output.usage };
    const event = { id: params.request_id, record_id: record.id, fingerprint: params.fingerprint,
      basis_status: record.status, product_type: record.product_type || '', quantity: record.quantity, date, recorded_at: new Date().toISOString(), text, entries,
      expectations: expected, ...(delivery ? { delivery_change: delivery } : {}), usage: output.usage };
    journal.events.push(event); journal.revision++;
    // Supply-only and expectation-only reports leave the kanban stage alone; a stated
    // delivery date is patched with the same backup/CAS write as a stage change.
    const stageReport = core.stageEntries(current, entries).length > 0;
    const change = stageReport || delivery ? stageSync.begin(journal, current, fresh.jobs,
      stageReport ? core.revision(current, core.latest(journal.events, record.id), core.decoration(current, fresh.jobs))?.status : current.status,
      'report', event.id, undefined, delivery || undefined) : null;
    if (delivery && change?.status === 'pending') event.fingerprint = core.fingerprint({ ...current, est_delivery: delivery.to }, fresh.jobs);
    else delete event.delivery_change;
    store.write(journal); // durable intent before changing kanban
    stageSync.recover(journal);
    return { saved: true, stage_sync: stageSync.publicChange(change), summary, usage: output.usage, snapshot: snapshot(undefined, journal) };
  });
}
const short = date => date ? date.slice(8, 10) + '.' + date.slice(5, 7) : 'boş';
function expectationText(x) { return 'Beklenti: ' + core.OPS[x.op] + ' — ' + short(x.date) + ' (' + x.when + ')'; }
function deliveryText(d) { return 'Tahmini teslimat: ' + short(d.from) + ' → ' + short(d.to); }
async function undo(params) {
  return store.locked(journal => {
    stageSync.recover(journal);
    const event = journal.events.find(e => e.id === params.event_id);
    if (!event) throw new Error('Bildirim bulunamadı.');
    const prior = journal.stage_syncs?.[String(event.record_id)];
    // Supply-only reports never changed the kanban, so undoing them must not either.
    const found = panel.loadPanelData().data?.uretimTakip?.find(r => String(r.id) === String(event.record_id));
    const supplyOnly = !core.stageEntries(found || {}, event.entries).length;
    if (event.voided && supplyOnly) return { ...snapshot(undefined, journal), stage_sync: null, reused: true };
    if (event.voided && prior?.operation === 'undo' && prior.event_id === event.id)
      return { ...snapshot(undefined, journal), stage_sync: stageSync.publicChange(prior), reused: true };
    if (event.voided) throw new Error('Bu bildirim zaten geri alınmış.');
    if (params.revision !== journal.revision) throw new Error('Günlük değişti; yenileyin.');
    const { data } = panel.loadPanelData();
    const record = getRecord(data, event.record_id);
    // A delivery date set by this report is restored only if nobody changed it since.
    const restore = event.delivery_change && (record.est_delivery || null) === event.delivery_change.to
      ? { from: event.delivery_change.to, to: event.delivery_change.from } : undefined;
    if (supplyOnly) {
      event.voided = new Date().toISOString(); journal.revision++;
      const change = restore ? stageSync.begin(journal, record, data.jobs, record.status, 'undo', event.id, undefined, restore) : null;
      store.write(journal); stageSync.recover(journal);
      return { ...snapshot(undefined, journal), stage_sync: stageSync.publicChange(change) };
    }
    const before = stageSync.assessment(record, data.jobs, journal.events);
    event.voided = new Date().toISOString(); journal.revision++;
    const after = stageSync.assessment(record, data.jobs, journal.events);
    const stageEvents = journal.events.filter(e => String(e.record_id) === String(record.id) && core.stageEntries(record, e.entries).length);
    const first = stageEvents[0];
    const last = stageEvents.filter(e => !e.voided).at(-1);
    const target = after.revision?.status || first?.basis_status;
    const warning = before.stale ? 'Aşama veya iş kaydı arada elle değişti; geri alma sırasında kanban aşamasına dokunulmadı.'
      : !stageSync.valid(target) || last && !stageSync.valid(last.basis_status)
        ? 'Eski bildirimin başlangıç aşaması bilinmiyor; kanban aşaması korunarak bildirim geri alındı.' : null;
    const change = stageSync.begin(journal, record, data.jobs, target, 'undo', event.id, warning, restore);
    store.write(journal);
    stageSync.recover(journal);
    return { ...snapshot(undefined, journal), stage_sync: stageSync.publicChange(change) };
  });
}
async function decideRule(params) {
  return store.locked(journal => {
    if (params.revision !== journal.revision) throw new Error('Üretim hafızası değişti; yenileyin.');
    const rule = memory.learn(journal).find(r => r.issue === params.issue);
    if (!rule || rule.samples < 3 || !['accepted', 'dismissed'].includes(params.status)) throw new Error('Kural için yeterli gözlem veya geçerli karar yok.');
    journal.rules[params.issue] = { status: params.status, date: new Date().toISOString(),
      evidence_ids: rule.evidence.map(e => e.event_id) };
    journal.revision++; store.write(journal);
    return snapshot(undefined, journal);
  });
}
function panelSnapshot() {
  // Same canonical shape as GET /paneldata: adopting a new cloud token must
  // also adopt current auth, otherwise a later browser save could restore old auth.
  const raw = panel.readPanelRaw();
  return raw ? { data: raw.data, auth: raw.auth || null, updatedAt: raw.updatedAt || null }
    : { data: null, updatedAt: null };
}
module.exports = { panelSnapshot, snapshot, submit, undo, decideRule, checkConnection, finalPlan, checkFinalConnection };
