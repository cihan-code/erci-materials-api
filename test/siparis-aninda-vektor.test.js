'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const childProcess=require('node:child_process');
const documents=require('../agent/siparis/documents');
const {setup}=require('./fixtures/siparis/belge-fixture');

async function fixture(t) {
  const f=await setup();
  t.after(async()=> {await documents.settled();await f.close();fs.rmSync(f.dir,{recursive:true,force:true});});
  return f;
}
const previews=(f,id)=>f.db.prepare("SELECT * FROM files WHERE version_id=? AND kind='desen_vektor_onizleme'").all(id);

test('G25 upload returns at once, then a natural-size vector preview becomes ready and downloadable', {timeout:60000}, async t=> {
  const f=await fixture(t);
  const o=await f.order(), id=o.version.id;
  const up=await f.upload(id);assert.equal(up.status,201);
  const first=(await f.request(`/surumler/${id}/vektor-durum`,{token:f.token})).data;
  assert.equal(first.length,1);assert.equal(first[0].sourceFileId,up.data.id);
  await documents.settled();
  const [row]=(await f.request(`/surumler/${id}/vektor-durum`,{token:f.token})).data;
  assert.ok(['hazir','teyit'].includes(row.status));assert.ok(row.previewFileId);
  const dl=await f.request(`/dosyalar/${row.previewFileId}`,{token:f.token});
  assert.equal(dl.status,200);assert.equal(dl.data.subarray(0,4).toString(),'%PDF');
  if (row.status==='teyit') assert.equal(f.db.prepare("SELECT count(*) n FROM confirmations WHERE kind='vektor_kalite' AND ref_id=? AND status='acik'").get(row.previewFileId).n,1);
});

test('G25 product images get no preview; failure is stored as hata', {timeout:60000}, async t=> {
  const f=await fixture(t);
  const o=await f.order(), id=o.version.id;
  const img=await f.upload(id,{kind:'urun_gorsel',lineId:o.version.lines[0].id,gorunum:'on'});assert.equal(img.status,201);
  assert.equal((await f.request(`/surumler/${id}/vektor-durum`,{token:f.token})).data.length,0);
  const bad=await f.upload(id,{buffer:Buffer.from('%PDF-1.4 bozuk'),name:'bozuk.pdf',mime:'application/pdf'});
  if (bad.status===201) {
    await documents.settled();
    assert.equal((await f.request(`/surumler/${id}/vektor-durum`,{token:f.token})).data[0].status,'hata');
  }
});

test('G25 prepare scales the ready preview instead of tracing again and keeps the workshop package unchanged', {timeout:90000}, async t=> {
  const f=await fixture(t);
  const o=await f.order(), id=o.version.id;
  const up=await f.upload(id);await documents.settled();
  assert.equal(previews(f,id).length,1);
  assert.equal((await f.measure(o.version.lines[0].id,{desenDosyaId:up.data.id})).status,201);
  const jobs=[], fork=childProcess.fork;
  t.mock.method(childProcess,'fork',(...args)=> {
    const child=fork(...args), send=child.send.bind(child);
    child.send=(m,cb)=> {jobs.push(m);return send(m,cb);};
    return child;
  });
  const prep=await f.post(`/surumler/${id}/hazirla`);
  t.mock.restoreAll();
  const vectorJobs=jobs.filter(j=>j.type==='vector');
  assert.equal(vectorJobs.length,1);assert.equal(vectorJobs[0].input.manualVector,true);assert.equal(vectorJobs[0].input.mime,'application/pdf');
  assert.equal(prep.status,200);
  const kinds=prep.data.map(x=>x.kind);
  assert.equal(kinds.filter(k=>k==='desen_vektor').length,1);
  assert.equal(kinds.filter(k=>k==='desen_vektor_onizleme').length,1);
  const vec=prep.data.find(x=>x.kind==='desen_vektor');
  const pdf=(await f.request(`/dosyalar/${vec.id}`,{token:f.token})).data;
  assert.equal(pdf.subarray(0,4).toString(),'%PDF');
  // The preview appearing in the snapshot must not make prepared forms look stale.
  assert.equal((await f.post(`/surumler/${id}/hazirla`)).status,200);
  assert.ok(documents.WORKSHOP.every(k=>k!=='desen_vektor_onizleme'));
});
