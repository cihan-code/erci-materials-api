'use strict';
// G70: the redraw queue between the server (Render, no Codex) and the worker on the owner's Mac (tools/desen-isci.js).
// The server queues a job per picture (once), the old path runs meanwhile; the worker claims it with a lease,
// draws it with Codex and uploads the PNGs; each upload goes through the G69 fidelity check before it is cached.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { tx, audit } = require('./db');
const desenCizim = require('./desenCizim');

const MAX_TRIES = 3;
const LEASE_S = () => Number(process.env.DESEN_ISCI_KIRALAMA_SN) || 900;
const now = () => Math.floor(Date.now() / 1000);
const cacheDir = dataDir => path.join(dataDir, 'siparis', 'desen-cizim');
const jobDir = dataDir => path.join(dataDir, 'siparis', 'desen-isci');
const safe = v => String(v).replace(/[^a-z0-9_-]/gi, '_').slice(0, 60);
const ext = mime => (mime === 'image/png' ? 'png' : 'jpg');
function write(file, buffer) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, buffer); }

// What documents.js uses while the provider is "isci": queue a job (idempotent) and read its state.
function queue(db, dataDir) {
  return {
    async enqueue({ anahtar, image, mime, positions, position, crop, applicationId }) {
      return tx(db, () => {
        let job = db.prepare('SELECT * FROM desen_isci_is WHERE anahtar=?').get(anahtar);
        if (!job) {
          const file = path.join(jobDir(dataDir), `${anahtar.slice(0, 32)}.${ext(mime)}`);
          write(file, image);
          const id = Number(db.prepare('INSERT INTO desen_isci_is(anahtar,gorsel_yol,gorsel_mime,konumlar_json) VALUES(?,?,?,?)')
            .run(anahtar, file, mime === 'image/png' ? 'image/png' : 'image/jpeg', JSON.stringify(positions)).lastInsertRowid);
          job = db.prepare('SELECT * FROM desen_isci_is WHERE id=?').get(id);
        }
        const exists = db.prepare('SELECT 1 FROM desen_isci_konum WHERE is_id=? AND konum=? AND application_id IS ?').get(job.id, position, applicationId ?? null);
        if (!exists) {
          let kirpim = null;
          if (crop) { kirpim = path.join(jobDir(dataDir), `${job.id}-${safe(position)}-${applicationId ?? 0}.png`); write(kirpim, crop); }
          db.prepare('INSERT INTO desen_isci_konum(is_id,konum,application_id,kirpim_yol) VALUES(?,?,?,?)').run(job.id, position, applicationId ?? null, kirpim);
        }
        const row = db.prepare('SELECT durum,neden FROM desen_isci_konum WHERE is_id=? AND konum=? AND application_id IS ?').get(job.id, position, applicationId ?? null);
        // A finished job whose picture is not in the cache any more (cache wiped): a rejected/hazir row without a file is final for this print.
        const durum = job.durum === 'hazir' ? (row.durum === 'hazir' ? 'bekliyor' : 'reddedildi') : job.durum;
        return { durum, neden: row.neden || job.hata || null, isId: job.id };
      });
    },
  };
}

// Visibility on an order answer: bekliyor | hazir | reddedildi | kapali.
function stateFor(db, applicationId, env = process.env) {
  if (!desenCizim.enabled(env) || desenCizim.provider(env) !== 'isci') return 'kapali';
  const row = db.prepare(`SELECT k.durum AS kd, j.durum AS jd FROM desen_isci_konum k JOIN desen_isci_is j ON j.id=k.is_id
    WHERE k.application_id=? ORDER BY j.id DESC LIMIT 1`).get(applicationId);
  if (!row) return 'bekliyor';
  if (row.kd === 'hazir') return 'hazir';
  if (row.kd === 'reddedildi' || row.jd === 'vazgecildi' || row.jd === 'reddedildi') return 'reddedildi';
  return 'bekliyor';
}

