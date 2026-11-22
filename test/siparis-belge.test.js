'use strict';
const {test,after}=require('node:test');
// Bound the whole file, including stuck HTTP requests or referenced worker handles.
// A test-only watchdog also fails the file when ordinary test cancellation cannot drain it.
const fileDeadline=setTimeout(()=> {
  console.error('Belge test dosyası 120 saniyeyi aştı');process.exit(1);
},120000);
fileDeadline.unref();
after(()=>clearTimeout(fileDeadline));
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {PDFDocument}=require('pdf-lib');
const {setup,designPng}=require('./fixtures/siparis/belge-fixture');
const documents=require('../agent/siparis/documents');
const queue=require('../agent/siparis/outbox');

async function fixture(t) {
  const f=await setup();
  t.after(async()=> {await f.close();fs.rmSync(f.dir,{recursive:true,force:true});});
  return f;
}
function ok(result,status=200) {assert.equal(result.status,status,JSON.stringify(result.data));return result.data;}
async function prepared(f,{both=true}={}) {
  const o=await f.order(), id=o.version.id, lineId=o.version.lines[0].id;
  const source=ok(await f.upload(id),201);
  ok(await f.measure(lineId,{desenDosyaId:source.id}),201);
  if (both) ok(await f.measure(lineId,{kind:'nakis',position:'gogus',desenDosyaId:source.id,designBoxPx:{w:37.5,h:20}}),201);
  const files=ok(await f.post(`/surumler/${id}/hazirla`));
  return {o,id,lineId,files,source};
}

test('HTTP bearer token is required for every document operation',async t=> {
  const f=await fixture(t);
  for (const [url,method] of [['/dosyalar/1','GET'],['/duz-cizimler','GET'],['/duz-cizimler','POST'],['/uygulamalar/olc','POST'],['/surumler/1/hazirla','POST'],['/surumler/1/dosyalar','POST'],['/surumler/1/atolye-paketi','GET']])
    assert.equal((await f.request(url,{method})).status,401);
});

test('HTTP uploads immutable bytes, server SHA256 and authenticated download',async t=> {
  const f=await fixture(t), o=await f.order(), png=designPng();
  const a=ok(await f.upload(o.version.id,{buffer:png}),201);
  const b=ok(await f.upload(o.version.id,{buffer:png}),201);
  assert.notEqual(a.id,b.id);assert.notEqual(a.path,b.path);
  assert.equal(a.sha256,crypto.createHash('sha256').update(png).digest('hex'));
  assert.match(a.path,/siparis\/files\/MRC-T1\/v1\/desen_kaynak-1\.png$/);
  const response=await f.request(`/dosyalar/${a.id}`,{token:f.token});
  assert.deepEqual(ok(response),png);assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  assert.match(response.headers.get('content-disposition'),/^attachment/);
  fs.writeFileSync(a.path,'altered');
  assert.equal((await f.request(`/dosyalar/${a.id}`,{token:f.token})).status,409);
});

test('HTTP rejects filename and order traversal, symlinks and a forged download path',async t=> {
  const f=await fixture(t), o=await f.order();
  assert.equal((await f.upload(o.version.id,{name:'../ornek.png'})).status,400);
  const unsafe=await f.order({order_no:'../escape'});
  assert.equal((await f.upload(unsafe.version.id)).status,400);
  const file=ok(await f.upload(o.version.id),201);
  const outside=path.join(f.dir,'outside.png');fs.writeFileSync(outside,designPng());
  f.db.prepare('UPDATE files SET path=? WHERE id=?').run(outside,file.id);
  assert.equal((await f.request(`/dosyalar/${file.id}`,{token:f.token})).status,403);
  f.db.prepare('UPDATE files SET path=? WHERE id=?').run(file.path,file.id);
  fs.unlinkSync(file.path);fs.symlinkSync(outside,file.path);
  assert.equal((await f.request(`/dosyalar/${file.id}`,{token:f.token})).status,403);
  assert.equal((await f.post(`/surumler/${o.version.id}/dosyalar`,{path:'../../outside.png',kind:'onay_formu'})).status,403);
  assert.equal((await f.request('/dosyalar/..%2F1',{token:f.token})).status,400);
});

test('HTTP upload type, signatures, SVG external resources and 25 MB limits',async t=> {
  const f=await fixture(t), o=await f.order();
  assert.equal((await f.upload(o.version.id,{name:'ornek.exe'})).status,415);
  assert.equal((await f.upload(o.version.id,{mime:'application/pdf'})).status,415);
  assert.equal((await f.upload(o.version.id,{buffer:Buffer.from('bad PNG')})).status,400);
  assert.equal((await f.upload(o.version.id,{name:'x.svg',mime:'image/svg+xml',buffer:Buffer.from('<svg><image href="file:///etc/passwd"/></svg>')})).status,400);
  assert.equal((await f.upload(o.version.id,{buffer:Buffer.alloc(25*1024*1024+1)})).status,413);
  const pdf=await PDFDocument.create();pdf.addPage([100,50]);
  ok(await f.upload(o.version.id,{name:'ornek.pdf',mime:'application/pdf',buffer:Buffer.from(await pdf.save())}),201);
});

