'use strict';
// G63: print/embroidery size name from an application's mm measure, by a table the team loads (Patron gives the limits).
// Cost itself stays in productionForm/pricingEngine: this only chooses the costTemplates size name they already price by.
// An empty table means no size is ever chosen here (G5 waits for a person, as before).
const { tx, audit, fail } = require('./db');
const { areaKey } = require('./areas');

const TYPES = ['baski', 'nakis'];
const SCHEMA = `CREATE TABLE IF NOT EXISTS boyut_esleme (
 id INTEGER PRIMARY KEY, tur TEXT NOT NULL CHECK(tur IN ('baski','nakis')), sira INTEGER NOT NULL, boyut TEXT NOT NULL,
 en_uzun_mm_max REAL NOT NULL CHECK(en_uzun_mm_max>0), alan_cm2_max REAL CHECK(alan_cm2_max IS NULL OR alan_cm2_max>0),
 UNIQUE(tur,sira)
);`;
const ready = new WeakSet();
function ensureSchema(db) {
  if (!ready.has(db)) { db.exec(SCHEMA); ready.add(db); }
  return db;
}
const hasTable = db => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='boyut_esleme'").get();
// Read without creating anything, so a read-only dry run works on a database that never loaded a table.
function rules(db) {
  return hasTable(db) ? db.prepare('SELECT * FROM boyut_esleme ORDER BY tur,sira').all() : [];
}

// {baski:[{boyut,enUzunMm,alanCm2?}], nakis:[...]}; within a type the first matching row wins, so rows go small to large.
function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Eşleme tablosu {baski:[...], nakis:[...]} biçiminde olmalı');
  const extra = Object.keys(input).filter(k => !TYPES.includes(k));
  if (extra.length) fail(`Bilinmeyen tür: ${extra.join(', ')} (yalnız baski, nakis)`);
  const rows = [];
  for (const tur of TYPES) {
    const list = input[tur] ?? [];
    if (!Array.isArray(list) || list.length > 50) fail(`${tur}: en çok 50 satırlık dizi olmalı`);
    let prev = 0;
    list.forEach((r, i) => {
      const where = `${tur}[${i}]`;
      if (!r || typeof r.boyut !== 'string' || !r.boyut.trim() || r.boyut.length > 80) fail(`${where}.boyut: boyut adı gerekli`);
      if (typeof r.enUzunMm !== 'number' || !Number.isFinite(r.enUzunMm) || r.enUzunMm <= 0) fail(`${where}.enUzunMm: pozitif sayı olmalı`);
      if (r.alanCm2 != null && (typeof r.alanCm2 !== 'number' || !Number.isFinite(r.alanCm2) || r.alanCm2 <= 0)) fail(`${where}.alanCm2: pozitif sayı olmalı`);
      // A smaller limit after a larger one could never match: the order would silently hide a row.
      if (r.enUzunMm < prev) fail(`${where}: satırlar en uzun kenara göre küçükten büyüğe sıralanmalı`);
      prev = r.enUzunMm;
      const unknown = Object.keys(r).filter(k => !['boyut', 'enUzunMm', 'alanCm2'].includes(k));
      if (unknown.length) fail(`${where}: bilinmeyen alan ${unknown.join(', ')}`);
      rows.push({ tur, sira: i, boyut: r.boyut.trim(), en_uzun_mm_max: r.enUzunMm, alan_cm2_max: r.alanCm2 ?? null });
    });
  }
  return rows;
}
// Replaces the whole table in one transaction; an empty object empties it (back to "no automatic size").
function load(db, input, { userId = null } = {}) {
  const rows = validate(input);
  ensureSchema(db);
  return tx(db, () => {
    db.prepare('DELETE FROM boyut_esleme').run();
    const ins = db.prepare('INSERT INTO boyut_esleme(tur,sira,boyut,en_uzun_mm_max,alan_cm2_max) VALUES(?,?,?,?,?)');
    for (const r of rows) ins.run(r.tur, r.sira, r.boyut, r.en_uzun_mm_max, r.alan_cm2_max);
    audit(db, userId, 'boyut_esleme_yukle', 'boyut_esleme', { satir: rows.length });
    // Cost transfers parked for a missing size get one more look; one that still lacks input simply parks again.
    const parked = db.prepare("SELECT id FROM outbox WHERE kind='maliyet_aktarim' AND status='fiyat_bekliyor'").all();
    for (const j of parked) {
      db.prepare("UPDATE outbox SET status='bekliyor',next_run_at=?,updated_at=? WHERE id=?").run(new Date().toISOString(), new Date().toISOString(), j.id);
      audit(db, userId, 'kuyruk_yeniden', j.id, { neden: 'boyut_esleme_yukle' });
    }
    return rules(db);
  });
}

// One application -> {boyut|null, kaynak}. Never a size the cost table does not price, never a size without a measure.
function sizeFor(table, app, costTemplates) {
  const own = table.filter(r => r.tur === app.kind);
  if (!own.length) return { boyut: null, kaynak: 'eşleme tablosu boş' };
  if (!(app.width_mm > 0) || !(app.height_mm > 0)) return { boyut: null, kaynak: 'ölçü yok' };
  const longest = Math.max(app.width_mm, app.height_mm), areaCm2 = app.width_mm * app.height_mm / 100;
  const hit = own.find(r => longest <= r.en_uzun_mm_max && (r.alan_cm2_max == null || areaCm2 <= r.alan_cm2_max));
  const measure = `${app.width_mm}×${app.height_mm} mm (en uzun ${longest} mm, alan ${Math.round(areaCm2 * 10) / 10} cm²)`;
  if (!hit) return { boyut: null, kaynak: `${measure}: hiçbir kurala uymuyor` };
  const rule = `en uzun ≤ ${hit.en_uzun_mm_max} mm${hit.alan_cm2_max != null ? ` ve alan ≤ ${hit.alan_cm2_max} cm²` : ''}`;
  const priced = costTemplates?.[app.kind] || {};
  if (priced[hit.boyut] == null) return { boyut: null, kaynak: `${measure}, kural "${rule}" → "${hit.boyut}" maliyet tablosunda yok` };
  return { boyut: hit.boyut, kaynak: `${measure}, kural "${rule}"` };
}

// Every application of the counted lines with its size; bnItems only when every one has a size, else null (G5 waits).
function derive(table, lines, costTemplates) {
  const apps = [];
  for (const l of lines) for (const a of l.applications || [])
    apps.push({ tur: a.kind, konum: areaKey(a.position), en_mm: a.width_mm ?? null, boy_mm: a.height_mm ?? null, adet: l.quantity, ...sizeFor(table, a, costTemplates) });
  const counted = apps.filter(a => a.adet > 0);
  if (!table.length || !counted.length || counted.some(a => !a.boyut)) return { apps, bnItems: null };
  const merged = new Map();
  for (const a of counted) {
    const k = `${a.tur}|${a.konum}|${a.boyut}`;
    if (!merged.has(k)) merged.set(k, { type: a.tur, area: a.konum, size: a.boyut, qty: 0 });
    merged.get(k).qty += a.adet;
  }
  return { apps, bnItems: [...merged.values()] };
}

// Read-only list of the size names (and unit TL) the panel's cost table prices, to agree the mapping with Patron.
function sizeNames(costTemplates) {
  const list = tur => Object.entries(costTemplates?.[tur] || {}).map(([boyut, tl]) => ({ tur, boyut, adetBasiTl: tl }));
  return [...list('baski'), ...list('nakis')];
}

module.exports = { ensureSchema, rules, validate, load, sizeFor, derive, sizeNames };
