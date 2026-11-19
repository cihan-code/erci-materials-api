'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { PDFDocument, PDFName, PDFArray, PDFNumber } = require('pdf-lib');
const PDFKit = require('pdfkit');
const SVGtoPDF = require('svg-to-pdfkit');
const tracer = require('@neplex/vectorizer');
const canvasLib = require('@napi-rs/canvas');
const { PNG } = require('pngjs');
const { imageSize, pixelBounds } = require('./measure');
const PT_PER_MM = 72 / 25.4;
let pdfjsPromise;

async function pdfjs() {
  // PDF.js legacy supports Node 18; Skia supplies the DOM geometry and canvas APIs.
  for (const name of ['DOMMatrix', 'ImageData', 'Path2D']) {
    if (!globalThis[name]) globalThis[name] = canvasLib[name];
  }
  return pdfjsPromise ||= import('pdfjs-dist/legacy/build/pdf.mjs');
}

class CanvasFactory {
  create(width, height) {
    const canvas = canvasLib.createCanvas(Math.ceil(width), Math.ceil(height));
    return { canvas, context: canvas.getContext('2d') };
  }
  reset(pair, width, height) { pair.canvas.width = width; pair.canvas.height = height; }
  destroy(pair) { pair.canvas.width = pair.canvas.height = 0; pair.canvas = pair.context = null; }
}

async function openPdf(buffer) {
  const lib = await pdfjs();
  const task = lib.getDocument({ data: Uint8Array.from(buffer), isEvalSupported: false,
    useSystemFonts: true, CanvasFactory, verbosity: 0 });
  try { return await task.promise; }
  catch (error) { await task.destroy(); throw error; }
}

async function renderPage(page, scale = 2) {
  const viewport = page.getViewport({ scale });
  if (viewport.width * viewport.height > 40_000_000) throw Object.assign(new Error('PDF sayfasi cok buyuk (40 MP siniri)'),{status:413});
  const factory = new CanvasFactory(), pair = factory.create(viewport.width, viewport.height);
  try {
    await page.render({ canvasContext: pair.context, viewport, canvasFactory: factory }).promise;
    return pair.canvas.toBuffer('image/png');
  } finally { factory.destroy(pair); }
}

function targetSize(targetMm) {
  if (targetMm == null) return null;
  const width = targetMm.w ?? targetMm.width ?? targetMm.widthMm;
  const height = targetMm.h ?? targetMm.height ?? targetMm.heightMm;
  if (![width, height].every(x => Number.isFinite(x) && x > 0 && x <= 3000)) {
    throw new TypeError('targetMm {w, h}: 0..3000 mm gerekli');
  }
  return { width: width * PT_PER_MM, height: height * PT_PER_MM };
}

function fit(source, target) {
  const size = target || source;
  const scaleX = size.width/source.width, scaleY = size.height/source.height;
  return {...size,scaleX,scaleY,scale:Math.min(scaleX,scaleY),x:0,y:0};
}

function svgPdf(svg, source, target) {
  const layout = fit(source, target);
  return new Promise((resolve, reject) => {
    const doc = new PDFKit({ size: [layout.width, layout.height], margin: 0, compress: true });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      SVGtoPDF(doc, svg, layout.x, layout.y, { width: layout.width,
        height: layout.height, preserveAspectRatio: 'none', assumePt: true });
      doc.end();
    } catch (err) { doc.destroy(); reject(err); }
  });
}

function alphaBounds({width,height,pixels}) {
  let left=width,top=height,right=-1,bottom=-1;
  for (let y=0;y<height;y++) for (let x=0;x<width;x++) if (pixels[(y*width+x)*4+3]>8) {
    left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
  }
  return right<0 ? null : {x:left,y:top,w:right-left+1,h:bottom-top+1};
}

async function rasterInput(buffer, source, assessRaster = false) {
  const jpeg=buffer[0]!==137;
  imageSize(buffer,jpeg ? 'image/jpeg' : 'image/png');
  const decoded = await tracer.readImage(buffer);
  // Lossy JPEG halos on white margins are background, not physical artwork.
  // Keep a pale-only design measurable as well; raster output still needs review.
  const transparent = assessRaster && decoded.pixels.some((v,i) => i%4 === 3 && v < 250);
  const bounds = pixelBounds(decoded,jpeg ? 235 : 250) || (jpeg ? pixelBounds(decoded,250) : null)
    || (transparent ? alphaBounds(decoded) : null);
  if (!bounds) throw new Error('Desen içerik kutusu boş');
  const cropped = new PNG({width:bounds.w,height:bounds.h});
  const pixels = Buffer.from(decoded.pixels);
  for (let y=0;y<bounds.h;y++) pixels.copy(cropped.data,y*bounds.w*4,
    ((bounds.y+y)*decoded.width+bounds.x)*4,((bounds.y+y)*decoded.width+bounds.x+bounds.w)*4);
  buffer=PNG.sync.write(cropped);
  const image={width:bounds.w,height:bounds.h,pixels:cropped.data, transparent};
  const dimensions = source ? {width:image.width*source.width/decoded.width,height:image.height*source.height/decoded.height}
    : {width:image.width*0.75,height:image.height*0.75};
  return {buffer,image,dimensions};
}
async function trace(buffer, source, target, assessRaster = false) {
  const decoded=await rasterInput(buffer,source,assessRaster);
  const {image,dimensions}=decoded;buffer=decoded.buffer;
  if (assessRaster) {
    const colors=perceptualPalette(image.pixels,image.width,image.height,image.transparent);
    if (colors.colorCount>0 && colors.colorCount<=qualityLimits().maxColors) {
      const normalized=PNG.sync.read(buffer), remap=new Map();
      colors.clusters.forEach((cluster,index)=> {
        let nearest=colors.significant[0];
        for(const candidate of colors.significant) if(delta(candidate.lab,cluster.lab)<delta(nearest.lab,cluster.lab)) nearest=candidate;
        if (!cluster.core || delta(nearest.lab,cluster.lab)<=qualityLimits().colorDeltaE) remap.set(index+1,nearest.rgb);
      });
      for(let i=0;i<colors.ids.length;i++) {
        const rgb=remap.get(colors.ids[i]);
        if(rgb) for(let c=0;c<3;c++) normalized.data[i*4+c]=rgb[c];
        // Boundary alpha is coverage, not a translucent ink; vtracer traces a binary silhouette.
        if(normalized.data[i*4+3]<128) normalized.data[i*4+3]=0;
        else normalized.data[i*4+3]=255;
      }
      buffer=PNG.sync.write(normalized);
    }
  }
  const svg = await tracer.vectorize(buffer, {
    colorMode: tracer.ColorMode.Color, hierarchical: tracer.Hierarchical.Stacked,
    mode: tracer.PathSimplifyMode.Spline, filterSpeckle: assessRaster ? 4 : 0, colorPrecision: 6,
    pathPrecision: 5, cornerThreshold: 60, lengthThreshold: 3.5,
    spliceThreshold: 45, layerDifference: 16, maxIterations: 10,
  });
  return { pdf: await svgPdf(svg, dimensions, target), image, svg, dimensions: target || dimensions };
}

