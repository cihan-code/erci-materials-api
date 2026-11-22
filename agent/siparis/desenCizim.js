'use strict';
// G69: a print cut from a product photo is small, wrinkled and skewed, so tracing it gives a poor vector.
// This layer lets an image model REDRAW the print flat and clean; the clean drawing then goes through the
// normal vector.js path. Off unless DESEN_CIZIM=1 and a provider is available; any failure, timeout or a
// redraw that does not look like the source leaves the old path (direct tracing) and records why.
//   DESEN_CIZIM_SAGLAYICI = openai (OPENAI_API_KEY) | codex (development only: local Codex CLI) | kayit (replay folder)
//   DESEN_CIZIM_KIP       = tam (default: the whole product picture, every print at once) | kirpik (the cut-out print alone)
// Only the print / product picture leaves the server: no customer name, order number, price or e-mail.
// Results are cached on disk per input bytes + request: the same print is never charged twice.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const REVISION = 'g69-1';
const TIMEOUT_MS = 300e3;
const MIN_LONG_EDGE = 2000;
const POSITION_TEXT = {
  gogus: 'centre chest (front)', sol_gogus: "wearer's left chest (front; on the viewer's RIGHT)",
  sag_gogus: "wearer's right chest (front; on the viewer's LEFT)", sirt: 'back', ense: 'nape, just under the collar on the back',
  kapuson: 'hood', kapusan: 'hood', kol: 'a sleeve', sol_kol: "wearer's left sleeve", sag_kol: "wearer's right sleeve",
  bacak: 'a leg', sol_bacak: "wearer's left leg", sag_bacak: "wearer's right leg",
};

let testProvider = null; // tests inject a fake provider; no network, no CLI
const setTestProvider = fn => { testProvider = fn; };

const flag = (env = process.env) => env.DESEN_CIZIM === '1';
function cliBin(env = process.env) {
  if (env.DESEN_CIZIM_CODEX) return fs.existsSync(env.DESEN_CIZIM_CODEX) ? env.DESEN_CIZIM_CODEX : null;
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    const file = dir && path.join(dir, 'codex');
    if (file && fs.existsSync(file)) return file;
  }
  const own = path.join(os.homedir(), '.claude', 'skills', 'ajan-orkestrasi', 'scripts', 'codex');
  return fs.existsSync(own) ? own : null;
}
// The active provider's name, or null (then the old path runs, nothing else changes).
function provider(env = process.env) {
  if (!flag(env)) return null;
  if (testProvider) return 'test';
  const name = env.DESEN_CIZIM_SAGLAYICI || 'openai';
  if (name === 'openai') return env.OPENAI_API_KEY ? 'openai' : null;
  if (name === 'codex') return env.NODE_ENV === 'production' ? null : cliBin(env) ? 'codex' : null; // development only
  if (name === 'kayit') return env.DESEN_CIZIM_KAYIT_DIZIN ? 'kayit' : null;
  return null;
}
// The OpenAI edit endpoint returns ONE image per request, so there it is always one request per print (kirpik).
const mode = (env = process.env) => (env.DESEN_CIZIM_SAGLAYICI || 'openai') === 'openai' || env.DESEN_CIZIM_KIP === 'kirpik' ? 'kirpik' : 'tam';
const model = (env = process.env) => env.DESEN_CIZIM_MODEL || ((env.DESEN_CIZIM_SAGLAYICI || 'openai') === 'codex' ? 'gpt-6-astra' : 'gpt-image-1');
// Part of the artwork cache key of documents.js while the layer is on (off: the old key, untouched).
const keyTag = (env = process.env) => provider(env) ? [REVISION, provider(env), mode(env), model(env)].join(':') : null;

const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');

// ---- prompts -------------------------------------------------------------------------------------------
const RULES = [
  'Keep the artwork EXACTLY as it is: every shape, line, letter, number, proportion and colour. Do NOT change, correct, translate,',
  'complete or add any text, letter or element; if a letter is unclear, redraw it as it appears. Remove ONLY the fabric texture,',
  'wrinkles, folds, shadows, perspective and the garment itself. Flat, front-facing, centred, generous even margin.',
  'Background: one plain solid colour with no gradient and no shadow: pure white when the artwork is dark or coloured,',
  'pure black when the artwork is white or very light (so it stays visible). Highest resolution you can produce.',
].join(' ');
function promptCrop() {
  return `The attached picture (print.png) is a single print cut from a garment photo. Redraw it clean. ${RULES}`;
}
function promptFull(prints) {
  const list = prints.map(p => `- ${p.name}.png: the print at "${p.position}" (${POSITION_TEXT[p.position] || p.position})`).join('\n');
  return [
    'The attached picture (product.png) shows a garment (front and/or back views) carrying prints.',
    'Extract each of the following prints SEPARATELY, as its own image file, one file per print, with exactly these file names:',
    list, RULES, 'A print is the whole artwork at that position (a logo together with its text is one print).',
    'Do not merge prints. If a print is not visible, do not produce its file.',
  ].join('\n');
}

