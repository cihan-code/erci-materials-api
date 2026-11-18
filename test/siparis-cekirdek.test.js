'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('node:child_process');
const express = require('express');
const cors = require('cors');
const { openDb, tx } = require('../agent/siparis/db');
const auth = require('../agent/siparis/auth');
const orders = require('../agent/siparis/orders');
const { approveVersion } = require('../agent/siparis/approval');
const stock = require('../agent/siparis/stock');
const queue = require('../agent/siparis/outbox');
const mount = require('../agent/siparis/routes');
const recipes = { version: 'test-350-v1', products: { sweat: { materials: [{ key:'kumas',g_per_unit:350 }] } } };
async function setup(t, opening = 20000) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'siparis-core-'));
  const file=path.join(dir,'test.sqlite');
  const db=openDb(file);
  t.after(() => { if (db.open) db.close(); fs.rmSync(dir,{recursive:true,force:true}); });
  const manager=await auth.createUser(db,{name:'Yönetici',password:'test-password',role:'yonetici'});
  const team=await auth.createUser(db,{name:'Ekip',password:'test-password',role:'ekip'});
  stock.importLegacyFabrics(db,{fabrics:[{id:'f1',name:'Örnek kumaş',colorName:'Mavi',unit:'kg'}],movements:[{fabricId:'f1',type:'giris',qty:opening/1000}]});
  const itemId=db.prepare('SELECT id FROM stock_items').get().id;
  let count=0;
  function make(quantity=100, extra={}) {
    const order=orders.createOrder(db,{order_no:`MRC-T${++count}`,customer_name:'Örnek Kulüp',lines:[{product_key:'sweat',fabric_item_id:itemId,quantity,...extra}]},team);
    const v=order.version;
    const f=orders.addFile(db,v.id,{kind:'onay_formu',path:`/synthetic/${v.id}.pdf`,sha256:'a'.repeat(64)},team);
    return {order,versionId:v.id,lineId:v.lines[0].id,fileId:f.id};
  }
  function approve(input, options={}) { return approveVersion(db,{...input,userId:manager.id,recipes,...options}); }
  function submit(input) { orders.submitForApproval(db,input.versionId,team); return input; }
  function invoice(qty=25000) {
    return Number(db.prepare("INSERT INTO invoice_lines(source_invoice_id,source_line_id,qty_milli,unit,item_id,match_status) VALUES(?,? ,?,'kg',?,'eslesti')")
      .run('INV-TEST',String(++count),qty,itemId).lastInsertRowid);
  }
  function revision(input, changes) {
    const v=orders.reviseVersion(db,input.versionId,changes,team);
    const f=orders.addFile(db,v.id,{kind:'onay_formu',path:`/synthetic/${v.id}.pdf`,sha256:'b'.repeat(64)},team);
    return {versionId:v.id,lineId:v.lines[0].id,fileId:f.id,version:v};
  }
  return {db,dir,file,manager,team,itemId,make,approve,submit,invoice,revision};
}
function summary(db) { const s=stock.stockSummary(db)[0]; return [s.total_milli,s.reserved_milli,s.available_milli,s.shortage_milli]; }

test('WAL, foreign keys, idempotent schema and immediate transaction rollback',async t => {
  const {db,file}=await setup(t);
  assert.equal(db.pragma('journal_mode',{simple:true}),'wal');
  assert.equal(db.pragma('foreign_keys',{simple:true}),1);
  const second=openDb(file); t.after(()=>second.close());
  assert.throws(()=>tx(db,()=>{db.prepare("INSERT INTO orders(order_no) VALUES('ROLLBACK')").run();throw Error('stop');}),/stop/);
  assert.equal(second.prepare("SELECT count(*) n FROM orders WHERE order_no='ROLLBACK'").get().n,0);
  assert.throws(()=>tx(db,()=>Promise.resolve()),/synchronous/);
  assert.throws(()=>db.prepare("INSERT INTO order_versions(order_id,version_no,created_by) VALUES(999,1,999)").run(),/FOREIGN KEY/);
});

