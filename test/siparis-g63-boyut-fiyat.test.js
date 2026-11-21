'use strict';
// G63 ek: line price as G5's price, mm -> size name table, size name list, "ölçü yaklaşık" durum. Invented data only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
// store.js fixes DATA_DIR when first required, so it is set before any require below.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'siparis-g63b-'));
process.env.DATA_DIR = DATA;
process.env.AGENT_MOCK = '1';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ONAY_ZINCIRI;
process.on('exit', () => fs.rmSync(DATA, { recursive: true, force: true }));
const { openDb } = require('../agent/siparis/db');
const auth = require('../agent/siparis/auth');
const orders = require('../agent/siparis/orders');
const { approveVersion } = require('../agent/siparis/approval');
const queue = require('../agent/siparis/outbox');
const cost = require('../agent/siparis/costTransfer');
const sizes = require('../agent/siparis/boyutEsleme');
const chain = require('../agent/siparis/onayZinciri');
const cli = require('../agent/siparis/cli');

const recipes = { version: 'test-g63b-v1', products: { sweat: { label: 'Sweatshirt', materials: [{ key: 'kumas', g_per_unit: 350 }] } } };
const costTemplates = {
  products: [{ name: 'Sweatshirt', baski_nakis_haric_maliyet: 14.5, items: [{ category: 'Kumaş', amount: 10 }, { category: 'Dikim', amount: 4.5 }] }],
  price_tiers: [{ min: 1, max: 49 }, { min: 50, max: 9999 }], maliyet_risk_pct: { Sweatshirt: [10, 5] }, price_list: { Sweatshirt: [30, 25] },
  baski: { 'Küçük Boyut': 1, 'Orta Boyut': 2 }, nakis: { 'Küçük Boyut': 3 },
};
// Invented limits; the real ones come from Patron.
const MAP = { baski: [{ boyut: 'Küçük Boyut', enUzunMm: 100 }, { boyut: 'Orta Boyut', enUzunMm: 300, alanCm2: 900 }], nakis: [{ boyut: 'Küçük Boyut', enUzunMm: 90 }] };
const PANEL = path.join(DATA, 'panel-data.json');
const DB_FILE = path.join(DATA, 'siparis.sqlite');
const panel = () => JSON.parse(fs.readFileSync(PANEL, 'utf8'));
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const exact = JSON.stringify({ method: 'elle' });
const line = (extra = {}) => ({ product_key: 'sweat', quantity: 20, color_name: 'Gece Mavisi', sizes: { S: 8, M: 12 }, unit_price_kurus: 12550,
  applications: [{ kind: 'baski', position: 'sirt', width_mm: 280, height_mm: 120, measure_source: exact },
    { kind: 'baski', position: 'gogus', width_mm: 90, height_mm: 90, measure_source: exact }], ...extra });

async function setup(t) {
  for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) fs.rmSync(f, { force: true });
  for (const d of ['agent', 'paneldata-backups']) fs.rmSync(path.join(DATA, d), { recursive: true, force: true });
  fs.writeFileSync(PANEL, JSON.stringify({ data: { jobs: [], uretimTakip: [], customers: [], costTemplates }, auth: {}, updatedAt: '2026-01-01T00:00:00.000Z' }));
  const db = openDb(DB_FILE);
  const manager = await auth.createUser(db, { name: 'Yönetici', password: 'test-password', role: 'yonetici' });
  const team = await auth.createUser(db, { name: 'Ekip', password: 'test-password', role: 'ekip' });
  const unregister = cost.register({ dataDir: DATA, recipes });
  t.after(() => { unregister(); if (db.open) db.close(); });
  function approved({ lines = [line()], ...input } = {}) {
    const order = orders.createOrder(db, { order_no: 'SIP-B001', customer_name: 'Örnek Kulüp', ...input, lines }, team);
    const v = order.version.id, pdf = path.join(DATA, `uretim-${v}.pdf`);
    fs.writeFileSync(pdf, `%PDF-1.4\n% Örnek ${v}\n`);
    orders.addFile(db, v, { kind: 'uretim_formu', path: pdf, sha256: sha(fs.readFileSync(pdf)) }, team);
    const fileId = orders.addFile(db, v, { kind: 'onay_formu', path: path.join(DATA, `onay-${v}.pdf`), sha256: 'a'.repeat(64) }, team).id;
    orders.submitForApproval(db, v, team);
    approveVersion(db, { versionId: v, userId: manager.id, fileId, recipes });
    return { orderId: order.id, versionId: v };
  }
  const run = () => queue.runOnce(db, 'maliyet_aktarim');
  return { db, manager, approved, run };
}

