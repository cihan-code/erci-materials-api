'use strict';

// No database or filesystem access here: this module runs in the render worker.
let canvasLib; // Native canvas is loaded only in the child, never by HTTP routing.
const { imageSize } = require('./measure');
const MAX_EDGE = 1600;
const VIEW = {gogus:'on',sol_gogus:'on',sag_gogus:'on',kol:'on',sol_kol:'on',sag_kol:'on',sirt:'arka',ense:'arka',kapusan:'arka'};
const viewForPosition = position => VIEW[position] || 'teyit';
const median = a => a.slice().sort((x,y)=>x-y)[Math.floor(a.length/2)];
const distance = (a,b) => Math.max(...a.map((v,i)=>Math.abs(v-b[i])));

async function raster({buffer,mime}, maxEdge=MAX_EDGE) {
  canvasLib ||= require('@napi-rs/canvas');
  let source, doc;
  if (mime==='application/pdf') {
    for (const k of ['DOMMatrix','ImageData','Path2D']) globalThis[k] ||= canvasLib[k];
    class CanvasFactory {
      create(w,h) { const canvas=canvasLib.createCanvas(Math.ceil(w),Math.ceil(h)); return {canvas,context:canvas.getContext('2d')}; }
      reset(p,w,h) {p.canvas.width=w;p.canvas.height=h;}
      destroy(p) {p.canvas.width=p.canvas.height=0;}
    }
    const pdf=await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task=pdf.getDocument({data:Uint8Array.from(buffer),isEvalSupported:false,useSystemFonts:true,CanvasFactory,verbosity:0});
    try {
      doc=await task.promise;
      const page=await doc.getPage(1), raw=page.getViewport({scale:1});
      if (raw.width*raw.height>40e6) throw new Error('PDF sayfası 40 MP sınırını aşıyor.');
      const viewport=page.getViewport({scale:Math.min(2,maxEdge/Math.max(raw.width,raw.height))});
      source=canvasLib.createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));
      await page.render({canvasContext:source.getContext('2d'),viewport,canvasFactory:new CanvasFactory()}).promise;
    } finally {if(doc) await doc.destroy(); else await task.destroy();}
  } else {
    if (!['image/png','image/jpeg'].includes(mime)) throw new Error('Otomatik ölçü için PNG, JPG veya PDF gerekli.');
    imageSize(buffer,mime); // Reject oversized input BEFORE native decoding.
    source=await canvasLib.loadImage(buffer);
  }
  const scale=Math.min(1,maxEdge/Math.max(source.width,source.height));
  const c=canvasLib.createCanvas(Math.max(1,Math.round(source.width*scale)),Math.max(1,Math.round(source.height*scale)));
  c.getContext('2d').drawImage(source,0,0,c.width,c.height);
  return c.getContext('2d').getImageData(0,0,c.width,c.height);
}

