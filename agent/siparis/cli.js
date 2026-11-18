#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { openDb } = require('./db');
const { createUser } = require('./auth');
async function main() {
  const [command, name, role, ...flags] = process.argv.slice(2);
  if (command !== 'kullanici-ekle' || !name || !['yonetici','ekip'].includes(role) || flags.some(f => f !== '--onay'))
    throw new Error('Kullanım: node agent/siparis/cli.js kullanici-ekle <ad> <yonetici|ekip> [--onay]');
  const password = process.env.SIPARIS_SIFRE || fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
  const db = openDb(path.join(process.env.DATA_DIR || path.join(__dirname, '../../data'), 'siparis.sqlite'));
  try { const user = await createUser(db, { name, role, password, onayYetkisi: flags.includes('--onay') }); console.log(`Kullanıcı eklendi: ${user.name} (${user.role})`); }
  finally { db.close(); }
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { main };