// Operator lists expand Form XObjects, so paths inside forms are counted as well.
async function inspectPage(page) {
  const { OPS } = await pdfjs();
  const ops = await page.getOperatorList();
  let pathCount = 0, imageCount = 0, textCount = 0, vectorPaintCount = 0, minLineWidth = Infinity;
  const colors = new Set();
  let matrix = [1, 0, 0, 1, 0, 0], lineWidth = 1, fillColor = 'gray:0', strokeColor = 'gray:0';
  const stack = [];
  const paintedPaths = new Set(['stroke', 'closeStroke', 'fill', 'eoFill', 'fillStroke',
    'eoFillStroke', 'closeFillStroke', 'closeEOFillStroke'].map(x => OPS[x]));
  const strokes = new Set(['stroke', 'closeStroke', 'fillStroke', 'eoFillStroke',
    'closeFillStroke', 'closeEOFillStroke'].map(x => OPS[x]));
  const imageOps = new Set(Object.keys(OPS).filter(k => /^paint.*Image/.test(k)).map(k => OPS[k]));
  const colorOps = new Map(Object.keys(OPS).filter(k => /^set(Fill|Stroke).*Color$/.test(k))
    .map(k => [OPS[k], k]));
  const textOps = new Set([OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText]);
  function transform(m) {
    const a = matrix;
    matrix = [a[0]*m[0]+a[2]*m[1], a[1]*m[0]+a[3]*m[1],
      a[0]*m[2]+a[2]*m[3], a[1]*m[2]+a[3]*m[3], 0, 0];
  }
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i], args = ops.argsArray[i];
    if (fn === OPS.save) stack.push({ matrix: matrix.slice(), lineWidth, fillColor, strokeColor });
    if (fn === OPS.restore && stack.length) ({ matrix, lineWidth, fillColor, strokeColor } = stack.pop());
    if (fn === OPS.transform) transform(args);
    if (fn === OPS.paintFormXObjectBegin) {
      stack.push({ matrix: matrix.slice(), lineWidth, fillColor, strokeColor });
      if (args[0]) transform(args[0]);
    }
    if (fn === OPS.paintFormXObjectEnd && stack.length) ({ matrix, lineWidth, fillColor, strokeColor } = stack.pop());
    if (fn === OPS.setLineWidth) lineWidth = args[0];
    if (paintedPaths.has(fn)) {
      pathCount++;
      if (![OPS.stroke, OPS.closeStroke].includes(fn)) colors.add(fillColor);
      if (strokes.has(fn)) colors.add(strokeColor);
    }
    if (strokes.has(fn)) {
      const scale = Math.min(Math.hypot(matrix[0], matrix[1]), Math.hypot(matrix[2], matrix[3]));
      minLineWidth = Math.min(minLineWidth, lineWidth * scale / PT_PER_MM);
    }
    if (imageOps.has(fn)) imageCount++;
    if (paintedPaths.has(fn) || fn === OPS.shadingFill) vectorPaintCount++;
    if (colorOps.has(fn)) {
      const name = colorOps.get(fn), color = name.replace(/set(Fill|Stroke)/, '') + ':' + JSON.stringify(args);
      if (name.startsWith('setFill')) fillColor = color;
      else strokeColor = color;
    }
    if (textOps.has(fn)) { colors.add(fillColor); textCount++; }
  }
  const text = await page.getTextContent();
  textCount = Math.max(textCount, text.items.filter(x => x.str && x.str.trim()).length);
  const viewport = page.getViewport({ scale: 1 });
  return { pathCount, vectorPaintCount, imageCount, textCount, colors, minLineWidth,
    width: viewport.width, height: viewport.height, rotation: viewport.rotation };
}

async function inspectPdf(buffer) {
  const doc = await openPdf(buffer);
  try {
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) pages.push(await inspectPage(await doc.getPage(i)));
    return pages;
  } finally { await doc.destroy(); }
}