// Worker side ---------------------------------------------------------------------------------------------
function claim(db) {
  return tx(db, () => {
    const t = now();
    // A worker that died: its lease ran out, the job is free again (tries are counted at the claim).
    db.prepare("UPDATE desen_isci_is SET durum='bekliyor',kiralama=NULL WHERE durum='kiralandi' AND kiralama_bitis<?").run(t);
    db.prepare("UPDATE desen_isci_is SET durum='vazgecildi',hata=COALESCE(hata,'deneme sınırı'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE durum='bekliyor' AND deneme>=?").run(MAX_TRIES);
    const job = db.prepare("SELECT * FROM desen_isci_is WHERE durum='bekliyor' ORDER BY id LIMIT 1").get();
    if (!job) return null;
    const lease = crypto.randomBytes(16).toString('hex');
    db.prepare("UPDATE desen_isci_is SET durum='kiralandi',kiralama=?,kiralama_bitis=?,deneme=deneme+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(lease, t + LEASE_S(), job.id);
    return { id: job.id, kiralama: lease, kiralamaSn: LEASE_S(), deneme: job.deneme + 1, konumlar: JSON.parse(job.konumlar_json), kip: 'tam', mime: job.gorsel_mime };
  });
}
function leased(db, id, lease) {
  const job = db.prepare('SELECT * FROM desen_isci_is WHERE id=?').get(id);
  if (!job) return { status: 404, error: 'İş yok' };
  if (job.durum !== 'kiralandi' || !lease || job.kiralama !== lease || job.kiralama_bitis < now()) return { status: 409, error: 'Kiralama geçersiz ya da süresi dolmuş' };
  return { job };
}
function image(db, id, lease) {
  const r = leased(db, id, lease);
  if (r.error) return r;
  return { buffer: fs.readFileSync(r.job.gorsel_yol), mime: r.job.gorsel_mime };
}
// Invalidate the stored previews of these applications (draft versions only) so the next request builds them again.
function refresh(db, appIds) {
  if (!appIds.length) return;
  require('./documents').invalidateExtracted(db, appIds);
}
async function submit(db, dataDir, id, lease, results) {
  const r = leased(db, id, lease);
  if (r.error) return r;
  const job = r.job, positions = JSON.parse(job.konumlar_json), byPos = new Map((results || []).map(x => [String(x.konum), x.png]));
  const rows = db.prepare('SELECT * FROM desen_isci_konum WHERE is_id=?').all(id);
  const outcome = {}, apps = [];
  for (const konum of positions) {
    const mine = rows.filter(k => k.konum === konum);
    let ok = false, neden = null;
    try {
      const png = byPos.get(konum) ? Buffer.from(byPos.get(konum), 'base64') : null;
      if (!png || png.length < 100) throw new Error('İşçi bu deseni üretmedi');
      await require('@napi-rs/canvas').loadImage(png); // must decode
      for (const k of mine) {
        if (!k.kirpim_yol || !fs.existsSync(k.kirpim_yol)) continue; // no crop yet: apply() checks it again before use
        const check = await desenCizim.fidelity(fs.readFileSync(k.kirpim_yol), png);
        if (!check.ok) throw new Error(`Yeniden çizim kaynağa benzemiyor: ${check.reasons.join('; ')}`);
      }
      write(path.join(cacheDir(dataDir), `${job.anahtar}-${konum}.png`), png);
      ok = true;
    } catch (e) { neden = String(e.message).slice(0, 300); }
    outcome[konum] = ok ? 'hazir' : 'reddedildi';
    db.prepare('UPDATE desen_isci_konum SET durum=?,neden=? WHERE is_id=? AND konum=?').run(ok ? 'hazir' : 'reddedildi', neden, id, konum);
    apps.push(...mine.map(k => k.application_id).filter(v => v != null));
  }
  const any = Object.values(outcome).includes('hazir');
  tx(db, () => {
    db.prepare("UPDATE desen_isci_is SET durum=?,kiralama=NULL,hata=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
      .run(any ? 'hazir' : 'reddedildi', any ? null : 'hiçbir desen denetimden geçmedi', id);
    audit(db, null, 'desen_isci_sonuc', id, { sonuc: outcome });
  });
  refresh(db, [...new Set(apps)]);
  return { ok: true, sonuc: outcome };
}
function fail(db, id, lease, message) {
  const r = leased(db, id, lease);
  if (r.error) return r;
  const giveUp = r.job.deneme >= MAX_TRIES;
  db.prepare("UPDATE desen_isci_is SET durum=?,kiralama=NULL,hata=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
    .run(giveUp ? 'vazgecildi' : 'bekliyor', String(message || 'hata').slice(0, 300), id);
  if (giveUp) {
    db.prepare("UPDATE desen_isci_konum SET durum='reddedildi',neden=? WHERE is_id=? AND durum='bekliyor'").run('Deneme sınırına ulaşıldı: ' + String(message || '').slice(0, 200), id);
    refresh(db, db.prepare('SELECT application_id FROM desen_isci_konum WHERE is_id=? AND application_id IS NOT NULL').all(id).map(k => k.application_id));
  }
  return { ok: true, durum: giveUp ? 'vazgecildi' : 'bekliyor' };
}
const listing = db => ({
  sayilar: Object.fromEntries(db.prepare('SELECT durum,COUNT(*) n FROM desen_isci_is GROUP BY durum').all().map(r => [r.durum, r.n])),
  bekleyen: db.prepare("SELECT id,konumlar_json,deneme,durum FROM desen_isci_is WHERE durum IN ('bekliyor','kiralandi') ORDER BY id LIMIT 50").all()
    .map(j => ({ id: j.id, konumlar: JSON.parse(j.konumlar_json), deneme: j.deneme, durum: j.durum })),
});

module.exports = { queue, stateFor, claim, image, submit, fail, listing, cacheDir, MAX_TRIES };
