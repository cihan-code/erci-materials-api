'use strict';

const PDFDocument = require('pdfkit');
const fs = require('node:fs');
const path = require('node:path');

const PORTRAIT = [810, 1440];
const LANDSCAPE = [1440, 810];
const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL'];
const POSITIONS = { gogus: 'Göğüs', sirt: 'Sırt', kol: 'Kol', ense: 'Ense', kapuson: 'Kapüşon' };
const TYPES = { baski: 'Baskı', nakis: 'Nakış' };
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
  const lines = order.lines.map(line => {
    requiredText(line.id, 'line.id');
    if (ids.has(line.id)) throw new TypeError('Satır kimlikleri benzersiz olmalıdır.');
    ids.add(line.id);
    for (const field of ['product', 'color', 'fabric']) requiredText(line[field], `line.${field}`);
    if (line.sizes != null && (typeof line.sizes !== 'object' || Array.isArray(line.sizes))) throw new TypeError('line.sizes nesne olmalıdır.');
    const sizes = Object.fromEntries(SIZES.map(size => [size, 0]));
    for (const [size, qty] of Object.entries(line.sizes || {})) {
      if (!size.trim() || !Number.isSafeInteger(qty) || qty < 0) throw new RangeError(`Geçersiz beden/adet: ${size}`);
      const column = SIZES.includes(size) ? size : 'Diğer';
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
    if (!Object.hasOwn(TYPES, app.type) || !Object.hasOwn(POSITIONS, app.position)) throw new TypeError('Geçersiz uygulama türü veya konumu.');
    for (const field of ['width_mm', 'height_mm']) {
      if (!Number.isSafeInteger(app[field]) || app[field] < 0) throw new RangeError(`${field} negatif olmayan tam sayı olmalıdır; eksik ölçüyü önce teyit edin.`);
    }
    if (app.lineIds !== undefined && (!Array.isArray(app.lineIds) || !app.lineIds.length || app.lineIds.some(id => !ids.has(id)))) {
      throw new TypeError('lineIds yalnız mevcut satır kimliklerini içermelidir.');
    }
  }
  total(lines); // Reject unsafe totals before creating any document.
  return { ...order, lines };
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
function dimensions(app) { return `${String(app.width_mm / 10).replace('.', ',')} × ${String(app.height_mm / 10).replace('.', ',')} cm`; }

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

function build(order, options, draw) {
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

function productPair(doc, line, y, { x = 40, width = 730, height = 380, labelSize = 22, bold = true } = {}) {
  const half = width / 2;
  image(doc, line.images.front, x, y, half - 12, height);
  image(doc, line.images.back, x + half + 12, y, half - 12, height);
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
  const x = 82, labelWidth = 188, cellWidth = 92, headHeight = 36;
  const positions = Object.keys(POSITIONS);
  const cells = ['baski', 'nakis'].map(type => positions.map(position =>
    apps.filter(app => app.type === type && app.position === position).map(dimensions)));
  const heights = cells.map(row => Math.max(36, ...row.map(list => list.length
    ? 40 + doc.font('Regular').fontSize(9).heightOfString(list.join('\n'), { width: cellWidth - 6, lineGap: 2 }) : 0)));
  const height = headHeight + heights[0] + heights[1];
  if (height > 1120) throw new RangeError('Tek konumda sayfaya sığmayacak kadar çok uygulama var.');
  if (y + height > 1230) { page(doc); y = 65; }
  const headers = ['Özellikler', ...Object.values(POSITIONS)];
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

function sizeColumns(lines) { return lines.some(l=>l.distributed) ? [...SIZES,...(lines.some(l=>Object.hasOwn(l.sizes,'Diğer')) ? ['Diğer'] : [])] : []; }
function sizeSummary(lines) { return sizeColumns(lines).map(s=>`${s}:${total(lines,s)}`).join('  '); }

function sizeTable(doc, lines, y, orderTotal) {
  const columns = sizeColumns(lines);
  const tableHeight = columns.length ? 34 + 3 * 37 : 0;
  if (y + tableHeight + 60 > 1330) { page(doc); y = 65; }
  const summary = `Toplam adet: ${total(lines)} · Sipariş toplamı: ${orderTotal}`;
  if (!columns.length) {
    text(doc, summary, 82, y, 646, 18, true);
    return;
  }
  const x = 86, labelWidth = 202, cellWidth = Math.min(50, 400 / columns.length);
  const rows = [
    ['Bedenler', columns.map(c => c), 34],
    ['Kesilmesi Gerekenler', columns.map(c => String(total(lines, c))), 37],
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
      if (value) cellText(doc, value, cx, cy, cellWidth, h, columns.length > 8 ? 11 : 13, false);
    });
    cy += h;
  });
  text(doc, 'toplam adet:', x + labelWidth + columns.length * cellWidth + 8, y + 52, 80, 9, true);
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
      y = bulletList(doc, [`${line.product} · ${line.color} · ${line.fabric}`, ...order.description], y + 34);
      const appsList = appsFor(order, [line]);
      const tableHeight = 36 * 3 + 40 * appsList.length;
      const fixed = 30 + 13 + Math.min(tableHeight, 200) + 31 + (line.distributed ? 150 + 40 : 40);
      y = Math.max(y + 12, 497);
      let imageHeight = Math.min(411, 1345 - y - fixed);
      if (imageHeight < 220) { page(doc); y = 60; imageHeight = 411; }
      text(doc, 'Ürün Görseli:', 28, y, 700, 24, true);
      const both = line.images.front != null && line.images.back != null;
      if (both) productPair(doc, line, y + 34, { x: 82, width: 648, height: imageHeight - 30, labelSize: 14 });
      else image(doc, line.images.front ?? line.images.back, 182, y + 34, 452, imageHeight);
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
        wholeBand(doc, `Bedenler ve Adetler : ${sizeSummary(lines)}   Toplam:${total(lines)}`, 171, '#454655');
        batch.forEach((line, i) => {
          const y = 250 + i * 270;
          const labelHeight = batch.length > 1 ? fittedText(doc, line.product, 10, y, 760, 30, 16, true, { align: 'center' }) + 5 : 0;
          const height = batch.length > 1 ? 190 : 340;
          productPair(doc, line, y + labelHeight + (batch.length > 1 ? 0 : 84), { x: 10, width: 760, height, labelSize: batch.length > 1 ? 18 : 28, bold: false });
        });
        logo(doc, brand, 940, 335, 320, 290);
        const apps = appsFor(order, batch);
        paragraphs(doc, apps.map(app => `${TYPES[app.type]} · ${POSITIONS[app.position]}: ${dimensions(app)}`), 650,
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
  const apps = appsFor(order, order.lines, type);
  if (apps.length === 0) return null;
  return build(order, options, (doc, brand) => {
    const lines = order.lines.filter(line => apps.some(app => !app.lineIds || app.lineIds.includes(line.id)));
    page(doc);
    title(doc, `${TYPES[type]} Formu`, `Ürün: ${[...new Set(lines.map(line => line.product))].join(', ')}`);
    text(doc, 'Ürün Açıklaması:', 54, 270, 700, 24, true);
    let visualY = bulletList(doc, [`Toplam adet: ${total(lines)}`, ...(sizeColumns(lines).length ? [`Bedenler ve Adetler: ${sizeSummary(lines)}`] : []), ...order.description], 304) + 15;
    if (visualY + 400 > 1210) { page(doc); visualY = 60; }
    text(doc, 'Ürün Görseli:', 28, visualY, 720, 24, true);
    visualY += 50;
    for (let i = 0; i < lines.length;) {
      const count = Math.min(2, lines.length - i);
      const rowHeight = (1210 - visualY) / count;
      for (let r = 0; r < count; r++, i++) {
        const line = lines[i];
        const y = visualY + r * rowHeight;
        const labelHeight = fittedText(doc, `${line.product} · ${line.color} · ${line.fabric} · Adet: ${total([line])}`, 45, y, 720, 60, 18, true, { align: 'center' });
        const imageHeight = Math.max(100, Math.min(350, rowHeight - labelHeight - 65));
        productPair(doc, line, y + labelHeight + 15, { height: imageHeight });
      }
      logo(doc, brand, 310, 1250, 190, 100);
      if (i < lines.length) { page(doc); visualY = 60; }
    }
    // Up to two product rows fit on page one; longer orders use continuation pages.
    let y = 60;
    page(doc);
    for (const app of apps) {
      if (y + 395 > 1350) { page(doc); y = 60; }
      text(doc, POSITIONS[app.position].toLocaleUpperCase('tr-TR'), 45, y, 720, 28, true, { align: 'center' });
      if (app.lineIds) text(doc, lines.filter(line => app.lineIds.includes(line.id)).map(line => `${line.product} / ${line.color}`).join(', '), 45, y + 42, 720, 16, false, { align: 'center' });
      image(doc, app.preview, 175, y + 85, 460, 230, 'Desen önizlemesi sağlanmadı');
      text(doc, dimensions(app), 45, y + 335, 720, 26, true, { align: 'center' });
      y += 420;
    }
  });
}

function renderPrintForm(order, options = {}) { return renderWorkshop(order, options, 'baski'); }
function renderEmbroideryForm(order, options = {}) { return renderWorkshop(order, options, 'nakis'); }

module.exports = { renderProductionForm, renderApprovalForm, renderPrintForm, renderEmbroideryForm, parseEmphasis, colorLabel };