test('approval is atomic and idempotent; submit has no inventory or queue effects',async t => {
  const f=await setup(t); const order=f.make();
  orders.addFile(f.db,order.versionId,{kind:'uretim_formu',path:'/synthetic/production.pdf',sha256:'c'.repeat(64)},f.team);
  assert.throws(()=>f.approve(order),/onay beklemiyor/);
  f.submit(order);
  assert.equal(f.db.prepare("SELECT count(*) n FROM stock_movements WHERE type='tahsis'").get().n,0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM outbox').get().n,0);
  const first=f.approve(order); assert.deepEqual(f.approve(order),first);
  assert.equal(first.allocations[0].need_milli,35000);
  assert.deepEqual(summary(f.db),[20000,20000,0,15000]);
  assert.equal(f.db.prepare("SELECT count(*) n FROM stock_movements WHERE type='tahsis'").get().n,1);
  assert.equal(first.outbox.length,3);
  assert.equal(first.outbox.filter(j=>j.kind==='atolye_dosya').length,2);
  assert.equal(f.db.prepare('SELECT recipe_version FROM order_lines WHERE id=?').get(order.lineId).recipe_version,'test-350-v1');
});

test('an outbox insertion error rolls back approval, reservations, movements and recipe version',async t => {
  const f=await setup(t); const order=f.submit(f.make());
  f.db.exec("CREATE TRIGGER stop_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'injected outbox failure'); END;");
  assert.throws(()=>f.approve(order),/injected/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM approvals').get().n,0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM allocations').get().n,0);
  assert.deepEqual(summary(f.db),[20000,0,20000,0]);
  assert.equal(f.db.prepare('SELECT recipe_version FROM order_lines WHERE id=?').get(order.lineId).recipe_version,null);
  assert.equal(orders.snapshot(f.db,order.versionId).status,'onay_bekliyor');
});

test('two independent connections contend for BEGIN IMMEDIATE without over-reserving', {timeout:15000}, async t => {
  const f=await setup(t); const a=f.submit(f.make()),b=f.submit(f.make());
  const script=`
    process.once('message',data=>{
      const {openDb}=require(data.root+'/agent/siparis/db');
      const {approveVersion}=require(data.root+'/agent/siparis/approval');
      const db=openDb(data.file);
      process.once('message',()=>{
        try {
          const r=approveVersion(db,data.input); db.close();
          process.send({reserved:r.allocations[0].reserved_milli},()=>process.disconnect());
        } catch(err) {db.close(); console.error(err.message); process.exit(1);}
      });
      process.send('ready');
    });
  `;
  function nextMessage(child) {
    return new Promise((resolve,reject)=>{
      const cleanup=()=>{child.off('message',message);child.off('error',error);child.off('exit',exited);};
      const message=value=>{cleanup();resolve(value);};
      const error=err=>{cleanup();reject(err);};
      const exited=code=>error(Error(`Concurrent approval child exited: ${code}`));
      child.once('message',message);child.once('error',error);child.once('exit',exited);
    });
  }
  const children=[a,b].map(()=>spawn(process.execPath,['-e',script],{stdio:['ignore','ignore','inherit','ipc']}));
  t.after(()=>{for(const child of children)if(child.exitCode===null)child.kill();});
  const ready=children.map(nextMessage);
  children.forEach((child,i)=>child.send({root:path.resolve(__dirname,'..'),file:f.file,input:{...[a,b][i],userId:f.manager.id,recipes}}));
  assert.deepEqual(await Promise.all(ready),['ready','ready']);
  const results=children.map(nextMessage);
  children.forEach(child=>child.send('start'));
  const reserved=(await Promise.all(results)).map(r=>r.reserved).sort((x,y)=>x-y);
  assert.deepEqual(reserved,[0,20000]);
  assert.deepEqual(summary(f.db),[20000,20000,0,50000]);
});

