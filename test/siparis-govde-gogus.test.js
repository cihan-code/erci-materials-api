'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createCanvas}=require('@napi-rs/canvas');
const {autoMeasure}=require('../agent/siparis/autoMeasure');
function mock({product='sweat',touching=false,seams=true,sleeve=false,repeated=false,small=false,damage=0,secondDamage=damage,wrong=false}={}) {
  const art=createCanvas(80,120),a=art.getContext('2d');
  a.fillStyle='#101824';a.fillRect(0,0,80,120);a.clearRect(8,8,35,33);a.clearRect(50,16,20,64);a.clearRect(8,60,20,52);a.clearRect(35,90,36,22);
  const c=createCanvas(600,650),x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,600,650);x.fillStyle='#a4b6b8';x.beginPath();
  const pts=touching?[[180,80],[420,80],[495,110],[520,575],[450,585],[420,500],[400,580],[200,580],[180,500],[150,585],[80,575],[105,110]]:[[180,80],[420,80],[495,110],[520,575],[450,585],[420,230],[420,500],[400,580],[200,580],[180,500],[180,230],[150,585],[80,575],[105,110]];
  pts.forEach(([u,v],i)=>i?x.lineTo(u,v):x.moveTo(u,v));x.closePath();x.fill();
  if(touching&&seams){x.strokeStyle='#58676a';x.lineWidth=3;for(const u of [180,420]){x.beginPath();x.moveTo(u,160);x.lineTo(u,500);x.stroke();}}
  const draw=(left,loss=damage)=>{const w=small?20:40,h=small?30:60;x.drawImage(art,left,350,w,h);if(loss){x.fillStyle='#a4b6b8';for(let i=0;i<loss;i++)x.fillRect(left+(i*7)%w,350+(i*11)%h,2,2);}};
  draw(sleeve?110:280);if(repeated)draw(470,secondDamage);
  if(wrong){a.clearRect(0,0,80,120);a.fillStyle='#101824';a.beginPath();a.arc(40,60,32,0,Math.PI*2);a.fill();}
  return {image:{buffer:c.toBuffer('image/png'),mime:'image/png',gorunum:'on'},design:{buffer:art.toBuffer('image/png'),mime:'image/png'},flat:{id:'gogus-L',ad:'Sentetik',urun:product,refBeden:'L',olculerL:{omuzdan_boy:100.2,gogus:48,etek:30}},product,position:sleeve?'kol':'gogus'};
}
const near=(n,v,t=6)=>assert.ok(n!=null&&Math.abs(n-v)<=t,`${n} ≠ ${v}`);
test('G39d ribbed sweat uses underarm chest, not the contracted hem',async()=>{
  const r=await autoMeasure(mock());assert.equal(r.needs_confirmation,false,JSON.stringify(r));near(r.width_mm,80);near(r.height_mm,120);
  assert.equal(r.measure_source.scalePair,'boy_gogus');near(r.measure_source.chestPx,240,2);assert.ok(r.measure_source.chestLinePx.y>=230&&r.measure_source.chestLinePx.y<300);assert.ok(r.measure_source.hemWidthPx<r.measure_source.chestPx);
});
test('G39d touching sleeves separate only with persistent bilateral side edges',async()=>{
  const r=await autoMeasure(mock({touching:true}));assert.equal(r.needs_confirmation,false,JSON.stringify(r));near(r.width_mm,80);near(r.measure_source.chestPx,240,8);assert.equal(r.measure_source.chestLinePx.method,'yapisik_kol_surekli_yan_kenar');
  const ambiguous=await autoMeasure(mock({touching:true,seams:false}));assert.equal(ambiguous.width_mm,null);assert.equal(ambiguous.needs_confirmation,true);assert.equal(ambiguous.measure_source.chestLinePx,null);assert.match(ambiguous.reason,/göğüs/);
});
test('G39d product keys choose one shared scale policy, including the sleeve path',async()=>{
  for(const product of ['sweat','sweatshirt','hoodie','kapusonlu','polar','tam_fermuar']) {
    const m=mock({product,sleeve:true}),r=await autoMeasure(m);assert.equal(r.needs_confirmation,false,JSON.stringify(r));near(r.width_mm,80);assert.equal(r.measure_source.scalePair,'boy_gogus');
  }
  const fallback=mock();delete fallback.flat.urun;assert.equal((await autoMeasure(fallback)).measure_source.scalePair,'boy_gogus');
});
test('G39d t-shirt and polo ignore chest changes and keep height/hem measurements',async()=>{
  for(const product of ['tisort','polo']) {
    const m=mock({product});m.flat.olculerL.etek=42;
    const before=await autoMeasure(m);m.flat.olculerL.gogus=900;
    const after=await autoMeasure(m);assert.equal(before.needs_confirmation,false,JSON.stringify(before));assert.equal(after.width_mm,before.width_mm);assert.equal(after.height_mm,before.height_mm);assert.equal(after.measure_source.scalePair,'boy_etek');
  }
});
test('G39d missing or conflicting chest never falls back to hem or a single scale',async()=>{
  for(const gogus of [undefined,0,NaN,Infinity,70]) {
    const m=mock();m.flat.olculerL.gogus=gogus;const r=await autoMeasure(m);assert.equal(r.width_mm,null,JSON.stringify(r));assert.equal(r.needs_confirmation,true);assert.match(r.reason,/göğüs/);
  }
  const m=mock();delete m.flat.olculerL.omuzdan_boy;assert.equal((await autoMeasure(m)).width_mm,null);
});
test('G39d the unchanged 15 percent scale guard brackets chest/height disagreement',async()=>{
  const valid=mock();valid.flat.olculerL.gogus=55.2;
  const accepted=await autoMeasure(valid);assert.ok(accepted.measure_source.scaleDifference<.15);assert.equal(accepted.needs_confirmation,false,JSON.stringify(accepted));
  valid.flat.olculerL.gogus=56.64;
  const rejected=await autoMeasure(valid);assert.ok(rejected.measure_source.scaleDifference>.15);assert.equal(rejected.width_mm,null);assert.match(rejected.reason,/Boy\/göğüs ölçek farkı/);
});
test('G39d raster loss on a unique small sleeve print can pass without loosening large-print matching',async()=>{
  const r=await autoMeasure(mock({sleeve:true,small:true,damage:40}));assert.equal(r.needs_confirmation,false,JSON.stringify(r));near(r.width_mm,40);near(r.height_mm,60);
  assert.ok(r.measure_source.confidence>=.65&&r.measure_source.confidence<.78);assert.equal(r.measure_source.matchPolicy,'kucuk_ayrik_desen');
  // Both observed candidates are below .78 and more than the old .045 apart.
  const close=await autoMeasure(mock({sleeve:true,small:true,damage:40,repeated:true,secondDamage:60}));
  assert.ok(close.measure_source.matchMargin>.045&&close.measure_source.matchMargin<.10);assert.equal(close.width_mm,null);assert.match(close.reason,/belirsiz/);
});
test('G39d small sleeve artwork keeps repeated and incorrect candidates in confirmation',async()=>{
  const good=await autoMeasure(mock({sleeve:true,small:true}));assert.equal(good.needs_confirmation,false,JSON.stringify(good));near(good.width_mm,40);near(good.height_mm,60);
  const repeat=await autoMeasure(mock({sleeve:true,small:true,repeated:true}));assert.equal(repeat.width_mm,null);assert.match(repeat.reason,/belirsiz/);
  const wrong=await autoMeasure(mock({sleeve:true,small:true,wrong:true}));assert.equal(wrong.width_mm,null);assert.equal(wrong.needs_confirmation,true);
});
