'use strict';
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'briefing-test-'));process.env.DATA_DIR=directory;
after(()=>fs.rmSync(directory,{recursive:true,force:true}));
const service=require('../agent/operations/service'),context=require('../agent/operations/jev-context'),capacity=require('../agent/operations/capacity'),briefing=require('../agent/operations/briefing'),delivery=require('../agent/operations/briefing-delivery');
function fixture(){
 const date='2026-10-19';
 const data={jobs:[],uretimTakip:[
  {id:1,customer_name:'Sentetik Atölye A',quantity:250,status:'Dikimde',decoration:'nakis',product_type:'sweat',assigned_to:'Erdem',est_delivery:'2026-10-19',note:'Astarı ve kordonu teyit et.',cord:'var',lining:'var'},
  {id:2,customer_name:'Sentetik Atölye B',quantity:250,status:'Dikimde',decoration:'yok',product_type:'sweat',assigned_to:'Cihan',est_delivery:'2026-10-18'},
  {id:3,customer_name:'Sentetik Fermuar',quantity:150,status:'Kumaş Geldi',decoration:'baski',product_type:'tam_fermuar',assigned_to:'Cihan',est_delivery:'2026-10-22',cord:'var',lining:'yok',problem_note:'Fermuar ölçüsünü teyit et.'},
  {id:4,customer_name:'Sentetik Polo',quantity:100,status:'Baskı/Nakışta',decoration:'nakis',product_type:'polo',assigned_to:'Erdem',est_delivery:'2026-10-21'}]};
 const snapshot=service.snapshot(data,{version:1,revision:3,rules:{},events:[]},false);
 snapshot.records[3].expectations=[{op:'embroidery',due_date:date,status:'due',text:'Nakış bugün bitecek.'}];
 const prepared=context.prepare(data,snapshot,'synthetic',date);
 const answer={answers:Object.fromEntries(Object.keys(prepared.questions).map(k=>[k,k==='global_priority'?{probabilities:{'IS-1':.4,'IS-2':.3,'IS-3':.2,'IS-4':.1}}:{choice:k==='action_IS-4'?'confirm':'do',confidence:.9}]))};
 snapshot.state_hash=prepared.state_hash;snapshot.jev={configured:true};snapshot.configured=true;
 snapshot.plan={version:1,status:'ready',source:'jev',date,state_hash:prepared.state_hash,generated_at:date+'T05:00:00Z',model:'synthetic',record_count:4,considered_count:4,...capacity.allocate(prepared,context.decisions(prepared,answer))};
 snapshot.briefing=briefing.build(snapshot);return {data,snapshot};
}
test('briefing preserves the exact decisions and priority, while keeping all detail',()=>{
 const {snapshot}=fixture(), before=JSON.stringify(snapshot.plan), view=briefing.build(snapshot);
 assert.equal(JSON.stringify(snapshot.plan),before);
 assert.deepEqual(view.items.map(i=>[i.record_id,i.priority,i.action]),snapshot.plan.decisions.slice().sort((a,b)=>a.priority-b.priority).map(d=>[d.record_id,d.priority,d.action]));
 assert.match(view.items[0].details.map(d=>d.text).join(' '),/Astarı ve kordonu/);
 assert.match(view.items[2].details.map(d=>d.text).join(' '),/Malzeme|kg/);
 assert.equal(view.items[0].capacity.today_quantity,200);
 assert.equal(view.items[1].capacity.today_quantity,0);
 assert.ok(view.items[3].details.some(d=>d.text==='Nakış bugün bitecek.'));
 assert.equal(view.summary.total,4);
 snapshot.plan.status='stale';assert.equal(briefing.build(snapshot),null);
});
test('delivery guard suppresses competing runs, restarts and post-SMTP retries',()=>{
 const now=new Date('2026-10-19T05:00:00Z'),p={date:'2026-10-19',audience:'a'.repeat(64),request_id:'attempt-one'};
 const first=delivery.claim(p,now);assert.equal(first.claimed,true);
 assert.equal(delivery.claim({...p,request_id:'attempt-two'},now).claimed,false);
 assert.equal(delivery.claim(p,now).token,first.token);
 const body={...p,token:first.token};delivery.update({...body,status:'sending'},now);
 assert.equal(delivery.claim({...p,request_id:'attempt-two'},new Date('2026-10-19T06:00:00Z')).claimed,false);
 delivery.update({...body,status:'uncertain'},now);
 assert.equal(delivery.claim({...p,request_id:'attempt-two'},now).claimed,false);
 delivery.update({...body,status:'sent'},now);delivery.update({...body,status:'sent'},now);
 delete require.cache[require.resolve('../agent/operations/briefing-delivery')];
 assert.equal(require('../agent/operations/briefing-delivery').claim({...p,request_id:'attempt-three'},now).claimed,false);
 const saved=JSON.stringify(delivery.recent());assert.doesNotMatch(saved,new RegExp(first.token));
 assert.equal(fs.existsSync(path.join(directory,'operations/journal.json')),false);
});
test('only abandoned preparation and proven pre-SMTP failures can retry',()=>{
 const now=new Date('2026-10-19T05:00:00Z'),p={date:'2026-10-19',audience:'b'.repeat(64),request_id:'prepare-one'};
 const a=delivery.claim(p,now);delivery.update({...p,token:a.token,status:'failed'},now);
 const b=delivery.claim({...p,request_id:'prepare-two'},now);assert.equal(b.claimed,true);
 const later=new Date('2026-10-19T05:16:00Z');
 const c=delivery.claim({...p,request_id:'prepare-three'},later);assert.equal(c.claimed,true);
 assert.throws(()=>delivery.update({...p,request_id:'prepare-two',token:b.token,status:'sending'},later));
 assert.equal(delivery.recent().receipts.find(r=>r.audience===p.audience).attempts.length,2);
 assert.throws(()=>delivery.claim({...p,date:'2026-10-18'},now));
});
if(require.main===module && process.argv.includes('--fixture'))fs.writeFileSync(process.argv.at(-1),JSON.stringify(fixture(),null,2));
test('corrupt receipts fail closed rather than authorize a duplicate send',()=>{
 const file=path.join(directory,'operations/briefing-delivery.json'),original=fs.readFileSync(file,'utf8');
 try{
  fs.writeFileSync(file,JSON.stringify({version:1,receipts:[{status:'unrecognized'}]}));
  assert.throws(()=>delivery.claim({date:'2026-10-19',audience:'a'.repeat(64),request_id:'attempt-four'},new Date('2026-10-19T06:00:00Z')),/çift gönderimi/);
 }finally{fs.writeFileSync(file,original);}
});
