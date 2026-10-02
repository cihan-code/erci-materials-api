'use strict';
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),path=require('path'),os=require('os');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stage-sync-'));process.env.DATA_DIR=dir;
after(()=>fs.rmSync(dir,{recursive:true,force:true}));
const service=require('../agent/operations/service'),panel=require('../agent/store'),journal=require('../agent/operations/store');
const stages=require('../agent/operations/stage-sync');
const base={id:7,customer_name:'Synthetic',quantity:100,status:'Kesimde',decoration:'baski',note:'Keep'};
function reset(status=base.status){fs.rmSync(path.join(dir,'operations'),{recursive:true,force:true});fs.writeFileSync(panel.PANEL_DATA_FILE,JSON.stringify({data:{uretimTakip:[{...base,status}],jobs:[],expenses:[{id:1,note:'keep financial row'}]},auth:{preserve:'synthetic auth'},updatedAt:'2026-10-02T05:00:00Z'}));}
function params(text='Sevk yapıldı.',id='stage-report-001'){const s=service.snapshot();return {record_id:7,request_id:id,text,revision:s.revision,fingerprint:s.records[0].fingerprint};}
function infer(op,status='completed',remaining=null){return async text=>({entries:[{op,status,remaining,reason:'',issue:null,evidence:text}]});}
const current=()=>panel.loadPanelData().data.uretimTakip[0];
test('forward, backward and delivered transitions are factual and retain unrelated data/auth',async()=>{
 for(const [from,op,to] of [['Kesimde','print_dropoff','Baskı/Nakışta'],['Dikimde','cut','Kesimde'],['Dikimde','sewing','Ütü-Pakette-Teslimat Bekliyor'],['Ütü-Pakette-Teslimat Bekliyor','delivery','Teslim Edildi']]){
  reset(from);const res=await service.submit(params(),infer(op));
  assert.equal(current().status,to);assert.equal(res.stage_sync.status,'applied');assert.equal(res.snapshot.records[0].stale,false);
  assert.equal(res.snapshot.records[0].revision.status,to);assert.equal(journal.read().events[0].basis_status,from);
  assert.equal(current().note,'Keep');assert.equal(panel.readPanelRaw().auth.preserve,'synthetic auth');assert.equal(panel.loadPanelData().data.expenses[0].id,1);
 }
});
test('remaining work stays at the operation stage and synchronizes without staleness',async()=>{
 reset();const before=fs.readFileSync(panel.PANEL_DATA_FILE,'utf8');
 const res=await service.submit(params('Beş adet kaldı.'),infer('print','partial',5));
 assert.equal(current().status,'Baskı/Nakışta');assert.equal(res.snapshot.records[0].stale,false);
 assert.equal(res.stage_sync.status,'applied');
});
test('manual changes including a return to original stage remain stale; undo preserves them',async()=>{
 for(const changes of [{status:'Dikimde'},{status:'Kesimde'},{quantity:200},{est_delivery:'2026-10-08'}]){
  reset();const res=await service.submit(params(),infer('print_dropoff'));
  const {data,updatedAt}=panel.loadPanelData();Object.assign(data.uretimTakip[0],changes);panel.writePanelData(data,updatedAt);
  assert.equal(service.snapshot().records[0].stale,true);
  const before=JSON.stringify(current());const undone=await service.undo({event_id:'stage-report-001',revision:res.snapshot.revision});
  assert.equal(JSON.stringify(current()),before);assert.equal(undone.stage_sync.status,'skipped');assert.match(undone.stage_sync.message,/elle değişti/);
 }
});
test('undo restores the remaining revision and finally the first original stage',async()=>{
 reset();let res=await service.submit(params(),infer('print_dropoff'));
 res=await service.submit(params('Dikim bitti.','stage-report-002'),infer('sewing'));
 assert.equal(current().status,'Ütü-Pakette-Teslimat Bekliyor');
 let undone=await service.undo({event_id:'stage-report-002',revision:res.snapshot.revision});
 assert.equal(current().status,'Baskı/Nakışta');assert.equal(undone.records[0].stale,false);
 undone=await service.undo({event_id:'stage-report-001',revision:undone.revision});
 assert.equal(current().status,'Kesimde');assert.equal(undone.records[0].revision,null);
});
test('ambiguity and dry-run cannot alter a stage or save an event',async()=>{
 reset();const before=fs.readFileSync(panel.PANEL_DATA_FILE,'utf8');
 await service.submit(params(),async()=>({clarification:'Hangi işlem?'}));
 await service.submit({...params(),dry_run:true},infer('delivery'));
 assert.equal(fs.readFileSync(panel.PANEL_DATA_FILE,'utf8'),before);assert.equal(journal.read().events.length,0);
});
test('pending journal intent recovers a failed panel write without extra interpretation',async()=>{
 reset();let calls=0;const p=params();const original=panel.writePanelData;
 panel.writePanelData=()=>{throw Error('synthetic disk failure');};
 try{const saved=await service.submit(p,async(...args)=>{calls++;return infer('print_dropoff')(...args);});assert.equal(saved.saved,true);assert.equal(saved.stage_sync.status,'pending');}
 finally{panel.writePanelData=original;}
 const reused=await service.submit(p,async()=>assert.fail('Never interpret a saved retry'));
 assert.equal(reused.reused,true);assert.equal(current().status,'Baskı/Nakışta');assert.equal(reused.snapshot.records[0].stale,false);assert.equal(calls,1);
 // Crash after panel write, before marking the intent applied: retry recognizes it.
 const ledger=journal.read();ledger.stage_syncs['7'].status='pending';journal.write(ledger);
 await service.submit(p,async()=>assert.fail('Never interpret'));assert.equal(journal.read().stage_syncs['7'].status,'applied');
});
test('unrelated edits during interpretation survive the narrow server patch and stale browser CAS fails',async()=>{
 reset();const old=panel.loadPanelData().updatedAt;
 await service.submit(params(),async(...args)=>{
  const {data,updatedAt}=panel.loadPanelData();data.expenses.push({id:2});panel.writePanelData(data,updatedAt);
  return infer('print_dropoff')(...args);
 });
 assert.equal(panel.loadPanelData().data.expenses.length,2);
 assert.throws(()=>panel.writePanelDataFull({data:{uretimTakip:[base]},expectedUpdatedAt:old,requireExpected:true}),e=>e.code==='CONFLICT');
 assert.equal(current().status,'Baskı/Nakışta');
});
test('legacy events keep strict fingerprints and unknown original stages are never invented',async()=>{
 reset();const p=params();await service.submit(p,infer('print_dropoff'));
 const ledger=journal.read();delete ledger.events[0].basis_status;journal.write(ledger);
 assert.equal(service.snapshot().records[0].stale,true);
 const undone=await service.undo({event_id:p.request_id,revision:1});assert.equal(current().status,'Baskı/Nakışta');assert.equal(undone.stage_sync.status,'skipped');
});
test('panel version tokens are distinct for multiple writes in one millisecond',()=>{
 reset();const originalNow=Date.now;Date.now=()=>Date.parse('2026-10-02T05:00:00Z');
 try { const a=panel.writePanelData(panel.loadPanelData().data,panel.loadPanelData().updatedAt);
 const b=panel.writePanelData(panel.loadPanelData().data,a);assert.notEqual(a,b);assert.ok(Date.parse(b)>Date.parse(a)); }
 finally {Date.now=originalNow;}
});
