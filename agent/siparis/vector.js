'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { PDFDocument, PDFName, PDFArray, PDFNumber, PDFRawStream, decodePDFRawStream } = require('pdf-lib');
const PDFKit = require('pdfkit');
const SVGtoPDF = require('svg-to-pdfkit');
const tracer = require('@neplex/vectorizer');
const canvasLib = require('@napi-rs/canvas');
const { PNG } = require('pngjs');
const { imageSize, pixelBounds } = require('./measure');
const { flatPalette, traceFlat, flatQuality, lab, delta, FLAT_VECTORIZERS } = require('./flatTrace');
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

async function renderPage(page, scale = 2, background) {
  const viewport = page.getViewport({ scale });
  if (viewport.width * viewport.height > 40_000_000) throw Object.assign(new Error('PDF sayfasi cok buyuk (40 MP siniri)'),{status:413});
  const factory = new CanvasFactory(), pair = factory.create(viewport.width, viewport.height);
  try {
    await page.render({ canvasContext: pair.context, viewport, background, canvasFactory: factory }).promise;
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
// Same 20-level colour step as the measurement's matte rule (autoMeasure.designContent).
function inkBounds({width,height,pixels},ground) {
  let left=width,top=height,right=-1,bottom=-1;
  for (let y=0;y<height;y++) for (let x=0;x<width;x++) {
    const i=(y*width+x)*4;
    if (pixels[i+3]<=8 || Math.max(Math.abs(pixels[i]-ground[0]),Math.abs(pixels[i+1]-ground[1]),Math.abs(pixels[i+2]-ground[2]))<=20) continue;
    left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
  }
  return right<0 ? null : {x:left,y:top,w:right-left+1,h:bottom-top+1};
}

// Bound native tracing allocations. Keep physical source dimensions and require review
// whenever resampling could hide artwork details; original uploads remain untouched.
const RASTER_EDGE=800;
// maxPixels: flat logos bypass the 800 px edge and keep up to this many source pixels.
async function boundedRaster(buffer, maxPixels) {
  const size=imageSize(buffer,buffer[0]===137?'image/png':'image/jpeg');
  const scale=Math.min(1,maxPixels ? Math.sqrt(maxPixels/(size.width*size.height)) : RASTER_EDGE/Math.max(size.width,size.height));
  if(scale===1)return {buffer,resampled:false};
  const image=await canvasLib.loadImage(buffer);
  const canvas=canvasLib.createCanvas(Math.max(1,Math.round(size.width*scale)),Math.max(1,Math.round(size.height*scale)));
  try {
    canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
    return {buffer:canvas.toBuffer('image/png'),resampled:true,source:{width:size.width*.75,height:size.height*.75}};
  } finally {canvas.width=canvas.height=0;}
}
async function rasterInput(buffer, source, assessRaster = false) {
  const jpeg=buffer[0]!==137;
  imageSize(buffer,jpeg ? 'image/jpeg' : 'image/png');
  const decoded = await tracer.readImage(buffer);
  // Lossy JPEG halos on white margins are background, not physical artwork.
  // Keep a pale-only design measurable as well; raster output still needs review.
  const transparent = assessRaster && decoded.pixels.some((v,i) => i%4 === 3 && v < 250);
  const bounds = pixelBounds(decoded,jpeg ? 235 : 250) || (jpeg ? pixelBounds(decoded,250) : null)
    || (assessRaster ? alphaBounds(decoded) : null);
  if (!bounds) throw new Error('Desen içerik kutusu boş');
  const cropped = new PNG({width:bounds.w,height:bounds.h});
  const pixels = Buffer.from(decoded.pixels.buffer,decoded.pixels.byteOffset,decoded.pixels.byteLength);
  for (let y=0;y<bounds.h;y++) pixels.copy(cropped.data,y*bounds.w*4,
    ((bounds.y+y)*decoded.width+bounds.x)*4,((bounds.y+y)*decoded.width+bounds.x+bounds.w)*4);
  buffer=PNG.sync.write(cropped);
  // An opaque pale field cannot establish whether white belongs to the design
  // or its ground; shadows and codec specks must not imply a precise print area.
  const borderColors=new Map();
  for(let y=0;y<decoded.height;y++) for(let x=0;x<decoded.width;x++) {
    if(x && y && x!==decoded.width-1 && y!==decoded.height-1) continue;
    const i=(y*decoded.width+x)*4,rgb=[pixels[i],pixels[i+1],pixels[i+2]],key=rgb.map(v=>v>>3).join(',');
    const bin=borderColors.get(key)||{rgb,count:0};bin.count++;borderColors.set(key,bin);
  }
  const ground=[...borderColors.values()].sort((a,b)=>b.count-a.count)[0];
  let similar=0;
  if(assessRaster && !transparent && ground) {
    const groundLab=lab(ground.rgb),cache=new Map();
    for(let i=0;i<pixels.length;i+=4) {
      const key=(pixels[i]>>3)*1024+(pixels[i+1]>>3)*32+(pixels[i+2]>>3);
      if(!cache.has(key)) cache.set(key,delta(groundLab,lab([pixels[i],pixels[i+1],pixels[i+2]]))<=qualityLimits().colorDeltaE);
      if(cache.get(key)) similar++;
    }
  }
  const groundUnclear=assessRaster && !transparent && similar/(decoded.width*decoded.height)>.98;
  const image={width:bounds.w,height:bounds.h,pixels:cropped.data, transparent, groundUnclear};
  const dimensions = source ? {width:image.width*source.width/decoded.width,height:image.height*source.height/decoded.height}
    : {width:image.width*0.75,height:image.height*0.75};
  return {buffer,image,dimensions};
}
// Quick flat-artwork probe on the 800 px raster before a larger decode is attempted.
async function flatRaster({buffer, source}) {
  const {image}=await rasterInput(buffer,source??null,true), limits=qualityLimits();
  const palette=perceptualPalette(image.pixels,image.width,image.height,image.transparent);
  return !!flatPalette(image,palette,{maxInks:limits.flatMaxColors,deltaE:limits.colorDeltaE}).flat;
}
// SIPARIS_VECTOR_TRACER=vtracer forces the previous tracer (comparisons, rollback).
const tracerChoice = () => (process.env.SIPARIS_VECTOR_TRACER || '').trim().toLowerCase() === 'vtracer' ? 'vtracer' : 'auto';
// flatOnly: the caller retries at the 800 px bound when the artwork is not traced flat.
async function trace(buffer, source, target, assessRaster = false, {flatOnly = false} = {}) {
  const decoded=await rasterInput(buffer,source,assessRaster);
  const {image,dimensions}=decoded;buffer=decoded.buffer;
  let tracing={vectorizer:'vtracer'};
  if (assessRaster) {
    const colors=perceptualPalette(image.pixels,image.width,image.height,image.transparent);
    // One or two flat inks (logo, lettering, emblem): imagetracerjs on smoothed per-colour masks.
    const limits=qualityLimits(), classified=flatPalette(image,colors,{maxInks:limits.flatMaxColors,deltaE:limits.colorDeltaE});
    if (classified.flat && tracerChoice()!=='vtracer') {
      try {
        const flat=traceFlat(classified.flat,{maxPixels:limits.flatTraceMaxPixels});
        global.gc?.();
        return { pdf: await svgPdf(flat.svg, dimensions, target), image, svg: flat.svg, dimensions: target || dimensions,
          tracing: {vectorizer:flat.vectorizer,upscale:flat.upscale,thresholds:flat.thresholds,layers:flat.colors} };
      } catch (error) { tracing.fallback=error.message; }
    }
    if (flatOnly) return null;
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
  return { pdf: await svgPdf(svg, dimensions, target), image, svg, dimensions: target || dimensions, tracing };
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
    maxPaths: value('MAX_PATHS', 500), maxNodes: value('MAX_NODES', 10000),
    // Flat artwork (one or two inks): re-rasterized vector against the source colour edges.
    flatMaxColors: value('FLAT_MAX_COLORS', 2, 6), minFlatIou: value('MIN_FLAT_IOU', 0.98, 1),
    maxEdgeDeviationPx: value('MAX_EDGE_DEVIATION_PX', 1, 100), flatTraceMaxPixels: value('FLAT_TRACE_MAX_PIXELS', 6e6, 4e7),
    flatRasterPixels: value('FLAT_RASTER_PIXELS', 2e6, 6e6) };
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
function skeletonWidth(mask, width, height, sx, sy) {
  const distance = distances(mask, width, height, sx, sy), skeleton = mask.slice();
  let changed = true;
  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      const remove = [];
      for (let y = 1; y < height-1; y++) for (let x = 1; x < width-1; x++) {
        const i = y*width+x;
        if (!skeleton[i]) continue;
        // Same Zhang-Suen test as before, without a per-pixel array (large solid areas run many passes).
        const p0 = skeleton[i-width], p1 = skeleton[i-width+1], p2 = skeleton[i+1], p3 = skeleton[i+width+1],
          p4 = skeleton[i+width], p5 = skeleton[i+width-1], p6 = skeleton[i-1], p7 = skeleton[i-width-1];
        const count = p0+p1+p2+p3+p4+p5+p6+p7;
        if (count < 2 || count > 6) continue;
        const transitions = (!p0&&p1?1:0)+(!p1&&p2?1:0)+(!p2&&p3?1:0)+(!p3&&p4?1:0)+(!p4&&p5?1:0)+(!p5&&p6?1:0)+(!p6&&p7?1:0)+(!p7&&p0?1:0);
        if (transitions !== 1) continue;
        if (pass ? p0*p2*p6 || p0*p4*p6 : p0*p2*p4 || p2*p4*p6) continue;
        remove.push(i);
      }
      for (const i of remove) skeleton[i] = 0;
      if (remove.length) changed = true;
    }
  }
  // Follow physical skeleton segments. Junctions, terminals and sharp corners do
  // not describe sustained print detail; exclude about two local radii around them.
  const neighbours = i => {
    const out=[];
    for (const [dx,dy] of [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[1,-1],[-1,1],[1,1]]) {
      const j=i+dy*width+dx;
      if (j<0 || j>=mask.length || !skeleton[j]) continue;
      if (dx && dy && (skeleton[i+dx] || skeleton[i+dy*width])) continue;
      out.push(j);
    }
    return out;
  };
  const graph=new Map();
  for(let i=0;i<mask.length;i++) if(skeleton[i]) graph.set(i,neighbours(i));
  const visited=new Set(), samples=[], compact=[];
  const edgeKey=(a,b)=>a<b ? a+':'+b : b+':'+a;
  const length=(a,b)=>Math.hypot((a%width-b%width)*sx,(Math.floor(a/width)-Math.floor(b/width))*sy);
  function segment(start,next) {
    const points=[start], positions=[0];let previous=start,current=next;
    while(true) {
      visited.add(edgeKey(previous,current));
      positions.push(positions.at(-1)+length(previous,current));points.push(current);
      const ns=graph.get(current);
      if(ns.length!==2 || current===start) break;
      const following=ns.find(n=>n!==previous);
      if(visited.has(edgeKey(current,following))) break;
      previous=current;current=following;
    }
    const total=positions.at(-1);
    if(total<1) return;
    let peak=0;for(const i of points) peak=Math.max(peak,distance[i]);
    // A broad compact segment may be entirely covered by its endpoint radii;
    // retain its inscribed width only after passing the physical 1 mm length gate.
    if(total<=4*Math.sqrt(peak)) compact.push(2*Math.sqrt(peak)-Math.max(sx,sy));
    const exclusions=[];
    if(graph.get(start).length!==2) exclusions.push([0,2*Math.sqrt(peak)]);
    if(graph.get(current).length!==2) exclusions.push([total,2*Math.sqrt(peak)]);
    // Detect bends over a radius-sized baseline, rather than pixel stair steps.
    for(let k=1;k<points.length-1;k++) {
      const radius=Math.sqrt(distance[points[k]]);let left=k-1,right=k+1;
      while(left>0 && positions[k]-positions[left]<radius) left--;
      while(right<points.length-1 && positions[right]-positions[k]<radius) right++;
      if(positions[k]-positions[left]<radius*.8 || positions[right]-positions[k]<radius*.8) continue;
      const a=points[left],b=points[k],c=points[right];
      const ux=(b%width-a%width)*sx,uy=(Math.floor(b/width)-Math.floor(a/width))*sy;
      const vx=(c%width-b%width)*sx,vy=(Math.floor(c/width)-Math.floor(b/width))*sy;
      if((ux*vx+uy*vy)/(Math.hypot(ux,uy)*Math.hypot(vx,vy))<.5) exclusions.push([positions[k],2*radius]);
    }
    for(let k=0;k<points.length;k++) {
      if(exclusions.some(([p,r])=>Math.abs(positions[k]-p)<r)) continue;
      const weight=((positions[k]- (positions[k-1]??positions[k]))+((positions[k+1]??positions[k])-positions[k]))/2;
      if(weight>0) samples.push({value:Math.max(Math.min(sx,sy),2*Math.sqrt(distance[points[k]])-Math.max(sx,sy)),weight});
    }
  }
  for(const [i,ns] of graph) if(ns.length!==2) for(const n of ns) if(!visited.has(edgeKey(i,n))) segment(i,n);
  for(const [i,ns] of graph) for(const n of ns) if(!visited.has(edgeKey(i,n))) segment(i,n);
  samples.sort((a,b)=>a.value-b.value);
  const threshold=samples.reduce((n,s)=>n+s.weight,0)*.05;let cumulative=0;
  for(const sample of samples) {cumulative+=sample.weight;if(cumulative>=threshold) return sample.value;}
  return compact.length ? Math.min(...compact) : null;
}

function components(mask, width, height, excludeBorder = false, noiseArea = 0) {
  const remaining = mask.slice(), interior = new Uint8Array(mask.length), queue = new Int32Array(mask.length);
  let minArea = Infinity, gurultuSayisi = 0;
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
    if ((!excludeBorder || !border) && tail < noiseArea) {gurultuSayisi++;continue;}
    if (!excludeBorder || !border) {
      minArea = Math.min(minArea, tail);
      for (let j = 0; j < tail; j++) interior[queue[j]] = 1;
    }
  }
  return { mask: interior, minArea: Number.isFinite(minArea) ? minArea : null, gurultuSayisi };
}

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

