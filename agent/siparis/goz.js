'use strict';
// G61 "göz": a vision model looks at the product picture the way a person does and says
// WHERE things are (garments, front/back, the box around each whole print). It never
// gives centimetres: the size is still computed in code from the pixel mask and the
// pattern's L scale (autoMeasure gozMeasure, olcuKarar).
// Off unless GOZ_OLCU=1 and a provider is available; any failure leaves the old path.
// Answers are cached in the database per picture bytes + request: no second call.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const REVISION = 'g61-1';
const EDGE = 1568; // long edge sent to the model (px)
const TIMEOUT_MS = 60e3;
const FAILURE_MEMO_MS = 10 * 60e3;
const POSITION_TEXT = {
  gogus: 'centre chest (front)', sol_gogus: "wearer's left chest (front; appears on the viewer's RIGHT)",
  sag_gogus: "wearer's right chest (front; appears on the viewer's LEFT)", sirt: 'back (between shoulders and hem)',
  ense: 'nape / back neck just under the collar', kapuson: 'hood', kapusan: 'hood', kol: 'a sleeve',
  sol_kol: "wearer's left sleeve", sag_kol: "wearer's right sleeve", bacak: 'a trouser/short leg',
  sol_bacak: "wearer's left leg", sag_bacak: "wearer's right leg",
};
const BOX = { type: 'object', additionalProperties: false, required: ['x', 'y', 'w', 'h'],
  properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } } };
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['urunler', 'baskilar'],
  properties: {
    urunler: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['kutu', 'gorunum', 'tur'],
      properties: { kutu: BOX, gorunum: { type: 'string', enum: ['on', 'arka', 'belirsiz'] }, tur: { type: 'string' } } } },
    baskilar: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['konum', 'urun', 'kutu', 'aciklama', 'guven'],
      properties: { konum: { type: 'string' }, urun: { type: 'integer' }, kutu: BOX, aciklama: { type: 'string' },
        guven: { type: 'string', enum: ['yuksek', 'orta', 'dusuk'] } } } },
  },
};

let testProvider = null; // tests inject a fake provider; no network
const failures = new Map();

