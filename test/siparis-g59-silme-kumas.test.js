'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { openDb } = require('../agent/siparis/db');
const auth = require('../agent/siparis/auth');
const orders = require('../agent/siparis/orders');
const { approveVersion } = require('../agent/siparis/approval');
const stock = require('../agent/siparis/stock');
const { fabricTypeList } = require('../agent/siparis/kartela');
const { panelData } = require('../agent/siparis/routes-panel');
const mount = require('../agent/siparis/routes');

// Invented data only: users "Ekip"/"Yönetici", orders MRC-G59-n, a single fabric type and colour set from the card file.
const recipes = { version: 'g59-v1', products: { sweat: { materials: [{ key: 'kumas', g_per_unit: 350 }] } } };
async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siparis-g59-'));
  const db = openDb(path.join(dir, 'siparis.sqlite'));
  t.after(() => { if (db.open) db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const manager = await auth.createUser(db, { name: 'Yönetici', password: 'test-password', role: 'yonetici' });
  const team = await auth.createUser(db, { name: 'Ekip', password: 'test-password', role: 'ekip' });
  let n = 0;
  const make = (line = {}, extra = {}) => orders.createOrder(db, { order_no: `MRC-G59-${++n}`, customer_name: 'Örnek Kulüp',
    lines: [{ product_key: 'sweat', quantity: 10, color_name: 'Mavi', ...line }], ...extra }, team);
  return { dir, db, manager, team, make };
}
function request(port, url, { token, body, method = body ? 'POST' : 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: url, method, agent: false, headers: { 'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(data ?? undefined);
  });
}
async function serve(t, f) {
  const app = express();
  mount(app, { db: f.db, dataDir: f.dir, worker: false, recipes });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => { server.close(r); server.closeAllConnections?.(); }));
  const { token } = await auth.login(f.db, { name: 'Ekip', password: 'test-password' });
  return (url, options = {}) => request(server.address().port, '/api/siparis' + url, { token, ...options });
}
const audits = (db, action) => db.prepare('SELECT * FROM audit_log WHERE action=?').all(action);

test('delete: soft, needs confirmation, hidden from list/detail/panel counters, row and audit stay', async t => {
  const f = await setup(t), call = await serve(t, f);
  const a = f.make(), b = f.make();
  orders.submitForApproval(f.db, a.version.id, f.team);
  f.db.prepare("INSERT INTO confirmations(kind,ref_table,ref_id,message) VALUES('olcu','order_lines',?,'x')").run(a.version.lines[0].id);
  assert.equal(panelData(f.db).onay_bekleyen.length, 1);
  assert.equal((await call(`/siparisler/${a.id}/sil`, { body: {} })).status, 400, 'no confirmation, no delete');
  assert.equal((await call(`/siparisler/${a.id}/sil`, { body: { onay: false } })).status, 400);
  assert.equal((await call('/siparisler')).body.length, 2);
  const del = await call(`/siparisler/${a.id}/sil`, { body: { onay: true } });
  assert.equal(del.status, 200);
  assert.deepEqual([del.body.ok, del.body.order_no], [true, a.order_no]);
  assert.deepEqual((await call('/siparisler')).body.map(o => o.id), [b.id]);
  assert.equal((await call(`/siparisler/${a.id}`)).status, 404);
  assert.equal((await call(`/surumler/${a.version.id}`)).status, 404);
  assert.equal((await call(`/siparisler/${a.id}/sil`, { body: { onay: true } })).status, 404, 'already deleted');
  assert.equal(panelData(f.db).onay_bekleyen.length, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM confirmations WHERE status='acik'").get().n, 0);
  const row = f.db.prepare('SELECT * FROM orders WHERE id=?').get(a.id);
  assert.ok(row.deleted_at && row.deleted_by === f.team.id, 'row stays with time and person');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM order_lines WHERE version_id=?').get(a.version.id).n, 1);
  const [log] = audits(f.db, 'siparis_sil');
  assert.deepEqual([log.user_id, log.ref, JSON.parse(log.detail_json).orderNo], [f.team.id, String(a.id), a.order_no]);
  const again = f.make({}, { order_no: a.order_no });
  assert.equal(again.order_no, a.order_no, 'the deleted number can be reused');
  const kept = f.db.prepare('SELECT * FROM orders WHERE id=?').get(a.id);
  assert.deepEqual([kept.order_no, kept.deleted_order_no], [`${a.order_no}~sil~${a.id}`, a.order_no]);
  assert.equal((await call('/siparisler')).body.filter(o => o.order_no === a.order_no).length, 1);
  assert.equal((await call(`/siparisler/${b.id}/sil`, { body: { onay: true }, token: null })).status, 401);
});

test('delete: an approved order that reserved stock is refused with a Turkish reason and the ledger is untouched', async t => {
  const f = await setup(t), call = await serve(t, f);
  stock.importLegacyFabrics(f.db, { fabrics: [{ id: 'f1', name: 'Örnek kumaş', colorName: 'Mavi', unit: 'kg' }] });
  const itemId = f.db.prepare('SELECT id FROM stock_items').get().id;
  stock.recordCount(f.db, { itemId, countedMilli: 20000, countKey: 'acilis-g59', userId: f.manager.id });
  const o = f.make({ fabric_item_id: itemId, quantity: 10 });
  const file = orders.addFile(f.db, o.version.id, { kind: 'onay_formu', path: '/synthetic/g59.pdf', sha256: 'a'.repeat(64) }, f.team);
  orders.submitForApproval(f.db, o.version.id, f.team);
  approveVersion(f.db, { versionId: o.version.id, fileId: file.id, userId: f.manager.id, recipes });
  const before = f.db.prepare('SELECT COUNT(*) n FROM stock_movements').get().n;
  const res = await call(`/siparisler/${o.id}/sil`, { body: { onay: true } });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /stok/);
  assert.equal(f.db.prepare('SELECT deleted_at FROM orders WHERE id=?').get(o.id).deleted_at, null);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM stock_movements').get().n, before);
  assert.equal((await call('/siparisler')).body.length, 1);
  // A real stock outflow gets its own, explicit reason.
  stock.consume(f.db, { orderLineId: o.version.lines[0].id, materialKey: 'kumas', qtyMilli: 1000, businessKey: 'g59-cikis', userId: f.manager.id });
  assert.match((await call(`/siparisler/${o.id}/sil`, { body: { onay: true } })).body.error, /stok çıkışı var/);
});