function bounds(mask,w,h) {
  let x0=w,y0=h,x1=-1,y1=-1;
  for(let y=0;y<h;y++) for(let x=0;x<w;x++) if(mask[y*w+x]) {x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);}
  return x1<0 ? null : {x:x0,y:y0,w:x1-x0+1,h:y1-y0+1};
}
function flood(mask,w,h,seed,visited,queue) {
  let start=0,end=0;queue[end++]=seed;visited[seed]=1;
  while(start<end) {
    const p=queue[start++], x=p%w;
    for(const q of [x>0?p-1:-1,x<w-1?p+1:-1,p-w,p+w]) if(q>=0 && q<w*h && !visited[q] && mask[q]===mask[seed]) {visited[q]=1;queue[end++]=q;}
  }
  return end;
}
function largest(mask,w,h) {
  const visited=new Uint8Array(mask.length),queue=new Int32Array(mask.length),out=new Uint8Array(mask.length);
  let best=[];
  for(let p=0;p<mask.length;p++) if(mask[p] && !visited[p]) {const n=flood(mask,w,h,p,visited,queue);if(n>best.length)best=queue.slice(0,n);}
  for(const p of best)out[p]=1;
  return out;
}
function fillHoles(mask,w,h) {
  const outside=new Uint8Array(mask.length),queue=new Int32Array(mask.length);
  for(let p=0;p<mask.length;p++) if(!mask[p] && !outside[p] && (p<w || p>=w*(h-1) || p%w===0 || p%w===w-1)) flood(mask,w,h,p,outside,queue);
  return mask.map((v,i)=>v || !outside[i] ? 1 : 0);
}
function closeMask(mask,w,h) {
  // Small breaks in flat drawing outlines must close before filling their interiors.
  const r=5;
  function pass(input,horizontal,dilate) {
    const out=new Uint8Array(input.length);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++) {
      let v=dilate?0:1;
      for(let k=-r;k<=r;k++) {
        const xx=x+(horizontal?k:0),yy=y+(horizontal?0:k);
        const bit=xx>=0&&xx<w&&yy>=0&&yy<h?input[yy*w+xx]:0;
        if(dilate?bit:!bit){v=dilate?1:0;break;}
      }
      out[y*w+x]=v;
    }
    return out;
  }
  const e=pass(pass(pass(pass(mask,true,true),false,true),true,false),false,false);
  return e;
}
function dominant(p, indices) {
  const buckets=new Map();
  for(const i of indices) {if(p.data[i*4+3]<64)continue;const rgb=[p.data[i*4],p.data[i*4+1],p.data[i*4+2]],key=rgb.map(v=>v>>4).join(',');const b=buckets.get(key)||{n:0,sum:[0,0,0]};b.n++;rgb.forEach((v,j)=>b.sum[j]+=v);buckets.set(key,b);}
  const b=[...buckets.values()].sort((a,b)=>b.n-a.n)[0];return b ? b.sum.map(v=>v/b.n) : [255,255,255];
}
function productMask(p) {
  const {width:w,height:h,data}=p,edges=[];
  for(let x=0;x<w;x++){edges.push(x,(h-1)*w+x);}for(let y=0;y<h;y++)edges.push(y*w,y*w+w-1);
  const bg=dominant(p,edges),raw=new Uint8Array(w*h),alphaBackground=edges.filter(i=>data[i*4+3]<64).length>edges.length*.7;
  for(let i=0;i<raw.length;i++)raw[i]=data[i*4+3]>64 && (alphaBackground || distance([data[i*4],data[i*4+1],data[i*4+2]],bg)>35) ? 1:0;
  const mask=fillHoles(largest(closeMask(raw,w,h),w,h),w,h);
  return {mask,box:bounds(mask,w,h)};
}
function referencePixels(p,product='') {
  const {width:w,height:h}=p,{mask,box}=productMask(p);
  if(!box || box.w<20 || box.h<20) return {chestPx:null,mask,box,symmetry:0,sharpness:0};
  const cx=box.x+Math.floor(box.w/2), rows=[];
  for(let y=box.y;y<box.y+box.h;y++) {
    let l=cx,r=cx;
    if(mask[y*w+cx]) {while(l>0&&mask[y*w+l-1])l--;while(r<w-1&&mask[y*w+r+1])r++;}
    rows.push({y,l,r,width:mask[y*w+cx]?r-l+1:0});
  }
  let chestPx;
  if(['sort','esofman'].includes(product)) {
    // Last continuous body band before the crotch splits into two legs.
    let split=rows.findIndex((r,i)=>i>box.h*.22 && !r.width);
    if(split<0)split=Math.floor(box.h*.7);
    chestPx=Math.max(...rows.slice(Math.floor(box.h*.22),split).map(r=>r.width));
  } else {
    const band=rows.slice(Math.floor(box.h*.42),Math.floor(box.h*.76)).filter(r=>r.width>box.w*.27);
    chestPx=band.length ? median(band.map(r=>r.width)) : null;
    // Hanging sleeves remain connected at chest height. Torso seams are nearly
    // vertical through the middle band; sleeve edges move outwards down the arm.
    const support=new Float64Array(w);
    const y0=box.y+Math.floor(box.h*.38),y1=box.y+Math.floor(box.h*.68);
    const lum=i=>(p.data[i*4]+p.data[i*4+1]+p.data[i*4+2])/3;
    for(let y=y0;y<y1;y++)for(let x=box.x+2;x<box.x+box.w-2;x++) {
      const i=y*w+x, dark=Math.max(0,(lum(i-2)+lum(i+2))/2-lum(i));
      support[x]+=Math.min(90,dark);
    }
    const side=(left)=> {
      const lo=Math.max(2,Math.round(cx+(left?-.36:.13)*box.w)),hi=Math.min(w-3,Math.round(cx+(left?-.13:.36)*box.w));
      let best=lo;for(let x=lo;x<=hi;x++)if(support[x]>support[best])best=x;
      return support[best]/Math.max(1,y1-y0)>9 ? best:null;
    };
    const left=side(true),right=side(false);
    if(left!=null&&right!=null)chestPx=right-left;

  }
  let mismatch=0,total=0,gradient=0,n=0;
  for(let y=box.y;y<box.y+box.h;y++)for(let dx=0;dx<box.w/2;dx++) {
    const l=y*w+box.x+dx,r=y*w+box.x+box.w-1-dx;
    mismatch+=mask[l]!==mask[r]?1:0;total+=mask[l]||mask[r]?1:0;
  }
  for(let y=box.y+1;y<box.y+box.h-1;y++)for(let x=box.x+1;x<box.x+box.w-1;x++) {
    const i=y*w+x;
    if(mask[i] && (!mask[i-1]||!mask[i+1]||!mask[i-w]||!mask[i+w])) {
      const lum=j=>(p.data[j*4]+p.data[j*4+1]+p.data[j*4+2])/3;
      gradient+=Math.max(Math.abs(lum(i+1)-lum(i-1)),Math.abs(lum(i+w)-lum(i-w)));n++;
    }
  }
  return {chestPx,mask,box,rows,symmetry:1-mismatch/Math.max(1,total),sharpness:gradient/Math.max(1,n)};
}