function cliBin(env = process.env) {
  if (env.GOZ_CLI) return fs.existsSync(env.GOZ_CLI) ? env.GOZ_CLI : null;
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    const file = dir && path.join(dir, 'claude');
    if (file && fs.existsSync(file)) return file;
  }
  // Same lookup as the limit-dengesi script: the newest VS Code extension binary.
  const root = path.join(os.homedir(), '.vscode', 'extensions');
  let found = [];
  try { found = fs.readdirSync(root).filter(d => d.startsWith('anthropic.claude-code-')); } catch { return null; }
  const version = d => (d.match(/claude-code-([\d.]+)/)?.[1] || '').split('.').map(Number);
  found.sort((a, b) => { const x = version(a), y = version(b); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; });
  for (const d of found.reverse()) {
    const file = path.join(root, d, 'resources', 'native-binary', 'claude');
    if (fs.existsSync(file)) return file;
  }
  return null;
}
// The active provider's name, or null (then the measurement behaves exactly as before G61).
function provider(env = process.env) {
  if (env.GOZ_OLCU !== '1') return null;
  if (testProvider) return 'test';
  const name = env.GOZ_SAGLAYICI || 'api';
  if (name === 'api') return env.ANTHROPIC_API_KEY ? 'api' : null;
  if (name === 'cli') return env.NODE_ENV === 'production' ? null : cliBin(env) ? 'cli' : null; // development only
  if (name === 'kayit') return env.GOZ_KAYIT_DIZIN ? 'kayit' : null;
  return null;
}
const model = (env = process.env) => env.GOZ_MODEL || 'claude-opus-5-5';
function init(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS goz_cache (
    anahtar TEXT PRIMARY KEY, sha256 TEXT NOT NULL, saglayici TEXT NOT NULL, model TEXT,
    istek_json TEXT NOT NULL, cevap_json TEXT NOT NULL, created_at INTEGER NOT NULL)`);
}
// One request per picture and order line: every position on the line is asked at once.
function request({ sha256, product, color, positions }) {
  return { sha256, product: product ?? null, color: color ?? null, positions: [...new Set(positions)].sort() };
}
function key(req, env = process.env) {
  return crypto.createHash('sha256').update(JSON.stringify([REVISION, provider(env), model(env), req])).digest('hex');
}
function cached(db, req, env = process.env) {
  if (!provider(env)) return null;
  const row = db.prepare('SELECT cevap_json FROM goz_cache WHERE anahtar=?').get(key(req, env));
  return row ? JSON.parse(row.cevap_json) : null;
}
function lastFailure(req, env = process.env) {
  const f = failures.get(key(req, env));
  return f && Date.now() - f.at < FAILURE_MEMO_MS ? f.message : null;
}
function prompt(req, img) {
  const positions = req.positions.map(p => `- ${p}: ${POSITION_TEXT[p] || p}`).join('\n');
  return [
    `This is a product picture for a garment print order (${img.width} x ${img.height} pixels).`,
    `Ordered product type: ${req.product || 'unknown'}; colour: ${req.color || 'unknown'}.`,
    'List every garment you see in "urunler": its bounding box in pixels of this picture (x, y = top-left corner),',
    'its view ("on" = front, "arka" = back, "belirsiz" = you cannot tell) and its type in a few words.',
    'Then, for each of these print positions, list the print(s) you see there in "baskilar":',
    positions,
    '"konum" is the position key above, "urun" the index of the garment in "urunler", "kutu" ONE box around the WHOLE',
    'artwork of that print: a logo together with its text, figure and graphics is one print. Give separate entries only',
    'for clearly separate prints at the same position (for example a logo and a separate number).',
    'Left and right are the wearer\'s. Omit a position that carries no print. Never estimate centimetres.',
    'Answer with the JSON object only.',
  ].join('\n');
}
// Pixel boxes of the sent picture -> fractions of it; anything malformed is dropped.
function normalize(answer, img) {
  if (!answer || !Array.isArray(answer.urunler) || !Array.isArray(answer.baskilar)) throw new Error('Göz cevabı beklenen biçimde değil');
  const W = img.width, H = img.height;
  const box = b => {
    if (!b || ![b.x, b.y, b.w, b.h].every(Number.isFinite) || b.w <= 0 || b.h <= 0) return null;
    const x = Math.max(0, Math.min(W, b.x)), y = Math.max(0, Math.min(H, b.y));
    const w = Math.min(W - x, b.w), h = Math.min(H - y, b.h);
    return w > 0 && h > 0 ? { x: x / W, y: y / H, w: w / W, h: h / H } : null;
  };
  const urunler = answer.urunler.map(u => ({ box: box(u.kutu), view: ['on', 'arka'].includes(u.gorunum) ? u.gorunum : 'belirsiz', type: String(u.tur || '') }));
  if (urunler.some(u => !u.box)) throw new Error('Göz cevabında geçersiz ürün kutusu');
  const baskilar = answer.baskilar.map(b => ({ position: String(b.konum), product: Number.isInteger(b.urun) && b.urun >= 0 && b.urun < urunler.length ? b.urun : null,
    box: box(b.kutu), note: String(b.aciklama || ''), confidence: ['yuksek', 'orta', 'dusuk'].includes(b.guven) ? b.guven : null })).filter(b => b.box);
  return { width: W, height: H, urunler, baskilar };
}
const jsonObject = text => {
  const s = String(text), a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('Göz cevabında JSON yok');
  return JSON.parse(s.slice(a, b + 1));
};
async function callApi(img, req, env, signal) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ timeout: Number(env.GOZ_ZAMAN_ASIMI_MS) || TIMEOUT_MS, maxRetries: 1 });
  // Server-side fallback: a declined request is re-run on the fallback model in the same call.
  const response = await client.beta.messages.create({
    model: model(env), max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    output_config: { effort: env.GOZ_EFFORT || 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: img.mime, data: img.buffer.toString('base64') } },
      { type: 'text', text: prompt(req, img) },
    ] }],
  }, { signal });
  if (response.stop_reason === 'refusal') throw new Error('Göz isteği reddedildi');
  if (response.stop_reason === 'max_tokens') throw new Error('Göz cevabı yarım kaldı');
  const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return { answer: jsonObject(text), usage: response.usage ? { input: response.usage.input_tokens, output: response.usage.output_tokens } : null };
}
// Development only: the local Claude Code CLI, headless, reading the picture from a temp file.
async function callCli(img, req, env, signal) {
  const bin = cliBin(env), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goz-'));
  const file = path.join(dir, img.mime === 'image/png' ? 'urun.png' : 'urun.jpg');
  fs.writeFileSync(file, img.buffer);
  try {
    const text = `${prompt(req, img)}\nRead the picture at ${file}. Reply with only one JSON object matching this JSON schema:\n${JSON.stringify(SCHEMA)}`;
    const out = await new Promise((resolve, reject) => {
      const child = childProcess.spawn(bin, ['-p', text, '--output-format', 'json', '--model', model(env), '--allowedTools', 'Read', '--max-turns', '4'],
        { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env } });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), Number(env.GOZ_ZAMAN_ASIMI_MS) || 4 * TIMEOUT_MS);
      const abort = () => child.kill('SIGKILL');
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });
      child.on('error', reject);
      child.on('close', code => { clearTimeout(timer); signal?.removeEventListener('abort', abort);
        code === 0 ? resolve(stdout) : reject(new Error(`Göz CLI çıkış ${code}: ${stderr.slice(0, 200)}`)); });
    });
    const envelope = JSON.parse(out);
    if (envelope.is_error) throw new Error(`Göz CLI hatası: ${String(envelope.result).slice(0, 200)}`);
    return { answer: jsonObject(envelope.result), usage: envelope.usage ? { input: envelope.usage.input_tokens, output: envelope.usage.output_tokens } : null };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
// Recorded answers (evaluation without a key): GOZ_KAYIT_DIZIN/<sha256>.json = {width,height,urunler,baskilar}.
async function callRecord(img, req, env) {
  const file = path.join(env.GOZ_KAYIT_DIZIN, `${req.sha256}.json`);
  if (!fs.existsSync(file)) throw new Error('Bu görsel için göz kaydı yok');
  const answer = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { answer, size: { width: answer.width, height: answer.height } };
}
/**
 * Makes sure the answer for `req` is cached. loadImage() -> {buffer, mime, width, height}
 * is called only on a cache miss. Returns {answer} or {error}; never throws.
 */
async function ensure(db, req, loadImage, { env = process.env, signal } = {}) {
  const name = provider(env);
  if (!name) return null;
  const k = key(req, env), hit = db.prepare('SELECT cevap_json FROM goz_cache WHERE anahtar=?').get(k);
  if (hit) return { answer: JSON.parse(hit.cevap_json), cached: true };
  const memo = lastFailure(req, env);
  if (memo) return { error: memo };
  try {
    const img = await loadImage();
    const call = name === 'test' ? testProvider : name === 'api' ? callApi : name === 'cli' ? callCli : callRecord;
    const raw = await call(img, req, env, signal);
    const answer = { ...normalize(raw.answer, raw.size || img), saglayici: name, model: name === 'api' || name === 'cli' ? model(env) : null, ...(raw.usage ? { usage: raw.usage } : {}) };
    db.prepare('INSERT OR REPLACE INTO goz_cache(anahtar,sha256,saglayici,model,istek_json,cevap_json,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(k, req.sha256, name, answer.model, JSON.stringify(req), JSON.stringify(answer), Date.now());
    failures.delete(k);
    return { answer };
  } catch (e) {
    if (signal?.aborted) throw e;
    const message = `Göz çalışmadı, piksel yolu kullanıldı: ${String(e.message).split('\n')[0].slice(0, 200)}`;
    failures.set(k, { at: Date.now(), message });
    return { error: message };
  }
}
// The front garment's side when the eye named exactly one front and one back garment.
function frontSide(answer) {
  const u = answer?.urunler || [];
  if (u.length !== 2) return null;
  const on = u.filter(g => g.view === 'on'), back = u.filter(g => g.view === 'arka');
  if (on.length !== 1 || back.length !== 1) return null;
  const c = b => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 }), a = c(on[0].box), b = c(back[0].box);
  return Math.abs(a.x - b.x) >= Math.abs(a.y - b.y) ? (a.x < b.x ? 'sol' : 'sag') : (a.y < b.y ? 'ust' : 'alt');
}
const union = boxes => {
  const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
  return { x, y, w: Math.max(...boxes.map(b => b.x + b.w)) - x, h: Math.max(...boxes.map(b => b.y + b.h)) - y };
};
/**
 * The eye's evidence for one print: {print, product, front} or {baskiYok|urunYok|reason}.
 * sameCount: applications of the line at this position. Several prints at a position the
 * order fills once are one print (their union); several applications with several prints
 * cannot be paired on this evidence, so the eye stays out of them.
 */
function forPrint(answer, position, sameCount) {
  if (!answer.urunler.length) return { urunYok: 'görselde giysi yok' };
  // The front/back answer belongs to the picture, whatever this print's outcome.
  const front = frontSide(answer), side = front ? { front } : {};
  const prints = answer.baskilar.filter(b => b.position === position);
  if (!prints.length) return { baskiYok: `${position} konumunda baskı yok`, ...side };
  if (sameCount !== 1) return { reason: `Göz ${position} konumunda ${prints.length} baskı, siparişte ${sameCount} uygulama var; eşleştirilemedi.`, ...side };
  const products = new Set(prints.map(p => p.product));
  if (products.size > 1) return { reason: `Göz ${position} konumunda ${products.size} farklı üründe baskı gösterdi; hangisi olduğu ayrılamadı.`, ...side };
  const box = prints.length === 1 ? prints[0].box : union(prints.map(p => p.box));
  const product = prints[0].product == null ? null : answer.urunler[prints[0].product];
  return { print: { box, confidence: prints.length === 1 ? prints[0].confidence : 'orta' }, product: product ? { box: product.box, view: product.view } : null, ...side };
}
function setTestProvider(fn) { testProvider = fn; failures.clear(); }
module.exports = { provider, model, init, request, key, cached, ensure, lastFailure, forPrint, frontSide, normalize, setTestProvider, cliBin, SCHEMA, EDGE, REVISION, prompt };
