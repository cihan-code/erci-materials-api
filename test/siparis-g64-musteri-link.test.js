'use strict';
// G64: customer approval link. Synthetic data only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { PNG } = require('pngjs');
const { openDb } = require('../agent/siparis/db');
const auth = require('../agent/siparis/auth');
const orders = require('../agent/siparis/orders');
const stock = require('../agent/siparis/stock');
const documents = require('../agent/siparis/documents');
const mount = require('../agent/siparis/routes');
const musteri = require('../agent/siparis/musteriOnay');

// node:http like the core tests (global fetch aborts natively next to better-sqlite3 on some Node versions).
function call(base, url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + url);
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, agent: false,
      headers: { ...(payload != null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { const buf = Buffer.concat(chunks); let data = buf;
        if ((res.headers['content-type'] || '').includes('json')) data = JSON.parse(buf.toString('utf8'));
        resolve({ status: res.statusCode, data, headers: res.headers }); });
    });
    req.on('error', reject); req.end(payload);
  });
}
const recipes = { version: 'g64-test', products: { tisort: { materials: [{ key: 'kumas', g_per_unit: 200 }] } } };
const ORIGIN = 'https://panel.example.test';
const png = () => { const p = new PNG({ width: 4, height: 4 }); p.data.fill(200); return PNG.sync.write(p); };

