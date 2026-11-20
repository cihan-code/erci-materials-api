'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createCanvas}=require('@napi-rs/canvas');
const {PDFDocument}=require('pdf-lib');
const {autoMeasure}=require('../agent/siparis/autoMeasure');

// Invented garments and artwork only. Shirt scale: 300 px hem = 60 cm, 2 mm/px.
const TEE={id:'tee-L',ad:'TİŞÖRT',urun:'tisort',refBeden:'L',olculerL:{omuzdan_boy:112.2,etek:60}};
const near=(n,expected,tolerance=.05)=>assert.ok(n!=null&&Math.abs(n/expected-1)<=tolerance,`${n} differs from ${expected}`);

// Wide, thin lettering: irregular glyph strokes, 10:1 like a one-line club name.
function lettering() {
  const c=createCanvas(400,40),x=c.getContext('2d');x.fillStyle='#ffffff';
  const widths=[5,3,7,4,6,3,5,8,4,3,6,5,7,3,4,6];
  let left=0;
  widths.forEach((w,i)=>{x.fillRect(left,0,w,40);if(i%3===0)x.fillRect(left,0,w*4,5);if(i%4===1)x.fillRect(left,35,w*3,5);if(i%5===2)x.fillRect(left,18,w*3,4);left+=w+(i%2?18:12);});
  x.fillRect(left,0,400-left,40);
  return c;
}
function tee({art,width,y=250,second=false,mark=false}) {
  const c=createCanvas(600,650),x=c.getContext('2d');
  x.fillStyle='#fafafa';x.fillRect(0,0,600,650);x.fillStyle='#244c77';x.beginPath();
  [[200,45],[400,45],[540,175],[475,250],[450,215],[450,605],[150,605],[150,215],[125,250],[60,175]].forEach(([a,b],i)=>i?x.lineTo(a,b):x.moveTo(a,b));
  x.closePath();x.fill();
  const height=width*art.height/art.width;
  x.drawImage(art,300-width/2,y,width,height);
  if(second)x.drawImage(art,300-width/2,y+150,width,height);
  // A spec-sheet dimension line in another color directly under the artwork.
  if(mark){x.fillStyle='#38b6e6';x.fillRect(300-width/2,y+height+3,width,4);}
  return c;
}
async function sheet(canvas,scale=1) {
  // The garment occupies a small part of a larger page, as on a supplier spec sheet.
  const pdf=await PDFDocument.create(),png=await pdf.embedPng(canvas.toBuffer('image/png'));
  const page=pdf.addPage([600*scale,1300*scale]);page.drawRectangle({x:0,y:0,width:600*scale,height:1300*scale,color:{type:'RGB',red:.98,green:.98,blue:.98}});
  page.drawImage(png,{x:0,y:650*scale,width:600*scale,height:650*scale});
  return Buffer.from(await pdf.save());
}
const png=c=>({buffer:c.toBuffer('image/png'),mime:'image/png'});

test('G41b thin lettering on a small PDF garment is found and sized from the L scale',async()=>{
  const art=lettering(),buffer=await sheet(tee({art,width:200}));
  const r=await autoMeasure({image:{buffer,mime:'application/pdf',gorunum:'on'},design:png(art),flat:TEE,product:'tisort',position:'gogus'});
  assert.equal(r.needs_confirmation,false,r.reason);
  near(r.width_mm,400);near(r.height_mm,40,.1);
  assert.ok(r.measure_source.rasterWidth>320,'page redrawn above the 320 px scan raster');
});

test('G41b thin lettering repeated on the same garment stays unmeasured',async()=>{
  const art=lettering(),buffer=await sheet(tee({art,width:200,y:230,second:true}));
  const r=await autoMeasure({image:{buffer,mime:'application/pdf',gorunum:'on'},design:png(art),flat:TEE,product:'tisort',position:'gogus'});
  assert.equal(r.width_mm,null);assert.equal(r.needs_confirmation,true);assert.match(r.reason,/birden fazla aday|eşleştirme güveni/);
});

test('G41b a dimension line beside thin lettering does not change its size',async()=>{
  const art=lettering(),buffer=await sheet(tee({art,width:200,mark:true}));
  const r=await autoMeasure({image:{buffer,mime:'application/pdf',gorunum:'on'},design:png(art),flat:TEE,product:'tisort',position:'gogus'});
  assert.equal(r.needs_confirmation,false,r.reason);near(r.width_mm,400);near(r.height_mm,40,.1);
});

// Front tee with hanging sleeves (G39c geometry) and a small dark sleeve mark.
const SLEEVE_FLAT={id:'sleeve-L',ad:'Kol sentetik',refBeden:'L',olculerL:{omuzdan_boy:100.2,etek:48,kol_boyu:100}};
function sleeveMock({mark=true,markColor='#38b6e6'}={}) {
  const d=createCanvas(80,120),a=d.getContext('2d');
  a.fillStyle='#101824';a.fillRect(0,0,80,120);
  a.clearRect(8,8,35,33);a.clearRect(50,16,20,64);a.clearRect(8,60,20,52);a.clearRect(35,90,36,22);
  const c=createCanvas(600,650),x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,600,650);x.fillStyle='#a4b6b8';
  x.beginPath();
  [[180,80],[420,80],[495,110],[520,575],[450,585],[420,230],[420,580],[180,580],[180,230],[150,585],[80,575],[105,110]].forEach(([u,v],i)=>i?x.lineTo(u,v):x.moveTo(u,v));
  x.closePath();x.fill();
  x.drawImage(d,110,350,40,60);
  // Label bar and its text 2 px under the artwork, as drawn on a supplier sheet.
  if(mark){x.fillStyle=markColor;x.fillRect(110,412,40,4);x.fillRect(118,419,6,9);x.fillRect(128,419,10,9);}
  return {image:{buffer:c.toBuffer('image/png'),mime:'image/png',gorunum:'on'},design:{buffer:d.toBuffer('image/png'),mime:'image/png'},flat:SLEEVE_FLAT,position:'kol'};
}
test('G41b a differently colored dimension mark beside a sleeve logo is not joined into it',async()=>{
  const r=await autoMeasure(sleeveMock());
  assert.equal(r.needs_confirmation,false,r.reason);near(r.width_mm,80,.08);near(r.height_mm,120,.08);
});
test('G41b a same-colored mark touching the sleeve logo still cannot be separated',async()=>{
  const r=await autoMeasure(sleeveMock({markColor:'#101824'}));
  assert.equal(r.width_mm,null);assert.equal(r.needs_confirmation,true);
});
