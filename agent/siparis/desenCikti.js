'use strict';
// G74: what leaves for the workshop for one print (Patron 22.11: "vektörel hale getirme işi hiç olmuyorsa çözünürlüğü çok
// yüksek bir şekilde atsın, neredeyse vektörel gibi").
//   vectorGate: a traced vector goes only when it is faithful to the raster it was traced from. Both are reduced to their
//               ink, laid on one grid (each to its own ink box) and compared: coverage both ways (missing strokes, extra or
//               doubled strokes) and fine structure. Thresholds in GATE, fixed by test/siparis-desen-cikti.test.js.
//   highResPng: always, and the only design file when the gate fails: a transparent indexed PNG, at least PNG_DPI at
//               print size and PNG_MIN_EDGE px on its long edge; every pixel is one of the design's inks or transparent
//               (sharp edges per colour, no blurred enlargement); pngPdf embeds it at print size without decoding it.
// Runs in one-shot render children (documents.js generateInChild "desenCikti" = gate + picture, "desenPng", "temizCizim"), each watched for
// memory by the server (DESEN_COCUK_MB). PNG pixels are read with pngjs and worked on in typed arrays; the gate draws the
// vector's own paths on a canvas (drawPdf) instead of loading pdf.js (~216 MB on its own, G74 measurement).
const zlib = require('zlib');
const canvasLib = () => require('@napi-rs/canvas');

const PNG_DPI = 600, PNG_MIN_EDGE = 6000;
const GATE = { ortusme: 0.95, parca: 0.6, ince: 0.9, oran: 0.03, kaynakPx: 1000 };
const FRAME = 2048, R = 1, TILE = 64, MAX_INKS = 8;
const PT_PER_MM = 72 / 25.4;

