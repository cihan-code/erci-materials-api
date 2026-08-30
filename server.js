// Merci Tekstil Paneli - Sirket Materyalleri dosya depolama API'si
// Render.com uzerinde kalici disk (persistent disk) ile calisir.
// Gerekli ortam degiskenleri (Render > Environment):
//   DATA_DIR      -> disk mount yolu, orn: /data
//   API_KEY       -> panelin gonderdigi gizli anahtar (rastgele uzun bir metin sen belirlersin)
//   CORS_ORIGIN   -> panelin yayinlandigi adres, orn: https://cihan-code.github.io
//   PORT          -> Render otomatik verir, dokunma
//   ANTHROPIC_API_KEY -> Yonetim Ajani + SDR arastirma/puanlama/mail taslagi
// Satis Ajani (SDR) - opsiyonel:
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI -> Gmail gonderim (OAuth)
//   GOOGLE_PLACES_API_KEY -> musteri arastirma kaynak katmani (Google Places; yoksa yalniz web_search)
//   SDR_GMAIL_DAILY_CAP (20) · SDR_DAILY_RESEARCH_CAP (6) · SDR_MAX_WEB_SEARCHES (8) · SDR_MAX_WEB_FETCHES (5)

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Yonetim Ajani modulleri (kendi ayri kovasi; /api/paneldata'ya dokunmaz).
const agentStore = require('./agent/store');
const agentDocs = require('./agent/documents');
const { validatePanelData } = require('./agent/panelSchema');
// Eager yukle: AGENT_MOCK guvenlik kilidi burada; production'da AGENT_MOCK=1 ise uygulama
// app.listen'e gelmeden process.exit(1) yapar.
require('./agent/claude');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const API_KEY = process.env.API_KEY || '';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const MATERIALS_DIR = path.join(DATA_DIR, 'materials');
const FOLDERS_FILE = path.join(MATERIALS_DIR, 'folders.json');
const MAX_FILE_SIZE = 30 * 1024 * 1024; // 30 MB - kalici diskte rahat yer var

const DEFAULT_FOLDERS = [
  { slug: 'genel', label: 'Genel Belgeler', isDefault: true },
  { slug: 'uretim_formu', label: 'Üretim Formu', isDefault: true },
  { slug: 'fiyat_teklifi', label: 'Fiyat Teklifi', isDefault: true },
  { slug: 'onay_formu', label: 'Onay Formu', isDefault: true },
];

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
ensureDir(MATERIALS_DIR);

function loadFolders() {
  if (!fs.existsSync(FOLDERS_FILE)) {
    fs.writeFileSync(FOLDERS_FILE, JSON.stringify(DEFAULT_FOLDERS, null, 2));
    return DEFAULT_FOLDERS.slice();
  }
  let list;
  try { list = JSON.parse(fs.readFileSync(FOLDERS_FILE, 'utf8')); }
  catch (e) { list = DEFAULT_FOLDERS.slice(); }
  // Eski kayitlarda isDefault alani olmayabilir (kod guncellenmeden once olusmus) - varsayilan
  // klasorleri isaretleyip diske geri yazariz ki yanlislikla silinemesinler.
  const defaultSlugs = new Set(DEFAULT_FOLDERS.map(f => f.slug));
  let changed = false;
  list.forEach(f => { if (defaultSlugs.has(f.slug) && !f.isDefault) { f.isDefault = true; changed = true; } });
  if (changed) saveFolders(list);
  return list;
}
function saveFolders(list) { fs.writeFileSync(FOLDERS_FILE, JSON.stringify(list, null, 2)); }

function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    .slice(0, 60) || ('klasor_' + Date.now());
}

function folderDir(slug) { return path.join(MATERIALS_DIR, slug); }
function metaFile(slug) { return path.join(folderDir(slug), 'meta.json'); }
function filesDir(slug) { return path.join(folderDir(slug), 'files'); }

function ensureFolderOnDisk(slug) {
  ensureDir(filesDir(slug));
  if (!fs.existsSync(metaFile(slug))) fs.writeFileSync(metaFile(slug), '[]');
}
function loadMeta(slug) {
  ensureFolderOnDisk(slug);
  try { return JSON.parse(fs.readFileSync(metaFile(slug), 'utf8')); }
  catch (e) { return []; }
}
function saveMeta(slug, arr) { fs.writeFileSync(metaFile(slug), JSON.stringify(arr, null, 2)); }

function folderExists(slug) {
  return loadFolders().some(f => f.slug === slug);
}

function fixFilenameEncoding(name) {
  // multer/busboy bazen UTF-8 dosya adlarini latin1 olarak okuyor (Türkçe karakterler bozuluyor).
  // Bunu duzeltmek icin latin1 -> utf8 donusumu deneriz; basarisiz olursa orijinali kullaniriz.
  if (!name) return name;
  try {
    const fixed = Buffer.from(name, 'latin1').toString('utf8');
    // Eger donusum sonrasi "replacement character" (bozuk kod noktasi) yoksa fixed'i kullan.
    if (!fixed.includes('�')) return fixed;
  } catch (e) { /* yoksay */ }
  return name;
}
function safeOriginalName(name) {
  return String(fixFilenameEncoding(name) || 'dosya').replace(/[\/\\]/g, '_').slice(0, 200);
}

