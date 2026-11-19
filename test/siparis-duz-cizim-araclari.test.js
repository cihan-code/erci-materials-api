'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {PNG}=require('pngjs');
const {spawnSync}=require('node:child_process');
const {prepare,horizontalReference,redMask}=require('../agent/siparis/tools/duz-cizim-hazirla');
const {upload}=require('../agent/siparis/tools/duz-cizim-yukle');
const {setup}=require('./fixtures/siparis/belge-fixture');
function temp(t){const p=fs.mkdtempSync(path.join(os.tmpdir(),'g22-test-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;}
// This garment and all dimensions are invented. No company artwork or settings.
function fake({dots=false,second=false}={}) {
  const p=new PNG({width:420,height:400});for(let i=0;i<p.data.length;i+=4)p.data.set([250,248,243,255],i);
  const pixel=(x,y,c)=>p.data.set([...c,255],(y*p.width+x)*4);
  const line=(x1,y1,x2,y2,c)=>{const n=Math.max(Math.abs(x2-x1),Math.abs(y2-y1));for(let i=0;i<=n;i++)pixel(Math.round(x1+(x2-x1)*i/n),Math.round(y1+(y2-y1)*i/n),c);};
  const black=[30,30,30],red=[195,65,40];
  for(const [a,b,c,d]of [[70,70,270,70],[70,70,70,285],[270,70,270,285],[70,285,270,285],[10,15,310,15],[10,340,350,340]])line(a,b,c,d,black);
  for(const yy of second?[140,220]:[140]) {
    line(80,yy,260,yy,red);for(let x=155;x<=175;x++)pixel(x,yy,[250,248,243]);
    if(dots)for(const xx of [80,260])for(let dy=-4;dy<=4;dy++)for(let dx=-4;dx<=4;dx++)if(dx*dx+dy*dy<=16)pixel(xx+dx,yy+dy,red);
    else for(const xx of [80,260])line(xx,yy-8,xx,yy+8,red);
  }
  // An unrelated vertical red measurement close to the right cap.
  line(290,85,290,280,red);
  return p;
}
function data(t){const dir=temp(t),source=path.join(dir,'source'),output=path.join(dir,'output');fs.mkdirSync(source);fs.writeFileSync(path.join(source,'fake.png'),PNG.sync.write(fake()));const config={'fake.png':{ad:'Uydurma Tişört',urun:'tisort',refLengthCm:52,refY:[135,145],bolge:{x:50,y:55,w:260,h:250},refAciklama:'Uydurma M / göğüs'}};return {dir,source,output,config};}
test('red caps and round endpoints are detected within 2px, excluding nearby vertical line',()=>{
  for(const dots of [false,true]){const p=fake({dots}),r=horizontalReference(p,redMask(p),{x:50,y:55,w:260,h:250},[135,145]);assert.ok(Math.abs(r.x1-80)<=2);assert.ok(Math.abs(r.x2-260)<=2);assert.equal(r.y1,r.y2);}
});
test('crop adds exactly 20px, excludes fake logo/table, removes red, preserves dark garment and coordinates',t=>{
  const f=data(t),rows=prepare(f.source,f.output,f.config),r=rows[0];assert.equal(r.belirsiz,undefined);assert.deepEqual(r.kirpma,{x:50,y:50,w:241,h:256});assert.equal(r.refLengthPx,180);assert.equal(r.refUcNoktalar.x2-r.refUcNoktalar.x1,r.refLengthPx);assert.equal(r.refUcNoktalar.y1,90);
  const p=PNG.sync.read(fs.readFileSync(path.join(f.output,r.dosya)));assert.equal(redMask(p).reduce((a,b)=>a+b,0),0);assert.equal(p.data[((100-r.kirpma.y)*p.width+70-r.kirpma.x)*4],30);
  const before=fs.readFileSync(path.join(f.output,'duz-cizimler.json'));prepare(f.source,f.output,f.config);assert.deepEqual(before,fs.readFileSync(path.join(f.output,'duz-cizimler.json')));
});
test('multiple arrows and missing cm are marked uncertain with a review preview, no guessed scale',t=>{
  const f=data(t);fs.writeFileSync(path.join(f.source,'fake.png'),PNG.sync.write(fake({second:true})));f.config['fake.png'].refY=[130,230];let r=prepare(f.source,f.output,f.config)[0];assert.match(r.belirsiz,/Birden fazla/);assert.equal(r.refLengthPx,null);assert.equal(fs.readdirSync(path.join(f.output,'onizleme')).length,1);
  delete f.config['fake.png'].refLengthCm;r=prepare(f.source,f.output,f.config)[0];assert.match(r.belirsiz,/doğrulanmış/);
});
test('dry CLI reads the manifest without login or network; null recipes are explicit skips',async t=>{
  const f=data(t),rows=prepare(f.source,f.output,f.config);rows.push({...rows[0],ad:'Recipe Yok',urun:null});const json=path.join(f.output,'duz-cizimler.json');fs.writeFileSync(json,JSON.stringify(rows));
  const logs=[];await upload({api:'http://127.0.0.1:1',json,dry:true,getCredentials:()=>assert.fail('login'),fetchImpl:()=>assert.fail('network'),log:s=>logs.push(s)});assert.match(logs.join('\n'),/urun:null/);
  const cli=spawnSync(process.execPath,['agent/siparis/tools/duz-cizim-yukle.js','--api','http://127.0.0.1:1','--json',json,'--kuru'],{encoding:'utf8'});assert.equal(cli.status,0,cli.stderr);assert.match(cli.stdout,/YÜKLENECEK/);assert.doesNotMatch(cli.stdout,/Şifre/);
});
test('local HTTP E2E uploads generated PNG, saves reference, skips duplicate and measures half chest as 26cm',async t=>{
  const d=data(t),rows=prepare(d.source,d.output,d.config),r=rows[0];
  // setup uses only a temporary DATA_DIR and loopback HTTP server.
  const dataDir=path.join(d.dir,'DATA_DIR');fs.mkdirSync(dataDir);const f=await setup({dataDir});t.after(()=>f.close());
  const args={api:f.base,json:path.join(d.output,'duz-cizimler.json'),getCredentials:async()=>({name:f.manager.name,password:'synthetic-password'}),log:()=>{}};
  assert.deepEqual(await upload(args),{uploaded:1,skipped:0});assert.deepEqual(await upload(args),{uploaded:0,skipped:1});
  const flats=(await f.request('/duz-cizimler',{token:f.managerToken})).data;assert.equal(flats.length,1);assert.equal(flats[0].refLengthPx,r.refLengthPx);assert.equal(flats[0].refLengthCm,52);
  const order=await f.order(),result=await f.measure(order.version.lines[0].id,{flatId:flats[0].id,designBoxPx:{w:r.refLengthPx/2,h:r.refLengthPx/4}});assert.equal(result.status,201,JSON.stringify(result.data));assert.ok(Math.abs(result.data.width_mm/10-26)<=.5);assert.equal(result.data.width_mm/result.data.height_mm,2);
});