// PNG/JPEG quality is advisory, measured on the cropped artwork at its output size.
// Invalid environment settings fall back to conservative defaults, never disable a check.
function qualityLimits(applicationType) {
  const value = (key, fallback, max = 1e6) => {
    const raw = process.env[`SIPARIS_VECTOR_${key}`];
    const n = raw == null || raw.trim() === '' ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 && n <= max ? n : fallback;
  };
  const embroidery = applicationType === 'nakis';
  return { colorDeltaE:value('COLOR_DELTA_E',10,100),minColorAreaRatio:value('MIN_COLOR_AREA_RATIO',.005,1), maxColors: value('MAX_COLORS', 6), minLineMm: embroidery
    ? value('NAKIS_MIN_LINE_MM', 1.2, 100) : value('BASKI_MIN_LINE_MM', 0.8, 100),
    minGapMm: embroidery ? value('NAKIS_MIN_GAP_MM', 1.2, 100) : value('BASKI_MIN_GAP_MM', 0.8, 100),
    minShapeMm2: embroidery ? value('NAKIS_MIN_SHAPE_MM2', 1.44) : value('BASKI_MIN_SHAPE_MM2', 0.64),
    minIou: value('MIN_IOU', 0.97, 1), maxPixelDifference: value('MAX_PIXEL_DIFFERENCE', 0.03, 1),
    maxSemiTransparentRatio: value('MAX_SEMI_TRANSPARENT_RATIO', 0.02, 1),
    maxPaths: value('MAX_PATHS', 500), maxNodes: value('MAX_NODES', 10000) };
}

// Exact squared Euclidean distance transform with physical, anisotropic pixel spacing.
function distances(mask, width, height, sx, sy) {
  const field = new Float64Array(mask.length);
  for (let i = 0; i < mask.length; i++) field[i] = mask[i] ? 1e20 : 0;
  const size = Math.max(width, height), f = new Float64Array(size), out = new Float64Array(size);
  const v = new Int32Array(size), z = new Float64Array(size + 1);
  function line(n, spacing) {
    const a = spacing * spacing;
    let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (let q = 1; q < n; q++) {
      let s;
      do {
        const p = v[k]; s = ((f[q] + a*q*q) - (f[p] + a*p*p)) / (2*a*(q-p));
        if (s <= z[k]) k--; else break;
      } while (k >= 0);
      k++; v[k] = q; z[k] = s; z[k+1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k+1] < q) k++;
      out[q] = a*(q-v[k])**2 + f[v[k]];
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) f[x] = field[y*width+x];
    line(width, sx);
    for (let x = 0; x < width; x++) field[y*width+x] = out[x];
  }
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = field[y*width+x];
    line(height, sy);
    for (let y = 0; y < height; y++) field[y*width+x] = out[y];
  }
  return field;
}

// Zhang–Suen thinning removes rectangle corners rather than treating short scanline
// runs at rounded boundaries as fine detail. The distance on the skeleton estimates width.
function skeletonWidth(mask, width, height, sx, sy, trim = 0) {
  const distance = distances(mask, width, height, sx, sy), skeleton = mask.slice();
  let changed = true;
  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      const remove = [];
      for (let y = 1; y < height-1; y++) for (let x = 1; x < width-1; x++) {
        const i = y*width+x;
        if (!skeleton[i]) continue;
        const p = [skeleton[i-width],skeleton[i-width+1],skeleton[i+1],skeleton[i+width+1],
          skeleton[i+width],skeleton[i+width-1],skeleton[i-1],skeleton[i-width-1]];
        const count = p.reduce((a,b) => a+b, 0);
        if (count < 2 || count > 6) continue;
        let transitions = 0;
        for (let j = 0; j < 8; j++) if (!p[j] && p[(j+1)%8]) transitions++;
        if (transitions !== 1) continue;
        if (pass ? p[0]*p[2]*p[6] || p[0]*p[4]*p[6] : p[0]*p[2]*p[4] || p[2]*p[4]*p[6]) continue;
        remove.push(i);
      }
      for (const i of remove) skeleton[i] = 0;
      if (remove.length) changed = true;
    }
  }
  // Short tapered terminals are boundary corners, not a sustained narrow channel.
  for(let step=0;step<trim;step++) {
    const remove=[];
    for(let y=1;y<height-1;y++) for(let x=1;x<width-1;x++) {
      const i=y*width+x;if(!skeleton[i]) continue;
      const count=[-width-1,-width,-width+1,-1,1,width-1,width,width+1].reduce((n,d)=>n+skeleton[i+d],0);
      if(count<=1) remove.push(i);
    }
    if(!remove.length) break;
    for(const i of remove) skeleton[i]=0;
  }
  let min = Infinity;
  for (let i = 0; i < mask.length; i++) if (skeleton[i]) {
    // Distance is to background pixel centres; subtract one pixel pitch to estimate edges.
    min = Math.min(min, Math.max(Math.min(sx,sy), 2*Math.sqrt(distance[i])-Math.max(sx,sy)));
  }
  return Number.isFinite(min) ? min : null;
}

