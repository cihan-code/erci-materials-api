'use strict';
// G5: hands an approved version's uretim_formu to the existing cost flow (documents -> document -> documentCommit).
// Cost rules stay in productionForm/pricingEngine; this adapter only feeds them the order data and decides when to wait.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { tx, audit, fail } = require('./db');
const { assertUser } = require('./auth');
const outbox = require('./outbox');
const { snapshot } = require('./orders');
const { normArea } = require('../productionForm');
const recipeReader = require('../operations/recipes');

const KIND = 'maliyet_aktarim';
const STALE_REF = 'atlandi:eski_surum';
// productionForm notes weaker template matches as "kesin değil — kontrol edin"; an unattended transfer waits instead.
const MIN_TEMPLATE_SCORE = 0.75;
const SCHEMA = `CREATE TABLE IF NOT EXISTS cost_transfers (
 version_id INTEGER PRIMARY KEY REFERENCES order_versions(id), order_id INTEGER NOT NULL REFERENCES orders(id),
 unit_price REAL CHECK(unit_price IS NULL OR unit_price>0), kdv_dahil INTEGER CHECK(kdv_dahil IS NULL OR kdv_dahil IN (0,1)),
 bn_items_json TEXT, price_by INTEGER REFERENCES users(id), price_at TEXT,
 document_id TEXT, computation_json TEXT, missing_json TEXT NOT NULL DEFAULT '[]',
 panel_job_id TEXT, job_no TEXT, done_at TEXT, skipped_reason TEXT,
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS cost_transfers_order ON cost_transfers(order_id);`;
const ready = new WeakSet();
const now = () => new Date().toISOString();
const uid = user => user && typeof user === 'object' ? user.id : user;
// Same comparison commitProductionForm uses to find an existing job by job_no.
const jobKey = value => String(value || '').trim().toLowerCase();
// Patron: every unit sale price is excluding VAT; a VAT-inclusive entry is refused, never converted.
const KDV_NOTE = 'KDV hariç';
const techLabel = type => type === 'baski' ? 'Baskı' : 'Nakış';
// Display labels only; application keys and costing inputs keep their existing values.
const AREA_LABELS = { 'göğüs': 'Göğüs', 'sırt': 'Sırt', kol: 'Kol', ense: 'Ense', 'kapüşon': 'Kapüşon',
  'sol göğüs': 'Sol göğüs', 'sağ göğüs': 'Sağ göğüs', 'sol kol': 'Sol kol', 'sağ kol': 'Sağ kol', yaka: 'Yaka', 'ön': 'Ön' };
const areaLabel = area => AREA_LABELS[normArea(area)] || area;
function missingLabel(message) {
  return String(message).replace(/((?:Baskı|Nakış) boyutu seçilmeli: ")([^"]+)(")/g,
    (_, prefix, area, suffix) => prefix + areaLabel(area) + suffix).trim().replace(/[.,;:!?]+$/, '');
}
// Bad or ambiguous data fails the same way on every attempt; the core parks it as basarisiz with an eksik_alan teyit.
function dataError(message) { const err = new Error(message); err.permanent = true; return err; }

function ensureSchema(db) {
  if (!ready.has(db)) { db.exec(SCHEMA); ready.add(db); }
  return db;
}
// Legacy modules fix DATA_DIR when first loaded; load them only when a transfer actually runs.
function legacy() {
  return { docs: require('../documents'), document: require('../document'), commit: require('../documentCommit'), store: require('../store') };
}
function checkDataDir(L, dataDir) {
  if (dataDir == null) return;
  const root = path.resolve(dataDir);
  if (path.resolve(L.store.DATA_DIR) !== root || path.resolve(L.docs.DOCS_DIR) !== path.join(root, 'agent', 'documents'))
    throw dataError('Maliyet akışının veri klasörü sipariş veri klasörüyle aynı değil; aktarım yapılmadı');
}
function getRow(db, versionId) { return db.prepare('SELECT * FROM cost_transfers WHERE version_id=?').get(versionId); }
function upsert(db, versionId, orderId, fields) {
  const cols = Object.keys(fields);
  db.prepare(`INSERT INTO cost_transfers(version_id,order_id,${cols.join(',')},updated_at) VALUES(?,?,${cols.map(() => '?').join(',')},?)
    ON CONFLICT(version_id) DO UPDATE SET ${cols.map(c => `${c}=excluded.${c}`).join(',')},updated_at=excluded.updated_at`)
    .run(versionId, orderId, ...cols.map(c => fields[c]), now());
}
function loadVersion(db, versionId) {
  const v = db.prepare(`SELECT v.*,o.order_no,o.job_no,o.customer_name,o.created_at AS order_created_at
    FROM order_versions v JOIN orders o ON o.id=v.order_id WHERE v.id=?`).get(versionId ?? null);
  if (!v) fail('Sürüm bulunamadı', 404);
  return v;
}

