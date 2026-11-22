'use strict';
// G64: customer approval link. A signed-in user mints a token for a version waiting for approval; the customer opens it
// without logging in, sees a whitelisted summary and either approves or leaves a change note.
// Only the SHA-256 of the token is stored. Every invalid state (unknown, expired, revoked, superseded version) is one and the same 404.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { tx, audit, fail } = require('./db');
const orders = require('./orders');
const documents = require('./documents');
const { approveVersion } = require('./approval');

const TTL_MS = 14 * 24 * 60 * 60 * 1000;
const CUSTOMER_USER = 'Müşteri (link)';
const NOT_FOUND = 'Bağlantı geçerli değil';
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const RECIPE_PRODUCTS = require('../operations/recipes.json').products;
const sha256 = v => crypto.createHash('sha256').update(v).digest('hex');
const notFound = () => fail(NOT_FOUND, 404);
const PRODUCT_IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

// One combined front+back picture uploaded as both views is the same bytes twice: show it once (G68).
// gorunum stays the single view when there is one; gorunumler lists every view the same bytes were saved as.
function productImages(files, base) {
  const bySha = new Map();
  for (const f of files) {
    const seen = bySha.get(f.sha256);
    if (seen) { if (f.gorunum && !seen.gorunumler.includes(f.gorunum)) seen.gorunumler.push(f.gorunum); continue; }
    bySha.set(f.sha256, { file: f, gorunumler: f.gorunum ? [f.gorunum] : [] });
  }
  return [...bySha.values()].map(({ file, gorunumler }) => ({ gorunum: gorunumler.length > 1 ? null : file.gorunum || null, gorunumler,
    url: `${base}/gorsel/${file.id}` }));
}
// Special account that owns approvals made through a link. Its password hash can never verify (no scrypt preimage is known).
function ensureCustomerUser(db) {
  const row = db.prepare('SELECT id FROM users WHERE name=?').get(CUSTOMER_USER);
  if (row) return row.id;
  const hash = `scrypt:${'0'.repeat(32)}:${'0'.repeat(128)}`;
  return Number(db.prepare("INSERT INTO users(name,password_hash,role,onay_yetkisi) VALUES(?,?,'ekip',1)").run(CUSTOMER_USER, hash).lastInsertRowid);
}

const ORIGIN_RE = /^https?:\/\/[^\s/,]+$/;
// PANEL_ORIGIN wins; otherwise CORS_ORIGIN is used only when it names exactly one origin (never "*", never a list).
function panelOriginFrom(env = process.env) {
  const own = String(env.PANEL_ORIGIN ?? '').trim().replace(/\/+$/, '');
  if (own) return ORIGIN_RE.test(own) ? { origin: own } : { error: 'PANEL_ORIGIN geçerli bir adres değil (https://alan-adi biçiminde olmalı)' };
  const cors = String(env.CORS_ORIGIN ?? '').trim().replace(/\/+$/, '');
  if (ORIGIN_RE.test(cors)) return { origin: cors };
  if (cors.includes(',') || /\s/.test(cors)) return { error: 'PANEL_ORIGIN ayarlı değil ve CORS_ORIGIN birden çok köken içeriyor; PANEL_ORIGIN belirleyin' };
  return { error: 'PANEL_ORIGIN ayarlı değil (CORS_ORIGIN da tek bir köken değil); link üretilemez' };
}

function createLink(db, versionId, user, { panelOrigin, now = Date.now() } = {}) {
  const found = panelOrigin ? (ORIGIN_RE.test(panelOrigin) ? { origin: panelOrigin } : { error: 'Geçersiz panel adresi' }) : panelOriginFrom();
  if (found.error) fail(found.error, 503);
  const origin = found.origin;
  return tx(db, () => {
    const userId = typeof user === 'object' ? user.id : user;
    const v = orders.snapshot(db, versionId);
    if (v.status !== 'onay_bekliyor') fail('Müşteri linki yalnız onay bekleyen sürüm için üretilir', 409);
    if (!v.files.some(f => f.kind === 'onay_formu')) fail('Onay formu hazır değil; önce belgeleri hazırlayın', 409);
    const at = new Date(now).toISOString();
    db.prepare('UPDATE customer_links SET revoked_at=? WHERE version_id=? AND revoked_at IS NULL').run(at, versionId);
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(now + TTL_MS).toISOString();
    const id = Number(db.prepare('INSERT INTO customer_links(version_id,token_hash,expires_at,created_by,created_at) VALUES(?,?,?,?,?)')
      .run(versionId, sha256(token), expiresAt, userId, at).lastInsertRowid);
    audit(db, userId, 'musteri_link_uret', versionId, { linkId: id, expiresAt }); // never the token
    return { link: `${origin}/onay.html?t=${token}`, expiresAt, versionId };
  });
}

