'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const childProcess=require('node:child_process');
const documents=require('../agent/siparis/documents');
const {setup}=require('./fixtures/siparis/belge-fixture');
const workerFixture=path.join(__dirname,'fixtures/siparis/render-worker.cjs');
const svgJob={type:'vector',input:{mime:'image/svg+xml',targetMm:{w:280,h:120},
  buffer:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 60"><rect width="140" height="60" fill="#2350aa"/></svg>')}};
const isTimeout=e=>e.status===504 && e.code==='PREPARE_TIMEOUT' && e.message==='Hazırlama zaman aşımına uğradı';

function interceptWorker(t,mode) {
  const fork=childProcess.fork, children=[];
  t.mock.method(childProcess,'fork',(filename,args,options)=> {
    const child=mode==='hold-open'
      ? fork(filename,args,{...options,execArgv:['--require',workerFixture]})
      : fork(workerFixture,[mode],options);
    children.push(child);
    return child;
  });
  t.after(()=> {for (const child of children) if (child.exitCode===null && child.signalCode===null) child.kill('SIGKILL');});
  return children;
}

test('G20 completed and failed renderers exit even with a retained handle', {timeout:15000}, async t=> {
  const children=interceptWorker(t,'hold-open');
  const result=await documents.generateInChild(svgJob,undefined,{timeoutMs:5000});
  assert.ok(Buffer.isBuffer(result.pdf));assert.equal(result.pdf.subarray(0,4).toString(),'%PDF');
  await assert.rejects(documents.generateInChild({type:'vector',input:{mime:'application/pdf',buffer:Buffer.from('%PDF-broken')}},undefined,{timeoutMs:5000}),/Invalid PDF/);
  assert.equal(children.length,2);
  for (const child of children) {assert.equal(child.exitCode,0);assert.equal(child.signalCode,null);}
});

test('G20 hung worker is SIGKILLed; queued real render starts only after close', {timeout:15000}, async t=> {
  const children=interceptWorker(t,'hang');
  const queue=documents.createRenderQueue({timeoutMs:10000,lockMs:11000});
  let closed=false;
  const hung=queue(signal=> {
    const work=documents.generateInChild({},signal,{timeoutMs:100});
    children[0].once('close',()=> {closed=true;});
    return work;
  });
  const rejection=assert.rejects(hung,isTimeout);
  const next=queue(signal=> {
    assert.equal(closed,true);assert.equal(children[0].signalCode,'SIGKILL');
    t.mock.restoreAll();
    return documents.generateInChild(svgJob,signal,{timeoutMs:5000});
  });
  await rejection;
  assert.ok(Buffer.isBuffer((await next).pdf));
});

test('G20 whole preparation deadline kills the worker and releases the queue', {timeout:10000}, async t=> {
  const children=interceptWorker(t,'hang');
  const queue=documents.createRenderQueue({timeoutMs:100,lockMs:200});
  let closed=false;
  await assert.rejects(queue(signal=> {
    const work=documents.generateInChild({},signal,{timeoutMs:5000});
    children[0].once('close',()=> {closed=true;});
    return work;
  }),isTimeout);
  await queue(async()=> {assert.equal(closed,true);assert.equal(children[0].signalCode,'SIGKILL');});
});

test('G20 advanced IPC drains a large Buffer before worker close', {timeout:10000}, async t=> {
  interceptWorker(t,'large');
  const result=await documents.generateInChild({},undefined,{timeoutMs:5000});
  assert.deepEqual(result,Buffer.alloc(8*1024*1024,0xa5));
});

test('G20 missing result, early disconnect and failed spawn settle without blocking', {timeout:15000}, async t=> {
  for (const mode of ['exit','disconnect']) {
    const children=interceptWorker(t,mode);
    await assert.rejects(documents.generateInChild({},undefined,{timeoutMs:5000}),/Vektör süreci/);
    assert.ok(children[0].exitCode!==null || children[0].signalCode!==null);
    t.mock.restoreAll();
  }
  const fork=childProcess.fork;
  t.mock.method(childProcess,'fork',(filename,args,options)=>fork(filename,args,{...options,execPath:'/nonexistent-g20-node'}));
  await assert.rejects(documents.generateInChild({},undefined,{timeoutMs:5000}),{code:'ENOENT'});
});

test('G20 HTTP timeout clears the lock, leaves no partial files and opens one confirmation', {timeout:15000}, async t=> {
  const f=await setup();
  t.after(async()=> {await f.close();fs.rmSync(f.dir,{recursive:true,force:true});});
  const o=await f.order(), id=o.version.id;
  const source=await f.upload(id);assert.equal(source.status,201);
  assert.equal((await f.measure(o.version.lines[0].id,{desenDosyaId:source.data.id})).status,201);
  const children=interceptWorker(t,'hang');
  // Exercise the actual worker timer and HTTP error path without waiting two minutes.
  const setTimer=global.setTimeout;
  t.mock.method(global,'setTimeout',(fn,ms,...args)=>setTimer(fn,ms===120000 ? 100 : ms,...args));
  for (let i=0;i<2;i++) {
    const response=await f.post(`/surumler/${id}/hazirla`);
    assert.equal(response.status,504);assert.equal(response.data.error,'Hazırlama zaman aşımına uğradı');
    assert.equal(children[i].signalCode,'SIGKILL');
    assert.equal(f.db.prepare('SELECT token FROM document_preparations WHERE version_id=?').get(id).token,null);
    assert.equal(f.db.prepare('SELECT count(*) n FROM files WHERE version_id=?').get(id).n,1);
  }
  const confirmations=f.db.prepare("SELECT * FROM confirmations WHERE kind='baglanti_hatasi' AND ref_table='order_versions' AND ref_id=? AND status='acik'").all(id);
  assert.equal(confirmations.length,1);assert.equal(confirmations[0].message,'Hazırlama zaman aşımına uğradı');
  t.mock.restoreAll();
  assert.equal((await f.post(`/surumler/${id}/hazirla`)).status,200);
});