// Units = pieces that carry the application; two prints on one garment count twice.
function applicationUnits(lines) {
  const map = new Map();
  for (const line of lines) {
    const seen = new Set();
    for (const a of line.applications || []) {
      const area = normArea(a.position), key = `${a.kind}:${area}`;
      if (!map.has(key)) map.set(key, { type: a.kind, area, lineQty: 0, units: 0, dimensionsMm: [] });
      const e = map.get(key);
      e.units += line.quantity;
      if (!seen.has(key)) { seen.add(key); e.lineQty += line.quantity; }
      const dim = a.width_mm && a.height_mm ? `${a.width_mm}×${a.height_mm}` : null;
      if (dim && !e.dimensionsMm.includes(dim)) e.dimensionsMm.push(dim);
    }
  }
  return [...map.values()];
}

// Structured production-form input built from the approved order; replaces the Sonnet reading of our own PDF.
function orderFacts(db, v, recipes) {
  const lines = snapshot(db, v.id).lines;
  if (!lines.length) throw dataError('Sürümde sipariş satırı yok');
  const products = [...new Set(lines.map(l => l.product_key))];
  // One İşler record carries one product type and one cost template.
  if (products.length !== 1) throw dataError(`Birden çok ürün tipi (${products.map(key => recipes?.products?.[key]?.label || 'Bilinmeyen ürün').join(', ')}) tek İşler kaydına aktarılamaz; maliyeti elle girin`);
  const label = recipes?.products?.[products[0]]?.label || products[0];
  const total = lines.reduce((s, l) => s + l.quantity, 0);
  const sizeList = lines.map(l => JSON.parse(l.sizes_json));
  // A breakdown missing some lines would look complete in İşler; leave it unknown.
  const sizes = sizeList.every(s => Object.keys(s).length)
    ? sizeList.reduce((acc, s) => { for (const [k, q] of Object.entries(s)) acc[k] = (acc[k] || 0) + q; return acc; }, {}) : null;
  const apps = applicationUnits(lines);
  // Areas present on only some lines: express the gap with the form's own exception mechanism so per-area counts stay exact.
  const instructions = apps.filter(a => a.lineQty < total).map(a => ({
    text: `${total - a.lineQty} adette ${a.area} ${a.type === 'baski' ? 'baskısı' : 'nakışı'} yok (yalnız bazı satırlarda var)`,
    affects: a.type === 'baski' ? 'print' : 'embroidery', area: a.area, delta: a.lineQty - total,
  }));
  const colors = [...new Set(lines.map(l => l.color_name).filter(Boolean))].join(', ') || null;
  return {
    label, total, sizes, apps, colors,
    form: {
      document_type: 'production_form', order_no: v.order_no, order_title: null, delivery_date: null,
      product_description: colors ? `${label} (${colors})` : label, product_type: label, color: colors,
      print_areas: apps.filter(a => a.type === 'baski').map(a => a.area),
      embroidery_areas: apps.filter(a => a.type === 'nakis').map(a => a.area),
      size_breakdown: sizes || {}, total_quantity: total, special_instructions: instructions,
      customer_name: v.customer_name || null, notes: null,
    },
  };
}

