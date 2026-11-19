'use strict';
const { tx, audit, fail, integer } = require('./db');
const { assertUser } = require('./auth');
const { parseInvoiceDescription, fabricKey, splitFabricKey } = require('./matching');
const { withKartela, resolveKartelaItem } = require('./kartela');
function stockSummary(db) {
  return db.prepare(`SELECT s.*,
    COALESCE(m.total,0) AS total_milli, COALESCE(a.reserved,0) AS reserved_milli,
    COALESCE(m.total,0)-COALESCE(a.reserved,0) AS available_milli,
    COALESCE(a.shortage,0) AS shortage_milli, COALESCE(i.awaiting,0) AS awaiting_delivery_milli
    FROM stock_items s
    LEFT JOIN (SELECT item_id,SUM(CASE WHEN type IN ('acilis','giris','duzeltme') THEN qty_milli WHEN type='cikis' THEN -qty_milli ELSE 0 END) AS total FROM stock_movements GROUP BY item_id) m ON m.item_id=s.id
    LEFT JOIN (SELECT item_id,SUM(reserved_milli) AS reserved,SUM(shortage_milli) AS shortage FROM allocations GROUP BY item_id) a ON a.item_id=s.id
    LEFT JOIN (SELECT item_id,SUM(qty_milli) AS awaiting FROM invoice_lines WHERE delivery_status='teslim_bekliyor' GROUP BY item_id) i ON i.item_id=s.id
    ORDER BY s.id`).all();
}
function available(db, itemId) {
  const row = stockSummary(db).find(i => i.id === itemId);
  if (!row) fail('Stok kalemi bulunamadı', 404);
  return row.available_milli;
}
function movement(db, { itemId, type, qtyMilli, orderLineId = null, invoiceLineId = null, businessKey, userId = null, note = null, allocationId = null }) {
  integer(qtyMilli, 'qtyMilli', ['duzeltme','acilis'].includes(type) ? -Number.MAX_SAFE_INTEGER : 1);
  return Number(db.prepare(`INSERT INTO stock_movements(item_id,type,qty_milli,order_line_id,invoice_line_id,business_key,created_by,note,allocation_id)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(itemId, type, qtyMilli, orderLineId, invoiceLineId, businessKey, userId, note, allocationId).lastInsertRowid);
}
// One receipt per invoice line: the distribution asked for the first time is part of the idempotent payload.
function deliveryRequest(allocations) {
  if (allocations === undefined) return JSON.stringify({ mode: 'fifo' });
  if (!Array.isArray(allocations)) fail('allocations listesi gerekli');
  return JSON.stringify({ mode: 'explicit', allocations: allocations.map(e => [Number(e?.orderLineId), e?.qtyMilli])
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]) });
}
function storedAllocations(json) {
  const r = json ? JSON.parse(json) : null;
  return r?.mode === 'explicit' ? r.allocations.map(([orderLineId, qtyMilli]) => ({ orderLineId, qtyMilli })) : undefined;
}
function openShortages(db, itemId) {
  return db.prepare(`SELECT a.* FROM allocations a JOIN order_lines l ON l.id=a.order_line_id
    JOIN approvals p ON p.version_id=l.version_id WHERE a.item_id=? AND a.shortage_milli>0
    ORDER BY p.approved_at,p.id,a.id`).all(itemId);
}
function reserve(db, row, qtyMilli, { itemId, userId = null, invoiceLineId = null, businessKey }) {
  movement(db, { itemId, type: 'tahsis', qtyMilli, orderLineId: row.order_line_id, invoiceLineId, businessKey, userId });
  db.prepare('UPDATE allocations SET reserved_milli=reserved_milli+?,shortage_milli=shortage_milli-? WHERE id=?').run(qtyMilli, qtyMilli, row.id);
}
// When usable stock of an item grows, its open shortages close in approval order (FIFO), inside the caller's tx.
function fillShortages(db, itemId, { budget, userId = null, invoiceLineId = null, keyPrefix }) {
  let left = budget ?? Math.max(0, available(db, itemId));
  const filled = [];
  for (const row of openShortages(db, itemId)) {
    if (left <= 0) break;
    const qty = Math.min(left, row.shortage_milli);
    reserve(db, row, qty, { itemId, userId, invoiceLineId, businessKey: `${keyPrefix}:${row.id}` });
    filled.push({ row, qty }); left -= qty;
  }
  return filled;
}
// Legacy name + colour become the "<type>|<colour>" key only when both read cleanly; anything else stays legacy:<id>.
function legacyFabricKey(f) {
  const p = parseInvoiceDescription(`${f.name ?? ''} ${f.colorName ?? ''}`);
  const clear = p.fabricType && p.colorKey && !p.issues.some(i => i.field !== 'quantity') && !p.unknownWords.length;
  return clear ? fabricKey(p.fabricType, p.colorKey) : null;
}
// Master data only: the physical stock is entered by a count (recordCount); old movement totals are not trusted.
function importLegacyFabrics(db, stokData) {
  return tx(db, () => {
    const data = stokData.data || stokData;
    let imported = 0;
    const pending = (data.fabrics || []).filter(f => {
      if (f.id == null) fail('Eski kumaş kimliği gerekli');
      return !db.prepare('SELECT id FROM stock_items WHERE legacy_fabric_id=?').get(String(f.id));
    });
    const wanted = new Map(pending.map(f => [f.id, legacyFabricKey(f)]));
    const uses = new Map();
    for (const k of wanted.values()) if (k) uses.set(k, (uses.get(k) || 0) + 1);
    for (const f of pending) {
      const meaning = wanted.get(f.id);
      // Two legacy fabrics, or an existing item, on one key cannot be merged by guess: both stay legacy for the team.
      const clash = meaning && (uses.get(meaning) > 1 || db.prepare('SELECT id FROM stock_items WHERE fabric_key=?').get(meaning));
      const itemId = Number(db.prepare(`INSERT INTO stock_items(fabric_key,name,color_name,color_no,unit,legacy_fabric_id)
        VALUES(?,?,?,?,?,?)`).run(meaning && !clash ? meaning : `legacy:${f.id}`, f.name, f.colorName ?? null, f.colorNo ?? null, f.unit, String(f.id)).lastInsertRowid);
      if (!meaning || clash) db.prepare("INSERT INTO confirmations(kind,ref_table,ref_id,message) VALUES('eksik_alan','stock_items',?,?)")
        .run(itemId, `Kumaş türü/renk eşlemesi gerekli: "${[f.name, f.colorName].filter(Boolean).join(' ')}" ` +
          (meaning ? `başka bir kumaşla aynı anahtara (${meaning}) çıkıyor.` : 'adından tür ve renk net okunamadı.'));
      audit(db, null, 'stok_aktar', itemId, { legacyId: f.id, fabricKey: meaning && !clash ? meaning : null }); imported++;
    }
    return { imported };
  });
}
// A physical count sets the book total: first count on a fresh item is the opening, later ones a correction by the
// difference. The count itself (audit row under its business key) is the idempotency record, also when nothing changed.
function recordCount(db, { itemId, countedMilli, countKey, userId, note = null }) {
  return tx(db, () => {
    assertUser(db, userId, true);
    integer(itemId, 'itemId', 1); integer(countedMilli, 'countedMilli', 0);
    if (typeof countKey !== 'string' || !countKey.trim()) fail('Sayım anahtarı gerekli');
    const businessKey = `sayim:${countKey.trim()}:${itemId}`;
    const prior = db.prepare("SELECT * FROM audit_log WHERE action='stok_sayim' AND ref=?").get(businessKey);
    if (prior) {
      const detail = JSON.parse(prior.detail_json);
      if (detail.countedMilli !== countedMilli) fail('Bu sayım anahtarı farklı bir miktarla kaydedilmiş', 409);
      return { ...detail, movement: db.prepare('SELECT * FROM stock_movements WHERE business_key=?').get(businessKey) || null };
    }
    const row = stockSummary(db).find(i => i.id === itemId);
    if (!row) fail('Stok kalemi bulunamadı', 404);
    if (countedMilli < row.reserved_milli) fail(`Sayım ayrılmış miktarın (${row.reserved_milli}) altında; önce tahsisler düzeltilmeli`, 409);
    const differenceMilli = countedMilli - row.total_milli;
    const fresh = !db.prepare('SELECT id FROM stock_movements WHERE item_id=? LIMIT 1').get(itemId);
    let id = null;
    if (differenceMilli) {
      id = movement(db, { itemId, type: fresh ? 'acilis' : 'duzeltme', qtyMilli: differenceMilli, businessKey, userId, note: note ?? `sayım ${countKey.trim()}` });
      if (differenceMilli > 0) fillShortages(db, itemId, { userId, keyPrefix: `serbest:${id}` });
    }
    const detail = { itemId, countedMilli, previousMilli: row.total_milli, differenceMilli, type: id ? (fresh ? 'acilis' : 'duzeltme') : null, note };
    audit(db, userId, 'stok_sayim', businessKey, detail);
    return { ...detail, movement: id ? db.prepare('SELECT * FROM stock_movements WHERE id=?').get(id) : null };
  });
}
// Caller holds the tx and has checked the actor; the invoice flow calls this for service-confirmed deliveries.
function receive(db, { invoiceLineId, itemId, qtyMilli, allocations, userId = null }) {
  const businessKey = `giris:${invoiceLineId}`;
  const existing = db.prepare('SELECT * FROM stock_movements WHERE business_key=?').get(businessKey);
  const request = deliveryRequest(allocations);
  if (existing) {
    if (existing.item_id !== itemId || existing.qty_milli !== qtyMilli) fail('Bu fatura satırı başka bir kalem veya miktarla teslim alınmış', 409);
    const first = db.prepare('SELECT delivery_request_json r FROM invoice_lines WHERE id=?').get(invoiceLineId)?.r;
    if (first && first !== request) fail('Bu fatura satırı başka bir dağıtımla teslim alınmış', 409);
    return existing;
  }
  integer(qtyMilli, 'qtyMilli', 1);
  const invoice = db.prepare('SELECT * FROM invoice_lines WHERE id=?').get(invoiceLineId);
  const item = db.prepare('SELECT * FROM stock_items WHERE id=?').get(itemId);
  if (!invoice || !item) fail('Fatura satırı veya stok kalemi bulunamadı', 404);
  if (invoice.delivery_status !== 'teslim_bekliyor' || invoice.unit !== item.unit || (invoice.item_id != null && invoice.item_id !== itemId)) fail('Teslimat eşlemesi geçersiz', 409);
  // The contract has a single receipt key per invoice line; partial receipts need a separate receipt identifier.
  if (invoice.qty_milli !== qtyMilli) fail('Tek teslimat miktarı fatura satırı miktarına eşit olmalı');
  const id = movement(db, { itemId, type: 'giris', qtyMilli, invoiceLineId, businessKey, userId });
  let remaining = qtyMilli;
  const shortages = openShortages(db, itemId);
  const targets = [];
  if (allocations !== undefined) {
    if (!Array.isArray(allocations)) fail('allocations listesi gerekli');
    const seen = new Set();
    for (const entry of allocations) {
      integer(entry.qtyMilli, 'allocation qtyMilli', 1);
      if (seen.has(entry.orderLineId)) fail('Tekrarlı tahsis hedefi');
      seen.add(entry.orderLineId);
      const rows = shortages.filter(a => a.order_line_id === entry.orderLineId);
      if (!rows.length || entry.qtyMilli > rows.reduce((n,a) => n+a.shortage_milli,0)) fail('Tahsis açık ihtiyacı aşıyor');
      let amount = entry.qtyMilli;
      for (const row of rows) { const qty = Math.min(amount, row.shortage_milli); if (qty) targets.push({ row, qty }); amount -= qty; }
    }
    if (targets.reduce((n,t) => n+t.qty,0) > remaining) fail('Tahsis teslimatı aşıyor');
    for (const { row, qty } of targets) {
      reserve(db, row, qty, { itemId, userId, invoiceLineId, businessKey: `teslim_tahsis:${invoiceLineId}:${row.id}` });
      remaining -= qty;
    }
  }
  // Explicit targets go first; whatever is left is usable stock and closes open shortages FIFO like any other increase.
  const budget = Math.min(remaining, Math.max(0, available(db, itemId)));
  const prefix = allocations !== undefined ? `teslim_fifo:${invoiceLineId}` : `teslim_tahsis:${invoiceLineId}`;
  for (const t of fillShortages(db, itemId, { budget, userId, invoiceLineId, keyPrefix: prefix })) { targets.push(t); remaining -= t.qty; }
  const given = new Map();
  for (const t of targets) {
    const g = given.get(t.row.id) || { orderLineId: t.row.order_line_id, materialKey: t.row.material_key, qtyMilli: 0 };
    g.qtyMilli += t.qty; given.set(t.row.id, g);
  }
  db.prepare("UPDATE invoice_lines SET delivery_status='teslim_alindi',match_status='eslesti',item_id=?,allocation_json=?,delivery_request_json=? WHERE id=?")
    .run(itemId, JSON.stringify([...given.values()]), request, invoiceLineId);
  audit(db, userId, 'teslim_al', invoiceLineId, { itemId, qtyMilli, allocatedMilli: qtyMilli-remaining });
  return db.prepare('SELECT * FROM stock_movements WHERE id=?').get(id);
}
function receiveDelivery(db, input) {
  return tx(db, () => { assertUser(db, input.userId); return receive(db, input); });
}
function adjustStock(db, { itemId, qtyMilli, businessKey, userId, note }) {
  return tx(db, () => {
    assertUser(db, userId, true); integer(qtyMilli, 'qtyMilli', -Number.MAX_SAFE_INTEGER);
    if (!businessKey || !note || !qtyMilli) fail('Düzeltme anahtarı, gerekçe ve sıfırdan farklı miktar gerekli');
    const key = `duzeltme:${businessKey}`;
    const existing = db.prepare('SELECT * FROM stock_movements WHERE business_key=?').get(key);
    if (existing) {
      if (existing.item_id !== Number(itemId) || existing.qty_milli !== qtyMilli) fail('İşlem anahtarı farklı bir düzeltme için kullanılmış', 409);
      return existing;
    }
    if (available(db, itemId) + qtyMilli < 0) fail('Düzeltme ayrılmış stok miktarını ihlal ediyor', 409);
    const id = movement(db, { itemId, type: 'duzeltme', qtyMilli, businessKey: key, userId, note });
    if (qtyMilli > 0) fillShortages(db, Number(itemId), { userId, keyPrefix: `serbest:${id}` });
    audit(db, userId, 'stok_duzelt', id, { itemId, qtyMilli, note }); return db.prepare('SELECT * FROM stock_movements WHERE id=?').get(id);
  });
}
function consume(db, { orderLineId, materialKey, qtyMilli, businessKey, userId }) {
  return tx(db, () => {
    assertUser(db, userId); integer(qtyMilli, 'qtyMilli', 1);
    if (!businessKey) fail('Çıkış işlem anahtarı gerekli');
    const key = `cikis:${businessKey}`;
    const existing = db.prepare('SELECT * FROM stock_movements WHERE business_key=?').get(key);
    const a = db.prepare('SELECT * FROM allocations WHERE order_line_id=? AND material_key=?').get(orderLineId, materialKey);
    if (existing) {
      // Fabric and lining of one line may sit on the same item, so the allocation (material) is part of the payload.
      const sameAllocation = existing.allocation_id != null ? existing.allocation_id === a?.id
        : JSON.parse(db.prepare("SELECT detail_json d FROM audit_log WHERE action='stok_cikis' AND ref=?").get(String(existing.id))?.d || '{}').materialKey === materialKey;
      if (existing.order_line_id !== orderLineId || existing.qty_milli !== qtyMilli || existing.item_id !== a?.item_id || !sameAllocation)
        fail('İşlem anahtarı farklı bir çıkış için kullanılmış', 409);
      return existing;
    }
    if (!a || a.reserved_milli < qtyMilli) fail('Yeterli tahsis yok', 409);
    const id = movement(db, { itemId: a.item_id, type: 'cikis', qtyMilli, orderLineId, businessKey: key, userId, allocationId: a.id });
    db.prepare('UPDATE allocations SET reserved_milli=reserved_milli-?,consumed_milli=consumed_milli+? WHERE id=?').run(qtyMilli, qtyMilli, a.id);
    audit(db, userId, 'stok_cikis', id, { orderLineId, materialKey, qtyMilli }); return db.prepare('SELECT * FROM stock_movements WHERE id=?').get(id);
  });
}
const MILLI_FIELDS = ['total', 'reserved', 'available', 'shortage', 'awaiting_delivery'];
// Panel view: kg figures are display-only conversions of the integer milli values, and only for kg items.
function stockView(db) {
  return stockSummary(db).map(row => {
    const view = { ...row };
    for (const f of MILLI_FIELDS) view[`${f}_kg`] = row.unit === 'kg' ? row[`${f}_milli`] / 1000 : null;
    return withKartela(view);
  });
}
const HEX = /^#[0-9a-f]{6}$/i;
function itemText(value, label, max) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > max) fail(`${label} en çok ${max} karakterlik metin olmalı`);
  return value.trim() || null;
}
function itemHex(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !HEX.test(value)) fail('colorHex #rrggbb biçiminde olmalı');
  return value.toLowerCase();
}
// New fabric item from the panel: the key comes from matching.fabricKey so invoices find the same item.
// With kartelaNo the card defines colour, number, hex and name; an existing item under that key is returned as mevcut.
function createStockItem(db, { tur, renk, ad, unit, colorNo, colorHex, kartelaNo } = {}, userId) {
  return tx(db, () => {
    assertUser(db, userId);
    if (!['kg','m','adet'].includes(unit)) fail("unit 'kg', 'm' veya 'adet' olmalı");
    if (kartelaNo != null && kartelaNo !== '') {
      if ([ad, colorNo, colorHex].some(v => v != null && v !== '')) fail('kartelaNo ile ad, colorNo ve colorHex gönderilmez; karteladan gelir');
      const k = resolveKartelaItem({ tur, kartelaNo, renk });
      const existing = db.prepare('SELECT * FROM stock_items WHERE fabric_key=?').get(k.fabricKey);
      if (existing) return { ...withKartela(existing), mevcut: true };
      const id = Number(db.prepare('INSERT INTO stock_items(fabric_key,name,color_name,color_no,unit,color_hex) VALUES(?,?,?,?,?,?)')
        .run(k.fabricKey, k.name, k.renk.renk, String(k.renk.no), unit, k.renk.hex).lastInsertRowid);
      audit(db, userId, 'stok_kalemi_olustur', id, { fabricKey: k.fabricKey, kartela: k.card.id, no: k.renk.no });
      return withKartela(db.prepare('SELECT * FROM stock_items WHERE id=?').get(id));
    }
    const key = fabricKey(itemText(tur, 'tur', 100), itemText(renk, 'renk', 100));
    if (!key) fail('Kumaş türü ve renk gerekli');
    const existing = db.prepare('SELECT * FROM stock_items WHERE fabric_key=?').get(key);
    if (existing) { const e = new Error('Bu kumaş türü ve renk için kalem zaten var'); e.status = 409; e.item = withKartela(existing); throw e; }
    const id = Number(db.prepare('INSERT INTO stock_items(fabric_key,name,color_name,color_no,unit,color_hex) VALUES(?,?,?,?,?,?)')
      .run(key, itemText(ad, 'ad', 200) || splitFabricKey(key).type.replace(/_/g, ' '), renk.trim(), itemText(colorNo, 'colorNo', 50), unit, itemHex(colorHex)).lastInsertRowid);
    audit(db, userId, 'stok_kalemi_olustur', id, { fabricKey: key });
    return withKartela(db.prepare('SELECT * FROM stock_items WHERE id=?').get(id));
  });
}
// Identity (type, colour, unit) stays fixed once stock and invoices point at the item; only labels change.
function updateStockItem(db, id, changes = {}, userId) {
  return tx(db, () => {
    assertUser(db, userId);
    const extra = Object.keys(changes).filter(k => !['ad','colorNo','colorHex'].includes(k));
    if (extra.length) fail(`Yalnız ad, colorNo ve colorHex değiştirilebilir: ${extra.join(', ')}`);
    const item = db.prepare('SELECT * FROM stock_items WHERE id=?').get(id);
    if (!item) fail('Stok kalemi bulunamadı', 404);
    const next = {
      name: Object.hasOwn(changes, 'ad') ? itemText(changes.ad, 'ad', 200) : item.name,
      color_no: Object.hasOwn(changes, 'colorNo') ? itemText(changes.colorNo, 'colorNo', 50) : item.color_no,
      color_hex: Object.hasOwn(changes, 'colorHex') ? itemHex(changes.colorHex) : item.color_hex,
    };
    if (!next.name) fail('ad boş olamaz');
    db.prepare('UPDATE stock_items SET name=?,color_no=?,color_hex=? WHERE id=?').run(next.name, next.color_no, next.color_hex, id);
    audit(db, userId, 'stok_kalemi_duzenle', id, changes);
    return withKartela(db.prepare('SELECT * FROM stock_items WHERE id=?').get(id));
  });
}
module.exports = { storedAllocations, stockSummary, stockView, available, movement, fillShortages, importLegacyFabrics, recordCount, receive, receiveDelivery,
  adjustStock, consume, createStockItem, updateStockItem };
