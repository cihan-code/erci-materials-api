'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { tx, audit, fail } = require('./db');
const { assertUser } = require('./auth');
const { validSizeChart } = require('./sizeChart');

function init(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS document_flats (
    id TEXT PRIMARY KEY, ad TEXT NOT NULL, urun TEXT NOT NULL,
    gorunum TEXT NOT NULL CHECK(gorunum IN ('on','arka')), dosya TEXT NOT NULL,
    refLengthPx REAL, refLengthCm REAL, refAciklama TEXT, refBeden TEXT, olculerL TEXT
  )`);
  // Older databases predate the reference size column; missing values stay null.
  if (!db.prepare('PRAGMA table_info(document_flats)').all().some(c => c.name === 'refBeden'))
    db.exec('ALTER TABLE document_flats ADD COLUMN refBeden TEXT');
  if (!db.prepare('PRAGMA table_info(document_flats)').all().some(c => c.name === 'olculerL'))
    db.exec('ALTER TABLE document_flats ADD COLUMN olculerL TEXT');
  if (!db.prepare('PRAGMA table_info(document_flats)').all().some(c => c.name === 'bedenTablosu'))
    db.exec('ALTER TABLE document_flats ADD COLUMN bedenTablosu TEXT');
}
function get(db, id) {
  const row = db.prepare('SELECT * FROM document_flats WHERE id=?').get(id);
  if (!row) fail('Düz çizim bulunamadı', 404);
  return decode(row);
}
function decode(row) {
  if (typeof row.olculerL === 'string') { try {row.olculerL=JSON.parse(row.olculerL);} catch {row.olculerL=null;} }
  if (typeof row.bedenTablosu === 'string') { try {row.bedenTablosu=JSON.parse(row.bedenTablosu);} catch {row.bedenTablosu=null;} }
  return row;
}
function list(db) { return db.prepare('SELECT * FROM document_flats ORDER BY ad,id').all().map(decode); }
const normalize = value => String(value).toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/ı/g,'i').replace(/[^a-z0-9]/g,'');
// Products without their own L pattern borrow one with the same body (Şef kararı,
// 20.11.2026: a half-zip sweat has the SWEAT body). The product's own pattern wins.
const FLAT_ALIASES = { yarim_fermuar: 'sweat' };
function selection(db, line, view, library) {
  const available = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='document_flats'").get();
  const rows = available ? (library ?? list(db)).filter(f=>f.refBeden?.trim().toUpperCase()==='L') : [];
  const own = rows.filter(f=>f.urun===line.product_key);
  const key = own.length || !Object.hasOwn(FLAT_ALIASES, line.product_key) ? line.product_key : FLAT_ALIASES[line.product_key];
  const all = own.length ? own : rows.filter(f=>f.urun===key);
  const inView = all.filter(f=>f.gorunum===view);
  const candidates = view && inView.length ? inView : all;
  const base = normalize(key);
  const name = ['kapusonlu','hoodie','sweatshirt','sweat'].includes(base) ? 'sweat' : base;
  const defaults = candidates.filter(f=>!/(oversize|owersize|zip)/.test(normalize(f.ad)) && normalize(f.ad)===name);
  const flat = line.kalip_id ? all.find(f=>f.id===line.kalip_id) ?? null
    : candidates.length===1 ? candidates[0] : defaults.length===1 ? defaults[0] : null;
  return {candidates,flat};
}
// Actionable reason when the product has no usable L pattern: the library
// rows exist but their refBeden/olculerL fields are empty (G47).
const positive = n => Number.isFinite(n) && n > 0;
const hasL = f => f.refBeden?.trim().toUpperCase()==='L' && f.olculerL && typeof f.olculerL==='object' && ['omuzdan_boy','etek','gogus','yan_boy','basen'].some(k=>positive(f.olculerL[k]));
function missingLNote(db, line, flat, library) {
  if (flat && hasL(flat)) return null;
  const available = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='document_flats'").get();
  const rows = available ? (library ?? list(db)) : [];
  const own = rows.filter(f=>f.urun===line.product_key);
  const named = flat ? [flat] : own.length || !Object.hasOwn(FLAT_ALIASES, line.product_key) ? own : rows.filter(f=>f.urun===FLAT_ALIASES[line.product_key]);
  if (!named.length) return 'Bu ürün için kalıp kütüphanesinde kalıp yok; L ölçüleriyle kalıp ekleyin';
  const names = [...new Set(named.map(f=>f.ad))];
  return `${names.join(', ')} ${names.length>1?'kalıplarında':'kalıbında'} L ölçüleri yok; kalıp kütüphanesini güncelleyin`;
}
// kalip-l-tamamla: fill only empty refBeden/olculerL fields from an L list
// kept outside the repository (same shape as duz-cizimler.json). A filled
// field is never overwritten. refBeden becomes "L" only when the stored
// reference cm is empty or equal to the list's L value: a different value is
// probably the old M reference and needs duz-cizim-yukle --guncelle instead.
const validL = o => o && typeof o==='object' && !Array.isArray(o) && Object.keys(o).length>0 && Object.entries(o).every(([k,v])=>/^[a-z][a-z0-9_]*$/.test(k) && positive(v));
function fillMissingL(db, records, { dry=false } = {}) {
  if (!Array.isArray(records)) fail('L listesi bir dizi olmalı');
  const byName = new Map();
  for (const r of records) {
    if (!r || typeof r.ad!=='string' || !r.ad.trim() || byName.has(r.ad.trim())) fail('L listesinde kalıp adları dolu ve tekil olmalı');
    byName.set(r.ad.trim(), r);
  }
  const rows = [], seen = new Set();
  const run = () => {
    for (const f of list(db)) {
      const r = byName.get(f.ad.trim()), row = { id:f.id, ad:f.ad, alanlar:[] };
      rows.push(row);
      if (!r) { row.durum='atlandi'; row.neden='L listesinde yok'; continue; }
      seen.add(f.ad.trim());
      if (r.urun!=null && r.urun!==f.urun) { row.durum='atlandi'; row.neden=`ürün farklı (${f.urun} ≠ ${r.urun})`; continue; }
      if (String(r.refBeden??'').trim().toUpperCase()!=='L' || !validL(r.olculerL)) { row.durum='atlandi'; row.neden='listede L beden ve pozitif olculerL yok'; continue; }
      const beden = f.refBeden?.trim() ? f.refBeden.trim().toUpperCase() : null;
      if (beden && beden!=='L') { row.durum='atlandi'; row.neden=`kayıtlı referans beden ${f.refBeden}`; continue; }
      if (!beden && f.refLengthCm!=null && f.refLengthCm!==r.refLengthCm) { row.durum='atlandi'; row.neden=`kayıtlı referans ${f.refLengthCm} cm, L listesi ${r.refLengthCm ?? '?'} cm; duz-cizim-yukle --guncelle kullanın`; continue; }
      if (!beden) { row.alanlar.push('refBeden'); if (!dry) db.prepare("UPDATE document_flats SET refBeden='L' WHERE id=?").run(f.id); }
      if (!validL(f.olculerL)) { row.alanlar.push('olculerL'); if (!dry) db.prepare('UPDATE document_flats SET olculerL=? WHERE id=?').run(JSON.stringify(r.olculerL), f.id); }
      row.durum = row.alanlar.length ? 'dolduruldu' : 'tam';
      if (row.alanlar.length && !dry) audit(db, null, 'kalip_l_tamamla', f.id, { alanlar:row.alanlar, cli:true });
    }
  };
  dry ? run() : tx(db, run);
  const unused = [...byName.keys()].filter(ad=>!seen.has(ad));
  return { rows, unused, filled:rows.filter(r=>r.durum==='dolduruldu').length };
}
// Filled tables are preserved. Importing a chart never changes scale fields.
function fillMissingSizeCharts(db, records, { dry=false } = {}) {
  if (!Array.isArray(records)) fail('Beden tablosu listesi bir dizi olmalı');
  const names = new Set();
  for (const r of records) {
    if (!r || typeof r.ad !== 'string' || !r.ad.trim() || names.has(r.ad.trim()) || !validSizeChart(r.bedenTablosu))
      fail('Tekil kalıp adı ve kaynaklı gerçek bedenTablosu gerekli');
    names.add(r.ad.trim());
  }
  const rows = [], seen = new Set();
  const run = () => {
    for (const f of list(db)) {
      const r = records.find(r => r.ad.trim() === f.ad.trim()), row = { id:f.id, ad:f.ad, alanlar:[] };
      rows.push(row);
      if (!r) { row.durum='atlandi'; row.neden='kaynak listesinde yok'; continue; }
      seen.add(r.ad.trim());
      if (r.urun != null && r.urun !== f.urun) { row.durum='atlandi'; row.neden='ürün farklı'; continue; }
      const stored = db.prepare('SELECT bedenTablosu FROM document_flats WHERE id=?').get(f.id).bedenTablosu;
      if (stored != null && stored.trim() && stored !== 'null' && stored !== '{}') { row.durum='tam'; continue; }
      row.alanlar.push('bedenTablosu'); row.durum='dolduruldu';
      if (!dry) {
        db.prepare('UPDATE document_flats SET bedenTablosu=? WHERE id=?').run(JSON.stringify(r.bedenTablosu), f.id);
        audit(db, null, 'kalip_beden_tamamla', f.id, { kaynak:r.bedenTablosu.kaynak, cli:true });
      }
    }
  };
  dry ? run() : tx(db, run);
  return { rows, unused:[...names].filter(ad => !seen.has(ad)), filled:rows.filter(r => r.durum==='dolduruldu').length };
}
function lineSelection(db,line) {
  const {candidates,flat}=selection(db,line);
  return {kalipId:flat?.id??null,kalipAdaylari:candidates.map(({id,ad,refBeden})=>({id,ad,refBeden}))};
}
function upload(db, dataDir, input, file, user) {
  assertUser(db, user.id);
  if (!['on','arka'].includes(input.gorunum) || !input.ad?.trim() || !input.urun?.trim())
    fail('ad, urun ve gorunum (on/arka) gerekli');
  // Library images must support the pixel reference measurement workflow.
  if (file.ext !== 'png' && file.ext !== 'jpg') fail('Düz çizim PNG veya JPG olmalı');
  const id = crypto.randomUUID();
  const dir = path.join(fs.realpathSync(dataDir), 'siparis', 'flats');
  fs.mkdirSync(dir, { recursive:true });
  if (fs.realpathSync(dir) !== path.resolve(dir)) fail('Düz çizim dizini sembolik bağlantı olamaz', 403);
  const dosya = path.join(dir, `${id}.${file.ext}`);
  fs.writeFileSync(dosya, file.buffer, { flag:'wx' });
  try {
    return tx(db, () => {
      db.prepare('INSERT INTO document_flats(id,ad,urun,gorunum,dosya) VALUES(?,?,?,?,?)')
        .run(id, input.ad.trim(), input.urun.trim(), input.gorunum, dosya);
      audit(db, user.id, 'duz_cizim_yukle', id);
      return get(db, id);
    });
  } catch (e) { fs.unlinkSync(dosya); throw e; }
}
function saveReference(db, id, input, user) {
  assertUser(db, user.id, true);
  for (const key of ['refLengthPx','refLengthCm'])
    if (!Number.isFinite(input[key]) || input[key] <= 0) fail('Pozitif referans px ve cm gerekli');
  if (typeof input.refAciklama !== 'string' || !input.refAciklama.trim()) fail('Referans açıklaması gerekli');
  if (input.refBeden!=null && (typeof input.refBeden!=='string' || !input.refBeden.trim())) fail('Geçerli referans beden gerekli');
  if (Object.hasOwn(input,'bedenTablosu') && !validSizeChart(input.bedenTablosu)) fail('Kaynaklı gerçek bedenTablosu gerekli');
  if (Object.hasOwn(input,'olculerL') && (!input.olculerL || typeof input.olculerL!=='object' || Array.isArray(input.olculerL) || !Object.keys(input.olculerL).length || Object.entries(input.olculerL).some(([k,v])=> !/^[a-z][a-z0-9_]*$/.test(k) || !Number.isFinite(v) || v<=0))) fail('olculerL pozitif cm değerleri içeren bir nesne olmalı');
  return tx(db, () => {
    get(db, id);
    db.prepare('UPDATE document_flats SET refLengthPx=?,refLengthCm=?,refAciklama=? WHERE id=?')
      .run(input.refLengthPx, input.refLengthCm, input.refAciklama.trim(), id);
    if (Object.hasOwn(input,'refBeden')) db.prepare('UPDATE document_flats SET refBeden=? WHERE id=?').run(input.refBeden?.trim()??null,id);
    if (Object.hasOwn(input,'olculerL')) db.prepare('UPDATE document_flats SET olculerL=? WHERE id=?').run(JSON.stringify(input.olculerL),id);
    if (Object.hasOwn(input,'bedenTablosu')) db.prepare('UPDATE document_flats SET bedenTablosu=? WHERE id=?').run(JSON.stringify(input.bedenTablosu),id);
    audit(db, user.id, 'duz_cizim_referans', id, input);
    return get(db, id);
  });
}
module.exports = { init, get, list, upload, saveReference, selection, lineSelection, missingLNote, fillMissingL, fillMissingSizeCharts };
