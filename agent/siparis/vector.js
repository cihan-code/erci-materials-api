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
  return lib.getDocument({ data: Uint8Array.from(buffer), isEvalSupported: false,
    useSystemFonts: true, CanvasFactory, verbosity: 0 }).promise;
}

async function renderPage(page, scale = 2) {
  const viewport = page.getViewport({ scale });
  if (viewport.width * viewport.height > 40_000_000) throw Object.assign(new Error('PDF sayfasi cok buyuk (40 MP siniri)'),{status:413});
  const pair = new CanvasFactory().create(viewport.width, viewport.height);
  await page.render({ canvasContext: pair.context, viewport, canvasFactory: new CanvasFactory() }).promise;
  return pair.canvas.toBuffer('image/png');
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

async function trace(buffer, source, target) {
  const jpeg=buffer[0]!==137;
  imageSize(buffer,jpeg ? 'image/jpeg' : 'image/png');
  const decoded = await tracer.readImage(buffer);
  // Lossy JPEG halos on white margins are background, not physical artwork.
  // Keep a pale-only design measurable as well; raster output still needs review.
  const bounds = pixelBounds(decoded,jpeg ? 235 : 250) || (jpeg ? pixelBounds(decoded,250) : null);
  if (!bounds) throw new Error('Desen içerik kutusu boş');
  const cropped = new PNG({width:bounds.w,height:bounds.h});
  const pixels = Buffer.from(decoded.pixels);
  for (let y=0;y<bounds.h;y++) pixels.copy(cropped.data,y*bounds.w*4,
    ((bounds.y+y)*decoded.width+bounds.x)*4,((bounds.y+y)*decoded.width+bounds.x+bounds.w)*4);
  buffer=PNG.sync.write(cropped);
  const image={width:bounds.w,height:bounds.h,pixels:cropped.data};
  const dimensions = source ? {width:image.width*source.width/decoded.width,height:image.height*source.height/decoded.height}
    : {width:image.width*0.75,height:image.height*0.75};
  const svg = await tracer.vectorize(buffer, {
    colorMode: tracer.ColorMode.Color, hierarchical: tracer.Hierarchical.Stacked,
    mode: tracer.PathSimplifyMode.Spline, filterSpeckle: 0, colorPrecision: 6,
    pathPrecision: 5, cornerThreshold: 60, lengthThreshold: 3.5,
    spliceThreshold: 45, layerDifference: 16, maxIterations: 10,
  });
  return { pdf: await svgPdf(svg, dimensions, target), image };
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
async function vectorize({ buffer, mime, targetMm, manualVector = false } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new TypeError('buffer gerekli');
  const target = targetSize(targetMm);
  mime = String(mime || '').split(';')[0].toLowerCase();
  let pdf, kind, inputPages, rasterDetails = [], reasons = [], aspectRatioError = 0;
  if (manualVector && mime!=='application/pdf') throw new Error('Hazır vektör PDF gerekli');
  if (['image/png', 'image/jpeg', 'image/jpg'].includes(mime)) {
    const result = await trace(buffer, null, target);
    pdf = result.pdf; kind = 'raster';
    inputPages = [{ width: result.image.width, height: result.image.height }];
    const source = { width: result.image.width * 0.75, height: result.image.height * 0.75 };
    if (target) aspectRatioError=Math.abs((target.width/target.height)/(source.width/source.height)-1);
    rasterDetails.push(rasterMinDetail(result.image, (target || source).width / PT_PER_MM));
    reasons.push('raster_detay_ve_metin_gorsel_teyidi');
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
            resizePage(original.getPage(i),target,await pageContentBox(await rendered.getPage(i+1))));
        }
        pdf = Buffer.from(await original.save({ updateFieldAppearances: false }));
      } finally { if (rendered) await rendered.destroy(); }
    }
    if (rasterPages.some(Boolean)) reasons.push('raster_detay_ve_metin_gorsel_teyidi');
    if (inputPages.some((x, i) => x.imageCount && !rasterPages[i])) reasons.push('karma_sayfada_raster_korundu');
  } else throw new TypeError('Desteklenen MIME: image/png, image/jpeg, application/pdf');

  const pages = await inspectPdf(pdf);
  const colors = new Set(pages.flatMap(x => [...x.colors]));
  const minValues = pages.map(x => x.minLineWidth).filter(Number.isFinite)
    .concat(rasterDetails.filter(x => x !== null));
  const minLineWidth = minValues.length ? Math.min(...minValues) : null;
  const pathCount = pages.reduce((sum, x) => sum + x.pathCount, 0);
  // Both stored dimensions are authoritative; report any aspect change for visual review.
  if (pathCount > 2000) reasons.push('cok_yol');
  if (minLineWidth !== null && minLineWidth < 0.2) reasons.push('ince_cizgi');
  if (pages.some(x => x.textCount)) reasons.push('metin');
  if (pathCount && minLineWidth === null) reasons.push('dolgu_detay_kalinligi_olculemedi');
  if (inputPages.some(x => !Number.isFinite(x.width / x.height) || x.width / x.height > 20 || x.width / x.height < 0.05)) reasons.push('supheli_oran');
  if (aspectRatioError > 0.01) reasons.push('oran_bozuldu');
  return { pdf, kind, report: { pathCount, colorCount: colors.size, minLineWidth,
    minLineWidthUnit: 'mm', minLineWidthEstimated: true, aspectRatioPreserved: aspectRatioError <= 0.01,
    aspectRatioError, aspectRatioMethod: 'content-boundary-transform',
    quality: manualVector ? 'iyi' : reasons.length ? 'teyit' : 'iyi', reasons: [...new Set(reasons)],
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
