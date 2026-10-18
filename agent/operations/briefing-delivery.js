'use strict';
// Delivery receipts are separate from production facts and use the existing disk.
// Mutations are synchronous (one Node service): no read/write await interleaving.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { DATA_DIR } = require('../store');
const { istanbulDay } = require('../lib/util');
const file = path.join(DATA_DIR, 'operations', 'briefing-delivery.json');
const LEASE_MS = 15 * 60000;
function read() {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.receipts) || data.receipts.some(r =>
      !r || !['reserved', 'sending', 'sent', 'failed', 'uncertain'].includes(r.status) ||
      typeof r.key !== 'string' || typeof r.token !== 'string' || !r.token ||
      !Number.isFinite(Date.parse(r.lease_until)) || !Array.isArray(r.attempts))) throw new Error();
    return data;
  } catch (e) {
    if (e.code === 'ENOENT') return { version: 1, receipts: [] };
    throw new Error('Brifing gönderim kaydı okunamadı; çift gönderimi önlemek için durduruldu.');
  }
}
function write(data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + crypto.randomUUID();
  try { fs.writeFileSync(tmp, JSON.stringify(data), { flag: 'wx', mode: 0o600 }); fs.renameSync(tmp, file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
function identity(p, now) {
  if (p.date !== istanbulDay(now) || !/^[a-f0-9]{64}$/.test(p.audience || '') ||
      !/^[\w-]{8,100}$/.test(p.request_id || '')) throw new Error('Brifing gönderim kimliği veya günü geçersiz.');
  return p.date + ':' + p.audience;
}
function claim(p, now = new Date()) {
  const key = identity(p, now), data = read(), prior = data.receipts.find(r => r.key === key);
  if (prior && (['sent', 'sending', 'uncertain'].includes(prior.status) ||
      prior.status === 'reserved' && Date.parse(prior.lease_until) > now.getTime() && prior.request_id !== p.request_id))
    return { claimed: false, status: prior.status, reason: 'Bu gün ve alıcı grubu için gönderim var veya sonucu belirsiz; tekrar gönderilmedi.' };
  if (prior?.status === 'reserved' && prior.request_id === p.request_id && Date.parse(prior.lease_until) > now.getTime())
    return { claimed: true, token: prior.token, status: prior.status };
  const receipt = { key, date: p.date, audience: p.audience, request_id: p.request_id,
    token: crypto.randomUUID(), status: 'reserved', reserved_at: now.toISOString(),
    scheduled_for: [p.date + 'T07:40:00+03:00', p.date + 'T08:00:00+03:00'].includes(p.scheduled_for) ? p.scheduled_for : p.date + 'T08:00:00+03:00',
    delay_seconds: Math.max(0, Math.round((now - new Date([p.date + 'T07:40:00+03:00', p.date + 'T08:00:00+03:00'].includes(p.scheduled_for) ? p.scheduled_for : p.date + 'T08:00:00+03:00')) / 1000)),
    lease_until: new Date(now.getTime() + LEASE_MS).toISOString(),
    run_id: /^\d{1,30}$/.test(String(p.run_id || '')) ? String(p.run_id) : null, attempts: [...(prior?.attempts || []),
      ...(prior ? [{ status: prior.status, at: prior.updated_at || prior.reserved_at, run_id: prior.run_id }] : [])] };
  if (prior) data.receipts[data.receipts.indexOf(prior)] = receipt; else data.receipts.push(receipt);
  write(data);
  return { claimed: true, token: receipt.token, status: receipt.status };
}
function update(p, now = new Date()) {
  const key = identity(p, now), data = read(), receipt = data.receipts.find(r => r.key === key);
  if (!receipt || receipt.token !== p.token || receipt.request_id !== p.request_id) throw new Error('Brifing gönderim yetkisi güncel değil.');
  const allowed = { reserved: ['sending', 'failed'], sending: ['sent', 'uncertain'], uncertain: ['sent'] };
  if (!['sending', 'sent', 'failed', 'uncertain'].includes(p.status) ||
      (p.status !== receipt.status && !allowed[receipt.status]?.includes(p.status))) throw new Error('Brifing gönderim geçişi geçersiz.');
  if (p.status !== receipt.status) {
    if (p.status === 'sending' && Date.parse(receipt.lease_until) <= now.getTime()) throw new Error('Brifing hazırlık süresi aşıldı; tekrar başlatın.');
    receipt.status = p.status; receipt.updated_at = now.toISOString(); receipt[p.status + '_at'] = now.toISOString();
    write(data);
  }
  return { status: receipt.status };
}
function recent() {
  return { version: 1, receipts: read().receipts.slice(-30).map(({ token, key, request_id, ...r }) => r) };
}
module.exports = { claim, update, recent };
