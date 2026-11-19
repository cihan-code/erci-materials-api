'use strict';
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {PDFDocument}=require('pdf-lib');
const auto=require('../agent/siparis/autoMeasure');
const documents=require('../agent/siparis/documents');
const {setup}=require('./fixtures/siparis/belge-fixture');
const {mockup}=require('./fixtures/siparis/oto-mockup');
const deadline=setTimeout(()=>{console.error('G24 test dosyası 90 saniyeyi aştı');process.exit(1);},90000);
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
test('G24 perspective, absent design, ambiguity, unknown view and missing flat require Turkish confirmation',async()=>{
  for(const [m,extra] of [[mockup({perspective:true}),{}],[mockup({missing:true}),{}],[mockup({repeated:true}),{}],[mockup(),{position:'other'}],[mockup(),{flat:null}]]) {
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
  // The previous measurement pins the chosen flat; explicitly invalidating it
  // must require selection rather than guess between competing product patterns.
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
  const check=await auto.autoMeasure(input(mockup(),{flat:{...flat,olculerL:{omuzdan_boy:80,etek:60}}}));assert.match(check.reason,/%8/);assert.equal(check.width_mm,null);assert.equal(check.measure_source.mmPerPx,null);
  const single=await auto.autoMeasure(input(mockup(),{flat:{...flat,olculerL:{etek:60}}}));assert.match(single.reason,/Tek L ölçeği/);assert.ok(single.width_mm>0);
});
test('G24 white garments on transparent backgrounds use alpha as the product mask',async()=>{
  const {createCanvas}=require('@napi-rs/canvas'),c=createCanvas(400,500),x=c.getContext('2d');x.fillStyle='white';x.fillRect(100,40,200,420);x.fillRect(60,40,280,100);
  const p=await auto.raster({buffer:c.toBuffer('image/png'),mime:'image/png'}),r=auto.silhouette(p);assert.equal(r.hemWidthPx,200);
});
test('G24 a single front product flat supplies the back reference; unlinked sources never measure',async t=>{
  const f=await fixture(t),o=await f.order(),line=o.version.lines[0],v=o.version.id,m=mockup({position:'sirt'});addFlat(f);
  const source=ok(await f.upload(v,{lineId:line.id,buffer:m.design}),201);
  ok(await f.upload(v,{kind:'urun_gorsel',lineId:line.id,gorunum:'arka',buffer:m.image}),201);
  const app=ok(await f.post(`/satirlar/${line.id}/uygulamalar`,{kind:'baski',position:'sirt'}),201);assert.equal(app.width_mm,null);
  const edited=ok(await f.request(`/uygulamalar/${app.id}`,{method:'PATCH',token:f.token,body:{desenDosyaId:source.id}}));
  assert.equal(JSON.parse(edited.application.measure_source).flatId,'tisorton');assert.ok(Math.abs(edited.application.width_mm-240)<=5);
});
test('G24b filled hanging sleeves, a shadow and a corner logo preserve two independent L scales',async()=>{
  const {silhouetteMockup}=require('./fixtures/siparis/oto-silhouette');
  for(const options of [{shadow:true},{recolor:true},{pale:true,shadow:true}]) {
    const m=silhouetteMockup(options),r=await auto.autoMeasure(input(m,{flat:{...flat,olculerL:{omuzdan_boy:72,etek:52}}}));
    assert.equal(r.needs_confirmation,false,JSON.stringify(r));
    assert.ok(Math.abs(r.measure_source.verticalMmPerPx-2)<.03,JSON.stringify(r));
    assert.ok(Math.abs(r.measure_source.horizontalMmPerPx-2)<.03,JSON.stringify(r));
    assert.ok(Math.abs(r.width_mm-238)<=5,JSON.stringify(r));
    assert.ok(Math.abs(r.height_mm-160)<=5,JSON.stringify(r));
    assert.ok(r.measure_source.designBoxPx.w>100);
  }
});
test('G24b a hood is excluded from shoulder height and tiny raster matches cannot alias the whole design',async()=>{
  const {silhouetteMockup}=require('./fixtures/siparis/oto-silhouette'),m=silhouetteMockup({hood:true,recolor:true});
  const r=await auto.autoMeasure(input(m,{flat:{...flat,olculerL:{omuzdan_boy:72,etek:52}}}));
  assert.ok(r.measure_source.shoulderY>50,JSON.stringify(r));assert.match(r.measure_source.shoulderMethod,/omuz/);
  if(r.measure_source.designBoxPx)assert.ok(r.measure_source.designBoxPx.w>50,JSON.stringify(r));
});
test('G24b all PDF pages are inspected; covers, logos and text do not replace the matching garment page',async()=>{
  const m=mockup(),pdf=await PDFDocument.create();
  const first=pdf.addPage([600,650]);first.drawText('PRODUCT COLLECTION',{x:100,y:400,size:28});first.drawRectangle({x:220,y:220,width:150,height:90});
  for(let i=0;i<5;i++)pdf.addPage([600,650]).drawText('NOTES '+i,{x:100,y:400,size:20});
  const wrong=await pdf.embedPng(mockup({missing:true}).image);pdf.addPage([600,650]).drawImage(wrong,{width:600,height:650});
  const right=await pdf.embedPng(m.image);pdf.addPage([600,650]).drawImage(right,{width:600,height:650});
  const r=await auto.autoMeasure(input(m,{image:{buffer:Buffer.from(await pdf.save()),mime:'application/pdf'}}));
  assert.equal(r.measure_source.pageCount,8);assert.equal(r.measure_source.selectedPage,8,JSON.stringify(r));assert.ok(Math.abs(r.width_mm-240)<=5,JSON.stringify(r));
  const cover=await PDFDocument.create();cover.addPage([600,650]).drawText('COLLECTION',{x:100,y:400,size:40});
  const noProduct=await auto.autoMeasure(input(m,{image:{buffer:Buffer.from(await cover.save()),mime:'application/pdf'}}));assert.equal(noProduct.width_mm,null);assert.equal(noProduct.needs_confirmation,true);
});
test('G24b L measurements survive API and --guncelle roundtrips while old reference contracts remain',async t=>{
  const f=await fixture(t);addFlat(f);
  const route='/duz-cizimler/tisorton/referans',body={refLengthPx:300,refLengthCm:60,refAciklama:'Synthetic chest',olculerL:{omuzdan_boy:72,etek:52,gogus:55}};
  const update=await f.request(route,{method:'PUT',token:f.managerToken,body});assert.equal(update.status,200,JSON.stringify(update.data));assert.equal(update.data.refBeden,'L');assert.deepEqual(update.data.olculerL,body.olculerL);
  const rows=ok(await f.request('/duz-cizimler',{token:f.token}));assert.deepEqual(rows[0].olculerL,body.olculerL);
  for(const invalid of [{etek:0},{etek:-1},{etek:'52'},[52],{}])assert.equal((await f.request(route,{method:'PUT',token:f.managerToken,body:{...body,olculerL:invalid}})).status,400);
  const path=require('node:path'),json=path.join(f.dir,'synthetic-reference.json'),filename=path.join(f.dir,'synthetic.png');fs.writeFileSync(filename,mockup().image);
  const record={ad:'Sentetik tisort',urun:'tisort',gorunum:'on',dosya:filename,refLengthPx:300,refLengthCm:60,refBeden:'L',refAciklama:'Synthetic chest',olculerL:{omuzdan_boy:74,etek:53}};fs.writeFileSync(json,JSON.stringify([record]));
  const {upload}=require('../agent/siparis/tools/duz-cizim-yukle');const fetchImpl=async(url,options)=>{if(url.endsWith('/giris'))return {ok:true,json:async()=>({token:f.managerToken})};return fetch(url,options);};
  assert.deepEqual(await upload({api:f.base,json,update:true,getCredentials:async()=>({name:'fixture',password:'fixture'}),fetchImpl,log:()=>{}}),{uploaded:1,skipped:0});
  assert.deepEqual(ok(await f.request('/duz-cizimler',{token:f.token}))[0].olculerL,record.olculerL);
});
test('G24b fabric texture outside the print requires confirmation even on a symmetric front',async()=>{
  const {silhouetteMockup}=require('./fixtures/siparis/oto-silhouette'),m=silhouetteMockup({wrinkles:true});
  const r=await auto.autoMeasure(input(m,{flat:{...flat,olculerL:{omuzdan_boy:72,etek:52}}}));
  assert.ok(r.measure_source.wrinkleFraction>.06,JSON.stringify(r));assert.equal(r.needs_confirmation,true);assert.match(r.reason,/kırışık/);
});
test('G24b large type, script marks and filled cover rectangles are not products',async()=>{
  const {createCanvas}=require('@napi-rs/canvas');
  for(const kind of ['type','script','rectangle']) {
    const c=createCanvas(600,600),x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,600,600);x.fillStyle='#253252';
    if(kind==='type'){x.fillRect(80,90,70,420);x.fillRect(450,90,70,420);x.fillRect(80,250,440,70);}
    else if(kind==='rectangle')x.fillRect(80,90,440,420);
    else {x.strokeStyle='#253252';x.lineWidth=30;x.beginPath();x.moveTo(70,350);x.bezierCurveTo(150,50,350,500,530,130);x.bezierCurveTo(540,430,150,220,100,450);x.stroke();}
    assert.equal(auto.silhouette(await auto.raster({buffer:c.toBuffer('image/png'),mime:'image/png'})),null,kind);
  }
});
