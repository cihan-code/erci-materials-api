'use strict';
// G5 maliyet aktarımı: invented orders, an invented panel-data.json and a temporary DATA_DIR. No network, no model call.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
// The legacy cost modules read DATA_DIR when first required, so it is fixed before any require below.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'siparis-maliyet-'));
process.env.DATA_DIR = DATA;
process.env.AGENT_MOCK = '1';
delete process.env.ANTHROPIC_API_KEY;
process.on('exit', () => fs.rmSync(DATA, { recursive: true, force: true }));
const express = require('express');
const { openDb } = require('../agent/siparis/db');
const auth = require('../agent/siparis/auth');
const orders = require('../agent/siparis/orders');
const { approveVersion } = require('../agent/siparis/approval');
const queue = require('../agent/siparis/outbox');
const mount = require('../agent/siparis/routes');
const cost = require('../agent/siparis/costTransfer');
const docs = require('../agent/documents');

const recipes = { version: 'test-maliyet-v1', products: {
  sweat: { label: 'Sweatshirt', materials: [{ key: 'kumas', g_per_unit: 350 }] },
  tisort: { label: 'Tişört', materials: [{ key: 'kumas', g_per_unit: 200 }] },
} };
const costTemplates = {
  products: [{ name: 'Sweatshirt', baski_nakis_haric_maliyet: 14.5, items: [{ category: 'Kumaş', amount: 10 }, { category: 'Dikim', amount: 4.5 }] }],
  price_tiers: [{ min: 1, max: 49 }, { min: 50, max: 9999 }],
  maliyet_risk_pct: { Sweatshirt: [10, 5] },
  price_list: { Sweatshirt: [30, 25] },
  baski: { 'Küçük Boyut': 1, 'Orta Boyut': 2 },
  nakis: { 'Küçük Boyut': 3 },
};
const PANEL = path.join(DATA, 'panel-data.json');
const panelJobs = () => JSON.parse(fs.readFileSync(PANEL, 'utf8')).data.jobs;
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const line = (extra = {}) => ({ product_key: 'sweat', quantity: 20, color_name: 'Gece Mavisi', sizes: { S: 8, M: 12 },
  applications: [{ kind: 'baski', position: 'sirt', width_mm: 280, height_mm: 120 }], ...extra });
const sirt = [{ type: 'baski', area: 'sirt', size: 'Orta Boyut' }];
const fiyat = a => `/siparisler/${a.orderId}/fiyat`;
const maliyet = a => `/siparisler/${a.orderId}/maliyet`;

