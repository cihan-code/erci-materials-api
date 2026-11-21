'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const PDFKit = require('pdfkit');
const pdf = require('../agent/siparis/pdf');
const flats = require('../agent/siparis/flats');
const documents = require('../agent/siparis/documents');
const { openDb } = require('../agent/siparis/db');
const { makeExampleOrder } = require('./fixtures/siparis/example-order');

// Deliberately irregular invented values: no size can be reconstructed from L.
const chart = { birim:'cm', kaynak:'sentetik-kalip.png', bedenler:{ S:{boy:63.2,gogus:47}, M:{boy:68,gogus:51.8}, L:{boy:72.1,gogus:56}, XL:{boy:74,gogus:59.3} } };
function order(withChart = true) {
  const o = makeExampleOrder({ twoColors:false });
  o.description = [];
  o.lines[0].bedenTablosu = withChart ? chart : undefined;
  const base = o.applications[0];
  o.applications = ['sag_kol','sol_kol','ense','sol_gogus','sirt'].map(position => ({ ...base, type:'baski', position, measureNote:'Sentetik kaynak' }));
  return o;
}
async function inspect(buffer) {
  const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await lib.getDocument({ data:Uint8Array.from(buffer), isEvalSupported:false, verbosity:0 }).promise;
  try {
    const pages = [];
    for (let n=1; n<=doc.numPages; n++) {
      const page = await doc.getPage(n), ops = await page.getOperatorList();
      const text = (await page.getTextContent()).items, images = [];
      let matrix;
      for (let i=0; i<ops.fnArray.length; i++) {
        if (ops.fnArray[i]===lib.OPS.transform) matrix=Array.from(ops.argsArray[i]);
        if (ops.fnArray[i]===lib.OPS.paintImageXObject && matrix) images.push({x:matrix[4],y:matrix[5]-Math.abs(matrix[3]),w:Math.abs(matrix[0]),h:Math.abs(matrix[3])});
      }
      pages.push({width:page.view[2],height:page.view[3],text,images});
    }
    return pages;
  } finally { await doc.destroy(); }
}
async function capture(render, input) {
  const shapes = [], original = PDFKit.prototype.roundedRect;
  PDFKit.prototype.roundedRect = function(x,y,w,h,...args) {
    shapes.push({x,y,w,h,width:this.page.width,height:this.page.height,page:this.bufferedPageRange().count});
    return original.call(this,x,y,w,h,...args);
  };
  try { return { shapes, pages:await inspect(await render(input)) }; }
  finally { PDFKit.prototype.roundedRect=original; }
}
const joined = pages => pages.map(p=>p.text.map(t=>t.str).join(' ')).join('\n');
const overlap = (a,b) => a.x < b.x+b.w-0.5 && b.x < a.x+a.w-0.5 && a.y < b.y+b.h-0.5 && b.y < a.y+a.h-0.5;

test('G57 approval/print/embroidery: five cards start in the right column, wrap below and never overlap', async () => {
  for (const render of [pdf.renderApprovalForm,pdf.renderPrintForm,pdf.renderEmbroideryForm]) for (const withChart of [true,false]) {
    const input=order(withChart);
    if (render===pdf.renderEmbroideryForm) input.applications.forEach(a=>a.type='nakis');
    const {pages,shapes}=await capture(render,input), first=pages[0];
    assert.equal(first.text.filter(t=>t.str.startsWith('En:')).length,5,render.name);
    const cards=shapes.filter(s=>s.w<=220 && s.h===Math.round(s.w*0.5));
    assert.equal(cards.length,10); // fill and outline, five cards
    const products=first.images.filter(i=>i.w>100 && i.y>220).slice(0,2);
    assert.equal(products.length,2);
    assert.ok(cards[0].x >= Math.max(...products.map(i=>i.x+i.w)),render.name);
    for (const p of pages) {
      for (const a of p.images) {
        assert.ok(a.x>=0 && a.y>=0 && a.x+a.w<=p.width+0.5 && a.y+a.h<=p.height+0.5,JSON.stringify(a));
        for (const b of p.images) if (a!==b) assert.ok(!overlap(a,b),JSON.stringify([a,b]));
      }
      for (const t of p.text) assert.ok(t.transform[4]>=0 && t.transform[4]+t.width<=p.width+0.5 && t.transform[5]>=0 && t.transform[5]<=p.height);
    }
    for (const s of shapes) assert.ok(s.x>=0 && s.y>=0 && s.x+s.w<=s.width && s.y+s.h<=s.height,JSON.stringify(s));
  }
});

