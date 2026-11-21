'use strict';
// G63 onay zinciri: invented orders, an invented panel-data.json and a temporary DATA_DIR. No network, no model call.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
// store.js fixes DATA_DIR when first required, so it is set before any require below.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'siparis-g63-'));
process.env.DATA_DIR = DATA;
process.env.AGENT_MOCK = '1';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ONAY_ZINCIRI;
process.on('exit', () => fs.rmSync(DATA, { recursive: true, force: true }));
const Database = require('better-sqlite3');
const { openDb } = require('../agent/siparis/db');
const auth = require('../agent/siparis/auth');
const orders = require('../agent/siparis/orders');
const { approveVersion } = require('../agent/siparis/approval');
const queue = require('../agent/siparis/outbox');
const chain = require('../agent/siparis/onayZinciri');
const cost = require('../agent/siparis/costTransfer');
const { panelData } = require('../agent/siparis/routes-panel');
const cli = require('../agent/siparis/cli');

const recipes = { version: 'test-g63-v1', products: {
  sweat: { label: 'Sweatshirt', materials: [{ key: 'kumas', g_per_unit: 350 }] },
  tisort: { label: 'Tişört', materials: [{ key: 'kumas', g_per_unit: 200 }] },
} };
const costTemplates = {
  products: [{ name: 'Sweatshirt', baski_nakis_haric_maliyet: 14.5, items: [{ category: 'Kumaş', amount: 10 }, { category: 'Dikim', amount: 4.5 }] }],
  price_tiers: [{ min: 1, max: 49 }, { min: 50, max: 9999 }], maliyet_risk_pct: { Sweatshirt: [10, 5] }, price_list: { Sweatshirt: [30, 25] },
  baski: { 'Küçük Boyut': 1, 'Orta Boyut': 2 }, nakis: { 'Küçük Boyut': 3 },
};
const PANEL = path.join(DATA, 'panel-data.json');
const DB_FILE = path.join(DATA, 'siparis.sqlite');
const panel = () => JSON.parse(fs.readFileSync(PANEL, 'utf8'));
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const exact = JSON.stringify({ method: 'elle' });
const line = (extra = {}) => ({ product_key: 'sweat', quantity: 20, color_name: 'Gece Mavisi', sizes: { S: 8, M: 12 },
  applications: [{ kind: 'baski', position: 'sirt', width_mm: 280, height_mm: 120, measure_source: exact }], ...extra });

async function setup(t, { on = true, jobs = [], cards = [], customers = [] } = {}) {
  for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) fs.rmSync(f, { force: true });
  for (const d of ['agent', 'paneldata-backups']) fs.rmSync(path.join(DATA, d), { recursive: true, force: true });
  fs.writeFileSync(PANEL, JSON.stringify({ data: { jobs, uretimTakip: cards, customers, costTemplates }, auth: {}, updatedAt: '2026-01-01T00:00:00.000Z' }));
  if (on) process.env.ONAY_ZINCIRI = '1'; else delete process.env.ONAY_ZINCIRI;
  const db = openDb(DB_FILE);
  const manager = await auth.createUser(db, { name: 'Yönetici', password: 'test-password', role: 'yonetici' });
  const team = await auth.createUser(db, { name: 'Ekip', password: 'test-password', role: 'ekip' });
  let stop = chain.mount(db, { dataDir: DATA, recipes, worker: true, intervalMs: 1e9 });
  t.after(() => { stop(); delete process.env.ONAY_ZINCIRI; if (db.open) db.close(); });
  function attach(versionId) {
    const pdf = path.join(DATA, `uretim-${versionId}.pdf`);
    fs.writeFileSync(pdf, `%PDF-1.4\n% Örnek üretim formu ${versionId}\n`);
    orders.addFile(db, versionId, { kind: 'uretim_formu', path: pdf, sha256: sha(fs.readFileSync(pdf)) }, team);
    return orders.addFile(db, versionId, { kind: 'onay_formu', path: path.join(DATA, `onay-${versionId}.pdf`), sha256: 'a'.repeat(64) }, team).id;
  }
  function approve(versionId) {
    const fileId = attach(versionId);
    orders.submitForApproval(db, versionId, team);
    return approveVersion(db, { versionId, userId: manager.id, fileId, recipes });
  }
  function approved({ lines = [line()], ...input } = {}) {
    const order = orders.createOrder(db, { order_no: 'SIP-T001', customer_name: 'Örnek Kulüp', ...input, lines }, team);
    approve(order.version.id);
    return { orderId: order.id, versionId: order.version.id, lineId: order.version.lines[0].id };
  }
  function revise(versionId, changes) { const v = orders.reviseVersion(db, versionId, changes, team); approve(v.id); return v.id; }
  async function run() { chain.enqueue(db); return queue.runOnce(db, 'onay_zinciri'); }
  const jobsOf = () => db.prepare("SELECT * FROM outbox WHERE kind='onay_zinciri' ORDER BY id").all();
  // A crashed worker leaves the job basarisiz (outcome unknown); the team retries it. Same path as a real restart.
  const crashRetry = job => { db.prepare("UPDATE outbox SET status='basarisiz' WHERE id=?").run(job.id); queue.retry(db, job.id, manager); };
  const remount = () => { stop(); stop = chain.mount(db, { dataDir: DATA, recipes, worker: true, intervalMs: 1e9 }); };
  return { db, manager, team, approve, approved, revise, run, jobsOf, remount, crashRetry };
}

