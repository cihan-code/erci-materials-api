'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {PDFDocument}=require('pdf-lib');
const {createCanvas}=require('@napi-rs/canvas');
const documents=require('../agent/siparis/documents');
const {REASON_TEXT,reasonTexts}=require('../agent/siparis/vectorReasons');

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
