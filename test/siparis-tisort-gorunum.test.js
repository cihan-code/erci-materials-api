'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createCanvas}=require('@napi-rs/canvas');
const {autoMeasure,raster,silhouettes}=require('../agent/siparis/autoMeasure');

function touchingShirts({depths=[35,11],lowerBridge=false}={}) {
  const canvas=createCanvas(800,425),ctx=canvas.getContext('2d');
  ctx.fillStyle='#fff';
  ctx.fillRect(0,0,canvas.width,canvas.height);
  for(const [i,depth] of depths.entries()){
    ctx.save();
    ctx.translate(i===0?247:549,40);
    ctx.fillStyle='#191921';
    ctx.beginPath();
    for(const [idx,[x,y]] of [[-68,0],[68,0],[157,74],[132,110],[95,82],[95,320],[-95,320],[-95,82],[-132,110],[-157,74]].entries()){
      if(idx===0)ctx.moveTo(x,y);
      else ctx.lineTo(x,y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle='#fff';
    ctx.beginPath();
    ctx.ellipse(0,0,43,depth,0,0,Math.PI*2);
    ctx.fill();
    ctx.fillRect(i===0?-40:-48,119,i===0?80:96,i===0?32:41);
    ctx.restore();
  }
  if(lowerBridge){
    ctx.fillStyle='#191921';
    ctx.fillRect(330,255,140,88);
  }
  return {buffer:canvas.toBuffer('image/png'),mime:'image/png'};
}
const flat={id:'sentetik-tisort',refBeden:'L',olculerL:{omuzdan_boy:64,etek:38}};
const measure=(image,position)=>autoMeasure({image,design:null,flat,product:'tisort',position});

test('G40e touching sleeves split at the lower gap and neckline assigns views independent of order',async()=>{
  for(const depths of [[35,11],[11,35]]){
    const image=touchingShirts({depths}),front=await measure(image,'gogus'),back=await measure(image,'sirt');
    for(const r of [front,back]){
      assert.equal(r.needs_confirmation,false,JSON.stringify(r));
      assert.equal(r.measure_source.views.length,2);
      for(const view of r.measure_source.views){
        assert.equal(view.splitMethod,'alt_govde_boslugu');
        assert.ok(Math.abs(view.hemWidthPx-190)<=2);
        assert.ok(Math.abs(view.bodyHeightPx-320)<=2,JSON.stringify(view));
      }
    }
    const frontIndex=depths.indexOf(35),backIndex=1-frontIndex;
    assert.equal(front.measure_source.selectedProductIndex,frontIndex);
    assert.equal(back.measure_source.selectedProductIndex,backIndex);
    assert.ok(Math.abs(front.width_mm-(frontIndex===0?160:192))<=4);
    assert.ok(Math.abs(back.width_mm-(backIndex===0?160:192))<=4);
  }
});

test('G40e two front variants preserve both product boxes and request view confirmation',async()=>{
  const r=await measure(touchingShirts({depths:[35,36]}),'sirt'),views=r.measure_source.views;
  assert.equal(views.length,2,JSON.stringify(r));
  assert.ok(views.every(view=>view.view==='teyit' && view.viewEvidence.neckDepth>.085));
  assert.ok(views[0].productBoxPx.x+views[0].productBoxPx.w<=views[1].productBoxPx.x);
  assert.equal(r.needs_confirmation,true);
  assert.equal(r.width_mm,null);
  assert.match(r.reason,/görünüm teyit edilmeli/);
});

test('G40e single products and a joined lower body do not trigger the two-shirt heuristic',async()=>{
  const image=touchingShirts({depths:[35]});
  const p=await raster(image);
  const [existing]=silhouettes(p),[shirt]=silhouettes(p,'tisort');
  assert.deepEqual(shirt.box,existing.box);
  assert.equal(shirt.bodyHeightPx,existing.bodyHeightPx);
  assert.equal(shirt.splitMethod,undefined);
  const r=await measure(image,'gogus');
  assert.equal(r.needs_confirmation,false,JSON.stringify(r));
  assert.equal(r.measure_source.views.length,1);
  assert.equal(r.width_mm,170);
  const joined=touchingShirts({lowerBridge:true});
  assert.ok(silhouettes(await raster(joined),'tisort').length<=1);
  const uncertain=await measure(joined,'gogus');
  assert.equal(uncertain.needs_confirmation,true,JSON.stringify(uncertain));
  assert.equal(uncertain.width_mm,null);
});

test('G40e PDF raster refinement preserves the same separated product and physical dimensions',async()=>{
  const {PDFDocument}=require('pdf-lib'),pdf=await PDFDocument.create();
  const image=await pdf.embedPng(touchingShirts({depths:[11,35]}).buffer);
  pdf.addPage([800,425]).drawImage(image,{width:800,height:425});
  const result=await measure({buffer:Buffer.from(await pdf.save()),mime:'application/pdf'},'gogus');
  assert.equal(result.needs_confirmation,false,JSON.stringify(result));
  assert.equal(result.measure_source.selectedPage,1);
  assert.equal(result.measure_source.selectedProductIndex,1);
  assert.equal(result.measure_source.rasterWidth,640);
  assert.ok(Math.abs(result.width_mm-192)<=5);
});
