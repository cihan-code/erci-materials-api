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
const PLACEHOLDER_TERMS = 'Bu metin bir yer tutucudur. Gerçek şartlar ve koşullar marka tarafından sağlanacaktır. Ölçü, renk, adet ve teslim bilgileri sipariş onayında kontrol edilmelidir.';

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
  image(doc, brand.logo || fs.readFileSync(path.join(__dirname, 'assets', 'placeholder-logo.png')), x, y, w, h);
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
      draw(doc, options.brand || {});
      const pages = doc.bufferedPageRange();
      for (let i = pages.start; i < pages.start + pages.count; i++) {
        doc.switchToPage(i);
        fittedText(doc, `${order.orderNo} · sürüm ${order.version}`, 65, doc.page.height - 34, doc.page.width - 130, 20, 12, false, { align: 'center' });
        text(doc, `${i + 1}`, doc.page.width - 65, doc.page.height - 34, 30, 12, false, { align: 'right' });
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
  text(doc, heading, 35, 42, 740, 66, true, { align: 'center' });
  if (subtitle) fittedText(doc, subtitle, 40, 150, 730, 70, 28, true, { align: 'center' });
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

function productPair(doc, line, y, { x = 40, width = 730, height = 380 } = {}) {
  const half = width / 2;
  image(doc, line.images.front, x, y, half - 12, height);
  image(doc, line.images.back, x + half + 12, y, half - 12, height);
  text(doc, 'ÖN', x, y + height + 10, half, 22, true, { align: 'center' });
  text(doc, 'ARKA', x + half, y + height + 10, half, 22, true, { align: 'center' });
}

function applicationTable(doc, apps, y) {
  const x = 40, labelWidth = 120, cellWidth = 122;
  const positions = Object.keys(POSITIONS);
  const contents = ['baski', 'nakis'].map(type => positions.map(position =>
    apps.filter(app => app.type === type && app.position === position).map(dimensions).join('\n') || '-'));
  const heights = contents.map(row => Math.max(40, ...row.map(value => doc.font('Regular').fontSize(15).heightOfString(value, { width: cellWidth - 8, lineGap: 3 }) + 16)));
  const height = 38 + heights[0] + heights[1];
  if (height > 1120) throw new RangeError('Tek konumda sayfaya sığmayacak kadar çok uygulama var.');
  if (y + height > 1230) { page(doc); y = 65; }
  const headers = ['Özellikler', ...Object.values(POSITIONS)];
  let cx = x;
  for (let i = 0; i < headers.length; i++) {
    const width = i ? cellWidth : labelWidth;
    box(doc, cx, y, width, 38, i ? '#bed7eb' : '#92acd4');
    text(doc, headers[i], cx + 3, y + 9, width - 6, 16, true, { align: 'center' });
    cx += width;
  }
  y += 38;
  for (let r = 0; r < 2; r++) {
    box(doc, x, y, labelWidth, heights[r]);
    text(doc, TYPES[['baski', 'nakis'][r]], x + 8, y + 10, labelWidth - 16, 16);
    for (let c = 0; c < positions.length; c++) {
      box(doc, x + labelWidth + c * cellWidth, y, cellWidth, heights[r]);
      text(doc, contents[r][c], x + labelWidth + c * cellWidth + 4, y + 8, cellWidth - 8, 15, false, { align: 'center' });
    }
    y += heights[r];
  }
  return y + 25;
}

function sizeColumns(lines) { return lines.some(l=>l.distributed) ? [...SIZES,...(lines.some(l=>Object.hasOwn(l.sizes,'Diğer')) ? ['Diğer'] : [])] : []; }
function sizeSummary(lines) { return sizeColumns(lines).map(s=>`${s}:${total(lines,s)}`).join('  '); }

function sizeTable(doc, lines, y, orderTotal) {
  if (y + 160 > 1360) { page(doc); y = 65; }
  if (!lines.some(l=>l.distributed)) {
    text(doc, `Toplam adet: ${total(lines)} · Sipariş toplamı: ${orderTotal}`, 40, y, 730, 18, true);
    return;
  }
  const columns = sizeColumns(lines);
  const x = 40, widths = [130, ...columns.map(() => 510/columns.length), 90];
  const rows = [ ['Bedenler', ...columns, 'Toplam'], ['Adet', ...columns.map(s => String(total(lines, s))), String(total(lines))] ];
  for (let r = 0; r < 2; r++) {
    let cx = x;
    rows[r].forEach((value, c) => {
      box(doc, cx, y + r * 42, widths[c], 42, r === 0 || c === 0 ? '#b5c7e3' : '#ffffff');
      text(doc, value, cx + 4, y + r * 42 + 11, widths[c] - 8, 16, true, { align: c ? 'center' : 'left' });
      cx += widths[c];
    });
  }
  text(doc, `Toplam adet: ${total(lines)} · Sipariş toplamı: ${orderTotal}`, x, y + 102, 730, 18, true);
}

async function renderProductionForm(input, options = {}) {
  const order = normalize(input);
  return build(order, options, doc => {
    for (const line of order.lines) {
      page(doc);
      title(doc, 'Üretim Formu');
      fittedText(doc, `Sipariş No: ${order.orderNo}`, 40, 147, 730, 60, 42, true, { align: 'center' });
      let y = 215;
      y += fittedText(doc, `Sipariş Adı: ${order.name}`, 40, y, 730, 75, 28, true, { align: 'center' }) + 16;
      box(doc, 180, y, 180, 42, '#b5c7e3'); box(doc, 360, y, 270, 42);
      text(doc, 'Teslim Tarihi', 185, y + 10, 170, 18, true, { align: 'center' });
      fittedText(doc, order.deliveryDate, 365, y + 10, 260, 28, 18, true, { align: 'center', color: '#ff3333' });
      y += 70;
      text(doc, 'Ürün Açıklaması:', 45, y, 720, 23, true);
      y = paragraphs(doc, [`${line.product} · ${line.color} · ${line.fabric}`, ...order.description.map(t => `• ${t}`)], y + 38);
      if (y + 440 > 1120) { page(doc); y = 60; }
      text(doc, 'Ürün Görseli:', 40, y + 8, 730, 23, true);
      productPair(doc, line, y + 55, { height: 350 });
      y = applicationTable(doc, appsFor(order, [line]), y + 460);
      sizeTable(doc, [line], y, total(order.lines));
    }
  });
}

function band(doc, value, x, y, width, color) {
  doc.rect(x, y, width, 36).fill(color);
  fittedText(doc, value, x + 15, y + 7, width - 30, 24, 18, false, { color: '#ffffff' });
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
        text(doc, 'Onay Formu', 40, 6, 1360, 66, true, { align: 'center' });
        band(doc, `Ürün Modeli: ${[...new Set(batch.map(line => line.product))].join(', ')}`, 0, 82, 525, '#464657');
        band(doc, `Ürün Rengi: ${color}`, 0, 126, 525, '#92929c');
        band(doc, `Sipariş Kodu: ${order.orderNo}`, 750, 82, 690, '#464657');
        band(doc, `Tarih: ${order.date}`, 750, 126, 690, '#92929c');
        band(doc, `Bedenler ve Adetler   ${sizeSummary(lines)}   Toplam:${total(lines)}`, 0, 171, 1440, '#464657');
        batch.forEach((line, i) => {
          const y = 260 + i * 240;
          const labelHeight = batch.length > 1 ? fittedText(doc, line.product, 30, y, 810, 30, 18, true, { align: 'center' }) + 5 : 10;
          productPair(doc, line, y + labelHeight, { x: 30, width: 810, height: batch.length > 1 ? 155 : 355 });
        });
        logo(doc, brand, 1000, 285, 250, 180);
        const apps = appsFor(order, batch);
        paragraphs(doc, apps.map(app => `${TYPES[app.type]} · ${POSITIONS[app.position]}: ${dimensions(app)}`), 510,
          { size: LANDSCAPE, x: 900, width: 500, fontSize: 20, bottom: 750 });
      }
    }
    page(doc, LANDSCAPE);
    text(doc, 'Sipariş Onay Formu · Şartlar ve Koşullar', 50, 50, 1340, 24, false, { align: 'center', color: '#ff3333' });
    const terms = brand.termsText === undefined ? PLACEHOLDER_TERMS : requiredText(brand.termsText, 'brand.termsText');
    paragraphs(doc, terms.split('\n'), 100, { size: LANDSCAPE, fontSize: 16, bottom: 730, align: 'center' });
  });
}

function renderWorkshop(input, options, type) {
  const order = normalize(input);
  const apps = appsFor(order, order.lines, type);
  if (apps.length === 0) return null;
  return build(order, options, (doc, brand) => {
    const lines = order.lines.filter(line => apps.some(app => !app.lineIds || app.lineIds.includes(line.id)));
    page(doc);
    title(doc, `${TYPES[type]} Formu`, `Ürün: ${[...new Set(lines.map(line => line.product))].join(', ')}`);
    text(doc, 'Ürün Açıklaması:', 45, 245, 720, 24, true);
    let visualY = paragraphs(doc, [`Toplam adet: ${total(lines)}`, ...(sizeColumns(lines).length ? [`Bedenler ve Adetler: ${sizeSummary(lines)}`] : []), ...order.description.map(t => `• ${t}`)], 290) + 15;
    if (visualY + 400 > 1210) { page(doc); visualY = 60; }
    text(doc, 'Ürün Görseli:', 45, visualY, 720, 24, true);
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

module.exports = { renderProductionForm, renderApprovalForm, renderPrintForm, renderEmbroideryForm };
