'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createCanvas}=require('@napi-rs/canvas');
const {autoMeasure}=require('../agent/siparis/autoMeasure');
const {mockup}=require('./fixtures/siparis/oto-mockup');

// Invented garments only. The synthetic tee mockup measures 560 px shoulder to
// hem and 300 px hem. Its flat drawing below has the same shape, so after
// calibration on the drawing the mockup has no residual axis difference.
const POLY=[[200,45],[400,45],[540,175],[475,250],[450,215],[450,605],[150,605],[150,215],[125,250],[60,175]];
function drawing({stretch=1,blank=false}={}) {
  const c=createCanvas(600,1000),x=c.getContext('2d');x.fillStyle='#fafafa';x.fillRect(0,0,600,1000);
  if(!blank){x.fillStyle='#d8d8d8';x.beginPath();POLY.forEach(([a,b],i)=>{const y=45+(b-45)*stretch;i?x.lineTo(a,y):x.moveTo(a,y);});x.closePath();x.fill();}
  return {buffer:c.toBuffer('image/png'),mime:'image/png'};
}
// The L table disagrees with the drawing by 40%: 168.3 cm "boy" over 560 px.
const L={omuzdan_boy:112.2*1.5,etek:60};
const job=(flat)=>{const m=mockup();return {image:{buffer:m.image,mime:'image/png',gorunum:'on'},design:{buffer:m.design,mime:'image/png'},flat:{id:'tee',ad:'Sentetik tişört',urun:'tisort',refBeden:'L',olculerL:L,...flat},product:'tisort',position:'gogus'};};

test('G45b without a drawing the 40% L/drawing difference still needs confirmation',async()=>{
  for(const flat of [{},{cizim:drawing({blank:true})}]) {
    const r=await autoMeasure(job(flat));
    assert.equal(r.width_mm,null);assert.match(r.reason,/%35 sınırını aşıyor/);assert.equal(r.measure_source.kalibrasyon,null);
  }
});

test('G45b the flat drawing calibrates the axes; a mockup drawn like it is measured without warning',async()=>{
  const r=await autoMeasure(job({cizim:drawing()})),s=r.measure_source;
  assert.equal(r.needs_confirmation,false,r.reason);
  assert.equal(s.kalibrasyon.kaynak,'duz_cizim');assert.ok(Math.abs(s.kalibrasyon.boyPx-560)<=2&&Math.abs(s.kalibrasyon.gogusPx-300)<=2,JSON.stringify(s.kalibrasyon));
  assert.ok(s.scaleDifference<.01);assert.equal(s.scaleMode,undefined);
  // One scale for both axes: the geometric mean of the raw L scales (sqrt(3*2)).
  assert.ok(Math.abs(s.mmPerPx-Math.sqrt(2*1.5*2))<.02,`${s.mmPerPx}`);
  assert.ok(Math.abs(r.width_mm-Math.round(120*Math.sqrt(2*1.5*2)))<=3,`${r.width_mm}`);
  // A cached result is used as given, without a drawing.
  const cached=await autoMeasure(job({kalibrasyon:{...s.kalibrasyon}}));
  assert.equal(cached.width_mm,r.width_mm);
  const wrongKind=await autoMeasure(job({kalibrasyon:{...s.kalibrasyon,tur:'bacak'}}));assert.equal(wrongKind.width_mm,null);
});

test('G45b bands apply to the residual after calibration',async()=>{
  // Drawing 20% taller than the mockup: residual about 20%, geometric mean with a note.
  const mid=await autoMeasure(job({cizim:drawing({stretch:1.2})}));
  assert.equal(mid.needs_confirmation,false,mid.reason);assert.equal(mid.measure_source.scaleMode,'geo_ortalama');
  assert.ok(mid.measure_source.scaleDifference>.15&&mid.measure_source.scaleDifference<.25);
  assert.match(mid.measure_source.scaleNote,/Mockup oranı kalıptan farklı/);
  // 55% taller: the residual stays above 35% and needs confirmation.
  const far=await autoMeasure(job({cizim:drawing({stretch:1.55})}));
  assert.equal(far.width_mm,null);assert.match(far.reason,/%35 sınırını aşıyor/);
});

function pants({drawingOnly=false}={}) {
  const c=createCanvas(600,900),x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,600,900);x.fillStyle='#c8c2b4';
  x.fillRect(150,50,300,300);x.fillRect(150,350,145,501);x.fillRect(305,350,145,501);
  const d=createCanvas(80,120),a=d.getContext('2d');
  a.fillStyle='#101824';a.fillRect(0,0,80,120);a.clearRect(8,8,35,33);a.clearRect(50,16,20,64);a.clearRect(8,60,20,52);a.clearRect(35,90,36,22);
  if(!drawingOnly)x.drawImage(d,340,200,80,120);
  return {canvas:c,design:d};
}
test('G45b trousers calibrate yan_boy and basen on the pattern drawing',async()=>{
  const m=pants(),flat={id:'p',ad:'EŞOFMAN',urun:'esofman',refBeden:'L',olculerL:{yan_boy:80.1,basen:30*1.5}};
  const input={image:{buffer:m.canvas.toBuffer('image/png'),mime:'image/png',gorunum:'on'},design:{buffer:m.design.toBuffer('image/png'),mime:'image/png'},product:'esofman',position:'sol_bacak'};
  const raw=await autoMeasure({...input,flat});assert.equal(raw.width_mm,null);assert.match(raw.reason,/%35 sınırını aşıyor/);
  const r=await autoMeasure({...input,flat:{...flat,cizim:{buffer:pants({drawingOnly:true}).canvas.toBuffer('image/png'),mime:'image/png'}}});
  assert.equal(r.needs_confirmation,false,r.reason);
  assert.deepEqual(Object.keys(r.measure_source.kalibrasyon).filter(k=>/Px$/.test(k)).sort(),['basenPx','yanBoyPx']);
  assert.ok(Math.abs(r.width_mm-80*Math.sqrt(1.5))<=3,`${r.width_mm}`);
});

test('G45b the server passes the drawing once per file and reuses the cached result',()=>{
  const documents=require('../agent/siparis/documents'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'kalib-'));
  try {
    const file=path.join(dir,'flat.png');fs.writeFileSync(file,drawing().buffer);
    const flat={id:'f',urun:'tisort',refBeden:'L',olculerL:L,dosya:file};
    const first=documents.flatCalibrationInput(flat,false);
    assert.ok(first.key);assert.ok(Buffer.isBuffer(first.flat.cizim.buffer));
    documents.FLAT_CALIBRATIONS.set(first.key,{boyPx:560,gogusPx:300,kaynak:'duz_cizim',oran:1.5,tur:'boy_etek'});
    const second=documents.flatCalibrationInput(flat,false);
    assert.equal(second.key,null);assert.equal(second.flat.cizim,undefined);assert.equal(second.flat.kalibrasyon.oran,1.5);
    assert.ok(documents.flatCalibrationInput(flat,true).key,'trousers are cached separately');
    assert.equal(documents.flatCalibrationInput({...flat,dosya:path.join(dir,'none.png')},false).key,null);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
