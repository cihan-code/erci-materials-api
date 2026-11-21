'use strict';
// G45c: mockup scale note on forms, sample (numune) lines, one-page production forms.
const {test,after}=require('node:test');
const fileDeadline=setTimeout(()=> {console.error('G45c testi 120 saniyeyi aştı');process.exit(1);},120000);
fileDeadline.unref();
after(()=>clearTimeout(fileDeadline));
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const Database=require('better-sqlite3');
const parse=require('pdf-parse');
const {setup}=require('./fixtures/siparis/belge-fixture');
const {openDb}=require('../agent/siparis/db');
const cost=require('../agent/siparis/costTransfer');
const {renderProductionForm,renderApprovalForm,renderPrintForm,renderEmbroideryForm}=require('../agent/siparis/pdf');
const {makeExampleOrder}=require('./fixtures/siparis/example-order');

const parsed=async buffer=>parse(buffer);
const NOTE='Mockup oranı kalıptan farklı (%28,9); ölçek boy ile göğüs ortalaması';
async function fixture(t) {
  const f=await setup();
  t.after(async()=> {await f.close();fs.rmSync(f.dir,{recursive:true,force:true});});
  return f;
}

test('geometrik ortalama notu ölçünün yanında ≈ ve dipnot olarak üç formda çıkar',async()=> {
  const order=makeExampleOrder({twoColors:false});
  order.applications[0].scaleNote=NOTE;
  for (const render of [renderProductionForm,renderApprovalForm,renderPrintForm]) {
    const {text}=await parsed(await render(order));
    // G54: the approximate size is on the application card ("En … Boy … ≈").
    assert.match(text,/En: 28 cm\s+Boy: 12 cm ≈/);assert.ok(text.replace(/\s+/g,' ').includes('≈ '+NOTE),render.name);
  }
  // Without a note nothing changes.
  delete order.applications[0].scaleNote;
  assert.doesNotMatch((await parsed(await renderProductionForm(order))).text,/≈/);
});

test('NUMUNE rozeti ve boş adet alanları: adedi olmayan numune satırı',async()=> {
  const order=makeExampleOrder({twoColors:false});
  Object.assign(order.lines[0],{numune:true,sizes:{},quantity:0});
  for (const render of [renderProductionForm,renderApprovalForm,renderPrintForm,renderEmbroideryForm]) {
    const {text}=await parsed(await render(order));
    assert.match(text,/NUMUNE/);assert.doesNotMatch(text,/[Tt]oplam adet:[ \t]*\d|Toplam:[ \t]*\d/);
  }
  assert.doesNotMatch((await parsed(await renderProductionForm(makeExampleOrder({twoColors:false})))).text,/NUMUNE/);
});

test('çok uygulamalı üretim formu bedenlerle birlikte tek sayfaya sığar',async()=> {
  for (const blank of [false,true]) {
    const order={...makeExampleOrder({twoColors:false}),omitQuantities:blank};
    const base=order.applications[0];
    order.applications=[base,{...base,position:'gogus'},{...base,type:'nakis',position:'sol_kol',scaleNote:NOTE},{...base,type:'nakis',position:'sag_kol'},
      {...base,position:'sol_gogus'},{...base,position:'ense'},{...base,type:'nakis',position:'sirt'}];
    order.description=['Dikiş ve kumaş rengi numuneyle eşleşecek, uzun bir açıklama satırı ile form alanını daraltır.','İkinci satır.'];
    order.lines[0].note='Yeni kalıp, şardonsuz kumaş, lastikli etek.';
    const result=await parsed(await renderProductionForm(order));
    assert.equal(result.numpages,1,`blank=${blank}`);
  }
});

test('numune satırı adetsiz kaydedilir; numunesiz satırda adet zorunlu kalır',async t=> {
  const f=await fixture(t);
  const sample=await f.order({order_no:'MRC-NUM1',lines:[{product_key:'tisort',color_name:'Mavi',numune:true,sizes:{}}]});
  const line=sample.version.lines[0];
  assert.equal(line.quantity,0);assert.equal(line.numune,1);
  const bad=await f.request('/siparisler',{method:'POST',token:f.token,body:{order_no:'MRC-NUM2',lines:[{product_key:'tisort',quantity:0,sizes:{}}]}});
  assert.equal(bad.status,400);
  assert.throws(()=>f.db.prepare("INSERT INTO order_lines(version_id,line_key,product_key,quantity) VALUES(?,?,?,0)").run(sample.version.id,'x','tisort'));
});

test('eski şemadaki order_lines yeniden başlatmada veri kaybı olmadan numune destekler',()=> {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'siparis-numune-goc-'));
  const file=path.join(dir,'siparis.sqlite');
  try {
    let schema=fs.readFileSync(path.join(__dirname,'../agent/siparis/schema.sql'),'utf8');
    schema=schema.replace("quantity>=0","quantity>0").replace(" numune INTEGER NOT NULL DEFAULT 0 CHECK(numune IN (0,1)),\n","").replace(", CHECK(quantity>0 OR numune=1)","");
    const old=new Database(file);old.exec(schema);
    old.prepare("INSERT INTO users(id,name,password_hash,role) VALUES(1,'a','x','yonetici')").run();
    old.prepare("INSERT INTO orders(id,order_no) VALUES(1,'MRC-G1')").run();
    old.prepare("INSERT INTO order_versions(id,order_id,version_no,created_by) VALUES(1,1,1,1)").run();
    old.prepare("INSERT INTO order_lines(id,version_id,line_key,product_key,quantity,sizes_json,note) VALUES(7,1,'k','tisort',3,'{\"M\":3}','not')").run();
    old.prepare("INSERT INTO applications(line_id,kind,position) VALUES(7,'baski','sirt')").run();
    old.close();
    const db=openDb(file);
    const row=db.prepare('SELECT * FROM order_lines WHERE id=7').get();
    assert.deepEqual([row.quantity,row.sizes_json,row.note,row.numune],[3,'{"M":3}','not',0]);
    assert.equal(db.prepare('SELECT count(*) n FROM applications WHERE line_id=7').get().n,1);
    db.prepare("INSERT INTO order_lines(version_id,line_key,product_key,quantity,numune) VALUES(1,'n','tisort',0,1)").run();
    assert.throws(()=>db.prepare("INSERT INTO order_lines(version_id,line_key,product_key,quantity) VALUES(1,'z','tisort',0)").run());
    assert.equal(db.pragma('foreign_key_check').length,0);
    db.close();
    openDb(file).close();
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('maliyet aktarımı adedi 0 olan numune satırını kg ve beden hesabına katmaz',async t=> {
  const f=await fixture(t);
  const o=await f.order({order_no:'MRC-NUM3',lines:[{product_key:'tisort',color_name:'Mavi',quantity:5,sizes:{M:5}},{product_key:'tisort',color_name:'Mavi',numune:true,sizes:{}}]});
  const v={id:o.version.id,order_no:'MRC-NUM3'};
  const facts=cost.orderFacts(f.db,v,{products:{tisort:{label:'Tişört'}}});
  assert.equal(facts.total,5);assert.deepEqual(facts.sizes,{M:5});
  const only=await f.order({order_no:'MRC-NUM4',lines:[{product_key:'tisort',numune:true,sizes:{}}]});
  assert.throws(()=>cost.orderFacts(f.db,{id:only.version.id,order_no:'MRC-NUM4'},{products:{tisort:{label:'Tişört'}}}),/numune adedi 0/);
});