function validBnItems(items, apps) {
  if (!Array.isArray(items) || items.length > 50) fail('bnItems: en çok 50 kalemlik dizi olmalı');
  return items.map(it => {
    if (!it || !['baski', 'nakis'].includes(it.type)) fail('bnItems.type: baski veya nakis olmalı');
    if (typeof it.area !== 'string' || !it.area.trim() || typeof it.size !== 'string' || !it.size.trim()) fail('bnItems: bölge ve boyut gerekli');
    if (it.qty != null && (!Number.isSafeInteger(it.qty) || it.qty <= 0)) fail('bnItems.qty: pozitif tam sayı olmalı');
    if (it.label != null && typeof it.label !== 'string') fail('bnItems.label: metin olmalı');
    if (!apps.some(a => a.type === it.type && a.area === normArea(it.area))) fail(`Bu sürümde ${techLabel(it.type).toLocaleLowerCase('tr')} bölgesi yok: ${areaLabel(it.area)}`);
    return { type: it.type, area: it.area.trim(), size: it.size.trim(),
      ...(it.qty != null ? { qty: it.qty } : {}), ...(it.label?.trim() ? { label: it.label.trim().slice(0, 80) } : {}) };
  });
}

// Everything that must be settled by a person before an unattended commit; empty means ready.
function missingInputs(cm, apps, bnSupplied, price) {
  const missing = [];
  // The flow's own notes explain each of these cases (no template, unsized print, weak match).
  if (!cm.templateMatch || cm.needsManual || cm.templateMatch.score < MIN_TEMPLATE_SCORE) missing.push(...cm.notes);
  if (bnSupplied) {
    // A supplied list replaces the per-area drafts, so an uncovered application would silently drop out of the cost.
    const provided = new Map();
    for (const it of cm.baskiNakisItems || []) if (it.size) provided.set(`${it.type}:${it.area}`, (provided.get(`${it.type}:${it.area}`) || 0) + it.qty);
    for (const a of apps) {
      const got = provided.get(`${a.type}:${a.area}`) || 0;
      if (got !== a.units) missing.push(`${techLabel(a.type)} adedi siparişle tutmuyor: "${areaLabel(a.area)}" siparişte ${a.units}, seçimde ${got}`);
    }
  }
  if (price == null) missing.push('Birim satış fiyatı girilmeli');
  return [...new Set(missing.map(missingLabel))];
}

// Picks the İşler record to update, or null for a new one. Ambiguity throws instead of choosing.
function resolveJob(jobs, { orderNo, jobNo, storedId }) {
  const byNo = no => jobs.filter(j => jobKey(j.job_no) === jobKey(no));
  const key = jobNo || orderNo;
  const own = storedId != null ? jobs.find(j => String(j.id) === String(storedId)) : null;
  // The record we transferred to is gone; a same-numbered record is not evidence that it is the same job.
  if (storedId != null && !own) throw dataError(`Aktarılan İşler kaydı (${storedId}) bulunamadı: İşler kaydı silinmiş; ekip doğrulamalı`);
  const hits = byNo(key);
  if (hits.length > 1) throw dataError(`İşler'de "${key}" iş numaralı birden fazla kayıt var; hangisinin güncelleneceği belirsiz`);
  if (jobNo && jobKey(jobNo) !== jobKey(orderNo) && byNo(orderNo).length)
    throw dataError(`İşler'de hem "${jobNo}" hem "${orderNo}" kaydı var; hangisinin güncelleneceği belirsiz`);
  if (own && hits[0] !== own) throw dataError(`Daha önce aktarılan İşler kaydının (${storedId}) iş numarası artık "${key}" değil; elle kontrol edin`);
  if (hits.length) return hits[0];
  if (jobNo) throw dataError(`Siparişin iş numarası "${jobNo}" İşler'de bulunamadı; yeni kayıt açılmadı`);
  return null;
}

function finalize(db, v, jobId, jobNo, documentId) {
  return tx(db, () => {
    upsert(db, v.id, v.order_id, { panel_job_id: String(jobId), job_no: jobNo, document_id: documentId, done_at: now(), missing_json: '[]' });
    if (db.prepare("UPDATE orders SET job_no=? WHERE id=? AND (job_no IS NULL OR trim(job_no)='')").run(jobNo, v.order_id).changes)
      audit(db, null, 'siparis_is_no', v.order_id, { jobNo, versionId: v.id });
    audit(db, null, 'maliyet_aktarildi', v.id, { jobId: String(jobId), jobNo, documentId });
    return String(jobId);
  });
}

