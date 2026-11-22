'use strict';
// G74: what leaves for the workshop for one print (Patron 22.11: "vektörel hale getirme işi hiç olmuyorsa çözünürlüğü çok
// yüksek bir şekilde atsın, neredeyse vektörel gibi").
//   vectorGate: a traced vector goes only when it is faithful to the raster it was traced from. Both are reduced to their
//               ink, laid on one grid (each to its own ink box) and compared: coverage both ways (missing strokes, extra or
//               doubled strokes) and fine structure. Thresholds in GATE, fixed by test/siparis-desen-cikti.test.js.
//   highResPng: always, and the only design file when the gate fails: a transparent indexed PNG, at least PNG_DPI at
//               print size and PNG_MIN_EDGE px on its long edge; every pixel is one of the design's inks or transparent
//               (sharp edges per colour, no blurred enlargement); pngPdf embeds it at print size without decoding it.
// Runs in the render child (documents.js generateInChild type "desenCikti"); pixels are worked on in typed arrays.
const zlib = require('zlib');
const canvasLib = () => require('@napi-rs/canvas');

const PNG_DPI = 600, PNG_MIN_EDGE = 6000;
const GATE = { ortusme: 0.95, parca: 0.6, ince: 0.9, oran: 0.03, kaynakPx: 1000 };
const FRAME = 2048, R = 1, TILE = 64, MAX_INKS = 8;
const PT_PER_MM = 72 / 25.4;