// ---- app kurulumu ----
const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: '20mb' }));

function checkApiKey(req, res, next) {
  if (!API_KEY) return next(); // API_KEY ayarlanmadiysa kontrol atlanir (kurulum kolaylastirma - onerilmez)
  const key = req.header('x-api-key');
  if (key !== API_KEY) return res.status(401).json({ error: 'Yetkisiz istek (x-api-key hatali veya eksik).' });
  next();
}

app.get('/', (req, res) => {
  res.type('text/plain').send('Merci Tekstil Materyaller API calisiyor.');
});

// ---- Panel verisi (Isler, Gelir, Gider, Gorevler vs.) - tum kullanicilar ayni veriyi paylassin diye ----
// panel-data.json yolu ve yedek klasoru + yedekleme + ATOMIK yazma: hepsi agent/store.js'te
// (tek kaynak). Eskiden burada ikinci, ATOMIK OLMAYAN bir kopya vardi (yazma ortasinda cokme =
// tum is verisi bozulur). 12 Agustos 2026 veri kaybi -> yedekleme; simdi tek atomik yol.
const PANEL_DATA_FILE = agentStore.PANEL_DATA_FILE;
const BACKUPS_DIR = agentStore.PANEL_BACKUPS_DIR;

app.get('/api/paneldata', checkApiKey, (req, res) => {
  if (!fs.existsSync(PANEL_DATA_FILE)) return res.json({ data: null, auth: null, updatedAt: null });
  try {
    const raw = fs.readFileSync(PANEL_DATA_FILE, 'utf8');
    res.type('application/json').send(raw);
  } catch (e) {
    res.status(500).json({ error: 'Panel verisi okunamadi.' });
  }
});

app.post('/api/paneldata', checkApiKey, (req, res) => {
  const body = req.body || {};
  if (!body.data) return res.status(400).json({ error: 'data alani gerekli.' });
  // Hafif dogrulama: "bu kesinlikle bozuk" durumlari (dizi olmasi gereken alan obje olmus,
  // para alaninda "abc"/"1.234,56" gibi cop). Sema katiligi YOK.
  const v = validatePanelData(body.data);
  if (!v.ok) {
    return res.status(422).json({
      error: 'Panel verisi doğrulanamadı (bozuk alan). Kaydetme iptal edildi.',
      details: v.errors,
    });
  }
  // Atomik yazma + iyimser eszamanlilik + yedekleme: agentStore.writePanelDataFull.
  // requireExpected: dosya VARSA ve expectedUpdatedAt yoksa REDDET (409). Bu, panelin ilk
  // pull'u basarisiz olup (Render soguk baslangic) bayat yerel veriyle buluttaki guncel
  // veriyi sessizce ezmesini engeller - 12 Agustos 2026 veri kaybinin hala ulasilabilir yolu.
  // Ilk yazma (dosya yok) yine serbest.
  try {
    const updatedAt = agentStore.writePanelDataFull({
      data: body.data,
      auth: body.auth || null,
      expectedUpdatedAt: (body.expectedUpdatedAt === undefined ? null : body.expectedUpdatedAt),
      requireExpected: true,
    });
    res.json({ ok: true, updatedAt });
  } catch (e) {
    if (e && (e.code === 'CONFLICT' || e.code === 'STALE_WRITE')) {
      return res.status(409).json({ error: String(e.message), currentUpdatedAt: e.currentUpdatedAt || null });
    }
    if (e && e.code === 'BAD_INPUT') return res.status(400).json({ error: String(e.message) });
    res.status(500).json({ error: 'Panel verisi kaydedilemedi.' });
  }
});

// Yedek listesini goster (en yeni en ustte) - sadece dosya adi/tarih/boyut, icerik degil.
app.get('/api/paneldata/backups', checkApiKey, (req, res) => {
  try {
    ensureDir(BACKUPS_DIR);
    const files = fs.readdirSync(BACKUPS_DIR).filter(f => f.endsWith('.json'));
    const list = files.map(f => {
      const stat = fs.statSync(path.join(BACKUPS_DIR, f));
      return { filename: f, size: stat.size, mtime: stat.mtime.toISOString() };
    }).sort((a, b) => b.filename.localeCompare(a.filename));
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: 'Yedek listesi okunamadi.' });
  }
});

// Belirli bir yedegin ham icerigini getir (geri yukleme oncesi onizleme veya geri yukleme icin).
app.get('/api/paneldata/backups/:filename', checkApiKey, (req, res) => {
  const filename = path.basename(req.params.filename); // path traversal koruma
  const filePath = path.join(BACKUPS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Yedek bulunamadi.' });
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    res.type('application/json').send(raw);
  } catch (e) {
    res.status(500).json({ error: 'Yedek okunamadi.' });
  }
});

