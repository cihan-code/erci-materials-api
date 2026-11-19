'use strict';
const { tx, audit, fail, integer } = require('./db');
const { assertUser } = require('./auth');
const { version, retireWorkshopJobs } = require('./orders');
const { available, movement, fillShortages } = require('./stock');
// Only these kinds go to the workshop; onay_formu, uretim_formu and customer files never do.
const WORKSHOP_KINDS = ['baski_formu', 'nakis_formu', 'desen_vektor'];
const recipeReader = require('../operations/recipes');
function result(db, versionId) {
  return { approval: db.prepare('SELECT * FROM approvals WHERE version_id=?').get(versionId),
    allocations: db.prepare('SELECT a.* FROM allocations a JOIN order_lines l ON l.id=a.order_line_id WHERE l.version_id=? ORDER BY a.id').all(versionId),
    outbox: db.prepare('SELECT * FROM outbox WHERE version_id=? ORDER BY id').all(versionId) };
}
function approveVersion(db, { versionId, userId, fileId, recipes = recipeReader.load() }) {
  return tx(db, () => {
    assertUser(db, userId, true);
    const v = version(db, versionId);
    if (db.prepare('SELECT id FROM approvals WHERE version_id=?').get(versionId)) return result(db, versionId);
    if (v.status !== 'onay_bekliyor') fail('Sürüm onay beklemiyor', 409);
    if (!db.prepare("SELECT id FROM files WHERE id=? AND version_id=? AND kind='onay_formu'").get(fileId ?? null, versionId)) fail('Onay dosyası bu sürüme ait onay_formu olmalı');
    if (!recipes.version) fail('Reçete sürümü gerekli');
    const lines = db.prepare('SELECT * FROM order_lines WHERE version_id=? ORDER BY id').all(versionId);
    if (!lines.length) fail('Sipariş satırı gerekli');
    const previous = db.prepare(`SELECT v.* FROM order_versions v JOIN approvals p ON p.version_id=v.id
      WHERE v.order_id=? AND v.version_no<? ORDER BY v.version_no DESC LIMIT 1`).get(v.order_id, v.version_no);
    const old = previous ? db.prepare(`SELECT a.*,l.line_key FROM allocations a JOIN order_lines l ON l.id=a.order_line_id WHERE l.version_id=?`).all(previous.id) : [];
    if (previous) retireWorkshopJobs(db, previous.id, userId);
    const plan = [];
    for (const line of lines) {
      const recipe = recipes.products?.[line.product_key];
      if (!recipe || !Array.isArray(recipe.materials) || !recipe.materials.length) fail(`Reçete yok: ${line.product_key}`);
      const mapping = JSON.parse(line.material_items_json);
      const seen = new Set();
      for (const m of recipe.materials) {
        if (!m.key || seen.has(m.key)) fail('Geçersiz veya tekrarlı reçete malzemesi');
        seen.add(m.key);
        if (m.when && m.when !== 'lining') fail('Bilinmeyen reçete koşulu');
        if (m.when === 'lining' && !line.lining) continue;
        if (m.g_per_unit == null) {
          db.prepare("INSERT INTO confirmations(kind,ref_table,ref_id,message) VALUES('eksik_alan','order_lines',?,?)")
            .run(line.id, `${m.key}: reçete miktarı bilinmiyor; miktar ve kullanım teyidi gerekli`);
          continue;
        }
        if (!Number.isFinite(m.g_per_unit) || m.g_per_unit <= 0) fail('Reçete miktarı geçersiz');
        const need = integer(line.quantity * m.g_per_unit, 'ihtiyaç', 1);
        const itemId = mapping[m.key] ?? (m.key === 'kumas' ? line.fabric_item_id : null);
        if (itemId != null) {
          const item = db.prepare('SELECT * FROM stock_items WHERE id=?').get(itemId);
          if (!item || item.unit !== 'kg') fail('Gram reçetesi kg stok kalemine bağlanmalı');
        } else {
          db.prepare("INSERT INTO confirmations(kind,ref_table,ref_id,message) VALUES('eksik_alan','order_lines',?,?)")
            .run(line.id, `${m.key}: stok kalemi eşlemesi gerekli; ihtiyaç ${need} gram`);
        }
        const prior = old.find(a => a.line_key === line.line_key && a.material_key === m.key);
        if (prior?.consumed_milli && (prior.item_id !== itemId || prior.consumed_milli > need)) fail('Tüketilmiş malzeme değiştirilemez veya tüketimin altına indirilemez', 409);
        const consumed = prior?.consumed_milli || 0;
        const carried = prior?.item_id === itemId ? Math.min(prior.reserved_milli, need-consumed) : 0;
        plan.push({ line, materialKey: m.key, itemId, need, consumed, carried, prior });
      }
      db.prepare('UPDATE order_lines SET recipe_version=? WHERE id=?').run(String(recipes.version), line.id);
    }
    // Release only excess or removed material. Carried reservations are transferred to the new allocation without ledger churn.
    const released = new Set();
    for (const a of old) {
      const target = plan.find(p => p.prior?.id === a.id);
      if (!target && a.consumed_milli) fail('Tüketilmiş malzeme revizyondan kaldırılamaz', 409);
      const release = a.reserved_milli - (target?.carried || 0);
      if (release) {
        movement(db, { itemId: a.item_id, type: 'tahsis_iade', qtyMilli: release, orderLineId: a.order_line_id,
          businessKey: `tahsis_iade:${versionId}:${a.id}`, userId });
        released.add(a.item_id);
      }
      db.prepare('UPDATE allocations SET reserved_milli=0,shortage_milli=0 WHERE id=?').run(a.id);
    }
    // Install every carry before computing availability so one revised line cannot steal another line's reservation.
    for (const p of plan) db.prepare(`INSERT INTO allocations(order_line_id,material_key,item_id,need_milli,reserved_milli,shortage_milli,consumed_milli)
      VALUES(?,?,?,?,?,?,?)`).run(p.line.id, p.materialKey, p.itemId, p.need, p.carried, p.need-p.consumed-p.carried, p.consumed);
    // Released stock first closes earlier approvals' shortages (FIFO); this version has no approval row yet, so it comes last.
    for (const itemId of released) fillShortages(db, itemId, { userId, keyPrefix: `serbest:onay:${versionId}:${itemId}` });
    for (const p of plan) {
      const extra = p.itemId == null ? 0 : Math.min(p.need-p.consumed-p.carried, Math.max(0, available(db, p.itemId)));
      if (extra) {
        movement(db, { itemId: p.itemId, type: 'tahsis', qtyMilli: extra, orderLineId: p.line.id,
          businessKey: `tahsis:${versionId}:${p.line.id}:${p.materialKey}`, userId });
        db.prepare('UPDATE allocations SET reserved_milli=reserved_milli+?,shortage_milli=shortage_milli-? WHERE order_line_id=? AND material_key=?')
          .run(extra, extra, p.line.id, p.materialKey);
      }
    }
    db.prepare('INSERT INTO approvals(version_id,approved_by,approved_file_id) VALUES(?,?,?)').run(versionId, userId, fileId);
    db.prepare("UPDATE order_versions SET status='onaylandi' WHERE id=?").run(versionId);
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(v.order_id);
    const enqueue = db.prepare('INSERT INTO outbox(kind,idempotency_key,version_id,payload_json) VALUES(?,?,?,?)');
    for (const file of db.prepare(`SELECT * FROM files WHERE version_id=? AND kind IN (${WORKSHOP_KINDS.map(() => '?').join(',')}) ORDER BY id`).all(versionId, ...WORKSHOP_KINDS))
      enqueue.run('atolye_dosya', `atolye:${versionId}:${file.id}`, versionId, JSON.stringify({ versionId, orderNo: order.order_no, versionNo: v.version_no, file }));
    enqueue.run('maliyet_aktarim', `maliyet:${order.order_no}:${v.version_no}`, versionId, JSON.stringify({ versionId, orderNo: order.order_no, versionNo: v.version_no }));
    audit(db, userId, 'surum_onayla', versionId, { fileId, recipeVersion: recipes.version });
    return result(db, versionId);
  });
}
module.exports = { approveVersion, WORKSHOP_KINDS };
