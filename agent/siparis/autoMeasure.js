'use strict';

// No database or filesystem access here: this module runs in the render worker.
let canvasLib; // Native canvas is loaded only in the child, never by HTTP routing.
const { imageSize, measureSleeve } = require('./measure');
// Measurement uses a bounded raster; original uploads and their dimensions stay intact.
const MAX_EDGE = 2000;
const MIN_SYMMETRY = .85, MIN_MATCH_CONFIDENCE = .78;
// A photo may distort either axis. This guard catches a distinctly different
// motif before sizing; the production vector has its own aspect policy.
const COLOR_ASPECT_TOLERANCE = .30;
// A thin design at least this fraction of the chest wide must keep 8 px
// across its short side in the template search, within a bounded raster.
const THIN_MIN_WIDTH = .2, THIN_CHEST_PX = 240, PDF_THIN_MAX_EDGE = 1600;
// Ink colors farther apart than this (max channel) are separate print layers.
const INK_LAYER_DISTANCE = 80;
// A refined PDF template match should span this many pixels on its long side.
const REFINE_DESIGN_PX = 120;
// Product keys, not inferred garment names or the presence of a chest number.
const CHEST_SCALE_PRODUCTS = new Set(['sweat','sweatshirt','hoodie','kapusonlu','polar','tam_fermuar','yarim_fermuar']);
const scalePairFor = (flat,product) => CHEST_SCALE_PRODUCTS.has(String(flat?.urun||product||'').trim().toLowerCase())?'boy_gogus':'boy_etek';
const percent = n => (n*100).toLocaleString('tr-TR',{minimumFractionDigits:1,maximumFractionDigits:4});
const VIEW = {gogus:'on',sol_gogus:'on',sag_gogus:'on',kol:'on',sol_kol:'on',sag_kol:'on',sirt:'arka',ense:'arka',kapusan:'arka',bacak:'on',sol_bacak:'on',sag_bacak:'on'};
const LEGS = ['bacak','sol_bacak','sag_bacak'];
const viewForPosition = position => VIEW[position] || 'teyit';
const median = a => a.slice().sort((x,y)=>x-y)[Math.floor(a.length/2)];
const distance = (a,b) => Math.max(...a.map((v,i)=>Math.abs(v-b[i])));

async function rasterPages({buffer,mime}, maxEdge=1000, selectedPages=null, {transparent=false}={}) {
  canvasLib ||= require('@napi-rs/canvas');
  if (mime==='application/pdf') {
    for (const k of ['DOMMatrix','ImageData','Path2D']) globalThis[k] ||= canvasLib[k];
    class CanvasFactory {
      create(w,h) {const canvas=canvasLib.createCanvas(Math.ceil(w),Math.ceil(h));return {canvas,context:canvas.getContext('2d')};}
      reset(p,w,h) {p.canvas.width=w;p.canvas.height=h;}
      destroy(p) {p.canvas.width=p.canvas.height=0;}
    }
    const pdf=await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task=pdf.getDocument({data:Uint8Array.from(buffer),isEvalSupported:false,useSystemFonts:true,CanvasFactory,verbosity:0});
    let doc;
    try {
      doc=await task.promise; const pages=[];
      // Every page is inspected, including product pages after covers and notes.
      for(let n=1;n<=doc.numPages;n++) {
        if(selectedPages && !selectedPages.includes(n))continue;
        const page=await doc.getPage(n),raw=page.getViewport({scale:1});
        if(raw.width*raw.height>40e6)throw new Error('PDF sayfası 40 MP sınırını aşıyor.');
        const viewport=page.getViewport({scale:Math.min(2,maxEdge/Math.max(raw.width,raw.height))});
        const canvas=canvasLib.createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));
        const background=transparent?'rgba(0,0,0,0)':undefined;
        await page.render({canvasContext:canvas.getContext('2d'),viewport,background,canvasFactory:new CanvasFactory()}).promise;
        pages.push(canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height));
        canvas.width=canvas.height=0;page.cleanup();
      }
      return pages;
    } finally {if(doc)await doc.destroy();else await task.destroy();}
  }
  if(!['image/png','image/jpeg'].includes(mime))throw new Error('Otomatik ölçü için PNG, JPG veya PDF gerekli.');
  imageSize(buffer,mime);
  const source=await canvasLib.loadImage(buffer);
  // A large source already holds >16 MB of decoded pixels; reserve memory for masks.
  const edge=source.width*source.height>4e6 ? Math.min(maxEdge,1000) : maxEdge;
  const scale=Math.min(1,edge/Math.max(source.width,source.height));
  const c=canvasLib.createCanvas(Math.max(1,Math.round(source.width*scale)),Math.max(1,Math.round(source.height*scale)));
  c.getContext('2d').drawImage(source,0,0,c.width,c.height);
  const pixels=c.getContext('2d').getImageData(0,0,c.width,c.height);
  c.width=c.height=0;
  return [pixels];
}
async function raster(input,maxEdge=MAX_EDGE) {return (await rasterPages(input,maxEdge))[0];}

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
  const r=2;
  // Running window counts; outside the raster counts as background, so an
  // erosion keeps a pixel only when its whole window is inside and set.
  function pass(input,horizontal,dilate) {
    const out=new Uint8Array(input.length),lines=horizontal?h:w,length=horizontal?w:h,step=horizontal?1:w,full=2*r+1;
    for(let line=0;line<lines;line++) {
      const base=horizontal?line*w:line;
      let count=0;
      for(let k=0;k<Math.min(r,length);k++)count+=input[base+k*step];
      for(let t=0;t<length;t++) {
        if(t+r<length)count+=input[base+(t+r)*step];
        if(t-r-1>=0)count-=input[base+(t-r-1)*step];
        out[base+t*step]=dilate?(count>0?1:0):(count===full&&t-r>=0&&t+r<length?1:0);
      }
    }
    return out;
  }
  const e=pass(pass(pass(pass(mask,true,true),false,true),true,false),false,false);
  return e;
}
function dominant(p, indices) {
  // Mode of 4-bit RGB buckets; ties go to the bucket seen first. Typed
  // counters avoid one string and array per pixel on large masks.
  const n=new Uint32Array(4096),sum=new Float64Array(4096*3),first=new Int32Array(4096).fill(-1),data=p.data;
  let order=0,best=-1;
  for(const i of indices) {
    if(data[i*4+3]<64)continue;
    const r=data[i*4],g=data[i*4+1],b=data[i*4+2],key=(r>>4)<<8|(g>>4)<<4|(b>>4);
    if(first[key]<0)first[key]=order++;
    n[key]++;sum[key*3]+=r;sum[key*3+1]+=g;sum[key*3+2]+=b;
  }
  for(let key=0;key<4096;key++)if(n[key]&&(best<0||n[key]>n[best]||n[key]===n[best]&&first[key]<first[best]))best=key;
  return best<0 ? [255,255,255] : [sum[best*3]/n[best],sum[best*3+1]/n[best],sum[best*3+2]/n[best]];
}
function productMask(p) {
  const {width:w,height:h,data}=p,edges=[];
  for(let x=0;x<w;x++){edges.push(x,(h-1)*w+x);}for(let y=0;y<h;y++)edges.push(y*w,y*w+w-1);
  const bg=dominant(p,edges),raw=new Uint8Array(w*h),alphaBackground=edges.filter(i=>data[i*4+3]<64).length>edges.length*.7;
  for(let i=0;i<raw.length;i++) {
    const delta=Math.max(Math.abs(data[i*4]-bg[0]),Math.abs(data[i*4+1]-bg[1]),Math.abs(data[i*4+2]-bg[2])),x=i%w,y=Math.floor(i/w);
    const lum=j=>(data[j*4]+data[j*4+1]+data[j*4+2])/3;
    const edge=x>0&&x<w-1&&y>0&&y<h-1?Math.max(Math.abs(lum(i+1)-lum(i-1)),Math.abs(lum(i+w)-lum(i-w))):0;
    // Smooth light shadows stay outside; a pale garment's sharp outline can
    // close and fill even when its interior is close to the edge background.
    raw[i]=data[i*4+3]>64&&(alphaBackground||delta>(Math.min(...bg)>240?16:35)||(delta>6&&edge>24))?1:0;
  }
  const mask=fillHoles(largest(closeMask(raw,w,h),w,h),w,h);
  return {mask,raw,background:bg,box:bounds(mask,w,h)};
}