// ---- Sadece Urun Maliyet Sablonlari (Excel/Power Query gibi disaridan salt-okunur baglanti icin) ----
// Bu endpoint TUM panel verisini degil, sadece urun maliyet sablonlarindaki (Kesim/Dikim/Baski-Nakis
// vb.) sabit birim fiyatlari duz bir liste olarak dondurur. Boylece bu baglanti bilgisi (API anahtari)
// Excel dosyasinda saklansa bile sadece fiyat bilgisine erisim riski olusur, musteri/gelir/gider gibi
// hassas verilere degil.
app.get('/api/costtemplates', checkApiKey, (req, res) => {
  if (!fs.existsSync(PANEL_DATA_FILE)) return res.json([]);
  try {
    const raw = JSON.parse(fs.readFileSync(PANEL_DATA_FILE, 'utf8'));
    const products = (raw.data && raw.data.costTemplates && raw.data.costTemplates.products) || [];
    const rows = [];
    products.forEach(p => {
      (p.items || []).forEach(it => {
        rows.push({ urun: p.name, kategori: it.category, fiyat: it.amount });
      });
    });
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Maliyet sablonlari okunamadi.' });
  }
});

// ---- Stok paneli verisi (Kumaş + Numune) - ayrı bir dosyada, mevcut panel verisine dokunmaz ----
const STOK_DATA_FILE = path.join(DATA_DIR, 'stok-data.json');

app.get('/api/stokdata', checkApiKey, (req, res) => {
  if (!fs.existsSync(STOK_DATA_FILE)) return res.json({ data: null, updatedAt: null });
  try {
    const raw = fs.readFileSync(STOK_DATA_FILE, 'utf8');
    res.type('application/json').send(raw);
  } catch (e) {
    res.status(500).json({ error: 'Stok verisi okunamadi.' });
  }
});

app.post('/api/stokdata', checkApiKey, (req, res) => {
  const body = req.body || {};
  if (!body.data) return res.status(400).json({ error: 'data alani gerekli.' });
  const payload = {
    data: body.data,
    updatedAt: new Date().toISOString(),
  };
  try {
    agentStore.writeJsonCompactAtomic(STOK_DATA_FILE, payload); // atomik (temp + rename)
    res.json({ ok: true, updatedAt: payload.updatedAt });
  } catch (e) {
    res.status(500).json({ error: 'Stok verisi kaydedilemedi.' });
  }
});


// Klasor listesi
app.get('/api/folders', checkApiKey, (req, res) => {
  const folders = loadFolders();
  const withCounts = folders.map(f => ({ ...f, fileCount: loadMeta(f.slug).length }));
  res.json(withCounts);
});

// Yeni klasor olustur
app.post('/api/folders', checkApiKey, (req, res) => {
  const label = (req.body && req.body.label || '').trim();
  if (!label) return res.status(400).json({ error: 'Klasor adi gerekli.' });
  const folders = loadFolders();
  let slug = slugify(label);
  let n = 1;
  const existingSlugs = new Set(folders.map(f => f.slug));
  while (existingSlugs.has(slug)) { slug = slugify(label) + '_' + (++n); }
  folders.push({ slug, label, isDefault: false });
  saveFolders(folders);
  ensureFolderOnDisk(slug);
  res.json({ slug, label, isDefault: false, fileCount: 0 });
});

// Klasoru sil (varsayilan klasorler silinemez, icindeki tum dosyalar da silinir)
app.delete('/api/folders/:folder', checkApiKey, (req, res) => {
  const slug = req.params.folder;
  const folders = loadFolders();
  const target = folders.find(f => f.slug === slug);
  if (!target) return res.status(404).json({ error: 'Klasor bulunamadi.' });
  if (target.isDefault) return res.status(400).json({ error: 'Varsayilan klasorler silinemez.' });
  const dir = folderDir(slug);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  saveFolders(folders.filter(f => f.slug !== slug));
  res.json({ ok: true });
});

// Bir klasordeki dosyalari listele
app.get('/api/materials/:folder', checkApiKey, (req, res) => {
  const slug = req.params.folder;
  if (!folderExists(slug)) return res.status(404).json({ error: 'Klasor bulunamadi.' });
  res.json(loadMeta(slug));
});

// Dosya yukleme
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const slug = req.params.folder;
      if (!folderExists(slug)) return cb(new Error('Klasor bulunamadi.'));
      ensureFolderOnDisk(slug);
      cb(null, filesDir(slug));
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').slice(0, 10);
      cb(null, Date.now() + '_' + crypto.randomBytes(6).toString('hex') + ext);
    },
  }),
  limits: { fileSize: MAX_FILE_SIZE },
});

