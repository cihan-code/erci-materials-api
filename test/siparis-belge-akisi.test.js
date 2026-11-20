'use strict';
// G41c: forms never stop for an unmeasured application, quantity-free preview, cropped design preview, child sizes and notes.
const {test,after}=require('node:test');
const fileDeadline=setTimeout(()=> {console.error('Belge akışı testi 120 saniyeyi aştı');process.exit(1);},120000);
fileDeadline.unref();
after(()=>clearTimeout(fileDeadline));
const assert=require('node:assert/strict');
const fs=require('node:fs');
const parse=require('pdf-parse');
const {PNG}=require('pngjs');
const {setup,designPng}=require('./fixtures/siparis/belge-fixture');
const {renderProductionForm,renderApprovalForm,renderPrintForm,renderEmbroideryForm}=require('../agent/siparis/pdf');
const {makeExampleOrder}=require('./fixtures/siparis/example-order');

const text=async buffer=>(await parse(buffer)).text;
const ok=(result,status=200)=>{assert.equal(result.status,status,JSON.stringify(result.data));return result.data;};
async function fixture(t) {
  const f=await setup();
  t.after(async()=> {await f.close();fs.rmSync(f.dir,{recursive:true,force:true});});
  return f;
}
const pendingOf=(order,index)=>({...order.applications[index],width_mm:0,height_mm:0,pending:true,preview:undefined});

test('bekleyen ölçü üretim ve onay formunda işaretlenir, atölye formu yalnız ölçülü uygulamayı alır ve eksikleri sayar',async()=> {
  const order=makeExampleOrder({twoColors:false});
  order.applications=[order.applications[0],pendingOf(order,1)];
  for (const render of [renderProductionForm,renderApprovalForm]) assert.match(await text(await render(order)),/Ölçü teyit bekliyor/);
  const print=await text(await renderPrintForm(order));
  assert.match(print,/28 × 12 cm/);assert.doesNotMatch(print,/Ölçü teyit bekliyor/);
  // The embroidery application is the pending one: no workshop form, and the print form does not list it.
  assert.equal(await renderEmbroideryForm(order),null);
  const [,confirmedEmbroidery]=makeExampleOrder({twoColors:false}).applications;
  order.applications=[pendingOf(order,0),confirmedEmbroidery];
  const embroidery=await text(await renderEmbroideryForm(order));
  assert.match(embroidery,/7,5 × 4 cm/);assert.equal(await renderPrintForm(order),null);
  order.applications=[confirmedEmbroidery,{...pendingOf(makeExampleOrder({twoColors:false}),1),type:'nakis',position:'sol_kol'}];
  assert.match(await text(await renderEmbroideryForm(order)),/Eksik:\s*Sol kol nakış uygulaması için ölçü teyidi bekleniyor/);
});

test('adetsiz model üç formda boş tabloları çizer ve hiçbir adet yazmaz',async()=> {
  const order={...makeExampleOrder({twoColors:false}),omitQuantities:true};
  for (const render of [renderProductionForm,renderApprovalForm]) {
    const out=await text(await render(order));
    assert.match(out,/Bedenler/);assert.match(out,/XXL/);assert.doesNotMatch(out,/[Tt]oplam adet:[ \t]*\d|Toplam:[ \t]*\d/);
  }
  assert.match(await text(await renderProductionForm(order)),/Kesilmesi Gerekenler/);
  assert.doesNotMatch(await text(await renderPrintForm(order)),/Adet: \d/);
});

test('çocuk yaş aralıkları kendi sütunlarında yazılır, yetişkin bedenler yalnız verilenle sınırlı kalır',async()=> {
  const order=makeExampleOrder({twoColors:false});
  order.lines[0].sizes={'8-10 yaş':3,'4-6 YAŞ':2,'12 yaş':1};order.lines[0].quantity=6;
  const out=await text(await renderProductionForm(order));
  for (const label of ['4-6 YAŞ','8-10 YAŞ','12 YAŞ']) assert.ok(out.includes(label),label);
  assert.doesNotMatch(out,/Diğer/);assert.doesNotMatch(out,/\n4XL\n/);
});