function designContent(p,removeMatte=false) {
  const mask=new Uint8Array(p.width*p.height);
  const transparent=p.data.some((v,i)=>i%4===3 && v<128);
  const [r,g,b]=p.data,delta=i=>Math.max(Math.abs(p.data[i*4]-r),Math.abs(p.data[i*4+1]-g),Math.abs(p.data[i*4+2]-b));
  let matte=removeMatte&&!transparent&&Math.min(r,g,b)<240;
  // A colored proof background is used only when the four edges agree.
  // Leave transparent artwork and existing light-background masks alone.
  if(matte) {
    for(let x=0;x<p.width&&matte;x++)matte=delta(x)<=12&&delta((p.height-1)*p.width+x)<=12;
    for(let y=0;y<p.height&&matte;y++)matte=delta(y*p.width)<=12&&delta((y+1)*p.width-1)<=12;
  }
  for(let i=0;i<mask.length;i++)mask[i]=p.data[i*4+3]>32 && (transparent || (matte ? delta(i)>20 : Math.min(p.data[i*4],p.data[i*4+1],p.data[i*4+2])<240)) ? 1:0;
  return {mask,box:bounds(mask,p.width,p.height)};
}
function resize(p,w,h) {
  const a=canvasLib.createCanvas(p.width,p.height);a.getContext('2d').putImageData(new canvasLib.ImageData(new Uint8ClampedArray(p.data),p.width,p.height),0,0);
  const b=canvasLib.createCanvas(w,h);b.getContext('2d').drawImage(a,0,0,w,h);
  const pixels=b.getContext('2d').getImageData(0,0,w,h);a.width=a.height=b.width=b.height=0;return pixels;
}
// Summed-area tables of the artwork alpha and alpha-weighted gray, cached per content.
const ART_INTEGRALS=new WeakMap();
function designIntegrals(design,content) {
  let art=ART_INTEGRALS.get(content);
  if(art)return art;
  const {width:w,height:h,data}=design,stride=w+1,A=new Float64Array((w+1)*(h+1)),AG=new Float64Array((w+1)*(h+1));
  for(let y=0;y<h;y++){let a=0,ag=0;for(let x=0;x<w;x++){const j=y*w+x,alpha=content.mask[j]?data[j*4+3]/255:0;a+=alpha;ag+=alpha*(data[j*4]+data[j*4+1]+data[j*4+2])/3;A[(y+1)*stride+x+1]=A[y*stride+x+1]+a;AG[(y+1)*stride+x+1]=AG[y*stride+x+1]+ag;}}
  const rect=(t,x0,y0,x1,y1)=>t[y1*stride+x1]-t[y0*stride+x1]-t[y1*stride+x0]+t[y0*stride+x0];
  art={mean(x0,y0,x1,y1) {
    // Area outside the artwork raster is transparent and still counts.
    const area=Math.max(1,(x1-x0)*(y1-y0)),cx0=Math.max(0,Math.min(w,Math.floor(x0))),cy0=Math.max(0,Math.min(h,Math.floor(y0)));
    const cx1=Math.max(cx0,Math.min(w,Math.max(cx0+1,Math.ceil(x1)))),cy1=Math.max(cy0,Math.min(h,Math.max(cy0+1,Math.ceil(y1))));
    const n=Math.max(1,(cx1-cx0)*(cy1-cy0)),cover=Math.min(1,n/area);
    return {a:rect(A,cx0,cy0,cx1,cy1)/n*cover,ag:rect(AG,cx0,cy0,cx1,cy1)/n*cover};
  }};
  ART_INTEGRALS.set(content,art);
  return art;
}
function matchDesign(image,design,content,reference,refine=true,initial=null) {
  const b=reference.box,pad=8,x0=Math.max(0,b.x-pad),y0=Math.max(0,b.y-pad),w=Math.min(image.width-x0,b.w+pad*2),h=Math.min(image.height-y0,b.h+pad*2);
  const data=new Uint8ClampedArray(w*h*4),mask=new Uint8Array(w*h);
  for(let y=0;y<h;y++) {data.set(image.data.subarray(((y+y0)*image.width+x0)*4,((y+y0)*image.width+x0+w)*4),y*w*4);mask.set(reference.mask.subarray((y+y0)*image.width+x0,(y+y0)*image.width+x0+w),y*w);}
  const result=matchDesignLocal({width:w,height:h,data},design,content,{...reference,mask,box:{...b,x:b.x-x0,y:b.y-y0}},initial?{...initial,box:{...initial.box,x:initial.box.x-x0,y:initial.box.y-y0}}:null,refine);
  if(result.box){result.box.x+=x0;result.box.y+=y0;}
  return result;
}
function matchDesignLocal(image,design,content,reference,initial=null,allowFine=true) {
  if(!content.box)return {box:null,confidence:0,ambiguous:false,content};
  // Thin artwork (wide lettering) needs pixels across its short side; a
  // square-sized raster budget alone would shrink it below recognition.
  const thin=content.box?Math.min(content.box.w/content.box.h,content.box.h/content.box.w):1;
  const needed=reference.chestPx>0?Math.min(THIN_CHEST_PX,8/(thin*THIN_MIN_WIDTH))/reference.chestPx:0;
  const factor=Math.min(1,Math.max(needed,(initial?720:allowFine?320:160)/Math.max(image.width,image.height))),small=resize(image,Math.round(image.width*factor),Math.round(image.height*factor));
  const w=small.width,h=small.height,mask=new Uint8Array(w*h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)mask[y*w+x]=reference.mask[Math.min(image.height-1,Math.floor(y/factor))*image.width+Math.min(image.width-1,Math.floor(x/factor))];
  const garment=dominant(small,Array.from(mask.keys()).filter(i=>mask[i])),bg=garment.reduce((s,v)=>s+v,0)/3;
  const gray=Float32Array.from(mask,(_,i)=>(small.data[i*4]+small.data[i*4+1]+small.data[i*4+2])/3);
  const ink=Float32Array.from(mask,(_,i)=>distance([small.data[i*4],small.data[i*4+1],small.data[i*4+2]],garment));
  const edges=new Float32Array(w*h);
  for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){const i=y*w+x;edges[i]=Math.abs(gray[i+1]-gray[i-1])+Math.abs(gray[i+w]-gray[i-w]);}
  const stride=w+1,integralMask=new Int32Array((w+1)*(h+1)),integralInk=new Float64Array((w+1)*(h+1)),integralInk2=new Float64Array((w+1)*(h+1));
  for(let y=0;y<h;y++){let m=0,k=0,k2=0;for(let x=0;x<w;x++){const i=y*w+x,j=(y+1)*stride+x+1;m+=mask[i];k+=ink[i];k2+=ink[i]*ink[i];integralMask[j]=integralMask[j-stride]+m;integralInk[j]=integralInk[j-stride]+k;integralInk2[j]=integralInk2[j-stride]+k2;}}
  const rect=(a,x0,y0,x1,y1)=>a[y1*stride+x1]-a[y0*stride+x1]-a[y1*stride+x0]+a[y0*stride+x0];
  const integralGray=new Float64Array((w+1)*(h+1));
  for(let y=0;y<h;y++){let g=0;for(let x=0;x<w;x++){g+=gray[y*w+x];integralGray[(y+1)*stride+x+1]=integralGray[y*stride+x+1]+g;}}
  const cb=content.box,ratio=cb.h/cb.w, candidates=[],art=designIntegrals(design,content);
  // Both sides are compared as cell means: point samples alias thin strokes,
  // so small line artwork would score as noise at its true placement.
  // Cell means per radius are computed once; template widths share few radii.
  const layers=new Map();
  function cells(r) {
    let layer=layers.get(r);
    if(layer)return layer;
    const g=new Float32Array(w*h),k=new Float32Array(w*h),e=new Float32Array(w*h),d=r+1;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){const x0=Math.max(0,x-r),y0=Math.max(0,y-r),x1=Math.min(w,x+r+1),y1=Math.min(h,y+r+1),n=(x1-x0)*(y1-y0);g[y*w+x]=rect(integralGray,x0,y0,x1,y1)/n;k[y*w+x]=rect(integralInk,x0,y0,x1,y1)/n;}
    const at=(x,y)=>g[Math.min(h-1,Math.max(0,y))*w+Math.min(w-1,Math.max(0,x))];
    for(let y=0;y<h;y++)for(let x=0;x<w;x++)e[y*w+x]=Math.abs(at(x+d,y)-at(x-d,y))+Math.abs(at(x,y+d)-at(x,y-d));
    layers.set(r,layer={g,k,e});
    return layer;
  }
  function template(width) {
    const height=width*ratio,pad=Math.max(1,width*.10),step=Math.max(1,Math.min(width/(initial?22:allowFine?11:8),height/(initial?8:allowFine?4:3))),samples=[];
    const r=Math.floor(step/2),d=r+1,sx=cb.w/width,sy=cb.h/height;
    // Composite of the artwork cell over the garment gray, in template pixels.
    const at=(xx,yy)=>{const m=art.mean(cb.x+(xx-r)*sx,cb.y+(yy-r)*sy,cb.x+(xx+r+1)*sx,cb.y+(yy+r+1)*sy);return {v:bg+m.ag-bg*m.a,a:m.a};};
    for(let yy=-pad;yy<height+pad;yy+=step)for(let xx=-pad;xx<width+pad;xx+=step) {
      const x=Math.round(xx),y=Math.round(yy),{v,a}=at(x,y);
      samples.push({x,y,v,a,e:Math.abs(at(x+d,y).v-at(x-d,y).v)+Math.abs(at(x,y+d).v-at(x,y-d).v)});
    }
    samples.r=r;
    const mean=samples.reduce((s,a)=>s+a.v,0)/samples.length,em=samples.reduce((s,a)=>s+a.e,0)/samples.length;
    const am=samples.reduce((s,a)=>s+a.a,0)/samples.length;
    let variance=0,ev=0,av=0;for(const a of samples){a.v-=mean;a.e-=em;a.a-=am;variance+=a.v*a.v;ev+=a.e*a.e;av+=a.a*a.a;}
    return {samples,variance,ev,av,width,height,pad};
  }
  function score(x,y,t) {
    const x0=Math.floor(x-t.pad),y0=Math.floor(y-t.pad),x1=Math.ceil(x+t.width+t.pad),y1=Math.ceil(y+t.height+t.pad);
    if(x0<0||y0<0||x1>w||y1>h)return -1;
    const area=(x1-x0)*(y1-y0);
    if(rect(integralMask,x0,y0,x1,y1)<area*.96)return -1;
    const inkSum=rect(integralInk,x0,y0,x1,y1);
    if(rect(integralInk2,x0,y0,x1,y1)-inkSum*inkSum/area<area*4)return -1;
    let sum=0,sq=0,cross=0,es=0,esq=0,ec=0,inside=0,ks=0,ksq=0,kc=0;
    const r=t.samples.r,L=r?cells(r):{g:gray,e:edges,k:ink};
    for(const a of t.samples){const xx=x+a.x,yy=y+a.y;if(xx<0||xx>=w||yy<0||yy>=h)return -1;const i=yy*w+xx;
      const v=L.g[i],e=L.e[i];
      sum+=v;sq+=v*v;cross+=a.v*v;es+=e;esq+=e*e;ec+=a.e*e;inside+=mask[i];
      const k=L.k[i];ks+=k;ksq+=k*k;kc+=a.a*k;}
    if(inside<t.samples.length*.96)return -1;
    const n=t.samples.length,v=sq-sum*sum/n,ev=esq-es*es/n;
    if(v<1||t.variance<1)return -1;
    const ncc=cross/Math.sqrt(t.variance*v),edge=ev>1&&t.ev>1?ec/Math.sqrt(t.ev*ev):0;
    const kv=ksq-ks*ks/n,shape=kv>1&&t.av>1?kc/Math.sqrt(t.av*kv):0;
    return .8*Math.max(Math.abs(ncc),shape)+.2*Math.max(0,edge);
  }
  const rb=reference.box,min=Math.max(8,Math.ceil(8/ratio),Math.round(reference.chestPx*factor*.03)),max=Math.min(w-4,Math.round(reference.box.w*factor*.98));
  if(initial)candidates.push({x:Math.round(initial.box.x*factor),y:Math.round(initial.box.y*factor),width:Math.round(initial.box.w*factor),score:-1});
  else for(let width=min;width<=max;width=Math.max(width+1,Math.round(width*1.08))) {
    const t=template(width),step=Math.max(allowFine?1:2,Math.min(allowFine?3:4,Math.floor(width/12)));
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
    if(!allowFine && !initial){refined.push(seed);continue;}
    let best=seed;
    const r=initial?6:4;
    for(let width=Math.max(min,seed.width-Math.ceil(seed.width*.12));width<=Math.min(max,seed.width+Math.ceil(seed.width*.12));width++) {
      const t=template(width);
      for(let y=seed.y-r;y<=seed.y+r;y++)for(let x=seed.x-r;x<=seed.x+r;x++) {const s=score(x,y,t);if(s>best.score)best={x,y,width,score:s};}
    }
    refined.push(best);
  }
  refined.sort((a,b)=>b.score-a.score);
  const best=refined[0],second=best && refined.find(a=>Math.hypot(a.x-best.x,a.y-best.y)>best.width*.4);
  if(!best)return {box:null,confidence:0,ambiguous:false,content,garment};
  const result={box:{x:Math.round(best.x/factor),y:Math.round(best.y/factor),w:best.width/factor,h:best.width*ratio/factor},confidence:best.score,ambiguous:!!second&&best.score-second.score<.045,content,garment};
  if(allowFine && !initial && result.confidence>.65) {
    const fine=matchDesignLocal(image,design,content,reference,result);
    fine.ambiguous ||= result.ambiguous;
    return fine;
  }
  if(initial)result.ambiguous=initial.ambiguous;
  return result;
}

function silhouette(p, segmented=null) {
  const {mask,raw,background,box}=segmented||productMask(p),w=p.width,h=p.height;
  if(!box || box.w<Math.max(16,w*.06) || box.h<Math.max(24,h*.12) || box.w*box.h<w*h*.006)return null;
  let area=0;for(const bit of mask)area+=bit;
  // Small logos and page typography have no substantial filled garment body.
  if(area<box.w*box.h*.3 || area>w*h*.94)return null;
  const cx=Math.round(box.x+box.w/2),rows=[];
  for(let y=box.y;y<box.y+box.h;y++) {
    let l=cx,r=cx;
    if(mask[y*w+cx]) {while(l>box.x&&mask[y*w+l-1])l--;while(r<box.x+box.w-1&&mask[y*w+r+1])r++;}
    rows.push({y,l,r,width:mask[y*w+cx]?r-l+1:0});
  }
  const occupied=rows.filter(r=>r.width),hemY=occupied.at(-1)?.y;
  if(hemY==null)return null;
  const band=rows.filter(r=>r.y>=hemY-box.h*.12 && r.y<=hemY-box.h*.075 && r.width>box.w*.2);
  let hemWidthPx=band.length?median(band.map(r=>r.width)):null;
  const bodyColor=dominant(p,Array.from(mask.keys()).filter(i=>mask[i]));
  if(distance(bodyColor,background)>(segmented?.lowContrast?35:18)) {
    // Closing may bridge a cuff-to-body gap. The original foreground evidence
    // in the hem band keeps hanging sleeves out of the central torso width.
    const widths=[];
    for(const row of band) {
      if(!raw[row.y*w+cx])continue;
      const side=direction=> {let gap=0,last=cx;for(let x=cx;x>=row.l&&x<=row.r;x+=direction){if(raw[row.y*w+x]){gap=0;last=x;}else if(++gap>=2)break;}return last;};
      const width=side(1)-side(-1)+1;
      if(width>box.w*.22)widths.push(width);
    }
    if(widths.length>=band.length*.5)hemWidthPx=median(widths);
  }
  if(!hemWidthPx || hemWidthPx<box.w*.35)return null;
  // The first broad central body row excludes a narrow neck or raised hood.
  // A short moving window rejects isolated pixels at a sloping shoulder edge.
  const broadTop=rows.slice(0,4).every(r=>r.width>=hemWidthPx*.6),shoulderThreshold=broadTop?.6:.9;
  const shoulder=rows.find((r,i)=>i<box.h*.45 && r.width>=hemWidthPx*shoulderThreshold && rows.slice(i,i+4).every(q=>q.width>=hemWidthPx*(shoulderThreshold-.02)));
  if(!shoulder)return null;
  let mismatch=0,total=0,soft=0,edgeN=0,texture=0,interior=0;
  const lum=i=>(p.data[i*4]+p.data[i*4+1]+p.data[i*4+2])/3;
  const garment=dominant(p,Array.from(mask.keys()).filter(i=>mask[i]));
  for(let y=box.y+1;y<box.y+box.h-1;y++)for(let x=box.x+1;x<box.x+box.w-1;x++) {
    const i=y*w+x,mirror=y*w+box.x+box.w-1-(x-box.x);
    if(x<cx){mismatch+=mask[i]!==mask[mirror]?1:0;total+=mask[i]||mask[mirror]?1:0;}
    if(!mask[i])continue;
    if(!mask[i-1]||!mask[i+1]||!mask[i-w]||!mask[i+w]) {edgeN++;if(Math.max(Math.abs(lum(i+1)-lum(i-1)),Math.abs(lum(i+w)-lum(i-w)))<Math.min(18,Math.max(4,distance(garment,background)*.3)))soft++;}
    else if(y>shoulder.y+box.h*.12 && y<hemY-box.h*.06) {
      interior++;const delta=distance([p.data[i*4],p.data[i*4+1],p.data[i*4+2]],garment);
      if(delta>18&&delta<85)texture++;
    }
  }
  const symmetry=1-mismatch/Math.max(1,total);
  // Small sheet products still need visible shoulder/sleeve breadth. A framed
  // cover logo can fill into a nearly rectangular body after closing.
  const smallProduct=box.w*box.h<w*h*.10,shoulderBreadth=smallProduct?1.12:1.05;
  const tail=rows.filter(r=>r.y>=hemY-Math.max(3,box.h*.035)&&r.y<hemY);
  if(smallProduct&&(!tail.length||median(tail.map(r=>r.width))<hemWidthPx*.65))return null;
  if(symmetry<.75 || Math.max(...rows.slice(0,Math.ceil(rows.length*.5)).map(r=>r.width))<hemWidthPx*shoulderBreadth)return null;
  return {mask,raw,box,rows,bodyCenterX:median(band.map(r=>(r.l+r.r)/2)),hemWidthPx,chestPx:hemWidthPx,hemY,shoulderY:shoulder.y,shoulderMethod:'merkez gövdenin hızlı genişlediği ilk sürekli omuz satırı',bodyHeightPx:hemY-shoulder.y+1,symmetry,softEdgeFraction:soft/Math.max(1,edgeN),textureFraction:texture/Math.max(1,interior)};
}
function wrinkleFraction(p,ref,printBox) {
  const w=p.width,cx=ref.bodyCenterX??(ref.box.x+ref.box.w/2),lum=i=>(p.data[i*4]+p.data[i*4+1]+p.data[i*4+2])/3;
  let textured=0,total=0;
  for(let y=Math.ceil(ref.shoulderY+ref.bodyHeightPx*.18);y<ref.hemY-ref.bodyHeightPx*.08;y+=2)for(let x=Math.ceil(cx-ref.hemWidthPx*.4);x<cx+ref.hemWidthPx*.4;x+=2) {
    if(printBox && x>=printBox.x-6&&x<=printBox.x+printBox.w+6&&y>=printBox.y-6&&y<=printBox.y+printBox.h+6)continue;
    const i=y*w+x;
    if(!ref.mask[i]||!ref.mask[i-3]||!ref.mask[i+3]||!ref.mask[i-3*w]||!ref.mask[i+3*w])continue;
    total++;if(Math.max(Math.abs(lum(i+3)-lum(i-3)),Math.abs(lum(i+3*w)-lum(i-3*w)))>4)textured++;
  }
  return textured/Math.max(1,total);
}

function components(mask,w,h,minArea=1) {
  const visited=new Uint8Array(mask.length),queue=new Int32Array(mask.length),out=[];
  for(let i=0;i<mask.length;i++)if(mask[i]&&!visited[i]) {
    const n=flood(mask,w,h,i,visited,queue);
    if(n<minArea)continue;
    const pixels=queue.slice(0,n);let x=w,y=h,r=0,b=0;
    for(const j of pixels){const xx=j%w,yy=Math.floor(j/w);x=Math.min(x,xx);y=Math.min(y,yy);r=Math.max(r,xx);b=Math.max(b,yy);}
    out.push({pixels,box:{x,y,w:r-x+1,h:b-y+1},area:n});
  }
  return out;
}

function overlapFraction(a,b) {
  const area=Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));
  return area/Math.max(a.w*a.h,b.w*b.h);
}

function comparableShirts(a,b) {
  const height=Math.max(a.bodyHeightPx,b.bodyHeightPx),hem=Math.max(a.hemWidthPx,b.hemWidthPx);
  return Math.abs(a.hemWidthPx-b.hemWidthPx)<=hem*.12 &&
    Math.abs(a.bodyHeightPx-b.bodyHeightPx)<=height*.12 &&
    Math.abs(a.hemY-b.hemY)<=height*.08 && Math.abs(a.shoulderY-b.shoulderY)<=height*.08;
}

