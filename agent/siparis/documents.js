'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { tx, audit, fail, integer } = require('./db');
const { assertUser } = require('./auth');
const orders = require('./orders');
const flats = require('./flats');
const { measureApplication, designBoxFromPng, imageSize } = require('./measure');
const { viewForPosition } = require('./autoMeasure');
const { reasonTexts } = require('./vectorReasons');
const childProcess = require('node:child_process');
const { buildWorkshopMessage, createWorkshopHandler } = require('./workshop');
const { registerHandler } = require('./outbox');
const UPLOAD_KINDS = ['urun_gorsel','desen_kaynak','desen_kaynak_vektor'];
const POSITIONS = ['gogus','sol_gogus','sag_gogus','kol','sol_kol','sag_kol','sirt','ense','kapusan','kapuson','bacak','sol_bacak','sag_bacak'];
const SOURCE_KINDS = ['desen_kaynak','desen_kaynak_vektor'];
const PREPARE_TIMEOUT_MS = 8*60e3;
// One automatic measurement in the worker. Measured 20.11.2026: a four-page
// PDF takes ~3 CPU-s on a laptop core and ~14 s on an efficiency core; the
// 0.5 CPU starter plan is slower still, so 15 s timed out on live sheets.
const MEASURE_TIMEOUT_MS = 60e3;
const PREPARE_LOCK_MS = 10*60e3;
const GENERATED = ['uretim_formu','onay_formu','baski_formu','nakis_formu','desen_vektor'];
const WORKSHOP = ['baski_formu','nakis_formu','desen_vektor'];
// Derived from an uploaded source right after upload; never an input of the forms and never sent to the workshop.
const PREVIEW = 'desen_vektor_onizleme';
const ARTWORK_EXTRACTION_REVISION = 3;
// Product image views; a complete sleeve view can supply its own L length scale.
const VIEWS = ['on','arka','kol'];
const pending = new Set();
// Source files whose preview job is queued or running in this process (per database); a 'hazirlaniyor'
// row outside this set was lost with a restart and is queued again on the next status read.
const previewingByDb = new WeakMap();
const previewing = db => { let ids=previewingByDb.get(db); if (!ids) previewingByDb.set(db,ids=new Set()); return ids; };
const roots = new WeakMap();
const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

