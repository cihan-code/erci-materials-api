'use strict';
// G63: approval chain. After a version is approved (by whoever calls approveVersion) the order opens, or updates,
// its İşler record (panel-data.json jobs) and its Üretim Takip card (uretimTakip), through the outbox.
// Only order facts are written; price/termin/cost stay empty unless the order knows them. Cost stays with G5 (costTransfer).
// Off unless ONAY_ZINCIRI=1: then nothing is queued and nothing is written.
const path = require('path');
const { tx, audit, fail } = require('./db');
const outbox = require('./outbox');
const { snapshot } = require('./orders');
const { fabricName } = require('./kartela');
const { normArea } = require('../productionForm');
// G5's own record lookup, so its later cost update lands on the very record the chain opened.
const { resolveJob } = require('./costTransfer');
const recipeReader = require('../operations/recipes');
const { URETIM_STATUSES } = require('../lib/enums');
const { nextId, istanbulDay } = require('../lib/util');

const KIND = 'onay_zinciri';
const SOURCE = 'onay_zinciri';
const STALE_REF = 'atlandi:eski_surum';
const DELETED_REF = 'atlandi:silindi';
// Panel index.html URETIM_LINING_PRODUCTS: the card shows "Astar" only for these products.
const LINING_PRODUCTS = ['sweat', 'tam_fermuar'];
const SCHEMA = `CREATE TABLE IF NOT EXISTS onay_zinciri (
 order_id INTEGER PRIMARY KEY REFERENCES orders(id), version_id INTEGER REFERENCES order_versions(id),
 panel_job_id TEXT, uretim_id TEXT, job_no TEXT,
 job_fields_json TEXT NOT NULL DEFAULT '{}', card_fields_json TEXT NOT NULL DEFAULT '{}', warnings_json TEXT NOT NULL DEFAULT '[]',
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS onay_zinciri_acik (
 id INTEGER PRIMARY KEY CHECK(id=1), after_approval_id INTEGER NOT NULL,
 since TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);`;
const JOB_LABELS = { title: 'İş adı', customer_id: 'Müşteri (kayıtlı)', customer_name_free: 'Müşteri adı', product_type: 'Ürün türü',
  quantity: 'Adet', unit_price: 'Birim fiyat', prod_size_breakdown: 'Beden dağılımı', prod_print_areas: 'Baskı bölgeleri',
  prod_embroidery_areas: 'Nakış bölgeleri', siparis_satirlar: 'Sipariş satırları', siparis_uygulamalar: 'Baskı/nakış uygulamaları',
  siparis_no: 'Sipariş no', siparis_surum: 'Sipariş sürümü' };
const CARD_LABELS = { customer_name: 'Müşteri', quantity: 'Adet', decoration: 'Baskı / Nakış', product_type: 'Ürün', lining: 'Astar',
  job_id: 'İş bağlantısı', job_no: 'İş no', siparis_no: 'Sipariş no' };
const ready = new WeakSet();
const now = () => new Date().toISOString();
const enabled = () => process.env.ONAY_ZINCIRI === '1';
const jobKey = value => String(value || '').trim().toLowerCase();
const trLower = value => String(value || '').trim().toLocaleLowerCase('tr');
function dataError(message) { const err = new Error(message); err.permanent = true; return err; }
const hasTable = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

