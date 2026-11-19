'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { openDb } = require('../agent/siparis/db');
const auth = require('../agent/siparis/auth');
const orders = require('../agent/siparis/orders');
const stock = require('../agent/siparis/stock');
const mount = require('../agent/siparis/routes');
const KEY = 'test-servis-anahtari-0123456789';
async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siparis-panel-'));
  const db = openDb(path.join(dir, 'test.sqlite'));
  process.env.SIPARIS_SERVIS_ANAHTARI = KEY;
  t.after(() => { delete process.env.SIPARIS_SERVIS_ANAHTARI; if (db.open) db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const team = await auth.createUser(db, { name: 'Ekip', password: 'test-password' });
  // The legacy import carries master data only (opening stock is a count), and a readable name opens no eksik_alan teyit.
  stock.importLegacyFabrics(db, { fabrics: [{ id: 'f1', name: 'Şardonlu 3 iplik', colorName: 'Mavi', unit: 'kg' }] });
  const itemId = db.prepare('SELECT id FROM stock_items').get().id;
  stock.recordCount(db, { itemId, countedMilli: 12500, countKey: 'acilis', userId: team.id });
  const order = orders.createOrder(db, { order_no: 'MRC-P1', customer_name: 'Örnek Kulüp', lines: [{ product_key: 'sweat', fabric_item_id: itemId, quantity: 10 }] }, team);
  orders.submitForApproval(db, order.version.id, team);
  db.prepare("INSERT INTO confirmations(kind,ref_table,ref_id,message) VALUES('olcu','x',1,'m'),('olcu','x',2,'m'),('fatura_eslesme','x',3,'m')").run();
  db.prepare("INSERT INTO outbox(kind,idempotency_key,version_id,payload_json,status) VALUES('maliyet_aktarim','k1',?, '{}','fiyat_bekliyor'),('atolye_dosya','k2',?, '{}','manuel_bekliyor'),('atolye_dosya','k3',?, '{}','basarisiz')")
    .run(order.version.id, order.version.id, order.version.id);
  db.prepare("INSERT INTO allocations(order_line_id,material_key,item_id,need_milli,reserved_milli,shortage_milli) VALUES(?,?,?,?,?,?)").run(order.version.lines[0].id, 'kumas', itemId, 5000, 2000, 3000);
  const app = express();
  mount(app, { db, dataDir: dir, worker: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => { server.close(r); server.closeAllConnections?.(); }));
  return { db, team, base: `http://127.0.0.1:${server.address().port}/api/siparis` };
}
test('panel-veri: 401 without credentials or with wrong key', async t => {
  const f = await setup(t);
  assert.equal((await fetch(f.base + '/panel-veri')).status, 401);
  assert.equal((await fetch(f.base + '/panel-veri', { headers: { authorization: 'Bearer yanlis-anahtar-0123456789' } })).status, 401);
});
test('panel-veri: service key returns Turkish summary without prices and writes nothing', async t => {
  const f = await setup(t);
  const before = f.db.prepare('SELECT (SELECT count(*) FROM audit_log) a,(SELECT count(*) FROM outbox) o').get();
  const res = await fetch(f.base + '/panel-veri', { headers: { authorization: `Bearer ${KEY}` } });
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.surum, 1);
  assert.ok(!Number.isNaN(Date.parse(d.uretildi)));
  assert.deepEqual(d.onay_bekleyen.map(x => [x.siparis_no, x.surum, x.musteri]), [['MRC-P1', 1, 'Örnek Kulüp']]);
  assert.ok(d.onay_bekleyen[0].gonderildi);
  assert.deepEqual(d.teyitler, { toplam: 3, turlere_gore: { olcu: 2, fatura_eslesme: 1 } });
  assert.deepEqual(d.tedarik_bekleyen, [{ kalem: 'Şardonlu 3 iplik', renk: 'Mavi', kg: 3 }]);
  assert.deepEqual(d.atolye, { elle_bekleyen: 1, basarisiz: 1 });
  assert.deepEqual(d.maliyet, { fiyat_bekleyen: [{ siparis_no: 'MRC-P1', surum: 1 }], basarisiz: 0 });
  assert.deepEqual(d.stok_ozet, { kalem_sayisi: 1, kullanilabilir_kg_toplam: 10.5 });
  assert.doesNotMatch(JSON.stringify(d), /"(fiyat|tutar|price|amount|birim_fiyat|toplam_tutar)":/i);
  assert.deepEqual(f.db.prepare('SELECT (SELECT count(*) FROM audit_log) a,(SELECT count(*) FROM outbox) o').get(), before);
});
test('panel-veri: a user session token is accepted, unset service key never matches', async t => {
  const f = await setup(t);
  const login = await auth.login(f.db, { name: 'Ekip', password: 'test-password' });
  assert.equal((await fetch(f.base + '/panel-veri', { headers: { authorization: `Bearer ${login.token}` } })).status, 200);
  process.env.SIPARIS_SERVIS_ANAHTARI = 'kisa-anahtar';
  assert.equal((await fetch(f.base + '/panel-veri', { headers: { authorization: 'Bearer kisa-anahtar' } })).status, 401, 'a key under 16 characters never matches');
  delete process.env.SIPARIS_SERVIS_ANAHTARI;
  assert.equal((await fetch(f.base + '/panel-veri', { headers: { authorization: 'Bearer undefined' } })).status, 401);
});
