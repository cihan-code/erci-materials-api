'use strict';

// Flat artwork (logos, lettering, emblems with one or two inks) is traced with potrace:
// every colour becomes a soft coverage mask, antialias pixels are split between the two
// colours they blend, the mask is upsampled and smoothed, then thresholded and traced.
// Straight edges stay straight, corners stay sharp, curves become Béziers. Multi-colour
// or photographic artwork stays on vtracer (vector.js decides).

// RGB distance an antialias or codec pixel may sit from its two-colour blend line.
const BLEND_RESIDUAL = 48;
// Share of pixels that may be neither a palette colour nor an edge blend next to one.
const MAX_NOISE_RATIO = 0.01;
// CIE76 Delta E in D65 Lab: alpha and antialias boundary mixtures are not inks.
function lab(rgb) {
  const [r,g,b] = rgb.map(v => {v/=255;return v>.04045 ? ((v+.055)/1.055)**2.4 : v/12.92;});
  const f = v => v>.008856 ? Math.cbrt(v) : 7.787*v+16/116;
  const x=f((.4124564*r+.3575761*g+.1804375*b)/.95047),
    y=f(.2126729*r+.7151522*g+.072175*b),z=f((.0193339*r+.119192*g+.9503041*b)/1.08883);
  return [116*y-16,500*(x-y),200*(y-z)];
}
const delta = (a,b) => Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);
let potraceLib;
// Lazy: the package loads Jimp, which the vtracer path never needs.
function potrace() {
  return potraceLib ||= { Potrace: require('potrace').Potrace, Bitmap: require('potrace/lib/types/Bitmap') };
}

// Best explanation of v as one colour or a blend of two: [i, j, t, residual].
function blend(r, g, b, colors) {
  let bi = 0, bj = 0, bt = 0, best = Infinity;
  for (let i = 0; i < colors.length; i++) {
    const c = colors[i], d = Math.hypot(r-c[0], g-c[1], b-c[2]);
    if (d < best) { best = d; bi = bj = i; bt = 0; }
  }
  for (let i = 0; i < colors.length; i++) for (let j = i+1; j < colors.length; j++) {
    const a = colors[i], c = colors[j], ex = c[0]-a[0], ey = c[1]-a[1], ez = c[2]-a[2], l = ex*ex+ey*ey+ez*ez;
    if (l < 1) continue;
    const t = Math.min(1, Math.max(0, ((r-a[0])*ex+(g-a[1])*ey+(b-a[2])*ez)/l));
    const d = Math.hypot(r-a[0]-t*ex, g-a[1]-t*ey, b-a[2]-t*ez);
    // A pure colour wins ties; a blend must explain the pixel clearly better.
    if (d < best - 0.5) { best = d; bi = i; bj = j; bt = t; }
  }
  return [bi, bj, bt, best];
}

// Soft membership (0..255) of every pixel in each colour, plus the transparent ground.
function memberships(pixels, width, height, colors, transparent) {
  const n = width*height, soft = colors.map(() => new Uint8Array(n)), none = transparent ? new Uint8Array(n) : null;
  const pure = new Uint8Array(n), mixed = new Uint8Array(n);
  let unexplained = 0, visible = 0;
  for (let p = 0; p < n; p++) {
    const q = p*4;
    let alpha = transparent ? pixels[q+3]/255 : 1, r = pixels[q], g = pixels[q+1], b = pixels[q+2];
    if (!transparent && pixels[q+3] < 255) {
      // An opaque artwork's stray alpha is composited on paper, as the PDF renders it.
      const a = pixels[q+3]/255;
      r = r*a+255*(1-a); g = g*a+255*(1-a); b = b*a+255*(1-a);
    }
    if (alpha < 0.03) { none[p] = 255; pure[p] = 1; continue; }
    if (alpha > 0.97) alpha = 1;
    visible++;
    const [i, j, t, residual] = blend(r, g, b, colors);
    if (residual > BLEND_RESIDUAL) unexplained++;
    soft[i][p] += Math.round(255*alpha*(1-t));
    soft[j][p] += Math.round(255*alpha*t);
    if (none) none[p] = Math.max(0, 255-soft[i][p]-(i===j ? 0 : soft[j][p]));
    if (Math.max(alpha*(1-t), alpha*t, 1-alpha) >= 0.9) pure[p] = 1;
    else mixed[p] = 1;
  }
  return { soft, none, pure, mixed, unexplained, visible };
}

