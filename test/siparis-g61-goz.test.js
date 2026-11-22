'use strict';
// G61 "göz": a fake provider (no network) stands for the vision model. Invented mockups only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const goz = require('../agent/siparis/goz');
const { decide } = require('../agent/siparis/olcuKarar');
const documents = require('../agent/siparis/documents');
const { setup } = require('./fixtures/siparis/belge-fixture');
const { mockup } = require('./fixtures/siparis/oto-mockup');
const { multiMockup } = require('./fixtures/siparis/oto-multi');

const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.data)); return r.data; };
function useEye(t, answer) {
  const calls = [];
  const before = { GOZ_OLCU: process.env.GOZ_OLCU };
  process.env.GOZ_OLCU = '1';
  goz.setTestProvider(async (img, req) => { calls.push({ img: { width: img.width, height: img.height, mime: img.mime }, req }); return typeof answer === 'function' ? answer(img, req) : { answer }; });
  t.after(() => { goz.setTestProvider(null); if (before.GOZ_OLCU === undefined) delete process.env.GOZ_OLCU; else process.env.GOZ_OLCU = before.GOZ_OLCU; });
  return calls;
}
async function fixture(t, { product = 'tisort', L = { omuzdan_boy: 112.2, etek: 60 }, flatImage = mockup({ missing: true }).image } = {}) {
  const f = await setup();
  t.after(async () => { await documents.settled(); await f.close(); fs.rmSync(f.dir, { recursive: true, force: true }); });
  const root = path.join(fs.realpathSync(f.dir), 'siparis', 'flats'); fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, `${product}.png`); fs.writeFileSync(file, flatImage);
  f.db.prepare('INSERT INTO document_flats(id,ad,urun,gorunum,dosya,refLengthCm,refLengthPx,refBeden,olculerL) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(`${product}-l`, `Sentetik ${product}`, product, 'on', file, 60, 300, 'L', JSON.stringify(L));
  return f;
}
// The mockup's chest print is 120 x 67.5 px at (240, 265) on a 600 x 650 picture; 2 mm per px.
const chestAnswer = { urunler: [{ kutu: { x: 60, y: 45, w: 480, h: 560 }, gorunum: 'on', tur: 'tişört' }],
  baskilar: [{ konum: 'gogus', urun: 0, kutu: { x: 232, y: 258, w: 136, h: 82 }, aciklama: 'logo', guven: 'yuksek' }] };

test('G61 off (no GOZ_OLCU) the measurement is the old one: no call, no cache, no eye in the record', async t => {
  const calls = []; goz.setTestProvider(async () => { calls.push(1); return { answer: chestAnswer }; });
  t.after(() => goz.setTestProvider(null));
  delete process.env.GOZ_OLCU;
  const f = await fixture(t), o = await f.order(), v = o.version.id, line = o.version.lines[0].id;
  ok(await f.upload(v, { kind: 'urun_gorsel', lineId: line, gorunum: 'on', buffer: mockup().image }), 201);
  const app = ok(await f.post(`/satirlar/${line}/uygulamalar`, { kind: 'baski', position: 'gogus' }), 201);
  assert.equal(calls.length, 0);
  assert.equal(JSON.parse(app.measure_source).goz, undefined);
  assert.equal(f.db.prepare('SELECT count(*) n FROM goz_cache').get().n, 0);
  goz.setTestProvider(null);
  assert.equal(goz.provider({ GOZ_OLCU: '1' }), null); // no key, no provider: the old path
  assert.equal(goz.provider({ GOZ_OLCU: '1', ANTHROPIC_API_KEY: 'x' }), 'api');
  assert.equal(goz.provider({ GOZ_OLCU: '1', GOZ_SAGLAYICI: 'cli', NODE_ENV: 'production' }), null);
});

