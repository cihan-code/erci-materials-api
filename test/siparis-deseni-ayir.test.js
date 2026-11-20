'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {PNG}=require('pngjs');
const {PDFDocument}=require('pdf-lib');
const {createCanvas,loadImage}=require('@napi-rs/canvas');
const documents=require('../agent/siparis/documents');
const orders=require('../agent/siparis/orders');
const {extractArtwork}=require('../agent/siparis/autoMeasure');
const {setup}=require('./fixtures/siparis/belge-fixture');
const {mockup}=require('./fixtures/siparis/oto-mockup');

async function fixture(t) {
  const f=await setup();
  t.after(async()=> {await documents.settled();await f.close();});
  return f;
}
function ok(response,status=200) {
  assert.equal(response.status,status,JSON.stringify(response.data));
  return response.data;
}
const vectorStatus=(f,id)=>f.request(`/surumler/${id}/vektor-durum`,{token:f.token}).then(ok);
const uploadProduct=(f,id,lineId,buffer)=>f.upload(id,{lineId,buffer,kind:'urun_gorsel',gorunum:'on'}).then(r=>ok(r,201));
const openMeasure=(f,appId)=>f.db.prepare("SELECT id FROM confirmations WHERE kind='olcu' AND ref_table='applications' AND ref_id=? AND status='acik'").get(appId);
const extract=buffer=>extractArtwork({image:{buffer,mime:'image/png',gorunum:'on'},position:'gogus'});

function editPixels(buffer,change) {
  const png=PNG.sync.read(buffer);
  const paint=(x0,y0,x1,y1,color)=> {
    for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++)png.data.set(color,(y*png.width+x)*4);
  };
  change(png,paint);
  return PNG.sync.write(png);
}

test('G40b crop keeps artwork and clears garment pixels, including holes',async()=> {
  const result=await extract(mockup().image);
  assert.deepEqual(result.placement,{page:1,view:'on',rasterWidth:600,rasterHeight:650,designBoxPx:{x:240,y:265,w:120,h:68}});
  const png=PNG.sync.read(result.buffer);
  const pixel=(x,y)=>[...png.data.subarray((y*png.width+x)*4,(y*png.width+x)*4+4)];
  assert.deepEqual(pixel(22,47),[0,0,0,0]);
  assert.deepEqual(pixel(2,2),[236,49,86,255]);
  assert.deepEqual(pixel(67,15),[37,50,124,255]);
});

test('G40b repeated marks, low contrast, a crossing seam and cut product give reasons without artwork',async()=> {
  const sample=mockup(),plain=mockup({missing:true}).image;
  const repeated=mockup({repeated:true}).image;
  const faint=editPixels(plain,(_,paint)=>paint(240,265,360,333,[43,80,129,255]));
  const seam=editPixels(sample.image,(_,paint)=>paint(195,280,355,283,[8,9,11,255]));
  const panel=editPixels(plain,(_,paint)=>paint(240,265,360,333,[12,17,19,255]));
  const cut=editPixels(sample.image,(png)=> {
    for(let y=0;y<png.height;y++)png.data.copy(png.data,y*png.width*4,(y*png.width+150)*4,(y+1)*png.width*4);
  });
  for(const [image,reason] of [[repeated,/birden çok/],[faint,/Düşük kontrast/],[seam,/dikiş/],[panel,/kumaş/],[cut,/kesil|maske/]]) {
    const result=await extract(image);
    assert.equal(result.buffer,undefined,`Expected refusal: ${reason}`);
    assert.match(result.reason,reason);
  }
});

async function tallBackMockup() {
  const back=createCanvas(600,650),ctx=back.getContext('2d');
  ctx.drawImage(await loadImage(mockup({missing:true}).image),0,0);
  const points=[[300,140],[325,250],[411,258],[350,335],[375,490],[300,409],[225,490],[250,335],[189,258],[275,250]];
  ctx.fillStyle='#ec3156';
  ctx.beginPath();
  points.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));
  ctx.closePath();ctx.fill();
  return back.toBuffer('image/png');
}