app.post('/api/materials/:folder/upload', checkApiKey, (req, res) => {
  const slug = req.params.folder;
  if (!folderExists(slug)) return res.status(404).json({ error: 'Klasor bulunamadi.' });
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Yukleme basarisiz.' });
    if (!req.file) return res.status(400).json({ error: 'Dosya bulunamadi.' });
    const entry = {
      id: path.parse(req.file.filename).name,
      storedName: req.file.filename,
      name: safeOriginalName(req.file.originalname),
      mime: req.file.mimetype || 'application/octet-stream',
      size: req.file.size,
      kind: 'upload',
      date: new Date().toISOString(),
    };
    const meta = loadMeta(slug);
    meta.unshift(entry);
    saveMeta(slug, meta);
    res.json(entry);
  });
});

// Belge Olusturucu'dan gelen HTML belgeyi kaydet (Uretim/Onay/Fiyat Teklifi)
app.post('/api/materials/:folder/generated', checkApiKey, (req, res) => {
  const slug = req.params.folder;
  if (!folderExists(slug)) return res.status(404).json({ error: 'Klasor bulunamadi.' });
  const { name, html } = req.body || {};
  if (!html) return res.status(400).json({ error: 'html alani gerekli.' });
  ensureFolderOnDisk(slug);
  const storedName = Date.now() + '_' + crypto.randomBytes(6).toString('hex') + '.html';
  fs.writeFileSync(path.join(filesDir(slug), storedName), html, 'utf8');
  const size = Buffer.byteLength(html, 'utf8');
  const entry = {
    id: path.parse(storedName).name,
    storedName,
    name: safeOriginalName(name || 'Belge'),
    mime: 'text/html',
    size,
    kind: 'generated',
    date: new Date().toISOString(),
  };
  const meta = loadMeta(slug);
  meta.unshift(entry);
  saveMeta(slug, meta);
  res.json(entry);
});

