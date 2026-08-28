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
const USAGE_LOG = path.join(AGENT_DIR, 'usage-log.jsonl');

// Panel verisi bu dosyada (server.js ile ayni yol). Ajan raporlar icin SALT-OKUNUR;
// yalnizca dar aksiyon fonksiyonlari (agent/actions.js) writePanelData ile guncel bir
// alani degistirir - o da yedek alarak.
const PANEL_DATA_FILE = path.join(DATA_DIR, 'panel-data.json');
const PANEL_BACKUPS_DIR = path.join(DATA_DIR, 'paneldata-backups');

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

// Tam ham dosya ({ data, auth, updatedAt }). Aksiyon fonksiyonlari icin.
function readPanelRaw() {
  return readJson(PANEL_DATA_FILE, null);
}

// server.js'deki backupCurrentPanelData ile ayni desen - aksiyonlar da yedek biraksin.
function backupPanelData() {
  try {
    if (!fs.existsSync(PANEL_DATA_FILE)) return;
    ensureDir(PANEL_BACKUPS_DIR);
    const raw = fs.readFileSync(PANEL_DATA_FILE, 'utf8');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(PANEL_BACKUPS_DIR, 'panel-data-' + stamp + '.json'), raw);
    const files = fs.readdirSync(PANEL_BACKUPS_DIR).filter((f) => f.endsWith('.json')).sort();
    if (files.length > 200) {
      files.slice(0, files.length - 200).forEach((f) => {
        try { fs.unlinkSync(path.join(PANEL_BACKUPS_DIR, f)); } catch (e) {}
      });
    }
  } catch (e) { /* yedek basarisiz olsa da yazma devam etsin */ }
}

// Panel verisini geri yaz. expectedUpdatedAt verilirse ve diskteki farkliysa 409 firlatir
// (panelin kendi optimistic-concurrency mantigiyla ayni). auth alanina dokunmaz.
function writePanelData(newData, expectedUpdatedAt) {
  const cur = readPanelRaw();
  if (!cur || !cur.data) throw new Error('panel-data.json yok - once panelden veri kaydedilmeli.');
  if (expectedUpdatedAt != null && cur.updatedAt !== expectedUpdatedAt) {
    const err = new Error('Cakisma: panel verisi bu arada baska yerden guncellenmis.');
    err.code = 'CONFLICT';
    throw err;
  }
  backupPanelData();
  const payload = { data: newData, auth: cur.auth || null, updatedAt: new Date().toISOString() };
  // server.js ile ayni bicim (kompakt) - dosya boyutu ikiye katlanmasin.
  ensureDir(path.dirname(PANEL_DATA_FILE));
  const tmp = PANEL_DATA_FILE + '.tmp-' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, PANEL_DATA_FILE);
  return payload.updatedAt;
}

// ---- API cagri maliyet gunlugu (her Anthropic cagrisi) ----
// JSONL: her satir bir cagri. { ts, opType, model, inputTokens, outputTokens, costUsd, stopReason }
function logUsage(entry) {
  try {
    ensureAgentDirs();
    fs.appendFileSync(USAGE_LOG, JSON.stringify(Object.assign({ ts: new Date().toISOString() }, entry)) + '\n');
  } catch (e) { console.error('[store.logUsage] yazilamadi:', e && e.message); }
}

function readUsage({ limit = 100 } = {}) {
  let lines = [];
  try { lines = fs.readFileSync(USAGE_LOG, 'utf8').split('\n').filter(Boolean); }
  catch (e) { return { entries: [], summary: emptyUsageSummary() }; }
  const all = lines.map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);

  const now = Date.now();
  const windows = { today: 0, d7: 7 * 864e5, d30: 30 * 864e5 };
  const summary = emptyUsageSummary();
  const todayStr = new Date().toISOString().slice(0, 10);
  all.forEach((e) => {
    const age = now - new Date(e.ts).getTime();
    const buckets = [];
    if (String(e.ts).slice(0, 10) === todayStr) buckets.push('today');
    if (age <= windows.d7) buckets.push('d7');
    if (age <= windows.d30) buckets.push('d30');
    buckets.forEach((b) => {
      summary[b].calls += 1;
      summary[b].inputTokens += e.inputTokens || 0;
      summary[b].outputTokens += e.outputTokens || 0;
      summary[b].costUsd += e.costUsd || 0;
      const bm = summary[b].byModel[e.model] = summary[b].byModel[e.model] || { calls: 0, costUsd: 0 };
      bm.calls += 1; bm.costUsd += e.costUsd || 0;
      const bo = summary[b].byOp[e.opType] = summary[b].byOp[e.opType] || { calls: 0, costUsd: 0 };
      bo.calls += 1; bo.costUsd += e.costUsd || 0;
    });
  });
  ['today', 'd7', 'd30'].forEach((b) => {
    summary[b].costUsd = Math.round(summary[b].costUsd * 10000) / 10000;
    Object.values(summary[b].byModel).forEach((x) => { x.costUsd = Math.round(x.costUsd * 10000) / 10000; });
    Object.values(summary[b].byOp).forEach((x) => { x.costUsd = Math.round(x.costUsd * 10000) / 10000; });
  });
  return { entries: all.slice(-limit).reverse(), summary, totalCalls: all.length };
}
function emptyUsageSummary() {
  const z = () => ({ calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, byModel: {}, byOp: {} });
  return { today: z(), d7: z(), d30: z() };
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
  ensureAgentDirs, loadPanelData, readPanelRaw, writePanelData,
  saveAgentOutput, listOutputs, getOutput, getLatest,
  readStatus, writeStatus,
  logUsage, readUsage,
};
