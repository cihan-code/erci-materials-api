'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { tx, audit, fail } = require('./db');
const { assertUser } = require('./auth');

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
}
function get(db, id) {
  const row = db.prepare('SELECT * FROM document_flats WHERE id=?').get(id);
  if (!row) fail('Düz çizim bulunamadı', 404);
  return decode(row);
}
function decode(row) {
  if (typeof row.olculerL === 'string') { try {row.olculerL=JSON.parse(row.olculerL);} catch {row.olculerL=null;} }
  return row;
}
function list(db) { return db.prepare('SELECT * FROM document_flats ORDER BY ad,id').all().map(decode); }
const normalize = value => String(value).toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/ı/g,'i').replace(/[^a-z0-9]/g,'');
function selection(db, line, view, library) {
  const available = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='document_flats'").get();
  const all = available ? (library ?? list(db)).filter(f=>f.urun===line.product_key && f.refBeden?.trim().toUpperCase()==='L') : [];
  const inView = all.filter(f=>f.gorunum===view);
  const candidates = view && inView.length ? inView : all;
  const base = normalize(line.product_key);
  const name = ['kapusonlu','hoodie','sweatshirt','sweat'].includes(base) ? 'sweat' : base;
  const defaults = candidates.filter(f=>!/(oversize|owersize|zip)/.test(normalize(f.ad)) && normalize(f.ad)===name);
  const flat = line.kalip_id ? all.find(f=>f.id===line.kalip_id) ?? null
    : candidates.length===1 ? candidates[0] : defaults.length===1 ? defaults[0] : null;
  return {candidates,flat};
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
  if (Object.hasOwn(input,'olculerL') && (!input.olculerL || typeof input.olculerL!=='object' || Array.isArray(input.olculerL) || !Object.keys(input.olculerL).length || Object.entries(input.olculerL).some(([k,v])=> !/^[a-z][a-z0-9_]*$/.test(k) || !Number.isFinite(v) || v<=0))) fail('olculerL pozitif cm değerleri içeren bir nesne olmalı');
  return tx(db, () => {
    get(db, id);
    db.prepare('UPDATE document_flats SET refLengthPx=?,refLengthCm=?,refAciklama=? WHERE id=?')
      .run(input.refLengthPx, input.refLengthCm, input.refAciklama.trim(), id);
    if (Object.hasOwn(input,'refBeden')) db.prepare('UPDATE document_flats SET refBeden=? WHERE id=?').run(input.refBeden?.trim()??null,id);
    if (Object.hasOwn(input,'olculerL')) db.prepare('UPDATE document_flats SET olculerL=? WHERE id=?').run(JSON.stringify(input.olculerL),id);
    audit(db, user.id, 'duz_cizim_referans', id, input);
    return get(db, id);
  });
}
module.exports = { init, get, list, upload, saveReference, selection, lineSelection };
