'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {PDFDocument,StandardFonts}=require('pdf-lib');
const {createCanvas}=require('@napi-rs/canvas');
const {extractArtwork}=require('../agent/siparis/autoMeasure');

// Invented garments only: a plain tee outline, scaled and moved on a sheet.
const BODY=[[200,45],[400,45],[540,175],[475,250],[450,215],[450,605],[150,605],[150,215],[125,250],[60,175]];
function tee(ctx,{dx=0,dy=0,scale=1,fill}) {
  ctx.fillStyle=fill;ctx.beginPath();
  BODY.forEach(([x,y],i)=>i?ctx.lineTo(dx+x*scale,dy+y*scale):ctx.moveTo(dx+x*scale,dy+y*scale));
  ctx.closePath();ctx.fill();
}
function block(ctx,x,y,w,h,color='#f2f2f2') {
  ctx.fillStyle=color;
  for(let k=0;k<4;k++)ctx.fillRect(x+k*w/4,y,w/4-4,h);
}
const extract=(buffer,position,options={})=>extractArtwork({image:{buffer,mime:options.mime||'image/png'},position,product:'tisort',...options});

test('G45 a sheet of colour variants: the line colour picks its garment, without it the sheet stays unresolved', async()=> {
  const c=createCanvas(1200,650),x=c.getContext('2d');
  x.fillStyle='#ffffff';x.fillRect(0,0,1200,650);
  tee(x,{fill:'#1d2c5e'});tee(x,{dx:600,fill:'#6e1420'});
  block(x,240,250,120,40);block(x,840,250,120,40);
  const sheet=c.toBuffer('image/png');
  const navy=await extract(sheet,'gogus',{color:'Lacivert 2201'});
  assert.ok(navy.buffer,navy.reason);
  const box=navy.placement.designBoxPx,k=navy.placement.rasterWidth/1200;
  assert.ok(box.x+box.w<600*k,JSON.stringify(box));
  const maroon=await extract(sheet,'gogus',{color:'Bordo'});
  assert.ok(maroon.placement.designBoxPx.x>600*k);
  const unknown=await extract(sheet,'gogus');
  assert.equal(unknown.buffer,undefined);
  assert.match(unknown.reason,/birden çok/);
});

test('G45 the application position names one of two prints on a front', async()=> {
  const c=createCanvas(600,650),x=c.getContext('2d');
  x.fillStyle='#ffffff';x.fillRect(0,0,600,650);
  tee(x,{fill:'#1d2c5e'});
  block(x,220,290,160,70);
  // An L-shaped mark: a solid rectangle would read as a flat cloth patch.
  x.fillStyle='#f2f2f2';x.fillRect(350,215,12,30);x.fillRect(350,233,44,12);
  const sheet=c.toBuffer('image/png');
  const centre=await extract(sheet,'gogus');
  assert.ok(centre.buffer,centre.reason);
  assert.ok(Math.abs(centre.placement.designBoxPx.x+centre.placement.designBoxPx.w/2-300)<8,JSON.stringify(centre.placement));
  const side=await extract(sheet,'sol_gogus');
  assert.ok(side.buffer,side.reason);
  assert.ok(Math.abs(side.placement.designBoxPx.x+side.placement.designBoxPx.w/2-372)<8,JSON.stringify(side.placement));
  // A print too small to show detail at the source size is flagged, not trusted silently.
  assert.equal(centre.warnings.length,0);
  assert.equal(side.warnings.length,1);
  assert.match(side.warnings[0],/Küçük baskı/);
});

async function stackedPdf({caption=true,title='T-Shirt'}={}) {
  const c=createCanvas(500,1300),x=c.getContext('2d');
  x.fillStyle='#ffffff';x.fillRect(0,0,500,1300);
  tee(x,{dx:-50,dy:0,fill:'#c9cdd2'});tee(x,{dx:-50,dy:650,fill:'#c9cdd2'});
  // Back print on the upper garment, chest print on the lower one.
  block(x,190,240,140,90,'#14213d');block(x,210,650+260,100,30,'#14213d');
  const doc=await PDFDocument.create(),page=doc.addPage([500,1300]);
  page.drawImage(await doc.embedPng(c.toBuffer('image/png')),{x:0,y:0,width:500,height:1300});
  const font=await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(title,{x:20,y:1285,size:10,font});
  // A heading just above the lower garment, as on a measurement sheet.
  if(caption)page.drawText('ÖN GÖRÜNÜM',{x:220,y:1300-660,size:12,font});
  return Buffer.from(await doc.save());
}

test('G45 a printed "ÖN" caption settles a stacked pair; without it the pair stays open', async()=> {
  const back=await extract(await stackedPdf(),'sirt',{mime:'application/pdf'});
  assert.ok(back.buffer,back.reason);
  assert.equal(back.placement.view,'arka');
  assert.ok(back.placement.designBoxPx.y+back.placement.designBoxPx.h<back.placement.rasterHeight/2,JSON.stringify(back.placement));
  const open=await extract(await stackedPdf({caption:false}),'sirt',{mime:'application/pdf'});
  assert.equal(open.buffer,undefined);
  assert.match(open.reason,/birden çok görünüm/);
  // A catalogue page titled with another product is not this line's garment.
  const other=await extract(await stackedPdf({title:'S w e a t s h i r t'}),'sirt',{mime:'application/pdf'});
  assert.equal(other.buffer,undefined);
  assert.match(other.reason,/maske/);
});

test('G45 a small print in a PDF is read again at a higher resolution', async()=> {
  // The sheet carries more detail than the 640 px scan, as a vector mockup does.
  const c=createCanvas(1800,1950),x=c.getContext('2d');
  x.scale(3,3);x.fillStyle='#ffffff';x.fillRect(0,0,600,650);
  tee(x,{fill:'#1d2c5e'});
  x.fillStyle='#f2f2f2';x.fillRect(352,215,8,16);x.fillRect(352,225,30,6);
  // Rays that taper to a point above and below the mark.
  x.beginPath();x.moveTo(367,200);x.lineTo(369,227);x.lineTo(365,227);x.closePath();x.fill();
  x.beginPath();x.moveTo(367,246);x.lineTo(369,231);x.lineTo(365,231);x.closePath();x.fill();
  const doc=await PDFDocument.create(),page=doc.addPage([1200,1300]);
  page.drawImage(await doc.embedPng(c.toBuffer('image/png')),{x:0,y:0,width:1200,height:1300});
  const result=await extract(Buffer.from(await doc.save()),'sol_gogus',{mime:'application/pdf'});
  assert.ok(result.buffer,result.reason);
  // The scan raster is 640 px on its long edge; the crop comes from a sharper one.
  assert.ok(result.placement.rasterHeight>640,JSON.stringify(result.placement));
  // The thin rays above and below the mark stay part of it.
  const box=result.placement.designBoxPx,k=result.placement.rasterHeight/650;
  assert.ok(box.y<=Math.ceil(201*k)&&box.y+box.h>=Math.floor(245*k),JSON.stringify(result.placement));
});
