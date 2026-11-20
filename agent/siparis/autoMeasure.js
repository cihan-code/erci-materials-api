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
// Product keys, not inferred garment names or the presence of a chest number.
const CHEST_SCALE_PRODUCTS = new Set(['sweat','sweatshirt','hoodie','kapusonlu','polar','tam_fermuar']);
const scalePairFor = (flat,product) => CHEST_SCALE_PRODUCTS.has(String(flat?.urun||product||'').trim().toLowerCase())?'boy_gogus':'boy_etek';
const percent = n => (n*100).toLocaleString('tr-TR',{minimumFractionDigits:1,maximumFractionDigits:4});
const VIEW = {gogus:'on',sol_gogus:'on',sag_gogus:'on',kol:'on',sol_kol:'on',sag_kol:'on',sirt:'arka',ense:'arka',kapusan:'arka'};
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
  for(let i=0;i<raw.length;i++) {
    const delta=distance([data[i*4],data[i*4+1],data[i*4+2]],bg),x=i%w,y=Math.floor(i/w);
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
  const factor=Math.min(1,(initial?720:allowFine?320:160)/Math.max(image.width,image.height)),small=resize(image,Math.round(image.width*factor),Math.round(image.height*factor));
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
  const cb=content.box,ratio=cb.h/cb.w, candidates=[];
  function template(width) {
    const height=width*ratio,pad=Math.max(1,width*.10),step=Math.max(1,width/(initial?22:allowFine?11:8)),samples=[];
    for(let yy=-pad;yy<height+pad;yy+=step)for(let xx=-pad;xx<width+pad;xx+=step) {
      const sx=cb.x+Math.floor(xx/width*cb.w),sy=cb.y+Math.floor(yy/height*cb.h);
      const at=(x,y)=> {if(x<cb.x||y<cb.y||x>=cb.x+cb.w||y>=cb.y+cb.h)return bg;const j=y*design.width+x,a=content.mask[j]?design.data[j*4+3]/255:0;return a*(design.data[j*4]+design.data[j*4+1]+design.data[j*4+2])/3+(1-a)*bg;};
      const v=at(sx,sy),d=Math.max(1,Math.round(cb.w/width));
      const a=sx>=cb.x&&sy>=cb.y&&sx<cb.x+cb.w&&sy<cb.y+cb.h?content.mask[sy*design.width+sx]:0;
      samples.push({x:Math.round(xx),y:Math.round(yy),v,a,e:Math.abs(at(sx+d,sy)-at(sx-d,sy))+Math.abs(at(sx,sy+d)-at(sx,sy-d))});
    }
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
    for(const a of t.samples){const xx=x+a.x,yy=y+a.y;if(xx<0||xx>=w||yy<0||yy>=h)return -1;const i=yy*w+xx,v=gray[i],e=edges[i];sum+=v;sq+=v*v;cross+=a.v*v;es+=e;esq+=e*e;ec+=a.e*e;inside+=mask[i];const k=ink[i];ks+=k;ksq+=k*k;kc+=a.a*k;}
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

function colorDesign(p,ref) {
  const w=p.width,h=p.height,cx=ref.bodyCenterX??(ref.box.x+ref.box.w/2),ink=contrastInk(p,ref),clean=new Uint8Array(ink.length);
  const top=ref.shoulderY+ref.bodyHeightPx*.14,bottom=ref.shoulderY+ref.bodyHeightPx*.62;
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
function scaleFor(ref,measurements,scalePair='boy_etek',p=null) {
  if(scalePair==='boy_gogus'&&p&&ref.chestLine===undefined)ref.chestLine=chestLine(p,ref);
  const chest=scalePair==='boy_gogus',horizontalCm=chest?measurements.gogus:measurements.etek,horizontalPx=chest?ref.chestLine?.width:ref.hemWidthPx;
  const vertical=Number.isFinite(measurements.omuzdan_boy)&&measurements.omuzdan_boy>0?measurements.omuzdan_boy*10/ref.bodyHeightPx:null;
  const horizontal=Number.isFinite(horizontalCm)&&horizontalCm>0&&horizontalPx>0?horizontalCm*10/horizontalPx:null;
  const difference=vertical&&horizontal?Math.abs(vertical-horizontal)/((vertical+horizontal)/2):null;
  return {vertical,horizontal,difference,mean:vertical&&horizontal?(difference<=.15?(vertical+horizontal)/2:null):chest?null:vertical||horizontal};
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
  const r=Math.max(2,Math.round(sleeve.lengthPx*.012)),joined=dilate(clean,w,h,r,r);
  return components(joined,w,h,8).map(c=>{
    const pixels=c.pixels.filter(i=>clean[i]),extent=sleeve.project(pixels);
    if(pixels.length<8||extent.alongPx<4||extent.acrossPx<4||extent.alongPx>sleeve.lengthPx*.65)return null;
    const mask=new Uint8Array(w*h);for(const i of pixels)mask[i]=1;
    return {mask,pixels,box:bounds(mask,w,h),...extent};
  }).filter(Boolean);
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
        scaleFor(ref,measurements,scalePair,p);
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
        const scale=scaleFor(ref,measurements,scalePair,p);
        source.scaleFrom='govde';source.mmPerPx=scale.mean;source.scaleDifference=scale.difference;
        source.hemWidthPx=ref.hemWidthPx;source.bodyHeightPx=ref.bodyHeightPx;
        Object.assign(source,{chestPx:ref.chestLine?.width??null,chestLinePx:ref.chestLine??null,shoulderY:ref.shoulderY,hemY:ref.hemY});
        if(scalePair==='boy_gogus'&&(!scale.vertical||!scale.horizontal))reasons.push('Kol için boy ve göğüs birlikte doğrulanamadı; göğüs çizgisi ve iki L ölçüsü gerekli.');
        if(scale.difference>.15)reasons.push(`Kol için gövde ${pairLabel} ölçek farkı %${percent(scale.difference)}; %15 sınırını aşıyor.`);
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

async function autoMeasure({image,design,flat,product,position}) {
  if(['kol','sol_kol','sag_kol'].includes(position))return autoMeasureSleeve({image,design,flat,product,position});
  const scalePair=scalePairFor(flat,product),pairLabel=scalePair==='boy_gogus'?'boy/göğüs':'boy/etek',horizontalLabel=scalePair==='boy_gogus'?'göğüs':'etek';
  const started=performance.now(),timings={},reasons=[],source={scalePair,method:'otomatik',flatId:flat?.id??null,flatAd:flat?.ad??null,refBeden:flat?.refBeden??null,refCm:flat?.refLengthCm??null,olculerL:flat?.olculerL??null,chestPx:null,designBoxPx:null,scale:null,mmPerPx:null,confidence:0,gorselFileId:image?.id??null,desenFileId:design?.id??null};
  let width=null,height=null;
  const positive=n=>Number.isFinite(n)&&n>0;
  const measurements=flat?.refBeden==='L' && flat?.olculerL && typeof flat.olculerL==='object' ? flat.olculerL : {};
  if(flat?.refBeden!=='L')reasons.push('Ürünün L kalıp referansı bulunamadı: kayıt L beden değil veya belirtilmemiş (geçerli referans sayısı 0).');
  if(!positive(measurements.omuzdan_boy)&&!positive(measurements[scalePair==='boy_gogus'?'gogus':'etek']))reasons.push(`Ürün için geçerli L beden kalıp ölçüleri bulunamadı (boy ve ${horizontalLabel} ölçüsü sayısı 0).`);
  if(viewForPosition(position)==='teyit')reasons.push('Ürün görünümü uygulama konumuyla eşleştirilemedi (geçerli görünüm sayısı 0).');
  try {
    const pages=await rasterPages(image,image.mime==='application/pdf'?320:MAX_EDGE),candidates=[],allViews=[];
    let designs=[];
    if(design)try {designs=await rasterPages(design,1000,null,{transparent:true});}catch(e){source.designReadError=e.message;}
    const designContents=designs.map(p=>designContent(p,true));
    const designRatios=designContents.flatMap(({box},i)=>box?[{page:i+1,ratio:box.w/box.h}]:[]);
    if(design && !designRatios.length)reasons.push('Bağlı desen dosyasının okunur içerik kutusu yok; renk adayının en-boy oranı doğrulanamadı.');
    global.gc?.(); // Release full-resolution native decode surfaces before scanning masks.
    source.pageCount=pages.length;source.designPageCount=designs.length;timings.raster=performance.now()-started;
    for(let i=0;i<pages.length;i++) {
      const refs=silhouettes(pages[i],product);
      const cues=refs.map(ref=>ref.splitMethod?{hooded:false,view:'teyit',lining:0,cords:0}:hoodView(pages[i],ref));
      if(product==='tisort')shirtViews(refs,cues);
      // No ordering assumption: only a visible opening/cords identifies front.
      // A second raised hood with no opening is the back of the same pair.
      if(refs.length===2&&cues.filter(c=>c.view==='on').length===1) {
        const other=cues.find(c=>c.view!=='on');if(other.hooded)other.view='arka';
      }
      for(let k=0;k<refs.length;k++) {
        const ref=refs[k],cue=cues[k],scale=scaleFor(ref,measurements,scalePair,pages[i]);
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
        const match=(!designs.length||refs.length===1||cue.view!=='teyit')&&['gogus','sol_gogus','sag_gogus','sirt'].includes(position)?colorDesign(pages[i],ref):{box:null};
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
    if(image.mime==='application/pdf' && finalists.length) {
      const numbers=[...new Set(finalists.map(c=>c.page))].sort((a,b)=>a-b),high=await rasterPages(image,640,numbers);
      const refs=high.map(p=>silhouettes(p,product));
      finalists=finalists.map(candidate=>{
        const n=numbers.indexOf(candidate.page),p=high[n],sx=p.width/candidate.p.width,sy=p.height/candidate.p.height;
        const scaled=b=>({x:b.x*sx,y:b.y*sy,w:b.w*sx,h:b.h*sy}),box=scaled(candidate.ref.box);
        // Component ordering can change when a pale outline appears at 640px.
        const ref=refs[n].slice().sort((a,b)=>overlapFraction(b.box,box)-overlapFraction(a.box,box)).find(r=>overlapFraction(r.box,box)>.5);
        return {...candidate,p,ref,match:{...candidate.match,box:scaled(candidate.match.box)}};
      }).filter(c=>c.ref);
    }
    const refined=finalists.map(candidate=>({...candidate,match:candidate.designPage?matchDesign(candidate.p,designs[candidate.designPage-1],designContents[candidate.designPage-1],candidate.ref,true,candidate.match):colorDesign(candidate.p,candidate.ref)}));
    timings.refine=performance.now()-started-timings.raster-timings.scan;
    refined.sort((a,b)=>((!!b.designPage&&b.match.confidence>=.78?1:0)-(!!a.designPage&&a.match.confidence>=.78?1:0))||b.match.confidence-a.match.confidence);
    const chosen=refined[0];
    if(!chosen) {
      if(unknownViews.length)reasons.push(unknownViewReason());
      reasons.push(`Ürün maskesi veya görselde desen bulunamadı (${allViews.length} ürün, 0 uygun desen adayı).`);
    }
    else {
      const {ref,match,page,designPage}=chosen;
      const {vertical,horizontal}=scaleFor(ref,measurements,scalePair,chosen.p);
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
      for(const v of paired?pageViews.filter(v=>v.difference>.15&&v.index!==chosen.index):[])reasons.push(`${v.view==='arka'?'Arka':'Diğer'} görünümün ${pairLabel} ölçek farkı %${percent(v.difference)}; %15 sınırını aşıyor (${v.vertical.toFixed(3)} ve ${v.horizontal.toFixed(3)} mm/px).`);
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
      source.scaleDifference=vertical&&horizontal?Math.abs(vertical-horizontal)/((vertical+horizontal)/2):null;
      if(vertical&&horizontal&&source.scaleDifference>.15)reasons.push(`${scalePair==='boy_gogus'?'Boy/göğüs':'Boy/etek'} ölçek farkı %${percent(source.scaleDifference)}; %15 sınırını aşıyor (${vertical.toFixed(3)} ve ${horizontal.toFixed(3)} mm/px).`);
      if((vertical&&!horizontal)||(!vertical&&horizontal))source.scaleNote='Tek L ölçeği bulundu (1 eksen); ikinci eksen ölçüsü yok.';
      source.scaleMethod=vertical&&horizontal?`omuzdan_boy ve ${horizontalLabel} ortalaması`:vertical?'yalnız omuzdan_boy':horizontal?`yalnız ${horizontalLabel}`:null;
      source.mmPerPx=vertical&&horizontal?(source.scaleDifference<=.15?(vertical+horizontal)/2:null):scalePair==='boy_gogus'?null:vertical||horizontal;
      if(scalePair==='boy_gogus'&&(!vertical||!horizontal))source.scaleMethod='eksik boy/göğüs ölçek çifti; ölçü yok';
      if(vertical&&horizontal&&source.scaleDifference>.15)source.scaleMethod='çelişen L ölçekleri; ölçü yok';
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
module.exports={autoMeasure,raster,rasterPages,viewForPosition,designContent,silhouette,silhouettes};