test('G61 the eye locates the whole print, the ink fixes its edges, the code sizes it; one call per picture', async t => {
  const calls = useEye(t, chestAnswer);
  const f = await fixture(t), o = await f.order(), v = o.version.id, line = o.version.lines[0].id;
  ok(await f.upload(v, { kind: 'urun_gorsel', lineId: line, gorunum: 'on', buffer: mockup().image }), 201);
  const app = ok(await f.post(`/satirlar/${line}/uygulamalar`, { kind: 'baski', position: 'gogus' }), 201);
  const s = JSON.parse(app.measure_source);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].req.positions, [...goz.POSITIONS].sort());
  assert.deepEqual([calls[0].img.width, calls[0].img.height, calls[0].img.mime], [600, 650, 'image/jpeg']);
  // The loose 136 x 82 px box snapped to the ink: 120 px wide -> 240 mm, as the pixel path.
  assert.equal(s.goz.boxPx.fit, 'murekkep');
  assert.ok(Math.abs(s.goz.boxPx.w - 120) <= 2, JSON.stringify(s.goz));
  assert.deepEqual([app.width_mm, app.needs_confirmation, s.olcuDurumu, s.olcuKaynagi], [240, 0, 'otomatik', 'görselden (göz)']);
  assert.ok(s.gozPikselFarki <= .1);
  // Measuring again, and a print added later on the same picture, make no second call.
  ok(await f.post(`/surumler/${v}/otomatik-olc?yeniden=1`, {}));
  ok(await f.post(`/satirlar/${line}/uygulamalar`, { kind: 'baski', position: 'sirt' }), 201);
  assert.equal(calls.length, 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM goz_cache').get().n, 1);
});