test('G40b accepts an outer sleeve crop and preserves arms of a tall back print',async()=> {
  const side=createCanvas(530,650),sideCtx=side.getContext('2d');
  sideCtx.drawImage(await loadImage(mockup().image),-70,0);
  const cropped=await extract(side.toBuffer('image/png'));
  assert.ok(cropped.buffer,cropped.reason);
  assert.deepEqual(cropped.placement.designBoxPx,{x:170,y:265,w:120,h:68});

  const result=await extractArtwork({image:{buffer:await tallBackMockup(),mime:'image/png',gorunum:'arka'},position:'sirt'});
  assert.ok(result.buffer,result.reason);
  assert.ok(result.placement.designBoxPx.h>=344);
  assert.ok(result.placement.designBoxPx.w>=217);
});

test('G40b detects a unique candidate after a PDF cover and checks the declared side',async()=> {
  const pdf=await PDFDocument.create();
  pdf.addPage([600,650]);
  const page=pdf.addPage([600,650]),image=await pdf.embedPng(mockup({offset:55}).image);
  page.drawImage(image,{x:0,y:0,width:600,height:650});
  const source={buffer:Buffer.from(await pdf.save()),mime:'application/pdf',gorunum:'on'};
  const result=await extractArtwork({image:source,position:'sol_gogus'});
  assert.ok(result.buffer,result.reason);
  assert.equal(result.placement.page,2);
  const wrongSide=await extractArtwork({image:source,position:'sag_gogus'});
  assert.equal(wrongSide.buffer,undefined);
  assert.match(wrongSide.reason,/göğüs tarafıyla/);
});

