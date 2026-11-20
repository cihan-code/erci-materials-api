'use strict';
// G39: the live order flow (front/back images, PDF/PNG designs, three applications). Synthetic data only.
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const childProcess=require('node:child_process');
const {PDFDocument,rgb}=require('pdf-lib');
const PDFKit=require('pdfkit');
const documents=require('../agent/siparis/documents');
const orders=require('../agent/siparis/orders');
const {openDb}=require('../agent/siparis/db');
const {createUser}=require('../agent/siparis/auth');
const {setup}=require('./fixtures/siparis/belge-fixture');
const {mockup}=require('./fixtures/siparis/oto-mockup');
const {multiMockup}=require('./fixtures/siparis/oto-multi');
const deadline=setTimeout(()=>{console.error('G39 test dosyası 150 saniyeyi aştı');process.exit(1);},150000);
deadline.unref();after(()=>clearTimeout(deadline));

const GENERIC='Uygulama ölçüsü teyit edilmeli';
const L={omuzdan_boy:112.2,etek:60};
async function fixture(t,options) {
  const f=await setup(options);
  t.after(async()=>{await documents.settled();await f.close();fs.rmSync(f.dir,{recursive:true,force:true});});
  return f;
}
function ok(r,status=200){assert.equal(r.status,status,JSON.stringify(r.data));return r.data;}
function addFlat(f,{product='tisort',view='on',id=product+view,ad='Sentetik '+product}={}) {
  const root=path.join(fs.realpathSync(f.dir),'siparis','flats');fs.mkdirSync(root,{recursive:true});
  const filename=path.join(root,id+'.png');fs.writeFileSync(filename,mockup({missing:true}).image);
  f.db.prepare('INSERT INTO document_flats(id,ad,urun,gorunum,dosya,refLengthCm,refLengthPx,refBeden,olculerL) VALUES(?,?,?,?,?,?,?,?,?)').run(id,ad,product,view,filename,60,300,'L',JSON.stringify(L));
}
async function rasterPdf(png) {
  const doc=await PDFDocument.create(),image=await doc.embedPng(png);
  doc.addPage([180,120]).drawImage(image,{x:0,y:0,width:180,height:120});return Buffer.from(await doc.save());
}
function vectorPdf() {
  return new Promise(resolve=>{const doc=new PDFKit({size:[200,100],margin:0}),chunks=[];
    doc.on('data',c=>chunks.push(c));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.rect(20,10,160,80).fill('#ec3156');doc.end();});
}
const SVG=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><rect x="20" y="10" width="160" height="80" fill="#25327c"/></svg>');
const status=async(f,v)=>ok(await f.request(`/surumler/${v}/vektor-durum`,{token:f.token}));
const openConfirmation=(f,appId)=>f.db.prepare("SELECT * FROM confirmations WHERE kind='olcu' AND ref_table='applications' AND ref_id=? AND status='acik'").all(appId);
const application=(f,id)=>f.db.prepare('SELECT * FROM applications WHERE id=?').get(id);

test('G39 PDF, PNG and SVG designs get a vector record with the upload and then a stated result',{timeout:90000},async t=>{
  const f=await fixture(t),o=await f.order(),v=o.version.id,line=o.version.lines[0].id,m=mockup();
  const uploads=[[m.design,'logo.png','image/png'],[await rasterPdf(m.design),'logo.pdf','application/pdf'],[await vectorPdf(),'vektor.pdf','application/pdf'],[SVG,'vektor.svg','image/svg+xml']];
  const ids=[];
  for(const [buffer,name,mime] of uploads) {
    const up=ok(await f.upload(v,{lineId:line,buffer,name,mime}),201);ids.push(up.id);
    // The record exists as soon as the upload answers, before any preview work finishes.
    const row=(await status(f,v)).find(r=>r.sourceFileId===up.id);
    assert.ok(row && ['hazirlaniyor','hazir','teyit'].includes(row.status),JSON.stringify(row));
  }
  await documents.settled();
  const rows=await status(f,v);
  assert.deepEqual(rows.map(r=>r.sourceFileId),ids);
  for(const row of rows){assert.ok(['hazir','teyit'].includes(row.status),JSON.stringify(row));assert.ok(row.previewFileId);}
  assert.deepEqual(rows.map(r=>r.sourceKind),['raster','raster','vector','vector']);
  // The PNG content box (160 × 90 inside transparent padding) gives the design ratio for manual sizing.
  const box=rows[0].designBox;assert.ok(Math.abs(box.w/box.h-160/90)<.05,JSON.stringify(box));
  assert.ok(Math.abs(rows[2].designBox.w/rows[2].designBox.h-2)<.05,JSON.stringify(rows[2].designBox));
});

