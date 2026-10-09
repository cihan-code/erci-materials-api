'use strict';
// Journal-first, recoverable stage patches through the same CAS/backup path as
// browser saves. All panel read/check/write steps are synchronous (no await gap).
const panel = require('../store');
const store = require('./store');
const core = require('./core');
const { URETIM_STATUSES } = require('../lib/enums');
const valid = value => URETIM_STATUSES.includes(value);
function assessment(record, jobs, events) {
  const active = events.filter(e => String(e.record_id) === String(record.id) && !e.voided);
  const entries = core.latest(events, record.id);
  // Supply-only reports (e.g. "fermuar geldi") never pin or move the kanban stage. A report
  // that changed the delivery date carries the post-change fingerprint, so it is the basis too.
  const last = active.filter(e => core.stageEntries(record, e.entries).length || e.delivery_change).at(-1);
  if (!last) return { entries, revision: null, stale: false };
  const tracked = valid(last.basis_status);
  const basis = tracked ? { ...record, status: last.basis_status } : record;
  const revision = core.revision(basis, entries, core.decoration(record, jobs));
  const stale = tracked
    ? last.fingerprint !== core.fingerprint(basis, jobs) || (!!revision && record.status !== revision.status)
    : last.fingerprint !== core.fingerprint(record, jobs);
  return { entries, revision, stale };
}
// delivery = { from, to }: the report's delivery date patch, applied with the stage in one write.
function begin(journal, record, jobs, target, operation, eventId, warning, delivery) {
  journal.stage_syncs ||= {};
  const change = { record_id: record.id, from_status: record.status, to_status: target,
    ...(delivery ? { from_delivery: delivery.from ?? null, to_delivery: delivery.to ?? null } : {}),
    before_fingerprint: core.fingerprint(record, jobs), operation, event_id: eventId,
    status: warning || !valid(target) ? 'skipped' : 'pending',
    ...(warning ? { message: warning } : {}) };
  journal.stage_syncs[String(record.id)] = change;
  return change;
}
function recover(journal) {
  for (const change of Object.values(journal.stage_syncs || {})) {
    if (change.status !== 'pending') continue;
    try {
      const { data, updatedAt } = panel.loadPanelData();
      const record = data?.uretimTakip?.find(r => String(r.id) === String(change.record_id));
      if (!record || !valid(change.to_status)) throw new Error('stage conflict');
      const current = core.fingerprint(record, data.jobs);
      const delivery = 'to_delivery' in change;
      const target = { status: change.to_status, ...(delivery ? { est_delivery: change.to_delivery } : {}) };
      const original = { status: change.from_status, ...(delivery ? { est_delivery: change.from_delivery } : {}) };
      const differs = Object.keys(target).some(k => (record[k] ?? null) !== (target[k] ?? null));
      const alreadyApplied = !differs && core.fingerprint({ ...record, ...original }, data.jobs) === change.before_fingerprint;
      if (current !== change.before_fingerprint && !alreadyApplied) {
        change.status = 'skipped';
        change.message = 'Panel kaydı arada elle değişti; kanban aşamasına ve teslim tarihine dokunulmadı. Son durumu teyit et.';
      } else {
        if (!alreadyApplied && differs) {
          Object.assign(record, target);
          panel.writePanelData(data, updatedAt); // auth + unrelated records retained, backup + CAS
        }
        change.status = 'applied';
        delete change.message;
      }
    } catch (e) {
      // A transient disk failure keeps the persisted intent for an idempotent
      // retry/restart. Never report that the immutable production event was lost.
      change.message = 'Bildirim kaydedildi; kanban aşaması henüz eşitlenemedi. Yenileyip aynı bildirimi tekrar kaydet.';
    }
    store.write(journal);
  }
}
function publicChange(change) {
  if (!change) return null;
  const { before_fingerprint, ...value } = change;
  return value;
}
module.exports = { assessment, begin, recover, publicChange, valid };