function designContent(p) {
  const mask=new Uint8Array(p.width*p.height);
  const transparent=p.data.some((v,i)=>i%4===3 && v<128);
  for(let i=0;i<mask.length;i++)mask[i]=p.data[i*4+3]>32 && (transparent || Math.min(p.data[i*4],p.data[i*4+1],p.data[i*4+2])<240) ? 1:0;
  return {mask,box:bounds(mask,p.width,p.height)};
}
function resize(p,w,h) {
  const a=canvasLib.createCanvas(p.width,p.height);a.getContext('2d').putImageData(new canvasLib.ImageData(new Uint8ClampedArray(p.data),p.width,p.height),0,0);
  const b=canvasLib.createCanvas(w,h);b.getContext('2d').drawImage(a,0,0,w,h);return b.getContext('2d').getImageData(0,0,w,h);
}
function matchDesign(image,design,reference,initial=null) {
  const content=designContent(design);
  if(!content.box)return {box:null,confidence:0,ambiguous:false,content};
  const factor=Math.min(1,(initial?640:240)/Math.max(image.width,image.height)),small=resize(image,Math.round(image.width*factor),Math.round(image.height*factor));
  const w=small.width,h=small.height,mask=new Uint8Array(w*h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)mask[y*w+x]=reference.mask[Math.min(image.height-1,Math.floor(y/factor))*image.width+Math.min(image.width-1,Math.floor(x/factor))];
  const garment=dominant(small,Array.from(mask.keys()).filter(i=>mask[i])),bg=garment.reduce((s,v)=>s+v,0)/3;
  const gray=Float32Array.from(mask,(_,i)=>(small.data[i*4]+small.data[i*4+1]+small.data[i*4+2])/3);
  const edges=new Float32Array(w*h);
  for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){const i=y*w+x;edges[i]=Math.abs(gray[i+1]-gray[i-1])+Math.abs(gray[i+w]-gray[i-w]);}
  const cb=content.box,ratio=cb.h/cb.w, candidates=[];
  function template(width) {
    const height=width*ratio,pad=Math.max(1,width*.10),step=Math.max(1,width/(initial?18:9)),samples=[];
    for(let yy=-pad;yy<height+pad;yy+=step)for(let xx=-pad;xx<width+pad;xx+=step) {
      const sx=cb.x+Math.floor(xx/width*cb.w),sy=cb.y+Math.floor(yy/height*cb.h);
      const at=(x,y)=> {if(x<cb.x||y<cb.y||x>=cb.x+cb.w||y>=cb.y+cb.h)return bg;const j=y*design.width+x,a=content.mask[j]?design.data[j*4+3]/255:0;return a*(design.data[j*4]+design.data[j*4+1]+design.data[j*4+2])/3+(1-a)*bg;};
      const v=at(sx,sy),d=Math.max(1,Math.round(cb.w/width));
      samples.push({x:Math.round(xx),y:Math.round(yy),v,e:Math.abs(at(sx+d,sy)-at(sx-d,sy))+Math.abs(at(sx,sy+d)-at(sx,sy-d))});
    }
    const mean=samples.reduce((s,a)=>s+a.v,0)/samples.length,em=samples.reduce((s,a)=>s+a.e,0)/samples.length;
    let variance=0,ev=0;for(const a of samples){a.v-=mean;a.e-=em;variance+=a.v*a.v;ev+=a.e*a.e;}
    return {samples,variance,ev,height,pad};
  }
  function score(x,y,t) {
    let sum=0,sq=0,cross=0,es=0,esq=0,ec=0,inside=0;
    for(const a of t.samples){const xx=x+a.x,yy=y+a.y;if(xx<0||xx>=w||yy<0||yy>=h)return -1;const i=yy*w+xx,v=gray[i],e=edges[i];sum+=v;sq+=v*v;cross+=a.v*v;es+=e;esq+=e*e;ec+=a.e*e;inside+=mask[i];}
    if(inside<t.samples.length*.96)return -1;
    const n=t.samples.length,v=sq-sum*sum/n,ev=esq-es*es/n;
    if(v<1||t.variance<1)return -1;
    const ncc=cross/Math.sqrt(t.variance*v),edge=ev>1&&t.ev>1?ec/Math.sqrt(t.ev*ev):0;
    return .8*ncc+.2*Math.max(0,edge);
  }
  const rb=reference.box,min=Math.max(3,Math.round(reference.chestPx*factor*.03)),max=Math.min(w-4,Math.round(reference.chestPx*factor*.95));
  if(initial)candidates.push({x:Math.round(initial.box.x*factor),y:Math.round(initial.box.y*factor),width:Math.round(initial.box.w*factor),score:-1});
  else for(let width=min;width<=max;width=Math.max(width+1,Math.round(width*1.08))) {
    const t=template(width),step=Math.max(2,Math.floor(width/8));
    for(let y=Math.max(1,Math.floor(rb.y*factor));y<Math.min(h-t.height-1,(rb.y+rb.h)*factor);y+=step)for(let x=Math.max(1,Math.floor(rb.x*factor));x<Math.min(w-width-1,(rb.x+rb.w)*factor);x+=step) {
      const s=score(x,y,t);if(s>.45)candidates.push({x,y,width,score:s});
    }
  }
  candidates.sort((a,b)=>b.score-a.score);
  const refined=[];
  // Refine multiple spatial hypotheses, so repeated designs cannot look certain.
  const seeds=[];
  for(const c of candidates){if(seeds.every(a=>Math.hypot(c.x-a.x,c.y-a.y)>Math.min(c.width,a.width)*.35))seeds.push(c);if(seeds.length===6)break;}
  for(const seed of seeds) {
    let best=seed;
    const r=initial?5:Math.max(3,Math.ceil(seed.width/8));
    for(let width=Math.max(min,seed.width-Math.ceil(seed.width*.12));width<=Math.min(max,seed.width+Math.ceil(seed.width*.12));width++) {
      const t=template(width);
      for(let y=seed.y-r;y<=seed.y+r;y++)for(let x=seed.x-r;x<=seed.x+r;x++) {const s=score(x,y,t);if(s>best.score)best={x,y,width,score:s};}
    }
    refined.push(best);
  }
  refined.sort((a,b)=>b.score-a.score);
  const best=refined[0],second=best && refined.find(a=>Math.hypot(a.x-best.x,a.y-best.y)>best.width*.4);
  if(!best)return {box:null,confidence:0,ambiguous:false,content,garment};
  const result={box:{x:Math.round(best.x/factor),y:Math.round(best.y/factor),w:Math.round(best.width/factor),h:Math.round(best.width*ratio/factor)},confidence:best.score,ambiguous:!!second&&best.score-second.score<.045,content,garment};
  if(!initial && result.confidence>.65) {
    const fine=matchDesign(image,design,reference,result);
    fine.ambiguous ||= result.ambiguous;
    return fine;
  }
  if(initial)result.ambiguous=initial.ambiguous;
  return result;
}
function fallbackRegion(p,ref,garment) {
  garment ||= dominant(p,Array.from(ref.mask.keys()).filter(i=>ref.mask[i]));
  const mask=ref.mask.map((v,i)=>v&&distance([p.data[i*4],p.data[i*4+1],p.data[i*4+2]],garment)>65?1:0);
  // Erode away the garment silhouette before looking for ink.
  const margin=Math.max(2,Math.round(ref.chestPx*.025));
  for(let y=0;y<p.height;y++)for(let x=0;x<p.width;x++)if(mask[y*p.width+x]) {
    for(const [dx,dy] of [[margin,0],[-margin,0],[0,margin],[0,-margin]])if(x+dx<0||x+dx>=p.width||y+dy<0||y+dy>=p.height||!ref.mask[(y+dy)*p.width+x+dx]) {mask[y*p.width+x]=0;break;}
  }
  const box=bounds(largest(mask,p.width,p.height),p.width,p.height);
  return box && box.w*box.h>Math.max(100,ref.chestPx*ref.chestPx*.002) && Math.min(box.w,box.h)>ref.chestPx*.035 ? box : null;
}
async function autoMeasure({image,design,flat,flatImage,product,position}) {
  const reasons=[],source={method:'otomatik',flatId:flat?.id??null,flatAd:flat?.ad??null,refBeden:flat?.refBeden??null,refCm:flat?.refLengthCm??null,chestPx:null,designBoxPx:null,scale:null,confidence:0,gorselFileId:image?.id??null,desenFileId:design?.id??null};
  let width=null,height=null;
  const validReference=Number.isFinite(flat?.refLengthCm) && flat.refLengthCm>0;
  if(!validReference)reasons.push('Ürün için tek ve geçerli bir kalıp referansı bulunamadı.');
  if(flat?.refBeden && flat.refBeden!=='L')reasons.push('Kalıp referansı L beden değil; L ölçüsü teyit edilmeli.');
  if(viewForPosition(position)==='teyit')reasons.push('Uygulama konumu için görünüm eşlemesi bulunamadı.');
  try {
    if(flatImage && Number.isFinite(flat?.refLengthPx) && flat.refLengthPx>0) {
      const check=referencePixels(await raster(flatImage),product);
      if(!check.chestPx || Math.abs(check.chestPx/flat.refLengthPx-1)>.04)
        reasons.push('Kalıp öz denetimi kayıtlı piksel referansından %4 üzerinde farklı; ölçü teyit edilmeli.');
    }
    const p=await raster(image),d=await raster(design),ref=referencePixels(p,product);
    source.chestPx=ref.chestPx;
    if(!ref.chestPx)reasons.push('Ürün maskesi veya göğüs/basen genişliği bulunamadı.');
    else {
      if(ref.symmetry<.88 || ref.sharpness<18)reasons.push('Görsel perspektifli, fotoğraf veya kenarları bulanık; ölçü teyit edilmeli.');
      const match=matchDesign(p,d,ref);
      source.confidence=Math.round(Math.max(0,Math.min(1,match.confidence))*1000)/1000;
      let box=match.box;
      if(!box || match.confidence<.78) {reasons.push('Desen eşleştirme güveni düşük; farklı renk bölgesi yedek ölçümü teyit edilmeli.');box=fallbackRegion(p,ref,match.garment);}
      if(match.ambiguous)reasons.push('Birden fazla desen adayı birbirine yakın; yerleşim teyit edilmeli.');
      if(!box)reasons.push('Görselde desen bulunamadı.');
      source.designBoxPx=box;
      if(box && validReference && match.content.box) {
        source.scale=flat.refLengthCm/ref.chestPx;
        width=Math.round(box.w*source.scale*10);height=Math.round(width*match.content.box.h/match.content.box.w);
        const small=['sol_gogus','sag_gogus','kol','sol_kol','sag_kol','ense','kapusan'].includes(position);
        if(width<(small?15:30)||width>(small?200:350)||height<10||height>500||width<=0)reasons.push('Ölçü olağandışı; baskı en ve boyu teyit edilmeli.');
        if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<=0||height<=0) {
          reasons.push('Hesaplanan ölçü güvenli tam sayı sınırında değil.');width=height=null;
        }
      }
    }
  } catch(e) {reasons.push(`Otomatik ölçü okunamadı: ${e.message}`);}
  return {width_mm:width,height_mm:height,measure_source:source,needs_confirmation:reasons.length>0,reasons,reason:reasons.join(' ')};
}
module.exports={autoMeasure,raster,referencePixels,viewForPosition,designContent};
