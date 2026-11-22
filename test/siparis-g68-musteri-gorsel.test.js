'use strict';
// G68: one customer picture per identical bytes. Invented data.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const areas = require('../agent/siparis/areas');
const standards = require('../agent/siparis/konumStandartlari');
const { decide, formNote } = require('../agent/siparis/olcuKarar');
const cost = require('../agent/siparis/costTransfer');
const sizes = require('../agent/siparis/boyutEsleme');

test('müşteri sayfası: aynı baytlı görsel ön ve arka olarak yüklenince bir kez gösterilir', async t => {
  process.env.PANEL_ORIGIN = 'https://panel.example.test';
  const { openDb } = require('../agent/siparis/db');
  const auth = require('../agent/siparis/auth');
  const orders = require('../agent/siparis/orders');
  const documents = require('../agent/siparis/documents');
  const musteri = require('../agent/siparis/musteriOnay');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g68-gorsel-'));
  const db = openDb(path.join(dir, 'siparis.sqlite'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  require('../agent/siparis/routes-belge')({ db, dataDir: dir }); // creates document_file_meta
  const team = await auth.createUser(db, { name: 'Örnek Ekip', password: 'synthetic-password', role: 'yonetici' });
  const order = orders.createOrder(db, { order_no: 'G68-GORSEL', customer_name: 'Örnek', lines: [{ product_key: 'tisort', quantity: 2, sizes: { M: 2 } }] }, team);
  const v = order.version, lineId = v.lines[0].id;
  const put = (name, buf, kind, gorunum) => {
    const p = path.join(dir, name); fs.writeFileSync(p, buf);
    const f = orders.addFile(db, v.id, { kind, path: p, sha256: crypto.createHash('sha256').update(buf).digest('hex') }, team);
    db.prepare('INSERT INTO document_file_meta(file_id,line_id,application_id,gorunum,mime) VALUES(?,?,?,?,?)').run(f.id, kind === 'urun_gorsel' ? lineId : null, null, gorunum, kind === 'urun_gorsel' ? 'image/png' : 'application/pdf');
    return f;
  };
  const combined = Buffer.from('synthetic combined front+back png');
  put('on.png', combined, 'urun_gorsel', 'on');
  put('arka.png', combined, 'urun_gorsel', 'arka');
  put('kol.png', Buffer.from('another picture'), 'urun_gorsel', 'kol');
  put('onay.pdf', Buffer.from('%PDF-1.4 onay'), 'onay_formu', null);
  orders.submitForApproval(db, v.id, team);
  const { link } = musteri.createLink(db, v.id, team);
  const s = musteri.summary(db, new URL(link).searchParams.get('t'));
  const images = s.urunler[0].gorseller;
  assert.equal(images.length, 2, JSON.stringify(images));
  assert.deepEqual(images.map(i => [i.gorunum, i.gorunumler]), [[null, ['on', 'arka']], ['kol', ['kol']]]);
});