test('kapalıyken (ONAY_ZINCIRI yok) onay kuyruğa iş koymaz, panel-data.json bayt bayt aynı kalır', async t => {
  const f = await setup(t, { on: false });
  const before = fs.readFileSync(PANEL, 'utf8');
  const a = f.approved();
  assert.equal(chain.enqueue(f.db), 0);
  assert.equal(await queue.runOnce(f.db, 'onay_zinciri'), null);
  assert.deepEqual(f.jobsOf(), []);
  assert.equal(fs.readFileSync(PANEL, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(DATA, 'paneldata-backups')), false);
  assert.equal(f.db.prepare('SELECT job_no FROM orders WHERE id=?').get(a.orderId).job_no, null);
  // The approval result itself is unchanged by the chain.
  assert.deepEqual(f.db.prepare('SELECT kind FROM outbox ORDER BY id').all().map(r => r.kind), ['maliyet_aktarim']);
});

test('açıkken onay tek İşler kaydı ve ona bağlı tek takip kartı açar; alanlar siparişten, fiyat/termin boş', async t => {
  const f = await setup(t, { customers: [{ id: 7, name: 'örnek kulüp' }] });
  const a = f.approved({ lines: [line({ unit_price_kurus: 12550 }),
    line({ product_key: 'sweat', quantity: 10, color_name: 'Kırmızı', sizes: { L: 10 }, unit_price_kurus: 12550,
      applications: [{ kind: 'nakis', position: 'gogus', width_mm: 80, height_mm: 60 }] })] });
  const done = await f.run();
  assert.equal(done.status, 'tamam', done.last_error);
  const { data } = panel();
  assert.equal(data.jobs.length, 1);
  assert.equal(data.uretimTakip.length, 1);
  const j = data.jobs[0], c = data.uretimTakip[0];
  assert.equal(j.job_no, 'SIP-T001');
  assert.equal(j.status, 'Onaylandı');
  assert.equal(j.customer_id, 7, 'exactly one registered customer with this name (case-insensitive)');
  assert.equal(j.customer_name_free, null);
  assert.equal(j.product_type, 'Sweatshirt');
  assert.equal(j.title, 'Sweatshirt (Gece Mavisi, Kırmızı)');
  assert.equal(j.quantity, 30);
  assert.equal(j.unit_price, 125.5, 'same line price on every line, from whole kuruş');
  assert.deepEqual(j.cost_items, []);
  assert.equal(j.delivery_date, null);
  assert.deepEqual(j.prod_size_breakdown, { S: 8, M: 12, L: 10 });
  assert.deepEqual(j.prod_print_areas, ['sırt']);
  assert.deepEqual(j.prod_embroidery_areas, ['göğüs']);
  assert.deepEqual(j.siparis_uygulamalar.map(u => [u.tur, u.konum, u.en_mm, u.boy_mm, u.adet, u.olcu_yaklasik]),
    [['baski', 'sırt', 280, 120, 20, false], ['nakis', 'göğüs', 80, 60, 10, true]]);
  assert.deepEqual(j.siparis_satirlar.map(s => [s.urun, s.renk, s.adet]), [['Sweatshirt', 'Gece Mavisi', 20], ['Sweatshirt', 'Kırmızı', 10]]);
  assert.match(j.note, /Ölçü yaklaşık: nakış göğüs/);
  assert.match(j.note, /termin bekliyor/);
  assert.equal(c.job_id, j.id);
  assert.equal(c.job_no, 'SIP-T001');
  assert.equal(c.status, 'Kumaş Bekleniyor');
  assert.equal(c.customer_name, 'Örnek Kulüp');
  assert.equal(c.quantity, 30);
  assert.equal(c.decoration, 'ikisi');
  assert.equal(c.product_type, 'sweat');
  assert.equal(c.lining, 'yok');
  assert.equal(c.est_delivery, null);
  assert.equal(f.db.prepare('SELECT job_no FROM orders WHERE id=?').get(a.orderId).job_no, 'SIP-T001');
  assert.ok(fs.readdirSync(path.join(DATA, 'paneldata-backups')).length >= 1, 'write went through the backup path');
  assert.deepEqual(JSON.parse(done.provider_ref), { isler: String(j.id), takip: String(c.id), uyari: 0 });
});

