'use strict';

const PDFDocument = require('pdfkit');
const fs = require('node:fs');
const path = require('node:path');

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
function dimensions(app) { return app.pending ? PENDING_LABEL : `${cm(app.width_mm)} × ${cm(app.height_mm)} cm`; }

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
function paragraphs(doc, items, y, { size = PORTRAIT, x = 45, width = size[0] - 90, fontSize = 19, bottom = size[1] - 110, align = 'left' } = {}) {
  for (const item of items) {
    const words = String(item).split(/\s+/);
    let line = '';
    for (const word of words) {
      doc.font('Regular').fontSize(fontSize);
      const candidate = line ? `${line} ${word}` : word;
      if (doc.widthOfString(candidate) > width && line) {
        if (y + fontSize * 1.6 > bottom) { page(doc, size); y = 60; }
        y += text(doc, line, x, y, width, fontSize, false, { align }) + 5;
        line = word;
      } else line = candidate;
    }
    if (line) {
      const height = doc.font('Regular').fontSize(fontSize).heightOfString(line, { width, lineGap: 3 });
      if (y + height > bottom) { page(doc, size); y = 60; }
      if (height > bottom - 60) throw new RangeError('Bir metin parçası sayfaya sığmayacak kadar uzun.');
      y += text(doc, line, x, y, width, fontSize, false, { align }) + 10;
    }
  }
  return y;
}

// "*vurgu*" prints red; an unpaired asterisk stays literal.
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
        images[key] = { buffer: source.buffer, placements: placements.filter(app => app.placement.page === 1) };
        continue;
      }
      const pages = new Set(placements.map(app => app.placement.page));
      const selected = pages.size === 1 ? [...pages][0] : null;
      try {
        const { rasterPages } = require('../autoMeasure');
        const { PNG } = require('pngjs');
        const [raster] = await rasterPages(source, 1000, [selected ?? 1]);
        images[key] = raster ? { buffer: PNG.sync.write(raster), placements: selected ? placements : [] } : undefined;
      } catch {
        // An unavailable optional preview leaves the listed dimensions readable.
        images[key] = undefined;
      }
    }
    line.images = images;
  }
}

const DIMENSION_BLUE = '#94dcff';

function dimensionMark(doc, x0, y0, x1, y1, label, bounds, vertical) {
  // A dark outline keeps the pale blue line visible on both light and dark products.
  doc.save().lineCap('round');
  const ticks = vertical ? [3, 0] : [0, 3];
  for (const [weight, color] of [[3.2, '#244358'], [1.5, DIMENSION_BLUE]]) {
    doc.lineWidth(weight).strokeColor(color)
      .moveTo(x0, y0).lineTo(x1, y1)
      .moveTo(x0 - ticks[0], y0 - ticks[1]).lineTo(x0 + ticks[0], y0 + ticks[1])
      .moveTo(x1 - ticks[0], y1 - ticks[1]).lineTo(x1 + ticks[0], y1 + ticks[1]).stroke();
  }
  const fontSize = 11, labelHeight = 16;
  const labelWidth = doc.font('Bold').fontSize(fontSize).widthOfString(label) + 10;
  const labelX = Math.max(bounds.x, Math.min(bounds.right - labelWidth, vertical ? x0 + 5 : (x0 + x1 - labelWidth) / 2));
  const desiredY = vertical ? (y0 + y1 - labelHeight) / 2 : y0 - labelHeight - 4;
  const labelY = Math.max(bounds.y, Math.min(bounds.bottom - labelHeight, desiredY));
  doc.rect(labelX, labelY, labelWidth, labelHeight).fill(DIMENSION_BLUE);
  text(doc, label, labelX, labelY + 1, labelWidth, fontSize, true, { color: '#183448', align: 'center', lineBreak: false });
  doc.restore();
}

