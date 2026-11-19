#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const readline=require('node:readline/promises');
const {Writable}=require('node:stream');
const recipes=require('../../operations/recipes.json').products;
async function credentials(input=process.stdin,output=process.stdout) {
  if(!input.isTTY || !output.isTTY)throw Error('Giriş için TTY gerekli; şifre argüman/env/dosyadan alınmaz');
  const normal=readline.createInterface({input,output});
  let name;try{name=(await normal.question('Kullanıcı adı: ')).trim();}finally{normal.close();}
  const muted=new Writable({write(_chunk,_enc,done){done();}});muted.isTTY=true;
  output.write('Şifre: ');
  const hidden=readline.createInterface({input,output:muted,terminal:true});
  try{return {name,password:await hidden.question('')};}finally{hidden.close();output.write('\n');}
}
const referenceBody=r=>({refLengthPx:r.refLengthPx,refLengthCm:r.refLengthCm,refAciklama:r.refAciklama,refBeden:r.refBeden??null});
// "M 52 → L 54" for a record that carries its previous (M) value as backup.
const change=r=>`${r.refLengthCmM!=null?'M '+r.refLengthCmM:'?'} → ${r.refBeden||'?'} ${r.refLengthCm}`;
function loadRecords(json) {
  const rows=JSON.parse(fs.readFileSync(json,'utf8'));
  if(!Array.isArray(rows))throw Error('JSON bir dizi olmalı');
  const names=new Set();
  return rows.map(r=>{
    if(!r || typeof r.ad!=='string'||!r.ad.trim()||names.has(r.ad))throw Error('Kalip adları dolu ve tekil olmalı');names.add(r.ad);
    let reason=r.belirsiz;
    if(!r.urun)reason ||= 'Recipe eşleşmesi yok (urun:null); API urun gerektiriyor';
    else if(!Object.hasOwn(recipes,r.urun))reason ||= 'Recipe anahtarı geçersiz';
    if(!r.dosya || ![r.refLengthCm,r.refLengthPx].every(n=>Number.isFinite(n)&&n>0)||!r.refAciklama?.trim()||r.gorunum!=='on')reason ||= 'Dosya/yatay referans eksik';
    const file=r.dosya?path.resolve(path.dirname(json),r.dosya):null;
    if(!reason&&!fs.statSync(file).isFile())throw Error('PNG dosyası bulunamadı: '+r.ad);
    return {record:r,file,reason};
  });
}
async function upload({api,json,dry=false,update=false,getCredentials=credentials,fetchImpl=fetch,log=console.log}) {
  const base=new URL(api);if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash)throw Error('Geçerli API URL gerekli');
  if(base.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(base.hostname))throw Error('Uzak API için HTTPS gerekli');
  const root=base.href.replace(/\/$/,'').replace(/\/api\/siparis$/,'')+'/api/siparis';
  const entries=loadRecords(json);
  if(dry){for(const e of entries)log(e.reason?`ATLA: ${e.record.ad} — ${e.reason}`:update?`GÜNCELLENECEK: ${e.record.ad} — ${change(e.record)}`:`YÜKLENECEK: ${e.record.ad}`);return {uploaded:0,skipped:entries.length,dry:true};}
  if(entries.every(e=>e.reason)){for(const e of entries)log(`ATLA: ${e.record.ad} — ${e.reason}`);return {uploaded:0,skipped:entries.length};}
  let token;
  const request=async(route,options={})=>{
    const response=await fetchImpl(root+route,{...options,redirect:'error',signal:AbortSignal.timeout(30000),headers:{...(options.body instanceof FormData?{}:{'Content-Type':'application/json'}),...(token?{Authorization:'Bearer '+token}:{}),...options.headers}});
    if(!response.ok)throw Error(`API ${response.status}: ${route}`);return response.json();
  };
  try {
    let auth=await getCredentials();const login=await request('/giris',{method:'POST',body:JSON.stringify(auth)});auth=null;
    token=login.token;if(typeof token!=='string'||!token)throw Error('Giriş token döndürmedi');
    const existing=await request('/duz-cizimler');if(!Array.isArray(existing))throw Error('API kalıp listesi geçersiz');
    const names=new Map(existing.map(r=>[r.ad,r]));let uploaded=0,skipped=0;
    for(const {record:r,file,reason}of entries) {
      if(reason){log(`ATLA: ${r.ad} — ${reason}`);skipped++;continue;}
      if(names.has(r.ad)) {
        // A previous upload may have stopped between POST and PUT. Repair only its missing reference.
        const old=names.get(r.ad);
        const stale=!(old.refLengthPx>0&&old.refLengthCm>0)||(update&&(old.refLengthCm!==r.refLengthCm||(old.refBeden??null)!==(r.refBeden??null)||old.refAciklama!==r.refAciklama));
        if(stale)await request('/duz-cizimler/'+encodeURIComponent(old.id)+'/referans',{method:'PUT',body:JSON.stringify(referenceBody(r))});
        if(update&&stale){log(`GÜNCELLENDİ: ${r.ad} — ${old.refLengthCm>0?'önceki '+old.refLengthCm+' → ':''}${r.refBeden||'?'} ${r.refLengthCm}`);uploaded++;continue;}
        log('ATLA (aynı ad): '+r.ad);skipped++;continue;
      }
      const form=new FormData();for(const key of ['ad','urun','gorunum'])form.append(key,r[key]);
      form.append('file',new Blob([fs.readFileSync(file)],{type:'image/png'}),path.basename(file));
      const created=await request('/duz-cizimler',{method:'POST',body:form});
      await request('/duz-cizimler/'+encodeURIComponent(created.id)+'/referans',{method:'PUT',body:JSON.stringify(referenceBody(r))});
      names.set(r.ad,created);uploaded++;log('YÜKLENDİ: '+r.ad);
    }
    return {uploaded,skipped};
  }finally{token=undefined;}
}
async function main(args=process.argv.slice(2)) {
  const options={};for(let i=0;i<args.length;i++) {if(args[i]==='--kuru')options.dry=true;else if(args[i]==='--guncelle')options.update=true;else if(['--api','--json'].includes(args[i])&&args[i+1])options[args[i++].slice(2)]=args[i];else throw Error('Geçersiz argüman');}
  if(!options.api||!options.json)throw Error('Kullanım: duz-cizim-yukle.js --api <url> --json <json> [--kuru] [--guncelle]');
  console.log(await upload(options));
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={upload,loadRecords,credentials};
