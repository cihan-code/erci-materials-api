#!/usr/bin/env node
'use strict';
// G61: shows the active print position width table, or validates and installs a replacement.
// Kullanım: node agent/siparis/tools/konum-standartlari.js [yukle <tablo.json>]   (DATA_DIR'a yazar)
const path = require('node:path');
const standards = require('../konumStandartlari');
const USAGE = 'Kullanım: node agent/siparis/tools/konum-standartlari.js [yukle <tablo.json>]';
const dataDir = () => process.env.DATA_DIR || path.join(__dirname, '../../../data');

function main(args = process.argv.slice(2), log = console.log) {
  if (args.length && (args[0] !== 'yukle' || args.length !== 2)) throw new Error(USAGE);
  if (args.length) log(`Yüklendi: ${standards.install(dataDir(), args[1])}`);
  const table = standards.load(dataDir());
  log('konum\tmin\tmax\tvarsayılan (mm)');
  const row = (name, b) => `${name}\t${b.min}\t${b.max}\t${b.varsayilan}${b.kasaMax ? `\tkasa ${b.kasaMax}` : ''}${b.dikey ? `\tdikey ${b.dikey.min}-${b.dikey.max}/${b.dikey.varsayilan}` : ''}`;
  for (const [position, b] of Object.entries(table.konumlar)) log(row(position, b));
  for (const [product, positions] of Object.entries(table.urunler || {}))
    for (const [position, b] of Object.entries(positions)) log(row(`${product}/${position}`, b));
  return table;
}
if (require.main === module) {
  try { main(); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
module.exports = { main };
