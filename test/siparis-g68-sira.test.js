'use strict';
// G68: approval chain and G5 cost transfer give the same İşler record whichever job runs first. Invented data only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
// store.js fixes DATA_DIR when first required, so it is set before any require below.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'siparis-g68-'));
process.env.DATA_DIR = DATA;
process.env.AGENT_MOCK = '1';
delete process.env.ANTHROPIC_API_KEY;
process.on('exit', () => fs.rmSync(DATA, { recursive: true, force: true }));
const { openDb } = require('../agent/siparis/db');
const auth = require('../agent/siparis/auth');
const orders = require('../agent/siparis/orders');
const { approveVersion } = require('../agent/siparis/approval');
const queue = require('../agent/siparis/outbox');
const cost = require('../agent/siparis/costTransfer');
const sizes = require('../agent/siparis/boyutEsleme');
const chain = require('../agent/siparis/onayZinciri');

const recipes = { version: 'test-g68-v1', products: { sweat: { label: 'Sweatshirt', materials: [{ key: 'kumas', g_per_unit: 350 }] } } };
const costTemplates = {
  products: [{ name: 'Sweatshirt', baski_nakis_haric_maliyet: 14.5, items: [{ category: 'Kumaş', amount: 10 }, { category: 'Dikim', amount: 4.5 }] }],
  price_tiers: [{ min: 1, max: 49 }, { min: 50, max: 9999 }], maliyet_risk_pct: { Sweatshirt: [10, 5] }, price_list: { Sweatshirt: [30, 25] },
  baski: { 'Küçük Boyut': 1, 'Orta Boyut': 2, 'Büyük Boyut': 3 },
};
// Invented limits for the test, not Patron's.
const MAP = { baski: [{ boyut: 'Küçük Boyut', enUzunMm: 100 }, { boyut: 'Orta Boyut', enUzunMm: 250 }, { boyut: 'Büyük Boyut', enUzunMm: 500 }] };
const PANEL = path.join(DATA, 'panel-data.json');
const DB_FILE = path.join(DATA, 'siparis.sqlite');
const panel = () => JSON.parse(fs.readFileSync(PANEL, 'utf8')).data;
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const approx = JSON.stringify({ method: 'otomatik', durum: 'yaklasik' });
const exact = JSON.stringify({ method: 'otomatik', durum: 'otomatik' });

// One full run: approve an order, then run the two queue jobs in the given order. Returns the panel and chain state.
async function scenario(t, first, { customers = [{ id: 3, name: 'Örnek Müşteri' }] } = {}) {
  for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) fs.rmSync(f, { force: true });
  for (const d of ['agent', 'paneldata-backups']) fs.rmSync(path.join(DATA, d), { recursive: true, force: true });
  fs.writeFileSync(PANEL, JSON.stringify({ data: { jobs: [], uretimTakip: [], customers, costTemplates }, auth: {}, updatedAt: '2026-01-01T00:00:00.000Z' }));
  process.env.ONAY_ZINCIRI = '1';
  const db = openDb(DB_FILE);
  const manager = await auth.createUser(db, { name: 'Yönetici', password: 'test-password', role: 'yonetici' });
  const team = await auth.createUser(db, { name: 'Ekip', password: 'test-password', role: 'ekip' });
  const stop = chain.mount(db, { dataDir: DATA, recipes, worker: true, intervalMs: 1e9 });
  const unregister = cost.register({ dataDir: DATA, recipes });
  t.after(() => { stop(); unregister(); delete process.env.ONAY_ZINCIRI; if (db.open) db.close(); });
  sizes.load(db, MAP);
  const order = orders.createOrder(db, { order_no: 'G68-ORNEK-1', customer_name: 'Örnek Müşteri', lines: [{ product_key: 'sweat', quantity: 20,
    color_name: 'Bordo', sizes: { S: 8, M: 12 }, unit_price_kurus: 42000, applications: [
      { kind: 'baski', position: 'sol_gogus', width_mm: 80, height_mm: 112, measure_source: exact },
      { kind: 'baski', position: 'sag_kol', width_mm: 190, height_mm: 119, measure_source: approx },
      { kind: 'baski', position: 'sirt', width_mm: 475, height_mm: 329, measure_source: approx }] }] }, team);
  const v = order.version.id, pdf = path.join(DATA, `uretim-${v}.pdf`);
  fs.writeFileSync(pdf, '%PDF-1.4\n% Örnek\n');
  orders.addFile(db, v, { kind: 'uretim_formu', path: pdf, sha256: sha(fs.readFileSync(pdf)) }, team);
  const fileId = orders.addFile(db, v, { kind: 'onay_formu', path: path.join(DATA, 'onay.pdf'), sha256: 'a'.repeat(64) }, team).id;
  orders.submitForApproval(db, v, team);
  approveVersion(db, { versionId: v, userId: manager.id, fileId, recipes });
  chain.enqueue(db);
  const results = {};
  for (const kind of first === 'zincir' ? ['onay_zinciri', 'maliyet_aktarim'] : ['maliyet_aktarim', 'onay_zinciri'])
    results[kind] = await queue.runOnce(db, kind);
  const map = db.prepare('SELECT * FROM onay_zinciri').get();
  return { data: panel(), results, map, db };
}
// Fields that only say when or under which document id a run happened.
const stable = job => {
  const { created_at, updated_at, document_id, document_hash, ...rest } = job;
  return { ...rest, note: String(rest.note).replace(/\[Üretim Formu [^\]]+\]/, '[Üretim Formu]') };
};