function lowerBodyGap(component,w) {
  const {x,y,w:width,h:height}=component.box;
  const firstY=Math.ceil(y+height*.61),lastY=Math.floor(y+height*.93);
  const inkByX=new Uint32Array(width);
  for(const i of component.pixels) {
    const row=Math.floor(i/w);
    if(row>=firstY && row<=lastY)inkByX[i%w-x]++;
  }
  // A real pair has a persistent background corridor through the lower body.
  // Stay away from the side seams and require a span, rather than one blank column.
  let start=null,best=null;
  const first=Math.ceil(width*.35),last=Math.floor(width*.65);
  for(let column=first;column<=last;column++) {
    if(inkByX[column]===0 && column<last){start??=column;continue;}
    if(start!=null && column-start>=Math.max(3,width*.018) && (!best || column-start>best.width))
      best={boundary:x+Math.floor((start+column)/2),width:column-start};
    start=null;
  }
  return best?.boundary;
}

function silhouettes(p,product) {
  const base=productMask(p),w=p.width,h=p.height;
  // A white product may contribute only a thin boundary before hole filling.
  // Judge body area in silhouette(), rather than discarding that outline here.
  const minInk=Math.max(24,Math.min(w*h*.006,Math.min(w,h)*.5));
  const collect=(raw,lowContrast=false)=>{
    const closed=closeMask(raw,w,h);
    const pieces=components(closed,w,h,minInk).filter(c=>c.box.h>h*.12&&c.box.w>w*.06);
    const reference=pixels=>{
      let mask=new Uint8Array(w*h);for(const i of pixels)mask[i]=1;
      mask=fillHoles(mask,w,h);
      const ref=silhouette(p,{...base,raw,mask,lowContrast,box:bounds(mask,w,h)});
      if(ref)ref.maskMethod=lowContrast?'acik_zemin_bolge':'renk_kenar';
      return ref;
    };
    const split=(c,boundary)=>[false,true].map(right=>reference(c.pixels.filter(i=>(i%w>=boundary)===right)));
    return pieces.flatMap(c=>{
      if(product==='tisort') {
        if(!lowContrast && Math.min(...base.background)>235 && c.box.w>c.box.h*1.24) {
          const boundary=lowerBodyGap(c,w);
          if(boundary!=null) {
            const halves=split(c,boundary);
            if(halves.every(ref=>ref && ref.symmetry>=MIN_SYMMETRY)) {
              for(const ref of halves) {
                ref.neckline=roundNeckline(p,ref);
                if(ref.neckline && ref.neckline.depth<=.18) {
                  // Counting from the centre of a deep neckline shortens one
                  // body's true shoulder-to-hem span, skewing the shared scale.
                  ref.shoulderY=ref.neckline.shoulderY;
                  ref.bodyHeightPx=ref.hemY-ref.shoulderY+1;
                  ref.shoulderMethod='yuvarlak yakanın iki yanındaki omuz çizgisi';
                }
              }
              if(comparableShirts(...halves))return halves.map(ref=>({...ref,splitMethod:'alt_govde_boslugu'}));
            }
            // The gap disproves one solid torso, even when the halves are
            // too different to verify as a pair.
            return [];
          }
        }
        return [reference(c.pixels)].filter(Boolean);
      }
      // Retain the established independent upper-body split for other products.
      const top=new Uint8Array(w*h),cut=c.box.y+c.box.h*.32;
      for(const i of c.pixels)if(Math.floor(i/w)<cut)top[i]=1;
      const seeds=components(top,w,h,c.area*.025).filter(a=>a.box.h>c.box.h*.16&&a.box.w>c.box.w*.18).sort((a,b)=>a.box.x-b.box.x);
      if(seeds.length!==2 || seeds[0].box.x+seeds[0].box.w>=seeds[1].box.x)return [reference(c.pixels)].filter(Boolean);
      const boundary=Math.round((seeds[0].box.x+seeds[0].box.w+seeds[1].box.x)/2);
      return split(c,boundary).filter(Boolean);
    });
  };
  const refs=collect(base.raw);
  // Keep established silhouettes unchanged. On a light background, a weaker
  // boundary separates the exterior flood region from pale fabric and shadows;
  // filling each closed component keeps internal print and folds out of geometry.
  if(Math.min(...base.background)>235) {
    const raw=new Uint8Array(w*h),covered=new Uint8Array(w*h);
    // Do not segment a known product twice. Pale products elsewhere on the
    // same page still get the weaker boundary, including on mixed-color sheets.
    for(const {box:b} of refs)for(let y=Math.max(0,b.y-5);y<Math.min(h,b.y+b.h+5);y++)covered.fill(1,y*w+Math.max(0,b.x-5),y*w+Math.min(w,b.x+b.w+5));
    let area=0;
    for(let i=0;i<raw.length;i++)if(!covered[i]) {
      const d=p.data,b=base.background;
      raw[i]=d[i*4+3]>64&&Math.max(Math.abs(d[i*4]-b[0]),Math.abs(d[i*4+1]-b[1]),Math.abs(d[i*4+2]-b[2]))>6?1:0;
      area+=raw[i];
    }
    if(area<minInk)return refs;
    const recovered=collect(raw,true);
    for(const ref of recovered)if(!refs.some(r=>overlapFraction(r.box,ref.box)>.5))refs.push(ref);
  }
  return refs;
}

// Rectangular dilation via an integral image joins letters without scanning a
// large kernel at every pixel. Returned boxes use original, undilated ink.
function dilate(mask,w,h,rx,ry) {
  const stride=w+1,sum=new Int32Array((w+1)*(h+1)),out=new Uint8Array(w*h);
  for(let y=0;y<h;y++){let n=0;for(let x=0;x<w;x++){n+=mask[y*w+x];sum[(y+1)*stride+x+1]=sum[y*stride+x+1]+n;}}
  for(let y=0;y<h;y++)for(let x=0;x<w;x++) {
    const l=Math.max(0,x-rx),r=Math.min(w,x+rx+1),t=Math.max(0,y-ry),b=Math.min(h,y+ry+1);
    out[y*w+x]=sum[b*stride+r]-sum[t*stride+r]-sum[b*stride+l]+sum[t*stride+l]>0?1:0;
  }
  return out;
}
function contrastInk(p,ref) {
  const garment=dominant(p,Array.from(ref.mask.keys()).filter(i=>ref.mask[i])),ink=new Uint8Array(ref.mask.length);
  for(let i=0;i<ink.length;i++)ink[i]=ref.mask[i]&&distance([p.data[i*4],p.data[i*4+1],p.data[i*4+2]],garment)>90?1:0;
  return ink;
}
function hoodView(p,ref) {
  const ink=contrastInk(p,ref),w=p.width,h=p.height,cx=ref.bodyCenterX??(ref.box.x+ref.box.w/2);
  // A raised narrow crown followed by broad shoulders is hood geometry. A
  // broad neckline alone is insufficient evidence for front/back assignment.
  const raised=ref.shoulderY-ref.box.y>ref.bodyHeightPx*.08;
  const lining=components(ink,w,h,ref.hemWidthPx).filter(c=>c.box.y<ref.shoulderY&&c.box.w>ref.hemWidthPx*.28&&c.box.h>ref.bodyHeightPx*.035&&Math.abs(c.box.x+c.box.w/2-cx)<ref.hemWidthPx*.2);
  const cords=components(ink,w,h,4).filter(c=>c.box.y>=ref.shoulderY-ref.bodyHeightPx*.03&&c.box.y<ref.shoulderY+ref.bodyHeightPx*.25&&c.box.h>ref.bodyHeightPx*.15&&c.box.w<ref.hemWidthPx*.08&&Math.abs(c.box.x+c.box.w/2-cx)<ref.hemWidthPx*.22);
  return {hooded:raised,view:raised&&(lining.length||cords.length>=2)?'on':'teyit',lining:lining.length,cords:cords.length};
}
function roundNeckline(p,ref) {
  if(ref.maskMethod!=='renk_kenar')return null;
  const {bodyCenterX:cx,hemWidthPx:hem,bodyHeightPx:height,box}=ref,w=p.width;
  const stableRows=Math.max(2,Math.round(height*.009)),end=box.y+height*.23;
  const probe=offset=>{
    const column=Math.round(cx+hem*offset),samples=[];
    for(let dx=-1;dx<=1;dx++){
      const x=column+dx;
      let run=0,top=null;
      for(let y=box.y;y<=end;y++){
        const index=y*w+x;
        run=ref.mask[index]&&ref.raw[index]?run+1:0;
        if(run===stableRows){top=y-run+1;break;}
      }
      if(top==null)return null;
      samples.push(top);
    }
    return median(samples);
  };
  const shoulders=[probe(-.32),probe(.32)],middle=probe(0);
  const inner=[probe(-.13),probe(.13)],outer=[probe(-.25),probe(.25)];
  if([...shoulders,middle,...inner,...outer].some(n=>n==null))return null;
  const baseline=(shoulders[0]+shoulders[1])/2,depth=middle-baseline;
  if(depth<Math.max(2,height*.018) || Math.abs(shoulders[0]-shoulders[1])>height*.018)return null;
  if(outer.some(y=>Math.abs(y-baseline)>Math.max(2,height*.017)))return null;
  if(Math.abs(inner[0]-inner[1])>Math.max(2,depth*.22) ||
     inner.some(y=>y-baseline<depth*.25 || y-baseline>depth*.92+1))return null;
  return {depth:depth/height,shoulderY:Math.round(baseline)};
}

function shirtViews(refs,cues) {
  if(refs.length!==2 || !refs.every(ref=>ref.splitMethod) || !comparableShirts(...refs))return;
  const depths=refs.map(ref=>ref.neckline?.depth??null);
  for(let i=0;i<refs.length;i++)cues[i].neckDepth=depths[i];
  const front=depths.findIndex(depth=>depth>=.085 && depth<=.18),back=1-front;
  if(front<0 || depths[back]==null || depths[back]>.052 || depths[front]-depths[back]<.05)return;
  cues[front].view='on';cues[back].view='arka';
}

function productViewCues(p,refs,product) {
  const cues=refs.map(ref=>ref.splitMethod?{hooded:false,view:'teyit',lining:0,cords:0}:hoodView(p,ref));
  if(product==='tisort')shirtViews(refs,cues);
  // A visible hood opening or cords identify the front of a hooded pair.
  if(refs.length===2 && cues.filter(c=>c.view==='on').length===1) {
    const other=cues.find(c=>c.view!=='on');
    if(other.hooded)other.view='arka';
  }
  return cues;
}

function colorDesign(p,ref,tallBack=false) {
  const w=p.width,h=p.height,cx=ref.bodyCenterX??(ref.box.x+ref.box.w/2),ink=contrastInk(p,ref),clean=new Uint8Array(ink.length);
  // A large back print can extend below the usual print band.
  const top=ref.shoulderY+ref.bodyHeightPx*(tallBack?.11:.14),bottom=ref.shoulderY+ref.bodyHeightPx*(tallBack?.83:.62);
  for(const c of components(ink,w,h,2)) {
    const b=c.box,ratio=Math.max(b.w/b.h,b.h/b.w);
    // Reject piping, lining, cords and long seams before joining print letters.
    if(ratio>9 || (b.h>ref.bodyHeightPx*.12&&b.w<ref.hemWidthPx*.055) || b.y<top || b.y+b.h>bottom || b.x<cx-ref.hemWidthPx*.48 || b.x+b.w>cx+ref.hemWidthPx*.48)continue;
    for(const i of c.pixels)clean[i]=1;
  }
  const joined=dilate(clean,w,h,Math.max(2,Math.round(ref.hemWidthPx*.022)),Math.max(2,Math.round(ref.bodyHeightPx*.016)));
  const candidates=[];
  for(const c of components(joined,w,h,10)) {
    const pixels=c.pixels.filter(i=>clean[i]);if(!pixels.length)continue;
    let x=w,y=h,r=0,b=0;for(const i of pixels){x=Math.min(x,i%w);r=Math.max(r,i%w);y=Math.min(y,Math.floor(i/w));b=Math.max(b,Math.floor(i/w));}
    const box={x,y,w:r-x+1,h:b-y+1},density=pixels.length/(box.w*box.h);
    if(box.w<ref.hemWidthPx*.045||box.h<ref.bodyHeightPx*.018||box.w/box.h>8||box.h/box.w>4||density<.035)continue;
    candidates.push({box,score:pixels.length,confidence:.86,content:{box},method:'otomatik_renk'});
  }
  candidates.sort((a,b)=>b.score-a.score);
  if(!candidates.length)return {box:null,confidence:0,ambiguous:false,content:{box:null},method:'otomatik_renk'};
  return {...candidates[0],ambiguous:!!candidates[1]&&candidates[1].score>candidates[0].score*.4};
}