async function decode(buffer, maxEdge = 0) {
  const img = await canvasLib().loadImage(buffer);
  const k = maxEdge ? Math.min(1, maxEdge / Math.max(img.width, img.height)) : 1;
  const w = Math.max(1, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k));
  const c = canvasLib().createCanvas(w, h), ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  return { width: w, height: h, data: ctx.getImageData(0, 0, w, h).data, srcWidth: img.width, srcHeight: img.height };
}
// A picture whose own ground is transparent; otherwise the median colour of its border is the ground.
function groundOf(p) {
  const { width: W, height: H, data: d } = p;
  let low = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 200) low++;
  if (low > W * H * 0.05) return null;
  const ring = [];
  for (let x = 0; x < W; x++) ring.push(x, (H - 1) * W + x);
  for (let y = 1; y < H - 1; y++) ring.push(y * W, y * W + W - 1);
  const med = c => { const v = ring.map(k => d[k * 4 + c]).sort((a, b) => a - b); return v[v.length >> 1]; };
  return [med(0), med(1), med(2)];
}
// Ink mask: alpha on a transparent ground; else the pixel (laid on the ground) clearly differs from the ground.
function inkMask(p, ground) {
  const { width: W, height: H, data: d } = p, m = new Uint8Array(W * H);
  for (let k = 0, i = 0; k < W * H; k++, i += 4) {
    if (!ground) { m[k] = d[i + 3] >= 128 ? 1 : 0; continue; }
    const a = d[i + 3] / 255, r = d[i] * a + ground[0] * (1 - a), g = d[i + 1] * a + ground[1] * (1 - a), b = d[i + 2] * a + ground[2] * (1 - a);
    m[k] = Math.hypot(r - ground[0], g - ground[1], b - ground[2]) > 70 ? 1 : 0;
  }
  return m;
}
function inkBox(m, W, H) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (m[y * W + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
// The ink sampled on a GW x GH frame spanning its own ink box (nearest pixel: both pictures land on the same frame).
function toFrame(m, W, H, box, GW, GH) {
  const g = new Uint8Array(GW * GH);
  for (let y = 0; y < GH; y++) {
    const sy = Math.min(H - 1, Math.floor(box.y + (y + 0.5) / GH * box.h)) * W;
    for (let x = 0; x < GW; x++) g[y * GW + x] = m[sy + Math.min(W - 1, Math.floor(box.x + (x + 0.5) / GW * box.w))];
  }
  return g;
}
// Cells within r of ink (square neighbourhood), separable: rows then columns.
function dilate(g, GW, GH, r) {
  const t = new Uint8Array(GW * GH), o = new Uint8Array(GW * GH);
  for (let y = 0; y < GH; y++) { let last = -1e9; for (let x = 0; x < GW; x++) { if (g[y * GW + x]) last = x; if (x - last <= r) t[y * GW + x] = 1; } last = 1e9; for (let x = GW - 1; x >= 0; x--) { if (g[y * GW + x]) last = x; if (last - x <= r) t[y * GW + x] = 1; } }
  for (let x = 0; x < GW; x++) { let last = -1e9; for (let y = 0; y < GH; y++) { if (t[y * GW + x]) last = y; if (y - last <= r) o[y * GW + x] = 1; } last = 1e9; for (let y = GH - 1; y >= 0; y--) { if (t[y * GW + x]) last = y; if (last - y <= r) o[y * GW + x] = 1; } }
  return o;
}
// Coverage both ways on tiles: a lost tooth or a doubled line is local, a whole-picture share would hide it.
// -> {kapsama, kesinlik} overall and the worst tile's (tiles with at least 1% ink on either side).
function agreement(a, b, GW, GH, r, tile) {
  const da = dilate(a, GW, GH, r), db = dilate(b, GW, GH, r), tw = Math.ceil(GW / tile), th = Math.ceil(GH / tile);
  const T = Array.from({ length: tw * th }, () => [0, 0, 0, 0]);
  let na = 0, nb = 0, ca = 0, cb = 0;
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
    const i = y * GW + x, t = T[Math.floor(y / tile) * tw + Math.floor(x / tile)];
    if (a[i]) { na++; t[0]++; if (db[i]) { ca++; t[1]++; } }
    if (b[i]) { nb++; t[2]++; if (da[i]) { cb++; t[3]++; } }
  }
  let worst = 1;
  for (const [ta, tca, tb, tcb] of T) {
    if (Math.max(ta, tb) < tile * tile * 0.01) continue;
    worst = Math.min(worst, ta ? tca / ta : 0, tb ? tcb / tb : 0);
  }
  return { kapsama: na ? ca / na : 0, kesinlik: nb ? cb / nb : 0, enKotuParca: worst };
}
// Correlation of the two ink maps averaged over 4 x 4 cells and softened 3 x 3 (1 = same structure).
function structure(a, b, GW, GH) {
  const w = Math.ceil(GW / 4), h = Math.ceil(GH / 4), pool = g => { const o = new Float32Array(w * h); for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) o[(y >> 2) * w + (x >> 2)] += g[y * GW + x] / 16; return o; };
  const blur = g => { const o = new Float32Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0, n = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const X = x + dx, Y = y + dy; if (X >= 0 && Y >= 0 && X < w && Y < h) { s += g[Y * w + X]; n++; } } o[y * w + x] = s / n; } return o; };
  const A = blur(pool(a)), B = blur(pool(b)), n = A.length;
  const ma = A.reduce((s, v) => s + v, 0) / n, mb = B.reduce((s, v) => s + v, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (A[i] - ma) * (B[i] - mb); saa += (A[i] - ma) ** 2; sbb += (B[i] - mb) ** 2; }
  return saa && sbb ? Math.max(0, sab / Math.sqrt(saa * sbb)) : 0;
}
// source: PNG of the raster that was traced; pdf: the vector traced from it (any size). -> {gecti, olcum, esik, neden}
// Both on one frame of the source's ink box, its long side FRAME px; tolerance R px (0.2%) for edge placement.
async function vectorGate({ source, pdf, limits = GATE }) {
  const src = await decode(source, FRAME), ground = groundOf(src);
  const ms = inkMask(src, ground), bs = inkBox(ms, src.width, src.height);
  // Rendered at the source frame's size (not larger): this child runs on a 512 MB server (G74 measurement: 1.5x cost ~90 MB more).
  const page = await decode(await require('./vector').renderFirstPage(pdf, Math.max(src.width, src.height)));
  const mv = inkMask(page, ground), bv = inkBox(mv, page.width, page.height);
  if (!bs || !bv) return { gecti: false, olcum: {}, esik: limits, neden: bs ? 'Vektörde mürekkep yok' : 'Kaynakta mürekkep yok' };
  const GW = bs.w, GH = bs.h;
  const a = toFrame(ms, src.width, src.height, bs, GW, GH), b = toFrame(mv, page.width, page.height, bv, GW, GH);
  const ag = agreement(a, b, GW, GH, R, TILE), ince = structure(a, b, GW, GH);
  const r3 = v => +v.toFixed(3);
  const olcum = { kapsama: r3(ag.kapsama), kesinlik: r3(ag.kesinlik), ortusme: r3(Math.min(ag.kapsama, ag.kesinlik)), enKotuParca: r3(ag.enKotuParca), ince: r3(ince),
    oranFarki: r3(Math.abs((bv.w / bv.h) / (bs.w / bs.h) - 1)) };
  const neden = [], kaynakPx = Math.max(src.srcWidth, src.srcHeight);
  // Below this the curves of any vector are the tracer's guess, not the design (a 95 px cut-out at 19 cm).
  if (kaynakPx < limits.kaynakPx) neden.push(`kaynak ${kaynakPx} px (en az ${limits.kaynakPx} px)`);
  olcum.kaynakPx = kaynakPx;
  if (olcum.ortusme < limits.ortusme) neden.push(`biçim örtüşmesi %${Math.round(olcum.ortusme * 100)} (eşik %${Math.round(limits.ortusme * 100)})`);
  if (olcum.enKotuParca < limits.parca) neden.push(`en kötü parça %${Math.round(olcum.enKotuParca * 100)} (eşik %${Math.round(limits.parca * 100)})`);
  if (olcum.ince < limits.ince) neden.push(`ince yapı ${olcum.ince} (eşik ${limits.ince})`);
  if (olcum.oranFarki > limits.oran) neden.push(`en/boy oranı %${Math.round(olcum.oranFarki * 100)} bozuk`);
  return { gecti: !neden.length, olcum, esik: limits, neden: neden.join('; ') || null };
}


