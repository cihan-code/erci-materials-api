'use strict';
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {PDFDocument,rgb}=require('pdf-lib');
const auto=require('../agent/siparis/autoMeasure');
const documents=require('../agent/siparis/documents');
const {setup}=require('./fixtures/siparis/belge-fixture');
const {mockup}=require('./fixtures/siparis/oto-mockup');
// A hang guard, not a speed test: about twice the half-file time measured under a full parallel run (82-91 s).
const deadline=setTimeout(()=>{console.error('G24 test dosyası 180 saniyeyi aştı');process.exit(1);},180000);
deadline.unref();after(()=>clearTimeout(deadline));
const flat={id:'test',ad:'Sentetik kalıp',refBeden:'L',refLengthCm:60,olculerL:{omuzdan_boy:112.2,etek:60}};
const input=(m,extra={})=>({image:{id:1,buffer:m.image,mime:'image/png'},design:{id:2,buffer:m.design,mime:'image/png'},flat,product:'tisort',position:'gogus',...extra});
async function fixture(t) {const f=await setup();t.after(async()=>{await f.close();fs.rmSync(f.dir,{recursive:true,force:true});});return f;}
function ok(r,status=200){assert.equal(r.status,status,JSON.stringify(r.data));return r.data;}
function addFlat(f,product='tisort',view='on',id=product+view,refBeden='L') {
  const path=require('node:path'),root=path.join(fs.realpathSync(f.dir),'siparis','flats');fs.mkdirSync(root,{recursive:true});
  const filename=path.join(root,id+'.png');fs.writeFileSync(filename,mockup({missing:true}).image);
  f.db.prepare('INSERT INTO document_flats(id,ad,urun,gorunum,dosya,refLengthCm,refLengthPx,refBeden,olculerL) VALUES(?,?,?,?,?,?,?,?,?)').run(id,'Sentetik '+product,product,view,filename,60,300,refBeden,JSON.stringify(flat.olculerL));
}
test('G24 position/view contract includes every key and unknown positions need confirmation',()=>{
  for(const key of ['gogus','sol_gogus','sag_gogus','kol','sol_kol','sag_kol'])assert.equal(auto.viewForPosition(key),'on');
  for(const key of ['sirt','ense','kapusan'])assert.equal(auto.viewForPosition(key),'arka');
  assert.equal(auto.viewForPosition('kapuson'),'teyit');assert.equal(auto.viewForPosition('bilinmeyen'),'teyit');
});
for(const position of ['gogus','sirt'])test(`G24 synthetic ${position} measures content within 5 mm`,async()=>{
  const m=mockup({position}),r=await auto.autoMeasure(input(m,{position}));
  assert.ok(Math.abs(r.width_mm-m.expectedWidth)<=5,JSON.stringify(r));
  assert.ok(Math.abs(r.height_mm-m.expectedHeight)<=5,JSON.stringify(r));
  assert.equal(r.needs_confirmation,false,JSON.stringify(r));assert.equal(r.measure_source.refBeden,'L');
});
test('G24 absent design, ambiguity, unknown view and missing flat require Turkish confirmation',async()=>{
  for(const [m,extra] of [[mockup({missing:true}),{}],[mockup({repeated:true}),{}],[mockup(),{position:'other'}],[mockup(),{flat:null}]]) {
    const r=await auto.autoMeasure(input(m,extra));assert.equal(r.needs_confirmation,true,JSON.stringify(r));assert.ok(r.reason.length>10);
  }
});
test('G24 PDF first page and JPEG support; invalid and oversized images require confirmation',async()=>{
  const m=mockup(),pdf=await PDFDocument.create(),im=await pdf.embedPng(m.image);pdf.addPage([600,650]).drawImage(im,{x:0,y:0,width:600,height:650});pdf.addPage([200,200]);
  const r=await auto.autoMeasure(input(m,{image:{id:1,buffer:Buffer.from(await pdf.save()),mime:'application/pdf'}}));
  assert.ok(Math.abs(r.width_mm-m.expectedWidth)<=5,JSON.stringify(r));
  const {createCanvas,loadImage}=require('@napi-rs/canvas'),c=createCanvas(600,650);c.getContext('2d').drawImage(await loadImage(m.image),0,0);
  const jpg=await auto.autoMeasure(input(m,{image:{buffer:c.toBuffer('image/jpeg'),mime:'image/jpeg'}}));assert.ok(Math.abs(jpg.width_mm-m.expectedWidth)<=5,JSON.stringify(jpg));
  const bad=Buffer.from(m.image);bad.writeUInt32BE(100000,16);
  await assert.rejects(auto.raster({buffer:bad,mime:'image/png'}),/40 megapiksel/);
  assert.equal((await auto.autoMeasure(input(m,{image:{buffer:Buffer.from('bad'),mime:'image/png'}}))).needs_confirmation,true);
});
test('G24 two lines/two views match only explicitly linked source and own product reference',async t=>{
  const f=await fixture(t),o=await f.order({lines:[{product_key:'tisort',quantity:1},{product_key:'polo',quantity:1}]}),v=o.version.id;
  for(const product of ['tisort','polo'])for(const view of ['on','arka'])addFlat(f,product,view);
  const apps=[];
  for(const [i,line] of o.version.lines.entries()) for(const [view,position] of [['on','gogus'],['arka','sirt']]) {
    const m=mockup({width:i?90:120,position});
    ok(await f.upload(v,{kind:'urun_gorsel',lineId:line.id,gorunum:view,buffer:m.image}),201);
    const source=ok(await f.upload(v,{lineId:line.id,buffer:m.design}),201);
    const app=ok(await f.post(`/satirlar/${line.id}/uygulamalar`,{kind:'baski',position,desenDosyaId:source.id}),201);apps.push(app);
    assert.ok(Math.abs(app.width_mm-m.expectedWidth)<=5,JSON.stringify(app));
    const p=JSON.parse(app.measure_source);assert.equal(p.flatId,line.product_key+view);assert.equal(p.desenFileId,source.id);assert.equal(app.needs_confirmation,0);
  }
  assert.equal(apps.length,4);
  const bad=await f.post(`/satirlar/${o.version.lines[0].id}/uygulamalar`,{kind:'baski',position:'gogus',desenDosyaId:JSON.parse(apps[3].measure_source).desenFileId});assert.equal(bad.status,400);
  const results=ok(await f.post(`/surumler/${v}/otomatik-olc`)).results;assert.equal(results.length,4);
  assert.equal(f.db.prepare("SELECT count(*) n FROM confirmations WHERE kind='olcu' AND status='acik'").get().n,0);
});
test('G24 upload triggers measurement; manual corrections survive automatic runs until yeniden=1',async t=>{
  const f=await fixture(t),o=await f.order(),line=o.version.lines[0],v=o.version.id,m=mockup();addFlat(f);
  const app=ok(await f.post(`/satirlar/${line.id}/uygulamalar`,{kind:'baski',position:'gogus'}),201);
  ok(await f.upload(v,{kind:'urun_gorsel',lineId:line.id,gorunum:'on',buffer:m.image}),201);
  ok(await f.upload(v,{lineId:line.id,applicationId:app.id,buffer:m.design}),201);
  let saved=f.db.prepare('SELECT * FROM applications WHERE id=?').get(app.id);assert.ok(Math.abs(saved.width_mm-240)<=5);assert.equal(JSON.parse(saved.measure_source).method,'otomatik');
  ok(await f.request(`/uygulamalar/${app.id}`,{method:'PATCH',token:f.token,body:{width_mm:111,height_mm:77}}));
  assert.equal(ok(await f.post(`/surumler/${v}/otomatik-olc`)).results.length,0);
  saved=f.db.prepare('SELECT * FROM applications WHERE id=?').get(app.id);assert.equal(saved.width_mm,111);assert.equal(JSON.parse(saved.measure_source).method,'elle');
  assert.equal(ok(await f.post(`/surumler/${v}/otomatik-olc?yeniden=1`)).results.length,1);
  saved=f.db.prepare('SELECT * FROM applications WHERE id=?').get(app.id);assert.ok(Math.abs(saved.width_mm-240)<=5);assert.equal(JSON.parse(saved.measure_source).method,'otomatik');
  const manual=ok(await f.measure(line.id),201);assert.equal(JSON.parse(manual.application.measure_source).method,'elle');
  f.db.prepare("UPDATE order_versions SET status='onay_bekliyor' WHERE id=?").run(v);
  assert.equal((await f.post(`/surumler/${v}/otomatik-olc`)).status,409);
});
test('G24 absent refBeden stays null; ambiguous product flats and missing design open one current confirmation',async t=>{
  const f=await fixture(t),o=await f.order(),line=o.version.lines[0],v=o.version.id,m=mockup({missing:true});addFlat(f,'tisort','on','one',null);
  const source=ok(await f.upload(v,{lineId:line.id,buffer:m.design}),201);
  ok(await f.upload(v,{kind:'urun_gorsel',lineId:line.id,gorunum:'on',buffer:m.image}),201);
  const app=ok(await f.post(`/satirlar/${line.id}/uygulamalar`,{kind:'baski',position:'gogus',desenDosyaId:source.id}),201);
  assert.equal(JSON.parse(app.measure_source).refBeden,null);assert.equal(app.needs_confirmation,1);assert.equal(app.width_mm,null);
  addFlat(f,'tisort','on','two');
  await f.post(`/surumler/${v}/otomatik-olc`);
  // Only L patterns are candidates; add another L to exercise genuine ambiguity.
  addFlat(f,'tisort','on','three');
  f.db.prepare('UPDATE applications SET measure_source=NULL WHERE id=?').run(app.id);
  const r=ok(await f.post(`/surumler/${v}/otomatik-olc`)).results[0];assert.equal(r.measure_source.flatId,null);assert.match(r.reason,/kalıp/);
  assert.equal(f.db.prepare("SELECT count(*) n FROM confirmations WHERE kind='olcu' AND ref_id=? AND status='acik'").get(app.id).n,1);
});
test('G24 manual correction made while worker runs cannot be overwritten, even with yeniden=1',async t=>{
  const f=await fixture(t),o=await f.order(),line=o.version.lines[0],v=o.version.id,m=mockup();addFlat(f);
  const source=ok(await f.upload(v,{lineId:line.id,buffer:m.design}),201);
  ok(await f.upload(v,{kind:'urun_gorsel',lineId:line.id,gorunum:'on',buffer:m.image}),201);
  const app=ok(await f.post(`/satirlar/${line.id}/uygulamalar`,{kind:'baski',position:'gogus',desenDosyaId:source.id}),201);
  const cp=require('node:child_process'),path=require('node:path'),fork=cp.fork;
  let notify;const started=new Promise(resolve=>notify=resolve);
  t.mock.method(cp,'fork',(filename,args,options)=>{const child=fork(filename,args,{...options,execArgv:['--require',path.join(__dirname,'fixtures/siparis/oto-delay-worker.cjs')]});notify();return child;});
  const measuring=f.post(`/surumler/${v}/otomatik-olc?yeniden=1`);
  let timer;try{await Promise.race([started,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Ölçü alt süreci başlamadı')),3000);})]);}finally{clearTimeout(timer);}
  const editing=f.request(`/uygulamalar/${app.id}`,{method:'PATCH',token:f.token,body:{width_mm:123,height_mm:78}});
  assert.equal(ok(await measuring).results.length,0);ok(await editing);
  const saved=f.db.prepare('SELECT * FROM applications WHERE id=?').get(app.id);assert.equal(saved.width_mm,123);assert.equal(JSON.parse(saved.measure_source).method,'elle');
});
test('G24 print size has no preset cap; non-L references and divergent scales require confirmation',async()=>{
  const large=await auto.autoMeasure(input(mockup({width:220})));assert.ok(large.width_mm>350,JSON.stringify(large));assert.doesNotMatch(large.reason,/olağandışı/);
  const other=await auto.autoMeasure(input(mockup(),{flat:{...flat,refBeden:'M'}}));assert.match(other.reason,/L beden değil/);assert.equal(other.width_mm,null);
  // G44: beyond 35% the axes disagree too much for a mockup; no scale.
  const check=await auto.autoMeasure(input(mockup(),{flat:{...flat,olculerL:{omuzdan_boy:70,etek:60}}}));assert.match(check.reason,/%35/);assert.equal(check.width_mm,null);assert.equal(check.measure_source.mmPerPx,null);
  const single=await auto.autoMeasure(input(mockup(),{flat:{...flat,olculerL:{etek:60}}}));assert.match(single.measure_source.scaleNote,/Tek L ölçeği/);assert.equal(single.needs_confirmation,false);assert.ok(single.width_mm>0);
});
test('G24 white garments on transparent backgrounds use alpha as the product mask',async()=>{
  const {createCanvas}=require('@napi-rs/canvas'),c=createCanvas(400,500),x=c.getContext('2d');x.fillStyle='white';x.fillRect(100,40,200,420);x.fillRect(60,40,280,100);
  const p=await auto.raster({buffer:c.toBuffer('image/png'),mime:'image/png'}),r=auto.silhouette(p);assert.equal(r.hemWidthPx,200);
});
test('G24 a single front product flat supplies the back reference; unlinked sources use color',async t=>{
  const f=await fixture(t),o=await f.order(),line=o.version.lines[0],v=o.version.id,m=mockup({position:'sirt'});addFlat(f);
  const source=ok(await f.upload(v,{lineId:line.id,buffer:m.design}),201);
  ok(await f.upload(v,{kind:'urun_gorsel',lineId:line.id,gorunum:'arka',buffer:m.image}),201);
  const app=ok(await f.post(`/satirlar/${line.id}/uygulamalar`,{kind:'baski',position:'sirt'}),201);assert.ok(app.width_mm>0);assert.equal(JSON.parse(app.measure_source).method,'otomatik_renk');
  const edited=ok(await f.request(`/uygulamalar/${app.id}`,{method:'PATCH',token:f.token,body:{desenDosyaId:source.id}}));
  assert.equal(JSON.parse(edited.application.measure_source).flatId,'tisorton');assert.ok(Math.abs(edited.application.width_mm-240)<=5);
});
