'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const childProcess=require('node:child_process');
const documents=require('../agent/siparis/documents');
const {setup,designPng}=require('./fixtures/siparis/belge-fixture');
const {mockup}=require('./fixtures/siparis/oto-mockup');
async function fixture(t) {
  const f=await setup();
  t.after(async()=>{await documents.settled();await f.close();fs.rmSync(f.dir,{recursive:true,force:true});});
  f.flat=(id,ad,urun='sweat',refBeden='L')=>f.db.prepare('INSERT INTO document_flats(id,ad,urun,gorunum,dosya,refBeden,refLengthCm,olculerL) VALUES(?,?,?,?,?,?,?,?)')
    .run(id,ad,urun,'on','synthetic.png',refBeden,60,JSON.stringify({omuzdan_boy:112.2,etek:60,gogus:60}));
  f.read=async id=>(await f.request(`/surumler/${id}`,{token:f.token})).data;
  f.patch=(id,kalipId)=>f.request(`/satirlar/${id}`,{method:'PATCH',token:f.token,body:{kalipId}});
  return f;
}
test('G39b regular product name selects the unique L default and exposes candidates',async t=>{
  const f=await fixture(t);
  f.flat('regular','SWEAT');f.flat('over','OWERSİZE SWEAT');f.flat('zip','ZIP SWEAT');f.flat('old','SWEAT','sweat','M');
  const o=await f.order({lines:[{product_key:'sweat',quantity:1}]});
  const line=o.version.lines[0];assert.equal(line.kalipId,'regular');
  assert.equal(line.kalipAdaylari.length,3);assert.deepEqual(Object.keys(line.kalipAdaylari[0]),['id','ad','refBeden']);
  f.flat('tee','TİŞÖRT','tisort');f.flat('tee-over','OVERSIZE TİŞÖRT','tisort');
  assert.equal((await f.order()).version.lines[0].kalipId,'tee');
  f.flat('hood','SWEAT','kapusonlu');f.flat('hood-over','OVERSIZE SWEAT','kapusonlu');
  assert.equal((await f.order({lines:[{product_key:'kapusonlu',quantity:1}]})).version.lines[0].kalipId,'hood');
});
test('G39b ambiguous defaults keep dimensions empty and ask for a pattern',async t=>{
  const f=await fixture(t);f.flat('a','SWEAT');f.flat('b','SWEAT');
  const o=await f.order({lines:[{product_key:'sweat',quantity:1,applications:[{kind:'baski',position:'gogus'}]}]});
  const line=o.version.lines[0];assert.equal(line.kalipId,null);
  const up=await f.upload(o.version.id,{kind:'urun_gorsel',lineId:line.id,gorunum:'on',buffer:mockup().image});assert.equal(up.status,201);
  const app=(await f.read(o.version.id)).lines[0].applications[0];assert.equal(app.width_mm,null);assert.equal(app.needs_confirmation,1);
  assert.match(f.db.prepare("SELECT message FROM confirmations WHERE ref_id=? AND kind='olcu' AND status='acik'").get(app.id).message,/Bu ürün için birden çok kalıp var; kalıbı seçin/);
});
test('G39b selecting a candidate persists, audits, remeasures only that line and survives revision',async t=>{
  const f=await fixture(t);f.flat('regular','SWEAT');f.flat('over','OVERSIZE SWEAT');f.flat('foreign','TİŞÖRT','tisort');
  const lines=[1,2].map(()=>({product_key:'sweat',quantity:1,applications:[{kind:'baski',position:'gogus'}]}));
  const o=await f.order({lines});
  for(const line of o.version.lines) await f.upload(o.version.id,{kind:'urun_gorsel',lineId:line.id,gorunum:'on',buffer:mockup().image});
  const before=f.db.prepare("SELECT count(*) n FROM audit_log WHERE action='uygulama_otomatik_olc'").get().n;
  for(const id of ['foreign','missing',null,12])assert.equal((await f.patch(o.version.lines[0].id,id)).status,400);
  assert.equal(f.db.prepare("SELECT count(*) n FROM audit_log WHERE action='satir_kalip_sec'").get().n,0);
  const edited=await f.patch(o.version.lines[0].id,'over');assert.equal(edited.status,200,JSON.stringify(edited.data));assert.equal(edited.data.kalipId,'over');
  assert.equal(JSON.parse(edited.data.applications[0].measure_source).flatAd,'OVERSIZE SWEAT');
  assert.equal(f.db.prepare("SELECT count(*) n FROM audit_log WHERE action='uygulama_otomatik_olc'").get().n,before+1);
  assert.equal(f.db.prepare("SELECT count(*) n FROM audit_log WHERE action='satir_kalip_sec'").get().n,1);
  assert.equal((await f.read(o.version.id)).lines[0].kalipId,'over');
  const revised=await f.post(`/surumler/${o.version.id}/revizyon`,{});assert.equal(revised.status,201,JSON.stringify(revised.data));assert.equal(revised.data.lines[0].kalipId,'over');
  assert.equal((await f.patch(o.version.lines[0].id,'regular')).status,409);
});
test('G39b previews and automatic measurements across databases share one worker slot',async t=>{
  const a=await fixture(t),b=await fixture(t),fork=childProcess.fork;
  let active=0,peak=0;const kinds=new Set();
  t.mock.method(childProcess,'fork',(...args)=>{
    const child=fork(...args);active++;peak=Math.max(peak,active);
    const send=child.send.bind(child);child.send=(job,...rest)=>{kinds.add(job.type);return send(job,...rest);};
    child.once('close',()=>active--);return child;
  });
  a.flat('regular','SWEAT');
  const o=await a.order({lines:[{product_key:'sweat',quantity:1,applications:[{kind:'baski',position:'gogus'}]}]});
  const other=await b.order();
  await Promise.all([a.upload(o.version.id,{kind:'urun_gorsel',lineId:o.version.lines[0].id,gorunum:'on',buffer:mockup().image}),b.upload(other.version.id,{buffer:designPng(2400,1800)})]);
  await documents.settled();assert.deepEqual([...kinds].sort(),['autoMeasure','raster','vector']);assert.equal(peak,1);assert.equal(active,0);
  const report=JSON.parse(b.db.prepare('SELECT report_json FROM document_vector_previews').get().report_json);
  assert.ok(Math.abs(report.pages[0].widthMm-2400*25.4/96)<.5);
  assert.ok(Math.abs(report.pages[0].heightMm-1800*25.4/96)<.5);
});

