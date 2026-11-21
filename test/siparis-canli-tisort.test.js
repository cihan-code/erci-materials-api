'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {PDFDocument,StandardFonts}=require('pdf-lib');
const {createCanvas}=require('@napi-rs/canvas');
const {autoMeasure,extractArtwork}=require('../agent/siparis/autoMeasure');
const documents=require('../agent/siparis/documents');
const flats=require('../agent/siparis/flats');
const {openDb}=require('../agent/siparis/db');
const {setup}=require('./fixtures/siparis/belge-fixture');

// G47 (live order): a front and a back of one dark tee side by side, a small
// letter-spaced word on the chest, the line colour naming another fabric.
// Invented garments, lettering and measurements only.
const BODY=[[200,45],[400,45],[540,175],[475,250],[450,215],[450,605],[150,605],[150,215],[125,250],[60,175]];
const CLOTH='#262626';
function tee(ctx,dx,fill=CLOTH) {
  ctx.fillStyle=fill;ctx.beginPath();
  BODY.forEach(([x,y],i)=>i?ctx.lineTo(dx+x,y):ctx.moveTo(dx+x,y));
  ctx.closePath();ctx.fill();
}
// The inside of the back neck shows through the front opening as a shadow.
function neckShadow(ctx,dx) {ctx.fillStyle='#050505';ctx.beginPath();ctx.ellipse(dx+300,50,60,24,0,0,Math.PI);ctx.fill();}
// Eight thin letters with wide gaps: 6 px strokes, 9 px tall, 10 px apart.
const LETTERS=8,LETTER_W=6,GAP=10,TEXT_H=9,TEXT_W=LETTERS*LETTER_W+(LETTERS-1)*GAP;
function lettering(ctx,x,y,k=1,color='#f4f4f4') {
  ctx.fillStyle=color;
  for(let n=0;n<LETTERS;n++) {
    const left=x+n*(LETTER_W+GAP)*k;
    ctx.fillRect(left,y,LETTER_W*k,1.5*k);ctx.fillRect(left,y+(TEXT_H-1.5)*k,LETTER_W*k,1.5*k);ctx.fillRect(left,y,1.5*k,TEXT_H*k);
  }
}
function pair({front=0,shadow=front,print=front,line=true}={}) {
  const c=createCanvas(1200,650),x=c.getContext('2d');
  x.fillStyle='#ffffff';x.fillRect(0,0,1200,650);
  tee(x,0);tee(x,600);
  if(shadow!=null)neckShadow(x,shadow*600);
  if(line&&print!=null)lettering(x,print*600+300-TEXT_W/2,250);
  return c.toBuffer('image/png');
}
// The linked source: the same word, white on a black proof background.
function source({w=TEXT_W,h=TEXT_H}={}) {
  const k=10,c=createCanvas(w*k+400,h*k+300),x=c.getContext('2d');
  x.fillStyle='#000000';x.fillRect(0,0,c.width,c.height);
  if(w===TEXT_W)lettering(x,200,150,k);else {x.fillStyle='#ffffff';x.fillRect(200,150,w*k,h*k);}
  return c.toBuffer('image/png');
}
const FLAT={id:'tee',ad:'UYDURMA TİŞÖRT',refBeden:'L',refLengthCm:54,olculerL:{omuzdan_boy:56,etek:30}};
const measure=(image,options={})=>autoMeasure({image:{buffer:image,mime:'image/png'},design:{buffer:source(options.source),mime:'image/png'},flat:FLAT,product:'tisort',position:'gogus',...options});

test('G47 a small letter-spaced word on the front of a dark pair is found as one print and measured', async()=> {
  const r=await measure(pair());
  assert.deepEqual(r.reasons,[],r.reason);
  const s=r.measure_source;
  assert.deepEqual(s.views.map(v=>v.view),['on','arka']);
  // G47b: the component-group path finds the word as the linked design itself.
  assert.equal(s.selectedProductIndex,0);assert.ok(['otomatik','otomatik_renk'].includes(s.method),s.method);
  // The letters join into one box of the whole word.
  assert.ok(Math.abs(s.candidateBoxPx.w-TEXT_W)<=2&&Math.abs(s.candidateBoxPx.h-TEXT_H)<=2,JSON.stringify(s.candidateBoxPx));
  assert.ok(s.aspectRatioError<=.3);
  assert.equal(r.width_mm,Math.round(s.candidateBoxPx.w*s.mmPerPx));
  // The neck shadow and the design on one garment agree on the front.
  assert.deepEqual(s.views[0].viewEvidence.pairVotes,['yaka içi gölgesi: 1. ürün ön','bağlı desenin konumu: 1. ürün ön']);
});

