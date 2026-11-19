'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const flats=require('../agent/siparis/flats');
const documents=require('../agent/siparis/documents');
const {setup}=require('./fixtures/siparis/belge-fixture');
const {mockup}=require('./fixtures/siparis/oto-mockup');

async function fixture(t) {
  const f=await setup();
  t.after(async()=> {await documents.settled();await f.close();fs.rmSync(f.dir,{recursive:true,force:true});});
  return f;
}
function addFlat(f,view) {
  const root=path.join(fs.realpathSync(f.dir),'siparis','flats');fs.mkdirSync(root,{recursive:true});
  const filename=path.join(root,view+'.png');fs.writeFileSync(filename,mockup({missing:true}).image);
  f.db.prepare('INSERT INTO document_flats(id,ad,urun,gorunum,dosya,refLengthCm,refLengthPx,refBeden,olculerL) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('tisort'+view,'Sentetik',  'tisort',view,filename,60,300,'L',JSON.stringify({omuzdan_boy:112.2,etek:60}));
}

test('G31 a failing automatic measurement after save still returns 201, keeps one file and queues the preview', {timeout:60000}, async t=> {
  const f=await fixture(t);
  const o=await f.order(), id=o.version.id, lineId=o.version.lines[0].id;
  addFlat(f,'on');
  assert.equal((await f.post(`/satirlar/${lineId}/uygulamalar`,{kind:'baski',position:'gogus'})).status,201);
  assert.equal((await f.upload(id,{kind:'urun_gorsel',lineId,gorunum:'on',buffer:mockup().image})).status,201);
  const original=flats.list;
  flats.list=()=> {throw new Error('kuyruk dolu');};
  let up;
  try { up=await f.upload(id,{lineId}); } finally { flats.list=original; }
  assert.equal(up.status,201);assert.match(up.data.olcuHatasi,/Otomatik ölçü/);
  assert.equal(f.db.prepare("SELECT count(*) n FROM files WHERE version_id=? AND kind='desen_kaynak'").get(id).n,1);
  const status=(await f.request(`/surumler/${id}/vektor-durum`,{token:f.token})).data;
  assert.equal(status.length,1);assert.equal(status[0].sourceFileId,up.data.id);
});

test('G31 editing one application does not re-measure a resolved, unchanged sibling', {timeout:60000}, async t=> {
  const f=await fixture(t);
  const o=await f.order(), id=o.version.id, lineId=o.version.lines[0].id;
  addFlat(f,'on');addFlat(f,'arka');
  for (const [view,position] of [['on','gogus'],['arka','sirt']])
    assert.equal((await f.upload(id,{kind:'urun_gorsel',lineId,gorunum:view,buffer:mockup({position}).image})).status,201);
  const a=(await f.post(`/satirlar/${lineId}/uygulamalar`,{kind:'baski',position:'gogus'})).data;
  const b=(await f.post(`/satirlar/${lineId}/uygulamalar`,{kind:'baski',position:'sol_gogus'})).data;
  const runs=appId=>f.db.prepare("SELECT count(*) n FROM audit_log WHERE action='uygulama_otomatik_olc' AND ref=?").get(String(appId)).n;
  f.db.prepare("INSERT INTO confirmations(kind,ref_table,ref_id,message,status) VALUES('olcu','applications',?,'teyit edildi','cozuldu')").run(a.id);
  const beforeA=runs(a.id),beforeB=runs(b.id);
  const edit=await f.request(`/uygulamalar/${b.id}`,{method:'PATCH',token:f.token,body:{position:'sirt'}});
  assert.equal(edit.status,200,JSON.stringify(edit.data));
  assert.equal(runs(a.id),beforeA);
  assert.ok(runs(b.id)>beforeB);
  assert.equal(f.db.prepare("SELECT count(*) n FROM confirmations WHERE kind='olcu' AND ref_id=? AND status='acik'").get(a.id).n,0);
});