function ensureSchema(db) {
  if (!ready.has(db)) { db.exec(SCHEMA); ready.add(db); }
  return db;
}
// The marker exists only while a server runs with ONAY_ZINCIRI=1. Approvals made while it was off are never back-filled:
// a later switch-on must not reopen orders the team already typed into İşler by hand.
function setEnabled(db, on) {
  ensureSchema(db);
  return tx(db, () => {
    if (!on) return db.prepare('DELETE FROM onay_zinciri_acik').run().changes ? audit(db, null, 'onay_zinciri_kapali', 1) : undefined;
    if (db.prepare('SELECT 1 FROM onay_zinciri_acik').get()) return undefined;
    const after = db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM approvals').get().m;
    db.prepare('INSERT INTO onay_zinciri_acik(id,after_approval_id) VALUES(1,?)').run(after);
    audit(db, null, 'onay_zinciri_acik', 1, { afterApprovalId: after });
    return undefined;
  });
}
// Queues one chain job per approval made while the chain is on. approveVersion stays untouched; the idempotency key
// makes a repeated sweep harmless, and a job queued before a crash survives the restart.
function enqueue(db) {
  ensureSchema(db);
  const pending = () => {
    const marker = db.prepare('SELECT after_approval_id FROM onay_zinciri_acik WHERE id=1').get();
    return marker ? db.prepare(`SELECT v.id,v.version_no,o.order_no FROM approvals a JOIN order_versions v ON v.id=a.version_id
      JOIN orders o ON o.id=v.order_id WHERE a.id>? AND o.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM outbox x WHERE x.idempotency_key='zincir:'||v.id) ORDER BY a.id`).all(marker.after_approval_id) : [];
  };
  // Read first: the sweep runs every second and must not take the write lock when there is nothing to queue.
  if (!pending().length) return 0;
  return tx(db, () => {
    let n = 0;
    for (const row of pending()) {
      db.prepare('INSERT OR IGNORE INTO outbox(kind,idempotency_key,version_id,payload_json) VALUES(?,?,?,?)')
        .run(KIND, `zincir:${row.id}`, row.id, JSON.stringify({ versionId: row.id, orderNo: row.order_no, versionNo: row.version_no }));
      audit(db, null, 'onay_zinciri_kuyruk', row.id);
      n++;
    }
    return n;
  });
}