function chestLine(p,ref) {
  const {width:w,height:h}=p,cx=Math.round(ref.bodyCenterX),height=ref.bodyHeightPx,hem=ref.hemWidthPx;
  const start=Math.ceil(ref.shoulderY+height*.2),end=Math.floor(ref.shoulderY+height*.58),window=Math.max(4,Math.round(height*.035));
  const rows=[];
  for(let y=start;y<=end;y++) {
    if(!ref.raw[y*w+cx])continue;
    const side=direction=>{let last=cx,gap=0;for(let x=cx;x>=ref.box.x&&x<ref.box.x+ref.box.w;x+=direction){if(ref.raw[y*w+x]){last=x;gap=0;}else if(++gap>=2)break;}return last;};
    const l=side(-1),r=side(1),width=r-l+1;
    // There must be shoulder/sleeve breadth above this central, separated run.
    const broad=ref.rows.some(q=>q.y<y&&q.y>=ref.shoulderY&&q.width>width*1.12);
    if(width>=hem*.7&&width<=hem*1.7&&broad)rows.push({y,l,r,width});
  }
  const stable=[];
  for(let i=0;i<=rows.length-window;i++) {
    const band=rows.slice(i,i+window),width=median(band.map(r=>r.width));
    if(band.at(-1).y-band[0].y!==window-1||band.some(r=>Math.abs(r.width-width)>width*.025))continue;
    stable.push({...band[Math.floor(window/2)],width,method:'kol_alti_ayrik_maske'});
  }
  if(stable.length) {
    const narrow=Math.min(...stable.map(r=>r.width));
    return stable.find(r=>r.width<=narrow*1.025);
  }
  // Touching sleeves have no exterior gap. A side seam is usable only when
  // it persists below the chest print as well as in the upper body. A uniform
  // joined mask provides no evidence: do not manufacture a split from L sizes.
  const lum=(x,y)=>{const i=(y*w+x)*4;return (p.data[i]+p.data[i+1]+p.data[i+2])/3;};
  const radius=Math.max(1,Math.round(hem*.01)),edge=(x,y)=>Math.abs(lum(x+radius,y)-lum(x-radius,y));
  const anchors=[];
  for(const sign of [-1,1]) {
    let best=null;
    for(let offset=Math.ceil(hem*.35);offset<=hem*.75;offset++) {
      const x=cx+sign*offset;if(x-radius<0||x+radius>=w)continue;
      let sum=0,strong=0,n=0,lower=0,lowerN=0;
      for(let y=start;y<Math.min(h,ref.shoulderY+height*.78);y++) {
        if(!ref.mask[y*w+x])continue;
        const value=edge(x,y);sum+=value;strong+=value>10;n++;
        if(y>ref.shoulderY+height*.58){lower+=value>10;lowerN++;}
      }
      if(n<height*.5||strong/n<.65||lower/Math.max(1,lowerN)<.6||sum/n<12)continue;
      if(!best||sum/n>best.score)best={x,score:sum/n};
    }
    if(!best)return null;anchors.push(best.x);
  }
  const traced=[];
  for(let y=start;y<=end;y++) {
    const ends=anchors.map(anchor=>{
      let best=null;
      for(let x=anchor-Math.ceil(hem*.025);x<=anchor+hem*.025;x++) {
        const value=edge(x,y);if(value>10&&(!best||value>best.value))best={x,value};
      }
      return best?.x;
    });
    if(ends.some(x=>x==null))continue;
    const [l,r]=ends,width=r-l+1;
    // Both sleeves must actually extend outside the proposed torso boundary.
    if(ref.rows.find(q=>q.y===y)?.width<width*1.15||Math.abs((l+r)/2-cx)>hem*.08)continue;
    traced.push({y,l,r,width});
  }
  for(let i=0;i<=traced.length-window;i++) {
    const band=traced.slice(i,i+window),width=median(band.map(r=>r.width));
    if(band.at(-1).y-band[0].y===window-1&&band.every(r=>Math.abs(r.width-width)<=width*.025))
      return {...band[Math.floor(window/2)],width,method:'yapisik_kol_surekli_yan_kenar'};
  }
  return null;
}
// PDF sheets are scanned at 320 px. Redraw a page only when the thinnest
// supplied design could not reach 8 px across at THIN_MIN_WIDTH of the chest.
function thinDesignEdge(refs,edge,contents,topEdge) {
  const thin=Math.min(1,...contents.flatMap(({box})=>box?[Math.min(box.w/box.h,box.h/box.w)]:[]));
  const chest=Math.min(...refs.map(ref=>ref.chestPx).filter(n=>n>0)),needed=Math.min(THIN_CHEST_PX,8/(thin*THIN_MIN_WIDTH));
  if(!Number.isFinite(chest)||chest>=needed)return null;
  return Math.min(topEdge,Math.ceil(edge*needed/chest));
}
// Two L axes within 15% agree: arithmetic mean. Up to 35% the mockup is drawn
// off the pattern's proportions (Patron/Şef kararı, 20.11.2026): the geometric
// mean keeps the artwork ratio and splits the error. Beyond 35% the mask or
// shoulder is more likely wrong, so there is no scale.
const SCALE_AGREE = .15, SCALE_MOCKUP = .35;
function pairScale(vertical,horizontal) {
  if(!vertical||!horizontal)return {difference:null,mean:null,mode:null};
  const difference=Math.abs(vertical-horizontal)/((vertical+horizontal)/2);
  if(difference<=SCALE_AGREE)return {difference,mean:(vertical+horizontal)/2,mode:'ortalama'};
  // A boundary value computed in floating point stays inside the band.
  if(difference<=SCALE_MOCKUP+1e-12)return {difference,mean:Math.sqrt(vertical*horizontal),mode:'geo_ortalama'};
  return {difference,mean:null,mode:null};
}
const mockupNote=(difference,label)=>`Mockup oranı kalıptan farklı (%${percent(difference)}); ölçek ${label} ortalaması.`;
// The L table and the detector need not mean the same row: on a pattern's
// own flat drawing the detected chest/height can disagree with L (SWEAT 29%).
// The same detector run on that drawing maps its pixels to the L values; the
// ratio is split evenly between the axes (sqrt), so a mockup drawn like the
// pattern gets one scale and the 15/35% bands apply to what remains.
function flatCalibration(p,flat,kind) {
  const L=flat?.olculerL||{},positive=n=>Number.isFinite(n)&&n>0;
  if(kind==='bacak') {
    if(!positive(L.yan_boy)||!positive(L.basen))return null;
    const ref=legSilhouette(p);
    if(!ref)return null;
    return {yanBoyPx:ref.heightPx,basenPx:ref.hipPx,kaynak:'duz_cizim',oran:(L.basen/ref.hipPx)/(L.yan_boy/ref.heightPx)};
  }
  const chest=kind==='boy_gogus',horizontalCm=chest?L.gogus:L.etek;
  if(!positive(L.omuzdan_boy)||!positive(horizontalCm))return null;
  const refs=silhouettes(p,flat.urun);
  // One garment only: a sheet of several drawings has no single calibration.
  if(refs.length!==1)return null;
  const ref=refs[0];if(chest)ref.chestLine=chestLine(p,ref);
  const horizontalPx=chest?ref.chestLine?.width:ref.hemWidthPx;
  if(!(horizontalPx>0)||!(ref.bodyHeightPx>0))return null;
  return {boyPx:ref.bodyHeightPx,gogusPx:horizontalPx,yatay:chest?'gogus':'etek',kaynak:'duz_cizim',oran:(horizontalCm/horizontalPx)/(L.omuzdan_boy/ref.bodyHeightPx)};
}
// A precomputed calibration (cached by the caller) is used as is; otherwise
// the drawing is read here. Without a drawing or a detection: no calibration.
async function calibrationFor(flat,kind) {
  if(!flat||flat.refBeden!=='L')return null;
  const cached=flat.kalibrasyon;
  if(cached!==undefined)return cached&&cached.tur===kind&&cached.oran>0?cached:null;
  if(!flat.cizim?.buffer)return null;
  try {
    const [p]=await rasterPages(flat.cizim,MAX_EDGE,[1]);
    const result=p?flatCalibration(p,flat,kind):null;
    return result?{...result,tur:kind}:null;
  } catch {return null;}
}
const calibrationFactor=cal=>cal?Math.sqrt(cal.oran):1;
function scaleFor(ref,measurements,scalePair='boy_etek',p=null,k=1) {
  if(scalePair==='boy_gogus'&&p&&ref.chestLine===undefined)ref.chestLine=chestLine(p,ref);
  const chest=scalePair==='boy_gogus',horizontalCm=chest?measurements.gogus:measurements.etek,horizontalPx=chest?ref.chestLine?.width:ref.hemWidthPx;
  const vertical=Number.isFinite(measurements.omuzdan_boy)&&measurements.omuzdan_boy>0?measurements.omuzdan_boy*10/ref.bodyHeightPx*k:null;
  const horizontal=Number.isFinite(horizontalCm)&&horizontalCm>0&&horizontalPx>0?horizontalCm*10/horizontalPx/k:null;
  const pair=pairScale(vertical,horizontal);
  return {vertical,horizontal,difference:pair.difference,mode:pair.mode,mean:vertical&&horizontal?pair.mean:chest?null:vertical||horizontal};
}