test('HTTP flat library uploads, lists and restricts reference saving to approval users',async t=> {
  const f=await fixture(t);
  const body=new FormData();body.set('ad','Örnek ön');body.set('urun','tisort');body.set('gorunum','on');body.set('file',new Blob([designPng()],{type:'image/png'}),'ornek.png');
  const flat=ok(await f.request('/duz-cizimler',{method:'POST',body,token:f.token}),201);
  const reference={refLengthPx:280,refLengthCm:56,refAciklama:'Omuzdan eteğe'};
  assert.equal(f.team.onay_yetkisi,1);
  ok(await f.request(`/duz-cizimler/${flat.id}/referans`,{method:'PUT',body:reference,token:f.token}));
  const restricted=await require('../agent/siparis/auth').createUser(f.db,{name:'Örnek Kısıtlı',password:'synthetic-password',onayYetkisi:false});
  assert.equal(restricted.onay_yetkisi,0);
  const restrictedToken=ok(await f.post('/giris',{name:restricted.name,password:'synthetic-password'})).token;
  assert.equal((await f.request(`/duz-cizimler/${flat.id}/referans`,{method:'PUT',body:reference,token:restrictedToken})).status,403);
  const saved=ok(await f.request(`/duz-cizimler/${flat.id}/referans`,{method:'PUT',body:reference,token:f.managerToken}));
  assert.equal(saved.refLengthCm,56);assert.match(saved.dosya,/siparis\/flats\//);
  assert.equal(ok(await f.request('/duz-cizimler',{token:f.token})).length,1);
  const o=await f.order();
  const result=ok(await f.measure(o.version.lines[0].id,{flatId:flat.id}),201);
  assert.equal(result.width_mm,280);assert.equal(JSON.parse(result.application.measure_source).flatId,flat.id);
});

test('HTTP measurement 280/56/140 gives 280 mm; PNG bounds and photo confirmations persist',async t=> {
  const f=await fixture(t), o=await f.order(), lineId=o.version.lines[0].id;
  const file=ok(await f.upload(o.version.id),201);
  const measured=ok(await f.measure(lineId,{desenDosyaId:file.id,designBoxPx:null}),201);
  assert.equal(measured.width_mm,280);assert.equal(measured.height_mm,120);assert.equal(measured.needsConfirmation,true);
  assert.equal(measured.application.width_mm,280);
  assert.equal(JSON.parse(measured.application.measure_source).desenDosyaId,file.id);
  const photo=ok(await f.measure(lineId,{imageKind:'photo'}),201);
  assert.equal(photo.needsConfirmation,true);assert.match(photo.reason,/Fotoğraf/);
  const confirmations=ok(await f.request('/teyitler',{token:f.token}));
  assert.ok(confirmations.some(c=>c.id===photo.confirmationId && c.kind==='olcu' && c.ref_id===photo.application.id));
  // Open measurements no longer stop the forms; they only block sending for approval.
  ok(await f.post(`/surumler/${o.version.id}/hazirla`));
  const blocked=await f.post(`/surumler/${o.version.id}/gonder`);
  assert.equal(blocked.status,409);assert.match(blocked.data.error,/ölçü teyidi/);
});

test('HTTP prepare generates four forms and one vector per application, is idempotent and supports immutable regeneration',async t=> {
  const f=await fixture(t), a=await prepared(f);
  for (const kind of ['uretim_formu','onay_formu','baski_formu','nakis_formu']) assert.equal(a.files.filter(file=>file.kind===kind).length,1);
  assert.equal(a.files.filter(file=>file.kind==='desen_vektor').length,2);
  for (const file of a.files.filter(f=>f.kind==='desen_vektor')) {
    const pdf=await PDFDocument.load(ok(await f.request(`/dosyalar/${file.id}`,{token:f.token})));
    const meta=f.db.prepare('SELECT application_id FROM document_file_meta WHERE file_id=?').get(file.id);
    const app=f.db.prepare('SELECT * FROM applications WHERE id=?').get(meta.application_id);
    assert.ok(Math.abs(pdf.getPage(0).getWidth()*25.4/72-app.width_mm)<0.01);
    assert.ok(Math.abs(pdf.getPage(0).getHeight()*25.4/72-app.height_mm)<0.01);
  }
  const again=ok(await f.post(`/surumler/${a.id}/hazirla`));assert.deepEqual(again,a.files);
  const oldBytes=new Map(a.files.map(file=>[file.path,fs.readFileSync(file.path)]));
  const regenerated=ok(await f.post(`/surumler/${a.id}/hazirla?yeniden=1`));
  assert.equal(regenerated.length,a.files.length);
  assert.notEqual(regenerated.find(f=>f.kind==='onay_formu').id,a.files.find(f=>f.kind==='onay_formu').id);
  for (const [filename,buffer] of oldBytes) assert.deepEqual(fs.readFileSync(filename),buffer);
  assert.ok(ok(await f.request('/teyitler',{token:f.token})).some(c=>c.kind==='vektor_kalite'));
});

test('HTTP open measurement still prepares forms (marked pending) but blocks sending; resolving it refreshes them',async t=> {
  const f=await fixture(t), o=await f.order();const file=ok(await f.upload(o.version.id),201);
  const measurement=ok(await f.measure(o.version.lines[0].id,{desenDosyaId:file.id,imageKind:'photo'}),201);
  const first=ok(await f.post(`/surumler/${o.version.id}/hazirla`));
  assert.ok(first.some(f=>f.kind==='uretim_formu'));assert.ok(first.some(f=>f.kind==='onay_formu'));
  assert.ok(!first.some(f=>f.kind==='baski_formu'||f.kind==='desen_vektor'));
  assert.equal((await f.post(`/surumler/${o.version.id}/gonder`)).status,409);
  ok(await f.post(`/teyitler/${measurement.confirmationId}/coz`));
  // The pending marker is part of the input fingerprint, so the stale forms must be regenerated.
  assert.equal((await f.post(`/surumler/${o.version.id}/hazirla`)).status,409);
  const files=ok(await f.post(`/surumler/${o.version.id}/hazirla?yeniden=1`));
  assert.ok(files.some(f=>f.kind==='onay_formu'));assert.ok(files.some(f=>f.kind==='baski_formu'));assert.ok(!files.some(f=>f.kind==='nakis_formu'));
});

test('HTTP submit requires approval form; unapproved package is blocked',async t=> {
  const f=await fixture(t), o=await f.order();
  const response=await f.post(`/surumler/${o.version.id}/gonder`);
  assert.equal(response.status,409);assert.match(response.data.error,/Onay formu/);
  assert.equal(f.db.prepare('SELECT status FROM order_versions WHERE id=?').get(o.version.id).status,'taslak');
  assert.equal((await f.request(`/surumler/${o.version.id}/atolye-paketi`,{token:f.token})).status,409);
});

test('HTTP approval package contains only workshop files, authenticated links and canonical outbox statuses',async t=> {
  const f=await fixture(t), a=await prepared(f);
  await resolveQuality(f);
  ok(await f.post(`/surumler/${a.id}/gonder`));
  assert.equal((await f.post(`/surumler/${a.id}/hazirla?yeniden=1`)).status,409);
  assert.equal((await f.post(`/surumler/${a.id}/onay`,{fileId:a.source.id},f.managerToken)).status,409);
  ok(await f.post(`/surumler/${a.id}/onay`,{fileId:a.files.find(file=>file.kind==='onay_formu').id},f.managerToken));
  ok(await f.post(`/surumler/${a.id}/onay`,{fileId:a.files.find(file=>file.kind==='onay_formu').id},f.managerToken));
  const bundle=ok(await f.request(`/surumler/${a.id}/atolye-paketi`,{token:f.token}));
  // G74: each traced raster design also sends its high resolution picture (desen_png).
  assert.equal(bundle.files.filter(file=>file.kind!=='desen_png').length,4);assert.equal(bundle.files.filter(file=>file.kind==='desen_png').length,2);assert.match(bundle.message,/MRC-T1/);assert.doesNotMatch(bundle.message,/Örnek Kulüp/);
  for (const file of bundle.files) {
    assert.ok(documents.WORKSHOP.includes(file.kind));assert.equal(file.outbox.status,'bekliyor');
    assert.equal(file.outbox.idempotency_key,`atolye:${a.id}:${file.id}`);
    assert.equal((await f.request(file.url.replace('/api/siparis',''),{token:f.token})).status,200);
  }
  assert.equal(f.db.prepare("SELECT count(*) n FROM outbox WHERE kind='atolye_dosya'").get().n,6);
  const vectors=bundle.files.filter(file=>file.kind==='desen_vektor');
  assert.equal(vectors.length,2);
  f.db.prepare("UPDATE outbox SET status='manuel_bekliyor' WHERE id=?").run(vectors[0].outbox.id);
  f.db.prepare("UPDATE outbox SET status='tamam' WHERE id=?").run(vectors[1].outbox.id);
  // A later legacy key with a matching payload must not override the canonical job.
  f.db.prepare("INSERT INTO outbox(kind,version_id,idempotency_key,payload_json,status) VALUES('atolye_dosya',?,?,?,'basarisiz')")
    .run(a.id,`legacy:${a.id}`,JSON.stringify({file:{id:vectors[0].id}}));
  const updated=ok(await f.request(`/surumler/${a.id}/atolye-paketi`,{token:f.token}));
  assert.equal(updated.files.find(file=>file.id===vectors[0].id).outbox.status,'manuel_bekliyor');
  assert.equal(updated.files.find(file=>file.id===vectors[1].id).outbox.status,'tamam');
  assert.equal(f.db.pragma('foreign_key_check').length,0);
});

test('workshop adapter honors manual mode and verifies stored SHA256 before automatic dispatch',async t=> {
  const oldAuto=process.env.OTOMATIK_GONDERIM, oldMode=process.env.WHATSAPP_MODE;
  t.after(()=> {for (const [k,v] of [['OTOMATIK_GONDERIM',oldAuto],['WHATSAPP_MODE',oldMode]]) {if (v===undefined) delete process.env[k];else process.env[k]=v;}});
  process.env.OTOMATIK_GONDERIM='1';process.env.WHATSAPP_MODE='manual';
  const f=await fixture(t), a=await prepared(f,{both:false});
  await resolveQuality(f);
  ok(await f.post(`/surumler/${a.id}/gonder`));
  ok(await f.post(`/surumler/${a.id}/onay`,{fileId:a.files.find(f=>f.kind==='onay_formu').id},f.managerToken));
  const job=await queue.runOnce(f.db,'atolye_dosya');assert.equal(job.status,'manuel_bekliyor');
  const manual=ok(await f.post(`/outbox/${job.id}/elle-gonderildi`,{providerRef:'örnek-elle'},f.managerToken));
  assert.equal(manual.status,'tamam');assert.equal(manual.provider_ref,'örnek-elle');
  const next=f.db.prepare("SELECT payload_json FROM outbox WHERE kind='atolye_dosya' AND status='bekliyor' ORDER BY id LIMIT 1").get();
  fs.writeFileSync(JSON.parse(next.payload_json).file.path,'altered');
  const failed=await queue.runOnce(f.db,'atolye_dosya');assert.equal(failed.status,'bekliyor');assert.match(failed.last_error,/SHA256/);
});

test('HTTP changed draft data requires regeneration before submission',async t=> {
  const f=await fixture(t), a=await prepared(f,{both:false});
  ok(await f.request(`/siparisler/${a.o.id}`,{method:'PATCH',body:{customer_name:'Örnek İkinci Kulüp'},token:f.token}));
  assert.equal((await f.post(`/surumler/${a.id}/hazirla`)).status,409);
  assert.equal((await f.post(`/surumler/${a.id}/gonder`)).status,409);
  ok(await f.post(`/surumler/${a.id}/hazirla?yeniden=1`));
  await resolveQuality(f);
  ok(await f.post(`/surumler/${a.id}/gonder`));
});

test('HTTP concurrent preparation does not create duplicate files',async t=> {
  const f=await fixture(t), o=await f.order();
  const source=ok(await f.upload(o.version.id),201);
  ok(await f.measure(o.version.lines[0].id,{desenDosyaId:source.id}),201);
  const results=await Promise.all([f.post(`/surumler/${o.version.id}/hazirla`),f.post(`/surumler/${o.version.id}/hazirla`)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  assert.equal(f.db.prepare("SELECT count(*) n FROM files WHERE version_id=? AND kind='onay_formu'").get(o.version.id).n,1);
});

test('HTTP regeneration rolls back registrations and removes partial new bytes on a persistence error',async t=> {
  const f=await fixture(t), a=await prepared(f,{both:false});
  const dir=path.dirname(a.source.path), before=fs.readdirSync(dir).sort();
  f.db.exec("CREATE TRIGGER belge_injected_failure BEFORE INSERT ON files WHEN NEW.kind='onay_formu' BEGIN SELECT RAISE(ABORT,'injected'); END");
  assert.equal((await f.post(`/surumler/${a.id}/hazirla?yeniden=1`)).status,409);
  const core=r=>({id:r.id,kind:r.kind,path:r.path,sha256:r.sha256});
  assert.deepEqual(f.db.prepare('SELECT * FROM files WHERE version_id=? ORDER BY id').all(a.id).map(core),a.files.map(core));
  assert.deepEqual(fs.readdirSync(dir).sort(),before);
  assert.equal(f.db.prepare('SELECT token FROM document_preparations WHERE version_id=?').get(a.id).token,null);
});

test('document initialization retires legacy queue shims idempotently and preserves core files',async t=> {
  const dir=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'belge-migration-'));
  const {openDb}=require('../agent/siparis/db');
  const db=openDb(path.join(dir,'test.sqlite'));
  t.after(()=> {db.close();fs.rmSync(dir,{recursive:true,force:true});});
  const user=await require('../agent/siparis/auth').createUser(db,{name:'Örnek',password:'test-password',role:'yonetici'});
  const orders=require('../agent/siparis/orders');
  const o=orders.createOrder(db,{order_no:'MRC-MIGRATION',lines:[{product_key:'tisort',quantity:1}]},user);
  const file=orders.addFile(db,o.version.id,{kind:'onay_formu',path:'/synthetic/onay.pdf',sha256:'a'.repeat(64)},user);
  db.prepare('INSERT INTO approvals(version_id,approved_by,approved_file_id) VALUES(?,?,?)').run(o.version.id,user.id,file.id);
  db.exec(`CREATE TABLE document_workshop_results(job_id INTEGER PRIMARY KEY, status TEXT);
    CREATE TRIGGER document_workshop_allowlist BEFORE INSERT ON outbox BEGIN SELECT 1; END;
    CREATE TRIGGER document_workshop_key AFTER INSERT ON outbox BEGIN SELECT 1; END;
    CREATE TRIGGER document_workshop_manual AFTER UPDATE OF status ON outbox BEGIN SELECT 1; END;`);
  documents.init(db);documents.init(db);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('document_workshop_allowlist','document_workshop_key','document_workshop_manual','document_workshop_results','document_files_migration')").all(),[]);
  assert.deepEqual(db.prepare('SELECT * FROM files WHERE id=?').get(file.id),file);
  assert.equal(db.prepare('SELECT approved_file_id FROM approvals').get().approved_file_id,file.id);
  assert.equal(db.pragma('foreign_keys',{simple:true}),1);assert.equal(db.pragma('foreign_key_check').length,0);
  orders.addFile(db,o.version.id,{kind:'desen_kaynak',path:'/synthetic/one.png',sha256:'b'.repeat(64)},user);
  orders.addFile(db,o.version.id,{kind:'desen_kaynak',path:'/synthetic/two.png',sha256:'c'.repeat(64)},user);
});

test('HTTP vector PDF and SVG sources are accepted; failed preparations leave no partial generated files',async t=> {
  const f=await fixture(t), o=await f.order();
  const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 60"><rect width="140" height="60" fill="#2350aa"/></svg>');
  const source=ok(await f.upload(o.version.id,{buffer:svg,name:'ornek.svg',mime:'image/svg+xml'}),201);
  ok(await f.measure(o.version.lines[0].id,{desenDosyaId:source.id}),201);
  ok(await f.post(`/surumler/${o.version.id}/hazirla`));
  const bad=await f.order();const badSource=ok(await f.upload(bad.version.id,{name:'bad.pdf',mime:'application/pdf',buffer:Buffer.from('%PDF-broken')}),201);
  ok(await f.measure(bad.version.lines[0].id,{desenDosyaId:badSource.id}),201);
  assert.equal((await f.post(`/surumler/${bad.version.id}/hazirla`)).status,500);
  assert.equal(f.db.prepare('SELECT count(*) n FROM files WHERE version_id=?').get(bad.version.id).n,1);
  assert.equal(f.db.prepare('SELECT token FROM document_preparations WHERE version_id=?').get(bad.version.id).token,null);
});

// G14 regression cases: synthetic inputs, isolated database, real HTTP boundaries.
async function resolveQuality(f) {
  for (const c of f.db.prepare("SELECT id FROM confirmations WHERE kind='vektor_kalite' AND status='acik'").all())
    ok(await f.post(`/teyitler/${c.id}/coz`));
}
test('G14-1 JSON registration rejects generated kinds, cross-version paths, duplicates and non-drafts',async t=> {
  const f=await fixture(t), o=await f.order(), v1=o.version.id;
  const source=ok(await f.upload(v1),201);
  for (const kind of ['onay_formu','uretim_formu','baski_formu','nakis_formu','desen_vektor'])
    assert.equal((await f.post(`/surumler/${v1}/dosyalar`,{kind,path:source.path})).status,403);
  assert.equal((await f.post(`/surumler/${v1}/dosyalar`,{kind:'desen_kaynak',path:source.path})).status,409);
  const v2=ok(await f.post(`/surumler/${v1}/revizyon`),201);
  assert.equal((await f.post(`/surumler/${v2.id}/dosyalar`,{kind:'desen_kaynak',path:source.path})).status,403);
  const local=ok(await f.upload(v2.id),201), extra=path.join(path.dirname(local.path),'extra.png');fs.writeFileSync(extra,designPng());
  ok(await f.post(`/surumler/${v2.id}/dosyalar`,{kind:'desen_kaynak',path:extra}),201);
  f.db.prepare("UPDATE order_versions SET status='onay_bekliyor' WHERE id=?").run(v2.id);
  assert.equal((await f.post(`/surumler/${v2.id}/dosyalar`,{kind:'desen_kaynak',path:extra})).status,409);
});
test('G14-2 revision is editable, carries open/resolved measurements and prepares v2 forms',async t=> {
  const f=await fixture(t), o=await f.order(), line=o.version.lines[0];
  const open=ok(await f.measure(line.id,{imageKind:'photo'}),201);
  const resolved=ok(await f.measure(line.id,{imageKind:'photo'}),201);
  ok(await f.post(`/teyitler/${resolved.confirmationId}/coz`));
  const v2=ok(await f.post(`/surumler/${o.version.id}/revizyon`),201);
  assert.equal(v2.status,'taslak');
  assert.equal(f.db.prepare('SELECT status FROM order_versions WHERE id=?').get(o.version.id).status,'eski');
  const apps=v2.lines[0].applications;
  for (const [i,status] of ['acik','cozuldu'].entries())
    assert.equal(f.db.prepare("SELECT status FROM confirmations WHERE kind='olcu' AND ref_table='applications' AND ref_id=?").get(apps[i].id)?.status,status);
  // G61: a print without a design file (or a size) no longer stops the forms; only its vector is missing.
  const waiting=ok(await f.post(`/surumler/${v2.id}/hazirla`));
  assert.match(waiting.find(x=>x.kind==='onay_formu').path,/\/v2\//);
  assert.equal(waiting.filter(x=>x.kind==='desen_vektor').length,0);
  const pending=f.db.prepare("SELECT id FROM confirmations WHERE ref_table='applications' AND ref_id=? AND status='acik'").get(apps[0].id);
  ok(await f.post(`/teyitler/${pending.id}/coz`));ok(await f.upload(v2.id),201);
  const files=ok(await f.post(`/surumler/${v2.id}/hazirla?yeniden=1`));
  assert.match(files.find(x=>x.kind==='onay_formu').path,/\/v2\//);
  assert.equal(files.filter(x=>x.kind==='desen_vektor').length,2);
});
test('G14-4 open vector quality blocks both submit and approval until resolved',async t=> {
  const f=await fixture(t), a=await prepared(f,{both:false});
  // A simple thick source can now be good; make the open-confirmation precondition explicit.
  f.db.prepare("INSERT INTO confirmations(kind,ref_table,ref_id,message) VALUES('vektor_kalite','files',?,'review')")
    .run(a.files.find(x=>x.kind==='desen_vektor').id);
  assert.equal((await f.post(`/surumler/${a.id}/gonder`)).status,409);
  const fileId=a.files.find(x=>x.kind==='onay_formu').id;
  assert.equal((await f.post(`/surumler/${a.id}/onay`,{fileId},f.managerToken)).status,409);
  await resolveQuality(f);ok(await f.post(`/surumler/${a.id}/gonder`));
  const vector=a.files.find(x=>x.kind==='desen_vektor');
  f.db.prepare("INSERT INTO confirmations(kind,ref_table,ref_id,message) VALUES('vektor_kalite','files',?,'review')").run(vector.id);
  assert.equal((await f.post(`/surumler/${a.id}/onay`,{fileId},f.managerToken)).status,409);
  await resolveQuality(f);ok(await f.post(`/surumler/${a.id}/onay`,{fileId},f.managerToken));
});
test('G14-4 pending preview is reassessed from source at target size and blocks final approval',async t=> {
  const f=await fixture(t),o=await f.order(),id=o.version.id;
  const canvas=require('@napi-rs/canvas').createCanvas(200,100),ctx=canvas.getContext('2d');
  ctx.fillStyle='#102060';ctx.fillRect(10,10,180,3);ctx.fillRect(10,10,3,80);ctx.fillRect(80,10,3,80);
  const source=ok(await f.upload(id,{buffer:canvas.toBuffer('image/png')}),201);
  await documents.settled();
  const preview=f.db.prepare('SELECT report_json FROM document_vector_previews WHERE source_file_id=?').get(source.id);
  assert.equal(JSON.parse(preview.report_json).quality,'beklemede');
  assert.equal(f.db.prepare("SELECT count(*) n FROM confirmations WHERE kind='vektor_kalite' AND status='acik'").get().n,0);
  ok(await f.measure(o.version.lines[0].id,{kind:'nakis',position:'gogus',desenDosyaId:source.id,
    refLengthPx:180,refLengthCm:1.8,designBoxPx:{w:180,h:80}}),201);
  const files=ok(await f.post(`/surumler/${id}/hazirla`));
  const confirmation=f.db.prepare("SELECT message FROM confirmations WHERE kind='vektor_kalite' AND status='acik'").get();
  assert.ok(confirmation);const report=JSON.parse(confirmation.message.slice(confirmation.message.indexOf('{')));
  assert.equal(report.rasterQuality.measurementSize,'target');
  assert.equal(report.rasterQuality.applicationType,'nakis');
  assert.ok(report.rasterQuality.minLineMm<=.31);
  assert.equal((await f.post(`/surumler/${id}/gonder`)).status,409);
  assert.equal((await f.post(`/surumler/${id}/onay`,{fileId:files.find(x=>x.kind==='onay_formu').id},f.managerToken)).status,409);
});
// G53: a manual vector is judged like any drawn vector; this one fits the 280 x 120 mm target, so nothing opens.
test('G14-4 manual vector source replaces traced artwork without an automatic quality confirmation',async t=> {
  const f=await fixture(t), a=await prepared(f,{both:false});
  const oldVector=a.files.find(x=>x.kind==='desen_vektor');
  const oldConfirmation=f.db.prepare("INSERT INTO confirmations(kind,ref_table,ref_id,message) VALUES('vektor_kalite','files',?,'old source review')").run(oldVector.id).lastInsertRowid;
  const pdf=await PDFDocument.create();pdf.addPage([300,200]).drawRectangle({x:80,y:70,width:140,height:60});
  const source=ok(await f.upload(a.id,{kind:'desen_kaynak_vektor',name:'vectorizer.pdf',mime:'application/pdf',buffer:Buffer.from(await pdf.save())}),201);
  const app=f.db.prepare('SELECT id FROM applications WHERE line_id=?').get(a.lineId);
  ok(await f.request(`/uygulamalar/${app.id}`,{method:'PATCH',token:f.token,body:{desenDosyaId:source.id}}));
  const files=ok(await f.post(`/surumler/${a.id}/hazirla?yeniden=1`));
  assert.equal(f.db.prepare("SELECT count(*) n FROM confirmations WHERE kind='vektor_kalite' AND status='acik'").get().n,0);
  assert.equal(f.db.prepare('SELECT status FROM confirmations WHERE id=?').get(oldConfirmation).status,'cozuldu');
  ok(await f.post(`/surumler/${a.id}/gonder`));assert.ok(files.some(x=>x.kind==='desen_vektor'));
});
test('G14-5 automatic source box always needs confirmation despite a flat reference',async t=> {
  const f=await fixture(t), o=await f.order(), source=ok(await f.upload(o.version.id),201);
  const result=ok(await f.measure(o.version.lines[0].id,{desenDosyaId:source.id,designBoxPx:null}),201);
  assert.equal(result.needsConfirmation,true);assert.ok(result.confirmationId);
});
test('G14-6 missing measure_source opens confirmation through HTTP and revision input',async t=> {
  const f=await fixture(t), o=await f.order(), input={kind:'baski',position:'sirt',width_mm:280,height_mm:120,needs_confirmation:false};
  const a=ok(await f.post(`/satirlar/${o.version.lines[0].id}/uygulamalar`,input),201);
  assert.equal(a.needs_confirmation,1);
  assert.equal(f.db.prepare("SELECT kind FROM confirmations WHERE ref_table='applications' AND ref_id=?").get(a.id)?.kind,'olcu');
  const v2=ok(await f.post(`/surumler/${o.version.id}/revizyon`,{lines:[{id:o.version.lines[0].id,applications:[input]}]}),201);
  assert.equal(v2.lines[0].applications[0].needs_confirmation,1);
  assert.equal(f.db.prepare("SELECT status FROM confirmations WHERE ref_table='applications' AND ref_id=?").get(v2.lines[0].applications[0].id)?.status,'acik');
});
test('G14-7 missing reference does not insert; draft applications can be remeasured and deleted',async t=> {
  const f=await fixture(t), o=await f.order(), line=o.version.lines[0];
  assert.equal((await f.measure(line.id,{refLengthPx:null,refLengthCm:null})).status,400);
  assert.equal(f.db.prepare('SELECT count(*) n FROM applications').get().n,0);
  const source=ok(await f.upload(o.version.id),201);
  const a=ok(await f.measure(line.id,{desenDosyaId:source.id,imageKind:'photo'}),201);
  const edited=ok(await f.request(`/uygulamalar/${a.application.id}`,{method:'PATCH',token:f.token,body:{refLengthPx:280,refLengthCm:56,designBoxPx:{w:100,h:50},imageKind:'flat'}}));
  assert.equal(edited.application.width_mm,200);assert.equal(edited.application.id,a.application.id);
  assert.equal(f.db.prepare("SELECT count(*) n FROM confirmations WHERE kind='olcu' AND status='acik'").get().n,0);
  ok(await f.post(`/surumler/${o.version.id}/hazirla`));
  ok(await f.request(`/uygulamalar/${a.application.id}`,{method:'DELETE',token:f.token}));
  assert.equal(f.db.prepare('SELECT count(*) n FROM applications').get().n,0);
  assert.equal((await f.post(`/surumler/${o.version.id}/gonder`)).status,409);
  assert.equal(f.db.pragma('foreign_key_check').length,0);
  const b=ok(await f.measure(line.id),201);
  f.db.prepare("UPDATE order_versions SET status='onay_bekliyor' WHERE id=?").run(o.version.id);
  for (const method of ['PATCH','DELETE']) assert.equal((await f.request(`/uygulamalar/${b.application.id}`,{method,token:f.token,body:{position:'gogus'}})).status,409);
});
test('G14-8 preparation supports absent distribution and nonstandard sizes',async t=> {
  const f=await fixture(t);
  for (const sizes of [undefined,{'5XL':1,'7-8 yaş':1}]) {
    const o=await f.order({lines:[{product_key:'tisort',quantity:2,sizes}]});
    const files=ok(await f.post(`/surumler/${o.version.id}/hazirla`));assert.ok(files.some(x=>x.kind==='onay_formu'));
  }
});
test('G14-9 PNG and JPEG header limits reject >40 MP with 413 before decoding',()=> {
  const png=Buffer.from(designPng());png.writeUInt32BE(10000,16);png.writeUInt32BE(5000,20);
  const jpeg=Buffer.from([255,216,255,192,0,17,8,0x13,0x88,0x27,0x10,3,1,0x11,0,2,0x11,0,3,0x11,0,255,217]);
  for (const [buffer,originalname,mimetype] of [[png,'huge.png','image/png'],[jpeg,'huge.jpg','image/jpeg']])
    assert.throws(()=>documents.validateUpload({buffer,originalname,mimetype}),e=>e.status===413);
});
test('G14-9 rendering serializes jobs, releases after failure and bounds the complete deadline below its lease',async()=> {
  let active=0,max=0;
  const queue=documents.createRenderQueue({timeoutMs:100,lockMs:200});
  const run=async()=> {active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,10));active--;};
  await Promise.all([queue(run),queue(run),queue(run)]);assert.equal(max,1);
  await assert.rejects(queue(async()=> {throw Error('fixture');}),/fixture/);
  await queue(run);
  const short=documents.createRenderQueue({timeoutMs:10,lockMs:30});
  await assert.rejects(short(signal=>new Promise(resolve=>signal.addEventListener('abort',resolve))),/zaman aşımına/);
  await short(async()=>{});
  assert.throws(()=>documents.createRenderQueue({timeoutMs:100,lockMs:50}),/kilit/);
});
test('G14-10 document date uses Istanbul at the UTC day boundary',()=> {
  assert.equal(documents.documentDate(new Date('2026-11-18T22:30:00Z')),'19.11.2026');
});
test('G14-11 slash order number is safely encoded and visible number stays intact',async t=> {
  const f=await fixture(t), o=await f.order({order_no:'MRC/2026-01'});
  const source=ok(await f.upload(o.version.id),201);
  assert.match(source.path,/\/files\/[^/]+\/v1\//);
  assert.equal(f.db.prepare('SELECT order_no FROM orders WHERE id=?').get(o.id).order_no,'MRC/2026-01');
  ok(await f.measure(o.version.lines[0].id,{desenDosyaId:source.id}),201);
  ok(await f.post(`/surumler/${o.version.id}/hazirla`)).find(x=>x.kind==='onay_formu');
});
test('G14-12 approval accepts a string fileId',async t=> {
  const f=await fixture(t), o=await f.order();
  const files=ok(await f.post(`/surumler/${o.version.id}/hazirla`));
  ok(await f.post(`/surumler/${o.version.id}/gonder`));
  ok(await f.post(`/surumler/${o.version.id}/onay`,{fileId:String(files.find(x=>x.kind==='onay_formu').id)},f.managerToken));
});

test('G14-7 source changes invalidate prepared forms even for confirmed manual measurements',async t=> {
  const f=await fixture(t), o=await f.order(), id=o.version.id, lineId=o.version.lines[0].id;
  const first=ok(await f.upload(id),201), second=ok(await f.upload(id),201);
  const app=ok(await f.post(`/satirlar/${lineId}/uygulamalar`,{kind:'baski',position:'sirt',width_mm:280,height_mm:120}),201);
  const patch=body=>f.request(`/uygulamalar/${app.id}`,{method:'PATCH',token:f.token,body});
  ok(await patch({desenDosyaId:first.id}));
  const confirmation=f.db.prepare("SELECT id FROM confirmations WHERE kind='olcu' AND ref_id=? AND status='acik'").get(app.id);
  ok(await f.post(`/teyitler/${confirmation.id}/coz`));
  ok(await f.post(`/surumler/${id}/hazirla`));
  await resolveQuality(f);
  ok(await patch({desenDosyaId:second.id}));
  // Resolving the manual measurement must not make the old source's forms current.
  for (const c of f.db.prepare("SELECT id FROM confirmations WHERE kind='olcu' AND status='acik'").all())
    ok(await f.post(`/teyitler/${c.id}/coz`));
  assert.equal((await f.post(`/surumler/${id}/gonder`)).status,409);
});

test('G14-7 draft edits accept legacy text provenance and permit remeasurement',async t=> {
  const f=await fixture(t), o=await f.order();
  const app=ok(await f.post(`/satirlar/${o.version.lines[0].id}/uygulamalar`,
    {kind:'baski',position:'sirt',width_mm:280,height_mm:120,measure_source:'ekip ölçümü'}),201);
  ok(await f.request(`/uygulamalar/${app.id}`,{method:'PATCH',token:f.token,body:{position:'gogus'}}));
  const result=ok(await f.request(`/uygulamalar/${app.id}`,{method:'PATCH',token:f.token,
    body:{refLengthPx:280,refLengthCm:56,designBoxPx:{w:100,h:50},imageKind:'flat'}}));
  assert.equal(result.application.width_mm,200);
});
