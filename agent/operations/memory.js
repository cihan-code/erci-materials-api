'use strict';
const { ISSUES, latest } = require('./core');
// Learn only from explicit, non-retracted observations on distinct records.
// Repeated clicks or repeated reports for one job never increase the sample size.
function learn(journal) {
  const observations = new Map();
  for (const event of journal.events.filter(e => !e.voided)) {
    for (const entry of event.entries) {
      if (!entry.issue || !ISSUES[entry.issue]?.reminder) continue;
      if (!observations.has(entry.issue)) observations.set(entry.issue, new Map());
      observations.get(entry.issue).set(String(event.record_id), {
        record_id: event.record_id, event_id: event.id, date: event.date, evidence: entry.evidence,
      });
    }
  }
  return [...observations].map(([issue, jobs]) => {
    const evidence = [...jobs.values()];
    const decision = journal.rules[issue];
    return { issue, label: ISSUES[issue].label, reminder: ISSUES[issue].reminder,
      samples: evidence.length, evidence,
      status: evidence.length < 3 ? 'observing' : decision?.status || 'suggested',
      decision: decision || null };
  });
}
function reminders(record, deco, entries, knowledge) {
  const candidates = knowledge.filter(k => k.status === 'accepted');
  const done = new Set(entries.filter(e => e.status === 'completed').map(e => e.op));
  return candidates.filter(k => {
    if (record.status === 'Teslim Edildi' || done.has('delivery') || done.has('sewing') || done.has('pack')) return false;
    if (k.issue.startsWith('print')) return ['baski', 'ikisi'].includes(deco) && !done.has('print') && !['Dikimde', 'Ütü-Pakette-Teslimat Bekliyor'].includes(record.status);
    if (k.issue === 'embroidery_file') return ['nakis', 'ikisi'].includes(deco) && !done.has('embroidery') && !['Dikimde', 'Ütü-Pakette-Teslimat Bekliyor'].includes(record.status);
    return true;
  }).map(k => ({ issue: k.issue, message: k.reminder, samples: k.samples }));
}
module.exports = { learn, reminders };