test('G40b vector preview is available before physical measurement; prepare remains idempotent',async t=> {
  const f=await fixture(t),{version}=await f.order(),id=version.id,lineId=version.lines[0].id;
  const image=await uploadProduct(f,id,lineId,mockup().image);
  const app=ok(await f.post(`/satirlar/${lineId}/uygulamalar`,{kind:'nakis',position:'gogus'}),201);
  assert.equal(app.width_mm,null);
  assert.equal((await f.post(`/surumler/${id}/hazirla`)).status,409);
  await documents.settled();
  const [preview]=await vectorStatus(f,id);
  assert.equal(preview.extracted,true);
  assert.equal(preview.sourceFileId,image.id);
  assert.equal(preview.applicationId,app.id);
  assert.equal(preview.position,'gogus');
  assert.equal(preview.placement.designBoxPx.w,120);
  assert.ok(preview.previewFileId);
  assert.equal(preview.targetMm,undefined);
  ok(await f.request(`/uygulamalar/${app.id}`,{method:'PATCH',token:f.token,body:{width_mm:120,height_mm:68}}));
  ok(await f.post(`/teyitler/${openMeasure(f,app.id).id}/coz`));
  const results=await Promise.all([f.post(`/surumler/${id}/hazirla`),f.post(`/surumler/${id}/hazirla`)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  const files=results.find(r=>r.status===200).data;
  assert.equal(files.filter(g=>g.kind==='nakis_formu').length,1);
  assert.equal(files.filter(g=>g.kind==='baski_formu').length,0);
  assert.equal(files.filter(g=>g.kind==='desen_vektor_onizleme').length,1);
  const [vector]=files.filter(g=>g.kind==='desen_vektor');
  const bytes=ok(await f.request(`/dosyalar/${vector.id}`,{token:f.token}));
  const pdf=await PDFDocument.load(bytes),page=pdf.getPage(0);
  assert.ok(Math.abs(page.getWidth()-120*72/25.4)<.1);
  assert.ok(Math.abs(page.getHeight()-68*72/25.4)<.1);
  assert.deepEqual(ok(await f.post(`/surumler/${id}/hazirla`)),files);
});

test('G40b replacement invalidates a legacy application preview and an explicit source takes precedence',async t=> {
  const f=await fixture(t),{version}=await f.order(),id=version.id,lineId=version.lines[0].id;
  await uploadProduct(f,id,lineId,mockup().image);
  const app=orders.addApplication(f.db,lineId,{kind:'baski',position:'gogus',width_mm:120,height_mm:68,measure_source:'{"method":"elle"}'},f.team);
  const first=ok(await f.post(`/surumler/${id}/hazirla`));
  const [preview]=await vectorStatus(f,id);
  assert.ok(preview.previewFileId);
  const next=await uploadProduct(f,id,lineId,mockup({repeated:true}).image);
  const stale=await f.post(`/surumler/${id}/hazirla`);
  assert.equal(stale.status,409);
  assert.match(stale.data.error,/Sürüm değişmiş/);
  const ambiguous=await f.post(`/surumler/${id}/hazirla?yeniden=1`);
  assert.equal(ambiguous.status,409);
  assert.match(ambiguous.data.error,/birden çok/);
  const [blocked]=await vectorStatus(f,id);
  assert.equal(blocked.sourceFileId,next.id);
  assert.equal(blocked.previewFileId,null);
  assert.equal(blocked.status,'teyit');
  const source=ok(await f.upload(id,{lineId,applicationId:app.id,buffer:mockup().design}),201);
  await documents.settled();
  const [explicit]=await vectorStatus(f,id);
  assert.equal(explicit.extracted,undefined);
  assert.equal(explicit.sourceFileId,source.id);
  const regenerated=ok(await f.post(`/surumler/${id}/hazirla?yeniden=1`));
  assert.notEqual(regenerated.find(g=>g.kind==='desen_vektor').id,first.find(g=>g.kind==='desen_vektor').id);
  assert.equal(f.db.prepare('SELECT width_mm FROM applications WHERE id=?').get(app.id).width_mm,120);
});

test('G40b a crop that differs from old automatic measurement keeps its preview and blocks the measured PDF',async t=> {
  const f=await fixture(t),{version}=await f.order(),id=version.id,lineId=version.lines[0].id;
  const image=await uploadProduct(f,id,lineId,mockup().image);
  orders.addApplication(f.db,lineId,{kind:'baski',position:'gogus',width_mm:120,height_mm:27,measure_source:JSON.stringify({
    method:'otomatik_renk',gorselFileId:image.id,selectedPage:1,rasterWidth:600,rasterHeight:650,designBoxPx:{x:240,y:290,w:120,h:27}
  })},f.team);
  const response=await f.post(`/surumler/${id}/hazirla`);
  assert.equal(response.status,409);
  assert.match(response.data.error,/otomatik ölçü kutusuyla eşleşmedi/);
  const [preview]=await vectorStatus(f,id);
  assert.ok(preview.previewFileId);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM files WHERE kind='desen_vektor'").get().n,0);
});

test('G40b measures the full tall back print and prepares a vector at that verified physical scale',async t=> {
  const f=await fixture(t),{version}=await f.order(),id=version.id,lineId=version.lines[0].id;
  const body=new FormData();
  for(const [key,value] of Object.entries({ad:'Sentetik arka kalıp',urun:'tisort',gorunum:'arka'}))body.set(key,value);
  body.set('file',new Blob([mockup({missing:true}).image],{type:'image/png'}),'kalip.png');
  const flat=ok(await f.request('/duz-cizimler',{method:'POST',body,token:f.token}),201);
  ok(await f.request(`/duz-cizimler/${flat.id}/referans`,{method:'PUT',token:f.managerToken,body:{
    refLengthPx:300,refLengthCm:36,refAciklama:'Etek eni',refBeden:'L',olculerL:{omuzdan_boy:67.2,etek:36}
  }}));
  ok(await f.upload(id,{lineId,buffer:await tallBackMockup(),kind:'urun_gorsel',gorunum:'arka'}),201);
  const app=ok(await f.post(`/satirlar/${lineId}/uygulamalar`,{kind:'baski',position:'sirt'}),201);
  assert.equal(app.needs_confirmation,0,app.measure_source);
  assert.ok(app.height_mm>410,app.measure_source);
  const files=ok(await f.post(`/surumler/${id}/hazirla`));
  const [vector]=files.filter(file=>file.kind==='desen_vektor');
  const pdf=await PDFDocument.load(ok(await f.request(`/dosyalar/${vector.id}`,{token:f.token})));
  assert.ok(Math.abs(pdf.getPage(0).getHeight()-app.height_mm*72/25.4)<.1);
});
