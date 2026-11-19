'use strict';
const crypto = require('crypto');
const { tx, audit, fail } = require('./db');
const { assertUser } = require('./auth');
const handlers = new Map();
const now = () => new Date().toISOString();
// Delay after the 1st..5th failure; the 5th failure makes the job basarisiz, so the last delay is never waited.
const RETRY_DELAYS_MS = [60e3, 5*60e3, 15*60e3, 60*60e3, 6*60*60e3];
const MAX_ATTEMPTS = 5;
const PARKED = ['fiyat_bekliyor', 'manuel_bekliyor'];
const reportError = err => console.error('[siparis outbox]', err?.message || err);
const uid = user => user && typeof user === 'object' ? user.id : user;
function get(db, id) { const job = db.prepare('SELECT * FROM outbox WHERE id=?').get(id); if (!job) fail('Kuyruk işi bulunamadı', 404); return job; }
function currentWorkshop(db, job) {
  if (job.kind === 'atolye_dosya' && db.prepare('SELECT status FROM order_versions WHERE id=?').get(job.version_id)?.status !== 'onaylandi') fail('Eski sürüm atölyeye gönderilemez', 409);
}
function jobConfirmation(db, job, kind, message) {
  if (!db.prepare("SELECT id FROM confirmations WHERE kind=? AND ref_table='outbox' AND ref_id=? AND status='acik'").get(kind, job.id))
    db.prepare("INSERT INTO confirmations(kind,ref_table,ref_id,message) VALUES(?,'outbox',?,?)").run(kind, job.id, message);
}
const connectionConfirmation = (db, job, message) => jobConfirmation(db, job, 'baglanti_hatasi', message);
// Provider references are stored as text: objects as JSON, never "[object Object]"; null stays null.
const refText = ref => (ref == null ? null : typeof ref === 'object' ? JSON.stringify(ref) : String(ref));
function claimNext(db, kind) {
  return tx(db, () => {
    const at = now();
    // An interrupted external call has an unknown outcome. Never silently resend it after a crash.
    for (const job of db.prepare("SELECT * FROM outbox WHERE status='isleniyor' AND next_run_at<=?").all(at)) {
      db.prepare("UPDATE outbox SET status='basarisiz',last_error=?,claim_token=NULL,updated_at=? WHERE id=?").run('İşçi kesildi; dış gönderim sonucu teyit edilmeli', at, job.id);
      connectionConfirmation(db, job, 'Gönderim sonucu belirsiz; sağlayıcı kaydını kontrol ederek tekrar deneyin');
      audit(db, null, 'kuyruk_kesildi', job.id);
    }
    for (const job of db.prepare(`SELECT o.* FROM outbox o JOIN order_versions v ON v.id=o.version_id
      WHERE o.kind='atolye_dosya' AND o.status IN ('bekliyor','manuel_bekliyor') AND v.status<>'onaylandi'`).all()) {
      db.prepare("UPDATE outbox SET status='iptal',updated_at=? WHERE id=?").run(at, job.id);
      audit(db, null, 'eski_gonderim_iptal', job.id);
    }
    if (process.env.OTOMATIK_GONDERIM !== '1') {
      for (const job of db.prepare("SELECT id FROM outbox WHERE kind='atolye_dosya' AND status='bekliyor'").all()) {
        db.prepare("UPDATE outbox SET status='manuel_bekliyor',updated_at=? WHERE id=?").run(at, job.id);
        audit(db, null, 'kuyruk_manuel', job.id);
      }
    }
    // A kind without a registered adapter stays 'bekliyor': no attempt is spent and no confirmation opens.
    const kinds = [...handlers.keys()].filter(k => !kind || k === kind);
    if (!kinds.length) return null;
    const job = db.prepare(`SELECT * FROM outbox WHERE status='bekliyor' AND next_run_at<=?
      AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY next_run_at,id LIMIT 1`).get(at, ...kinds);
    if (!job) return null;
    db.prepare("UPDATE outbox SET status='isleniyor',attempts=attempts+1,claim_token=?,next_run_at=?,updated_at=? WHERE id=?")
      .run(crypto.randomUUID(), new Date(Date.now()+5*60*1000).toISOString(), at, job.id);
    audit(db, null, 'kuyruk_al', job.id);
    return get(db, job.id);
  });
}
function markDone(db, id, providerRef, claimToken) {
  return tx(db, () => {
    const job = get(db, id);
    if (job.status === 'tamam') return job;
    if (job.status !== 'isleniyor' || (claimToken && job.claim_token !== claimToken)) fail('İş sahipliği geçersiz', 409);
    db.prepare("UPDATE outbox SET status='tamam',provider_ref=?,last_error=NULL,claim_token=NULL,updated_at=? WHERE id=?")
      .run(refText(providerRef), now(), id);
    audit(db, null, 'kuyruk_tamam', id, { providerRef: refText(providerRef) }); return get(db, id);
  });
}
function markFailed(db, id, err, claimToken) {
  return tx(db, () => {
    const job = get(db, id);
    if (job.status !== 'isleniyor' || (claimToken && job.claim_token !== claimToken)) fail('İş sahipliği geçersiz', 409);
    const message = String(err?.message || err).slice(0,2000);
    // A permanent error (bad data, not the connection) would fail the same way on every retry.
    const permanent = err?.permanent === true;
    const status = permanent || job.attempts >= MAX_ATTEMPTS ? 'basarisiz' : 'bekliyor';
    const next = new Date(Date.now()+RETRY_DELAYS_MS[Math.min(Math.max(job.attempts,1), RETRY_DELAYS_MS.length)-1]).toISOString();
    db.prepare('UPDATE outbox SET status=?,last_error=?,next_run_at=?,claim_token=NULL,updated_at=? WHERE id=?').run(status,message,next,now(),id);
    if (permanent) jobConfirmation(db, job, 'eksik_alan', message);
    else if (status === 'basarisiz') connectionConfirmation(db, job, `Bağlantı hatası: ${message}`);
    audit(db, null, 'kuyruk_hata', id, { attempts: job.attempts, permanent }); return get(db, id);
  });
}
function retry(db, id, user) {
  return tx(db, () => {
    assertUser(db, uid(user), true); const job = get(db,id); currentWorkshop(db,job);
    if (!['basarisiz','manuel_bekliyor','fiyat_bekliyor','bekliyor'].includes(job.status)) fail('İş tekrar denenemez',409);
    db.prepare("UPDATE outbox SET status='bekliyor',attempts=0,last_error=NULL,claim_token=NULL,next_run_at=?,updated_at=? WHERE id=?").run(now(),now(),id);
    db.prepare("UPDATE confirmations SET status='cozuldu',resolved_by=? WHERE ref_table='outbox' AND ref_id=? AND kind IN ('baglanti_hatasi','eksik_alan') AND status='acik'").run(uid(user),id);
    audit(db,uid(user),'kuyruk_tekrar',id); return get(db,id);
  });
}
function setManual(db, id, user) {
  return tx(db, () => {
    if (user != null) assertUser(db,uid(user),true);
    const job = get(db,id); currentWorkshop(db,job);
    if (job.kind !== 'atolye_dosya' || !['bekliyor','manuel_bekliyor','basarisiz'].includes(job.status)) fail('İş elle gönderime alınamaz',409);
    db.prepare("UPDATE outbox SET status='manuel_bekliyor',updated_at=? WHERE id=?").run(now(),id);
    audit(db,uid(user) ?? null,'kuyruk_manuel',id); return get(db,id);
  });
}
function markManualSent(db,id,user,providerRef = 'elle') {
  return tx(db, () => {
    assertUser(db,uid(user),true); const job=get(db,id); currentWorkshop(db,job);
    if (job.status === 'tamam') return job;
    if (job.status !== 'manuel_bekliyor') fail('Elle gönderim beklenmiyor',409);
    db.prepare("UPDATE outbox SET status='tamam',provider_ref=?,updated_at=? WHERE id=?").run(refText(providerRef ?? 'elle'),now(),id);
    audit(db,uid(user),'elle_gonderildi',id,{providerRef: refText(providerRef ?? 'elle')}); return get(db,id);
  });
}
function registerHandler(kind, fn) {
  if (!['atolye_dosya','maliyet_aktarim'].includes(kind) || typeof fn !== 'function') fail('Geçersiz kuyruk bağdaştırıcısı');
  handlers.set(kind,fn);
  return () => { if (handlers.get(kind) === fn) handlers.delete(kind); };
}
async function runOnce(db, kind, { onError = reportError, heartbeatMs = 60000 } = {}) {
  const job=claimNext(db,kind);
  if (!job) return null;
  // Refresh the lease while the adapter is running. Adapters must use idempotencyKey at their provider.
  // A timer callback that throws would kill the process (e.g. SQLITE_BUSY under a long lock), so errors are reported.
  const heartbeat=setInterval(() => {
    try {
      if (!db.open) return;
      tx(db, () => {
        const changed=db.prepare("UPDATE outbox SET next_run_at=?,updated_at=? WHERE id=? AND status='isleniyor' AND claim_token=?")
          .run(new Date(Date.now()+5*60*1000).toISOString(),now(),job.id,job.claim_token).changes;
        if (changed) audit(db,null,'kuyruk_yasam',job.id);
      });
    } catch (err) {
      try { onError(err); } catch { /* the reporter must not take the process down either */ }
    }
  },heartbeatMs);
  heartbeat.unref();
  try {
    const handler=handlers.get(job.kind);
    if (!handler) throw new Error(`Bağdaştırıcı kayıtlı değil: ${job.kind}`);
    const response=await handler(JSON.parse(job.payload_json), { idempotencyKey: job.idempotency_key, job, db });
    // Parked results keep the job open: fiyat_bekliyor returns via retry, manuel_bekliyor closes via markManualSent.
    if (PARKED.includes(response?.status)) return tx(db, () => {
      const changed=db.prepare("UPDATE outbox SET status=?,provider_ref=COALESCE(?,provider_ref),claim_token=NULL,updated_at=? WHERE id=? AND status='isleniyor' AND claim_token=?")
        .run(response.status,refText(response.providerRef),now(),job.id,job.claim_token).changes;
      if (!changed) fail('İş sahipliği geçersiz',409);
      audit(db,null,response.status === 'fiyat_bekliyor' ? 'kuyruk_fiyat_bekliyor' : 'kuyruk_manuel',job.id); return get(db,job.id);
    });
    const ref=response?.providerRef;
    // Only {providerRef} means done. Anything else has an unknown outcome at the provider: never resend it blindly.
    if (ref == null || ref === '' || (response.status != null && response.status !== 'tamam')) return tx(db, () => {
      const changed=db.prepare("UPDATE outbox SET status='basarisiz',last_error=?,claim_token=NULL,updated_at=? WHERE id=? AND status='isleniyor' AND claim_token=?")
        .run('Bağdaştırıcı sonucu belirsiz (providerRef yok)',now(),job.id,job.claim_token).changes;
      if (!changed) fail('İş sahipliği geçersiz',409);
      connectionConfirmation(db, job, 'Gönderim sonucu belirsiz; sağlayıcı kaydını kontrol ederek tekrar deneyin');
      audit(db,null,'kuyruk_belirsiz',job.id); return get(db,job.id);
    });
    return markDone(db,job.id,ref,job.claim_token);
  } catch (err) {
    if (!db.open) throw err;
    const latest=get(db,job.id);
    if (latest.status !== 'isleniyor' || latest.claim_token !== job.claim_token) throw err;
    return markFailed(db,job.id,err,job.claim_token);
  } finally { clearInterval(heartbeat); }
}
function startWorker(db, { intervalMs = 1000, onError = reportError } = {}) {
  let busy=false;
  const timer=setInterval(async () => {
    if (busy || !db.open) return;
    busy=true;
    try { await runOnce(db, undefined, { onError }); } catch (err) { onError(err); } finally { busy=false; }
  },intervalMs);
  timer.unref(); return () => clearInterval(timer);
}
module.exports = { claimNext, markDone, markFailed, retry, setManual, markManualSent, registerHandler, runOnce, startWorker };