// Dosyayi indir / goruntule
app.get('/api/materials/:folder/:id/download', checkApiKey, (req, res) => {
  const slug = req.params.folder;
  if (!folderExists(slug)) return res.status(404).json({ error: 'Klasor bulunamadi.' });
  const meta = loadMeta(slug);
  const entry = meta.find(m => m.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Dosya bulunamadi.' });
  const filePath = path.join(filesDir(slug), entry.storedName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Dosya diskte bulunamadi.' });
  res.setHeader('Content-Type', entry.mime || 'application/octet-stream');
  if (req.query.inline === '1') {
    res.setHeader('Content-Disposition', 'inline; filename="' + encodeURIComponent(entry.name) + '"');
  } else {
    res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(entry.name) + '"');
  }
  fs.createReadStream(filePath).pipe(res);
});

// Dosya sil
app.delete('/api/materials/:folder/:id', checkApiKey, (req, res) => {
  const slug = req.params.folder;
  if (!folderExists(slug)) return res.status(404).json({ error: 'Klasor bulunamadi.' });
  const meta = loadMeta(slug);
  const entry = meta.find(m => m.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Dosya bulunamadi.' });
  const filePath = path.join(filesDir(slug), entry.storedName);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  saveMeta(slug, meta.filter(m => m.id !== req.params.id));
  res.json({ ok: true });
});

// ---- Yonetim Ajani ciktilari (gunluk brifing, uretim risk, finans, ...) ----
// Ajan SADECE bu kovaya yazar. Panel is verisi (/api/paneldata) ajan icin salt-okunur.
agentStore.ensureAgentDirs();

// Meta listesi (markdown haric). ?type= ve ?limit= ile filtre.
app.get('/api/agent/outputs', checkApiKey, (req, res) => {
  try {
    res.json(agentStore.listOutputs({ type: req.query.type, limit: req.query.limit }));
  } catch (e) {
    res.status(500).json({ error: 'Ajan ciktilari okunamadi.' });
  }
});

// O tipteki en yeni cikti (panelin varsayilan gorunumu). ?type= zorunlu degil.
app.get('/api/agent/latest', checkApiKey, (req, res) => {
  const rec = agentStore.getLatest(req.query.type);
  if (!rec) return res.status(404).json({ error: 'Bu tipte henuz cikti yok.' });
  res.json(rec);
});

// Ajan calisma durumu ("hazirlaniyor..." gostergesi icin).
app.get('/api/agent/status', checkApiKey, (req, res) => {
  res.json(agentStore.readStatus());
});

// Tek ciktinin tam metni.
app.get('/api/agent/outputs/:id', checkApiKey, (req, res) => {
  const rec = agentStore.getOutput(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Cikti bulunamadi.' });
  res.json(rec);
});

// Tek ajan ciktisini sil (panelde "Sil" butonu - test ciktilarini temizlemek icin).
app.delete('/api/agent/outputs/:id', checkApiKey, (req, res) => {
  try {
    const out = agentStore.deleteOutput(req.params.id);
    if (!out.deleted) return res.status(404).json({ error: 'Cikti bulunamadi.' });
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(400).json({ error: String(e && e.message || e) });
  }
});

// Toplu sil: ?type= veya ?before=YYYY-MM-DD veya body.ids[]. En az bir olcut sart.
app.post('/api/agent/outputs/delete', checkApiKey, (req, res) => {
  const { type, before, ids } = Object.assign({}, req.query, req.body || {});
  if (!type && !before && !(Array.isArray(ids) && ids.length)) {
    return res.status(400).json({ error: 'type, before veya ids gerekli.' });
  }
  try {
    res.json({ ok: true, ...agentStore.deleteOutputs({ type, before, ids }) });
  } catch (e) {
    res.status(400).json({ error: String(e && e.message || e) });
  }
});

// Disaridan hazir bir markdown ciktisini kaydet (elle calistirilan Claude Code dongusunun
// publish_output.sh'i buraya POST eder). generate.js kendi kaydini dogrudan store ile yapar.
app.post('/api/agent/outputs', checkApiKey, (req, res) => {
  const { type, title, date, markdown, meta } = req.body || {};
  try {
    const rec = agentStore.saveAgentOutput({ type, title, date, markdown, meta });
    res.json({ ok: true, id: rec.id, type: rec.type, date: rec.date });
  } catch (e) {
    res.status(400).json({ error: String(e && e.message || e) });
  }
});

// Brifing uretimini baslat. Anthropic cagrisi 20-60 sn surebilir; async baslatip hemen doneriz,
// panel /api/agent/status'u poll eder.
app.post('/api/agent/run', checkApiKey, (req, res) => {
  const type = (req.query.type || req.body && req.body.type || 'gunluk-brifing');
  if (!agentStore.OUTPUT_TYPES.includes(type)) {
    return res.status(400).json({ error: 'Gecersiz tip: ' + type });
  }
  const status = agentStore.readStatus();
  if (status.running) {
    return res.status(409).json({ error: 'Ajan zaten calisiyor.', status });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY tanimli degil - otomatik uretim kapali.' });
  }
  // Isteği hemen yanitla, uretimi arka planda yap.
  res.json({ started: true, type });
  try {
    const { generate } = require('./agent/generate');
    generate(type).catch((e) => console.error('[api/agent/run] uretim hatasi:', e && e.message || e));
  } catch (e) {
    console.error('[api/agent/run] generate yuklenemedi:', e && e.message || e);
    agentStore.writeStatus({ running: false, lastError: String(e && e.message || e) });
  }
});

// ---- API maliyet gunlugu: her Anthropic cagrisi (model, token, USD) ----
app.get('/api/agent/usage', checkApiKey, (req, res) => {
  try {
    res.json(agentStore.readUsage({ limit: Math.min(500, parseInt(req.query.limit, 10) || 100) }));
  } catch (e) {
    res.status(500).json({ error: 'Kullanim gunlugu okunamadi.' });
  }
});

// ---- Ajana serbest metin komut: Claude aksiyonlari cikarir, backend uygular ----
// safe aksiyonlar hemen uygulanir; finansal/silme/kritik aksiyonlar "pending" doner,
// kullanici /api/agent/act/confirm ile onaylar (ikinci Claude cagrisi YOK).
app.post('/api/agent/act', checkApiKey, async (req, res) => {
  const instruction = (req.body && req.body.instruction) || '';
  if (!instruction.trim()) return res.status(400).json({ error: 'instruction gerekli.' });
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY tanimli degil.' });
  }
  try {
    const { interpretAndAct } = require('./agent/act');
    const out = await interpretAndAct(instruction);
    res.json(out);
  } catch (e) {
    console.error('[api/agent/act] hata:', e && e.message || e);
    res.status(400).json({ error: String(e && e.message || e) });
  }
});

// Onaylanmis tek aksiyonu uygula (Claude cagrisi yok).
app.post('/api/agent/act/confirm', checkApiKey, (req, res) => {
  const action = req.body && req.body.action;
  if (!action || !action.type) return res.status(400).json({ error: 'action.type gerekli.' });
  try {
    const { confirmAction } = require('./agent/act');
    res.json(confirmAction(action));
  } catch (e) {
    const code = e && e.code === 'CONFLICT' ? 409 : 400;
    res.status(code).json({ error: String(e && e.message || e) });
  }
});

// ================= FINANSAL BELGE ISLEME (dekont / fatura) =================
// Yukleme -> Vision cikarim -> DETERMINISTIK siniflandirma -> kullanici onizleme/duzenleme
// -> "Onayla ve İşle" -> finans kaydi. Onaysiz HICBIR mutasyon yok.
const docUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

app.post('/api/agent/documents', checkApiKey, (req, res) => {
  docUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Yükleme başarısız.' });
    if (!req.file) return res.status(400).json({ error: 'Dosya bulunamadı (alan adı: file).' });
    try {
      const r = agentDocs.saveDocument(req.file.buffer, req.file.originalname, req.file.mimetype);
      res.json(r);
    } catch (e) {
      res.status(400).json({ error: String(e && e.message || e) });
    }
  });
});

