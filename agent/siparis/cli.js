#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const { openDb, tx, audit, fail } = require('./db');
const { createUser, passwordHash } = require('./auth');
const { importLegacyFabrics } = require('./stock');
const { applyKartela } = require('./kartela');
const USAGE = [
  'Kullanım: node agent/siparis/cli.js <komut>',
  '  kullanici-ekle <ad> <yonetici|ekip> [--onaysiz]',
  '  kullanici-listele',
  '  sifre-degistir <ad>            (terminalde gizli giriş; pipe/stdin ya da SIPARIS_SIFRE)',
  '  kullanici-onaysiz <ad> | kullanici-onayli <ad>',
  '  eski-kumaslari-aktar [--kuru]',
  '  kartela-uygula [--kuru]         (kartelalı kalemlere renk no, hex ve standart ad yazar)',
  '  kalip-l-tamamla <L-listesi.json> [--kuru]  (kalıpların yalnız boş refBeden/olculerL alanlarını doldurur)',
  '  kalip-beden-tamamla <kaynakli-tablolar.json> [--kuru]  (yalnız boş bedenTablosu alanlarını doldurur)',
  '  onay-zinciri --kuru <surumId>  (onayda açılacak İşler kaydını ve takip kartını JSON gösterir, yazmaz)'
].join('\n');
const dataDir = () => process.env.DATA_DIR || path.join(__dirname, '../../data');
async function readPassword() {
  if (!process.stdin.isTTY) return process.env.SIPARIS_SIFRE || fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
  const input = process.stdin, output = process.stderr;
  const wasRaw = input.isRaw, wasFlowing = input.readableFlowing === true;
  const decoder = new StringDecoder('utf8');
  let line = '', first, skipLf = false;
  const interrupted = () => Object.assign(new Error('Şifre girişi iptal edildi'), { exitCode: 130 });
  let onData, onEnd, onError;
  const signals = new Map();
  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, password) => {
        if (settled) return;
        settled = true;
        error ? reject(error) : resolve(password);
      };
      onError = error => finish(error);
      onEnd = () => finish(new Error('Şifre girişi tamamlanmadı'));
      onData = chunk => {
        for (const char of decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) {
          if (settled) break;
          if (char === '\u0003') { finish(interrupted()); break; }
          if (char === '\u0004') { onEnd(); break; }
          if (char === '\n' && skipLf) { skipLf = false; continue; }
          skipLf = char === '\r';
          if (char === '\r' || char === '\n') {
            output.write('\n');
            if (first === undefined) {
              first = line;
              line = '';
              output.write('Şifre (tekrar): ');
            } else if (line !== first) finish(new Error('Şifreler uyuşmuyor'));
            else finish(null, first);
          } else if (char === '\u007f' || char === '\b') {
            line = Array.from(line).slice(0, -1).join('');
          } else if (char >= ' ' && char !== '\u007f') {
            line += char;
            if (line.length > 1024) finish(new Error('Şifre 8–1024 karakter olmalı'));
          }
        }
      };
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        const handler = () => finish(Object.assign(new Error('Şifre girişi iptal edildi'), {
          exitCode: signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 129
        }));
        signals.set(signal, handler);
        process.on(signal, handler);
      }
      input.on('data', onData);
      input.on('end', onEnd);
      input.on('error', onError);
      input.setRawMode(true); // Raw TTY mode also disables terminal echo.
      output.write('Şifre: ');
      input.resume();
    });
  } finally {
    input.removeListener('data', onData);
    input.removeListener('end', onEnd);
    input.removeListener('error', onError);
    for (const [signal, handler] of signals) process.removeListener(signal, handler);
    input.setRawMode(Boolean(wasRaw));
    if (!wasFlowing) input.pause();
    output.write('\n');
  }
}
function findUser(db, name) {
  const user = db.prepare('SELECT id,name FROM users WHERE name=?').get(String(name).trim());
  if (!user) fail(`Kullanıcı bulunamadı: ${name}`);
  return user;
}
// The L list stays outside the public repository; only empty fields are filled.
function fillFlatsL(args, method = 'fillMissingL') {
  const files = args.filter(a => a !== '--kuru');
  if (files.length !== 1 || args.length > 2 || files[0].startsWith('--')) throw new Error(USAGE);
  const records = JSON.parse(fs.readFileSync(files[0], 'utf8')), dry = args.includes('--kuru');
  const db = openDb(path.join(dataDir(), 'siparis.sqlite'));
  try {
    require('./flats').init(db);
    const result = require('./flats')[method](db, records, { dry });
    if (dry) console.log('[KURU ÇALIŞTIRMA, hiçbir şey yazılmadı]');
    const label = { dolduruldu: dry ? 'doldurulacak' : 'dolduruldu', tam: 'zaten tam', atlandi: 'atlandı' };
    console.log('kalıp\tdurum\tayrıntı');
    for (const r of result.rows) console.log(`${r.ad}\t${label[r.durum]}\t${r.alanlar.join(', ') || r.neden || ''}`);
    for (const ad of result.unused) console.log(`${ad}\tatlandı\tkütüphanede bu adla kalıp yok`);
    console.log(`${dry ? 'Doldurulacak' : 'Doldurulan'} kalıp: ${result.filled}`);
    return result;
  } finally { db.close(); }
}
// G63 dry run only: the chain itself runs in the server's queue. Opens the database read-only so nothing can be written.
function chainDryRun(args) {
  const ids = args.filter(a => a !== '--kuru');
  if (!args.includes('--kuru') || ids.length !== 1 || args.length !== 2 || !/^\d+$/.test(ids[0])) throw new Error(USAGE);
  const Database = require('better-sqlite3');
  const file = path.join(dataDir(), 'siparis.sqlite');
  if (!fs.existsSync(file)) throw new Error(`Dosya bulunamadı: ${file}`);
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const result = require('./onayZinciri').dryRun(db, Number(ids[0]), { panel: require('../store').readPanelRaw() });
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally { db.close(); }
}
async function main(argv = process.argv.slice(2)) {
  const [command, name, role, ...flags] = argv;
  if (command === 'onay-zinciri') return chainDryRun(argv.slice(1));
  if (command === 'kalip-l-tamamla') return fillFlatsL(argv.slice(1));
  if (command === 'kalip-beden-tamamla') return fillFlatsL(argv.slice(1), 'fillMissingSizeCharts');
  const needsName = ['kullanici-ekle', 'sifre-degistir', 'kullanici-onaysiz', 'kullanici-onayli'];
  const dryCapable = ['eski-kumaslari-aktar', 'kartela-uygula'];
  if (!['kullanici-listele', ...dryCapable, ...needsName].includes(command) || (needsName.includes(command) && !name)) throw new Error(USAGE);
  if (command === 'kullanici-ekle' && (!['yonetici', 'ekip'].includes(role) || flags.some(f => !['--onay', '--onaysiz'].includes(f)) ||
      (flags.includes('--onay') && flags.includes('--onaysiz')))) throw new Error(USAGE);
  if (dryCapable.includes(command) && [name, role, ...flags].some(a => a !== undefined && a !== '--kuru')) throw new Error(USAGE);
  const dry = dryCapable.includes(command) && argv.includes('--kuru');
  let legacy = null;
  if (command === 'eski-kumaslari-aktar') {
    const file = path.join(dataDir(), 'stok-data.json');
    if (!fs.existsSync(file)) throw new Error(`Dosya bulunamadı: ${file}`);
    legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  const password = command === 'kullanici-ekle' || command === 'sifre-degistir' ? await readPassword() : null;
  if (password !== null && (password.length < 8 || password.length > 1024)) throw new Error('Şifre 8–1024 karakter olmalı');
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
    } else if (command === 'kartela-uygula') {
      const result = applyKartela(db, { dry });
      const label = { degisir: dry ? 'değişecek' : 'değişti', uygun: 'uygun', eslesmedi: 'eşleşmedi' };
      if (dry) console.log('[KURU ÇALIŞTIRMA, hiçbir şey yazılmadı]');
      console.log('id\tanahtar\tdurum\tayrıntı');
      for (const r of result.rows) console.log(`${r.id}\t${r.fabricKey}\t${label[r.durum]}\t${r.neden || r.name}`);
      console.log(`${dry ? 'Değişecek' : 'Değişen'} kalem: ${result.changed}; zaten uygun: ${result.unchanged}; eşleşmedi: ${result.unmatched}`);
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
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = e.exitCode || 1; });
module.exports = { main };