async function setup(t, { limits } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siparis-g64-'));
  const db = openDb(path.join(dir, 'siparis.sqlite'));
  process.env.PANEL_ORIGIN = ORIGIN;
  const manager = await auth.createUser(db, { name: 'Örnek Yetkili', password: 'synthetic-password', role: 'yonetici' });
  const team = await auth.createUser(db, { name: 'Örnek Ekip', password: 'synthetic-password' });
  stock.importLegacyFabrics(db, { fabrics: [{ id: 'f1', name: 'Örnek kumaş', colorName: 'Mavi', unit: 'kg' }] });
  const itemId = db.prepare('SELECT id FROM stock_items').get().id;
  stock.recordCount(db, { itemId, countedMilli: 50000, countKey: 'acilis', userId: manager.id });
  const app = express();
  const handle = mount(app, { db, dataDir: dir, worker: false, recipes, customerLimits: limits });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/siparis`;
  t.after(() => { server.close(); handle.close(); if (db.open) db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const login = async u => (await call(base, '/giris', { method: 'POST', body: { name: u.name, password: 'synthetic-password' } })).data.token;
  const tok = await login(team);
  const bearer = { authorization: `Bearer ${tok}` };
  let n = 0;
  // A version waiting for approval with a real onay_formu PDF and a product picture on disk.
  function make({ withForm = true } = {}) {
    const order = orders.createOrder(db, { order_no: `MRC-G64-${++n}`, customer_name: 'Örnek Kulüp', lines: [{ product_key: 'tisort', fabric_item_id: itemId, color_name: 'Mavi', quantity: 4, sizes: { M: 2, L: 2 } }] }, team);
    const v = order.version;
    const lineId = v.lines[0].id;
    db.prepare("INSERT INTO applications(line_id,kind,position,width_mm,height_mm,measure_source,needs_confirmation) VALUES(?,?,?,?,?,?,0)")
      .run(lineId, 'baski', 'gogus', 280, 120, JSON.stringify({ method: 'elle', iccKey: 'GIZLI-GEREKCE' }));
    const folder = documents.directory(dir, documents.safeSegment(order.order_no), `v${v.version_no}`);
    fs.mkdirSync(folder, { recursive: true });
    const put = (name, buf, kind, meta = {}) => {
      const p = path.join(folder, name); fs.writeFileSync(p, buf);
      const f = orders.addFile(db, v.id, { kind, path: p, sha256: crypto.createHash('sha256').update(buf).digest('hex') }, team);
      db.prepare('INSERT INTO document_file_meta(file_id,line_id,application_id,gorunum,mime) VALUES(?,?,?,?,?)').run(f.id, meta.lineId ?? null, null, meta.gorunum ?? null, meta.mime);
      return f;
    };
    const image = put('on.png', png(), 'urun_gorsel', { lineId, gorunum: 'on', mime: 'image/png' });
    // Internal-only artefacts that must never be reachable.
    const production = put('uretim.pdf', Buffer.from('%PDF-1.4 uretim'), 'uretim_formu', { mime: 'application/pdf' });
    const form = withForm ? put('onay.pdf', Buffer.from('%PDF-1.4 onay-formu'), 'onay_formu', { mime: 'application/pdf' }) : null;
    orders.submitForApproval(db, v.id, team);
    return { order, versionId: v.id, lineId, image, form, production };
  }
  const mint = async (versionId) => (await call(base, `/surumler/${versionId}/musteri-link`, { method: 'POST', headers: bearer }));
  const tokenOf = r => new URL(r.data.link).searchParams.get('t');
  return { db, dir, base, manager, team, bearer, make, mint, tokenOf, itemId };
}

test('link üretilir: 32+ bayt belirteç, DB yalnız özet tutar, 14 gün, panel adresiyle', async t => {
  const f = await setup(t); const x = f.make();
  assert.equal((await call(f.base, `/surumler/${x.versionId}/musteri-link`, { method: 'POST' })).status, 401);
  const r = await f.mint(x.versionId);
  assert.equal(r.status, 201);
  assert.match(r.data.link, new RegExp(`^${ORIGIN.replace(/\./g, '\\.')}/onay\\.html\\?t=[A-Za-z0-9_-]{43}$`));
  const token = f.tokenOf(r);
  assert.ok(Buffer.from(token, 'base64url').length >= 32);
  const row = f.db.prepare('SELECT * FROM customer_links').get();
  assert.equal(row.token_hash, crypto.createHash('sha256').update(token).digest('hex'));
  assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM audit_log').all()).includes(token));
  const days = (Date.parse(row.expires_at) - Date.parse(row.created_at)) / 86400000;
  assert.ok(Math.abs(days - 14) < 0.01);
  // Only a version waiting for approval gets a link.
  const draft = orders.createOrder(f.db, { order_no: 'MRC-G64-TASLAK', lines: [{ product_key: 'tisort', quantity: 1 }] }, f.team);
  assert.equal((await f.mint(draft.version.id)).status, 409);
});

test('yeniden istenince eski belirteç iptal olur, süre dolunca ve revizyonda link ölür', async t => {
  const f = await setup(t); const x = f.make();
  const a = f.tokenOf(await f.mint(x.versionId)), b = f.tokenOf(await f.mint(x.versionId));
  assert.notEqual(a, b);
  assert.equal((await call(f.base, `/musteri/${a}`)).status, 404);
  assert.equal((await call(f.base, `/musteri/${b}`)).status, 200);
  // Expiry: move the stored expiry into the past.
  f.db.prepare('UPDATE customer_links SET expires_at=? WHERE token_hash=?').run(new Date(Date.now() - 1000).toISOString(), crypto.createHash('sha256').update(b).digest('hex'));
  assert.equal((await call(f.base, `/musteri/${b}`)).status, 404);
  // Revision of the version kills its links.
  const y = f.make(); const c = f.tokenOf(await f.mint(y.versionId));
  assert.equal((await call(f.base, `/musteri/${c}`)).status, 200);
  orders.reviseVersion(f.db, y.versionId, {}, f.manager);
  const dead = await call(f.base, `/musteri/${c}`);
  assert.equal(dead.status, 404);
  assert.equal((await call(f.base, `/musteri/${c}/onay-formu.pdf`)).status, 404);
});

test('geçersiz, kısa, bilinmeyen ve iptal belirteçleri aynı 404 cevabını verir', async t => {
  const f = await setup(t); const x = f.make(); const good = f.tokenOf(await f.mint(x.versionId));
  await f.mint(x.versionId); // revokes `good`
  const answers = [];
  for (const tok of [good, 'a'.repeat(43), 'kisa', crypto.randomBytes(32).toString('base64url')])
    answers.push(await call(f.base, `/musteri/${tok}`));
  for (const a of answers) { assert.equal(a.status, 404); assert.deepEqual(a.data, answers[0].data); }
});

test('özet ucu yalnız beyaz listedeki alanları döner; fiyat, stok, iç not, kullanıcı, gerekçe yok', async t => {
  const f = await setup(t); const x = f.make();
  f.db.prepare("UPDATE order_lines SET note='IC-NOT-GIZLI' WHERE id=?").run(x.lineId);
  f.db.prepare("INSERT INTO confirmations(kind,ref_table,ref_id,message) VALUES('olcu','applications',1,'TEYIT-GEREKCE-GIZLI')").run();
  const token = f.tokenOf(await f.mint(x.versionId));
  const r = await call(f.base, `/musteri/${token}`);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.data).sort(), ['durum', 'notlar', 'onayFormu', 'sartlar', 'siparis', 'sonKullanma', 'urunler'].sort());
  assert.deepEqual(Object.keys(r.data.siparis).sort(), ['ad', 'no', 'surum']);
  const u = r.data.urunler[0];
  assert.deepEqual(Object.keys(u).sort(), ['adet', 'ad', 'bedenler', 'gorseller', 'kumas', 'numune', 'renk', 'uygulamalar'].sort());
  assert.deepEqual(Object.keys(u.uygulamalar[0]).sort(), ['boyMm', 'enMm', 'konum', 'olcu', 'tur']);
  assert.deepEqual(u.bedenler, { M: 2, L: 2 });
  assert.equal(u.uygulamalar[0].olcu, 'standart');
  assert.equal(r.data.durum, 'bekliyor');
  const text = JSON.stringify({ ...r.data, sartlar: undefined }); // the generic terms text legitimately says "masraf/maliyet"
  for (const secret of ['IC-NOT-GIZLI', 'TEYIT-GEREKCE-GIZLI', 'GIZLI-GEREKCE', 'Örnek Yetkili', 'Örnek Ekip', 'fiyat', 'maliyet', 'price', 'cost', 'stok', 'fabric_item_id', 'password', f.dir])
    assert.ok(!text.includes(secret), secret);
  assert.match(r.data.sartlar, /ŞARTLAR VE KOŞULLAR/);
});

test('onay formu ve ürün görseli yalnız o sürümden servis edilir', async t => {
  const f = await setup(t); const x = f.make(); const other = f.make();
  const token = f.tokenOf(await f.mint(x.versionId));
  const summary = (await call(f.base, `/musteri/${token}`)).data;
  assert.equal(summary.urunler[0].gorseller.length, 1);
  const pdf = await call(f.base, `/musteri/${token}/onay-formu.pdf`);
  assert.equal(pdf.status, 200); assert.equal(pdf.headers['content-type'], 'application/pdf');
  assert.match(pdf.data.toString(), /onay-formu/);
  const img = await call(f.base, new URL(summary.urunler[0].gorseller[0].url, 'http://x').pathname.replace('/api/siparis', ''));
  assert.equal(img.status, 200); assert.equal(img.headers['content-type'], 'image/png');
  // Another version's picture, the production form and the id of a nonexistent file are all refused.
  for (const id of [other.image.id, x.production.id, 99999]) assert.equal((await call(f.base, `/musteri/${token}/gorsel/${id}`)).status, 404);
});

test('onay tek seferlik: approveVersion etkileri (stok ayırma, outbox) personelin onayıyla aynı, audit yazılır', async t => {
  const f = await setup(t); const x = f.make(); const y = f.make();
  const token = f.tokenOf(await f.mint(x.versionId));
  assert.equal((await call(f.base, `/musteri/${token}/onayla`, { method: 'POST', body: { adSoyad: 'Ayşe Örnek' } })).status, 400); // kabul yok
  assert.equal((await call(f.base, `/musteri/${token}/onayla`, { method: 'POST', body: { adSoyad: '', kabul: true } })).status, 400);
  const ua = { 'user-agent': 'Test-Tarayici/1.0' };
  const first = await call(f.base, `/musteri/${token}/onayla`, { method: 'POST', headers: ua, body: { adSoyad: 'Ayşe Örnek', kabul: true } });
  assert.equal(first.status, 200); assert.deepEqual(first.data, { durum: 'onaylandi', tekrar: false });
  const second = await call(f.base, `/musteri/${token}/onayla`, { method: 'POST', body: { adSoyad: 'Ayşe Örnek', kabul: true } });
  assert.equal(second.status, 200); assert.equal(second.data.durum, 'onaylandi');
  assert.equal(f.db.prepare('SELECT count(*) n FROM approvals WHERE version_id=?').get(x.versionId).n, 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM customer_approvals').get().n, 1);
  assert.equal(f.db.prepare("SELECT count(*) n FROM audit_log WHERE action='surum_onayla' AND ref=?").get(String(x.versionId)).n, 1);
  const ca = f.db.prepare('SELECT * FROM customer_approvals').get();
  assert.equal(ca.full_name, 'Ayşe Örnek'); assert.equal(ca.user_agent, 'Test-Tarayici/1.0'); assert.ok(ca.ip);
  const approver = f.db.prepare('SELECT u.name FROM approvals a JOIN users u ON u.id=a.approved_by WHERE a.version_id=?').get(x.versionId);
  assert.equal(approver.name, musteri.CUSTOMER_USER);
  // Same effects as a staff approval of a twin version.
  const { approveVersion } = require('../agent/siparis/approval');
  const staff = approveVersion(f.db, { versionId: y.versionId, userId: f.manager.id, fileId: y.form.id, recipes });
  const mine = f.db.prepare('SELECT a.* FROM allocations a JOIN order_lines l ON l.id=a.order_line_id WHERE l.version_id=?').all(x.versionId);
  assert.equal(mine.length, staff.allocations.length);
  assert.equal(mine[0].need_milli, staff.allocations[0].need_milli); assert.equal(mine[0].reserved_milli, staff.allocations[0].reserved_milli);
  const kinds = v => f.db.prepare('SELECT kind FROM outbox WHERE version_id=? ORDER BY id').all(v).map(r => r.kind);
  assert.deepEqual(kinds(x.versionId), kinds(y.versionId));
  assert.ok(kinds(x.versionId).includes('maliyet_aktarim'));
  assert.equal((await call(f.base, `/musteri/${token}`)).data.durum, 'onaylandi');
  // Once approved, a change note is refused.
  assert.equal((await call(f.base, `/musteri/${token}/degisiklik`, { method: 'POST', body: { adSoyad: 'Ayşe Örnek', not: 'geç kaldım' } })).status, 409);
});

test('onay formu hazır değilse onay 409 verir ve hiçbir şey yazmaz; iç gerekçe dışarı sızmaz', async t => {
  const f = await setup(t);
  // No form: the link itself cannot be minted; drop the form after minting to hit the approval guard.
  const x = f.make(); const token = f.tokenOf(await f.mint(x.versionId));
  f.db.prepare("DELETE FROM document_file_meta WHERE file_id=?").run(x.form.id);
  f.db.prepare("DELETE FROM files WHERE id=?").run(x.form.id);
  const r = await call(f.base, `/musteri/${token}/onayla`, { method: 'POST', body: { adSoyad: 'Ayşe Örnek', kabul: true } });
  assert.equal(r.status, 409); assert.match(r.data.error, /Onay formu/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM approvals').get().n, 0);
  // Missing recipe: approveVersion fails internally; the customer only sees the generic message.
  const y = f.make(); f.db.prepare("UPDATE order_lines SET product_key='yok-urun' WHERE id=?").run(y.lineId);
  const t2 = f.tokenOf(await f.mint(y.versionId));
  const r2 = await call(f.base, `/musteri/${t2}/onayla`, { method: 'POST', body: { adSoyad: 'Ayşe Örnek', kabul: true } });
  assert.equal(r2.status, 409); assert.ok(!/yok-urun|Reçete/.test(JSON.stringify(r2.data)));
  assert.equal(f.db.prepare('SELECT count(*) n FROM approvals').get().n, 0);
  assert.equal(f.db.prepare("SELECT count(*) n FROM audit_log WHERE action='musteri_onay_reddedildi'").get().n, 1);
  assert.equal((await f.mint(orders.createOrder(f.db, { order_no: 'MRC-G64-F', lines: [{ product_key: 'tisort', quantity: 1 }] }, f.team).version.id)).status, 409);
});

test('değişiklik notu onaylamaz, durum değişir, teyit düşer, çok not tarihle saklanır, düz metin', async t => {
  const f = await setup(t); const x = f.make(); const token = f.tokenOf(await f.mint(x.versionId));
  const bad = b => call(f.base, `/musteri/${token}/degisiklik`, { method: 'POST', body: b });
  assert.equal((await bad({ adSoyad: 'Ayşe Örnek', not: '' })).status, 400);
  assert.equal((await bad({ adSoyad: 'Ayşe Örnek', not: 'x'.repeat(2001) })).status, 400);
  assert.equal((await bad({ adSoyad: 'Ayşe Örnek', not: 'Göğüs baskısı biraz küçülsün <script>alert(1)</script>' })).status, 201);
  assert.equal((await bad({ adSoyad: 'Ayşe Örnek', not: 'Renk bir ton açık olsun' })).status, 201);
  assert.equal(f.db.prepare('SELECT count(*) n FROM approvals').get().n, 0);
  assert.equal(f.db.prepare('SELECT status FROM order_versions WHERE id=?').get(x.versionId).status, 'onay_bekliyor');
  const s = (await call(f.base, `/musteri/${token}`)).data;
  assert.equal(s.durum, 'degisiklik_istendi'); assert.equal(s.notlar.length, 2);
  const conf = f.db.prepare("SELECT * FROM confirmations WHERE kind='musteri_notu' AND status='acik'").all();
  assert.equal(conf.length, 2); assert.equal(conf[0].ref_table, 'order_versions'); assert.equal(conf[0].ref_id, x.versionId);
  const notes = await call(f.base, `/surumler/${x.versionId}/musteri-notlari`, { headers: f.bearer });
  assert.equal(notes.data.length, 2); assert.ok(notes.data[0].metin.includes('<script>')); assert.ok(notes.data[0].tarih);
  assert.equal((await call(f.base, `/musteri/${token}/degisiklik`, { method: 'POST', body: { adSoyad: 'Ayşe Örnek', not: 'x' } })).status, 201);
});

test('hız sınırı: belirteç başına ve IP başına; gövde boyutu sınırı; CORS yalnız PANEL_ORIGIN', async t => {
  const f = await setup(t, { limits: { perTokenMax: 3, perIpMax: 6 } }); const x = f.make(); const token = f.tokenOf(await f.mint(x.versionId));
  const codes = []; for (let i = 0; i < 4; i++) codes.push((await call(f.base, `/musteri/${token}`)).status);
  assert.deepEqual(codes, [200, 200, 200, 429]);
  // A different token is limited per IP once the IP budget is spent.
  const rnd = () => crypto.randomBytes(32).toString('base64url');
  const more = []; for (let i = 0; i < 4; i++) more.push((await call(f.base, `/musteri/${rnd()}`)).status);
  assert.ok(more.includes(429)); assert.equal(more[0], 404);
  const g = await setup(t); const y = g.make(); const tk = g.tokenOf(await g.mint(y.versionId));
  const big = await call(g.base, `/musteri/${tk}/degisiklik`, { method: 'POST', body: { adSoyad: 'Ayşe Örnek', not: 'a'.repeat(20000) } });
  assert.equal(big.status, 413);
  const ok = await call(g.base, `/musteri/${tk}`, { headers: { origin: ORIGIN } });
  assert.equal(ok.headers['access-control-allow-origin'], ORIGIN);
  const evil = await call(g.base, `/musteri/${tk}`, { headers: { origin: 'https://evil.example.test' } });
  assert.equal(evil.headers['access-control-allow-origin'], undefined);
  assert.equal(ok.headers['cache-control'], 'no-store');
});

test('eski veritabanındaki teyit tablosu musteri_notu türünü kabul edecek biçimde yeniden kurulur', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siparis-g64m-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'old.sqlite');
  let db = openDb(file);
  db.exec(`PRAGMA foreign_keys=OFF; DROP TABLE confirmations; CREATE TABLE confirmations (id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('olcu','fatura_eslesme','eksik_alan','baglanti_hatasi','vektor_kalite','eski_surum')),
    ref_table TEXT NOT NULL, ref_id INTEGER NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'acik' CHECK(status IN ('acik','cozuldu')), resolved_by INTEGER REFERENCES users(id));
    INSERT INTO confirmations(kind,ref_table,ref_id,message) VALUES('olcu','applications',1,'eski kayıt');`);
  db.close();
  db = openDb(file); t.after(() => db.close());
  assert.equal(db.prepare('SELECT count(*) n FROM confirmations').get().n, 1);
  db.prepare("INSERT INTO confirmations(kind,ref_table,ref_id,message) VALUES('musteri_notu','order_versions',1,'x')").run();
});