function productImage(doc, source, apps, x, y, w, h) {
  if (source == null || Buffer.isBuffer(source)) return image(doc, source, x, y, w, h);
  const { buffer, placements } = source;
  const opened = doc.openImage(buffer);
  doc.image(opened, x, y, { fit: [w, h], align: 'center', valign: 'center' });
  if (opened.orientation && opened.orientation !== 1) return;
  const scale = Math.min(w / opened.width, h / opened.height);
  const width = opened.width * scale, height = opened.height * scale;
  const left = x + (w - width) / 2, top = y + (h - height) / 2;
  const bounds = { x, y, right: x + w, bottom: y + h };
  for (const app of placements) {
    if (!apps.includes(app)) continue;
    const { box, rasterWidth, rasterHeight, swapAxes } = app.placement;
    // The measured raster can round either side by one pixel during downsampling.
    if (Math.abs(rasterWidth * opened.height - rasterHeight * opened.width) > opened.width + opened.height) continue;
    const sx = width / rasterWidth, sy = height / rasterHeight;
    const x0 = left + box.x * sx, x1 = x0 + box.w * sx;
    const y0 = top + box.y * sy, y1 = y0 + box.h * sy;
    const widthY = y0 - y >= 24 ? y0 - 6 : y0 + 6;
    const heightX = x1 + 6 <= bounds.right - 6 ? x1 + 6 : x1 - 6;
    dimensionMark(doc, x0, widthY, x1, widthY, `${cm(swapAxes ? app.height_mm : app.width_mm)} cm`, bounds, false);
    dimensionMark(doc, heightX, y0, heightX, y1, `${cm(swapAxes ? app.width_mm : app.height_mm)} cm`, bounds, true);
  }
}

function productPair(doc, line, apps, y, { x = 40, width = 730, height = 380, labelSize = 22, bold = true } = {}) {
  const half = width / 2;
  productImage(doc, line.images.front, apps, x, y, half - 12, height);
  productImage(doc, line.images.back, apps, x + half + 12, y, half - 12, height);
  text(doc, 'ÖN', x, y + height + 10, half, labelSize, bold, { align: 'center' });
  text(doc, 'ARKA', x + half, y + height + 10, half, labelSize, bold, { align: 'center' });
}

// Centered single-line label inside a table cell.
function cellText(doc, value, x, y, w, h, size, bold, align = 'center') {
  text(doc, value, x + 4, y + (h - size * 1.25) / 2, w - 8, size, bold, { align });
}

const HEAD_DARK = '#8ea9db';
const HEAD_LIGHT = '#bdd7ee';
const SIZE_BLUE = '#b4c6e7';

function applicationTable(doc, apps, y) {
  const legs = apps.some(app => (POSITION_ALIASES[app.position] || app.position) === 'bacak');
  const columns = legs ? { ...POSITIONS, ...LEG_POSITION } : POSITIONS;
  const x = 82, labelWidth = 188, cellWidth = legs ? 460 / 6 : 92, headHeight = 36;
  const positions = Object.keys(columns);
  const cells = ['baski', 'nakis'].map(type => positions.map(position =>
    apps.filter(app => app.type === type && (POSITION_ALIASES[app.position] || app.position) === position).map(app =>
      SIDED.includes(app.position) ? `${POSITION_LABELS[app.position]} · ${dimensions(app)}` : dimensions(app))));
  const heights = cells.map(row => Math.max(36, ...row.map(list => list.length
    ? 40 + doc.font('Regular').fontSize(9).heightOfString(list.join('\n'), { width: cellWidth - 6, lineGap: 2 }) : 0)));
  const height = headHeight + heights[0] + heights[1];
  if (height > 1120) throw new RangeError('Tek konumda sayfaya sığmayacak kadar çok uygulama var.');
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
        text(doc, cells[r][c].join('\n'), cellX + 3, y + 34, cellWidth - 6, 9, false, { align: 'center', lineGap: 2 });
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
function sizeSummary(lines) { return sizeColumns(lines).map(s => `${s}:${isBlank(lines) ? '' : total(lines, s)}`).join('  '); }

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
      const tableHeight = 36 * 3 + 40 * appsList.length;
      const fixed = 30 + 13 + Math.min(tableHeight, 200) + 31 + (line.distributed || line.blank ? 150 + 40 : 40);
      y = Math.max(y + 12, 497);
      let imageHeight = Math.min(411, 1345 - y - fixed);
      if (imageHeight < 220) { page(doc); y = 60; imageHeight = 411; }
      text(doc, 'Ürün Görseli:', 28, y, 700, 24, true);
      const both = line.images.front != null && line.images.back != null;
      if (both) productPair(doc, line, appsList, y + 34, { x: 82, width: 648, height: imageHeight - 30, labelSize: 14 });
      else productImage(doc, line.images.front ?? line.images.back, appsList, 182, y + 34, 452, imageHeight);
      y = applicationTable(doc, appsList, y + 34 + imageHeight + 13) ;
      sizeTable(doc, [line], y, total(order.lines));
    }
  });
}