// Constant-time comparison of the stored digest with the presented one; the row is looked up by digest.
function resolve(db, token, { now = Date.now() } = {}) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) notFound();
  const hash = sha256(token);
  const row = db.prepare('SELECT * FROM customer_links WHERE token_hash=?').get(hash);
  const stored = Buffer.from(row ? row.token_hash : '0'.repeat(64), 'hex');
  const ok = crypto.timingSafeEqual(stored, Buffer.from(hash, 'hex'));
  if (!row || !ok || row.revoked_at || row.expires_at <= new Date(now).toISOString()) notFound();
  const v = db.prepare('SELECT v.*,o.deleted_at FROM order_versions v JOIN orders o ON o.id=v.order_id WHERE v.id=?').get(row.version_id);
  // A revised version is 'eski': its link is dead. A staff approval keeps the link readable as "onaylandi".
  if (!v || v.deleted_at || !['onay_bekliyor', 'onaylandi'].includes(v.status)) notFound();
  return { link: row, version: v };
}

function stateOf(db, link, version) {
  if (db.prepare('SELECT 1 FROM approvals WHERE version_id=?').get(version.id)) return 'onaylandi';
  if (db.prepare('SELECT 1 FROM customer_notes WHERE version_id=? AND link_id=?').get(version.id, link.id)) return 'degisiklik_istendi';
  return 'bekliyor';
}

let terms;
const termsText = () => (terms ??= fs.readFileSync(path.join(__dirname, 'pdf', 'sartlar.txt'), 'utf8'));
const latestFile = (v, kind) => v.files.findLast(f => f.kind === kind);

// Explicit whitelist: nothing is spread from a row. No price, cost, stock, internal note, user name or measurement reason.
function summary(db, token, opts) {
  const { link, version } = resolve(db, token, opts);
  const v = orders.snapshot(db, version.id);
  const order = db.prepare('SELECT order_no,customer_name FROM orders WHERE id=?').get(v.order_id);
  const t = encodeURIComponent(token);
  const base = `/api/siparis/musteri/${t}`;
  const form = latestFile(v, 'onay_formu');
  const durum = stateOf(db, link, version);
  const approval = durum === 'onaylandi' ? db.prepare('SELECT full_name,approved_at FROM customer_approvals WHERE version_id=?').get(v.id) : null;
  return {
    durum,
    siparis: { no: order.order_no, ad: order.customer_name || null, surum: v.version_no },
    sonKullanma: link.expires_at,
    urunler: v.lines.map(l => {
      let sizes = {};
      try { sizes = JSON.parse(l.sizes_json) || {}; } catch { /* keep empty */ }
      return {
        ad: RECIPE_PRODUCTS[l.product_key]?.label || l.product_key,
        renk: l.color_name || null,
        kumas: l.fabric_type ? require('./kartela').fabricName(l.fabric_type) : null,
        numune: !!l.numune,
        adet: l.quantity,
        bedenler: Object.fromEntries(Object.entries(sizes).map(([k, n]) => [String(k), Number(n)])),
        gorseller: productImages(v.files.filter(f => f.kind === 'urun_gorsel' && f.line_id === l.id && PRODUCT_IMAGE_MIME[path.extname(f.path).toLowerCase()]), base),
        uygulamalar: l.applications.map(a => {
          let src = {};
          try { src = JSON.parse(a.measure_source) || {}; } catch { /* free text source */ }
          const pending = !(a.width_mm > 0 && a.height_mm > 0);
          // Status label only from an explicit field in measure_source (G61); otherwise none is shown.
          const flag = [src.durum, src.olcuDurumu].find(x => typeof x === 'string');
          const label = ['otomatik', 'yaklasik', 'standart'].includes(flag) ? flag : (src.yaklasik === true ? 'yaklasik' : src.standart === true ? 'standart' : null);
          return { tur: a.kind, konum: a.position, enMm: pending ? null : a.width_mm, boyMm: pending ? null : a.height_mm,
            olcu: pending ? 'bekliyor' : label };
        }),
      };
    }),
    onayFormu: form ? `${base}/onay-formu.pdf` : null,
    sartlar: termsText(),
    notlar: db.prepare('SELECT created_at AS tarih,note AS metin FROM customer_notes WHERE version_id=? AND link_id=? ORDER BY id').all(v.id, link.id),
    ...(approval ? { onaylayan: approval.full_name, onayTarihi: approval.approved_at } : {}),
  };
}

