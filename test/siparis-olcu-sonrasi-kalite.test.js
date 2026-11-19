'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {PNG}=require('pngjs');
const documents=require('../agent/siparis/documents');
const {setup}=require('./fixtures/siparis/belge-fixture');

async function fixture(t) {
  const f=await setup();
  t.after(async()=> {await documents.settled();await f.close();fs.rmSync(f.dir,{recursive:true,force:true});});
  return f;
}
// Bold filled rectangle on a transparent canvas; synthetic.
function boldPng(w=400,h=200) {
  const png=new PNG({width:w,height:h});
  for (let y=0;y<h;y++) for (let x=0;x<w;x++) {
    const i=(y*w+x)*4,on=x>40 && x<w-40 && y>30 && y<h-30;
    png.data[i]=on?35:255;png.data[i+1]=on?80:255;png.data[i+2]=on?170:255;png.data[i+3]=on?255:0;
  }
  return PNG.sync.write(png);
}
// Hairline stripes on a transparent canvas; synthetic.
function thinPng(w=1400,h=600) {
  const png=new PNG({width:w,height:h});
  for (let y=0;y<h;y++) for (let x=0;x<w;x++) {
    const i=(y*w+x)*4,on=y%40===0 && x>50 && x<w-50;
    png.data[i]=on?0:255;png.data[i+1]=on?0:255;png.data[i+2]=on?0:255;png.data[i+3]=on?255:0;
  }
  return PNG.sync.write(png);
}
const status=async(f,id)=>(await f.request(`/surumler/${id}/vektor-durum`,{token:f.token})).data[0];
const open=(f,fileId)=>f.db.prepare("SELECT count(*) n FROM confirmations WHERE kind='vektor_kalite' AND ref_id=? AND status='acik'").get(fileId).n;

test('G30 snapshot carries desenDosyaId per application', {timeout:60000}, async t=> {
  const f=await fixture(t);
  const o=await f.order(), id=o.version.id, lineId=o.version.lines[0].id;
  const up=await f.upload(id);await documents.settled();
  assert.equal((await f.measure(lineId,{})).status,201);
  const bound=await f.measure(lineId,{desenDosyaId:up.data.id});assert.equal(bound.status,201);
  await documents.settled();
  const snap=(await f.request(`/surumler/${id}`,{token:f.token})).data;
  const apps=(snap.version||snap).lines[0].applications;
  assert.ok(apps.some(a=>a.desenDosyaId===up.data.id));
  assert.ok(apps.some(a=>a.desenDosyaId===null));
});

test('G30 plain artwork: beklemede becomes iyi after a measure, with reasons in the status', {timeout:90000}, async t=> {
  const f=await fixture(t);
  const o=await f.order(), id=o.version.id, lineId=o.version.lines[0].id;
  const up=await f.upload(id,{buffer:boldPng()});await documents.settled();
  const before=await status(f,id);
  assert.equal(before.quality,'beklemede');assert.deepEqual(before.reasons,[]);
  assert.equal((await f.measure(lineId,{desenDosyaId:up.data.id,designBoxPx:{w:319,h:139},refLengthPx:638,refLengthCm:56})).status,201);
  await documents.settled();
  const after=await status(f,id);
  assert.equal(after.quality,'iyi',JSON.stringify(after));assert.ok(Array.isArray(after.reasons));assert.ok(after.targetMm.w>0);
  assert.equal(open(f,after.previewFileId),0);
});

test('G30 hairline artwork: teyit with a single open confirmation, even when measured twice', {timeout:120000}, async t=> {
  const f=await fixture(t);
  const o=await f.order(), id=o.version.id, lineId=o.version.lines[0].id;
  const up=await f.upload(id,{buffer:thinPng()});await documents.settled();
  assert.equal((await status(f,id)).quality,'beklemede');
  const body={desenDosyaId:up.data.id,designBoxPx:{w:1400,h:600},refLengthPx:2800,refLengthCm:56};
  assert.equal((await f.measure(lineId,body)).status,201);
  await documents.settled();
  const row=await status(f,id);
  assert.equal(row.quality,'teyit');assert.equal(row.status,'teyit');assert.ok(row.reasons.length>0);
  assert.equal(open(f,row.previewFileId),1);
  assert.equal((await f.measure(lineId,body)).status,201);
  await documents.settled();
  assert.equal(open(f,(await status(f,id)).previewFileId),1);
});