// Chebyshev dilation by radius r (separable running window).
function dilate(mask, width, height, r) {
  const tmp = new Uint8Array(mask.length), out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let v = 0;
    for (let d = Math.max(0, x-r); d <= Math.min(width-1, x+r) && !v; d++) v = mask[y*width+d];
    tmp[y*width+x] = v;
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let v = 0;
    for (let d = Math.max(0, y-r); d <= Math.min(height-1, y+r) && !v; d++) v = tmp[d*width+x];
    out[y*width+x] = v;
  }
  return out;
}

// Share of a cluster's pixels lying between pixels of colours a and b (5x5 window):
// an antialias or low-resolution ramp cluster, not an ink of its own.
function betweenRatio(pixels, width, height, ids, id, a, b) {
  const close = (q, c) => Math.hypot(pixels[q]-c[0], pixels[q+1]-c[1], pixels[q+2]-c[2]) <= 60;
  let count = 0, between = 0;
  for (let p = 0; p < ids.length; p++) {
    if (ids[p] !== id) continue;
    count++;
    const x = p%width, y = (p-x)/width;
    let nearA = false, nearB = false;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x+dx, yy = y+dy;
      if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
      const q = (yy*width+xx)*4;
      nearA ||= close(q, a); nearB ||= close(q, b);
    }
    if (nearA && nearB) between++;
  }
  return count ? between/count : 0;
}

/**
 * Classifies cropped artwork as flat. palette is perceptualPalette() of the same pixels.
 * Returns flat: null with a reason when vtracer should handle the artwork instead.
 */
function flatPalette(image, palette, { maxInks = 2, deltaE = 10 } = {}) {
  const { width, height, pixels, transparent } = image, n = width*height;
  let inks = palette.significant.map(c => ({ rgb: c.rgb.slice(0, 3), count: c.count, core: c.core,
    id: palette.clusters.indexOf(c)+1 }));
  if (!inks.length) return { flat: null, reason: 'renk_kumesi_yok' };
  let paper = null, paperCount = 0;
  if (!transparent) {
    // Paper is not an ink cluster, but vtracer paints it too; keep the same layers.
    const bins = new Map();
    for (let p = 0; p < n; p++) {
      const q = p*4;
      if (Math.min(pixels[q], pixels[q+1], pixels[q+2]) < 245) continue;
      paperCount++;
      const key = (pixels[q]>>2)*4096+(pixels[q+1]>>2)*64+(pixels[q+2]>>2), bin = bins.get(key);
      if (bin) bin.count++; else bins.set(key, { rgb: [pixels[q], pixels[q+1], pixels[q+2]], count: 1 });
    }
    if (paperCount >= n*0.005) paper = [...bins.values()].sort((a, b) => b.count-a.count)[0].rgb;
  }
  // Mostly-edge clusters on the blend line of two other colours are ramps (antialias,
  // screenshots, upscaled rasters); their pixels are split between those two colours.
  let ramps = 0;
  for (const ink of [...inks].sort((a, b) => a.core/a.count-b.core/b.count)) {
    if (ink.core/ink.count >= 0.25 || inks.length < 2 && !paper) continue;
    const others = inks.filter(c => c !== ink).map(c => c.rgb).concat(paper ? [paper] : []);
    const [i, j, t, residual] = blend(...ink.rgb, others);
    if (i === j || t < 0.05 || t > 0.95 || residual > BLEND_RESIDUAL/2) continue;
    if (betweenRatio(pixels, width, height, palette.ids, ink.id, others[i], others[j]) < 0.8) continue;
    inks = inks.filter(c => c !== ink); ramps++;
  }
  if (inks.length > maxInks) return { flat: null, reason: 'cok_renk', stats: { inks: inks.length, ramps } };
  const colors = inks.map(c => c.rgb);
  if (paper) {
    // Off-white ink just under the paper cut-off and the paper itself are one colour.
    const same = inks.findIndex(c => delta(lab(c.rgb), lab(paper)) <= deltaE);
    if (same < 0) colors.push(paper);
    else if (paperCount > inks[same].count) colors[same] = paper;
  }
  const m = memberships(pixels, width, height, colors, transparent);
  // Edge blends sit next to a pure colour; gradients and photo texture do not.
  const near = dilate(m.pure, width, height, 2);
  let orphan = 0;
  for (let p = 0; p < n; p++) if (m.mixed[p] && !near[p]) orphan++;
  const noiseRatio = m.visible ? (m.unexplained+orphan)/m.visible : 1;
  const stats = { inks: inks.length, ramps, unexplained: m.unexplained, orphanBlend: orphan, noiseRatio };
  if (!m.visible || noiseRatio > MAX_NOISE_RATIO) return { flat: null, reason: 'duz_renk_degil', stats };
  return { flat: { width, height, transparent, colors, soft: m.soft, none: m.none }, stats };
}