app.get('/api/agent/documents', checkApiKey, (req, res) => {
  try {
    res.json(agentDocs.listDocuments({ status: req.query.status, limit: req.query.limit }));
  } catch (e) { res.status(500).json({ error: 'Belge listesi okunamadı.' }); }
});

app.get('/api/agent/documents/:id', checkApiKey, (req, res) => {
  const rec = agentDocs.getDocument(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Belge bulunamadı.' });
  const { storedName, ...safe } = rec;
  res.json(safe);
});

app.get('/api/agent/documents/:id/file', checkApiKey, (req, res) => {
  const rec = agentDocs.getDocument(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Belge bulunamadı.' });
  try {
    const buf = agentDocs.fileBuffer(rec);
    res.setHeader('Content-Type', rec.mime);
    res.setHeader('Content-Disposition', 'inline; filename="' + encodeURIComponent(rec.originalName) + '"');
    res.send(buf);
  } catch (e) { res.status(404).json({ error: 'Dosya diskte yok.' }); }
});

// Vision cikarim + deterministik siniflandirma. Finans mutasyonu YOK.
app.post('/api/agent/documents/:id/extract', checkApiKey, async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY && process.env.AGENT_MOCK !== '1') {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY tanımlı değil.' });
  }
  try {
    const { extractDocument } = require('./agent/document');
    const rec = await extractDocument(req.params.id);
    const { storedName, ...safe } = rec;
    res.json(safe);
  } catch (e) {
    console.error('[documents/extract] hata:', e && e.message || e);
    res.status(400).json({ error: String(e && e.message || e) });
  }
});

// Uretim formu: onizlemede alan/boyut degisince adet+maliyeti yeniden hesapla (panel verisine dokunmaz).
app.post('/api/agent/documents/:id/recompute', checkApiKey, (req, res) => {
  try {
    const { recomputeProdForm } = require('./agent/document');
    const rec = recomputeProdForm(req.params.id, req.body || {});
    const { storedName, ...safe } = rec;
    res.json(safe);
  } catch (e) {
    res.status(400).json({ error: String(e && e.message || e) });
  }
});

// Onaylanan belgeyi finansa isle (kullanici duzenlemeleri + confirm).
app.post('/api/agent/documents/:id/commit', checkApiKey, (req, res) => {
  try {
    const { commitDocument } = require('./agent/documentCommit');
    const out = commitDocument(req.params.id, req.body || {});
    res.json(out);
  } catch (e) {
    const code = e && e.code === 'CONFLICT' ? 409 : 400;
    res.status(code).json({ error: String(e && e.message || e) });
  }
});

// Belge kaydini TAMAMEN sil (dosya + kayit + indeks). Panel verisine dokunmaz -
// islenmis belgenin olusturdugu gelir/gider/is kaydi yerinde kalir (yanit committedRecord ile bildirir).
app.delete('/api/agent/documents/:id', checkApiKey, (req, res) => {
  try {
    res.json(agentDocs.deleteDocument(req.params.id));
  } catch (e) {
    res.status(e && /bulunamad/i.test(String(e.message)) ? 404 : 400).json({ error: String(e && e.message || e) });
  }
});

// Toplu sil: body/query { status? | before? (YYYY-MM-DD) | ids[] }. En az bir olcut sart.
app.post('/api/agent/documents/delete', checkApiKey, (req, res) => {
  const { status, before, ids } = Object.assign({}, req.query, req.body || {});
  if (!status && !before && !(Array.isArray(ids) && ids.length)) {
    return res.status(400).json({ error: 'status, before veya ids gerekli.' });
  }
  try {
    res.json({ ok: true, ...agentDocs.deleteDocuments({ status, before, ids }) });
  } catch (e) { res.status(400).json({ error: String(e && e.message || e) }); }
});

// ========================= SATIŞ AJANI (SDR) =========================
// Yönetim Ajanından BAĞIMSIZ. Kendi namespace'i (/api/sdr/*), kendi kodu (agent/sdr/),
// kendi kovası (DATA_DIR/sdr/). leads[] panel-data.json içinde (agent/sdr/leads.js yazar).
const sdrStore = require('./agent/sdr/store');
const sdrLeads = require('./agent/sdr/leads');
const sdrGmail = require('./agent/sdr/gmail');