test('G47 the same pair with the front on the right: evidence, not order, names the front', async()=> {
  const r=await measure(pair({front:1}));
  assert.deepEqual(r.reasons,[],r.reason);
  assert.deepEqual(r.measure_source.views.map(v=>v.view),['arka','on']);
  assert.equal(r.measure_source.selectedProductIndex,1);
});

test('G47 the linked design position decides alone when nothing contradicts; a contradiction names its cues', async()=> {
  // Patron, 21.11.2026: the system decides front/back itself. No neck shadow
  // on either garment: the chest design found on the left one names it front.
  const alone=await measure(pair({shadow:null}));
  assert.deepEqual(alone.reasons,[],alone.reason);
  assert.deepEqual(alone.measure_source.views.map(v=>v.view),['on','arka']);
  // The shadow names the left garment, the design sits on the right one.
  const conflict=await measure(pair({shadow:0,print:1}));
  assert.equal(conflict.width_mm,null);
  assert.match(conflict.reason,/2 görünüm ayrılamadı.*Kanıtlar çelişiyor: yaka içi gölgesi 1\. ürünü, bağlı desenin konumu 2\. ürünü ön gösteriyor/);
});

test('G47 a mark under the back collar and a chest-side print settle a pair of plain dark tees', async()=> {
  // No neck shadow: the background shows inside both collars, as on many mockups.
  const c=createCanvas(1200,650),x=c.getContext('2d');
  x.fillStyle='#ffffff';x.fillRect(0,0,1200,650);tee(x,0);tee(x,600);
  x.fillStyle='#f4f4f4';for(const y of [58,64,70])x.fillRect(600+291,y,18,3);
  x.fillStyle='#f2f2f2';x.fillRect(340,215,44,10);x.fillRect(340,229,44,10);x.fillRect(340,215,8,24);
  const r=await autoMeasure({image:{buffer:c.toBuffer('image/png'),mime:'image/png'},design:null,flat:FLAT,product:'tisort',position:'sol_gogus'});
  const views=r.measure_source.views;
  assert.deepEqual(views.map(v=>v.view),['on','arka'],r.reason);
  assert.deepEqual(views[0].viewEvidence.pairVotes,['yan göğüs baskısı: 1. ürün ön','ense etiketi/baskısı: 1. ürün ön']);
  // The same mark on the garment carrying the side print contradicts it.
  const d=createCanvas(1200,650),y=d.getContext('2d');
  y.fillStyle='#ffffff';y.fillRect(0,0,1200,650);tee(y,0);tee(y,600);
  y.fillStyle='#f4f4f4';for(const yy of [58,64,70])y.fillRect(291,yy,18,3);
  y.fillStyle='#f2f2f2';y.fillRect(340,215,44,10);y.fillRect(340,229,44,10);y.fillRect(340,215,8,24);
  const conflict=await autoMeasure({image:{buffer:d.toBuffer('image/png'),mime:'image/png'},design:null,flat:FLAT,product:'tisort',position:'sol_gogus'});
  assert.equal(conflict.width_mm,null);
  assert.match(conflict.reason,/Kanıtlar çelişiyor: yan göğüs baskısı 1\. ürünü, ense etiketi\/baskısı 2\. ürünü ön gösteriyor/);
});

test('G47 a tee line on a garment whose collar rises above the shoulders asks for confirmation', async()=> {
  const c=createCanvas(600,700),x=c.getContext('2d');
  x.fillStyle='#ffffff';x.fillRect(0,0,600,700);
  x.save();x.translate(0,90);tee(x,0);x.restore();
  // A stand collar 95 px above the shoulder line (half-zip sweat).
  x.fillStyle=CLOTH;x.fillRect(240,40,120,100);
  lettering(x,300-TEXT_W/2,340);
  const r=await measure(c.toBuffer('image/png'));
  assert.equal(r.needs_confirmation,true);
  assert.match(r.reason,/Satır ürünü tişört, görseldeki ürünün yakası omuzdan yükseliyor/);
  // The ordinary tee of the main case has no such reason.
  assert.doesNotMatch((await measure(pair())).reason,/yakası omuzdan/);
});

