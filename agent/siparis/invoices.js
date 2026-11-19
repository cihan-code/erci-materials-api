'use strict';
// Finance invoice lines → invoice_lines. One row per (source invoice, source line). Content changes re-match the line
// while it waits for delivery; after delivery they only open a confirmation. Only an 'eslesti' result binds a stock
// item, a 'teyit' line stays unbound with a confirmation, and stock moves only on delivery.
const crypto = require('crypto');
const { tx, audit, fail } = require('./db');
const { assertUser } = require('./auth');
const { matchInvoiceLine, parseInvoiceDescription, splitFabricKey } = require('./matching');
const { receive } = require('./stock');

const UNITS = { kg: 'kg', kgm: 'kg', kgs: 'kg', kilo: 'kg', kilogram: 'kg', g: 'g', gr: 'g', grm: 'g', gram: 'g',
  m: 'm', mt: 'm', mtr: 'm', metre: 'm', meter: 'm', adet: 'adet', ad: 'adet', c62: 'adet', nar: 'adet', pcs: 'adet' };
const MAX_LINES = 500;
const FILTERS = { eslesti: "match_status='eslesti'", teyit: "match_status='teyit'", eslesmedi: "match_status='eslesmedi'",
  teslim_bekliyor: "delivery_status='teslim_bekliyor'", teslim_alindi: "delivery_status='teslim_alindi'" };
const fold = v => String(v ?? '').toLocaleLowerCase('tr-TR').replace(/ı/g, 'i').normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
const text = (v, max) => (v == null ? null : String(v).trim().slice(0, max) || null);
const now = () => new Date().toISOString();
const json = (v, empty) => (v ? JSON.parse(v) : empty);
const label = line => `${line.invoice_no || line.source_invoice_id} / satır ${line.source_line_id}`;
const get = (db, id) => db.prepare('SELECT * FROM invoice_lines WHERE id=?').get(id);

function readLine(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'Satır nesne olmalı.' };
  const base = { sourceInvoiceId: text(raw.sourceInvoiceId, 100), sourceLineId: text(raw.sourceLineId, 100) };
  if (!base.sourceInvoiceId || !base.sourceLineId) return { ...base, error: 'Kaynak fatura ve satır kimliği gerekli.' };
  const description = text(raw.description, 1000) || '';
  const q = typeof raw.quantity === 'number' ? raw.quantity
    : typeof raw.quantity === 'string' && /^\d+(\.\d+)?$/.test(raw.quantity.trim()) ? Number(raw.quantity) : NaN;
  if (!Number.isFinite(q) || q <= 0) return { ...base, error: 'Miktar okunamadı.' };
  let unit = UNITS[fold(raw.unit)];
  if (!fold(raw.unit)) {
    // No unit on the invoice: the description's unit counts only when its amount is exactly the line amount.
    const p = parseInvoiceDescription(description);
    if (!p.unit || p.qtyMilli !== Math.round(q * 1000)) return { ...base, error: 'Birim yok ve açıklamadan doğrulanamadı.' };
    unit = p.unit;
  } else if (!unit) return { ...base, error: `Birim tanınmadı: "${String(raw.unit).slice(0, 20)}".` };
  const qtyMilli = Math.round(unit === 'g' ? q : q * 1000);
  if (unit === 'g') unit = 'kg';
  if (!Number.isSafeInteger(qtyMilli) || qtyMilli <= 0) return { ...base, error: 'Miktar okunamadı.' };
  return { ...base, description, qtyMilli, unit, invoiceNo: text(raw.invoiceNo, 100), invoiceDate: text(raw.invoiceDate, 40),
    supplier: text(raw.supplier, 300), supplierVkn: text(raw.supplierVkn, 20), purchaseRef: text(raw.purchaseRef, 100),
    unitPrice: typeof raw.unitPrice === 'number' && Number.isFinite(raw.unitPrice) ? raw.unitPrice : null,
    deliveryConfirmed: raw.deliveryConfirmed === true,
    hash: crypto.createHash('sha256').update(JSON.stringify([description, qtyMilli, unit])).digest('hex') };
}

