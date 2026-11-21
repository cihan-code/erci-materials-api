'use strict';

const PDFDocument = require('pdfkit');
const fs = require('node:fs');
const path = require('node:path');
const { bodyRows } = require('../sizeChart');

const PORTRAIT = [810, 1440];
const LANDSCAPE = [1440, 810];
const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL'];
const POSITIONS = { gogus: 'Göğüs', sirt: 'Sırt', kol: 'Kol', ense: 'Ense', kapuson: 'Kapüşon' };
// Trouser legs get a table column only when an order has one (page width).
const LEG_POSITION = { bacak: 'Bacak' };
const POSITION_ALIASES = { sol_gogus: 'gogus', sag_gogus: 'gogus', sol_kol: 'kol', sag_kol: 'kol', kapusan: 'kapuson', sol_bacak: 'bacak', sag_bacak: 'bacak' };
const POSITION_LABELS = { ...POSITIONS, ...LEG_POSITION, kapusan: POSITIONS.kapuson, sol_gogus: 'Sol göğüs', sag_gogus: 'Sağ göğüs', sol_kol: 'Sol kol', sag_kol: 'Sağ kol', sol_bacak: 'Sol bacak', sag_bacak: 'Sağ bacak' };
const SIDED = ['sol_gogus', 'sag_gogus', 'sol_kol', 'sag_kol', 'sol_bacak', 'sag_bacak'];
const TYPES = { baski: 'Baskı', nakis: 'Nakış' };
const CHILD_SIZE = /^(\d{1,2})(?:\s*-\s*(\d{1,2}))?\s*ya[sş]$/i;
const PENDING_LABEL = 'Ölçü teyit bekliyor';
const FONT = path.join(__dirname, 'fonts');
const TERMS_TITLE = 'SİPARİŞ ONAY FORMU – ŞARTLAR VE KOŞULLAR';
const RED = '#ff3333';
const LOGO_FILE = path.join(__dirname, 'assets', 'mercico-logo.png');
const TERMS_FILE = path.join(__dirname, 'sartlar.txt');
let defaultLogo;
let defaultTerms;

