'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');
const { openDb } = require('../agent/siparis/db');

const CLI = path.join(__dirname, '../agent/siparis/cli.js');
const run = (dir, args, input = '', env = {}) => spawnSync(process.execPath, [CLI, ...args],
  { env: { ...process.env, DATA_DIR: dir, SIPARIS_SIFRE: '', ...env }, input, encoding: 'utf8' });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'siparis-cli-'));
const query = (dir, sql) => { const db = openDb(path.join(dir, 'siparis.sqlite')); try { return db.prepare(sql).all(); } finally { db.close(); } };

test('kullanici ekle, listele, onay yetkisi ve sifre degistir', () => {
  const dir = tmp();
  assert.equal(run(dir, ['kullanici-ekle', 'Deneme Bir', 'ekip'], 'gizli-sifre-1\n').status, 0);
  const list = run(dir, ['kullanici-listele']);
  assert.match(list.stdout, /Deneme Bir\tekip\tonay:evet\t/);
  assert.doesNotMatch(list.stdout, /scrypt/);
  assert.equal(run(dir, ['kullanici-onaysiz', 'Deneme Bir']).status, 0);
  assert.match(run(dir, ['kullanici-listele']).stdout, /onay:hayır/);
  assert.equal(run(dir, ['kullanici-onayli', 'Deneme Bir']).status, 0);
  assert.match(run(dir, ['kullanici-listele']).stdout, /onay:evet/);
  assert.equal(query(dir, "SELECT * FROM audit_log WHERE action='onay_yetkisi'").length, 2);
  assert.notEqual(run(dir, ['kullanici-onaysiz', 'Yok Kimse']).status, 0);

  const db = openDb(path.join(dir, 'siparis.sqlite'));
  const u = db.prepare("SELECT id,password_hash FROM users").get();
  db.prepare("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES(?,?,?)").run(u.id, 'tok', '2999-01-01T00:00:00Z');
  db.close();
  assert.equal(run(dir, ['sifre-degistir', 'Deneme Bir'], '', { SIPARIS_SIFRE: 'yeni-sifre-22' }).status, 0);
  assert.equal(query(dir, 'SELECT * FROM sessions').length, 0);
  assert.notEqual(query(dir, 'SELECT password_hash h FROM users')[0].h, u.password_hash);
  assert.equal(query(dir, "SELECT * FROM audit_log WHERE action='sifre_degistir'").length, 1);
});

test('eski kumaslari aktar: dosya yok, kuru calistirma, gercek ve ikinci calistirma', () => {
  const dir = tmp();
  const missing = run(dir, ['eski-kumaslari-aktar']);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /stok-data\.json/);

  fs.writeFileSync(path.join(dir, 'stok-data.json'), JSON.stringify({ data: { fabrics: [
    { id: 'k1', name: 'Zzz Bilinmez Kumaş', colorName: 'Qqq', unit: 'm' },
    { id: 'k2', name: 'Xxx Garip', unit: 'm' }
  ], openingBalances: [{ fabricId: 'k1', quantity: 50 }] } }));
  const dry = run(dir, ['eski-kumaslari-aktar', '--kuru']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /KURU/);
  assert.match(dry.stdout, /Aktarılan kalem: 2;.*legacy: kalan: 2; açılan teyit: 2/);
  assert.equal(query(dir, 'SELECT * FROM stock_items').length, 0);
  assert.equal(query(dir, 'SELECT * FROM confirmations').length, 0);

  const real = run(dir, ['eski-kumaslari-aktar']);
  assert.equal(real.status, 0, real.stderr);
  assert.match(real.stdout, /Aktarılan kalem: 2;/);
  assert.equal(query(dir, 'SELECT * FROM stock_items').length, 2);
  assert.equal(query(dir, 'SELECT * FROM stock_movements').length, 0);
  const again = run(dir, ['eski-kumaslari-aktar']);
  assert.match(again.stdout, /Aktarılan kalem: 0;/);
  assert.equal(query(dir, 'SELECT * FROM stock_items').length, 2);
});