// True when the ratio is the gate's only objection (the shape itself is faithful).
function onlyAspect(kapi, limits = GATE) {
  const m = kapi?.olcum || {};
  return !kapi?.gecti && m.oranFarki > limits.oran && m.ortusme >= limits.ortusme && m.enKotuParca >= limits.parca && m.ince >= limits.ince && m.kaynakPx >= limits.kaynakPx;
}

// ---- inks ------------------------------------------------------------------------------------------------
// Coverage 0..255 of every pixel: alpha on a transparent ground, else the distance from the ground colour (35 -> 0, 90 -> 255).
function coverage(p, ground) {
  const { width: W, height: H, data: d } = p, a = new Uint8Array(W * H);
  for (let k = 0, i = 0; k < W * H; k++, i += 4) {
    if (!ground) { a[k] = d[i + 3]; continue; }
    const dist = Math.hypot(d[i] - ground[0], d[i + 1] - ground[1], d[i + 2] - ground[2]);
    a[k] = d[i + 3] < 128 ? 0 : dist <= 35 ? 0 : dist >= 90 ? 255 : Math.round((dist - 35) / 55 * 255);
  }
  return a;
}
// Interior pixels: fully covered, and so are their four neighbours. An edge pixel can be fully opaque yet carry the
// old ground in its colour (a cream line drawn on black, its ground made transparent: a grey rim).
function interior(cover, W, H) {
  const m = new Uint8Array(W * H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const k = y * W + x;
    if (cover[k] >= 250 && cover[k - 1] >= 250 && cover[k + 1] >= 250 && cover[k - W] >= 250 && cover[k + W] >= 250) m[k] = 1;
  }
  return m;
}
// The design's inks: colours of the interior pixels in 5-bit buckets, the most used first, each one at
// least MERGE away from the ones taken and holding 1% of the solid pixels; then three k-means rounds. Edge blends
// between two inks are spread over many small buckets and do not become an ink of their own. -> [[r,g,b], ...]
const MERGE = 64;
function inksOf(p, cover, inner = interior(cover, p.width, p.height)) {
  const d = p.data, bins = new Map();
  let solid = 0;
  for (let k = 0; k < cover.length; k++) {
    if (!inner[k]) continue;
    const i = k * 4, key = (d[i] >> 3) << 10 | (d[i + 1] >> 3) << 5 | (d[i + 2] >> 3);
    let b = bins.get(key); if (!b) bins.set(key, b = [0, 0, 0, 0]);
    b[0] += d[i]; b[1] += d[i + 1]; b[2] += d[i + 2]; b[3]++; solid++;
  }
  const inks = [];
  for (const b of [...bins.values()].sort((x, y) => y[3] - x[3])) {
    if (b[3] < solid * 0.01 || inks.length >= MAX_INKS) break;
    const c = [b[0] / b[3], b[1] / b[3], b[2] / b[3]];
    if (inks.every(o => Math.hypot(o[0] - c[0], o[1] - c[1], o[2] - c[2]) >= MERGE)) inks.push(c);
  }
  if (!inks.length) return [];
  for (let round = 0; round < 3; round++) {
    const sum = inks.map(() => [0, 0, 0, 0]);
    for (const b of bins.values()) { const c = [b[0] / b[3], b[1] / b[3], b[2] / b[3]], s = sum[nearest(inks, c[0], c[1], c[2])]; s[0] += b[0]; s[1] += b[1]; s[2] += b[2]; s[3] += b[3]; }
    sum.forEach((s, j) => { if (s[3]) inks[j] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]; });
  }
  // An ink whose pixels nearly all sit on an edge (next to the ground or another ink) is a blend (anti-aliasing, JPEG
  // noise on thin strokes): it joins its nearest ink. The largest ink always stays.
  if (inks.length > 1) {
    const W = p.width, H = p.height, idx = new Int8Array(cover.length).fill(-1), n = inks.map(() => 0), core = inks.map(() => 0);
    for (let k = 0; k < cover.length; k++) if (cover[k] >= 128) idx[k] = nearest(inks, d[k * 4], d[k * 4 + 1], d[k * 4 + 2]);
    for (let k = 0; k < cover.length; k++) {
      const j = idx[k]; if (j < 0) continue;
      n[j]++;
      const x = k % W;
      if (x > 0 && x < W - 1 && k >= W && k < W * (H - 1) && idx[k - 1] === j && idx[k + 1] === j && idx[k - W] === j && idx[k + W] === j) core[j]++;
    }
    const largest = n.indexOf(Math.max(...n));
    const kept = inks.filter((_, j) => j === largest || (n[j] && core[j] / n[j] >= 0.25));
    inks.splice(0, inks.length, ...kept);
  }
  return inks.map(c => c.map(Math.round));
}
function nearest(inks, r, g, b) {
  let best = 0, bd = Infinity;
  for (let j = 0; j < inks.length; j++) { const e = (inks[j][0] - r) ** 2 + (inks[j][1] - g) ** 2 + (inks[j][2] - b) ** 2; if (e < bd) { bd = e; best = j; } }
  return best;
}
// Every pixel becomes one ink, its coverage kept as alpha (the edge's sub-pixel position; under 128 it is transparent).
// An edge pixel carries the ground in its colour, so it takes the ink of its interior neighbours (within 3 px),
// not its own nearest ink: no grey fleck along a white stroke. -> {width, height, data (RGBA), inks, box (ink box) | null}
async function cleanInks(buffer) {
  const p = await decode(buffer), ground = groundOf(p), cover = coverage(p, ground), W = p.width, H = p.height, inner = interior(cover, W, H);
  const inks = inksOf(p, cover, inner), d = p.data, out = new Uint8ClampedArray(d.length), idx = new Int8Array(W * H).fill(-1);
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  if (!inks.length) return { width: W, height: H, data: out, inks, box: null };
  for (let k = 0; k < cover.length; k++) if (inner[k]) idx[k] = nearest(inks, d[k * 4], d[k * 4 + 1], d[k * 4 + 2]);
  const votes = new Uint32Array(inks.length);
  for (let k = 0; k < cover.length; k++) {
    if (!cover[k]) continue;
    let j = idx[k];
    if (j < 0) {
      const x = k % W, y = (k - x) / W;
      for (let r = 1; r <= 3 && j < 0; r++) {
        votes.fill(0);
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
          const X = x + dx, Y = y + dy;
          if (X >= 0 && Y >= 0 && X < W && Y < H && idx[Y * W + X] >= 0) votes[idx[Y * W + X]]++;
        }
        let best = -1; for (let n = 0; n < inks.length; n++) if (votes[n] && (best < 0 || votes[n] > votes[best])) best = n;
        j = best;
      }
      if (j < 0) j = nearest(inks, d[k * 4], d[k * 4 + 1], d[k * 4 + 2]);
    }
    const i = k * 4, c = inks[j];
    out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = cover[k];
    if (cover[k] >= 128) { const x = k % W, y = (k - x) / W; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return { width: W, height: H, data: out, inks, box: x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } };
}
async function cleanPng(buffer) {
  const c = await cleanInks(buffer);
  if (!c.box) return null;
  const cv = canvasLib().createCanvas(c.width, c.height);
  cv.getContext('2d').putImageData(new (canvasLib().ImageData)(c.data, c.width, c.height), 0, 0);
  return { buffer: cv.toBuffer('image/png'), inks: c.inks.length };
}

