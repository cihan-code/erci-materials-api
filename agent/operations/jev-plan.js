'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { DATA_DIR } = require('../store');
const context = require('./jev-context');
const capacity = require('./capacity');
const client = require('./jev-client');
const file = path.join(DATA_DIR, 'operations', 'jev-plan.json');
const pending = new Map();
function read() {
  try { const result = JSON.parse(fs.readFileSync(file, 'utf8')); return result?.version === 1 ? result : null; }
  catch (e) { if (e.code === 'ENOENT' || e instanceof SyntaxError) return null; throw e; }
}
function write(result) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + crypto.randomUUID();
  try { fs.writeFileSync(temp, JSON.stringify(result), { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function build(prepared, source, reason, answer, fingerprint) {
  const allocated = capacity.allocate(prepared, context.decisions(prepared, answer));
  return { version: 1, capacity: allocated.capacity, status: !prepared.tasks.length ? 'empty' : source === 'jev' ? 'ready' : 'fallback', source,
    reason: reason || null, date: prepared.date, state_hash: prepared.state_hash,
    generated_at: new Date().toISOString(), model: answer?.model || client.config().model,
    record_count: prepared.tasks.length, considered_count: prepared.considered_count,
    decisions: allocated.decisions, credential_fingerprint: fingerprint || null };
}
function matches(result, prepared, config) {
  if (result?.state_hash !== prepared.state_hash || result.credential_fingerprint !== config.keyFingerprint ||
      result.date !== prepared.date || result.record_count !== prepared.tasks.length ||
      result.considered_count !== prepared.considered_count || !Number.isFinite(Date.parse(result.generated_at)) ||
      !Array.isArray(result.decisions) || result.decisions.length !== prepared.tasks.length) return false;
  const source = result.status === 'ready' ? 'jev' : 'rules';
  if (!['ready', 'fallback', 'empty'].includes(result.status) || result.source !== source ||
      (result.status === 'empty') !== !prepared.tasks.length) return false;
  const ids = new Set(), priorities = new Set();
  for (const d of result.decisions) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
    const task = prepared.tasks.find(t => String(t.record_id) === String(d.record_id));
    if (!task || ids.has(String(d.record_id)) || d.task_key !== task.key ||
        typeof d.action !== 'string' || !d.action.trim() || !['do', 'defer', 'confirm'].includes(d.disposition) ||
        (task.type === 'verify' ? d.disposition === 'do' : d.disposition === 'confirm') ||
        d.source !== source || !Number.isInteger(d.priority) || d.priority < 1 || d.priority > prepared.tasks.length ||
        priorities.has(d.priority) || (d.confidence !== null &&
          !(typeof d.confidence === 'number' && Number.isFinite(d.confidence) && d.confidence >= 0 && d.confidence <= 1))) return false;
    ids.add(String(d.record_id)); priorities.add(d.priority);
  }
  const expected = capacity.allocate(prepared, result.decisions.map(d => ({ ...d })));
  if (JSON.stringify(result.capacity) !== JSON.stringify(expected.capacity)) return false;
  for (const d of result.decisions) {
    const correct = expected.decisions.find(x => String(x.record_id) === String(d.record_id));
    if (correct.capacity && (JSON.stringify(d.capacity) !== JSON.stringify(correct.capacity) || d.action !== correct.action)) return false;
  }
  return true;
}
function cached(prepared, config) {
  const result = read();
  if (!matches(result, prepared, config)) return null;
  // Retry failed/unavailable calls only after a minute, never on ordinary reads.
  if (result.status === 'fallback' && Date.now() - Date.parse(result.generated_at) > 60000) return null;
  return result;
}
function publicPlan(result) {
  const { credential_fingerprint, ...value } = result;
  return value;
}
function peek(prepared) {
  const config = client.config();
  const result = read();
  if (matches(result, prepared, config)) return publicPlan(result);
  if (!prepared.tasks.length) return publicPlan(build(prepared, 'rules', null, null, config.keyFingerprint));
  if (!config.configured) return publicPlan(build(prepared, 'rules', 'Jev sunucuda yapılandırılmamış; kural planı kullanılıyor.', null, config.keyFingerprint));
  return { version: 1, status: 'stale', source: 'rules', reason: 'Üretim bilgileri değişti; Jev son planı yeniden değerlendirmeli.',
    date: prepared.date, state_hash: prepared.state_hash, model: config.model, record_count: prepared.tasks.length,
    considered_count: prepared.considered_count, decisions: [] };
}
async function compute(load, evaluator = client.evaluate) {
  const current = load();
  const config = client.config();
  const prepared = context.prepare(current.data, current.snapshot, config.model);
  const existing = cached(prepared, config);
  if (existing) return publicPlan(existing);
  const requestKey = prepared.state_hash + ':' + config.keyFingerprint;
  if (pending.has(requestKey)) return pending.get(requestKey);
  const work = (async () => {
    let result;
    if (!prepared.tasks.length) result = build(prepared, 'rules', null, null, config.keyFingerprint);
    else if (prepared.limit_reason || !config.configured) result = build(prepared, 'rules', prepared.limit_reason || 'Jev sunucuda yapılandırılmamış; kural planı kullanıldı.', null, config.keyFingerprint);
    else {
      try {
        const answer = client.validate_choices(await evaluator(prepared.state, prepared.questions), prepared.questions);
        result = build(prepared, 'jev', null, answer, config.keyFingerprint);
      } catch (_) { result = build(prepared, 'rules', 'Jev değerlendirmesi başarısız; bildirilen gerçek durum korunarak kural planı kullanıldı.', null, config.keyFingerprint); }
    }
    const fresh = load();
    const freshConfig = client.config();
    const freshContext = context.prepare(fresh.data, fresh.snapshot, freshConfig.model);
    if (freshContext.state_hash !== prepared.state_hash || freshConfig.keyFingerprint !== config.keyFingerprint)
      throw new Error('Üretim bilgileri Jev değerlendirirken değişti; planı tekrar değerlendir.');
    write(result);
    return publicPlan(result);
  })();
  pending.set(requestKey, work);
  try { return await work; } finally { pending.delete(requestKey); }
}
module.exports = { compute, peek };