test('G39 sources without a record or with a lost job are queued on the first read; other versions say yok',{timeout:60000},async t=>{
  const f=await fixture(t),o=await f.order(),v=o.version.id,line=o.version.lines[0].id,m=mockup();
  const a=ok(await f.upload(v,{lineId:line,buffer:m.design}),201),b=ok(await f.upload(v,{lineId:line,buffer:await rasterPdf(m.design),name:'b.pdf',mime:'application/pdf'}),201);
  await documents.settled();
  // a: uploaded before G25 (no row). b: a restart interrupted its job.
  f.db.prepare('DELETE FROM document_vector_previews WHERE source_file_id=?').run(a.id);
  f.db.prepare("UPDATE document_vector_previews SET status='hazirlaniyor',preview_file_id=NULL,report_json=NULL WHERE source_file_id=?").run(b.id);
  assert.equal(documents.vectorStatus(f.db,v).find(r=>r.sourceFileId===a.id).status,'yok');
  const first=await status(f,v);
  assert.deepEqual(first.map(r=>[r.sourceFileId,r.status]),[[a.id,'hazirlaniyor'],[b.id,'hazirlaniyor']]);
  await documents.settled();
  for(const row of await status(f,v))assert.ok(['hazir','teyit'].includes(row.status),JSON.stringify(row));
  // A version that is no longer a draft cannot receive a preview file; the gap is stated.
  f.db.prepare('DELETE FROM document_vector_previews WHERE source_file_id=?').run(a.id);
  f.db.prepare("UPDATE order_versions SET status='onay_bekliyor' WHERE id=?").run(v);
  const row=(await status(f,v)).find(r=>r.sourceFileId===a.id);
  assert.equal(row.status,'yok');assert.match(row.message,/taslak olmadığı/);
  await documents.settled();
  assert.equal(f.db.prepare('SELECT count(*) n FROM document_vector_previews WHERE source_file_id=?').get(a.id).n,0);
});

test('G39 automatic measurement runs after uploads and applications, images first or last',{timeout:90000},async t=>{
  const f=await fixture(t),o=await f.order(),v=o.version.id,line=o.version.lines[0].id;
  addFlat(f);addFlat(f,{view:'arka'});
  const front=mockup({position:'gogus'}),back=mockup({position:'sirt'});
  ok(await f.upload(v,{kind:'urun_gorsel',lineId:line,gorunum:'on',buffer:front.image}),201);
  const chest=ok(await f.upload(v,{lineId:line,buffer:await rasterPdf(front.design),name:'gogus.pdf',mime:'application/pdf'}),201);
  const app=ok(await f.post(`/satirlar/${line}/uygulamalar`,{kind:'nakis',position:'gogus',desenDosyaId:chest.id,measure_source:JSON.stringify({desenDosyaId:chest.id}),needs_confirmation:1}),201);
  assert.ok(Math.abs(app.width_mm-front.expectedWidth)<=6,JSON.stringify(app));assert.equal(app.needs_confirmation,0);
  // The back image arrives after its application: the image upload triggers the measurement.
  const back1=ok(await f.upload(v,{lineId:line,buffer:back.design,name:'sirt.png'}),201);
  const backApp=ok(await f.post(`/satirlar/${line}/uygulamalar`,{kind:'baski',position:'sirt',desenDosyaId:back1.id}),201);
  assert.equal(backApp.width_mm,null);assert.match(openConfirmation(f,backApp.id)[0].message,/^Arka görünüm için ürün görseli yok/);
  ok(await f.upload(v,{kind:'urun_gorsel',lineId:line,gorunum:'arka',buffer:back.image}),201);
  const measured=application(f,backApp.id);
  assert.ok(Math.abs(measured.width_mm-back.expectedWidth)<=6,JSON.stringify(measured));assert.equal(openConfirmation(f,backApp.id).length,0);
  assert.ok(f.db.prepare("SELECT count(*) n FROM audit_log WHERE action='uygulama_otomatik_olc' AND ref=?").get(String(backApp.id)).n>=1);
});