const hex = rgb => '#'+rgb.map(v => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();

function binomial(taps) {
  let row = [1];
  for (let i = 1; i < taps; i++) row = row.map((v, j) => v+(row[j-1] || 0)).concat(1);
  const sum = row.reduce((a, b) => a+b, 0);
  return row.map(v => v/sum);
}

// Bilinear upsample by k with pixel-centre alignment; blur() then smooths ~0.5 source px
// so codec noise and short raster steps do not become wobbles in the traced edge.
function upsample(soft, width, height, k) {
  const W = width*k, H = height*k, out = new Uint8Array(W*H);
  const x0 = new Int32Array(W), x1 = new Int32Array(W), fx = new Float32Array(W);
  for (let X = 0; X < W; X++) {
    const s = Math.min(width-1, Math.max(0, (X+0.5)/k-0.5)), f = Math.floor(s);
    x0[X] = f; x1[X] = Math.min(width-1, f+1); fx[X] = s-f;
  }
  for (let Y = 0; Y < H; Y++) {
    const s = Math.min(height-1, Math.max(0, (Y+0.5)/k-0.5)), y0 = Math.floor(s), y1 = Math.min(height-1, y0+1), fy = s-y0;
    const r0 = y0*width, r1 = y1*width, o = Y*W;
    for (let X = 0; X < W; X++) {
      const a = soft[r0+x0[X]], b = soft[r0+x1[X]], c = soft[r1+x0[X]], d = soft[r1+x1[X]], u = fx[X];
      out[o+X] = Math.round((a+(b-a)*u)*(1-fy)+(c+(d-c)*u)*fy);
    }
  }
  return { data: out, W, H };
}

function blur(data, W, H, k) {
  const kernel = binomial(4*k-1), r = kernel.length >> 1, tmp = new Uint8Array(data.length);
  for (let y = 0; y < H; y++) {
    const o = y*W;
    for (let x = 0; x < W; x++) {
      let v = 0;
      for (let d = -r; d <= r; d++) v += kernel[d+r]*data[o+Math.min(W-1, Math.max(0, x+d))];
      tmp[o+x] = Math.round(v);
    }
  }
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) {
    let v = 0;
    for (let d = -r; d <= r; d++) v += kernel[d+r]*tmp[Math.min(H-1, Math.max(0, y+d))*W+x];
    data[y*W+x] = Math.round(v);
  }
}

// Otsu over the edge ramps only (solid inside/outside would dominate the histogram),
// clamped near 50% coverage so the threshold cannot erode or swell a colour.
function otsu(data) {
  const hist = new Float64Array(256);
  for (let i = 0; i < data.length; i++) if (data[i] >= 16 && data[i] <= 239) hist[data[i]]++;
  let total = 0, sum = 0;
  for (let v = 0; v < 256; v++) { total += hist[v]; sum += v*hist[v]; }
  let w0 = 0, s0 = 0, best = -1, threshold = 128;
  for (let v = 0; v < 255; v++) {
    w0 += hist[v]; s0 += v*hist[v];
    const w1 = total-w0;
    if (!w0 || !w1) continue;
    const between = w0*w1*(s0/w0-(sum-s0)/w1)**2;
    if (between > best) { best = between; threshold = v+1; }
  }
  return Math.min(153, Math.max(102, threshold));
}