// Araştırma başlat (async) - panel /api/sdr/status poll eder.
app.post('/api/sdr/research', checkApiKey, (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY && process.env.AGENT_MOCK !== '1') {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY tanımlı değil.' });
  }
  const { query, city, type } = req.body || {};
  if (!query || !String(query).trim()) return res.status(400).json({ error: 'query (araştırma hedefi) gerekli.' });
  // "running" bayragi takili kalabilir (sunucu arastirma ortasinda yeniden baslarsa). 15 dk'dan
  // eski bir "running" bayat sayilir - yeni istegi engelleme.
  const st = sdrStore.readStatus();
  const fresh = st.running && st.startedAt && (Date.now() - new Date(st.startedAt).getTime()) < 15 * 60 * 1000;
  if (fresh) return res.status(409).json({ error: 'Bir araştırma zaten çalışıyor.' });
  try {
    const { researchAndScore } = require('./agent/sdr/flow');
    researchAndScore({ query, city, type }).catch((e) => console.error('[sdr/research] hata:', e && e.message || e));
    res.json({ started: true });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
});
app.get('/api/sdr/status', checkApiKey, (req, res) => {
  const sdrSources = require('./agent/sdr/sources');
  res.json(Object.assign(sdrStore.readStatus(), {
    dailyCap: sdrStore.DAILY_CAP, researchToday: sdrStore.researchCountToday(),
    sources: {
      places: sdrSources.placesConfigured(),
    },
  }));
});
app.get('/api/sdr/research', checkApiKey, (req, res) => {
  res.json(sdrStore.research.list({ limit: req.query.limit }));
});
app.get('/api/sdr/research/:id', checkApiKey, (req, res) => {
  const rec = sdrStore.research.get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Araştırma bulunamadı.' });
  res.json(rec);
});
app.delete('/api/sdr/research/:id', checkApiKey, (req, res) => {
  const r = sdrStore.research.delete(req.params.id);
  res.status(r.deleted ? 200 : 404).json(r.deleted ? { ok: true } : { error: 'Bulunamadı.' });
});

// Aday(lar)ı Lead Havuzuna aktar (data.leads).
app.post('/api/sdr/leads/commit', checkApiKey, (req, res) => {
  const { researchId, candidateIndexes, candidates, source_query } = req.body || {};
  let list = Array.isArray(candidates) ? candidates : null;
  if (!list && researchId) {
    const rec = sdrStore.research.get(researchId);
    if (!rec) return res.status(404).json({ error: 'Araştırma bulunamadı.' });
    const all = rec.candidates || [];
    list = Array.isArray(candidateIndexes) && candidateIndexes.length
      ? candidateIndexes.map((i) => all[i]).filter(Boolean)
      : all;
  }
  if (!list || !list.length) return res.status(400).json({ error: 'candidates veya researchId gerekli.' });
  try {
    res.json(sdrLeads.commitLeads(list, { confirm: true, source_query }));
  } catch (e) { res.status(400).json({ error: String(e && e.message || e) }); }
});

app.get('/api/sdr/leads', checkApiKey, (req, res) => {
  const { data } = agentStore.loadPanelData();
  res.json(sdrLeads.listLeads(data || {}, { status: req.query.status, city: req.query.city, priority: req.query.priority }));
});

// Günlük özet - deterministik, model çağrısı YOK (takibi geciken + taslak bekleyen lead'ler).
app.get('/api/sdr/digest', checkApiKey, (req, res) => {
  const { data } = agentStore.loadPanelData();
  res.json(sdrLeads.digest(data || {}));
});

// Mail taslağı üret (KAYDETMEZ - panele döner, kullanıcı düzenleyip /leads/:id ile kaydeder).
app.post('/api/sdr/leads/:id/email', checkApiKey, async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY && process.env.AGENT_MOCK !== '1') {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY tanımlı değil.' });
  }
  const { data } = agentStore.loadPanelData();
  const lead = sdrLeads.getLead(data || {}, req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead bulunamadı.' });
  try {
    const { draftEmail } = require('./agent/sdr/email');
    res.json(await draftEmail(lead));
  } catch (e) { res.status(400).json({ error: String(e && e.message || e) }); }
});

// Lead güncelle: { durum? | mail_taslagi? | mark_sent? | followup_tarihi? | note? }
app.post('/api/sdr/leads/:id', checkApiKey, (req, res) => {
  try {
    res.json(sdrLeads.updateLead(req.params.id, req.body || {}, { confirm: true }));
  } catch (e) { res.status(400).json({ error: String(e && e.message || e) }); }
});

// Lead -> pipeline (Potansiyel İşler).
app.post('/api/sdr/leads/:id/convert', checkApiKey, (req, res) => {
  try {
    res.json(sdrLeads.convertToPipeline(req.params.id, Object.assign({ confirm: true }, req.body || {})));
  } catch (e) { res.status(400).json({ error: String(e && e.message || e) }); }
});

app.delete('/api/sdr/leads/:id', checkApiKey, (req, res) => {
  try {
    const r = sdrLeads.deleteLead(req.params.id);
    res.status(r.deleted ? 200 : 404).json(r.deleted ? r : { error: 'Bulunamadı.' });
  } catch (e) { res.status(400).json({ error: String(e && e.message || e) }); }
});