function components(mask, width, height, excludeBorder = false) {
  const remaining = mask.slice(), interior = new Uint8Array(mask.length), queue = new Int32Array(mask.length);
  let minArea = Infinity;
  for (let start = 0; start < mask.length; start++) {
    if (!remaining[start]) continue;
    let head = 0, tail = 1, border = false; queue[0] = start; remaining[start] = 0;
    while (head < tail) {
      const i = queue[head++], x = i%width, y = Math.floor(i/width);
      if (!x || !y || x === width-1 || y === height-1) border = true;
      for (const next of [x ? i-1 : -1,x < width-1 ? i+1 : -1,y ? i-width : -1,y < height-1 ? i+width : -1]) {
        if (next >= 0 && remaining[next]) {remaining[next] = 0; queue[tail++] = next;}
      }
    }
    if (!excludeBorder || !border) {
      minArea = Math.min(minArea, tail);
      for (let j = 0; j < tail; j++) interior[queue[j]] = 1;
    }
  }
  return { mask: interior, minArea: Number.isFinite(minArea) ? minArea : null };
}

// CIE76 Delta E in D65 Lab: alpha and antialias boundary mixtures are not inks.
function lab(rgb) {
  const [r,g,b] = rgb.map(v => {v/=255;return v>.04045 ? ((v+.055)/1.055)**2.4 : v/12.92;});
  const f = v => v>.008856 ? Math.cbrt(v) : 7.787*v+16/116;
  const x=f((.4124564*r+.3575761*g+.1804375*b)/.95047),
    y=f(.2126729*r+.7151522*g+.072175*b),z=f((.0193339*r+.119192*g+.9503041*b)/1.08883);
  return [116*y-16,500*(x-y),200*(y-z)];
}
const delta = (a,b) => Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);
function perceptualPalette(data,width,height,transparent,limits=qualityLimits()) {
  const histogram=new Map(), keys=new Int32Array(width*height);keys.fill(-1);
  let visible=0;
  for(let i=0;i<keys.length;i++) {
    const p=i*4;
    if(data[p+3]<247 || (!transparent && Math.min(data[p],data[p+1],data[p+2])>=245)) continue;
    visible++;
    const key=(data[p]>>3)*1024+(data[p+1]>>3)*32+(data[p+2]>>3);keys[i]=key;
    let bin=histogram.get(key);
    if(!bin) histogram.set(key,bin={key,rgb:[data[p],data[p+1],data[p+2]],count:0,core:0});
    bin.count++;
    const x=i%width,y=Math.floor(i/width);
    let core=true;
    for(const n of [x ? i-1:i,x<width-1 ? i+1:i,y ? i-width:i,y<height-1 ? i+width:i]) {
      const q=n*4;
      if(data[q+3]<247 || Math.max(...[0,1,2].map(c=>Math.abs(data[p+c]-data[q+c])))>24) core=false;
    }
    if(core) bin.core++;
  }
  const clusters=[];
  // Most frequent stable interior colours anchor the clusters; small JPEG/AA shades join them.
  for(const bin of [...histogram.values()].sort((a,b)=>b.core-a.core || b.count-a.count)) {
    bin.lab=lab(bin.rgb);
    let id=clusters.findIndex(c=>delta(c.lab,bin.lab)<=limits.colorDeltaE);
    if(id<0) {id=clusters.length;clusters.push({lab:bin.lab,rgb:bin.rgb,count:0,core:0});}
    bin.id=id+1;clusters[id].count+=bin.count;clusters[id].core+=bin.core;
  }
  const significant=clusters.filter(c=>c.core>0 && c.count>=visible*limits.minColorAreaRatio);
  const ids=new Int32Array(keys.length);
  for(let i=0;i<ids.length;i++) if(keys[i]>=0) ids[i]=histogram.get(keys[i]).id;
  return {ids,clusters,significant,colorCount:significant.length};
}
// A one-pixel opening removes isolated resampling/codec noise before physical measurement.
function opening(mask,width,height) {
  const eroded=new Uint8Array(mask.length),out=new Uint8Array(mask.length);
  for(let y=1;y<height-1;y++) for(let x=1;x<width-1;x++) {
    const i=y*width+x;
    if(mask[i] && mask[i-1] && mask[i+1] && mask[i-width] && mask[i+width]) eroded[i]=1;
  }
  for(let y=1;y<height-1;y++) for(let x=1;x<width-1;x++) {
    const i=y*width+x;
    if(eroded[i] || eroded[i-1] || eroded[i+1] || eroded[i-width] || eroded[i+width]) out[i]=1;
  }
  return out;
}