test('kumaş ve kalıp açıklaması üretim ve atölye formuna girer',async()=> {
  const order=makeExampleOrder({twoColors:false});
  order.lines[0].note='Yeni kalıp, şardonsuz kumaş, lastikli etek.';
  for (const render of [renderProductionForm,renderPrintForm]) assert.match((await text(await render(order))).replace(/\s+/g,' '),/Yeni kalıp, şardonsuz kumaş, lastikli etek\./);
});

test('ayrı desen yoksa baskı formu ürün görselinden kırpılmış kutuyu basar',async()=> {
  const order=makeExampleOrder({twoColors:false});
  const png=PNG.sync.write(Object.assign(new PNG({width:300,height:370}),{data:Buffer.alloc(300*370*4,200)}));
  order.lines[0].images={front:{fileId:5,view:'on',mime:'image/png',buffer:png}};
  const app={...order.applications[1],type:'baski',position:'gogus',preview:undefined,lineIds:[order.lines[0].id],
    placement:{fileId:5,view:'on',page:1,rasterWidth:300,rasterHeight:370,box:{x:100,y:100,w:60,h:40}}};
  order.applications=[app];
  assert.match(await text(await renderPrintForm(order)),/Ürün görselinden kırpıldı/);
  delete app.placement;
  const without=await text(await renderPrintForm(order));
  assert.match(without,/Desen önizlemesi sağlanmadı/);assert.doesNotMatch(without,/kırpıldı/);
});

test('HTTP önizleme ölçü teyidi açıkken de üç formu adetsiz çıkarır, hiçbir dosya kaydetmez',async t=> {
  const f=await fixture(t),o=await f.order(),id=o.version.id;
  const source=ok(await f.upload(id),201);
  ok(await f.measure(o.version.lines[0].id,{desenDosyaId:source.id,imageKind:'photo'}),201);
  const count=table=>f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
  const generated=()=>f.db.prepare("SELECT count(*) n FROM files WHERE kind LIKE '%_formu' OR kind='desen_vektor'").get().n;
  const before=[generated(),count('order_versions'),count('document_preparations')];
  const result=ok(await f.post(`/surumler/${id}/onizleme?adetsiz=1`));
  assert.equal(result.adetsiz,true);assert.equal(result.eksik.length,1);assert.equal(result.eksik[0].position,'sirt');
  assert.deepEqual(result.formlar.map(x=>x.kind).sort(),['onay_formu','uretim_formu']);
  for (const form of result.formlar) assert.equal(Buffer.from(form.pdf,'base64').subarray(0,5).toString(),'%PDF-');
  assert.deepEqual([generated(),count('order_versions'),count('document_preparations')],before);
});

test('HTTP ölçülü uygulama varken önizleme baskı formunu da getirir; satır açıklaması kaydedilir',async t=> {
  const f=await fixture(t),o=await f.order(),id=o.version.id,lineId=o.version.lines[0].id;
  const source=ok(await f.upload(id),201);
  ok(await f.measure(lineId,{desenDosyaId:source.id}),201);
  const patched=await f.request(`/satirlar/${lineId}`,{method:'PATCH',token:f.token,body:{note:'Normal kalıp, şardonlu kumaş.'}});
  assert.equal(patched.status,200,JSON.stringify(patched.data));
  assert.equal(patched.data.note,'Normal kalıp, şardonlu kumaş.');
  const result=ok(await f.post(`/surumler/${id}/onizleme`));
  const kinds=result.formlar.map(x=>x.kind).sort();
  assert.ok(kinds.includes('baski_formu'),kinds.join());assert.equal(result.eksik.length,0);
  assert.equal(result.adetsiz,false);
  assert.equal(f.db.prepare('SELECT note FROM order_lines WHERE id=?').get(lineId).note,'Normal kalıp, şardonlu kumaş.');
  const bad=await f.request(`/satirlar/${lineId}`,{method:'PATCH',token:f.token,body:{note:'x'.repeat(501)}});
  assert.equal(bad.status,400);
});