// ---- SDR Gmail entegrasyonu (Faz 2) ----
// Scope: gmail.send + openid email (gelen kutusu OKUNMAZ). Onaylı tekli gönderim. Toplu/otomatik YOK.
function sdrGmailReady(res) {
  if (sdrGmail.configured() || process.env.SDR_GMAIL_MOCK === '1') return true;
  res.status(503).json({ error: 'Gmail bağlantısı yapılandırılmadı (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI).' });
  return false;
}
function htmlEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function gmailCallbackPage(title, message, ok) {
  return '<!doctype html><html lang="tr"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + htmlEsc(title) + '</title>' +
    '<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f6fa;color:#12213b;' +
    'display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}' +
    '.card{background:#fff;border:1px solid #d9e0ea;border-radius:14px;padding:28px 32px;max-width:420px;text-align:center;box-shadow:0 6px 24px rgba(18,33,59,.08)}' +
    '.ico{font-size:40px}h1{font-size:18px;margin:12px 0 6px}p{color:#5a6474;font-size:14px;line-height:1.5;margin:0}' +
    '</style></head><body><div class="card"><div class="ico">' + (ok ? '✅' : '⚠️') + '</div>' +
    '<h1>' + htmlEsc(title) + '</h1><p>' + htmlEsc(message) + '</p>' +
    '<p style="margin-top:14px;font-size:12px;color:#8a94a6">Bu sekmeyi kapatıp panele dönebilirsiniz.</p></div>' +
    '<script>setTimeout(function(){window.close()},4000)</script></body></html>';
}

// OAuth başlat: panel bu URL'yi alıp kullanıcıyı Google'a yönlendirir.
app.get('/api/sdr/gmail/auth', checkApiKey, (req, res) => {
  if (!sdrGmailReady(res)) return;
  try { res.json({ url: sdrGmail.buildAuthUrl() }); }
  catch (e) { res.status(503).json({ error: String(e && e.message || e) }); }
});

// Google buraya döner (tarayıcı yönlendirmesi — x-api-key yok, state ile korunur).
app.get('/api/sdr/gmail/callback', async (req, res) => {
  const { code, state, error } = req.query || {};
  if (error) {
    return res.status(400).type('html').send(gmailCallbackPage('Bağlantı iptal edildi', 'Google yetkilendirmesi tamamlanmadı: ' + error, false));
  }
  try {
    const r = await sdrGmail.handleCallback({ code, state });
    res.type('html').send(gmailCallbackPage('Gmail bağlandı', r.email + ' hesabı Satış Ajanına bağlandı.', true));
  } catch (e) {
    res.status(400).type('html').send(gmailCallbackPage('Bağlantı hatası', String(e && e.message || e), false));
  }
});

app.get('/api/sdr/gmail/status', checkApiKey, (req, res) => {
  res.json(sdrGmail.status());
});

app.post('/api/sdr/gmail/disconnect', checkApiKey, async (req, res) => {
  try { res.json(await sdrGmail.disconnect()); }
  catch (e) { res.status(400).json({ error: String(e && e.message || e) }); }
});

// Onaylı tekli gönderim: lead'in KAYITLI taslağını info@mercitex.com'dan gönderir.
// Body (opsiyonel): { to, konu, govde, force }
app.post('/api/sdr/leads/:id/send', checkApiKey, async (req, res) => {
  if (!sdrGmailReady(res)) return;
  try {
    const { data } = agentStore.loadPanelData();
    const lead = sdrLeads.getLead(data || {}, req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead bulunamadı.' });

    const body = req.body || {};
    const konu = (body.konu && String(body.konu).trim()) || (lead.mail_taslagi && lead.mail_taslagi.konu) || null;
    const govde = (body.govde && String(body.govde).trim()) || (lead.mail_taslagi && lead.mail_taslagi.govde) || null;
    if (!konu || !govde) {
      return res.status(400).json({ error: 'Bu lead için kayıtlı mail taslağı yok. Önce "Mail Taslağı Oluştur" ile taslağı hazırlayıp kaydedin.' });
    }
    const to = sdrGmail.resolveRecipient(lead, body.to);
    if (!to) return res.status(400).json({ error: 'Bu lead için alıcı e-posta adresi yok. Gönderim ekranından adres girin.' });

    if (body.force !== true && sdrGmail.recentlySentTo(lead.id)) {
      return res.status(429).json({ error: 'Bu lead\'e son 24 saat içinde zaten mail gönderildi. Yine de göndermek için tekrar onaylayın.' });
    }

    const sent = await sdrGmail.sendEmail({ to, subject: konu, body: govde, leadId: lead.id });
    const upd = sdrLeads.updateLead(req.params.id, {
      mark_sent: true, konu, kanal: 'email (Gmail)', to, message_id: sent.messageId,
    }, { confirm: true });
    res.json({ ok: true, sent, lead: upd.lead });
  } catch (e) {
    const code = e && e.code === 'DAILY_CAP' ? 429 : 400;
    res.status(code).json({ error: String(e && e.message || e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Merci Tekstil Materyaller API port ' + PORT + ' uzerinde calisiyor. DATA_DIR=' + DATA_DIR));