async function rasterQuality(image, pdf, svg, dimensions, applicationType, target, priorMetrics) {
  const limits = qualityLimits(applicationType), originalWidth = image.width, originalHeight = image.height;
  const scale = Math.min(1, Math.sqrt(1_000_000/(originalWidth*originalHeight)),
    target ? dimensions.width/PT_PER_MM*300/25.4/originalWidth : 1,
    target ? dimensions.height/PT_PER_MM*300/25.4/originalHeight : 1);
  const width = Math.max(1, Math.round(originalWidth*scale)), height = Math.max(1, Math.round(originalHeight*scale));
  const sourceCanvas = canvasLib.createCanvas(width, height), ctx = sourceCanvas.getContext('2d');
  const full = canvasLib.createCanvas(originalWidth, originalHeight);
  full.getContext('2d').putImageData(new canvasLib.ImageData(Uint8ClampedArray.from(image.pixels),originalWidth,originalHeight),0,0);
  ctx.drawImage(full,0,0,width,height);
  const data = ctx.getImageData(0,0,width,height).data;
  const transparent = image.transparent;
  const palette = perceptualPalette(data,width,height,transparent,limits), colorIds=palette.ids;
  let alphaEdgePixels = 0, semi = 0;
  // Coverage classification is bounded to the analysis grid (at most 1 MP).
  for (let y=0;y<height;y++) for (let x=0;x<width;x++) {
    const i=(y*width+x)*4, alpha=data[i+3];
    if (alpha<=8 || alpha>=247) continue;
    let coverage=false;
    for(let dy=-2;dy<=2 && !coverage;dy++) for(let dx=-2;dx<=2;dx++) {
      const xx=x+dx,yy=y+dy;
      if(xx>=0 && yy>=0 && xx<width && yy<height && data[(yy*width+xx)*4+3]>=247) {coverage=true;break;}
    }
    alphaEdgePixels++;
    if(!coverage) semi++;
  }
  const w = width+2, h = height+2, mask = new Uint8Array(w*h);
  for (let i = 0; i < width*height; i++) {
    const p = i*4, alpha = data[p+3];
    if (alpha <= 8) continue;

    const ink = transparent ? alpha > 127 : Math.min(data[p],data[p+1],data[p+2]) < 245;
    if (ink) mask[(Math.floor(i/width)+1)*w+i%width+1] = 1;
  }
  const sx = dimensions.width/PT_PER_MM/width, sy = dimensions.height/PT_PER_MM/height;
  let minLineMm = null, minShapeMm2 = null;
  // Complex palettes already require review; avoid unbounded per-colour skeleton work.
  if (target && palette.colorCount <= limits.maxColors && palette.clusters.length <= 64) {
    for (let id=1;id<=palette.clusters.length;id++) {
      if (!palette.clusters[id-1].core) continue;
      const region = new Uint8Array(mask.length);
      for (let i = 0; i < colorIds.length; i++) if (colorIds[i] === id) region[(Math.floor(i/width)+1)*w+i%width+1] = 1;
      const clean=opening(region,w,h), component = components(clean,w,h);
      if (component.minArea === null) continue;
      const line = skeletonWidth(clean,w,h,sx,sy), area = component.minArea*sx*sy;
      if (line !== null) minLineMm = Math.min(minLineMm ?? Infinity,line);
      minShapeMm2 = Math.min(minShapeMm2 ?? Infinity,area);
    }
  }
  const cleanMask=opening(mask,w,h);
  const background = Uint8Array.from(cleanMask, x => 1-x), holes = components(background,w,h,true);
  // A background pixel bracketed by ink in either axis belongs to a gap,
  // including channels open to the exterior. Outer blank margins never qualify.
  const gaps = holes.mask.slice();
  for (let y=1;y<h-1;y++) {
    let first=-1,last=-1;
    for (let x=1;x<w-1;x++) if(cleanMask[y*w+x]) {if(first<0) first=x;last=x;}
    for (let x=first+1;first>=0 && x<last;x++) if(!cleanMask[y*w+x]) gaps[y*w+x]=1;
  }
  for (let x=1;x<w-1;x++) {
    let first=-1,last=-1;
    for (let y=1;y<h-1;y++) if(cleanMask[y*w+x]) {if(first<0) first=y;last=y;}
    for (let y=first+1;first>=0 && y<last;y++) if(!cleanMask[y*w+x]) gaps[y*w+x]=1;
  }
  const minGapMm = target ? skeletonWidth(opening(gaps,w,h),w,h,sx,sy,Math.ceil(limits.minGapMm/Math.min(sx,sy))) : null;
  const cleanHoles=components(opening(holes.mask,w,h),w,h);
  if (target && cleanHoles.minArea !== null) minShapeMm2 = Math.min(minShapeMm2 ?? Infinity,cleanHoles.minArea*sx*sy);
  const output = canvasLib.createCanvas(width,height), outputCtx = output.getContext('2d');
  const doc = await openPdf(pdf);
  try {
    const page = await doc.getPage(1), viewport = page.getViewport({scale:1});
    await page.render({canvasContext:outputCtx,viewport,background:transparent ? 'rgba(0,0,0,0)' : 'white',
      transform:[width/viewport.width,0,0,height/viewport.height,0,0]}).promise;
  } finally {await doc.destroy();}
  const rendered = outputCtx.getImageData(0,0,width,height).data;
  const outputMask=new Uint8Array(mask.length);
  for(let i=0;i<width*height;i++) {
    const p=i*4;
    outputMask[(Math.floor(i/width)+1)*w+i%width+1]=transparent ? rendered[p+3]>127 : Math.min(rendered[p],rendered[p+1],rendered[p+2])<245;
  }
  const nearby=(m,i)=>m[i] || m[i-1] || m[i+1] || m[i-w] || m[i+w]
    || m[i-w-1] || m[i-w+1] || m[i+w-1] || m[i+w+1];
  let mismatch = 0, union = 0, difference = 0;
  for (let i = 0; i < width*height; i++) {
    const p = i*4, a = !!mask[(Math.floor(i/width)+1)*w+i%width+1];
    const b = transparent ? rendered[p+3] > 127 : Math.min(rendered[p],rendered[p+1],rendered[p+2]) < 245;
    const index=(Math.floor(i/width)+1)*w+i%width+1;
    if ((a && !nearby(outputMask,index)) || (b && !nearby(mask,index))) mismatch++;
    if (a || b) union++;
    for (let c = 0; c < 3; c++) difference += Math.abs((data[p+c]*data[p+3]/255+255-data[p+3])
      -(rendered[p+c]*rendered[p+3]/255+255-rendered[p+3]))/255;
  }
  const pathCount = priorMetrics?.pathCount ?? (svg.match(/<path\b/g)||[]).length;
  const arity = {M:2,L:2,C:6,Q:4,A:7,S:4,T:2,H:1,V:1};
  let nodeCount = 0;
  for (const match of svg.matchAll(/\bd=["']([^"']*)["']/g)) {
    for (const command of match[1].matchAll(/([MLCQASTHVZ])([^MLCQASTHVZ]*)/gi)) {
      const name=command[1].toUpperCase(), args=command[2].match(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi)||[];
      if (arity[name]) nodeCount += Math.ceil(args.length/arity[name])*(name==='C' ? 3 : ['Q','S'].includes(name) ? 2 : 1);
    }
  }
  const metrics = { colorCount:palette.colorCount, minLineMm, minGapMm, minShapeMm2, pathCount, nodeCount:priorMetrics?.nodeCount ?? nodeCount,
    iou:union ? 1-mismatch/union : 0, pixelDifference:difference/(width*height*3),
    semiTransparentRatio:alphaEdgePixels ? semi/alphaEdgePixels : 0, alphaEdgePixels, semiTransparentPixels:semi, measurementSize:target ? 'target' : 'pending', analysisDpi:target ? Math.min(25.4/sx,25.4/sy) : null, noiseFilter:'one-pixel-opening', colorDeltaE:limits.colorDeltaE, minColorAreaRatio:limits.minColorAreaRatio, iouTolerancePx:1,
    widthMm:target ? dimensions.width/PT_PER_MM : null,heightMm:target ? dimensions.height/PT_PER_MM : null,
    applicationType, analysisWidth:width, analysisHeight:height, limits };
  const reasons = [];
  if (!metrics.colorCount) reasons.push('Algısal renk kümeleri güvenilir ayrıştırılamadı; fotoğraf veya geçiş için teyit gerekir.');
  if (metrics.colorCount > limits.maxColors) reasons.push(`Renk sayısı ${metrics.colorCount}; sınır ${limits.maxColors}.`);
  if (minLineMm === null) reasons.push('En ince çizgi güvenilir ölçülemedi.');
  else if (minLineMm < limits.minLineMm) reasons.push(`En ince çizgi ${minLineMm.toFixed(3)} mm; ${applicationType==='nakis' ? 'nakış' : 'baskı'} sınırı ${limits.minLineMm} mm.`);
  if (minGapMm !== null && minGapMm < limits.minGapMm) reasons.push(`En küçük boşluk ${minGapMm.toFixed(3)} mm; sınır ${limits.minGapMm} mm.`);
  if (minShapeMm2 !== null && minShapeMm2 < limits.minShapeMm2) reasons.push(`En küçük kapalı şekil ${minShapeMm2.toFixed(3)} mm²; sınır ${limits.minShapeMm2} mm².`);
  if (metrics.iou < limits.minIou) reasons.push(`Vektör benzerliği ${metrics.iou.toFixed(4)}; gerekli IoU ${limits.minIou}.`);
  if (metrics.pixelDifference > limits.maxPixelDifference) reasons.push(`Piksel farkı ${metrics.pixelDifference.toFixed(4)}; sınır ${limits.maxPixelDifference}.`);
  if (metrics.semiTransparentRatio > limits.maxSemiTransparentRatio) reasons.push(`Alfa kenarında yarı saydam piksel oranı ${metrics.semiTransparentRatio.toFixed(4)}; sınır ${limits.maxSemiTransparentRatio}.`);
  if (pathCount > limits.maxPaths) reasons.push(`Yol sayısı ${pathCount}; sınır ${limits.maxPaths}.`);
  if (metrics.nodeCount > limits.maxNodes) reasons.push(`Düğüm sayısı ${metrics.nodeCount}; sınır ${limits.maxNodes}.`);
  return {metrics,reasons};
}

