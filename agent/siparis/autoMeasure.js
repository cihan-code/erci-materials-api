'use strict';

// No database or filesystem access here: this module runs in the render worker.
let canvasLib; // Native canvas is loaded only in the child, never by HTTP routing.
const { imageSize } = require('./measure');
// Measurement uses a bounded raster; original uploads and their dimensions stay intact.
const MAX_EDGE = 2000;
const MIN_SYMMETRY = .85, MIN_MATCH_CONFIDENCE = .78;
const percent = n => (n*100).toLocaleString('tr-TR',{minimumFractionDigits:1,maximumFractionDigits:4});
const VIEW = {gogus:'on',sol_gogus:'on',sag_gogus:'on',kol:'on',sol_kol:'on',sag_kol:'on',sirt:'arka',ense:'arka',kapusan:'arka'};
const viewForPosition = position => VIEW[position] || 'teyit';
const median = a => a.slice().sort((x,y)=>x-y)[Math.floor(a.length/2)];
const distance = (a,b) => Math.max(...a.map((v,i)=>Math.abs(v-b[i])));

async function rasterPages({buffer,mime}, maxEdge=1000, selectedPages=null) {
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
        await page.render({canvasContext:canvas.getContext('2d'),viewport,canvasFactory:new CanvasFactory()}).promise;
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

function designContent(p) {
  const mask=new Uint8Array(p.width*p.height);
  const transparent=p.data.some((v,i)=>i%4===3 && v<128);
  for(let i=0;i<mask.length;i++)mask[i]=p.data[i*4+3]>32 && (transparent || Math.min(p.data[i*4],p.data[i*4+1],p.data[i*4+2])<240) ? 1:0;
  return {mask,box:bounds(mask,p.width,p.height)};
}
function resize(p,w,h) {
  const a=canvasLib.createCanvas(p.width,p.height);a.getContext('2d').putImageData(new canvasLib.ImageData(new Uint8ClampedArray(p.data),p.width,p.height),0,0);
  const b=canvasLib.createCanvas(w,h);b.getContext('2d').drawImage(a,0,0,w,h);
  const pixels=b.getContext('2d').getImageData(0,0,w,h);a.width=a.height=b.width=b.height=0;return pixels;
}
function matchDesign(image,design,reference,refine=true,initial=null) {
  const b=reference.box,pad=8,x0=Math.max(0,b.x-pad),y0=Math.max(0,b.y-pad),w=Math.min(image.width-x0,b.w+pad*2),h=Math.min(image.height-y0,b.h+pad*2);
  const data=new Uint8ClampedArray(w*h*4),mask=new Uint8Array(w*h);
  for(let y=0;y<h;y++) {data.set(image.data.subarray(((y+y0)*image.width+x0)*4,((y+y0)*image.width+x0+w)*4),y*w*4);mask.set(reference.mask.subarray((y+y0)*image.width+x0,(y+y0)*image.width+x0+w),y*w);}
  const result=matchDesignLocal({width:w,height:h,data},design,{...reference,mask,box:{...b,x:b.x-x0,y:b.y-y0}},initial?{...initial,box:{...initial.box,x:initial.box.x-x0,y:initial.box.y-y0}}:null,refine);
  if(result.box){result.box.x+=x0;result.box.y+=y0;}
  return result;
}
function matchDesignLocal(image,design,reference,initial=null,allowFine=true) {
  const content=designContent(design);
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
    const fine=matchDesignLocal(image,design,reference,result);
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
  return {mask,box,rows,bodyCenterX:median(band.map(r=>(r.l+r.r)/2)),hemWidthPx,chestPx:hemWidthPx,hemY,shoulderY:shoulder.y,shoulderMethod:'merkez gövdenin hızlı genişlediği ilk sürekli omuz satırı',bodyHeightPx:hemY-shoulder.y+1,symmetry,softEdgeFraction:soft/Math.max(1,edgeN),textureFraction:texture/Math.max(1,interior)};
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

function silhouettes(p) {
  const base=productMask(p),w=p.width,h=p.height;
  // A white product may contribute only a thin boundary before hole filling.
  // Judge body area in silhouette(), rather than discarding that outline here.
  const minInk=Math.max(24,Math.min(w*h*.006,Math.min(w,h)*.5));
  const collect=(raw,lowContrast=false)=>{
    const closed=closeMask(raw,w,h);
    let pieces=components(closed,w,h,minInk).filter(c=>c.box.h>h*.12&&c.box.w>w*.06);
    // Touching sleeves can connect two otherwise separate garments. Only split
    // when two substantial, disconnected upper bodies provide independent seeds.
    pieces=pieces.flatMap(c=>{
      const top=new Uint8Array(w*h),cut=c.box.y+c.box.h*.32;
      for(const i of c.pixels)if(Math.floor(i/w)<cut)top[i]=1;
      const seeds=components(top,w,h,c.area*.025).filter(a=>a.box.h>c.box.h*.16&&a.box.w>c.box.w*.18).sort((a,b)=>a.box.x-b.box.x);
      if(seeds.length!==2 || seeds[0].box.x+seeds[0].box.w>=seeds[1].box.x)return [c];
      const boundary=Math.round((seeds[0].box.x+seeds[0].box.w+seeds[1].box.x)/2);
      return [false,true].map(right=>({pixels:c.pixels.filter(i=>(i%w>=boundary)===right)}));
    });
    return pieces.map(c=>{
      let mask=new Uint8Array(w*h);for(const i of c.pixels)mask[i]=1;
      mask=fillHoles(mask,w,h);
      const ref=silhouette(p,{...base,raw,mask,lowContrast,box:bounds(mask,w,h)});
      if(ref)ref.maskMethod=lowContrast?'acik_zemin_bolge':'renk_kenar';
      return ref;
    }).filter(Boolean);
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

function scaleFor(ref,measurements) {
  const vertical=Number.isFinite(measurements.omuzdan_boy)&&measurements.omuzdan_boy>0?measurements.omuzdan_boy*10/ref.bodyHeightPx:null;
  const horizontal=Number.isFinite(measurements.etek)&&measurements.etek>0?measurements.etek*10/ref.hemWidthPx:null;
  const difference=vertical&&horizontal?Math.abs(vertical-horizontal)/((vertical+horizontal)/2):null;
  return {vertical,horizontal,difference,mean:vertical&&horizontal?(difference<=.15?(vertical+horizontal)/2:null):vertical||horizontal};
}

async function autoMeasure({image,design,flat,product,position}) {
  const started=performance.now(),timings={},reasons=[],source={method:'otomatik',flatId:flat?.id??null,flatAd:flat?.ad??null,refBeden:flat?.refBeden??null,refCm:flat?.refLengthCm??null,olculerL:flat?.olculerL??null,chestPx:null,designBoxPx:null,scale:null,mmPerPx:null,confidence:0,gorselFileId:image?.id??null,desenFileId:design?.id??null};
  let width=null,height=null;
  const positive=n=>Number.isFinite(n)&&n>0;
  const measurements=flat?.refBeden==='L' && flat?.olculerL && typeof flat.olculerL==='object' ? flat.olculerL : {};
  if(flat?.refBeden!=='L')reasons.push('Ürünün L kalıp referansı bulunamadı: kayıt L beden değil veya belirtilmemiş (geçerli referans sayısı 0).');
  if(!positive(measurements.omuzdan_boy)&&!positive(measurements.etek))reasons.push('Ürün için geçerli L beden kalıp ölçüleri bulunamadı (boy ve etek ölçüsü sayısı 0).');
  if(viewForPosition(position)==='teyit')reasons.push('Ürün görünümü uygulama konumuyla eşleştirilemedi (geçerli görünüm sayısı 0).');
  try {
    const pages=await rasterPages(image,image.mime==='application/pdf'?320:MAX_EDGE),candidates=[],allViews=[];
    let designs=[];
    if(design)try {designs=await rasterPages(design);}catch(e){source.designReadError=e.message;}
    global.gc?.(); // Release full-resolution native decode surfaces before scanning masks.
    source.pageCount=pages.length;source.designPageCount=designs.length;timings.raster=performance.now()-started;
    for(let i=0;i<pages.length;i++) {
      const refs=silhouettes(pages[i]);
      const cues=refs.map(ref=>hoodView(pages[i],ref));
      // No ordering assumption: only a visible opening/cords identifies front.
      // A second raised hood with no opening is the back of the same pair.
      if(refs.length===2&&cues.filter(c=>c.view==='on').length===1) {
        const other=cues.find(c=>c.view!=='on');if(other.hooded)other.view='arka';
      }
      for(let k=0;k<refs.length;k++) {
        const ref=refs[k],cue=cues[k],scale=scaleFor(ref,measurements);
        allViews.push({page:i+1,index:k,view:cue.view,hooded:cue.hooded,viewEvidence:{lining:cue.lining,cords:cue.cords},maskMethod:ref.maskMethod,productBoxPx:ref.box,shoulderY:ref.shoulderY,hemY:ref.hemY,hemWidthPx:ref.hemWidthPx,bodyHeightPx:ref.bodyHeightPx,...scale});
        if(cue.view!=='teyit'&&cue.view!==viewForPosition(position))continue;
        if(refs.length>1&&cue.view==='teyit'&&!designs.length)continue;
        if(designs.length)for(let j=0;j<designs.length;j++) {
          const match=matchDesign(pages[i],designs[j],ref,false);
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
      const refs=high.map(p=>silhouettes(p));
      finalists=finalists.map(candidate=>{
        const n=numbers.indexOf(candidate.page),p=high[n],sx=p.width/candidate.p.width,sy=p.height/candidate.p.height;
        const scaled=b=>({x:b.x*sx,y:b.y*sy,w:b.w*sx,h:b.h*sy}),box=scaled(candidate.ref.box);
        // Component ordering can change when a pale outline appears at 640px.
        const ref=refs[n].slice().sort((a,b)=>overlapFraction(b.box,box)-overlapFraction(a.box,box)).find(r=>overlapFraction(r.box,box)>.5);
        return {...candidate,p,ref,match:{...candidate.match,box:scaled(candidate.match.box)}};
      }).filter(c=>c.ref);
    }
    const refined=finalists.map(candidate=>({...candidate,match:candidate.designPage?matchDesign(candidate.p,designs[candidate.designPage-1],candidate.ref,true,candidate.match):colorDesign(candidate.p,candidate.ref)}));
    timings.refine=performance.now()-started-timings.raster-timings.scan;
    refined.sort((a,b)=>((!!b.designPage&&b.match.confidence>=.78?1:0)-(!!a.designPage&&a.match.confidence>=.78?1:0))||b.match.confidence-a.match.confidence);
    const chosen=refined[0];
    if(!chosen) {
      if(unknownViews.length)reasons.push(unknownViewReason());
      reasons.push(`Ürün maskesi veya görselde desen bulunamadı (${allViews.length} ürün, 0 uygun desen adayı).`);
    }
    else {
      const {ref,match,page,designPage}=chosen;
      source.method=match.method||'otomatik';source.selectedView=viewForPosition(position);
      source.rasterWidth=chosen.p.width;source.rasterHeight=chosen.p.height;
      const competing=refined.find(c=>c.page!==page||c.index!==chosen.index);
      const placementAmbiguous=match.ambiguous || !!competing&&Math.abs(match.confidence-competing.match.confidence)<.045;
      const templateSelectsProduct=designPage&&match.confidence>=MIN_MATCH_CONFIDENCE&&!placementAmbiguous;
      if(unknownViews.some(v=>v.page===page)&&!templateSelectsProduct)reasons.push(unknownViewReason());
      source.productSelection=templateSelectsProduct?'desen':'gorunum';
      const pageViews=allViews.filter(v=>v.page===page);
      // Independent products can be drawn at different sizes. Compare scales
      // only for the identified front/back pair, as in the two-view workflow.
      const paired=pageViews.length===2&&pageViews.some(v=>v.view==='on')&&pageViews.some(v=>v.view==='arka');
      const samePage=paired?pageViews.filter(v=>v.mean):[];
      for(const v of paired?pageViews.filter(v=>v.difference>.15&&v.index!==chosen.index):[])reasons.push(`${v.view==='arka'?'Arka':'Diğer'} görünümün boy/etek ölçek farkı %${percent(v.difference)}; %15 sınırını aşıyor (${v.vertical.toFixed(3)} ve ${v.horizontal.toFixed(3)} mm/px).`);
      if(samePage.length>1) {
        source.viewScaleDifference=(Math.max(...samePage.map(v=>v.mean))-Math.min(...samePage.map(v=>v.mean)))/(samePage.reduce((s,v)=>s+v.mean,0)/samePage.length);
        if(source.viewScaleDifference>.05)reasons.push(`Ön/arka ortalama ölçek farkı %${percent(source.viewScaleDifference)}; %5 sınırını aşıyor (${samePage.map(v=>v.mean.toFixed(3)).join(' ve ')} mm/px).`);
      }
      source.wrinkleFraction=wrinkleFraction(chosen.p,ref,match.box);
      Object.assign(source,{selectedPage:page,selectedDesignPage:designPage,selectedProductIndex:chosen.index,maskMethod:ref.maskMethod,chestPx:ref.hemWidthPx,hemWidthPx:ref.hemWidthPx,bodyHeightPx:ref.bodyHeightPx,shoulderY:ref.shoulderY,hemY:ref.hemY,shoulderMethod:ref.shoulderMethod,productBoxPx:ref.box,symmetry:ref.symmetry,textureFraction:ref.textureFraction,softEdgeFraction:ref.softEdgeFraction});
      source.matchConfidence=Math.round(Math.max(0,Math.min(1,match.confidence))*1000)/1000;
      source.textureConfidencePenalty=(ref.softEdgeFraction>.35 || ref.textureFraction>.16 || source.wrinkleFraction>.06)?.05:0;
      source.confidence=Math.round(Math.max(0,source.matchConfidence-source.textureConfidencePenalty)*1000)/1000;
      source.candidateBoxPx=match.box;
      source.designAspectRatio=match.content.box?match.content.box.w/match.content.box.h:null;
      source.aspectRatioError=match.box&&source.designAspectRatio?Math.abs(match.box.w/match.box.h/source.designAspectRatio-1):null;
      if(ref.symmetry<MIN_SYMMETRY)reasons.push(`Ürün maskesinin sol-sağ simetrisi %${percent(ref.symmetry)}; %${percent(MIN_SYMMETRY)} sınırının altında.`);
      if(placementAmbiguous)reasons.push(`Desen/ürün eşleşme güveni düşük: birden fazla aday var (en iyi güven %${percent(match.confidence)}${competing?`, diğer ürün güveni %${percent(competing.match.confidence)}`:''}); tek yerleşim teyit edilmeli.`);
      const {vertical,horizontal}=scaleFor(ref,measurements);
      if((ref.maskMethod==='acik_zemin_bolge'||ref.box.w*ref.box.h<chosen.p.width*chosen.p.height*.10)&&(!vertical||!horizontal))reasons.push('Yeni bulunan ürün için boy ve etek ölçekleri birlikte doğrulanamadı; iki L ölçüsüyle teyit edilmeli.');
      source.verticalMmPerPx=vertical;source.horizontalMmPerPx=horizontal;
      source.scaleDifference=vertical&&horizontal?Math.abs(vertical-horizontal)/((vertical+horizontal)/2):null;
      if(vertical&&horizontal&&source.scaleDifference>.15)reasons.push(`Boy/etek ölçek farkı %${percent(source.scaleDifference)}; %15 sınırını aşıyor (${vertical.toFixed(3)} ve ${horizontal.toFixed(3)} mm/px).`);
      if((vertical&&!horizontal)||(!vertical&&horizontal))source.scaleNote='Tek L ölçeği bulundu (1 eksen); ikinci eksen ölçüsü yok.';
      source.scaleMethod=vertical&&horizontal?'omuzdan_boy ve etek ortalaması':vertical?'yalnız omuzdan_boy':horizontal?'yalnız etek':null;
      source.mmPerPx=vertical&&horizontal?(source.scaleDifference<=.15?(vertical+horizontal)/2:null):vertical||horizontal;
      if(vertical&&horizontal&&source.scaleDifference>.15)source.scaleMethod='çelişen L ölçekleri; ölçü yok';
      source.scale=source.mmPerPx?source.mmPerPx/10:null;
      if(source.aspectRatioError>.01)source.aspectRatioNote=`Desen en-boy oranı farkı %${percent(source.aspectRatioError)}.`;
      if(match.confidence<MIN_MATCH_CONFIDENCE)reasons.push(`Desen eşleştirme güveni %${percent(match.confidence)}; %${percent(MIN_MATCH_CONFIDENCE)} sınırının altında.`);
      else if(!placementAmbiguous) {
        source.designBoxPx=match.box;
        if(source.mmPerPx) {
          width=Math.round(match.box.w*source.mmPerPx);height=Math.round(match.box.h*source.mmPerPx);
          if(match.box.w>ref.hemWidthPx)reasons.push(`Desen eni ${match.box.w.toFixed(1)} piksel, ürün gövde eninden (${ref.hemWidthPx} piksel) büyük; hesaplanan en ${width} mm.`);
          if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<=0||height<=0){reasons.push(`Hesaplanan ölçü fiziksel olarak geçersiz (${width} × ${height} mm); pozitif tam sayı ölçü bulunamadı.`);width=height=null;}
        }
      }
    }
  } catch(e) {reasons.push(`Ürün/desen okunamadı (ölçü sayısı 0): ${e.message}`);}
  source.timingsMs={...Object.fromEntries(Object.entries(timings).map(([k,v])=>[k,Math.round(v)])),total:Math.round(performance.now()-started)};
  return {width_mm:width,height_mm:height,measure_source:source,needs_confirmation:reasons.length>0,reasons,reason:reasons.join(' ')};
}
module.exports={autoMeasure,raster,rasterPages,viewForPosition,designContent,silhouette,silhouettes};