test('satır fiyatı G5\'in fiyatı olur; boyut tablosu boşken "fiyat bekliyor"da yalnız boyut eksik kalır', async t => {
  const f = await setup(t);
  const a = f.approved();
  assert.equal((await f.run()).status, 'fiyat_bekliyor');
  const s = cost.costStatus(f.db, a.orderId);
  assert.equal(s.linePrice, 125.5);
  assert.equal(s.unitPrice, null);
  assert.ok(!s.missing.includes('Birim satış fiyatı girilmeli'), s.missing.join(' | '));
  assert.ok(s.missing.some(m => /Baskı boyutu seçilmeli/.test(m)));
  assert.equal(s.computation.priceSource, 'satir');
  assert.deepEqual(panel().data.jobs, []);
});

test('tablo doluyken boyut adı mm\'den bulunur, G5 elle giriş beklemeden İşler\'e maliyetle yazar', async t => {
  const f = await setup(t);
  sizes.load(f.db, MAP);
  const a = f.approved();
  const done = await f.run();
  assert.equal(done.status, 'tamam', done.last_error);
  const j = panel().data.jobs[0];
  assert.equal(j.unit_price, 125.5);
  assert.ok(j.cost_items.some(c => c.category === 'Baskı (sırt - Orta Boyut, 20 adet)' && c.amount === 40), JSON.stringify(j.cost_items));
  assert.ok(j.cost_items.some(c => c.category === 'Baskı (göğüs - Küçük Boyut, 20 adet)' && c.amount === 20));
  assert.match(j.note, /sipariş satırından/);
  const src = cost.costStatus(f.db, a.orderId).computation.sizeSources;
  assert.match(src.find(x => x.konum === 'sırt').kaynak, /280×120 mm.*en uzun ≤ 300 mm ve alan ≤ 900 cm²/);
});

test('G5\'te elle girilen fiyat satır fiyatından önceliklidir', async t => {
  const f = await setup(t);
  const a = f.approved();
  await f.run();
  cost.setPrice(f.db, a.orderId, { unitPrice: 30, bnItems: [{ type: 'baski', area: 'sirt', size: 'Orta Boyut' }, { type: 'baski', area: 'gogus', size: 'Küçük Boyut' }] }, f.manager);
  assert.equal((await f.run()).status, 'tamam');
  assert.equal(panel().data.jobs[0].unit_price, 30);
  assert.doesNotMatch(panel().data.jobs[0].note, /sipariş satırından/);
});

test('satır fiyatları farklıysa bugünkü davranış: fiyat istenir, ortalama alınmaz', async t => {
  const f = await setup(t);
  sizes.load(f.db, MAP);
  const a = f.approved({ lines: [line(), line({ quantity: 5, sizes: { L: 5 }, unit_price_kurus: 13000 })] });
  assert.equal((await f.run()).status, 'fiyat_bekliyor');
  const s = cost.costStatus(f.db, a.orderId);
  assert.equal(s.linePrice, null);
  assert.ok(s.missing.includes('Birim satış fiyatı girilmeli'));
});

test('boyut bulunamazsa (ölçü yok, kurala uymuyor, ad maliyet tablosunda yok) kalem boş kalır, sebep görünür, uydurma yok', async t => {
  const f = await setup(t);
  sizes.load(f.db, { baski: [{ boyut: 'Küçük Boyut', enUzunMm: 100 }, { boyut: 'Dev Boyut', enUzunMm: 500 }] });
  const a = f.approved({ lines: [line({ applications: [
    { kind: 'baski', position: 'sirt', width_mm: 280, height_mm: 120, measure_source: exact },
    { kind: 'baski', position: 'gogus', width_mm: 90, height_mm: 90, measure_source: exact },
    { kind: 'baski', position: 'kol', width_mm: 600, height_mm: 50, measure_source: exact },
    { kind: 'nakis', position: 'ense', width_mm: 40, height_mm: 30, measure_source: exact }] })] });
  assert.equal((await f.run()).status, 'fiyat_bekliyor');
  const s = cost.costStatus(f.db, a.orderId);
  const by = k => s.computation.sizeSources.find(x => x.konum === k);
  assert.equal(by('göğüs').boyut, 'Küçük Boyut');
  assert.equal(by('sırt').boyut, null);
  assert.match(by('sırt').kaynak, /"Dev Boyut" maliyet tablosunda yok/);
  assert.match(by('kol').kaynak, /hiçbir kurala uymuyor/);
  assert.equal(by('ense').kaynak, 'eşleme tablosu boş');
  assert.ok(s.missing.some(m => /Baskı boyutu bulunamadı: "Sırt"/.test(m)), s.missing.join(' | '));
  assert.deepEqual(panel().data.jobs, []);
});