// Recovery after a crash between commitDocument and finalize: the document already names the job it created.
function recoverCommitted(db, L, v, doc) {
  const created = doc.committedRecord?.created?.find(c => c.kind === 'job');
  const job = created && (L.store.readPanelRaw()?.data?.jobs || []).find(j => String(j.id) === String(created.id));
  if (!job) throw dataError(`Üretim formu belgesi (${doc.id}) işlenmiş ama İşler kaydı bulunamadı; elle kontrol edin`);
  return { providerRef: finalize(db, v, job.id, String(job.job_no).trim(), doc.id) };
}

async function transfer(payload, context, { dataDir, recipes } = {}) {
  const db = ensureSchema(context?.db);
  const { versionId, orderNo, versionNo } = payload || {};
  const v = loadVersion(db, versionId);
  if (v.order_no !== orderNo || v.version_no !== versionNo) throw dataError('Kuyruk yükü sürüm kaydıyla uyuşmuyor');
  const done = getRow(db, v.id);
  if (done?.done_at) return { providerRef: done.panel_job_id };
  if (done?.skipped_reason) return { providerRef: STALE_REF };
  if (v.status !== 'onaylandi') {
    // Fallback: revision already cancels pending jobs, but a superseded version must never overwrite the newer İşler data.
    tx(db, () => { upsert(db, v.id, v.order_id, { skipped_reason: `Sürüm durumu: ${v.status}` }); audit(db, null, 'maliyet_atlandi', v.id, { status: v.status }); });
    return { providerRef: STALE_REF };
  }
  const L = legacy();
  checkDataDir(L, dataDir);

  // 1. yükle: the approved production PDF, verified against the recorded hash.
  const file = db.prepare("SELECT * FROM files WHERE version_id=? AND kind='uretim_formu'").get(v.id);
  if (!file) throw dataError('Onaylı sürümde uretim_formu dosyası yok');
  if (!path.isAbsolute(file.path)) throw dataError('uretim_formu dosya yolu mutlak olmalı');
  const buffer = fs.readFileSync(file.path);
  if (crypto.createHash('sha256').update(buffer).digest('hex') !== file.sha256) throw dataError('uretim_formu SHA256 kayıtla uyuşmuyor; dosya değişmiş');
  const facts = orderFacts(db, v, recipes || recipeReader.load());
  let doc = done?.document_id ? L.docs.getDocument(done.document_id) : null;
  if (doc?.status === 'committed') return recoverCommitted(db, L, v, doc);
  if (!doc || doc.status === 'discarded' || doc.sha256 !== file.sha256) {
    const name = `${v.order_no}-v${v.version_no}-uretim-formu${path.extname(file.path).toLowerCase() || '.pdf'}`;
    const saved = L.docs.saveDocument(buffer, name, 'application/pdf');
    tx(db, () => { upsert(db, v.id, v.order_id, { document_id: saved.id }); audit(db, null, 'maliyet_belge', v.id, { documentId: saved.id }); });
    doc = L.docs.getDocument(saved.id);
  }

  // 2. çıkar: structured order data through the flow's own normaliser and classifier; no model call.
  const extraction = L.document.normalizeExtraction(facts.form);
  const classification = L.document.classify(extraction);
  classification.humanLabel = L.document.humanClass(classification.finalType, classification.finalDirection);
  L.docs.updateDocument(doc.id, { status: 'extracted', extraction, classification,
    extractMeta: { source: 'siparis', versionId: v.id, model: null, costUsd: 0, at: now(), mock: false } });

  // 3. yeniden hesapla: quantities and template cost/price from panel costTemplates.
  const row = getRow(db, v.id);
  const bnItems = row?.bn_items_json ? JSON.parse(row.bn_items_json) : null;
  const { form } = facts;
  const rec = L.document.recomputeProdForm(doc.id, { order_no: form.order_no, product_type: form.product_type,
    product_description: form.product_description, total_quantity: form.total_quantity, size_breakdown: form.size_breakdown,
    print_areas: form.print_areas, embroidery_areas: form.embroidery_areas, special_instructions: form.special_instructions,
    ...(bnItems ? { bnItems } : {}) });
  const { quantities: q, costMatch: cm } = rec.prodComputation;
  const computation = { productType: facts.label, totalQty: q.totalQty, template: cm.templateMatch, costItems: cm.costItems,
    costTotal: cm.costTotal, suggestedUnitPrice: cm.suggestedUnitPrice, priceTierAvailable: cm.priceTierAvailable,
    baskiNakisItems: cm.baskiNakisItems, applications: facts.apps, notes: cm.notes, warnings: q.warnings };
  const missing = missingInputs(cm, facts.apps, !!bnItems, row?.unit_price ?? null);
  tx(db, () => upsert(db, v.id, v.order_id, { computation_json: JSON.stringify(computation), missing_json: JSON.stringify(missing) }));
  // Without a price the job parks until the fiyat endpoint requeues it; with a price, anything still missing is a data error.
  // The queue re-tests the wait inside its parking transaction, so a price saved meanwhile requeues the job instead.
  if (row?.unit_price == null) return { status: 'fiyat_bekliyor', stillWaiting: d => getRow(d, v.id)?.unit_price == null };
  if (missing.length) throw dataError(`Maliyet aktarımı için eksik alanlar:\n${missing.map(message => `• ${message}`).join('\n')}`);
  if (row.kdv_dahil === 1) throw dataError('Birim fiyat KDV dahil kaydedilmiş; fiyat KDV hariç yeniden girilmeli');

  // 4. işle: commitDocument, using its "update" choice whenever an İşler record already exists.
  const raw = L.store.readPanelRaw();
  if (!raw || !raw.data) throw new Error('panel-data.json yok');
  const prior = db.prepare(`SELECT panel_job_id FROM cost_transfers WHERE order_id=? AND done_at IS NOT NULL
    AND panel_job_id IS NOT NULL ORDER BY done_at DESC LIMIT 1`).get(v.order_id);
  const target = resolveJob(raw.data.jobs || [], { orderNo: v.order_no, jobNo: v.job_no?.trim() || null, storedId: prior?.panel_job_id });
  const key = target ? String(target.job_no).trim() : v.order_no;
  const fields = {
    finalType: 'production_form', order_no: key, order_date: String(v.order_created_at).slice(0, 10),
    // Fields the order does not know keep the İşler record's values on update.
    order_title: target ? target.title : null, delivery_date: target ? target.delivery_date : null,
    baski_nakis_secim: target ? target.baski_nakis_secim : null,
    customer_name: v.customer_name || (target ? target.customer_name_free : null),
    product_type: form.product_type, product_description: form.product_description, color: form.color,
    total_quantity: q.totalQty, size_breakdown: facts.sizes, print_areas: form.print_areas,
    embroidery_areas: form.embroidery_areas, special_instructions: form.special_instructions,
    unit_price: row.unit_price, cost_items: cm.costItems,
    notes: `Sipariş ${v.order_no} v${v.version_no} · Birim fiyat: ${KDV_NOTE}`,
  };
  const out = L.commit.commitDocument(doc.id, { confirm: true, fields, links: { customer_id: target ? target.customer_id ?? null : null },
    ...(target ? { existingJobAction: 'update' } : {}) });
  if (out.needsExistingJobDecision) throw new Error(`İşler'de "${key}" kaydı aktarım sırasında oluştu; tekrar denenecek`);
  if (target && String(out.jobId) !== String(target.id)) throw dataError(`Beklenen İşler kaydı ${target.id}, güncellenen ${out.jobId}; elle kontrol edin`);
  return { providerRef: finalize(db, v, out.jobId, key, doc.id) };
}

