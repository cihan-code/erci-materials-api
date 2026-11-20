'use strict';
// Synthetic end-to-end memory probe. Run separately from the parallel test suite.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
async function main() {
  const mode=process.argv[2],dir=process.argv[3];
  if(mode==='fixtures') {
    const {createCanvas,loadImage}=require('@napi-rs/canvas');
    const {mockup}=require('./fixtures/siparis/oto-mockup');
    const sample=mockup();
    for(const [name,buffer,w,h] of [['product',sample.image,2400,2600],['design',sample.design,3600,2400]]) {
      const canvas=createCanvas(w,h);canvas.getContext('2d').drawImage(await loadImage(buffer),0,0,w,h);
      fs.writeFileSync(path.join(dir,name+'.png'),canvas.toBuffer('image/png'));
    }
    const {PDFDocument}=require('pdf-lib');const pdf=await PDFDocument.create();
    const page=pdf.addPage([600,650]);const image=await pdf.embedPng(sample.image);page.drawImage(image,{x:0,y:0,width:600,height:650});
    fs.writeFileSync(path.join(dir,'product.pdf'),await pdf.save());
    const design=await PDFDocument.create();design.addPage([360,240]).drawRectangle({x:20,y:20,width:300,height:180});
    fs.writeFileSync(path.join(dir,'design.pdf'),await design.save());return;
  }
  if(mode==='flow') {
    const documents=require('../agent/siparis/documents'),{setup}=require('./fixtures/siparis/belge-fixture');
    const originalFork=cp.fork;
    cp.fork=(...args)=>{const child=originalFork(...args),send=child.send.bind(child);child.send=(job,...rest)=>{console.log(JSON.stringify({worker:job.type}));return send(job,...rest);};return child;};
    const f=await setup();
    try {
      f.db.prepare('INSERT INTO document_flats(id,ad,urun,gorunum,dosya,refBeden,refLengthCm,olculerL) VALUES(?,?,?,?,?,?,?,?)')
        .run('regular','SWEAT','sweat','on','synthetic.png','L',60,JSON.stringify({omuzdan_boy:112.2,etek:60}));
      const o=await f.order({lines:[{product_key:'sweat',quantity:1,applications:['gogus','sol_gogus','sirt'].map(position=>({kind:'baski',position}))}]});
      const id=o.version.id,lineId=o.version.lines[0].id;
      const uploads=[
        {kind:'desen_kaynak',buffer:fs.readFileSync(path.join(dir,'design.png'))},
        {kind:'desen_kaynak',buffer:fs.readFileSync(path.join(dir,'design.pdf')),name:'design.pdf',mime:'application/pdf'},
        {kind:'urun_gorsel',gorunum:'on',buffer:fs.readFileSync(path.join(dir,'product.png'))},
        {kind:'urun_gorsel',gorunum:'arka',buffer:fs.readFileSync(path.join(dir,'product.pdf')),name:'product.pdf',mime:'application/pdf'}];
      const results=await Promise.all(uploads.map(input=>f.upload(id,{...input,lineId})));
      for(const r of results)if(r.status!==201)throw new Error(JSON.stringify(r));
      await documents.settled();
      const v=(await f.request(`/surumler/${id}`,{token:f.token})).data;
      for(const app of v.lines[0].applications) {
        const r=await f.request(`/uygulamalar/${app.id}`,{method:'PATCH',token:f.token,body:{desenDosyaId:results[0].data.id}});
        if(r.status!==200)throw new Error(JSON.stringify(r));
      }
      await documents.settled();
      const runs=f.db.prepare("SELECT count(*) n FROM audit_log WHERE action='uygulama_otomatik_olc'").get().n;
      console.log(JSON.stringify({applications:3,automaticMeasurements:runs,previews:documents.vectorStatus(f.db,id).map(r=>r.status)}));
    } finally {await documents.settled();await f.close();fs.rmSync(f.dir,{recursive:true,force:true});}
    return;
  }
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'siparis-memory-'));
  try {
    cp.execFileSync(process.execPath,[__filename,'fixtures',temp]);
    const child=cp.spawn(process.execPath,[__filename,'flow',temp],{stdio:['ignore','pipe','inherit']});
    let stage='startup';const peaks={};
    child.stdout.on('data',chunk=>{for(const line of chunk.toString().trim().split('\n')){try{const value=JSON.parse(line);if(value.worker)stage=value.worker;else console.log(line);}catch{console.log(line);}}});
    let peak=0,parentPeak=0,workerPeak=0,samples=0;
    const timer=setInterval(()=> {
      const rows=cp.execFileSync('ps',['-axo','pid=,ppid=,rss='],{encoding:'utf8'}).trim().split('\n').map(s=>s.trim().split(/\s+/).map(Number));
      const ids=new Set([child.pid]);let added;
      do {added=false;for(const [pid,ppid] of rows)if(ids.has(ppid)&&!ids.has(pid)){ids.add(pid);added=true;}}while(added);
      const parent=rows.find(r=>r[0]===child.pid)?.[2]??0,total=rows.filter(r=>ids.has(r[0])).reduce((sum,r)=>sum+r[2],0);
      peaks[stage]=Math.max(peaks[stage]??0,total/1024);peak=Math.max(peak,total);parentPeak=Math.max(parentPeak,parent);workerPeak=Math.max(workerPeak,total-parent);samples++;
    },25);
    const code=await new Promise(resolve=>child.once('exit',resolve));clearInterval(timer);
    console.log(JSON.stringify({totalPeakMiB:+(peak/1024).toFixed(1),parentPeakMiB:+(parentPeak/1024).toFixed(1),workerPeakMiB:+(workerPeak/1024).toFixed(1),samples,peaks,code}));
    if(code)process.exitCode=code;
  } finally {fs.rmSync(temp,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
