'use strict';
const {test}=require('node:test');
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
  assert.equal((await f.request(`/duz-cizimler/${flat.id}/referans`,{method:'PUT',body:reference,token:f.token})).status,403);
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
  assert.equal(measured.width_mm,280);assert.equal(measured.height_mm,120);assert.equal(measured.needsConfirmation,false);
  assert.equal(measured.application.width_mm,280);
  assert.equal(JSON.parse(measured.application.measure_source).desenDosyaId,file.id);
  const photo=ok(await f.measure(lineId,{imageKind:'photo'}),201);
  assert.equal(photo.needsConfirmation,true);assert.match(photo.reason,/Fotoğraf/);
  const confirmations=ok(await f.request('/teyitler',{token:f.token}));
  assert.ok(confirmations.some(c=>c.id===photo.confirmationId && c.kind==='olcu' && c.ref_id===photo.application.id));
  const blocked=await f.post(`/surumler/${o.version.id}/hazirla`);
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

test('HTTP open measurement blocks prepare; resolving advisory values enables it',async t=> {
  const f=await fixture(t), o=await f.order();const file=ok(await f.upload(o.version.id),201);
  const measurement=ok(await f.measure(o.version.lines[0].id,{desenDosyaId:file.id,imageKind:'photo'}),201);
  assert.equal((await f.post(`/surumler/${o.version.id}/hazirla`)).status,409);
  ok(await f.post(`/teyitler/${measurement.confirmationId}/coz`));
  const files=ok(await f.post(`/surumler/${o.version.id}/hazirla`));
  assert.ok(files.some(f=>f.kind==='onay_formu'));assert.ok(!files.some(f=>f.kind==='nakis_formu'));
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
  ok(await f.post(`/surumler/${a.id}/gonder`));
  assert.equal((await f.post(`/surumler/${a.id}/hazirla?yeniden=1`)).status,409);
  assert.equal((await f.post(`/surumler/${a.id}/onay`,{fileId:a.source.id},f.managerToken)).status,409);
  ok(await f.post(`/surumler/${a.id}/onay`,{fileId:a.files.find(file=>file.kind==='onay_formu').id},f.managerToken));
  ok(await f.post(`/surumler/${a.id}/onay`,{fileId:a.files.find(file=>file.kind==='onay_formu').id},f.managerToken));
  const bundle=ok(await f.request(`/surumler/${a.id}/atolye-paketi`,{token:f.token}));
  assert.equal(bundle.files.length,4);assert.match(bundle.message,/MRC-T1/);assert.doesNotMatch(bundle.message,/Örnek Kulüp/);
  for (const file of bundle.files) {
    assert.ok(documents.WORKSHOP.includes(file.kind));assert.equal(file.outbox.status,'bekliyor');
    assert.equal(file.outbox.idempotency_key,`atolye:${a.id}:${file.id}`);
    assert.equal((await f.request(file.url.replace('/api/siparis',''),{token:f.token})).status,200);
  }
  assert.equal(f.db.prepare("SELECT count(*) n FROM outbox WHERE kind='atolye_dosya'").get().n,4);
  assert.equal(f.db.pragma('foreign_key_check').length,0);
});

test('workshop adapter honors manual mode and verifies stored SHA256 before automatic dispatch',async t=> {
  const oldAuto=process.env.OTOMATIK_GONDERIM, oldMode=process.env.WHATSAPP_MODE;
  t.after(()=> {for (const [k,v] of [['OTOMATIK_GONDERIM',oldAuto],['WHATSAPP_MODE',oldMode]]) {if (v===undefined) delete process.env[k];else process.env[k]=v;}});
  process.env.OTOMATIK_GONDERIM='1';process.env.WHATSAPP_MODE='manual';
  const f=await fixture(t), a=await prepared(f,{both:false});
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
  assert.deepEqual(f.db.prepare('SELECT * FROM files WHERE version_id=? ORDER BY id').all(a.id),a.files);
  assert.deepEqual(fs.readdirSync(dir).sort(),before);
  assert.equal(f.db.prepare('SELECT token FROM document_preparations WHERE version_id=?').get(a.id).token,null);
});

test('legacy file migration preserves existing approval references and is idempotent',async t=> {
  const dir=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'belge-migration-'));
  const {openDb}=require('../agent/siparis/db');
  const db=openDb(path.join(dir,'test.sqlite'));
  t.after(()=> {db.close();fs.rmSync(dir,{recursive:true,force:true});});
  const user=await require('../agent/siparis/auth').createUser(db,{name:'Örnek',password:'test-password',role:'yonetici'});
  const orders=require('../agent/siparis/orders');
  const o=orders.createOrder(db,{order_no:'MRC-MIGRATION',lines:[{product_key:'tisort',quantity:1}]},user);
  const file=orders.addFile(db,o.version.id,{kind:'onay_formu',path:'/synthetic/onay.pdf',sha256:'a'.repeat(64)},user);
  db.prepare('INSERT INTO approvals(version_id,approved_by,approved_file_id) VALUES(?,?,?)').run(o.version.id,user.id,file.id);
  documents.init(db);documents.init(db);
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
