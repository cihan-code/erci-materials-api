'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createCanvas}=require('@napi-rs/canvas');
const {autoMeasure}=require('../agent/siparis/autoMeasure');
const {mockup}=require('./fixtures/siparis/oto-mockup');

// Invented garments only. The synthetic tee is drawn at 2 mm/px on both axes
// (560 px shoulder to hem, 300 px hem). Its L height is changed so that the two
// axis scales differ by `d` (relative to their mean); the hem scale stays 2.
const vertical=d=>2*(2+d)/(2-d);
const tee=d=>{const m=mockup();return {image:{buffer:m.image,mime:'image/png',id:1,gorunum:'on'},design:{buffer:m.design,mime:'image/png',id:2},
  flat:{id:'tee',ad:'Sentetik tişört',refBeden:'L',olculerL:{omuzdan_boy:vertical(d)*560/10,etek:60}},product:'tisort',position:'gogus'};};

test('G44 10% axis difference keeps the arithmetic mean and no warning',async()=>{
  const r=await autoMeasure(tee(.10)),s=r.measure_source;
  assert.equal(r.needs_confirmation,false,r.reason);
  assert.equal(s.scaleMode,undefined);assert.equal(s.scaleNote,undefined);
  assert.equal(s.mmPerPx,(s.verticalMmPerPx+s.horizontalMmPerPx)/2);
  assert.equal(r.width_mm,Math.round(s.designBoxPx.w*s.mmPerPx));
});

test('G44 20% mockup difference measures with the geometric mean and a visible warning',async()=>{
  const r=await autoMeasure(tee(.20)),s=r.measure_source;
  assert.equal(r.needs_confirmation,false,r.reason);assert.equal(r.reasons.length,0);
  assert.equal(s.scaleMode,'geo_ortalama');
  assert.ok(Math.abs(s.mmPerPx-Math.sqrt(s.verticalMmPerPx*s.horizontalMmPerPx))<1e-9);
  assert.ok(Math.abs(s.verticalMmPerPx-vertical(.2))<.02&&Math.abs(s.horizontalMmPerPx-2)<.02);
  assert.equal(s.scaleNote,'Mockup oranı kalıptan farklı (%20,0); ölçek boy ile etek ortalaması.');
  // The artwork ratio is kept: both sides use the same single scale.
  assert.ok(Math.abs(r.width_mm/r.height_mm-s.designBoxPx.w/s.designBoxPx.h)<.02);
  assert.ok(r.width_mm>240*1.09&&r.width_mm<240*1.11,`${r.width_mm}`);
});

test('G44 40% difference is a mask or shoulder fault: confirmation, no size',async()=>{
  const r=await autoMeasure(tee(.40));
  assert.equal(r.needs_confirmation,true);assert.equal(r.width_mm,null);assert.equal(r.measure_source.mmPerPx,null);
  assert.match(r.reason,/Boy\/etek ölçek farkı %40,0; %35 sınırını aşıyor, maske veya omuz hatası olabilir/);
  assert.equal(r.measure_source.scaleMode,undefined);
});

// Front tee with hanging sleeves (G39c geometry); the sleeve scale comes from the body.
function sleeve(d) {
  const a=createCanvas(80,120),g=a.getContext('2d');
  g.fillStyle='#101824';g.fillRect(0,0,80,120);
  g.clearRect(8,8,35,33);g.clearRect(50,16,20,64);g.clearRect(8,60,20,52);g.clearRect(35,90,36,22);
  const c=createCanvas(600,650),x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,600,650);x.fillStyle='#a4b6b8';x.beginPath();
  [[180,80],[420,80],[495,110],[520,575],[450,585],[420,230],[420,580],[180,580],[180,230],[150,585],[80,575],[105,110]].forEach(([u,v],i)=>i?x.lineTo(u,v):x.moveTo(u,v));
  x.closePath();x.fill();x.drawImage(a,110,350,40,60);
  // 100.2 cm over the body height and 48 cm over the hem agree at 2 mm/px; widen the hem's L value.
  const etek=48*(2-d)/(2+d);
  return {image:{buffer:c.toBuffer('image/png'),mime:'image/png',gorunum:'on'},design:{buffer:a.toBuffer('image/png'),mime:'image/png'},
    flat:{id:'kol',ad:'Kol sentetik',refBeden:'L',olculerL:{omuzdan_boy:100.2,etek}},position:'kol'};
}
test('G44 a sleeve scaled from the body uses the same mockup rule',async()=>{
  const ok=await autoMeasure(sleeve(.20)),s=ok.measure_source;
  assert.equal(ok.needs_confirmation,false,ok.reason);assert.equal(s.scaleFrom,'govde');assert.equal(s.scaleMode,'geo_ortalama');
  assert.match(s.scaleNote,/Mockup oranı kalıptan farklı \(%[0-9,]+\); ölçek boy ile etek ortalaması/);
  assert.ok(Math.abs(s.mmPerPx-Math.sqrt(s.verticalMmPerPx*s.horizontalMmPerPx))<1e-9);
  const off=await autoMeasure(sleeve(.40));
  assert.equal(off.width_mm,null);assert.match(off.reason,/%35 sınırını aşıyor/);
});

// Light trousers at 1 mm/px: 801 px waist to hem, 300 px hip.
function pants(basen) {
  const d=createCanvas(80,120),a=d.getContext('2d');
  a.fillStyle='#101824';a.fillRect(0,0,80,120);
  a.clearRect(8,8,35,33);a.clearRect(50,16,20,64);a.clearRect(8,60,20,52);a.clearRect(35,90,36,22);
  const c=createCanvas(600,900),x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,600,900);x.fillStyle='#c8c2b4';
  x.fillRect(150,50,300,300);x.fillRect(150,350,145,501);x.fillRect(305,350,145,501);x.drawImage(d,340,200,80,120);
  return {image:{buffer:c.toBuffer('image/png'),mime:'image/png',gorunum:'on'},design:{buffer:d.toBuffer('image/png'),mime:'image/png'},
    flat:{id:'pants',ad:'EŞOFMAN',urun:'esofman',refBeden:'L',olculerL:{basen,yan_boy:80.1}},product:'esofman',position:'sol_bacak'};
}
test('G44 a leg print uses the mockup rule on yan_boy and basen',async()=>{
  const r=await autoMeasure(pants(30*2.2/1.8)),s=r.measure_source;
  assert.equal(r.needs_confirmation,false,r.reason);assert.equal(s.scaleMode,'geo_ortalama');
  assert.match(s.scaleNote,/ölçek yan boy ile basen ortalaması/);
  assert.ok(Math.abs(r.width_mm-80*Math.sqrt(2.2/1.8))<=2,`${r.width_mm}`);
  const off=await autoMeasure(pants(30*2.4/1.6));assert.equal(off.width_mm,null);assert.match(off.reason,/%35 sınırını aşıyor/);
});