test('hangi iş önce çalışırsa çalışsın İşler kaydı, takip kartı ve eşleme aynı; sahte "elle değişmiş" uyarısı yok', async t => {
  const a = await scenario(t, 'zincir');
  const aJobs = a.data.jobs.map(stable), aCards = a.data.uretimTakip, aMap = { ...a.map };
  assert.equal(a.results.onay_zinciri.status, 'tamam', a.results.onay_zinciri.last_error);
  assert.equal(a.results.maliyet_aktarim.status, 'tamam', a.results.maliyet_aktarim.last_error);
  a.db.close();
  const b = await scenario(t, 'maliyet');
  assert.equal(b.results.maliyet_aktarim.status, 'tamam', b.results.maliyet_aktarim.last_error);
  assert.equal(b.results.onay_zinciri.status, 'tamam', b.results.onay_zinciri.last_error);
  assert.equal(b.data.jobs.length, 1);
  assert.equal(b.data.uretimTakip.length, 1);
  assert.deepEqual(b.data.jobs.map(stable), aJobs);
  assert.deepEqual(b.data.uretimTakip, aCards);
  assert.deepEqual(JSON.parse(b.map.warnings_json), [], 'no false hand-edit warning');
  assert.deepEqual(JSON.parse(aMap.warnings_json), []);
  for (const k of ['panel_job_id', 'uretim_id', 'job_no', 'job_fields_json', 'card_fields_json']) assert.equal(b.map[k], aMap[k], k);
  const j = b.data.jobs[0];
  assert.equal(j.customer_id, 3);
  assert.equal(j.customer_name_free, null);
  assert.equal(j.kaynak, 'onay_zinciri');
  // Both notes, chain first, each once.
  assert.match(j.note, /^\[Sipariş G68-ORNEK-1 v1\] onayda otomatik açıldı .* \| \[Üretim Formu /);
  assert.equal(j.note.split('[Sipariş G68-ORNEK-1 v1]').length, 2);
  assert.equal(j.note.split('[Üretim Formu').length, 2);
  assert.match(j.note, /Ölçü yaklaşık: baskı sağ kol, baskı sırt/);
  assert.deepEqual(j.prod_print_areas, ['sol göğüs', 'sağ kol', 'sırt']);
  assert.ok(j.cost_items.some(c => c.category === 'Baskı (sol göğüs - Orta Boyut, 20 adet)'), JSON.stringify(j.cost_items));
  // A rerun after both (crash retry) changes nothing and adds no second note.
  const before = JSON.stringify(panel());
  b.db.prepare("UPDATE outbox SET status='basarisiz' WHERE kind='onay_zinciri'").run();
  queue.retry(b.db, b.db.prepare("SELECT id FROM outbox WHERE kind='onay_zinciri'").get().id, 1);
  assert.equal((await queue.runOnce(b.db, 'onay_zinciri')).status, 'tamam');
  assert.equal(JSON.stringify(panel()), before);
});

test('G5 önce açtığı kayıtta müşteri gerçekten başka biriyse uyarı yine düşer', async t => {
  const b = await scenario(t, 'maliyet', { customers: [] });
  const raw = JSON.parse(fs.readFileSync(PANEL, 'utf8'));
  assert.equal(raw.data.jobs[0].customer_name_free, 'Örnek Müşteri');
  // Same run, but the team renamed the customer on the record before the chain ran.
  raw.data.jobs[0].customer_name_free = 'Başka Firma';
  fs.writeFileSync(PANEL, JSON.stringify(raw));
  b.db.prepare('DELETE FROM onay_zinciri').run();
  b.db.prepare("UPDATE outbox SET status='basarisiz' WHERE kind='onay_zinciri'").run();
  queue.retry(b.db, b.db.prepare("SELECT id FROM outbox WHERE kind='onay_zinciri'").get().id, 1);
  assert.equal((await queue.runOnce(b.db, 'onay_zinciri')).status, 'tamam');
  assert.equal(panel().jobs[0].customer_name_free, 'Başka Firma');
  assert.ok(JSON.parse(b.db.prepare('SELECT warnings_json FROM onay_zinciri').get().warnings_json).some(w => /Müşteri adı/.test(w)));
});