// ---- providers: request {mode, files:[{name,buffer}], prompt, outputs:[names]} -> Map name -> png Buffer ------
async function callOpenai(req, env, signal) {
  const form = new FormData();
  form.set('model', model(env));
  form.set('prompt', req.prompt);
  form.set('size', req.size || 'auto');
  form.set('quality', 'high');
  form.set('output_format', 'png');
  for (const f of req.files) form.append('image[]', new Blob([f.buffer], { type: 'image/png' }), `${f.name}.png`);
  const res = await fetch(`${env.OPENAI_BASE_URL || 'https://api.openai.com'}/v1/images/edits`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` }, body: form, signal });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${data?.error?.message || 'hata'}`);
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI görsel dönmedi');
  return new Map([[req.outputs[0], Buffer.from(b64, 'base64')]]);
}
function callCodex(req, env, signal) {
  const bin = cliBin(env);
  if (!bin) return Promise.reject(new Error('Codex bulunamadı'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desen-cizim-'));
  const done = () => fs.rmSync(dir, { recursive: true, force: true });
  for (const f of req.files) fs.writeFileSync(path.join(dir, `${f.name}.png`), f.buffer);
  const outList = req.outputs.map(n => `${n}.png`).join(', ');
  const prompt = `${req.prompt}\nUse your image generation tool (not code, not tracing) for each drawing and save the result in the current directory as: ${outList}. Do not edit the input files.`;
  const args = ['exec', '-m', model(env), '-s', 'workspace-write', '--skip-git-repo-check', '-C', dir, ...req.files.flatMap(f => ['-i', path.join(dir, `${f.name}.png`)]), '-'];
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(bin, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    const kill = () => { try { child.kill('SIGTERM'); } catch {} };
    const timer = setTimeout(() => { kill(); reject(new Error('Codex zaman aşımı')); }, Number(env.DESEN_CIZIM_ZAMAN_ASIMI_MS) || TIMEOUT_MS);
    signal?.addEventListener('abort', () => { kill(); reject(new Error('iptal')); }, { once: true });
    child.on('error', e => { clearTimeout(timer); done(); reject(e); });
    child.on('close', () => {
      clearTimeout(timer);
      const out = new Map();
      for (const n of req.outputs) { const f = path.join(dir, `${n}.png`); if (fs.existsSync(f)) out.set(n, fs.readFileSync(f)); }
      done();
      out.size ? resolve(out) : reject(new Error('Codex görsel üretmedi'));
    });
    child.stdin.end(prompt);
  });
}
async function callKayit(req, env) { // replay folder: <name>.png, named after the request outputs
  const out = new Map();
  for (const n of req.outputs) { const f = path.join(env.DESEN_CIZIM_KAYIT_DIZIN, `${n}.png`); if (fs.existsSync(f)) out.set(n, fs.readFileSync(f)); }
  if (!out.size) throw new Error('Kayıtta çıktı yok');
  return out;
}
async function call(req, env, signal) {
  const name = provider(env);
  if (name === 'test') return testProvider(req);
  if (name === 'openai') return callOpenai(req, env, signal);
  if (name === 'codex') return callCodex(req, env, signal);
  if (name === 'kayit') return callKayit(req, env);
  throw new Error('Sağlayıcı yok');
}

// ---- image helpers (@napi-rs/canvas) -------------------------------------------------------------------
const canvasLib = () => require('@napi-rs/canvas');
async function pixels(buffer, edge) {
  const img = await canvasLib().loadImage(buffer);
  const k = edge ? Math.min(1, edge / Math.max(img.width, img.height)) : 1;
  const w = Math.max(1, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k));
  const c = canvasLib().createCanvas(w, h), ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  return { width: w, height: h, data: ctx.getImageData(0, 0, w, h).data, srcWidth: img.width, srcHeight: img.height };
}
// Long edge >= 2000 px: a smaller drawing is smoothly enlarged (no new detail; vector.js traces the contours).
async function upscale(buffer) {
  const img = await canvasLib().loadImage(buffer);
  const long = Math.max(img.width, img.height);
  if (long >= MIN_LONG_EDGE) return { buffer, width: img.width, height: img.height, enlarged: false };
  const k = MIN_LONG_EDGE / long, w = Math.round(img.width * k), h = Math.round(img.height * k);
  const c = canvasLib().createCanvas(w, h), ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  return { buffer: c.toBuffer('image/png'), width: w, height: h, enlarged: true };
}

