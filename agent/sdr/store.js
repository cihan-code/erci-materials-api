// Satis Ajani (SDR) deposu: arastirma loglari + status + gunluk arastirma sayaci.
// panel-data.json'a DOKUNMAZ (leads[] oraya sdr/leads.js yazar). Kendi kovasi.

const fs = require('fs');
const path = require('path');
const { jsonIndexStore } = require('../lib/jsonIndexStore');
const { istanbulDay } = require('../lib/util');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const SDR_DIR = path.join(DATA_DIR, 'sdr');
const RESEARCH_DIR = path.join(SDR_DIR, 'research');
const STATUS_FILE = path.join(SDR_DIR, 'status.json');

// Gunluk arastirma limiti (maliyet korumasi). Render env: SDR_DAILY_RESEARCH_CAP.
const DAILY_CAP = parseInt(process.env.SDR_DAILY_RESEARCH_CAP, 10) || 6;

const research = jsonIndexStore(RESEARCH_DIR, {
  metaOf: (r) => ({
    id: r.id, createdAt: r.createdAt, query: r.query,
    candidateCount: (r.candidates || []).length, costUsd: r.meta && r.meta.costUsd || 0,
    mock: !!(r.meta && r.meta.mock),
  }),
});

function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return fb; } }
function writeAtomic(f, obj) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp-' + Math.random().toString(36).slice(2);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, f);
}

function readStatus() {
  return readJson(STATUS_FILE, { running: false, startedAt: null, finishedAt: null, lastQuery: null, lastError: null });
}
function writeStatus(patch) {
  const next = Object.assign(readStatus(), patch);
  writeAtomic(STATUS_FILE, next);
  return next;
}

// Bugun (Istanbul) kac arastirma yapildi? DAILY_CAP kontrolu icin.
function researchCountToday() {
  const today = istanbulDay(new Date());
  return research.list({ limit: 200 }).filter((m) => istanbulDay(m.createdAt) === today).length;
}
function dailyCapReached() { return researchCountToday() >= DAILY_CAP; }

// { query, city, type, candidates:[...], meta:{model, costUsd, webSearches, mock, at} }
function saveResearch(rec) {
  const id = research.newId();
  return research.save(Object.assign({ id, createdAt: new Date().toISOString() }, rec));
}

module.exports = {
  SDR_DIR, RESEARCH_DIR, DAILY_CAP,
  research, saveResearch,
  readStatus, writeStatus,
  researchCountToday, dailyCapReached,
};
