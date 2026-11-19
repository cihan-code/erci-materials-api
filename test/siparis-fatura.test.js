'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('node:child_process');
const express = require('express');
const Database = require('better-sqlite3');
const { openDb } = require('../agent/siparis/db');
const auth = require('../agent/siparis/auth');
const orders = require('../agent/siparis/orders');
const { approveVersion } = require('../agent/siparis/approval');
const stock = require('../agent/siparis/stock');
const queue = require('../agent/siparis/outbox');
const invoices = require('../agent/siparis/invoices');
const mount = require('../agent/siparis/routes');

// Invented data only: customer "Örnek Kulüp", orders MRC-T…, invoices FAT-T…
const SERVICE_KEY = 'uydurma-servis-anahtari-test';
const priorKey = process.env.SIPARIS_SERVIS_ANAHTARI;
process.env.SIPARIS_SERVIS_ANAHTARI = SERVICE_KEY;
after(() => { if (priorKey === undefined) delete process.env.SIPARIS_SERVIS_ANAHTARI; else process.env.SIPARIS_SERVIS_ANAHTARI = priorKey; });
const recipes = { version: 'test-350-v1', products: { sweat: { materials: [{ key: 'kumas', g_per_unit: 350 }] } } };
const kgRecipe = { version: 'test-1000-v1', products: { sweat: { materials: [{ key: 'kumas', g_per_unit: 1000 }] } } };

