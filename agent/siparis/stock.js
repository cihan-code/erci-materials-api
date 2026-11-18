'use strict';
const { tx, audit, fail, integer } = require('./db');
const { assertUser } = require('./auth');
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
function movement(db, { itemId, type, qtyMilli, orderLineId = null, invoiceLineId = null, businessKey, userId = null, note = null }) {
  integer(qtyMilli, 'qtyMilli', ['duzeltme','acilis'].includes(type) ? -Number.MAX_SAFE_INTEGER : 1);
  return Number(db.prepare(`INSERT INTO stock_movements(item_id,type,qty_milli,order_line_id,invoice_line_id,business_key,created_by,note)
    VALUES(?,?,?,?,?,?,?,?)`).run(itemId, type, qtyMilli, orderLineId, invoiceLineId, businessKey, userId, note).lastInsertRowid);
}
function importLegacyFabrics(db, stokData) {
  return tx(db, () => {
    const data = stokData.data || stokData;
    let imported = 0;
    for (const f of data.fabrics || []) {
      if (f.id == null) fail('Eski kumaş kimliği gerekli');
      const key = `acilis:${f.id}`;
      if (db.prepare('SELECT id FROM stock_movements WHERE business_key=?').get(key)) continue;
      let sum = 0;
      for (const m of (data.movements || []).filter(m => String(m.fabricId) === String(f.id))) {
        if (!['giris','cikis','acilis','duzeltme'].includes(m.type)) fail(`Eski hareket türü için eşleme gerekli: ${m.type}`);
        const milli = Math.round(Number(m.qty) * 1000);
        if (m.qty == null || m.qty === '' || !Number.isFinite(Number(m.qty))) fail('Eski hareket miktarı geçersiz');
        integer(milli, 'eski miktar', m.type === 'duzeltme' ? -Number.MAX_SAFE_INTEGER : 0);
        sum += m.type === 'cikis' ? -milli : milli;
      }
      integer(sum, 'açılış toplamı', 0);
      const itemId = Number(db.prepare(`INSERT INTO stock_items(fabric_key,name,color_name,color_no,unit,legacy_fabric_id)
        VALUES(?,?,?,?,?,?)`).run(`legacy:${f.id}`, f.name, f.colorName ?? null, f.colorNo ?? null, f.unit, String(f.id)).lastInsertRowid);
      movement(db, { itemId, type: 'acilis', qtyMilli: sum, businessKey: key });
      audit(db, null, 'stok_aktar', itemId, { legacyId: f.id, qtyMilli: sum }); imported++;
    }
    return { imported };
  });
}
function receiveDelivery(db, { invoiceLineId, itemId, qtyMilli, allocations, userId }) {
  return tx(db, () => {
    assertUser(db, userId);
    const businessKey = `giris:${invoiceLineId}`;
    const existing = db.prepare('SELECT * FROM stock_movements WHERE business_key=?').get(businessKey);
    if (existing) return existing;
    integer(qtyMilli, 'qtyMilli', 1);
    const invoice = db.prepare('SELECT * FROM invoice_lines WHERE id=?').get(invoiceLineId);
    const item = db.prepare('SELECT * FROM stock_items WHERE id=?').get(itemId);
    if (!invoice || !item) fail('Fatura satırı veya stok kalemi bulunamadı', 404);
    if (invoice.delivery_status !== 'teslim_bekliyor' || invoice.unit !== item.unit || (invoice.item_id != null && invoice.item_id !== itemId)) fail('Teslimat eşlemesi geçersiz', 409);
    // The contract has a single receipt key per invoice line; partial receipts need a separate receipt identifier.
    if (invoice.qty_milli !== qtyMilli) fail('Tek teslimat miktarı fatura satırı miktarına eşit olmalı');
    const id = movement(db, { itemId, type: 'giris', qtyMilli, invoiceLineId, businessKey, userId });
    let remaining = qtyMilli;
    const shortages = db.prepare(`SELECT a.* FROM allocations a JOIN order_lines l ON l.id=a.order_line_id
      JOIN approvals p ON p.version_id=l.version_id WHERE a.item_id=? AND a.shortage_milli>0
      ORDER BY p.approved_at,p.id,a.id`).all(itemId);
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
    } else {
      let budget = remaining;
      for (const row of shortages) { const qty = Math.min(budget, row.shortage_milli); if (qty) targets.push({ row, qty }); budget -= qty; }
    }
    for (const { row, qty } of targets) {
      movement(db, { itemId, type: 'tahsis', qtyMilli: qty, orderLineId: row.order_line_id, invoiceLineId,
        businessKey: `teslim_tahsis:${invoiceLineId}:${row.id}`, userId });
      db.prepare('UPDATE allocations SET reserved_milli=reserved_milli+?,shortage_milli=shortage_milli-? WHERE id=?').run(qty, qty, row.id);
      remaining -= qty;
    }
    db.prepare("UPDATE invoice_lines SET delivery_status='teslim_alindi',match_status='eslesti',item_id=?,allocation_json=? WHERE id=?")
      .run(itemId, JSON.stringify(targets.map(t => ({ orderLineId: t.row.order_line_id, materialKey: t.row.material_key, qtyMilli: t.qty }))), invoiceLineId);
    audit(db, userId, 'teslim_al', invoiceLineId, { itemId, qtyMilli, allocatedMilli: qtyMilli-remaining });
    return db.prepare('SELECT * FROM stock_movements WHERE id=?').get(id);
  });
}
function adjustStock(db, { itemId, qtyMilli, businessKey, userId, note }) {
  return tx(db, () => {
    assertUser(db, userId, true); integer(qtyMilli, 'qtyMilli', -Number.MAX_SAFE_INTEGER);
    if (!businessKey || !note || !qtyMilli) fail('Düzeltme anahtarı, gerekçe ve sıfırdan farklı miktar gerekli');
    const key = `duzeltme:${businessKey}`;
    const existing = db.prepare('SELECT * FROM stock_movements WHERE business_key=?').get(key);
    if (existing) return existing;
    if (available(db, itemId) + qtyMilli < 0) fail('Düzeltme ayrılmış stok miktarını ihlal ediyor', 409);
    const id = movement(db, { itemId, type: 'duzeltme', qtyMilli, businessKey: key, userId, note });
    audit(db, userId, 'stok_duzelt', id, { itemId, qtyMilli, note }); return db.prepare('SELECT * FROM stock_movements WHERE id=?').get(id);
  });
}
function consume(db, { orderLineId, materialKey, qtyMilli, businessKey, userId }) {
  return tx(db, () => {
    assertUser(db, userId); integer(qtyMilli, 'qtyMilli', 1);
    if (!businessKey) fail('Çıkış işlem anahtarı gerekli');
    const key = `cikis:${businessKey}`;
    const existing = db.prepare('SELECT * FROM stock_movements WHERE business_key=?').get(key);
    if (existing) return existing;
    const a = db.prepare('SELECT * FROM allocations WHERE order_line_id=? AND material_key=?').get(orderLineId, materialKey);
    if (!a || a.reserved_milli < qtyMilli) fail('Yeterli tahsis yok', 409);
    const id = movement(db, { itemId: a.item_id, type: 'cikis', qtyMilli, orderLineId, businessKey: key, userId });
    db.prepare('UPDATE allocations SET reserved_milli=reserved_milli-?,consumed_milli=consumed_milli+? WHERE id=?').run(qtyMilli, qtyMilli, a.id);
    audit(db, userId, 'stok_cikis', id, { orderLineId, materialKey, qtyMilli }); return db.prepare('SELECT * FROM stock_movements WHERE id=?').get(id);
  });
}
module.exports = { stockSummary, available, movement, importLegacyFabrics, receiveDelivery, adjustStock, consume };
