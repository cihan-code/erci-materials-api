'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {PDFDocument}=require('pdf-lib');
const {createCanvas}=require('@napi-rs/canvas');
const documents=require('../agent/siparis/documents');
const {REASON_TEXT,reasonTexts}=require('../agent/siparis/vectorReasons');
const {PNG}=require('pngjs');
const {extractArtwork}=require('../agent/siparis/autoMeasure');

const BODY=[[200,45],[400,45],[540,175],[475,250],[450,215],[450,605],[150,605],[150,215],[125,250],[60,175]];
// Two invented navy tees side by side on a white sheet. Folds shift the
// cloth brightness by dozens of levels, as in a photographed mockup.
function pairSheet({openingAt='left',sidedAt='left',rays=true,date=true,seam=false}={}) {
  const c=createCanvas(1200,650),x=c.getContext('2d');
  x.fillStyle='#ffffff';x.fillRect(0,0,1200,650);
  for(const dx of [0,600]) {
    x.fillStyle='#243a78';x.beginPath();BODY.forEach(([a,b],i)=>i?x.lineTo(a+dx,b):x.moveTo(a+dx,b));x.closePath();x.fill();
  }
  const png=PNG.sync.read(c.toBuffer('image/png'));
  for(let i=0;i<png.data.length;i+=4)if(png.data[i]===36&&png.data[i+1]===58&&png.data[i+2]===120) {
    const p=i/4,k=1+.16*Math.sin((p%1200)/9+Math.floor(p/1200)/23);
    png.data.set([36*k,58*k,120*k].map(Math.round),i);
  }
  const out=createCanvas(1200,650),ctx=out.getContext('2d');
  ctx.putImageData(Object.assign(ctx.createImageData(1200,650),{}),0,0);
  const id=ctx.createImageData(1200,650);id.data.set(png.data);ctx.putImageData(id,0,0);
  // Shadowed inside of the neck, visible only on a front.
  const opening=openingAt==='left'?300:900;
  if(openingAt!=='none') {ctx.fillStyle='#0b1022';ctx.beginPath();ctx.ellipse(opening,66,58,18,0,0,Math.PI*2);ctx.fill();}
  ctx.fillStyle='#f4f4f4';
  // Small chest-side mark (wearer's left = image right of centre).
  const side=sidedAt==='left'?360:960;
  ctx.fillRect(side-22,200,44,10);ctx.fillRect(side-22,214,44,10);ctx.fillRect(side-22,200,8,24);
  // Back print on the other garment: a star whose rays taper to a point,
  // block lettering and, below it, a small date line.
  const cx=sidedAt==='left'?900:300;
  ctx.beginPath();ctx.moveTo(cx-80,300);ctx.lineTo(cx-64,292);ctx.lineTo(cx-48,300);ctx.lineTo(cx-64,308);ctx.closePath();ctx.fill();
  ctx.fillRect(cx-72,296,16,8);
  if(rays) {
    ctx.beginPath();ctx.moveTo(cx-64,236);ctx.lineTo(cx-60,294);ctx.lineTo(cx-68,294);ctx.closePath();ctx.fill();
    ctx.beginPath();ctx.moveTo(cx-64,364);ctx.lineTo(cx-60,306);ctx.lineTo(cx-68,306);ctx.closePath();ctx.fill();
  }
  for(let k=0;k<4;k++){ctx.fillRect(cx-36+k*30,280,10,40);ctx.fillRect(cx-36+k*30,280,24,10);ctx.fillRect(cx-36+k*30,310,24,10);}
  if(date)for(let k=0;k<4;k++)ctx.fillRect(cx-6+k*16,328,10,5);
  if(seam)ctx.fillRect(cx+82,296,70,3);
  return out.toBuffer('image/png');
}
const pairExtract=(buffer,position)=>extractArtwork({image:{buffer,mime:'image/png'},position,product:'tisort'});


// A scanned photo page: grain on a dark ground around a light mark, as a
// customer PDF exported from a phone. Every pixel differs from its neighbour.
async function grainyPdf(pages) {
  const doc=await PDFDocument.create();
  let seed=7;
  const random=()=>(seed=(seed*1103515245+12345)%2147483648)/2147483648;
  for(let n=0;n<pages;n++) {
    const canvas=createCanvas(900,1270),ctx=canvas.getContext('2d'),image=ctx.createImageData(900,1270);
    for(let i=0;i<image.data.length;i+=4) {
      const v=20+Math.floor(random()*60);
      image.data.set([v,v+5,v+30,255],i);
    }
    ctx.putImageData(image,0,0);
    ctx.fillStyle='#d8d8d8';ctx.font='bold 160px sans-serif';ctx.fillText('ABC',200,650);
    const jpg=await doc.embedJpg(canvas.toBuffer('image/jpeg',70));
    doc.addPage([595,842]).drawImage(jpg,{x:0,y:0,width:595,height:842});
  }
  return Buffer.from(await doc.save());
}

