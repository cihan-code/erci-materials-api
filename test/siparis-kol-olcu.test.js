'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createCanvas}=require('@napi-rs/canvas');
const {autoMeasure}=require('../agent/siparis/autoMeasure');
const {measureSleeve}=require('../agent/siparis/measure');
const flat={id:'sleeve-L',ad:'Kol sentetik',refBeden:'L',olculerL:{omuzdan_boy:100.2,etek:48,kol_boyu:100}};
function mock({separate=false,compression=1,repeated=false,missing=false,torsoOnly=false,rotate=false}={}) {
  const d=createCanvas(80,120),a=d.getContext('2d');
  a.fillStyle='#101824';a.fillRect(0,0,80,120);
  a.clearRect(8,8,35,33);a.clearRect(50,16,20,64);a.clearRect(8,60,20,52);a.clearRect(35,90,36,22);
  const c=createCanvas(600,650),x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,600,650);x.fillStyle='#a4b6b8';
  x.beginPath();
  const pts=torsoOnly?[[180,80],[420,80],[420,580],[180,580]]:separate?[[250,80],[350,80],[340,579],[260,579]]:[[180,80],[420,80],[495,110],[520,575],[450,585],[420,230],[420,580],[180,580],[180,230],[150,585],[80,575],[105,110]];
  pts.forEach(([u,v],i)=>i?x.lineTo(u,v):x.moveTo(u,v));x.closePath();x.fill();
  const draw=left=>{x.save();x.translate(left,350);if(rotate){x.translate(0,40);x.rotate(-Math.PI/2);x.drawImage(d,0,0,40,60*compression);}else x.drawImage(d,0,0,40*compression,60);x.restore();};
  if(!missing){draw(separate?280:110);if(repeated)draw(470);}
  return {image:{buffer:c.toBuffer('image/png'),mime:'image/png',gorunum:separate?'kol':'on'},design:{buffer:d.toBuffer('image/png'),mime:'image/png'},flat,position:'kol'};
}
function near(n,expected,tol=6){assert.ok(Math.abs(n-expected)<=tol,`${n} differs from ${expected}`);}
test('G39c front sleeve uses body L scale and artwork ratio',async()=>{
  const r=await autoMeasure(mock());assert.equal(r.needs_confirmation,false,JSON.stringify(r));near(r.width_mm,80);near(r.height_mm,120);
  assert.equal(r.measure_source.scaleFrom,'govde');assert.equal(r.measure_source.measuredAxis,'boy');assert.match(r.measure_source.summary,/Kol boyunca/);
});
test('G39c separate complete sleeve uses kol_boyu without body measurements',async()=>{
  const m=mock({separate:true});m.flat={...flat,olculerL:{kol_boyu:100}};
  const r=await autoMeasure(m);assert.equal(r.needs_confirmation,false,JSON.stringify(r));near(r.width_mm,80);near(r.height_mm,120);assert.equal(r.measure_source.scaleFrom,'kol_boyu');
});
test('G39c no sleeve yields a concrete Turkish reason and no dimensions',async()=>{
  const r=await autoMeasure(mock({torsoOnly:true}));assert.equal(r.needs_confirmation,true);assert.equal(r.width_mm,null);assert.match(r.reason,/Kol bulunamadı/);
});
test('G39c transverse shortening is corrected from artwork, but >10% needs confirmation',async()=>{
  const r=await autoMeasure(mock({separate:true,compression:.6}));assert.equal(r.needs_confirmation,true,JSON.stringify(r));near(r.width_mm,80);near(r.height_mm,120);assert.match(r.reason,/±%10/);assert.ok(r.measure_source.aspectRatioError>.3);
});
test('G39c missing source, artwork and repeated candidates never receive unconfirmed dimensions',async()=>{
  const noScale=mock({separate:true});noScale.flat={...flat,olculerL:{}};
  const r=await autoMeasure(noScale);assert.equal(r.width_mm,null);assert.match(r.reason,/ölçek kaynağı yok/);
  const noArt=mock();noArt.design=null;const absent=await autoMeasure(noArt);assert.equal(absent.width_mm,null);assert.match(absent.reason,/desen dosyası yok/);
  const repeated=await autoMeasure(mock({repeated:true}));assert.equal(repeated.needs_confirmation,true);assert.equal(repeated.width_mm,null);assert.match(repeated.reason,/belirsiz/);
});
test('G39c the artwork width may run along the sleeve (quarter turn)',async()=>{
  const r=await autoMeasure(mock({separate:true,rotate:true}));assert.equal(r.needs_confirmation,false,JSON.stringify(r));assert.equal(r.measure_source.measuredAxis,'en');near(r.width_mm,80);near(r.height_mm,120);
});
test('G39c observed aspect error is checked independently at ±10% and dimensions reject invalid scale',()=>{
  for(const factor of [.9,1.1])assert.deepEqual(measureSleeve({alongPx:60,acrossPx:40*factor,designRatio:2/3,measuredAxis:'boy',mmPerPx:2}).reasons,[]);
  assert.match(measureSleeve({alongPx:60,acrossPx:35,designRatio:2/3,measuredAxis:'boy',mmPerPx:2}).reasons.join(' '),/±%10/);
  assert.equal(measureSleeve({alongPx:60,acrossPx:40,designRatio:2/3,measuredAxis:'boy',mmPerPx:Infinity}).width_mm,null);
});
test('G39c PDF sleeve image uses the same lengthwise measurement',async()=>{
  const {PDFDocument}=require('pdf-lib'),m=mock({separate:true}),pdf=await PDFDocument.create(),im=await pdf.embedPng(m.image.buffer);
  pdf.addPage([600,650]).drawImage(im,{x:0,y:0,width:600,height:650});
  const r=await autoMeasure({...m,image:{mime:'application/pdf',buffer:Buffer.from(await pdf.save()),gorunum:'kol'}});
  assert.equal(r.needs_confirmation,false,JSON.stringify(r));near(r.width_mm,80);near(r.height_mm,120);assert.equal(r.measure_source.scaleFrom,'kol_boyu');
});
test('G39c front/back metadata selects the wearer side; unknown side needs confirmation',async()=>{
  const m=mock();
  const right=await autoMeasure({...m,position:'sag_kol'});assert.equal(right.needs_confirmation,false,JSON.stringify(right));
  const left=await autoMeasure({...m,position:'sol_kol'});assert.equal(left.width_mm,null);assert.equal(left.needs_confirmation,true);
  const back=await autoMeasure({...m,image:{...m.image,gorunum:'arka'},position:'sol_kol'});assert.equal(back.needs_confirmation,false,JSON.stringify(back));
  const unknown=await autoMeasure({...m,image:{...m.image,gorunum:undefined},position:'sag_kol'});assert.equal(unknown.needs_confirmation,true);assert.match(unknown.reason,/yönü/);
});
test('G39c incomplete sleeve and conflicting torso scales cannot create a measurement',async()=>{
  const m=mock({separate:true}),{loadImage}=require('@napi-rs/canvas'),c=createCanvas(600,650),x=c.getContext('2d');
  x.drawImage(await loadImage(m.image.buffer),0,-100);
  const crop=await autoMeasure({...m,image:{...m.image,buffer:c.toBuffer('image/png')}});assert.equal(crop.width_mm,null);assert.match(crop.reason,/Kol bulunamadı/);
  const body=mock();body.flat={...flat,olculerL:{omuzdan_boy:50,etek:48}};
  const conflict=await autoMeasure(body);assert.equal(conflict.width_mm,null);assert.match(conflict.reason,/boy\/etek ölçek farkı/);
});
test('G39c API measures print and embroidery, prioritizes sleeve uploads and retains manual corrections',{timeout:60000},async t=>{
  const fs=require('node:fs'),path=require('node:path'),documents=require('../agent/siparis/documents');
  const f=await require('./fixtures/siparis/belge-fixture').setup();
  t.after(async()=>{await documents.settled();await f.close();fs.rmSync(f.dir,{recursive:true,force:true});});
  const o=await f.order(),v=o.version.id,line=o.version.lines[0].id,m=mock(),s=mock({separate:true});
  const root=path.join(fs.realpathSync(f.dir),'siparis','flats');fs.mkdirSync(root,{recursive:true});
  const file=path.join(root,'kol.png');fs.writeFileSync(file,m.image.buffer);
  f.db.prepare('INSERT INTO document_flats(id,ad,urun,gorunum,dosya,refLengthCm,refLengthPx,refBeden,olculerL) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(flat.id,flat.ad,'tisort','on',file,48,240,'L',JSON.stringify(flat.olculerL));
  const ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.data));return r.data;};
  ok(await f.upload(v,{kind:'urun_gorsel',lineId:line,gorunum:'on',buffer:m.image.buffer}),201);
  const art=ok(await f.upload(v,{lineId:line,buffer:m.design.buffer}),201),apps=[];
  for(const kind of ['baski','nakis']) {
    const app=ok(await f.post(`/satirlar/${line}/uygulamalar`,{kind,position:'kol',desenDosyaId:art.id}),201);
    assert.equal(app.needs_confirmation,0,JSON.stringify(app));near(app.width_mm,80);apps.push(app);
  }
  const sleeveFile=ok(await f.upload(v,{kind:'urun_gorsel',lineId:line,gorunum:'kol',buffer:s.image.buffer}),201);
  const saved=()=>f.db.prepare('SELECT * FROM applications WHERE id=?').get(apps[0].id);
  assert.equal(saved().needs_confirmation,0);assert.equal(JSON.parse(saved().measure_source).scaleFrom,'kol_boyu');
  assert.equal(JSON.parse(saved().measure_source).gorselFileId,sleeveFile.id);
  ok(await f.request(`/uygulamalar/${apps[0].id}`,{method:'PATCH',token:f.token,body:{width_mm:123,height_mm:99}}));
  ok(await f.post(`/surumler/${v}/otomatik-olc`));assert.equal(saved().width_mm,123);
  ok(await f.post(`/surumler/${v}/otomatik-olc?yeniden=1`));near(saved().width_mm,80);assert.equal(saved().needs_confirmation,0);
});
