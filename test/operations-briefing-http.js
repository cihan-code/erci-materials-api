'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),{spawn}=require('node:child_process');
test('HTTP send guard authenticates, persists once-only delivery and never writes production',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'briefing-http-'));
 const original=JSON.stringify({data:{jobs:[],uretimTakip:[]},updatedAt:'fixture'});
 fs.writeFileSync(path.join(dir,'panel-data.json'),original);
 const port=19000+Math.floor(Math.random()*10000),base='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,PORT:String(port),DATA_DIR:dir,API_KEY:'synthetic-briefing',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
 let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
 const call=(route,body)=>fetch(base+'/api/agent/briefing-delivery'+route,{method:body?'POST':'GET',headers:{'x-api-key':'synthetic-briefing','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 try{
  for(let i=0;i<100&&!logs.includes('uzerinde calisiyor');i++)await new Promise(r=>setTimeout(r,30));
  assert.match(logs,/uzerinde calisiyor/);
  assert.equal((await fetch(base+'/api/agent/briefing-delivery')).status,401);
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Istanbul'}).format(new Date());
  const p={date:day,audience:'c'.repeat(64),request_id:'first-send'};
  const results=await Promise.all([call('/claim',p),call('/claim',{...p,request_id:'second-send'})]);
  const claims=await Promise.all(results.map(r=>r.json()));assert.equal(claims.filter(r=>r.claimed).length,1);
  const token=claims[0].token;assert.ok(token);
  for(const status of ['sending','sent'])assert.equal((await (await call('/update',{...p,token,status})).json()).status,status);
  assert.equal((await (await call('/claim',{...p,request_id:'third-send'})).json()).claimed,false);
  const receipts=await (await call('')).json();assert.equal(receipts.receipts[0].status,'sent');
  assert.doesNotMatch(JSON.stringify(receipts),new RegExp(token));
  assert.equal(fs.readFileSync(path.join(dir,'panel-data.json'),'utf8'),original);
  assert.equal(fs.existsSync(path.join(dir,'operations/journal.json')),false);
 }finally{child.kill();await new Promise(resolve=>child.once('exit',resolve));fs.rmSync(dir,{recursive:true,force:true});}
});
