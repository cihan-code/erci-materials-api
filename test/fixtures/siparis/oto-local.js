'use strict';
// Local HTTP end-to-end trial. Never supplies a design file or writes real
// pixels into fixtures. Usage: node test/fixtures/siparis/oto-local.js image.png output-dir
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {setup}=require('./belge-fixture');
const {multiMockup}=require('./oto-multi');
const {createCanvas,loadImage}=require('@napi-rs/canvas');
async function trial(filename,outputDir) {
  fs.mkdirSync(outputDir,{recursive:true});
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'g24c-local-')),f=await setup({dataDir:dir});
  const ok=(r,status=200)=>{if(r.status!==status)throw new Error(JSON.stringify(r));return r.data;};
  try {
    const buffer=fs.readFileSync(filename),root=path.join(dir,'siparis','flats');fs.mkdirSync(root,{recursive:true});
    const flatFile=path.join(root,'synthetic-sweat.png');fs.writeFileSync(flatFile,multiMockup({missing:true}).image);
    const olculerL={gogus:61,omuzdan_boy:71,etek:52,tum_omuz:61.5};
    f.db.prepare('INSERT INTO document_flats(id,ad,urun,gorunum,dosya,refBeden,olculerL) VALUES(?,?,?,?,?,?,?)').run('local-sweat','Sentetik SWEAT L referansı','sweat','on',flatFile,'L',JSON.stringify(olculerL));
    const o=await f.order({order_no:'G24C-YEREL-DENEME',lines:[{product_key:'sweat',color_name:'Lacivert',quantity:1,sizes:{L:1}}]}),v=o.version.id,line=o.version.lines[0];
    for(const gorunum of ['on','arka'])ok(await f.upload(v,{kind:'urun_gorsel',lineId:line.id,gorunum,buffer}),201);
    for(const [kind,position] of [['nakis','gogus'],['baski','sirt']])ok(await f.post(`/satirlar/${line.id}/uygulamalar`,{kind,position}),201);
    const results=ok(await f.post(`/surumler/${v}/otomatik-olc`)).results;
    const report={order:o.order_no,product:'sweat',olculerL,designFileCount:f.db.prepare("SELECT count(*) n FROM files WHERE kind='desen_kaynak'").get().n,results};
    fs.writeFileSync(path.join(outputDir,'g24c-sonuc.json'),JSON.stringify(report,null,2)+'\n');
    const original=await loadImage(buffer),c=createCanvas(original.width,original.height),x=c.getContext('2d');x.drawImage(original,0,0);
    const rows=[];
    for(const [i,r] of results.entries()) {
      const s=r.measure_source,b=s.designBoxPx,color=i?'#ff931e':'#00bb88';
      if(b){x.strokeStyle=color;x.lineWidth=3;x.strokeRect(b.x,b.y,b.w,b.h);x.font='bold 19px sans-serif';x.fillStyle=color;x.fillText(`${s.selectedView}: ${r.width_mm/10} x ${r.height_mm/10} cm`,b.x,b.y-12);}
      const p=s.productBoxPx;if(p){x.strokeStyle=color;x.lineWidth=2;x.setLineDash([8,5]);x.beginPath();x.moveTo(p.x,s.shoulderY);x.lineTo(p.x+p.w,s.shoulderY);x.stroke();x.setLineDash([]);}
      rows.push(`| ${s.selectedView} | ${b?`${b.x}, ${b.y}, ${b.w}, ${b.h}`:'yok'} | ${s.verticalMmPerPx?.toFixed(6)} | ${s.horizontalMmPerPx?.toFixed(6)} | ${s.mmPerPx?.toFixed(6)} | ${r.width_mm/10} × ${r.height_mm/10} | ${r.needs_confirmation?r.reason:'yok'} |`);
    }
    fs.writeFileSync(path.join(outputDir,'g24c-kutular.png'),c.toBuffer('image/png'));
    fs.writeFileSync(path.join(outputDir,'g24c-rapor.md'),`# G24c yerel uçtan uca deneme\n\nSentetik sipariş; sweat L; Nakış · Göğüs ve Baskı · Sırt. Aynı PNG iki ürün görünümüne yüklendi. Desen dosyası: ${report.designFileCount}. Kaynak: otomatik_renk.\n\n| Görünüm | Kutu x,y,w,h (px) | Boy mm/px | Etek mm/px | Ortalama mm/px | Sonuç cm | Teyit |\n|---|---|---|---|---|---|---|\n${rows.join('\n')}\n\nÖn/arka ortalama ölçek farkı: %${(results[0]?.measure_source.viewScaleDifference*100).toFixed(2)}.\nKutu ve omuz çizgileri: g24c-kutular.png. Tam teşhis: g24c-sonuc.json.\n`);
    return report;
  } finally {await f.close();fs.rmSync(dir,{recursive:true,force:true});}
}
if(require.main===module)trial(path.resolve(process.argv[2]),path.resolve(process.argv[3])).then(report=>console.log(JSON.stringify(report.results.map(r=>({width_mm:r.width_mm,height_mm:r.height_mm,box:r.measure_source.designBoxPx,scale:r.measure_source.mmPerPx,reason:r.reason})),null,2))).catch(e=>{console.error(e);process.exitCode=1;});
module.exports={trial};