const meaningful = key => typeof key === 'string' && key.includes('|') && !key.startsWith('legacy:');
// A bound item's key is the fact. For an unbound or legacy-bound need the main fabric may fall back to the product
// default and the order colour; another material is its own type with unknown colour. Such needs never bind (bindable).
function toNeed(r) {
  const main = r.material_key === 'kumas', bound = meaningful(r.fabric_key);
  return { orderLineId: r.id, orderNo: r.order_no, shortageMilli: r.shortage_milli,
    fabricKey: bound ? r.fabric_key : main ? null : r.material_key,
    productKey: !bound && main ? r.product_key : null, colorName: !bound && main ? r.color_name : null };
}
function openNeedRows(db) {
  return db.prepare(`SELECT a.id,a.order_line_id,a.material_key,a.item_id,a.shortage_milli,l.product_key,l.color_name,o.order_no,s.fabric_key
    FROM allocations a JOIN order_lines l ON l.id=a.order_line_id JOIN order_versions v ON v.id=l.version_id
    JOIN orders o ON o.id=v.order_id LEFT JOIN stock_items s ON s.id=a.item_id
    WHERE v.status='onaylandi' AND a.shortage_milli>0 ORDER BY a.id`).all();
}
function evaluate(db, line) {
  const rows = openNeedRows(db), byId = new Map(rows.map(r => [r.id, r]));
  const r = matchInvoiceLine({ line: { sourceInvoiceId: line.source_invoice_id, sourceLineId: line.source_line_id,
    description: line.description, qtyMilli: line.qty_milli, unit: line.unit, purchaseRef: line.purchase_ref }, openNeeds: rows.map(toNeed) });
  if (r.status !== 'eslesti') return { status: 'teyit', fabricKey: r.fabricKey, item: null, allocations: [], reasons: r.reasons };
  // The matcher works on keys; reserving needs the need's allocation to sit on the very item the key names.
  const item = db.prepare('SELECT * FROM stock_items WHERE fabric_key=?').get(r.fabricKey);
  const problems = [];
  if (item && item.unit !== line.unit) problems.push(`${r.fabricKey} kalemi ${item.unit} biriminde, fatura satırı ${line.unit}.`);
  for (const a of r.allocations) {
    const need = byId.get(a.orderLineId);
    if (need.item_id == null) problems.push(`${need.order_no} siparişinin ${need.material_key} malzemesi bir stok kalemine bağlı değil; önce siparişte kalem seçilmeli.`);
    else if (!item || need.item_id !== item.id) problems.push(`${need.order_no} siparişi başka bir stok kalemine bağlı (${need.fabric_key}); fatura satırı ${r.fabricKey}.`);
  }
  if (problems.length) return { status: 'teyit', fabricKey: r.fabricKey, item: null, allocations: [],
    reasons: [...problems, `Eşleştirme önerisi: ${r.reasons.join(' ')}`] };
  return { status: 'eslesti', fabricKey: r.fabricKey, item, reasons: r.reasons, allocations: r.allocations.map(a => {
    const need = byId.get(a.orderLineId);
    return { allocationId: need.id, orderLineId: need.order_line_id, materialKey: need.material_key, orderNo: need.order_no, qtyMilli: a.qtyMilli };
  }) };
}
function createItem(db, key, unit, userId) {
  const { type, color } = splitFabricKey(key);
  const id = Number(db.prepare('INSERT INTO stock_items(fabric_key,name,color_name,unit) VALUES(?,?,?,?)')
    .run(key, type.replace(/_/g, ' '), color.replace(/_/g, ' '), unit).lastInsertRowid);
  audit(db, userId, 'stok_kalemi_olustur', id, { fabricKey: key });
  return db.prepare('SELECT * FROM stock_items WHERE id=?').get(id);
}
function openConfirmation(db, line, message) {
  if (!db.prepare("SELECT id FROM confirmations WHERE kind='fatura_eslesme' AND ref_table='invoice_lines' AND ref_id=? AND message=? AND status='acik'").get(line.id, message))
    db.prepare("INSERT INTO confirmations(kind,ref_table,ref_id,message) VALUES('fatura_eslesme','invoice_lines',?,?)").run(line.id, message);
}
function closeConfirmations(db, lineId, userId) {
  db.prepare("UPDATE confirmations SET status='cozuldu',resolved_by=? WHERE kind='fatura_eslesme' AND ref_table='invoice_lines' AND ref_id=? AND status='acik'")
    .run(userId ?? null, lineId);
}
function applyMatch(db, line, match, userId) {
  if (match.status === 'eslesti') {
    const item = match.item || createItem(db, match.fabricKey, line.unit, userId);
    db.prepare(`UPDATE invoice_lines SET match_status='eslesti',item_id=?,fabric_key=?,color_name=?,allocation_json=?,match_reasons_json=?,updated_at=? WHERE id=?`)
      .run(item.id, match.fabricKey, item.color_name, JSON.stringify(match.allocations), JSON.stringify(match.reasons), now(), line.id);
    return item;
  }
  db.prepare(`UPDATE invoice_lines SET match_status='teyit',item_id=NULL,fabric_key=?,color_name=NULL,allocation_json=NULL,match_reasons_json=?,updated_at=? WHERE id=?`)
    .run(match.fabricKey ?? null, JSON.stringify(match.reasons), now(), line.id);
  openConfirmation(db, line, `Fatura satırı teyit bekliyor (${label(line)}): ${match.reasons.join(' ')}`);
  return null;
}
// receive() takes one entry per order line; two materials of one line on the same item are summed.
function perOrderLine(allocations) {
  const sums = new Map();
  for (const a of allocations) sums.set(a.orderLineId, (sums.get(a.orderLineId) || 0) + a.qtyMilli);
  return [...sums].map(([orderLineId, qtyMilli]) => ({ orderLineId, qtyMilli }));
}
const outcome = (line, status, reasons) => ({ id: line.id, sourceInvoiceId: line.source_invoice_id, sourceLineId: line.source_line_id,
  status, matchStatus: line.match_status, deliveryStatus: line.delivery_status, reasons });