function init(db) {
  // The core owns schema migrations and queue transitions. Retire the old
  // document-layer shims on existing databases as well as fresh installs.
  db.exec(`DROP TRIGGER IF EXISTS document_workshop_allowlist;
    DROP TRIGGER IF EXISTS document_workshop_key;
    DROP TRIGGER IF EXISTS document_workshop_manual;
    DROP TABLE IF EXISTS document_workshop_results;`);
  db.exec(fileMetaTable('document_file_meta',true));
  // SQLite cannot widen a CHECK in place: rebuild once so a sleeve ('kol') image can be stored.
  if (!db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='document_file_meta'").get().sql.includes("'kol'")) tx(db,()=> {
    db.exec(`${fileMetaTable('document_file_meta_kol')};
      INSERT INTO document_file_meta_kol(file_id,line_id,application_id,gorunum,mime) SELECT file_id,line_id,application_id,gorunum,mime FROM document_file_meta;
      DROP TABLE document_file_meta;
      ALTER TABLE document_file_meta_kol RENAME TO document_file_meta;`);
  });
  db.exec(`CREATE TABLE IF NOT EXISTS document_application_sources (
    application_id INTEGER PRIMARY KEY REFERENCES applications(id),
    file_id INTEGER NOT NULL REFERENCES files(id)
  );
  CREATE TABLE IF NOT EXISTS document_vector_previews (
    source_file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
    preview_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
    status TEXT NOT NULL CHECK(status IN ('hazirlaniyor','hazir','teyit','hata')),
    report_json TEXT, message TEXT, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS document_extracted_previews (
    application_id INTEGER PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,
    source_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    preview_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
    input_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('hazir','teyit','hata')),
    report_json TEXT, message TEXT, artwork BLOB
  );
  CREATE TABLE IF NOT EXISTS document_preparations (
    version_id INTEGER PRIMARY KEY REFERENCES order_versions(id),
    token TEXT, started_at INTEGER, ready INTEGER NOT NULL DEFAULT 0, source_json TEXT
  );
  `);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS document_file_path ON files(version_id,path)');
  flats.init(db);
}
function fileMetaTable(name,ifMissing=false) {
  return `CREATE TABLE ${ifMissing?'IF NOT EXISTS ':''}${name} (
    file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
    line_id INTEGER REFERENCES order_lines(id), application_id INTEGER REFERENCES applications(id),
    gorunum TEXT CHECK(gorunum IN (${VIEWS.map(v=>`'${v}'`).join(',')})), mime TEXT NOT NULL
  )`;
}
function safeSegment(value) {
  if (typeof value === 'string' && value.includes('~')) fail('Dosya yolunda geçersiz sipariş numarası',400);
  if (typeof value === 'string') value = value.replaceAll('/', '~2F');
  if (typeof value !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{N} _~.-]{0,359}$/u.test(value) || value.includes('..'))
    fail('Dosya yolunda geçersiz sipariş numarası', 400);
  return value;
}
function directory(dataDir, ...segments) {
  fs.mkdirSync(dataDir, {recursive:true});
  let current = fs.realpathSync(dataDir);
  for (const segment of ['siparis','files',...segments]) {
    current = path.join(current, segment);
    try { fs.mkdirSync(current); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (fs.lstatSync(current).isSymbolicLink() || !fs.statSync(current).isDirectory()) fail('Güvensiz dosya dizini', 403);
  }
  return current;
}
function filePath(dataDir, file) {
  const root = directory(dataDir);
  const resolved = path.resolve(file.path);
  if (!resolved.startsWith(root + path.sep)) fail('Dosya izin verilen dizinde değil', 403);
  const relative = path.relative(root, resolved);
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) fail('Sembolik bağlantı reddedildi', 403);
  }
  if (!fs.statSync(current).isFile()) fail('Dosya bulunamadı', 404);
  return current;
}
function readFile(dataDir, file) {
  let buffer;
  try { buffer = fs.readFileSync(filePath(dataDir, file)); }
  catch (e) { if (e.code === 'ENOENT') fail('Dosya bulunamadı',404); throw e; }
  if (sha256(buffer) !== file.sha256) fail('Dosyanın SHA256 özeti değişmiş',409);
  return buffer;
}
function validateUpload(file) {
  if (!file?.buffer?.length) fail('file alanında dosya gerekli');
  if (file.buffer.length>25*1024*1024) fail('Dosya en çok 25 MB olabilir',413);
  const name = file.originalname;
  if (!name || name.includes('..') || /[\\/\x00]/.test(name)) fail('Geçersiz dosya adı');
  const ext = path.extname(name).toLowerCase();
  const mime = {'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.pdf':'application/pdf','.svg':'image/svg+xml'}[ext];
  if (!mime || file.mimetype !== mime) fail('Yalnız PNG/JPG/PDF/SVG kabul edilir',415);
  const b = file.buffer;
  if (mime === 'image/png' || mime === 'image/jpeg') {
    try { imageSize(b,mime); } catch (e) { fail(e.message,e.status || 400); }
  } else if (mime === 'application/pdf' && b.subarray(0,5).toString() !== '%PDF-') fail('Geçersiz PDF');
  else if (mime === 'image/svg+xml') {
    const s=b.toString('utf8');
    if (!/<svg[\s>]/i.test(s) || /<!DOCTYPE|<!ENTITY|<script|<foreignObject|\bon\w+\s*=|(?:href|url)\s*[=(]\s*['"]?\s*(?!#)[^\s'"\)]/i.test(s))
      fail('SVG etkin içerik veya dış kaynak içeremez');
  }
  return { buffer:b, mime, ext:ext === '.jpeg' ? 'jpg' : ext.slice(1) };
}
function draft(db, versionId) {
  const v = orders.snapshot(db, integer(versionId,'versionId',1));
  if (v.status !== 'taslak') fail('Yalnız taslak sürüm hazırlanabilir veya düzenlenebilir',409);
  return v;
}
function unlocked(db, versionId) {
  if (db.prepare('SELECT token FROM document_preparations WHERE version_id=?').get(versionId)?.token)
    fail('Sürüm hazırlanıyor; işlem bitince tekrar deneyin',409);
}
function saveFile(db, dataDir, v, kind, content, user, meta = {}, written = []) {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(v.order_id);
  const dir = directory(dataDir, safeSegment(order.order_no), `v${v.version_no}`);
  const ext = meta.ext || 'pdf';
  let n=1, filename;
  for (;;) {
    filename = path.join(dir, `${kind}-${n++}.${ext}`);
    try { fs.writeFileSync(filename, content, {flag:'wx'}); break; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  written.push(filename);
  const file = orders.addFile(db,v.id,{kind,path:filename,sha256:sha256(content)},user);
  db.prepare('INSERT INTO document_file_meta(file_id,line_id,application_id,gorunum,mime) VALUES(?,?,?,?,?)')
    .run(file.id,meta.lineId ?? null,meta.applicationId ?? null,meta.gorunum ?? null,meta.mime || 'application/pdf');
  return file;
}
async function upload(db, dataDir, versionId, input, file, user) {
  assertUser(db,user.id);
  if (!UPLOAD_KINDS.includes(input.kind)) fail('Geçersiz kaynak dosya türü');
  if (input.kind === 'desen_kaynak_vektor' && !['pdf','svg'].includes(file.ext)) fail('Hazır vektör PDF veya SVG olmalı');
  const written=[];
  let saved;
  try { saved=tx(db, () => {
    const v=draft(db,versionId); unlocked(db,versionId);
    const lineId=input.lineId == null ? null : integer(Number(input.lineId),'lineId',1);
    if (lineId && !v.lines.some(l=>l.id===lineId)) fail('Satır bu sürüme ait değil');
    if (input.gorunum != null && !VIEWS.includes(input.gorunum)) fail('gorunum on/arka/kol olmalı');
    if (input.kind==='urun_gorsel' && (!lineId || !input.gorunum)) fail('Ürün görseli için lineId ve gorunum gerekli');
    const applicationId=input.applicationId==null?null:integer(Number(input.applicationId),'applicationId',1);
    const app=applicationId==null?null:v.lines.flatMap(l=>l.applications).find(a=>a.id===applicationId);
    if(applicationId!=null && (!app || (lineId && app.line_id!==lineId))) fail('Uygulama bu satır/sürüme ait değil');
    const saved=saveFile(db,dataDir,v,input.kind,file.buffer,user,{...file,lineId:lineId??app?.line_id,applicationId,gorunum:input.gorunum},written);
    if(app && SOURCE_KINDS.includes(input.kind)) db.prepare('INSERT INTO document_application_sources(application_id,file_id) VALUES(?,?) ON CONFLICT(application_id) DO UPDATE SET file_id=excluded.file_id').run(app.id,saved.id);
    // The vector record is committed with the file: a slow measurement or a restart can never leave it unknown.
    if (SOURCE_KINDS.includes(input.kind)) db.prepare("INSERT INTO document_vector_previews(source_file_id,status,updated_at) VALUES(?,'hazirlaniyor',?)").run(saved.id,Date.now());
    return saved;
  }); } catch (e) { for (const f of written) fs.unlinkSync(f); throw e; }
  if (SOURCE_KINDS.includes(saved.kind)) previewing(db).add(saved.id);
  const olcuHatasi=await measureAfterSave(db,dataDir,versionId,user,true);
  queuePreview(db,dataDir,saved,user);
  return olcuHatasi ? {...saved,olcuHatasi} : saved;
}
function measure(db, dataDir, input, user, applicationId = null) {
  const result=measureNow(db,dataDir,input,user,applicationId);
  const versionId=result?.application && db.prepare('SELECT version_id FROM order_lines WHERE id=?').get(result.application.line_id)?.version_id;
  if (versionId) requalifyVersion(db,dataDir,versionId,user);
  return result;
}
function measureNow(db, dataDir, input, user, applicationId = null) {
  assertUser(db,user.id);
  if (!input || typeof input!=='object' || Array.isArray(input)) fail('Ölçü gövdesi nesne olmalı');
  if (!POSITIONS.includes(input.position)) fail('Geçersiz uygulama konumu');
  const lineId=integer(Number(input.lineId),'lineId',1);
  const line=db.prepare('SELECT * FROM order_lines WHERE id=?').get(lineId);
  if (!line) fail('Sipariş satırı bulunamadı',404);
  let reference = {refLengthPx:input.refLengthPx,refLengthCm:input.refLengthCm};
  if (input.flatId) {
    const flat=flats.get(db,input.flatId);
    reference = {refLengthPx:flat.refLengthPx,refLengthCm:flat.refLengthCm,refAciklama:flat.refAciklama,flatId:flat.id};
  }
  if (![reference.refLengthPx,reference.refLengthCm].every(n=>Number.isFinite(n) && n>0)) fail('Pozitif referans px ve cm gerekli');
  let source, box=input.designBoxPx;
  const automaticBox = !box && input.desenDosyaId != null;
  if (input.desenDosyaId != null) {
    source=db.prepare("SELECT * FROM files WHERE id=? AND version_id=? AND kind IN ('desen_kaynak','desen_kaynak_vektor')").get(integer(Number(input.desenDosyaId),'desenDosyaId',1),line.version_id);
    if (!source) fail('Desen dosyası bu sürüme ait değil');
    const meta=db.prepare('SELECT * FROM document_file_meta WHERE file_id=?').get(source.id);
    if (meta?.line_id && meta.line_id!==lineId) fail('Desen dosyası başka satıra ait');
    if (!box) {
      if (path.extname(source.path).toLowerCase()!=='.png') fail('Otomatik kutu için PNG gerekli; diğer türlerde designBoxPx verin');
      try { box=designBoxFromPng(readFile(dataDir,source)); } catch (e) { if (e.status) throw e; fail('PNG kutusu okunamadı'); }
    }
  }
  let result;
  try { result=measureApplication({...reference,designBoxPx:box,imageKind:input.imageKind,flags:input.flags}); }
  catch (e) { fail(e.message); }
  if (automaticBox) {
    result.needsConfirmation=true;
    result.reasons.push('Desen dosyasının piksel kutusu düz çizim referansıyla aynı görselden değil; ölçü teyidi gerekli');
    result.reason=result.reasons.join(' ');
  }
  return tx(db, () => {
    draft(db,line.version_id); unlocked(db,line.version_id);
    const values={kind:input.kind,position:input.position,width_mm:result.width_mm,height_mm:result.height_mm,
      needs_confirmation:result.needsConfirmation,
      measure_source:JSON.stringify({...reference,method:'elle',designBoxPx:box,imageKind:input.imageKind,flags:input.flags || {},desenDosyaId:source?.id,automaticBox,reasons:result.reasons})};
    let application;
    if (applicationId == null) application=orders.addApplication(db,lineId,values,user);
    else {
      if (!['baski','nakis'].includes(values.kind)) fail('Geçersiz uygulama türü');
      const old=db.prepare('SELECT * FROM applications WHERE id=? AND line_id=?').get(applicationId,lineId);
      if (!old) fail('Uygulama bulunamadı',404);
      db.prepare('UPDATE applications SET kind=?,position=?,width_mm=?,height_mm=?,needs_confirmation=?,measure_source=? WHERE id=?')
        .run(values.kind,values.position,values.width_mm,values.height_mm,values.needs_confirmation?1:0,values.measure_source,applicationId);
      db.prepare("UPDATE confirmations SET status='cozuldu',resolved_by=? WHERE ref_table='applications' AND ref_id=? AND kind='olcu' AND status='acik'").run(user.id,applicationId);
      if (result.needsConfirmation) db.prepare("INSERT INTO confirmations(kind,ref_table,ref_id,message) VALUES('olcu','applications',?,?)").run(applicationId,result.reason);
      application=db.prepare('SELECT * FROM applications WHERE id=?').get(applicationId);
      audit(db,user.id,'uygulama_yeniden_olc',applicationId);
    }
    db.prepare('DELETE FROM document_application_sources WHERE application_id=?').run(application.id);
    if (source) db.prepare('INSERT INTO document_application_sources(application_id,file_id) VALUES(?,?)').run(application.id,source.id);
    const confirmationId=db.prepare("SELECT id FROM confirmations WHERE kind='olcu' AND ref_table='applications' AND ref_id=? AND status='acik' ORDER BY id DESC LIMIT 1").get(application.id)?.id ?? null;
    if (confirmationId) db.prepare('UPDATE confirmations SET message=? WHERE id=?').run(result.reason,confirmationId);
    return {...result,application,confirmationId};
  });
}
async function editApplication(db,dataDir,applicationId,changes,user) {
  assertUser(db,user.id);
  const result=tx(db,()=> {
    const app=db.prepare('SELECT a.*,l.version_id FROM applications a JOIN order_lines l ON l.id=a.line_id WHERE a.id=?').get(applicationId);
    if (!app) fail('Uygulama bulunamadı',404);
    draft(db,app.version_id); unlocked(db,app.version_id);
    if (!changes || typeof changes!=='object' || Array.isArray(changes)) fail('Uygulama gövdesi nesne olmalı');
    if (Object.hasOwn(changes,'lineId') && Number(changes.lineId)!==app.line_id) fail('Uygulama satırı değiştirilemez');
    let previous={};
    if (app.measure_source) {
      try { previous=JSON.parse(app.measure_source); } catch { previous=null; }
      if (!previous || typeof previous!=='object' || Array.isArray(previous)) previous={description:app.measure_source};
    }
    const measurementKeys=['flatId','refLengthPx','refLengthCm','designBoxPx','imageKind','flags'];
    if (measurementKeys.some(key=>Object.hasOwn(changes,key))) {
      const input={...previous,...changes,lineId:app.line_id,kind:changes.kind ?? app.kind,position:changes.position ?? app.position};
      // An automatic design-file box never becomes a placement box merely by editing another field.
      if (previous.automaticBox && !Object.hasOwn(changes,'designBoxPx')) input.designBoxPx=null;
      return measure(db,dataDir,input,user,app.id);
    }
    if (changes.kind!=null && !['baski','nakis'].includes(changes.kind)) fail('Geçersiz uygulama türü');
    if (changes.position!=null && !POSITIONS.includes(changes.position)) fail('Geçersiz uygulama konumu');
    const changedDimensions=['width_mm','height_mm'].some(k=>Object.hasOwn(changes,k));
    for (const k of ['width_mm','height_mm']) if (Object.hasOwn(changes,k) && (!Number.isSafeInteger(changes[k]) || changes[k]<=0)) fail('Geçersiz ölçü');
    if (Object.hasOwn(changes,'elleTeyit')) {
      // The person enters and vouches for this size in the manual editor, so its confirmation closes with the save.
      if (changes.elleTeyit!==true) fail('elleTeyit yalnız true olabilir');
      if (!['width_mm','height_mm'].every(k=>Object.hasOwn(changes,k))) fail('Elle teyit için en ve boy (mm) gerekli');
      if (Object.keys(changes).some(k=>!['width_mm','height_mm','elleTeyit','lineId'].includes(k))) fail('Elle teyitle yalnız en ve boy kaydedilir');
      const {reasons,...kept}=previous;
      db.prepare('UPDATE applications SET width_mm=?,height_mm=?,measure_source=?,needs_confirmation=0 WHERE id=?')
        .run(changes.width_mm,changes.height_mm,JSON.stringify({...kept,method:'elle',elleTeyit:true}),app.id);
      db.prepare("UPDATE confirmations SET status='cozuldu',resolved_by=? WHERE kind='olcu' AND ref_table='applications' AND ref_id=? AND status='acik'").run(user.id,app.id);
      audit(db,user.id,'uygulama_elle_olcu',app.id,{width_mm:changes.width_mm,height_mm:changes.height_mm,onceki:{width_mm:app.width_mm,height_mm:app.height_mm}});
      return {application:db.prepare('SELECT * FROM applications WHERE id=?').get(app.id)};
    }
    if (changes.desenDosyaId!=null) {
      const v=orders.snapshot(db,app.version_id), source=v.files.find(f=>f.id===Number(changes.desenDosyaId) && SOURCE_KINDS.includes(f.kind));
      const meta=source && db.prepare('SELECT line_id FROM document_file_meta WHERE file_id=?').get(source.id);
      if (!source || (meta?.line_id && meta.line_id!==app.line_id)) fail('Desen dosyası bu satır/sürüme ait değil');
      db.prepare('INSERT INTO document_application_sources(application_id,file_id) VALUES(?,?) ON CONFLICT(application_id) DO UPDATE SET file_id=excluded.file_id').run(app.id,source.id);
      previous.desenDosyaId=source.id;
    }
    const uncertain=changedDimensions || !app.measure_source;
    db.prepare('UPDATE applications SET kind=?,position=?,width_mm=?,height_mm=?,measure_source=?,needs_confirmation=? WHERE id=?')
      .run(changes.kind ?? app.kind,changes.position ?? app.position,changes.width_mm ?? app.width_mm,changes.height_mm ?? app.height_mm,
        JSON.stringify(changedDimensions?{...previous,method:'elle'}:previous),uncertain ? 1 : app.needs_confirmation,app.id);
    if (uncertain && !db.prepare("SELECT id FROM confirmations WHERE kind='olcu' AND ref_table='applications' AND ref_id=? AND status='acik'").get(app.id))
      db.prepare("INSERT INTO confirmations(kind,ref_table,ref_id,message) VALUES('olcu','applications',?,'Elle değiştirilen ölçü teyit edilmeli')").run(app.id);
    audit(db,user.id,'uygulama_duzenle',app.id);
    return {application:db.prepare('SELECT * FROM applications WHERE id=?').get(app.id)};
  });
  const line=db.prepare('SELECT version_id FROM order_lines WHERE id=?').get(result.application.line_id);
  const olcuHatasi=await measureAfterSave(db,dataDir,line.version_id,user,true);
  result.application=db.prepare('SELECT * FROM applications WHERE id=?').get(applicationId);
  if (olcuHatasi) result.olcuHatasi=olcuHatasi;
  return result;
}
function deleteApplication(db,applicationId,user) {
  assertUser(db,user.id);
  return tx(db,()=> {
    const app=db.prepare('SELECT a.*,l.version_id FROM applications a JOIN order_lines l ON l.id=a.line_id WHERE a.id=?').get(applicationId);
    if (!app) fail('Uygulama bulunamadı',404);
    draft(db,app.version_id);unlocked(db,app.version_id);
    db.prepare('DELETE FROM document_application_sources WHERE application_id=?').run(app.id);
    retireExtractedPreview(db,app.id,user);
    db.prepare('UPDATE document_file_meta SET application_id=NULL WHERE application_id=?').run(app.id);
    db.prepare("UPDATE confirmations SET status='cozuldu',resolved_by=? WHERE kind='olcu' AND ref_table='applications' AND ref_id=? AND status='acik'").run(user.id,app.id);
    db.prepare('DELETE FROM applications WHERE id=?').run(app.id);
    audit(db,user.id,'uygulama_sil',app.id);
    return {ok:true};
  });
}
function assertVectorQuality(db,v) {
  if (db.prepare("SELECT c.id FROM confirmations c JOIN files f ON c.ref_table='files' AND c.ref_id=f.id WHERE f.version_id=? AND c.kind='vektor_kalite' AND c.status='acik'").get(v.id))
    fail('Açık vektör kalite teyidi var; çözün veya hazır vektör yükleyip yeniden hazırlayın',409);
}
function documentDate(date=new Date()) { return date.toLocaleDateString('tr-TR',{timeZone:'Europe/Istanbul'}); }
function openMeasurements(db, versionId) {
  return db.prepare(`SELECT c.* FROM confirmations c WHERE c.kind='olcu' AND c.status='acik' AND (
    (c.ref_table='order_versions' AND c.ref_id=?) OR
    (c.ref_table='order_lines' AND c.ref_id IN (SELECT id FROM order_lines WHERE version_id=?)) OR
    (c.ref_table='applications' AND c.ref_id IN (SELECT a.id FROM applications a JOIN order_lines l ON l.id=a.line_id WHERE l.version_id=?)))`)
    .all(versionId,versionId,versionId);
}
function assertMeasurements(db, v) {
  const pending=openMeasurements(db,v.id);
  if (pending.length) fail(`Açık ölçü teyidi: ${pending.map(c=>c.message).join(' ')}`,409);
  for (const a of v.lines.flatMap(l=>l.applications)) {
    if (![a.width_mm,a.height_mm].every(n=>Number.isSafeInteger(n) && n>0)) fail(`Uygulama ${a.id}: geçerli ölçü gerekli`,409);
    if (a.needs_confirmation && !db.prepare("SELECT id FROM confirmations WHERE kind='olcu' AND ref_table='applications' AND ref_id=? AND status='cozuldu'").get(a.id))
      fail(`Uygulama ${a.id}: ölçü teyidi gerekli`,409);
  }
}
// Applications whose measurement is not usable yet: an open confirmation (on the application, its line or the version),
// no valid millimetres, or a flagged measurement nobody resolved. Forms still print them, marked as pending.
function pendingApplications(db,v) {
  const open=openMeasurements(db,v.id),pending=new Map();
  for (const line of v.lines) for (const a of line.applications) {
    const own=open.find(c=>(c.ref_table==='applications'&&c.ref_id===a.id)||(c.ref_table==='order_lines'&&c.ref_id===line.id)||c.ref_table==='order_versions');
    if (own) pending.set(a.id,own.message);
    else if (![a.width_mm,a.height_mm].every(n=>Number.isSafeInteger(n) && n>0)) pending.set(a.id,'Geçerli ölçü yok');
    else if (a.needs_confirmation && !db.prepare("SELECT id FROM confirmations WHERE kind='olcu' AND ref_table='applications' AND ref_id=? AND status='cozuldu'").get(a.id)) pending.set(a.id,'Ölçü teyidi gerekli');
  }
  return pending;
}
function inputFingerprint(db,v) {
  const pending=[...pendingApplications(db,v).keys()];
  return JSON.stringify({...(pending.length?{pending}:{}),order:db.prepare('SELECT * FROM orders WHERE id=?').get(v.order_id),
    lines:v.lines.map(({recipe_version,...line})=>line),files:v.files.filter(f=>!GENERATED.includes(f.kind) && f.kind!==PREVIEW),
    sources:db.prepare(`SELECT s.application_id,s.file_id FROM document_application_sources s
      JOIN applications a ON a.id=s.application_id JOIN order_lines l ON l.id=a.line_id
      WHERE l.version_id=? ORDER BY s.application_id`).all(v.id)});
}
// A preview finishing in the background must not look like a draft change.
function stableSnapshot(v) { return JSON.stringify({...v,files:v.files.filter(f=>f.kind!==PREVIEW)}); }
function assertFresh(db,v) {
  const state=db.prepare('SELECT * FROM document_preparations WHERE version_id=?').get(v.id);
  if (state?.ready && state.source_json!==inputFingerprint(db,v))
    fail('Sürüm değişmiş; belgeleri hazirla?yeniden=1 ile yeniden üretin',409);
}
function artworkFor(db,v,line,app) {
  const linked=db.prepare('SELECT file_id FROM document_application_sources WHERE application_id=?').get(app.id)?.file_id;
  const recorded=Number(provenance(app).desenDosyaId);
  const lineSources=v.files.filter(f=>SOURCE_KINDS.includes(f.kind) && (!f.line_id||f.line_id===line.id));
  const explicit=linked ?? (lineSources.some(f=>f.id===recorded) ? recorded : null);
  const candidates=lineSources.filter(f=> {
    const owner=db.prepare('SELECT application_id FROM document_file_meta WHERE file_id=?').get(f.id)?.application_id;
    return !owner||owner===app.id;
  });
  const source=explicit ? lineSources.find(f=>f.id===explicit) : candidates.length===1 ? candidates[0] : null;
  if(source)return {source};
  const selected=productImageFor(v,line,app),image=selected.image;
  const gap=explicit||candidates.length>1 ? 'Bu uygulama için desenDosyaId ile tek bir geçerli kaynak bağlayın.' : selected.gap;
  // The line colour picks one garment on a sheet of colour variants.
  const key=JSON.stringify([ARTWORK_EXTRACTION_REVISION,line.product_key,line.color_name??null,app.position,app.kind,image?.id,image?.sha256,image?.gorunum,gap]);
  return {image,key,gap};
}
function formPlacement(app,source,image,design) {
  const locatedMeasurement=['otomatik','otomatik_renk'].includes(source.method) || (source.method==='elle' && source.elleTeyit===true);
  if (!image || !locatedMeasurement ||
      source.gorselFileId!==image.fileId || source.selectedView!==image.view ||
      (source.desenFileId??null)!==(design?.id??null)) return undefined;
  const {selectedPage:page,rasterWidth,rasterHeight,designBoxPx:box,productBoxPx:product}=source;
  if (![page,rasterWidth,rasterHeight].every(n=>Number.isSafeInteger(n) && n>0) ||
      !box || !product || ![box.x,box.y,box.w,box.h,product.x,product.y,product.w,product.h].every(Number.isFinite) ||
      box.x<product.x || box.y<product.y || box.x+box.w>product.x+product.w || box.y+box.h>product.y+product.h) return undefined;
  let swapAxes=false;
  if (source.sleeveMethod) {
    const axis=source.measuredAxisVector;
    if (!SLEEVES.includes(app.position) || source.bodyCount!==1 || !(source.confidence>=.78) ||
        !['en','boy'].includes(source.measuredAxis) || !axis || ![axis.x,axis.y].every(Number.isFinite)) return undefined;
    // The recorded ink bounds only describe horizontal and vertical axes.
    const horizontal=Math.abs(axis.x)>.99,vertical=Math.abs(axis.y)>.99;
    if (!horizontal && !vertical) return undefined;
    swapAxes=horizontal !== (source.measuredAxis==='en');
  } else {
    if (viewForPosition(app.position)!==image.view || SLEEVES.includes(app.position) || !(source.matchConfidence>=.78) || !Array.isArray(source.views)) return undefined;
    const views=source.views.filter(view=>view?.page===page);
    const selected=views.find(view=>view.index===source.selectedProductIndex);
    if (!selected || (selected.view!==image.view && (views.length!==1 || selected.view!=='teyit'))) return undefined;
  }
  return {fileId:image.fileId,view:image.view,page,rasterWidth,rasterHeight,box,swapAxes};
}

function retireExtractedPreview(db,appId,user) {
  const old=db.prepare('SELECT preview_file_id FROM document_extracted_previews WHERE application_id=?').get(appId);
  if(!old)return;
  db.prepare('DELETE FROM document_extracted_previews WHERE application_id=?').run(appId);
  if(!old.preview_file_id)return;
  db.prepare("UPDATE confirmations SET status='cozuldu',resolved_by=? WHERE kind='vektor_kalite' AND ref_table='files' AND ref_id=? AND status='acik'").run(user.id,old.preview_file_id);
  db.prepare('DELETE FROM files WHERE id=? AND kind=?').run(old.preview_file_id,PREVIEW);
}

function extractedRecord(db,appId,{key},includeArtwork=false) {
  return db.prepare(`SELECT preview_file_id,status,report_json,message${includeArtwork?',artwork':''} FROM document_extracted_previews
    WHERE application_id=? AND input_json=? AND (artwork IS NULL OR preview_file_id IS NOT NULL)`).get(appId,key);
}

async function extractPreview(db,dataDir,v,line,app,input,user,signal,retryError=false) {
  if(input.gap)return {message:input.gap};
  const previous=extractedRecord(db,app.id,input,true);
  // Verify the original bytes even if a valid-looking cached crop exists.
  let artwork,result,message,status;
  try {
    const original={...input.image,...await vectorInput(dataDir,input.image)};
    if(previous&&(!retryError||previous.status!=='hata'))return previous;
    // A small print is read a second time at a higher resolution; on a slow
    // single CPU a ten-page sheet then needs more than the former 15 s.
    artwork=await generateInChild({type:'extractArtwork',input:{image:original,position:app.position,product:line.product_key,color:line.color_name}},signal,{timeoutMs:30000});
    if(artwork.reason) {message=artwork.reason;status='teyit';}
    else {
      result=await generateInChild({type:'vector',designBox:true,input:{buffer:artwork.buffer,mime:'image/png'}},signal);
      // A separation warning (small print) needs the same visual check as a vector warning.
      if(artwork.warnings?.length)result.report={...result.report,quality:'teyit',reasons:[...(result.report.reasons||[]),...artwork.warnings]};
      // Information only (line colour not seen on the garment): no confirmation.
      if(artwork.notes?.length)result.report={...result.report,notes:artwork.notes};
      status=result.report.quality==='teyit'?'teyit':'hazir';
    }
  } catch(e) {
    if(signal.aborted)throw e;
    message=`Üründen desen önizlemesi tamamlanamadı: ${e.message}`;
    status='hata';
  }
  signal.throwIfAborted();
  const written=[];
  try { return tx(db,()=> {
    const current=draft(db,v.id),currentLine=current.lines.find(l=>l.id===line.id),currentApp=currentLine?.applications.find(a=>a.id===app.id);
    if(!currentApp||artworkFor(db,current,currentLine,currentApp).key!==input.key)return {message:'Ürün görseli veya uygulama değişti; yeniden deneyin.'};
    const existing=extractedRecord(db,app.id,input,true);
    if(existing&&(!previous||existing.preview_file_id!==previous.preview_file_id))return existing;
    const file=result && saveFile(db,dataDir,current,PREVIEW,result.pdf,user,{lineId:line.id,applicationId:app.id},written);
    retireExtractedPreview(db,app.id,user);
    const report=result && {...result.report,placement:artwork.placement};
    if(file&&status==='teyit')db.prepare("INSERT INTO confirmations(kind,ref_table,ref_id,message) VALUES('vektor_kalite','files',?,?)")
      .run(file.id,`Vektör kalitesi görsel teyit gerektiriyor: ${JSON.stringify(report)}`);
    db.prepare(`INSERT INTO document_extracted_previews(application_id,source_file_id,preview_file_id,input_json,status,report_json,message,artwork)
      VALUES(?,?,?,?,?,?,?,?)`).run(app.id,input.image.id,file?.id??null,input.key,status,report?JSON.stringify(report):null,message??null,result?artwork.buffer:null);
    return extractedRecord(db,app.id,input,true);
  }); } catch(e) {
    for(const file of written)try {fs.unlinkSync(file);} catch {}
    throw e;
  }
}

function assertExtractedMeasurement(app,image,placement) {
  const source=provenance(app);
  if(!['otomatik','otomatik_renk'].includes(source.method))return;
  const box=source.designBoxPx, current=placement.designBoxPx;
  const aligned=(offset,size,edge,currentOffset,currentSize,currentEdge)=> {
    if(![offset,size,edge,currentOffset,currentSize,currentEdge].every(Number.isFinite)||size<=0||edge<=0)return false;
    const relativeSize=size/edge,expectedSize=currentSize/currentEdge;
    const relativeCenter=(offset+size/2)/edge,expectedCenter=(currentOffset+currentSize/2)/currentEdge;
    return Math.abs(relativeSize/expectedSize-1)<=.12&&Math.abs(relativeCenter-expectedCenter)<=expectedSize*.12;
  };
  if(source.gorselFileId===image.id&&source.selectedPage===placement.page&&box&&
    aligned(box.x,box.w,source.rasterWidth,current.x,current.w,placement.rasterWidth)&&
    aligned(box.y,box.h,source.rasterHeight,current.y,current.h,placement.rasterHeight))return;
  fail(`Uygulama ${app.id}: Ayrıştırılan desen otomatik ölçü kutusuyla eşleşmedi. Önizlemeyi kontrol edip fiziksel ölçüyü girin.`,409);
}

// allowPending prints unmeasured applications as "Ölçü teyit bekliyor"; omitQuantities leaves every quantity field empty.
function formOrder(db,dataDir,v,sourceByApp,extractedByApp=new Map(),{allowPending=false,omitQuantities=false}={}) {
  if (!allowPending) assertMeasurements(db,v);
  const pending=allowPending ? pendingApplications(db,v) : new Map();
  const order=db.prepare('SELECT * FROM orders WHERE id=?').get(v.order_id);
  const preview = file => file && /\.(png|jpe?g)$/i.test(file.path) ? readFile(dataDir,file) : undefined;
  const applications=[];
  return {
    orderNo:order.order_no,name:order.customer_name || 'Müşteri belirtilmedi',version:v.version_no,
    date:documentDate(),deliveryDate:'Teslim tarihi belirtilmedi',description:[],...(omitQuantities?{omitQuantities:true}:{}),
    lines:v.lines.map(l=> {
      const images={},lineId=String(l.id);
      // Match automatic measurement's use of the latest immutable upload for each view.
      for (const [key,view] of [['front','on'],['back','arka']]) {
        const file=v.files.findLast(f=>f.kind==='urun_gorsel' && f.line_id===l.id && f.gorunum===view);
        const mime={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.pdf':'application/pdf'}[path.extname(file?.path||'').toLowerCase()];
        if (mime) images[key]={fileId:file.id,view,mime,buffer:readFile(dataDir,file)};
      }
      for (const app of l.applications) {
        if (pending.has(app.id)) {
          applications.push({type:app.kind,position:app.position,width_mm:0,height_mm:0,lineIds:[lineId],pending:true,reason:pending.get(app.id)});
          continue;
        }
        const design=sourceByApp.get(app.id);
        const source=provenance(app);
        const image=Object.values(images).find(image=>image.fileId===source.gorselFileId);
        applications.push({type:app.kind,position:app.position,width_mm:app.width_mm,height_mm:app.height_mm,lineIds:[lineId],
          preview:preview(design)||extractedByApp.get(app.id),placement:formPlacement(app,source,image,design),
          ...(source.scaleMode==='geo_ortalama'&&source.scaleNote?{scaleNote:String(source.scaleNote)}:{})});
      }
      const sizes=JSON.parse(l.sizes_json);
      if (!omitQuantities && Object.keys(sizes).length && Object.values(sizes).reduce((a,b)=>a+b,0)!==l.quantity) fail(`Satır ${l.id}: PDF için adetlere eşit beden dağılımı gerekli`,409);
      const item=l.fabric_item_id ? db.prepare('SELECT name,color_name,color_no FROM stock_items WHERE id=?').get(l.fabric_item_id) : null;
      return {id:lineId,product:l.product_key,color:l.color_name ? require('./pdf').stockColorLabel(l.color_name,item) : 'Renk belirtilmedi',fabric:item ? item.name : 'Kumaş belirtilmedi',sizes,quantity:l.quantity,images,...(l.numune?{numune:true}:{}),...(l.note?{note:l.note}:{})};
    }),
    applications,
  };
}
// The worker calibrates the scale on the pattern's own flat drawing (G45b).
// One result per drawing file and L values is kept for this process; a
// missing or unreadable drawing leaves the uncalibrated behaviour.
const FLAT_CALIBRATIONS=new Map();
function flatCalibrationInput(flat,leg) {
  if(!flat?.dosya)return {flat,key:null};
  let stat;
  try {stat=fs.statSync(flat.dosya);} catch {return {flat,key:null};}
  if(!stat.isFile())return {flat,key:null};
  const key=JSON.stringify([flat.id,flat.dosya,stat.size,stat.mtimeMs,flat.urun,flat.olculerL??null,leg]);
  if(FLAT_CALIBRATIONS.has(key))return {flat:{...flat,kalibrasyon:FLAT_CALIBRATIONS.get(key)},key:null};
  const ext=path.extname(flat.dosya).toLowerCase(),mime=ext==='.png'?'image/png':['.jpg','.jpeg'].includes(ext)?'image/jpeg':null;
  if(!mime)return {flat,key:null};
  try {return {flat:{...flat,cizim:{buffer:fs.readFileSync(flat.dosya),mime}},key};} catch {return {flat,key:null};}
}
// The line's fabric colour, when the stock item states one under the same colour name.
// A proof ground in this colour is the garment itself (vector.js findGround).
function garmentColor(db,lineId) {
  const line=lineId==null ? null : db.prepare('SELECT color_name,fabric_item_id FROM order_lines WHERE id=?').get(lineId);
  const item=line?.fabric_item_id ? db.prepare('SELECT color_name,color_hex FROM stock_items WHERE id=?').get(line.fabric_item_id) : null;
  const same=(a,b)=>String(a??'').trim().toLocaleLowerCase('tr')===String(b??'').trim().toLocaleLowerCase('tr');
  return item && /^#[0-9a-f]{6}$/i.test(item.color_hex ?? '') && (!line.color_name || same(line.color_name,item.color_name)) ? item.color_hex : null;
}
async function vectorInput(dataDir,file) {
  return {manualVector:file.kind==='desen_kaynak_vektor',buffer:readFile(dataDir,file),mime:{'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.pdf':'application/pdf','.svg':'image/svg+xml'}[path.extname(file.path).toLowerCase()]};
}
async function normalizeVectorInput({buffer,mime,...rest}) {
  if (mime==='image/svg+xml') {
    // G4 accepts PDF/PNG/JPEG. Convert SVG paths to a vector PDF first.
    const PDFDocument=require('pdfkit');
    const SVGtoPDF=require('svg-to-pdfkit');
    const svg=buffer.toString('utf8');
    const root=/<svg\b[^>]*>/i.exec(svg)?.[0] || '';
    const attr=name=>new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`,'i').exec(root)?.[1];
    const box=(attr('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    const length=value=> {
      const m=/^([\d.+e-]+)(px|pt|mm|cm|in|pc)?$/i.exec(value || '');
      return m ? Number(m[1])*({px:0.75,pt:1,mm:72/25.4,cm:72/2.54,in:72,pc:12}[m[2]?.toLowerCase() || 'px']) : null;
    };
    const width=length(attr('width')) || (box.length===4 ? box[2]*0.75 : 750);
    const height=length(attr('height')) || (box.length===4 ? box[3]*0.75 : 750);
    if (![width,height].every(n=>Number.isFinite(n) && n>0 && n<=100000)) fail('Geçersiz SVG boyutu');
    buffer=await new Promise((resolve,reject)=> {
      const doc=new PDFDocument({size:[width,height],margin:0}); const chunks=[];
      doc.on('data',c=>chunks.push(c)); doc.on('error',reject); doc.on('end',()=>resolve(Buffer.concat(chunks)));
      try { SVGtoPDF(doc,svg,0,0,{width,height,preserveAspectRatio:'xMidYMid meet'}); doc.end(); }
      catch (e) { doc.destroy(); reject(e); }
    });
    mime='application/pdf';
  }
  return {...rest,buffer,mime};
}
// One render pipeline at a time, with a deadline covering queue wait AND all children.
// An aborted task keeps its queue slot until its worker has exited.
function preparationTimeout() {
  return Object.assign(new Error('Hazırlama zaman aşımına uğradı'),{status:504,code:'PREPARE_TIMEOUT'});
}
function createRenderQueue({timeoutMs=PREPARE_TIMEOUT_MS,lockMs=PREPARE_LOCK_MS}={}) {
  if (!(Number.isFinite(timeoutMs) && Number.isFinite(lockMs) && timeoutMs>0 && lockMs>timeoutMs)) throw new Error('Hazırlama kilit süresi toplam zaman aşımından uzun olmalı');
  let tail=Promise.resolve();
  return run=> {
    const controller=new AbortController();
    let timer;
    const deadline=new Promise((resolve,reject)=> {
      timer=setTimeout(()=> {
        const error=preparationTimeout();
        reject(error);controller.abort(error);
      },timeoutMs);
    });
    const work=tail.catch(()=>{}).then(()=> {
      controller.signal.throwIfAborted();return run(controller.signal);
    });
    tail=work.catch(()=>{});
    return Promise.race([work,deadline]).finally(()=>clearTimeout(timer));
  };
}
const renderQueue=createRenderQueue();
function provenance(app) {
  try {return JSON.parse(app.measure_source)||{};} catch {return {};}
}
function manuallyMeasured(app) {
  const source=provenance(app);
  return source.method==='elle' || (!['otomatik','otomatik_renk'].includes(source.method) && (app.width_mm!=null || app.height_mm!=null));
}
const POSITION_LABELS={gogus:'Göğüs',sol_gogus:'Sol göğüs',sag_gogus:'Sağ göğüs',kol:'Kol',sol_kol:'Sol kol',sag_kol:'Sağ kol',sirt:'Sırt',ense:'Ense',kapusan:'Kapüşon',kapuson:'Kapüşon',bacak:'Bacak',sol_bacak:'Sol bacak',sag_bacak:'Sağ bacak'};
const SLEEVES=['kol','sol_kol','sag_kol'];
function productImageFor(v,line,app) {
  const view=viewForPosition(app.position),label=POSITION_LABELS[app.position] || app.position;
  const sleeve=SLEEVES.includes(app.position);
  const images=v.files.filter(f=>f.kind==='urun_gorsel' && f.line_id===line.id && (sleeve ? ['kol','on','arka'].includes(f.gorunum) : view==='teyit' ? ['on','arka'].includes(f.gorunum) : f.gorunum===view));
  // A replacement upload supersedes the previous immutable file in this view.
  const image=sleeve ? images.filter(f=>f.gorunum==='kol').at(-1)||images.filter(f=>f.gorunum==='on').at(-1)||images.at(-1) : images.at(-1);
  if(!image)return {gap:sleeve ? `${label} görünümü için ürün görseli yok: kol, ön veya arka görsel yüklenmedi.`
    : view==='teyit' ? `${label} konumu için ön veya arka ürün görseli yok.` : `${view==='on'?'Ön':'Arka'} görünüm için ürün görseli yok (${label} konumu ${view==='on'?'ön':'arka'} görselde ölçülür).`};
  return {image,view};
}
// Returns the measurement inputs, or {gap} with the concrete reason why the application cannot be measured yet.
function autoInputs(db,v,line,app) {
  const {image,view,gap}=productImageFor(v,line,app);
  const linked=db.prepare('SELECT file_id FROM document_application_sources WHERE application_id=?').get(app.id)?.file_id;
  // Applications registered before G24 kept their design only in the panel's provenance.
  const recorded=linked==null ? Number(provenance(app).desenDosyaId) : null;
  const design=v.files.find(f=>f.id===(linked ?? recorded) && SOURCE_KINDS.includes(f.kind));
  const meta=design && db.prepare('SELECT line_id FROM document_file_meta WHERE file_id=?').get(design.id);
  if(meta?.line_id && meta.line_id!==line.id)return {gap:'Desen dosyası başka bir ürün satırına ait; bu satırın desenini bağlayın.'};
  if(gap)return {gap};
  const library=flats.list(db),{candidates,flat}=flats.selection(db,line,view==='teyit'?image.gorunum:view,library);
  const flatNote=!flat && candidates.length>1 ? 'Bu ürün için birden çok kalıp var; kalıbı seçin' : !candidates.length || flat ? flats.missingLNote(db,line,flat,library) : null;
  // The line colour only adds an information note to the measurement.
  return {image,design,flat,product:line.product_key,position:app.position,...(line.color_name?{color:line.color_name}:{}),...(flatNote?{flatNote}:{}),...(design && linked==null?{linkDesign:true}:{})};
}
function autoFingerprint({desenDosyaId,...app},input) {return JSON.stringify({app,input});}
// autoMeasure states these two when no single L pattern was passed; a known ambiguity replaces them.
const NO_FLAT_REASONS=['Ürünün L kalıp referansı bulunamadı','Ürün için geçerli L beden kalıp ölçüleri bulunamadı'];
function explain(result,input) {
  let reasons=Array.isArray(result.reasons) ? result.reasons : result.reason ? [result.reason] : [];
  if(input.flatNote)reasons=[input.flatNote,...reasons.filter(r=>!NO_FLAT_REASONS.some(prefix=>String(r).startsWith(prefix)))];
  if(SLEEVES.includes(input.position) && reasons.length && result.width_mm==null)reasons=[`Kol konumu ${input.image.gorunum==='kol'?'ayrı kol':input.image.gorunum==='arka'?'arka':'ön'} görselde ölçülemedi: ${reasons.join(' ')}`];
  return {...result,reasons,reason:reasons.join(' '),needs_confirmation:result.needs_confirmation || reasons.length>0};
}
// Replace a stale or generic open measurement confirmation with the concrete reason; nothing is measured.
function noteReason(db,user,appId,reason) {
  const open=db.prepare("SELECT id,message FROM confirmations WHERE kind='olcu' AND ref_table='applications' AND ref_id=? AND status='acik' ORDER BY id DESC LIMIT 1").get(appId);
  if(open?.message===reason)return false;
  if(open)db.prepare('UPDATE confirmations SET message=? WHERE id=?').run(reason,open.id);
  else db.prepare("INSERT INTO confirmations(kind,ref_table,ref_id,message) VALUES('olcu','applications',?,?)").run(appId,reason);
  db.prepare('UPDATE applications SET needs_confirmation=1 WHERE id=?').run(appId);
  audit(db,user.id,'uygulama_olcu_gerekce',appId,{reason});
  return true;
}
const unmeasured=app=>!manuallyMeasured(app) && !['otomatik','otomatik_renk'].includes(provenance(app).method);

// The record is already committed; a failing automatic measurement must not make the client retry and duplicate it.
async function measureAfterSave(db,dataDir,versionId,user,changedOnly) {
  try { await automaticMeasure(db,dataDir,versionId,user,false,changedOnly); return null; }
  catch (e) {
    // Persist the failure on applications that were never measured, so it survives a page reload.
    try { tx(db,()=> {
      if(orders.version(db,versionId).status!=='taslak')return;
      for(const app of db.prepare('SELECT a.* FROM applications a JOIN order_lines l ON l.id=a.line_id WHERE l.version_id=?').all(versionId))
        if(unmeasured(app))noteReason(db,user,app.id,`Otomatik ölçü çalışmadı: ${e.message}`);
    }); } catch {}
    return `Otomatik ölçü şimdi çalışmadı (${e.message}); kayıt oluşturuldu, ölçüyü sonra yeniden deneyin`;
  }
}
async function automaticMeasure(db,dataDir,versionId,user,regenerate=false,changedOnly=false,lineId=null) {
  assertUser(db,user.id);draft(db,versionId);unlocked(db,versionId);
  return renderQueue(async signal=> {
    const v=draft(db,versionId);unlocked(db,versionId);
    const results=[];
    for(const line of v.lines) for(const original of line.applications) {
      if(lineId!=null && line.id!==lineId)continue;
      signal.throwIfAborted();
      const app=db.prepare('SELECT * FROM applications WHERE id=?').get(original.id);
      if(!app || (!regenerate && manuallyMeasured(app)))continue;
      const input=autoInputs(db,v,line,app);
      if(input.gap) {
        tx(db,()=> {
          draft(db,versionId);unlocked(db,versionId);
          const current=db.prepare('SELECT * FROM applications WHERE id=?').get(app.id);
          // Never overwrite a size: an earlier automatic result keeps its own confirmation.
          if(current && !manuallyMeasured(current) && current.width_mm==null && noteReason(db,user,app.id,input.gap))
            results.push({applicationId:app.id,width_mm:null,height_mm:null,needs_confirmation:true,reason:input.gap});
        });
        continue;
      }
      const previous=provenance(app);
      if(changedOnly && ['otomatik','otomatik_renk'].includes(previous.method) && previous.gorselFileId===input.image.id && previous.desenFileId===(input.design?.id??null) &&
        previous.flatId===(input.flat?.id??null) && previous.refCm===(input.flat?.refLengthCm??null) && previous.refBeden===(input.flat?.refBeden??null) && JSON.stringify(previous.olculerL??null)===JSON.stringify(input.flat?.olculerL??null))continue;
      const fingerprint=autoFingerprint(app,input);
      let result;
      try {
        const image={...input.image,...await vectorInput(dataDir,input.image)};
        const design=input.design?{...input.design,...await vectorInput(dataDir,input.design)}:null;
        const {flatNote,linkDesign,...job}=input;
        const calibration=flatCalibrationInput(input.flat,['bacak','sol_bacak','sag_bacak'].includes(input.position));
        result=await generateInChild({type:'autoMeasure',input:{...job,image,design,flat:calibration.flat}},signal,{timeoutMs:MEASURE_TIMEOUT_MS});
        if(calibration.key && result?.measure_source && Object.hasOwn(result.measure_source,'kalibrasyon'))
          FLAT_CALIBRATIONS.set(calibration.key,result.measure_source.kalibrasyon);
      } catch(e) {
        if(signal.aborted)throw e;
        result={width_mm:null,height_mm:null,needs_confirmation:true,reasons:[`Otomatik ölçü tamamlanamadı: ${e.message}`],
          measure_source:{method:'otomatik',flatId:input.flat?.id??null,flatAd:input.flat?.ad??null,refBeden:input.flat?.refBeden??null,refCm:input.flat?.refLengthCm??null,chestPx:null,designBoxPx:null,scale:null,confidence:0,gorselFileId:input.image.id,desenFileId:(input.design?.id??null)}};
      }
      result=explain(result,input);
      signal.throwIfAborted();
      tx(db,()=> {
        const current=draft(db,versionId);unlocked(db,versionId);
        const currentLine=current.lines.find(l=>l.id===line.id),currentApp=currentLine?.applications.find(a=>a.id===app.id);
        // A manual edit, source replacement or reference change during rendering
        // invalidates this result. The subsequent save/upload queues fresh work.
        if(!currentApp || autoFingerprint(currentApp,autoInputs(db,current,currentLine,currentApp))!==fingerprint)return;
        if(input.linkDesign)db.prepare('INSERT INTO document_application_sources(application_id,file_id) VALUES(?,?) ON CONFLICT(application_id) DO NOTHING').run(app.id,input.design.id);
        db.prepare('UPDATE applications SET width_mm=?,height_mm=?,measure_source=?,needs_confirmation=? WHERE id=?')
          .run(result.width_mm,result.height_mm,JSON.stringify(result.measure_source),result.needs_confirmation?1:0,app.id);
        db.prepare("UPDATE confirmations SET status='cozuldu',resolved_by=? WHERE kind='olcu' AND ref_table='applications' AND ref_id=? AND status='acik'").run(user.id,app.id);
        if(result.needs_confirmation)db.prepare("INSERT INTO confirmations(kind,ref_table,ref_id,message) VALUES('olcu','applications',?,?)").run(app.id,result.reason);
        audit(db,user.id,'uygulama_otomatik_olc',app.id,{width_mm:result.width_mm,height_mm:result.height_mm,reason:result.reason});
        results.push({applicationId:app.id,...result});
      });
    }
    return {results};
  }).then(r=>{requalifyVersion(db,dataDir,versionId,user);return r;});
}
async function editLine(db,dataDir,lineId,input,user) {
  const line=tx(db,()=> {
    assertUser(db,user.id);
    const line=db.prepare('SELECT * FROM order_lines WHERE id=?').get(lineId);
    if(!line)fail('Satır bulunamadı',404);
    draft(db,line.version_id);unlocked(db,line.version_id);
    if(input.note!==undefined) {
      if(input.note!==null && (typeof input.note!=='string' || input.note.length>500))fail('Kumaş/kalıp açıklaması en çok 500 karakterlik metin olmalı');
      db.prepare('UPDATE order_lines SET note=? WHERE id=?').run(input.note?.trim()||null,lineId);
      audit(db,user.id,'satir_aciklama',lineId);
    }
    if(input.kalipId===undefined && input.note!==undefined)return line;
    if(typeof input.kalipId!=='string' || !flats.selection(db,line).candidates.some(f=>f.id===input.kalipId))
      fail('Kalıp bu ürünün adaylarından biri olmalı');
    db.prepare('UPDATE order_lines SET kalip_id=? WHERE id=?').run(input.kalipId,lineId);
    for(const app of line.kalip_id===input.kalipId ? [] : db.prepare('SELECT * FROM applications WHERE line_id=?').all(lineId)) {
      if(manuallyMeasured(app))continue;
      db.prepare('UPDATE applications SET width_mm=NULL,height_mm=NULL,measure_source=?,needs_confirmation=1 WHERE id=?')
        .run(JSON.stringify({...provenance(app),method:'kalip_secimi',flatId:input.kalipId}),app.id);
      noteReason(db,user,app.id,'Kalıp seçimi değişti; ölçü yeniden hesaplanmalı');
    }
    audit(db,user.id,'satir_kalip_sec',lineId,{oncekiKalipId:line.kalip_id,kalipId:input.kalipId});
    return line;
  });
  let olcuHatasi;
  if(input.kalipId===undefined)return {...orders.snapshot(db,line.version_id).lines.find(l=>l.id===lineId)};
  try {await automaticMeasure(db,dataDir,line.version_id,user,false,true,lineId);}
  catch(e) {olcuHatasi=`Otomatik ölçü şimdi çalışmadı (${e.message}); kalıp seçimi kaydedildi`;}
  return {...orders.snapshot(db,line.version_id).lines.find(l=>l.id===lineId),...(olcuHatasi?{olcuHatasi}:{})};
}
async function addApplication(db,dataDir,lineId,input,user) {
  const app=tx(db,()=> {
    const line=db.prepare('SELECT * FROM order_lines WHERE id=?').get(lineId);
    if(!line)fail('Satır bulunamadı',404);
    draft(db,line.version_id);unlocked(db,line.version_id);
    const manual=input.width_mm!=null||input.height_mm!=null;
    const app=orders.addApplication(db,lineId,{...input,measure_source:manual?JSON.stringify({method:'elle',flatId:input.flatId??null}):JSON.stringify({flatId:input.flatId??null}),needs_confirmation:true},user);
    if(input.desenDosyaId!=null) {
      const source=db.prepare("SELECT f.* FROM files f LEFT JOIN document_file_meta m ON m.file_id=f.id WHERE f.id=? AND f.version_id=? AND f.kind IN ('desen_kaynak','desen_kaynak_vektor') AND (m.line_id IS NULL OR m.line_id=?)").get(integer(Number(input.desenDosyaId),'desenDosyaId',1),line.version_id,lineId);
      if(!source)fail('Desen bu satır/sürüme ait değil');
      db.prepare('INSERT INTO document_application_sources(application_id,file_id) VALUES(?,?)').run(app.id,source.id);
    }
    return {...app,version_id:line.version_id};
  });
  const olcuHatasi=await measureAfterSave(db,dataDir,app.version_id,user,true);
  const saved=db.prepare('SELECT * FROM applications WHERE id=?').get(app.id);
  return olcuHatasi ? {...saved,olcuHatasi} : saved;
}
// Decode large source images in a separate one-shot process. Native decoder
// arenas then exit before the tracer/mask worker loads its own libraries.
async function generateInChild(input,signal,{timeoutMs=120000}={}) {
  if (!(Number.isFinite(timeoutMs) && timeoutMs>0)) throw new TypeError('Geçerli render süresi gerekli');
  signal?.throwIfAborted();
  const deadline=Date.now()+timeoutMs;
  const run=job=> {
    if(Date.now()>=deadline)throw preparationTimeout();
    return generateRawChild(job,signal,{timeoutMs:deadline-Date.now()});
  };
  async function shrink(source,edge) {
    if(!source || !['image/png','image/jpeg','image/jpg'].includes(source.mime))return source;
    const size=imageSize(source.buffer,source.mime);
    if(size.width*size.height<=4e6)return source;
    const result=await run({type:'raster',input:{buffer:source.buffer,edge}});
    return {...source,buffer:result.buffer,mime:'image/png',rasterSource:size};
  }
  if(input.type==='vector') {
    const source=await shrink(input.input,800);
    const qualitySource=await shrink(source.qualitySource,800);
    input={...input,input:{...source,...(qualitySource?{qualitySource}:{})}};
  } else if(['autoMeasure','extractArtwork'].includes(input.type)) {
    const image=await shrink(input.input.image,1000),design=await shrink(input.input.design,1000);
    input={...input,input:{...input.input,image,design}};
  }
  return run(input);
}
function generateRawChild(input,signal,{timeoutMs=120000}={}) {
  if (!(Number.isFinite(timeoutMs) && timeoutMs>0)) throw new TypeError('Geçerli render süresi gerekli');
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=> {
    const child=childProcess.fork(__filename,['--vector-worker'],{serialization:'advanced',execArgv:['--max-old-space-size=64','--max-semi-space-size=1','--expose-gc'],stdio:['ignore','ignore','pipe','ipc']});
    let result,error,received=false;
    const stop=e=> {error ||= e;child.kill('SIGKILL');};
    const abort=()=>stop(signal.reason);
    signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>stop(preparationTimeout()),timeoutMs);
    child.stderr.resume();
    child.once('error',stop);
    // exit can precede the final IPC/stdio events. Keep listeners and the queue
    // slot until close, including failed spawns and SIGKILL cancellation.
    child.once('close',(code,exitSignal)=> {
      clearTimeout(timer);signal?.removeEventListener('abort',abort);
      if (error) reject(error);
      else if (!received || code!==0) reject(new Error(`Vektör süreci tamamlanamadı (${exitSignal || code})`));
      else resolve(result);
    });
    child.once('message',message=> {
      if (!message || (!Object.hasOwn(message,'result') && typeof message.error!=='string')) {
        stop(new Error('Geçersiz render yanıtı'));return;
      }
      received=true;
      if (message.error) error ||= Object.assign(new Error(message.error),{status:message.status,code:message.code});
      else result=message.result;
    });
    child.once('disconnect',()=> {
      if (!received) stop(new Error('Vektör süreci yanıt vermeden bağlantıyı kapattı'));
    });
    if (signal?.aborted) {abort();return;}
    try {child.send(input,e=> {if (e) stop(e);});} catch (e) {stop(e);}
  });
}
async function prepare(db,dataDir,versionId,user,regenerate=false) {
  assertUser(db,user.id);
  const token=crypto.randomUUID();
  const start=tx(db,()=> {
    const v=draft(db,versionId);
    const state=db.prepare('SELECT * FROM document_preparations WHERE version_id=?').get(versionId);
    if (state?.token && Date.now()-state.started_at<PREPARE_LOCK_MS) fail('Sürüm zaten hazırlanıyor',409);
    if (state?.ready && !regenerate) { assertFresh(db,v); return {existing:v.files}; }
    db.prepare(`INSERT INTO document_preparations(version_id,token,started_at) VALUES(?,?,?)
      ON CONFLICT(version_id) DO UPDATE SET token=excluded.token,started_at=excluded.started_at`).run(versionId,token,Date.now());
    return {v,fingerprint:stableSnapshot(v),sourceFingerprint:inputFingerprint(db,v)};
  });
  if (start.existing) return start.existing;
  // Unmeasured applications no longer stop the forms; their desen previews are prepared in the background.
  if (pendingApplications(db,start.v).size) ensureExtractedRecords(db,dataDir,start.v,user);
  const written=[];
  try {
    const {v}=start;
    const generated=await renderQueue(async signal=> {
      const sourceByApp=new Map(), extractedByApp=new Map(), generated=[];
      const applications=v.lines.flatMap(line=>line.applications.map(app=>({line,app})));
      for (const source of v.files.filter(f=>SOURCE_KINDS.includes(f.kind)))
        if (!applications.length) fail(`Desen ${source.id}: ölçülü uygulama bağlantısı gerekli`,409);
      const unmeasured=pendingApplications(db,v);
      for (const {line,app:a} of applications) {
        if (unmeasured.has(a.id)) continue;
        const targetMm={w:a.width_mm,h:a.height_mm},input=artworkFor(db,v,line,a);
        let original,prev;
        if(input.source) {
          sourceByApp.set(a.id,input.source);
          original=await vectorInput(dataDir,input.source);
          prev=readyPreview(db,dataDir,v,input.source);
        } else {
          const row=await extractPreview(db,dataDir,v,line,a,input,user,signal,true);
          if(!row.artwork)fail(`Uygulama ${a.id}: ${row.message}`,409);
          const report=JSON.parse(row.report_json);
          assertExtractedMeasurement(a,input.image,report.placement);
          original={buffer:row.artwork,mime:'image/png'};
          extractedByApp.set(a.id,row.artwork);
          const file=db.prepare('SELECT * FROM files WHERE id=? AND version_id=? AND kind=?').get(row.preview_file_id,v.id,PREVIEW);
          if(file)prev={buffer:readFile(dataDir,file),report};
        }
        const raster=['image/png','image/jpeg','image/jpg'].includes(original.mime);
        const cached=prev && (!raster || (Number.isFinite(prev.report.rasterQuality?.pathCount) && Number.isFinite(prev.report.rasterQuality?.nodeCount)));
        // Legacy previews without complexity metrics are retraced from the original raster.
        // Keep cached vector paths; final raster quality is measured against the original artwork.
        const result=await generateInChild({type:'vector',input:{...(cached
          ? {manualVector:true,buffer:prev.buffer,mime:'application/pdf',targetMm,applicationType:a.kind,
            ...(raster ? {qualitySource:{...original,metrics:prev.report.rasterQuality}} : {})}
          : {...original,targetMm,applicationType:a.kind}),garmentColor:garmentColor(db,line.id)}},signal);
        const report=prev && !raster && !original.manualVector ? {...result.report,quality:prev.report.quality==='teyit' || result.report.aspectRatioError>0.01 ? 'teyit' : 'iyi',
          reasons:[...new Set([...(prev.report.reasons||[]),...(result.report.aspectRatioError>0.01 ? ['oran_bozuldu'] : [])])]} : result.report;
        generated.push({kind:'desen_vektor',buffer:result.pdf,meta:{applicationId:a.id,...(!input.source?{lineId:line.id}:{})},report});
      }
      const model=formOrder(db,dataDir,v,sourceByApp,extractedByApp,{allowPending:true});
      generated.push(...await generateInChild({type:'forms',model},signal));
      return generated;
    });
    return tx(db,()=> {
      const current=draft(db,versionId);
      if (stableSnapshot(current)!==start.fingerprint || inputFingerprint(db,current)!==start.sourceFingerprint || db.prepare('SELECT token FROM document_preparations WHERE version_id=?').get(versionId)?.token!==token)
        fail('Sürüm hazırlama sırasında değişti; yeniden deneyin',409);
      for (const g of generated) {
        const file=saveFile(db,dataDir,v,g.kind,g.buffer,user,g.meta,written);
        if (g.report?.quality==='teyit') db.prepare("INSERT INTO confirmations(kind,ref_table,ref_id,message) VALUES('vektor_kalite','files',?,?)")
          .run(file.id,`Vektör kalitesi görsel teyit gerektiriyor: ${JSON.stringify(g.report)}`);
      }
      // Register new files first so SQLite cannot reuse an old file ID.
      // Old bytes remain immutable; only current draft registrations are replaced.
      for (const f of current.files.filter(f=>GENERATED.includes(f.kind))) {
        db.prepare("UPDATE confirmations SET status='cozuldu',resolved_by=? WHERE kind='vektor_kalite' AND ref_table='files' AND ref_id=? AND status='acik'").run(user.id,f.id);
        db.prepare('DELETE FROM files WHERE id=?').run(f.id);
      }
      for(const line of current.lines)for(const app of line.applications)
        if(artworkFor(db,current,line,app).source)retireExtractedPreview(db,app.id,user);
      // Preview confirmations are superseded by the confirmation on the generated vector.
      db.prepare(`UPDATE confirmations SET status='cozuldu',resolved_by=? WHERE kind='vektor_kalite' AND status='acik' AND ref_table='files'
        AND ref_id IN (SELECT id FROM files WHERE version_id=? AND kind=?)`).run(user.id,versionId,PREVIEW);
      db.prepare('UPDATE document_preparations SET token=NULL,ready=1,source_json=? WHERE version_id=? AND token=?').run(start.sourceFingerprint,versionId,token);
      audit(db,user.id,'belgeler_hazirla',versionId,{regenerate});
      return orders.snapshot(db,versionId).files;
    });
  } catch (e) {
    for (const f of written) fs.unlinkSync(f);
    if (e.code==='PREPARE_TIMEOUT') db.prepare(`INSERT INTO confirmations(kind,ref_table,ref_id,message)
      SELECT 'baglanti_hatasi','order_versions',?,? WHERE NOT EXISTS
      (SELECT 1 FROM confirmations WHERE kind='baglanti_hatasi' AND ref_table='order_versions'
        AND ref_id=? AND message=? AND status='acik')`).run(versionId,e.message,versionId,e.message);
    throw e;
  }
  finally { db.prepare('UPDATE document_preparations SET token=NULL WHERE version_id=? AND token=?').run(versionId,token); }
}
// Persists nothing: forms for a version as they would print now, optionally without sizes and quantities.
// Vectors are not traced; the print form uses the linked design, a cached extraction or a crop of the product image.
async function previewForms(db,dataDir,versionId,user,{omitQuantities=false}={}) {
  assertUser(db,user.id);
  const v=orders.snapshot(db,integer(versionId,'versionId',1));
  const sourceByApp=new Map(),extractedByApp=new Map(),pending=pendingApplications(db,v);
  for (const line of v.lines) for (const app of line.applications) {
    if (pending.has(app.id)) continue;
    const input=artworkFor(db,v,line,app);
    if (input.source) sourceByApp.set(app.id,input.source);
    else if (!input.gap) {
      const row=extractedRecord(db,app.id,input,true);
      if (row?.artwork) extractedByApp.set(app.id,row.artwork);
    }
  }
  const model=formOrder(db,dataDir,v,sourceByApp,extractedByApp,{allowPending:true,omitQuantities});
  const forms=await renderQueue(signal=>generateInChild({type:'forms',model},signal));
  const missing=[];
  for (const line of v.lines) for (const app of line.applications) if (pending.has(app.id))
    missing.push({applicationId:app.id,lineId:line.id,kind:app.kind,position:app.position,reason:pending.get(app.id)});
  return {forms,missing};
}
function readyPreview(db,dataDir,v,source) {
  if (!source || !SOURCE_KINDS.includes(source.kind)) return null;
  const row=db.prepare("SELECT * FROM document_vector_previews WHERE source_file_id=? AND status IN ('hazir','teyit')").get(source.id);
  const file=row?.preview_file_id && v.files.find(f=>f.id===row.preview_file_id && f.kind===PREVIEW);
  if (!file) return null;
  try { return {buffer:readFile(dataDir,file),report:JSON.parse(row.report_json || '{}')}; } catch { return null; }
}
// Fire-and-forget: the upload response never waits for the render queue.
function queuePreview(db,dataDir,file,user) {
  if (!file || !SOURCE_KINDS.includes(file.kind)) return null;
  const mark=(status,message=null,extra={})=>db.prepare(`INSERT INTO document_vector_previews(source_file_id,preview_file_id,status,report_json,message,updated_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(source_file_id) DO UPDATE SET preview_file_id=excluded.preview_file_id,status=excluded.status,report_json=excluded.report_json,message=excluded.message,updated_at=excluded.updated_at`)
    .run(file.id,extra.previewId ?? null,status,extra.report ? JSON.stringify(extra.report) : null,message,Date.now());
  mark('hazirlaniyor');
  previewing(db).add(file.id);
  const task=(async()=> {
    const written=[];
    try {
      const lineId=db.prepare('SELECT line_id FROM document_file_meta WHERE file_id=?').get(file.id)?.line_id;
      const result=await renderQueue(async signal=>generateInChild({type:'vector',designBox:true,input:{...await vectorInput(dataDir,file),garmentColor:garmentColor(db,lineId)}},signal));
      tx(db,()=> {
        const v=draft(db,file.version_id);
        if (!db.prepare('SELECT 1 FROM files WHERE id=?').get(file.id)) fail('Kaynak dosya silindi',409);
        const meta=db.prepare('SELECT line_id FROM document_file_meta WHERE file_id=?').get(file.id);
        const saved=saveFile(db,dataDir,v,PREVIEW,result.pdf,user,{lineId:meta?.line_id},written);
        const quality=result.report?.quality==='teyit' ? 'teyit' : 'hazir';
        if (quality==='teyit') db.prepare("INSERT INTO confirmations(kind,ref_table,ref_id,message) VALUES('vektor_kalite','files',?,?)")
          .run(saved.id,`Vektör kalitesi görsel teyit gerektiriyor: ${JSON.stringify(result.report)}`);
        mark(quality,null,{previewId:saved.id,report:result.report});
      });
    } catch (e) {
      for (const f of written) try { fs.unlinkSync(f); } catch {}
      try { mark('hata',String(e.message || e).slice(0,300)); } catch {}
    }
  })().finally(()=>{pending.delete(task);previewing(db).delete(file.id);});
  pending.add(task);
  return task;
}
function ensureExtractedRecords(db,dataDir,v,user) {
  for(const line of v.lines) for(const app of line.applications) {
    const input=artworkFor(db,v,line,app);
    if(input.source||input.gap) {
      if(db.prepare('SELECT 1 FROM document_extracted_previews WHERE application_id=?').get(app.id))
        tx(db,()=>retireExtractedPreview(db,app.id,user));
      continue;
    }
    if(extractedRecord(db,app.id,input))continue;
    const workKey=`extract:${app.id}:${input.key}`;
    if(previewing(db).has(workKey))continue;
    previewing(db).add(workKey);
    const task=renderQueue(signal=>extractPreview(db,dataDir,v,line,app,input,user,signal))
      .catch(()=>{}).finally(()=>{pending.delete(task);previewing(db).delete(workKey);});
    pending.add(task);
  }
}
function ensureVectorRecords(db,dataDir,versionId,user) {
  const v=orders.snapshot(db,integer(versionId,'versionId',1));
  // A preview file can only be added to a draft; other versions report 'yok' in vectorStatus.
  if (v.status!=='taslak') return;
  for (const file of v.files.filter(f=>SOURCE_KINDS.includes(f.kind))) {
    if (previewing(db).has(file.id)) continue;
    const row=db.prepare('SELECT status FROM document_vector_previews WHERE source_file_id=?').get(file.id);
    if (!row || row.status==='hazirlaniyor') queuePreview(db,dataDir,file,user);
  }
  ensureExtractedRecords(db,dataDir,v,user);
}
// Once an application has a size, a preview that waited for it ('beklemede') is judged
// against that target. Runs in the background on the shared render queue.
function requalifyVersion(db,dataDir,versionId,user) {
  const task=(async()=> {
    try {
      const rows=db.prepare(`SELECT a.id,a.kind,a.width_mm,a.height_mm,s.file_id FROM applications a
        JOIN order_lines l ON l.id=a.line_id JOIN document_application_sources s ON s.application_id=a.id
        JOIN document_vector_previews p ON p.source_file_id=s.file_id
        WHERE l.version_id=? AND a.width_mm IS NOT NULL AND a.height_mm IS NOT NULL AND p.status IN ('hazir','teyit')`).all(versionId);
      for (const a of rows) {
        const qualityOf=r=> { try { return JSON.parse(r?.report_json||'{}').quality; } catch { return null; } };
        const row=db.prepare('SELECT * FROM document_vector_previews WHERE source_file_id=?').get(a.file_id);
        if (qualityOf(row)!=='beklemede') continue;
        const targetMm={w:a.width_mm,h:a.height_mm};
        const result=await renderQueue(async signal=> {
          const v=orders.snapshot(db,versionId),source=v.files.find(f=>f.id===a.file_id && SOURCE_KINDS.includes(f.kind));
          const prev=source && readyPreview(db,dataDir,v,source);
          if (!prev || prev.report.quality!=='beklemede') return null;
          const original=await vectorInput(dataDir,source);
          if (!['image/png','image/jpeg','image/jpg'].includes(original.mime)) return null;
          return generateInChild({type:'vector',input:{manualVector:true,buffer:prev.buffer,mime:'application/pdf',targetMm,applicationType:a.kind,
            qualitySource:{...original,metrics:prev.report.rasterQuality}}},signal);
        });
        if (!result) continue;
        tx(db,()=> {
          const cur=db.prepare('SELECT * FROM document_vector_previews WHERE source_file_id=?').get(a.file_id);
          const app=db.prepare('SELECT width_mm,height_mm FROM applications WHERE id=?').get(a.id);
          // Skip if the preview, the source link or the size changed while rendering.
          if (!cur || cur.preview_file_id!==row.preview_file_id || qualityOf(cur)!=='beklemede' || !app || app.width_mm!==a.width_mm || app.height_mm!==a.height_mm) return;
          if (db.prepare('SELECT file_id FROM document_application_sources WHERE application_id=?').get(a.id)?.file_id!==a.file_id) return;
          const report={...result.report,targetMm};
          const open=db.prepare("SELECT id FROM confirmations WHERE kind='vektor_kalite' AND ref_table='files' AND ref_id=? AND status='acik'").get(cur.preview_file_id);
          if (report.quality==='teyit' && !open) db.prepare("INSERT INTO confirmations(kind,ref_table,ref_id,message) VALUES('vektor_kalite','files',?,?)")
            .run(cur.preview_file_id,`Vektör kalitesi görsel teyit gerektiriyor: ${JSON.stringify(report)}`);
          if (report.quality==='iyi') db.prepare("UPDATE confirmations SET status='cozuldu',resolved_by=? WHERE kind='vektor_kalite' AND ref_table='files' AND ref_id=? AND status='acik'").run(user.id,cur.preview_file_id);
          db.prepare("UPDATE document_vector_previews SET status=?,report_json=?,updated_at=? WHERE source_file_id=?")
            .run(report.quality==='teyit'?'teyit':'hazir',JSON.stringify(report),Date.now(),a.file_id);
        });
      }
    } catch {}
  })().finally(()=>pending.delete(task));
  pending.add(task);
  return task;
}
function vectorStatus(db,versionId) {
  const rows=db.prepare(`SELECT p.source_file_id AS sourceFileId,p.preview_file_id AS previewFileId,p.status,p.message,p.report_json
    FROM document_vector_previews p JOIN files f ON f.id=p.source_file_id WHERE f.version_id=? ORDER BY p.source_file_id`).all(versionId)
    .map(({report_json,...r})=> {
      const report=report_json ? JSON.parse(report_json) : {};
      return {...r,quality:report.quality ?? null,reasons:Array.isArray(report.reasons) ? report.reasons : [],
        ...(report.targetMm ? {targetMm:report.targetMm} : {}),
        ...(report.sourceKind ? {sourceKind:report.sourceKind} : {}),...(report.designBox ? {designBox:report.designBox} : {})};
    });
  // Every source file gets a row: a missing record is stated, never left for the client to guess.
  const missing=db.prepare(`SELECT f.id FROM files f WHERE f.version_id=? AND f.kind IN ('desen_kaynak','desen_kaynak_vektor')
    AND NOT EXISTS (SELECT 1 FROM document_vector_previews p WHERE p.source_file_id=f.id)`).all(versionId);
  const draftVersion=orders.version(db,versionId).status==='taslak';
  for (const {id} of missing) rows.push({sourceFileId:id,previewFileId:null,status:'yok',quality:null,reasons:[],
    message:draftVersion ? 'Vektör kaydı yok; durum yeniden okununca hazırlanır.' : 'Sürüm taslak olmadığı için vektör önizlemesi hazırlanmadı.'});
  const v=orders.snapshot(db,versionId);
  for(const line of v.lines)for(const app of line.applications) {
    const input=artworkFor(db,v,line,app);
    if(input.source)continue;
    const row=extractedRecord(db,app.id,input),report=row?.report_json ? JSON.parse(row.report_json) : {};
    if(!row&&v.status!=='taslak')continue;
    rows.push({extracted:true,applicationId:app.id,sourceFileId:input.image?.id??null,position:app.position,
      previewFileId:row?.preview_file_id??null,status:row?.status??(input.gap?'teyit':'hazirlaniyor'),message:row?.message??input.gap??null,
      quality:report.quality??null,reasons:report.reasons??[],...(report.placement?{placement:report.placement}:{}),
      ...(report.sourceKind?{sourceKind:report.sourceKind}:{}),...(report.designBox?{designBox:report.designBox}:{}),
      // Shown as the preview's origin: no separate artwork file was supplied.
      ...(row?.preview_file_id?{sourceLabel:'Görselden ayrıldı'}:{})});
  }
  // Stored reports keep short codes; every row also carries their Turkish text.
  for(const row of rows)row.reasonTexts=reasonTexts(row.reasons);
  return rows.sort((a,b)=>a.sourceFileId-b.sourceFileId);
}
const settled=()=>Promise.all([...pending]);
function workshopPackage(db,versionId) {
  const v=orders.snapshot(db,versionId);
  if (v.status!=='onaylandi') fail('Atölye paketi için sürüm onaylanmalı',409);
  const order=db.prepare('SELECT * FROM orders WHERE id=?').get(v.order_id);
  const files=v.files.filter(f=>WORKSHOP.includes(f.kind)).map(f=> {
    const job=db.prepare("SELECT id,status,idempotency_key FROM outbox WHERE version_id=? AND kind='atolye_dosya' AND idempotency_key=? ORDER BY id DESC LIMIT 1")
      .get(versionId,`atolye:${versionId}:${f.id}`);
    return {...f,url:`/api/siparis/dosyalar/${f.id}`,outbox:job || null};
  });
  return {message:buildWorkshopMessage({...order,version_no:v.version_no,lines:v.lines},files),files};
}
function registerWorkshop(boundDb,dataDir) {
  roots.set(boundDb,dataDir);
  const handler=createWorkshopHandler(process.env);
  return registerHandler('atolye_dosya',async(payload,context)=> {
    const {db,job}=context;
    const file=db.prepare('SELECT * FROM files WHERE id=? AND version_id=?').get(payload.file?.id,job.version_id);
    if (!file || !WORKSHOP.includes(file.kind)) fail('Bu dosya atölyeye gönderilemez',409);
    if (orders.version(db,job.version_id).status!=='onaylandi') fail('Sürüm onaylanmamış',409);
    const order=db.prepare('SELECT o.* FROM orders o JOIN order_versions v ON v.order_id=o.id WHERE v.id=?').get(job.version_id);
    // Verify the registered path and bytes even if the upstream payload was altered.
    const root=roots.get(db) || path.dirname(db.name);
    const buffer=readFile(root,file);
    const result=await handler({...job,payload_json:{...payload,order:{...order,version_no:orders.version(db,job.version_id).version_no,lines:orders.snapshot(db,job.version_id).lines},file:{...file,buffer,mime:'application/pdf'}}});
    audit(db,null,'atolye_bagdastirici_sonucu',job.id,{status:result.status});
    if (result.status==='manuel_bekliyor') return {status:'manuel_bekliyor'};
    return {providerRef:result.providerRef};
  });
}
module.exports={flatCalibrationInput,FLAT_CALIBRATIONS,editLine,queuePreview,ensureVectorRecords,VIEWS,addApplication,automaticMeasure,vectorStatus,settled,PREVIEW,init,UPLOAD_KINDS,directory,safeSegment,editApplication,deleteApplication,assertVectorQuality,documentDate,createRenderQueue,generateInChild,validateUpload,upload,measure,prepare,previewForms,pendingApplications,formOrder,workshopPackage,registerWorkshop,filePath,readFile,sha256,WORKSHOP,openMeasurements,assertMeasurements,assertFresh,unlocked};
function vectorModule() {
  // Native tracer/canvas binaries come from npm; a platform without them must say so, not fail anonymously.
  try { return require('./vector'); }
  catch (e) { throw new Error(`Vektörleştirme bu sunucuda yok: ${String(e.message).split('\n')[0]}`); }
}
async function designBoxOf(input) {
  try {
    const auto=require('./autoMeasure'),[page]=await auto.rasterPages(input,600,input.mime==='application/pdf'?[1]:null);
    // Same matte rule as the measurement: a uniform proof ground is not the artwork's box.
    const box=page && auto.designContent(page,true).box;
    return box ? {w:box.w,h:box.h} : null;
  } catch { return null; }
}
if (require.main===module && process.argv[2]==='--vector-worker') {
  // A one-shot worker must not depend on PDF/native-library handles becoming
  // idle. Flush the entire IPC response before exiting; close drains it in the parent.
  const reply=message=>process.send(message,error=>process.exit(error ? 1 : 0));
  process.once('disconnect',()=>process.exit(1));
  process.once('message',async job=> {
    try {
      let result;
      if(job.type==='raster') {
        const canvasLib=require('@napi-rs/canvas'),image=await canvasLib.loadImage(job.input.buffer);
        const scale=Math.min(1,job.input.edge/Math.max(image.width,image.height));
        const canvas=canvasLib.createCanvas(Math.max(1,Math.round(image.width*scale)),Math.max(1,Math.round(image.height*scale)));
        canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
        result={buffer:canvas.toBuffer('image/png')};
      }
      else if (job.type==='autoMeasure') {
        const {design,...input}=job.input;
        let reference=design;
        if (design?.mime==='image/svg+xml') {
          // Keep a failed SVG as an unreadable reference so measurement can still report a color candidate.
          try { reference=await normalizeVectorInput(design); } catch {}
        }
        result=await require('./autoMeasure').autoMeasure({...input,design:reference});
      }
      else if (job.type==='extractArtwork') result=await require('./autoMeasure').extractArtwork(job.input);
      else if (job.type==='vector') {
        const input=await normalizeVectorInput(job.input);
        result=await vectorModule().vectorize(input);
        // Upload previews also record the source kind and the artwork content box (ratio for manual sizing).
        global.gc?.();
        if (job.designBox) Object.assign(result.report,{sourceKind:result.kind,designBox:result.report.designBox??await designBoxOf(input)});
      }
      else {
        const forms=require('./pdf'); result=[];
        for (const [kind,render] of [['uretim_formu',forms.renderProductionForm],['onay_formu',forms.renderApprovalForm],['baski_formu',forms.renderPrintForm],['nakis_formu',forms.renderEmbroideryForm]]) {
          const buffer=await render(job.model);
          if (buffer!==null) result.push({kind,buffer});
        }
      }
      reply({result});
    } catch (e) {reply({error:e.message,status:e.status,code:e.code});}
  });
}