test('fabric types: one row per type, card colours with stock item or none, stock-only colours, legacy rows', async t => {
  const f = await setup(t);
  const empty = fabricTypeList(f.db);
  assert.deepEqual(empty.map(x => x.tur).sort(), ['lakost', 'polar', 'sardonlu_3_iplik', 'sardonsuz_3_iplik', 'supren_30_1']);
  assert.equal(new Set(empty.map(x => x.tur)).size, empty.length);
  const suprem = empty.find(x => x.tur === 'supren_30_1');
  assert.ok(suprem.kartela && suprem.renkler.length > 3);
  assert.ok(suprem.renkler.every(r => r.kartelada && r.stokKalemId === null && r.no > 0 && /^#/.test(r.hex)));
  const first = suprem.renkler[0];
  const item = stock.createStockItem(f.db, { tur: 'supren_30_1', kartelaNo: first.no, unit: 'kg' }, f.team.id);
  stock.createStockItem(f.db, { tur: 'supren_30_1', renk: 'Deneme Rengi', unit: 'kg' }, f.team.id);
  stock.createStockItem(f.db, { tur: 'ipek', renk: 'Krem', unit: 'kg' }, f.team.id);
  stock.importLegacyFabrics(f.db, { fabrics: [{ id: 'k1', name: 'Eski kumaş', unit: 'kg' }] });
  const list = fabricTypeList(f.db);
  const s = list.find(x => x.tur === 'supren_30_1');
  assert.equal(list.filter(x => x.tur === 'supren_30_1').length, 1, 'type listed once even with several stock items');
  assert.equal(s.renkler.find(r => r.no === first.no).stokKalemId, item.id);
  assert.deepEqual(s.renkler.filter(r => !r.kartelada).map(r => r.renk), ['Deneme Rengi']);
  assert.deepEqual(list.find(x => x.tur === 'ipek').renkler.map(r => [r.renk, r.kartelada]), [['Krem', false]]);
  assert.equal(list.find(x => x.tur === 'ipek').kartela, null);
  assert.ok(list.some(x => x.tur.startsWith('legacy:') && x.ad === 'Eski kumaş'));
});

test('line: type + card colour finds the existing stock item; typed colour and no-item cases save by name without opening stock', async t => {
  const f = await setup(t), call = await serve(t, f);
  const card = fabricTypeList(f.db).find(x => x.tur === 'supren_30_1').renkler[0];
  const item = stock.createStockItem(f.db, { tur: 'supren_30_1', kartelaNo: card.no, unit: 'kg' }, f.team.id);
  const count = () => f.db.prepare('SELECT COUNT(*) n FROM stock_items').get().n, items = count();
  const hit = f.make({ fabric_type: 'supren_30_1', color_name: card.renk }).version.lines[0];
  assert.deepEqual([hit.fabric_item_id, hit.fabric_type, hit.stokKalemiYok, hit.color_name], [item.id, 'supren_30_1', false, card.renk]);
  const other = fabricTypeList(f.db).find(x => x.tur === 'supren_30_1').renkler[1];
  const miss = f.make({ fabric_type: 'supren_30_1', color_name: other.renk }).version.lines[0];
  assert.deepEqual([miss.fabric_item_id, miss.stokKalemiYok], [null, true]);
  const typed = f.make({ fabric_type: 'Süprem 30/1', color_name: 'Çağla Yeşili' }).version.lines[0];
  assert.deepEqual([typed.fabric_type, typed.fabric_item_id, typed.color_name, typed.stokKalemiYok], ['supren_30_1', null, 'Çağla Yeşili', true], 'Turkish colour kept as typed');
  assert.equal(count(), items, 'no stock item opens by itself');
  // Same through HTTP, then a revision keeps type and colour and re-resolves the item.
  const created = await call('/siparisler', { body: { order_no: 'MRC-G59-H', lines: [{ product_key: 'sweat', quantity: 5, fabric_type: 'supren_30_1', color_name: card.renk }] } });
  assert.equal(created.status, 201);
  const rev = orders.reviseVersion(f.db, created.body.version.id, { lines: [{ id: created.body.version.lines[0].id, quantity: 6 }] }, f.team);
  assert.deepEqual([rev.lines[0].fabric_item_id, rev.lines[0].fabric_type, rev.lines[0].color_name], [item.id, 'supren_30_1', card.renk]);
  const recolor = orders.reviseVersion(f.db, rev.id, { lines: [{ id: rev.lines[0].id, color_name: 'Başka Renk' }] }, f.team);
  assert.deepEqual([recolor.lines[0].fabric_item_id, recolor.lines[0].stokKalemiYok], [null, true], 'a changed colour drops the old item');
  assert.equal((await call('/kumas-turleri')).body.length, fabricTypeList(f.db).length);
});

test('old orders (fabric_item_id only) open and revise unchanged; a line by name prints the type name on the form data', async t => {
  const f = await setup(t);
  stock.importLegacyFabrics(f.db, { fabrics: [{ id: 'f1', name: 'Örnek kumaş', colorName: 'Mavi', unit: 'kg' }] });
  const itemId = f.db.prepare('SELECT id FROM stock_items').get().id;
  const old = f.make({ fabric_item_id: itemId }).version.lines[0];
  assert.deepEqual([old.fabric_item_id, old.fabric_type, old.stokKalemiYok, old.color_name], [itemId, null, false, 'Mavi']);
  const rev = orders.reviseVersion(f.db, old.version_id, { lines: [{ id: old.id, quantity: 12 }] }, f.team);
  assert.deepEqual([rev.lines[0].fabric_item_id, rev.lines[0].fabric_type, rev.lines[0].quantity], [itemId, null, 12]);
  // Migration: a database without the new columns gains them.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siparis-g59-mig-'));
  try {
    const Database = require('better-sqlite3'), file = path.join(dir, 'old.sqlite');
    const raw = new Database(file);
    raw.exec(fs.readFileSync(path.join(__dirname, '../agent/siparis/schema.sql'), 'utf8')
      .replace(/,\n deleted_at TEXT, deleted_by INTEGER REFERENCES users\(id\), deleted_order_no TEXT/, '').replace(' fabric_type TEXT,', ''));
    raw.close();
    const db = openDb(file);
    assert.ok(db.prepare('PRAGMA table_info(orders)').all().some(c => c.name === 'deleted_at'));
    assert.ok(db.prepare('PRAGMA table_info(orders)').all().some(c => c.name === 'deleted_order_no'));
    assert.ok(db.prepare('PRAGMA table_info(order_lines)').all().some(c => c.name === 'fabric_type'));
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