// Sleeve geometry and matching are independent of the established torso path.
// PCA supplies the arm direction, not an assumed vertical artwork direction.
function sleeveGeometry(mask,w,h,side=null) {
  const pixels=[];let x=0,y=0;
  for(let i=0;i<mask.length;i++)if(mask[i]){pixels.push(i);x+=i%w;y+=Math.floor(i/w);}
  if(pixels.length<80)return null;
  x/=pixels.length;y/=pixels.length;
  let xx=0,xy=0,yy=0;
  for(const i of pixels){const dx=i%w-x,dy=Math.floor(i/w)-y;xx+=dx*dx;xy+=dx*dy;yy+=dy*dy;}
  const theta=.5*Math.atan2(2*xy,xx-yy);
  let u={x:Math.cos(theta),y:Math.sin(theta)};
  if(u.y<0)u={x:-u.x,y:-u.y};
  const v={x:u.y,y:-u.x};
  const project=indices=>{
    let a=Infinity,b=-Infinity,c=Infinity,d=-Infinity;
    for(const i of indices){const dx=i%w-x,dy=Math.floor(i/w)-y,along=dx*u.x+dy*u.y,across=dx*v.x+dy*v.y;a=Math.min(a,along);b=Math.max(b,along);c=Math.min(c,across);d=Math.max(d,across);}
    return {a,b,c,d,alongPx:b-a+1,acrossPx:d-c+1};
  };
  const extent=project(pixels),box=bounds(mask,w,h);
  if(extent.alongPx/extent.acrossPx<1.55)return null;
  return {mask,box,side,u,v,center:{x,y},project,lengthPx:extent.alongPx,extent};
}
function sleevesOnBody(ref,w,h) {
  const cx=ref.bodyCenterX,result=[];
  for(const side of ['sol','sag']) {
    const mask=new Uint8Array(w*h),edge=cx+(side==='sol'?-1:1)*(ref.chestLine?.width||ref.hemWidthPx)*.51;
    for(let y=ref.shoulderY;y<ref.box.y+ref.box.h;y++)for(let x=ref.box.x;x<ref.box.x+ref.box.w;x++)
      if(ref.mask[y*w+x]&&(side==='sol'?x<edge:x>edge))mask[y*w+x]=1;
    const sleeve=sleeveGeometry(largest(mask,w,h),w,h,side);
    if(sleeve)result.push(sleeve);
  }
  return result;
}
function sleevePrints(p,sleeve) {
  const w=p.width,h=p.height,mask=sleeve.mask;
  const ink=contrastInk(p,sleeve),clean=new Uint8Array(w*h);
  // Seams at the silhouette edge must not become measured artwork.
  for(let y=2;y<h-2;y++)for(let x=2;x<w-2;x++) {
    const i=y*w+x;
    if(ink[i]&&mask[i-2]&&mask[i+2]&&mask[i-2*w]&&mask[i+2*w])clean[i]=1;
  }
  const r=Math.max(2,Math.round(sleeve.lengthPx*.012)),found=[];
  // Every ink color also forms its own layer: a differently colored mark
  // beside the artwork (dimension line, label, seam tape) must not be joined
  // into the only candidate. The all-color candidates remain hypotheses.
  // A single color layer may join over twice the radius: its gaps cannot
  // pull in a mark of another color.
  for(const [layer,radius] of [[clean,r],...inkLayers(p,clean).map(layer=>[layer,r*2])]) {
    const joined=dilate(layer,w,h,radius,radius);
    for(const c of components(joined,w,h,8)) {
      const pixels=c.pixels.filter(i=>layer[i]),extent=sleeve.project(pixels);
      if(pixels.length<8||extent.alongPx<4||extent.acrossPx<4||extent.alongPx>sleeve.lengthPx*.65)continue;
      const mask=new Uint8Array(w*h);for(const i of pixels)mask[i]=1;
      const box=bounds(mask,w,h);
      if(!found.some(f=>f.pixels.length===pixels.length&&f.box.x===box.x&&f.box.y===box.y&&f.box.w===box.w&&f.box.h===box.h))found.push({mask,pixels,box,...extent});
    }
  }
  return found;
}
// Split ink into color groups; a single-color mark returns no extra layer.
function inkLayers(p,ink) {
  const groups=[];
  for(let i=0;i<ink.length;i++) {
    if(!ink[i])continue;
    const rgb=[p.data[i*4],p.data[i*4+1],p.data[i*4+2]];
    let g=groups.find(g=>distance(g.rgb,rgb)<=INK_LAYER_DISTANCE);
    if(!g)groups.push(g={rgb,sum:[0,0,0],n:0});
    g.n++;rgb.forEach((v,j)=>g.sum[j]+=v);
  }
  const total=groups.reduce((s,g)=>s+g.n,0),major=groups.filter(g=>g.n>=total*.08).map(g=>g.sum.map(v=>v/g.n));
  if(major.length<2)return [];
  const layers=major.map(()=>new Uint8Array(ink.length));
  for(let i=0;i<ink.length;i++) {
    if(!ink[i])continue;
    const rgb=[p.data[i*4],p.data[i*4+1],p.data[i*4+2]];
    let best=0;for(let k=1;k<major.length;k++)if(distance(major[k],rgb)<distance(major[best],rgb))best=k;
    layers[best][i]=1;
  }
  return layers;
}
function sleeveMatch(p,sleeve,candidate,design,content) {
  let best=null;
  // The artwork may tilt slightly relative to the entire shoulder/cuff axis.
  // Search only a small angle, always measuring the independently observed ink.
  const pixels=candidate.pixels;
  for(const degrees of [-12,-8,-4,0,4,8,12]) {
    const angle=degrees*Math.PI/180,cos=Math.cos(angle),sin=Math.sin(angle);
    const u={x:sleeve.u.x*cos-sleeve.u.y*sin,y:sleeve.u.x*sin+sleeve.u.y*cos},v={x:u.y,y:-u.x};
    let a=Infinity,b=-Infinity,c=Infinity,d=-Infinity;
    for(const i of pixels){const dx=i%p.width-sleeve.center.x,dy=Math.floor(i/p.width)-sleeve.center.y,along=dx*u.x+dy*u.y,across=dx*v.x+dy*v.y;a=Math.min(a,along);b=Math.max(b,along);c=Math.min(c,across);d=Math.max(d,across);}
    const projected={...candidate,a,b,c,d,alongPx:b-a+1,acrossPx:d-c+1};
    const match=sleeveMatchAligned(p,{...sleeve,u,v},projected,design,content);
    if(match&&(!best||match.confidence>best.confidence))best={...match,projected,axis:u,axisOffsetDegrees:degrees};
  }
  return best;
}
const SLEEVE_GRIDS=new WeakMap();
function sleeveMatchAligned(p,sleeve,candidate,design,content) {
  const b=content.box;
  if(!b)return null;
  // Compare normalized ink shapes, allowing rotation and transverse shortening.
  // The candidate bounds remain observed ink; no template ratio is imposed.
  const N=24,observed=[];
  const sample=(mask,w,h,x,y)=>x>=0&&y>=0&&x<w&&y<h?mask[Math.floor(y)*w+Math.floor(x)]:0;
  for(let y=0;y<N;y++)for(let x=0;x<N;x++) {
    let sum=0;
    for(const dy of [.2,.5,.8])for(const dx of [.2,.5,.8]) {
      const a=candidate.a+(y+dy)/N*candidate.alongPx,c=candidate.c+(x+dx)/N*candidate.acrossPx;
      sum+=sample(candidate.mask,p.width,p.height,sleeve.center.x+a*sleeve.u.x+c*sleeve.v.x,sleeve.center.y+a*sleeve.u.y+c*sleeve.v.y);
    }
    observed.push(sum/9);
  }
  const mean=observed.reduce((s,v)=>s+v,0)/observed.length;
  let best=null;
  // The artwork grid does not depend on the candidate: build it once per design.
  let grids=SLEEVE_GRIDS.get(content);
  if(!grids) {
    grids=[];
    for(let rotation=0;rotation<4;rotation++) {
      const values=[];
      for(let y=0;y<N;y++)for(let x=0;x<N;x++) {
        let sum=0;
        for(const dy of [.2,.5,.8])for(const dx of [.2,.5,.8]) {
          const u=(x+dx)/N,v=(y+dy)/N;
          const [sx,sy]=rotation===0?[u,v]:rotation===1?[v,1-u]:rotation===2?[1-u,1-v]:[1-v,u];
          sum+=sample(content.mask,design.width,design.height,b.x+sx*b.w,b.y+sy*b.h);
        }
        values.push(sum/9);
      }
      grids.push(values);
    }
    SLEEVE_GRIDS.set(content,grids);
  }
  for(let rotation=0;rotation<4;rotation++) {
    const values=grids[rotation];
    const tm=values.reduce((s,v)=>s+v,0)/values.length;
    let cross=0,variance=0,tv=0;
    for(let i=0;i<values.length;i++){const a=observed[i]-mean,d=values[i]-tm;cross+=a*d;variance+=a*a;tv+=d*d;}
    const confidence=variance>0&&tv>0?Math.max(0,cross/Math.sqrt(variance*tv)):0;
    if(!best||confidence>best.confidence)best={confidence,rotation,measuredAxis:rotation%2?'en':'boy',designRatio:b.w/b.h};
  }
  return best;
}
async function autoMeasureSleeve({image,design,flat,product,position}) {
  const scalePair=scalePairFor(flat,product),pairLabel=scalePair==='boy_gogus'?'boy/göğüs':'boy/etek';
  const started=performance.now(),reasons=[],source={scalePair,method:'otomatik',sleeveMethod:'kol_ekseni_desen_orani',scaleFrom:null,measuredAxis:null,flatId:flat?.id??null,flatAd:flat?.ad??null,refBeden:flat?.refBeden??null,refCm:flat?.refLengthCm??null,olculerL:flat?.olculerL??null,gorselFileId:image?.id??null,desenFileId:design?.id??null,selectedView:image?.gorunum||'on',mmPerPx:null,designBoxPx:null,confidence:0};
  let width=null,height=null;
  const measurements=flat?.refBeden==='L'?flat.olculerL||{}:{};
  if(flat?.refBeden!=='L')reasons.push('Ürünün L kalıp referansı bulunamadı: kol için L beden ölçüsü gerekli.');
  const cal=await calibrationFor(flat,scalePair),k=calibrationFactor(cal);
  source.kalibrasyon=cal;
  try {
    // Small cuff artwork needs full raster resolution even on PDF sheets.
    const pages=await rasterPages(image,image.mime==='application/pdf'?1000:MAX_EDGE),designs=design?await rasterPages(design,1000,null,{transparent:true}):[],candidates=[];
    const designContents=designs.map(p=>designContent(p,true));
    let sleeveCount=0,bodyCount=0;
    source.pageCount=pages.length;source.designPageCount=designs.length;
    for(let i=0;i<pages.length;i++) {
      const p=pages[i],segmented=image.gorunum==='kol'?productMask(p):null,box=segmented?.box;
      const isolated=box&&Math.max(box.h/box.w,box.w/box.h)>2.2;
      const refs=isolated?[]:silhouettes(p),geometries=[];bodyCount+=refs.length;
      const knownSide=['on','arka'].includes(image.gorunum)&&position!=='kol';
      const wantedSide=position==='sol_kol'?'sol':'sag';
      const imageSide=image.gorunum==='on'?(wantedSide==='sol'?'sag':'sol'):wantedSide;
      for(const ref of refs) {
        scaleFor(ref,measurements,scalePair,p,k);
        for(const sleeve of sleevesOnBody(ref,p.width,p.height))
          if(!knownSide||sleeve.side===imageSide)geometries.push({sleeve,ref});
      }
      if(!refs.length&&image.gorunum==='kol') {
        const {mask,box}=segmented;
        // A close crop does not establish a full shoulder-to-cuff reference.
        const complete=box&&box.x>2&&box.y>2&&box.x+box.w<p.width-2&&box.y+box.h<p.height-2;
        const sleeve=complete?sleeveGeometry(mask,p.width,p.height):null;
        if(sleeve)geometries.push({sleeve,ref:null});
      }
      sleeveCount+=geometries.length;
      for(const {sleeve,ref} of geometries)for(const candidate of sleevePrints(p,sleeve))for(let j=0;j<designs.length;j++) {
        const match=sleeveMatch(p,sleeve,candidate,designs[j],designContents[j]);
        if(match)candidates.push({p,sleeve,ref,candidate,match,page:i+1,designPage:j+1});
      }
    }
    source.sleeveCount=sleeveCount;source.bodyCount=bodyCount;
    if(!sleeveCount)reasons.push('Kol bulunamadı: ürün maskesinde gövdeden ayrılan kol veya tamamı görünen ayrı kol silueti yok.');
    if(!designContents.some(content=>content.box))reasons.push('Kol desen dosyası yok veya boş; en-boy oranı ve desen eşleşmesi doğrulanamadı.');
    candidates.sort((a,b)=>b.match.confidence-a.match.confidence);
    source.pageCandidates=candidates.slice(0,5).map(c=>({page:c.page,designPage:c.designPage,confidence:c.match.confidence,box:c.candidate.box}));
    const chosen=candidates[0];
    if(!chosen) {
      if(sleeveCount)reasons.push('Kol üzerinde desen adayı bulunamadı (0 eşleşme); yerleşim teyit edilmeli.');
    } else {
      const {p,sleeve,ref,match}=chosen,candidate=match.projected;
      Object.assign(source,{selectedPage:chosen.page,selectedDesignPage:chosen.designPage,rasterWidth:p.width,rasterHeight:p.height,productBoxPx:ref?.box??sleeve.box,sleeveBoxPx:sleeve.box,sleeveAxis:sleeve.u,measuredAxisVector:match.axis,axisOffsetDegrees:match.axisOffsetDegrees,sleeveLengthPx:sleeve.lengthPx,candidateBoxPx:candidate.box,observedAlongPx:candidate.alongPx,observedAcrossPx:candidate.acrossPx,measuredAxis:match.measuredAxis,designAspectRatio:match.designRatio,rotation:match.rotation*90,confidence:match.confidence});
      const competing=candidates.find(c=>c.page!==chosen.page||overlapFraction(c.candidate.box,candidate.box)<.5);
      const ambiguous=!!competing&&(competing.match.confidence>=MIN_MATCH_CONFIDENCE||match.confidence-competing.match.confidence<=.10);
      if(ambiguous)reasons.push(`Kol desen adayı belirsiz: en iyi eşleşme %${percent(match.confidence)}, diğer aday %${percent(competing.match.confidence)}; tek yerleşim seçilemiyor.`);
      const ratio=match.measuredAxis==='boy'?candidate.acrossPx/candidate.alongPx:candidate.alongPx/candidate.acrossPx;
      const ratioError=Math.abs(ratio/match.designRatio-1),short=Math.min(candidate.box.w,candidate.box.h),long=Math.max(candidate.box.w,candidate.box.h);
      // At <=48 px a single lost ink pixel changes a normalized 24x24 cell
      // substantially. Only a detached, non-solid small mark with independent
      // aspect agreement and a >10 percentage point lead may use 0.65 NCC.
      const fill=chosen.candidate.pixels.length/(candidate.box.w*candidate.box.h);
      const smallDistinct=!ambiguous&&short>=8&&long<=48&&chosen.candidate.pixels.length>=24&&fill>=.1&&fill<=.85&&ratioError<=.25;
      const threshold=smallDistinct?.65:MIN_MATCH_CONFIDENCE;
      Object.assign(source,{matchThreshold:threshold,matchPolicy:smallDistinct?'kucuk_ayrik_desen':'standart',runnerUpConfidence:competing?.match.confidence??null,matchMargin:competing?match.confidence-competing.match.confidence:null});
      // Without proven front/back orientation, image left is not wearer left.
      if(position!=='kol'&&!['on','arka'].includes(image.gorunum))reasons.push('Sol/sağ kol yönü görselden kesin doğrulanamadı; seçilen kol yerleşimi teyit edilmeli.');
      if(match.confidence<threshold)reasons.push(`Kol desen eşleştirme güveni %${percent(match.confidence)}; %${percent(threshold)} sınırının altında.`);
      if(ref) {
        const scale=scaleFor(ref,measurements,scalePair,p,k);
        source.scaleFrom='govde';source.mmPerPx=scale.mean;source.scaleDifference=scale.difference;
        source.hemWidthPx=ref.hemWidthPx;source.bodyHeightPx=ref.bodyHeightPx;
        Object.assign(source,{chestPx:ref.chestLine?.width??null,chestLinePx:ref.chestLine??null,shoulderY:ref.shoulderY,hemY:ref.hemY});
        if(scalePair==='boy_gogus'&&(!scale.vertical||!scale.horizontal))reasons.push('Kol için boy ve göğüs birlikte doğrulanamadı; göğüs çizgisi ve iki L ölçüsü gerekli.');
        if(!scale.mean&&scale.difference>SCALE_MOCKUP)reasons.push(`Kol için gövde ${pairLabel} ölçek farkı %${percent(scale.difference)}; %35 sınırını aşıyor, maske veya omuz hatası olabilir.`);
        else if(scale.mode==='geo_ortalama')Object.assign(source,{scaleMode:'geo_ortalama',verticalMmPerPx:scale.vertical,horizontalMmPerPx:scale.horizontal,scaleNote:mockupNote(scale.difference,pairLabel==='boy/göğüs'?'boy ile göğüs':'boy ile etek')});
        if(ref.symmetry<MIN_SYMMETRY)reasons.push(`Kol için kullanılan gövde simetrisi %${percent(ref.symmetry)}; %85 sınırının altında.`);
      } else if(Number.isFinite(measurements.kol_boyu)&&measurements.kol_boyu>0) {
        source.scaleFrom='kol_boyu';source.mmPerPx=measurements.kol_boyu*10/sleeve.lengthPx;
      }
      if(!source.mmPerPx)reasons.push(`Kol için ölçek kaynağı yok: geçerli L kol_boyu veya aynı görselde doğrulanmış gövde ${pairLabel} ölçeği bulunamadı.`);
      source.scale=source.mmPerPx?source.mmPerPx/10:null;
      if(!ambiguous&&match.confidence>=threshold) {
        const measured=measureSleeve({alongPx:candidate.alongPx,acrossPx:candidate.acrossPx,designRatio:match.designRatio,measuredAxis:match.measuredAxis,mmPerPx:source.mmPerPx});
        source.aspectRatioError=measured.aspectRatioError;
        reasons.push(...measured.reasons);width=measured.width_mm;height=measured.height_mm;
        source.designBoxPx=candidate.box;
      }
      source.summary=width!=null?`Kol boyunca desenin ${match.measuredAxis} ekseni ölçüldü; diğer eksen desen dosyasının oranından hesaplandı. Ölçek: ${source.scaleFrom==='kol_boyu'?'L kol boyu':`aynı görselde L gövde ${pairLabel}`}.`:'Kol deseni değerlendirildi; güvenilir cm ölçüsü oluşmadı. Teyit gerekçelerine bakılmalı.';
    }
  } catch(e) {reasons.push(`Kol ürün/desen görseli okunamadı: ${e.message}`);}
  source.timingsMs={total:Math.round(performance.now()-started)};
  return {width_mm:width,height_mm:height,measure_source:source,needs_confirmation:reasons.length>0,reasons,reason:reasons.join(' ')};
}

