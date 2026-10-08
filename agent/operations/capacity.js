'use strict';
// One workshop, minimum rates. Forecasts are estimates, never completion facts.
const fs = require('fs'), path = require('path');
const core = require('./core');
const positive = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
const rounded = v => Math.round(v * 100) / 100;
const dateOK = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  Number.isFinite(Date.parse(v + 'T00:00:00Z')) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;
function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'capacity.json'), 'utf8'));
  if (cfg.version !== 1 || !positive(cfg.workday?.hours) || !Array.isArray(cfg.workday.closed_weekdays) ||
      cfg.workday.closed_weekdays.length > 6 || cfg.workday.closed_weekdays.some(d => !Number.isInteger(d) || d < 0 || d > 6) ||
      !positive(cfg.sewing?.transition_hours) || cfg.sewing.transition_hours > cfg.workday.hours || !positive(cfg.sewing.boost_factor) || cfg.sewing.boost_factor <= 1 || !Number.isInteger(cfg.sewing.max_forecast_workdays) ||
      cfg.sewing.max_forecast_workdays < 1 || !cfg.cutting || Object.values(cfg.cutting).some(v => !Number.isInteger(v) || v <= 0) || !cfg.products || Object.values(cfg.products).some(p => !p.label || !positive(p.sewing_per_day)))
    throw new Error('Kapasite yapılandırması geçersiz; planı kontrol edin.');
  return cfg;
}
function quantity(value) {
  if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim())) value = Number(value);
  return positive(value) ? value : null;
}
const nextDay = day => new Date(Date.parse(day + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
const closed = (day, cfg) => cfg.workday.closed_weekdays.includes(new Date(day + 'T00:00:00Z').getUTCDay());
function workingDay(day, cfg) { while (closed(day, cfg)) day = nextDay(day); return day; }
function previousSetup(journal, day) {
  // A plan does not prove what the workshop actually sewed yesterday.
  const event = (journal.events || []).filter(e => !e.voided && e.date <= day &&
    e.entries.some(x => x.op === 'sewing' && ['completed', 'partial', 'in_progress'].includes(x.status))).at(-1);
  return { product_type: event?.product_type || null, date: event?.date || null,
    source: event?.product_type ? 'reported_operation' : 'unknown' };
}
function input(record, saved, task, cfg) {
  if (!task || saved.stale || task.type === 'verify') return null;
  const stage = saved.revision?.status || record.status;
  const done = new Set(saved.entries.filter(e => e.status === 'completed').map(e => e.op));
  let station = null, queue = null;
  if (stage === 'Dikimde' && !done.has('sewing')) { station = 'sewing'; queue = 'existing'; }
  else if (task.key === 'sewing_handoff') { station = 'sewing'; queue = 'handoff'; }
  else if ((stage === 'Kumaş Geldi' && task.key === 'cut') || (stage === 'Kesimde' && !done.has('cut'))) station = 'cut';
  if (!station) return null;
  const op = station === 'sewing' ? 'sewing' : 'cut';
  const progress = saved.entries.find(e => e.op === op);
  const remaining = quantity(progress?.remaining) ?? quantity(record.quantity);
  const product = cfg.products[record.product_type];
  const blocked = saved.entries.some(e => ['blocked', 'not_started'].includes(e.status) && e.reason);
  return { station, queue, product_type: product ? record.product_type : '', product_label: product?.label || '',
    quantity: remaining, order_quantity: quantity(record.quantity), delivery_date: dateOK(record.est_delivery) ? record.est_delivery : null,
    daily_minimum: product?.sewing_per_day || null,
    required_hours: product && remaining ? rounded(remaining / (product.sewing_per_day / cfg.workday.hours)) : null,
    required_workdays: product && remaining ? rounded(remaining / product.sewing_per_day) : null,
    blocked, reason: saved.entries.filter(e => e.status !== 'completed' && e.reason).map(e => e.reason).join('; ') };
}
function consume(cursor, hours, cfg, allocations, rate = 0) {
  let days = 0;
  while (hours > 1e-8) {
    if (++days > cfg.sewing.max_forecast_workdays) throw new Error('Tahmin aralığı aşıldı; kapasite hesaplanamadı.');
    if (cursor.used >= cfg.workday.hours - 1e-8) { cursor.day = workingDay(nextDay(cursor.day), cfg); cursor.used = 0; }
    const take = Math.min(hours, cfg.workday.hours - cursor.used);
    if (rate) allocations.set(cursor.day, (allocations.get(cursor.day) || 0) + take * rate);
    cursor.used += take; hours -= take;
  }
}
function schedule(before, facts, cfg, factor = 1) {
  const cursor = { ...before }, allocations = new Map(), transitions = [];
  if (cursor.used >= cfg.workday.hours - 1e-8) { cursor.day = workingDay(nextDay(cursor.day), cfg); cursor.used = 0; }
  if (cursor.product && cursor.product !== facts.product_type) {
    const from = cursor.product, start = { ...cursor };
    consume(cursor, cfg.sewing.transition_hours, cfg, allocations);
    // A setup can straddle midnight; charge only the hours on each day.
    const firstHours = Math.min(cfg.sewing.transition_hours, cfg.workday.hours - start.used);
    transitions.push({ date: start.day, from_type: from, to_type: facts.product_type, hours: rounded(firstHours) });
    if (firstHours < cfg.sewing.transition_hours) transitions.push({ date: cursor.day, from_type: from,
      to_type: facts.product_type, hours: rounded(cfg.sewing.transition_hours - firstHours) });
  }
  const rate = cfg.products[facts.product_type].sewing_per_day / cfg.workday.hours * factor;
  consume(cursor, facts.quantity / rate, cfg, allocations, rate);
  cursor.product = facts.product_type;
  return { cursor, finish: cursor.day, allocations, transitions };
}
function risk(finish, due) { return due ? Math.max(0, Math.round((Date.parse(finish) - Date.parse(due)) / 86400000)) : null; }
const shortDate = d => d.slice(8, 10) + '.' + d.slice(5, 7);
function result(facts, run, today) {
  const today_quantity = rounded(run.allocations.get(today) || 0);
  return { today_quantity, remaining_after_today: rounded(Math.max(0, facts.quantity - today_quantity)),
    estimated_finish: run.finish, risk_days: risk(run.finish, facts.delivery_date) };
}
function description(c) {
  if (c.status === 'unavailable' || c.status === 'blocked') return c.message;
  let text = (c.station === 'sewing' ? 'Bugün dikilecek' : 'Bugün kesilecek') + ' ≈' + c.today_quantity +
    ' adet; kalan ≈' + c.remaining_after_today + ' adet; tahmini ' + (c.station === 'sewing' ? 'dikim' : 'kesim') +
    ' bitiş ' + shortDate(c.estimated_finish) + '.';
  if (c.delivery_date) text += ' Teslim ' + shortDate(c.delivery_date) + ', tahmini bitiş ' + shortDate(c.estimated_finish) +
    (c.risk_days ? ' → ≈' + c.risk_days + ' gün gecikme riski.' : ' → dikim/kesim bitişi teslim tarihini aşmıyor.');
  if (c.boost) text += ' Alternatif: zorlanmış kapasite (+%15), bugün ≈' + c.boost.today_quantity +
    ' adet; tahmini dikim bitiş ' + shortDate(c.boost.estimated_finish) + '. Asgari plan değiştirilmedi.';
  if (c.reason) text += ' ' + c.reason;
  return text;
}
function allocate(prepared, decisions) {
  const cfg = prepared.capacity_config, today = prepared.date, start = workingDay(today, cfg);
  const setup = prepared.sewing_setup || {};
  const map = new Map(decisions.map(d => [String(d.record_id), d]));
  const tasks = prepared.tasks.filter(t => t.capacity_input).map(t => ({ task: t, d: map.get(String(t.record_id)), f: t.capacity_input }));
  for (const { d } of tasks) { d.model_disposition = d.model_disposition || d.disposition; d.disposition = d.model_disposition; }
  const summary = { version: 1, config_hash: core.hash(cfg), workday: cfg.workday, transitions_today: [], notes: [] };
  if (tasks.some(x => x.f.station === 'sewing') && !cfg.products[setup.product_type])
    summary.notes.push('Önceki dikilen ürün bilinmiyor; ilk ürün geçişi süresi hariç tahmin yapıldı.');
  let cursor = { day: start, used: 0, product: cfg.products[setup.product_type] ? setup.product_type : null }, uncertain = false;
  const sewing = tasks.filter(x => x.f.station === 'sewing').sort((a, b) =>
    (a.f.queue === 'handoff') - (b.f.queue === 'handoff') || (a.d.disposition === 'defer') - (b.d.disposition === 'defer') || a.d.priority - b.d.priority);
  for (const { task, d, f } of sewing) {
    const c = { version: 1, station: 'sewing', ...f, status: 'scheduled', today_quantity: null,
      remaining_after_today: null, estimated_finish: null, risk_days: null, boost: null };
    if (!f.product_type || f.quantity == null || f.blocked || uncertain) {
      c.status = f.blocked ? 'blocked' : 'unavailable';
      c.message = f.blocked ? 'Dikim engeli sürüyor; kapasite ve bitiş hesaplanamadı. ' + f.reason
        : !f.product_type ? 'Ürün seçilmemiş, kapasite hesaplanamadı.'
        : f.quantity == null ? 'Adet yok veya geçersiz; kapasite ve bitiş hesaplanamadı.'
        : 'Önceki işin yükü veya engelin çözülme zamanı bilinmiyor; kuyruk kapasitesi ve bitiş hesaplanamadı.';
      uncertain = true;
    } else {
      if (d.disposition === 'defer' && cursor.day === today) { cursor.day = workingDay(nextDay(today), cfg); cursor.used = 0; }
      try {
        const before = { ...cursor }, run = schedule(before, f, cfg);
        Object.assign(c, result(f, run, today)); cursor = run.cursor;
        summary.transitions_today.push(...run.transitions.filter(t => t.date === today));
        if (c.risk_days > 0 || f.delivery_date && f.delivery_date < today) c.boost = {
          label: 'zorlanmış kapasite (+%15)', factor: cfg.sewing.boost_factor,
          ...result(f, schedule(before, f, cfg, cfg.sewing.boost_factor), today) };
      } catch (_) { c.status = 'unavailable'; c.message = 'Tahmin aralığı aşıldı; kapasite hesaplanamadı.'; uncertain = true; }
    }
    c.message = c.message || description(c);
    if (f.reason && !c.message.includes(f.reason)) c.message += ' ' + f.reason;
    d.capacity = c;
    if (c.status !== 'scheduled' || c.today_quantity === 0) d.disposition = 'defer';
    d.action = (f.queue === 'handoff' ? 'Dikim kuyruğuna al. ' : '') + c.message;
  }
  let cutSlots = [], cutDay = start;
  for (const { task, d, f } of tasks.filter(x => x.f.station === 'cut').sort((a, b) => a.d.priority - b.d.priority)) {
    const c = { version: 1, ...f, status: 'scheduled', today_quantity: null, remaining_after_today: null,
      estimated_finish: null, risk_days: null, boost: null };
    const small = f.order_quantity != null && f.order_quantity < cfg.cutting.small_order_below;
    const canJoin = () =>
      (small && cutSlots.every(s => s.small) && cutSlots.length < cfg.cutting.small_orders_per_day) ||
      (!small && cutSlots.every(s => !s.small) && cutSlots.length < cfg.cutting.large_orders_per_day) ||
      ((d.urgent || cutSlots.some(s => s.urgent)) && cutSlots.length < cfg.cutting.urgent_orders_per_day);
    if ((cutDay === today && d.disposition === 'defer') || (cutSlots.length && !canJoin())) { cutDay = workingDay(nextDay(cutDay), cfg); cutSlots = []; }
    cutSlots.push({ small, urgent: !!d.urgent });
    if (!f.product_type || f.quantity == null || f.blocked) {
      c.status = f.blocked ? 'blocked' : 'unavailable';
      c.message = f.blocked ? 'Kesim engeli sürüyor; kapasite hesaplanamadı. ' + f.reason
        : !f.product_type ? 'Ürün seçilmemiş, kapasite hesaplanamadı.' : 'Adet yok veya geçersiz; kesim miktarı hesaplanamadı.';
    } else {
      c.today_quantity = cutDay === today ? f.quantity : 0;
      c.remaining_after_today = rounded(f.quantity - c.today_quantity); c.estimated_finish = cutDay;
      c.risk_days = risk(cutDay, f.delivery_date); c.message = description(c);
      if (cutDay !== today) d.disposition = 'defer';
      if (d.urgent) c.message += ' Acil kesim kapasitesi kullanılıyor (günde en fazla ≈' + cfg.cutting.urgent_orders_per_day + ' sipariş).';
    }
    if (f.reason && !c.message.includes(f.reason)) c.message += ' ' + f.reason;
    if (c.status !== 'scheduled') d.disposition = 'defer';
    d.capacity = c; d.action = c.message;
  }
  summary.transitions_today = summary.transitions_today.map(t => ({ ...t, from_label: cfg.products[t.from_type].label, to_label: cfg.products[t.to_type].label }));
  return { decisions, capacity: summary };
}
module.exports = { loadConfig, quantity, previousSetup, input, schedule, allocate, dateOK };
