'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('node:child_process');
const express = require('express');
const { openDb } = require('../agent/siparis/db');
const auth = require('../agent/siparis/auth');
const stock = require('../agent/siparis/stock');
const invoices = require('../agent/siparis/invoices');
const kartela = require('../agent/siparis/kartela');
const mount = require('../agent/siparis/routes');
const { parseInvoiceDescription, matchInvoiceLine, fabricKey } = require('../agent/siparis/matching');

// Invented data only: users "Ekip"/"Yönetici", invoices FAT-K…, legacy ids k9…
const SERVICE_KEY = 'uydurma-servis-anahtari-kartela';
const priorKey = process.env.SIPARIS_SERVIS_ANAHTARI;
process.env.SIPARIS_SERVIS_ANAHTARI = SERVICE_KEY;
after(() => { if (priorKey === undefined) delete process.env.SIPARIS_SERVIS_ANAHTARI; else process.env.SIPARIS_SERVIS_ANAHTARI = priorKey; });
const CLI = path.join(__dirname, '../agent/siparis/cli.js');
const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, '../agent/siparis/kartela.json'), 'utf8'));

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siparis-kartela-'));
  const db = openDb(path.join(dir, 'siparis.sqlite'));
  t.after(() => { if (db.open) db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const team = await auth.createUser(db, { name: 'Ekip', password: 'test-password', role: 'ekip' });
  return { dir, db, team };
}
function request(port, url, { token, body, method = body ? 'POST' : 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: url, method, agent: false, headers: { 'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(data ?? undefined);
  });
}
async function serve(t, f) {
  const app = express();
  mount(app, { db: f.db, dataDir: f.dir, worker: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => { server.close(r); server.closeAllConnections?.(); }));
  const { token } = await auth.login(f.db, { name: 'Ekip', password: 'test-password' });
  return (url, options = {}) => request(server.address().port, '/api/siparis' + url, { token, ...options });
}
const invoiceLine = (id, description, quantity) => ({ sourceInvoiceId: 'FAT-K1', sourceLineId: String(id), invoiceNo: 'FAT-K1',
  invoiceDate: '2026-11-20', supplier: 'Örnek Tedarik', supplierVkn: '0000000000', description, quantity, unit: 'kg',
  unitPrice: 1, purchaseRef: null, deliveryConfirmed: false });
const need = (id, fabricKey, shortageMilli) => ({ orderLineId: id, orderNo: `MRC-K${id}`, shortageMilli, fabricKey });

test('GET /kartela: person login only; four cards, Polar colours resolved from 3 İplik, keys and flags from the data', async t => {
  const f = await setup(t);
  const call = await serve(t, f);
  assert.equal((await call('/kartela', { token: null })).status, 401);
  assert.equal((await call('/kartela', { token: SERVICE_KEY })).status, 401, 'the service key is not a person login');
  const res = await call('/kartela');
  assert.equal(res.status, 200);
  const { surum, kartelalar } = res.body;
  assert.equal(surum, 1);
  assert.deepEqual(Object.keys(res.body), ['surum', 'kartelalar']);
  assert.deepEqual(kartelalar.map(k => [k.id, k.ad, k.kumaslar.map(x => `${x.tur}=${x.ad}`).join(',')]), [
    ['suprem_30_1', '30/1 Süprem', 'supren_30_1=30/1 Süprem'],
    ['uc_iplik', '3 İplik', 'sardonlu_3_iplik=3 İplik Sardonlu,sardonsuz_3_iplik=3 İplik Sardonsuz'],
    ['lakost_30_1', '30/1 Lacoste', 'lakost=30/1 Lacoste'],
    ['polar', 'Polar', 'polar=Polar']]);
  const byId = Object.fromEntries(kartelalar.map(k => [k.id, k]));
  assert.ok(kartelalar.every(k => k.renkler.length === 36 && !('renklerKaynagi' in k)));
  assert.deepEqual(byId.polar.renkler, byId.uc_iplik.renkler, 'Polar returns the 3 İplik colours resolved');
  assert.match(byId.polar.not, /3 İplik/);
  assert.equal(byId.suprem_30_1.not, undefined);
  assert.deepEqual(byId.suprem_30_1.renkler.find(r => r.no === 14), { no: 14, renk: 'Lacivert', renkKey: 'lacivert', hex: '#251f40' });
  assert.deepEqual(byId.suprem_30_1.renkler.find(r => r.no === 4), { no: 4, renk: 'Gri Melanj', renkKey: 'gri_melanj', hex: '#c8c8c8', dokulu: true });
  assert.match(byId.suprem_30_1.renkler.find(r => r.no === 26).teyit, /19/);
  assert.deepEqual(byId.lakost_30_1.renkler.filter(r => /^(acik|koyu)_/.test(r.renkKey)).map(r => r.renkKey),
    ['koyu_kirmizi', 'acik_haki', 'acik_lila', 'acik_sari', 'koyu_vizon']);
  // Every number and colour name comes from the data file as written.
  for (const k of DATA.kartelalar) {
    const own = k.renkler || DATA.kartelalar.find(x => x.id === k.renklerKaynagi).renkler;
    assert.deepEqual(byId[k.id].renkler.map(r => [r.no, r.renk, r.hex]), own.map(r => [r.no, r.renk, r.hex.toLowerCase()]));
  }
});

test('POST /stok/kalemler with kartelaNo: card name, number, hex and key; second request returns the item as mevcut', async t => {
  const f = await setup(t);
  const call = await serve(t, f);
  const created = await call('/stok/kalemler', { body: { tur: 'supren_30_1', kartelaNo: 14, unit: 'kg' } });
  assert.equal(created.status, 201);
  const item = created.body;
  assert.deepEqual([item.fabric_key, item.name, item.color_name, item.color_no, item.color_hex, item.unit],
    ['supren_30_1|lacivert', '30/1 Süprem 14 Lacivert', 'Lacivert', '14', '#251f40', 'kg']);
  assert.deepEqual(item.kartela, { id: 'suprem_30_1', ad: '30/1 Süprem', no: 14 });
  assert.equal(item.mevcut, undefined);
  const audits = () => f.db.prepare("SELECT detail_json d FROM audit_log WHERE action='stok_kalemi_olustur'").all().map(r => JSON.parse(r.d));
  assert.deepEqual(audits(), [{ fabricKey: 'supren_30_1|lacivert', kartela: 'suprem_30_1', no: 14 }]);

  // Same item asked again, in words and with the number as text: nothing new is opened.
  const again = await call('/stok/kalemler', { body: { tur: '30/1 Süprem', kartelaNo: '14', unit: 'kg' } });
  assert.equal(again.status, 200);
  assert.deepEqual([again.body.id, again.body.mevcut, again.body.kartela.no], [item.id, true, 14]);
  assert.equal(f.db.prepare('SELECT count(*) n FROM stock_items').get().n, 1);
  assert.equal(audits().length, 1, 'returning the existing item writes nothing');

  // Polar reads 3 İplik's numbers; the same number on another fabric is another item.
  const polar = await call('/stok/kalemler', { body: { tur: 'Polar', kartelaNo: 14, unit: 'kg' } });
  assert.deepEqual([polar.status, polar.body.name, polar.body.fabric_key, polar.body.kartela], [201, 'Polar 14 Lacivert', 'polar|lacivert', { id: 'polar', ad: 'Polar', no: 14 }]);
  const sardonsuz = await call('/stok/kalemler', { body: { tur: 'sardonsuz_3_iplik', kartelaNo: 11, unit: 'kg' } });
  assert.deepEqual([sardonsuz.body.name, sardonsuz.body.fabric_key], ['3 İplik Sardonsuz 11 Gri Melanj', 'sardonsuz_3_iplik|gri_melanj']);
  const lacoste = await call('/stok/kalemler', { body: { tur: 'lakost', kartelaNo: 3, renk: 'Petrol Mavi', unit: 'kg' } });
  assert.deepEqual([lacoste.status, lacoste.body.name, lacoste.body.color_hex], [201, '30/1 Lacoste 3 Petrol Mavi', '#5d96a1'], 'a matching renk is accepted');

  // An item opened earlier by colour name has the same key: it is returned, unbound until kartela-uygula numbers it.
  const byName = await call('/stok/kalemler', { body: { tur: 'lakost', renk: 'Siyah', unit: 'kg' } });
  assert.equal(byName.status, 201);
  const twin = await call('/stok/kalemler', { body: { tur: 'lakost', kartelaNo: 5, unit: 'kg' } });
  assert.deepEqual([twin.status, twin.body.id, twin.body.mevcut, twin.body.color_no, 'kartela' in twin.body], [200, byName.body.id, true, null, false]);

  // The old body works as before: 409 with the item on the same key.
  const old = await call('/stok/kalemler', { body: { tur: 'supren_30_1', renk: 'lacivert', unit: 'kg' } });
  assert.deepEqual([old.status, old.body.item.id], [409, item.id]);
});

test('POST /stok/kalemler with kartelaNo: bad number, carded type missing, unconfirmed name and conflicting fields are 400', async t => {
  const f = await setup(t);
  const call = await serve(t, f);
  const bad = async (body, pattern) => {
    const res = await call('/stok/kalemler', { body: { unit: 'kg', ...body } });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(res.body.error, pattern);
  };
  await bad({ tur: 'supren_30_1', kartelaNo: 37 }, /30\/1 Süprem kartelasında 37 numara yok/);
  await bad({ tur: 'polar', kartelaNo: 99 }, /Polar kartelasında 99 numara yok/);
  for (const kartelaNo of [0, -3, 1.5, 'on dört', '14a', true])
    await bad({ tur: 'supren_30_1', kartelaNo }, /Kartela numarası pozitif tam sayı olmalı/);
  await bad({ tur: 'ribana_30_1', kartelaNo: 1 }, /"ribana_30_1" için kartela yok/);
  await bad({ tur: 'süprem', kartelaNo: 1 }, /için kartela yok/);
  await bad({ kartelaNo: 1 }, /Kumaş türü gerekli/);
  await bad({ tur: 'supren_30_1', kartelaNo: 26 }, /26 numaralı rengin adı teyit bekliyor/);
  await bad({ tur: 'supren_30_1', kartelaNo: 14, colorHex: '#000000' }, /karteladan gelir/);
  await bad({ tur: 'supren_30_1', kartelaNo: 14, ad: 'Özel ad' }, /karteladan gelir/);
  await bad({ tur: 'supren_30_1', kartelaNo: 14, renk: 'Siyah' }, /"Siyah" kartelada 14 numaralı renk \(Lacivert\) değil/);
  assert.equal((await call('/stok/kalemler', { body: { tur: 'supren_30_1', kartelaNo: 14, unit: 'ton' } })).status, 400);
  assert.equal(f.db.prepare('SELECT count(*) n FROM stock_items').get().n, 0);
});

test('stock item endpoints return color_no, color_hex and kartela only while the number names the key colour', async t => {
  const f = await setup(t);
  const call = await serve(t, f);
  const carded = (await call('/stok/kalemler', { body: { tur: 'lakost', kartelaNo: 8, unit: 'kg' } })).body;
  const free = (await call('/stok/kalemler', { body: { tur: 'ribana_30_1', renk: 'Siyah', unit: 'kg', colorNo: '6', colorHex: '#101010' } })).body;
  const typed = (await call('/stok/kalemler', { body: { tur: 'polar', renk: 'Bordo', unit: 'kg', colorNo: '12' } })).body;
  assert.deepEqual(typed.kartela, { id: 'polar', ad: 'Polar', no: 12 }, 'a number typed by hand binds when it is that colour');
  assert.equal('kartela' in free, false, 'no card for ribana');
  const rows = (await call('/stok')).body;
  const row = id => rows.find(r => r.id === id);
  assert.deepEqual([row(carded.id).color_no, row(carded.id).color_hex, row(carded.id).kartela], ['8', '#251f40', { id: 'lakost_30_1', ad: '30/1 Lacoste', no: 8 }]);
  assert.deepEqual([row(free.id).color_no, row(free.id).color_hex, 'kartela' in row(free.id)], ['6', '#101010', false]);
  assert.equal(row(carded.id).total_kg, 0, 'the stock view fields stay');
  const moved = await call(`/stok/kalemler/${carded.id}`, { method: 'PATCH', body: { colorNo: '9' } });
  assert.deepEqual([moved.status, moved.body.color_no, 'kartela' in moved.body], [200, '9', false], 'number 9 is Turuncu, not this lacivert item');
  const back = await call(`/stok/kalemler/${carded.id}`, { method: 'PATCH', body: { colorNo: '8' } });
  assert.deepEqual(back.body.kartela, { id: 'lakost_30_1', ad: '30/1 Lacoste', no: 8 });
});

test('kartela-uygula: dry run writes nothing; real run numbers exact matches only, leaves an audit trail and is idempotent', async t => {
  const f = await setup(t);
  const add = (key, name, colorName, colorNo = null, colorHex = null, legacy = null) => Number(f.db.prepare(
    'INSERT INTO stock_items(fabric_key,name,color_name,color_no,unit,color_hex,legacy_fabric_id) VALUES(?,?,?,?,?,?,?)')
    .run(key, name, colorName, colorNo, 'kg', colorHex, legacy).lastInsertRowid);
  const ids = {
    invoice: add('supren_30_1|lacivert', 'supren 30 1', 'lacivert'),
    legacyMeaning: add('sardonlu_3_iplik|nefti', 'Şardonlu 3 İplik Nefti', 'Nefti Yeşil', null, '#123456', 'k8'),
    numbered: add('lakost|beyaz', 'Lakost beyaz', 'Beyaz', '1'),
    raw: add('legacy:k9', 'Zzz Bilinmez Kumaş', 'Qqq', null, null, 'k9'),
    noCard: add('ribana_30_1|siyah', 'ribana 30 1', 'siyah'),
    shade: add('lakost|koyu_lacivert', 'lakost', 'koyu lacivert'),
    unconfirmed: add('supren_30_1|asker_yesili', 'supren 30 1', 'asker yeşili'),
    otherNo: add('polar|bordo', 'Polar bordo', 'Bordo', 'P-7'),
    clash: add('sardonsuz_3_iplik|siyah', 'sardonsuz 3 iplik', 'Lacivert'),
  };
  ids.standard = stock.createStockItem(f.db, { tur: 'polar', kartelaNo: 6, unit: 'kg' }, f.team.id).id;
  const snapshot = () => f.db.prepare('SELECT * FROM stock_items ORDER BY id').all();
  const before = snapshot();
  const run = args => spawnSync(process.execPath, [CLI, 'kartela-uygula', ...args], { env: { ...process.env, DATA_DIR: f.dir }, encoding: 'utf8' });

  const dry = run(['--kuru']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /KURU/);
  assert.match(dry.stdout, /Değişecek kalem: 3; zaten uygun: 1; eşleşmedi: 6/);
  assert.match(dry.stdout, new RegExp(`${ids.invoice}\\tsupren_30_1\\|lacivert\\tdeğişecek\\tad: "supren 30 1" → "30/1 Süprem 14 Lacivert"; renk: "lacivert" → "Lacivert"; no: — → "14"; hex: — → "#251f40"`));
  assert.deepEqual(snapshot(), before);
  assert.equal(f.db.prepare("SELECT count(*) n FROM audit_log WHERE action='kartela_uygula'").get().n, 0);

  const real = run([]);
  assert.equal(real.status, 0, real.stderr);
  assert.match(real.stdout, /Değişen kalem: 3; zaten uygun: 1; eşleşmedi: 6/);
  const line = id => real.stdout.split('\n').find(l => l.startsWith(`${id}\t`));
  for (const [id, reason] of [[ids.raw, /eşleşmedi\tham satır \(legacy\)/], [ids.noCard, /eşleşmedi\ttürün kartelası yok/],
    [ids.shade, /eşleşmedi\t30\/1 Lacoste kartelasında koyu_lacivert rengi yok/], [ids.unconfirmed, /eşleşmedi\tkartela 26 numaralı rengin adı teyit bekliyor/],
    [ids.otherNo, /eşleşmedi\tkayıtlı no P-7 tam sayı değil; 'Bordo' kartelada 12$/], [ids.clash, /eşleşmedi\trenk adı "Lacivert" anahtardaki renkle \(siyah\) aynı değil/],
    [ids.standard, /\tuygun\tPolar 6 Siyah$/], [ids.numbered, /\tdeğişti\tad: "Lakost beyaz" → "30\/1 Lacoste 1 Beyaz"; hex: — → "#ffffff"$/]])
    assert.match(line(id), reason, String(id));
  const after = Object.fromEntries(snapshot().map(r => [r.id, r]));
  const pick = r => [r.name, r.color_name, r.color_no, r.color_hex, r.fabric_key];
  assert.deepEqual(pick(after[ids.invoice]), ['30/1 Süprem 14 Lacivert', 'Lacivert', '14', '#251f40', 'supren_30_1|lacivert']);
  assert.deepEqual(pick(after[ids.legacyMeaning]), ['3 İplik Sardonlu 24 Nefti', 'Nefti', '24', '#073d22', 'sardonlu_3_iplik|nefti'], 'kartela hex replaces a typed one');
  for (const key of ['raw', 'noCard', 'shade', 'unconfirmed', 'otherNo', 'clash', 'standard'])
    assert.deepEqual(after[ids[key]], before.find(r => r.id === ids[key]), key);
  const audits = f.db.prepare("SELECT ref,user_id,detail_json d FROM audit_log WHERE action='kartela_uygula' ORDER BY id").all();
  assert.deepEqual(audits.map(a => Number(a.ref)), [ids.invoice, ids.legacyMeaning, ids.numbered]);
  assert.deepEqual(JSON.parse(audits[1].d), { kartela: 'uc_iplik', no: 24, cli: true,
    onceki: { name: 'Şardonlu 3 İplik Nefti', color_name: 'Nefti Yeşil', color_no: null, color_hex: '#123456' },
    yeni: { name: '3 İplik Sardonlu 24 Nefti', color_name: 'Nefti', color_no: '24', color_hex: '#073d22' } });
  assert.equal(audits[0].user_id, null);

  const again = run([]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /Değişen kalem: 0; zaten uygun: 4; eşleşmedi: 6/);
  assert.equal(f.db.prepare("SELECT count(*) n FROM audit_log WHERE action='kartela_uygula'").get().n, 3);
  const rows = stock.stockView(f.db);
  assert.deepEqual(rows.find(r => r.id === ids.invoice).kartela, { id: 'suprem_30_1', ad: '30/1 Süprem', no: 14 });
  assert.notEqual(run(['--fazla']).status, 0, 'unknown flag is a usage error');
});

test('kartela-uygula: a colour name on two numbers of one card has two candidates and stays unmatched', async t => {
  const f = await setup(t);
  // Invented card: the same colour name under two numbers.
  const k = kartela.loadKartela({ kartelalar: [{ id: 'deneme', ad: 'Deneme Kartela', kumaslar: { kaskorse: 'Deneme Kaşkorse' },
    renkler: [{ no: 1, renk: 'Siyah', hex: '#000000' }, { no: 2, renk: 'Haki', hex: '#3f451e' }, { no: 3, renk: 'haki', hex: '#3f451f' }] }] });
  f.db.prepare("INSERT INTO stock_items(fabric_key,name,color_name,unit) VALUES('kaskorse|haki','kaskorse','haki','kg'),('kaskorse|siyah','kaskorse','siyah','kg')").run();
  const result = kartela.applyKartela(f.db, { kartela: k });
  assert.deepEqual(result.rows.map(r => [r.fabricKey, r.durum, r.neden]), [
    ['kaskorse|haki', 'eslesmedi', 'birden çok aday: 2 Haki, 3 haki'],
    ['kaskorse|siyah', 'degisir', 'ad: "kaskorse" → "Deneme Kaşkorse 1 Siyah"; renk: "siyah" → "Siyah"; no: — → "1"; hex: — → "#000000"']]);
  assert.equal(f.db.prepare("SELECT color_no FROM stock_items WHERE fabric_key='kaskorse|haki'").get().color_no, null);
});

test('kartela data is checked at load: unknown colour name, missing source, shared type and loose type key fail loudly', () => {
  const card = extra => ({ kartelalar: [{ id: 'a', ad: 'A', kumaslar: { kaskorse: 'Kaşkorse' }, renkler: [{ no: 1, renk: 'Siyah', hex: '#000000' }], ...extra }] });
  assert.doesNotThrow(() => kartela.loadKartela(card({})));
  assert.throws(() => kartela.loadKartela(card({ renkler: [{ no: 1, renk: 'Gece Mavisi', hex: '#000000' }] })), /"Gece Mavisi" renk sözlüğünde yok/);
  assert.throws(() => kartela.loadKartela(card({ renkler: [{ no: 1, renk: 'Siyah', hex: '#000000' }, { no: 1, renk: 'Beyaz', hex: '#ffffff' }] })), /tekrarlı/);
  assert.throws(() => kartela.loadKartela(card({ renkler: [{ no: 1, renk: 'Siyah', hex: 'siyah' }] })), /hex/);
  assert.throws(() => kartela.loadKartela(card({ renkler: undefined, renklerKaynagi: 'yok' })), /renklerKaynagi yok/);
  assert.throws(() => kartela.loadKartela(card({ kumaslar: { 'Kaş Korse': 'Kaşkorse' } })), /tür biçiminde değil/);
  const twice = card({});
  twice.kartelalar.push({ ...twice.kartelalar[0], id: 'b' });
  assert.throws(() => kartela.loadKartela(twice), /kaskorse iki kartelada var/);
});

test('invoices: every card colour reads as its key; a listed shade like petrol mavi lands on the carded item', async t => {
  for (const k of DATA.kartelalar) for (const r of k.renkler || []) {
    const p = parseInvoiceDescription(`Lakost ${r.renk} 5 kg`);
    assert.deepEqual([p.colorKey, p.issues, p.unknownWords], [kartela.kartelaView().kartelalar.find(x => x.id === k.id).renkler.find(c => c.no === r.no).renkKey, [], []], r.renk);
  }
  // The key a card number opens is the key the colour name opens and an invoice reads.
  for (const k of kartela.kartelaView().kartelalar) for (const { tur } of k.kumaslar) for (const r of k.renkler)
    assert.equal(fabricKey(tur, r.renk), `${tur}|${r.renkKey}`, `${tur} ${r.renk}`);
  const colour = text => parseInvoiceDescription(text).colorKey;
  assert.deepEqual(['FUŞYA', 'turkuaz', 'Ten', 'krem', 'zümrüt yeşili', 'somon', 'TABA', 'karamel', 'fıstık yeşili', 'mint', 'zeytin', 'su yeşili',
    'petrol mavi', 'petrol yeşili', 'nar çiçeği', 'küf yeşili', 'asker yeşili', 'antrasit melanj', 'açık haki', 'açık sarı', 'açık lila', 'açık yeşil',
    'koyu kırmızı', 'koyu vizon'].map(c => colour(`30/1 süprem ${c} 5 kg`)),
  ['fusya', 'turkuaz', 'ten', 'krem', 'zumrut_yesili', 'somon', 'taba', 'karamel', 'fistik_yesili', 'mint', 'zeytin', 'su_yesili',
    'petrol_mavi', 'petrol_yesili', 'nar_cicegi', 'kuf_yesili', 'asker_yesili', 'antrasit_melanj', 'acik_haki', 'acik_sari', 'acik_lila', 'acik_yesil',
    'koyu_kirmizi', 'koyu_vizon']);

  // Matching: the listed shade is its own item; beside an open plain-colour need it stays teyit (near colour, as before).
  const petrol = matchInvoiceLine({ line: { description: 'Lakost petrol mavi 10 kg', qtyMilli: 10000, unit: 'kg' },
    openNeeds: [need(1, 'lakost|petrol_mavi', 4000), need(2, 'supren_30_1|mavi', 9000)] });
  assert.deepEqual([petrol.status, petrol.fabricKey, petrol.allocations, petrol.unallocatedMilli], ['eslesti', 'lakost|petrol_mavi', [{ orderLineId: 1, qtyMilli: 4000 }], 6000]);
  const near = matchInvoiceLine({ line: { description: 'Lakost petrol mavi 10 kg', qtyMilli: 10000, unit: 'kg' },
    openNeeds: [need(1, 'lakost|petrol_mavi', 4000), need(2, 'lakost|mavi', 9000)] });
  assert.deepEqual([near.status, near.allocations], ['teyit', []]);
  const dark = matchInvoiceLine({ line: { description: 'Lakost koyu kırmızı 5 kg', qtyMilli: 5000, unit: 'kg' }, openNeeds: [need(1, 'lakost|kirmizi', 5000)] });
  assert.equal(dark.status, 'teyit', 'koyu kırmızı is not kırmızı');

  // End to end: an item opened from the card number receives the invoice written in words.
  const f = await setup(t);
  const item = stock.createStockItem(f.db, { tur: 'lakost', kartelaNo: 3, unit: 'kg' }, f.team.id);
  const [landed] = invoices.ingest(f.db, { lines: [invoiceLine(1, 'Lakost petrol mavi 5 kg', 5)] });
  assert.equal(f.db.prepare('SELECT item_id FROM invoice_lines WHERE id=?').get(landed.id).item_id, item.id);
});

test('invoices: a shade the cards do not list ("koyu lacivert", "açık turkuaz", bare "petrol") still goes to teyit', () => {
  for (const text of ['30/1 süprem koyu lacivert 5 kg', 'Lakost açık turkuaz 5 kg']) {
    const p = parseInvoiceDescription(text);
    assert.equal(p.colorKey, null, text);
    assert.match(p.issues.map(i => i.message).join(' '), /Renk tonu sözlükte yok/, text);
  }
  const navy = matchInvoiceLine({ line: { description: '30/1 süprem koyu lacivert 5 kg', qtyMilli: 5000, unit: 'kg' }, openNeeds: [need(1, 'supren_30_1|lacivert', 5000)] });
  assert.deepEqual([navy.status, navy.allocations], ['teyit', []]);
  assert.match(navy.reasons.join(' '), /koyu lacivert/);
  const bare = matchInvoiceLine({ line: { description: 'Lakost petrol 5 kg', qtyMilli: 5000, unit: 'kg' }, openNeeds: [] });
  assert.equal(bare.status, 'teyit');
  const night = matchInvoiceLine({ line: { description: 'Lakost gece mavi 5 kg', qtyMilli: 5000, unit: 'kg' }, openNeeds: [] });
  assert.match(night.reasons.join(' '), /tanınmayan sözcük var \("gece"\)/);
});

test('kartela-uygula: a spreadsheet number "12.0" matches and is written as "12"; a real clash stays unmatched with both colours named', async t => {
  const f = await setup(t);
  const add = (key, colorName, colorNo) => Number(f.db.prepare('INSERT INTO stock_items(fabric_key,name,color_name,color_no,unit) VALUES(?,?,?,?,?)')
    .run(key, 'eski ad', colorName, colorNo, 'kg').lastInsertRowid);
  const ids = {
    float: add('sardonlu_3_iplik|bordo', 'Bordo', '12.0'),
    plain: add('polar|bordo', 'Bordo', ' 12 '),
    green: add('supren_30_1|yesil', 'Yeşil', '34.0'),
    beige: add('supren_30_1|bej', 'Bej', '22'),
    beige3: add('sardonlu_3_iplik|bej', 'Bej', '16'),
    missing: add('lakost|bordo', 'Bordo', '40'),
    half: add('sardonsuz_3_iplik|bordo', 'Bordo', '12.5'),
  };
  assert.equal(kartela.itemKartela({ fabric_key: 'sardonlu_3_iplik|bordo', color_no: '12.0' }).no, 12, 'the kartela field reads the same number');
  assert.equal(kartela.itemKartela({ fabric_key: 'sardonlu_3_iplik|bordo', color_no: 12 }).no, 12);
  for (const v of ['12.5', '12.00.0', 'on iki', '-12', '0', 12.5]) assert.equal(kartela.cardNo(v), null, String(v));
  const first = kartela.applyKartela(f.db);
  const row = id => first.rows.find(r => r.id === id);
  assert.deepEqual([row(ids.float).durum, row(ids.plain).durum], ['degisir', 'degisir']);
  assert.match(row(ids.float).neden, /no: "12\.0" → "12"/);
  assert.equal(row(ids.green).neden, "kayıtlı no 34.0 kartelada 'Nefti'; 'Yeşil' kartelada 30");
  assert.equal(row(ids.beige).neden, "kayıtlı no 22 kartelada 'Krem'; 'Bej' kartelada 16");
  assert.equal(row(ids.beige3).neden, "kayıtlı no 16 kartelada 'Ekru'; 'Bej' kartelada 36");
  assert.equal(row(ids.missing).neden, "kayıtlı no 40 kartelada yok; 'Bordo' kartelada 6");
  assert.equal(row(ids.half).neden, "kayıtlı no 12.5 tam sayı değil; 'Bordo' kartelada 12");
  const stored = id => f.db.prepare('SELECT color_no,name FROM stock_items WHERE id=?').get(id);
  assert.deepEqual(stored(ids.float), { color_no: '12', name: '3 İplik Sardonlu 12 Bordo' });
  assert.equal(stored(ids.plain).color_no, '12');
  for (const key of ['green', 'beige', 'beige3', 'missing', 'half']) assert.equal(stored(ids[key]).name, 'eski ad', key);
  const again = kartela.applyKartela(f.db);
  assert.deepEqual([again.changed, again.unchanged, again.unmatched], [0, 2, 5]);
});