function loadVersion(db, versionId) {
  const v = db.prepare(`SELECT v.*,o.order_no,o.job_no,o.customer_name,o.created_at AS order_created_at,o.deleted_at,
    (SELECT approved_at FROM approvals WHERE version_id=v.id) AS approved_at
    FROM order_versions v JOIN orders o ON o.id=v.order_id WHERE v.id=?`).get(versionId ?? null);
  if (!v) fail('Sürüm bulunamadı', 404);
  return v;
}
function fabricOf(db, line) {
  if (line.fabric_item_id != null) {
    const item = db.prepare('SELECT name FROM stock_items WHERE id=?').get(line.fabric_item_id);
    if (item) return item.name;
  }
  return line.fabric_type && !line.fabric_type.startsWith('legacy:') ? fabricName(line.fabric_type) : null;
}
// Measurements the team typed or the measurer settled are exact; anything else (no source, a pending check, or a
// method this module does not know, e.g. a standard/approximate size) is marked "ölçü yaklaşık".
function approximate(app) {
  if (app.width_mm == null || app.height_mm == null) return true;
  if (app.needs_confirmation) return true;
  let method = null;
  try { method = JSON.parse(app.measure_source || 'null')?.method ?? null; } catch { method = null; }
  return !['elle', 'otomatik'].includes(method);
}
const SAME = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// Everything the order itself knows, in İşler and Üretim Takip terms. undefined = unknown: such a field is never written.
function orderFacts(db, v, { recipes = recipeReader.load(), customers = [] } = {}) {
  const lines = snapshot(db, v.id).lines;
  if (!lines.length) throw dataError('Sürümde sipariş satırı yok');
  const label = key => recipes?.products?.[key]?.label || key;
  const products = [...new Set(lines.map(l => l.product_key))];
  const counted = lines.filter(l => l.quantity > 0);
  const total = counted.reduce((s, l) => s + l.quantity, 0);
  const sizeList = counted.map(l => JSON.parse(l.sizes_json));
  // A breakdown missing some lines would look complete in İşler; leave it unknown (same rule as G5).
  const sizes = counted.length && sizeList.every(s => Object.keys(s).length)
    ? sizeList.reduce((acc, s) => { for (const [k, q] of Object.entries(s)) acc[k] = (acc[k] || 0) + q; return acc; }, {}) : undefined;
  const colors = [...new Set(lines.map(l => l.color_name).filter(Boolean))];
  const satirlar = lines.map(l => ({ urun: label(l.product_key), kumas: fabricOf(db, l), renk: l.color_name || null,
    adet: l.quantity, bedenler: JSON.parse(l.sizes_json), astar: l.lining ? 'var' : 'yok', numune: !!l.numune,
    birim_fiyat_kurus: l.unit_price_kurus ?? null }));
  const uygulamalar = lines.flatMap(l => (l.applications || []).map(a => ({ urun: label(l.product_key), renk: l.color_name || null,
    tur: a.kind, konum: normArea(a.position), en_mm: a.width_mm ?? null, boy_mm: a.height_mm ?? null, adet: l.quantity,
    olcu_yaklasik: approximate(a) })));
  const areas = kind => [...new Set(uygulamalar.filter(a => a.tur === kind && a.adet > 0).map(a => a.konum))];
  const kinds = new Set(uygulamalar.map(a => a.tur));
  const decoration = kinds.has('baski') && kinds.has('nakis') ? 'ikisi' : kinds.has('baski') ? 'baski' : kinds.has('nakis') ? 'nakis' : 'yok';
  // Unit price: the version's G5 price if it was entered, else the lines' own price when every counted line has the same one.
  // İşler keeps one unit price per job; differing line prices are never averaged.
  const warnings = [];
  let unitPrice;
  const g5 = hasTable(db, 'cost_transfers') ? db.prepare('SELECT unit_price FROM cost_transfers WHERE version_id=?').get(v.id)?.unit_price : null;
  if (g5 != null) unitPrice = g5;
  else if (counted.length && counted.every(l => l.unit_price_kurus != null)) {
    const prices = new Set(counted.map(l => l.unit_price_kurus));
    if (prices.size === 1) unitPrice = [...prices][0] / 100;
    else warnings.push('Satırların birim fiyatları farklı; İşler tek birim fiyat tutar, fiyat boş bırakıldı');
  } else if (counted.some(l => l.unit_price_kurus != null)) warnings.push('Birim fiyatı yalnız bazı satırlarda var; İşler fiyatı boş bırakıldı');
  const productLabel = products.map(label).join(', ');
  const title = colors.length ? `${productLabel} (${colors.join(', ')})` : productLabel;
  const name = (v.customer_name || '').trim();
  // Same rule as the panel's own job form: a registered customer with exactly this name (case-insensitive).
  const matches = name ? customers.filter(c => trLower(c.name) === trLower(name)) : [];
  if (matches.length > 1) warnings.push(`Müşteri listesinde "${name}" adında ${matches.length} kayıt var; işe bağlanmadı, ad serbest yazıldı`);
  const customerId = matches.length === 1 ? matches[0].id : null;
  const job = {
    title, product_type: productLabel, quantity: total, unit_price: unitPrice,
    customer_id: name ? customerId : undefined, customer_name_free: name ? (customerId != null ? null : name) : undefined,
    // Areas as G5 writes them (counted lines only), so its later cost update does not look like a hand edit.
    prod_size_breakdown: sizes, prod_print_areas: areas('baski'), prod_embroidery_areas: areas('nakis'),
    siparis_no: v.order_no, siparis_surum: v.version_no, siparis_satirlar: satirlar, siparis_uygulamalar: uygulamalar,
  };
  const single = products.length === 1 ? products[0] : null;
  const linings = new Set(lines.map(l => l.lining));
  const card = {
    customer_name: name || title, quantity: total, decoration,
    // The card's product list is the recipe keys; a mixed order has no single product.
    product_type: single || '',
    lining: single && LINING_PRODUCTS.includes(single) && linings.size === 1 ? (lines[0].lining ? 'var' : 'yok') : undefined,
    siparis_no: v.order_no,
  };
  const approx = uygulamalar.filter(a => a.olcu_yaklasik);
  return { job, card, warnings, approx, total };
}

