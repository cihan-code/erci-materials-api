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
    refLengthPx REAL, refLengthCm REAL, refAciklama TEXT, refBeden TEXT
  )`);
  // Older databases predate the reference size column; missing values stay null.
  if (!db.prepare('PRAGMA table_info(document_flats)').all().some(c => c.name === 'refBeden'))
    db.exec('ALTER TABLE document_flats ADD COLUMN refBeden TEXT');
}
function get(db, id) {
  const row = db.prepare('SELECT * FROM document_flats WHERE id=?').get(id);
  if (!row) fail('Düz çizim bulunamadı', 404);
  return row;
}
function list(db) { return db.prepare('SELECT * FROM document_flats ORDER BY ad,id').all(); }
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
  return tx(db, () => {
    get(db, id);
    db.prepare('UPDATE document_flats SET refLengthPx=?,refLengthCm=?,refAciklama=? WHERE id=?')
      .run(input.refLengthPx, input.refLengthCm, input.refAciklama.trim(), id);
    if (Object.hasOwn(input,'refBeden')) db.prepare('UPDATE document_flats SET refBeden=? WHERE id=?').run(input.refBeden?.trim()??null,id);
    audit(db, user.id, 'duz_cizim_referans', id, input);
    return get(db, id);
  });
}
module.exports = { init, get, list, upload, saveReference };