test('yeniden deneme ve ikinci tarama çift kayıt açmaz; değişiklik yoksa panel yeniden yazılmaz', async t => {
  const f = await setup(t);
  f.approved();
  await f.run();
  assert.equal(chain.enqueue(f.db), 0, 'one job per approved version');
  const stamp = panel().updatedAt;
  f.crashRetry(f.jobsOf()[0]);
  const again = await f.run();
  assert.equal(again.status, 'tamam');
  assert.equal(panel().data.jobs.length, 1);
  assert.equal(panel().data.uretimTakip.length, 1);
  assert.equal(panel().updatedAt, stamp, 'nothing changed, nothing written');
});

test('çökme sonrası (eşleme kaydı yokken) iş no ve job_id ile mevcut kayıt bulunur, ikinci kayıt açılmaz', async t => {
  const f = await setup(t);
  f.approved();
  await f.run();
  f.db.prepare('DELETE FROM onay_zinciri').run();
  f.crashRetry(f.jobsOf()[0]);
  assert.equal((await f.run()).status, 'tamam');
  assert.equal(panel().data.jobs.length, 1);
  assert.equal(panel().data.uretimTakip.length, 1);
});

test('revizyon onayında siparişten gelen alan güncellenir; Patron\'un elle değiştirdiği alan korunur ve uyarı düşer', async t => {
  const f = await setup(t);
  const a = f.approved();
  await f.run();
  const raw = panel();
  raw.data.jobs[0].title = 'Elle yazılan iş adı';
  raw.data.jobs[0].unit_price = 99;
  raw.data.uretimTakip[0].status = 'Kesimde';
  raw.data.uretimTakip[0].quantity = 21;
  fs.writeFileSync(PANEL, JSON.stringify(raw));
  const v2 = f.revise(a.versionId, { lines: [{ id: a.lineId, quantity: 30, sizes: { S: 10, M: 20 }, color_name: 'Siyah' }] });
  const done = await f.run();
  assert.equal(done.status, 'tamam', done.last_error);
  const { data } = panel();
  assert.equal(data.jobs.length, 1);
  const j = data.jobs[0], c = data.uretimTakip[0];
  assert.equal(j.quantity, 30);
  assert.deepEqual(j.prod_size_breakdown, { S: 10, M: 20 });
  assert.equal(j.siparis_surum, 2);
  assert.equal(j.title, 'Elle yazılan iş adı', 'hand-edited field kept');
  assert.equal(j.unit_price, 99, 'a price typed in İşler is never overwritten by an unknown one');
  assert.equal(c.status, 'Kesimde', 'stage is never touched');
  assert.equal(c.quantity, 21, 'hand-edited card quantity kept');
  const row = f.db.prepare('SELECT * FROM onay_zinciri WHERE order_id=?').get(a.orderId);
  assert.equal(row.version_id, v2);
  const warnings = JSON.parse(row.warnings_json);
  assert.ok(warnings.some(w => /İş adı/.test(w)), warnings.join(' | '));
  assert.ok(warnings.some(w => /Takip .*Adet/.test(w)), warnings.join(' | '));
  assert.ok(!warnings.some(w => /99/.test(w)), 'no amounts in warnings');
  const pv = panelData(f.db).onay_zinciri;
  assert.equal(pv.basarisiz, 0);
  assert.ok(pv.uyarilar.some(u => u.siparis_no === 'SIP-T001' && /İş adı/.test(u.mesaj)));
  // The superseded version's job (if it ran late) is skipped, never writes old data.
  const old = f.jobsOf()[0];
  assert.deepEqual(chain.run(JSON.parse(old.payload_json), { db: f.db }, { dataDir: DATA, recipes }), { providerRef: chain.STALE_REF });
});

