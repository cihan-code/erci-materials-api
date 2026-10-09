'use strict';
// Dated expectations from reports ("kalanı pazartesi bitecek", "Salı teslim edilmesi
// gerekiyor"). The model copies the day words; this module turns them into dates, so
// no date is ever invented. Invalid or undated items are dropped and never block a report.
const MAX_DAYS = 90;
const WEEKDAYS = ['pazar', 'pazartesi', 'salı', 'çarşamba', 'perşembe', 'cuma', 'cumartesi'];
const MONTHS = ['ocak', 'şubat', 'mart', 'nisan', 'mayıs', 'haziran', 'temmuz', 'ağustos', 'eylül', 'ekim', 'kasım', 'aralık'];
const lower = s => String(s).toLocaleLowerCase('tr-TR');
const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const iso = (y, m, d) => {
  const value = new Date(Date.UTC(y, m - 1, d));
  return value.getUTCFullYear() === y && value.getUTCMonth() === m - 1 && value.getUTCDate() === d ? value.toISOString().slice(0, 10) : null;
};
function explicitDate(text, day) {
  const year = Number(day.slice(0, 4));
  let m = text.match(/(?<!\d)(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?!\d)/), d, mo, y;
  if (m) { d = +m[1]; mo = +m[2]; y = m[3] ? +(m[3].length === 2 ? '20' + m[3] : m[3]) : null; }
  else {
    m = text.match(new RegExp('(?<!\\d)(\\d{1,2})\\s+(' + MONTHS.join('|') + ')'));
    if (!m) return undefined;
    d = +m[1]; mo = MONTHS.indexOf(m[2]) + 1; y = null;
  }
  let date = iso(y || year, mo, d);
  if (date && !y && date < day) date = iso(year + 1, mo, d);
  return date || undefined; // "17.30" is a time, not a date: fall back to the day words
}
// Resolve the copied day words against the report's Istanbul day.
function resolve(when, day) {
  const text = lower(when).trim();
  if (!text) return null;
  let date = explicitDate(text, day);
  if (date === undefined) {
    if (/\bbugün\b/u.test(text)) date = day;
    else if (/öbür gün|yarından sonra/u.test(text)) date = addDays(day, 2);
    else if (/yarın/u.test(text)) date = addDays(day, 1);
    else {
      const index = WEEKDAYS.map((w, i) => [w, i]).sort((a, b) => b[0].length - a[0].length).find(([w]) => text.includes(w))?.[1];
      if (index === undefined) return null;
      const today = new Date(day + 'T00:00:00Z').getUTCDay();
      date = addDays(day, (index - today + 7) % 7 + (/haftaya|gelecek hafta|önümüzdeki hafta/u.test(text) ? 7 : 0));
    }
  }
  if (!date || date < day || date > addDays(day, MAX_DAYS)) return null;
  return date;
}
function validate(list, text, day, ops) {
  if (!Array.isArray(list)) return [];
  const byOp = new Map();
  for (const x of list) {
    if (!x || !ops[x.op] || typeof x.when !== 'string' || typeof x.evidence !== 'string') continue;
    const evidence = x.evidence.trim(), when = x.when.trim();
    if (!evidence || !when || !text.includes(evidence) || !lower(evidence).includes(lower(when))) continue;
    const date = resolve(when, day);
    if (!date) continue;
    // One expectation per operation: the latest stated day wins.
    if (!byOp.has(x.op) || byOp.get(x.op).date <= date) byOp.set(x.op, { op: x.op, when, date, evidence });
  }
  return [...byOp.values()];
}
const STAGE_ORDER = ['Kumaş Bekleniyor', 'Kumaş Geldi', 'Kesimde', 'Baskı/Nakışta', 'Dikimde', 'Ütü-Pakette-Teslimat Bekliyor', 'Teslim Edildi'];
const OP_STAGE = { fabric: 'Kumaş Geldi', cut: 'Kesimde', print_dropoff: 'Baskı/Nakışta', print: 'Baskı/Nakışta',
  embroidery_dropoff: 'Baskı/Nakışta', embroidery: 'Baskı/Nakışta', sewing: 'Dikimde', pack: 'Ütü-Pakette-Teslimat Bekliyor' };
const short = date => date.slice(8, 10) + '.' + date.slice(5, 7);
// Open reminders for one record: latest expectation per operation, closed by a completed
// report of that operation (same or later event) or by the kanban moving past its stage.
function open(record, events, today, ops) {
  if (record.status === 'Teslim Edildi') return [];
  const active = events.filter(e => String(e.record_id) === String(record.id) && !e.voided);
  const latest = new Map();
  active.forEach((e, index) => {
    for (const x of e.expectations || []) if (x.op !== 'delivery') latest.set(x.op, { ...x, index, event_id: e.id, report_date: e.date });
  });
  return [...latest.values()].filter(x => {
    if (active.slice(x.index).some(e => e.entries.some(en => en.op === x.op && en.status === 'completed'))) return false;
    const stage = OP_STAGE[x.op];
    return !stage || STAGE_ORDER.indexOf(record.status) <= STAGE_ORDER.indexOf(stage);
  }).sort((a, b) => a.date.localeCompare(b.date) || a.op.localeCompare(b.op)).map(x => {
    const status = x.date > today ? 'upcoming' : x.date === today ? 'due' : 'overdue';
    const source = '“' + x.evidence + '” (' + short(x.report_date) + ' bildirimi)';
    const text = status === 'upcoming' ? 'Beklenen: ' + ops[x.op] + ' ' + short(x.date) + ' — ' + source + '.'
      : status === 'due' ? 'Bugün bekleniyor: ' + ops[x.op] + ' — ' + source + '.'
      : ops[x.op] + ' ' + short(x.date) + ' tarihinde bitecekti; durumu teyit et — ' + source + '.';
    return { op: x.op, label: ops[x.op], date: x.date, when: x.when, evidence: x.evidence, event_id: x.event_id,
      report_date: x.report_date, status, text };
  });
}
module.exports = { resolve, validate, open };