test('G41 a multi-page photo PDF finishes in the 64 MB vector worker instead of closing it', async()=> {
  const buffer=await grainyPdf(3);
  const result=await documents.generateInChild({type:'vector',designBox:true,input:{buffer,mime:'application/pdf'}},undefined,{timeoutMs:120000});
  assert.equal(result.kind,'raster');
  assert.equal(result.report.pageCount,3);
  assert.equal(result.report.quality,'teyit');
  // Downsampling is never silent: the operator is asked to compare details.
  assert.ok(result.report.reasons.some(r=>r.startsWith('Büyük raster bellek sınırı')));
  // Thinnest detail is measured in millimetres of the A4 page, not at 96 dpi pixels.
  assert.ok(result.report.minLineWidth>0.2 && result.report.minLineWidth<3,String(result.report.minLineWidth));
});

test('G41 every short vector quality code has Turkish text; sentences pass through', ()=> {
  const source=fs.readFileSync(path.join(__dirname,'../agent/siparis/vector.js'),'utf8');
  // Every lower-case code the vectorizer pushes, including the code side of a ternary.
  const codes=[...source.matchAll(/reasons\.push\(([^;]*)\);/g)].flatMap(m=>[...m[1].matchAll(/'([a-z]+(?:_[a-z]+)*)'/g)].map(c=>c[1]));
  assert.ok(codes.length>=8,codes.join());
  for(const code of codes)assert.ok(REASON_TEXT[code] && !/_/.test(REASON_TEXT[code]),code);
  assert.deepEqual(reasonTexts(['dolgu_detay_kalinligi_olculemedi','En ince çizgi güvenilir ölçülemedi.']),
    ['Dolgu detaylarının kalınlığı ölçülemedi.','En ince çizgi güvenilir ölçülemedi.']);
  assert.deepEqual(reasonTexts(undefined),[]);
});

test('G41 a front/back pair on dark cloth resolves by the neck opening and the chest-side mark', async()=> {
  const sheet=pairSheet();
  const front=await pairExtract(sheet,'sol_gogus');
  assert.ok(front.buffer,front.reason);
  assert.equal(front.placement.view,'on');
  // The sheet is read at 1000 px; expectations are in sheet pixels.
  const f=front.placement.rasterWidth/1200,at=v=>Math.round(v*f);
  assert.ok(Math.abs(front.placement.designBoxPx.x+front.placement.designBoxPx.w/2-at(360))<6,JSON.stringify(front.placement));
  const back=await pairExtract(sheet,'sirt');
  assert.ok(back.buffer,back.reason);
  assert.equal(back.placement.view,'arka');
  const box=back.placement.designBoxPx;
  // The whole print: both tapering rays and the date line under the lettering.
  assert.ok(box.y<=at(240)&&box.y+box.h>=at(360),JSON.stringify(box));
  assert.ok(box.x<=at(822)&&box.x+box.w>=at(976),JSON.stringify(box));
  const plain=(await pairExtract(pairSheet({rays:false}),'sirt')).placement.designBoxPx;
  assert.ok(plain.y+plain.h>=at(332)&&plain.y>at(270),JSON.stringify(plain));
  // Folded navy cloth becomes transparent; the white ink stays opaque.
  const png=PNG.sync.read(back.buffer),alpha=(x,y)=>png.data[((y-box.y)*png.width+x-box.x)*4+3];
  assert.equal(alpha(box.x+box.w-2,box.y+3),0);
  assert.equal(alpha(at(869),at(300)),255);
});

test('G41 conflicting or missing front evidence leaves a pair unresolved', async()=> {
  // The neck opening says right, the chest-side mark says left.
  const conflict=await pairExtract(pairSheet({openingAt:'right'}),'sirt');
  assert.equal(conflict.buffer,undefined);
  assert.match(conflict.reason,/birden çok görünüm/);
  // Dark cloth without any visible opening: the side mark alone is not enough.
  const unseen=await pairExtract(pairSheet({openingAt:'none'}),'sirt');
  assert.equal(unseen.buffer,undefined);
  assert.match(unseen.reason,/birden çok görünüm/);
});

test('G41 a flat stroke attached to the print is still a seam, not a ray', async()=> {
  const result=await pairExtract(pairSheet({seam:true}),'sirt');
  assert.equal(result.buffer,undefined);
  assert.match(result.reason,/dikiş/);
});