test('25 kg delivery closes 15 kg shortage and duplicate invoice receipt is inert',async t => {
  const f=await setup(t); f.approve(f.submit(f.make())); const invoiceLineId=f.invoice();
  assert.equal(stock.stockSummary(f.db)[0].awaiting_delivery_milli,25000);
  const input={invoiceLineId,itemId:f.itemId,qtyMilli:25000,userId:f.team.id};
  const first=stock.receiveDelivery(f.db,input);
  assert.deepEqual(summary(f.db),[45000,35000,10000,0]);
  const before=f.db.prepare('SELECT count(*) n FROM audit_log').get().n;
  assert.deepEqual(stock.receiveDelivery(f.db,input),first);
  assert.equal(f.db.prepare('SELECT count(*) n FROM audit_log').get().n,before);
  assert.equal(stock.stockSummary(f.db)[0].awaiting_delivery_milli,0);
});

test('deliveries allocate FIFO and explicit targets leave the rest available',async t => {
  const f=await setup(t,0); const a=f.submit(f.make(10)),b=f.submit(f.make(10)); f.approve(a); f.approve(b);
  stock.receiveDelivery(f.db,{invoiceLineId:f.invoice(4000),itemId:f.itemId,qtyMilli:4000,userId:f.team.id});
  const amounts=()=>f.db.prepare('SELECT reserved_milli FROM allocations ORDER BY id').all().map(a=>a.reserved_milli);
  assert.deepEqual(amounts(),[3500,500]);
  stock.receiveDelivery(f.db,{invoiceLineId:f.invoice(4000),itemId:f.itemId,qtyMilli:4000,allocations:[{orderLineId:b.lineId,qtyMilli:1000}],userId:f.team.id});
  assert.deepEqual(amounts(),[3500,1500]);
  assert.equal(stock.stockSummary(f.db)[0].available_milli,3000);
});

test('invalid delivery targets and partial quantity rollback the receipt',async t => {
  const f=await setup(t,0); const a=f.submit(f.make(10)); f.approve(a); const invoiceLineId=f.invoice(4000);
  const input={invoiceLineId,itemId:f.itemId,qtyMilli:4000,userId:f.team.id};
  assert.throws(()=>stock.receiveDelivery(f.db,{...input,allocations:[{orderLineId:a.lineId,qtyMilli:4000}]}),/aşıyor/);
  assert.throws(()=>stock.receiveDelivery(f.db,{...input,qtyMilli:2000}),/eşit/);
  assert.equal(f.db.prepare("SELECT count(*) n FROM stock_movements WHERE type='giris'").get().n,0);
  assert.equal(f.db.prepare('SELECT delivery_status FROM invoice_lines WHERE id=?').get(invoiceLineId).delivery_status,'teslim_bekliyor');
});

