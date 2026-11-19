'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {PNG}=require('pngjs');
const {upload}=require('../agent/siparis/tools/duz-cizim-yukle');
const {setup}=require('./fixtures/siparis/belge-fixture');
// Invented data only: a tiny PNG and made-up measurements.
function temp(t){const p=fs.mkdtempSync(path.join(os.tmpdir(),'g26-test-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;}
function manifest(dir,over={}) {
  fs.mkdirSync(path.join(dir,'kirpilmis'),{recursive:true});
  fs.writeFileSync(path.join(dir,'kirpilmis','a.png'),PNG.sync.write(new PNG({width:8,height:8})));
  const row={dosya:'kirpilmis/a.png',ad:'Uydurma',urun:'tisort',gorunum:'on',refLengthPx:100,refLengthCm:54,refLengthCmM:52,refBeden:'L',refAciklama:'Göğüs genişliği, L = 54 cm',...over};
  const json=path.join(dir,'duz-cizimler.json');fs.writeFileSync(json,JSON.stringify([row]));return json;
}
test('dry run with --guncelle lists the M to L change',async t=>{
  const json=manifest(temp(t)),logs=[];
  await upload({api:'http://127.0.0.1:1',json,dry:true,update:true,getCredentials:()=>assert.fail('login'),fetchImpl:()=>assert.fail('network'),log:s=>logs.push(s)});
  assert.match(logs.join('\n'),/GÜNCELLENECEK: Uydurma — M 52 → L 54/);
});
test('--guncelle updates an existing flat reference; without it the flat is skipped; old rows have null refBeden',async t=>{
  const dir=temp(t),dataDir=path.join(dir,'DATA_DIR');fs.mkdirSync(dataDir);const f=await setup({dataDir});t.after(()=>f.close());
  const common={getCredentials:async()=>({name:f.manager.name,password:'synthetic-password'}),log:()=>{}};
  // First upload with the old M reference and no refBeden.
  const old=manifest(dir,{refLengthCm:52,refBeden:undefined,refAciklama:'Göğüs, M = 52 cm'});
  assert.deepEqual(await upload({...common,api:f.base,json:old}),{uploaded:1,skipped:0});
  let flat=(await f.request('/duz-cizimler',{token:f.managerToken})).data[0];assert.equal(flat.refLengthCm,52);assert.equal(flat.refBeden,null);
  const json=manifest(dir);
  assert.deepEqual(await upload({...common,api:f.base,json}),{uploaded:0,skipped:1});
  assert.equal((await f.request('/duz-cizimler',{token:f.managerToken})).data[0].refLengthCm,52);
  assert.deepEqual(await upload({...common,api:f.base,json,update:true}),{uploaded:1,skipped:0});
  flat=(await f.request('/duz-cizimler',{token:f.managerToken})).data[0];
  assert.equal(flat.refLengthCm,54);assert.equal(flat.refBeden,'L');assert.equal(flat.refLengthPx,100);assert.match(flat.refAciklama,/L = 54/);
  assert.deepEqual(await upload({...common,api:f.base,json,update:true}),{uploaded:0,skipped:1});
});
