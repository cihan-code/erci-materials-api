'use strict';
// G24b-G24d and G40 automatic measurement cases, split from siparis-otomatik-olcu.test.js (G61):
// one file had reached its 90 s deadline under parallel runs.
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {PDFDocument,rgb}=require('pdf-lib');
const auto=require('../agent/siparis/autoMeasure');
const documents=require('../agent/siparis/documents');
const {setup}=require('./fixtures/siparis/belge-fixture');
const {mockup}=require('./fixtures/siparis/oto-mockup');
// A hang guard, not a speed test: about twice the half-file time measured under a full parallel run (82-91 s).
const deadline=setTimeout(()=>{console.error('G24b-d test dosyası 180 saniyeyi aştı');process.exit(1);},180000);
deadline.unref();after(()=>clearTimeout(deadline));
const flat={id:'test',ad:'Sentetik kalıp',refBeden:'L',refLengthCm:60,olculerL:{omuzdan_boy:112.2,etek:60}};
const input=(m,extra={})=>({image:{id:1,buffer:m.image,mime:'image/png'},design:{id:2,buffer:m.design,mime:'image/png'},flat,product:'tisort',position:'gogus',...extra});
async function fixture(t) {const f=await setup();t.after(async()=>{await f.close();fs.rmSync(f.dir,{recursive:true,force:true});});return f;}
function ok(r,status=200){assert.equal(r.status,status,JSON.stringify(r.data));return r.data;}
function addFlat(f,product='tisort',view='on',id=product+view,refBeden='L') {
  const path=require('node:path'),root=path.join(fs.realpathSync(f.dir),'siparis','flats');fs.mkdirSync(root,{recursive:true});
  const filename=path.join(root,id+'.png');fs.writeFileSync(filename,mockup({missing:true}).image);
  f.db.prepare('INSERT INTO document_flats(id,ad,urun,gorunum,dosya,refLengthCm,refLengthPx,refBeden,olculerL) VALUES(?,?,?,?,?,?,?,?,?)').run(id,'Sentetik '+product,product,view,filename,60,300,refBeden,JSON.stringify(flat.olculerL));
}
test('G24b filled hanging sleeves, a shadow and a corner logo preserve two independent L scales',async()=>{
  const {silhouetteMockup}=require('./fixtures/siparis/oto-silhouette');
  for(const options of [{shadow:true},{recolor:true},{pale:true,shadow:true}]) {
    const m=silhouetteMockup(options),r=await auto.autoMeasure(input(m,{flat:{...flat,olculerL:{omuzdan_boy:72,etek:52}}}));
    assert.equal(r.needs_confirmation,false,JSON.stringify(r));
    assert.ok(Math.abs(r.measure_source.verticalMmPerPx-2)<.03,JSON.stringify(r));
    assert.ok(Math.abs(r.measure_source.horizontalMmPerPx-2)<.03,JSON.stringify(r));
    assert.ok(Math.abs(r.width_mm-238)<=5,JSON.stringify(r));
    assert.ok(Math.abs(r.height_mm-160)<=5,JSON.stringify(r));
    assert.ok(r.measure_source.designBoxPx.w>100);
  }
});
test('G24b a hood is excluded from shoulder height and tiny raster matches cannot alias the whole design',async()=>{
  const {silhouetteMockup}=require('./fixtures/siparis/oto-silhouette'),m=silhouetteMockup({hood:true,recolor:true});
  const r=await auto.autoMeasure(input(m,{flat:{...flat,olculerL:{omuzdan_boy:72,etek:52}}}));
  assert.ok(r.measure_source.shoulderY>50,JSON.stringify(r));assert.match(r.measure_source.shoulderMethod,/omuz/);
  if(r.measure_source.designBoxPx)assert.ok(r.measure_source.designBoxPx.w>50,JSON.stringify(r));
});
test('G24b all PDF pages are inspected; covers, logos and text do not replace the matching garment page',async()=>{
  const m=mockup(),pdf=await PDFDocument.create();
  const first=pdf.addPage([600,650]);first.drawText('PRODUCT COLLECTION',{x:100,y:400,size:28});first.drawRectangle({x:220,y:220,width:150,height:90});
  for(let i=0;i<5;i++)pdf.addPage([600,650]).drawText('NOTES '+i,{x:100,y:400,size:20});
  const wrong=await pdf.embedPng(mockup({missing:true}).image);pdf.addPage([600,650]).drawImage(wrong,{width:600,height:650});
  const right=await pdf.embedPng(m.image);pdf.addPage([600,650]).drawImage(right,{width:600,height:650});
  const r=await auto.autoMeasure(input(m,{image:{buffer:Buffer.from(await pdf.save()),mime:'application/pdf'}}));
  assert.equal(r.measure_source.pageCount,8);assert.equal(r.measure_source.selectedPage,8,JSON.stringify(r));assert.ok(Math.abs(r.width_mm-240)<=5,JSON.stringify(r));
  const cover=await PDFDocument.create();cover.addPage([600,650]).drawText('COLLECTION',{x:100,y:400,size:40});
  const noProduct=await auto.autoMeasure(input(m,{image:{buffer:Buffer.from(await cover.save()),mime:'application/pdf'}}));assert.equal(noProduct.width_mm,null);assert.equal(noProduct.needs_confirmation,true);
});
test('G24b L measurements survive API and --guncelle roundtrips while old reference contracts remain',async t=>{
  const f=await fixture(t);addFlat(f);
  const route='/duz-cizimler/tisorton/referans',body={refLengthPx:300,refLengthCm:60,refAciklama:'Synthetic chest',olculerL:{omuzdan_boy:72,etek:52,gogus:55}};
  const update=await f.request(route,{method:'PUT',token:f.managerToken,body});assert.equal(update.status,200,JSON.stringify(update.data));assert.equal(update.data.refBeden,'L');assert.deepEqual(update.data.olculerL,body.olculerL);
  const rows=ok(await f.request('/duz-cizimler',{token:f.token}));assert.deepEqual(rows[0].olculerL,body.olculerL);
  for(const invalid of [{etek:0},{etek:-1},{etek:'52'},[52],{}])assert.equal((await f.request(route,{method:'PUT',token:f.managerToken,body:{...body,olculerL:invalid}})).status,400);
  const path=require('node:path'),json=path.join(f.dir,'synthetic-reference.json'),filename=path.join(f.dir,'synthetic.png');fs.writeFileSync(filename,mockup().image);
  const record={ad:'Sentetik tisort',urun:'tisort',gorunum:'on',dosya:filename,refLengthPx:300,refLengthCm:60,refBeden:'L',refAciklama:'Synthetic chest',olculerL:{omuzdan_boy:74,etek:53}};fs.writeFileSync(json,JSON.stringify([record]));
  const {upload}=require('../agent/siparis/tools/duz-cizim-yukle');const fetchImpl=async(url,options)=>{if(url.endsWith('/giris'))return {ok:true,json:async()=>({token:f.managerToken})};return fetch(url,options);};
  assert.deepEqual(await upload({api:f.base,json,update:true,getCredentials:async()=>({name:'fixture',password:'fixture'}),fetchImpl,log:()=>{}}),{uploaded:1,skipped:0});
  assert.deepEqual(ok(await f.request('/duz-cizimler',{token:f.token}))[0].olculerL,record.olculerL);
});
test('G24d fabric texture only lowers reported confidence and never requires confirmation',async()=>{
  const {silhouetteMockup}=require('./fixtures/siparis/oto-silhouette'),m=silhouetteMockup({wrinkles:true});
  const r=await auto.autoMeasure(input(m,{flat:{...flat,olculerL:{omuzdan_boy:72,etek:52}}}));
  assert.ok(r.measure_source.wrinkleFraction>.06,JSON.stringify(r));assert.equal(r.needs_confirmation,false,JSON.stringify(r));assert.equal(r.reason,'');assert.ok(r.measure_source.textureConfidencePenalty<=.05);assert.ok(r.measure_source.matchConfidence-r.measure_source.confidence<=.050001);
});
test('G24b large type, script marks and filled cover rectangles are not products',async()=>{
  const {createCanvas}=require('@napi-rs/canvas');
  for(const kind of ['type','script','rectangle']) {
    const c=createCanvas(600,600),x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,600,600);x.fillStyle='#253252';
    if(kind==='type'){x.fillRect(80,90,70,420);x.fillRect(450,90,70,420);x.fillRect(80,250,440,70);}
    else if(kind==='rectangle')x.fillRect(80,90,440,420);
    else {x.strokeStyle='#253252';x.lineWidth=30;x.beginPath();x.moveTo(70,350);x.bezierCurveTo(150,50,350,500,530,130);x.bezierCurveTo(540,430,150,220,100,450);x.stroke();}
    assert.equal(auto.silhouette(await auto.raster({buffer:c.toBuffer('image/png'),mime:'image/png'})),null,kind);
  }
});