function band(doc, label, value, x, y, width, color, valueX) {
  doc.roundedRect(x, y, width, 36, 8).fill(color);
  text(doc, label, x < 0 ? 16 : x + 16, y + 8, 160, 16, false, { color: '#ffffff' });
  fittedText(doc, `: ${value}`, valueX, y + 8, x + width - valueX - 20, 24, 17, false, { color: '#ffffff' });
}

function wholeBand(doc, value, y, color) {
  doc.rect(0, y, 1440, 36).fill(color);
  fittedText(doc, value, 31, y + 8, 1380, 24, 17, false, { color: '#ffffff' });
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
        band(doc, 'Ürün Modeli', [...new Set(batch.map(line => line.product))].join(', '), -30, 90, 570, '#454655', 206);
        band(doc, 'Ürün Rengi', color, -30, 126, 570, '#8f8f99', 206);
        band(doc, 'Sipariş Kodu', order.orderNo, 750, 81, 720, '#454655', 941);
        band(doc, 'Tarih', order.date, 750, 126, 720, '#8f8f99', 941);
        wholeBand(doc, `Bedenler ve Adetler : ${sizeSummary(lines)}   Toplam:${order.omitQuantities ? '' : total(lines)}`, 171, '#454655');
        const apps = appsFor(order, batch);
        batch.forEach((line, i) => {
          const y = 250 + i * 270;
          const labelHeight = batch.length > 1 ? fittedText(doc, line.product, 10, y, 760, 30, 16, true, { align: 'center' }) + 5 : 0;
          const height = batch.length > 1 ? 190 : 340;
          productPair(doc, line, apps, y + labelHeight + (batch.length > 1 ? 0 : 84), { x: 10, width: 760, height, labelSize: batch.length > 1 ? 18 : 28, bold: false });
        });
        logo(doc, brand, 940, 335, 320, 290);
        paragraphs(doc, apps.map(app => `${TYPES[app.type]} · ${POSITION_LABELS[app.position]}: ${dimensions(app)}`), 650,
          { size: LANDSCAPE, x: 900, width: 500, fontSize: 18, bottom: 750 });
      }
    }
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
    title(doc, `${TYPES[type]} Formu`, `Ürün: ${[...new Set(lines.map(line => line.product))].join(', ')}`);
    text(doc, 'Ürün Açıklaması:', 54, 270, 700, 24, true);
    const blank = order.omitQuantities;
    const quantities = [`Toplam adet:${blank ? '' : ` ${total(lines)}`}`, ...(sizeColumns(lines).length ? [`Bedenler ve Adetler: ${sizeSummary(lines)}`] : [])];
    const notes = lines.filter(line => line.note).map(line => `${line.product}: ${line.note}`);
    let visualY = bulletList(doc, [...quantities, ...notes, ...order.description, ...missing], 304) + 15;
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
        const imageHeight = Math.max(100, Math.min(350, rowHeight - labelHeight - 65));
        productPair(doc, line, apps, y + labelHeight + 15, { height: imageHeight });
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
      image(doc, app.preview, 175, y + 85, 460, 230, 'Desen önizlemesi sağlanmadı');
      text(doc, dimensions(app), 45, y + 335, 720, 26, true, { align: 'center' });
      if (app.previewCropped) text(doc, 'Ürün görselinden kırpıldı', 175, y + 318, 460, 11, false, { align: 'center', color: '#666666' });
      y += 420;
    }
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
