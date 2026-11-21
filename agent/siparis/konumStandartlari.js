'use strict';
// G61: usual print widths per product type and position (mm). The built-in table ships
// with the code; DATA_DIR/konum-standartlari.json (written by the CLI) replaces it.
const fs = require('fs');
const path = require('path');
const BUILT_IN = path.join(__dirname, 'konum-standartlari.json');
const FILE = 'konum-standartlari.json';

function band(value, where) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where}: nesne olmalı`);
  for (const key of ['min', 'max', 'varsayilan'])
    if (!Number.isSafeInteger(value[key]) || value[key] <= 0) throw new Error(`${where}.${key}: pozitif tam sayı (mm) olmalı`);
  if (!(value.min <= value.varsayilan && value.varsayilan <= value.max)) throw new Error(`${where}: min ≤ varsayilan ≤ max olmalı`);
  if (value.kasaMax !== undefined && (!Number.isSafeInteger(value.kasaMax) || value.kasaMax < value.max)) throw new Error(`${where}.kasaMax: max'tan küçük olmayan tam sayı olmalı`);
  const known = ['min', 'max', 'varsayilan', 'kasaMax', 'dikey'];
  const extra = Object.keys(value).filter(k => !known.includes(k));
  if (extra.length) throw new Error(`${where}: bilinmeyen alan ${extra.join(', ')}`);
  if (value.dikey !== undefined) {
    if (value.dikey.dikey !== undefined) throw new Error(`${where}.dikey: iç içe dikey olamaz`);
    band(value.dikey, `${where}.dikey`);
  }
}
function validate(table) {
  if (!table || typeof table !== 'object' || Array.isArray(table)) throw new Error('Konum standartları JSON nesnesi olmalı');
  if (!table.konumlar || typeof table.konumlar !== 'object') throw new Error('konumlar alanı gerekli');
  for (const [position, value] of Object.entries(table.konumlar)) band(value, `konumlar.${position}`);
  for (const [product, positions] of Object.entries(table.urunler || {})) {
    if (!positions || typeof positions !== 'object' || Array.isArray(positions)) throw new Error(`urunler.${product}: nesne olmalı`);
    for (const [position, value] of Object.entries(positions)) band(value, `urunler.${product}.${position}`);
  }
  return table;
}
const cache = new Map();
function readTable(file) {
  const stat = fs.statSync(file), key = `${file}:${stat.size}:${stat.mtimeMs}`;
  if (!cache.has(key)) cache.set(key, validate(JSON.parse(fs.readFileSync(file, 'utf8'))));
  return cache.get(key);
}
// A broken override must not silently fall back to the built-in widths: the caller sees the error.
function load(dataDir = process.env.DATA_DIR) {
  const override = dataDir ? path.join(dataDir, FILE) : null;
  if (override && fs.existsSync(override)) return readTable(override);
  return readTable(BUILT_IN);
}
// dikey: a sleeve print read along the arm (long text down the sleeve) has its own band.
function standardFor(table, product, position, { dikey = false } = {}) {
  const key = String(product ?? '').trim().toLowerCase();
  const own = table?.urunler?.[key]?.[position] ?? table?.konumlar?.[position];
  if (!own) return null;
  return dikey && own.dikey ? { ...own.dikey, dikey: true } : { min: own.min, max: own.max, varsayilan: own.varsayilan, ...(own.kasaMax ? { kasaMax: own.kasaMax } : {}) };
}
function install(dataDir, file) {
  const table = validate(JSON.parse(fs.readFileSync(file, 'utf8')));
  fs.mkdirSync(dataDir, { recursive: true });
  const target = path.join(dataDir, FILE), tmp = `${target}.tmp${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(table, null, 2) + '\n');
  fs.renameSync(tmp, target);
  return target;
}
module.exports = { load, validate, standardFor, install, BUILT_IN, FILE };