// Finance marks a batch as sent on any 2xx, so a line that cannot be stored is kept visible as an open confirmation.
function reject(db, raw, input, reason, { source, userId }) {
  return tx(db, () => {
    const ref = `${input.sourceInvoiceId ?? '?'}:${input.sourceLineId ?? '?'}`;
    const keep = raw && typeof raw === 'object' ? { invoiceNo: raw.invoiceNo, description: text(raw.description, 300), quantity: raw.quantity, unit: raw.unit } : {};
    audit(db, userId, 'fatura_satiri_reddet', ref, { source, reason, line: keep });
    const auditId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
    const message = `Fatura satırı alınamadı (${ref}${keep.invoiceNo ? ', ' + keep.invoiceNo : ''}): ${reason}`;
    if (!db.prepare("SELECT id FROM confirmations WHERE kind='fatura_eslesme' AND ref_table='audit_log' AND message=? AND status='acik'").get(message))
      db.prepare("INSERT INTO confirmations(kind,ref_table,ref_id,message) VALUES('fatura_eslesme','audit_log',?,?)").run(auditId, message);
    return { id: null, sourceInvoiceId: input.sourceInvoiceId ?? null, sourceLineId: input.sourceLineId ?? null,
      status: 'reddedildi', matchStatus: null, deliveryStatus: null, reasons: [reason] };
  });
}
function ingestLine(db, input, { source, userId }) {
  return tx(db, () => {
    const fields = [input.supplier, input.description, input.qtyMilli, input.unit, input.purchaseRef, source, input.invoiceNo,
      input.invoiceDate, input.supplierVkn, input.unitPrice, input.hash];
    let line = db.prepare('SELECT * FROM invoice_lines WHERE source_invoice_id=? AND source_line_id=?').get(input.sourceInvoiceId, input.sourceLineId);
    let status;
    if (!line) {
      const id = Number(db.prepare(`INSERT INTO invoice_lines(supplier,description,qty_milli,unit,purchase_ref,source,invoice_no,invoice_date,
        supplier_vkn,unit_price,content_hash,source_invoice_id,source_line_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(...fields, input.sourceInvoiceId, input.sourceLineId, now(), now()).lastInsertRowid);
      audit(db, userId, 'fatura_satiri_al', id, { source, invoiceNo: input.invoiceNo });
      line = get(db, id); status = 'yeni';
    } else if (line.content_hash === input.hash) {
      return outcome(line, 'ayni', json(line.match_reasons_json, []));
    } else if (line.delivery_status === 'teslim_alindi') {
      const message = `Teslim alınmış fatura satırının içeriği değişti (${label(line)}); kayıt değiştirilmedi, ekip kontrol etmeli.`;
      openConfirmation(db, line, message);
      audit(db, userId, 'fatura_satiri_degisti', line.id, { before: line.content_hash, after: input.hash });
      return outcome(line, 'reddedildi', [message]);
    } else {
      db.prepare(`UPDATE invoice_lines SET supplier=?,description=?,qty_milli=?,unit=?,purchase_ref=?,source=?,invoice_no=?,invoice_date=?,
        supplier_vkn=?,unit_price=?,content_hash=?,updated_at=? WHERE id=?`).run(...fields, now(), line.id);
      // Earlier teyit reasons describe the old content; the new match decides afresh.
      closeConfirmations(db, line.id, userId);
      audit(db, userId, 'fatura_satiri_guncelle', line.id, { before: line.content_hash, after: input.hash });
      line = get(db, line.id); status = 'guncellendi';
    }
    const match = evaluate(db, line);
    const item = applyMatch(db, line, match, userId);
    const reasons = [...match.reasons];
    if (input.deliveryConfirmed && item) {
      // "Teslimi de doğruluyorsa tek adımda": same transaction as the match.
      receive(db, { invoiceLineId: line.id, itemId: item.id, qtyMilli: line.qty_milli, allocations: perOrderLine(match.allocations), userId });
      reasons.push('Teslim doğrulandı; miktar stoğa girdi.');
    } else if (input.deliveryConfirmed) reasons.push('Teslim doğrulandı ama eşleşme teyit bekliyor; stoğa girmedi.');
    return outcome(get(db, line.id), status, reasons);
  });
}
function ingest(db, body, { userId = null } = {}) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.lines)) fail('lines listesi gerekli');
  if (body.lines.length > MAX_LINES) fail(`Bir istekte en çok ${MAX_LINES} satır gönderilebilir`, 413);
  if (userId != null) assertUser(db, userId);
  const context = { source: text(body.source, 100), userId };
  return body.lines.map(raw => {
    const input = readLine(raw);
    if (input.error) return reject(db, raw, input, input.error, context);
    try { return ingestLine(db, input, context); }
    catch (err) {
      // A business refusal must not vanish (Finance will not resend); unexpected errors fail the batch for a retry.
      if (err.status && err.status < 500) return reject(db, raw, input, err.message, context);
      throw err;
    }
  });
}

function deliver(db, id, { itemId, allocations } = {}, userId) {
  return tx(db, () => {
    assertUser(db, userId);
    const line = get(db, id);
    if (!line) fail('Fatura satırı bulunamadı', 404);
    const waiting = line.delivery_status === 'teslim_bekliyor';
    const chosen = itemId == null ? line.item_id : Number(itemId);
    if (chosen == null) fail('Teslim için stok kalemi seçilmeli', 409);
    if (waiting && chosen !== line.item_id) {
      if (!db.prepare('SELECT id FROM stock_items WHERE id=?').get(chosen)) fail('Stok kalemi bulunamadı', 404);
      db.prepare('UPDATE invoice_lines SET item_id=?,updated_at=? WHERE id=?').run(chosen, now(), id);
      audit(db, userId, 'fatura_kalem_sec', id, { from: line.item_id, to: chosen });
    }
    let plan = allocations;
    if (plan === undefined && waiting && chosen === line.item_id && line.match_status === 'eslesti' && line.allocation_json) {
      const suggested = json(line.allocation_json, []);
      // The suggestion was computed at match time; a need that has since shrunk or moved needs a person to redistribute.
      for (const s of suggested) {
        const a = db.prepare('SELECT * FROM allocations WHERE id=?').get(s.allocationId);
        if (!a || a.item_id !== chosen || a.shortage_milli < s.qtyMilli) fail('Eşleşme önerisi artık geçerli değil; dağıtımı elle verin.', 409);
      }
      plan = perOrderLine(suggested);
    }
    const movement = receive(db, { invoiceLineId: id, itemId: chosen, qtyMilli: line.qty_milli, allocations: plan, userId });
    if (waiting) closeConfirmations(db, id, userId);
    return { line: view(db, get(db, id)), movement };
  });
}

function orderNoOf(db, orderLineId) {
  return db.prepare('SELECT o.order_no FROM order_lines l JOIN order_versions v ON v.id=l.version_id JOIN orders o ON o.id=v.order_id WHERE l.id=?')
    .get(orderLineId)?.order_no ?? null;
}
function view(db, row) {
  const allocations = json(row.allocation_json, []).map(a => ({ ...a, orderNo: a.orderNo ?? orderNoOf(db, a.orderLineId) }));
  return { ...row, allocations, orders: [...new Set(allocations.map(a => a.orderNo).filter(Boolean))],
    reasons: json(row.match_reasons_json, []),
    confirmations: db.prepare("SELECT * FROM confirmations WHERE ref_table='invoice_lines' AND ref_id=? AND status='acik' ORDER BY id").all(row.id) };
}
function list(db, { durum } = {}) {
  if (durum != null && durum !== '' && !Object.hasOwn(FILTERS, durum)) fail('Geçersiz durum');
  return db.prepare(`SELECT * FROM invoice_lines ${durum ? 'WHERE ' + FILTERS[durum] : ''} ORDER BY id DESC LIMIT 500`).all().map(r => view(db, r));
}

module.exports = { ingest, deliver, list, readLine };