test('G47 thin lettering needs the linked design ratio; without it nothing is measured', async()=> {
  // A square source does not describe a 13:1 word.
  const square=await measure(pair(),{source:{w:20,h:20}});
  assert.equal(square.width_mm,null);
  // Extraction has no source ratio: the word stays below the anonymous print limits.
  const c=createCanvas(600,650),x=c.getContext('2d');
  x.fillStyle='#ffffff';x.fillRect(0,0,600,650);tee(x,0);lettering(x,300-TEXT_W/2,250);
  const extracted=await extractArtwork({image:{buffer:c.toBuffer('image/png'),mime:'image/png'},position:'gogus',product:'tisort'});
  assert.equal(extracted.buffer,undefined);
});

test('G47 a line colour no garment shows is an information note, never a filter', async()=> {
  const r=await measure(pair(),{color:'Ekru'});
  assert.deepEqual(r.reasons,[],r.reason);assert.equal(r.needs_confirmation,false);
  assert.equal(r.measure_source.colorNote,'Satır rengi (Ekru) görseldeki ürün rengiyle uyuşmuyor');
  const black=await measure(pair(),{color:'Siyah'});
  assert.equal(black.measure_source.colorNote,undefined);
});

async function titledPdf(title) {
  const c=createCanvas(600,650),x=c.getContext('2d');
  x.fillStyle='#ffffff';x.fillRect(0,0,600,650);tee(x,0,'#1d2c5e');
  x.fillStyle='#f2f2f2';for(let k=0;k<4;k++)x.fillRect(240+k*30,250,26,40);
  const doc=await PDFDocument.create(),page=doc.addPage([600,650]);
  page.drawImage(await doc.embedPng(c.toBuffer('image/png')),{x:0,y:0,width:600,height:650});
  page.drawText(title,{x:20,y:630,size:10,font:await doc.embedFont(StandardFonts.Helvetica)});
  return Buffer.from(await doc.save());
}
test('G47 extraction keeps a sheet whose title and garment both miss the line colour, with a note', async()=> {
  const sheet=await titledPdf('Siyah T-Shirt');
  const r=await extractArtwork({image:{buffer:sheet,mime:'application/pdf'},position:'gogus',product:'tisort',color:'Ekru'});
  assert.ok(r.buffer,r.reason);
  assert.deepEqual(r.notes,['Satır rengi (Ekru) görseldeki ürün rengiyle uyuşmuyor']);
  assert.ok(!r.warnings.some(w=>/Satır rengi/.test(w)));
  // A colour the sheet names needs no note.
  const named=await extractArtwork({image:{buffer:sheet,mime:'application/pdf'},position:'gogus',product:'tisort',color:'Siyah'});
  assert.ok(named.buffer,named.reason);assert.deepEqual(named.notes,[]);
});

// L pattern library: an actionable reason and a fill-only command.
function library(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'g47-'));const db=openDb(path.join(dir,'siparis.sqlite'));flats.init(db);
  t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
  const add=(id,ad,urun,refBeden=null,refLengthCm=null,olculerL=null)=>db.prepare('INSERT INTO document_flats(id,ad,urun,gorunum,dosya,refBeden,refLengthCm,olculerL) VALUES(?,?,?,?,?,?,?,?)')
    .run(id,ad,urun,'on','uydurma.png',refBeden,refLengthCm,olculerL&&JSON.stringify(olculerL));
  return {db,dir,add};
}
const L_LIST=[
  {ad:'UYDURMA TİŞÖRT',urun:'tisort',refBeden:'L',refLengthCm:50,olculerL:{gogus:50,omuzdan_boy:70,etek:48}},
  {ad:'UYDURMA SWEAT',urun:'sweat',refBeden:'L',refLengthCm:58,olculerL:{gogus:58,omuzdan_boy:69,etek:50}},
  {ad:'UYDURMA ŞORT',urun:'sort',refBeden:'L',refLengthCm:50,olculerL:{bel:36,basen:50,yan_boy:35}},
  {ad:'UYDURMA POLO',urun:'polo',refBeden:'L',refLengthCm:52,olculerL:{gogus:52,omuzdan_boy:70,etek:52}},
  {ad:'UYDURMA CEKET',urun:null,refBeden:'L',refLengthCm:60,olculerL:{gogus:60}}
];