test('geçici hata onayı geri almaz, iş yeniden denenir; kalıcı hata başarısız işlerde görünür', async t => {
  const f = await setup(t);
  const a = f.approved();
  const saved = fs.readFileSync(PANEL);
  fs.rmSync(PANEL);
  const first = await f.run();
  assert.equal(first.status, 'bekliyor');
  assert.equal(first.attempts, 1);
  assert.equal(f.db.prepare('SELECT status FROM order_versions WHERE id=?').get(a.versionId).status, 'onaylandi');
  fs.writeFileSync(PANEL, saved);
  queue.retry(f.db, first.id, f.manager);
  assert.equal((await f.run()).status, 'tamam');
  assert.equal(panel().data.jobs.length, 1);
});

test('belirsiz eşleşme (aynı iş numaralı iki İşler kaydı) yazmaz; başarısız + eksik_alan teyidi + panel-veri', async t => {
  const twins = [{ id: 1, job_no: 'SIP-T001', title: 'A' }, { id: 2, job_no: 'sip-t001', title: 'B' }];
  const f = await setup(t, { jobs: twins });
  f.approved();
  const before = fs.readFileSync(PANEL, 'utf8');
  const job = await f.run();
  assert.equal(job.status, 'basarisiz');
  assert.match(job.last_error, /birden fazla kayıt/);
  assert.ok(f.db.prepare("SELECT 1 FROM confirmations WHERE kind='eksik_alan' AND ref_table='outbox' AND ref_id=?").get(job.id));
  assert.equal(fs.readFileSync(PANEL, 'utf8'), before);
  assert.equal(panelData(f.db).onay_zinciri.basarisiz, 1);
});

test('siparişin iş numarası olan mevcut İşler kaydı benimsenir: yalnız boş alanlar dolar, dolu alan korunur', async t => {
  const f = await setup(t, { jobs: [{ id: 5, job_no: 'MRC-007', title: 'Elle açılmış iş', customer_name_free: 'Başka Ad', quantity: 0, unit_price: 0, status: 'Teklif' }] });
  f.approved({ job_no: 'MRC-007' });
  const done = await f.run();
  assert.equal(done.status, 'tamam', done.last_error);
  const { data } = panel();
  assert.equal(data.jobs.length, 1);
  const j = data.jobs[0];
  assert.equal(j.title, 'Elle açılmış iş');
  assert.equal(j.customer_name_free, 'Başka Ad');
  assert.equal(j.status, 'Teklif', 'status is never set on an existing record');
  assert.equal(j.quantity, 20, 'panel default 0 counts as empty');
  assert.equal(j.unit_price, 0, 'no price known: left as is');
  assert.equal(data.uretimTakip.length, 1);
  assert.equal(data.uretimTakip[0].job_id, 5);
  assert.equal(data.uretimTakip[0].job_no, 'MRC-007');
});

test('iş numarası verilmiş ama İşler\'de yoksa yeni kayıt açılmaz (G5 kuralı)', async t => {
  const f = await setup(t);
  f.approved({ job_no: 'MRC-404' });
  const job = await f.run();
  assert.equal(job.status, 'basarisiz');
  assert.match(job.last_error, /bulunamadı/);
  assert.deepEqual(panel().data.jobs, []);
});

test('satır fiyatları farklıysa birim fiyat boş kalır ve uyarı düşer; ortalama alınmaz', async t => {
  const f = await setup(t);
  f.approved({ lines: [line({ unit_price_kurus: 10000 }), line({ quantity: 5, sizes: { L: 5 }, unit_price_kurus: 12000 })] });
  await f.run();
  assert.equal(panel().data.jobs[0].unit_price, null);
  assert.ok(JSON.parse(f.db.prepare('SELECT warnings_json FROM onay_zinciri').get().warnings_json).some(w => /farklı/.test(w)));
  assert.throws(() => orders.createOrder(f.db, { order_no: 'SIP-T009', lines: [line({ unit_price_kurus: 12.5 })] }, f.team), /unit_price_kurus/);
});

test('zincir kapalıyken yapılan onaylar sonradan açılınca geriye dönük işlenmez', async t => {
  const f = await setup(t, { on: false });
  f.approved({ order_no: 'SIP-ESKI' });
  process.env.ONAY_ZINCIRI = '1';
  f.remount();
  assert.equal(chain.enqueue(f.db), 0);
  f.approved({ order_no: 'SIP-YENI' });
  assert.equal(chain.enqueue(f.db), 1);
  await queue.runOnce(f.db, 'onay_zinciri');
  assert.deepEqual(panel().data.jobs.map(j => j.job_no), ['SIP-YENI']);
});

