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
    // G74: which drawing the worker chose for this print (tam | kirpik), or null.
    async secilen({ anahtar, position }) {
      return db.prepare(`SELECT k.secilen FROM desen_isci_konum k JOIN desen_isci_is j ON j.id=k.is_id
        WHERE j.anahtar=? AND k.konum=? AND k.secilen IS NOT NULL ORDER BY k.id DESC LIMIT 1`).get(anahtar, position)?.secilen ?? null;
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
// Second attempt (G71). The whole-picture drawing (asama "tam") is judged per print against the cut-out source:
//   weak  = it failed the fidelity check, OR its score (desenCizim.fidelity puan, 0..1) is below ZAYIF_PUAN,
//           OR the source cut-out is small (shortest side under KUCUK_PX): little detail to go by, so the model may invent.
// Weak prints get a second drawing from the cut-out alone (asama "kirpik", one Codex call per print) in the SAME job.
// The better score wins; the cut-out drawing wins a near tie (within TOLERANS) because it cannot invent beyond its source.
const ZAYIF_PUAN = () => Number(process.env.DESEN_ISCI_ZAYIF_PUAN) || 0.5;
const KUCUK_PX = () => Number(process.env.DESEN_ISCI_KUCUK_PX) || 150;
const TOLERANS = 0.05;
// G74: a print sitting tilted on the garment (a sleeve signature): the whole-picture drawing had to be turned at least
// EGIK degrees to match the cut-out, i.e. the model straightened it. The design file is upright (the tilt belongs to the
// placement), so a straightened drawing that passed the fidelity check is not judged against a cut-out drawing that
// merely copied the tilt of a small, blurred cut-out (G71/G72 left sleeve "BBT": the copy won on score and was broken).
// "Turned" means: the best turn is at least EGIK degrees, it matches well (overlap >= 0.8) and clearly better than the
// drawing as it stands (by 0.1): a poor drawing that only happens to fit better at some angle is not a straightened one.
const EGIK = 15;
const straight = c => !!c && Math.abs(c.donus ?? 0) >= EGIK && (c.ortusme ?? 0) >= 0.8 && (c.ortusme ?? 0) - (c.duz ?? 0) >= 0.1;
// Choice between the two drawings of one print: tamPuan / kirpikPuan are fidelity scores, null when that drawing is missing or refused;
// tamDonus / kirpikDonus: how each matched the cut-out ({donus: best turn in degrees, ortusme: overlap there, duz: overlap unturned}).
// A straightened whole-picture drawing wins over a cut-out drawing that kept the tilt; otherwise the higher score wins,
// the cut-out drawing on a near tie (within TOLERANS); nothing usable -> null.
function pick(tamPuan, kirpikPuan, { tamDonus = null, kirpikDonus = null } = {}) {
  if (tamPuan !== null && straight(tamDonus) && (kirpikPuan === null || !straight(kirpikDonus))) return 'tam';
  if (kirpikPuan !== null && (tamPuan === null || kirpikPuan >= tamPuan - TOLERANS)) return 'kirpik';
  return tamPuan !== null ? 'tam' : null;
}
function claim(db, dataDir) {
  return tx(db, () => {
    const t = now();
    // A worker that died: its lease ran out, the job is free again (tries are counted at the claim).
    db.prepare("UPDATE desen_isci_is SET durum='bekliyor',kiralama=NULL WHERE durum='kiralandi' AND kiralama_bitis<?").run(t);
    for (const j of db.prepare("SELECT * FROM desen_isci_is WHERE durum='bekliyor' AND deneme>=?").all(MAX_TRIES)) abandon(db, dataDir, j, 'deneme sınırı');
    const job = db.prepare("SELECT * FROM desen_isci_is WHERE durum='bekliyor' ORDER BY id LIMIT 1").get();
    if (!job) return null;
    const lease = crypto.randomBytes(16).toString('hex');
    db.prepare("UPDATE desen_isci_is SET durum='kiralandi',kiralama=?,kiralama_bitis=?,deneme=deneme+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(lease, t + LEASE_S(), job.id);
    const all = JSON.parse(job.konumlar_json);
    const konumlar = job.asama === 'kirpik' ? all.filter(k => db.prepare("SELECT 1 FROM desen_isci_konum WHERE is_id=? AND konum=? AND durum='ikinci'").get(job.id, k)) : all;
    return { id: job.id, kiralama: lease, kiralamaSn: LEASE_S(), deneme: job.deneme + 1, konumlar, kip: job.asama, mime: job.gorsel_mime };
  });
}
// A job past its try limit is given up. A print that already has a whole-picture candidate keeps it (hazir, secilen tam);
// the others fall back to the old path with a reason.
function abandon(db, dataDir, job, why) {
  const ids = [];
  for (const k of db.prepare("SELECT * FROM desen_isci_konum WHERE is_id=?").all(job.id)) {
    if (k.application_id != null) ids.push(k.application_id);
    if (!['bekliyor', 'ikinci'].includes(k.durum)) continue;
    if (k.durum === 'ikinci' && k.tam_yol && fs.existsSync(k.tam_yol)) {
      write(path.join(cacheDir(dataDir), `${job.anahtar}-${k.konum}.png`), fs.readFileSync(k.tam_yol));
      db.prepare("UPDATE desen_isci_konum SET durum='hazir',secilen='tam' WHERE id=?").run(k.id);
    } else db.prepare("UPDATE desen_isci_konum SET durum='reddedildi',neden=? WHERE id=?").run(`Deneme sınırına ulaşıldı: ${why}`.slice(0, 300), k.id);
  }
  const any = db.prepare("SELECT 1 FROM desen_isci_konum WHERE is_id=? AND durum='hazir'").get(job.id);
  db.prepare("UPDATE desen_isci_is SET durum=?,kiralama=NULL,hata=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(any ? 'hazir' : 'vazgecildi', String(why).slice(0, 300), job.id);
  return ids;
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
// The cut-out of one print, for the second attempt.
function cutout(db, id, lease, konum) {
  const r = leased(db, id, lease);
  if (r.error) return r;
  const k = db.prepare("SELECT kirpim_yol FROM desen_isci_konum WHERE is_id=? AND konum=? AND kirpim_yol IS NOT NULL LIMIT 1").get(id, konum);
  if (!k || !fs.existsSync(k.kirpim_yol)) return { status: 404, error: 'Kırpım yok' };
  return { buffer: fs.readFileSync(k.kirpim_yol), mime: 'image/png' };
}
// Invalidate the stored previews of these applications (draft versions only) so the next request builds them again.
function refresh(db, appIds) {
  if (!appIds.length) return;
  require('./documents').invalidateExtracted(db, appIds);
}
const decode = async b64 => { const png = b64 ? Buffer.from(b64, 'base64') : null; if (!png || png.length < 100) throw new Error('İşçi bu deseni üretmedi'); await require('@napi-rs/canvas').loadImage(png); return png; };
// Fidelity of a drawing against the print's stored cut-out(s): the weakest cut-out decides; {ok, puan, neden}. No cut-out yet: accepted here, apply() checks again.
async function judge(rows, png) {
  let worst = null;
  for (const k of rows) {
    if (!k.kirpim_yol || !fs.existsSync(k.kirpim_yol)) continue;
    const c = await desenCizim.fidelity(fs.readFileSync(k.kirpim_yol), png);
    const puan = c.metrics?.puan ?? null;
    if (!worst || !c.ok || (worst.ok && puan < worst.puan)) worst = { ok: c.ok, puan, donus: { donus: c.metrics?.donusDerece ?? 0, ortusme: c.metrics?.overlap ?? 0, duz: c.metrics?.duzOrtusme ?? 0 }, neden: c.ok ? null : `Yeniden çizim kaynağa benzemiyor: ${c.reasons.join('; ')}`, crop: k.kirpim_yol };
    if (!c.ok) break;
  }
  return worst || { ok: true, puan: null, neden: null, crop: null };
}
async function small(file) {
  if (!file) return false;
  const i = await require('@napi-rs/canvas').loadImage(fs.readFileSync(file));
  return Math.min(i.width, i.height) < KUCUK_PX();
}
async function submit(db, dataDir, id, lease, results) {
  const r = leased(db, id, lease);
  if (r.error) return r;
  const job = r.job, positions = JSON.parse(job.konumlar_json), byPos = new Map((results || []).map(x => [String(x.konum), x.png]));
  const rows = db.prepare('SELECT * FROM desen_isci_konum WHERE is_id=?').all(id);
  const cachePng = konum => path.join(cacheDir(dataDir), `${job.anahtar}-${konum}.png`), tamPng = konum => path.join(jobDir(dataDir), `${id}-${safe(konum)}.tam.png`);
  const outcome = {}, apps = [], second = [];
  const setRow = (konum, f) => db.prepare(`UPDATE desen_isci_konum SET ${Object.keys(f).map(k => `${k}=?`).join(',')} WHERE is_id=? AND konum=?`).run(...Object.values(f), id, konum);
  for (const konum of positions) {
    const mine = rows.filter(k => k.konum === konum), row0 = mine[0];
    apps.push(...mine.map(k => k.application_id).filter(v => v != null));
    if (job.asama === 'kirpik' && row0.durum !== 'ikinci') continue; // finished in the first stage
    let png = null, check = null, neden = null;
    try { png = await decode(byPos.get(konum)); check = await judge(mine, png); neden = check.neden; } catch (e) { neden = String(e.message).slice(0, 300); }
    if (job.asama === 'tam') {
      // G74: a missing or refused drawing (even "a copy of the input") always gets the cut-out attempt when a cut-out exists;
      // a straightened drawing that passed is final (the cut-out drawing would only copy the tilt).
      const cut = mine.find(k => k.kirpim_yol && fs.existsSync(k.kirpim_yol))?.kirpim_yol;
      const passed = !!check?.ok, upright = passed && straight(check.donus);
      const weak = !!cut && (!passed || (!upright && ((check.puan ?? 1) < ZAYIF_PUAN() || await small(cut))));
      if (weak) { // keep this drawing as the candidate, ask for a cut-out drawing
        if (png) write(tamPng(konum), png);
        setRow(konum, { durum: 'ikinci', tam_yol: png ? tamPng(konum) : null, tam_puan: check?.ok ? check.puan : null, neden });
        second.push(konum); outcome[konum] = 'ikinci'; continue;
      }
      if (check?.ok) { write(cachePng(konum), png); setRow(konum, { durum: 'hazir', neden: null, tam_puan: check.puan, secilen: 'tam' }); outcome[konum] = 'hazir'; }
      else { setRow(konum, { durum: 'reddedildi', neden: neden || 'Yeniden çizim alınamadı' }); outcome[konum] = 'reddedildi'; }
      continue;
    }
    // second stage: the better of the two drawings, the cut-out one on a near tie
    const tamThere = !!(row0.tam_yol && fs.existsSync(row0.tam_yol));
    const tamPuan = row0.tam_puan, kp = check?.ok ? check.puan : null;
    const tamDonus = tamPuan !== null && tamThere ? (await judge(mine, fs.readFileSync(row0.tam_yol))).donus : null;
    const choice = pick(tamPuan, kp, { tamDonus, kirpikDonus: check?.donus ?? null });
    const useCut = choice === 'kirpik', useTam = choice === 'tam' && tamThere;
    if (useCut || useTam) {
      write(cachePng(konum), useCut ? png : fs.readFileSync(row0.tam_yol));
      setRow(konum, { durum: 'hazir', neden: null, kirpik_puan: kp, secilen: useCut ? 'kirpik' : 'tam' });
      outcome[konum] = 'hazir';
    } else {
      setRow(konum, { durum: 'reddedildi', neden: [row0.neden, neden].filter(Boolean).join(' | ').slice(0, 300) || 'Yeniden çizim alınamadı' });
      outcome[konum] = 'reddedildi';
    }
  }
  const any = Object.values(outcome).includes('hazir');
  tx(db, () => {
    if (second.length) db.prepare("UPDATE desen_isci_is SET durum='bekliyor',asama='kirpik',deneme=0,kiralama=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(id);
    else db.prepare("UPDATE desen_isci_is SET durum=?,kiralama=NULL,hata=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
      .run(any || db.prepare("SELECT 1 FROM desen_isci_konum WHERE is_id=? AND durum='hazir'").get(id) ? 'hazir' : 'reddedildi', any ? null : 'hiçbir desen denetimden geçmedi', id);
    audit(db, null, 'desen_isci_sonuc', id, { asama: job.asama, sonuc: outcome });
  });
  if (!second.length) refresh(db, [...new Set(rows.filter(k => k.application_id != null).map(k => k.application_id))]);
  return { ok: true, sonuc: outcome, ...(second.length ? { ikinciDeneme: second } : {}) };
}
function fail(db, dataDir, id, lease, message) {
  const r = leased(db, id, lease);
  if (r.error) return r;
  const msg = String(message || 'hata').slice(0, 300);
  if (r.job.deneme < MAX_TRIES) {
    db.prepare("UPDATE desen_isci_is SET durum='bekliyor',kiralama=NULL,hata=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(msg, id);
    return { ok: true, durum: 'bekliyor' };
  }
  const ids = tx(db, () => abandon(db, dataDir, r.job, msg));
  refresh(db, [...new Set(ids)]);
  return { ok: true, durum: db.prepare('SELECT durum FROM desen_isci_is WHERE id=?').get(id).durum === 'hazir' ? 'hazir' : 'vazgecildi' };
}
const listing = db => ({
  sayilar: Object.fromEntries(db.prepare('SELECT durum,COUNT(*) n FROM desen_isci_is GROUP BY durum').all().map(r => [r.durum, r.n])),
  bekleyen: db.prepare("SELECT id,konumlar_json,deneme,durum FROM desen_isci_is WHERE durum IN ('bekliyor','kiralandi') ORDER BY id LIMIT 50").all()
    .map(j => ({ id: j.id, konumlar: JSON.parse(j.konumlar_json), deneme: j.deneme, durum: j.durum })),
});

module.exports = { pick, EGIK, ZAYIF_PUAN, KUCUK_PX, queue, stateFor, claim, image, cutout, submit, fail, listing, cacheDir, MAX_TRIES };
