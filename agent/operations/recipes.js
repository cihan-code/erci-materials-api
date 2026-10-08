'use strict';
// Product recipes: per-unit material use and product-specific steps. Amounts are
// computed here; the model sees them only as context and never produces them.
// Supply confirmations (zipper, collar) never move the kanban stage; ilik moves it
// only where the recipe places it after sewing (polo ilik-düğme).
const fs = require('fs'), path = require('path');
const AUX_OPS = ['zipper', 'collar'];
const CHOICES = ['var', 'yok'];
const CUT_STAGES = ['Kumaş Bekleniyor', 'Kumaş Geldi', 'Kesimde'];
const PRE_SEWING = [...CUT_STAGES, 'Baskı/Nakışta', 'Dikimde'];
const STATUS = { partial: 'kısmen geldi', in_progress: 'devam ediyor', blocked: 'bekleniyor', not_started: 'başlanmadı' };
let cached = null;
function validate(cfg) {
  const amount = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
  const material = m => m && cfg.materials?.[m.key] && (m.when === undefined || m.when === 'lining') &&
    (m.g_per_unit === null ? typeof m.condition === 'string' && !!m.condition : amount(m.g_per_unit));
  if (cfg?.version !== 1 || !cfg.products || !cfg.materials || Object.values(cfg.products).some(p => !p.label ||
      !Array.isArray(p.materials) || !p.materials.length || !p.materials.every(material) ||
      !Array.isArray(p.steps) || !p.steps.length || p.steps.some(s => typeof s !== 'string' || !s.trim()) ||
      (p.preparations || []).some(x => !AUX_OPS.includes(x.op) || !x.label) ||
      (p.post_sewing_op !== undefined && p.post_sewing_op !== 'buttonhole')))
    throw new Error('Reçete yapılandırması geçersiz; planı kontrol edin.');
  return cfg;
}
function load() {
  return cached ||= validate(JSON.parse(fs.readFileSync(path.join(__dirname, 'recipes.json'), 'utf8')));
}
const choice = value => CHOICES.includes(value) ? value : '';
const cap = text => text.charAt(0).toLocaleUpperCase('tr-TR') + text.slice(1);
function quantity(value) {
  if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim())) value = Number(value);
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}
function postSewingOp(productType, cfg = load()) {
  return cfg.products[productType]?.post_sewing_op || null;
}
// Entries that may move the kanban stage for this record.
function stageEntries(record, entries, cfg = load()) {
  const post = postSewingOp(record.product_type, cfg);
  return entries.filter(e => !AUX_OPS.includes(e.op) && (e.op !== 'buttonhole' || post === 'buttonhole'));
}
function kg(grams, units) {
  const value = grams * units / 1000;
  if (value < 0.1) return { kg: Math.round(value * 100) / 100, text: '<0,1 kg' };
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return { kg: rounded, text: '≈' + String(rounded).replace('.', ',') + ' kg' };
}
function materialNeed(record, units, cfg = load()) {
  const product = cfg.products[record.product_type];
  if (!product) return { status: 'unavailable', quantity: null, items: [], message: 'Ürün seçilmemiş; malzeme ihtiyacı hesaplanamadı.' };
  if (units == null) return { status: 'unavailable', quantity: null, items: [], message: 'Adet yok; malzeme ihtiyacı hesaplanamadı.' };
  const lining = choice(record.lining), items = [];
  for (const m of product.materials) {
    if (m.when === 'lining' && lining === 'yok') continue;
    const label = cfg.materials[m.key];
    const condition = m.when === 'lining' ? (lining === 'var' ? null : 'modelde astar varsa') : m.condition || null;
    if (m.g_per_unit === null) {
      items.push({ key: m.key, label, g_per_unit: null, kg: null, condition, text: (condition ? condition + ' ' : '') + label + ' (miktarı reçetede yok)' });
      continue;
    }
    const need = kg(m.g_per_unit, units);
    items.push({ key: m.key, label, g_per_unit: m.g_per_unit, kg: need.kg, condition,
      text: (condition ? condition + ' ' : '') + need.text + ' ' + label });
  }
  return { status: 'calculated', quantity: units, items, message: 'Malzeme (fire hariç): ' + items.map(i => i.text).join(', ') + '.' };
}
function preparations(record, entries, stage, cfg = load()) {
  const product = cfg.products[record.product_type];
  const done = new Set(entries.filter(e => e.status === 'completed').map(e => e.op));
  if (!product?.preparations || !PRE_SEWING.includes(stage) || ['sewing', 'pack', 'delivery'].some(op => done.has(op))) return [];
  return product.preparations.map(p => {
    const entry = entries.find(e => e.op === p.op);
    const status = !entry ? 'unconfirmed' : entry.status === 'completed' ? 'confirmed' : 'reported';
    const text = status === 'confirmed' ? '' : status === 'reported'
      ? p.label + ' ' + STATUS[entry.status] + (entry.reason ? ' (' + entry.reason + ')' : '') + '; teyit edilsin.'
      : cap((p.condition ? p.condition + ' ' : '') + p.label.toLocaleLowerCase('tr-TR')) + ' teyit edilsin.';
    return { op: p.op, label: p.label, condition: p.condition || null, status, reason: entry?.reason || '', text };
  });
}
function hints(record, task, entries, stage, deco, cfg = load()) {
  const p = cfg.products[record.product_type];
  if (!p || !task) return [];
  const done = new Set(entries.filter(e => e.status === 'completed').map(e => e.op));
  const cord = choice(record.cord), lining = choice(record.lining), out = [];
  const ilik = (prefix = '') => cord === 'var' ? prefix + p.cord_part + ' ilikçiye gönder.'
    : prefix + 'model kordonluysa ' + p.cord_part + ' ilikçiye gönder.';
  if (!done.has('cut') && CUT_STAGES.includes(stage)) {
    if (p.extra_cut) out.push(cap(p.extra_cut) + ' kesimi de yapılsın.');
    if (p.lining && lining !== 'yok') out.push(lining === 'var' ? 'Astar kesimi de yapılsın.' : 'Modelde astar varsa astar kesimi de yapılsın.');
    if (p.cord_part && cord !== 'yok') out.push(ilik('Kesimden sonra ').replace('sonra model', 'sonra, model'));
  } else if (done.has('cut') && stage === 'Kesimde') {
    if (p.cord_part && cord !== 'yok' && !done.has('buttonhole')) out.push(cap(ilik()));
    if (p.sewing_hint && deco === 'yok') out.push(p.sewing_hint);
  } else if (task.key === 'sewing_handoff') {
    if (p.sewing_hint) out.push(p.sewing_hint);
    if (p.cord_piece && cord === 'var' && !done.has('buttonhole')) out.push('İlikçideki ' + p.cord_piece + ' parçaları da dikime alınsın.');
  } else if (stage === 'Dikimde' && !done.has('sewing')) {
    if (p.sewing_note) out.push(p.sewing_note);
    if (p.post_sewing_op) out.push('Dikimden sonra ilik-düğmeye gönder.');
  }
  return out;
}
// Deterministic recipe summary for one planned task; null when no product is known.
function forTask(record, saved, task, cfg = load()) {
  const product = cfg.products[record.product_type];
  if (!task || !product || saved.stale) return null;
  const entries = saved.entries || [];
  const stage = saved.revision?.status || record.status;
  const done = new Set(entries.filter(e => e.status === 'completed').map(e => e.op));
  const cut = entries.find(e => e.op === 'cut');
  const units = quantity(cut?.status === 'partial' ? cut.remaining : null) ?? quantity(record.quantity);
  const materials = !done.has('cut') && CUT_STAGES.includes(stage) ? materialNeed(record, units, cfg) : null;
  const preps = preparations(record, entries, stage, cfg);
  const notes = hints(record, task, entries, stage, saved.basis?.decoration || record.decoration || '', cfg);
  const text = [...notes, ...(materials ? [materials.message] : []), ...preps.map(x => x.text).filter(Boolean)].join(' ');
  return { version: 1, product_type: record.product_type, label: product.label,
    cord: product.cord_part ? choice(record.cord) || null : null, lining: product.lining ? choice(record.lining) || null : null,
    materials, preparations: preps, hints: notes, text };
}
// Compact per-product context for the model: steps and g/unit, once per product.
function context(productTypes, cfg = load()) {
  return Object.fromEntries([...new Set(productTypes)].filter(t => cfg.products[t]).sort().map(t => {
    const p = cfg.products[t];
    return [t, { label: p.label, steps: p.steps,
      g_per_unit: Object.fromEntries(p.materials.map(m => [m.key, m.g_per_unit === null ? (m.condition + '; miktar yok')
        : m.when === 'lining' ? m.g_per_unit + ' (modelde astar varsa)' : m.g_per_unit])) }];
  }));
}
module.exports = { AUX_OPS, load, validate, quantity, postSewingOp, stageEntries, kg, materialNeed, preparations, hints, forTask, context };