function flatMeasureImage(image, maxPixels = 1.2e6) {
  const scale=Math.sqrt(maxPixels/(image.width*image.height));
  if (scale>=1) return image;
  const width=Math.max(1,Math.round(image.width*scale)), height=Math.max(1,Math.round(image.height*scale));
  const full=canvasLib.createCanvas(image.width,image.height), small=canvasLib.createCanvas(width,height);
  try {
    full.getContext('2d').putImageData(new canvasLib.ImageData(Uint8ClampedArray.from(image.pixels),image.width,image.height),0,0);
    const ctx=small.getContext('2d');ctx.drawImage(full,0,0,width,height);
    return {...image,width,height,pixels:ctx.getImageData(0,0,width,height).data};
  } finally {full.width=full.height=small.width=small.height=0;}
}

// PDF page stretched to width x height pixels (same fit as the IoU render below).
// All four corners of the traced page painted opaque in one pale colour: the white field
// around a non-rectangular mark (inside its crop) was traced as a filled area. A mark that
// fills its own corners in a colour (a box badge) is artwork and is not asked about.
async function tracedGround(pdf) {
  const n = 48, data = await renderPixels(pdf, n, n, true), at = (x, y) => Array.from(data.subarray((y*n+x)*4, (y*n+x)*4+4));
  const corners = [at(1,1), at(n-2,1), at(1,n-2), at(n-2,n-2)];
  if (corners.some(c => c[3] < 250 || Math.min(...c.slice(0,3)) < 235)) return null;
  if (corners.some(c => c.slice(0,3).some((v,i) => Math.abs(v-corners[0][i]) > 12))) return null;
  return hexColor(corners[0].slice(0,3));
}
async function renderPixels(pdf, width, height, transparent) {
  const canvas = canvasLib.createCanvas(width, height), ctx = canvas.getContext('2d');
  const doc = await openPdf(pdf);
  try {
    const page = await doc.getPage(1), viewport = page.getViewport({scale:1});
    await page.render({canvasContext:ctx,viewport,background:transparent ? 'rgba(0,0,0,0)' : 'white',
      transform:[width/viewport.width,0,0,height/viewport.height,0,0]}).promise;
    return ctx.getImageData(0,0,width,height).data;
  } finally {await doc.destroy();canvas.width=canvas.height=0;}
}

