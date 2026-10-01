'use strict';
const store = require('./store');
const panel = require('../store');
const core = require('./core');
const { istanbulDay } = require('../lib/util');
const { interpret } = require('./interpret');
const memory = require('./memory');
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
function snapshot(data = panel.loadPanelData().data, journal = store.read()) {
  if (!data) throw new Error('Panel verisi okunamadı.');
  const knowledge = memory.learn(journal);
  const records = (data.uretimTakip || []).map(record => {
    const entries = core.latest(journal.events, record.id);
    const events = journal.events.filter(e => String(e.record_id) === String(record.id) && !e.voided);
    const last = events.at(-1);
    const stale = !!last && last.fingerprint !== core.fingerprint(record, data.jobs);
    return { record_id: record.id, fingerprint: core.fingerprint(record, data.jobs), entries,
      basis: { status: record.status, quantity: record.quantity, customer: record.customer_name,
        decoration: core.decoration(record, data.jobs), est_delivery: record.est_delivery || null },
      reminders: memory.reminders(record, core.decoration(record, data.jobs), entries, knowledge),
      revision: stale ? { status: record.status, section: 'Gün içi revizyon', hold: true,
        action: 'Panel kaydı bildirimden sonra değişti; son durumunu yeniden bildir.', note: '' }
        : core.revision(record, entries, core.decoration(record, data.jobs)),
      stale, history: events.slice(-20).reverse().map(e => ({ id: e.id, date: e.date, text: e.text, entries: e.entries })) };
  });
  return { version: 1, revision: journal.revision, records, knowledge,
    build: process.env.RENDER_GIT_COMMIT || null,
    configured: !!process.env.ANTHROPIC_API_KEY, model: require('../pricing').HAIKU };
}
async function submit(params, interpreter = interpret) {
  const text = String(params.text || '').trim();
  if (!text || text.length > 2000) throw new Error('Bildirim 1–2000 karakter olmalı.');
  if (!/^[\w-]{8,100}$/.test(params.request_id || '')) throw new Error('Bildirim kimliği gerekli.');
  if (params.dry_run !== undefined && typeof params.dry_run !== 'boolean') throw new Error('Önizleme seçeneği doğru / yanlış olmalı.');
  return store.locked(async journal => {
    const existing = journal.events.find(e => e.id === params.request_id);
    if (existing) {
      if (existing.text !== text || String(existing.record_id) !== String(params.record_id)) throw new Error('Bildirim kimliği farklı içerikle kullanılmış.');
      if (existing.voided) return { saved: false, clarification: 'Bu bildirim geri alınmış; yeni bildirim yazın.' };
      return { saved: true, reused: true, snapshot: snapshot(undefined, journal) };
    }
    const { data } = panel.loadPanelData();
    const record = getRecord(data, params.record_id);
    const date = today();
    if (params.revision !== journal.revision || params.fingerprint !== core.fingerprint(record, data.jobs)) throw new Error('Plan değişti; yenileyip tekrar kaydedin.');
    const previous = core.latest(journal.events, record.id);
    const last = journal.events.filter(e => String(e.record_id) === String(record.id) && !e.voided).at(-1);
    if (last?.text === text && last.date === date && last.fingerprint === params.fingerprint) return { saved: true, reused: true, snapshot: snapshot(data, journal) };
    const output = await interpreter(text, { ...record, decoration: core.decoration(record, data.jobs) }, previous, date);
    if (output.clarification) return { saved: false, clarification: String(output.clarification).slice(0, 600), usage: output.usage };
    const entries = core.validateEntries(output.entries, record, text);
    const fresh = panel.loadPanelData().data;
    if (core.fingerprint(getRecord(fresh, record.id), fresh.jobs) !== params.fingerprint) throw new Error('İş kaydı yorumlama sırasında değişti; yenileyip tekrar deneyin.');
    if (params.dry_run) return { saved: false, dry_run: true, entries,
      summary: entries.map(core.describe).join('\n'), usage: output.usage };
    const event = { id: params.request_id, record_id: record.id, fingerprint: params.fingerprint,
      quantity: record.quantity, date, recorded_at: new Date().toISOString(), text, entries, usage: output.usage };
    journal.events.push(event); journal.revision++;
    store.write(journal);
    return { saved: true, summary: entries.map(core.describe).join('\n'), usage: output.usage, snapshot: snapshot(fresh, journal) };
  });
}
async function undo(params) {
  return store.locked(journal => {
    if (params.revision !== journal.revision) throw new Error('Günlük değişti; yenileyin.');
    const event = journal.events.find(e => e.id === params.event_id && !e.voided);
    if (!event) throw new Error('Bildirim bulunamadı.');
    event.voided = new Date().toISOString(); journal.revision++; store.write(journal);
    return snapshot(undefined, journal);
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
module.exports = { snapshot, submit, undo, decideRule, checkConnection };