// Artwork cut by the crop continues past the page edge (replicated border), so potrace
// never rounds the corner where a shape meets the edge; the root <svg> clips the overhang.
const PAD = 2;
function traceLayer(soft, width, height, k, rgb) {
  const { Potrace, Bitmap } = potrace();
  const pw = width+2*PAD, ph = height+2*PAD, padded = new Uint8Array(pw*ph);
  for (let y = 0; y < ph; y++) {
    const row = Math.min(height-1, Math.max(0, y-PAD))*width;
    for (let x = 0; x < pw; x++) padded[y*pw+x] = soft[row+Math.min(width-1, Math.max(0, x-PAD))];
  }
  const { data, W, H } = upsample(padded, pw, ph, k);
  blur(data, W, H, k);
  const threshold = otsu(data);
  for (let i = 0; i < data.length; i++) data[i] = data[i] >= threshold ? 0 : 255;
  const bitmap = new Bitmap(1, 1);
  Object.assign(bitmap, { width: W, height: H, size: W*H, arrayBuffer: data.buffer, data });
  const tracer = new Potrace({ turdSize: 4*k*k, alphaMax: 1, optCurve: true, optTolerance: 0.2,
    threshold: 128, blackOnWhite: true });
  // potrace only reads luminance; feeding it directly avoids a Jimp RGBA copy of the mask.
  tracer._luminanceData = bitmap;
  tracer._imageLoaded = true;
  const tag = tracer.getPathTag(hex(rgb), { x: 1/k, y: 1/k });
  return { tag: tracer._pathlist.length ? tag : '', threshold, paths: tracer._pathlist.length };
}