// options.ground: pixels in a removed proof ground's colour are the garment, not ink (both renders).
// options.vectorSource: no trace to compare (IoU, edge deviation, notches) and the path/node
// limits are tracer limits; a drawn vector has its own (cok_yol).
async function rasterQuality(image, pdf, svg, dimensions, applicationType, target, priorMetrics, tracing, options = {}) {
  const limits = qualityLimits(applicationType), originalWidth = image.width, originalHeight = image.height;
  // Same pixel budget as the 800 px bound, so a larger flat raster costs no more skeleton work.
  const scale = Math.min(1, Math.sqrt(RASTER_EDGE*RASTER_EDGE/(originalWidth*originalHeight)),
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
  // Coverage classification is bounded to the analysis grid (at most 0.64 MP).
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
  let minLineMm = null, minShapeMm2 = null, gurultuSayisi = 0;
  const noiseArea=mask.reduce((n,p)=>n+p,0)*.0005;
  // Complex palettes already require review; avoid unbounded per-colour skeleton work.
  if (target && palette.colorCount <= limits.maxColors && palette.clusters.length <= 64) {
    for (let id=1;id<=palette.clusters.length;id++) {
      if (!palette.clusters[id-1].core) continue;
      const region = new Uint8Array(mask.length);
      for (let i = 0; i < colorIds.length; i++) if (colorIds[i] === id) region[(Math.floor(i/width)+1)*w+i%width+1] = 1;
      const filtered=components(region,w,h,false,noiseArea);
      gurultuSayisi+=filtered.gurultuSayisi;
      const clean=opening(filtered.mask,w,h), component=components(clean,w,h,false,noiseArea);
      gurultuSayisi+=component.gurultuSayisi;
      if (component.minArea === null) continue;
      const line = skeletonWidth(component.mask,w,h,sx,sy), area = component.minArea*sx*sy;
      if (line !== null) minLineMm = Math.min(minLineMm ?? Infinity,line);
      minShapeMm2 = Math.min(minShapeMm2 ?? Infinity,area);
    }
  }
  const cleanMask=opening(mask,w,h);
  const background = Uint8Array.from(cleanMask, x => 1-x), holes = components(background,w,h,true);
  // Negative components touching the image boundary are exterior background.
  // Enclosed components use exactly the same segment measurement as positive ink.
  const cleanHoles=components(opening(holes.mask,w,h),w,h,false,noiseArea);
  gurultuSayisi+=cleanHoles.gurultuSayisi;
  const minGapMm=target ? skeletonWidth(cleanHoles.mask,w,h,sx,sy) : null;
  if(target && cleanHoles.minArea!==null) minShapeMm2=Math.min(minShapeMm2??Infinity,cleanHoles.minArea*sx*sy);
  const output = canvasLib.createCanvas(width,height), outputCtx = output.getContext('2d');
  const doc = await openPdf(pdf);
  try {
    const page = await doc.getPage(1), viewport = page.getViewport({scale:1});
    await page.render({canvasContext:outputCtx,viewport,background:transparent ? 'rgba(0,0,0,0)' : 'white',
      transform:[width/viewport.width,0,0,height/viewport.height,0,0]}).promise;
  } finally {await doc.destroy();}
  const rendered = clearGround(outputCtx.getImageData(0,0,width,height).data, options.ground);
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
  // Flat artwork: per-colour IoU, edge deviation and notches in source pixels, whichever tracer ran.
  // A large flat source is measured at <=1.2 MP so the 2x comparison grid stays within memory.
  const measured = flatMeasureImage(image);
  const flatSource = flatPalette(measured, perceptualPalette(measured.pixels,measured.width,measured.height,transparent,limits),
    {maxInks:limits.flatMaxColors,deltaE:limits.colorDeltaE});
  const flat = flatSource.flat && !options.vectorSource ? await flatQuality(flatSource.flat,async(w,h)=>clearGround(await renderPixels(pdf,w,h,transparent),options.ground)) : null;
  global.gc?.();
  const metrics = { vectorizer:priorMetrics?.vectorizer ?? tracing?.vectorizer ?? null,
    ...(FLAT_VECTORIZERS.has(tracing?.vectorizer) ? {flatTrace:{upscale:tracing.upscale,thresholds:tracing.thresholds,layers:tracing.layers}} : {}),
    ...(tracing?.fallback ? {vectorizerFallback:tracing.fallback} : {}),
    flatQuality:flat, flatClass:flatSource.flat ? 'duz' : flatSource.reason, flatStats:flatSource.stats ?? null,
    gurultuSayisi, colorCount:palette.colorCount, minLineMm, minGapMm, minShapeMm2, pathCount, nodeCount:priorMetrics?.nodeCount ?? nodeCount,
    iou:options.vectorSource ? null : union ? 1-mismatch/union : 0, pixelDifference:options.vectorSource ? null : difference/(width*height*3),
    semiTransparentRatio:alphaEdgePixels ? semi/alphaEdgePixels : 0, alphaEdgePixels, semiTransparentPixels:semi, measurementSize:target ? 'target' : 'pending', analysisDpi:target ? Math.min(25.4/sx,25.4/sy) : null, noiseFilter:'one-pixel-opening', colorDeltaE:limits.colorDeltaE, minColorAreaRatio:limits.minColorAreaRatio, iouTolerancePx:1,
    widthMm:target ? dimensions.width/PT_PER_MM : null,heightMm:target ? dimensions.height/PT_PER_MM : null,
    applicationType, analysisWidth:width, analysisHeight:height, limits };
  const reasons = [];
  if(image.groundUnclear) reasons.push('Zemin ve desen rengi ayrışmıyor; baskı alanı belirsiz');
  if (!metrics.colorCount) reasons.push('Algısal renk kümeleri güvenilir ayrıştırılamadı; fotoğraf veya geçiş için teyit gerekir.');
  if (metrics.colorCount > limits.maxColors) reasons.push(`Renk sayısı ${metrics.colorCount}; sınır ${limits.maxColors}.`);
  if (minLineMm === null && (minShapeMm2===null || minShapeMm2<limits.minShapeMm2)) reasons.push('En ince çizgi güvenilir ölçülemedi.');
  else if (minLineMm !== null && minLineMm < limits.minLineMm) reasons.push(`En ince çizgi ${minLineMm.toFixed(3)} mm; ${applicationType==='nakis' ? 'nakış' : 'baskı'} sınırı ${limits.minLineMm} mm.`);
  if (minGapMm !== null && minGapMm < limits.minGapMm) reasons.push(`En küçük boşluk ${minGapMm.toFixed(3)} mm; sınır ${limits.minGapMm} mm.`);
  if (minShapeMm2 !== null && minShapeMm2 < limits.minShapeMm2) reasons.push(`En küçük kapalı şekil ${minShapeMm2.toFixed(3)} mm²; sınır ${limits.minShapeMm2} mm².`);
  if (metrics.iou !== null && metrics.iou < limits.minIou) reasons.push(`Vektör benzerliği ${metrics.iou.toFixed(4)}; gerekli IoU ${limits.minIou}.`);
  if (metrics.pixelDifference !== null && metrics.pixelDifference > limits.maxPixelDifference) reasons.push(`Piksel farkı ${metrics.pixelDifference.toFixed(4)}; sınır ${limits.maxPixelDifference}.`);
  if (metrics.semiTransparentRatio > limits.maxSemiTransparentRatio) reasons.push(`Alfa kenarında yarı saydam piksel oranı ${metrics.semiTransparentRatio.toFixed(4)}; sınır ${limits.maxSemiTransparentRatio}.`);
  if (!options.vectorSource && pathCount > limits.maxPaths) reasons.push(`Yol sayısı ${pathCount}; sınır ${limits.maxPaths}.`);
  if (!options.vectorSource && metrics.nodeCount > limits.maxNodes) reasons.push(`Düğüm sayısı ${metrics.nodeCount}; sınır ${limits.maxNodes}.`);
  if (flat && flat.iou < limits.minFlatIou) reasons.push(`Düz renk vektör benzerliği ${flat.iou.toFixed(4)}; gerekli IoU ${limits.minFlatIou}.`);
  if (flat && flat.edgeDeviationPx > limits.maxEdgeDeviationPx) reasons.push(`Kenar sapması ${flat.edgeDeviationPx.toFixed(2)} kaynak pikseli; sınır ${limits.maxEdgeDeviationPx}.`);
  if (flat && flat.notchCount) reasons.push(`Kesişim veya köşelerde ${flat.notchCount} çentik var.`);
  return {metrics,reasons};
}

// On the garment the ground colour is no ink: the same 20-level step as the content box.
function clearGround(data, ground) {
  if (!ground) return data;
  for (let i=0;i<data.length;i+=4) if (data[i+3] && Math.max(Math.abs(data[i]-ground[0]),Math.abs(data[i+1]-ground[1]),Math.abs(data[i+2]-ground[2]))<=20) data[i+3]=0;
  return data;
}
// G53: a drawn vector PDF is judged at the target size by the G49 print checks of a
// traced raster (colours, line, gap, closed shape, alpha edge), on its own rendering
// within the same pixel budget, whichever upload kind brought it. IoU, edge deviation
// and notches compare a trace with its source; a drawn vector has no trace (its paths
// are the source's), so those are not computed for it.
async function vectorQuality(pdf, page, applicationType, target, ground, pathCount) {
  const scale=Math.min(300/72,Math.sqrt(RASTER_EDGE*RASTER_EDGE/(page.width*page.height)));
  const width=Math.max(1,Math.round(page.width*scale)), height=Math.max(1,Math.round(page.height*scale));
  const pixels=clearGround(await renderPixels(pdf,width,height,true),ground);
  return rasterQuality({width,height,pixels,transparent:true,groundUnclear:false},pdf,'',{width:page.width,height:page.height},
    applicationType,target,{pathCount,nodeCount:null,vectorizer:null},null,{ground,vectorSource:true});
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

// G53: a proof exported "on black" paints the garment colour as a full-page
// rectangle before any artwork. That ground is not ink: kept, it turns the
// content box into the page (DYNAMICS 3:1 instead of ~16:1) and the fitted
// letters are flattened. Only the plainest form is recognised: the first
// painted object is one opaque rectangle fill (`re`, or m/l corners) in a device colour, nothing is
// clipped or drawn before it, and after the CTM it covers the whole crop box
// (touches all four edges). Anything else is left exactly as drawn.
const GROUND_OPS=new Set(['q','Q','cm','w','J','j','M','d','ri','i','gs','g','G','rg','RG','k','K','cs','CS','sc','scn','SC','SCN',
  'm','l','c','v','y','h','re','BMC','BDC','EMC','MP','DP']);
const PAINT_OPS=new Set(['f','F','f*','S','s','B','B*','b','b*','sh','Do','BI','Tj','TJ',"'",'"']);
function contentTokens(text) {
  const tokens=[], delimiter=c=>'()<>[]{}/%'.includes(c), space=c=>' \t\r\n\f\0'.includes(c);
  let i=0;
  while (i<text.length) {
    const c=text[i];
    if (space(c)) { i++; continue; }
    if (c==='%') { while (i<text.length && text[i]!=='\n' && text[i]!=='\r') i++; continue; }
    const start=i;
    if (c==='(') {
      let depth=0;
      for (; i<text.length; i++) {
        if (text[i]==='\\') { i++; continue; }
        if (text[i]==='(') depth++;
        if (text[i]===')' && --depth===0) { i++; break; }
      }
      tokens.push({operand:true,value:null,start,end:i});
    } else if (c==='<' && text[i+1]==='<') { tokens.push({operand:true,value:'<<',start,end:i+=2}); }
    else if (c==='>' && text[i+1]==='>') { tokens.push({operand:true,value:'>>',start,end:i+=2}); }
    else if (c==='<') { i=text.indexOf('>',i)+1 || text.length; tokens.push({operand:true,value:null,start,end:i}); }
    else if ('[]{}'.includes(c)) { tokens.push({operand:true,value:c,start,end:++i}); }
    else if (c==='/') { i++; while (i<text.length && !space(text[i]) && !delimiter(text[i])) i++; tokens.push({operand:true,value:text.slice(start,i),start,end:i}); }
    else {
      while (i<text.length && !space(text[i]) && !delimiter(text[i])) i++;
      if (i===start) { i++; continue; }
      const word=text.slice(start,i);
      tokens.push(/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word) ? {operand:true,value:Number(word),start,end:i} : {operand:false,value:word,start,end:i});
    }
  }
  return tokens;
}
function contentText(doc, page) {
  const contents=page.node.Contents();
  if (!contents) return null;
  const streams=contents instanceof PDFArray ? contents.asArray().map(ref=>doc.context.lookup(ref)) : [contents];
  if (!streams.every(stream=>stream instanceof PDFRawStream)) return null;
  // Array parts may only be split between tokens, so a line break joins them safely.
  return streams.map(stream=>Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1')).join('\n');
}
function opaqueState(page, name) {
  const states=page.node.Resources()?.lookup(PDFName.of('ExtGState'));
  const state=states && typeof name==='string' && states.lookup(PDFName.of(name.slice(1)));
  if (!state || typeof state.lookup!=='function') return false;
  const alpha=state.lookup(PDFName.of('ca')), mask=state.lookup(PDFName.of('SMask')), blend=state.lookup(PDFName.of('BM'));
  return (!alpha || alpha.asNumber?.()===1) && (!mask || String(mask)==='/None') && (!blend || ['/Normal','/Compatible'].includes(String(blend)));
}
function findGround(doc, page) {
  let text;
  try { text=contentText(doc,page); } catch { return null; }
  if (text==null) return null;
  const box=page.getCropBox(), stack=[];
  let ctm=[1,0,0,1,0,0], fill=[0,0,0], operands=[], path=[];
  const tokens=contentTokens(text);
  for (const [index,token] of tokens.entries()) {
    if (token.operand) { operands.push(token.value); continue; }
    const op=token.value, args=operands; operands=[];
    if (['f','F','f*'].includes(op)) {
      const corners=path.length===1 && rectangleCorners(path[0]);
      if (!corners || !fill) return null;
      const points=corners.map(([px,py])=>[ctm[0]*px+ctm[2]*py+ctm[4],ctm[1]*px+ctm[3]*py+ctm[5]]);
      const xs=points.map(p=>p[0]), ys=points.map(p=>p[1]), tol=Math.max(1,Math.max(box.width,box.height)*.005);
      const axisAligned=(Math.abs(ctm[1])<1e-9 && Math.abs(ctm[2])<1e-9) || (Math.abs(ctm[0])<1e-9 && Math.abs(ctm[3])<1e-9);
      if (!axisAligned || Math.min(...xs)>box.x+tol || Math.max(...xs)<box.x+box.width-tol
        || Math.min(...ys)>box.y+tol || Math.max(...ys)<box.y+box.height-tol) return null;
      // A page that is only this rectangle (a solid patch) has no other artwork: then it is the design.
      if (!tokens.slice(index+1).some(t=>!t.operand && PAINT_OPS.has(t.value))) return null;
      return {text,start:token.start,end:token.end,color:fill.map(v=>Math.round(Math.max(0,Math.min(1,v))*255))};
    }
    if (!GROUND_OPS.has(op)) return null;
    if (op==='q') stack.push({ctm:ctm.slice(),fill});
    else if (op==='Q') { if (!stack.length) return null; ({ctm,fill}=stack.pop()); }
    else if (op==='cm') {
      if (args.length!==6 || !args.every(Number.isFinite)) return null;
      const [a,b,c,d,e,f]=args, m=ctm;
      ctm=[a*m[0]+b*m[2],a*m[1]+b*m[3],c*m[0]+d*m[2],c*m[1]+d*m[3],e*m[0]+f*m[2]+m[4],e*m[1]+f*m[3]+m[5]];
    }
    else if (op==='rg') fill=args.length===3 && args.every(Number.isFinite) ? args : null;
    else if (op==='g') fill=args.length===1 && Number.isFinite(args[0]) ? [args[0],args[0],args[0]] : null;
    else if (op==='k') fill=args.length===4 && args.every(Number.isFinite) ? [0,1,2].map(n=>(1-args[n])*(1-args[3])) : null;
    // A named colour space or pattern is not a plain device colour.
    else if (['cs','sc','scn'].includes(op)) fill=null;
    else if (op==='gs' && !opaqueState(page,args[0])) return null;
    else if (op==='re') {
      if (args.length!==4 || !args.every(Number.isFinite)) return null;
      const [x,y,w,h]=args; path.push([[x,y],[x+w,y],[x+w,y+h],[x,y+h]]);
    }
    else if (op==='m') { if (args.length!==2 || !args.every(Number.isFinite)) return null; path.push([args]); }
    else if (op==='l') { if (!path.length || !path.at(-1) || args.length!==2 || !args.every(Number.isFinite)) return null; path.at(-1).push(args); }
    else if (op==='h') { if (!path.length) return null; }
    else if (['c','v','y'].includes(op)) return null;
  }
  return null;
}
// Four axis-aligned corners in order (a closing point back to the start is allowed).
function rectangleCorners(points) {
  const p=points.length===5 && points[4][0]===points[0][0] && points[4][1]===points[0][1] ? points.slice(0,4) : points;
  if (p.length!==4) return null;
  const edges=[0,1,2,3].map(i=>[p[i],p[(i+1)%4]]);
  const straight=edges.every(([a,b])=>a[0]===b[0] || a[1]===b[1]), alternating=(edges[0][0][0]===edges[0][1][0])!==(edges[1][0][0]===edges[1][1][0]);
  return straight && alternating ? p : null;
}
// The ground's fill becomes `n` (end the path, paint nothing); every other operator is untouched.
function removeGround(doc, page, ground) {
  const text=ground.text.slice(0,ground.start)+'n'+ground.text.slice(ground.end);
  page.node.set(PDFName.of('Contents'),doc.context.register(doc.context.flateStream(Buffer.from(text,'latin1'))));
}
const hexColor=rgb=>'#'+rgb.map(v=>v.toString(16).padStart(2,'0')).join('');
function parseHex(value) {
  const match=/^#?([0-9a-f]{6})$/i.exec(String(value??'').trim());
  return match ? [0,2,4].map(i=>parseInt(match[1].slice(i,i+2),16)) : null;
}

// Measure rendered ink, then transform the original PDF operators; the output stays vector.
// With a removed ground, paint in the ground's own colour (letter counters, shading) is not ink.
async function pageContentBox(page, groundColor) {
  const scale=2, viewport=page.getViewport({scale});
  const {width,height,data:pixels}=PNG.sync.read(await renderPage(page,scale,'rgba(0,0,0,0)'));
  let transparent=false;
  // Leave out the outer raster pixel, which can be clear due to viewport rounding.
  for (let y=1;y<height-1 && !transparent;y++) for (let x=1;x<width-1;x++) {
    if (pixels[(y*width+x)*4+3]<=8) { transparent=true; break; }
  }
  // Alpha includes white and dark ink on clear pages. A painted page with a
  // light backdrop still uses the established color bounds on a white canvas.
  let bounds=transparent&&groundColor?inkBounds({width,height,pixels},groundColor):null;
  bounds??=transparent?alphaBounds({width,height,pixels}):pixelBounds(PNG.sync.read(await renderPage(page,scale)),250);
  if (!bounds) throw new Error('PDF desen içerik kutusu boş');
  const corners=[viewport.convertToPdfPoint(bounds.x,bounds.y),
    viewport.convertToPdfPoint(bounds.x+bounds.w,bounds.y+bounds.h)];
  return {x:Math.min(corners[0][0],corners[1][0]),y:Math.min(corners[0][1],corners[1][1]),
    width:Math.abs(corners[1][0]-corners[0][0]),height:Math.abs(corners[1][1]-corners[0][1])};
}
// Sizes are stored in whole millimetres, so a small print cannot carry its exact
// ratio (DYNAMICS 163 x 10.2 mm is stored as 163 x 10). When the artwork ratio
// fits both stored sides to within that half-millimetre, the artwork keeps its
// ratio and is centred (the slack stays under 0.5 mm); a larger difference is a
// real change of ratio and is applied and reported as before.
const SIZE_QUANTUM = 0.5 * PT_PER_MM;
function resizePage(page, target, crop) {
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;
  const rotated = rotation === 90 || rotation === 270;
  const physicalTarget = rotated ? {width:target.height,height:target.width} : target;
  let {scaleX,scaleY}=fit(crop,physicalTarget), dx=0, dy=0;
  const ratio=crop.width/crop.height, {width:W,height:H}=physicalTarget;
  if (H>SIZE_QUANTUM && W>SIZE_QUANTUM && ratio>=(W-SIZE_QUANTUM)/(H+SIZE_QUANTUM) && ratio<=(W+SIZE_QUANTUM)/(H-SIZE_QUANTUM)) {
    scaleX=scaleY=Math.min(scaleX,scaleY);
    dx=(W-crop.width*scaleX)/2; dy=(H-crop.height*scaleY)/2;
  }
  page.scaleContent(scaleX,scaleY);
  page.translateContent(-crop.x*scaleX+dx,-crop.y*scaleY+dy);
  page.scaleAnnotations(scaleX,scaleY);
  const annots=page.node.Annots();
  if (annots) for (let i=0;i<annots.size();i++) {
    const annotation=page.doc.context.lookup(annots.get(i));
    const rect=annotation.lookup(PDFName.of('Rect'),PDFArray);
    if (rect) for (let j=0;j<4;j++) rect.set(j,PDFNumber.of(rect.lookup(j,PDFNumber).asNumber()
      - (j%2 ? crop.y*scaleY-dy : crop.x*scaleX-dx)));
  }
  for (const box of ['setMediaBox','setCropBox','setTrimBox','setBleedBox','setArtBox'])
    page[box](0,0,physicalTarget.width,physicalTarget.height);
  return Math.abs(scaleX/scaleY-1);
}

/** Local only. targetMm is the artwork content boundary in millimetres. */
async function vectorize({ buffer, mime, rasterSource, targetMm, manualVector = false, applicationType = 'baski', qualitySource, garmentColor, includeSvg = false } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new TypeError('buffer gerekli');
  const target = targetSize(targetMm);
  mime = String(mime || '').split(';')[0].toLowerCase();
  let tracedSvg, pdf, kind, inputPages, rasterQualityReport, designBox, rasterDetails = [], reasons = [], aspectRatioError = 0, grounds = [], opaqueRaster = false;
  const vectorizers = new Set();
  if (!['baski','nakis'].includes(applicationType)) throw new TypeError('applicationType baski veya nakis olmalı');
  if (manualVector && mime!=='application/pdf') throw new Error('Hazır vektör PDF gerekli');
  if (['image/png', 'image/jpeg', 'image/jpg'].includes(mime)) {
    let bounded=await boundedRaster(buffer), result;
    if(rasterSource)Object.assign(bounded,{resampled:true,source:{width:rasterSource.width*.75,height:rasterSource.height*.75}});
    global.gc?.(); // Drop the original native decode before tracing the bounded raster.
    // Flat logos are traced from up to FLAT_RASTER_PIXELS of the original (6 MP mask budget);
    // other artwork keeps the 800 px bound for the native colour tracer.
    if (bounded.resampled && !rasterSource && tracerChoice()!=='vtracer' && await flatRaster(bounded)) {
      const large=await boundedRaster(buffer,qualityLimits().flatRasterPixels);
      global.gc?.();
      result=await trace(large.buffer, large.source??null, target, true, {flatOnly:true});
      if (result) bounded=large;
    }
    result ??= await trace(bounded.buffer, bounded.source??null, target, true);
    if(bounded.resampled)reasons.push('Büyük raster bellek sınırı için küçültüldü; ince detayları özgün dosyayla teyit edin.');
    pdf = result.pdf; kind = 'raster'; tracedSvg = result.svg;
    designBox={w:result.image.width,h:result.image.height};
    inputPages = [{ width: result.image.width, height: result.image.height }];
    const source = { width: result.image.width * 0.75, height: result.image.height * 0.75 };
    if (target) aspectRatioError=Math.abs((target.width/target.height)/(source.width/source.height)-1);
    rasterQualityReport = await rasterQuality(result.image,pdf,result.svg,result.dimensions,applicationType,target,undefined,result.tracing);
    opaqueRaster = !result.image.transparent;
    vectorizers.add(result.tracing.vectorizer);
    rasterDetails.push(rasterQualityReport.metrics.minLineMm);
    reasons.push(...rasterQualityReport.reasons);
  } else if (mime === 'application/pdf') {
    inputPages = await inspectPdf(buffer);
    if (manualVector && inputPages.some(p=>p.imageCount || (!p.vectorPaintCount && !p.textCount)))
      throw Object.assign(new Error('Hazır vektör raster veya boş sayfa içeremez'),{status:400});
    const rasterPages = inputPages.map(x => x.imageCount > 0 && x.vectorPaintCount === 0 && x.textCount === 0);
    kind = rasterPages.every(Boolean) ? 'raster' : 'vector';
    // A cached preview (qualitySource) was traced from pixels and is never a proof ground.
    let source = buffer;
    if (kind === 'vector' && !qualitySource) {
      const grounded = await PDFDocument.load(buffer);
      grounds = grounded.getPages().map((page, i) => rasterPages[i] ? null : findGround(grounded, page));
      grounds.forEach((ground, i) => { if (ground) removeGround(grounded, grounded.getPage(i), ground); });
      if (grounds.some(Boolean)) source = Buffer.from(await grounded.save({ updateFieldAppearances: false }));
    }
    if (!rasterPages.some(Boolean) && !target) pdf = Buffer.from(source);
    else {
      // Fresh document for pure raster inputs avoids serializing unused source image objects.
      const original = kind === 'raster' ? await PDFDocument.create() : await PDFDocument.load(source);
      const rendered = rasterPages.some(Boolean) || target ? await openPdf(source) : null;
      try {
        for (let i = 0; i < inputPages.length; i++) {
          if (rasterPages[i]) {
            // Rendering ONLY image-only pages preserves placement, crop, masks and composition;
            // raw PDF image extraction would lose those. No vector/text page is rasterized.
            // Same 800 px bound as PNG/JPEG uploads: a 2x A4 photo page traced to
            // SVG exhausts the worker's 64 MB heap. Physical size stays in points.
            const page = await rendered.getPage(i + 1), scale = Math.min(2, RASTER_EDGE / Math.max(inputPages[i].width, inputPages[i].height));
            if (scale < 2) reasons.push('Büyük raster bellek sınırı için küçültüldü; ince detayları özgün dosyayla teyit edin.');
            const result = await trace(await renderPage(page, scale), inputPages[i], target, true);
            vectorizers.add(result.tracing.vectorizer);
            page.cleanup();
            const traced = await PDFDocument.load(result.pdf);
            const [replacement] = await original.copyPages(traced, [0]);
            if (kind === 'raster') original.addPage(replacement);
            else { original.removePage(i); original.insertPage(i, replacement); }
            // Content size in points: pixels at the render scale, not a fixed 96 dpi.
            const source={width:result.image.width/scale,height:result.image.height/scale};
            global.gc?.(); // Release this page's raster and SVG before the next page.
            if (target) aspectRatioError=Math.max(aspectRatioError,Math.abs((target.width/target.height)/(source.width/source.height)-1));
            rasterDetails.push(rasterMinDetail(result.image,(target || source).width/PT_PER_MM));
          } else if (target) aspectRatioError=Math.max(aspectRatioError,
            resizePage(original.getPage(i),target,qualitySource
              ? {x:0,y:0,width:inputPages[i].width,height:inputPages[i].height}
              : await pageContentBox(await rendered.getPage(i+1),grounds[i]?.color)));
        }
        pdf = Buffer.from(await original.save({ updateFieldAppearances: false }));
      } finally { if (rendered) await rendered.destroy(); }
    }
    if (rasterPages.some(Boolean)) reasons.push('raster_detay_ve_metin_gorsel_teyidi');
    if (inputPages.some((x, i) => x.imageCount && !rasterPages[i])) reasons.push('karma_sayfada_raster_korundu');
    // A ground in the garment's own colour is the garment; any other ground may be a printed box.
    const garment = parseHex(garmentColor);
    if (grounds.some(g => g && !(garment && delta(lab(g.color), lab(garment)) <= qualityLimits(applicationType).colorDeltaE)))
      reasons.push('zemin_cikarildi');
  } else throw new TypeError('Desteklenen MIME: image/png, image/jpeg, application/pdf');

  // A cached preview is resized as vector paths; assess its final PDF against the original raster.
  if (qualitySource) {
    if (!manualVector || !target || !Buffer.isBuffer(qualitySource.buffer)
      || !['image/png','image/jpeg','image/jpg'].includes(qualitySource.mime)) throw new TypeError('Geçerli kalite kaynağı gerekli');
    // A flat preview was traced from the larger raster; judge it against the same pixels.
    const flatPreview=FLAT_VECTORIZERS.has(qualitySource.metrics?.vectorizer) && !qualitySource.rasterSource;
    const bounded=await boundedRaster(qualitySource.buffer,flatPreview ? qualityLimits().flatRasterPixels : undefined);
    if(qualitySource.rasterSource)bounded.resampled=true;
    global.gc?.();
    const original=await rasterInput(bounded.buffer,bounded.source??null,true);
    if(bounded.resampled)reasons.push('Büyük raster bellek sınırı için küçültüldü; ince detayları özgün dosyayla teyit edin.');
    aspectRatioError=Math.abs((target.width/target.height)/(original.image.width/original.image.height)-1);
    rasterQualityReport=await rasterQuality(original.image,pdf,'',target,applicationType,target,qualitySource.metrics);
    opaqueRaster=!original.image.transparent;
    rasterDetails.push(rasterQualityReport.metrics.minLineMm);reasons.push(...rasterQualityReport.reasons);
    if (![qualitySource.metrics?.pathCount,qualitySource.metrics?.nodeCount].every(n=>Number.isFinite(n) && n>=0)) {
      rasterQualityReport.metrics.pathCount=null;rasterQualityReport.metrics.nodeCount=null;
      reasons.push('Önizlemenin yol ve düğüm ölçümleri eksik; özgün kaynaktan yeniden hazırlama gerekir.');
    }
  }
  // G58: a traced opaque ground (a white field behind a PNG logo) would print as a box; ask, change nothing.
  // White ink on a transparent PNG is artwork, not a field.
  if (rasterQualityReport && opaqueRaster) {
    const field = await tracedGround(pdf);
    if (field) reasons.push(`Desende düz zemin var (${field}); baskıya dahil mi? Teyit edin.`);
  }
  const pages = await inspectPdf(pdf);
  const colors = new Set(pages.flatMap(x => [...x.colors]));
  const minValues = pages.map(x => x.minLineWidth).filter(Number.isFinite)
    .concat(rasterDetails.filter(x => x !== null));
  const minLineWidth = minValues.length ? Math.min(...minValues) : null;
  const pathCount = pages.reduce((sum, x) => sum + x.pathCount, 0);
  let vectorQualityReport;
  if (kind === 'vector' && target && !qualitySource && pages.length === 1 && !pages[0].imageCount) {
    vectorQualityReport = await vectorQuality(pdf, pages[0], applicationType, target, grounds[0]?.color, pathCount);
    reasons.push(...vectorQualityReport.reasons);
  }
  // Fill widths have no print size before the application is measured: they wait for the
  // target (as a raster does) instead of being reported as unmeasurable.
  const pendingFill = kind === 'vector' && !target && !qualitySource && pathCount > 0 && minLineWidth === null;
  // Both stored dimensions are authoritative; report any aspect change for visual review.
  if (!rasterQualityReport && pathCount > 2000) reasons.push('cok_yol');
  if (!rasterQualityReport && minLineWidth !== null && minLineWidth < 0.2) reasons.push('ince_cizgi');
  if (pages.some(x => x.textCount)) reasons.push('metin');
  if (!rasterQualityReport && !vectorQualityReport && !pendingFill && pathCount && minLineWidth === null) reasons.push('dolgu_detay_kalinligi_olculemedi');
  if (inputPages.some(x => !Number.isFinite(x.width / x.height) || x.width / x.height > 20 || x.width / x.height < 0.05)) reasons.push(rasterQualityReport ? 'Desenin en boy oranı olağan sınırların dışında.' : 'supheli_oran');
  if (aspectRatioError > 0.01) reasons.push(rasterQualityReport ? 'Hedef ölçü desenin en boy oranını değiştiriyor.' : 'oran_bozuldu');
  return { pdf, kind, ...(includeSvg && tracedSvg ? { svg: tracedSvg } : {}), report: { pathCount, colorCount: rasterQualityReport?.metrics.colorCount ?? colors.size, minLineWidth,
    minLineWidthUnit: 'mm', minLineWidthEstimated: true, aspectRatioPreserved: aspectRatioError <= 0.01,
    aspectRatioError, aspectRatioMethod: 'content-boundary-transform',
    rasterQuality: rasterQualityReport?.metrics,
    ...(vectorQualityReport ? {vectorQuality: vectorQualityReport.metrics} : {}),
    ...(vectorizers.size ? {vectorizer:[...vectorizers].join('+')} : {}),
    ...(designBox?{designBox}:{}),
    ...(grounds.some(Boolean) ? {ground:{removed:true,pages:grounds.flatMap((g,i)=>g?[{page:i+1,color:hexColor(g.color)}]:[]),
      garmentColor:parseHex(garmentColor) ? hexColor(parseHex(garmentColor)) : null}} : {}),
    quality: rasterQualityReport && !target ? 'beklemede' : reasons.length ? 'teyit' : pendingFill ? 'beklemede' : 'iyi',
    qualityLabel: (rasterQualityReport && !target) || (pendingFill && !reasons.length) ? 'Kalite ölçüden sonra değerlendirilecek' : undefined,
    reasons: rasterQualityReport && !target ? [] : [...new Set(reasons)],
    pageCount: pages.length, pages: pages.map(x => ({ pathCount: x.pathCount,
      imageCount: x.imageCount, textCount: x.textCount, widthMm: x.width / PT_PER_MM,
      heightMm: x.height / PT_PER_MM })), rasterPdfMethod: kind === 'raster' && mime === 'application/pdf'
      ? `PDF.js image-only page composition at 144 dpi -> local ${[...vectorizers].join('+')} -> SVG paths` : undefined } };
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