// Order fields go in only where the record still holds what the chain wrote last (or, on a record the chain did not
// write, where it is empty). A value somebody changed in the panel is left alone and reported.
const EMPTY_ZERO = new Set(['quantity', 'unit_price']);
function isEmpty(field, value) {
  if (value == null || value === '') return true;
  if (Array.isArray(value)) return !value.length;
  if (typeof value === 'object') return !Object.keys(value).length;
  return EMPTY_ZERO.has(field) && Number(value) === 0;
}
function merge(record, desired, last, labels, where) {
  const set = {}, kept = {}, conflicts = [], nextLast = {};
  for (const [field, value] of Object.entries(desired)) {
    if (value === undefined) { if (field in last) nextLast[field] = last[field]; continue; }
    const cur = record ? record[field] : undefined;
    if (SAME(cur, value)) { nextLast[field] = value; continue; }
    const untouched = field in last ? SAME(cur, last[field]) : isEmpty(field, cur);
    if (untouched) { set[field] = value; nextLast[field] = value; continue; }
    kept[field] = cur;
    if (field in last) nextLast[field] = last[field];
    // Prices never travel in warnings: panel-veri shows these to the Ajan Paneli, which carries no amounts.
    const values = field === 'unit_price' ? '' : ` (panel: ${JSON.stringify(cur ?? null)}, sipariş: ${JSON.stringify(value)})`;
    conflicts.push(`${where}: "${labels[field] || field}" panelde elle değiştirilmiş; siparişteki değer yazılmadı${values}`);
  }
  return { set, kept, conflicts, nextLast };
}

// Pure planning over the panel data: what would be created or changed. The dry run prints this, the job applies it.
function plan(db, versionId, { panel, recipes } = {}) {
  const v = loadVersion(db, versionId);
  const base = { versionId: v.id, orderNo: v.order_no, versionNo: v.version_no };
  if (v.deleted_at) return { ...base, skip: DELETED_REF, reason: 'Sipariş silinmiş' };
  if (v.status !== 'onaylandi') return { ...base, skip: STALE_REF, reason: `Sürüm durumu: ${v.status}` };
  if (!panel || !panel.data) throw new Error('panel-data.json yok');
  const data = panel.data;
  const map = hasTable(db, 'onay_zinciri') ? db.prepare('SELECT * FROM onay_zinciri WHERE order_id=?').get(v.order_id) : null;
  const g5 = hasTable(db, 'cost_transfers') ? db.prepare(`SELECT panel_job_id FROM cost_transfers WHERE order_id=? AND done_at IS NOT NULL
    AND panel_job_id IS NOT NULL ORDER BY done_at DESC LIMIT 1`).get(v.order_id)?.panel_job_id : null;
  if (map?.panel_job_id && g5 && String(map.panel_job_id) !== String(g5))
    throw dataError(`Zincirin açtığı İşler kaydı (${map.panel_job_id}) ile maliyet aktarımının kaydı (${g5}) farklı; elle kontrol edin`);
  const jobs = data.jobs || [], cards = data.uretimTakip || [];
  const target = resolveJob(jobs, { orderNo: v.order_no, jobNo: v.job_no?.trim() || null, storedId: map?.panel_job_id ?? g5 ?? null });
  const facts = orderFacts(db, v, { recipes, customers: data.customers || [] });
  const ours = !!(target && map?.panel_job_id && String(map.panel_job_id) === String(target.id));
  const key = target ? String(target.job_no).trim() : (v.job_no?.trim() || v.order_no);
  const warnings = [...facts.warnings];
  const jobMerge = merge(target, facts.job, ours ? JSON.parse(map.job_fields_json) : {}, JOB_LABELS, `İşler ${key}`);
  warnings.push(...jobMerge.conflicts);
  const approxNote = facts.approx.length
    ? ` · Ölçü yaklaşık: ${facts.approx.map(a => `${a.tur === 'baski' ? 'baskı' : 'nakış'} ${a.konum}`).join(', ')}` : '';
  const isler = target
    ? { islem: Object.keys(jobMerge.set).length ? 'guncelle' : 'degisiklik_yok', id: target.id, job_no: key, alanlar: jobMerge.set, korunan: jobMerge.kept }
    : { islem: 'ac', id: null, job_no: key, alanlar: {
      job_no: key, order_date: istanbulDay(v.order_created_at), status: 'Onaylandı', delivery_date: null,
      ...Object.fromEntries(Object.entries(facts.job).filter(([, val]) => val !== undefined)),
      unit_price: facts.job.unit_price ?? null, cost_items: [], manual_total_cost: 0, deposit_received: 0, baski_nakis_secim: null,
      problem_note: null, note: `[Sipariş ${v.order_no} v${v.version_no}] onayda otomatik açıldı · Fiyat KDV hariç${facts.job.unit_price == null ? ' · fiyat bekliyor' : ''} · termin bekliyor · maliyet G5 aktarımında${approxNote}`,
      kaynak: SOURCE } };

  // Card: linked to the job by job_id; never two cards for one job.
  let takip;
  const cardLast = ours && map.uretim_id ? JSON.parse(map.card_fields_json) : {};
  const own = map?.uretim_id ? cards.find(c => String(c.id) === String(map.uretim_id)) : null;
  const linked = target ? cards.filter(c => c.job_id != null && String(c.job_id) === String(target.id)) : [];
  const desiredCard = { ...facts.card, job_no: key };
  if (map?.uretim_id && !own) {
    takip = { islem: 'yok', id: null, neden: 'Takip kartı panelden silinmiş; yeniden açılmadı' };
    warnings.push(`Üretim takip kartı (${map.uretim_id}) panelden silinmiş; yeniden açılmadı`);
  } else if (!own && linked.length > 1) {
    takip = { islem: 'yok', id: null, neden: 'Bu işe bağlı birden fazla takip kartı var' };
    warnings.push(`İşler ${key} kaydına bağlı ${linked.length} takip kartı var; hangisinin güncelleneceği belirsiz, dokunulmadı`);
  } else {
    const card = own || linked[0] || null;
    const m = merge(card, desiredCard, own ? cardLast : {}, CARD_LABELS, `Takip ${card ? card.id : 'yeni'}`);
    warnings.push(...m.conflicts);
    takip = card
      ? { islem: Object.keys(m.set).length ? 'guncelle' : 'degisiklik_yok', id: card.id, alanlar: m.set, korunan: m.kept, last: m.nextLast }
      : { islem: 'ac', id: null, alanlar: { date: istanbulDay(v.approved_at || now()), est_delivery: null, status: URETIM_STATUSES[0],
        follow_up_date: null, assigned_to: '', problem_note: '', cord: '',
        note: `[Sipariş ${v.order_no} v${v.version_no}] onayda otomatik açıldı${approxNote}`,
        ...Object.fromEntries(Object.entries(desiredCard).filter(([, val]) => val !== undefined)), kaynak: SOURCE }, last: m.nextLast };
  }
  return { ...base, orderId: v.order_id, isler, takip, uyarilar: warnings, jobLast: jobMerge.nextLast };
}

