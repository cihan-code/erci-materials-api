'use strict';
// A presentation of existing final decisions. Never selects or edits an action.
const core = require('./core');
const { dateOK } = require('./capacity');
const short = text => text.length > 180 ? text.slice(0, 177).trimEnd() + '…' : text;
function summaryAction(action) { return short(action.split(/;\s*|\.\s+/)[0]); }
function build(snapshot) {
  const plan = snapshot.plan;
  if (!plan || !['ready', 'fallback', 'empty'].includes(plan.status)) return null;
  const records = new Map(snapshot.records.map(r => [String(r.record_id), r]));
  const items = plan.decisions.slice().sort((a, b) => a.priority - b.priority).map(d => {
    const r = records.get(String(d.record_id)), b = r.basis, p = r.planning_basis || {};
    const status = r.revision?.status || b.status;
    const days_late = dateOK(b.est_delivery) ? Math.max(0, Math.round((Date.parse(plan.date) - Date.parse(b.est_delivery)) / 86400000)) : 0;
    const details = [{ label: 'Tam aksiyon', text: d.action }];
    const add = (label, text) => { if (typeof text === 'string' && text.trim()) details.push({ label, text }); };
    add('Üretim notu', p.note); add('Sorun notu', p.problem_note);
    for (const e of r.entries || []) add('Bildirilen ilerleme', core.describe(e));
    add('Bildirim sonrası', r.revision?.action); add('Bildirim notu', r.revision?.note);
    for (const e of r.expectations || []) add('Tarihli beklenti', e.text);
    for (const m of r.reminders || []) add('Üretim hafızası', m.message);
    if (d.recipe) {
      for (const h of d.recipe.hints || []) add('Üretim adımı', h);
      add('Malzeme', d.recipe.materials?.message);
      for (const x of d.recipe.preparations || []) add('Hazırlık teyidi', x.text);
    }
    return { record_id: d.record_id, priority: d.priority, disposition: d.disposition,
      customer: typeof b.customer === 'string' && b.customer.trim() ? b.customer.trim() : '(adsız kayıt)',
      quantity: b.quantity ?? null, status, decoration: b.decoration || '', product_type: p.product_type || '',
      assigned_to: p.assigned_to || '', delivery_date: b.est_delivery || null, days_late,
      follow_up_due: !!p.follow_up_date && p.follow_up_date <= plan.date,
      action: d.action, summary_action: summaryAction(d.action), source: d.source, confidence: d.confidence,
      capacity: d.capacity || null, recipe: d.recipe || null,
      expectations: r.expectations || [], details };
  });
  const capacity = plan.capacity;
  const notices = [...(capacity?.notes || []), ...(capacity?.transitions_today || []).map(t =>
    (t.from_label || t.from_type) + ' → ' + (t.to_label || t.to_type) + ' geçişi, ≈' + t.hours + ' saat')];
  return { version: 1, date: plan.date, state_hash: plan.state_hash, revision: snapshot.revision,
    generated_at: plan.generated_at, source: plan.source,
    summary: { total: items.length, overdue: items.filter(i => i.days_late > 0).length,
      do: items.filter(i => i.disposition === 'do').length, confirm: items.filter(i => i.disposition === 'confirm').length,
      defer: items.filter(i => i.disposition === 'defer').length }, notices, items };
}
module.exports = { build, summaryAction };
