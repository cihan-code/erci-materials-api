#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {PNG}=require('pngjs');
const recipes=require('../../operations/recipes.json').products;
const red=(r,g,b,a)=>a>100 && r>120 && r-g>30 && r>g*1.3 && r>b*1.15;
const dark=(r,g,b,a)=>a>100 && Math.max(r,g,b)<150 && Math.max(r,g,b)-Math.min(r,g,b)<45;
function bounds(p,region,predicate) {
  let x1=p.width,y1=p.height,x2=-1,y2=-1;
  for(let y=region.y;y<region.y+region.h;y++) for(let x=region.x;x<region.x+region.w;x++) {
    if(predicate(...p.data.subarray((y*p.width+x)*4,(y*p.width+x)*4+4))) {x1=Math.min(x1,x);y1=Math.min(y1,y);x2=Math.max(x2,x);y2=Math.max(y2,y);}
  }
  return x2<0 ? null : {x:x1,y:y1,w:x2-x1+1,h:y2-y1+1};
}
function checkRegion(r,p) {
  if(!r || !['x','y','w','h'].every(k=>Number.isInteger(r[k])) || r.x<0 || r.y<0 || r.w<1 || r.h<1 || r.x+r.w>p.width || r.y+r.h>p.height) throw Error('Geçerli ürün arama bolge kutusu gerekli');
}
function redMask(p) {
  const mask=new Uint8Array(p.width*p.height);
  for(let i=0;i<mask.length;i++) mask[i]=Number(red(...p.data.subarray(i*4,i*4+4)));
  return mask;
}
/** Detect horizontal red shafts, joining the gap occupied by the numbered circle.
 * The external y band only disambiguates which labelled measurement to use.
 * Neither length nor endpoints are taken from configuration. */