test('G40 bağlı hazır PDF ve SVG vektörleri renk adayının oranını sınar',{timeout:45000},async t=>{
  const f=await fixture(t),o=await f.order({lines:[{product_key:'sweat',quantity:1}]}),v=o.version.id,line=o.version.lines[0].id;
  addFlat(f,{product:'sweat',view:'arka'});
  f.db.prepare('UPDATE document_flats SET olculerL=?').run(JSON.stringify({omuzdan_boy:71,etek:52,gogus:61,tum_omuz:61.5}));
  ok(await f.upload(v,{kind:'urun_gorsel',lineId:line,gorunum:'arka',buffer:multiMockup().image}),201);
  const pdf=await PDFDocument.create(),page=pdf.addPage([180,80]);
  const shapes=[[20,6,10,45],[36,7,15,7],[26,45,9,6]];
  for(const [x,y,width,height] of shapes)page.drawRectangle({x,y,width,height,color:rgb(1,1,1)});
  const rects=shapes.map(([x,y,w,h])=>`<rect x="${x}" y="${80-y-h}" width="${w}" height="${h}" fill="white"/>`).join('');
  const svg=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="180" height="80" viewBox="0 0 180 80">${rects}</svg>`);
  for(const [buffer,mime,ext] of [[Buffer.from(await pdf.save()),'application/pdf','pdf'],[svg,'image/svg+xml','svg']]) {
    const file=ok(await f.upload(v,{kind:'desen_kaynak_vektor',lineId:line,buffer,mime,name:`baski.${ext}`}),201);
    const app=ok(await f.post(`/satirlar/${line}/uygulamalar`,{kind:'baski',position:'sirt',desenDosyaId:file.id}),201);
    const source=JSON.parse(app.measure_source);
    assert.equal(source.desenFileId,file.id);
    assert.ok(Math.abs(source.designAspectRatio-31/45)<.04,JSON.stringify(source));
    assert.equal(app.width_mm,null);assert.equal(app.height_mm,null);assert.equal(source.designBoxPx,null);
    assert.match(openConfirmation(f,app.id)[0].message,/en-boy oranı .* uyuşmuyor/);
  }
});

test('G39 an application that cannot be measured states the concrete reason, never only the generic text',{timeout:90000},async t=>{
  const f=await fixture(t),o=await f.order(),v=o.version.id,line=o.version.lines[0].id,m=mockup();
  const design=ok(await f.upload(v,{lineId:line,buffer:m.design}),201);
  const sleeve=ok(await f.post(`/satirlar/${line}/uygulamalar`,{kind:'nakis',position:'kol',desenDosyaId:design.id,measure_source:'{}',needs_confirmation:1}),201);
  const [reason]=openConfirmation(f,sleeve.id);
  assert.match(reason.message,/^Kol görünümü için ürün görseli yok: kol, ön veya arka görsel yüklenmedi/);assert.notEqual(reason.message,GENERIC);
  assert.ok(f.db.prepare("SELECT count(*) n FROM audit_log WHERE action='uygulama_olcu_gerekce' AND ref=?").get(String(sleeve.id)).n===1);
  // A sleeve view is now measured first; this image has only a chest design.
  ok(await f.upload(v,{kind:'urun_gorsel',lineId:line,gorunum:'kol',buffer:m.image}),201);
  assert.match(openConfirmation(f,sleeve.id)[0].message,/^Kol konumu ayrı kol görselde ölçülemedi/);
  // The dedicated sleeve view keeps priority when a front view is uploaded later.
  addFlat(f);
  ok(await f.upload(v,{kind:'urun_gorsel',lineId:line,gorunum:'on',buffer:mockup({missing:true}).image}),201);
  const after=application(f,sleeve.id);assert.equal(after.width_mm,null);
  assert.match(openConfirmation(f,sleeve.id)[0].message,/^Kol konumu ayrı kol görselde ölçülemedi: /);
  assert.equal(openConfirmation(f,sleeve.id).length,1);
});

test('G39b two L patterns without a unique base name require explicit selection',{timeout:60000},async t=>{
  const f=await fixture(t),o=await f.order(),v=o.version.id,line=o.version.lines[0].id,m=mockup();
  addFlat(f,{id:'normal',ad:'TİŞÖRT özel'});addFlat(f,{id:'oversize',ad:'Oversize Tişört'});
  ok(await f.upload(v,{kind:'urun_gorsel',lineId:line,gorunum:'on',buffer:m.image}),201);
  const design=ok(await f.upload(v,{lineId:line,buffer:m.design}),201);
  const app=ok(await f.post(`/satirlar/${line}/uygulamalar`,{kind:'baski',position:'gogus',desenDosyaId:design.id}),201);
  assert.equal(app.width_mm,null);
  const [c]=openConfirmation(f,app.id);
  assert.match(c.message,/^Bu ürün için birden çok kalıp var; kalıbı seçin/);
  assert.doesNotMatch(c.message,/L kalıp referansı bulunamadı/);
});

test('G39 a measurement that cannot run at all leaves its reason on the confirmation',{timeout:60000},async t=>{
  const f=await fixture(t),o=await f.order(),v=o.version.id,line=o.version.lines[0].id,m=mockup();
  const design=ok(await f.upload(v,{lineId:line,buffer:m.design}),201);
  // Lock the version in the same transaction that registers the application, as a concurrent preparation would.
  f.db.exec(`CREATE TEMP TRIGGER g39_lock AFTER INSERT ON applications BEGIN
    INSERT INTO document_preparations(version_id,token,started_at) VALUES(${v},'kilit',${Date.now()}) ON CONFLICT(version_id) DO UPDATE SET token='kilit'; END`);
  const app=ok(await f.post(`/satirlar/${line}/uygulamalar`,{kind:'baski',position:'gogus',desenDosyaId:design.id}),201);
  assert.match(app.olcuHatasi,/Otomatik ölçü şimdi çalışmadı/);
  assert.match(openConfirmation(f,app.id)[0].message,/^Otomatik ölçü çalışmadı: Sürüm hazırlanıyor/);
});

test('G39 manual save stores the size for the person and closes that confirmation',{timeout:60000},async t=>{
  const f=await fixture(t),o=await f.order(),v=o.version.id,line=o.version.lines[0].id,m=mockup();addFlat(f);
  const design=ok(await f.upload(v,{lineId:line,buffer:m.design}),201);
  const app=ok(await f.post(`/satirlar/${line}/uygulamalar`,{kind:'baski',position:'gogus',desenDosyaId:design.id}),201);
  const [open]=openConfirmation(f,app.id);assert.ok(open);
  const patch=body=>f.request(`/uygulamalar/${app.id}`,{method:'PATCH',token:f.token,body});
  for(const body of [{width_mm:250,height_mm:120,elleTeyit:false},{width_mm:250,elleTeyit:true},{width_mm:250,height_mm:0,elleTeyit:true},{width_mm:250,height_mm:120,elleTeyit:true,kind:'nakis'}])
    assert.equal((await patch(body)).status,400,JSON.stringify(body));
  const saved=ok(await patch({width_mm:250,height_mm:141,elleTeyit:true})).application;
  assert.deepEqual([saved.width_mm,saved.height_mm,saved.needs_confirmation],[250,141,0]);
  assert.equal(JSON.parse(saved.measure_source).method,'elle');
  const closed=f.db.prepare('SELECT * FROM confirmations WHERE id=?').get(open.id);
  assert.equal(closed.status,'cozuldu');assert.equal(closed.resolved_by,f.team.id);
  const entry=f.db.prepare("SELECT * FROM audit_log WHERE action='uygulama_elle_olcu' AND ref=?").get(String(app.id));
  assert.equal(entry.user_id,f.team.id);assert.deepEqual(JSON.parse(entry.detail_json),{width_mm:250,height_mm:141,onceki:{width_mm:null,height_mm:null}});
  assert.equal(documents.openMeasurements(f.db,v).length,0);
  // A later image upload measures automatically, but never over the person's size.
  ok(await f.upload(v,{kind:'urun_gorsel',lineId:line,gorunum:'on',buffer:m.image}),201);
  assert.deepEqual([application(f,app.id).width_mm,application(f,app.id).height_mm],[250,141]);
  assert.doesNotThrow(()=>documents.assertMeasurements(f.db,orders.snapshot(f.db,v)));
});

test('G39 applications registered by the old server are measured on request with their recorded design',{timeout:60000},async t=>{
  const f=await fixture(t),o=await f.order(),v=o.version.id,line=o.version.lines[0].id,m=mockup();addFlat(f);
  ok(await f.upload(v,{kind:'urun_gorsel',lineId:line,gorunum:'on',buffer:m.image}),201);
  const design=ok(await f.upload(v,{lineId:line,buffer:m.design}),201);
  // Before G24 the panel's call reached the core route: provenance only, generic confirmation, no link.
  const old=orders.addApplication(f.db,line,{kind:'baski',position:'gogus',measure_source:JSON.stringify({desenDosyaId:design.id,dosyaAdi:'logo.png'}),needs_confirmation:1},f.team);
  assert.equal(openConfirmation(f,old.id)[0].message,GENERIC);
  const {results}=ok(await f.post(`/surumler/${v}/otomatik-olc?degisen=1`));
  assert.deepEqual(results.map(r=>r.applicationId),[old.id]);
  const measured=application(f,old.id);
  assert.ok(Math.abs(measured.width_mm-m.expectedWidth)<=6,JSON.stringify(measured));assert.equal(JSON.parse(measured.measure_source).desenFileId,design.id);
  assert.equal(f.db.prepare('SELECT file_id FROM document_application_sources WHERE application_id=?').get(old.id).file_id,design.id);
  // Unchanged inputs are not measured again.
  assert.equal(ok(await f.post(`/surumler/${v}/otomatik-olc?degisen=1`)).results.length,0);
});

test('G39 an older file metadata table is rebuilt once so sleeve images can be stored',{timeout:30000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'siparis-g39-'));
  const db=openDb(path.join(dir,'siparis.sqlite')),user=await createUser(db,{name:'Eski Kullanıcı',password:'synthetic-password'});
  const order=orders.createOrder(db,{order_no:'ESKI-1',lines:[{product_key:'tisort',quantity:1}]},user);
  const file=orders.addFile(db,order.version.id,{kind:'urun_gorsel',path:'/eski/on.png',sha256:'a'.repeat(64)},user);
  db.exec(`CREATE TABLE document_file_meta (file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
    line_id INTEGER REFERENCES order_lines(id), application_id INTEGER REFERENCES applications(id),
    gorunum TEXT CHECK(gorunum IN ('on','arka')), mime TEXT NOT NULL)`);
  db.prepare("INSERT INTO document_file_meta(file_id,line_id,gorunum,mime) VALUES(?,?,'on','image/png')").run(file.id,order.version.lines[0].id);
  db.close();
  const f=await fixture(t,{dataDir:dir});
  assert.deepEqual(f.db.prepare('SELECT file_id,gorunum FROM document_file_meta').all(),[{file_id:file.id,gorunum:'on'}]);
  assert.match(f.db.prepare("SELECT sql FROM sqlite_master WHERE name='document_file_meta'").get().sql,/'kol'/);
  documents.init(f.db);
  const o=await f.order(),v=o.version.id,line=o.version.lines[0].id;
  ok(await f.upload(v,{kind:'urun_gorsel',lineId:line,gorunum:'kol',buffer:mockup().image}),201);
  assert.equal((await f.upload(v,{kind:'urun_gorsel',lineId:line,gorunum:'yan',buffer:mockup().image})).status,400);
  assert.equal(orders.snapshot(f.db,v).files.find(x=>x.kind==='urun_gorsel').gorunum,'kol');
});

test('G39 a server that cannot load the vectorizer says so on the record',{timeout:60000},async t=>{
  const f=await fixture(t),o=await f.order(),v=o.version.id,line=o.version.lines[0].id;
  const preload=path.join(f.dir,'vektor-yok.cjs');
  fs.writeFileSync(preload,`const Module=require('node:module'),load=Module._load;
Module._load=function(request,parent,...rest){if(request==='./vector'&&parent?.filename?.endsWith('documents.js')){const e=new Error('Cannot find native binding\\nayrıntı');e.code='ERR_DLOPEN_FAILED';throw e;}return load.call(this,request,parent,...rest);};`);
  const fork=childProcess.fork;
  t.mock.method(childProcess,'fork',(file,args,options)=>fork(file,args,{...options,execArgv:['--require',preload]}));
  const up=ok(await f.upload(v,{lineId:line,buffer:mockup().design}),201);
  await documents.settled();t.mock.restoreAll();
  const row=(await status(f,v)).find(r=>r.sourceFileId===up.id);
  assert.equal(row.status,'hata');assert.equal(row.message,'Vektörleştirme bu sunucuda yok: Cannot find native binding');
});