test('silinmiş siparişin işi atlanır, panel yazılmaz', async t => {
  const f = await setup(t);
  const a = f.approved();
  chain.enqueue(f.db);
  // Approved orders cannot be deleted through the API; the guard is checked directly.
  f.db.prepare("UPDATE orders SET deleted_at='2026-01-02T00:00:00.000Z' WHERE id=?").run(a.orderId);
  const before = fs.readFileSync(PANEL, 'utf8');
  const job = await queue.runOnce(f.db, 'onay_zinciri');
  assert.equal(job.provider_ref, chain.DELETED_REF);
  assert.equal(fs.readFileSync(PANEL, 'utf8'), before);
});

test('kuru çalıştırma (cli onay-zinciri --kuru) planı JSON verir, hiçbir şey yazmaz', async t => {
  const f = await setup(t);
  const a = f.approved();
  const before = fs.readFileSync(PANEL, 'utf8');
  const outboxBefore = JSON.stringify(f.db.prepare('SELECT * FROM outbox').all());
  const audits = f.db.prepare('SELECT COUNT(*) n FROM audit_log').get().n;
  const logs = [];
  const original = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  let result;
  try { result = await cli.main(['onay-zinciri', '--kuru', String(a.versionId)]); } finally { console.log = original; }
  assert.equal(result.kuru, true);
  assert.equal(result.isler.islem, 'ac');
  assert.equal(result.isler.alanlar.quantity, 20);
  assert.equal(result.takip.islem, 'ac');
  assert.equal(result.takip.alanlar.status, 'Kumaş Bekleniyor');
  assert.deepEqual(JSON.parse(logs.join('\n')).isler.job_no, 'SIP-T001');
  assert.equal(fs.readFileSync(PANEL, 'utf8'), before);
  assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM outbox').all()), outboxBefore);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM audit_log').get().n, audits);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM onay_zinciri').get().n, 0);
  await assert.rejects(() => cli.main(['onay-zinciri', String(a.versionId)]), /Kullanım/);
});

test('G5 maliyet aktarımı zincirin açtığı kaydı günceller; ikinci İşler kaydı açılmaz, baskı maliyeti boyuttan gelir', async t => {
  const f = await setup(t);
  const a = f.approved();
  await f.run();
  const unregister = cost.register({ dataDir: DATA, recipes });
  t.after(unregister);
  assert.equal((await queue.runOnce(f.db, 'maliyet_aktarim')).status, 'fiyat_bekliyor');
  cost.setPrice(f.db, a.orderId, { unitPrice: 30, bnItems: [{ type: 'baski', area: 'sirt', size: 'Orta Boyut' }] }, f.manager);
  const done = await queue.runOnce(f.db, 'maliyet_aktarim');
  assert.equal(done.status, 'tamam', done.last_error);
  const { data } = panel();
  assert.equal(data.jobs.length, 1);
  assert.equal(done.provider_ref, String(data.jobs[0].id));
  assert.equal(data.jobs[0].unit_price, 30);
  assert.ok(data.jobs[0].cost_items.some(c => c.category === 'Baskı (sırt - Orta Boyut, 20 adet)' && c.amount === 40));
  assert.equal(data.uretimTakip.length, 1);
});

test('eski şema: outbox tablosu yeni iş türü için bir kez yeniden kurulur, eski satırlar korunur', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siparis-g63-eski-'));
  try {
    const file = path.join(dir, 'siparis.sqlite');
    const schema = fs.readFileSync(path.join(__dirname, '../agent/siparis/schema.sql'), 'utf8')
      .replace(",'onay_zinciri')", ')').replace(/ unit_price_kurus INTEGER[^\n]*\n/, '');
    assert.ok(!schema.includes('onay_zinciri') && !schema.includes('unit_price_kurus'));
    const old = new Database(file);
    old.exec(schema);
    old.prepare("INSERT INTO users(name,password_hash,role) VALUES('x','y','yonetici')").run();
    old.prepare("INSERT INTO orders(order_no) VALUES('SIP-ESKI')").run();
    old.prepare("INSERT INTO order_versions(order_id,version_no,created_by) VALUES(1,1,1)").run();
    old.prepare("INSERT INTO outbox(kind,idempotency_key,version_id,payload_json) VALUES('maliyet_aktarim','k1',1,'{}')").run();
    old.close();
    const db = openDb(file);
    try {
      assert.equal(db.prepare('SELECT COUNT(*) n FROM outbox').get().n, 1);
      db.prepare("INSERT INTO outbox(kind,idempotency_key,version_id,payload_json) VALUES('onay_zinciri','zincir:1',1,'{}')").run();
      assert.ok(db.prepare('PRAGMA table_info(order_lines)').all().some(c => c.name === 'unit_price_kurus'));
    } finally { db.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
