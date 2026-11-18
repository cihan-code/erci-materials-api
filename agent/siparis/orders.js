'use strict';
const crypto = require('crypto');
const { tx, audit, fail, integer } = require('./db');
const { assertUser } = require('./auth');
const uid = user => user && typeof user === 'object' ? user.id : user;
function version(db, id) {
  const v = db.prepare('SELECT * FROM order_versions WHERE id=?').get(id);
  if (!v) fail('Sürüm bulunamadı', 404);
  return v;
}
function editable(db, id) {
  const v = version(db, id);
  if (v.status !== 'taslak') fail('Yalnız taslak düzenlenebilir; yeni revizyon açın', 409);
  return v;
}
function snapshot(db, versionId) {
  const v = version(db, versionId);
  return { ...v, lines: db.prepare('SELECT * FROM order_lines WHERE version_id=? ORDER BY id').all(versionId).map(l => ({
    ...l, applications: db.prepare('SELECT * FROM applications WHERE line_id=? ORDER BY id').all(l.id)
  })), files: db.prepare('SELECT * FROM files WHERE version_id=? ORDER BY id').all(versionId) };
}
function insertApplication(db, lineId, app) {
  if (!['baski','nakis'].includes(app.kind) || typeof app.position !== 'string' || !app.position.trim()) fail('Uygulama türü ve konumu gerekli');
  for (const k of ['width_mm','height_mm']) if (app[k] != null && (!Number.isFinite(app[k]) || app[k] <= 0)) fail('Geçersiz ölçü');
  return Number(db.prepare(`INSERT INTO applications(line_id,kind,position,width_mm,height_mm,measure_source,needs_confirmation)
    VALUES(?,?,?,?,?,?,?)`).run(lineId, app.kind, app.position, app.width_mm ?? null, app.height_mm ?? null,
    app.measure_source ?? null, app.needs_confirmation ? 1 : 0).lastInsertRowid);
}
function jsonObject(value, label) {
  let obj = value ?? {};
  if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch { fail(`${label}: geçersiz JSON`); } }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) fail(`${label}: nesne gerekli`);
  return obj;
}
function insertLine(db, versionId, line, lineKey) {
  integer(line.quantity, 'quantity', 1);
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
  const id = Number(db.prepare(`INSERT INTO order_lines(version_id,line_key,product_key,fabric_item_id,color_name,quantity,sizes_json,lining,material_items_json)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(versionId, lineKey || crypto.randomUUID(), line.product_key, line.fabric_item_id ?? null,
    line.color_name ?? null, line.quantity, JSON.stringify(sizes), [true,1,'var'].includes(line.lining) ? 1 : 0, JSON.stringify(materials)).lastInsertRowid);
  for (const a of line.applications || []) insertApplication(db, id, a);
  return id;
}
function createOrder(db, input, user) {
  const userId = uid(user);
  return tx(db, () => {
    assertUser(db, userId);
    if (typeof input.order_no !== 'string' || !input.order_no.trim()) fail('Sipariş numarası gerekli');
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
    audit(db, uid(user), 'satir_ekle', id); return db.prepare('SELECT * FROM order_lines WHERE id=?').get(id);
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
    if (!['taslak','onay_bekliyor'].includes(version(db, versionId).status)) fail('Bu sürüme dosya eklenemez', 409);
    if (!file.kind || !file.path || !/^[a-f0-9]{64}$/i.test(file.sha256)) fail('Dosya türü, yolu ve SHA256 gerekli');
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
    db.prepare("INSERT INTO confirmations(kind,ref_table,ref_id,message) VALUES('eksik_alan','order_versions',?,?)").run(versionId, `Atölyede eski sürüm (v${v.version_no}) var`);
    audit(db, userId, 'eski_atolye_teyidi', versionId);
  }
}
function reviseVersion(db, versionId, changes = {}, user) {
  return tx(db, () => {
    const userId = uid(user); assertUser(db, userId);
    const old = snapshot(db, versionId);
    if (!['taslak','onay_bekliyor','onaylandi'].includes(old.status)) fail('Yalnız güncel sürüm revize edilebilir', 409);
    // Check all earlier approved ancestors as well (multiple unapproved revisions).
    for (const v of db.prepare('SELECT id FROM order_versions WHERE order_id=?').all(old.order_id)) retireWorkshopJobs(db, v.id, userId);
    const nextNo = db.prepare('SELECT MAX(version_no)+1 AS n FROM order_versions WHERE order_id=?').get(old.order_id).n;
    const id = Number(db.prepare("INSERT INTO order_versions(order_id,version_no,status,previous_version_id,created_by) VALUES(?,?,'onay_bekliyor',?,?)").run(old.order_id, nextNo, versionId, userId).lastInsertRowid);
    const seen = new Set();
    for (const change of changes.lines ?? old.lines) {
      const source = change.id != null ? old.lines.find(l => l.id === change.id) : change.line_key ? old.lines.find(l => l.line_key === change.line_key) : null;
      if ((change.id != null || change.line_key != null) && !source) fail('Revizyon satırı kaynak sürüme ait değil');
      if (source && seen.has(source.id)) fail('Tekrarlı revizyon satırı');
      if (source) seen.add(source.id);
      const merged = { ...source, ...change };
      if (Object.hasOwn(change, 'sizes')) delete merged.sizes_json;
      if (Object.hasOwn(change, 'material_items')) delete merged.material_items_json;
      insertLine(db, id, merged, source?.line_key);
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
    if (!order) fail('Sipariş bulunamadı', 404);
    if (db.prepare("SELECT id FROM order_versions WHERE order_id=? AND status<>'taslak'").get(orderId)) fail('Onaya gönderilmiş sipariş için revizyon gerekli', 409);
    db.prepare('UPDATE orders SET job_no=?,customer_name=? WHERE id=?').run(changes.job_no ?? order.job_no, changes.customer_name ?? order.customer_name, orderId);
    audit(db, uid(user), 'siparis_duzenle', orderId); return db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  });
}
function cancelOrder(db, orderId, user) {
  return tx(db, () => {
    assertUser(db, uid(user));
    if (!db.prepare('SELECT id FROM orders WHERE id=?').get(orderId)) fail('Sipariş bulunamadı', 404);
    if (db.prepare('SELECT a.id FROM approvals a JOIN order_versions v ON v.id=a.version_id WHERE v.order_id=?').get(orderId)) fail('Onaylı sipariş iptali için stok iade politikası gerekli', 409);
    db.prepare("UPDATE order_versions SET status='iptal' WHERE order_id=? AND status<>'eski'").run(orderId);
    audit(db, uid(user), 'siparis_iptal', orderId); return { ok: true };
  });
}
module.exports = { createOrder, addLine, addApplication, addFile, submitForApproval, reviseVersion, updateOrder, cancelOrder, snapshot, version, retireWorkshopJobs };