test('G57 bounded equal-height header columns include swatch, order, date and dotted empty counts', async () => {
  for (const render of [pdf.renderApprovalForm,pdf.renderPrintForm]) {
    const input=order(); input.omitQuantities=true; input.lines[0].color='Mavi (Kartela 8)';
    const {pages,shapes}=await capture(render,input), bands=shapes.filter(s=>s.page===1 && s.w>250 && s.h>=36 && s.y<300);
    assert.equal(bands.length,5);
    for (const i of [0,2]) {
      assert.equal(bands[i].y,bands[i+1].y); assert.equal(bands[i].w,bands[i+1].w); assert.equal(bands[i].h,bands[i+1].h);
      assert.ok(bands[i].x>=40 && bands[i+1].x+bands[i+1].w<=pages[0].width-40);
    }
    const text=joined(pages);
    for (const value of ['Kartela 8',input.orderNo,input.date,'S:…','Toplam']) assert.ok(text.includes(value),value);
    assert.doesNotMatch(text,/Toplam(?: adet)?:\s*\d/);
  }
});

test('G57 wrapped headers and two models preserve table, card and page boundaries', async () => {
  for (const render of [pdf.renderApprovalForm,pdf.renderPrintForm]) {
    const input=order();
    input.orderNo='G57-'+'uzun sipariş kodu '.repeat(5);
    input.lines[0].product='Sentetik ürün modeli '.repeat(4);
    input.lines[1]={...input.lines[0],id:'ikinci-model',product:'İkinci sentetik model'};
    const {pages,shapes}=await capture(render,input);
    const firstBands=shapes.filter(s=>s.page===1 && s.w>250 && s.h>=36 && s.y<300);
    assert.equal(firstBands.length,5);
    assert.ok(firstBands[0].h>36);
    assert.equal(firstBands[0].h,firstBands[1].h);
    assert.equal(joined(pages).match(/En: /g).length,10);
    for (const s of shapes) assert.ok(s.x>=0 && s.y>=0 && s.x+s.w<=s.width && s.y+s.h<=s.height,JSON.stringify(s));
    for (const p of pages) {
      for (const t of p.text) assert.ok(t.transform[4]>=0 && t.transform[4]+t.width<=p.width+0.5 && t.transform[5]>=0 && t.transform[5]<=p.height);
      for (const a of p.images) for (const b of p.images) if(a!==b) assert.ok(!overlap(a,b),JSON.stringify([a,b]));
    }
  }
});

test('G57 table prints only source-backed Boy/Göğüs pairs, above cards, without L extrapolation', async () => {
  for (const render of [pdf.renderApprovalForm,pdf.renderPrintForm]) {
    const pages=await inspect(await render(order())), text=joined(pages), first=pages[0];
    for (const value of ['(A) Boy','(B) Göğüs','63,2','51,8','72,1','59,3']) assert.ok(text.includes(value),value);
    assert.equal(first.text.filter(t=>t.str==='XS').length,0);
    const table=first.text.filter(t=>['63,2','51,8','72,1','59,3'].includes(t.str));
    const firstCard=first.text.find(t=>t.str.startsWith('Baskı ·'));
    assert.ok(table.every(t=>t.transform[5]>firstCard.transform[5]));
    for (const missing of [undefined, {birim:'cm',bedenler:chart.bedenler}, {...chart,bedenler:{L:{yan_boy:90,basen:55}}}]) {
      const input=order(false); input.lines[0].bedenTablosu=missing; input.lines[0].olculerL={gogus:56,omuzdan_boy:72};
      assert.doesNotMatch(joined(await inspect(await render(input))),/Beden Ölçüleri|\(A\) Boy|\(B\) Göğüs/);
    }
  }
});