// One-pixel foreground runs estimate fine raster details; not a production measurement.
function rasterMinDetail(image, widthMm) {
  const { width, height, pixels: data } = image;
  let min = Infinity;
  for (let y = 0; y < height; y++) {
    let run = 0;
    for (let x = 0; x <= width; x++) {
      const i = (y * width + x) * 4;
      const foreground = x < width && data[i+3] > 32 && Math.min(data[i], data[i+1], data[i+2]) < 220;
      if (foreground) run++;
      else if (run) { min = Math.min(min, run); run = 0; }
    }
  }
  for (let x = 0; x < width; x++) {
    let run = 0;
    for (let y = 0; y <= height; y++) {
      const i = (y * width + x) * 4;
      const foreground = y < height && data[i+3] > 32 && Math.min(data[i], data[i+1], data[i+2]) < 220;
      if (foreground) run++;
      else if (run) { min = Math.min(min, run); run = 0; }
    }
  }
  return min === Infinity ? null : min * widthMm / width;
}

// Measure rendered ink, then transform the original PDF operators; the output stays vector.
async function pageContentBox(page) {
  const scale=2, viewport=page.getViewport({scale});
  const png=PNG.sync.read(await renderPage(page,scale));
  const bounds=pixelBounds(png,250);
  if (!bounds) throw new Error('PDF desen içerik kutusu boş');
  const corners=[viewport.convertToPdfPoint(bounds.x,bounds.y),
    viewport.convertToPdfPoint(bounds.x+bounds.w,bounds.y+bounds.h)];
  return {x:Math.min(corners[0][0],corners[1][0]),y:Math.min(corners[0][1],corners[1][1]),
    width:Math.abs(corners[1][0]-corners[0][0]),height:Math.abs(corners[1][1]-corners[0][1])};
}
function resizePage(page, target, crop) {
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;
  const rotated = rotation === 90 || rotation === 270;
  const physicalTarget = rotated ? {width:target.height,height:target.width} : target;
  const {scaleX,scaleY}=fit(crop,physicalTarget);
  page.scaleContent(scaleX,scaleY);
  page.translateContent(-crop.x*scaleX,-crop.y*scaleY);
  page.scaleAnnotations(scaleX,scaleY);
  const annots=page.node.Annots();
  if (annots) for (let i=0;i<annots.size();i++) {
    const annotation=page.doc.context.lookup(annots.get(i));
    const rect=annotation.lookup(PDFName.of('Rect'),PDFArray);
    if (rect) for (let j=0;j<4;j++) rect.set(j,PDFNumber.of(rect.lookup(j,PDFNumber).asNumber()
      - (j%2 ? crop.y*scaleY : crop.x*scaleX)));
  }
  for (const box of ['setMediaBox','setCropBox','setTrimBox','setBleedBox','setArtBox'])
    page[box](0,0,physicalTarget.width,physicalTarget.height);
  return Math.abs(scaleX/scaleY-1);
}