test('legacy import is idempotent and unsupported types roll back the entire import',async t => {
  const f=await setup(t); const input={fabrics:[{id:'f1',name:'Changed',unit:'kg'}],movements:[]};
  assert.deepEqual(stock.importLegacyFabrics(f.db,input),{imported:0});
  assert.deepEqual(summary(f.db),[20000,0,20000,0]);
  assert.throws(()=>stock.importLegacyFabrics(f.db,{fabrics:[{id:'f2',name:'Örnek',unit:'kg'}],movements:[{fabricId:'f2',type:'unknown',qty:1}]}),/eşleme/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM stock_items').get().n,1);
});

test('dimension revision is pending, cancels old workshop jobs immediately and carries stock without churn',async t => {
  const f=await setup(t,50000); const a=f.make(100,{applications:[{kind:'baski',position:'on',width_mm:100,height_mm:200}]}); f.approve(f.submit(a));
  const revision=f.revision(a,{lines:[{id:a.lineId,applications:[{kind:'baski',position:'on',width_mm:120,height_mm:200}]}]});
  assert.equal(revision.version.status,'onay_bekliyor');
  assert.equal(orders.snapshot(f.db,a.versionId).status,'eski');
  assert.equal(revision.version.lines[0].applications[0].width_mm,120);
  assert.equal(revision.version.files.length,0);
  assert.equal(f.db.prepare("SELECT status FROM outbox WHERE version_id=? AND kind='atolye_dosya'").get(a.versionId).status,'iptal');
  f.approve(revision);
  assert.equal(f.db.prepare("SELECT count(*) n FROM stock_movements WHERE type IN ('tahsis','tahsis_iade')").get().n,1);
  assert.deepEqual(summary(f.db),[50000,35000,15000,0]);
  assert.equal(f.db.prepare('SELECT reserved_milli FROM allocations WHERE order_line_id=?').get(a.lineId).reserved_milli,0);
});

test('100 to 120 revision writes only +7 kg and completed workshop work opens confirmation',async t => {
  const f=await setup(t,50000); const a=f.submit(f.make()); f.approve(a);
  const job=f.db.prepare("SELECT * FROM outbox WHERE version_id=? AND kind='atolye_dosya'").get(a.versionId);
  queue.setManual(f.db,job.id,f.manager); queue.markManualSent(f.db,job.id,f.manager,'manual-test');
  const b=f.revision(a,{lines:[{id:a.lineId,quantity:120}]}); f.approve(b);
  assert.deepEqual(f.db.prepare("SELECT qty_milli FROM stock_movements WHERE type='tahsis' ORDER BY id").all().map(x=>x.qty_milli),[35000,7000]);
  assert.deepEqual(summary(f.db),[50000,42000,8000,0]);
  assert.equal(f.db.prepare("SELECT count(*) n FROM confirmations WHERE message='Atölyede eski sürüm (v1) var'").get().n,1);
  assert.throws(()=>queue.retry(f.db,job.id,f.manager),/Eski sürüm/);
});

test('downward revisions release only the difference and preserve consumption',async t => {
  const f=await setup(t,50000); const a=f.submit(f.make()); f.approve(a);
  stock.consume(f.db,{orderLineId:a.lineId,materialKey:'kumas',qtyMilli:10000,businessKey:'cut-1',userId:f.team.id});
  const b=f.revision(a,{lines:[{id:a.lineId,quantity:80}]}); f.approve(b);
  assert.deepEqual(summary(f.db),[40000,18000,22000,0]);
  assert.equal(f.db.prepare("SELECT qty_milli FROM stock_movements WHERE type='tahsis_iade'").get().qty_milli,7000);
  const alloc=f.db.prepare('SELECT * FROM allocations WHERE order_line_id=?').get(b.lineId);
  assert.equal(alloc.consumed_milli,10000); assert.equal(alloc.need_milli,28000);
  const c=f.revision(b,{lines:[{id:b.lineId,quantity:10}]});
  assert.throws(()=>f.approve(c),/Tüketilmiş/);
  assert.deepEqual(summary(f.db),[40000,18000,22000,0]);
});

test('multiple pending revisions still compare against the last approved allocation',async t => {
  const f=await setup(t,50000); const a=f.submit(f.make()); f.approve(a);
  const b=f.revision(a,{lines:[{id:a.lineId,quantity:110}]});
  const c=f.revision(b,{lines:[{id:b.lineId,quantity:120}]}); f.approve(c);
  assert.deepEqual(summary(f.db),[50000,42000,8000,0]);
  assert.deepEqual(f.db.prepare("SELECT qty_milli FROM stock_movements WHERE type='tahsis'").all().map(r=>r.qty_milli),[35000,7000]);
});

test('multi-line revision installs every carry before allocating extra stock',async t => {
  const f=await setup(t,10000); const a=f.make(10);
  const second=orders.addLine(f.db,a.versionId,{product_key:'sweat',fabric_item_id:f.itemId,quantity:10},f.team);
  f.approve(f.submit(a));
  const b=f.revision(a,{lines:[{id:a.lineId,quantity:20},{id:second.id}]}); f.approve(b);
  assert.deepEqual(summary(f.db),[10000,10000,0,500]);
  assert.deepEqual(f.db.prepare('SELECT a.reserved_milli FROM allocations a JOIN order_lines l ON l.id=a.order_line_id WHERE l.version_id=? ORDER BY a.id').all(b.versionId).map(a=>a.reserved_milli),[6500,3500]);
});

test('fabric change releases old item and allocates the new item',async t => {
  const f=await setup(t,50000); stock.importLegacyFabrics(f.db,{fabrics:[{id:'f2',name:'İkinci kumaş',unit:'kg'}],movements:[{fabricId:'f2',type:'giris',qty:40}]});
  const item2=f.db.prepare("SELECT id FROM stock_items WHERE legacy_fabric_id='f2'").get().id;
  const a=f.submit(f.make());f.approve(a); const b=f.revision(a,{lines:[{id:a.lineId,fabric_item_id:item2}]});f.approve(b);
  assert.deepEqual(stock.stockSummary(f.db).map(i=>i.reserved_milli),[0,35000]);
});

test('default recipe uses 720 g, lining is conditional and unbound secondary material requires confirmation',async t => {
  const f=await setup(t,100000); const a=f.submit(f.make()); const result=f.approve(a,{recipes:undefined});
  assert.equal(result.allocations.find(a=>a.material_key==='kumas').need_milli,72000);
  assert.equal(result.allocations.some(a=>a.material_key==='astar'),false);
  const secondary=result.allocations.find(a=>a.material_key==='kaskorse');
  assert.equal(secondary.item_id,null);assert.equal(secondary.shortage_milli,12500);
  assert.match(f.db.prepare('SELECT message FROM confirmations').get().message,/stok kalemi/);
  const b=f.submit(f.make(1,{lining:true,material_items:{kaskorse:f.itemId,astar:f.itemId}}));
  const r=f.approve(b,{recipes:undefined});assert.equal(r.allocations.find(a=>a.material_key==='astar').need_milli,50);
});

test('unknown recipe quantity creates a confirmation without inventing inventory needs',async t => {
  const f=await setup(t);const a=f.submit(f.make(10,{product_key:'esofman'}));const r=f.approve(a,{recipes:undefined});
  assert.equal(r.allocations.length,1);assert.match(f.db.prepare('SELECT message FROM confirmations').get().message,/miktarı bilinmiyor/);
});

test('adjustment privilege, negative-stock prevention and idempotent consumption',async t => {
  const f=await setup(t,50000);const a=f.submit(f.make());f.approve(a);
  assert.throws(()=>stock.adjustStock(f.db,{itemId:f.itemId,qtyMilli:100,businessKey:'adj',note:'sayım',userId:f.team.id}),e=>e.status===403);
  assert.throws(()=>stock.adjustStock(f.db,{itemId:f.itemId,qtyMilli:-16000,businessKey:'adj',note:'sayım',userId:f.manager.id}),/ihlal/);
  stock.adjustStock(f.db,{itemId:f.itemId,qtyMilli:-1000,businessKey:'adj',note:'sayım',userId:f.manager.id});
  const input={orderLineId:a.lineId,materialKey:'kumas',qtyMilli:5000,businessKey:'cut',userId:f.team.id};
  const once=stock.consume(f.db,input);assert.deepEqual(stock.consume(f.db,input),once);
  assert.deepEqual(summary(f.db),[44000,30000,14000,0]);
  assert.throws(()=>stock.consume(f.db,{...input,qtyMilli:30001,businessKey:'cut2'}),/Yeterli/);
});

test('automatic sending defaults off; manual completion is audited and never calls adapter',async t => {
  const prior=process.env.OTOMATIK_GONDERIM;delete process.env.OTOMATIK_GONDERIM;
  t.after(()=>{if(prior===undefined)delete process.env.OTOMATIK_GONDERIM;else process.env.OTOMATIK_GONDERIM=prior;});
  const f=await setup(t);const a=f.submit(f.make());f.approve(a);let called=0;
  t.after(queue.registerHandler('atolye_dosya',async()=>{called++;}));
  assert.equal(await queue.runOnce(f.db,'atolye_dosya'),null);assert.equal(called,0);
  const job=f.db.prepare("SELECT * FROM outbox WHERE kind='atolye_dosya'").get();assert.equal(job.status,'manuel_bekliyor');assert.equal(job.attempts,0);
  assert.throws(()=>queue.markManualSent(f.db,job.id,f.team),e=>e.status===403);
  assert.equal(queue.markManualSent(f.db,job.id,f.manager).status,'tamam');
  assert.equal(f.db.prepare("SELECT count(*) n FROM audit_log WHERE action='elle_gonderildi'").get().n,1);
});

test('queue claims are exclusive; failures back off and fifth attempt opens a single confirmation',async t => {
  const f=await setup(t);f.approve(f.submit(f.make()));const other=openDb(f.file);t.after(()=>other.close());
  let previousDelay=0,job;
  for(let i=1;i<=5;i++) {
    job=queue.claimNext(f.db,'maliyet_aktarim');assert.equal(job.attempts,i);
    assert.equal(queue.claimNext(other,'maliyet_aktarim'),null);
    const failed=queue.markFailed(f.db,job.id,Error('test-provider-offline'),job.claim_token);
    const delay=Date.parse(failed.next_run_at)-Date.now();assert.ok(delay>previousDelay);previousDelay=delay;
    if(i<5) {assert.equal(failed.status,'bekliyor');assert.equal(queue.claimNext(f.db,'maliyet_aktarim'),null);f.db.prepare("UPDATE outbox SET next_run_at='2000-01-01' WHERE id=?").run(job.id);}
    else assert.equal(failed.status,'basarisiz');
  }
  assert.equal(f.db.prepare("SELECT count(*) n FROM confirmations WHERE kind='baglanti_hatasi'").get().n,1);
  assert.throws(()=>queue.retry(f.db,job.id,f.team),e=>e.status===403);
  assert.equal(queue.retry(f.db,job.id,f.manager).attempts,0);
  const claimed=queue.claimNext(f.db,'maliyet_aktarim');
  assert.throws(()=>queue.markDone(f.db,claimed.id,'remote','wrong-token'),/sahipliği/);
  assert.equal(queue.markDone(f.db,claimed.id,'remote-1',claimed.claim_token).provider_ref,'remote-1');
});

test('handler receives stable provider idempotency key and supports price waiting',async t => {
  const f=await setup(t);const a=f.submit(f.make());f.approve(a);
  let observed;
  const unregister=queue.registerHandler('maliyet_aktarim',async(payload,context)=>{observed={payload,key:context.idempotencyKey};return {status:'fiyat_bekliyor'};});t.after(unregister);
  const result=await queue.runOnce(f.db,'maliyet_aktarim');assert.equal(result.status,'fiyat_bekliyor');
  assert.equal(observed.key,'maliyet:MRC-T1:1');assert.equal(observed.payload.versionId,a.versionId);
  queue.retry(f.db,result.id,f.manager);
  t.after(queue.registerHandler('maliyet_aktarim',async()=>({providerRef:'cost-1'})));
  assert.equal((await queue.runOnce(f.db,'maliyet_aktarim')).provider_ref,'cost-1');
});

test('interrupted claim requires confirmation rather than an unverified external resend',async t => {
  const f=await setup(t);f.approve(f.submit(f.make()));const job=queue.claimNext(f.db,'maliyet_aktarim');
  f.db.prepare("UPDATE outbox SET next_run_at='2000-01-01' WHERE id=?").run(job.id);
  assert.equal(queue.claimNext(f.db,'maliyet_aktarim'),null);
  assert.equal(f.db.prepare('SELECT status FROM outbox WHERE id=?').get(job.id).status,'basarisiz');
  assert.equal(f.db.prepare("SELECT count(*) n FROM confirmations WHERE kind='baglanti_hatasi'").get().n,1);
});

test('passwords use scrypt, session tokens are hashed, expired tokens and public API key are rejected',async t => {
  const f=await setup(t);const app=express();app.use(cors({origin:'https://example.invalid'}));
  mount(app,{db:f.db,dataDir:f.dir,worker:false,recipes});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections?.();}));
  const base=`http://127.0.0.1:${server.address().port}/api/siparis`;
  async function request(url, token, body, method=body?'POST':'GET') {
    return fetch(base+url,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{'x-api-key':'public-repository-key'})},...(body?{body:JSON.stringify(body)}:{})});
  }
  assert.equal((await request('/stok')).status,401);
  assert.equal((await request('/giris',null,{ad:'Ekip',sifre:'wrong-password'})).status,401);
  const teamLogin=await (await request('/giris',null,{ad:'Ekip',sifre:'test-password'})).json();
  const managerLogin=await (await request('/giris',null,{ad:'Yönetici',sifre:'test-password'})).json();
  assert.equal(teamLogin.token.length,64);
  const session=f.db.prepare('SELECT * FROM sessions WHERE user_id=?').get(f.team.id);assert.notEqual(session.token_hash,teamLogin.token);
  assert.ok(Math.abs(Date.parse(teamLogin.expiresAt)-Date.now()-12*3600000)<5000);
  assert.match(f.db.prepare('SELECT password_hash FROM users WHERE id=?').get(f.team.id).password_hash,/^scrypt:/);
  const a=f.submit(f.make());
  assert.equal((await request(`/surumler/${a.versionId}/onay`,teamLogin.token,{fileId:a.fileId,userId:f.manager.id})).status,403);
  const approved=await request(`/surumler/${a.versionId}/onay`,managerLogin.token,{fileId:a.fileId});assert.equal(approved.status,200);
  assert.equal(approved.headers.get('access-control-allow-origin'),'https://example.invalid');
  const delegated=await auth.createUser(f.db,{name:'Yetkili ekip',password:'test-password',onayYetkisi:true});
  const delegatedLogin=await auth.login(f.db,{name:delegated.name,password:'test-password'});const b=f.submit(f.make(1));
  assert.equal((await request(`/surumler/${b.versionId}/onay`,delegatedLogin.token,{fileId:b.fileId})).status,200);
  f.db.prepare("UPDATE sessions SET expires_at='2000-01-01' WHERE user_id=?").run(f.team.id);
  assert.equal((await request('/stok',teamLogin.token)).status,401);
});