// The flat ground of the redraw becomes transparent (the tracer and the workshop PDF must not carry a coloured box).
async function groundToAlpha(buffer) {
  const p = await pixels(buffer), ink = inkOf(p), g = ink.ground, d = p.data;
  for (let i = 0; i < d.length; i += 4) {
    const dist = Math.hypot(d[i] - g[0], d[i + 1] - g[1], d[i + 2] - g[2]);
    d[i + 3] = dist <= 35 ? 0 : dist >= 90 ? 255 : Math.round((dist - 35) / 55 * 255);
  }
  const c = canvasLib().createCanvas(p.width, p.height);
  c.getContext('2d').putImageData(new (require('@napi-rs/canvas').ImageData)(d, p.width, p.height), 0, 0);
  return c.toBuffer('image/png');
}

// ---- fidelity check ------------------------------------------------------------------------------------
const GRID = 32;
const LIMITS = { aspect: 0.25, color: 110, overlap: 0.5 };
// Ink mask: transparent pixels are ground; otherwise ground = median colour of the border, ink = clearly different.
function inkOf(p) {
  const { width: W, height: H, data } = p;
  let alphaLow = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 200) alphaLow++;
  const transparent = alphaLow > W * H * 0.05;
  const px = (x, y) => (y * W + x) * 4;
  const ring = [];
  for (let x = 0; x < W; x++) for (const y of [0, H - 1]) ring.push(px(x, y));
  for (let y = 1; y < H - 1; y++) for (const x of [0, W - 1]) ring.push(px(x, y));
  const med = c => { const v = ring.map(i => data[i + c]).sort((a, b) => a - b); return v[v.length >> 1]; };
  const ground = [med(0), med(1), med(2)];
  const mask = new Uint8Array(W * H);
  const sumC = [0, 0, 0]; let n = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = px(x, y);
    const d = Math.hypot(data[i] - ground[0], data[i + 1] - ground[1], data[i + 2] - ground[2]);
    const on = transparent ? data[i + 3] >= 128 : d > 70;
    if (!on) continue;
    mask[y * W + x] = 1;
    // Colour of the ink: only opaque, clearly coloured pixels count (anti-aliased edges would blur it).
    if (transparent ? data[i + 3] >= 250 : d > 110) { sumC[0] += data[i]; sumC[1] += data[i + 1]; sumC[2] += data[i + 2]; n++; }
  }
  const color = n ? sumC.map(v => Math.round(v / n)) : null;
  return { mask, W, H, color, ground, count: mask.reduce((a, b) => a + b, 0) };
}
// Ink pixels as points, optionally rotated; the box leaves out 0.5% of the points on each side (isolated specks).
function points(ink, angle = 0) {
  const { mask, W, H } = ink, c = Math.cos(angle), s = Math.sin(angle), pts = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (mask[y * W + x]) pts.push([x * c - y * s, x * s + y * c]);
  return pts;
}
function boxAndGrid(pts) {
  const cut = Math.max(0, Math.floor(pts.length * 0.005));
  const q = (k, lo) => { const v = pts.map(p => p[k]).sort((a, b) => a - b); return lo ? v[cut] : v[v.length - 1 - cut]; };
  const x0 = q(0, true), x1 = q(0, false), y0 = q(1, true), y1 = q(1, false);
  const w = Math.max(1e-6, x1 - x0), h = Math.max(1e-6, y1 - y0), g = new Float32Array(GRID * GRID);
  for (const [x, y] of pts) {
    if (x < x0 || x > x1 || y < y0 || y > y1) continue;
    g[Math.min(GRID - 1, Math.floor((y - y0) / h * GRID)) * GRID + Math.min(GRID - 1, Math.floor((x - x0) / w * GRID))] = 1;
  }
  return { ratio: w / h, grid: g };
}
const dilate = (g, r = 1) => {
  const o = new Uint8Array(GRID * GRID);
  for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) if (g[y * GRID + x])
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const X = x + dx, Y = y + dy; if (X >= 0 && Y >= 0 && X < GRID && Y < GRID) o[Y * GRID + X] = 1;
    }
  return o;
};
function overlapOf(ga, gb) {
  const da = dilate(ga), db = dilate(gb);
  let ca = 0, cb = 0, na = 0, nb = 0;
  for (let i = 0; i < ga.length; i++) { if (ga[i]) { na++; if (db[i]) ca++; } if (gb[i]) { nb++; if (da[i]) cb++; } }
  return Math.min(na ? ca / na : 0, nb ? cb / nb : 0);
}
// source / redrawn: PNG buffers. Simple, explainable: aspect ratio, ink colour, rough shape overlap.
// A print that sits tilted on the garment (a sleeve) is redrawn upright: the redrawn ink is turned in 5 degree
// steps (-90..90) and the best turn is judged, so a straightened print is not refused for being straightened.
async function fidelity(source, redrawn, limits = LIMITS) {
  const a = inkOf(await pixels(source, 256)), b = inkOf(await pixels(redrawn, 256));
  const reasons = [];
  // The prompt asks for a flat white or black ground; garment fabric left behind (any other ground) means no real redraw.
  const g = b.ground;
  if (!(g.every(v => v <= 40) || g.every(v => v >= 215))) return { ok: false, metrics: { zemin: g }, reasons: ['Zemin düz beyaz ya da siyah değil; kumaş kalmış olabilir'] };
  if (a.count < 20 || b.count < 20) return { ok: false, metrics: {}, reasons: ['Baskı mürekkebi ayırt edilemedi'] };
  // The model sometimes hands the cut-out back untouched (fabric still there): nothing was redrawn.
  const sa = await pixels(source, 48), sb = await pixels(redrawn, 48);
  if (sa.width === sb.width && sa.height === sb.height) {
    let diff = 0;
    for (let i = 0; i < sa.data.length; i += 4) diff += Math.abs(sa.data[i] - sb.data[i]) + Math.abs(sa.data[i + 1] - sb.data[i + 1]) + Math.abs(sa.data[i + 2] - sb.data[i + 2]);
    if (diff / (sa.data.length / 4 * 3) < 6) return { ok: false, metrics: {}, reasons: ['Çıktı girdinin kopyası; yeniden çizilmemiş'] };
  }
  const A = boxAndGrid(points(a));
  let best = null;
  for (let deg = -90; deg <= 90; deg += 5) {
    const B = boxAndGrid(points(b, deg * Math.PI / 180));
    const aspect = Math.abs(B.ratio / A.ratio - 1), overlap = overlapOf(A.grid, B.grid);
    // Score: shape first; a turn must also bring the ratio close, otherwise it only hides a wrong drawing.
    const score = overlap - (aspect > limits.aspect ? 1 : 0);
    if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) < 1e-9 && Math.abs(deg) < Math.abs(best.deg))) best = { deg, aspect, overlap, score };
  }
  if (best.aspect > limits.aspect) reasons.push(`En/boy oranı kaynaktan %${Math.round(best.aspect * 100)} farklı`);
  let color = null;
  if (a.color && b.color) {
    color = Math.round(Math.hypot(a.color[0] - b.color[0], a.color[1] - b.color[1], a.color[2] - b.color[2]));
    if (color > limits.color) reasons.push(`Baskın renk kaynaktan farklı (uzaklık ${color})`);
  }
  if (best.overlap < limits.overlap) reasons.push(`Biçim örtüşmesi düşük (%${Math.round(best.overlap * 100)})`);
  return { ok: !reasons.length, metrics: { aspect: +best.aspect.toFixed(3), color, overlap: +best.overlap.toFixed(3),
    donusDerece: best.deg, sourceInk: a.color, redrawnInk: b.color }, reasons };
}