// ---- very high resolution PNG ------------------------------------------------------------------------------
// Physical size of the design inside the print box at its own ratio (contain), and the pixels for PNG_DPI / PNG_MIN_EDGE.
// Pixel budget (DESEN_PNG_MP, million pixels, default 100): rows are made in bands so memory hardly grows with size, but
// time does; a print so large that 600 dpi passes the budget is made at the budget (never under PNG_MIN_EDGE px) and its
// dpi in the report says so. A 47.5 x 33 cm back print at 600 dpi is about 82 MP.
const budget = (env = process.env) => { const n = Number(env.DESEN_PNG_MP); return (Number.isFinite(n) && n > 0 ? n : 100) * 1e6; };
function pngSize(boxW, boxH, widthMm, heightMm, env = process.env) {
  const ratio = boxW / boxH;
  const mmW = ratio >= widthMm / heightMm ? widthMm : heightMm * ratio, mmH = ratio >= widthMm / heightMm ? widthMm / ratio : heightMm;
  const longMm = Math.max(mmW, mmH), shortOf = long => long * Math.min(ratio, 1 / ratio);
  let longPx = Math.max(PNG_MIN_EDGE, Math.ceil(longMm / 25.4 * PNG_DPI));
  if (longPx * shortOf(longPx) > budget(env)) longPx = Math.max(PNG_MIN_EDGE, Math.floor(Math.sqrt(budget(env) / Math.min(ratio, 1 / ratio))));
  const W = ratio >= 1 ? longPx : Math.max(1, Math.ceil(longPx * ratio)), H = ratio >= 1 ? Math.max(1, Math.ceil(longPx / ratio)) : longPx; // ceil: the short side keeps the dpi too
  return { W, H, mmW, mmH, dpi: Math.floor(Math.min(W / (mmW / 25.4), H / (mmH / 25.4))) };
}
const INTER = 2048;
// source: the clean design raster; widthMm/heightMm: the print box. -> {png, pdf, width, height, dpi, inks, mm}
// The design (its ink box) is smoothly enlarged to an intermediate of up to INTER px (never below its own size), then
// every output pixel takes the bilinear coverage of that picture (>= 50%: ink) and the ink most of its four neighbours carry.
async function highResPng({ source, widthMm, heightMm }) {
  if (![widthMm, heightMm].every(v => Number.isFinite(v) && v > 0)) throw new TypeError('Baskı ölçüsü gerekli');
  const clean = await cleanInks(source);
  if (!clean.box) throw new Error('Desende mürekkep yok');
  const { box, inks } = clean, size = pngSize(box.w, box.h, widthMm, heightMm);
  // Intermediate: the ink box with a 1 px transparent margin, enlarged with high quality smoothing (soft edges to threshold).
  const pad = 1, sw = box.w + 2 * pad, sh = box.h + 2 * pad;
  const srcCanvas = canvasLib().createCanvas(sw, sh);
  { const full = canvasLib().createCanvas(clean.width, clean.height); full.getContext('2d').putImageData(new (canvasLib().ImageData)(clean.data, clean.width, clean.height), 0, 0);
    srcCanvas.getContext('2d').drawImage(full, box.x - pad, box.y - pad, sw, sh, 0, 0, sw, sh); full.width = full.height = 0; }
  clean.data = null; // the full-size clean picture is no longer needed (memory: see vectorGate)
  const k = Math.max(1, Math.min(INTER / Math.max(sw, sh), Math.max(size.W, size.H) / Math.max(sw, sh)));
  const iw = Math.max(sw, Math.round(sw * k)), ih = Math.max(sh, Math.round(sh * k));
  const inter = canvasLib().createCanvas(iw, ih), ictx = inter.getContext('2d');
  ictx.imageSmoothingEnabled = true; ictx.imageSmoothingQuality = 'high';
  ictx.drawImage(srcCanvas, 0, 0, iw, ih);
  const id = ictx.getImageData(0, 0, iw, ih).data, alpha = new Uint8Array(iw * ih), ink = new Uint8Array(iw * ih);
  for (let q = 0, i = 0; q < iw * ih; q++, i += 4) { alpha[q] = id[i + 3]; if (id[i + 3]) ink[q] = nearest(inks, id[i], id[i + 1], id[i + 2]); }
  inter.width = inter.height = 0; srcCanvas.width = srcCanvas.height = 0; // native canvas memory back before the rows are made
  global.gc?.();
  // The design's box inside the intermediate (the 1 px margin scaled).
  const ox = pad * iw / sw, oy = pad * ih / sh, bw = box.w * iw / sw, bh = box.h * ih / sh;
  const { W, H } = size, vote = new Float32Array(inks.length);
  // One output row (filter byte 0, then one palette index per pixel) written at off.
  const fill = (y, raw, off) => {
    const v = oy + (y + 0.5) / H * bh - 0.5, y0 = Math.max(0, Math.min(ih - 1, Math.floor(v))), y1 = Math.min(ih - 1, y0 + 1), fy = Math.max(0, Math.min(1, v - y0));
    const r0 = y0 * iw, r1 = y1 * iw, base = off + 1;
    for (let x = 0; x < W; x++) {
      const u = ox + (x + 0.5) / W * bw - 0.5, x0 = Math.max(0, Math.min(iw - 1, Math.floor(u))), x1 = Math.min(iw - 1, x0 + 1), fx = Math.max(0, Math.min(1, u - x0));
      const a00 = alpha[r0 + x0], a10 = alpha[r0 + x1], a01 = alpha[r1 + x0], a11 = alpha[r1 + x1];
      if (!(a00 | a10 | a01 | a11)) continue; // transparent (index 0)
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      if (a00 * w00 + a10 * w10 + a01 * w01 + a11 * w11 < 127.5) continue;
      const i00 = ink[r0 + x0], i10 = ink[r0 + x1], i01 = ink[r1 + x0], i11 = ink[r1 + x1];
      let best = i00;
      if (!(i00 === i10 && i00 === i01 && i00 === i11)) {
        vote.fill(0); vote[i00] += a00 * w00; vote[i10] += a10 * w10; vote[i01] += a01 * w01; vote[i11] += a11 * w11;
        for (let j = 0; j < inks.length; j++) if (vote[j] > vote[best]) best = j;
      }
      raw[base + x] = best + 1;
    }
  };
  const data = await deflateRows(H, W + 1, fill);
  const palette = [[0, 0, 0], ...inks];
  const png = encodePng({ W, H, palette, data, dpi: size.dpi });
  const pdf = await pngPdf({ W, H, palette, data, widthMm, heightMm, mmW: size.mmW, mmH: size.mmH });
  return { png, pdf, width: W, height: H, dpi: size.dpi, inks: inks.length, mm: { w: +size.mmW.toFixed(1), h: +size.mmH.toFixed(1) } };
}
// Rows are compressed in bands of about 4 MB: a 11000 x 7600 px back print never holds its 84 MB of rows at once.
async function deflateRows(H, row, fill) {
  const def = zlib.createDeflate({ level: 6 }), out = [];
  def.on('data', c => out.push(c));
  const done = new Promise((resolve, reject) => { def.on('end', resolve); def.on('error', reject); });
  const band = Math.max(1, Math.floor((4 << 20) / row));
  for (let y = 0; y < H; y += band) {
    const n = Math.min(band, H - y), buf = Buffer.alloc(n * row);
    for (let r = 0; r < n; r++) fill(y + r, buf, r * row);
    if (!def.write(buf)) await new Promise(resolve => def.once('drain', resolve));
  }
  def.end();
  await done;
  return Buffer.concat(out);
}
// CRC-32 of PNG chunks (zlib.crc32 needs Node 20.15; the engines field allows 20.0).
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(...bufs) { let c = 0xffffffff; for (const b of bufs) for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, body) {
  const len = Buffer.alloc(4), crc = Buffer.alloc(4), t = Buffer.from(type, 'latin1');
  len.writeUInt32BE(body.length); crc.writeUInt32BE(crc32(t, body));
  return Buffer.concat([len, t, body, crc]);
}
// Indexed PNG: index 0 is transparent (tRNS), the others the inks; pHYs carries the dpi.
function encodePng({ W, H, palette, data, dpi }) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 3;
  const phys = Buffer.alloc(9), ppm = Math.round(dpi / 0.0254); phys.writeUInt32BE(ppm, 0); phys.writeUInt32BE(ppm, 4); phys[8] = 1;
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('PLTE', Buffer.from(palette.flat())),
    chunk('tRNS', Buffer.from([0])), chunk('pHYs', phys)];
  for (let i = 0; i < data.length; i += 1 << 20) parts.push(chunk('IDAT', data.subarray(i, i + (1 << 20))));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}
