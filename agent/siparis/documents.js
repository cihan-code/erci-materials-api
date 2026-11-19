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
const childProcess = require('node:child_process');
const { buildWorkshopMessage, createWorkshopHandler } = require('./workshop');
const { registerHandler } = require('./outbox');
const UPLOAD_KINDS = ['urun_gorsel','desen_kaynak','desen_kaynak_vektor'];
const POSITIONS = ['gogus','sol_gogus','sag_gogus','kol','sol_kol','sag_kol','sirt','ense','kapusan','kapuson'];
const SOURCE_KINDS = ['desen_kaynak','desen_kaynak_vektor'];
const PREPARE_TIMEOUT_MS = 8*60e3;
const PREPARE_LOCK_MS = 10*60e3;
const GENERATED = ['uretim_formu','onay_formu','baski_formu','nakis_formu','desen_vektor'];
const WORKSHOP = ['baski_formu','nakis_formu','desen_vektor'];
const roots = new WeakMap();
const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

function init(db) {
  // The core owns schema migrations and queue transitions. Retire the old
  // document-layer shims on existing databases as well as fresh installs.
  db.exec(`DROP TRIGGER IF EXISTS document_workshop_allowlist;
    DROP TRIGGER IF EXISTS document_workshop_key;
    DROP TRIGGER IF EXISTS document_workshop_manual;
    DROP TABLE IF EXISTS document_workshop_results;`);
  db.exec(`CREATE TABLE IF NOT EXISTS document_file_meta (
    file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
    line_id INTEGER REFERENCES order_lines(id), application_id INTEGER REFERENCES applications(id),
    gorunum TEXT CHECK(gorunum IN ('on','arka')), mime TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS document_application_sources (
    application_id INTEGER PRIMARY KEY REFERENCES applications(id),
    file_id INTEGER NOT NULL REFERENCES files(id)
  );
  CREATE TABLE IF NOT EXISTS document_preparations (
    version_id INTEGER PRIMARY KEY REFERENCES order_versions(id),
    token TEXT, started_at INTEGER, ready INTEGER NOT NULL DEFAULT 0, source_json TEXT
  );
  `);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS document_file_path ON files(version_id,path)');
  flats.init(db);
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
    if (input.gorunum != null && !['on','arka'].includes(input.gorunum)) fail('gorunum on/arka olmalı');
    if (input.kind==='urun_gorsel' && (!lineId || !input.gorunum)) fail('Ürün görseli için lineId ve gorunum gerekli');
    const applicationId=input.applicationId==null?null:integer(Number(input.applicationId),'applicationId',1);
    const app=applicationId==null?null:v.lines.flatMap(l=>l.applications).find(a=>a.id===applicationId);
    if(applicationId!=null && (!app || (lineId && app.line_id!==lineId))) fail('Uygulama bu satır/sürüme ait değil');
    const saved=saveFile(db,dataDir,v,input.kind,file.buffer,user,{...file,lineId:lineId??app?.line_id,applicationId,gorunum:input.gorunum},written);
    if(app && input.kind==='desen_kaynak') db.prepare('INSERT INTO document_application_sources(application_id,file_id) VALUES(?,?) ON CONFLICT(application_id) DO UPDATE SET file_id=excluded.file_id').run(app.id,saved.id);
    return saved;
  }); } catch (e) { for (const f of written) fs.unlinkSync(f); throw e; }
  await automaticMeasure(db,dataDir,versionId,user,false,true);
  return saved;
}
function measure(db, dataDir, input, user, applicationId = null) {
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
  await automaticMeasure(db,dataDir,line.version_id,user);
  result.application=db.prepare('SELECT * FROM applications WHERE id=?').get(applicationId);
  return result;
}
function deleteApplication(db,applicationId,user) {
  assertUser(db,user.id);
  return tx(db,()=> {
    const app=db.prepare('SELECT a.*,l.version_id FROM applications a JOIN order_lines l ON l.id=a.line_id WHERE a.id=?').get(applicationId);
    if (!app) fail('Uygulama bulunamadı',404);
    draft(db,app.version_id);unlocked(db,app.version_id);
    db.prepare('DELETE FROM document_application_sources WHERE application_id=?').run(app.id);
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
function inputFingerprint(db,v) {
  return JSON.stringify({order:db.prepare('SELECT * FROM orders WHERE id=?').get(v.order_id),
    lines:v.lines.map(({recipe_version,...line})=>line),files:v.files.filter(f=>!GENERATED.includes(f.kind)),
    sources:db.prepare(`SELECT s.application_id,s.file_id FROM document_application_sources s
      JOIN applications a ON a.id=s.application_id JOIN order_lines l ON l.id=a.line_id
      WHERE l.version_id=? ORDER BY s.application_id`).all(v.id)});
}
function assertFresh(db,v) {
  const state=db.prepare('SELECT * FROM document_preparations WHERE version_id=?').get(v.id);
  if (state?.ready && state.source_json!==inputFingerprint(db,v))
    fail('Sürüm değişmiş; belgeleri hazirla?yeniden=1 ile yeniden üretin',409);
}
function sourceFor(db, v, app) {
  const explicit=db.prepare('SELECT file_id FROM document_application_sources WHERE application_id=?').get(app.id)?.file_id;
  const candidates=v.files.filter(f=>SOURCE_KINDS.includes(f.kind)).filter(f=> {
    const meta=db.prepare('SELECT line_id FROM document_file_meta WHERE file_id=?').get(f.id);
    return !meta?.line_id || meta.line_id===app.line_id;
  });
  const source=explicit ? v.files.find(f=>f.id===explicit && SOURCE_KINDS.includes(f.kind)) : candidates.length===1 ? candidates[0] : null;
  if (!source) fail(`Uygulama ${app.id}: desenDosyaId ile tek bir kaynak bağlayın`,409);
  return source;
}
function formOrder(db,dataDir,v,sourceByApp) {
  const order=db.prepare('SELECT * FROM orders WHERE id=?').get(v.order_id);
  const preview = file => file && /\.(png|jpe?g)$/i.test(file.path) ? readFile(dataDir,file) : undefined;
  return {
    orderNo:order.order_no,name:order.customer_name || 'Müşteri belirtilmedi',version:v.version_no,
    date:documentDate(),deliveryDate:'Teslim tarihi belirtilmedi',description:[],
    lines:v.lines.map(l=> {
      const images={};
      for (const f of v.files.filter(f=>f.kind==='urun_gorsel')) {
        const meta=db.prepare('SELECT * FROM document_file_meta WHERE file_id=?').get(f.id);
        if (meta?.line_id===l.id) images[meta.gorunum==='on'?'front':'back']=preview(f);
      }
      const sizes=JSON.parse(l.sizes_json);
      if (Object.keys(sizes).length && Object.values(sizes).reduce((a,b)=>a+b,0)!==l.quantity) fail(`Satır ${l.id}: PDF için adetlere eşit beden dağılımı gerekli`,409);
      return {id:String(l.id),product:l.product_key,color:l.color_name || 'Renk belirtilmedi',fabric:l.fabric_item_id ? db.prepare('SELECT name FROM stock_items WHERE id=?').get(l.fabric_item_id).name : 'Kumaş belirtilmedi',sizes,quantity:l.quantity,images};
    }),
    applications:v.lines.flatMap(l=>l.applications.map(a=>({type:a.kind,position:a.position,width_mm:a.width_mm,height_mm:a.height_mm,lineIds:[String(l.id)],preview:preview(sourceByApp.get(a.id))}))),
  };
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
function autoInputs(db,v,line,app) {
  const view=viewForPosition(app.position);
  const images=v.files.filter(f=>f.kind==='urun_gorsel' && f.line_id===line.id && (view==='teyit'||f.gorunum===view));
  // A replacement upload supersedes the previous immutable file in this view.
  const image=images.at(-1);
  const sourceId=db.prepare('SELECT file_id FROM document_application_sources WHERE application_id=?').get(app.id)?.file_id;
  const design=v.files.find(f=>f.id===sourceId && f.kind==='desen_kaynak');
  const meta=design && db.prepare('SELECT line_id FROM document_file_meta WHERE file_id=?').get(design.id);
  if(!image || (meta?.line_id && meta.line_id!==line.id))return null;
  const productFlats=flats.list(db).filter(f=>f.urun===line.product_key);
  const viewFlats=productFlats.filter(f=>f.gorunum===(view==='teyit'?image.gorunum:view));
  // A front library drawing also supplies the same garment's back chest width.
  const candidates=viewFlats.length?viewFlats:productFlats;
  const requested=provenance(app).flatId;
  const flat=requested ? productFlats.find(f=>f.id===requested)??null : candidates.length===1?candidates[0]:null;
  return {image,design,flat,product:line.product_key,position:app.position};
}
function autoFingerprint(app,input) {return JSON.stringify({app,input});}

async function automaticMeasure(db,dataDir,versionId,user,regenerate=false,changedOnly=false) {
  assertUser(db,user.id);draft(db,versionId);unlocked(db,versionId);
  return renderQueue(async signal=> {
    const v=draft(db,versionId);unlocked(db,versionId);
    const results=[];
    for(const line of v.lines) for(const original of line.applications) {
      signal.throwIfAborted();
      const app=db.prepare('SELECT * FROM applications WHERE id=?').get(original.id);
      if(!app || (!regenerate && manuallyMeasured(app)))continue;
      const input=autoInputs(db,v,line,app);
      if(!input)continue;
      const previous=provenance(app);
      if(changedOnly && ['otomatik','otomatik_renk'].includes(previous.method) && previous.gorselFileId===input.image.id && previous.desenFileId===(input.design?.id??null) &&
        previous.flatId===(input.flat?.id??null) && previous.refCm===(input.flat?.refLengthCm??null) && previous.refBeden===(input.flat?.refBeden??null) && JSON.stringify(previous.olculerL??null)===JSON.stringify(input.flat?.olculerL??null))continue;
      const fingerprint=autoFingerprint(app,input);
      let result;
      try {
        const image={...input.image,...await vectorInput(dataDir,input.image)};
        const design=input.design?{...input.design,...await vectorInput(dataDir,input.design)}:null;
        result=await generateInChild({type:'autoMeasure',input:{...input,image,design}},signal,{timeoutMs:15000});
      } catch(e) {
        if(signal.aborted)throw e;
        result={width_mm:null,height_mm:null,needs_confirmation:true,reason:`Otomatik ölçü tamamlanamadı: ${e.message}`,
          measure_source:{method:'otomatik',flatId:input.flat?.id??null,flatAd:input.flat?.ad??null,refBeden:input.flat?.refBeden??null,refCm:input.flat?.refLengthCm??null,chestPx:null,designBoxPx:null,scale:null,confidence:0,gorselFileId:input.image.id,desenFileId:(input.design?.id??null)}};
      }
      signal.throwIfAborted();
      tx(db,()=> {
        const current=draft(db,versionId);unlocked(db,versionId);
        const currentLine=current.lines.find(l=>l.id===line.id),currentApp=currentLine?.applications.find(a=>a.id===app.id);
        // A manual edit, source replacement or reference change during rendering
        // invalidates this result. The subsequent save/upload queues fresh work.
        if(!currentApp || autoFingerprint(currentApp,autoInputs(db,current,currentLine,currentApp))!==fingerprint)return;
        db.prepare('UPDATE applications SET width_mm=?,height_mm=?,measure_source=?,needs_confirmation=? WHERE id=?')
          .run(result.width_mm,result.height_mm,JSON.stringify(result.measure_source),result.needs_confirmation?1:0,app.id);
        db.prepare("UPDATE confirmations SET status='cozuldu',resolved_by=? WHERE kind='olcu' AND ref_table='applications' AND ref_id=? AND status='acik'").run(user.id,app.id);
        if(result.needs_confirmation)db.prepare("INSERT INTO confirmations(kind,ref_table,ref_id,message) VALUES('olcu','applications',?,?)").run(app.id,result.reason);
        audit(db,user.id,'uygulama_otomatik_olc',app.id,{width_mm:result.width_mm,height_mm:result.height_mm,reason:result.reason});
        results.push({applicationId:app.id,...result});
      });
    }
    return {results};
  });
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
  await automaticMeasure(db,dataDir,app.version_id,user);
  return db.prepare('SELECT * FROM applications WHERE id=?').get(app.id);
}
function generateInChild(input,signal,{timeoutMs=120000}={}) {
  if (!(Number.isFinite(timeoutMs) && timeoutMs>0)) throw new TypeError('Geçerli render süresi gerekli');
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=> {
    const child=childProcess.fork(__filename,['--vector-worker'],{serialization:'advanced',execArgv:[],stdio:['ignore','ignore','pipe','ipc']});
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
    const v=draft(db,versionId); assertMeasurements(db,v);
    const state=db.prepare('SELECT * FROM document_preparations WHERE version_id=?').get(versionId);
    if (state?.token && Date.now()-state.started_at<PREPARE_LOCK_MS) fail('Sürüm zaten hazırlanıyor',409);
    if (state?.ready && !regenerate) { assertFresh(db,v); return {existing:v.files}; }
    db.prepare(`INSERT INTO document_preparations(version_id,token,started_at) VALUES(?,?,?)
      ON CONFLICT(version_id) DO UPDATE SET token=excluded.token,started_at=excluded.started_at`).run(versionId,token,Date.now());
    return {v,fingerprint:JSON.stringify(v),sourceFingerprint:inputFingerprint(db,v)};
  });
  if (start.existing) return start.existing;
  const written=[];
  try {
    const {v}=start;
    const generated=await renderQueue(async signal=> {
      const sourceByApp=new Map(), generated=[];
      for (const a of v.lines.flatMap(l=>l.applications)) sourceByApp.set(a.id,sourceFor(db,v,a));
      for (const source of v.files.filter(f=>SOURCE_KINDS.includes(f.kind)))
        if (!sourceByApp.size) fail(`Desen ${source.id}: ölçülü uygulama bağlantısı gerekli`,409);
      for (const a of v.lines.flatMap(l=>l.applications)) {
        const result=await generateInChild({type:'vector',input:{...await vectorInput(dataDir,sourceByApp.get(a.id)),targetMm:{w:a.width_mm,h:a.height_mm}}},signal);
        generated.push({kind:'desen_vektor',buffer:result.pdf,meta:{applicationId:a.id},report:result.report});
      }
      const model=formOrder(db,dataDir,v,sourceByApp);
      generated.push(...await generateInChild({type:'forms',model},signal));
      return generated;
    });
    return tx(db,()=> {
      const current=draft(db,versionId); assertMeasurements(db,current);
      if (JSON.stringify(current)!==start.fingerprint || inputFingerprint(db,current)!==start.sourceFingerprint || db.prepare('SELECT token FROM document_preparations WHERE version_id=?').get(versionId)?.token!==token)
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
module.exports={init,UPLOAD_KINDS,directory,safeSegment,editApplication,deleteApplication,addApplication,automaticMeasure,assertVectorQuality,documentDate,createRenderQueue,generateInChild,validateUpload,upload,measure,prepare,workshopPackage,registerWorkshop,filePath,readFile,sha256,WORKSHOP,openMeasurements,assertMeasurements,assertFresh,unlocked};
if (require.main===module && process.argv[2]==='--vector-worker') {
  // A one-shot worker must not depend on PDF/native-library handles becoming
  // idle. Flush the entire IPC response before exiting; close drains it in the parent.
  const reply=message=>process.send(message,error=>process.exit(error ? 1 : 0));
  process.once('disconnect',()=>process.exit(1));
  process.once('message',async job=> {
    try {
      let result;
      if (job.type==='autoMeasure') result=await require('./autoMeasure').autoMeasure(job.input);
      else if (job.type==='vector') result=await require('./vector').vectorize(await normalizeVectorInput(job.input));
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