async function setup(t, { jobs = [] } = {}) {
  for (const d of ['agent', 'paneldata-backups']) fs.rmSync(path.join(DATA, d), { recursive: true, force: true });
  fs.writeFileSync(PANEL, JSON.stringify({ data: { jobs, costTemplates }, auth: {}, updatedAt: '2026-01-01T00:00:00.000Z' }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siparis-maliyet-db-'));
  const db = openDb(path.join(dir, 'siparis.sqlite'));
  const manager = await auth.createUser(db, { name: 'Yönetici', password: 'test-password', role: 'yonetici' });
  const team = await auth.createUser(db, { name: 'Ekip', password: 'test-password', role: 'ekip' });
  const app = express();
  mount(app, { db, dataDir: DATA, worker: false, recipes });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const unregister = cost.register({ dataDir: DATA, recipes });
  t.after(async () => {
    unregister();
    await new Promise(r => { server.close(r); server.closeAllConnections?.(); });
    if (db.open) db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const tokens = { manager: (await auth.login(db, { name: 'Yönetici', password: 'test-password' })).token,
    team: (await auth.login(db, { name: 'Ekip', password: 'test-password' })).token };
  const base = `http://127.0.0.1:${server.address().port}/api/siparis`;
  async function http(method, url, token, body) {
    const res = await fetch(base + url, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json() };
  }
  const pdfPath = versionId => path.join(dir, `uretim-${versionId}.pdf`);
  function attach(versionId) {
    fs.writeFileSync(pdfPath(versionId), `%PDF-1.4\n% Örnek üretim formu ${versionId}\n`);
    orders.addFile(db, versionId, { kind: 'uretim_formu', path: pdfPath(versionId), sha256: sha(fs.readFileSync(pdfPath(versionId))) }, team);
    return orders.addFile(db, versionId, { kind: 'onay_formu', path: path.join(dir, `onay-${versionId}.pdf`), sha256: 'a'.repeat(64) }, team).id;
  }
  function approved({ lines = [line()], ...input }) {
    const order = orders.createOrder(db, { customer_name: 'Örnek Kulüp', ...input, lines }, team);
    const versionId = order.version.id, fileId = attach(versionId);
    orders.submitForApproval(db, versionId, team);
    approveVersion(db, { versionId, userId: manager.id, fileId, recipes });
    return { orderId: order.id, versionId, lineId: order.version.lines[0].id };
  }
  function revise(versionId, changes) {
    const v = orders.reviseVersion(db, versionId, changes, team), fileId = attach(v.id);
    approveVersion(db, { versionId: v.id, userId: manager.id, fileId, recipes });
    return v.id;
  }
  const run = () => queue.runOnce(db, 'maliyet_aktarim');
  const row = versionId => db.prepare('SELECT * FROM cost_transfers WHERE version_id=?').get(versionId);
  const audits = action => db.prepare('SELECT * FROM audit_log WHERE action=?').all(action);
  // A permanent data error closes the job as basarisiz with an open eksik_alan teyit; it is never retried on its own.
  const teyit = job => db.prepare("SELECT message FROM confirmations WHERE kind='eksik_alan' AND ref_table='outbox' AND ref_id=? AND status='acik'").get(job.id)?.message;
  return { db, dir, manager, team, tokens, http, approved, revise, run, row, audits, teyit, pdfPath };
}

test('fiyat yokken fiyat_bekliyor: maliyet mevcut şablondan hesaplanır, İşler\'e kayıt düşmez, model çağrılmaz', async t => {
  const f = await setup(t);
  const a = f.approved({ order_no: 'MRC-T001' });
  const result = await f.run();
  assert.equal(result.status, 'fiyat_bekliyor');
  assert.deepEqual(panelJobs(), []);
  const s = await f.http('GET', maliyet(a), f.tokens.team);
  assert.equal(s.status, 200);
  assert.equal(s.body.status, 'fiyat_bekliyor');
  assert.equal(s.body.priceWaiting, true);
  assert.equal(s.body.jobId, null);
  assert.equal(s.body.computation.template.name, 'Sweatshirt');
  assert.deepEqual(s.body.computation.costItems, [{ category: 'Kumaş', amount: 200 }, { category: 'Dikim', amount: 90 }, { category: 'Risk Payı (%10)', amount: 29 }]);
  assert.equal(s.body.computation.suggestedUnitPrice, 30);
  assert.ok(s.body.missing.some(m => /Baskı boyutu seçilmeli/.test(m)), s.body.missing.join(' | '));
  assert.ok(s.body.missing.includes('Birim satış fiyatı girilmeli'));
  const doc = docs.getDocument(f.row(a.versionId).document_id);
  assert.equal(doc.status, 'extracted');
  assert.equal(doc.extractMeta.source, 'siparis');
  assert.equal(doc.classification.finalType, 'production_form');
  assert.equal(fs.existsSync(path.join(DATA, 'agent', 'usage-log.jsonl')), false);
});

test('fiyat girilince İşler\'e tek kayıt düşer; kalemler şablondan gelir, iş no ve audit yazılır', async t => {
  const f = await setup(t);
  const a = f.approved({ order_no: 'MRC-T001' });
  await f.run();
  const posted = await f.http('POST', fiyat(a), f.tokens.manager, { unitPrice: 30, kdvDahil: false, bnItems: sirt });
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  assert.equal(posted.body.status, 'bekliyor');
  assert.equal(posted.body.unitPrice, 30);
  assert.equal(posted.body.kdvDahil, false);
  assert.equal(f.audits('maliyet_fiyat').length, 1);
  assert.equal(f.audits('maliyet_fiyat')[0].user_id, f.manager.id);
  const done = await f.run();
  assert.equal(done.status, 'tamam');
  const jobs = panelJobs();
  assert.equal(jobs.length, 1);
  const j = jobs[0];
  assert.equal(done.provider_ref, String(j.id));
  assert.equal(j.job_no, 'MRC-T001');
  assert.equal(j.quantity, 20);
  assert.equal(j.unit_price, 30);
  assert.equal(j.product_type, 'Sweatshirt');
  assert.equal(j.status, 'Onaylandı');
  assert.equal(j.customer_name_free, 'Örnek Kulüp');
  assert.deepEqual(j.cost_items, [{ category: 'Kumaş', amount: 200 }, { category: 'Dikim', amount: 90 },
    { category: 'Risk Payı (%10)', amount: 29 }, { category: 'Baskı (sırt - Orta Boyut, 20 adet)', amount: 40 }]);
  assert.deepEqual(j.prod_size_breakdown, { S: 8, M: 12 });
  assert.equal(j.document_id, f.row(a.versionId).document_id);
  assert.match(j.note, /KDV hariç/);
  assert.equal(f.db.prepare('SELECT job_no FROM orders WHERE id=?').get(a.orderId).job_no, 'MRC-T001');
  assert.equal(f.audits('siparis_is_no').length, 1);
  assert.equal(f.audits('maliyet_aktarildi').length, 1);
  const s = await f.http('GET', maliyet(a), f.tokens.team);
  assert.equal(s.body.status, 'tamam');
  assert.equal(s.body.jobId, String(j.id));
  assert.equal(s.body.priceWaiting, false);
  assert.equal(s.body.lastError, null);
  assert.equal((await f.http('POST', fiyat(a), f.tokens.manager, { unitPrice: 31 })).status, 409);
});

test('aynı iş tekrar çalışınca ikinci kayıt oluşmaz: tekrar çağrı, çökme sonrası, elle açılmış İşler kaydı', async t => {
  const byHand = { id: 7, job_no: ' mrc-t002 ', title: 'Elle açılan iş', status: 'Kesimde', customer_id: 42, delivery_date: '2026-12-01', quantity: 1, unit_price: 0, cost_items: [] };
  const f = await setup(t, { jobs: [byHand] });
  const a = f.approved({ order_no: 'MRC-T001' });
  assert.equal((await f.http('POST', fiyat(a), f.tokens.manager, { unitPrice: 30, bnItems: sirt })).status, 200);
  const first = await f.run();
  assert.equal(first.status, 'tamam');
  assert.equal(panelJobs().length, 2);
  // Patron: prices are excluding VAT; an entry without kdvDahil is stored and noted that way.
  assert.equal(f.row(a.versionId).kdv_dahil, 0);
  assert.match(panelJobs().find(x => x.job_no === 'MRC-T001').note, /KDV hariç/);
  const payload = JSON.parse(first.payload_json), context = { db: f.db, idempotencyKey: first.idempotency_key, job: first };
  assert.deepEqual(await cost.transfer(payload, context, { dataDir: DATA, recipes }), { providerRef: first.provider_ref });
  assert.equal(panelJobs().length, 2);
  // Crash after the İşler write but before our bookkeeping: the committed document leads back to the same record.
  f.db.prepare('UPDATE cost_transfers SET done_at=NULL,panel_job_id=NULL WHERE version_id=?').run(a.versionId);
  f.db.prepare('UPDATE orders SET job_no=NULL WHERE id=?').run(a.orderId);
  assert.deepEqual(await cost.transfer(payload, context, { dataDir: DATA, recipes }), { providerRef: first.provider_ref });
  assert.equal(panelJobs().length, 2);
  assert.equal(f.db.prepare('SELECT job_no FROM orders WHERE id=?').get(a.orderId).job_no, 'MRC-T001');
  // An İşler record typed by hand with the same order number is updated, never duplicated, and keeps what the order does not know.
  const b = f.approved({ order_no: 'MRC-T002' });
  await f.http('POST', fiyat(b), f.tokens.manager, { unitPrice: 25, bnItems: sirt });
  const updated = await f.run();
  assert.equal(updated.status, 'tamam');
  assert.equal(updated.provider_ref, '7');
  const jobs = panelJobs();
  assert.equal(jobs.length, 2);
  const j = jobs.find(x => x.id === 7);
  assert.equal(j.status, 'Kesimde');
  assert.equal(j.customer_id, 42);
  assert.equal(j.delivery_date, '2026-12-01');
  assert.equal(j.title, 'Elle açılan iş');
  assert.equal(j.quantity, 20);
  assert.equal(j.unit_price, 25);
  assert.equal(f.db.prepare('SELECT job_no FROM orders WHERE id=?').get(b.orderId).job_no, 'mrc-t002');
});

test('revizyonda aynı İşler kaydı güncellenir; eski sürümün fiyatı yeni sürüme taşınmaz', async t => {
  const f = await setup(t);
  const a = f.approved({ order_no: 'MRC-T001' });
  await f.run();
  await f.http('POST', fiyat(a), f.tokens.manager, { unitPrice: 30, kdvDahil: false, bnItems: sirt });
  const v1 = await f.run();
  assert.equal(v1.status, 'tamam');
  const v2Id = f.revise(a.versionId, { lines: [{ id: a.lineId, quantity: 30, sizes: { S: 10, M: 20 } }] });
  const waiting = await f.run();
  assert.equal(waiting.version_id, v2Id);
  assert.equal(waiting.status, 'fiyat_bekliyor');
  const s = await f.http('GET', maliyet(a), f.tokens.team);
  assert.equal(s.body.versionNo, 2);
  assert.equal(s.body.unitPrice, null);
  assert.equal(s.body.jobId, v1.provider_ref);
  assert.equal((await f.http('POST', fiyat(a), f.tokens.manager, { unitPrice: 28, kdvDahil: true, bnItems: sirt })).status, 200);
  const v2 = await f.run();
  assert.equal(v2.status, 'tamam');
  assert.equal(v2.provider_ref, v1.provider_ref);
  const jobs = panelJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].quantity, 30);
  assert.equal(jobs[0].unit_price, 28);
  assert.deepEqual(jobs[0].cost_items, [{ category: 'Kumaş', amount: 300 }, { category: 'Dikim', amount: 135 },
    { category: 'Risk Payı (%10)', amount: 43.5 }, { category: 'Baskı (sırt - Orta Boyut, 30 adet)', amount: 60 }]);
  assert.equal(jobs[0].document_id, f.row(v2Id).document_id);
  assert.match(jobs[0].note, /KDV dahil/);
  assert.equal(f.db.prepare('SELECT job_no FROM orders WHERE id=?').get(a.orderId).job_no, 'MRC-T001');
});

test('revizyon eski sürümün bekleyen maliyet işini iptal eder; yedek yol eski sürümü İşler\'e yazmaz', async t => {
  const f = await setup(t);
  const a = f.approved({ order_no: 'MRC-T001' });
  const waiting = await f.run();
  assert.equal(waiting.status, 'fiyat_bekliyor');
  orders.reviseVersion(f.db, a.versionId, {}, f.team);
  assert.equal(f.db.prepare('SELECT status FROM outbox WHERE id=?').get(waiting.id).status, 'iptal');
  assert.equal(await f.run(), null);
  assert.equal((await f.http('POST', fiyat(a), f.tokens.manager, { unitPrice: 30 })).status, 409);
  assert.throws(() => queue.retry(f.db, waiting.id, f.manager), /tekrar denenemez/);
  // Fallback: a stale job that still reaches the adapter is closed without touching İşler.
  const context = { db: f.db, idempotencyKey: waiting.idempotency_key, job: waiting };
  assert.deepEqual(await cost.transfer(JSON.parse(waiting.payload_json), context, { dataDir: DATA, recipes }), { providerRef: cost.STALE_REF });
  assert.deepEqual(panelJobs(), []);
  assert.equal(f.audits('maliyet_atlandi').length, 1);
  assert.equal(f.db.prepare('SELECT job_no FROM orders WHERE id=?').get(a.orderId).job_no, null);
});

test('onay yetkisi kapalı (--onaysiz) kullanıcının fiyat girişi 403 döner ve iz bırakmaz; varsayılan ekip üyesi girebilir', async t => {
  const f = await setup(t);
  const a = f.approved({ order_no: 'MRC-T001' });
  await f.run();
  const intern = await auth.createUser(f.db, { name: 'Stajyer', password: 'test-password', onayYetkisi: false });
  const { token } = await auth.login(f.db, { name: 'Stajyer', password: 'test-password' });
  assert.equal((await f.http('POST', fiyat(a), token, { unitPrice: 30 })).status, 403);
  assert.throws(() => cost.setPrice(f.db, a.orderId, { unitPrice: 30 }, intern), e => e.status === 403);
  assert.equal(f.row(a.versionId).unit_price, null);
  assert.equal(f.audits('maliyet_fiyat').length, 0);
  assert.equal(f.db.prepare("SELECT status FROM outbox WHERE version_id=? AND kind='maliyet_aktarim'").get(a.versionId).status, 'fiyat_bekliyor');
  assert.equal((await f.http('POST', fiyat(a), f.tokens.team, { unitPrice: 30 })).status, 200);
  assert.equal(f.audits('maliyet_fiyat')[0].user_id, f.team.id);
});

test('fiyat girdisi doğrulanır; olmayan sipariş 404, onaysız sipariş 409', async t => {
  const f = await setup(t);
  const a = f.approved({ order_no: 'MRC-T001' });
  for (const body of [{ unitPrice: 0 }, { unitPrice: -5 }, { unitPrice: '30' }, { unitPrice: 12.345 }, {},
    { unitPrice: 30, kdvDahil: 'evet' }, { unitPrice: 30, bnItems: 'sirt' },
    { unitPrice: 30, bnItems: [{ type: 'baski', area: 'göğüs', size: 'Orta Boyut' }] },
    { unitPrice: 30, bnItems: [{ type: 'nakis', area: 'sirt', size: 'Küçük Boyut' }] },
    { unitPrice: 30, bnItems: [{ type: 'baski', area: 'sirt', size: 'Orta Boyut', qty: 0 }] }])
    assert.equal((await f.http('POST', fiyat(a), f.tokens.manager, body)).status, 400, JSON.stringify(body));
  assert.equal(f.row(a.versionId), undefined);
  assert.equal((await f.http('POST', '/siparisler/999/fiyat', f.tokens.manager, { unitPrice: 30 })).status, 404);
  assert.equal((await f.http('GET', '/siparisler/999/maliyet', f.tokens.team)).status, 404);
  const draft = orders.createOrder(f.db, { order_no: 'MRC-T009', lines: [line()] }, f.team);
  assert.equal((await f.http('POST', `/siparisler/${draft.id}/fiyat`, f.tokens.manager, { unitPrice: 30 })).status, 409);
  const s = await f.http('GET', `/siparisler/${draft.id}/maliyet`, f.tokens.team);
  assert.equal(s.status, 200);
  assert.equal(s.body.status, null);
  assert.equal(s.body.priceWaiting, false);
});

test('belirsiz İşler eşleşmesinde kayıt açılmaz ve hiçbir kayıt güncellenmez', async t => {
  const f = await setup(t, { jobs: [{ id: 1, job_no: 'MRC-T001', title: 'A' }, { id: 2, job_no: 'mrc-t001 ', title: 'B' },
    { id: 3, job_no: 'IS-7', title: 'C' }, { id: 4, job_no: 'MRC-T003', title: 'D' }] });
  const before = panelJobs();
  for (const [input, error] of [[{ order_no: 'MRC-T001' }, /birden fazla kayıt/], [{ order_no: 'MRC-T002', job_no: 'IS-404' }, /"IS-404" İşler'de bulunamadı/],
    [{ order_no: 'MRC-T003', job_no: 'IS-7' }, /hem "IS-7" hem "MRC-T003"/]]) {
    const a = f.approved(input);
    await f.http('POST', fiyat(a), f.tokens.manager, { unitPrice: 30, bnItems: sirt });
    const failed = await f.run();
    assert.equal(failed.version_id, a.versionId);
    assert.equal(failed.status, 'basarisiz');
    assert.equal(failed.attempts, 1);
    assert.match(failed.last_error, error);
    assert.match(f.teyit(failed), error);
    assert.match((await f.http('GET', maliyet(a), f.tokens.team)).body.lastError, error);
  }
  assert.deepEqual(panelJobs(), before);
  assert.equal(f.db.prepare("SELECT job_no FROM orders WHERE order_no='MRC-T001'").get().job_no, null);
});

test('fiyat varken eksik ya da bozuk veri kalıcı hata olur: şablon, baskı adedi, çoklu ürün, SHA, veri klasörü', async t => {
  const f = await setup(t);
  const permanent = async (a, error) => {
    const failed = await f.run();
    assert.equal(failed.version_id, a.versionId);
    assert.equal(failed.status, 'basarisiz');
    assert.match(failed.last_error, error);
    assert.match(f.teyit(failed), error);
    return failed;
  };
  const noTemplate = f.approved({ order_no: 'MRC-T010', lines: [line({ product_key: 'tisort', applications: [] })] });
  await f.http('POST', fiyat(noTemplate), f.tokens.manager, { unitPrice: 20 });
  await permanent(noTemplate, /şablonuyla eşleşmedi/);
  assert.ok((await f.http('GET', maliyet(noTemplate), f.tokens.team)).body.missing.some(m => /şablonuyla eşleşmedi/.test(m)));
  // A missing print size is fixed through the fiyat endpoint, which requeues the failed job.
  const twoPrints = f.approved({ order_no: 'MRC-T011', lines: [line({ applications: [{ kind: 'baski', position: 'sirt' }, { kind: 'baski', position: 'sırt' }] })] });
  await f.http('POST', fiyat(twoPrints), f.tokens.manager, { unitPrice: 30, bnItems: sirt });
  const short = await permanent(twoPrints, /Baskı adedi siparişle tutmuyor: "sırt" siparişte 40, seçimde 20/);
  const fixed = await f.http('POST', fiyat(twoPrints), f.tokens.manager, { unitPrice: 30,
    bnItems: [...sirt, { type: 'baski', area: 'sirt', size: 'Küçük Boyut', label: 'yazı' }] });
  assert.equal(fixed.body.status, 'bekliyor');
  assert.equal(f.teyit(short), undefined);
  assert.equal((await f.run()).status, 'tamam');
  assert.deepEqual(panelJobs()[0].cost_items.slice(-2), [{ category: 'Baskı (sırt - Orta Boyut, 20 adet)', amount: 40 },
    { category: 'Baskı (yazı - Küçük Boyut, 20 adet)', amount: 20 }]);
  const mixed = f.approved({ order_no: 'MRC-T012', lines: [line({ applications: [] }), line({ product_key: 'tisort', applications: [] })] });
  await f.http('POST', fiyat(mixed), f.tokens.manager, { unitPrice: 30 });
  await permanent(mixed, /Birden çok ürün tipi \(sweat, tisort\)/);
  const tampered = f.approved({ order_no: 'MRC-T013' });
  await f.http('POST', fiyat(tampered), f.tokens.manager, { unitPrice: 30, bnItems: sirt });
  fs.appendFileSync(f.pdfPath(tampered.versionId), 'değişti');
  await permanent(tampered, /SHA256/);
  const elsewhere = f.approved({ order_no: 'MRC-T014', lines: [line({ applications: [] })] });
  await f.http('POST', fiyat(elsewhere), f.tokens.manager, { unitPrice: 30 });
  const job = f.db.prepare("SELECT * FROM outbox WHERE version_id=? AND kind='maliyet_aktarim'").get(elsewhere.versionId);
  await assert.rejects(cost.transfer(JSON.parse(job.payload_json), { db: f.db }, { dataDir: f.dir, recipes }), e => e.permanent === true && /veri klasörü/.test(e.message));
  assert.equal(panelJobs().length, 1);
  assert.equal(docs.listDocuments({}).length, 2);
});

test('yalnız bazı satırlarda olan uygulama gerçek adediyle maliyetlenir; eksik beden dağılımı bilinmiyor kalır', async t => {
  const f = await setup(t);
  const a = f.approved({ order_no: 'MRC-T020', lines: [
    line({ quantity: 10, sizes: { S: 4, M: 6 }, applications: [{ kind: 'nakis', position: 'gogus' }] }),
    line({ quantity: 5, sizes: { L: 5 }, color_name: 'Kiremit', applications: [] })] });
  await f.http('POST', fiyat(a), f.tokens.manager, { unitPrice: 30, bnItems: [{ type: 'nakis', area: 'gogus', size: 'Küçük Boyut' }] });
  assert.equal((await f.run()).status, 'tamam');
  const j = panelJobs()[0];
  assert.equal(j.quantity, 15);
  assert.equal(j.title, 'Sweatshirt (Gece Mavisi, Kiremit)');
  assert.deepEqual(j.cost_items, [{ category: 'Kumaş', amount: 150 }, { category: 'Dikim', amount: 67.5 },
    { category: 'Risk Payı (%10)', amount: 21.75 }, { category: 'Nakış (göğüs - Küçük Boyut, 10 adet)', amount: 30 }]);
  assert.deepEqual(j.prod_size_breakdown, { S: 4, M: 6, L: 5 });
  const b = f.approved({ order_no: 'MRC-T021', lines: [line({ applications: [] }), line({ quantity: 5, sizes: {}, applications: [] })] });
  await f.http('POST', fiyat(b), f.tokens.manager, { unitPrice: 30 });
  assert.equal((await f.run()).status, 'tamam');
  const jb = panelJobs().find(x => x.job_no === 'MRC-T021');
  assert.equal(jb.quantity, 25);
  assert.equal(jb.prod_size_breakdown, null);
});
