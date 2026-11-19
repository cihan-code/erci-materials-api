'use strict';
// Synthetic pixels and users only; no production data or provider calls.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const express=require('express');
const {PNG}=require('pngjs');
const {openDb}=require('../../../agent/siparis/db');
const {createUser}=require('../../../agent/siparis/auth');
const mount=require('../../../agent/siparis/routes');

function designPng(w=140,h=60) {
  const png=new PNG({width:w,height:h});
  for (let i=0;i<png.data.length;i+=4) { png.data[i]=35; png.data[i+1]=80; png.data[i+2]=170; png.data[i+3]=255; }
  return PNG.sync.write(png);
}
async function setup({dataDir}={}) {
  const dir=dataDir || fs.mkdtempSync(path.join(os.tmpdir(),'siparis-belge-'));
  const db=openDb(path.join(dir,'siparis.sqlite'));
  const manager=await createUser(db,{name:'Örnek Yetkili',password:'synthetic-password',role:'yonetici'});
  const team=await createUser(db,{name:'Örnek Ekip',password:'synthetic-password'});
  const app=express();
  const handle=mount(app,{db,dataDir:dir,worker:false,recipes:{version:'belge-test-v1',products:{tisort:{materials:[{key:'kumas',g_per_unit:200}]}}}});
  const server=app.listen(0,'127.0.0.1');
  try { await new Promise((resolve,reject)=> {server.once('listening',resolve);server.once('error',reject);}); }
  catch (e) { handle.close(); db.close(); throw e; }
  const base=`http://127.0.0.1:${server.address().port}/api/siparis`;
  async function request(url,{method='GET',body,token}={}) {
    const headers=token ? {authorization:`Bearer ${token}`} : {};
    if (body && !(body instanceof FormData)) {headers['content-type']='application/json';body=JSON.stringify(body);}
    const response=await fetch(base+url,{method,headers,...(body?{body}:{})});
    const data=response.headers.get('content-type')?.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
    return {status:response.status,data,headers:response.headers};
  }
  const login=async user=> (await request('/giris',{method:'POST',body:{name:user.name,password:'synthetic-password'}})).data.token;
  const token=await login(team), managerToken=await login(manager);
  let orderCount=0;
  async function order(extra={}) {
    const result=await request('/siparisler',{method:'POST',token,body:{order_no:`MRC-T${++orderCount}`,customer_name:'Örnek Kulüp',lines:[{product_key:'tisort',color_name:'Mavi',quantity:2,sizes:{M:2}}],...extra}});
    if (result.status!==201) throw new Error(JSON.stringify(result));
    return result.data;
  }
  function upload(versionId,{buffer=designPng(),name='ornek.png',mime='image/png',kind='desen_kaynak',...fields}={}) {
    const body=new FormData(); body.set('kind',kind);
    for (const [k,v] of Object.entries(fields)) body.set(k,String(v));
    body.set('file',new Blob([buffer],{type:mime}),name);
    return request(`/surumler/${versionId}/dosyalar`,{method:'POST',token,body});
  }
  function measure(lineId,extra={}) {
    return request('/uygulamalar/olc',{method:'POST',token,body:{lineId,kind:'baski',position:'sirt',refLengthPx:280,refLengthCm:56,designBoxPx:{w:140,h:60},imageKind:'flat',...extra}});
  }
  const post=(url,body={},authToken=token)=>request(url,{method:'POST',body,token:authToken});
  async function close() {
    await new Promise(resolve=> {server.close(resolve);server.closeAllConnections?.();});
    handle.close(); db.close();
  }
  return {dir,db,server,base,token,managerToken,manager,team,request,order,upload,measure,post,close};
}
module.exports={setup,designPng};
