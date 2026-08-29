// Finansal belge deposu (dekont / fatura goruntuleri).
// DATA_DIR/agent/documents/ altinda: dosyalar + index.json.
// Panel-data'ya base64 GOMULMEZ. Finans kaydi document_id ile baglanir.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DOCS_DIR = path.join(DATA_DIR, 'agent', 'documents');
const FILES_DIR = path.join(DOCS_DIR, 'files');
const INDEX_FILE = path.join(DOCS_DIR, 'index.json');

const MAX_SIZE = 15 * 1024 * 1024; // 15 MB (Anthropic base64 limiti 10MB; PDF icin biraz pay)
const MIME_EXT = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf',
};
const EXT_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.pdf': 'application/pdf',
};

function ensureDirs() { fs.mkdirSync(FILES_DIR, { recursive: true }); }
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return fb; } }
function writeJsonAtomic(f, o) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp-' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, JSON.stringify(o, null, 2));
  fs.renameSync(tmp, f);
}
function loadIndex() { const i = readJson(INDEX_FILE, null); return Array.isArray(i) ? i : []; }
function saveIndex(l) { writeJsonAtomic(INDEX_FILE, l.slice(0, 1000)); }

function detectMime(originalName, providedMime) {
  const ext = path.extname(String(originalName || '')).toLowerCase();
  if (EXT_MIME[ext]) return EXT_MIME[ext];
  if (MIME_EXT[providedMime]) return providedMime;
  return null;
}

// buffer + orijinal ad -> kaydet. Doner: { id, sha256, duplicateOf?, ... }
function saveDocument(buffer, originalName, providedMime) {
  ensureDirs();
  if (!buffer || !buffer.length) throw new Error('Boş dosya.');
  if (buffer.length > MAX_SIZE) throw new Error('Dosya çok büyük (max ' + Math.round(MAX_SIZE / 1024 / 1024) + ' MB).');
  const mime = detectMime(originalName, providedMime);
  if (!mime) throw new Error('Desteklenmeyen dosya türü. JPG / PNG / WEBP / PDF yükleyin.');

  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const index = loadIndex();
  const dup = index.find((d) => d.sha256 === sha256 && d.status !== 'discarded');

  const now = new Date();
  const id = now.toISOString().replace(/[:.]/g, '-') + '_' + crypto.randomBytes(4).toString('hex');
  const storedName = id + MIME_EXT[mime];
  fs.writeFileSync(path.join(FILES_DIR, storedName), buffer);

  const rec = {
    id, storedName,
    originalName: String(originalName || 'belge').replace(/[\/\\]/g, '_').slice(0, 200),
    mime, size: buffer.length, sha256,
    status: 'pending', // pending -> extracted -> committed | discarded
    uploadedAt: now.toISOString(),
    extraction: null,      // Vision cikti
    classification: null,  // deterministik sonuc
    committedRecord: null, // { kind, ids }
  };
  writeJsonAtomic(path.join(DOCS_DIR, id + '.json'), rec);
  index.unshift(metaOf(rec));
  saveIndex(index);
  return {
    id, sha256, mime, size: buffer.length,
    duplicateOf: dup ? { id: dup.id, uploadedAt: dup.uploadedAt } : null,
  };
}

function metaOf(rec) {
  return {
    id: rec.id, originalName: rec.originalName, mime: rec.mime, size: rec.size,
    sha256: rec.sha256, status: rec.status, uploadedAt: rec.uploadedAt,
    documentType: rec.classification && rec.classification.finalType || null,
    direction: rec.classification && rec.classification.finalDirection || null,
    humanLabel: rec.classification && rec.classification.humanLabel || null,
    amount: rec.extraction && rec.extraction.total != null ? rec.extraction.total
      : (rec.extraction && rec.extraction.amount) || null,
    orderNo: rec.extraction && rec.extraction.order_no || null,
    committedKind: rec.committedRecord && rec.committedRecord.kind || null,
  };
}