test('kural sınırları: en uzun kenar sınıra eşitse uyar, alan ölçütü aşılırsa sonraki kurala geçer, ölçü yoksa boş', () => {
  const table = sizes.validate(MAP).map(r => ({ ...r }));
  assert.equal(sizes.sizeFor(table, { kind: 'baski', width_mm: 100, height_mm: 40 }, costTemplates).boyut, 'Küçük Boyut');
  assert.equal(sizes.sizeFor(table, { kind: 'baski', width_mm: 100.5, height_mm: 40 }, costTemplates).boyut, 'Orta Boyut');
  assert.equal(sizes.sizeFor(table, { kind: 'baski', width_mm: 300, height_mm: 300 }, costTemplates).boyut, 'Orta Boyut', '900 cm² equals the limit');
  assert.equal(sizes.sizeFor(table, { kind: 'baski', width_mm: 300, height_mm: 301 }, costTemplates).boyut, null);
  assert.equal(sizes.sizeFor(table, { kind: 'baski', width_mm: null, height_mm: 40 }, costTemplates).kaynak, 'ölçü yok');
  assert.throws(() => sizes.validate({ baski: [{ boyut: 'Orta Boyut', enUzunMm: 300 }, { boyut: 'Küçük Boyut', enUzunMm: 100 }] }), /küçükten büyüğe/);
  assert.throws(() => sizes.validate({ dtf: [] }), /Bilinmeyen tür/);
  assert.throws(() => sizes.validate({ baski: [{ boyut: 'X', enUzunMm: -1 }] }), /enUzunMm/);
  assert.throws(() => sizes.validate({ baski: [{ boyut: 'X', enUzunMm: 10, renk: 2 }] }), /bilinmeyen alan/);
});

test('tablo yüklenince fiyat bekleyen maliyet işi bir kez daha denenir; {} tabloyu boşaltır', async t => {
  const f = await setup(t);
  f.approved();
  assert.equal((await f.run()).status, 'fiyat_bekliyor');
  sizes.load(f.db, MAP);
  assert.equal((await f.run()).status, 'tamam');
  assert.deepEqual(sizes.load(f.db, {}), []);
});

test('CLI: boyut-esleme-yukle tabloyu yükler ve bilinmeyen adı uyarır; boyut-adlari yalnız okur', async t => {
  const f = await setup(t);
  const file = path.join(DATA, 'esleme.json');
  fs.writeFileSync(file, JSON.stringify({ baski: [{ boyut: 'Küçük Boyut', enUzunMm: 100 }, { boyut: 'Bilinmez', enUzunMm: 200 }] }));
  const logs = [], original = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    f.db.close();
    assert.equal((await cli.main(['boyut-esleme-yukle', file])).length, 2);
    const before = fs.readFileSync(PANEL, 'utf8'), dbBefore = fs.statSync(DB_FILE).mtimeMs;
    const listed = await cli.main(['boyut-adlari']);
    assert.deepEqual(listed.names.map(n => [n.tur, n.boyut, n.adetBasiTl]), [['baski', 'Küçük Boyut', 1], ['baski', 'Orta Boyut', 2], ['nakis', 'Küçük Boyut', 3]]);
    assert.equal(listed.rules.length, 2);
    assert.equal(fs.readFileSync(PANEL, 'utf8'), before);
    assert.equal(fs.statSync(DB_FILE).mtimeMs, dbBefore);
  } finally { console.log = original; }
  assert.ok(logs.some(l => /Bilinmez.*UYARI/.test(l)), logs.join('\n'));
  assert.ok(logs.some(l => /^nakis\tKüçük Boyut\t3$/.test(l)));
});

test('onay zinciri kuru çalıştırması her uygulamanın boyut adını ve kaynağını gösterir', async t => {
  const f = await setup(t);
  sizes.load(f.db, MAP);
  const a = f.approved();
  const out = chain.dryRun(f.db, a.versionId, { panel: panel(), recipes });
  assert.deepEqual(out.boyutlar.map(b => [b.konum, b.boyut]), [['sırt', 'Orta Boyut'], ['göğüs', 'Küçük Boyut']]);
  assert.match(out.boyutlar[1].kaynak, /90×90 mm.*en uzun ≤ 100 mm/);
});

test('"ölçü yaklaşık": ölçücünün durum alanı (yaklasik/standart) önceliklidir; yoksa yöntem kuralı', () => {
  const app = src => ({ width_mm: 100, height_mm: 50, needs_confirmation: 0, measure_source: JSON.stringify(src) });
  assert.equal(chain.approximate(app({ method: 'elle', durum: 'yaklasik' })), true);
  assert.equal(chain.approximate(app({ method: 'otomatik', durum: 'standart' })), true);
  assert.equal(chain.approximate(app({ method: 'standart_tablo', durum: 'kesin' })), false);
  assert.equal(chain.approximate(app({ method: 'elle' })), false);
  assert.equal(chain.approximate(app({ method: 'elle', olcuDurumu: 'yaklasik' })), true, 'G64 reads olcuDurumu too');
  assert.equal(chain.approximate(app({ method: 'elle', standart: true })), true);
  assert.equal(chain.approximate(app({ method: 'tahmin' })), true);
  assert.equal(chain.approximate({ ...app({ method: 'elle', durum: 'kesin' }), needs_confirmation: 1 }), true);
});