test('HTTP CRUD, confirmation resolution and file path containment',async t => {
  const f=await setup(t);const app=express();mount(app,{db:f.db,dataDir:f.dir,worker:false,recipes});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections?.();}));
  const {token}=await auth.login(f.db,{name:f.team.name,password:'test-password'});
  const base=`http://127.0.0.1:${server.address().port}/api/siparis`;
  const request=(url,method='GET',body)=>fetch(base+url,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const created=await request('/siparisler','POST',{order_no:'MRC-HTTP',lines:[{product_key:'sweat',quantity:1,fabric_item_id:f.itemId}]});assert.equal(created.status,201);
  const order=await created.json();
  assert.equal((await request(`/siparisler/${order.id}`,'PATCH',{job_no:'JOB-TEST'})).status,200);
  assert.equal((await (await request(`/siparisler/${order.id}`)).json()).job_no,'JOB-TEST');
  fs.mkdirSync(path.join(f.dir,'siparis','files'),{recursive:true});fs.writeFileSync(path.join(f.dir,'outside.pdf'),'synthetic');
  const fileRes=await request(`/surumler/${order.version.id}/dosyalar`,'POST',{kind:'onay_formu',path:'../../outside.pdf'});assert.equal(fileRes.status,403);
  fs.writeFileSync(path.join(f.dir,'siparis','files','test.pdf'),'synthetic');
  assert.equal((await request(`/surumler/${order.version.id}/dosyalar`,'POST',{kind:'onay_formu',path:'test.pdf'})).status,201);
  f.db.prepare("INSERT INTO confirmations(kind,ref_table,ref_id,message) VALUES('eksik_alan','orders',?,'Örnek teyit')").run(order.id);
  const c=(await (await request('/teyitler')).json())[0];
  assert.equal((await request(`/teyitler/${c.id}/coz`,'POST',{})).status,200);
  assert.equal(f.db.prepare('SELECT resolved_by FROM confirmations WHERE id=?').get(c.id).resolved_by,f.team.id);
  assert.equal((await request(`/siparisler/${order.id}`,'DELETE')).status,200);
});