const {multiMockup}=require('./fixtures/siparis/oto-multi');
const hoodieFlat={...flat,olculerL:{omuzdan_boy:71,etek:52,gogus:61,tum_omuz:61.5}};
// G39d: this fixture has 355px length and 264px underarm chest.
// L 71/61 averages to 2.1553mm/px; the old hem-based 2mm/px no longer applies.
const hoodieMmPerPx=(710/355+610/264)/2;
test('G24c two views without a design exclude lining, cords, piping and pocket; order is irrelevant',async()=>{
  for(const swap of [false,true])for(const position of ['gogus','sirt']) {
    const r=await auto.autoMeasure(input(multiMockup({swap}),{design:null,flat:hoodieFlat,product:'sweat',position}));
    const front=position==='gogus',b=r.measure_source.designBoxPx;
    assert.equal(r.measure_source.method,'otomatik_renk');assert.equal(r.measure_source.views.length,2);
    assert.equal(r.measure_source.selectedView,front?'on':'arka');
    assert.ok(Math.abs(b.x-(front?(swap?845:305):(swap?202:742)))<=2,JSON.stringify(r));
    assert.ok(Math.abs(b.y-235)<=2);assert.ok(Math.abs(b.w-(front?70:135))<=2);assert.ok(Math.abs(b.h-(front?40:60))<=2);
    assert.ok(Math.abs(r.width_mm-(front?151:291))<=3,JSON.stringify(r));
    assert.ok(Math.abs(r.height_mm-(front?86:129))<=3,JSON.stringify(r));
    assert.equal(r.measure_source.shoulderY,150);assert.ok(r.measure_source.viewScaleDifference<.05);
    assert.ok(Math.abs(r.measure_source.mmPerPx-hoodieMmPerPx)<.03);
  }
});
test('G24c unknown views and competing prints never invent a placement; empty garments have no print',async()=>{
  for(const options of [{ambiguous:true},{repeated:true},{missing:true}]) {
    const r=await auto.autoMeasure(input(multiMockup(options),{design:null,flat:hoodieFlat,product:'sweat'}));
    assert.equal(r.needs_confirmation,true,JSON.stringify(r));assert.equal(r.width_mm,null,JSON.stringify(r));
    if(options.ambiguous)assert.match(r.reason,/görünüm teyit/);
    if(options.repeated)assert.match(r.reason,/yerleşim teyit/);
  }
});
test('G24c touching lower sleeves split only from independent upper bodies',async()=>{
  for(const position of ['gogus','sirt']) {
    const r=await auto.autoMeasure(input(multiMockup({touching:true}),{design:null,flat:hoodieFlat,product:'sweat',position}));
    assert.equal(r.measure_source.views.length,2,JSON.stringify(r));
    assert.ok(r.measure_source.views.every(v=>v.view!=='teyit'),JSON.stringify(r));
    assert.ok(Math.abs(r.width_mm-(position==='gogus'?151:291))<=3,JSON.stringify(r));
    assert.ok(Math.abs(r.measure_source.designBoxPx.x-(position==='gogus'?305:582))<=2);
    assert.ok(r.measure_source.viewScaleDifference<.05);
  }
});
test('G24c view scale differences above 5% and axis differences above 15% require confirmation',async()=>{
  const scaled=await auto.autoMeasure(input(multiMockup({backScale:.82}),{design:null,flat:hoodieFlat,product:'sweat',position:'sirt'}));
  assert.ok(scaled.measure_source.viewScaleDifference>.05);assert.match(scaled.reason,/%5/);assert.equal(scaled.needs_confirmation,true);
  const m=mockup(),within=await auto.autoMeasure(input(m,{flat:{...flat,olculerL:{omuzdan_boy:102,etek:60}}}));
  assert.ok(within.measure_source.scaleDifference>.08&&within.measure_source.scaleDifference<.15);
  assert.equal(within.needs_confirmation,false,JSON.stringify(within));
  assert.equal(within.measure_source.mmPerPx,(within.measure_source.verticalMmPerPx+within.measure_source.horizontalMmPerPx)/2);
});
test('G40 ayrı desen oranı uyuşmazsa veya içerik okunamazsa renk kutusu yalnız aday kalır',async()=>{
  const m=multiMockup(),options={flat:hoodieFlat,product:'sweat',position:'sirt'};
  const blank=await PDFDocument.create();blank.addPage([180,80]);
  const tall=await PDFDocument.create(),page=tall.addPage([180,80]),ink=rgb(1,1,1);
  // The page ratio agrees with the mock-up's wide motif. The actual white artwork is tall.
  page.drawRectangle({x:20,y:6,width:10,height:45,color:ink});
  page.drawRectangle({x:36,y:7,width:15,height:7,color:ink});
  page.drawRectangle({x:26,y:45,width:9,height:6,color:ink});
  for(const artwork of [tall,blank,null]) {
    const design=artwork?{buffer:Buffer.from(await artwork.save()),mime:'application/pdf'}:{buffer:Buffer.from('invalid'),mime:'image/png'};
    const r=await auto.autoMeasure(input(m,{...options,design})),source=r.measure_source;
    assert.equal(source.method,'otomatik_renk',JSON.stringify(r));
    assert.ok(source.candidateBoxPx.w/source.candidateBoxPx.h>2,JSON.stringify(r));
    assert.equal(source.designBoxPx,null);
    assert.equal(r.width_mm,null);assert.equal(r.height_mm,null);assert.equal(r.needs_confirmation,true);
    if(artwork===tall) {
      assert.equal(source.aspectReferencePage,1);
      assert.ok(Math.abs(source.designAspectRatio-31/45)<.02);
      assert.match(r.reason,/en-boy oranı .* uyuşmuyor.*sınır %30/);
    } else {
      assert.equal(source.designAspectRatio,null);
      assert.match(r.reason,/okunur içerik kutusu yok/);
    }
  }
  const unlinked=await auto.autoMeasure(input(m,{...options,design:null}));
  assert.equal(unlinked.needs_confirmation,false,JSON.stringify(unlinked));
  assert.ok(Math.abs(unlinked.width_mm-291)<=3,JSON.stringify(unlinked));
  const nearRatio=await auto.autoMeasure(input(m,{...options,design:{buffer:mockup().design,mime:'image/png'}}));
  assert.equal(nearRatio.measure_source.method,'otomatik_renk',JSON.stringify(nearRatio));
  assert.equal(nearRatio.needs_confirmation,false,JSON.stringify(nearRatio));
  assert.equal(nearRatio.width_mm,unlinked.width_mm);
});
test('G40 beyaz PDF deseni saydam zeminde ve dört kenarı tek renk olan provada eşleşir',async()=>{
  const m=multiMockup(),options={flat:hoodieFlat,product:'sweat',position:'sirt'};
  for(const matte of [false,true]) {
    const design=await PDFDocument.create(),page=design.addPage([175,100]);
    if(matte)page.drawRectangle({x:0,y:0,width:175,height:100,color:rgb(.10,.14,.20)});
    const w=135,h=60,ink=rgb(1,1,1);
    const rect=(x,y,width,height)=>page.drawRectangle({x:20+x,y:80-y-height,width,height,color:ink});
    rect(0,0,w*.24,h*.65);rect(w*.32,0,w*.68,h*.65);rect(w*.16,h*.78,w*.84,h*.22);
    const r=await auto.autoMeasure(input(m,{...options,design:{buffer:Buffer.from(await design.save()),mime:'application/pdf'}}));
    assert.equal(r.measure_source.selectedDesignPage,1,JSON.stringify(r));
    assert.equal(r.needs_confirmation,false,JSON.stringify(r));
    assert.ok(Math.abs(r.width_mm-291)<=8 && Math.abs(r.height_mm-130)<=8,JSON.stringify(r));
  }
});
test('G24c API uploads the same two-view hoodie for both applications without a design and preserves manual edits',async t=>{
  const f=await fixture(t),o=await f.order({lines:[{product_key:'sweat',quantity:1,sizes:{L:1}}]}),v=o.version.id,line=o.version.lines[0],m=multiMockup();
  addFlat(f,'sweat');f.db.prepare('UPDATE document_flats SET olculerL=?').run(JSON.stringify(hoodieFlat.olculerL));
  for(const view of ['on','arka'])ok(await f.upload(v,{kind:'urun_gorsel',lineId:line.id,gorunum:view,buffer:m.image}),201);
  const apps=[];
  for(const [kind,position,width] of [['nakis','gogus',151],['baski','sirt',291]]) {
    const app=ok(await f.post(`/satirlar/${line.id}/uygulamalar`,{kind,position}),201);apps.push(app);
    assert.ok(Math.abs(app.width_mm-width)<=3,JSON.stringify(app));assert.equal(JSON.parse(app.measure_source).method,'otomatik_renk');
    assert.equal(JSON.parse(app.measure_source).desenFileId,null);
  }
  assert.equal(f.db.prepare("SELECT count(*) n FROM files WHERE kind='desen_kaynak'").get().n,0);
  assert.equal(ok(await f.post(`/surumler/${v}/otomatik-olc`)).results.length,2);
  ok(await f.request(`/uygulamalar/${apps[0].id}`,{method:'PATCH',token:f.token,body:{width_mm:155,height_mm:85}}));
  assert.equal(ok(await f.post(`/surumler/${v}/otomatik-olc`)).results.length,1);
  assert.equal(f.db.prepare('SELECT width_mm FROM applications WHERE id=?').get(apps[0].id).width_mm,155);
});