function horizontalReference(p,mask,region,yBand) {
  if(!Array.isArray(yBand) || yBand.length!==2 || !yBand.every(Number.isFinite)) throw Error('Yatay referans için refY aralığı gerekli');
  const rows=[];
  for(let y=Math.max(region.y,Math.ceil(yBand[0]));y<=Math.min(region.y+region.h-1,Math.floor(yBand[1]));y++) {
    let xs=[];
    for(let x=region.x;x<region.x+region.w;x++) if(mask[y*p.width+x]) xs.push(x);
    // A perpendicular dimension line beyond the cap is an isolated short run.
    const segments=[];for(const x of xs){if(!segments.length||x-segments.at(-1).at(-1)>2)segments.push([]);segments.at(-1).push(x);}
    while(segments.length&&segments[0].length<8)segments.shift();
    while(segments.length&&segments.at(-1).length<8)segments.pop();
    xs=segments.flat();
    let group=[];
    const finish=()=> {if(group.length>0) {const span=group.at(-1)-group[0];if(span>=60 && group.length>span*.48)rows.push({y,x1:group[0],x2:group.at(-1),count:group.length});}group=[];};
    for(const x of xs) {if(group.length && x-group.at(-1)>Math.max(64,p.width*.05))finish();group.push(x);}finish();
  }
  if(!rows.length) throw Error('Yatay kırmızı ok bulunamadı');
  const bands=[];
  for(const row of rows.sort((a,b)=>a.y-b.y)) {let b=bands.at(-1);if(!b || row.y-b.at(-1).y>4)bands.push(b=[]);b.push(row);}
  if(bands.length!==1) throw Error('Birden fazla yatay ok adayı; refY aralığını daraltın');
  const row=bands[0].sort((a,b)=>b.count-a.count || Math.abs(a.y-(yBand[0]+yBand[1])/2)-Math.abs(b.y-(yBand[0]+yBand[1])/2))[0];
  function terminal(edge,sign) {
    // End caps and round endpoint dots: centre their local vertical projection.
    const columns=[];
    for(let x=edge;x!==edge+sign*12;x+=sign) {let n=0;for(let y=row.y-9;y<=row.y+9;y++) if(y>=0&&y<p.height)n+=mask[y*p.width+x]||0;if(n>=4)columns.push([x,n]);else if(columns.length)break;}
    return columns.length ? Math.round(columns.reduce((n,[x,c])=>n+x*c,0)/columns.reduce((n,[,c])=>n+c,0)) : edge;
  }
  const x1=terminal(row.x1,1),x2=terminal(row.x2,-1);
  return {x1,y1:row.y,x2,y2:row.y};
}
function cleanRed(p,mask) {
  const result=Buffer.from(p.data), nearby=new Uint8Array(mask.length);
  for(let y=0;y<p.height;y++)for(let x=0;x<p.width;x++)if(mask[y*p.width+x]) {
    for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++)if(x+dx>=0&&x+dx<p.width&&y+dy>=0&&y+dy<p.height)nearby[(y+dy)*p.width+x+dx]=1;
  }
  for(let y=0;y<p.height;y++)for(let x=0;x<p.width;x++)if(nearby[y*p.width+x]) {
    const i=(y*p.width+x)*4;
    // Keep actual dark garment pixels, including at arrow intersections.
    if(!mask[y*p.width+x] && dark(...p.data.subarray(i,i+4)))continue;
    let best=null;
    for(let radius=3;radius<=24&&!best;radius+=3) {
      const samples=[];
      for(let dy=-radius;dy<=radius;dy+=radius)for(let dx=-radius;dx<=radius;dx+=radius) {
        const xx=x+dx,yy=y+dy;if(xx<0||yy<0||xx>=p.width||yy>=p.height||nearby[yy*p.width+xx])continue;
        const j=(yy*p.width+xx)*4,px=[...p.data.subarray(j,j+4)];if(Math.min(...px.slice(0,3))>175)samples.push(px);
      }
      if(samples.length)best=[0,1,2,3].map(c=>samples.map(s=>s[c]).sort((a,b)=>a-b)[Math.floor(samples.length/2)]);
    }
    if(best)for(let c=0;c<4;c++)result[i+c]=best[c];
  }
  return {...p,data:result};
}
function crop(p,r) {
  const out=new PNG({width:r.w,height:r.h});
  for(let y=0;y<r.h;y++)p.data.copy(out.data,y*r.w*4,((r.y+y)*p.width+r.x)*4,((r.y+y)*p.width+r.x+r.w)*4);
  return out;
}
function line(p,x1,y1,x2,y2,color) {
  const steps=Math.max(Math.abs(x2-x1),Math.abs(y2-y1));
  for(let s=0;s<=steps;s++)for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++) {
    const x=Math.round(x1+(x2-x1)*s/(steps||1))+dx,y=Math.round(y1+(y2-y1)*s/(steps||1))+dy;
    if(x>=0&&y>=0&&x<p.width&&y<p.height)for(let c=0;c<4;c++)p.data[(y*p.width+x)*4+c]=color[c];
  }
}
function prepare(source,output,settings={}) {
  if(path.resolve(source)===path.resolve(output))throw Error('Kaynak ve çıktı farklı olmalı');
  fs.mkdirSync(path.join(output,'kirpilmis'),{recursive:true});fs.mkdirSync(path.join(output,'onizleme'),{recursive:true});
  const records=[];
  for(const name of fs.readdirSync(source).filter(n=>/\.png$/i.test(n)).sort()) {
    const config=settings[name]||settings[name.normalize('NFC')],record={dosya:null,ad:config?.ad||path.basename(name,'.png'),urun:config?.urun??null,gorunum:'on',refLengthPx:null,refLengthCm:null,refBeden:null,refAciklama:'',kirpma:null,refUcNoktalar:null};
    try {
      if(!config)throw Error('Dış ayarda bu dosya yok');
      if(record.urun!==null&&!Object.hasOwn(recipes,record.urun))throw Error('Bilinmeyen recipe anahtarı');
      if(!Number.isFinite(config.refLengthCm)||config.refLengthCm<=0||!config.refAciklama?.trim())throw Error('Görselden doğrulanmış referans beden cm/açıklama gerekli');
      const p=PNG.sync.read(fs.readFileSync(path.join(source,name)));checkRegion(config.bolge,p);
      const mask=redMask(p),ref=horizontalReference(p,mask,config.bolge,config.refY),b=bounds(p,config.bolge,dark);
      if(!b)throw Error('Koyu ürün sınırı bulunamadı');
      const x=Math.max(0,b.x-20),y=Math.max(0,b.y-20),r={x,y,w:Math.min(p.width,b.x+b.w+20)-x,h:Math.min(p.height,b.y+b.h+20)-y};
      // A waistband reference may lie just outside the drawing but remains in the 20px margin.
      if(ref.x1<r.x||ref.x2>=r.x+r.w||ref.y1<r.y||ref.y1>=r.y+r.h)throw Error('Referans 20 px ürün kırpmasının dışında; başka anlamlı yatay ölçü seçin');
      const outName=String(records.length+1).padStart(2,'0')+'-'+name;
      fs.writeFileSync(path.join(output,'kirpilmis',outName),PNG.sync.write(crop(cleanRed(p,mask),r)));
      const preview={...p,data:Buffer.from(p.data)};
      line(preview,r.x,r.y,r.x+r.w-1,r.y,[0,100,255,255]);line(preview,r.x,r.y,r.x,r.y+r.h-1,[0,100,255,255]);line(preview,r.x+r.w-1,r.y,r.x+r.w-1,r.y+r.h-1,[0,100,255,255]);line(preview,r.x,r.y+r.h-1,r.x+r.w-1,r.y+r.h-1,[0,100,255,255]);
      line(preview,ref.x1,ref.y1,ref.x2,ref.y2,[0,190,40,255]);
      for(const xx of [ref.x1,ref.x2])line(preview,xx,ref.y1-10,xx,ref.y1+10,[0,190,40,255]);
      fs.writeFileSync(path.join(output,'onizleme',outName),PNG.sync.write(preview));
      Object.assign(record,{dosya:path.posix.join('kirpilmis',outName),refLengthPx:ref.x2-ref.x1,refLengthCm:config.refLengthCm,refBeden:config.refBeden??null,...(Number.isFinite(config.refLengthCmM)?{refLengthCmM:config.refLengthCmM}:{}),refAciklama:config.refAciklama+'; kırmızı maske yatay gövde + uç çizgisi/nokta merkezi; yalnız yatay tek ölçek',kirpma:r,refUcNoktalar:{x1:ref.x1-r.x,y1:ref.y1-r.y,x2:ref.x2-r.x,y2:ref.y2-r.y}});
    }catch(e){
      record.belirsiz=e.message;record.refAciklama='BELİRSİZ: '+e.message;
      // Still provide the original for review when configuration/detection is uncertain.
      try {const original=PNG.sync.read(fs.readFileSync(path.join(source,name)));fs.writeFileSync(path.join(output,'onizleme',String(records.length+1).padStart(2,'0')+'-'+name),PNG.sync.write(original));} catch(_) { /* Invalid PNG has no renderable preview. */ }
    }
    records.push(record);
  }
  fs.writeFileSync(path.join(output,'duz-cizimler.json'),JSON.stringify(records,null,2)+'\n');return records;
}
function main(args=process.argv.slice(2)) {
  const [source,output,...rest]=args;
  if(!source||!output||rest.length!==2||rest[0]!=='--ayar')throw Error('Kullanım: duz-cizim-hazirla.js <kaynak> <çıktı> --ayar <repo-dışı.json>');
  const records=prepare(source,output,JSON.parse(fs.readFileSync(rest[1],'utf8')));
  console.log(JSON.stringify(records.map(({ad,urun,refLengthPx,refLengthCm,belirsiz})=>({ad,urun,refLengthPx,refLengthCm,belirsiz})),null,2));
}
if(require.main===module)try{main();}catch(e){console.error(e.message);process.exitCode=1;}
module.exports={prepare,horizontalReference,redMask,cleanRed};