/** Local only. targetMm is the artwork content boundary in millimetres. */
async function vectorize({ buffer, mime, targetMm, manualVector = false, applicationType = 'baski', qualitySource } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new TypeError('buffer gerekli');
  const target = targetSize(targetMm);
  mime = String(mime || '').split(';')[0].toLowerCase();
  let pdf, kind, inputPages, rasterQualityReport, rasterDetails = [], reasons = [], aspectRatioError = 0;
  if (!['baski','nakis'].includes(applicationType)) throw new TypeError('applicationType baski veya nakis olmalı');
  if (manualVector && mime!=='application/pdf') throw new Error('Hazır vektör PDF gerekli');
  if (['image/png', 'image/jpeg', 'image/jpg'].includes(mime)) {
    const result = await trace(buffer, null, target, true);
    pdf = result.pdf; kind = 'raster';
    inputPages = [{ width: result.image.width, height: result.image.height }];
    const source = { width: result.image.width * 0.75, height: result.image.height * 0.75 };
    if (target) aspectRatioError=Math.abs((target.width/target.height)/(source.width/source.height)-1);
    rasterQualityReport = await rasterQuality(result.image,pdf,result.svg,result.dimensions,applicationType,target);
    rasterDetails.push(rasterQualityReport.metrics.minLineMm);
    reasons.push(...rasterQualityReport.reasons);
  } else if (mime === 'application/pdf') {
    inputPages = await inspectPdf(buffer);
    if (manualVector && inputPages.some(p=>p.imageCount || (!p.vectorPaintCount && !p.textCount)))
      throw Object.assign(new Error('Hazır vektör raster veya boş sayfa içeremez'),{status:400});
    const rasterPages = inputPages.map(x => x.imageCount > 0 && x.vectorPaintCount === 0 && x.textCount === 0);
    kind = rasterPages.every(Boolean) ? 'raster' : 'vector';
    if (!rasterPages.some(Boolean) && !target) pdf = Buffer.from(buffer);
    else {
      // Fresh document for pure raster inputs avoids serializing unused source image objects.
      const original = kind === 'raster' ? await PDFDocument.create() : await PDFDocument.load(buffer);
      const rendered = rasterPages.some(Boolean) || target ? await openPdf(buffer) : null;
      try {
        for (let i = 0; i < inputPages.length; i++) {
          if (rasterPages[i]) {
            // Rendering ONLY image-only pages preserves placement, crop, masks and composition;
            // raw PDF image extraction would lose those. No vector/text page is rasterized.
            const result = await trace(await renderPage(await rendered.getPage(i + 1)), inputPages[i], target);
            const traced = await PDFDocument.load(result.pdf);
            const [replacement] = await original.copyPages(traced, [0]);
            if (kind === 'raster') original.addPage(replacement);
            else { original.removePage(i); original.insertPage(i, replacement); }
            const source={width:result.image.width*0.75,height:result.image.height*0.75};
            if (target) aspectRatioError=Math.max(aspectRatioError,Math.abs((target.width/target.height)/(source.width/source.height)-1));
            rasterDetails.push(rasterMinDetail(result.image,(target || source).width/PT_PER_MM));
          } else if (target) aspectRatioError=Math.max(aspectRatioError,
            resizePage(original.getPage(i),target,qualitySource
              ? {x:0,y:0,width:inputPages[i].width,height:inputPages[i].height}
              : await pageContentBox(await rendered.getPage(i+1))));
        }
        pdf = Buffer.from(await original.save({ updateFieldAppearances: false }));
      } finally { if (rendered) await rendered.destroy(); }
    }
    if (rasterPages.some(Boolean)) reasons.push('raster_detay_ve_metin_gorsel_teyidi');
    if (inputPages.some((x, i) => x.imageCount && !rasterPages[i])) reasons.push('karma_sayfada_raster_korundu');
  } else throw new TypeError('Desteklenen MIME: image/png, image/jpeg, application/pdf');

  // A cached preview is resized as vector paths; assess its final PDF against the original raster.
  if (qualitySource) {
    if (!manualVector || !target || !Buffer.isBuffer(qualitySource.buffer)
      || !['image/png','image/jpeg','image/jpg'].includes(qualitySource.mime)) throw new TypeError('Geçerli kalite kaynağı gerekli');
    const original=await rasterInput(qualitySource.buffer,null,true);
    aspectRatioError=Math.abs((target.width/target.height)/(original.image.width/original.image.height)-1);
    rasterQualityReport=await rasterQuality(original.image,pdf,'',target,applicationType,target,qualitySource.metrics);
    rasterDetails.push(rasterQualityReport.metrics.minLineMm);reasons.push(...rasterQualityReport.reasons);
    if (![qualitySource.metrics?.pathCount,qualitySource.metrics?.nodeCount].every(n=>Number.isFinite(n) && n>=0)) {
      rasterQualityReport.metrics.pathCount=null;rasterQualityReport.metrics.nodeCount=null;
      reasons.push('Önizlemenin yol ve düğüm ölçümleri eksik; özgün kaynaktan yeniden hazırlama gerekir.');
    }
  }
  const pages = await inspectPdf(pdf);
  const colors = new Set(pages.flatMap(x => [...x.colors]));
  const minValues = pages.map(x => x.minLineWidth).filter(Number.isFinite)
    .concat(rasterDetails.filter(x => x !== null));
  const minLineWidth = minValues.length ? Math.min(...minValues) : null;
  const pathCount = pages.reduce((sum, x) => sum + x.pathCount, 0);
  // Both stored dimensions are authoritative; report any aspect change for visual review.
  if (!rasterQualityReport && pathCount > 2000) reasons.push('cok_yol');
  if (!rasterQualityReport && minLineWidth !== null && minLineWidth < 0.2) reasons.push('ince_cizgi');
  if (pages.some(x => x.textCount)) reasons.push('metin');
  if (!rasterQualityReport && pathCount && minLineWidth === null) reasons.push('dolgu_detay_kalinligi_olculemedi');
  if (inputPages.some(x => !Number.isFinite(x.width / x.height) || x.width / x.height > 20 || x.width / x.height < 0.05)) reasons.push(rasterQualityReport ? 'Desenin en boy oranı olağan sınırların dışında.' : 'supheli_oran');
  if (aspectRatioError > 0.01) reasons.push(rasterQualityReport ? 'Hedef ölçü desenin en boy oranını değiştiriyor.' : 'oran_bozuldu');
  return { pdf, kind, report: { pathCount, colorCount: rasterQualityReport?.metrics.colorCount ?? colors.size, minLineWidth,
    minLineWidthUnit: 'mm', minLineWidthEstimated: true, aspectRatioPreserved: aspectRatioError <= 0.01,
    aspectRatioError, aspectRatioMethod: 'content-boundary-transform',
    rasterQuality: rasterQualityReport?.metrics,
    quality: manualVector && !qualitySource ? 'iyi' : rasterQualityReport && !target ? 'beklemede' : reasons.length ? 'teyit' : 'iyi',
    qualityLabel: rasterQualityReport && !target ? 'Kalite ölçüden sonra değerlendirilecek' : undefined,
    reasons: rasterQualityReport && !target ? [] : [...new Set(reasons)],
    pageCount: pages.length, pages: pages.map(x => ({ pathCount: x.pathCount,
      imageCount: x.imageCount, textCount: x.textCount, widthMm: x.width / PT_PER_MM,
      heightMm: x.height / PT_PER_MM })), rasterPdfMethod: kind === 'raster' && mime === 'application/pdf'
      ? 'PDF.js image-only page composition at 144 dpi -> local vtracer -> SVG paths' : undefined } };
}