test('enabled workshop adapter sends once; in-flight dispatch blocks revision',async t => {
  const prior=process.env.OTOMATIK_GONDERIM;process.env.OTOMATIK_GONDERIM='1';
  t.after(()=>{if(prior===undefined)delete process.env.OTOMATIK_GONDERIM;else process.env.OTOMATIK_GONDERIM=prior;});
  const f=await setup(t);const a=f.submit(f.make());f.approve(a);
  let finish,calls=0;
  t.after(queue.registerHandler('atolye_dosya',async(payload,{idempotencyKey})=>{
    calls++;assert.equal(payload.file.id,a.fileId);assert.equal(idempotencyKey,`atolye:${a.versionId}:onay_formu`);
    await new Promise(resolve=>{finish=resolve;});return {providerRef:'workshop-1'};
  }));
  const sending=queue.runOnce(f.db,'atolye_dosya');
  assert.throws(()=>f.revision(a,{lines:[{id:a.lineId,quantity:120}]}),/Gönderim sürüyor/);
  finish();const job=await sending;assert.equal(job.status,'tamam');assert.equal(job.provider_ref,'workshop-1');
  assert.equal(await queue.runOnce(f.db,'atolye_dosya'),null);assert.equal(calls,1);
  assert.equal(orders.snapshot(f.db,a.versionId).status,'onaylandi');
});