// ---- cache + public API --------------------------------------------------------------------------------
const memo = new Map(); // in-flight / finished full-picture requests of this process
function cachePath(dir, key) { return path.join(dir, `${key}.png`); }
function readCache(dir, key) { try { return fs.readFileSync(cachePath(dir, key)); } catch { return null; } }
function writeCache(dir, key, buf) { try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(cachePath(dir, key), buf); } catch {} }
const keyOf = (env, parts) => sha(Buffer.from(JSON.stringify([REVISION, provider(env), model(env), ...parts])));

function enabled(env = process.env) { return !!provider(env); }

// Redraw of one cut-out print. -> {buffer, ...} or throws.
async function redrawCrop({ crop, image = null, cacheDir, env = process.env, signal }) {
  const files = [{ name: 'print', buffer: crop }, ...(image && provider(env) === 'openai' ? [{ name: 'product', buffer: image }] : [])];
  const key = keyOf(env, ['kirpik', sha(crop), image && provider(env) === 'openai' ? sha(image) : null]);
  const hit = cacheDir && readCache(cacheDir, key);
  if (hit) return { buffer: hit, cached: true, ms: 0, key };
  const t0 = Date.now();
  const out = await call({ mode: 'kirpik', files, prompt: promptCrop(), outputs: ['print'] }, env, signal);
  const buffer = out.get('print');
  if (!buffer) throw new Error('Çıktı yok');
  if (cacheDir) writeCache(cacheDir, key, buffer);
  return { buffer, cached: false, ms: Date.now() - t0, key };
}
// Redraw of every print of the whole product picture in one request. prints: [{position}] -> Map position -> {buffer}
async function redrawFull({ image, prints, cacheDir, env = process.env, signal }) {
  const named = [...new Set(prints.map(p => p.position))].sort().map(position => ({ position, name: position }));
  const base = keyOf(env, ['tam', sha(image), named.map(n => n.position)]);
  const result = new Map(), missing = [];
  for (const n of named) { const hit = cacheDir && readCache(cacheDir, `${base}-${n.name}`); if (hit) result.set(n.position, { buffer: hit, cached: true, ms: 0 }); else missing.push(n); }
  if (missing.length) {
    const flight = `${base}:${missing.map(n => n.name)}`;
    if (!memo.has(flight)) {
      const t0 = Date.now();
      memo.set(flight, call({ mode: 'tam', files: [{ name: 'product', buffer: image }], prompt: promptFull(missing), outputs: missing.map(n => n.name) }, env, signal)
        .then(out => ({ out, ms: Date.now() - t0 })).catch(e => { memo.delete(flight); throw e; }));
    }
    const { out, ms } = await memo.get(flight);
    for (const n of missing) {
      const buffer = out.get(n.name);
      if (!buffer) continue;
      if (cacheDir) writeCache(cacheDir, `${base}-${n.name}`, buffer);
      result.set(n.position, { buffer, cached: false, ms });
    }
  }
  return result;
}