test('G61 a failing or malformed eye answer silently leaves the pixel path and records why', async t => {
  let mode = 'error';
  useEye(t, () => { if (mode === 'error') throw new Error('zaman aşımı'); return { answer: { urunler: 'bozuk' } }; });
  const f = await fixture(t), o = await f.order(), v = o.version.id, line = o.version.lines[0].id;
  ok(await f.upload(v, { kind: 'urun_gorsel', lineId: line, gorunum: 'on', buffer: mockup().image }), 201);
  const app = ok(await f.post(`/satirlar/${line}/uygulamalar`, { kind: 'baski', position: 'gogus' }), 201);
  const s = JSON.parse(app.measure_source);
  assert.equal(app.width_mm, 240);
  assert.equal(s.olcuKaynagi, 'görselden (piksel)');
  assert.match(s.goz.reason, /Göz çalışmadı, piksel yolu kullanıldı: zaman aşımı/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM goz_cache').get().n, 0);
  // Malformed JSON: the same fallback (a fresh request: another position on the line).
  mode = 'bozuk'; goz.setTestProvider(async () => ({ answer: { urunler: 'bozuk' } }));
  const second = ok(await f.post(`/satirlar/${line}/uygulamalar`, { kind: 'baski', position: 'sol_gogus' }), 201);
  assert.match(JSON.parse(second.measure_source).goz?.reason || '', /beklenen biçimde değil/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM goz_cache').get().n, 0);
});

test('G61 the eye seeing no print at the position is the one remaining confirmation', async t => {
  useEye(t, { urunler: chestAnswer.urunler, baskilar: [] });
  const f = await fixture(t), o = await f.order(), v = o.version.id, line = o.version.lines[0].id;
  ok(await f.upload(v, { kind: 'urun_gorsel', lineId: line, gorunum: 'on', buffer: mockup().image }), 201);
  const app = ok(await f.post(`/satirlar/${line}/uygulamalar`, { kind: 'baski', position: 'gogus' }), 201);
  assert.deepEqual([app.width_mm, app.needs_confirmation], [null, 1]);
  const c = f.db.prepare("SELECT message FROM confirmations WHERE kind='olcu' AND ref_id=? AND status='acik'").get(app.id);
  assert.match(c.message, /Göz bu konumda baskı görmedi/);
});

test('G61 the eye decides front/back; the user answer wins and a disagreement stays visible as ≈', async t => {
  // The eye says the RIGHT garment is the front (the default would have taken the left one).
  const answer = { urunler: [{ kutu: { x: 30, y: 40, w: 500, h: 560 }, gorunum: 'arka', tur: 'sweat' }, { kutu: { x: 570, y: 40, w: 500, h: 560 }, gorunum: 'on', tur: 'sweat' }],
    baskilar: [{ konum: 'sirt', urun: 0, kutu: { x: 180, y: 200, w: 240, h: 150 }, aciklama: 'sırt yazısı', guven: 'orta' }] };
  useEye(t, answer);
  const L = { omuzdan_boy: 71, etek: 52, gogus: 61, tum_omuz: 61.5 };
  const f = await fixture(t, { product: 'sweat', L, flatImage: multiMockup({ missing: true }).image });
  const o = await f.order({ lines: [{ product_key: 'sweat', quantity: 1, sizes: { L: 1 } }] }), v = o.version.id, line = o.version.lines[0].id;
  const picture = multiMockup({ ambiguous: true }).image;
  for (const gorunum of ['on', 'arka']) ok(await f.upload(v, { kind: 'urun_gorsel', lineId: line, gorunum, buffer: picture }), 201);
  const app = ok(await f.post(`/satirlar/${line}/uygulamalar`, { kind: 'baski', position: 'sirt' }), 201);
  const s = JSON.parse(app.measure_source);
  assert.deepEqual(s.viewHint, { front: 'sag', source: 'goz' });
  assert.ok(s.views.find(g => g.view === 'on').productBoxPx.x > s.views.find(g => g.view === 'arka').productBoxPx.x);
  // A person answers "left is the front": that answer is used, the eye's disagreement is noted.
  const c = f.db.prepare("INSERT INTO confirmations(kind,ref_table,ref_id,message) VALUES('olcu','applications',?,'Ön/arka teyit edilmeli')").run(app.id).lastInsertRowid;
  ok(await f.post(`/teyitler/${c}/coz`, { onUrun: 'sol' }));
  const after = JSON.parse(f.db.prepare('SELECT measure_source FROM applications WHERE id=?').get(app.id).measure_source);
  assert.deepEqual(after.viewHint, { front: 'sol', source: 'kullanici' });
  assert.ok(after.notlar.some(n => /kullanıcı cevabı kullanıldı/.test(n)), JSON.stringify(after.notlar));
  assert.notEqual(after.olcuDurumu, 'otomatik');
});

test('G61 eye and pixel widths more than 10% apart: the eye box is kept, marked approximate', () => {
  const views = [{ page: 1, view: 'on' }];
  const base = { width_mm: 26, height_mm: 83, reasons: [], measure_source: { method: 'otomatik', views, goz: { width_mm: 80, height_mm: 95, boxPx: { w: 40, h: 47 } } } };
  const r = decide(base, { position: 'sol_gogus' });
  assert.deepEqual([r.width_mm, r.height_mm, r.measure_source.olcuDurumu, r.measure_source.olcuKaynagi], [80, 95, 'yaklasik', 'görselden (göz)']);
  assert.match(r.measure_source.olcuNotu, /göz kutusu esas alındı/);
  const close = decide({ ...base, width_mm: 77 }, { position: 'sol_gogus' });
  assert.equal(close.measure_source.olcuDurumu, 'otomatik');
});

test('G61 eye answers: boxes are normalised and checked, several prints at one ordered position merge', () => {
  const n = goz.normalize({ urunler: [{ kutu: { x: 0, y: 0, w: 100, h: 200 }, gorunum: 'on', tur: 't' }],
    baskilar: [{ konum: 'sirt', urun: 0, kutu: { x: 10, y: 10, w: 20, h: 10 }, aciklama: 'logo', guven: 'yuksek' },
      { konum: 'sirt', urun: 0, kutu: { x: 10, y: 40, w: 30, h: 20 }, aciklama: 'numara', guven: 'orta' },
      { konum: 'sirt', urun: 7, kutu: { x: 0, y: 0, w: -1, h: 5 }, aciklama: 'bozuk', guven: 'x' }] }, { width: 100, height: 200 });
  assert.equal(n.baskilar.length, 2);
  const one = goz.forPrint(n, 'sirt', 1), round = b => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, Math.round(v * 1000) / 1000]));
  assert.deepEqual(round(one.print.box), { x: .1, y: .05, w: .3, h: .25 });
  // G61b: as many prints as ordered pair top to bottom (approximate); otherwise one group box.
  const [top, bottom] = [0, 1].map(rank => goz.forPrint(n, 'sirt', 2, rank).print);
  assert.ok(top.box.y < bottom.box.y && /yukarıdan aşağı/.test(top.pairing));
  assert.match(goz.forPrint(n, 'sirt', 3).print.pairing, /tek grup kutusu/);
  assert.ok(goz.forPrint(n, 'gogus', 1).baskiYok);
  assert.throws(() => goz.normalize({ urunler: [{ kutu: null }], baskilar: [] }, { width: 1, height: 1 }));
  assert.equal(goz.frontSide({ urunler: [{ box: { x: .6, y: 0, w: .3, h: 1 }, view: 'on' }, { box: { x: 0, y: 0, w: .3, h: 1 }, view: 'arka' }] }), 'sag');
});
