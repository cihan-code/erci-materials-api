// Yonetim Ajani cikti deposu.
// server.js hem de agent/generate.js buradaki fonksiyonlari kullanir ki kayit/okuma
// mantigi tek yerde dursun. Panel is verisi (panel-data.json) gibi, DATA_DIR altinda
// duz JSON dosyalari; ajan SADECE kendi kovasina yazar, /api/paneldata'ya dokunmaz.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const AGENT_DIR = path.join(DATA_DIR, 'agent');
const OUTPUTS_DIR = path.join(AGENT_DIR, 'outputs');
const INDEX_FILE = path.join(AGENT_DIR, 'index.json');
const STATUS_FILE = path.join(AGENT_DIR, 'status.json');

// Panel verisi bu dosyada (server.js ile ayni yol). Ajan bunu SALT-OKUNUR kullanir.
const PANEL_DATA_FILE = path.join(DATA_DIR, 'panel-data.json');

const OUTPUT_TYPES = [
  'gunluk-brifing',
  'uretim-risk',
  'satis-takip',
  'finans',
  'haftalik-review',
  'aylik-rapor',
];

const TYPE_LABELS = {
  'gunluk-brifing': 'Gunluk Brifing',
  'uretim-risk': 'Uretim Risk',
  'satis-takip': 'Satis Takip',
  'finans': 'Finans / Nakit',
  'haftalik-review': 'Haftalik Review',
  'aylik-rapor': 'Aylik Rapor',
};

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function ensureAgentDirs() { ensureDir(OUTPUTS_DIR); }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
}
function writeJsonAtomic(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp-' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function loadIndex() {
  const idx = readJson(INDEX_FILE, null);
  return Array.isArray(idx) ? idx : [];
}
function saveIndex(list) { writeJsonAtomic(INDEX_FILE, list); }

// Panel is verisini diskten oku (HTTP roundtrip yok). { data, updatedAt } dondurur.
function loadPanelData() {
  const raw = readJson(PANEL_DATA_FILE, null);
  if (!raw || !raw.data) return { data: null, updatedAt: null };
  return { data: raw.data, updatedAt: raw.updatedAt || null };
}

// Bir ajan ciktisini kaydet. meta = { dataConfidence, panelUpdatedAt, model, tokensIn, ... }
function saveAgentOutput({ type, title, date, markdown, meta }) {
  ensureAgentDirs();
  if (!OUTPUT_TYPES.includes(type)) throw new Error('Gecersiz cikti tipi: ' + type);
  if (!markdown || !String(markdown).trim()) throw new Error('markdown alani bos.');

  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const id = stamp + '_' + crypto.randomBytes(4).toString('hex');
  const record = {
    id,
    type,
    title: title || (TYPE_LABELS[type] + ' - ' + (date || now.toISOString().slice(0, 10))),
    date: date || now.toISOString().slice(0, 10),
    createdAt: now.toISOString(),
    markdown: String(markdown),
    meta: meta || {},
  };
  writeJsonAtomic(path.join(OUTPUTS_DIR, id + '.json'), record);

  const index = loadIndex();
  index.unshift({
    id: record.id,
    type: record.type,
    title: record.title,
    date: record.date,
    createdAt: record.createdAt,
    meta: record.meta,
  });
  // Cok sismesin diye indeksi 500 kayitla sinirla (dosyalar diskte kalir).
  saveIndex(index.slice(0, 500));
  return record;
}

function listOutputs({ type, limit } = {}) {
  let index = loadIndex();
  if (type) index = index.filter((r) => r.type === type);
  const n = Math.max(1, Math.min(200, parseInt(limit, 10) || 30));
  return index.slice(0, n);
}

function getOutput(id) {
  if (!id || /[^A-Za-z0-9_\-]/.test(id)) return null;
  return readJson(path.join(OUTPUTS_DIR, id + '.json'), null);
}

function getLatest(type) {
  const index = loadIndex();
  const hit = index.find((r) => !type || r.type === type);
  if (!hit) return null;
  return getOutput(hit.id);
}

function readStatus() {
  return readJson(STATUS_FILE, { running: false, type: null, startedAt: null, finishedAt: null, lastError: null });
}
function writeStatus(patch) {
  const cur = readStatus();
  const next = Object.assign({}, cur, patch);
  writeJsonAtomic(STATUS_FILE, next);
  return next;
}

module.exports = {
  DATA_DIR, AGENT_DIR, OUTPUTS_DIR, PANEL_DATA_FILE,
  OUTPUT_TYPES, TYPE_LABELS,
  ensureAgentDirs, loadPanelData,
  saveAgentOutput, listOutputs, getOutput, getLatest,
  readStatus, writeStatus,
};