test('G24d mild perspective with compatible scales is accepted; physical print width is checked against the torso',async()=>{
  const mild=await auto.autoMeasure(input(mockup({perspective:true})));
  assert.ok(mild.measure_source.symmetry>=.85);assert.equal(mild.needs_confirmation,false,JSON.stringify(mild));
  const {createCanvas,loadImage}=require('@napi-rs/canvas'),m=mockup({width:220}),c=createCanvas(600,650),x=c.getContext('2d');
  x.drawImage(await loadImage(m.image),0,0);x.fillStyle='#fafafa';x.fillRect(150,450,50,156);x.fillRect(400,450,50,156);
  const wide=await auto.autoMeasure(input({...m,image:c.toBuffer('image/png')},{flat:{...flat,olculerL:{omuzdan_boy:112,etek:40}}}));
  assert.ok(wide.measure_source.designBoxPx.w>wide.measure_source.hemWidthPx,JSON.stringify(wide));
  assert.equal(wide.needs_confirmation,true);assert.match(wide.reason,/Desen eni [0-9.,]+ piksel, ürün gövde eninden/);
});
test('G24d asymmetric product masks identify their measured symmetry and threshold',async()=>{
  const {createCanvas,loadImage}=require('@napi-rs/canvas'),m=mockup(),c=createCanvas(600,650),x=c.getContext('2d');
  x.drawImage(await loadImage(m.image),0,0);x.fillStyle='#fafafa';x.fillRect(150,360,65,240);
  const r=await auto.autoMeasure(input({...m,image:c.toBuffer('image/png')}));
  assert.ok(r.measure_source.symmetry<.85&&r.measure_source.symmetry>=.75,JSON.stringify(r));
  assert.equal(r.needs_confirmation,true);assert.match(r.reason,/sol-sağ simetrisi %[0-9,]+; %85,0 sınırının altında/);
});
test('G24d axis scale thresholds: mean to 15%, mockup geometric mean to 35%, none above',async()=>{
  const m=mockup(),baseline=await auto.autoMeasure(input(m)),s=baseline.measure_source;
  for(const difference of [.149999,.15,.15001,.35,.35001]) {
    const vertical=2*(2+difference)/(2-difference),r=await auto.autoMeasure(input(m,{flat:{...flat,olculerL:{omuzdan_boy:vertical*s.bodyHeightPx/10,etek:2*s.hemWidthPx/10}}}));
    const v=r.measure_source.verticalMmPerPx,h=r.measure_source.horizontalMmPerPx;
    if(difference<=.15){assert.equal(r.needs_confirmation,false,JSON.stringify(r));assert.ok(r.width_mm>0);assert.equal(r.measure_source.scaleMode,undefined);assert.equal(r.measure_source.mmPerPx,(v+h)/2);}
    else if(difference<=.35){assert.equal(r.needs_confirmation,false,JSON.stringify(r));assert.equal(r.measure_source.scaleMode,'geo_ortalama');assert.ok(Math.abs(r.measure_source.mmPerPx-Math.sqrt(v*h))<1e-9);assert.match(r.measure_source.scaleNote,/Mockup oranı kalıptan farklı \(%[0-9,]+\); ölçek boy ile etek ortalaması/);}
    else {assert.equal(r.needs_confirmation,true);assert.equal(r.width_mm,null);assert.match(r.reason,/Boy\/etek ölçek farkı %35,001; %35 sınırını aşıyor/);}
  }
});