// The one entry point of documents.js. Never throws: {used:true, buffer, report} or {used:false, report:{reason}}.
//   crop: the artwork PNG the old path would trace; image: the product picture buffer; prints: all positions on it.
async function apply({ crop, image, position, prints, cacheDir, env = process.env, signal, log = console.warn }) {
  if (!provider(env)) return { used: false, off: true };
  const t0 = Date.now(), kip = mode(env), saglayici = provider(env);
  const report = { yol: 'dogrudan-izleme', kip, saglayici, model: model(env) };
  try {
    let drawn;
    if (kip === 'tam' && image) {
      const map = await redrawFull({ image, prints: prints?.length ? prints : [{ position }], cacheDir, env, signal });
      drawn = map.get(position);
      if (!drawn) throw new Error(`Tam görselden "${position}" deseni çıkmadı; eski yola dönüldü`);
    } else drawn = await redrawCrop({ crop, image, cacheDir, env, signal });
    const check = await fidelity(crop, drawn.buffer);
    Object.assign(report, { sadakat: check.metrics, onbellek: drawn.cached, sureMs: drawn.ms });
    if (!check.ok) throw Object.assign(new Error(`Yeniden çizim kaynağa benzemiyor: ${check.reasons.join('; ')}`), { sadakat: check });
    const big = await upscale(await groundToAlpha(drawn.buffer));
    Object.assign(report, { yol: 'yeniden-cizim', cozunurluk: [big.width, big.height], buyutuldu: big.enlarged });
    return { used: true, buffer: big.buffer, report };
  } catch (e) {
    report.neden = String(e.message || e).slice(0, 300);
    report.elleKontrol = true;
    report.sureMs = Date.now() - t0;
    try { log(`[desen-cizim] ${position}: eski yola dönüldü: ${report.neden}`); } catch {}
    return { used: false, report };
  }
}

module.exports = { enabled, provider, mode, model, keyTag, apply, redrawCrop, redrawFull, fidelity, upscale, groundToAlpha, setTestProvider,
  promptCrop, promptFull, LIMITS, POSITION_TEXT };
