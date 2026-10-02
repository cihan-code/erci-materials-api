'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('fs'),path=require('path'),os=require('os');const {spawn}=require('child_process');
test('real HTTP report and undo synchronize kanban, stale tab cannot overwrite, paid interpretation is idempotent',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stage-http-'));
 fs.writeFileSync(path.join(dir,'panel-data.json'),JSON.stringify({data:{jobs:[],uretimTakip:[{id:7,customer_name:'Synthetic',quantity:100,status:'Kesimde',decoration:'baski'}]},updatedAt:'2026-10-02T05:00:00Z',auth:{test:true}}));
 const script=`let calls=0;const p=require.resolve('./agent/claude');require.cache[p]={id:p,filename:p,loaded:true,exports:{callClaude:async opts=>{require('fs').writeFileSync(${JSON.stringify(path.join(dir,'calls'))},String(++calls));return {model:'test',costUsd:0,text:JSON.stringify({clarification:'',entries:[{op:'print_dropoff',status:'completed',remaining:null,reason:'',issue:null,evidence:JSON.parse(opts.user).report}]})}}}};require('./server');`;
 const port=18000+Math.floor(Math.random()*10000),base='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,['-e',script],{cwd:path.join(__dirname,'..'),env:{...process.env,DATA_DIR:dir,API_KEY:'synthetic-key',PORT:String(port),TYPESAFE_API_KEY:'',ANTHROPIC_API_KEY:'test-placeholder',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
 let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
 const request=async(route,body)=>{const r=await fetch(base+'/api/'+route,{method:body?'POST':'GET',headers:{'x-api-key':'synthetic-key','content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};};
 try{
  for(let i=0;i<100&&!logs.includes('uzerinde calisiyor');i++)await new Promise(r=>setTimeout(r,30));assert.ok(logs.includes('uzerinde calisiyor'),logs);
  const before=(await request('paneldata')).body,s=(await request('agent/operations')).body;
  const payload={record_id:7,request_id:'stage-http-report',text:'Baskıya sevk edildi.',revision:s.revision,fingerprint:s.records[0].fingerprint};
  const result=await request('agent/operations/report',payload);assert.equal(result.status,200);
  const saved=result.body;assert.equal(saved.saved,true);assert.equal(saved.stage_sync.to_status,'Baskı/Nakışta');assert.equal(saved.snapshot.records[0].stale,false);
  assert.equal(saved.panel_sync.data.uretimTakip[0].status,'Baskı/Nakışta');assert.notEqual(saved.panel_sync.updatedAt,before.updatedAt);assert.equal(saved.panel_sync.auth.test,true);
  assert.equal((await request('agent/operations/report',payload)).body.reused,true);assert.equal(fs.readFileSync(path.join(dir,'calls'),'utf8'),'1');
  const stale=await request('paneldata',{data:before.data,expectedUpdatedAt:before.updatedAt});assert.equal(stale.status,409);
  assert.equal((await request('paneldata')).body.data.uretimTakip[0].status,'Baskı/Nakışta');
  const undoBody={event_id:payload.request_id,revision:saved.snapshot.revision};
  const undone=await request('agent/operations/undo',undoBody);assert.equal(undone.status,200);assert.equal(undone.body.panel_sync.data.uretimTakip[0].status,'Kesimde');assert.equal(undone.body.stage_sync.operation,'undo');
  const again=await request('agent/operations/undo',undoBody);assert.equal(again.status,200);assert.equal(again.body.revision,undone.body.revision);
  assert.equal(fs.readFileSync(path.join(dir,'calls'),'utf8'),'1');
 }finally{child.kill();if(child.exitCode===null&&child.signalCode===null)await new Promise(r=>child.once('exit',r));fs.rmSync(dir,{recursive:true,force:true});}
});