/** Stacked layers: largest colour at the bottom; each layer covers every colour above it. */
function traceFlat(flat, { maxPixels = 6e6 } = {}) {
  const { width, height, transparent, colors, soft } = flat;
  const k = Math.max(1, Math.min(4, Math.floor(Math.sqrt(maxPixels/(width*height)))));
  const area = soft.map(s => s.reduce((a, v) => a+v, 0));
  const order = colors.map((_, i) => i).filter(i => area[i] > 0).sort((a, b) => area[b]-area[a]);
  const acc = new Uint8Array(width*height), tags = [], thresholds = [];
  let base = '';
  for (let l = order.length-1; l >= 0; l--) {
    const s = soft[order[l]];
    for (let p = 0; p < acc.length; p++) acc[p] = Math.min(255, acc[p]+s[p]);
    if (l === 0 && !transparent) {
      base = `<path d="M0 0H${width}V${height}H0Z" stroke="none" fill="${hex(colors[order[0]])}"/>\n`;
      thresholds.push(null);
      continue;
    }
    const layer = traceLayer(acc, width, height, k, colors[order[l]]);
    if (layer.tag) tags.push(layer.tag);
    thresholds.push(layer.threshold);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n`
    + `${base}<g transform="translate(${-PAD} ${-PAD})">\n${tags.reverse().join('\n')}\n</g>\n</svg>`;
  return { svg, upscale: k, thresholds: thresholds.reverse(), colors: order.map(i => hex(colors[i])) };
}

// Exact squared Euclidean distance transform (Felzenszwalb); zero where seed is set.
function distanceField(seed, width, height) {
  const field = new Float32Array(seed.length);
  for (let i = 0; i < seed.length; i++) field[i] = seed[i] ? 0 : 1e20;
  const size = Math.max(width, height), f = new Float64Array(size), out = new Float64Array(size);
  const v = new Int32Array(size), z = new Float64Array(size+1);
  function line(n) {
    let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (let q = 1; q < n; q++) {
      let s;
      do {
        const p = v[k]; s = ((f[q]+q*q)-(f[p]+p*p))/(2*(q-p));
        if (s <= z[k]) k--; else break;
      } while (k >= 0);
      k++; v[k] = q; z[k] = s; z[k+1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k+1] < q) k++;
      out[q] = (q-v[k])**2+f[v[k]];
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) f[x] = field[y*width+x];
    line(width);
    for (let x = 0; x < width; x++) field[y*width+x] = out[x];
  }
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = field[y*width+x];
    line(height);
    for (let y = 0; y < height; y++) field[y*width+x] = out[y];
  }
  return field;
}

// A localized defect reaches this far (source px) past the source edge and its deep
// core stays within NOTCH_EXTENT; longer deep runs are edge offsets, not notches.
const NOTCH_DEPTH = 0.5, NOTCH_EXTENT = 4, IOU_TOLERANCE = 0.5;

/**
 * Compares the vector, re-rasterized m times larger than the source, with the source
 * colour edges (bilinear iso-lines of the soft masks). All lengths are source pixels.
 * render(width, height) resolves to RGBA of the PDF page stretched to that size.
 */
async function flatQuality(flat, render, { maxPixels = 5e6 } = {}) {
  const { width, height, transparent, colors, soft, none } = flat;
  const m = Math.max(1, Math.min(4, Math.floor(Math.sqrt(maxPixels/(width*height)))));
  const W = width*m, H = height*m, N = W*H;
  const layers = transparent ? [...soft, none] : soft, labels = layers.length;
  // Source labels: argmax of the bilinear soft masks on the measurement grid.
  const source = new Uint8Array(N), best = new Uint8Array(N);
  for (let c = 0; c < labels; c++) {
    const { data } = upsample(layers[c], width, height, m);
    for (let i = 0; i < N; i++) if (!c || data[i] > best[i]) { best[i] = data[i]; source[i] = c; }
  }
  const pixels = await render(W, H), output = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const q = i*4, alpha = transparent ? pixels[q+3]/255 : 1;
    if (transparent && alpha < 0.5) { output[i] = labels-1; continue; }
    const [a, b, t] = blend(pixels[q], pixels[q+1], pixels[q+2], colors);
    output[i] = t < 0.5 ? a : b;
  }
  const inter = new Float64Array(labels), union = new Float64Array(labels);
  const boundary = new Uint8Array(N), mismatch = new Uint8Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y*W+x, s = source[i], o = output[i];
    if (s === o) inter[s]++;
    union[s]++; if (s !== o) { union[o]++; mismatch[i] = 1; }
    if ((x && source[i-1] !== s) || (x < W-1 && source[i+1] !== s)
      || (y && source[i-W] !== s) || (y < H-1 && source[i+W] !== s)) boundary[i] = 1;
  }
  const distance = distanceField(boundary, W, H);
  // Pixel centres sit half a grid step from the edge they straddle.
  const depthOf = i => (Math.sqrt(distance[i])+0.5)/m;
  let edgeDeviation = 0;
  const tolerated = new Float64Array(labels);
  for (let i = 0; i < N; i++) if (mismatch[i]) {
    const d = depthOf(i);
    if (d > edgeDeviation) edgeDeviation = d;
    // An antialiased raster fixes its edges to about half a pixel; closer disagreement is agreement.
    if (d <= IOU_TOLERANCE) { tolerated[source[i]]++; tolerated[output[i]]++; }
    // Deep cores: the part of a defect farther than NOTCH_DEPTH from the source edge.
    mismatch[i] = d > NOTCH_DEPTH ? 1 : 0;
  }
  // A compact deep core is a notch or bump; a long one is an offset edge, judged by edgeDeviation.
  const seen = new Uint8Array(N), stack = [], notches = [];
  let notchCount = 0;
  for (let start = 0; start < N; start++) {
    if (!mismatch[start] || seen[start]) continue;
    seen[start] = 1; stack.push(start);
    let depth = 0, minX = W, minY = H, maxX = 0, maxY = 0;
    while (stack.length) {
      const i = stack.pop(), x = i%W, y = (i-x)/W;
      depth = Math.max(depth, depthOf(i));
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x+dx, yy = y+dy, j = yy*W+xx;
        if (xx >= 0 && yy >= 0 && xx < W && yy < H && mismatch[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    const extent = Math.hypot(maxX-minX+1, maxY-minY+1)/m;
    if (extent > NOTCH_EXTENT) continue;
    notchCount++;
    if (notches.length < 20) notches.push({ x: Math.round((minX+maxX)/2/m), y: Math.round((minY+maxY)/2/m),
      depthPx: Number(depth.toFixed(2)), extentPx: Number(extent.toFixed(2)) });
  }
  const iouByColor = [];
  for (let c = 0; c < colors.length; c++) if (union[c]) iouByColor.push({ color: hex(colors[c]),
    iou: (inter[c]+tolerated[c])/union[c], strictIou: inter[c]/union[c] });
  const minOf = key => iouByColor.length ? Math.min(...iouByColor.map(x => x[key])) : 0;
  return { iou: minOf('iou'), strictIou: minOf('strictIou'), iouTolerancePx: IOU_TOLERANCE, iouByColor,
    edgeDeviationPx: edgeDeviation, notchCount, notches, measurementScale: m, notchDepthPx: NOTCH_DEPTH, notchExtentPx: NOTCH_EXTENT };
}

module.exports = { flatPalette, traceFlat, flatQuality, lab, delta };