test('G39b choosing the current default recalculates once and repeating it preserves the result',async t=>{
  const f=await fixture(t);f.flat('regular','SWEAT');f.flat('over','OWERSIZE SWEAT');
  const o=await f.order({lines:[{product_key:'sweat',quantity:1,applications:[{kind:'baski',position:'gogus'}]}]});
  const line=o.version.lines[0],sample=mockup();
  await f.upload(o.version.id,{kind:'urun_gorsel',lineId:line.id,gorunum:'on',buffer:sample.image});
  const source=await f.upload(o.version.id,{lineId:line.id,buffer:sample.design});
  await f.request(`/uygulamalar/${line.applications[0].id}`,{method:'PATCH',token:f.token,body:{desenDosyaId:source.data.id}});
  const first=await f.patch(line.id,'regular');assert.equal(first.status,200);assert.ok(first.data.applications[0].width_mm>0);
  const second=await f.patch(line.id,'regular');assert.equal(second.status,200);assert.equal(second.data.applications[0].width_mm,first.data.applications[0].width_mm);
  const appId=line.applications[0].id;
  await f.request(`/uygulamalar/${appId}`,{method:'PATCH',token:f.token,body:{width_mm:123,height_mm:45}});
  const manual=await f.patch(line.id,'over');assert.equal(manual.status,200);assert.equal(manual.data.applications[0].width_mm,123);
});