function requiredText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} dolu bir metin olmalıdır.`);
  return value;
}

function normalize(order) {
  if (!order || !Array.isArray(order.lines) || order.lines.length === 0) throw new TypeError('En az bir sipariş satırı gerekir.');
  requiredText(order.orderNo, 'orderNo'); requiredText(order.name, 'name');
  requiredText(order.deliveryDate, 'deliveryDate'); requiredText(order.date, 'date');
  if (!Number.isSafeInteger(order.version) || order.version < 1) throw new RangeError('version pozitif tam sayı olmalıdır.');
  if (!Array.isArray(order.description) || order.description.some(t => typeof t !== 'string')) throw new TypeError('description metin dizisi olmalıdır.');
  const ids = new Set();
  const omitQuantities = order.omitQuantities === true;
  const lines = order.lines.map(line => {
    requiredText(line.id, 'line.id');
    if (ids.has(line.id)) throw new TypeError('Satır kimlikleri benzersiz olmalıdır.');
    ids.add(line.id);
    for (const field of ['product', 'color', 'fabric']) requiredText(line[field], `line.${field}`);
    if (omitQuantities) return { ...line, sizes: {}, quantity: 0, distributed: false, blank: true, images: line.images || {} };
    // A sample line without a count prints empty quantity fields.
    if (line.numune && !line.quantity && !Object.values(line.sizes || {}).some(Boolean)) return { ...line, sizes: {}, quantity: 0, distributed: false, blank: true, images: line.images || {} };
    if (line.sizes != null && (typeof line.sizes !== 'object' || Array.isArray(line.sizes))) throw new TypeError('line.sizes nesne olmalıdır.');
    const sizes = Object.fromEntries(SIZES.map(size => [size, 0]));
    for (const [size, qty] of Object.entries(line.sizes || {})) {
      if (!size.trim() || !Number.isSafeInteger(qty) || qty < 0) throw new RangeError(`Geçersiz beden/adet: ${size}`);
      const column = sizeColumn(size);
      sizes[column] = (sizes[column] || 0) + qty;
    }
    const distributed = Object.keys(line.sizes || {}).length > 0;
    const sum = Object.values(sizes).reduce((a,b)=>a+b,0);
    const quantity = line.quantity ?? sum;
    if (!Number.isSafeInteger(quantity) || quantity < 0 || (distributed && quantity !== sum)) throw new RangeError('Geçersiz toplam adet');
    return { ...line, sizes, quantity, distributed, images: line.images || {} };
  });
  if (!Array.isArray(order.applications)) throw new TypeError('applications dizi olmalıdır.');
  for (const app of order.applications) {
    if (!Object.hasOwn(TYPES, app.type) || !Object.hasOwn(POSITION_LABELS, app.position)) throw new TypeError('Geçersiz uygulama türü veya konumu.');
    // A pending measurement is printed as such; its numbers are never drawn or measured.
    for (const field of app.pending ? [] : ['width_mm', 'height_mm']) {
      if (!Number.isSafeInteger(app[field]) || app[field] < 0) throw new RangeError(`${field} negatif olmayan tam sayı olmalıdır; eksik ölçüyü önce teyit edin.`);
    }
    if (app.lineIds !== undefined && (!Array.isArray(app.lineIds) || !app.lineIds.length || app.lineIds.some(id => !ids.has(id)))) {
      throw new TypeError('lineIds yalnız mevcut satır kimliklerini içermelidir.');
    }
  }
  total(lines); // Reject unsafe totals before creating any document.
  // Copies, so previews cropped while rendering never leak into the caller's model.
  return { ...order, lines, applications: order.applications.map(app => ({ ...app })), omitQuantities };
}

// Standard sizes keep their column, child age ranges get their own, anything else is summed under "Diğer".
function sizeColumn(size) {
  if (SIZES.includes(size)) return size;
  const child = CHILD_SIZE.exec(size.trim());
  return child ? `${child[1]}${child[2] ? `-${child[2]}` : ''} YAŞ` : 'Diğer';
}

function total(lines, size) {
  const result = lines.reduce((sum, line) => sum + (size ? (line.sizes[size] || 0) : line.quantity), 0);
  if (!Number.isSafeInteger(result)) throw new RangeError('Toplam adet güvenli tam sayı sınırını aşıyor.');
  return result;
}

function appsFor(order, lines, type) {
  return order.applications.filter(app => (!type || app.type === type) &&
    (!app.lineIds || lines.some(line => app.lineIds.includes(line.id))));
}

// Every form uses this formatter and the stored millimetres, never image geometry.
function cm(mm) { return String(mm / 10).replace('.', ','); }
function dimensions(app) { return app.pending ? PENDING_LABEL : `${cm(app.width_mm)} × ${cm(app.height_mm)} cm${app.scaleNote ? ' ≈' : ''}`; }

// Measurements taken with the geometric mean of two scales carry "≈"; the note is printed once as a footnote.
function scaleFootnote(doc, apps, x, y, width) {
  const notes = [...new Set(apps.filter(app => app.scaleNote && !app.pending).map(app => app.scaleNote))];
  if (notes.length) text(doc, `≈ ${notes.join(' · ')}`, x, y, width, 10, false, { color: '#555555' });
}

function numuneBadge(doc, x, y) {
  doc.save().roundedRect(x, y, 150, 30, 6).fill(RED).restore();
  text(doc, 'NUMUNE', x, y + 5, 150, 18, true, { color: '#ffffff', align: 'center', lineBreak: false });
}

function text(doc, value, x, y, width, size = 18, bold = false, extra = {}) {
  doc.font(bold ? 'Bold' : 'Regular').fontSize(size).fillColor(extra.color || '#111111');
  const opts = { width, lineGap: 3, ...extra };
  doc.text(String(value), x, y, opts);
  return doc.heightOfString(String(value), opts);
}

function fittedText(doc, value, x, y, width, height, size, bold = false, extra = {}) {
  doc.font(bold ? 'Bold' : 'Regular');
  while (size >= 10) {
    doc.fontSize(size);
    if (doc.heightOfString(String(value), { width, lineGap: 3 }) <= height) {
      return text(doc, value, x, y, width, size, bold, extra);
    }
    size--;
  }
  throw new RangeError('Başlık veya etiket ayrılan alana sığmıyor.');
}

function box(doc, x, y, width, height, color = '#ffffff') {
  doc.rect(x, y, width, height).fillAndStroke(color, '#666666');
}

function image(doc, buffer, x, y, w, h, label = 'Görsel sağlanmadı') {
  if (buffer !== undefined && buffer !== null) {
    if (!Buffer.isBuffer(buffer)) throw new TypeError('Görseller PNG/JPEG Buffer olmalıdır.');
    doc.image(buffer, x, y, { fit: [w, h], align: 'center', valign: 'center' });
  } else {
    doc.save().rect(x, y, w, h).fill('#f5f5f5').restore();
    text(doc, label, x + 8, y + h / 2 - 12, w - 16, 16, false, { align: 'center' });
  }
}

function logo(doc, brand, x, y, w, h) {
  defaultLogo ||= fs.readFileSync(LOGO_FILE);
  image(doc, brand.logo || defaultLogo, x, y, w, h);
}

// A PDF/SVG design is shown from its vector: the page is rasterised and cut to its ink.
// It stays transparent; the application card behind it carries the fabric colour (or
// the removed proof ground), so white ink stays visible.
async function vectorPreviews(order) {
  for (const app of order.applications) {
    const vector = app.previewVector;
    delete app.previewVector;
    if (app.preview || app.pending || !vector || !Buffer.isBuffer(vector.buffer)) continue;
    try {
      const canvasLib = require('@napi-rs/canvas');
      const { rasterPages } = require('../autoMeasure');
      // 1600 px keeps thin line ends of a large design inside the ink bounds.
      const [raster] = await rasterPages({ buffer: vector.buffer, mime: 'application/pdf' }, 1600, [1], { transparent: true });
      const ground = /^#[0-9a-f]{6}$/i.test(vector.background ?? '') ? [1, 3, 5].map(i => parseInt(vector.background.slice(i, i + 2), 16)) : null;
      let x0 = raster.width, y0 = raster.height, x1 = -1, y1 = -1;
      for (let y = 0; y < raster.height; y++) for (let x = 0; x < raster.width; x++) {
        const i = (y * raster.width + x) * 4, d = raster.data;
        if (d[i + 3] <= 8 || (ground && Math.max(Math.abs(d[i] - ground[0]), Math.abs(d[i + 1] - ground[1]), Math.abs(d[i + 2] - ground[2])) <= 20)) continue;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      if (x1 < 0) continue;
      // Two clear pixels keep antialiased edges whole; the visible margin comes from the card (contain).
      const pad = 2;
      x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(raster.width - 1, x1 + pad); y1 = Math.min(raster.height - 1, y1 + pad);
      const full = canvasLib.createCanvas(raster.width, raster.height);
      full.getContext('2d').putImageData(raster, 0, 0);
      const canvas = canvasLib.createCanvas(x1 - x0 + 1, y1 - y0 + 1), ctx = canvas.getContext('2d');
      ctx.drawImage(full, x0, y0, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
      app.preview = canvas.toBuffer('image/png');
      if (ground) app.previewBackground = vector.background;
    } catch {
      // An unreadable vector falls back to the product-image crop below.
    }
  }
}

// Without a separate or extracted design, the print form shows the measured box cut from the product image.
async function cropPreviews(order) {
  for (const app of order.applications) {
    if (app.preview || app.pending || !app.placement || app.lineIds?.length !== 1) continue;
    const line = order.lines.find(l => l.id === app.lineIds[0]);
    const source = ['front', 'back'].map(key => line?.images[key]).find(image => image?.placements?.includes(app));
    if (!source) continue;
    try {
      const canvasLib = require('@napi-rs/canvas');
      const img = await canvasLib.loadImage(source.buffer);
      const { box, rasterWidth, rasterHeight } = app.placement;
      const sx = img.width / rasterWidth, sy = img.height / rasterHeight;
      const w = Math.max(1, Math.round(box.w * sx)), h = Math.max(1, Math.round(box.h * sy));
      const canvas = canvasLib.createCanvas(w, h);
      canvas.getContext('2d').drawImage(img, box.x * sx, box.y * sy, box.w * sx, box.h * sy, 0, 0, w, h);
      app.preview = canvas.toBuffer('image/png');
      app.previewCropped = true;
    } catch {
      // A failed crop leaves the "preview not provided" note; dimensions stay readable.
    }
  }
}

async function build(order, options, draw) {
  await resolveProductImages(order);
  await vectorPreviews(order);
  await cropPreviews(order);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ autoFirstPage: false, margin: 0, bufferPages: true,
      info: { Title: `${order.orderNo} · ${order.name}`, Author: 'Sipariş Formları' } });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    try {
      doc.registerFont('Regular', path.join(FONT, 'Montserrat-Regular.ttf'));
      doc.registerFont('Bold', path.join(FONT, 'Montserrat-Bold.ttf'));
      doc.pageTags = new Map();
      draw(doc, options.brand || {});
      const pages = doc.bufferedPageRange();
      for (let i = pages.start; i < pages.start + pages.count; i++) {
        doc.switchToPage(i);
        const tag = doc.pageTags.get(i);
        fittedText(doc, `${order.orderNo} · sürüm ${order.version}${tag ? ` · ${tag}` : ''}`, 65, doc.page.height - 34, doc.page.width - 130, 20, 12, false, { align: 'center' });
        text(doc, `${i + 1}`, doc.page.width - 75, doc.page.height - 36, 30, 15, true, { align: 'right' });
      }
      doc.end();
    } catch (error) {
      doc.destroy();
      reject(error);
    }
  });
}

function page(doc, size = PORTRAIT) { doc.addPage({ size, margin: 0 }); }

function title(doc, heading, subtitle) {
  fittedText(doc, heading, 35, 46, 740, 90, 66, true, { align: 'center' });
  if (subtitle) fittedText(doc, subtitle, 40, 209, 730, 70, 30, true, { align: 'center' });
}

// Free text flows onto continuation pages. It is never shortened or clipped.
function parseEmphasis(value) {
  const segments = [];
  String(value).split(/\*([^*\n]+)\*/).forEach((part, i) => {
    if (part) segments.push({ text: part, red: i % 2 === 1 });
  });
  return segments;
}

// Word wrap that keeps colour runs together, so a line is one text item per colour.
function richLines(doc, segments, width, size) {
  doc.font('Regular').fontSize(size);
  const lines = [[]];
  let used = 0;
  let carry = '';
  for (const segment of segments) {
    const tokens = segment.text.match(/\s*\S+/g) || [];
    for (const [index, token] of tokens.entries()) {
      let word = index === 0 && carry && !/^\s/.test(token) ? carry + token : token;
      carry = '';
      const first = used === 0;
      if (first) word = word.trimStart();
      if (!first && used + doc.widthOfString(word) > width) { lines.push([]); used = 0; word = word.trimStart(); }
      const line = lines[lines.length - 1];
      const last = line[line.length - 1];
      if (last && last.red === segment.red) last.text += word; else line.push({ text: word, red: segment.red });
      used += doc.widthOfString(word);
    }
    carry = /\s$/.test(segment.text) ? ' ' : '';
  }
  return lines;
}

function bulletList(doc, items, y, { size = PORTRAIT, x = 61, fontSize = 18, bottom = size[1] - 110 } = {}) {
  const width = size[0] - x - 45;
  const step = fontSize * 1.35;
  for (const item of items) {
    const lines = richLines(doc, parseEmphasis(item), width, fontSize);
    const height = lines.length * step;
    if (y + height > bottom) { page(doc, size); y = 60; }
    doc.save().rect(x - 15, y + step / 2 - 4.5, 7, 7).fill(RED).restore();
    for (const line of lines) {
      let cx = x;
      for (const run of line) {
        doc.font('Regular').fontSize(fontSize).fillColor(run.red ? RED : '#111111');
        doc.text(run.text, cx, y, { lineBreak: false });
        cx += doc.widthOfString(run.text);
      }
      y += step;
    }
    y += 6;
  }
  return y;
}

function validPlacement(placement) {
  const { page, rasterWidth, rasterHeight, box } = placement;
  return [page, rasterWidth, rasterHeight].every(n => Number.isSafeInteger(n) && n > 0) &&
    box && [box.x, box.y, box.w, box.h].every(Number.isFinite) && box.x >= 0 && box.y >= 0 &&
    box.w > 0 && box.h > 0 && box.x + box.w <= rasterWidth && box.y + box.h <= rasterHeight;
}

// G53: one picture holding the front and the back garment shows, in each slot, only
// the garment that view pairing named for it. The whole picture is still what was
// measured; placements move with the cut. A failed cut keeps the whole picture.
async function cutGarment(image, crop, page) {
  if (!crop || !image || crop.page !== page) return image;
  try {
    const canvasLib = require('@napi-rs/canvas');
    const img = await canvasLib.loadImage(image.buffer);
    const sx = img.width / crop.rasterWidth, sy = img.height / crop.rasterHeight;
    const w = Math.max(1, Math.round(crop.w * sx)), h = Math.max(1, Math.round(crop.h * sy));
    const canvas = canvasLib.createCanvas(w, h);
    canvas.getContext('2d').drawImage(img, crop.x * sx, crop.y * sy, crop.w * sx, crop.h * sy, 0, 0, w, h);
    const placements = [];
    for (const app of image.placements) {
      // A placement measured on another raster size of the same picture is scaled first.
      const { box, rasterWidth, rasterHeight } = app.placement, kx = crop.rasterWidth / rasterWidth, ky = crop.rasterHeight / rasterHeight;
      const moved = { ...app.placement, rasterWidth: Math.round(crop.w), rasterHeight: Math.round(crop.h),
        box: { x: box.x * kx - crop.x, y: box.y * ky - crop.y, w: box.w * kx, h: box.h * ky } };
      if (validPlacement(moved)) { app.placement = moved; placements.push(app); }
    }
    return { buffer: canvas.toBuffer('image/png'), placements };
  } catch {
    return image;
  }
}

async function resolveProductImages(order) {
  for (const line of order.lines) {
    const images = { ...line.images };
    for (const [key, view] of [['front', 'on'], ['back', 'arka']]) {
      const source = images[key];
      if (source == null || Buffer.isBuffer(source)) continue;
      if (!Buffer.isBuffer(source.buffer)) throw new TypeError('Ürün görseli Buffer olmalıdır.');
      const placements = order.applications.filter(({ placement, lineIds, width_mm, height_mm }) =>
        placement && width_mm > 0 && height_mm > 0 && lineIds?.length === 1 && lineIds[0] === line.id &&
        source.fileId != null && placement.fileId === source.fileId && placement.view === view && source.view === view && validPlacement(placement));
      if (source.mime !== 'application/pdf') {
        images[key] = await cutGarment({ buffer: source.buffer, placements: placements.filter(app => app.placement.page === 1) }, source.crop, 1);
        continue;
      }
      const pages = new Set(placements.map(app => app.placement.page));
      const selected = pages.size === 1 ? [...pages][0] : null;
      try {
        const { rasterPages } = require('../autoMeasure');
        const { PNG } = require('pngjs');
        const [raster] = await rasterPages(source, 1000, [selected ?? 1]);
        images[key] = raster ? await cutGarment({ buffer: PNG.sync.write(raster), placements: selected ? placements : [] }, source.crop, selected ?? 1) : undefined;
      } catch {
        // An unavailable optional preview leaves the listed dimensions readable.
        images[key] = undefined;
      }
    }
    line.images = images;
  }
}

// G54: product pictures stay clean; sizes are printed on the application cards.
function productImage(doc, source, x, y, w, h) {
  if (source == null || Buffer.isBuffer(source)) return image(doc, source, x, y, w, h);
  doc.image(source.buffer, x, y, { fit: [w, h], align: 'center', valign: 'center' });
}

function productPair(doc, line, y, { x = 40, width = 730, height = 380, labelSize = 22, bold = true } = {}) {
  const half = width / 2;
  productImage(doc, line.images.front, x, y, half - 12, height);
  productImage(doc, line.images.back, x + half + 12, y, half - 12, height);
  text(doc, 'ÖN', x, y + height + 10, half, labelSize, bold, { align: 'center' });
  text(doc, 'ARKA', x + half, y + height + 10, half, labelSize, bold, { align: 'center' });
}
// Width/height of each product picture of a line (a missing one draws a 1:1 placeholder).
function pictureAspects(doc, line) {
  const aspect = source => {
    const buffer = Buffer.isBuffer(source) ? source : source?.buffer;
    if (!Buffer.isBuffer(buffer)) return 1;
    try { const opened = doc.openImage(buffer); return opened.width / opened.height || 1; } catch { return 1; }
  };
  const both = line.images.front != null && line.images.back != null;
  return both ? [aspect(line.images.front), aspect(line.images.back)] : [aspect(line.images.front ?? line.images.back)];
}
// Drawn picture area in a w x h box: two views side by side with labels under them, or one view.
function pictureFit(aspects, w, h, labelSize) {
  if (aspects.length === 1) { const width = Math.min(w, h * aspects[0]); return { area: width * width / aspects[0], height: width / aspects[0] }; }
  const slotW = w / 2 - 12, slotH = Math.max(0, h - labelSize * 1.3 - 12);
  const sizes = aspects.map(a => Math.min(slotW, slotH * a)).map((width, i) => [width, width / aspects[i]]);
  return { area: sizes.reduce((sum, [a, b]) => sum + a * b, 0), height: Math.max(...sizes.map(([, b]) => b)) };
}
// Both views with their ÖN/ARKA labels right under the drawn pictures; a single view fills the box.
function pictures(doc, line, x, y, w, h, { labelSize = 22, bold = true } = {}) {
  const aspects = pictureAspects(doc, line);
  if (aspects.length === 2) productPair(doc, line, y, { x, width: w, height: pictureFit(aspects, w, h, labelSize).height, labelSize, bold });
  else productImage(doc, line.images.front ?? line.images.back, x, y, w, h);
}

// G54 application cards: title, the design on the fabric colour, then "En / Boy".
// A manual size adds its source note in small grey type. Pictures stay clean.
const CARD_WIDTHS = [220, 200, 180, 160, 140, 120, 100];
const CARD_GAP = 10;
const cardNote = app => !app.pending && typeof app.measureNote === 'string' && app.measureNote.trim() ? app.measureNote.trim() : null;
const cardHeight = (cw, notes) => 20 + Math.round(cw * 0.5) + 6 + 15 + (notes ? 12 : 0);
const hexColor = value => /^#[0-9a-f]{6}$/i.test(value ?? '') ? value : null;
function cardColor(line, app) { return hexColor(line?.colorHex) ?? hexColor(app.previewBackground) ?? '#eeeeee'; }
const isDark = hex => [1, 3, 5].reduce((sum, i, k) => sum + parseInt(hex.slice(i, i + 2), 16) * [0.299, 0.587, 0.114][k], 0) < 140;
function sizeLine(app) {
  return app.pending ? PENDING_LABEL : `En: ${cm(app.width_mm)} cm   Boy: ${cm(app.height_mm)} cm${app.scaleNote ? ' ≈' : ''}`;
}
// One line that shrinks (down to 6 pt) instead of wrapping or leaving its box.
function lineText(doc, value, x, y, width, size, bold, color = '#111111') {
  doc.font(bold ? 'Bold' : 'Regular');
  while (size > 6 && doc.fontSize(size).widthOfString(String(value)) > width) size -= 0.5;
  text(doc, value, x, y, width, size, bold, { align: 'center', color, lineBreak: false, height: size * 1.4, ellipsis: true });
}
const PREVIEW_MARGIN = 10;
function applicationCard(doc, line, app, x, y, cw, notes) {
  lineText(doc, `${TYPES[app.type]} · ${POSITION_LABELS[app.position]}`, x, y, cw, 11, true);
  const ph = Math.round(cw * 0.5), py = y + 20, color = cardColor(line, app);
  doc.save().roundedRect(x, py, cw, ph, 6).fill(color).restore();
  doc.save().lineWidth(0.6).strokeColor('#b0b0b0').roundedRect(x, py, cw, ph, 6).stroke().restore();
  // Contain: the whole design at its own ratio, an even margin on the limiting side.
  if (Buffer.isBuffer(app.preview)) doc.image(app.preview, x + PREVIEW_MARGIN, py + PREVIEW_MARGIN, { fit: [cw - 2 * PREVIEW_MARGIN, ph - 2 * PREVIEW_MARGIN], align: 'center', valign: 'center' });
  else lineText(doc, 'Önizleme yok', x, py + ph / 2 - 6, cw, 9, false, isDark(color) ? '#ffffff' : '#666666');
  if (Buffer.isBuffer(app.preview) && app.previewCropped) lineText(doc, 'görselden kırpıldı', x, py + ph - 10, cw, 6.5, false, isDark(color) ? '#dddddd' : '#555555');
  lineText(doc, sizeLine(app), x, py + ph + 6, cw, 10, true);
  const note = cardNote(app);
  if (notes && note) lineText(doc, note, x, py + ph + 21, cw, 8, false, '#555555');
}
// Every arrangement that fits the area is scored by the drawn area of the product
// pictures at their own aspect ratio; within 10% of the best area, larger cards win,
// then fewer rows under the pictures. Everything stays inside the area; null when
// nothing fits.
// below: cards only in the grid under full-width pictures (a tall area such as the print form).
function cardLayout(n, area, notes, { minImageW = 200, maxImageW = Infinity, minImageH = 120, top = 0, maxRows = Infinity, labelSize = 22, aspects = [1, 1], below = false, maxRightCols = 6, minCardW = 100 } = {}) {
  const fits = [];
  for (const cw of CARD_WIDTHS) {
    if (cw < minCardW) continue;
    const ch = cardHeight(cw, notes), gridCols = Math.max(1, Math.floor((area.w + CARD_GAP) / (cw + CARD_GAP)));
    for (let rightCols = below ? 0 : 1; rightCols <= (below ? 0 : maxRightCols); rightCols++) {
      const rightW = rightCols ? rightCols * cw + (rightCols - 1) * CARD_GAP : 0, imageW = area.w - rightW - (rightCols ? 16 : 0);
      if (imageW < minImageW) break;
      if (imageW > maxImageW) continue;
      for (let rows = 0; rows <= Math.min(maxRows, Math.ceil(n / gridCols)); rows++) {
        const imageH = area.h - rows * (ch + CARD_GAP);
        if (imageH < Math.max(minImageH, top)) break;
        const right = rightCols ? Math.min(n, Math.max(0, Math.floor((imageH - top + CARD_GAP) / (ch + CARD_GAP))) * rightCols) : 0;
        if (n - right > rows * gridCols) continue;
        fits.push({ cw, ch, rightCols, rightW, imageW, imageH, right, gridCols, rows,
          picture: pictureFit(aspects, imageW, imageH, labelSize).area });
        break;
      }
    }
  }
  if (!fits.length) return null;
  const best = Math.max(...fits.map(f => f.picture));
  return fits.filter(f => f.picture >= best * 0.9).sort((a, b) => b.cw - a.cw || a.rows - b.rows || a.rightCols - b.rightCols)[0];
}
const chartHeight = rows => rows.length ? 44 + rows.length * 18 : 0;
function bodySizeTable(doc, rows, x, y, width) {
  if (!rows.length) return;
  lineText(doc, 'Beden Ölçüleri (cm)', x, y, width, 11, true);
  const columns = [0.26, 0.37, 0.37];
  [['Beden', '(A) Boy', '(B) Göğüs'], ...rows.map(([s,v]) => [s, String(v.boy).replace('.', ','), String(v.gogus).replace('.', ',')])].forEach((row, r) => {
    let cx = x;
    row.forEach((value, c) => {
      const w = width * columns[c], cy = y + 20 + r * 18;
      box(doc, cx, cy, w, 18, r ? '#ffffff' : '#e7e7e9');
      lineText(doc, value, cx + 2, cy + 3, w - 4, 9, r === 0);
      cx += w;
    });
  });
}
// Pictures on the left, cards beside them and in a grid below. Cards that cannot fit
// the area move to a cards page at the end of the form (flushCards), never off the page.
function productBlock(doc, line, apps, area, options = {}) {
  const rows = options.sizeChart ? bodyRows(line.bedenTablosu) : [];
  const top = (options.top || 0) + chartHeight(rows);
  const notes = apps.some(cardNote), layout = apps.length ? cardLayout(apps.length, area, notes, { ...options, top,
    ...(rows.length ? { minCardW:180 } : {}), aspects: pictureAspects(doc, line) }) : null;
  if (!layout) {
    if (apps.length) (doc.deferredCards ||= []).push({ line, apps, rows });
    const sideW = rows.length ? 220 : 0;
    pictures(doc, line, area.x, area.y, sideW ? area.w - sideW - 16 : options.imageOnlyW ?? area.w, area.h, options);
    if (rows.length) bodySizeTable(doc, rows, area.x + area.w - sideW, area.y, sideW);
    return null;
  }
  pictures(doc, line, area.x, area.y, layout.imageW, layout.imageH, options);
  const { cw, ch, rightCols, rightW, right, gridCols } = layout, rightX = area.x + area.w - rightW;
  bodySizeTable(doc, rows, rightX, area.y + (options.top || 0), rightW);
  // Without cards beside them the grid follows the drawn pictures, not the end of their box.
  const aspects = pictureAspects(doc, line), labels = aspects.length === 2 ? (options.labelSize ?? 22) * 1.3 + 12 : 0;
  const gridTop = area.y + (rightCols ? layout.imageH : Math.min(layout.imageH, pictureFit(aspects, layout.imageW, layout.imageH, options.labelSize ?? 22).height + labels)) + CARD_GAP;
  apps.forEach((app, i) => {
    const k = i - right;
    const [x, y] = i < right
      ? [rightX + (i % rightCols) * (cw + CARD_GAP), area.y + top + Math.floor(i / rightCols) * (ch + CARD_GAP)]
      : [area.x + (k % gridCols) * (cw + CARD_GAP), gridTop + Math.floor(k / gridCols) * (ch + CARD_GAP)];
    applicationCard(doc, line, app, x, y, cw, notes);
  });
  return { ...layout, rightX };
}
function flushCards(doc, size = PORTRAIT) {
  for (const { line, apps, rows = [] } of doc.deferredCards || []) {
    const notes = apps.some(cardNote), cw = 220, ch = cardHeight(cw, notes), cols = Math.floor((size[0] - 80 + CARD_GAP) / (cw + CARD_GAP));
    let y = size[1];
    apps.forEach((app, i) => {
      const col = i % cols;
      if (col === 0 && y + ch > size[1] - 60) {
        page(doc, size);
        lineText(doc, `Uygulamalar · ${line.product} · ${line.color}`, 40, 30, size[0] - 80, 18, true);
        y = 70;
        bodySizeTable(doc, rows, 40, y, cw);
        y += chartHeight(rows);
      }
      applicationCard(doc, line, app, 40 + col * (cw + CARD_GAP), y, cw, notes);
      if (col === cols - 1) y += ch + CARD_GAP;
    });
  }
  doc.deferredCards = [];
}
const appsOfLine = (apps, line) => apps.filter(app => !app.lineIds || app.lineIds.includes(line.id));

// Centered single-line label inside a table cell.
function cellText(doc, value, x, y, w, h, size, bold, align = 'center') {
  text(doc, value, x + 4, y + (h - size * 1.25) / 2, w - 8, size, bold, { align });
}

const HEAD_DARK = '#8ea9db';
const HEAD_LIGHT = '#bdd7ee';
const SIZE_BLUE = '#b4c6e7';

function applicationTableLayout(doc, apps) {
  const legs = apps.some(app => (POSITION_ALIASES[app.position] || app.position) === 'bacak');
  const columns = legs ? { ...POSITIONS, ...LEG_POSITION } : POSITIONS;
  const x = 82, labelWidth = 188, cellWidth = legs ? 460 / 6 : 92, headHeight = 36;
  const positions = Object.keys(columns);
  // Each entry is its size and, for a manual size, its source note in smaller grey type.
  const cells = ['baski', 'nakis'].map(type => positions.map(position =>
    apps.filter(app => app.type === type && (POSITION_ALIASES[app.position] || app.position) === position).map(app => ({
      text: SIDED.includes(app.position) ? `${POSITION_LABELS[app.position]} · ${dimensions(app)}` : dimensions(app),
      note: !app.pending && typeof app.measureNote === 'string' && app.measureNote.trim() ? app.measureNote.trim() : null }))));
  const entryHeight = entry => doc.font('Regular').fontSize(9).heightOfString(entry.text, { width: cellWidth - 6, lineGap: 2 })
    + (entry.note ? doc.font('Regular').fontSize(7).heightOfString(entry.note, { width: cellWidth - 6, lineGap: 2 }) : 0);
  const heights = cells.map(row => Math.max(36, ...row.map(list => list.length
    ? 40 + list.reduce((sum, entry) => sum + entryHeight(entry), 0) : 0)));
  const height = headHeight + heights[0] + heights[1];
  if (height > 1120) throw new RangeError('Tek konumda sayfaya sığmayacak kadar çok uygulama var.');
  return { x, labelWidth, cellWidth, headHeight, columns, positions, cells, heights, height, entryHeight };
}

function applicationTable(doc, apps, y) {
  const { x, labelWidth, cellWidth, headHeight, columns, positions, cells, heights, height, entryHeight } = applicationTableLayout(doc, apps);
  if (y + height > 1230) { page(doc); y = 65; }
  const headers = ['Özellikler', ...Object.values(columns)];
  let cx = x;
  for (let i = 0; i < headers.length; i++) {
    const width = i ? cellWidth : labelWidth;
    box(doc, cx, y, width, headHeight, i ? HEAD_LIGHT : HEAD_DARK);
    cellText(doc, headers[i], cx, y, width, headHeight, 13, true);
    cx += width;
  }
  y += headHeight;
  for (let r = 0; r < 2; r++) {
    box(doc, x, y, labelWidth, heights[r]);
    text(doc, TYPES[['baski', 'nakis'][r]], x + 8, y + 10, labelWidth - 16, 14);
    for (let c = 0; c < positions.length; c++) {
      const cellX = x + labelWidth + c * cellWidth;
      box(doc, cellX, y, cellWidth, heights[r]);
      if (cells[r][c].length) {
        text(doc, '+', cellX, y + 3, cellWidth, 26, true, { align: 'center' });
        let entryY = y + 34;
        for (const entry of cells[r][c]) {
          text(doc, entry.text, cellX + 3, entryY, cellWidth - 6, 9, false, { align: 'center', lineGap: 2 });
          if (entry.note) text(doc, entry.note, cellX + 3, entryY + doc.font('Regular').fontSize(9).heightOfString(entry.text, { width: cellWidth - 6, lineGap: 2 }),
            cellWidth - 6, 7, false, { align: 'center', lineGap: 2, color: '#555555' });
          entryY += entryHeight(entry);
        }
      }
    }
    y += heights[r];
  }
  return y + 31;
}

const isBlank = lines => lines.some(l => l.blank);
function sizeColumns(lines) {
  if (!lines.some(l => l.distributed || l.blank)) return [];
  const child = [...new Set(lines.flatMap(l => Object.keys(l.sizes)).filter(k => !SIZES.includes(k) && k !== 'Diğer' && total(lines, k) > 0))]
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  // Age-range orders drop the adult columns nobody ordered.
  const standard = child.length ? SIZES.filter(s => total(lines, s) > 0) : SIZES;
  return [...standard, ...child, ...(lines.some(l => Object.hasOwn(l.sizes, 'Diğer')) ? ['Diğer'] : [])];
}
function sizeSummary(lines) { return sizeColumns(lines).map(s => `${s}:${isBlank(lines) ? '…' : total(lines, s)}`).join('  '); }

function sizeTable(doc, lines, y, orderTotal) {
  const columns = sizeColumns(lines);
  const tableHeight = columns.length ? 34 + 3 * 37 : 0;
  if (y + tableHeight + 60 > 1330) { page(doc); y = 65; }
  const blank = isBlank(lines);
  const summary = blank ? 'Toplam adet:                    Sipariş toplamı:' : `Toplam adet: ${total(lines)} · Sipariş toplamı: ${orderTotal}`;
  if (!columns.length) {
    text(doc, summary, 82, y, 646, 18, true);
    return;
  }
  const x = 86, labelWidth = 202, cellWidth = Math.min(50, 400 / columns.length);
  const rows = [
    ['Bedenler', columns.map(c => c), 34],
    ['Kesilmesi Gerekenler', columns.map(c => blank ? '' : String(total(lines, c))), 37],
    ['Kesilen Adet', columns.map(() => ''), 37],
    ['', columns.map(() => ''), 37],
  ];
  let cy = y;
  rows.forEach(([label, values, h], r) => {
    box(doc, x, cy, labelWidth, h, SIZE_BLUE);
    if (label) cellText(doc, label, x + 4, cy, labelWidth - 4, h, 14, true, 'left');
    values.forEach((value, c) => {
      const cx = x + labelWidth + c * cellWidth;
      box(doc, cx, cy, cellWidth, h, r === 0 ? '#d3dff2' : '#ffffff');
      if (value) cellText(doc, value, cx, cy, cellWidth, h, value.length > 4 ? 8 : columns.length > 8 ? 11 : 13, false);
    });
    cy += h;
  });
  if (!blank) text(doc, `toplam adet: ${total(lines)}`, x + labelWidth + columns.length * cellWidth + 8, y + 52, 80, 9, true);
  text(doc, summary, x, cy + 14, 646, 14, true);
}

async function renderProductionForm(input, options = {}) {
  const order = normalize(input);
  return build(order, options, doc => {
    for (const line of order.lines) {
      page(doc);
      title(doc, 'Üretim Formu');
      if (line.numune) numuneBadge(doc, 630, 10);
      fittedText(doc, `Sipariş No: ${order.orderNo}`, 40, 140, 730, 60, 40, true, { align: 'center' });
      let y = 209;
      y += fittedText(doc, `Sipariş Adı: ${order.name}`, 40, y, 730, 75, 30, true, { align: 'center' }) + 20;
      y = Math.max(y, 266);
      box(doc, 182, y, 176, 40, SIZE_BLUE); box(doc, 358, y, 267, 40);
      cellText(doc, 'Teslim Tarihi', 182, y, 176, 40, 16, true);
      fittedText(doc, order.deliveryDate, 363, y + 9, 257, 28, 17, true, { align: 'center', color: RED });
      y += 62;
      text(doc, 'Ürün Açıklaması:', 54, y, 700, 24, true);
      y = bulletList(doc, [`${line.product} · ${line.color} · ${line.fabric}`, ...(line.note ? [line.note] : []), ...order.description], y + 34);
      const appsList = appsFor(order, [line]);
      const tableHeight = applicationTableLayout(doc, appsList).height;
      const note = appsList.some(app => app.scaleNote && !app.pending) ? 16 : 0;
      // The table and the size table are never split: the product image shrinks to what is left of the page.
      const sizeNeed = (sizeColumns([line]).length ? 34 + 3 * 37 : 0) + 60;
      // Cards share the picture area, which may then grow past the old picture height.
      const room = top => Math.min(appsList.length ? 640 : 411, 1230 - top - 13 - tableHeight, 1330 - top - 13 - tableHeight - 31 - note - sizeNeed);
      // With cards under the pictures the template's spare space above them is used.
      y = Math.max(y + 12, appsList.length ? 430 : 497);
      let imageHeight = room(y + 34);
      if (imageHeight < 130) { page(doc); y = 60; imageHeight = room(y + 34); }
      text(doc, 'Ürün Görseli:', 28, y, 700, 24, true);
      productBlock(doc, line, appsList, { x: 40, y: y + 34, w: 730, h: imageHeight }, { labelSize: 14, minImageW: 300 });
      y = applicationTable(doc, appsList, y + 34 + imageHeight + 13);
      scaleFootnote(doc, appsList, 82, y - 24, 646);
      sizeTable(doc, [line], y, total(order.lines));
    }
    flushCards(doc);
  });
}

// Identical bounded columns on approval and workshop pages.
function formBands(doc, order, lines, y) {
  const x = 40, gap = 16, width = doc.page.width - 80, col = (width - gap) / 2;
  const fontSize = doc.page.width > 1000 ? 16 : 12;
  const rows = [
    [`Ürün Modeli: ${[...new Set(lines.map(l => l.product))].join(', ')}`, `Sipariş Kodu: ${order.orderNo}`],
    [`Ürün Rengi: ${[...new Set(lines.map(l => l.color))].join(', ')}`, `Tarih: ${order.date}`],
  ];
  for (const [r, row] of rows.entries()) {
    doc.font('Regular').fontSize(fontSize);
    const h = Math.max(36, ...row.map(v => doc.heightOfString(v, { width: col - 24, lineGap: 3 }) + 16));
    row.forEach((value, c) => {
      const cx = x + c * (col + gap);
      doc.roundedRect(cx, y, col, h, 6).fill(r ? '#8f8f99' : '#454655');
      text(doc, value, cx + 12, y + 8, col - 24, fontSize, false, { color: '#ffffff' });
    });
    y += h + 6;
  }
  const summary = `Bedenler ve Adetler: ${sizeSummary(lines)}   ${doc.page.width > 1000 ? 'Toplam:' : 'Toplam adet: '}${isBlank(lines) ? '…' : total(lines)}`;
  doc.font('Regular').fontSize(fontSize);
  const h = Math.max(36, doc.heightOfString(summary, { width: width - 24, lineGap: 3 }) + 16);
  doc.roundedRect(x, y, width, h, 6).fill('#454655');
  text(doc, summary, x + 12, y + 8, width - 24, fontSize, false, { color: '#ffffff' });
  return y + h;
}

function termsEntries(source) {
  const rows = source.split('\n').map(row => row.trim());
  while (rows.length && (!rows[0] || rows[0].toLocaleUpperCase('tr-TR') === TERMS_TITLE)) rows.shift();
  const entries = [];
  for (const row of rows) {
    if (!row) { if (entries.length) entries[entries.length - 1].gap = 6; continue; }
    entries.push({ value: row, head: /^\d+\.\s/.test(row), gap: 0 });
  }
  return entries;
}

// The terms always fit one page by shrinking the type; only an extreme custom text continues.
function termsPage(doc, source) {
  page(doc, LANDSCAPE);
  doc.pageTags.set(doc.bufferedPageRange().count - 1, 'Şartlar ve Koşullar');
  text(doc, TERMS_TITLE, 50, 38, 1340, 22, true, { align: 'center', color: RED });
  const entries = termsEntries(source);
  const measure = size => entries.reduce((sum, entry) =>
    sum + doc.font(entry.head ? 'Bold' : 'Regular').fontSize(size).heightOfString(entry.value, { width: 1340, lineGap: 3 }) + entry.gap + (entry.head ? 2 : 0), 0);
  let size = 18;
  while (size > 11 && 82 + measure(size) > 755) size--;
  let y = 82;
  for (const entry of entries) {
    const height = doc.font(entry.head ? 'Bold' : 'Regular').fontSize(size).heightOfString(entry.value, { width: 1340, lineGap: 3 });
    if (y + height > 755) { page(doc, LANDSCAPE); y = 50; }
    text(doc, entry.value, 50, y, 1340, size, entry.head, { align: 'center' });
    y += height + entry.gap + (entry.head ? 2 : 0);
  }
}

async function renderApprovalForm(input, options = {}) {
  const order = normalize(input);
  return build(order, options, (doc, brand) => {
    const colors = [...new Set(order.lines.map(line => line.color))];
    for (const color of colors) {
      const lines = order.lines.filter(line => line.color === color);
      // Two models of one color share a page. Larger color groups continue separately.
      for (let offset = 0; offset < lines.length; offset += 2) {
        const batch = lines.slice(offset, offset + 2);
        page(doc, LANDSCAPE);
        fittedText(doc, 'Onay Formu', 40, 6, 1360, 80, 62, true, { align: 'center' });
        if (batch.some(line => line.numune)) numuneBadge(doc, 1230, 20);
        const headerBottom = formBands(doc, order, batch, 90);
        logo(doc, brand, 40, 10, 125, 65);
        const apps = appsFor(order, batch);
        const start = Math.max(235, headerBottom + 24), rowHeight = (745 - start) / batch.length;
        batch.forEach((line, i) => {
          const y = start + i * rowHeight;
          const labelHeight = batch.length > 1 ? fittedText(doc, line.product, 40, y, 900, 30, 16, true, { align: 'center' }) + 5 : 0;
          productBlock(doc, line, appsOfLine(apps, line), { x:40, y:y + labelHeight, w:1360, h:rowHeight - labelHeight - 10 },
            { minImageW:600, maxRightCols:1, sizeChart:true, minImageH:120, labelSize:batch.length > 1 ? 18 : 28, bold:false });
        });
        scaleFootnote(doc, apps, 40, 752, 1360);
      }
    }
    flushCards(doc, LANDSCAPE);
    termsPage(doc, brand.termsText === undefined ? loadDefaultTerms() : requiredText(brand.termsText, 'brand.termsText'));
  });
}

function loadDefaultTerms() {
  defaultTerms ||= fs.readFileSync(TERMS_FILE, 'utf8');
  return defaultTerms;
}

// Stock items with a swatch number print as "Lacivert (Kartela 14)".
function colorLabel(name, colorNo) {
  const color = String(name ?? '').trim();
  const no = String(colorNo ?? '').trim();
  return color && no ? `${color} (Kartela ${no})` : color;
}

function renderWorkshop(input, options, type) {
  const order = normalize(input);
  const wanted = appsFor(order, order.lines, type);
  // Applications still awaiting a measurement are not workshop work; the form lists them as missing.
  const apps = wanted.filter(app => !app.pending);
  if (apps.length === 0) return null;
  const missing = wanted.filter(app => app.pending).map(app =>
    `*Eksik:* ${POSITION_LABELS[app.position]} ${TYPES[type].toLocaleLowerCase('tr-TR')} uygulaması için ölçü teyidi bekleniyor; forma alınmadı.`);
  return build(order, options, (doc, brand) => {
    const lines = order.lines.filter(line => apps.some(app => !app.lineIds || app.lineIds.includes(line.id)));
    page(doc);
    title(doc, `${TYPES[type]} Formu`);
    const headerBottom = formBands(doc, order, lines, 150);
    if (lines.some(line => line.numune)) numuneBadge(doc, 630, 10);
    const notes = lines.filter(line => line.note).map(line => `${line.product}: ${line.note}`);
    const described = [...notes, ...order.description, ...missing];
    // Nothing to describe: no heading either; the images move up.
    if (described.length) text(doc, 'Ürün Açıklaması:', 54, headerBottom + 20, 700, 24, true);
    let visualY = described.length ? bulletList(doc, described, headerBottom + 54) + 15 : headerBottom + 20;
    if (visualY + 400 > 1210) { page(doc); visualY = 60; }
    text(doc, 'Ürün Görseli:', 28, visualY, 720, 24, true);
    visualY += 50;
    for (let i = 0; i < lines.length;) {
      const count = Math.min(2, lines.length - i);
      const rowHeight = (1210 - visualY) / count;
      for (let r = 0; r < count; r++, i++) {
        const line = lines[i];
        const y = visualY + r * rowHeight;
        const label = `${line.product} · ${line.color} · ${line.fabric}${order.omitQuantities ? ' · Adet:' : ` · Adet: ${total([line])}`}`;
        const labelHeight = fittedText(doc, label, 45, y, 720, 60, 18, true, { align: 'center' });
        const areaHeight = Math.max(140, Math.min(count > 1 ? rowHeight - labelHeight - 25 : 640, rowHeight - labelHeight - 25));
        productBlock(doc, line, appsOfLine(apps, line), { x: 45, y: y + labelHeight + 15, w: 720, h: areaHeight }, { minImageW: 300, maxRightCols:1, sizeChart:true });
      }
      logo(doc, brand, 310, 1250, 190, 100);
      if (i < lines.length) { page(doc); visualY = 60; }
    }
    // Up to two product rows fit on page one; longer orders use continuation pages.
    let y = 60;
    page(doc);
    for (const app of apps) {
      if (y + 395 > 1350) { page(doc); y = 60; }
      text(doc, POSITION_LABELS[app.position].toLocaleUpperCase('tr-TR'), 45, y, 720, 28, true, { align: 'center' });
      if (app.lineIds) text(doc, lines.filter(line => app.lineIds.includes(line.id)).map(line => `${line.product} / ${line.color}`).join(', '), 45, y + 42, 720, 16, false, { align: 'center' });
      // Same fabric-coloured ground as the card, so white ink stays visible.
      if (Buffer.isBuffer(app.preview)) doc.save().roundedRect(175, y + 85, 460, 230, 6).fill(cardColor(lines.find(line => app.lineIds?.includes(line.id)), app)).restore();
      if (Buffer.isBuffer(app.preview)) doc.image(app.preview, 175 + 2 * PREVIEW_MARGIN, y + 85 + 2 * PREVIEW_MARGIN,
        { fit: [460 - 4 * PREVIEW_MARGIN, 230 - 4 * PREVIEW_MARGIN], align: 'center', valign: 'center' });
      else image(doc, app.preview, 175, y + 85, 460, 230, 'Desen önizlemesi sağlanmadı');
      text(doc, dimensions(app), 45, y + 335, 720, 26, true, { align: 'center' });
      scaleFootnote(doc, [app], 45, y + 368, 720);
      if (app.previewCropped) text(doc, 'Ürün görselinden kırpıldı', 175, y + 318, 460, 11, false, { align: 'center', color: '#666666' });
      y += 420;
    }
    flushCards(doc);
  });
}

// The swatch number is only valid while the line colour is still the stock item's colour.
function stockColorLabel(lineColor, item) {
  const norm = value => String(value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('tr-TR');
  const same = item && norm(lineColor) && norm(lineColor) === norm(item.color_name);
  return colorLabel(lineColor, same ? item.color_no : '');
}

function renderPrintForm(order, options = {}) { return renderWorkshop(order, options, 'baski'); }
function renderEmbroideryForm(order, options = {}) { return renderWorkshop(order, options, 'nakis'); }

module.exports = { renderProductionForm, renderApprovalForm, renderPrintForm, renderEmbroideryForm, parseEmphasis, colorLabel, stockColorLabel };