async function compareDirectory(input, output) {
  const inputDir = await fs.realpath(input);
  const outputDir = output ? path.resolve(output) : await fs.mkdtemp(path.join(os.tmpdir(), 'siparis-vektor-'));
  // Resolve the nearest existing ancestor BEFORE mkdir (including symlinked ancestors).
  let ancestor = outputDir, tail = [];
  while (true) {
    try { ancestor = await fs.realpath(ancestor); break; }
    catch (err) {
      if (err.code !== 'ENOENT') throw err;
      tail.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor);
    }
  }
  const realOutput = path.join(ancestor, ...tail);
  if (realOutput === inputDir || realOutput.startsWith(inputDir + path.sep)) throw new Error('Cikti girdi klasorunun disinda olmali');
  await fs.mkdir(realOutput, { recursive: true });
  const entries = await fs.readdir(inputDir, { withFileTypes: true });
  const mimes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.pdf': 'application/pdf' };
  const results = [];
  for (const entry of entries) {
    const mime = mimes[path.extname(entry.name).toLowerCase()];
    if (!entry.isFile() || !mime) continue;
    const stem = entry.name; // Preserve extension to avoid a.png / a.pdf collisions.
    const result = await vectorize({ buffer: await fs.readFile(path.join(inputDir, entry.name)), mime });
    await fs.writeFile(path.join(realOutput, stem + '.pdf'), result.pdf, { flag: 'wx' });
    await fs.writeFile(path.join(realOutput, stem + '.json'), JSON.stringify({ kind: result.kind, ...result.report }, null, 2), { flag: 'wx' });
    const doc = await openPdf(result.pdf);
    try {
      for (let i = 1; i <= doc.numPages; i++) await fs.writeFile(path.join(realOutput, stem + `.page-${i}.png`),
        await renderPage(await doc.getPage(i)), { flag: 'wx' });
    } finally { await doc.destroy(); }
    results.push({ file: entry.name, quality: result.report.quality });
  }
  return { output: realOutput, files: results };
}

module.exports = { vectorize, compareDirectory };
if (require.main === module) {
  const args = process.argv.slice(2);
  const index = args.indexOf('--karsilastir'), out = args.indexOf('--output');
  if (index < 0 || !args[index + 1]) {
    console.error('Kullanim: node agent/siparis/vector.js --karsilastir <klasor> [--output <ayri-klasor>]');
    process.exitCode = 1;
  } else compareDirectory(args[index + 1], out >= 0 ? args[out + 1] : undefined)
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(err => { console.error(err.message); process.exitCode = 1; });
}