test('foreign approval files and invalid revision inputs cannot leave partial mutations',async t => {
  const f=await setup(t,50000);const a=f.submit(f.make()),other=f.make();
  assert.throws(()=>f.approve({...a,fileId:other.fileId}),/bu sürüme/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM approvals').get().n,0);
  f.approve(a);
  assert.throws(()=>f.revision(a,{lines:[{id:other.lineId,quantity:120}]}),/kaynak sürüme/);
  assert.equal(orders.snapshot(f.db,a.versionId).status,'onaylandi');
  assert.equal(f.db.prepare("SELECT status FROM outbox WHERE version_id=? AND kind='atolye_dosya'").get(a.versionId).status,'bekliyor');
  assert.deepEqual(summary(f.db),[50000,35000,15000,0]);
});

test('CLI accepts stdin and environment password without printing or storing plaintext',async t => {
  const f=await setup(t);const {execFileSync}=require('node:child_process');
  const cli=path.resolve(__dirname,'../agent/siparis/cli.js');const env={...process.env,DATA_DIR:f.dir};delete env.SIPARIS_SIFRE;
  const output=execFileSync(process.execPath,[cli,'kullanici-ekle','CLI Ekip','ekip','--onay'],{env,input:'synthetic-secret\n',encoding:'utf8'});
  assert.ok(!output.includes('synthetic-secret'));
  execFileSync(process.execPath,[cli,'kullanici-ekle','CLI Yönetici','yonetici'],{env:{...env,SIPARIS_SIFRE:'second-secret'},encoding:'utf8'});
  const db=openDb(path.join(f.dir,'siparis.sqlite'));t.after(()=>db.close());
  const first=await auth.login(db,{name:'CLI Ekip',password:'synthetic-secret'});assert.equal(first.user.onay_yetkisi,1);
  const second=await auth.login(db,{name:'CLI Yönetici',password:'second-secret'});assert.equal(second.user.role,'yonetici');
  assert.equal(db.prepare("SELECT count(*) n FROM audit_log WHERE action='kullanici_ekle'").get().n,2);
});