function register({ dataDir, recipes } = {}) {
  return outbox.registerHandler(KIND, (payload, context) => transfer(payload, context, { dataDir, recipes }));
}

function costStatus(db, orderId) {
  ensureSchema(db);
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!order) fail('Sipariş bulunamadı', 404);
  const job = db.prepare(`SELECT o.*,v.version_no,v.status AS version_status FROM outbox o JOIN order_versions v ON v.id=o.version_id
    WHERE v.order_id=? AND o.kind=? ORDER BY v.version_no DESC,o.id DESC LIMIT 1`).get(order.id, KIND);
  const row = job ? getRow(db, job.version_id) : null;
  const prior = db.prepare(`SELECT panel_job_id FROM cost_transfers WHERE order_id=? AND done_at IS NOT NULL
    AND panel_job_id IS NOT NULL ORDER BY done_at DESC LIMIT 1`).get(order.id);
  return {
    orderId: order.id, orderNo: order.order_no, jobNo: order.job_no,
    versionId: job?.version_id ?? null, versionNo: job?.version_no ?? null, versionStatus: job?.version_status ?? null,
    outboxId: job?.id ?? null, status: job?.status ?? null, priceWaiting: job?.status === 'fiyat_bekliyor',
    lastError: job?.last_error ?? null, jobId: row?.panel_job_id ?? prior?.panel_job_id ?? null,
    unitPrice: row?.unit_price ?? null, kdvDahil: row?.unit_price == null ? null : false,
    priceSetBy: row?.price_by ?? null, priceSetAt: row?.price_at ?? null,
    bnItems: row?.bn_items_json ? JSON.parse(row.bn_items_json) : null,
    missing: JSON.parse(row?.missing_json || '[]'), skippedReason: row?.skipped_reason ?? null,
    computation: row?.computation_json ? JSON.parse(row.computation_json) : null,
  };
}