test('G57 import dry run writes nothing; only empty tables fill; stored values and scale stay intact', () => {
  const db=openDb(':memory:');
  try {
    flats.init(db);
    for (const [id,ad] of [['a','TİŞÖRT'],['b','Oversize Tişört']]) db.prepare('INSERT INTO document_flats(id,ad,urun,gorunum,dosya,refBeden,refLengthCm) VALUES(?,?,?,?,?,?,?)').run(id,ad,'tisort','on','sentetik.png','L',56);
    db.prepare('UPDATE document_flats SET bedenTablosu=? WHERE id=?').run(JSON.stringify(chart),'b');
    const records=['TİŞÖRT','Oversize Tişört'].map(ad=>({ad,urun:'tisort',bedenTablosu:{...chart,kaynak:'yeni-sentetik.png'}}));
    assert.equal(flats.fillMissingSizeCharts(db,records,{dry:true}).filled,1);
    assert.equal(flats.get(db,'a').bedenTablosu,null);
    assert.equal(db.prepare("SELECT count(*) n FROM audit_log WHERE action='kalip_beden_tamamla'").get().n,0);
    assert.equal(flats.fillMissingSizeCharts(db,records).filled,1);
    assert.equal(flats.get(db,'a').bedenTablosu.kaynak,'yeni-sentetik.png');
    assert.deepEqual(flats.get(db,'b').bedenTablosu,chart);
    assert.equal(flats.get(db,'a').refLengthCm,56);
    assert.equal(flats.fillMissingSizeCharts(db,records).filled,0);
    assert.throws(()=>flats.fillMissingSizeCharts(db,[{ad:'TİŞÖRT',bedenTablosu:{...chart,kaynak:''}}]));
  } finally { db.close(); }
});

test('G57 CLI --kuru and real import; form model uses the selected pattern, never another product variant', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'g57-chart-')), file=path.join(dir,'tables.json');
  let db=openDb(path.join(dir,'siparis.sqlite'));
  try {
    flats.init(db);
    db.prepare("INSERT INTO orders(id,order_no,customer_name) VALUES(1,'G57-SYN','Sentetik')").run();
    for (const [id,ad] of [['a','TİŞÖRT'],['b','Oversize Tişört']]) db.prepare('INSERT INTO document_flats(id,ad,urun,gorunum,dosya,refBeden) VALUES(?,?,?,?,?,?)').run(id,ad,'tisort','on','sentetik.png','L');
    fs.writeFileSync(file,JSON.stringify([{ad:'Oversize Tişört',urun:'tisort',bedenTablosu:chart}]));
    const run=extra=>spawnSync(process.execPath,['agent/siparis/cli.js','kalip-beden-tamamla',file,...extra],{env:{...process.env,DATA_DIR:dir},encoding:'utf8'});
    assert.equal(run(['--kuru']).status,0); assert.equal(flats.get(db,'b').bedenTablosu,null);
    assert.equal(run([]).status,0);
    const line={id:1,product_key:'tisort',color_name:'Mavi',sizes_json:'{}',quantity:1,applications:[]};
    const v={order_id:1,version_no:1,lines:[line],files:[]};
    assert.equal(documents.formOrder(db,dir,v,new Map()).lines[0].bedenTablosu,undefined);
    line.kalip_id='b';
    assert.deepEqual(documents.formOrder(db,dir,v,new Map()).lines[0].bedenTablosu,chart);
  } finally { db.close(); fs.rmSync(dir,{recursive:true,force:true}); }
});

test('G57 importing the selected chart makes old prepared forms stale; other variants leave them fresh', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'g57-fresh-')), db=openDb(path.join(dir,'siparis.sqlite'));
  try {
    documents.init(db); flats.init(db);
    const user=await require('../agent/siparis/auth').createUser(db,{name:'Sentetik G57',password:'sentetik-sifre-g57',role:'yonetici'});
    const orders=require('../agent/siparis/orders');
    for(const [id,ad] of [['a','TİŞÖRT'],['b','Oversize Tişört']]) db.prepare('INSERT INTO document_flats(id,ad,urun,gorunum,dosya,refBeden) VALUES(?,?,?,?,?,?)').run(id,ad,'tisort','on','sentetik.png','L');
    const {version}=orders.createOrder(db,{order_no:'G57-TABLO',customer_name:'Sentetik',lines:[{product_key:'tisort',color_name:'Mavi',quantity:1,sizes:{L:1}}]},user);
    await documents.prepare(db,dir,version.id,user);
    flats.fillMissingSizeCharts(db,[{ad:'Oversize Tişört',bedenTablosu:chart}]);
    assert.doesNotThrow(()=>documents.assertFresh(db,orders.snapshot(db,version.id)));
    flats.fillMissingSizeCharts(db,[{ad:'TİŞÖRT',bedenTablosu:chart}]);
    assert.throws(()=>documents.assertFresh(db,orders.snapshot(db,version.id)),/yeniden=1/);
    const files=await documents.prepare(db,dir,version.id,user,true);
    assert.doesNotThrow(()=>documents.assertFresh(db,orders.snapshot(db,version.id)));
    assert.match(joined(await inspect(documents.readFile(dir,files.find(f=>f.kind==='onay_formu')))),/Beden Ölçüleri/);
  } finally { db.close(); fs.rmSync(dir,{recursive:true,force:true}); }
});