// RGBA pixels; a PNG is read by pngjs (no native canvas), anything else or a PNG above maxEdge by the canvas.
async function decode(buffer, maxEdge = 0) {
  if (buffer[0] === 0x89 && buffer[1] === 0x50) {
    const p = require('pngjs').PNG.sync.read(buffer);
    if (!maxEdge || Math.max(p.width, p.height) <= maxEdge) return { width: p.width, height: p.height, data: p.data, srcWidth: p.width, srcHeight: p.height };
  }
  const img = await canvasLib().loadImage(buffer);
  const k = maxEdge ? Math.min(1, maxEdge / Math.max(img.width, img.height)) : 1;
  const w = Math.max(1, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k));
  const c = canvasLib().createCanvas(w, h), ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  c.width = c.height = 0;
  return { width: w, height: h, data, srcWidth: img.width, srcHeight: img.height };
}
// The design's ground, decided as the tracer decides it (vector.js: a near-white margin is paper, see pixelBounds and
// tracedGround): a transparent picture has none (alpha); a near-white edge (all channels >= 235) is paper; an edge in a
// colour of its own is ink (an opaque badge filling its picture: the review's navy crest lost its navy). An edge without one
// colour (under 60% of its pixels within 40 of the median) cannot be told: belirsiz, and no picture is made from it.
const PAPER = 235;
function groundInfo(p) {
  const { width: W, height: H, data: d } = p;
  let low = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 200) low++;
  if (low > W * H * 0.05) return { ground: null, saydam: true };
  const ring = [];
  for (let x = 0; x < W; x++) ring.push(x, (H - 1) * W + x);
  for (let y = 1; y < H - 1; y++) ring.push(y * W, y * W + W - 1);
  const med = c => { const v = ring.map(k => d[k * 4 + c]).sort((a, b) => a - b); return v[v.length >> 1]; };
  const m = [med(0), med(1), med(2)];
  const near = ring.filter(k => Math.abs(d[k * 4] - m[0]) <= 40 && Math.abs(d[k * 4 + 1] - m[1]) <= 40 && Math.abs(d[k * 4 + 2] - m[2]) <= 40).length;
  if (near < ring.length * 0.6) return { ground: null, belirsiz: true, kenar: m };
  return Math.min(...m) >= PAPER ? { ground: m } : { ground: null, kenar: m };
}
const groundOf = p => groundInfo(p).ground;
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
  // Two flat maps (one colour filling its whole box, G74 review): the same map is the same structure.
  if (!saa && !sbb) return Math.abs(ma - mb) < 1e-6 ? 1 : 0;
  return saa && sbb ? Math.max(0, sab / Math.sqrt(saa * sbb)) : 0;
}
// The page of one of our own vector PDFs drawn on a canvas, its long edge near longEdge px, transparent ground. Only the
// path operators our tracer and pdf-lib write are known (q Q cm, m l c v y h re, f f* B b S s n, W W*, colours, gs w);
// anything else (text, images, patterns) throws CIZILEMEDI and the gate counts the vector as not passed.
async function drawPdf(pdf, longEdge) {
  const { PDFDocument, PDFArray, PDFRawStream, decodePDFRawStream } = require('pdf-lib');
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const page = doc.getPage(0), box = page.getMediaBox();
  const s = longEdge / Math.max(box.width, box.height), W = Math.max(1, Math.round(box.width * s)), H = Math.max(1, Math.round(box.height * s));
  const contents = page.node.Contents();
  const streams = !contents ? [] : contents instanceof PDFArray ? contents.asArray().map(r => doc.context.lookup(r)) : [contents];
  let text = '';
  for (const st of streams) text += Buffer.from(st instanceof PDFRawStream ? decodePDFRawStream(st).decode() : st.getContents()).toString('latin1') + '\n';
  const c = canvasLib().createCanvas(W, H), ctx = c.getContext('2d');
  ctx.setTransform(s, 0, 0, -s, -box.x * s, (box.y + box.height) * s);
  paint(ctx, text);
  const data = ctx.getImageData(0, 0, W, H).data;
  c.width = c.height = 0;
  return { width: W, height: H, data };
}
const unsupported = what => Object.assign(new Error(`Vektör kapıda çizilemedi (${what})`), { code: 'CIZILEMEDI' });
function paint(ctx, text) {
  const { Path2D } = canvasLib();
  const v = x => Math.round(Math.max(0, Math.min(1, x)) * 255);
  const colour = a => a.length === 1 ? `rgb(${v(a[0])},${v(a[0])},${v(a[0])})` : a.length === 3 ? `rgb(${v(a[0])},${v(a[1])},${v(a[2])})`
    : a.length === 4 ? `rgb(${v((1 - a[0]) * (1 - a[3]))},${v((1 - a[1]) * (1 - a[3]))},${v((1 - a[2]) * (1 - a[3]))})` : null;
  let stack = [], path = new Path2D(), cur = [0, 0], clip = null, inArray = false;
  const end = () => { if (clip) { ctx.clip(path, clip); clip = null; } path = new Path2D(); };
  for (const [t] of text.matchAll(/%[^\r\n]*|\/[^\s/\[\]()<>{}%]*|[+-]?(?:\d+\.?\d*|\.\d+)|[A-Za-z'"*]+|<<|>>|[[\]()<>{}]/g)) {
    if (t[0] === '%') continue;
    if (t === '[') { inArray = true; continue; }
    if (t === ']') { inArray = false; stack.push('[]'); continue; }
    if (inArray) continue;
    if (['(', '<', '<<', '{'].includes(t)) throw unsupported('metin ya da sözlük');
    if (t[0] === '/' || /^[+\-.\d]/.test(t)) { stack.push(t); continue; }
    const a = stack.filter(x => x[0] !== '/' && x !== '[]').map(Number), named = stack.some(x => x[0] === '/');
    switch (t) {
      case 'q': ctx.save(); break;
      case 'Q': ctx.restore(); break;
      case 'cm': ctx.transform(a[0], a[1], a[2], a[3], a[4], a[5]); break;
      case 'm': path.moveTo(a[0], a[1]); cur = [a[0], a[1]]; break;
      case 'l': path.lineTo(a[0], a[1]); cur = [a[0], a[1]]; break;
      case 'c': path.bezierCurveTo(a[0], a[1], a[2], a[3], a[4], a[5]); cur = [a[4], a[5]]; break;
      case 'v': path.bezierCurveTo(cur[0], cur[1], a[0], a[1], a[2], a[3]); cur = [a[2], a[3]]; break;
      case 'y': path.bezierCurveTo(a[0], a[1], a[2], a[3], a[2], a[3]); cur = [a[2], a[3]]; break;
      case 'h': path.closePath(); break;
      case 're': path.rect(a[0], a[1], a[2], a[3]); cur = [a[0], a[1]]; break;
      case 'f': case 'F': ctx.fill(path, 'nonzero'); end(); break;
      case 'f*': ctx.fill(path, 'evenodd'); end(); break;
      case 'B': case 'b': if (t === 'b') path.closePath(); ctx.fill(path, 'nonzero'); ctx.stroke(path); end(); break;
      case 'B*': case 'b*': if (t === 'b*') path.closePath(); ctx.fill(path, 'evenodd'); ctx.stroke(path); end(); break;
      case 'S': case 's': if (t === 's') path.closePath(); ctx.stroke(path); end(); break;
      case 'n': end(); break;
      case 'W': clip = 'nonzero'; break;
      case 'W*': clip = 'evenodd'; break;
      case 'rg': case 'g': case 'k': case 'sc': case 'scn': if (named || !colour(a)) throw unsupported('desen dolgusu'); ctx.fillStyle = colour(a); break;
      case 'RG': case 'G': case 'K': case 'SC': case 'SCN': if (named || !colour(a)) throw unsupported('desen çizgisi'); ctx.strokeStyle = colour(a); break;
      case 'w': ctx.lineWidth = a[0]; break;
      case 'cs': case 'CS': case 'gs': case 'J': case 'j': case 'M': case 'd': case 'ri': case 'i': break;
      default: throw unsupported(t);
    }
    stack = [];
  }
}
// Ink class of every frame pixel (-1: no ink): the nearest of the source's inks, sampled like toFrame.
function classFrame(m, p, box, GW, GH, inks) {
  const { width: W, height: H, data: d } = p, g = new Int8Array(GW * GH).fill(-1);
  for (let y = 0; y < GH; y++) {
    const sy = Math.min(H - 1, Math.floor(box.y + (y + 0.5) / GH * box.h)) * W;
    for (let x = 0; x < GW; x++) {
      const k = sy + Math.min(W - 1, Math.floor(box.x + (x + 0.5) / GW * box.w));
      if (m[k]) g[y * GW + x] = nearest(inks, d[k * 4], d[k * 4 + 1], d[k * 4 + 2]);
    }
  }
  return g;
}
// source: the raster that was traced; pdf: the vector traced from it (any size). -> {gecti, olcum, esik, neden}
// Both on one frame of the source's ink box (its own pixels, up to FRAME); tolerance R px for edge placement. The ink as a
// whole and every ink colour holding 1% of it are compared on their own: a white lettering lost on a navy badge is a
// missing colour, not missing ink (G74 review).
async function vectorGate({ source, pdf, limits = GATE }) {
  const src = await decode(source, FRAME), gi = groundInfo(src), r3 = v => +v.toFixed(3);
  const kaynakPx = Math.max(src.srcWidth, src.srcHeight);
  if (gi.belirsiz) return { gecti: false, olcum: { kaynakPx }, esik: limits, neden: 'desenin zemini belirsiz (kenar rengi karışık)' };
  const ground = gi.ground, ms = inkMask(src, ground), bs = inkBox(ms, src.width, src.height);
  let page;
  try { page = await drawPdf(pdf, Math.max(src.width, src.height)); }
  catch (e) { if (e.code !== 'CIZILEMEDI') throw e; return { gecti: false, olcum: { kaynakPx }, esik: limits, neden: e.message }; }
  const mv = inkMask(page, ground), bv = inkBox(mv, page.width, page.height);
  if (!bs || !bv) return { gecti: false, olcum: { kaynakPx }, esik: limits, neden: bs ? 'Vektörde mürekkep yok' : 'Kaynakta mürekkep yok' };
  const GW = bs.w, GH = bs.h;
  const a = toFrame(ms, src.width, src.height, bs, GW, GH), b = toFrame(mv, page.width, page.height, bv, GW, GH);
  const all = agreement(a, b, GW, GH, R, TILE);
  let worst = all.enKotuParca, ince = structure(a, b, GW, GH), colours = 1;
  const inks = inksOf(src, coverage(src, ground));
  if (inks.length > 1) {
    const ca = classFrame(ms, src, bs, GW, GH, inks), cb = classFrame(mv, page, bv, GW, GH, inks), inkCount = a.reduce((n, v) => n + v, 0);
    colours = 0;
    for (let j = 0; j < inks.length; j++) {
      const aj = ca.map(v => (v === j ? 1 : 0)), bj = cb.map(v => (v === j ? 1 : 0));
      if (aj.reduce((n, v) => n + v, 0) < inkCount * 0.01) continue;
      colours++;
      const ag = agreement(aj, bj, GW, GH, R, TILE);
      worst = Math.min(worst, ag.enKotuParca, ag.kapsama, ag.kesinlik);
      ince = Math.min(ince, structure(aj, bj, GW, GH));
    }
  }
  page = null;
  const olcum = { kapsama: r3(all.kapsama), kesinlik: r3(all.kesinlik), ortusme: r3(Math.min(all.kapsama, all.kesinlik)), enKotuParca: r3(worst), ince: r3(ince),
    renk: colours, oranFarki: r3(Math.abs((bv.w / bv.h) / (bs.w / bs.h) - 1)), kaynakPx };
  const neden = [];
  // Below this the curves of any vector are the tracer's guess, not the design (a 95 px cut-out at 19 cm).
  if (kaynakPx < limits.kaynakPx) neden.push(`kaynak ${kaynakPx} px (en az ${limits.kaynakPx} px)`);
  if (olcum.ortusme < limits.ortusme) neden.push(`biçim örtüşmesi %${Math.round(olcum.ortusme * 100)} (eşik %${Math.round(limits.ortusme * 100)})`);
  if (olcum.enKotuParca < limits.parca) neden.push(`en kötü parça ya da renk %${Math.round(olcum.enKotuParca * 100)} (eşik %${Math.round(limits.parca * 100)})`);
  if (olcum.ince < limits.ince) neden.push(`ince yapı ${olcum.ince} (eşik ${limits.ince})`);
  if (olcum.oranFarki > limits.oran) neden.push(`en/boy oranı %${Math.round(olcum.oranFarki * 100)} bozuk`);
  return { gecti: !neden.length, olcum, esik: limits, neden: neden.join('; ') || null };
}

// The design at its own ratio inside the print box (contain), to 0.1 mm. -> {w, h}
function containMm(ratio, box) {
  const w = ratio >= box.w / box.h ? box.w : box.h * ratio, h = ratio >= box.w / box.h ? box.w / ratio : box.h;
  return { w: +w.toFixed(1), h: +h.toFixed(1) };
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
// not its own nearest ink: no grey fleck along a white stroke. -> {W, H, cover, idx (ink per covered pixel), inks, box | null}
function cleanMaps(p, ground) {
  const W = p.width, H = p.height, d = p.data, cover = coverage(p, ground), inner = interior(cover, W, H);
  const inks = inksOf(p, cover, inner), idx = new Int8Array(W * H).fill(-1);
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  if (!inks.length) return { W, H, cover, idx, inks, box: null };
  for (let k = 0; k < cover.length; k++) if (inner[k]) idx[k] = nearest(inks, d[k * 4], d[k * 4 + 1], d[k * 4 + 2]);
  const votes = new Uint32Array(inks.length);
  for (let k = 0; k < cover.length; k++) {
    if (!cover[k] || idx[k] >= 0) { if (cover[k] >= 128) { const x = k % W, y = (k - x) / W; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } continue; }
    let j = -1;
    const x = k % W, y = (k - x) / W;
    for (let r = 1; r <= 3 && j < 0; r++) {
      votes.fill(0);
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const X = x + dx, Y = y + dy;
        if (X >= 0 && Y >= 0 && X < W && Y < H && inner[Y * W + X]) votes[idx[Y * W + X]]++;
      }
      for (let n = 0; n < inks.length; n++) if (votes[n] && (j < 0 || votes[n] > votes[j])) j = n;
    }
    idx[k] = j < 0 ? nearest(inks, d[k * 4], d[k * 4 + 1], d[k * 4 + 2]) : j;
    if (cover[k] >= 128) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return { W, H, cover, idx, inks, box: x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } };
}
const zeminBelirsiz = () => Object.assign(new Error('Desenin zemini belirsiz (kenar rengi karışık): kenarın baskıya dahil olup olmadığı gözle seçilmeli; yüksek çözünürlüklü görsel üretilmedi.'), { code: 'ZEMIN_BELIRSIZ' });
// The clean drawing as RGBA (the tracer's input). -> {width, height, data, inks, box}
async function cleanInks(buffer) {
  const p = await decode(buffer), gi = groundInfo(p);
  if (gi.belirsiz) throw zeminBelirsiz();
  const m = cleanMaps(p, gi.ground), out = new Uint8ClampedArray(m.W * m.H * 4);
  for (let k = 0; k < m.cover.length; k++) {
    if (!m.cover[k]) continue;
    const c = m.inks[m.idx[k]], i = k * 4;
    out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = m.cover[k];
  }
  return { width: m.W, height: m.H, data: out, inks: m.inks, box: m.box };
}
async function cleanPng(buffer) {
  let c;
  try { c = await cleanInks(buffer); } catch (e) { if (e.code === 'ZEMIN_BELIRSIZ') return null; throw e; }
  if (!c.box) return null;
  const { PNG } = require('pngjs'), png = new PNG({ width: c.width, height: c.height });
  png.data = Buffer.from(c.data.buffer, c.data.byteOffset, c.data.byteLength);
  return { buffer: PNG.sync.write(png), inks: c.inks.length };
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
const SMALL = 1024;
// source: the clean design raster; widthMm/heightMm: the print box; maxMp: a lower pixel budget (the server's retry).
// -> {png, pdf, width, height, dpi, inks, mm}. Every output pixel takes the bilinear coverage of the design (>= 50%: ink)
// and the ink most of its four neighbours carry. A design of SMALL px or more is sampled as it is; a smaller one (an eye
// cut-out) is first enlarged with high quality smoothing to SMALL..2*SMALL px so its edges are not the source's pixels.
async function highResPng({ source, widthMm, heightMm, maxMp = null }) {
  if (![widthMm, heightMm].every(v => Number.isFinite(v) && v > 0)) throw new TypeError('Baskı ölçüsü gerekli');
  let p = await decode(source);
  const gi = groundInfo(p);
  if (gi.belirsiz) throw zeminBelirsiz();
  let m = cleanMaps(p, gi.ground);
  p = null;
  global.gc?.(); // the decoded picture (RGBA) is not needed any more
  
  if (!m.box) throw new Error('Desende mürekkep yok');
  const { box, inks } = m, size = pngSize(box.w, box.h, widthMm, heightMm, maxMp ? { DESEN_PNG_MP: String(maxMp) } : process.env);
  // The sampled design: its ink box with a 1 px transparent margin, coverage (alpha) and ink index per pixel.
  const pad = 1, sw = box.w + 2 * pad, sh = box.h + 2 * pad;
  let iw = sw, ih = sh, alpha = new Uint8Array(sw * sh), ink = new Uint8Array(sw * sh);
  for (let y = 0; y < box.h; y++) for (let x = 0; x < box.w; x++) {
    const k = (box.y + y) * m.W + box.x + x, q = (y + pad) * sw + x + pad;
    alpha[q] = m.cover[k]; if (m.cover[k]) ink[q] = m.idx[k];
  }
  m = null;
  if (Math.max(sw, sh) < SMALL) {
    const k = Math.min(2 * SMALL / Math.max(sw, sh), Math.max(size.W, size.H) / Math.max(sw, sh));
    if (k > 1) {
      const small = canvasLib().createCanvas(sw, sh), sctx = small.getContext('2d'), img = sctx.createImageData(sw, sh);
      for (let q = 0; q < sw * sh; q++) { if (!alpha[q]) continue; const c = inks[ink[q]]; img.data.set([c[0], c[1], c[2], alpha[q]], q * 4); }
      sctx.putImageData(img, 0, 0);
      iw = Math.round(sw * k); ih = Math.round(sh * k);
      const big = canvasLib().createCanvas(iw, ih), bctx = big.getContext('2d');
      bctx.imageSmoothingEnabled = true; bctx.imageSmoothingQuality = 'high';
      bctx.drawImage(small, 0, 0, iw, ih);
      const id = bctx.getImageData(0, 0, iw, ih).data;
      alpha = new Uint8Array(iw * ih); ink = new Uint8Array(iw * ih);
      for (let q = 0, i = 0; q < iw * ih; q++, i += 4) { alpha[q] = id[i + 3]; if (id[i + 3]) ink[q] = nearest(inks, id[i], id[i + 1], id[i + 2]); }
      small.width = small.height = 0; big.width = big.height = 0;
    }
  }
  global.gc?.();
  // The design's box inside the sampled picture (the 1 px margin scaled).
  const ox = pad * iw / sw, oy = pad * ih / sh, bw = box.w * iw / sw, bh = box.h * ih / sh;
  const { W, H } = size, vote = new Float32Array(inks.length);
  // The source columns and weights of every output column are the same on every row: worked out once.
  const X0 = new Int32Array(W), X1 = new Int32Array(W), FX = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    const u = ox + (x + 0.5) / W * bw - 0.5, x0 = Math.max(0, Math.min(iw - 1, Math.floor(u)));
    X0[x] = x0; X1[x] = Math.min(iw - 1, x0 + 1); FX[x] = Math.max(0, Math.min(1, u - x0));
  }
  // One output row (filter byte 0, then one palette index per pixel) written at off.
  const fill = (y, raw, off) => {
    const v = oy + (y + 0.5) / H * bh - 0.5, y0 = Math.max(0, Math.min(ih - 1, Math.floor(v))), y1 = Math.min(ih - 1, y0 + 1), fy = Math.max(0, Math.min(1, v - y0));
    const r0 = y0 * iw, r1 = y1 * iw, base = off + 1;
    for (let x = 0; x < W; x++) {
      const x0 = X0[x], x1 = X1[x], fx = FX[x];
      const a00 = alpha[r0 + x0], a10 = alpha[r0 + x1], a01 = alpha[r1 + x0], a11 = alpha[r1 + x1];
      if (!(a00 | a10 | a01 | a11)) continue; // transparent (index 0)
      if ((a00 & a10 & a01 & a11) === 255 && ink[r0 + x0] === ink[r0 + x1] && ink[r0 + x0] === ink[r1 + x0] && ink[r0 + x0] === ink[r1 + x1]) { raw[base + x] = ink[r0 + x0] + 1; continue; } // inside one ink
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
// Rows are compressed in bands of about 1 MB through one reused buffer, synchronously: each band is a raw deflate segment
// ended by a sync flush (no final bit), the segments together are one deflate stream, closed by an empty final block and
// wrapped as zlib (header, Adler-32). No band waits in a queue or in the thread pool: a 11000 x 7600 px back print never
// holds its 84 MB of rows (G74 measurement: the streaming version still grew by ~40 MB).
async function deflateRows(H, row, fill) {
  const band = Math.max(1, Math.floor((1 << 20) / row)), buf = Buffer.alloc(band * row), out = [Buffer.from([0x78, 0x9c])];
  let a = 1, b = 0;
  for (let y = 0; y < H; y += band) {
    const n = Math.min(band, H - y), part = buf.subarray(0, n * row);
    part.fill(0);
    for (let r = 0; r < n; r++) fill(y + r, buf, r * row);
    for (let i = 0; i < part.length;) { const stop = Math.min(part.length, i + 5552); for (; i < stop; i++) { a += part[i]; b += a; } a %= 65521; b %= 65521; }
    out.push(zlib.deflateRawSync(part, { level: 6, finishFlush: zlib.constants.Z_SYNC_FLUSH }));
  }
  out.push(zlib.deflateRawSync(Buffer.alloc(0)));
  const tail = Buffer.alloc(4); tail.writeUInt32BE(((b << 16) | a) >>> 0);
  out.push(tail);
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

module.exports = { vectorGate, containMm, highResPng, cleanInks, cleanPng, pngSize, drawPdf, groundInfo, GATE, PNG_DPI, PNG_MIN_EDGE, PT_PER_MM, decode, groundOf, inkMask };