test('G47 a pattern without L sizes gives an actionable reason', t=> {
  const {db,add}=library(t);
  assert.equal(flats.missingLNote(db,{product_key:'tisort'},null),'Bu ürün için kalıp kütüphanesinde kalıp yok; L ölçüleriyle kalıp ekleyin');
  add('t','TİŞÖRT','tisort');
  assert.equal(flats.missingLNote(db,{product_key:'tisort'},null),'TİŞÖRT kalıbında L ölçüleri yok; kalıp kütüphanesini güncelleyin');
  // An L record whose size table is empty is just as unusable.
  const emptyL={id:'x',ad:'TİŞÖRT',urun:'tisort',refBeden:'L',olculerL:null};
  assert.match(flats.missingLNote(db,{product_key:'tisort'},emptyL),/^TİŞÖRT kalıbında L ölçüleri yok/);
  assert.equal(flats.missingLNote(db,{product_key:'tisort'},{...emptyL,olculerL:{omuzdan_boy:70,etek:48}}),null);
});

test('G47 the live order reason names the pattern instead of the generic L message', async t=> {
  const f=await setup();
  t.after(async()=>{await documents.settled();await f.close();fs.rmSync(f.dir,{recursive:true,force:true});});
  f.db.prepare('INSERT INTO document_flats(id,ad,urun,gorunum,dosya) VALUES(?,?,?,?,?)').run('tee','TİŞÖRT','tisort','on','uydurma.png');
  const o=await f.order({lines:[{product_key:'tisort',quantity:1,color_name:'Ekru',applications:[{kind:'baski',position:'gogus'}]}]});
  const line=o.version.lines[0];
  assert.equal((await f.upload(o.version.id,{kind:'urun_gorsel',lineId:line.id,gorunum:'on',buffer:pair()})).status,201);
  const app=(await f.request(`/surumler/${o.version.id}`,{token:f.token})).data.lines[0].applications[0];
  const message=f.db.prepare("SELECT message FROM confirmations WHERE ref_id=? AND kind='olcu' AND status='acik'").get(app.id).message;
  assert.match(message,/^TİŞÖRT kalıbında L ölçüleri yok; kalıp kütüphanesini güncelleyin/);
  assert.doesNotMatch(message,/L kalıp referansı bulunamadı|geçerli L beden/);
});