// Trousers seen from the front: waist top to hem is the L side length (yan_boy);
// the full width just above the crotch is the L hip (basen). The crotch is the
// top of a persistent background corridor between the two legs.
function legSilhouette(p) {
  const segmented=productMask(p),{mask,box}=segmented,w=p.width,h=p.height;
  if(!box||box.h<h*.3||box.w<w*.1||box.h<box.w*1.2)return null;
  const pixels=[];for(let i=0;i<mask.length;i++)if(mask[i])pixels.push(i);
  const gapX=lowerBodyGap({box,pixels},w);
  if(gapX==null)return null;
  let crotchY=null;
  for(let y=Math.floor(box.y+box.h*.85);y>box.y+box.h*.15;y--)if(mask[y*w+gapX]){crotchY=y+1;break;}
  if(crotchY==null||crotchY>box.y+box.h*.7)return null;
  const span=y=>{let l=-1,r=-1;for(let x=box.x;x<box.x+box.w;x++)if(mask[y*w+x]){if(l<0)l=x;r=x;}
    // A hip row is one continuous run across the body.
    for(let x=l;x<=r;x++)if(!mask[y*w+x])return null;return l<0?null:r-l+1;};
  const widths=[];
  for(let y=Math.round(crotchY-box.h*.06);y<=crotchY-Math.max(2,box.h*.02);y++){const width=span(y);if(width)widths.push(width);}
  if(widths.length<Math.max(2,box.h*.02))return null;
  const hipPx=median(widths),heightPx=box.h;
  // A thigh print is framed by one leg, so the template search resolves
  // artwork against half the hip width.
  return {mask,box,raw:segmented.raw,gapX,crotchY,hipPx,heightPx,chestPx:hipPx/2,hemWidthPx:hipPx};
}
async function autoMeasureLeg({image,design,flat,product,position}) {
  const started=performance.now(),reasons=[],source={scalePair:'yan_boy_basen',method:'otomatik',flatId:flat?.id??null,flatAd:flat?.ad??null,refBeden:flat?.refBeden??null,olculerL:flat?.olculerL??null,gorselFileId:image?.id??null,desenFileId:design?.id??null,selectedView:'on',designBoxPx:null,mmPerPx:null,scale:null,confidence:0};
  let width=null,height=null;
  const positive=n=>Number.isFinite(n)&&n>0;
  const measurements=flat?.refBeden==='L'&&flat?.olculerL&&typeof flat.olculerL==='object'?flat.olculerL:{};
  if(flat?.refBeden!=='L')reasons.push('Ürünün L kalıp referansı bulunamadı: bacak için L beden ölçüsü gerekli.');
  else if(!positive(measurements.yan_boy)||!positive(measurements.basen))reasons.push('Bacak ölçeği için kalıbın L yan_boy ve basen ölçüleri gerekli; ikisi birlikte bulunamadı.');
  const cal=await calibrationFor(flat,'bacak'),k=calibrationFactor(cal);
  source.kalibrasyon=cal;
  try {
    const pages=await rasterPages(image,image.mime==='application/pdf'?1000:MAX_EDGE),designs=design?await rasterPages(design,1000,null,{transparent:true}):[],candidates=[];
    const designContents=designs.map(p=>designContent(p,true));
    if(!designContents.some(c=>c.box))reasons.push('Bacak desen dosyası yok veya boş; desen bacakta eşleştirilemedi.');
    let legCount=0;
    source.pageCount=pages.length;source.designPageCount=designs.length;
    for(let i=0;i<pages.length;i++) {
      const ref=legSilhouette(pages[i]);
      if(!ref)continue;
      legCount++;
      for(let j=0;j<designs.length;j++) {
        if(!designContents[j].box)continue;
        const coarse=matchDesign(pages[i],designs[j],designContents[j],ref,false);
        if(!coarse.box)continue;
        const match=matchDesign(pages[i],designs[j],designContents[j],ref,true,coarse);
        if(match.box)candidates.push({p:pages[i],ref,match,page:i+1,designPage:j+1});
      }
    }
    source.legCount=legCount;
    if(!legCount)reasons.push('Eşofman/pantolon silueti bulunamadı: iki bacak arasında süren zemin boşluğu ve kalça satırı görülmedi.');
    candidates.sort((a,b)=>b.match.confidence-a.match.confidence);
    source.pageCandidates=candidates.slice(0,5).map(c=>({page:c.page,designPage:c.designPage,confidence:Math.round(c.match.confidence*1000)/1000}));
    const chosen=candidates[0];
    if(legCount&&designs.length&&!chosen)reasons.push('Bacak üzerinde desen adayı bulunamadı (0 eşleşme); yerleşim teyit edilmeli.');
    if(chosen) {
      const {p,ref,match}=chosen,box=match.box;
      const competing=candidates.find(c=>c!==chosen&&(c.page!==chosen.page||overlapFraction(c.match.box,box)<.5));
      const ambiguous=match.ambiguous||!!competing&&chosen.match.confidence-competing.match.confidence<.045;
      Object.assign(source,{selectedPage:chosen.page,selectedDesignPage:chosen.designPage,rasterWidth:p.width,rasterHeight:p.height,productBoxPx:ref.box,legGapX:ref.gapX,crotchY:ref.crotchY,hipPx:ref.hipPx,sideLengthPx:ref.heightPx,candidateBoxPx:box,matchConfidence:Math.round(match.confidence*1000)/1000,confidence:Math.round(match.confidence*1000)/1000});
      source.designAspectRatio=match.content.box.w/match.content.box.h;
      if(ambiguous)reasons.push(`Bacak desen adayı belirsiz: en iyi eşleşme %${percent(match.confidence)}${competing?`, diğer aday %${percent(competing.match.confidence)}`:''}; tek yerleşim seçilemiyor.`);
      if(match.confidence<MIN_MATCH_CONFIDENCE)reasons.push(`Bacak desen eşleştirme güveni %${percent(match.confidence)}; %${percent(MIN_MATCH_CONFIDENCE)} sınırının altında.`);
      // Front view: the wearer's left leg is on the image right; a back view mirrors it.
      const imageRight=box.x+box.w/2>ref.gapX,wanted=position==='sol_bacak'?'sol':position==='sag_bacak'?'sag':null;
      const found=image.gorunum==='arka'?(imageRight?'sag':'sol'):(imageRight?'sol':'sag');
      source.legSide=['on','arka'].includes(image.gorunum)?found:null;
      let sideOk=true;
      if(wanted&&!['on','arka'].includes(image.gorunum)){sideOk=false;reasons.push('Sol/sağ bacak yönü görselden kesin doğrulanamadı; ön veya arka görünüm gerekli.');}
      else if(wanted&&found!==wanted){sideOk=false;reasons.push(`Desen ${found==='sol'?'sol':'sağ'} bacakta bulundu; uygulama ${wanted==='sol'?'sol':'sağ'} bacak olarak kayıtlı. Konum teyit edilmeli.`);}
      if(positive(measurements.yan_boy)&&positive(measurements.basen)) {
        const vertical=measurements.yan_boy*10/ref.heightPx*k,horizontal=measurements.basen*10/ref.hipPx/k,{difference,mean,mode}=pairScale(vertical,horizontal);
        Object.assign(source,{verticalMmPerPx:vertical,horizontalMmPerPx:horizontal,scaleDifference:difference});
        if(!mean){source.scaleMethod='çelişen L ölçekleri; ölçü yok';reasons.push(`Yan boy/basen ölçek farkı %${percent(difference)}; %35 sınırını aşıyor, maske veya bel/paça hatası olabilir (${vertical.toFixed(3)} ve ${horizontal.toFixed(3)} mm/px).`);}
        else {
          source.scaleMethod=mode==='geo_ortalama'?'yan_boy ve basen geometrik ortalaması':'yan_boy ve basen ortalaması';source.mmPerPx=mean;source.scale=mean/10;
          if(mode==='geo_ortalama')Object.assign(source,{scaleMode:mode,scaleNote:mockupNote(difference,'yan boy ile basen')});
        }
      }
      if(!ambiguous&&sideOk&&match.confidence>=MIN_MATCH_CONFIDENCE&&source.mmPerPx) {
        source.designBoxPx=box;
        width=Math.round(box.w*source.mmPerPx);height=Math.round(box.h*source.mmPerPx);
        if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<=0||height<=0){reasons.push(`Hesaplanan ölçü fiziksel olarak geçersiz (${width} × ${height} mm); pozitif tam sayı ölçü bulunamadı.`);width=height=null;}
      }
    }
  } catch(e) {reasons.push(`Bacak ürün/desen görseli okunamadı: ${e.message}`);}
  source.timingsMs={total:Math.round(performance.now()-started)};
  return {width_mm:width,height_mm:height,measure_source:source,needs_confirmation:reasons.length>0,reasons,reason:reasons.join(' ')};
}

