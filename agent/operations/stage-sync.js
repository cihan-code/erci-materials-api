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
  const last = active.at(-1), entries = core.latest(events, record.id);
  if (!last) return { entries, revision: null, stale: false };
  const tracked = valid(last.basis_status);
  const basis = tracked ? { ...record, status: last.basis_status } : record;
  const revision = core.revision(basis, entries, core.decoration(record, jobs));
  const stale = tracked
    ? last.fingerprint !== core.fingerprint(basis, jobs) || record.status !== revision?.status
    : last.fingerprint !== core.fingerprint(record, jobs);
  return { entries, revision, stale };
}
function begin(journal, record, jobs, target, operation, eventId, warning) {
  journal.stage_syncs ||= {};
  const change = { record_id: record.id, from_status: record.status, to_status: target,
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
      const alreadyApplied = record.status === change.to_status &&
        core.fingerprint({ ...record, status: change.from_status }, data.jobs) === change.before_fingerprint;
      if (current !== change.before_fingerprint && !alreadyApplied) {
        change.status = 'skipped';
        change.message = 'Panel kaydı arada elle değişti; kanban aşamasına dokunulmadı. Son durumu teyit et.';
      } else {
        if (!alreadyApplied && record.status !== change.to_status) {
          record.status = change.to_status;
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
