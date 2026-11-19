'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createCanvas,loadImage}=require('@napi-rs/canvas');
const {autoMeasure,raster,silhouettes}=require('../agent/siparis/autoMeasure');
const {mockup}=require('./fixtures/siparis/oto-mockup');
const flat={id:'sentetik',refBeden:'L',olculerL:{omuzdan_boy:112.2,etek:60}};
const input=(image,design,extra={})=>({image:{buffer:image,mime:'image/png'},design:design?{buffer:design,mime:'image/png'}:null,flat,position:'gogus',product:'tisort',...extra});

// All artwork is invented in code. The white body is identical to the page:
// only its blurred, symmetric boundary shadow separates it from the exterior.
async function pale({color='#ffffff',print=true,asymmetric=false}={}) {
  const m=mockup(),c=createCanvas(600,650),x=c.getContext('2d');
  x.fillStyle='#fff';x.fillRect(0,0,600,650);
  x.shadowColor='#aaa';x.shadowBlur=5;x.fillStyle=color;x.beginPath();
  const points=[[200,45],[400,45],[540,175],[475,250],[450,215],[450,605],[150,605],[150,215],[125,250],[60,175]];
  points.forEach(([a,b],i)=>i?x.lineTo(a,b):x.moveTo(a,b));x.closePath();x.fill();x.shadowBlur=0;
  if(asymmetric){x.fillStyle='#fff';x.fillRect(415,300,150,305);}
  if(print)x.drawImage(await loadImage(m.design),10,10,160,90,240,265,120,67.5);
  return {image:c.toBuffer('image/png'),design:m.design};
}

for(const [name,color] of [['beyaz','#ffffff'],['ekru','#fcfbf7'],['gri','#f4f4f4']])test(`G36 beyaz zeminde gölgeli ${name} ürünün dış hattı ve baskısı ölçülür`,async()=>{
  const m=await pale({color}),r=await autoMeasure(input(m.image,m.design)),s=r.measure_source;
  assert.equal(r.needs_confirmation,false,JSON.stringify(r));
  if(name==='beyaz')assert.equal(s.maskMethod,'acik_zemin_bolge');
  assert.ok(Math.abs(s.hemWidthPx-300)<=10,JSON.stringify(s));
  assert.ok(Math.abs(r.width_mm-240)<=6,JSON.stringify(r));
  assert.ok(Math.abs(r.height_mm-135)<=6,JSON.stringify(r));
  assert.ok(s.symmetry>=.85&&s.scaleDifference<=.15);
});

test('G36 ürün içindeki baskı ve beyaz boşluklar gövde maskesini bölmez',async()=>{
  const printed=await pale(),empty=await pale({print:false});
  const [a,b]=await Promise.all([printed,empty].map(async m=>silhouettes(await raster({buffer:m.image,mime:'image/png'}))));
  assert.equal(a.length,1);assert.equal(b.length,1);
  assert.deepEqual(a[0].box,b[0].box);assert.equal(a[0].hemWidthPx,b[0].hemWidthPx);
  assert.equal(a[0].bodyHeightPx,b[0].bodyHeightPx);
  assert.ok(a[0].mask[300*600+300]);
});

async function sheet({repeated=false,unmatched=false,light=false,scales=[.5,.5,.5]}={}) {
  const c=createCanvas(1100,800),x=c.getContext('2d'),m=mockup();
  x.fillStyle=light?'#fff':'#fafafa';x.fillRect(0,0,c.width,c.height);
  for(let i=0;i<3;i++) {
    const garment=light&&i===1?await pale():mockup({missing:unmatched||(!repeated&&i!==1)});
    x.drawImage(await loadImage(garment.image),i*365,150,600*scales[i],650*scales[i]);
    if(unmatched) {
      x.fillStyle='#ff9f20';x.beginPath();x.arc(i*365+300*scales[i],150+300*scales[i],55*scales[i],0,Math.PI*2);x.fill();
    }
  }
  return {image:c.toBuffer('image/png'),design:m.design};
}