function file(db, dataDir, token, { kind, fileId } = {}) {
  const { version } = resolve(db, token);
  const v = orders.snapshot(db, version.id);
  const f = kind === 'onay_formu' ? latestFile(v, 'onay_formu') : v.files.find(x => x.id === fileId && x.kind === 'urun_gorsel');
  if (!f) notFound();
  const ext = path.extname(f.path).toLowerCase();
  const mime = kind === 'onay_formu' ? 'application/pdf' : PRODUCT_IMAGE_MIME[ext];
  if (!mime) notFound();
  return { buffer: documents.readFile(dataDir, f), mime, name: path.basename(f.path) };
}

const cleanName = value => {
  const s = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (s.length < 2 || s.length > 120 || /[\u0000-\u001f\u007f]/.test(s)) fail('Ad soyad 2–120 karakter olmalı');
  return s;
};
const clip = (value, n) => String(value ?? '').slice(0, n);

function approve(db, token, body, ctx = {}, { recipes } = {}) {
  const { link, version } = resolve(db, token);
  if (body?.kabul !== true) fail('Onay için şartları kabul etmeniz gerekir');
  const name = cleanName(body.adSoyad);
  // A second POST (or a staff approval in between) gives the same result and writes nothing.
  const already = () => db.prepare('SELECT 1 FROM approvals WHERE version_id=?').get(version.id);
  if (already()) return { durum: 'onaylandi', tekrar: true };
  const userId = ensureCustomerUser(db);
  try {
    return tx(db, () => {
      if (already()) return { durum: 'onaylandi', tekrar: true };
      const v = orders.snapshot(db, version.id);
      const form = latestFile(v, 'onay_formu');
      if (!form) fail('Onay formu henüz hazırlanmadı; lütfen bizimle iletişime geçin', 409);
      try {
        documents.unlocked(db, v.id);
        documents.assertMeasurements(db, v);
        documents.assertVectorQuality(db, v);
        documents.assertFresh(db, v);
        approveVersion(db, { versionId: v.id, userId, fileId: form.id, ...(recipes ? { recipes } : {}) });
      } catch (e) { e.gate = true; throw e; }
      db.prepare('INSERT INTO customer_approvals(version_id,link_id,full_name,ip,user_agent) VALUES(?,?,?,?,?)')
        .run(v.id, link.id, name, clip(ctx.ip, 64), clip(ctx.userAgent, 300));
      audit(db, userId, 'musteri_onay', v.id, { linkId: link.id, adSoyad: name, ip: clip(ctx.ip, 64), userAgent: clip(ctx.userAgent, 300) });
      return { durum: 'onaylandi', tekrar: false };
    });
  } catch (e) {
    if (!e.gate) throw e;
    // Internal reasons (recipes, stock, measurements) are not for the customer; the staff sees them in the audit log.
    audit(db, userId, 'musteri_onay_reddedildi', version.id, { linkId: link.id, reason: String(e.message).slice(0, 300) });
    const err = new Error('Onay şu an tamamlanamadı; lütfen bizimle iletişime geçin');
    err.status = 409;
    throw err;
  }
}

function requestChange(db, token, body, ctx = {}) {
  const { link, version } = resolve(db, token);
  const name = cleanName(body?.adSoyad);
  const note = typeof body?.not === 'string' ? body.not.trim() : '';
  if (note.length < 1 || note.length > 2000) fail('Not 1–2000 karakter olmalı');
  return tx(db, () => {
    if (db.prepare('SELECT 1 FROM approvals WHERE version_id=?').get(version.id)) fail('Bu sipariş onaylanmış; değişiklik için bizimle iletişime geçin', 409);
    const userId = ensureCustomerUser(db);
    const id = Number(db.prepare('INSERT INTO customer_notes(version_id,link_id,full_name,note,ip,user_agent) VALUES(?,?,?,?,?,?)')
      .run(version.id, link.id, name, note, clip(ctx.ip, 64), clip(ctx.userAgent, 300)).lastInsertRowid);
    db.prepare("INSERT INTO confirmations(kind,ref_table,ref_id,message) VALUES('musteri_notu','order_versions',?,?)")
      .run(version.id, `Müşteri değişiklik istedi (${name}): ${note.length > 200 ? note.slice(0, 200) + '…' : note}`);
    audit(db, userId, 'musteri_degisiklik', version.id, { linkId: link.id, noteId: id });
    return { durum: 'degisiklik_istendi' };
  });
}

// Staff view: notes of a version (panel shows them on the order card). Plain text; the panel escapes on render.
function notesOf(db, versionId) {
  return db.prepare('SELECT id,full_name AS adSoyad,note AS metin,created_at AS tarih FROM customer_notes WHERE version_id=? ORDER BY id').all(versionId);
}

module.exports = { panelOriginFrom, createLink, summary, file, approve, requestChange, notesOf, ensureCustomerUser, resolve, CUSTOMER_USER, TTL_MS };
