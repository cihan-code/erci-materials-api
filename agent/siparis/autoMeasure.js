'use strict';

// No database or filesystem access here: this module runs in the render worker.
let canvasLib; // Native canvas is loaded only in the child, never by HTTP routing.
const { imageSize, measureSleeve } = require('./measure');
const bodyPoints = require('./olcuNoktalari');
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
// G58: no garment on a pale ground usually means a white or pale garment the mask cannot
// separate from it (no edge is traced from shadows). Say so instead of a bare count.
function paleGroundReason(p) {
  const {width:w,height:h}=p,edges=[];
  for(let x=0;x<w;x++){edges.push(x,(h-1)*w+x);}for(let y=0;y<h;y++)edges.push(y*w,y*w+w-1);
  const bg=dominant(p,edges);
  if(Math.min(...bg)<225)return [];
  const hex='#'+bg.map(v=>Math.round(v).toString(16).padStart(2,'0')).join('');
  return [`Ürün zeminden ayrılamadı: görselin zemini açık renkli (${hex}); beyaz veya açık renkli ürünün kenarı güvenilir bulunamadı. Ürünü renkli zeminde gösteren bir görsel yükleyin ya da ölçüyü elle girin.`];
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
  let transparent=p.data.some((v,i)=>i%4===3 && v<128);
  // A vector proof drawn on a filled background rectangle can leave a partly
  // covered last pixel row at the page edge (G47); that fringe alone does not
  // make the artwork transparent when the edges form one matte colour.
  const fringeOnly=transparent&&!p.data.some((v,i)=>{if(i%4!==3||v>=128)return false;const x=(i>>2)%p.width,y=Math.floor((i>>2)/p.width);return x>0&&y>0&&x<p.width-1&&y<p.height-1;});
  const [r,g,b]=p.data,delta=i=>Math.max(Math.abs(p.data[i*4]-r),Math.abs(p.data[i*4+1]-g),Math.abs(p.data[i*4+2]-b));
  let matte=removeMatte&&(!transparent||fringeOnly)&&Math.min(r,g,b)<240;
  // A colored proof background is used only when the four edges agree.
  // Leave transparent artwork and existing light-background masks alone.
  if(matte) {
    for(let x=0;x<p.width&&matte;x++)matte=delta(x)<=12&&delta((p.height-1)*p.width+x)<=12;
    for(let y=0;y<p.height&&matte;y++)matte=delta(y*p.width)<=12&&delta((y+1)*p.width-1)<=12;
    if(matte)transparent=false;
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
  let band=rows.filter(r=>r.y>=hemY-box.h*.12 && r.y<=hemY-box.h*.075 && r.width>box.w*.2);
  let hemWidthPx=band.length?median(band.map(r=>r.width)):null;
  // Arms hanging straight down put both cuffs into the hem band (G47b: a
  // hoodie photographed flat, band = 95% of the silhouette). Below the cuffs
  // the hem rib is the torso alone: a run of rows of one stable width.
  if(hemWidthPx&&hemWidthPx>=box.w*.9) {
    const low=rows.filter(r=>r.y>hemY-box.h*.075&&r.width>0&&r.width<hemWidthPx*.8);
    let best=[],run=[];
    for(const r of low) {
      if(run.length&&(r.y!==run.at(-1).y+1||Math.abs(r.width-run[0].width)>run[0].width*.03))run=[];
      run.push(r);if(run.length>best.length)best=run.slice();
    }
    if(best.length>=Math.max(4,box.h*.03)){band=best;hemWidthPx=median(best.map(r=>r.width));}
  }
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
  // A lining lies under the hood crown; ink at the silhouette top is a hanger or background (G47).
  const lining=components(ink,w,h,ref.hemWidthPx).filter(c=>c.box.y<ref.shoulderY&&c.box.y>ref.box.y+ref.bodyHeightPx*.01&&c.box.w>ref.hemWidthPx*.28&&c.box.h>ref.bodyHeightPx*.035&&Math.abs(c.box.x+c.box.w/2-cx)<ref.hemWidthPx*.2);
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
  // A tee has no hood: the background inside its collar is not a lining (G47).
  if(product==='tisort')for(const c of cues){c.view='teyit';c.hooded=false;}
  if(product==='tisort')shirtViews(refs,cues);
  // A visible hood opening or cords identify the front of a hooded pair.
  if(refs.length===2 && cues.filter(c=>c.view==='on').length===1) {
    const other=cues.find(c=>c.view!=='on');
    if(other.hooded)other.view='arka';
    // A back print reaching the collar can pass for a lining (G47: a half-zip
    // stand collar). On dark cloth the front's opening is shadowed; when the
    // "back" shows that shadow and the "front" none, both views stay open.
    const front=cues.findIndex(c=>c.view==='on'),shade=refs.map(ref=>openingShade(p,ref));
    if(other.view==='arka'&&shade.every(v=>v!=null)&&shade[front]<=.03&&shade[1-front]>=.1&&pairedGarments(...refs))
      for(const c of cues)c.view='teyit';
  }
  return cues;
}

// Content width/height ratios of the linked design pages, for colorDesign.
const contentRatios=contents=>contents.flatMap(({box})=>box?[box.w/box.h]:[]);
const ratioMatches=(ratio,ratios)=>ratios.some(r=>Math.max(ratio/r,r/ratio)-1<=COLOR_ASPECT_TOLERANCE);
// A letter-spaced line of small lettering joins into one box that is too thin
// and too low for an anonymous print. It is accepted only as the linked
// design: at least three separate letters whose joined box has the design's
// width/height ratio.
function colorDesign(p,ref,tallBack=false,ratios=[]) {
  const w=p.width,h=p.height,cx=ref.bodyCenterX??(ref.box.x+ref.box.w/2),ink=contrastInk(p,ref),clean=new Uint8Array(ink.length);
  // A large back print can extend below the usual print band.
  const top=ref.shoulderY+ref.bodyHeightPx*(tallBack?.11:.14),bottom=ref.shoulderY+ref.bodyHeightPx*(tallBack?.83:.62);
  const part=new Int32Array(ink.length),parts=components(ink,w,h,2);
  for(const [k,c] of parts.entries()) {
    const b=c.box,ratio=Math.max(b.w/b.h,b.h/b.w);
    // Reject piping, lining, cords and long seams before joining print letters.
    if(ratio>9 || (b.h>ref.bodyHeightPx*.12&&b.w<ref.hemWidthPx*.055) || b.y<top || b.y+b.h>bottom || b.x<cx-ref.hemWidthPx*.48 || b.x+b.w>cx+ref.hemWidthPx*.48)continue;
    for(const i of c.pixels){clean[i]=1;part[i]=k+1;}
  }
  const joined=dilate(clean,w,h,Math.max(2,Math.round(ref.hemWidthPx*.022)),Math.max(2,Math.round(ref.bodyHeightPx*.016)));
  const candidates=[];
  for(const c of components(joined,w,h,10)) {
    const pixels=c.pixels.filter(i=>clean[i]);if(!pixels.length)continue;
    let x=w,y=h,r=0,b=0;for(const i of pixels){x=Math.min(x,i%w);r=Math.max(r,i%w);y=Math.min(y,Math.floor(i/w));b=Math.max(b,Math.floor(i/w));}
    const box={x,y,w:r-x+1,h:b-y+1},density=pixels.length/(box.w*box.h);
    if(density<.035)continue;
    if(box.w<ref.hemWidthPx*.045||box.h<ref.bodyHeightPx*.018||box.w/box.h>8||box.h/box.w>4) {
      const ids=[...new Set(pixels.map(i=>part[i]))],middle=box.y+box.h/2,letters=ids.length;
      // One row of letters: each crosses the middle line of the joined box.
      const row=ids.every(k=>{const q=parts[k-1].box;return q.y<=middle&&q.y+q.h>=middle;});
      if(!(letters>=3&&row&&box.h>=4&&box.w>=ref.hemWidthPx*.1&&box.w>box.h&&ratioMatches(box.w/box.h,ratios)))continue;
      candidates.push({box,score:pixels.length,confidence:.86,content:{box},method:'otomatik_renk',lettering:letters});
      continue;
    }
    candidates.push({box,score:pixels.length,confidence:.86,content:{box},method:'otomatik_renk'});
  }
  candidates.sort((a,b)=>b.score-a.score);
  if(!candidates.length)return {box:null,confidence:0,ambiguous:false,content:{box:null},method:'otomatik_renk'};
  return {...candidates[0],ambiguous:!!candidates[1]&&candidates[1].score>candidates[0].score*.4,others:candidates.slice(1)};
}

// G47b: thin or multi-part designs (≡ bars, wavy lines, line art) defeat the
// sliding template. Group the garment's ink at a few join radii, keep groups
// whose box has the design's width/height ratio, and compare each group with
// the design's own layout: a coarse occupancy grid plus row and column
// profiles, each as normalized correlation. Ink is read against the garment
// colour with a local threshold (half the group's peak contrast), so a
// blurred mockup print keeps its bars apart. The silhouette's anti-aliased
// edge is excluded. A second distinct group within 10% leaves it ambiguous.
const GROUP_RADII=[.01,.02,.04,.08];
function profileOf(mask,w,box,n,rows) {
  const out=new Float64Array(n),[a0,len,b0,span]=rows?[box.y,box.h,box.x,box.w]:[box.x,box.w,box.y,box.h];
  for(let k=0;k<n;k++) {
    const from=Math.floor(a0+k*len/n),to=Math.max(from+1,Math.floor(a0+(k+1)*len/n));let ink=0;
    for(let a=from;a<to;a++)for(let b=b0;b<b0+span;b++)ink+=mask[rows?a*w+b:b*w+a]?1:0;
    out[k]=ink/((to-from)*span);
  }
  return out;
}
function gridOf(mask,w,box,n) {
  const out=new Float64Array(n*n);
  for(let gy=0;gy<n;gy++)for(let gx=0;gx<n;gx++) {
    const x0=Math.floor(box.x+gx*box.w/n),x1=Math.max(x0+1,Math.floor(box.x+(gx+1)*box.w/n)),y0=Math.floor(box.y+gy*box.h/n),y1=Math.max(y0+1,Math.floor(box.y+(gy+1)*box.h/n));
    let ink=0;for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++)ink+=mask[y*w+x]?1:0;
    out[gy*n+gx]=ink/((x1-x0)*(y1-y0));
  }
  return out;
}
function correlation(a,b) {
  // Short profiles are smoothed alike: a blurred bar is wider than its source.
  if(a.length<=32){const k=Math.max(1,Math.round(a.length/12)),soft=v=>Float64Array.from(v,(_,i)=>{let t=0,n=0;for(let j=i-k;j<=i+k;j++)if(j>=0&&j<v.length){t+=v[j];n++;}return t/n;});a=soft(a);b=soft(b);}
  const n=a.length,ma=a.reduce((s,v)=>s+v,0)/n,mb=b.reduce((s,v)=>s+v,0)/n;let c=0,va=0,vb=0;
  for(let i=0;i<n;i++){c+=(a[i]-ma)*(b[i]-mb);va+=(a[i]-ma)**2;vb+=(b[i]-mb)**2;}
  return va>1e-9&&vb>1e-9?c/Math.sqrt(va*vb):0;
}
function layoutScore(mask,w,box,design,content) {
  const g=Math.max(4,Math.min(12,Math.floor(Math.min(box.w,box.h)/3))),r=Math.max(8,Math.min(32,box.h)),c=Math.max(8,Math.min(32,box.w));
  const pairs=[[gridOf(mask,w,box,g),gridOf(content.mask,design.width,content.box,g)],
    [profileOf(mask,w,box,r,true),profileOf(content.mask,design.width,content.box,r,true)],
    [profileOf(mask,w,box,c,false),profileOf(content.mask,design.width,content.box,c,false)]];
  // A flat design profile (straight bars seen across) carries no layout; its
  // correlation would be noise. Only informative comparisons are averaged.
  const informative=pairs.filter(([,d])=>{const m=d.reduce((s,v)=>s+v,0)/d.length;return m>0&&Math.sqrt(d.reduce((s,v)=>s+(v-m)**2,0)/d.length)/m>.05;});
  return informative.length?informative.reduce((s,[a,d])=>s+correlation(a,d),0)/informative.length:0;
}
// A converted proof can carry a filled rectangle that the source shows as
// transparent (G47b: svg-to-pdfkit drew OTOKON's SVG on a black box). Its
// uniform border marks it; the content inside it is the artwork. Used only as
// a second hypothesis by groupDesign: a real rectangular badge keeps its box.
function innerMatte(p,content) {
  if(!content.box)return null;
  if(content.box.w<p.width*.3||content.box.h<p.height*.3)return null;
  // Two pixels inside: the rectangle's own edge is anti-aliased.
  const x=content.box.x+2,y=content.box.y+2,bw=content.box.w-4,bh=content.box.h-4,w=p.width,d=p.data;
  const ring=[];for(let i=x;i<x+bw;i++)ring.push(y*w+i,(y+bh-1)*w+i);for(let j=y;j<y+bh;j++)ring.push(j*w+x,j*w+x+bw-1);
  const c=[d[ring[0]*4],d[ring[0]*4+1],d[ring[0]*4+2]];
  if(ring.some(i=>d[i*4+3]<128||distance([d[i*4],d[i*4+1],d[i*4+2]],c)>12))return null;
  const mask=new Uint8Array(w*p.height);
  for(let j=y;j<y+bh;j++)for(let i=x;i<x+bw;i++){const k=j*w+i;mask[k]=d[k*4+3]>32&&distance([d[k*4],d[k*4+1],d[k*4+2]],c)>20?1:0;}
  const box=bounds(mask,w,p.height);
  return box?{mask,box}:null;
}
function groupDesign(p,ref,design,content) {
  const inner=innerMatte(design,content);
  if(inner) {
    const a=groupDesignWith(p,ref,design,content),b=groupDesignWith(p,ref,design,inner);
    return b.confidence>a.confidence?b:a;
  }
  return groupDesignWith(p,ref,design,content);
}
function groupDesignWith(p,ref,design,content) {
  const none={box:null,confidence:0,ambiguous:false,content,method:'otomatik',group:true};
  if(!content.box)return none;
  const w=p.width,h=p.height,ratio=content.box.w/content.box.h,garment=dominant(p,Array.from(ref.mask.keys()).filter(i=>ref.mask[i]));
  const e=Math.max(3,Math.round(ref.hemWidthPx*.015)),contrast=new Float32Array(w*h),ink=new Uint8Array(w*h);
  const {x:bx,y:by,w:bw,h:bh}=ref.box;
  for(let y=Math.max(e,by);y<Math.min(h-e,by+bh);y++)for(let x=Math.max(e,bx);x<Math.min(w-e,bx+bw);x++) {
    const i=y*w+x;
    if(!ref.mask[i]||!ref.mask[i-e]||!ref.mask[i+e]||!ref.mask[i-e*w]||!ref.mask[i+e*w])continue;
    contrast[i]=distance([p.data[i*4],p.data[i*4+1],p.data[i*4+2]],garment);ink[i]=contrast[i]>40?1:0;
  }
  const found=[];
  for(const radius of GROUP_RADII) {
    const r=Math.max(1,Math.round(ref.hemWidthPx*radius)),joined=dilate(ink,w,h,r,r);
    for(const c of components(joined,w,h,8)) {
      const own=c.pixels.filter(i=>ink[i]);if(own.length<6)continue;
      const values=own.map(i=>contrast[i]).sort((a,b)=>a-b),t=Math.max(40,values[Math.floor(values.length*.95)]*.5);
      const local=new Uint8Array(w*h);let x0=w,y0=h,x1=-1,y1=-1;
      for(const i of own)if(contrast[i]>t){local[i]=1;const x=i%w,y=(i-x)/w;x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);}
      if(x1<0)continue;
      const box={x:x0,y:y0,w:x1-x0+1,h:y1-y0+1};
      if(box.w<4||box.h<3||box.w>ref.hemWidthPx*1.1||!ratioMatches(box.w/box.h,[ratio]))continue;
      if(found.some(f=>f.box.x===box.x&&f.box.y===box.y&&f.box.w===box.w&&f.box.h===box.h))continue;
      found.push({box,score:layoutScore(local,w,box,design,content)});
    }
  }
  found.sort((a,b)=>b.score-a.score);
  const best=found[0];if(!best)return none;
  const rival=found.find(f=>overlapFraction(f.box,best.box)<.5&&overlapFraction(best.box,f.box)<.5);
  return {...none,box:best.box,confidence:Math.max(0,best.score),ambiguous:!!rival&&rival.score>=best.score*.9,rival:rival?Math.round(rival.score*1000)/1000:null};
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
  const L=bodyPoints.points(flat,{requireL:false}).cm,positive=n=>Number.isFinite(n)&&n>0;
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
  // G47d: a blurred, letter-spaced or sheared sleeve print falls apart on the
  // contrast-90 mask. As in groupDesign, fainter ink away from the silhouette
  // edge is grouped at wider radii and kept above half its own peak contrast.
  const garment=dominant(p,Array.from(mask.keys()).filter(i=>mask[i])),contrast=new Float32Array(w*h),faint=new Uint8Array(w*h);
  const e=Math.max(3,Math.round(sleeve.lengthPx*.02));
  for(let y=e;y<h-e;y++)for(let x=e;x<w-e;x++) {
    const i=y*w+x;
    if(!mask[i]||!mask[i-e]||!mask[i+e]||!mask[i-e*w]||!mask[i+e*w])continue;
    contrast[i]=distance([p.data[i*4],p.data[i*4+1],p.data[i*4+2]],garment);faint[i]=contrast[i]>40?1:0;
  }
  for(const radius of [.02,.05,.1].map(k=>Math.max(1,Math.round(sleeve.lengthPx*k))))
    for(const c of components(dilate(faint,w,h,radius,radius),w,h,8)) {
      const own=Array.from(c.pixels).filter(i=>faint[i]);if(own.length<8)continue;
      const values=own.map(i=>contrast[i]).sort((a,b)=>a-b),t=Math.max(40,values[Math.floor(values.length*.95)]*.5);
      const pixels=own.filter(i=>contrast[i]>t),extent=sleeve.project(pixels);
      if(pixels.length<8||extent.alongPx<4||extent.acrossPx<4||extent.alongPx>sleeve.lengthPx*.65)continue;
      const local=new Uint8Array(w*h);for(const i of pixels)local[i]=1;
      const box=bounds(local,w,h);
      if(!found.some(f=>f.grouped&&f.box.x===box.x&&f.box.y===box.y&&f.box.w===box.w&&f.box.h===box.h))found.push({mask:local,pixels,box,...extent,grouped:true,contrast});
    }
  return found;
}
// G55 (Patron, 21.11.2026): blur-aware aspect for small sleeve prints read by
// the aligned path. The blur is the image's own edge spread: the 10-90% rise
// of the print's outermost edges (background outside, ink plateau inside)
// along scan lines in the print's frame, on the contrast map. Its median is
// subtracted from the stroke thickness (the short side). The sleeve's curve
// shows as shear: the along-centre of the ink drifting with the across
// position; the along extent is taken after removing it. The ±10% rule is
// unchanged. Few or scattered edges, or blur over half the thickness, make
// the estimate unreliable.
function edgeSpread(p,con,origin,u,v,along,across,peak) {
  const w=p.width,h=p.height,at=(a,c)=>{
    const X=origin.x+a*u.x+c*v.x,Y=origin.y+a*u.y+c*v.y,x0=Math.floor(X),y0=Math.floor(Y),fx=X-x0,fy=Y-y0;
    if(x0<0||y0<0||x0+1>=w||y0+1>=h)return 0;
    const g=(x,y)=>con[y*w+x];
    return g(x0,y0)*(1-fx)*(1-fy)+g(x0+1,y0)*fx*(1-fy)+g(x0,y0+1)*(1-fx)*fy+g(x0+1,y0+1)*fx*fy;
  };
  const spreads=[];
  for(const [lines,span,acrossLines] of [[along,across,true],[across,along,false]]) {
    for(let s=lines.from;s<=lines.to;s++) {
      const profile=[];for(let t=span.from-4;t<=span.to+4;t+=.25)profile.push(acrossLines?at(s,t):at(t,s));
      const cross=[];for(let k=1;k<profile.length;k++)if((profile[k-1]<peak*.5)!==(profile[k]<peak*.5))cross.push(k);
      if(cross.length<2)continue;
      for(const [k,rising] of [[cross[0],true],[cross.at(-1),false]]) {
        let i10=k,i90=k;
        if(rising){while(i10>0&&profile[i10]>peak*.1)i10--;while(i90<profile.length-1&&profile[i90]<peak*.9)i90++;}
        else{while(i10<profile.length-1&&profile[i10]>peak*.1)i10++;while(i90>0&&profile[i90]<peak*.9)i90--;}
        if(i10===0||i10===profile.length-1)continue;
        const inside=rising?profile.slice(k,k+16):profile.slice(Math.max(0,k-16),k);
        if(Math.max(...inside)<peak*.9)continue;
        spreads.push(Math.abs(i90-i10)*.25);
      }
    }
  }
  spreads.sort((a,b)=>a-b);
  if(!spreads.length)return {spread:null,edges:0,iqr:null};
  const q=f=>spreads[Math.floor(spreads.length*f)];
  return {spread:q(.5),edges:spreads.length,iqr:q(.75)-q(.25)};
}
function blurAwareAspect(p,candidate,u,v,center,pts) {
  const con=candidate.contrast,pixels=candidate.pixels;
  const peak=Array.from(pixels,i=>con[i]).sort((a,b)=>a-b)[Math.floor(pixels.length*.95)];
  const as=pts.map(q=>q[0]),cs=pts.map(q=>q[1]);
  const along={from:Math.floor(Math.min(...as)),to:Math.ceil(Math.max(...as))},across={from:Math.floor(Math.min(...cs)),to:Math.ceil(Math.max(...cs))};
  const blur=edgeSpread(p,con,center,u,v,along,across,peak);
  // Shear: the ink's along-mean of each across row against the across
  // position, weighted by the row's ink. Sparse rows (a word's tops and
  // bottoms) only carry a few letters and are left out.
  const rows=new Map();for(const [a,c] of pts){const k=Math.round(c);if(!rows.has(k))rows.set(k,{n:0,sum:0});const r=rows.get(k);r.n++;r.sum+=a;}
  const full=Math.max(...[...rows.values()].map(r=>r.n)),used=[...rows].filter(([,r])=>r.n>=full*.25);
  let tw=0,tx=0,ty=0;for(const [k,r] of used){tw+=r.n;tx+=k*r.n;ty+=r.sum;}
  const mx=tx/tw,my=ty/tw;let sxy=0,sxx=0;
  for(const [k,r] of used){sxy+=(k-mx)*(r.sum-my*r.n);sxx+=r.n*(k-mx)**2;}
  // A sleeve curve tilts a print by a few degrees; a slope beyond 0.5 (27°)
  // is letter shape, not a curve, and is not applied.
  const fitted=sxx?sxy/sxx:0,shear=Math.abs(fitted)<=.5?fitted:0,straight=pts.map(([a,c])=>a-shear*c);
  const W=Math.max(...straight)-Math.min(...straight)+1,H=Math.max(...cs)-Math.min(...cs)+1,thin=Math.min(W,H);
  const reliable=blur.spread!=null&&blur.edges>=12&&blur.iqr<=Math.max(1,blur.spread*.5)&&blur.spread<thin*.5;
  const Wc=W<H?W-blur.spread:W,Hc=H<=W?H-blur.spread:H;
  return {reliable,spread:blur.spread,edges:blur.edges,iqr:blur.iqr,shear,ratio:reliable?Wc/Hc:null};
}
// G47d: a grouped sleeve print read in its own frame. Two axes are tried: the
// principal axis of its ink (a word) and the stroke direction from the
// contrast structure tensor (sheared bars). The frame is sampled back from
// the image, so turning leaves no holes. Below 16 px across, blur shapes the
// cross profile; only the profile along the long side is compared then. The
// ratio test uses the 3-97% extents, the measured length the full extent.
function alignedSleeveMatch(p,sleeve,candidate,design,content) {
  if(!content.box)return null;
  const w=p.width,h=p.height,pixels=candidate.pixels,con=candidate.contrast,designRatio=content.box.w/content.box.h;
  let mx=0,my=0;for(const i of pixels){mx+=i%w;my+=Math.floor(i/w);}mx/=pixels.length;my/=pixels.length;
  let sxx=0,sxy=0,syy=0;for(const i of pixels){const dx=i%w-mx,dy=Math.floor(i/w)-my;sxx+=dx*dx;sxy+=dx*dy;syy+=dy*dy;}
  const b=candidate.box;let jxx=0,jxy=0,jyy=0;
  for(let y=Math.max(1,b.y);y<Math.min(h-1,b.y+b.h);y++)for(let x=Math.max(1,b.x);x<Math.min(w-1,b.x+b.w);x++){const i=y*w+x,gx=(con[i+1]-con[i-1])/2,gy=(con[i+w]-con[i-w])/2;jxx+=gx*gx;jxy+=gx*gy;jyy+=gy*gy;}
  let best=null;
  for(const theta of [.5*Math.atan2(2*sxy,sxx-syy),.5*Math.atan2(2*jxy,jxx-jyy)+Math.PI/2]) {
    const u={x:Math.cos(theta),y:Math.sin(theta)},v={x:-u.y,y:u.x};
    const along=[],across=[];for(const i of pixels){const dx=i%w-mx,dy=Math.floor(i/w)-my;along.push(dx*u.x+dy*u.y);across.push(dx*v.x+dy*v.y);}
    along.sort((a,c)=>a-c);across.sort((a,c)=>a-c);
    const a0=along[0],c0=across[0],W=Math.round(along.at(-1)-a0)+1,H=Math.round(across.at(-1)-c0)+1;
    const q=(list,f)=>list[Math.floor(list.length*f)],W94=q(along,.97)-q(along,.03),H94=q(across,.97)-q(across,.03);
    if(!(W94>0&&H94>0))continue;
    const frame=new Uint8Array(W*H);
    for(let y=0;y<H;y++)for(let x=0;x<W;x++){const ix=Math.round(mx+(a0+x)*u.x+(c0+y)*v.x),iy=Math.round(my+(a0+x)*u.y+(c0+y)*v.y);if(ix>=0&&iy>=0&&ix<w&&iy<h)frame[y*W+x]=candidate.mask[iy*w+ix];}
    for(const turn of [0,1,2,3]) {
      const tw=turn%2?H:W,th=turn%2?W:H,ratio=turn%2?H94/W94:W94/H94;
      if(!ratioMatches(ratio,[designRatio]))continue;
      const m=new Uint8Array(tw*th);
      for(let y=0;y<H;y++)for(let x=0;x<W;x++)if(frame[y*W+x]){const [xx,yy]=turn===0?[x,y]:turn===1?[y,W-1-x]:turn===2?[W-1-x,H-1-y]:[H-1-y,x];m[yy*tw+xx]=1;}
      const box={x:0,y:0,w:tw,h:th},rows=th>tw,n=Math.max(8,Math.min(32,rows?th:tw));
      const confidence=Math.max(0,Math.min(tw,th)>=16?layoutScore(m,tw,box,design,content):correlation(profileOf(m,tw,box,n,rows),profileOf(content.mask,design.width,content.box,n,rows)));
      // Within ±12° of the sleeve axis (or of its right-angle turns) the
      // established G39c/G39d match decides; this path only covers prints the
      // classic search cannot reach (EXE: 15° outside it).
      const offset=Math.abs((theta-Math.atan2(sleeve.u.y,sleeve.u.x))*180/Math.PI)%90;
      if(Math.min(offset,90-offset)<=12)continue;
      if(!best||confidence>best.confidence)
        best={confidence,rotation:turn,measuredAxis:turn%2?'boy':'en',designRatio,axis:u,axisOffsetDegrees:Math.round((theta-Math.atan2(sleeve.u.y,sleeve.u.x))*180/Math.PI),
          // Length is the full extent; the across side follows the robust
          // ratio, so a pixel of turning anti-aliasing does not read as shape.
          projected:{...candidate,alongPx:W,acrossPx:W*H94/W94},aligned:true,frame:{u,v}};
    }
  }
  if(best) {
    // G55: the aspect measureSleeve tests follows the blur- and shear-
    // corrected ratio when the blur estimate is reliable; the length stays
    // the full extent along the sleeve.
    const {u,v}=best.frame;
    const pts=Array.from(pixels,i=>{const dx=i%w-mx,dy=Math.floor(i/w)-my;return [dx*u.x+dy*u.y,dx*v.x+dy*v.y];});
    const aspect=blurAwareAspect(p,candidate,u,v,{x:mx,y:my},pts);
    best.blur={spread:aspect.spread,edges:aspect.edges,iqr:aspect.iqr,shear:Math.round(aspect.shear*1000)/1000,reliable:aspect.reliable};
    if(aspect.reliable) {
      // Frame ratio is along/across for rotation 0/2; a turned design reads across/along.
      const frameRatio=best.rotation%2?1/aspect.ratio:aspect.ratio;
      best.projected={...best.projected,acrossPx:best.projected.alongPx/(best.measuredAxis==='boy'?1/frameRatio:frameRatio)};
    }
  }
  return best;
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
  // Grouped (G47d) candidates go only through the aligned path below; the
  // established ±12° match keeps its own candidates and decisions.
  if(candidate.grouped)return alignedSleeveMatch(p,sleeve,candidate,design,content);
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
  const measurements=bodyPoints.points(flat).cm;
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
      if(match.blur)source.bulaniklik=match.blur;
      if(!ambiguous&&match.confidence>=threshold) {
        const measured=measureSleeve({alongPx:candidate.alongPx,acrossPx:candidate.acrossPx,designRatio:match.designRatio,measuredAxis:match.measuredAxis,mmPerPx:source.mmPerPx});
        source.aspectRatioError=measured.aspectRatioError;
        reasons.push(...measured.reasons);width=measured.width_mm;height=measured.height_mm;
        // The correction was needed and could not be made (G55).
        if(match.aligned&&match.blur&&!match.blur.reliable&&measured.aspectRatioError>.10)
          reasons.push(`Kol baskısının bulanıklığı görselden güvenilir ölçülemedi (${match.blur.edges} kenar${match.blur.spread!=null?`, yayılma ${match.blur.spread} px, çeyrekler arası ${match.blur.iqr} px`:''}); en-boy oranı düzeltilemedi.`);
        // The workshop reads a sleeve print's "en" along the sleeve; say which design axis that is.
        source.enEkseni=match.measuredAxis==='en'?'kol boyunca (desenin eni)':'kola dik (desenin boyu kol boyunca)';
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
  const measurements=bodyPoints.points(flat).cm;
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

// G61: the eye says where the whole print is; the edges come from the ink inside
// that box. Pixels off the garment colour within the box (grown by 4%) bound the
// print; a fit that keeps less than 60% or grows past 110% of the eye's box on
// either axis is not trusted and the eye's box stays.
const GOZ_INK=60, GOZ_PAD=.04;
// Ink pixels inside the eye's box (grown by GOZ_PAD) that differ from the garment colour.
function inkPixels(p,box,garment) {
  const px=Math.max(2,box.w*GOZ_PAD),py=Math.max(2,box.h*GOZ_PAD),out=[];
  const x0=Math.max(0,Math.floor(box.x-px)),y0=Math.max(0,Math.floor(box.y-py)),x1=Math.min(p.width,Math.ceil(box.x+box.w+px)),y1=Math.min(p.height,Math.ceil(box.y+box.h+py));
  for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++) {
    const i=(y*p.width+x)*4;
    if(p.data[i+3]>=64&&distance([p.data[i],p.data[i+1],p.data[i+2]],garment)>GOZ_INK)out.push(x,y);
  }
  return out;
}
// The garment colour around a box: a ring 4-20% outside it (no product mask needed).
function ringColour(p,box) {
  const grow=(k)=>({x0:Math.max(0,Math.floor(box.x-box.w*k)),y0:Math.max(0,Math.floor(box.y-box.h*k)),x1:Math.min(p.width,Math.ceil(box.x+box.w*(1+k))),y1:Math.min(p.height,Math.ceil(box.y+box.h*(1+k)))});
  const outer=grow(.2),inner=grow(.04),idx=[];
  for(let y=outer.y0;y<outer.y1;y++)for(let x=outer.x0;x<outer.x1;x++)if(x<inner.x0||x>=inner.x1||y<inner.y0||y>=inner.y1)idx.push(y*p.width+x);
  return dominant(p,idx);
}
function fitInkWith(p,box,garment) {
  const ink=inkPixels(p,box,garment),n=ink.length/2;
  let minX=Infinity,minY=Infinity,maxX=-1,maxY=-1;
  for(let k=0;k<ink.length;k+=2){const x=ink[k],y=ink[k+1];if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y;}
  const fitted=n?{x:minX,y:minY,w:maxX-minX+1,h:maxY-minY+1}:null;
  const kept=fitted&&[fitted.w/box.w,fitted.h/box.h].every(k=>k>=.6&&k<=1.1)&&n>=box.w*box.h*.005;
  return kept?{...fitted,fit:'murekkep'}:{x:box.x,y:box.y,w:box.w,h:box.h,fit:'goz'};
}
function fitInk(p,ref,box) {return fitInkWith(p,box,dominant(p,Array.from(ref.mask.keys()).filter(i=>ref.mask[i])));}
// G61b: scale from the eye's garment points and the pattern's known widths (cm, L).
// Shoulder and hem width are the scale; the chest (armpit to armpit) counts only when one of
// them is missing: on a photo the hanging sleeves hide the armpits and the chest reads narrow
// (G61b evaluation, 6 photos: chest 7-35 points worse than shoulder or hem every time).
// Shoulder and hem more than 12% apart: their mean, marked approximate. With one of them the
// chest joins: the median, or the most consistent pair when they disagree (approximate).
// Height alone (collar to hem) is never a scale (G61: TAYF %69).
const POINT_SPREAD=.12;
function pointScale(pts,cm,W,H) {
  const d=(a,b)=>pts?.[a]&&pts?.[b]?Math.hypot((pts[a].x-pts[b].x)*W,(pts[a].y-pts[b].y)*H):null;
  const all=[['omuz',d('omuz_sol','omuz_sag')],['gogus',d('koltuk_sol','koltuk_sag')],['etek',d('etek_sol','etek_sag')]]
    .filter(([k,px])=>px>4&&Number.isFinite(cm[k])&&cm[k]>0).map(([k,px])=>({k,px:Math.round(px*10)/10,mmPerPx:cm[k]*10/px}));
  if(!all.length)return {reason:pts?.yaka&&(pts.etek_sol||pts.etek_sag)?'Yalnız boy noktaları var; tek eksenli ölçek kullanılmaz.':'Gözün noktalarında kalıbın bilinen bir eniyle eşleşen ölçü yok.'};
  const off=(a,b)=>Math.abs(a.mmPerPx-b.mmPerPx)/((a.mmPerPx+b.mmPerPx)/2);
  const primary=all.filter(c=>c.k!=='gogus');
  if(primary.length===2) {
    const apart=off(primary[0],primary[1]);
    return {mmPerPx:(primary[0].mmPerPx+primary[1].mmPerPx)/2,adaylar:all,secilen:['omuz','etek'],
      ...(apart>POINT_SPREAD?{yaklasik:`Omuz ve etek ölçekleri %${Math.round(apart*100)} ayrışıyor; ortalamaları alındı.`}:{})};
  }
  if(all.length===1)return {mmPerPx:all[0].mmPerPx,adaylar:all,yaklasik:`Ölçek tek yatay adaydan (${all[0].k}).`};
  const values=all.map(c=>c.mmPerPx).sort((a,b)=>a-b),mid=values.length>>1,median=values.length%2?values[mid]:(values[mid-1]+values[mid])/2;
  if((values.at(-1)-values[0])/median<=POINT_SPREAD)return {mmPerPx:median,adaylar:all};
  let best=null;
  for(let i=0;i<all.length;i++)for(let j=i+1;j<all.length;j++)if(!best||off(all[i],all[j])<best.off)best={off:off(all[i],all[j]),pair:[all[i],all[j]]};
  return {mmPerPx:(best.pair[0].mmPerPx+best.pair[1].mmPerPx)/2,adaylar:all,secilen:best.pair.map(c=>c.k),
    yaklasik:`Ölçek adayları ayrışıyor; en tutarlı ikili (${best.pair.map(c=>c.k).join(' ve ')}) alındı.`};
}
// goz: {print:{box (0..1 of the picture), pairing?}, product:{box, points?}|null} chosen by the parent for this print.
function gozMeasure(p,refs,goz,measurements,scalePair,calK) {
  const px=b=>({x:b.x*p.width,y:b.y*p.height,w:b.w*p.width,h:b.h*p.height});
  const box=px(goz.print.box),product=goz.product?.box?px(goz.product.box):null;
  const centre={x:box.x+box.w/2,y:box.y+box.h/2},inside=r=>centre.x>=r.box.x&&centre.x<=r.box.x+r.box.w&&centre.y>=r.box.y&&centre.y<=r.box.y+r.box.h;
  const ranked=refs.slice().sort((a,b)=>(product?overlapFraction(b.box,product)-overlapFraction(a.box,product):0)||(inside(b)-inside(a)));
  const ref=ranked.find(r=>product?overlapFraction(r.box,product)>.3:inside(r));
  const out={gozBoxPx:box,rasterWidth:p.width,rasterHeight:p.height,confidence:goz.print.confidence??null,...(goz.print.pairing?{pairing:goz.print.pairing}:{})};
  const fitted=ref?fitInk(p,ref,box):fitInkWith(p,box,ringColour(p,box));
  const points=goz.product?.points?pointScale(goz.product.points,measurements,p.width,p.height):null;
  if(points?.mmPerPx)
    return {...out,boxPx:fitted,...(ref?{productIndex:refs.indexOf(ref)}:{}),olcek:'noktalar',olcekAdaylari:points.adaylar,...(points.yaklasik?{olcekYaklasik:points.yaklasik}:{}),
      mmPerPx:points.mmPerPx,width_mm:Math.round(fitted.w*points.mmPerPx),height_mm:Math.round(fitted.h*points.mmPerPx)};
  if(!ref)return {...out,boxPx:box,reason:points?.reason||'Gözün gösterdiği ürün piksel maskesinde bulunamadı; ölçek için ürün eni bilinmiyor.'};
  const scale=scaleFor(ref,measurements,scalePair,p,calK);
  out.boxPx=fitted;out.productIndex=refs.indexOf(ref);
  if(!(scale.mean>0))return {...out,reason:points?.reason||'Göz kutusu var, ama ürünün L ölçeği doğrulanamadı; ölçek yok.'};
  return {...out,mmPerPx:scale.mean,width_mm:Math.round(fitted.w*scale.mean),height_mm:Math.round(fitted.h*scale.mean)};
}
// G61b: a sleeve or leg print measured on its own axis. Axis = the eye's shoulder end -> cuff
// (leg: waist side -> leg opening) nearest to the print; scale = pattern sleeve length (leg:
// yan_boy) over that axis in pixels, or the body scale (approximate). The ink inside the eye's
// box is projected on the axis: "en" runs along the arm (workshop rule, G47/G55), "boy" across.
function gozLimbMeasure(p,goz,position,measurements) {
  const pts=goz.product?.points||{},W=p.width,H=p.height,P=k=>pts[k]&&{x:pts[k].x*W,y:pts[k].y*H};
  const box={x:goz.print.box.x*W,y:goz.print.box.y*H,w:goz.print.box.w*W,h:goz.print.box.h*H},c={x:box.x+box.w/2,y:box.y+box.h/2};
  const leg=LEGS.includes(position);
  const sides=(leg?[['sol','bel_sol','paca_sol'],['sag','bel_sag','paca_sag']]:[['sol','kol_sol_omuz','kol_sol_agiz'],['sag','kol_sag_omuz','kol_sag_agiz']])
    .map(([side,a,b])=>({side,a:P(a),b:P(b)})).filter(x=>x.a&&x.b&&Math.hypot(x.b.x-x.a.x,x.b.y-x.a.y)>8);
  const out={gozBoxPx:box,rasterWidth:W,rasterHeight:H,confidence:goz.print.confidence??null,...(goz.print.pairing?{pairing:goz.print.pairing}:{})};
  if(!sides.length)return {...out,reason:`Göz ${leg?'bacak':'kol'} ekseninin noktalarını vermedi; ${leg?'bacak':'kol'} baskısı eski yoldan.`};
  const segment=x=>{const vx=x.b.x-x.a.x,vy=x.b.y-x.a.y,t=Math.max(0,Math.min(1,((c.x-x.a.x)*vx+(c.y-x.a.y)*vy)/(vx*vx+vy*vy)));return Math.hypot(x.a.x+t*vx-c.x,x.a.y+t*vy-c.y);};
  const axis=sides.sort((m,n)=>segment(m)-segment(n))[0],len=Math.hypot(axis.b.x-axis.a.x,axis.b.y-axis.a.y);
  const u={x:(axis.b.x-axis.a.x)/len,y:(axis.b.y-axis.a.y)/len},v={x:-u.y,y:u.x};
  const limbCm=leg?measurements.yan_boy:measurements.kol_boyu;
  let k=null,olcek=null,olcekYaklasik=null;
  if(Number.isFinite(limbCm)&&limbCm>0){k=limbCm*10/len;olcek=leg?'yan_boy':'kol_boyu';}
  else {
    const body=pointScale(pts,measurements,W,H);
    if(body.mmPerPx){k=body.mmPerPx;olcek='noktalar';olcekYaklasik=`Kalıpta ${leg?'yan boy':'kol boyu'} yok; gövde ölçeği kullanıldı.`;}
    else return {...out,reason:`Kalıpta ${leg?'yan boy':'kol boyu'} yok ve gövde ölçeği kurulamadı.`};
  }
  const ink=inkPixels(p,box,ringColour(p,box)),n=ink.length/2;
  const corners=[[box.x,box.y],[box.x+box.w,box.y],[box.x,box.y+box.h],[box.x+box.w,box.y+box.h]].flat();
  const use=n>=box.w*box.h*.005?ink:corners;
  let a0=Infinity,a1=-Infinity,b0=Infinity,b1=-Infinity;
  for(let i=0;i<use.length;i+=2){const along=use[i]*u.x+use[i+1]*u.y,across=use[i]*v.x+use[i+1]*v.y;if(along<a0)a0=along;if(along>a1)a1=along;if(across<b0)b0=across;if(across>b1)b1=across;}
  const alongPx=a1-a0+1,acrossPx=b1-b0+1;
  return {...out,eksen:{taraf:axis.side,basPx:axis.a,sonPx:axis.b,uzunlukPx:Math.round(len)},olcek,...(olcekYaklasik?{olcekYaklasik}:{}),fit:use===ink?'murekkep':'goz',
    mmPerPx:k,boyuncaPx:Math.round(alongPx),dikPx:Math.round(acrossPx),width_mm:Math.round(alongPx*k),height_mm:Math.round(acrossPx*k)};
}
async function gozLimb({image,design,flat,position,goz}) {
  const base={method:'otomatik',flatId:flat?.id??null,flatAd:flat?.ad??null,refBeden:flat?.refBeden??null,gorselFileId:image?.id??null,desenFileId:design?.id??null,selectedView:image?.gorunum||'on'};
  try {
    const [p]=await rasterPages(image,1600,image.mime==='application/pdf'?[1]:null);
    const m=gozLimbMeasure(p,goz,position,bodyPoints.points(flat).cm);
    return m.width_mm>0?{width_mm:null,height_mm:null,needs_confirmation:false,reasons:[],reason:'',measure_source:{...base,goz:m}}:{reason:m.reason};
  } catch(e) {return {reason:`Göz kol/bacak ölçüsü okunamadı: ${e.message}`};}
}
async function autoMeasure({image,design,flat,product,position,color,viewHint=null,viewDefault=false,goz=null}) {
  if(['kol','sol_kol','sag_kol'].includes(position)||LEGS.includes(position)) {
    // G61b: with the eye's points a sleeve/leg print is measured on its own axis; otherwise as before.
    const eye=goz?.print?.box&&goz.product?.points?await gozLimb({image,design,flat,position,goz}):null;
    if(eye?.measure_source)return eye;
    const old=LEGS.includes(position)?await autoMeasureLeg({image,design,flat,product,position}):await autoMeasureSleeve({image,design,flat,product,position});
    const why=eye?.reason||goz?.reason||null;
    if(goz?.baskiYok||why)old.measure_source={...old.measure_source,goz:{...(goz?.baskiYok?{baskiYok:goz.baskiYok}:{}),...(why?{reason:why}:{})}};
    return old;
  }
  const scalePair=scalePairFor(flat,product),pairLabel=scalePair==='boy_gogus'?'boy/göğüs':'boy/etek',horizontalLabel=scalePair==='boy_gogus'?'göğüs':'etek';
  const started=performance.now(),timings={},reasons=[],source={scalePair,method:'otomatik',flatId:flat?.id??null,flatAd:flat?.ad??null,refBeden:flat?.refBeden??null,refCm:flat?.refLengthCm??null,olculerL:flat?.olculerL??null,chestPx:null,designBoxPx:null,scale:null,mmPerPx:null,confidence:0,gorselFileId:image?.id??null,desenFileId:design?.id??null};
  if(viewHint)source.viewHint=viewHint;
  let width=null,height=null;
  const positive=n=>Number.isFinite(n)&&n>0;
  const measurements=bodyPoints.points(flat).cm;
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
    const tallBack=position==='sirt'&&!design,upper=['gogus','sol_gogus','sag_gogus','sirt'];
    let designs=[];const pageRefs=[];
    if(design)try {designs=await rasterPages(design,1000,null,{transparent:true});}catch(e){source.designReadError=e.message;}
    const designContents=designs.map(p=>designContent(p,true));
    const designRatios=designContents.flatMap(({box},i)=>box?[{page:i+1,ratio:box.w/box.h}]:[]),ratios=contentRatios(designContents);
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
      // A pair of one garment is settled by the extraction cues. The linked
      // design found on exactly one garment adds a vote for the view of its
      // position; it can confirm or contradict, never decide alone.
      if(refs.length===2) {
        const matches=refs.map(ref=>colorDesign(pages[i],ref,tallBack,ratios));
        const carrying=matches.map(m=>!!m.box&&ratioMatches(m.box.w/m.box.h,ratios));
        const carrier=upper.includes(position)&&ratios.length&&carrying.filter(Boolean).length===1&&matches.every((m,k)=>carrying[k]||!m.box)?carrying.indexOf(true):-1;
        pairViews(pages[i],refs,cues,matches,[],carrier<0?null:viewForPosition(position)==='on'?carrier:1-carrier);
        if(carrier>=0)cues.forEach((c,k)=>{c.designCarrier=k===carrier;});
        if(i===0)applyViewHint(refs,cues,viewHint);
        if(viewDefault)applyViewHint(refs,cues,defaultViewHint(refs));
      }
      pageRefs[i]=refs;
      for(let k=0;k<refs.length;k++) {
        const ref=refs[k],cue=cues[k],scale=scaleFor(ref,measurements,scalePair,pages[i],calK);
        allViews.push({page:i+1,index:k,view:cue.view,garmentColor:garmentColor(dominant(pages[i],Array.from(ref.mask.keys()).filter(j=>ref.mask[j]))),hooded:cue.hooded,viewEvidence:{lining:cue.lining,cords:cue.cords,...(cue.neckDepth!==undefined?{neckDepth:cue.neckDepth}:{}),...(cue.pairVotes?{pairVotes:cue.pairVotes}:{}),...(cue.viewConflict?{viewConflict:cue.viewConflict}:{}),...(cue.viewSource?{viewSource:cue.viewSource}:{}),...(cue.designCarrier!==undefined?{designCarrier:cue.designCarrier}:{})},maskMethod:ref.maskMethod,...(ref.splitMethod?{splitMethod:ref.splitMethod}:{}),productBoxPx:ref.box,shoulderY:ref.shoulderY,hemY:ref.hemY,hemWidthPx:ref.hemWidthPx,chestLinePx:ref.chestLine??null,bodyHeightPx:ref.bodyHeightPx,...scale});
        if(cue.view!=='teyit'&&cue.view!==viewForPosition(position))continue;
        if(refs.length>1&&cue.view==='teyit'&&!designs.length)continue;
        if(designs.length)for(let j=0;j<designs.length;j++) {
          const match=matchDesign(pages[i],designs[j],designContents[j],ref,false);
          if(match.box)candidates.push({p:pages[i],ref,match,page:i+1,designPage:j+1,index:k});
          const group=groupDesign(pages[i],ref,designs[j],designContents[j]);
          if(group.box)candidates.push({p:pages[i],ref,match:group,page:i+1,designPage:j+1,index:k});
        }
        // Also retain the color hypothesis: refinement may reject the template.
        // Unknown sheet products need the supplied design. An independently
        // identified front/back view keeps the established color fallback.
        const match=(!designs.length||refs.length===1||cue.view!=='teyit')&&upper.includes(position)?colorDesign(pages[i],ref,tallBack,ratios):{box:null};
        if(match.box)candidates.push({p:pages[i],ref,match,page:i+1,designPage:null,index:k});
      }
    }
    source.views=allViews;
    if(designRatios.length)source.designContentRatio=designRatios[0].ratio;
    if(goz?.print?.box&&pages[0]&&pageRefs[0])source.goz=gozMeasure(pages[0],pageRefs[0],goz,measurements,scalePair,calK);
    else if(goz?.baskiYok||goz?.urunYok||goz?.reason)source.goz={...(goz.baskiYok?{baskiYok:goz.baskiYok}:{}),...(goz.urunYok?{urunYok:goz.urunYok}:{}),...(goz.reason?{reason:goz.reason}:{})};
    // The line colour does not pick a garment here; a colour no garment shows
    // is worth knowing (the fabric may be wrong) but does not block the size.
    const lineColor=named(color,COLOR_WORDS);
    if(lineColor.length===1&&allViews.length&&!allViews.some(v=>v.garmentColor===lineColor[0]))source.colorNote=colorMismatch(color);

    const unknownViews=allViews.filter(v=>allViews.filter(q=>q.page===v.page).length>1&&v.view==='teyit');
    const conflict=unknownViews.find(v=>v.viewEvidence.viewConflict)?.viewEvidence.viewConflict;
    const unknownViewReason=()=>`Ürün görünümü eşleştirme güveni düşük: ${unknownViews.length} görünüm ayrılamadı; görünüm teyit edilmeli.`+
      (conflict?` Kanıtlar çelişiyor: ${conflict}.`:' Ön/arka kanıtı (kapüşon, yaka, etiket, ense işareti, desen konumu) bulunamadı.');
    // A strong template takes precedence over the independent color fallback.
    candidates.sort((a,b)=>(!!b.designPage-!!a.designPage)||b.match.confidence-a.match.confidence);
    source.pageCandidates=candidates.slice(0,5).map(c=>({page:c.page,productIndex:c.index,designPage:c.designPage,confidence:Math.round(c.match.confidence*1000)/1000}));
    timings.scan=performance.now()-started-timings.raster;
    let finalists=[...candidates.filter(c=>c.designPage&&!c.match.group).slice(0,3),...candidates.filter(c=>c.match.group).slice(0,3),...candidates.filter(c=>!c.designPage).slice(0,3)];
    // Every product on a sheet needs a refined template hypothesis; otherwise
    // a fourth repeated print could be discarded before the ambiguity check.
    const represented=new Set(finalists.filter(c=>c.designPage).map(c=>`${c.page}:${c.index}`));
    for(const c of candidates.filter(c=>c.designPage&&!c.match.group&&allViews.filter(v=>v.page===c.page).length>1)) {
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
    const refined=finalists.map(candidate=>({...candidate,match:candidate.match.group?groupDesign(candidate.p,candidate.ref,designs[candidate.designPage-1],designContents[candidate.designPage-1]):candidate.designPage?matchDesign(candidate.p,designs[candidate.designPage-1],designContents[candidate.designPage-1],candidate.ref,true,candidate.match):colorDesign(candidate.p,candidate.ref,tallBack,ratios)}));
    timings.refine=performance.now()-started-timings.raster-timings.scan;
    refined.sort((a,b)=>((!!b.designPage&&b.match.confidence>=.78?1:0)-(!!a.designPage&&a.match.confidence>=.78?1:0))||b.match.confidence-a.match.confidence);
    const chosen=refined[0];
    if(!chosen) {
      if(unknownViews.length)reasons.push(unknownViewReason());
      if(!allViews.length&&pages.length)reasons.push(...paleGroundReason(pages[0]));
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
      // Conflicting view cues are never overridden by a design match: the
      // design may sit on the garment the other cues call the back (G47b).
      const viewConflict=unknownViews.some(v=>v.page===page&&v.viewEvidence.viewConflict);
      if(unknownViews.some(v=>v.page===page && (v.splitMethod || !templateSelectsProduct || v.viewEvidence.viewConflict)))reasons.push(unknownViewReason());
      source.productSelection=templateSelectsProduct?'desen':'gorunum';
      // A tee has no collar rising well above the shoulders (mockups: 8-12% of
      // the body height; a half-zip stand collar 16-17%, hoods more). Its L
      // table on such a garment sized a chest logo 20% large (G47). Teyit only.
      if(String(product??'').trim().toLowerCase()==='tisort'&&(ref.shoulderY-ref.box.y)/ref.bodyHeightPx>=.15)
        reasons.push('Satır ürünü tişört, görseldeki ürünün yakası omuzdan yükseliyor (dik yaka, fermuar veya kapüşon); ürünü ve kalıbı kontrol edin.');
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
      if(designPage&&designRatios.some(d=>d.page===designPage))source.designContentRatio=designRatios.find(d=>d.page===designPage).ratio;
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
      else if(!placementAmbiguous && colorAspectVerified && !viewConflict) {
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
  const w=p.width,h=p.height,d=p.data,cx=ref.bodyCenterX??(ref.box.x+ref.box.w/2);
  // Cords hang below the collar of a front; only a part that is not a long
  // vertical strand may sit that high, and a back has none.
  const top=Math.max(0,Math.ceil(ref.shoulderY+ref.bodyHeightPx*.04)),cordFree=Math.ceil(ref.shoulderY+ref.bodyHeightPx*.14);
  // A back print may run down to the ribbed hem band.
  const bottom=Math.min(h,Math.floor(ref.shoulderY+ref.bodyHeightPx*(tallBack?.9:.62)));
  // A wide back print can pass the width of a ribbed hem; side seams at the
  // garment outline stay out because ink there touches the mask edge.
  const reach=tallBack?.55:.48,margin=Math.max(3,Math.round(ref.hemWidthPx*.02));
  const left=Math.max(0,Math.ceil(cx-ref.hemWidthPx*reach)),right=Math.min(w,Math.floor(cx+ref.hemWidthPx*reach));
  const all=contrastInk(p,ref),ink=new Uint8Array(w*h);
  const inside=i=>ref.mask[i-margin]&&ref.mask[i+margin]&&ref.mask[i-margin*w]&&ref.mask[i+margin*w];
  for(let y=top;y<bottom;y++)for(let x=left;x<right;x++) {const i=y*w+x;ink[i]=all[i]&&inside(i)?1:0;}
  const garment=dominant(p,Array.from(ref.mask.keys()).filter(i=>ref.mask[i]));
  const far=i=>Math.max(Math.abs(d[i*4]-garment[0]),Math.abs(d[i*4+1]-garment[1]),Math.abs(d[i*4+2]-garment[2]));
  // Ink colours of the detected print; a joined part must share one of them
  // (a gold zipper or a label of another colour is not part of a white print).
  const buckets=new Map();let total=0;
  for(let y=box.y;y<box.y+box.h;y++)for(let x=box.x;x<box.x+box.w;x++) {
    const i=y*w+x;if(!all[i])continue;
    const key=(d[i*4]>>6)*16+(d[i*4+1]>>6)*4+(d[i*4+2]>>6),b=buckets.get(key)||{n:0,rgb:[0,0,0]};
    b.n++;for(let k=0;k<3;k++)b.rgb[k]+=d[i*4+k];buckets.set(key,b);total++;
  }
  // Main inks only: edge blends spread over many small buckets.
  const palette=[...buckets.values()].filter(b=>b.n>=total*.15).map(b=>b.rgb.map(v=>v/b.n));
  const inkColor=c=> {
    let best=c.pixels[0];for(const i of c.pixels)if(far(i)>far(best))best=i;
    return palette.some(rgb=>Math.max(...rgb.map((v,k)=>Math.abs(v-d[best*4+k])))<=70);
  };
  const parts=components(ink,w,h,2).filter(c=>c.box.x>left&&c.box.y>top&&c.box.x+c.box.w<right&&c.box.y+c.box.h<bottom&&
    (tallBack||c.box.y>=cordFree||c.box.h<c.box.w*3));
  // On a front, what hangs above a print is a zipper pull, cord end or collar
  // detail unless it lies flat like a line of text.
  let b={...box},grown=true;
  while(grown) {
    grown=false;
    const gap=Math.max(2,Math.round(Math.min(b.w,b.h)*.2));
    for(const c of parts) {
      const q=c.box;
      if(c.joined||q.x>b.x+b.w+gap||q.x+q.w<b.x-gap||q.y>b.y+b.h+gap||q.y+q.h<b.y-gap||!inkColor(c))continue;
      if(!tallBack&&q.y+q.h<=b.y&&q.w<q.h)continue;
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
  // Saturated bright cloth (red) has a low mean but is not dark cloth.
  if(level>128||Math.max(...garment)>160)return null;
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
// Colour and product words, as written on order lines and mockup sheets.
const foldText=value=>String(value??'').toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/ı/g,'i');
// Letter-spaced headings ("S w e a t s h i r t") become words before matching.
const textWords=value=>foldText(value).replace(/\b([a-z0-9]) (?=[a-z0-9]\b)/g,'$1').replace(/-/g,'').split(/[^a-z0-9]+/).filter(Boolean);
const COLOR_WORDS={beyaz:'beyaz',white:'beyaz',krem:'krem',ekru:'krem',siyah:'siyah',black:'siyah',antrasit:'gri',gri:'gri',fume:'gri',grey:'gri',gray:'gri',
  lacivert:'lacivert',navy:'lacivert',bordo:'bordo',maroon:'bordo',burgundy:'bordo',kirmizi:'kirmizi',red:'kirmizi',mavi:'mavi',saks:'mavi',blue:'mavi',
  yesil:'yesil',green:'yesil',haki:'yesil',sari:'sari',yellow:'sari',turuncu:'turuncu',orange:'turuncu',mor:'mor',purple:'mor',pembe:'pembe',pink:'pembe'};
const PRODUCT_WORDS={tshirt:'tisort',shirt:'tisort',tisort:'tisort',sweatshirt:'sweat',sweat:'sweat',hoodie:'sweat',kapusonlu:'sweat',sort:'sort',short:'sort',shorts:'sort',
  bornoz:'bornoz',bone:'bone',esofman:'esofman',jogger:'esofman'};
const LINE_PRODUCTS={tisort:'tisort',sweat:'sweat',sweatshirt:'sweat',hoodie:'sweat',kapusonlu:'sweat',polar:'sweat',tam_fermuar:'sweat',sort:'sort',esofman:'esofman'};
const named=(text,table)=>[...new Set(textWords(text).map(w=>table[w]).filter(Boolean))];
const colorMismatch=color=>`Satır rengi (${String(color).trim()}) görseldeki ürün rengiyle uyuşmuyor`;
// Garment colour family from its dominant RGB; null where no family is clear.
function garmentColor([r,g,b]) {
  const max=Math.max(r,g,b),min=Math.min(r,g,b),v=max/255,s=max?(max-min)/max:0;
  if(s<.18)return v>.8?'beyaz':v<.25?'siyah':'gri';
  let hue=max===r?((g-b)/(max-min))*60:max===g?(2+(b-r)/(max-min))*60:(4+(r-g)/(max-min))*60;
  if(hue<0)hue+=360;
  if(s<.3&&v>.75&&hue>=20&&hue<70)return 'krem';
  if(hue<15||hue>=340)return v<.6?'bordo':'kirmizi';
  if(hue<40)return 'turuncu';
  if(hue<70)return 'sari';
  if(hue<170)return 'yesil';
  if(hue<260)return v<.55?'lacivert':'mavi';
  return hue<300?'mor':'pembe';
}
// Text of each PDF page with item positions in the raster used for extraction.
async function pdfText(image,maxEdge,selectedPages) {
  const pdf=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task=pdf.getDocument({data:Uint8Array.from(image.buffer),isEvalSupported:false,useSystemFonts:true,verbosity:0});
  let doc;
  try {
    doc=await task.promise;const pages=[];
    for(let n=1;n<=doc.numPages;n++) {
      if(!selectedPages.includes(n))continue;
      const page=await doc.getPage(n),raw=page.getViewport({scale:1});
      const viewport=page.getViewport({scale:Math.min(2,maxEdge/Math.max(raw.width,raw.height))});
      const items=(await page.getTextContent()).items.filter(item=>item.str?.trim()).map(item=> {
        const [x,y]=viewport.convertToViewportPoint(item.transform[4],item.transform[5]);
        return {text:item.str,x,y};
      });
      pages.push({text:items.map(item=>item.text).join(' '),items});
      page.cleanup();
    }
    return pages;
  } finally {if(doc)await doc.destroy();else await task.destroy();}
}
// A printed "ÖN"/"ARKA" caption belongs to the nearest garment when it sits
// just above or below it and no other garment is as close.
function captionViews(items,refs) {
  const views=refs.map(()=>null);
  for(const item of items||[]) {
    const words=textWords(item.text).join(' ');
    const view=/^(on|front)( (gorunus|gorunum|yuz|view))?$/.test(words)?'on':/^(arka|back)( (gorunus|gorunum|yuz|view))?$/.test(words)?'arka':null;
    if(!view)continue;
    const gaps=refs.map(ref=> {
      const b=ref.box,dx=Math.max(0,b.x-item.x,item.x-b.x-b.w),dy=Math.max(0,b.y-item.y,item.y-b.y-b.h);
      return dx>0?Infinity:dy/ref.bodyHeightPx;
    });
    const best=gaps.indexOf(Math.min(...gaps)),heading=item.y<=refs[best].box.y;
    // A caption is a heading: just above its garment, it wins a close call
    // against the garment it trails; otherwise the nearer must be clearly nearer.
    if(gaps[best]>.35||gaps.some((g,k)=>k!==best&&g<=gaps[best]*(heading&&item.y>=refs[k].box.y+refs[k].box.h?1:2)))continue;
    if(views[best]&&views[best]!==view)views[best]='celiski';else views[best]=view;
  }
  return views;
}
// A hood lining shows as two mirrored wedges of a lighter tone of the same
// cloth colour beside the opening; only a front shows it. Highlights on the
// back of a hood are one-sided or gradual and do not pair up.
function liningPair(p,ref) {
  const w=p.width,h=p.height,d=p.data,cx=ref.bodyCenterX??(ref.box.x+ref.box.w/2);
  const f=dominant(p,Array.from(ref.mask.keys()).filter(i=>ref.mask[i])),norm=f[0]**2+f[1]**2+f[2]**2;
  if(norm<300)return false;
  const lighter=new Uint8Array(w*h);
  for(let y=Math.max(0,ref.box.y);y<ref.shoulderY;y++)
    for(let x=Math.max(0,Math.ceil(cx-ref.hemWidthPx*.35));x<Math.min(w,cx+ref.hemWidthPx*.35);x++) {
      const i=y*w+x;
      if(!ref.mask[i])continue;
      const c=[d[i*4],d[i*4+1],d[i*4+2]],s=(c[0]*f[0]+c[1]*f[1]+c[2]*f[2])/norm;
      if(s>=1.3&&s<=2.2&&Math.max(...c.map((v,k)=>Math.abs(v-s*f[k])))<=20)lighter[i]=1;
    }
  const parts=components(lighter,w,h,Math.max(6,ref.hemWidthPx*ref.bodyHeightPx*.001)).map(q=>({
    x:(q.box.x+q.box.w/2-cx)/ref.hemWidthPx,y:(q.box.y+q.box.h/2-ref.shoulderY)/ref.bodyHeightPx,area:q.area}));
  return parts.some(l=>l.x<-.05&&parts.some(r=>r.x>.05&&Math.abs(l.x+r.x)<=.06&&Math.abs(l.y-r.y)<=.05&&
    Math.max(l.area,r.area)<=2*Math.min(l.area,r.area)));
}
// Front and back of one garment shown side by side or one above the other.
function pairedGarments(a,b) {
  const height=Math.max(a.bodyHeightPx,b.bodyHeightPx),hem=Math.max(a.hemWidthPx,b.hemWidthPx);
  if(Math.abs(a.hemWidthPx-b.hemWidthPx)>hem*.12||Math.abs(a.bodyHeightPx-b.bodyHeightPx)>height*.12)return false;
  return comparableShirts(a,b)||Math.abs(a.bodyCenterX-b.bodyCenterX)<=hem*.08;
}
// A small mark on the centre line just under the collar (a neck label, an
// "ense" print) is only seen on a back.
function neckMark(p,ref) {
  const ink=contrastInk(p,ref),cx=ref.bodyCenterX??(ref.box.x+ref.box.w/2);
  return components(ink,p.width,p.height,3).some(c=>{
    const o=(c.box.x+c.box.w/2-cx)/ref.hemWidthPx,y=(c.box.y-ref.shoulderY)/ref.bodyHeightPx;
    return Math.abs(o)<.05&&y>=-.06&&y<=.05&&c.box.w<ref.hemWidthPx*.1&&c.box.h<ref.bodyHeightPx*.03;
  });
}
// Settle front/back of a pair of the same garment, shared by extraction and
// measurement (Patron, 21.11.2026: the system decides, the user is not asked).
// Every cue below is a vote for the front; agreeing votes decide, any
// disagreement leaves both views open with the conflicting cues named:
// - hood lining/cords or a deeper front neckline (productViewCues),
// - a printed label next to a garment ("ÖN", "ARKA"),
// - on dark cloth, the shadowed neck/hood opening or a mirrored hood lining,
// - a chest-side print, which only a front carries,
// - a small mark under the back collar (neck label or ense print),
// - the linked design found on one garment only: its application position
//   names that garment's side (chest → front, back → back).
function pairViews(p,refs,cues,matches,labels=[],linkedFront=null) {
  if(refs.length!==2||!pairedGarments(...refs))return;
  const votes=[];
  const front=cues.findIndex(c=>c.view==='on'),back=cues.findIndex(c=>c.view==='arka');
  // Hood evidence naming both garments a front contradicts itself: no vote.
  if(!cues.every(c=>c.view==='on')&&(front>=0||back>=0))
    votes.push({front:front>=0?front:1-back,cue:cues.some(c=>c.neckDepth!=null)?'yaka oyuğu':'kapüşon açıklığı/kordon'});
  if(labels.includes('celiski')){for(const c of cues){c.view='teyit';c.viewConflict='ÖN/ARKA etiketi çelişkili';}return;}
  const labelled=labels.findIndex(l=>l==='on'),labelledBack=labels.findIndex(l=>l==='arka');
  if(labelled>=0||labelledBack>=0) {
    if(labelled>=0&&labelledBack>=0&&labelled===labelledBack)return;
    votes.push({front:labelled>=0?labelled:1-labelledBack,cue:'ÖN/ARKA etiketi'});
  }
  const shade=refs.map(ref=>openingShade(p,ref));
  if(shade.every(s=>s!=null)) {
    const lining=refs.map(ref=>liningPair(p,ref));
    const shaded=refs.map((_,i)=>shade[i]>=.15||lining[i]),plain=refs.map((_,i)=>shade[i]<=.03&&!lining[i]);
    const index=shaded.findIndex(Boolean);
    if(index>=0&&!shaded[1-index]&&plain[1-index])votes.push({front:index,cue:'yaka içi gölgesi'});
    // Two closed hood backs: the hoods themselves say neither is a front.
    if(cues.every((c,i)=>c.hooded&&plain[i]&&!c.lining&&!c.cords)) {
      for(const c of cues){c.view='teyit';c.viewConflict='iki kapüşon da kapalı arka yüz gösteriyor';}
      return;
    }
  }
  {
    // A lone chest-side logo is a front's. The other garment must not carry
    // one too; none, a centred print or a composition of several prints (a
    // back, G47b TAYF) is fine.
    const lone=refs.map((ref,i)=>{
      const all=[matches[i],...(matches[i].others||[])].filter(m=>m.box);
      return !matches[i].ambiguous&&all.length===1&&Math.abs(all[0].box.x+all[0].box.w/2-ref.bodyCenterX)/ref.hemWidthPx>=.15;
    });
    const side=lone.indexOf(true);
    const centred=k=>!matches[k].box||matches[k].ambiguous||Math.abs(matches[k].box.x+matches[k].box.w/2-refs[k].bodyCenterX)/refs[k].hemWidthPx<.08;
    if(side>=0&&!lone[1-side]&&centred(1-side))votes.push({front:side,cue:'yan göğüs baskısı'});
  }
  const marks=refs.map(ref=>neckMark(p,ref));
  if(marks[0]!==marks[1])votes.push({front:marks.indexOf(false),cue:'ense etiketi/baskısı'});
  if(linkedFront!=null)votes.push({front:linkedFront,cue:'bağlı desenin konumu'});
  for(const c of cues)c.pairVotes=votes.map(v=>`${v.cue}: ${v.front+1}. ürün ön`);
  if(!votes.length)return;
  if(votes.some(v=>v.front!==votes[0].front)) {
    for(const c of cues){c.view='teyit';c.viewConflict=votes.map(v=>`${v.cue} ${v.front+1}. ürünü`).join(', ')+' ön gösteriyor';}
    return;
  }
  cues[votes[0].front].view='on';cues[1-votes[0].front].view='arka';
}
// G58: one front/back answer per picture. hint={front:'sol'|'sag'|'ust'|'alt',source}
// names the front garment by its place on the sheet: 'kullanici' (the user's
// answer) and 'olcum' (the measurement this extraction must follow) win;
// 'baska_baski' is what another print of the same picture found and only
// settles an undecided pair (a contradiction stays open).
// hint={conflict} carries a disagreement between prints: both views stay open.
const VIEW_SIDES=['sol','sag','ust','alt'];
// G61: with no evidence and no answer, two garments side by side are read as front on
// the left (stacked: front on top). Evidence that decided a view, an answer or the eye wins;
// conflicting cues fall back to the same layout and keep the conflict as a note.
function defaultViewHint(refs) {
  if(refs.length!==2)return null;
  const c=r=>({x:r.box.x+r.box.w/2,y:r.box.y+r.box.h/2}),[a,b]=refs.map(c);
  return {front:Math.abs(a.x-b.x)>=Math.abs(a.y-b.y)?'sol':'ust',source:'varsayilan'};
}
function applyViewHint(refs,cues,hint) {
  if(!hint||refs.length!==2)return;
  if(hint.conflict) {for(const c of cues){c.view='teyit';c.viewConflict=hint.conflict;c.viewSource='baska_baski';}return;}
  if(!VIEW_SIDES.includes(hint.front))return;
  const across=['sol','sag'].includes(hint.front),centre=r=>across?r.box.x+r.box.w/2:r.box.y+r.box.h/2,size=r=>across?r.box.w:r.box.h;
  const [a,b]=refs.map(centre);
  // Garments that do not sit apart along the named axis cannot be told apart by it.
  if(Math.abs(a-b)<Math.min(...refs.map(size))/2)return;
  const first=a<b?0:1,front=['sol','ust'].includes(hint.front)?first:1-first,label=`${front+1}. ürün ön`;
  if(hint.source==='varsayilan') {
    if(cues.some(c=>c.view==='on'))return;
    cues[front].view='on';cues[1-front].view='arka';
    for(const c of cues){if(c.viewConflict){c.viewConflictNote=c.viewConflict;delete c.viewConflict;}c.viewSource='varsayilan';c.pairVotes=[...(c.pairVotes||[]),`varsayılan dizilim: ${label}`];}
    return;
  }
  if(hint.source!=='baska_baski') {
    cues[front].view='on';cues[1-front].view='arka';
    for(const c of cues){delete c.viewConflict;c.viewSource=hint.source;c.pairVotes=[...(c.pairVotes||[]),`${hint.source==='kullanici'?'kullanıcı teyidi':hint.source==='goz'?'göz':'ölçümün görünümü'}: ${label}`];}
    return;
  }
  const decided=cues.findIndex(c=>c.view==='on');
  if(decided<0&&cues.every(c=>c.view==='teyit'&&!c.viewConflict)) {
    cues[front].view='on';cues[1-front].view='arka';
    for(const c of cues){c.viewSource='baska_baski';c.pairVotes=[...(c.pairVotes||[]),`aynı görselin başka baskısı: ${label}`];}
  } else if(decided>=0&&decided!==front) {
    for(const c of cues){c.view='teyit';c.viewSource='baska_baski';c.viewConflict=`bu baskı ${decided+1}. ürünü, aynı görselin başka baskısı ${front+1}. ürünü ön buldu`;}
  }
}
// Re-reading a page at a higher resolution keeps the garment found on the
// scan raster: its mask is enlarged and its measurements scaled.
const HI_RES_SHORT=120, HI_RES_TARGET=160, HI_RES_EDGE=1600, HI_RES_PIXELS=2.5e6, SMALL_PRINT_PX=64;
function scaledBox(box,k,p) {
  const x=Math.max(0,Math.floor(box.x*k)),y=Math.max(0,Math.floor(box.y*k));
  return {x,y,w:Math.min(p.width-x,Math.ceil(box.w*k)),h:Math.min(p.height-y,Math.ceil(box.h*k))};
}
function scaledRef(ref,low,high) {
  const kx=high.width/low.width,ky=high.height/low.height,mask=new Uint8Array(high.width*high.height);
  for(let y=0;y<high.height;y++) {
    const row=Math.min(low.height-1,Math.floor(y/ky))*low.width;
    for(let x=0;x<high.width;x++)mask[y*high.width+x]=ref.mask[row+Math.min(low.width-1,Math.floor(x/kx))];
  }
  return {...ref,mask,raw:null,maskScale:kx,box:scaledBox(ref.box,kx,high),bodyCenterX:ref.bodyCenterX*kx,hemWidthPx:ref.hemWidthPx*kx,chestPx:ref.chestPx*kx,
    hemY:ref.hemY*ky,shoulderY:ref.shoulderY*ky,bodyHeightPx:ref.bodyHeightPx*ky};
}
// The same print on the same garment: equal placement on the body, equal
// garment colour and matching ink pattern on a coarse grid.
function sameArtwork(a,b) {
  if(a.color!==b.color||a.match.ambiguous||b.match.ambiguous)return false;
  const place=({ref,match:{box}})=>[(box.x+box.w/2-ref.bodyCenterX)/ref.hemWidthPx,(box.y-ref.shoulderY)/ref.bodyHeightPx,box.w/ref.hemWidthPx,box.h/ref.bodyHeightPx];
  const pa=place(a),pb=place(b);
  if(pa.some((v,i)=>Math.abs(v-pb[i])>.04))return false;
  const grid=({p,ref,match:{box}})=> {
    const garment=dominant(p,Array.from(ref.mask.keys()).filter(i=>ref.mask[i])),out=[];
    for(let gy=0;gy<12;gy++)for(let gx=0;gx<24;gx++) {
      const i=(Math.floor(box.y+(gy+.5)*box.h/12)*p.width+Math.floor(box.x+(gx+.5)*box.w/24))*4;
      out.push(Math.max(...[0,1,2].map(k=>Math.abs(p.data[i+k]-garment[k]))));
    }
    return out;
  };
  const ga=grid(a),gb=grid(b);
  return ga.reduce((sum,v,i)=>sum+Math.abs(v-gb[i]),0)/ga.length<=20;
}
// Several prints on one garment: the application's position names one of
// them. On a front the centre-most print is the chest print and the outermost
// on the named side is the chest-side logo, each only when clearly apart from
// the next one. On a back, prints stacked on the centre line form one
// composition. Anything else stays ambiguous.
function positionPrint(match,ref,position) {
  const all=[match,...(match.others||[])].map(c=>({...c,o:(c.box.x+c.box.w/2-ref.bodyCenterX)/ref.hemWidthPx}));
  if(position==='sirt') {
    // A small second print (a neck label) is another application, not part of the back print.
    if(!match.ambiguous)return {...match,known:all.slice(1).map(c=>c.box)};
    const column=all.filter(c=>Math.abs(c.o)<.1).sort((a,b)=>a.box.y-b.box.y);
    if(column.length<2||all.some(c=>Math.abs(c.o)>=.1&&c.score>match.score*.4))return match;
    let box=column[0].box;
    for(const c of column.slice(1)) {
      const q=c.box,overlap=Math.min(box.x+box.w,q.x+q.w)-Math.max(box.x,q.x);
      if(overlap<Math.min(box.w,q.w)*.6||q.y-(box.y+box.h)>Math.max(box.h,q.h)*2.5)return match;
      const x0=Math.min(box.x,q.x),y0=Math.min(box.y,q.y);
      box={x:x0,y:y0,w:Math.max(box.x+box.w,q.x+q.w)-x0,h:Math.max(box.y+box.h,q.y+q.h)-y0};
    }
    return {...match,box,score:column.reduce((sum,c)=>sum+c.score,0),ambiguous:false,others:[],known:all.filter(c=>!column.includes(c)).map(c=>c.box)};
  }
  const side=position==='sol_gogus'?1:position==='sag_gogus'?-1:0;
  const ranked=all.map(c=>({c,key:side?c.o*side:-Math.abs(c.o)})).sort((a,b)=>b.key-a.key);
  if(side&&ranked[0].key<.05)return match;
  if(ranked[1]&&ranked[0].key-ranked[1].key<.12)return match;
  const {o,...chosen}=ranked[0].c;
  // The other prints belong to other applications on the same garment.
  return {...chosen,ambiguous:false,others:[],known:ranked.slice(1).map(r=>r.c.box)};
}
// Artwork recovery uses the existing placement detector but never infers a physical scale.
// G61b: when colour separation cannot isolate the print, the eye's box (fitted to the ink) is
// cut out: ink kept, the garment colour around it made transparent. A note says so.
async function gozCut(image,gozBox) {
  canvasLib ||= require('@napi-rs/canvas');
  const [p]=await rasterPages(image,1600,image.mime==='application/pdf'?[1]:null);
  const box={x:gozBox.x*p.width,y:gozBox.y*p.height,w:gozBox.w*p.width,h:gozBox.h*p.height};
  const garment=ringColour(p,box),f=fitInkWith(p,box,garment);
  const x0=Math.max(0,Math.floor(f.x)),y0=Math.max(0,Math.floor(f.y)),w=Math.min(p.width-x0,Math.ceil(f.w)),h=Math.min(p.height-y0,Math.ceil(f.h));
  if(w<4||h<4)return null;
  const c=canvasLib.createCanvas(w,h),ctx=c.getContext('2d'),out=ctx.createImageData(w,h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++) {
    const i=((y0+y)*p.width+x0+x)*4,o=(y*w+x)*4,rgb=[p.data[i],p.data[i+1],p.data[i+2]];
    if(p.data[i+3]<64||distance(rgb,garment)<=GOZ_INK)continue;
    out.data[o]=rgb[0];out.data[o+1]=rgb[1];out.data[o+2]=rgb[2];out.data[o+3]=255;
  }
  ctx.putImageData(out,0,0);
  return {buffer:c.toBuffer('image/png'),placement:{page:1,view:image.gorunum,rasterWidth:p.width,rasterHeight:p.height,designBoxPx:{x:x0,y:y0,w,h},gozKesit:true},
    warnings:[],notes:['Desen gözün kutusundan kesildi (kumaş rengi saydam); kenarları kontrol edin.']};
}
async function extractArtwork(input) {
  const result=await extractArtworkColour(input);
  if(result?.buffer || !input.gozBox)return result;
  const cut=await gozCut(input.image,input.gozBox).catch(()=>null);
  return cut || result;
}
async function extractArtworkColour({image,position,product:productKey,color,viewHint=null}) {
  const view=viewForPosition(position);
  const supported=['gogus','sol_gogus','sag_gogus','sirt'];
  if(!supported.includes(position))return {reason:'Bu konumda üründen güvenilir desen ayrıştırılamadı; ayrı desen dosyası bağlayın.'};
  if(image.gorunum&&image.gorunum!==view)return {reason:'Ürün görünümü bildirilen uygulama konumuyla eşleşmedi.'};
  // An extra page detects overflow without decoding the rest of a large sheet.
  const pageLimit=12, selectedPages=Array.from({length:pageLimit+1},(_,i)=>i+1);
  const edge=image.mime==='application/pdf'?640:1000;
  const pages=await rasterPages(image,edge,selectedPages), candidates=[];
  if(pages.length>pageLimit)return {reason:`${pageLimit} sayfadan uzun üründen güvenle desen ayrılamıyor; tek ürün görünümü yükleyin.`};
  const texts=image.mime==='application/pdf'?await pdfText(image,edge,selectedPages):null;
  const lineColor=named(color,COLOR_WORDS),wantColor=lineColor.length===1?lineColor[0]:null;
  const wantProduct=LINE_PRODUCTS[String(productKey??'').trim().toLowerCase()]??null;
  let hasProduct=false, ambiguousView=false, wrongSide=false;
  const scanned=[],notes=[];
  for(const [i,p] of pages.entries()) {
    // A catalogue page titled with another product is not this line's garment.
    const title=texts?.[i]?.text,products=named(title,PRODUCT_WORDS),titleColors=named(title,COLOR_WORDS);
    if(wantProduct&&products.length===1&&products[0]!==wantProduct)continue;
    const refs=silhouettes(p,productKey);
    hasProduct||=refs.length>0;
    scanned.push({i,p,refs,titleColor:titleColors.length===1?titleColors[0]:null,colors:refs.map(ref=>garmentColor(dominant(p,Array.from(ref.mask.keys()).filter(k=>ref.mask[k])))),captions:captionViews(texts?.[i]?.items,refs)});
  }
  // Colour variants repeat one design on garments of different colours. The
  // line colour picks among them only when the sheet shows several colours
  // and that one among them; a colour no garment or page title shows leaves
  // every garment in play, with a note (the fabric may be the wrong one).
  const seen=new Set(scanned.flatMap(sheet=>[...sheet.colors,sheet.titleColor].filter(Boolean)));
  if(wantColor&&seen.size&&!seen.has(wantColor))notes.push(colorMismatch(color));
  const sheets=wantColor&&seen.has(wantColor)&&seen.size>1?scanned.filter(sheet=>!sheet.titleColor||sheet.titleColor===wantColor):scanned;
  const byColor=wantColor&&sheets.some(sheet=>sheet.colors.includes(wantColor));
  for(const {i,p,refs:all,colors,captions} of sheets) {
    const kept=all.map((_,k)=>!byColor||colors[k]===wantColor);
    const refs=all.filter((_,k)=>kept[k]),labels=captions.filter((_,k)=>kept[k]);
    const cues=productViewCues(p,refs,productKey);
    const matches=refs.map(ref=>colorDesign(p,ref,position==='sirt'));
    pairViews(p,refs,cues,matches,labels);
    if(i===0)applyViewHint(refs,cues,viewHint);
    for(const [index,ref] of refs.entries()) {
      const cue=cues[index];
      if(cue.view!=='teyit'&&cue.view!==view)continue;
      let match=matches[index];
      if(!match.box)continue;
      if(refs.length>1&&cue.view==='teyit') {ambiguousView=true;continue;}
      if(match.others?.length)match=positionPrint(match,ref,position);
      const {x,w}=match.box;
      const offset=(x+w/2-ref.bodyCenterX)/ref.hemWidthPx;
      if((position==='sol_gogus'&&offset<.05)||(position==='sag_gogus'&&offset>-.05)) {wrongSide=true;continue;}
      candidates.push({p,ref,match,page:i+1,color:colors[all.indexOf(ref)]});
    }
  }
  // A sheet may repeat the same garment and print on several pages; one copy is enough.
  if(!ambiguousView&&candidates.length>1&&candidates.every(c=>sameArtwork(candidates[0],c)))candidates.splice(1);
  if(!ambiguousView&&candidates.length>1&&!wantColor&&new Set(candidates.map(c=>c.color)).size===candidates.length)
    return {reason:'Desen birden çok renk varyantında görünüyor; satırın rengini girin ya da tek görünüm yükleyin.'};
  if(ambiguousView||candidates.length>1||candidates[0]?.match.ambiguous)
    return {reason:'Üründe birden çok görünüm veya desen adayı var; konumu teyit edin ya da ayrı desen bağlayın.'};
  if(!candidates.length) return {reason:wrongSide ? 'Desen bildirilen göğüs tarafıyla eşleşmedi.' : hasProduct
    ? 'Güvenilir desen adayı yok. Düşük kontrast, dikiş veya kesik desen olabilir.'
    : 'Tam ürün maskesi bulunamadı; ürün veya desen kesilmiş olabilir.'};

  let {p,ref,match,page}=candidates[0];
  const unsafe={reason:'Desen kenarı kumaş, gölge veya dikişten güvenle ayrılamadı; ayrı desen dosyası bağlayın.'};
  {
    const {width:w,height:h}=p,mask=ref.mask,product=ref.box;
    const sleeveOnly=x=> {
      // A slight crop of the outer sleeve is independent of a complete torso
      // print. Any border contact at torso height remains unsafe.
      if(Math.abs(x-ref.bodyCenterX)<ref.hemWidthPx*.52)return false;
      for(let y=Math.floor(ref.shoulderY+ref.bodyHeightPx*.42);y<product.y+product.h;y++)
        if(mask[y*w+x])return false;
      return true;
    };
    // A hem cut by the page edge leaves the chest and back print bands whole;
    // the print itself must then end well above that edge.
    const hemCut=product.y+product.h>h-3&&match.box.y+match.box.h<h-ref.bodyHeightPx*.15;
    if(product.y<3||(product.y+product.h>h-3&&!hemCut)||
      (product.x<3&&!sleeveOnly(product.x))||(product.x+product.w>w-3&&!sleeveOnly(product.x+product.w-1)))
      return {reason:'Ürün görüntü kenarında kesiliyor; desenin tamamı doğrulanamadı.'};
    if(ref.symmetry<MIN_SYMMETRY)return unsafe;
  }
  // A small print loses thin strokes and small lettering at the scan size.
  // Read the same page again with more pixels when the source has them.
  const short=Math.min(match.box.w,match.box.h);
  if(short<HI_RES_SHORT) {
    const base=Math.max(p.width,p.height),area=p.width*p.height;
    const edge=Math.min(HI_RES_EDGE,Math.round(base*Math.min(4,HI_RES_TARGET/short,Math.sqrt(HI_RES_PIXELS/area))));
    if(edge>base*1.2) {
      const [hi]=await rasterPages(image,edge,[page]),k=hi.width/p.width;
      if(k>1.2&&Math.abs(hi.height/p.height-k)<.02*k) {
        // Prefer the garment found again on the sharper raster; its outline
        // is exact, where an enlarged mask is blocky at the edges.
        const expected=scaledBox(ref.box,k,hi),again=silhouettes(hi,productKey).find(r=>overlapFraction(r.box,expected)>.8);
        ref=again?{...again,maskScale:1}:scaledRef(ref,p,hi);match={...match,box:scaledBox(match.box,k,hi),score:match.score*k*k,known:(match.known||[]).map(box=>scaledBox(box,k,hi))};p=hi;
      }
    }
  }
  let b=match.box;
  const {width:w,height:h,data}=p, mask=ref.mask;
  const maxW=ref.hemWidthPx*.90,maxH=ref.bodyHeightPx*(position==='sirt'?.70:.44);
  if(b.w>maxW||b.h>maxH) return unsafe;
  const maxChannel=i=>Math.max(data[i*4],data[i*4+1],data[i*4+2]);
  const minChannel=i=>Math.min(data[i*4],data[i*4+1],data[i*4+2]);
  const white=(i,level)=>minChannel(i)>=level&&maxChannel(i)-minChannel(i)<=27;
  // Crop a print box with a margin and read the cloth from its outer ring.
  const isolate=(b,pad)=> {
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
  // A back print may be wider than the ribbed hem it is measured against.
  if(b.w>(position==='sirt'?ref.hemWidthPx*1.1:maxW)||b.h>maxH)return unsafe;
  // The margin only has to be clean cloth all round. A print close to an
  // arm gap or seam may keep a narrower one; the ring checks stay the same.
  const widest=Math.max(4,Math.round(Math.min(b.w,b.h)*.14));
  const crop=[widest,Math.round(widest/2),4].filter((pad,i,all)=>pad>=4&&all.indexOf(pad)===i).reduce((found,pad)=>found||isolate(b,pad),null);
  if(!crop)return unsafe;
  const {x,y,right,bottom,cw,ch,fabric,contrast,whiteLayer,shading}=crop,layered=whiteLayer||!!shading;
  // The placement detector searches the usual print band. A second prominent
  // mark elsewhere on the torso makes a source crop unsafe as well.
  // An enlarged mask is blocky by its scale; keep that far from its edge.
  const e=Math.max(2,Math.ceil(2*(ref.maskScale||1)));
  // A crease or shadow darkens the cloth without changing its hue; ink differs
  // in hue or is far darker than any fold.
  const norm=fabric[0]**2+fabric[1]**2+fabric[2]**2;
  const crease=i=> {
    const c=[data[i*4],data[i*4+1],data[i*4+2]],s=norm?(c[0]*fabric[0]+c[1]*fabric[1]+c[2]*fabric[2])/norm:0;
    return s>=.3&&s<1&&Math.max(...c.map((v,k)=>Math.abs(v-s*fabric[k])))<=20;
  };
  const outside=new Uint8Array(w*h), left=Math.max(2,Math.ceil(ref.bodyCenterX-ref.hemWidthPx*.47)),
    end=Math.min(w-2,Math.floor(ref.bodyCenterX+ref.hemWidthPx*.47));
  for(let yy=Math.max(2,Math.ceil(ref.shoulderY+ref.bodyHeightPx*.14));yy<Math.min(h-2,ref.hemY-ref.bodyHeightPx*.08);yy++)
    for(let xx=left;xx<end;xx++) {
      if(xx>=x&&xx<right&&yy>=y&&yy<bottom)continue;
      const i=yy*w+xx;
      if(mask[i]&&mask[i-e]&&mask[i+e]&&mask[i-e*w]&&mask[i+e*w]&&(whiteLayer?white(i,172):(shading?shading(i)>=SHADE_INK:contrast(i)>75)&&!crease(i)))outside[i]=1;
    }
  const known=q=>(match.known||[]).some(k=>q.x<k.x+k.w&&k.x<q.x+q.w&&q.y<k.y+k.h&&k.y<q.y+q.h);
  if(components(outside,w,h,Math.max(12,match.score*.10)).some(c=>c.box.w>=5&&c.box.h>=5&&!known(c.box)))
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
    // The source has no more pixels for a small print: thin strokes and small
    // lettering may be missing, so its outline and proportions need a look.
    const warnings=Math.min(box.w,box.h)<SMALL_PRINT_PX?[`Küçük baskı ${box.w}×${box.h} pikselden ayrıldı; ince uçlar ve küçük yazılar eksik olabilir, en-boy oranını kaynakla teyit edin.`]:[];
    return {buffer:canvas.toBuffer('image/png'),placement:{page,view,rasterWidth:w,rasterHeight:h,designBoxPx:{...box,x:x+box.x,y:y+box.y}},warnings,notes};
  } finally {canvas.width=canvas.height=0;}
}
module.exports={pointScale,gozLimbMeasure,defaultViewHint,fitInk,paleGroundReason,applyViewHint,autoMeasure,raster,rasterPages,viewForPosition,designContent,silhouette,silhouettes,extractArtwork};