test('G36 bir sayfada üç ayrı ürün bulunur, dosyadaki desenin ürünü seçilir',async()=>{
  // Different rendering sizes are independent products, not a front/back pair.
  const m=await sheet({scales:[.4,.5,.55]}),r=await autoMeasure(input(m.image,m.design)),s=r.measure_source;
  assert.equal(s.views.length,3,JSON.stringify(r));assert.equal(s.selectedProductIndex,1);
  assert.equal(s.productSelection,'desen');assert.ok(s.productBoxPx.x>365&&s.productBoxPx.x<500);
  assert.ok(Math.abs(r.width_mm-240)<=6,JSON.stringify(r));
  assert.ok(Math.abs(r.height_mm-135)<=6,JSON.stringify(r));assert.equal(r.needs_confirmation,false,JSON.stringify(r));
});

test('G36 karışık sayfada koyu ürünler korunurken beyaz ürün ayrıca bulunur',async()=>{
  const m=await sheet({light:true}),r=await autoMeasure(input(m.image,m.design));
  assert.equal(r.measure_source.views.length,3,JSON.stringify(r));
  assert.equal(r.measure_source.maskMethod,'acik_zemin_bolge');
  assert.equal(r.needs_confirmation,false,JSON.stringify(r));assert.ok(Math.abs(r.width_mm-240)<=8,JSON.stringify(r));
});

test('G36 üç üründe tekrarlanan desen ölçü uydurmadan Türkçe teyit ister',async()=>{
  const m=await sheet({repeated:true}),r=await autoMeasure(input(m.image,m.design));
  assert.equal(r.measure_source.views.length,3);assert.equal(r.needs_confirmation,true);
  assert.equal(r.width_mm,null);assert.equal(r.height_mm,null);assert.match(r.reason,/birden fazla aday|güven.*sınırının altında/);
});

test('G36 çok ürünlü sayfada bulunamayan desen başka baskıyla değiştirilmez',async()=>{
  const m=await sheet({unmatched:true}),r=await autoMeasure(input(m.image,m.design));
  assert.equal(r.measure_source.views.length,3);assert.equal(r.needs_confirmation,true);
  assert.equal(r.width_mm,null);assert.match(r.reason,/bulunamadı|güven.*sınırının altında|birden fazla aday/);
});

test('G36 PDF ürün sayfası yüksek çözünürlükte aynı ürünü korur',async()=>{
  const {PDFDocument}=require('pdf-lib'),m=await sheet(),pdf=await PDFDocument.create(),im=await pdf.embedPng(m.image);
  pdf.addPage([1100,800]).drawImage(im,{width:1100,height:800});
  const r=await autoMeasure(input(m.image,m.design,{image:{buffer:Buffer.from(await pdf.save()),mime:'application/pdf'}}));
  assert.equal(r.measure_source.views.length,3,JSON.stringify(r));
  assert.equal(r.measure_source.selectedProductIndex,1,JSON.stringify(r));
  assert.equal(r.needs_confirmation,false,JSON.stringify(r));assert.ok(Math.abs(r.width_mm-240)<=8,JSON.stringify(r));
});

test('G36 açık üründe çelişen ya da eksik ölçekler ve düşük simetri teyit ister',async()=>{
  const m=await pale();
  const badScale=await autoMeasure(input(m.image,m.design,{flat:{...flat,olculerL:{omuzdan_boy:75,etek:60}}}));
  assert.equal(badScale.needs_confirmation,true);assert.equal(badScale.width_mm,null);assert.match(badScale.reason,/Boy\/etek ölçek farkı/);
  const single=await autoMeasure(input(m.image,m.design,{flat:{...flat,olculerL:{etek:60}}}));
  assert.equal(single.needs_confirmation,true);assert.match(single.reason,/iki L ölçüsüyle teyit/);
  const asym=await pale({asymmetric:true}),r=await autoMeasure(input(asym.image,asym.design));
  assert.equal(r.needs_confirmation,true);assert.match(r.reason,/simetri|bulunamadı/);
});

test('G36 koyu kapaktaki küçük çerçeveli logo ürün sayılmaz',async()=>{
  const c=createCanvas(600,400),x=c.getContext('2d');x.fillStyle='#3c4061';x.fillRect(0,0,600,400);
  x.strokeStyle='white';x.lineWidth=3;x.strokeRect(250,70,75,90);x.beginPath();x.ellipse(287,115,20,35,0,0,Math.PI*2);x.stroke();
  const refs=silhouettes(await raster({buffer:c.toBuffer('image/png'),mime:'image/png'}));
  assert.equal(refs.length,0);
});