test('G47 kalip-l-tamamla fills only empty fields, is idempotent and leaves conflicts visible', t=> {
  const {db,add}=library(t);
  add('tee','UYDURMA TİŞÖRT','tisort');                                    // both empty
  add('sweat','UYDURMA SWEAT','sweat','L',58);                             // olculerL empty
  add('sort','UYDURMA ŞORT','sort',null,49);                               // old reference cm differs
  add('polo','UYDURMA POLO','polo','L',52,{gogus:51,omuzdan_boy:71});      // already filled: never overwritten
  add('m','UYDURMA M','tisort','M',48);                                    // not in the list
  const dry=flats.fillMissingL(db,L_LIST,{dry:true});
  assert.equal(dry.filled,2);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM document_flats WHERE olculerL IS NOT NULL").get().n,1);
  const done=flats.fillMissingL(db,L_LIST);
  const row=id=>flats.get(db,id),status=id=>done.rows.find(r=>r.id===id);
  assert.deepEqual(status('tee').alanlar,['refBeden','olculerL']);assert.equal(row('tee').refBeden,'L');assert.deepEqual(row('tee').olculerL,L_LIST[0].olculerL);
  assert.deepEqual(status('sweat').alanlar,['olculerL']);assert.equal(row('sweat').refLengthCm,58);
  assert.equal(status('sort').durum,'atlandi');assert.match(status('sort').neden,/49 cm.*50 cm.*--guncelle/);assert.equal(row('sort').refBeden,null);
  assert.equal(status('polo').durum,'tam');assert.deepEqual(row('polo').olculerL,{gogus:51,omuzdan_boy:71});
  assert.equal(status('m').durum,'atlandi');assert.equal(row('m').refBeden,'M');
  assert.deepEqual(done.unused,['UYDURMA CEKET']);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='kalip_l_tamamla'").get().n,2);
  const again=flats.fillMissingL(db,L_LIST);
  assert.equal(again.filled,0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='kalip_l_tamamla'").get().n,2);
  assert.throws(()=>flats.fillMissingL(db,[L_LIST[0],L_LIST[0]]),/tekil/);
});

test('G47 kalip-l-tamamla runs from the CLI against DATA_DIR, --kuru writes nothing', async t=> {
  const {db,dir,add}=library(t);add('tee','UYDURMA TİŞÖRT','tisort');
  const list=path.join(dir,'l-listesi.json');fs.writeFileSync(list,JSON.stringify(L_LIST));
  const {main}=require('../agent/siparis/cli');
  const before=process.env.DATA_DIR,log=console.log,lines=[];
  process.env.DATA_DIR=dir;console.log=s=>lines.push(String(s));
  try {
    await main(['kalip-l-tamamla',list,'--kuru']);
    assert.equal(flats.get(db,'tee').refBeden,null);
    await main(['kalip-l-tamamla',list]);
  } finally {console.log=log;if(before===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=before;}
  assert.match(lines.join('\n'),/KURU ÇALIŞTIRMA[\s\S]*UYDURMA TİŞÖRT\tdoldurulacak\trefBeden, olculerL[\s\S]*UYDURMA TİŞÖRT\tdolduruldu/);
  assert.equal(flats.get(db,'tee').refBeden,'L');
  await assert.rejects(main(['kalip-l-tamamla']),/Kullanım/);
});

// G47b: a thin multi-part mark (three bars) under the back collar, located by
// the component-group path; the linked source is the same mark.
function bars(ctx,x,y,k=1,color='#f0f0f0') {ctx.fillStyle=color;for(const dy of [0,7,14])ctx.fillRect(x,y+dy*k,24*k,3*k);}
function barsSource({box=false}={}) {
  const c=createCanvas(400,300),x=c.getContext('2d');
  if(box){x.fillStyle='#000000';x.fillRect(60,40,280,220);}else{x.fillStyle='#000000';x.fillRect(0,0,400,300);}
  bars(x,140,110,5,'#ffffff');
  return c.toBuffer('image/png');
}
function backWithBars({twice=false}={}) {
  const c=createCanvas(1200,650),x=c.getContext('2d');
  x.fillStyle='#ffffff';x.fillRect(0,0,1200,650);tee(x,0);tee(x,600);
  // The front carries a chest-side logo, the back the bars under the collar.
  x.fillStyle='#f2f2f2';x.fillRect(340,215,44,10);x.fillRect(340,229,44,10);x.fillRect(340,215,8,24);
  bars(x,888,80);if(twice)bars(x,888,300);
  return c.toBuffer('image/png');
}
const measureBars=(image,options={})=>autoMeasure({image:{buffer:image,mime:'image/png'},design:{buffer:barsSource(options),mime:'image/png'},flat:FLAT,product:'tisort',position:options.position||'ense'});

test('G47b a thin multi-part mark is located as one group by its own layout and measured', async()=> {
  const r=await measureBars(backWithBars());
  assert.deepEqual(r.reasons,[],r.reason);
  const s=r.measure_source,box=s.candidateBoxPx;
  assert.equal(s.selectedProductIndex,1);assert.equal(s.method,'otomatik');
  assert.ok(Math.abs(box.x-888)<=2&&Math.abs(box.w-24)<=2&&Math.abs(box.h-17)<=2,JSON.stringify(box));
  assert.ok(s.matchConfidence>=.78);
});

test('G47b a second equal group leaves the placement open; a source on a filled box still matches', async()=> {
  const twice=await measureBars(backWithBars({twice:true}));
  assert.equal(twice.width_mm,null);
  assert.match(twice.reason,/birden fazla aday|güveni/);
  // A converted proof drew the bars on a black box inside a transparent page.
  const boxed=await measureBars(backWithBars(),{box:true});
  assert.deepEqual(boxed.reasons,[],boxed.reason);
  assert.ok(Math.abs(boxed.measure_source.candidateBoxPx.w-24)<=2);
});

test('G47b arms hanging to the hem: the rib below the cuffs is the torso hem', async()=> {
  // Invented hoodie front: straight arms reach the hem band, the rib is narrower.
  const c=createCanvas(600,700),x=c.getContext('2d');
  x.fillStyle='#ffffff';x.fillRect(0,0,600,700);x.fillStyle='#1b1b1f';
  x.beginPath();x.ellipse(300,90,75,70,0,0,Math.PI*2);x.fill();
  x.beginPath();for(const [i,[a,b]] of [[150,140],[450,140],[520,200],[540,600],[470,600],[450,620],[450,660],[150,660],[150,620],[130,600],[60,600],[80,200]].entries())i?x.lineTo(a,b):x.moveTo(a,b);x.closePath();x.fill();
  const {silhouettes}=require('../agent/siparis/autoMeasure');
  const [p]=await require('../agent/siparis/autoMeasure').rasterPages({buffer:c.toBuffer('image/png'),mime:'image/png'});
  const refs=silhouettes(p,'sweat');
  assert.equal(refs.length,1);
  assert.ok(Math.abs(refs[0].hemWidthPx-300)<=4,String(refs[0].hemWidthPx));
});

// G47c (measured choice, 21.11.2026): height alone is not a scale. On the
// atelier set it raised the mean deviation (13% → 25%); the A policy stays:
// a sweat without a chest line is left for confirmation, not sized from height.
test('G47c a sweat whose chest line cannot be traced is not sized from its height alone', async()=> {
  const c=createCanvas(600,700),x=c.getContext('2d');
  x.fillStyle='#ffffff';x.fillRect(0,0,600,700);x.fillStyle='#1b1b1f';
  x.beginPath();x.ellipse(300,90,75,70,0,0,Math.PI*2);x.fill();
  x.beginPath();for(const [i,[a,b]] of [[150,140],[450,140],[520,200],[540,600],[470,600],[450,620],[450,660],[150,660],[150,620],[130,600],[60,600],[80,200]].entries())i?x.lineTo(a,b):x.moveTo(a,b);x.closePath();x.fill();
  x.fillStyle='#f2f2f2';for(let k=0;k<4;k++)x.fillRect(240+k*30,260,26,40);
  const r=await autoMeasure({image:{buffer:c.toBuffer('image/png'),mime:'image/png'},design:null,flat:{id:'s',refBeden:'L',olculerL:{omuzdan_boy:71,gogus:61}},product:'sweat',position:'gogus'});
  assert.equal(r.width_mm,null);
  assert.equal(r.measure_source.mmPerPx,null);
  assert.ok(r.measure_source.verticalMmPerPx>0);
  assert.match(r.reason,/boy ve göğüs ölçekleri birlikte doğrulanamadı/);
  assert.notEqual(r.measure_source.scaleMode,'yalniz_boy');
});

// G47d: a word running along a sleeve but well off the sleeve's own axis
// (beyond the former ±12° search) is grouped and read in its own frame.
function tiltedSleeve({degrees=25,blur=false}={}) {
  const c=createCanvas(600,650),x=c.getContext('2d');
  x.fillStyle='#ffffff';x.fillRect(0,0,600,650);x.fillStyle=CLOTH;
  x.beginPath();[[250,80],[350,80],[340,579],[260,579]].forEach(([u,v],i)=>i?x.lineTo(u,v):x.moveTo(u,v));x.closePath();x.fill();
  x.save();x.translate(300,330);x.rotate((90-degrees)*Math.PI/180);if(blur)x.filter='blur(1.5px)';lettering(x,-TEXT_W/2,-TEXT_H/2);x.restore();
  return c.toBuffer('image/png');
}
const sleeveFlat={id:'kol',ad:'Uydurma kol',refBeden:'L',olculerL:{kol_boyu:100}};
const measureSleeveWord=image=>autoMeasure({image:{buffer:image,mime:'image/png',gorunum:'kol'},design:{buffer:source(),mime:'image/png'},flat:sleeveFlat,product:'tisort',position:'kol'});

test('G47d a word tilted 25° off the sleeve axis is located in its own frame and measured along the sleeve', async()=> {
  const r=await measureSleeveWord(tiltedSleeve());
  assert.deepEqual(r.reasons,[],r.reason);
  const s=r.measure_source;
  assert.ok(s.matchConfidence===undefined||s.pageCandidates[0].confidence>=.78,JSON.stringify(s.pageCandidates));
  assert.equal(s.measuredAxis,'en');assert.match(s.enEkseni,/kol boyunca/);
  // 118 px along a 500 px sleeve of 100 cm: 236 mm.
  assert.ok(Math.abs(r.width_mm-236)<=8,String(r.width_mm));
});

test('G47d blur that thickens the letters beyond the ±10% aspect rule keeps the size for confirmation', async()=> {
  const r=await measureSleeveWord(tiltedSleeve({blur:true}));
  assert.equal(r.needs_confirmation,true);
  assert.match(r.reason,/±%10/);
});