function checkDataDir(store, dataDir) {
  if (dataDir == null) return;
  if (path.resolve(store.DATA_DIR) !== path.resolve(dataDir)) throw dataError('Panel verisinin klasörü sipariş veri klasörüyle aynı değil; yazılmadı');
}

// Read, plan and write in one synchronous step (no await gap), through the panel's CAS + backup write path.
function run(payload, context, { dataDir, recipes } = {}) {
  const db = ensureSchema(context?.db);
  const { versionId, orderNo, versionNo } = payload || {};
  const v = loadVersion(db, versionId);
  if (v.order_no !== orderNo || v.version_no !== versionNo) {
    // A deleted order is renamed to its archive name; it is skipped below, not treated as a bad payload.
    if (!v.deleted_at) throw dataError('Kuyruk yükü sürüm kaydıyla uyuşmuyor');
  }
  const store = require('../store');
  checkDataDir(store, dataDir);
  const raw = store.readPanelRaw();
  const p = plan(db, v.id, { panel: raw, recipes });
  if (p.skip) {
    tx(db, () => audit(db, null, 'onay_zinciri_atlandi', v.id, { reason: p.reason }));
    return { providerRef: p.skip };
  }
  const data = raw.data;
  data.jobs ||= []; data.uretimTakip ||= [];
  const at = now();
  let jobId = p.isler.id, changed = false;
  if (p.isler.islem === 'ac') {
    jobId = nextId(data.jobs);
    data.jobs.unshift({ id: jobId, ...p.isler.alanlar, created_at: at, updated_at: at });
    changed = true;
  } else if (p.isler.islem === 'guncelle') {
    Object.assign(data.jobs.find(j => String(j.id) === String(jobId)), p.isler.alanlar, { updated_at: at });
    changed = true;
  }
  let cardId = p.takip.id;
  if (p.takip.islem === 'ac') {
    cardId = nextId(data.uretimTakip);
    data.uretimTakip.unshift({ id: cardId, ...p.takip.alanlar, job_id: jobId });
    changed = true;
  } else if (p.takip.islem === 'guncelle') {
    Object.assign(data.uretimTakip.find(c => String(c.id) === String(cardId)), p.takip.alanlar);
    changed = true;
  }
  // A card opened for a new job links to that job's id, which only exists now.
  const cardLast = p.takip.last ? { ...p.takip.last, ...(p.takip.islem === 'ac' ? { job_id: jobId } : {}) } : null;
  if (changed) store.writePanelData(data, raw.updatedAt);
  const ref = tx(db, () => {
    const prev = db.prepare('SELECT * FROM onay_zinciri WHERE order_id=?').get(p.orderId);
    db.prepare(`INSERT INTO onay_zinciri(order_id,version_id,panel_job_id,uretim_id,job_no,job_fields_json,card_fields_json,warnings_json,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(order_id) DO UPDATE SET version_id=excluded.version_id,panel_job_id=excluded.panel_job_id,
      uretim_id=excluded.uretim_id,job_no=excluded.job_no,job_fields_json=excluded.job_fields_json,card_fields_json=excluded.card_fields_json,
      warnings_json=excluded.warnings_json,updated_at=excluded.updated_at`)
      .run(p.orderId, v.id, String(jobId), cardId != null ? String(cardId) : prev?.uretim_id ?? null, p.isler.job_no,
        JSON.stringify(p.jobLast), JSON.stringify(cardLast ?? JSON.parse(prev?.card_fields_json || '{}')), JSON.stringify(p.uyarilar), at);
    // Same link G5 records after its transfer: the order now names its İşler number.
    if (db.prepare("UPDATE orders SET job_no=? WHERE id=? AND (job_no IS NULL OR trim(job_no)='')").run(p.isler.job_no, p.orderId).changes)
      audit(db, null, 'siparis_is_no', p.orderId, { jobNo: p.isler.job_no, versionId: v.id });
    audit(db, null, 'onay_zinciri', v.id, { isler: p.isler.islem, jobId: String(jobId), takip: p.takip.islem, cardId: cardId ?? null, uyarilar: p.uyarilar });
    return { isler: String(jobId), takip: cardId != null ? String(cardId) : null, uyari: p.uyarilar.length };
  });
  return { providerRef: ref };
}