// Price belongs to one approved version: a revision may change quantity, so an older price is never reused.
function setPrice(db, orderId, body, user) {
  ensureSchema(db);
  return tx(db, () => {
    const userId = assertUser(db, uid(user), true).id;
    if (!db.prepare('SELECT id FROM orders WHERE id=?').get(orderId)) fail('Sipariş bulunamadı', 404);
    const input = body && typeof body === 'object' ? body : {};
    const { unitPrice } = input;
    if (typeof unitPrice !== 'number' || !Number.isFinite(unitPrice) || unitPrice <= 0 || Math.round(unitPrice * 100) / 100 !== unitPrice)
      fail('unitPrice: en çok iki ondalıklı pozitif sayı olmalı');
    if (input.kdvDahil != null && input.kdvDahil !== false) fail('Fiyatlar KDV hariç girilir');
    const v = db.prepare("SELECT * FROM order_versions WHERE order_id=? AND status='onaylandi' ORDER BY version_no DESC LIMIT 1").get(orderId);
    if (!v) fail('Onaylı sürüm yok; fiyat onaydan sonra girilir', 409);
    const job = db.prepare('SELECT * FROM outbox WHERE version_id=? AND kind=?').get(v.id, KIND);
    if (!job) fail('Maliyet aktarım işi bulunamadı', 409);
    if (['tamam', 'iptal'].includes(job.status)) fail('Maliyet aktarımı kapandı; fiyat İşler kaydından değiştirilmeli', 409);
    // A running transfer may already be committing the stored price; changing it now would leave İşler and this record apart.
    // A first price is safe: the queue re-tests the wait when it parks the job.
    if (job.status === 'isleniyor' && getRow(db, v.id)?.unit_price != null) fail('Maliyet aktarımı sürüyor; bitince fiyatı yeniden girin', 409);
    const fields = { unit_price: unitPrice, kdv_dahil: 0, price_by: userId, price_at: now() };
    let bnItems;
    if (Object.hasOwn(input, 'bnItems')) {
      bnItems = input.bnItems == null ? null : validBnItems(input.bnItems, applicationUnits(snapshot(db, v.id).lines));
      fields.bn_items_json = bnItems ? JSON.stringify(bnItems) : null;
    }
    upsert(db, v.id, orderId, fields);
    audit(db, userId, 'maliyet_fiyat', v.id, { orderId, unitPrice, ...(bnItems !== undefined ? { bnItems } : {}) });
    // fiyat_bekliyor waits for exactly this input; basarisiz may be a missing print size this entry now supplies.
    if (['fiyat_bekliyor', 'basarisiz'].includes(job.status)) outbox.retry(db, job.id, userId);
    return costStatus(db, orderId);
  });
}

module.exports = { KIND, STALE_REF, ensureSchema, register, transfer, costStatus, setPrice, resolveJob, applicationUnits };
