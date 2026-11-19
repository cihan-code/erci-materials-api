#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { openDb, tx, audit, fail } = require('./db');
const { createUser, passwordHash } = require('./auth');
const { importLegacyFabrics } = require('./stock');
const USAGE = [
  'Kullanım: node agent/siparis/cli.js <komut>',
  '  kullanici-ekle <ad> <yonetici|ekip> [--onaysiz]',
  '  kullanici-listele',
  '  sifre-degistir <ad>            (yeni şifre stdin ya da SIPARIS_SIFRE)',
  '  kullanici-onaysiz <ad> | kullanici-onayli <ad>',
  '  eski-kumaslari-aktar [--kuru]'
].join('\n');
const dataDir = () => process.env.DATA_DIR || path.join(__dirname, '../../data');
const readPassword = () => process.env.SIPARIS_SIFRE || fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
function findUser(db, name) {
  const user = db.prepare('SELECT id,name FROM users WHERE name=?').get(String(name).trim());
  if (!user) fail(`Kullanıcı bulunamadı: ${name}`);
  return user;
}
async function main(argv = process.argv.slice(2)) {
  const [command, name, role, ...flags] = argv;
  const needsName = ['kullanici-ekle', 'sifre-degistir', 'kullanici-onaysiz', 'kullanici-onayli'];
  if (!['kullanici-listele', 'eski-kumaslari-aktar', ...needsName].includes(command) || (needsName.includes(command) && !name)) throw new Error(USAGE);
  if (command === 'kullanici-ekle' && (!['yonetici', 'ekip'].includes(role) || flags.some(f => !['--onay', '--onaysiz'].includes(f)) ||
      (flags.includes('--onay') && flags.includes('--onaysiz')))) throw new Error(USAGE);
  if (command === 'eski-kumaslari-aktar' && [name, role, ...flags].some(a => a !== undefined && a !== '--kuru')) throw new Error(USAGE);
  const dry = command === 'eski-kumaslari-aktar' && argv.includes('--kuru');
  let legacy = null;
  if (command === 'eski-kumaslari-aktar') {
    const file = path.join(dataDir(), 'stok-data.json');
    if (!fs.existsSync(file)) throw new Error(`Dosya bulunamadı: ${file}`);
    legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  const password = command === 'kullanici-ekle' || command === 'sifre-degistir' ? readPassword() : null;
  const db = openDb(path.join(dataDir(), 'siparis.sqlite'));
  try {
    if (command === 'kullanici-ekle') {
      const user = await createUser(db, { name, role, password, onayYetkisi: !flags.includes('--onaysiz') });
      console.log(`Kullanıcı eklendi: ${user.name} (${user.role})`);
    } else if (command === 'kullanici-listele') {
      for (const u of db.prepare('SELECT name,role,onay_yetkisi,created_at FROM users ORDER BY id').all())
        console.log(`${u.name}\t${u.role}\tonay:${u.onay_yetkisi ? 'evet' : 'hayır'}\t${u.created_at}`);
    } else if (command === 'sifre-degistir') {
      const encoded = await passwordHash(password);
      const closed = tx(db, () => {
        const u = findUser(db, name);
        db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(encoded, u.id);
        const n = db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id).changes;
        audit(db, u.id, 'sifre_degistir', u.id, { kapatilanOturum: n });
        return n;
      });
      console.log(`Şifre değiştirildi: ${String(name).trim()} (${closed} açık oturum kapatıldı)`);
    } else if (command === 'kullanici-onaysiz' || command === 'kullanici-onayli') {
      const on = command === 'kullanici-onayli';
      tx(db, () => {
        const u = findUser(db, name);
        db.prepare('UPDATE users SET onay_yetkisi=? WHERE id=?').run(on ? 1 : 0, u.id);
        audit(db, null, 'onay_yetkisi', u.id, { onayYetkisi: on, cli: true });
      });
      console.log(`Onay yetkisi ${on ? 'açıldı' : 'kapatıldı'}: ${String(name).trim()}`);
    } else {
      const lastItem = db.prepare('SELECT COALESCE(MAX(id),0) m FROM stock_items').get().m;
      const lastConf = db.prepare('SELECT COALESCE(MAX(id),0) m FROM confirmations').get().m;
      if (dry) db.exec('BEGIN');
      let summary;
      try {
        importLegacyFabrics(db, legacy);
        summary = {
          imported: db.prepare('SELECT COUNT(*) c FROM stock_items WHERE id>?').get(lastItem).c,
          legacyKey: db.prepare("SELECT COUNT(*) c FROM stock_items WHERE id>? AND fabric_key LIKE 'legacy:%'").get(lastItem).c,
          confirmations: db.prepare('SELECT COUNT(*) c FROM confirmations WHERE id>?').get(lastConf).c
        };
      } finally { if (dry) db.exec('ROLLBACK'); }
      console.log(`${dry ? '[KURU ÇALIŞTIRMA, hiçbir şey yazılmadı] ' : ''}Aktarılan kalem: ${summary.imported}; ` +
        `anlamlı anahtar: ${summary.imported - summary.legacyKey}; legacy: kalan: ${summary.legacyKey}; açılan teyit: ${summary.confirmations}`);
    }
  } finally { db.close(); }
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { main };
