'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {setup}=require('./belge-fixture');

async function run() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'siparis-ornek-'));
  process.env.DATA_DIR=dir;
  // The demo only downloads a manual workshop package; it never starts a worker.
  const f=await setup({dataDir:dir});
  function ok(result) {
    if (result.status>=400) throw Error(`${result.status}: ${JSON.stringify(result.data)}`);
    return result.data;
  }
  try {
    const order=await f.order(); const id=order.version.id, lineId=order.version.lines[0].id;
    const source=ok(await f.upload(id));
    ok(await f.upload(id,{kind:'urun_gorsel',lineId,gorunum:'on'}));
    ok(await f.measure(lineId,{desenDosyaId:source.id}));
    ok(await f.measure(lineId,{kind:'nakis',position:'gogus',desenDosyaId:source.id,designBoxPx:{w:37.5,h:20}}));
    const files=ok(await f.post(`/surumler/${id}/hazirla`));
    for (const c of ok(await f.request('/teyitler',{token:f.managerToken})))
      if (c.kind==='vektor_kalite') ok(await f.post(`/teyitler/${c.id}/coz`,{},f.managerToken));
    ok(await f.post(`/surumler/${id}/gonder`));
    ok(await f.post(`/surumler/${id}/onay`,{fileId:files.find(file=>file.kind==='onay_formu').id},f.managerToken));
    const bundle=ok(await f.request(`/surumler/${id}/atolye-paketi`,{token:f.token}));
    fs.writeFileSync(path.join(dir,'atolye-paketi.json'),JSON.stringify(bundle,null,2));
    // Exercise authenticated downloads, too. Registered originals remain in files/.
    const downloads=path.join(dir,'indirilen-atolye-paketi'); fs.mkdirSync(downloads);
    for (const file of bundle.files) {
      const downloaded=ok(await f.request(`/dosyalar/${file.id}`,{token:f.token}));
      fs.writeFileSync(path.join(downloads,path.basename(file.path)),downloaded,{flag:'wx'});
    }
    console.log(`Çıktı klasörü: ${dir}`);
    console.log(`Sipariş ${order.order_no}: ${files.length} dosya, atölye paketinde ${bundle.files.length} dosya.`);
    return dir;
  } finally { await f.close(); }
}
if (require.main===module) run().catch(e=> {console.error(e.message);process.exitCode=1;});
module.exports={run};