async function autoMeasure({image,design,flat,product,position}) {
  if(['kol','sol_kol','sag_kol'].includes(position))return autoMeasureSleeve({image,design,flat,product,position});
  if(LEGS.includes(position))return autoMeasureLeg({image,design,flat,product,position});
  const scalePair=scalePairFor(flat,product),pairLabel=scalePair==='boy_gogus'?'boy/göğüs':'boy/etek',horizontalLabel=scalePair==='boy_gogus'?'göğüs':'etek';
  const started=performance.now(),timings={},reasons=[],source={scalePair,method:'otomatik',flatId:flat?.id??null,flatAd:flat?.ad??null,refBeden:flat?.refBeden??null,refCm:flat?.refLengthCm??null,olculerL:flat?.olculerL??null,chestPx:null,designBoxPx:null,scale:null,mmPerPx:null,confidence:0,gorselFileId:image?.id??null,desenFileId:design?.id??null};
  let width=null,height=null;
  const positive=n=>Number.isFinite(n)&&n>0;
  const measurements=flat?.refBeden==='L' && flat?.olculerL && typeof flat.olculerL==='object' ? flat.olculerL : {};
  if(flat?.refBeden!=='L')reasons.push('Ürünün L kalıp referansı bulunamadı: kayıt L beden değil veya belirtilmemiş (geçerli referans sayısı 0).');
  if(!positive(measurements.omuzdan_boy)&&!positive(measurements[scalePair==='boy_gogus'?'gogus':'etek']))reasons.push(`Ürün için geçerli L beden kalıp ölçüleri bulunamadı (boy ve ${horizontalLabel} ölçüsü sayısı 0).`);
  if(viewForPosition(position)==='teyit')reasons.push('Ürün görünümü uygulama konumuyla eşleştirilemedi (geçerli görünüm sayısı 0).');
  const cal=await calibrationFor(flat,scalePair),calK=calibrationFactor(cal);
  source.kalibrasyon=cal;
  try {
    // PDF sheets are scanned small, then only pages whose artwork needs more
    // pixels are redrawn. Photos are already measured at MAX_EDGE.
    const pdf=image.mime==='application/pdf',scanEdge=pdf?320:MAX_EDGE;
    const topEdge=pdf?PDF_THIN_MAX_EDGE:Math.min(MAX_EDGE,Math.max(...Object.values(imageSize(image.buffer,image.mime))));
    const pages=await rasterPages(image,scanEdge),candidates=[],allViews=[],pageEdges=pages.map(()=>scanEdge);
    const tallBack=position==='sirt'&&!design;
    let designs=[];
    if(design)try {designs=await rasterPages(design,1000,null,{transparent:true});}catch(e){source.designReadError=e.message;}
    const designContents=designs.map(p=>designContent(p,true));
    const designRatios=designContents.flatMap(({box},i)=>box?[{page:i+1,ratio:box.w/box.h}]:[]);
    if(design && !designRatios.length)reasons.push('Bağlı desen dosyasının okunur içerik kutusu yok; renk adayının en-boy oranı doğrulanamadı.');
    global.gc?.(); // Release full-resolution native decode surfaces before scanning masks.
    source.pageCount=pages.length;source.designPageCount=designs.length;timings.raster=performance.now()-started;
    for(let i=0;i<pages.length;i++) {
      let refs=silhouettes(pages[i],product);
      const cues=productViewCues(pages[i],refs,product);
      const edge=thinDesignEdge(refs,pageEdges[i],designContents,topEdge);
      if(edge&&edge>pageEdges[i]) {
        // View cues stay from the 320 px sheet; every product must be found again.
        const p=(await rasterPages(image,edge,[i+1]))[0],sx=p.width/pages[i].width,sy=p.height/pages[i].height,found=silhouettes(p,product);
        const mapped=refs.map(ref=>{const box={x:ref.box.x*sx,y:ref.box.y*sy,w:ref.box.w*sx,h:ref.box.h*sy};return found.find(r=>overlapFraction(r.box,box)>.5);});
        if(mapped.every(Boolean)&&new Set(mapped).size===mapped.length){pages[i]=p;pageEdges[i]=edge;refs=mapped;}
      }
      for(let k=0;k<refs.length;k++) {
        const ref=refs[k],cue=cues[k],scale=scaleFor(ref,measurements,scalePair,pages[i],calK);
        allViews.push({page:i+1,index:k,view:cue.view,hooded:cue.hooded,viewEvidence:{lining:cue.lining,cords:cue.cords,...(cue.neckDepth!==undefined?{neckDepth:cue.neckDepth}:{})},maskMethod:ref.maskMethod,...(ref.splitMethod?{splitMethod:ref.splitMethod}:{}),productBoxPx:ref.box,shoulderY:ref.shoulderY,hemY:ref.hemY,hemWidthPx:ref.hemWidthPx,chestLinePx:ref.chestLine??null,bodyHeightPx:ref.bodyHeightPx,...scale});
        if(cue.view!=='teyit'&&cue.view!==viewForPosition(position))continue;
        if(refs.length>1&&cue.view==='teyit'&&!designs.length)continue;
        if(designs.length)for(let j=0;j<designs.length;j++) {
          const match=matchDesign(pages[i],designs[j],designContents[j],ref,false);
          if(match.box)candidates.push({p:pages[i],ref,match,page:i+1,designPage:j+1,index:k});
        }
        // Also retain the color hypothesis: refinement may reject the template.
        // Unknown sheet products need the supplied design. An independently
        // identified front/back view keeps the established color fallback.
        const match=(!designs.length||refs.length===1||cue.view!=='teyit')&&['gogus','sol_gogus','sag_gogus','sirt'].includes(position)?colorDesign(pages[i],ref,tallBack):{box:null};
        if(match.box)candidates.push({p:pages[i],ref,match,page:i+1,designPage:null,index:k});
      }
    }
    source.views=allViews;
    const unknownViews=allViews.filter(v=>allViews.filter(q=>q.page===v.page).length>1&&v.view==='teyit');
    const unknownViewReason=()=>`Ürün görünümü eşleştirme güveni düşük: ${unknownViews.length} görünüm ayrılamadı; görünüm teyit edilmeli.`;
    // A strong template takes precedence over the independent color fallback.
    candidates.sort((a,b)=>(!!b.designPage-!!a.designPage)||b.match.confidence-a.match.confidence);
    source.pageCandidates=candidates.slice(0,5).map(c=>({page:c.page,productIndex:c.index,designPage:c.designPage,confidence:Math.round(c.match.confidence*1000)/1000}));
    timings.scan=performance.now()-started-timings.raster;
    let finalists=[...candidates.filter(c=>c.designPage).slice(0,3),...candidates.filter(c=>!c.designPage).slice(0,3)];
    // Every product on a sheet needs a refined template hypothesis; otherwise
    // a fourth repeated print could be discarded before the ambiguity check.
    const represented=new Set(finalists.filter(c=>c.designPage).map(c=>`${c.page}:${c.index}`));
    for(const c of candidates.filter(c=>c.designPage&&allViews.filter(v=>v.page===c.page).length>1)) {
      const key=`${c.page}:${c.index}`;
      if(!represented.has(key)){finalists.push(c);represented.add(key);}
    }
    // One pixel of template width is 3% of a 36 px logo: draw small matches larger.
    const refineEdge=n=>{
      // Only the page's strongest template hit sets the size; a weaker tiny hit
      // would redraw the page large for nothing.
      const best=finalists.filter(c=>c.page===n&&c.designPage).sort((a,b)=>b.match.confidence-a.match.confidence)[0];
      const size=best?Math.max(best.match.box.w,best.match.box.h):Infinity;
      return Math.max(pdf?640:0,pageEdges[n-1],Math.min(topEdge,Math.ceil(pageEdges[n-1]*REFINE_DESIGN_PX/size)));
    };
    if(finalists.length && (pdf || refineEdge(1)>pageEdges[0])) {
      const numbers=[...new Set(finalists.map(c=>c.page))].sort((a,b)=>a-b),high=[],edges=numbers.map(refineEdge);
      // Parse the PDF once per distinct edge, not once per page.
      for(const edge of new Set(edges)) {
        const wanted=numbers.filter((_,k)=>edges[k]===edge),drawn=await rasterPages(image,edge,wanted);
        wanted.forEach((n,k)=>{high[numbers.indexOf(n)]=drawn[k];});
      }
      const refs=high.map(p=>silhouettes(p,product));
      finalists=finalists.map(candidate=>{
        const n=numbers.indexOf(candidate.page),p=high[n],sx=p.width/candidate.p.width,sy=p.height/candidate.p.height;
        const scaled=b=>({x:b.x*sx,y:b.y*sy,w:b.w*sx,h:b.h*sy}),box=scaled(candidate.ref.box);
        // Component ordering can change when a pale outline appears at 640px.
        const ref=refs[n].slice().sort((a,b)=>overlapFraction(b.box,box)-overlapFraction(a.box,box)).find(r=>overlapFraction(r.box,box)>.5);
        return {...candidate,p,ref,match:{...candidate.match,box:scaled(candidate.match.box)}};
      }).filter(c=>c.ref);
    }
    const refined=finalists.map(candidate=>({...candidate,match:candidate.designPage?matchDesign(candidate.p,designs[candidate.designPage-1],designContents[candidate.designPage-1],candidate.ref,true,candidate.match):colorDesign(candidate.p,candidate.ref,tallBack)}));
    timings.refine=performance.now()-started-timings.raster-timings.scan;
    refined.sort((a,b)=>((!!b.designPage&&b.match.confidence>=.78?1:0)-(!!a.designPage&&a.match.confidence>=.78?1:0))||b.match.confidence-a.match.confidence);
    const chosen=refined[0];
    if(!chosen) {
      if(unknownViews.length)reasons.push(unknownViewReason());
      reasons.push(`Ürün maskesi veya görselde desen bulunamadı (${allViews.length} ürün, 0 uygun desen adayı).`);
    }
    else {
      const {ref,match,page,designPage}=chosen;
      const {vertical,horizontal}=scaleFor(ref,measurements,scalePair,chosen.p,calK);
      source.method=match.method||'otomatik';source.selectedView=viewForPosition(position);
      source.rasterWidth=chosen.p.width;source.rasterHeight=chosen.p.height;
      const competing=refined.find(c=>c.page!==page||c.index!==chosen.index);
      const placementAmbiguous=match.ambiguous || !!competing&&Math.abs(match.confidence-competing.match.confidence)<.045;
      const templateSelectsProduct=designPage&&match.confidence>=MIN_MATCH_CONFIDENCE&&!placementAmbiguous;
      if(unknownViews.some(v=>v.page===page && (v.splitMethod || !templateSelectsProduct)))reasons.push(unknownViewReason());
      source.productSelection=templateSelectsProduct?'desen':'gorunum';
      const pageViews=allViews.filter(v=>v.page===page);
      // Independent products can be drawn at different sizes. Compare scales
      // only for the identified front/back pair, as in the two-view workflow.
      const paired=pageViews.length===2&&pageViews.some(v=>v.view==='on')&&pageViews.some(v=>v.view==='arka');
      const samePage=paired?pageViews.filter(v=>v.mean):[];
      for(const v of paired?pageViews.filter(v=>v.difference>SCALE_MOCKUP+1e-12&&v.index!==chosen.index):[])reasons.push(`${v.view==='arka'?'Arka':'Diğer'} görünümün ${pairLabel} ölçek farkı %${percent(v.difference)}; %35 sınırını aşıyor (${v.vertical.toFixed(3)} ve ${v.horizontal.toFixed(3)} mm/px).`);
      if(samePage.length>1) {
        source.viewScaleDifference=(Math.max(...samePage.map(v=>v.mean))-Math.min(...samePage.map(v=>v.mean)))/(samePage.reduce((s,v)=>s+v.mean,0)/samePage.length);
        if(source.viewScaleDifference>.05)reasons.push(`Ön/arka ortalama ölçek farkı %${percent(source.viewScaleDifference)}; %5 sınırını aşıyor (${samePage.map(v=>v.mean.toFixed(3)).join(' ve ')} mm/px).`);
      }
      source.wrinkleFraction=wrinkleFraction(chosen.p,ref,match.box);
      Object.assign(source,{selectedPage:page,selectedDesignPage:designPage,selectedProductIndex:chosen.index,maskMethod:ref.maskMethod,chestPx:scalePair==='boy_gogus'?(ref.chestLine?.width??null):ref.hemWidthPx,chestLinePx:ref.chestLine??null,hemWidthPx:ref.hemWidthPx,bodyHeightPx:ref.bodyHeightPx,shoulderY:ref.shoulderY,hemY:ref.hemY,shoulderMethod:ref.shoulderMethod,productBoxPx:ref.box,symmetry:ref.symmetry,textureFraction:ref.textureFraction,softEdgeFraction:ref.softEdgeFraction});
      source.matchConfidence=Math.round(Math.max(0,Math.min(1,match.confidence))*1000)/1000;
      source.textureConfidencePenalty=(ref.softEdgeFraction>.35 || ref.textureFraction>.16 || source.wrinkleFraction>.06)?.05:0;
      source.confidence=Math.round(Math.max(0,source.matchConfidence-source.textureConfidencePenalty)*1000)/1000;
      source.candidateBoxPx=match.box;
      source.designAspectRatio=match.content.box?match.content.box.w/match.content.box.h:null;
      source.aspectRatioError=match.box&&source.designAspectRatio?Math.abs(match.box.w/match.box.h/source.designAspectRatio-1):null;
      let colorAspectVerified=true;
      if(!designPage && design && match.box) {
        const ratio=match.box.w/match.box.h;
        const difference=reference=>Math.max(ratio/reference,reference/ratio)-1;
        const closest=designRatios.reduce((best,candidate)=>!best||difference(candidate.ratio)<difference(best.ratio)?candidate:best,null);
        source.aspectReferencePage=closest?.page??null;
        source.designAspectRatio=closest?.ratio??null;
        source.aspectRatioError=closest?difference(closest.ratio):null;
        colorAspectVerified=!!closest&&source.aspectRatioError<=COLOR_ASPECT_TOLERANCE;
        if(closest&&!colorAspectVerified)reasons.push(`Renk adayının en-boy oranı (${ratio.toFixed(2)}) bağlı desenin ${closest.page}. sayfasındaki içerik oranıyla (${closest.ratio.toFixed(2)}) uyuşmuyor: fark %${percent(source.aspectRatioError)}, sınır %${percent(COLOR_ASPECT_TOLERANCE)}.`);
      }
      if(ref.symmetry<MIN_SYMMETRY)reasons.push(`Ürün maskesinin sol-sağ simetrisi %${percent(ref.symmetry)}; %${percent(MIN_SYMMETRY)} sınırının altında.`);
      if(placementAmbiguous)reasons.push(`Desen/ürün eşleşme güveni düşük: birden fazla aday var (en iyi güven %${percent(match.confidence)}${competing?`, diğer ürün güveni %${percent(competing.match.confidence)}`:''}); tek yerleşim teyit edilmeli.`);
      if((scalePair==='boy_gogus'||ref.maskMethod==='acik_zemin_bolge'||ref.box.w*ref.box.h<chosen.p.width*chosen.p.height*.10)&&(!vertical||!horizontal))reasons.push(`Ürün için boy ve ${horizontalLabel} ölçekleri birlikte doğrulanamadı; gövde çizgisi ve iki L ölçüsüyle teyit edilmeli.`);
      source.verticalMmPerPx=vertical;source.horizontalMmPerPx=horizontal;
      const pair=pairScale(vertical,horizontal);
      source.scaleDifference=pair.difference;
      if(vertical&&horizontal&&!pair.mean)reasons.push(`${scalePair==='boy_gogus'?'Boy/göğüs':'Boy/etek'} ölçek farkı %${percent(source.scaleDifference)}; %35 sınırını aşıyor, maske veya omuz hatası olabilir (${vertical.toFixed(3)} ve ${horizontal.toFixed(3)} mm/px).`);
      if(pair.mode==='geo_ortalama'){source.scaleMode='geo_ortalama';source.scaleNote=mockupNote(pair.difference,scalePair==='boy_gogus'?'boy ile göğüs':'boy ile etek');}
      if((vertical&&!horizontal)||(!vertical&&horizontal))source.scaleNote='Tek L ölçeği bulundu (1 eksen); ikinci eksen ölçüsü yok.';
      source.scaleMethod=vertical&&horizontal?`omuzdan_boy ve ${horizontalLabel} ${pair.mode==='geo_ortalama'?'geometrik ':''}ortalaması`:vertical?'yalnız omuzdan_boy':horizontal?`yalnız ${horizontalLabel}`:null;
      source.mmPerPx=vertical&&horizontal?pair.mean:scalePair==='boy_gogus'?null:vertical||horizontal;
      if(scalePair==='boy_gogus'&&(!vertical||!horizontal))source.scaleMethod='eksik boy/göğüs ölçek çifti; ölçü yok';
      if(vertical&&horizontal&&!pair.mean)source.scaleMethod='çelişen L ölçekleri; ölçü yok';
      source.scale=source.mmPerPx?source.mmPerPx/10:null;
      if(source.aspectRatioError>.01)source.aspectRatioNote=`Desen en-boy oranı farkı %${percent(source.aspectRatioError)}.`;
      if(match.confidence<MIN_MATCH_CONFIDENCE)reasons.push(`Desen eşleştirme güveni %${percent(match.confidence)}; %${percent(MIN_MATCH_CONFIDENCE)} sınırının altında.`);
      else if(!placementAmbiguous && colorAspectVerified) {
        source.designBoxPx=match.box;
        if(source.mmPerPx) {
          width=Math.round(match.box.w*source.mmPerPx);height=Math.round(match.box.h*source.mmPerPx);
          if(match.box.w>(scalePair==='boy_gogus'?ref.chestLine?.width:ref.hemWidthPx))reasons.push(`Desen eni ${match.box.w.toFixed(1)} piksel, ürün gövde eninden (${ref.hemWidthPx} piksel) büyük; hesaplanan en ${width} mm.`);
          if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<=0||height<=0){reasons.push(`Hesaplanan ölçü fiziksel olarak geçersiz (${width} × ${height} mm); pozitif tam sayı ölçü bulunamadı.`);width=height=null;}
        }
      }
    }
  } catch(e) {reasons.push(`Ürün/desen okunamadı (ölçü sayısı 0): ${e.message}`);}
  source.timingsMs={...Object.fromEntries(Object.entries(timings).map(([k,v])=>[k,Math.round(v)])),total:Math.round(performance.now()-started)};
  return {width_mm:width,height_mm:height,measure_source:source,needs_confirmation:reasons.length>0,reasons,reason:reasons.join(' ')};
}
// Folds change the brightness of dyed cloth far more than its hue. Fit the
// ring as one colour under varying light; print must lie well off that line.
// Returns how far a pixel is beyond the ring's spread, or null when the ring
// itself is not one shaded colour (a second colour, seam or print edge).
const SHADE_INK=45, SHADE_CLOTH=12;
function clothShading(data,ring,fabric) {
  const norm=fabric[0]**2+fabric[1]**2+fabric[2]**2,mean=(fabric[0]+fabric[1]+fabric[2])/3;
  if(norm<300)return null;
  const fit=i=> {
    const c=[data[i*4],data[i*4+1],data[i*4+2]],s=(c[0]*fabric[0]+c[1]*fabric[1]+c[2]*fabric[2])/norm;
    return [s*mean,Math.max(...c.map((v,k)=>Math.abs(v-s*fabric[k])))];
  };
  const fits=ring.map(fit),levels=fits.map(f=>f[0]).sort((a,b)=>a-b),offs=fits.map(f=>f[1]).sort((a,b)=>a-b);
  const at=(a,q)=>a[Math.min(a.length-1,Math.floor(a.length*q))];
  const low=at(levels,.005),high=at(levels,.995),off=at(offs,.995);
  if(off>20||offs.at(-1)>off+SHADE_CLOTH*2||levels.at(-1)>high+SHADE_CLOTH*2||levels[0]<low-SHADE_CLOTH*2)return null;
  return i=> {const [level,o]=fit(i);return Math.max(o-off,level-high,low-level);};
}
// The placement detector drops thin strokes (star rays) and small lines
// (dates) before joining a print. Rejoin its own contrast ink lying next to
// the print inside the print band; a cord or seam crosses the band edge and
// stays out.
function wholePrint(p,ref,box,tallBack) {
  const w=p.width,h=p.height,cx=ref.bodyCenterX??(ref.box.x+ref.box.w/2);
  // A back has no cords or opening below the collar; its print may rise closer to it.
  const top=Math.max(0,Math.ceil(ref.shoulderY+ref.bodyHeightPx*(tallBack?.04:.14))),bottom=Math.min(h,Math.floor(ref.shoulderY+ref.bodyHeightPx*(tallBack?.83:.62)));
  const left=Math.max(0,Math.ceil(cx-ref.hemWidthPx*.48)),right=Math.min(w,Math.floor(cx+ref.hemWidthPx*.48));
  const all=contrastInk(p,ref),ink=new Uint8Array(w*h);
  for(let y=top;y<bottom;y++)for(let x=left;x<right;x++) {const i=y*w+x;ink[i]=all[i];}
  const parts=components(ink,w,h,2).filter(c=>c.box.x>left&&c.box.y>top&&c.box.x+c.box.w<right&&c.box.y+c.box.h<bottom);
  let b={...box},grown=true;
  while(grown) {
    grown=false;
    const gap=Math.max(2,Math.round(Math.min(b.w,b.h)*.2));
    for(const c of parts) {
      const q=c.box;
      if(c.joined||q.x>b.x+b.w+gap||q.x+q.w<b.x-gap||q.y>b.y+b.h+gap||q.y+q.h<b.y-gap)continue;
      c.joined=grown=true;
      const x0=Math.min(b.x,q.x),y0=Math.min(b.y,q.y);
      b={x:x0,y:y0,w:Math.max(b.x+b.w,q.x+q.w)-x0,h:Math.max(b.y+b.h,q.y+q.h)-y0};
    }
  }
  return b;
}
// Share of the neck/hood opening that is clearly darker than the cloth. Only a
// front view shows the shadowed inside of a neckline or hood; null on light
// cloth, where that shadow is too faint to separate from folds.
function openingShade(p,ref) {
  const w=p.width,d=p.data,cx=ref.bodyCenterX??(ref.box.x+ref.box.w/2);
  const garment=dominant(p,Array.from(ref.mask.keys()).filter(i=>ref.mask[i])),level=(garment[0]+garment[1]+garment[2])/3;
  if(level>128)return null;
  const limit=level-Math.max(12,level*.3);
  let total=0,dark=0;
  for(let y=ref.box.y;y<ref.shoulderY+ref.bodyHeightPx*.05;y++)
    for(let x=Math.ceil(cx-ref.hemWidthPx*.15);x<cx+ref.hemWidthPx*.15;x++) {
      const i=y*w+x;
      if(!ref.mask[i])continue;
      total++;if((d[i*4]+d[i*4+1]+d[i*4+2])/3<limit)dark++;
    }
  return total?dark/total:null;
}
// Extraction only: settle front/back of a side-by-side pair of the same
// garment. Two independent cues are used, and any disagreement leaves both
// views unresolved: the opening shade above, and a chest-side print, which
// only a front carries while the other print sits on the centre line.
function pairViews(p,refs,cues,matches) {
  // A front already found by hood evidence must agree with these cues.
  const known=cues.findIndex(c=>c.view==='on');
  if(refs.length!==2||!comparableShirts(...refs)||cues.some(c=>!['on','teyit'].includes(c.view))||cues.every(c=>c.view==='on'))return;
  const votes=[],shade=refs.map(ref=>openingShade(p,ref));
  if(shade.every(s=>s!=null)) {
    const front=shade.findIndex(s=>s>=.15);
    // Dark cloth always shows a front opening; without one, neither is a front.
    if(front<0||shade[1-front]>.03)return;
    votes.push(front);
  }
  if(matches.every(m=>m.box&&!m.ambiguous)) {
    const offset=refs.map((ref,i)=>Math.abs(matches[i].box.x+matches[i].box.w/2-ref.bodyCenterX)/ref.hemWidthPx);
    const front=offset.findIndex(o=>o>=.15);
    if(front>=0&&offset[1-front]<.08)votes.push(front);
  }
  if(!votes.length||votes.some(v=>v!==votes[0])||(known>=0&&votes[0]!==known))return;
  cues[votes[0]].view='on';cues[1-votes[0]].view='arka';
}
// Artwork recovery uses the existing placement detector but never infers a physical scale.
async function extractArtwork({image,position,product:productKey}) {
  const view=viewForPosition(position);
  const supported=['gogus','sol_gogus','sag_gogus','sirt'];
  if(!supported.includes(position))return {reason:'Bu konumda üründen güvenilir desen ayrıştırılamadı; ayrı desen dosyası bağlayın.'};
  if(image.gorunum&&image.gorunum!==view)return {reason:'Ürün görünümü bildirilen uygulama konumuyla eşleşmedi.'};
  // An extra page detects overflow without decoding the rest of a large sheet.
  const pageLimit=12, selectedPages=Array.from({length:pageLimit+1},(_,i)=>i+1);
  const pages=await rasterPages(image,image.mime==='application/pdf'?640:1000,selectedPages), candidates=[];
  if(pages.length>pageLimit)return {reason:`${pageLimit} sayfadan uzun üründen güvenle desen ayrılamıyor; tek ürün görünümü yükleyin.`};
  let hasProduct=false, ambiguousView=false, wrongSide=false;
  for(const [i,p] of pages.entries()) {
    const refs=silhouettes(p,productKey),cues=productViewCues(p,refs,productKey);
    const matches=refs.map(ref=>colorDesign(p,ref,position==='sirt'));
    pairViews(p,refs,cues,matches);
    for(const [index,ref] of refs.entries()) {
      hasProduct=true;
      const cue=cues[index];
      if(cue.view!=='teyit'&&cue.view!==view)continue;
      const match=matches[index];
      if(!match.box)continue;
      if(refs.length>1&&cue.view==='teyit') {ambiguousView=true;continue;}
      const {x,w}=match.box;
      const offset=(x+w/2-ref.bodyCenterX)/ref.hemWidthPx;
      if((position==='sol_gogus'&&offset<.05)||(position==='sag_gogus'&&offset>-.05)) {wrongSide=true;continue;}
      candidates.push({p,ref,match,page:i+1});
    }
  }
  if(ambiguousView||candidates.length>1||candidates[0]?.match.ambiguous)
    return {reason:'Üründe birden çok görünüm veya desen adayı var; konumu teyit edin ya da ayrı desen bağlayın.'};
  if(!candidates.length) return {reason:wrongSide ? 'Desen bildirilen göğüs tarafıyla eşleşmedi.' : hasProduct
    ? 'Güvenilir desen adayı yok. Düşük kontrast, dikiş veya kesik desen olabilir.'
    : 'Tam ürün maskesi bulunamadı; ürün veya desen kesilmiş olabilir.'};

  const {p,ref,match,page}=candidates[0];
  let b=match.box;
  const {width:w,height:h,data}=p, mask=ref.mask;
  const unsafe={reason:'Desen kenarı kumaş, gölge veya dikişten güvenle ayrılamadı; ayrı desen dosyası bağlayın.'};
  const product=ref.box;
  const sleeveOnly=x=> {
    // A slight crop of the outer sleeve is independent of a complete torso
    // print. Any border contact at torso height remains unsafe.
    if(Math.abs(x-ref.bodyCenterX)<ref.hemWidthPx*.52)return false;
    for(let y=Math.floor(ref.shoulderY+ref.bodyHeightPx*.42);y<product.y+product.h;y++)
      if(mask[y*w+x])return false;
    return true;
  };
  if(product.y<3||product.y+product.h>h-3||
    (product.x<3&&!sleeveOnly(product.x))||(product.x+product.w>w-3&&!sleeveOnly(product.x+product.w-1)))
    return {reason:'Ürün görüntü kenarında kesiliyor; desenin tamamı doğrulanamadı.'};
  if(ref.symmetry<MIN_SYMMETRY)return unsafe;
  const maxW=ref.hemWidthPx*.90,maxH=ref.bodyHeightPx*(position==='sirt'?.70:.44);
  if(b.w>maxW||b.h>maxH) return unsafe;
  const maxChannel=i=>Math.max(data[i*4],data[i*4+1],data[i*4+2]);
  const minChannel=i=>Math.min(data[i*4],data[i*4+1],data[i*4+2]);
  const white=(i,level)=>minChannel(i)>=level&&maxChannel(i)-minChannel(i)<=27;
  // Crop a print box with a margin and read the cloth from its outer ring.
  const isolate=b=> {
    const pad=Math.max(4,Math.round(Math.min(b.w,b.h)*.14));
    const x=Math.max(1,b.x-pad),y=Math.max(1,b.y-pad),right=Math.min(w-1,b.x+b.w+pad),bottom=Math.min(h-1,b.y+b.h+pad),ring=[];
    for(let yy=y;yy<bottom;yy++)for(let xx=x;xx<right;xx++) {
      const i=yy*w+xx;
      if(!mask[i]||data[i*4+3]<250)return null;
      if(xx<x+2||yy<y+2||xx>=right-2||yy>=bottom-2)ring.push(i);
    }
    const fabric=dominant(p,ring);
    const contrast=i=>Math.max(Math.abs(data[i*4]-fabric[0]),Math.abs(data[i*4+1]-fabric[1]),Math.abs(data[i*4+2]-fabric[2]));
    const unstable=wrinkleFraction(p,ref,b)>.08||ring.some(i=>contrast(i)>22)||ring.filter(i=>contrast(i)>9).length>ring.length*.07;
    // On charcoal cloth, folds can shift the background by dozens of levels
    // while remaining far below a neutral white print in every channel. Dyed
    // dark cloth (navy) is left to the shading model below.
    const whiteLayer=unstable&&Math.max(...fabric)-Math.min(...fabric)<=24&&ring.every(i=>maxChannel(i)<=120)&&ring.filter(i=>maxChannel(i)<=90).length>=ring.length*.96;
    const shading=unstable&&!whiteLayer?clothShading(data,ring,fabric):null;
    if(unstable&&!whiteLayer&&!shading)return null;
    return {x,y,right,bottom,cw:right-x,ch:bottom-y,fabric,contrast,whiteLayer,shading};
  };
  b=wholePrint(p,ref,b,position==='sirt');
  if(b.w>maxW||b.h>maxH)return unsafe;
  const crop=isolate(b);
  if(!crop)return unsafe;
  const {x,y,right,bottom,cw,ch,fabric,contrast,whiteLayer,shading}=crop,layered=whiteLayer||!!shading;
  // The placement detector searches the usual print band. A second prominent
  // mark elsewhere on the torso makes a source crop unsafe as well.
  const outside=new Uint8Array(w*h), left=Math.max(2,Math.ceil(ref.bodyCenterX-ref.hemWidthPx*.47)),
    end=Math.min(w-2,Math.floor(ref.bodyCenterX+ref.hemWidthPx*.47));
  for(let yy=Math.max(2,Math.ceil(ref.shoulderY+ref.bodyHeightPx*.14));yy<Math.min(h-2,ref.hemY-ref.bodyHeightPx*.08);yy++)
    for(let xx=left;xx<end;xx++) {
      if(xx>=x&&xx<right&&yy>=y&&yy<bottom)continue;
      const i=yy*w+xx;
      if(mask[i]&&mask[i-2]&&mask[i+2]&&mask[i-2*w]&&mask[i+2*w]&&(whiteLayer?white(i,172):shading?shading(i)>=SHADE_INK:contrast(i)>75))outside[i]=1;
    }
  if(components(outside,w,h,Math.max(12,match.score*.10)).some(c=>c.box.w>=5&&c.box.h>=5))
    return {reason:'Üründe birden çok desen adayı var; konumu teyit edin ya da ayrı desen bağlayın.'};
  const ink=new Uint8Array(cw*ch), core=layered?new Uint8Array(cw*ch):null;
  let coreArea=0;
  for(let yy=0;yy<ch;yy++)for(let xx=0;xx<cw;xx++) {
    const i=(y+yy)*w+x+xx,j=yy*cw+xx;
    if(whiteLayer) {
      // Reject a second bright ink layer rather than silently making it transparent.
      if(maxChannel(i)>=150&&!white(i,128))return unsafe;
      if(white(i,172)) {core[j]=ink[j]=1;coreArea++;}
    } else if(shading) {
      if(shading(i)>=SHADE_INK) {core[j]=ink[j]=1;coreArea++;}
    } else if(contrast(i)>19)ink[j]=1;
  }
  if(layered) {
    if(coreArea<Math.max(24,match.score*.68))return unsafe;
    const nearCore=dilate(core,cw,ch,1,1);
    let loose=0;
    for(let yy=0;yy<ch;yy++)for(let xx=0;xx<cw;xx++) {
      const i=(y+yy)*w+x+xx,j=yy*cw+xx;
      if(whiteLayer) {if(nearCore[j]&&white(i,125))ink[j]=1;}
      else if(shading(i)>SHADE_CLOTH) {if(nearCore[j])ink[j]=1;else loose++;}
    }
    // Off-cloth pixels away from the print edge are a fold or a faint second
    // layer that neither the cloth model nor the print explains.
    if(loose>coreArea*.03)return unsafe;
  }
  const parts=components(ink,cw,ch), box=bounds(ink,cw,ch);
  if(!box||box.w<8||box.h<8||box.x<2||box.y<2||box.x+box.w>cw-2||box.y+box.h>ch-2)return unsafe;
  const area=parts.reduce((sum,c)=>sum+c.area,0);
  if(area<box.w*box.h*(layered?.035:.08)||parts.some(c=>c.area>=8&&(c.box.w>c.box.h*10||c.box.h>c.box.w*10)))return unsafe;
  const rowInk=new Uint16Array(box.h),colInk=new Uint16Array(box.w);
  for(let yy=0;yy<box.h;yy++)for(let xx=0;xx<box.w;xx++)if(ink[(box.y+yy)*cw+box.x+xx]) {rowInk[yy]++;colInk[xx]++;}
  const thinLimit=Math.max(2,Math.round(Math.min(box.w,box.h)*.07));
  // Each check returns the suspicious thin ends as [from,to) ranges along the profile.
  const thinEnds=counts=> {
    const first=counts.findIndex(n=>n>thinLimit),last=counts.findLastIndex(n=>n>thinLimit),limit=Math.max(5,counts.length*.17);
    if(first<0)return [[0,counts.length]];
    return [...(first>limit?[[0,first]]:[]),...(counts.length-1-last>limit?[[last+1,counts.length]]:[])];
  };
  const flatThinEnds=counts=> {
    const limit=Math.max(10,Math.round(counts.length*.12)),ends=[];
    for(const reversed of [false,true]) {
      const values=reversed?counts.slice().reverse():counts;
      let run=0,runWidth=0,n=0;
      for(const value of values) {
        if(value>thinLimit)break;
        n++;
        if(Math.abs(value-runWidth)>1) {run=0;runWidth=value;}
        if(++run>=limit) {
          const thick=values.findIndex(v=>v>thinLimit),to=thick<0?values.length:thick;
          ends.push(reversed?[counts.length-to,counts.length]:[0,to]);break;
        }
      }
    }
    return ends;
  };
  // A thin end is a seam or cord unless it grows out of the print itself and
  // tapers: every ink pixel there belongs to a part that continues past the
  // thin end and is broad elsewhere, and the end narrows away from it, like
  // the ray of a star. A seam or cord keeps one width along its length.
  const owner=new Int32Array(cw*ch).fill(-1);
  parts.forEach((part,k)=>{for(const i of part.pixels)owner[i]=k;});
  const attached=(rows,[from,to])=> {
    const seen=new Set();
    for(let a=from;a<to;a++)for(let bIndex=0;bIndex<(rows?box.w:box.h);bIndex++) {
      const yy=box.y+(rows?a:bIndex),xx=box.x+(rows?bIndex:a),k=owner[yy*cw+xx];
      if(k>=0)seen.add(k);
    }
    return [...seen].every(k=> {
      const q=parts[k].box,start=(rows?q.y-box.y:q.x-box.x),stop=start+(rows?q.h:q.w);
      return parts[k].area>=area*.05&&(rows?q.w:q.h)>=thinLimit*3&&(start<from||stop>to);
    });
  };
  const tapered=(counts,[from,to])=> {
    const widths=Array.from(counts.subarray(from,to)).filter(n=>n>0);
    if(widths.length<3)return false;
    const third=Math.max(1,Math.floor(widths.length/3)),mean=a=>a.reduce((x,y)=>x+y,0)/a.length;
    const [far,near]=from===0?[widths.slice(0,third),widths.slice(-third)]:[widths.slice(-third),widths.slice(0,third)];
    return mean(near)>=Math.max(2,mean(far)*1.8);
  };
  const ends=(layered?flatThinEnds:thinEnds);
  if(ends(rowInk).some(r=>!attached(true,r)||!tapered(rowInk,r))||ends(colInk).some(r=>!attached(false,r)||!tapered(colInk,r)))return unsafe;
  // A real print should have a repeatable boundary. Small changes to the
  // fabric threshold must not make a substantial part of the artwork vanish.
  let weak=0,opaque=0,sameColor=0;
  const first=parts[0].pixels[0],colorOffset=((y+Math.floor(first/cw))*w+x+first%cw)*4;
  for(const part of parts)for(const i of part.pixels) {
    const source=(y+Math.floor(i/cw))*w+x+i%cw,d=contrast(source),offset=source*4;
    if(d<30)weak++;
    if(d>=65)opaque++;
    if(Math.abs(data[offset]-data[colorOffset])<=9&&Math.abs(data[offset+1]-data[colorOffset+1])<=9&&Math.abs(data[offset+2]-data[colorOffset+2])<=9)sameColor++;
  }
  if(layered ? coreArea>box.w*box.h*.91 : weak>area*.14||opaque<area*.28||(area>box.w*box.h*.94&&sameColor>area*.94))return unsafe;
  const canvas=canvasLib.createCanvas(box.w,box.h),ctx=canvas.getContext('2d'),ground=Math.max(...fabric);
  try {
    const pixels=ctx.createImageData(box.w,box.h);
    for(let yy=0;yy<box.h;yy++)for(let xx=0;xx<box.w;xx++) {
      const i=(box.y+yy)*cw+box.x+xx;
      if(!ink[i])continue;
      const src=((y+box.y+yy)*w+x+box.x+xx)*4,dst=(yy*box.w+xx)*4;
      if(whiteLayer) {
        const shade=minChannel(src/4);
        const coverage=core[i]&&shade>=195 ? 255 : Math.round(255*(shade-ground)/(235-ground));
        pixels.data.set([255,255,255,coverage],dst);
      } else if(shading&&!core[i]) {
        // Edge pixels blend print and cloth; keep their share as opacity.
        const coverage=Math.round(255*Math.min(1,(shading(src/4)-SHADE_CLOTH)/(SHADE_INK-SHADE_CLOTH)));
        pixels.data.set([data[src],data[src+1],data[src+2],coverage],dst);
      } else pixels.data.set(data.subarray(src,src+4),dst);
    }
    ctx.putImageData(pixels,0,0);
    return {buffer:canvas.toBuffer('image/png'),placement:{page,view,rasterWidth:w,rasterHeight:h,designBoxPx:{...box,x:x+box.x,y:y+box.y}}};
  } finally {canvas.width=canvas.height=0;}
}
module.exports={autoMeasure,raster,rasterPages,viewForPosition,designContent,silhouette,silhouettes,extractArtwork};