function getDocument(id) {
  if (!id || /[^A-Za-z0-9_\-]/.test(id)) return null;
  return readJson(path.join(DOCS_DIR, id + '.json'), null);
}
function updateDocument(id, patch) {
  const rec = getDocument(id);
  if (!rec) throw new Error('Belge bulunamadı: ' + id);
  Object.assign(rec, patch);
  writeJsonAtomic(path.join(DOCS_DIR, id + '.json'), rec);
  const index = loadIndex();
  const i = index.findIndex((m) => m.id === id);
  if (i >= 0) index[i] = metaOf(rec); else index.unshift(metaOf(rec));
  saveIndex(index);
  return rec;
}
function listDocuments({ status, limit } = {}) {
  let idx = loadIndex();
  if (status) idx = idx.filter((m) => m.status === status);
  return idx.slice(0, Math.max(1, Math.min(200, parseInt(limit, 10) || 50)));
}
function fileBuffer(rec) {
  const p = path.join(FILES_DIR, rec.storedName);
  if (!fs.existsSync(p)) throw new Error('Dosya diskte yok.');
  return fs.readFileSync(p);
}
function fileBase64(rec) { return fileBuffer(rec).toString('base64'); }

function discardDocument(id) {
  const rec = getDocument(id);
  if (!rec) throw new Error('Belge bulunamadı.');
  if (rec.status === 'committed') throw new Error('İşlenmiş belge silinemez (finans kaydı var).');
  updateDocument(id, { status: 'discarded' });
  try { fs.unlinkSync(path.join(FILES_DIR, rec.storedName)); } catch (e) {}
  return { ok: true };
}

// HARD sil: belge kaydini + dosyasini + indeks satirini tamamen kaldirir.
// PANEL VERISINE DOKUNMAZ - islenmis belgenin olusturdugu gelir/gider/fatura/is kaydi
// yerinde kalir (kullanici onu Gelir/Gider/Faturalar sekmesinden ayrica siler).
function deleteDocument(id) {
  const rec = getDocument(id);
  if (!rec) throw new Error('Belge bulunamadı: ' + id);
  try { fs.unlinkSync(path.join(FILES_DIR, rec.storedName)); } catch (e) { /* dosya zaten yok */ }
  try { fs.unlinkSync(path.join(DOCS_DIR, id + '.json')); } catch (e) { /* json zaten yok */ }
  saveIndex(loadIndex().filter((m) => m.id !== id));
  return {
    ok: true, id,
    wasCommitted: rec.status === 'committed',
    committedRecord: rec.committedRecord || null,
  };
}

// Toplu HARD sil: { ids? } veya { status? } veya { before? (YYYY-MM-DD, uploadedAt) }.
// En az bir olcut sart - bos {} hicbir sey silmez.
function deleteDocuments({ ids, status, before } = {}) {
  const index = loadIndex();
  const idSet = Array.isArray(ids) && ids.length ? new Set(ids) : null;
  if (!idSet && !status && !before) return { deleted: 0, ids: [] };
  const doomed = index.filter((m) => {
    if (idSet) return idSet.has(m.id);
    if (status && m.status !== status) return false;
    if (before && String(m.uploadedAt || '').slice(0, 10) >= before) return false;
    return true;
  });
  doomed.forEach((m) => {
    const rec = getDocument(m.id);
    if (rec) { try { fs.unlinkSync(path.join(FILES_DIR, rec.storedName)); } catch (e) {} }
    try { fs.unlinkSync(path.join(DOCS_DIR, m.id + '.json')); } catch (e) {}
  });
  const doomedIds = new Set(doomed.map((m) => m.id));
  saveIndex(index.filter((m) => !doomedIds.has(m.id)));
  return { deleted: doomedIds.size, ids: [...doomedIds] };
}

module.exports = {
  DOCS_DIR, MAX_SIZE, EXT_MIME,
  ensureDirs, saveDocument, getDocument, updateDocument, listDocuments,
  fileBuffer, fileBase64, discardDocument, deleteDocument, deleteDocuments, loadIndex,
};