async function setup(t, { fabrics = [], stockKg = {}, recipe = recipes } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siparis-fatura-'));
  const file = path.join(dir, 'test.sqlite');
  const db = openDb(file);
  t.after(() => { if (db.open) db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const manager = await auth.createUser(db, { name: 'Yönetici', password: 'test-password', role: 'yonetici' });
  const team = await auth.createUser(db, { name: 'Ekip', password: 'test-password', role: 'ekip' });
  const restricted = await auth.createUser(db, { name: 'Kısıtlı', password: 'test-password', onayYetkisi: false });
  if (fabrics.length) stock.importLegacyFabrics(db, { fabrics });
  const item = key => db.prepare('SELECT id FROM stock_items WHERE fabric_key=?').get(key)?.id;
  // Opening stock comes from a physical count; the legacy import carries master data only.
  for (const [legacyId, kg] of Object.entries(stockKg)) stock.recordCount(db, { countKey: 'acilis',
    itemId: db.prepare('SELECT id FROM stock_items WHERE legacy_fabric_id=?').get(legacyId).id, countedMilli: kg * 1000, userId: manager.id });
  let n = 0;
  function draft(lines, files = []) {
    const order = orders.createOrder(db, { order_no: `MRC-T${String(++n).padStart(3, '0')}`, customer_name: 'Örnek Kulüp', lines }, team);
    const v = order.version;
    const fileId = orders.addFile(db, v.id, { kind: 'onay_formu', path: `/synthetic/${v.id}-onay.pdf`, sha256: 'a'.repeat(64) }, team).id;
    const extra = files.map(kind => orders.addFile(db, v.id, { kind, path: `/synthetic/${v.id}-${kind}-${Math.random()}.pdf`, sha256: 'b'.repeat(64) }, team));
    return { order, versionId: v.id, lineIds: v.lines.map(l => l.id), fileId, files: extra };
  }
  function approve(d) {
    if (orders.snapshot(db, d.versionId).status === 'taslak') orders.submitForApproval(db, d.versionId, team);
    return approveVersion(db, { versionId: d.versionId, userId: manager.id, fileId: d.fileId, recipes: recipe });
  }
  const order = lines => { const d = draft(lines); approve(d); return d; };
  const summary = key => {
    const s = stock.stockSummary(db).find(i => i.fabric_key === key);
    return { total: s.total_milli, reserved: s.reserved_milli, available: s.available_milli, shortage: s.shortage_milli, awaiting: s.awaiting_delivery_milli };
  };
  const alloc = lineId => db.prepare('SELECT reserved_milli r,shortage_milli s FROM allocations WHERE order_line_id=?').get(lineId);
  return { db, dir, file, manager, team, restricted, item, draft, approve, order, summary, alloc };
}
// node:http client, not fetch: with undici parsing in the same process as better-sqlite3 11 on Node 24 the test
// process aborts natively at random GCs ("RemoveEnvironmentCleanupHook ... env != nullptr"); a separate server process does not.
function request(port, url, { token, body, method = body ? 'POST' : 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: url, method, agent: false, headers: { 'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, json: async () => JSON.parse(text) }));
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
  return (url, options) => request(server.address().port, '/api/siparis' + url, options);
}
const line = (id, description, quantity, extra = {}) => ({ sourceInvoiceId: 'FAT-T1', sourceLineId: String(id), invoiceNo: 'FAT-T1',
  invoiceDate: '2026-11-18', supplier: 'Örnek Tedarik', supplierVkn: '0000000000', description, quantity, unit: 'kg',
  unitPrice: 1, purchaseRef: null, deliveryConfirmed: false, ...extra });
const black = { id: 'k1', name: 'Şardonlu 3 İplik', colorName: 'Siyah', unit: 'kg' };
const pink = { id: 'k2', name: 'Şardonlu 3 iplik kumaş', colorName: 'Pembe', unit: 'kg' };

test('kabul testi 3: 35 kg need, 20 kg stock; a 25 kg line delivered closes 15 and leaves 10; a resend adds nothing', async t => {
  const f = await setup(t, { fabrics: [black], stockKg: { k1: 20 } });
  const key = 'sardonlu_3_iplik|siyah';
  const o = f.order([{ product_key: 'sweat', fabric_item_id: f.item(key), color_name: 'Siyah', quantity: 100 }]);
  assert.deepEqual(f.summary(key), { total: 20000, reserved: 20000, available: 0, shortage: 15000, awaiting: 0 });
  const call = await serve(t, f);
  const body = { source: 'finans-ajani', lines: [line(1, 'Siyah şardonlu 3 iplik 25 kg', 25, { unit: 'KG' })] };
  const first = await (await call('/fatura-satirlari', { token: SERVICE_KEY, body })).json();
  assert.equal(first.results[0].status, 'yeni');
  assert.equal(first.results[0].matchStatus, 'eslesti');
  assert.match(first.results[0].reasons.join(' '), /MRC-T001 için 15 kg ayrıldı/);
  assert.deepEqual(f.summary(key), { total: 20000, reserved: 20000, available: 0, shortage: 15000, awaiting: 25000 }, 'matching moves no stock');
  const { token } = await auth.login(f.db, { name: 'Ekip', password: 'test-password' });
  const delivered = await call(`/fatura-satirlari/${first.results[0].id}/teslim`, { token, body: {} });
  assert.equal(delivered.status, 200);
  assert.deepEqual(f.summary(key), { total: 45000, reserved: 35000, available: 10000, shortage: 0, awaiting: 0 });
  assert.deepEqual(f.alloc(o.lineIds[0]), { r: 35000, s: 0 });
  const again = await (await call('/fatura-satirlari', { token: SERVICE_KEY, body })).json();
  assert.equal(again.results[0].status, 'ayni');
  assert.equal((await call(`/fatura-satirlari/${first.results[0].id}/teslim`, { token, body: {} })).status, 200);
  assert.equal(f.db.prepare("SELECT count(*) n FROM stock_movements WHERE type='giris'").get().n, 1);
  assert.deepEqual(f.summary(key), { total: 45000, reserved: 35000, available: 10000, shortage: 0, awaiting: 0 });
});

test('kabul testi 4: 20 siyah and 100 pembe at 350 g take 8 and 40 kg in one step; the vague line waits for teyit', async t => {
  const f = await setup(t, { fabrics: [black, pink] });
  const ks = 'sardonlu_3_iplik|siyah', kp = 'sardonlu_3_iplik|pembe';
  f.order([{ product_key: 'sweat', fabric_item_id: f.item(ks), color_name: 'Siyah', quantity: 20 },
    { product_key: 'sweat', fabric_item_id: f.item(kp), color_name: 'Pembe', quantity: 100 }]);
  const results = invoices.ingest(f.db, { source: 'finans-ajani', lines: [
    line(1, 'kumaş 10 kg', 10),
    line(2, 'Siyah şardonlu 3 iplik 8 kg', 8, { deliveryConfirmed: true }),
    line(3, 'Pembe şardonlu 3 iplik 40 kg', 40, { deliveryConfirmed: true })] });
  assert.deepEqual(results.map(r => [r.status, r.matchStatus, r.deliveryStatus]),
    [['yeni', 'teyit', 'teslim_bekliyor'], ['yeni', 'eslesti', 'teslim_alindi'], ['yeni', 'eslesti', 'teslim_alindi']]);
  assert.deepEqual([f.summary(ks).available, f.summary(ks).reserved, f.summary(ks).shortage], [1000, 7000, 0]);
  assert.deepEqual([f.summary(kp).available, f.summary(kp).reserved, f.summary(kp).shortage], [5000, 35000, 0]);
  const vague = f.db.prepare('SELECT * FROM invoice_lines WHERE id=?').get(results[0].id);
  assert.equal(vague.item_id, null, 'a teyit line is not bound to stock');
  const open = f.db.prepare("SELECT * FROM confirmations WHERE kind='fatura_eslesme' AND status='acik'").all();
  assert.equal(open.length, 1);
  assert.equal(open[0].ref_id, vague.id);
  assert.match(open[0].message, /renk okunamadı/);
});

test('service key: wrong or missing key is 401, the right key or a user token is accepted', async t => {
  const f = await setup(t);
  const call = await serve(t, f);
  const body = { source: 'finans-ajani', lines: [] };
  assert.equal((await call('/fatura-satirlari', { token: 'yanlis-anahtar', body })).status, 401);
  assert.equal((await call('/fatura-satirlari', { body })).status, 401);
  assert.equal((await call('/fatura-satirlari', { token: SERVICE_KEY, body })).status, 200);
  const { token } = await auth.login(f.db, { name: 'Ekip', password: 'test-password' });
  assert.equal((await call('/fatura-satirlari', { token, body })).status, 200);
  assert.equal((await call('/fatura-satirlari', { token: SERVICE_KEY })).status, 401, 'the service key only feeds lines');
  process.env.SIPARIS_SERVIS_ANAHTARI = '';
  t.after(() => { process.env.SIPARIS_SERVIS_ANAHTARI = SERVICE_KEY; });
  assert.equal((await call('/fatura-satirlari', { token: SERVICE_KEY, body })).status, 401, 'no configured key, no service access');
});

test('content change: re-matched before delivery, only a confirmation after delivery', async t => {
  const f = await setup(t, { fabrics: [black] });
  const key = 'sardonlu_3_iplik|siyah';
  f.order([{ product_key: 'sweat', fabric_item_id: f.item(key), color_name: 'Siyah', quantity: 100 }]);
  const send = (description, quantity) => invoices.ingest(f.db, { source: 'finans-ajani', lines: [line(1, description, quantity)] })[0];
  const vague = send('kumaş 10 kg', 10);
  assert.equal(vague.matchStatus, 'teyit');
  const fixed = send('Siyah şardonlu 3 iplik 30 kg', 30);
  assert.deepEqual([fixed.status, fixed.matchStatus], ['guncellendi', 'eslesti']);
  assert.equal(f.db.prepare("SELECT count(*) n FROM confirmations WHERE ref_table='invoice_lines' AND status='acik'").get().n, 0,
    'the old teyit no longer describes the line');
  assert.equal(f.db.prepare('SELECT qty_milli FROM invoice_lines WHERE id=?').get(fixed.id).qty_milli, 30000);
  invoices.deliver(f.db, fixed.id, {}, f.team.id);
  const late = send('Siyah şardonlu 3 iplik 35 kg', 35);
  assert.equal(late.status, 'reddedildi');
  assert.equal(f.db.prepare('SELECT qty_milli FROM invoice_lines WHERE id=?').get(fixed.id).qty_milli, 30000);
  send('Siyah şardonlu 3 iplik 35 kg', 35);
  const open = f.db.prepare("SELECT message FROM confirmations WHERE kind='fatura_eslesme' AND ref_id=? AND status='acik'").all(fixed.id);
  assert.equal(open.length, 1);
  assert.match(open[0].message, /Teslim alınmış fatura satırının içeriği değişti/);
  assert.equal(f.summary(key).total, 30000);
});

test('unbound order fabric, unknown unit and listing: nothing is bound or lost on a guess', async t => {
  const f = await setup(t, { fabrics: [black] });
  f.order([{ product_key: 'sweat', fabric_item_id: null, color_name: 'Lacivert', quantity: 10 }]);
  const call = await serve(t, f);
  const res = await (await call('/fatura-satirlari', { token: SERVICE_KEY, body: { source: 'finans-ajani', lines: [
    line(1, 'Lacivert şardonlu 3 iplik 4 kg', 4),
    line(2, 'Siyah şardonlu 3 iplik 2 top', 2, { unit: 'top' }),
    line(3, 'Siyah şardonlu 3 iplik 5 kg', 5, { unit: '' }),
    { sourceLineId: '9', quantity: 1, unit: 'kg' }] } })).json();
  assert.deepEqual(res.results.map(r => [r.status, r.matchStatus]),
    [['yeni', 'teyit'], ['reddedildi', null], ['yeni', 'eslesti'], ['reddedildi', null]]);
  assert.match(res.results[0].reasons.join(' '), /stok kalemine bağlı değil/);
  assert.equal(f.db.prepare("SELECT count(*) n FROM stock_items WHERE fabric_key='sardonlu_3_iplik|lacivert'").get().n, 0);
  assert.equal(f.db.prepare("SELECT count(*) n FROM confirmations WHERE kind='fatura_eslesme' AND ref_table='audit_log'").get().n, 2,
    'refused lines stay visible: Finance will not resend them');
  const { token } = await auth.login(f.db, { name: 'Ekip', password: 'test-password' });
  const listed = await (await call('/fatura-satirlari?durum=teyit', { token })).json();
  assert.deepEqual(listed.map(l => l.source_line_id), ['1']);
  assert.equal(listed[0].confirmations.length, 1);
  assert.equal((await call('/fatura-satirlari?durum=hepsi', { token })).status, 400);
  assert.equal((await call('/fatura-satirlari')).status, 401);
  // The team settles the teyit by choosing the item: delivery then closes the line's confirmations.
  const item = f.item('sardonlu_3_iplik|siyah');
  const done = await (await call(`/fatura-satirlari/${res.results[0].id}/teslim`, { token, body: { itemId: item, allocations: [] } })).json();
  assert.equal(done.line.delivery_status, 'teslim_alindi');
  assert.equal(done.line.confirmations.length, 0);
});

test('a job without a registered adapter stays bekliyor; no attempt, no confirmation', async t => {
  const f = await setup(t, { fabrics: [black] });
  f.order([{ product_key: 'sweat', fabric_item_id: f.item('sardonlu_3_iplik|siyah'), quantity: 1 }]);
  for (let i = 0; i < 3; i++) assert.equal(await queue.runOnce(f.db), null);
  const job = f.db.prepare("SELECT * FROM outbox WHERE kind='maliyet_aktarim'").get();
  assert.deepEqual([job.status, job.attempts], ['bekliyor', 0]);
  assert.equal(f.db.prepare("SELECT count(*) n FROM confirmations WHERE ref_table='outbox'").get().n, 0);
});

test('heartbeat under a long write lock reports the error and the process stays up', { timeout: 10000 }, async t => {
  const f = await setup(t, { fabrics: [black] });
  f.order([{ product_key: 'sweat', fabric_item_id: f.item('sardonlu_3_iplik|siyah'), quantity: 1 }]);
  f.db.pragma('busy_timeout = 20');
  const other = new Database(f.file);
  t.after(() => other.close());
  t.after(queue.registerHandler('maliyet_aktarim', async () => {
    other.exec('BEGIN IMMEDIATE');
    await new Promise(r => setTimeout(r, 300));
    other.exec('COMMIT');
    return { providerRef: 'maliyet-1' };
  }));
  const errors = [];
  let crashed = null;
  const onCrash = err => { crashed = err; };
  process.once('uncaughtException', onCrash);
  t.after(() => process.off('uncaughtException', onCrash));
  const job = await queue.runOnce(f.db, 'maliyet_aktarim', { heartbeatMs: 40, onError: err => errors.push(err) });
  assert.equal(crashed, null);
  assert.ok(errors.length >= 1);
  assert.match(errors[0].message, /locked|busy/i);
  assert.deepEqual([job.status, job.provider_ref], ['tamam', 'maliyet-1']);
});

test('same idempotency key with a different payload is 409; the same payload returns the first result', async t => {
  const f = await setup(t, { fabrics: [black], stockKg: { k1: 50 } });
  const item = f.item('sardonlu_3_iplik|siyah');
  const a = f.order([{ product_key: 'sweat', fabric_item_id: item, quantity: 20 }]);
  const b = f.order([{ product_key: 'sweat', fabric_item_id: item, quantity: 20 }]);
  const cut = { orderLineId: a.lineIds[0], materialKey: 'kumas', qtyMilli: 1000, businessKey: 'kesim-19-11', userId: f.team.id };
  const once = stock.consume(f.db, cut);
  assert.deepEqual(stock.consume(f.db, cut), once);
  assert.throws(() => stock.consume(f.db, { ...cut, orderLineId: b.lineIds[0] }), e => e.status === 409);
  assert.throws(() => stock.consume(f.db, { ...cut, qtyMilli: 2000 }), e => e.status === 409);
  assert.equal(f.alloc(b.lineIds[0]).r, 7000, 'the other order was not consumed');
  const fix = { itemId: item, qtyMilli: 500, businessKey: 'sayim-1', note: 'sayım', userId: f.manager.id };
  const adj = stock.adjustStock(f.db, fix);
  assert.deepEqual(stock.adjustStock(f.db, fix), adj);
  assert.throws(() => stock.adjustStock(f.db, { ...fix, qtyMilli: -500 }), e => e.status === 409);
});

test('A5 FIFO: stock released by a revision or a count goes to the earliest approved shortage first', async t => {
  const f = await setup(t, { fabrics: [black], stockKg: { k1: 30 }, recipe: kgRecipe });
  const item = f.item('sardonlu_3_iplik|siyah');
  const B = f.order([{ product_key: 'sweat', fabric_item_id: item, quantity: 20 }]);
  const A = f.order([{ product_key: 'sweat', fabric_item_id: item, quantity: 25 }]);
  assert.deepEqual(f.alloc(A.lineIds[0]), { r: 10000, s: 15000 });
  const v2 = orders.reviseVersion(f.db, B.versionId, { lines: [{ id: B.lineIds[0], quantity: 10 }] }, f.manager);
  const file = orders.addFile(f.db, v2.id, { kind: 'onay_formu', path: '/synthetic/b2.pdf', sha256: 'c'.repeat(64) }, f.team).id;
  f.approve({ versionId: v2.id, fileId: file });
  assert.deepEqual(f.alloc(v2.lines[0].id), { r: 10000, s: 0 });
  assert.deepEqual(f.alloc(A.lineIds[0]), { r: 20000, s: 5000 }, 'A receives the 10 kg B released');
  const C = f.order([{ product_key: 'sweat', fabric_item_id: item, quantity: 10 }]);
  assert.deepEqual(f.alloc(C.lineIds[0]), { r: 0, s: 10000 }, 'C gets nothing: A was waiting first');
  assert.equal(f.summary('sardonlu_3_iplik|siyah').available, 0);
  stock.adjustStock(f.db, { itemId: item, qtyMilli: 8000, businessKey: 'sayim-fazla', note: 'sayım fazlası', userId: f.manager.id });
  assert.deepEqual([f.alloc(A.lineIds[0]), f.alloc(C.lineIds[0])], [{ r: 25000, s: 0 }, { r: 3000, s: 7000 }]);
});

test('revision rights and cost jobs: approved needs approval rights (default on); pending cost transfers are cancelled, finished ones kept', async t => {
  const f = await setup(t, { fabrics: [black], stockKg: { k1: 50 } });
  const item = f.item('sardonlu_3_iplik|siyah');
  const a = f.order([{ product_key: 'sweat', fabric_item_id: item, quantity: 10 }]);
  const b = f.order([{ product_key: 'sweat', fabric_item_id: item, quantity: 10 }]);
  const cost = v => f.db.prepare("SELECT status FROM outbox WHERE version_id=? AND kind='maliyet_aktarim'").get(v).status;
  f.db.prepare("UPDATE outbox SET status='fiyat_bekliyor' WHERE version_id=? AND kind='maliyet_aktarim'").run(a.versionId);
  f.db.prepare("UPDATE outbox SET status='tamam' WHERE version_id=? AND kind='maliyet_aktarim'").run(b.versionId);
  assert.throws(() => orders.reviseVersion(f.db, a.versionId, {}, f.restricted), e => e.status === 403);
  assert.equal(cost(a.versionId), 'fiyat_bekliyor', 'a refused revision changes nothing');
  const a2 = orders.reviseVersion(f.db, a.versionId, {}, f.team);
  orders.reviseVersion(f.db, b.versionId, {}, f.manager);
  assert.deepEqual([cost(a.versionId), cost(b.versionId)], ['iptal', 'tamam']);
  assert.equal(orders.reviseVersion(f.db, a2.id, {}, f.restricted).status, 'onay_bekliyor', 'any account may revise a pending version');
  for (const status of ['bekliyor', 'manuel_bekliyor']) {
    const c = f.order([{ product_key: 'sweat', fabric_item_id: item, quantity: 1 }]);
    f.db.prepare("UPDATE outbox SET status=? WHERE version_id=? AND kind='maliyet_aktarim'").run(status, c.versionId);
    orders.reviseVersion(f.db, c.versionId, {}, f.manager);
    assert.equal(cost(c.versionId), 'iptal');
  }
  const call = await serve(t, f);
  const d = f.order([{ product_key: 'sweat', fabric_item_id: item, quantity: 1 }]);
  const limited = await auth.login(f.db, { name: 'Kısıtlı', password: 'test-password' });
  assert.equal((await call(`/surumler/${d.versionId}/revizyon`, { token: limited.token, body: {} })).status, 403);
  const team = await auth.login(f.db, { name: 'Ekip', password: 'test-password' });
  assert.equal((await call(`/surumler/${d.versionId}/revizyon`, { token: team.token, body: {} })).status, 201, 'by default everyone may');
});

test('file kind filter: only print, embroidery and vector files go to the workshop; approval needs the onay_formu', async t => {
  const f = await setup(t, { fabrics: [black], stockKg: { k1: 50 } });
  const d = f.draft([{ product_key: 'sweat', fabric_item_id: f.item('sardonlu_3_iplik|siyah'), quantity: 1 }],
    ['uretim_formu', 'urun_gorsel', 'urun_gorsel', 'desen_kaynak', 'baski_formu', 'nakis_formu', 'desen_vektor', 'desen_vektor']);
  orders.submitForApproval(f.db, d.versionId, f.team);
  const production = d.files.find(x => x.kind === 'uretim_formu').id;
  assert.throws(() => approveVersion(f.db, { versionId: d.versionId, userId: f.manager.id, fileId: production, recipes }), e => e.status === 400);
  const r = f.approve(d);
  const sent = r.outbox.filter(j => j.kind === 'atolye_dosya');
  const expected = d.files.filter(x => ['baski_formu', 'nakis_formu', 'desen_vektor'].includes(x.kind));
  assert.deepEqual(sent.map(j => j.idempotency_key), expected.map(x => `atolye:${d.versionId}:${x.id}`));
  assert.deepEqual(sent.map(j => JSON.parse(j.payload_json).file.kind), ['baski_formu', 'nakis_formu', 'desen_vektor', 'desen_vektor']);
  assert.equal(r.approval.approved_file_id, d.fileId);
});

test('legacy fabrics take a "<type>|<colour>" key only when it reads cleanly and uniquely', async t => {
  const f = await setup(t, { fabrics: [black, { id: 'k3', name: 'Örnek kumaş', colorName: 'Mavi', unit: 'kg' },
    { id: 'k4', name: 'Lacoste', colorName: 'Lacivert', unit: 'kg' }, { id: 'k5', name: 'LAKOST', colorName: 'laci', unit: 'kg' }] });
  const keys = f.db.prepare('SELECT legacy_fabric_id id,fabric_key k FROM stock_items ORDER BY id').all();
  assert.deepEqual(keys, [{ id: 'k1', k: 'sardonlu_3_iplik|siyah' }, { id: 'k3', k: 'legacy:k3' }, { id: 'k4', k: 'legacy:k4' }, { id: 'k5', k: 'legacy:k5' }]);
  stock.importLegacyFabrics(f.db, { fabrics: [{ id: 'k6', name: 'şardonlu üç iplik', colorName: 'SİYAH', unit: 'kg' }] });
  assert.equal(f.db.prepare("SELECT fabric_key FROM stock_items WHERE legacy_fabric_id='k6'").get().fabric_key, 'legacy:k6');
  const messages = f.db.prepare("SELECT message FROM confirmations WHERE kind='eksik_alan' AND ref_table='stock_items' ORDER BY id").all().map(c => c.message);
  assert.equal(messages.length, 4);
  assert.match(messages[0], /okunamadı/);
  assert.match(messages[1], /lakost\|lacivert/);
  assert.match(messages[3], /sardonlu_3_iplik\|siyah/);
});

test('server keeps serving the panel and answers 503 for /api/siparis when the database cannot open', { timeout: 15000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siparis-503-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'siparis.sqlite'));
  const port = await new Promise(resolve => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const child = spawn(process.execPath, [path.resolve(__dirname, '../server.js')],
    { env: { PATH: process.env.PATH, HOME: process.env.HOME, DATA_DIR: dir, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let log = '';
  await new Promise((resolve, reject) => {
    const seen = chunk => { log += chunk; if (/uzerinde calisiyor/.test(log)) resolve(); };
    child.stdout.on('data', seen); child.stderr.on('data', seen);
    child.once('exit', code => reject(new Error(`server exited ${code}: ${log}`)));
  });
  assert.match(log, /\[siparis\] modul acilamadi/);
  assert.equal((await request(port, '/')).status, 200);
  assert.equal((await request(port, '/api/siparis/stok')).status, 503);
});

test('A14: panel creates fabric items under the invoice key, edits only labels, and /stok shows display kg', async t => {
  const f = await setup(t);
  const call = await serve(t, f);
  const { token } = await auth.login(f.db, { name: 'Ekip', password: 'test-password' });
  const make = body => call('/stok/kalemler', { token, body });
  const created = await make({ tur: 'Şardonlu 3 iplik', renk: 'Gri Melanj', unit: 'kg', colorNo: 'GM-01', colorHex: '#A0A0A0' });
  assert.equal(created.status, 201);
  const item = await created.json();
  assert.deepEqual([item.fabric_key, item.name, item.color_name, item.color_no, item.color_hex], ['sardonlu_3_iplik|gri_melanj', 'sardonlu 3 iplik', 'Gri Melanj', 'GM-01', '#a0a0a0']);
  const twin = await make({ tur: 'ŞARDONLU ÜÇ İPLİK', renk: 'gri melanj', unit: 'kg' });
  assert.equal(twin.status, 409);
  assert.equal((await twin.json()).item.id, item.id);
  for (const bad of [{ tur: 'lakost', unit: 'kg' }, { tur: 'lakost', renk: 'siyah', unit: 'ton' }, { tur: 'lakost', renk: 'siyah', unit: 'kg', colorHex: 'gri' }])
    assert.equal((await make(bad)).status, 400);
  assert.equal((await call('/stok/kalemler', { token: SERVICE_KEY, body: { tur: 'lakost', renk: 'siyah', unit: 'kg' } })).status, 401);
  const patched = await call(`/stok/kalemler/${item.id}`, { token, method: 'PATCH', body: { ad: 'Gri melanj şardon', colorHex: '#B0B0B0', colorNo: null } });
  assert.equal(patched.status, 200);
  assert.deepEqual((({ name, color_hex, color_no, fabric_key }) => [name, color_hex, color_no, fabric_key])(await patched.json()),
    ['Gri melanj şardon', '#b0b0b0', null, 'sardonlu_3_iplik|gri_melanj']);
  for (const body of [{ unit: 'm' }, { renk: 'siyah' }, { ad: '' }])
    assert.equal((await call(`/stok/kalemler/${item.id}`, { token, method: 'PATCH', body })).status, 400);
  const meter = await (await make({ tur: 'ribana', renk: 'siyah', unit: 'm' })).json();
  stock.recordCount(f.db, { itemId: item.id, countedMilli: 12500, countKey: 'raf', userId: f.manager.id });
  const rows = await (await call('/stok', { token })).json();
  const row = rows.find(r => r.id === item.id);
  assert.deepEqual([row.fabric_key, row.name, row.color_name, row.color_no, row.unit], ['sardonlu_3_iplik|gri_melanj', 'Gri melanj şardon', 'Gri Melanj', null, 'kg']);
  assert.deepEqual([row.total_milli, row.total_kg, row.available_kg, row.reserved_kg, row.shortage_kg, row.awaiting_delivery_kg], [12500, 12.5, 12.5, 0, 0, 0]);
  assert.equal(rows.find(r => r.id === meter.id).total_kg, null, 'no kg figure for a metre item');
  const [matched] = invoices.ingest(f.db, { lines: [line(1, 'Gri melanj şardonlu 3 iplik 5 kg', 5)] });
  assert.equal(f.db.prepare('SELECT item_id FROM invoice_lines WHERE id=?').get(matched.id).item_id, item.id, 'invoices land on the panel item');
});