// Dry run: the same plan, printed; nothing is written (no schema either).
function dryRun(db, versionId, { panel, recipes } = {}) {
  const p = plan(db, versionId, { panel, recipes });
  if (p.skip) return { kuru: true, surumId: p.versionId, siparisNo: p.orderNo, atlandi: p.reason };
  return { kuru: true, surumId: p.versionId, siparisNo: p.orderNo, surum: p.versionNo, isler: p.isler,
    takip: { islem: p.takip.islem, id: p.takip.id, alanlar: p.takip.alanlar || {}, korunan: p.takip.korunan || {}, ...(p.takip.neden ? { neden: p.takip.neden } : {}) },
    uyarilar: p.uyarilar };
}

// Called once by routes.js. With the flag off the marker is cleared and nothing is queued or registered.
function mount(db, { dataDir, recipes, worker = true, intervalMs = 1000, onError = err => console.error('[onay zinciri]', err?.message || err) } = {}) {
  const on = enabled();
  setEnabled(db, on);
  if (!on) return () => {};
  enqueue(db);
  const unregister = worker ? outbox.registerHandler(KIND, (payload, context) => run(payload, context, { dataDir, recipes })) : () => {};
  const timer = setInterval(() => { try { if (db.open) enqueue(db); } catch (err) { try { onError(err); } catch { /* never fatal */ } } }, intervalMs);
  timer.unref();
  return () => { clearInterval(timer); unregister(); };
}

module.exports = { KIND, STALE_REF, DELETED_REF, ensureSchema, setEnabled, enqueue, orderFacts, plan, run, dryRun, mount, enabled };
