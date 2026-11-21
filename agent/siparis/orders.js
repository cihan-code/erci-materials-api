'use strict';
const crypto = require('crypto');
const { tx, audit, fail, integer } = require('./db');
const { assertUser } = require('./auth');
const flats = require('./flats');
const { fabricKey, typeKey } = require('./matching');
const uid = user => user && typeof user === 'object' ? user.id : user;
function version(db, id) {
  const v = db.prepare('SELECT * FROM order_versions WHERE id=?').get(id);
  if (!v) fail('Sürüm bulunamadı', 404);
  // A soft-deleted order is gone for every screen and endpoint that reaches it through a version.
  if (db.prepare('SELECT deleted_at FROM orders WHERE id=?').get(v.order_id)?.deleted_at) fail('Sürüm bulunamadı', 404);
  return v;
}
function editable(db, id) {
  const v = version(db, id);
  if (v.status !== 'taslak') fail('Yalnız taslak düzenlenebilir; yeni revizyon açın', 409);
  return v;
}
function snapshot(db, versionId) {
  const v = version(db, versionId);
  const hasFileMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='document_file_meta'").get();
  const filesSql = hasFileMeta
    ? 'SELECT f.*,m.line_id,m.gorunum FROM files f LEFT JOIN document_file_meta m ON m.file_id=f.id WHERE f.version_id=? ORDER BY f.id'
    : 'SELECT * FROM files WHERE version_id=? ORDER BY id';
  const hasSources = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='document_application_sources'").get();
  const appsSql = hasSources
    ? 'SELECT a.*,(SELECT s.file_id FROM document_application_sources s WHERE s.application_id=a.id) AS desenDosyaId FROM applications a WHERE a.line_id=? ORDER BY a.id'
    : 'SELECT * FROM applications WHERE line_id=? ORDER BY id';
  return { ...v, lines: db.prepare('SELECT * FROM order_lines WHERE version_id=? ORDER BY id').all(versionId).map(l => ({
    ...l, stokKalemiYok: !!l.fabric_type && l.fabric_item_id == null, ...flats.lineSelection(db,l), applications: db.prepare(appsSql).all(l.id).map(a => ({ ...a, desenDosyaId: a.desenDosyaId ?? null }))
  })), files: db.prepare(filesSql).all(versionId) };
}
function insertApplication(db, lineId, app) {
  if (!['baski','nakis'].includes(app.kind) || typeof app.position !== 'string' || !app.position.trim()) fail('Uygulama türü ve konumu gerekli');
  for (const k of ['width_mm','height_mm']) if (app[k] != null && (!Number.isFinite(app[k]) || app[k] <= 0)) fail('Geçersiz ölçü');
  const needsConfirmation = !app.measure_source || app.needs_confirmation;
  const id = Number(db.prepare(`INSERT INTO applications(line_id,kind,position,width_mm,height_mm,measure_source,needs_confirmation)
    VALUES(?,?,?,?,?,?,?)`).run(lineId, app.kind, app.position, app.width_mm ?? null, app.height_mm ?? null,
    app.measure_source || null, needsConfirmation ? 1 : 0).lastInsertRowid);
  if (needsConfirmation) db.prepare("INSERT INTO confirmations(kind,ref_table,ref_id,message) VALUES('olcu','applications',?,?)")
    .run(id, app.measure_source ? 'Uygulama ölçüsü teyit edilmeli' : 'Ölçü kaynağı yok; ekip teyidi gerekli');
  return id;
}
function jsonObject(value, label) {
  let obj = value ?? {};
  if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch { fail(`${label}: geçersiz JSON`); } }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) fail(`${label}: nesne gerekli`);
  return obj;
}
// G59: the line names a fabric type and a colour separately. The stock item is found by type + colour (the same key invoices
// use); with no such item the line stays by name ("stokta kalem yok") and no stock item is opened. Lines saved with only
// fabric_item_id (the old combined choice) keep that item and have no type.
function resolveFabric(db, line) {
  const raw = typeof line.fabric_type === 'string' ? line.fabric_type.trim() : '';
  if (!raw) return { type: null, itemId: line.fabric_item_id ?? null };
  if (raw.length > 100) fail('Kumaş türü en çok 100 karakter olabilir');
  if (raw.startsWith('legacy:')) {
    const item = db.prepare('SELECT id FROM stock_items WHERE fabric_key=?').get(raw);
    if (!item) fail('Kumaş türü bulunamadı');
    return { type: raw, itemId: item.id };
  }
  const type = typeKey(raw);
  if (!type) fail('Geçersiz kumaş türü');
  const key = typeof line.color_name === 'string' && line.color_name.trim() ? fabricKey(type, line.color_name) : null;
  const item = key ? db.prepare('SELECT id FROM stock_items WHERE fabric_key=?').get(key) : null;
  return { type, itemId: item?.id ?? null };
}
function insertLine(db, versionId, line, lineKey, sourceApplications = []) {
  // A sample line (numune) may have no quantity yet; every other line needs at least one piece.
  const numune = [true,1,'var'].includes(line.numune);
  line = { ...line, quantity: line.quantity ?? (numune ? 0 : line.quantity) };
  integer(line.quantity, 'quantity', numune ? 0 : 1);
  if (typeof line.product_key !== 'string' || !line.product_key.trim()) fail('Ürün anahtarı gerekli');
  const sizes = jsonObject(line.sizes_json ?? line.sizes, 'sizes');
  for (const q of Object.values(sizes)) integer(q, 'beden adedi');
  if (Object.keys(sizes).length && Object.values(sizes).reduce((a,b) => a+b, 0) !== line.quantity) fail('Beden toplamı adede eşit olmalı');
  const materials = jsonObject(line.material_items_json ?? line.material_items, 'material_items');
  for (const item of Object.values(materials)) {
    integer(item, 'material item', 1);
    if (!db.prepare('SELECT id FROM stock_items WHERE id=?').get(item)) fail('Malzeme stok kalemi bulunamadı');
  }
  if (line.lining != null && ![true,false,0,1,'var','yok'].includes(line.lining)) fail('Geçersiz astar seçimi');
  const note = typeof line.note === 'string' && line.note.trim() ? line.note.trim() : null;
  if (note && note.length > 500) fail('Kumaş/kalıp açıklaması en çok 500 karakter olabilir');
  const kalipId = line.kalipId ?? line.kalip_id ?? null;
  if (kalipId!=null && !flats.selection(db,line).candidates.some(f=>f.id===kalipId)) fail('Kalıp bu ürünün adaylarından biri olmalı');
  const fabric = resolveFabric(db, line);
  const id = Number(db.prepare(`INSERT INTO order_lines(version_id,line_key,product_key,fabric_item_id,color_name,quantity,sizes_json,lining,material_items_json,numune)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(versionId, lineKey || crypto.randomUUID(), line.product_key, fabric.itemId,
    line.color_name ?? null, line.quantity, JSON.stringify(sizes), [true,1,'var'].includes(line.lining) ? 1 : 0, JSON.stringify(materials), numune ? 1 : 0).lastInsertRowid);
  if (fabric.type) db.prepare('UPDATE order_lines SET fabric_type=? WHERE id=?').run(fabric.type,id);
  if (kalipId!=null) db.prepare('UPDATE order_lines SET kalip_id=? WHERE id=?').run(kalipId,id);
  if (note) db.prepare('UPDATE order_lines SET note=? WHERE id=?').run(note,id);
  for (const a of line.applications || []) {
    const appId = insertApplication(db, id, a);
    const source = sourceApplications.find(old => old.id === a.id &&
      ['kind','position','width_mm','height_mm','measure_source','needs_confirmation'].every(k => old[k] === a[k]));
    // Only unchanged measurements inherit a resolution. Missing provenance always needs a fresh check.
    if (source?.measure_source) {
      const confirmations = db.prepare("SELECT * FROM confirmations WHERE kind='olcu' AND ref_table='applications' AND ref_id=?").all(source.id);
      if (confirmations.length) {
        db.prepare("DELETE FROM confirmations WHERE kind='olcu' AND ref_table='applications' AND ref_id=?").run(appId);
        for (const c of confirmations) db.prepare("INSERT INTO confirmations(kind,ref_table,ref_id,message,status,resolved_by) VALUES('olcu','applications',?,?,?,?)")
          .run(appId,c.message,c.status,c.resolved_by);
      }
    }
  }
  return id;
}
function createOrder(db, input, user) {
  const userId = uid(user);
  return tx(db, () => {
    assertUser(db, userId);
    if (typeof input.order_no !== 'string' || !input.order_no.trim()) fail('Sipariş numarası gerekli');
    if (db.prepare('SELECT 1 FROM orders WHERE order_no=? AND deleted_at IS NOT NULL').get(input.order_no.trim())) fail('Bu sipariş numarası silinmiş bir siparişte kayıtlı; farklı bir numara verin', 409);
    const orderId = Number(db.prepare('INSERT INTO orders(order_no,job_no,customer_name) VALUES(?,?,?)').run(input.order_no.trim(), input.job_no ?? null, input.customer_name ?? null).lastInsertRowid);
    const versionId = Number(db.prepare('INSERT INTO order_versions(order_id,version_no,created_by) VALUES(?,1,?)').run(orderId, userId).lastInsertRowid);
    for (const line of input.lines || []) insertLine(db, versionId, line);
    audit(db, userId, 'siparis_olustur', orderId, { versionId });
    return { ...db.prepare('SELECT * FROM orders WHERE id=?').get(orderId), version: snapshot(db, versionId) };
  });
}
function addLine(db, versionId, line, user) {
  return tx(db, () => {
    assertUser(db, uid(user)); editable(db, versionId);
    const id = insertLine(db, versionId, line);
    audit(db, uid(user), 'satir_ekle', id);
    const row=db.prepare('SELECT * FROM order_lines WHERE id=?').get(id);
    return {...row,...flats.lineSelection(db,row)};
  });
}
function addApplication(db, lineId, app, user) {
  return tx(db, () => {
    assertUser(db, uid(user));
    const line = db.prepare('SELECT * FROM order_lines WHERE id=?').get(lineId);
    if (!line) fail('Satır bulunamadı', 404);
    editable(db, line.version_id);
    const id = insertApplication(db, lineId, app); audit(db, uid(user), 'uygulama_ekle', id);
    return db.prepare('SELECT * FROM applications WHERE id=?').get(id);
  });
}
function addFile(db, versionId, file, user) {
  return tx(db, () => {
    assertUser(db, uid(user));
    if (version(db, versionId).status !== 'taslak') fail('Bu sürüme dosya eklenemez', 409);
    if (!file.kind || !file.path || !/^[a-f0-9]{64}$/i.test(file.sha256)) fail('Dosya türü, yolu ve SHA256 gerekli');
    if (db.prepare('SELECT id FROM files WHERE version_id=? AND path=?').get(versionId,file.path)) fail('Dosya yolu bu sürümde zaten kayıtlı',409);
    const id = Number(db.prepare('INSERT INTO files(version_id,kind,path,sha256) VALUES(?,?,?,?)').run(versionId, file.kind, file.path, file.sha256).lastInsertRowid);
    audit(db, uid(user), 'dosya_ekle', id); return db.prepare('SELECT * FROM files WHERE id=?').get(id);
  });
}
function submitForApproval(db, versionId, user) {
  return tx(db, () => {
    assertUser(db, uid(user)); const v = version(db, versionId);
    if (v.status === 'onay_bekliyor') return snapshot(db, versionId);
    editable(db, versionId);
    if (!db.prepare('SELECT id FROM order_lines WHERE version_id=?').get(versionId)) fail('En az bir sipariş satırı gerekli');
    db.prepare("UPDATE order_versions SET status='onay_bekliyor' WHERE id=?").run(versionId);
    audit(db, uid(user), 'onaya_gonder', versionId); return snapshot(db, versionId);
  });
}
function retireWorkshopJobs(db, versionId, userId) {
  const v = version(db, versionId);
  if (db.prepare("SELECT id FROM outbox WHERE version_id=? AND status='isleniyor'").get(versionId)) fail('Gönderim sürüyor; tamamlanınca revizyon açın', 409);
  db.prepare("UPDATE outbox SET status='iptal',updated_at=? WHERE version_id=? AND kind='atolye_dosya' AND status IN ('bekliyor','manuel_bekliyor','basarisiz')").run(new Date().toISOString(), versionId);
  if (db.prepare("SELECT id FROM outbox WHERE version_id=? AND kind='atolye_dosya' AND status='tamam'").get(versionId) &&
      !db.prepare("SELECT id FROM confirmations WHERE ref_table='order_versions' AND ref_id=? AND message=?").get(versionId, `Atölyede eski sürüm (v${v.version_no}) var`)) {
    db.prepare("INSERT INTO confirmations(kind,ref_table,ref_id,message) VALUES('eski_surum','order_versions',?,?)").run(versionId, `Atölyede eski sürüm (v${v.version_no}) var`);
    audit(db, userId, 'eski_atolye_teyidi', versionId);
  }
}
// A revision makes the old version's pending cost transfer obsolete; finished transfers stay (G5 updates the same record).
function retireCostJobs(db, versionId, userId) {
  for (const job of db.prepare("SELECT id FROM outbox WHERE version_id=? AND kind='maliyet_aktarim' AND status IN ('bekliyor','fiyat_bekliyor','manuel_bekliyor')").all(versionId)) {
    db.prepare("UPDATE outbox SET status='iptal',updated_at=? WHERE id=?").run(new Date().toISOString(), job.id);
    audit(db, userId, 'maliyet_iptal', job.id, { versionId });
  }
}
function reviseVersion(db, versionId, changes = {}, user) {
  return tx(db, () => {
    const userId = uid(user); assertUser(db, userId);
    const old = snapshot(db, versionId);
    if (!['taslak','onay_bekliyor','onaylandi'].includes(old.status)) fail('Yalnız güncel sürüm revize edilebilir', 409);
    // Revising an approved version reopens stock and workshop work, so it needs approval rights.
    if (old.status === 'onaylandi') assertUser(db, userId, true);
    // Check all earlier approved ancestors as well (multiple unapproved revisions).
    for (const v of db.prepare('SELECT id FROM order_versions WHERE order_id=?').all(old.order_id)) {
      retireWorkshopJobs(db, v.id, userId);
      retireCostJobs(db, v.id, userId);
    }
    const nextNo = db.prepare('SELECT MAX(version_no)+1 AS n FROM order_versions WHERE order_id=?').get(old.order_id).n;
    const id = Number(db.prepare("INSERT INTO order_versions(order_id,version_no,status,previous_version_id,created_by) VALUES(?,?,'taslak',?,?)").run(old.order_id, nextNo, versionId, userId).lastInsertRowid);
    const seen = new Set();
    for (const change of changes.lines ?? old.lines) {
      const source = change.id != null ? old.lines.find(l => l.id === change.id) : change.line_key ? old.lines.find(l => l.line_key === change.line_key) : null;
      if ((change.id != null || change.line_key != null) && !source) fail('Revizyon satırı kaynak sürüme ait değil');
      if (source && seen.has(source.id)) fail('Tekrarlı revizyon satırı');
      if (source) seen.add(source.id);
      const merged = { ...source, ...change };
      if (Object.hasOwn(change, 'sizes')) delete merged.sizes_json;
      if (Object.hasOwn(change, 'material_items')) delete merged.material_items_json;
      insertLine(db, id, merged, source?.line_key, source?.applications);
    }
    if (!db.prepare('SELECT id FROM order_lines WHERE version_id=?').get(id)) fail('En az bir satır gerekli');
    // Files must be regenerated for this version: copying an old PDF could authorize stale dimensions.
    db.prepare("UPDATE order_versions SET status='eski' WHERE id=?").run(versionId);
    audit(db, userId, 'revizyon', id, { previousVersionId: versionId });
    return snapshot(db, id);
  });
}
function updateOrder(db, orderId, changes, user) {
  return tx(db, () => {
    assertUser(db, uid(user));
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    if (!order || order.deleted_at) fail('Sipariş bulunamadı', 404);
    if (db.prepare("SELECT id FROM order_versions WHERE order_id=? AND status<>'taslak'").get(orderId)) fail('Onaya gönderilmiş sipariş için revizyon gerekli', 409);
    db.prepare('UPDATE orders SET job_no=?,customer_name=? WHERE id=?').run(changes.job_no ?? order.job_no, changes.customer_name ?? order.customer_name, orderId);
    audit(db, uid(user), 'siparis_duzenle', orderId); return db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  });
}
function cancelOrder(db, orderId, user) {
  return tx(db, () => {
    assertUser(db, uid(user));
    if (!db.prepare('SELECT id FROM orders WHERE id=? AND deleted_at IS NULL').get(orderId)) fail('Sipariş bulunamadı', 404);
    if (db.prepare('SELECT a.id FROM approvals a JOIN order_versions v ON v.id=a.version_id WHERE v.order_id=?').get(orderId)) fail('Onaylı sipariş iptali için stok iade politikası gerekli', 409);
    db.prepare("UPDATE order_versions SET status='iptal' WHERE order_id=? AND status<>'eski'").run(orderId);
    audit(db, uid(user), 'siparis_iptal', orderId); return { ok: true };
  });
}
// G59: soft delete from the order list. The row, its versions and files stay; deleted_at/deleted_by hide it everywhere.
// There is no stock-release path for a whole order (cancelOrder refuses approved orders too), so an order that holds a
// reservation, a stock movement or a workshop/cost hand-off is refused with the reason instead of touching the ledger.
function deleteOrder(db, orderId, input, user) {
  return tx(db, () => {
    const userId = uid(user); assertUser(db, userId);
    const order = db.prepare('SELECT * FROM orders WHERE id=? AND deleted_at IS NULL').get(orderId);
    if (!order) fail('Sipariş bulunamadı', 404);
    if (input?.onay !== true) fail('Silmek için onay gerekli', 400);
    const lines = db.prepare('SELECT l.id FROM order_lines l JOIN order_versions v ON v.id=l.version_id WHERE v.order_id=?').all(orderId).map(l => l.id);
    const versions = db.prepare('SELECT id FROM order_versions WHERE order_id=?').all(orderId).map(v => v.id);
    const marks = list => list.map(() => '?').join(',');
    if (lines.length && (db.prepare(`SELECT 1 FROM stock_movements WHERE type='cikis' AND order_line_id IN (${marks(lines)})`).get(...lines) ||
        db.prepare(`SELECT 1 FROM allocations WHERE consumed_milli>0 AND order_line_id IN (${marks(lines)})`).get(...lines)))
      fail('Bu siparişte stok çıkışı var; silinemez. Önce stok çıkışı geri alınmalı (yöneticiye danışın).', 409);
    if (db.prepare('SELECT 1 FROM approvals a JOIN order_versions v ON v.id=a.version_id WHERE v.order_id=?').get(orderId) ||
        (lines.length && db.prepare(`SELECT 1 FROM allocations WHERE (reserved_milli>0 OR shortage_milli>0) AND order_line_id IN (${marks(lines)})`).get(...lines)))
      fail('Bu sipariş onaylandı ve stokta ayırması var; stok iade işlemi olmadan silinemez (yöneticiye danışın).', 409);
    if (versions.length && db.prepare(`SELECT 1 FROM outbox WHERE status IN ('tamam','isleniyor') AND version_id IN (${marks(versions)})`).get(...versions))
      fail('Bu sipariş atölyeye ya da maliyete gönderilmiş; silinemez.', 409);
    // Open checks of the order's lines and applications would keep counting in the team's "Teyitler" list.
    const open = db.prepare(`SELECT c.id FROM confirmations c WHERE c.status='acik' AND (
        (c.ref_table='order_lines' AND c.ref_id IN (${marks(lines.length ? lines : [0])})) OR
        (c.ref_table='applications' AND c.ref_id IN (SELECT a.id FROM applications a WHERE a.line_id IN (${marks(lines.length ? lines : [0])}))) OR
        (c.ref_table='order_versions' AND c.ref_id IN (${marks(versions.length ? versions : [0])})))`)
      .all(...(lines.length ? lines : [0]), ...(lines.length ? lines : [0]), ...(versions.length ? versions : [0])).map(c => c.id);
    for (const id of open) db.prepare("UPDATE confirmations SET status='cozuldu',resolved_by=? WHERE id=?").run(userId, id);
    db.prepare('UPDATE orders SET deleted_at=?,deleted_by=? WHERE id=?').run(new Date().toISOString(), userId, orderId);
    audit(db, userId, 'siparis_sil', orderId, { orderNo: order.order_no, versions, kapatilanTeyitler: open });
    return { ok: true, id: orderId, order_no: order.order_no };
  });
}
module.exports = { createOrder, deleteOrder, addLine, addApplication, addFile, submitForApproval, reviseVersion, updateOrder, cancelOrder, snapshot, version, retireWorkshopJobs };