// The same compressed rows as a PDF image (Flate + PNG predictor, indexed colours, index 0 masked) on a page of the
// print size, the design centred at its own ratio. Nothing is decoded or re-encoded.
async function pngPdf({ W, H, palette, data, widthMm, heightMm, mmW, mmH }) {
  const { PDFDocument, PDFName, PDFNumber, PDFHexString, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } = require('pdf-lib');
  const doc = await PDFDocument.create(), ctx = doc.context;
  const pw = widthMm * PT_PER_MM, ph = heightMm * PT_PER_MM, iw = mmW * PT_PER_MM, ih = mmH * PT_PER_MM;
  const page = doc.addPage([pw, ph]);
  const lookup = PDFHexString.of(Buffer.from(palette.flat()).toString('hex'));
  const image = ctx.stream(data, {
    Type: 'XObject', Subtype: 'Image', Width: W, Height: H, BitsPerComponent: 8,
    ColorSpace: ctx.obj([PDFName.of('Indexed'), PDFName.of('DeviceRGB'), PDFNumber.of(palette.length - 1), lookup]),
    Filter: 'FlateDecode', DecodeParms: { Predictor: 15, Colors: 1, BitsPerComponent: 8, Columns: W }, Mask: [0, 0],
  });
  const name = page.node.newXObject('Desen', ctx.register(image));
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(iw, 0, 0, ih, (pw - iw) / 2, (ph - ih) / 2), drawObject(name), popGraphicsState());
  doc.setTitle('Desen (yüksek çözünürlüklü görsel, vektör değil)');
  return Buffer.from(await doc.save());
}

module.exports = { vectorGate, onlyAspect, highResPng, cleanInks, cleanPng, pngSize, GATE, PNG_DPI, PNG_MIN_EDGE, PT_PER_MM, decode, groundOf, inkMask };
