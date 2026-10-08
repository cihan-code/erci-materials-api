'use strict';

// Production facts never come from a suggested plan. The service synchronizes
// validated revisions to the commercial kanban; this core only computes facts
// solely from validated reports. Remaining counts are cumulative snapshots, not deltas.
const crypto = require('crypto');
const OPS = {
  fabric: 'Kumaş hazırlığı', cut: 'Kesim', print_dropoff: 'Baskıya sevk',
  print: 'Baskı', embroidery_dropoff: 'Nakışa sevk', embroidery: 'Nakış',
  sewing: 'Dikim', pack: 'Ütü / paket', delivery: 'Teslimat',
};
const ISSUES = {
  print_paper: { label: 'Baskı kâğıdı eksikliği', reminder: 'Baskıya sevkten önce tüm ürünlerin baskı kâğıtlarını sayıp teyit et.', ops: ['print', 'print_dropoff'] },
  print_file: { label: 'Baskı dosyası eksikliği', reminder: 'Baskıya sevkten önce dosyanın baskıcıya ulaştığını teyit et.', ops: ['print', 'print_dropoff'] },
  embroidery_file: { label: 'Nakış dosyası eksikliği', reminder: 'Nakışa sevkten önce dosyanın nakışçıya ulaştığını teyit et.', ops: ['embroidery', 'embroidery_dropoff'] },
  material: { label: 'Malzeme eksikliği', reminder: 'İşe başlamadan önce kumaş ve yardımcı malzemeleri teyit et.', ops: ['fabric', 'cut', 'sewing'] },
  supplier: { label: 'Atölye / tedarikçi beklemesi', reminder: 'Sevkten önce atölyenin teslim alma ve bitirme zamanını teyit et.', ops: ['print', 'embroidery', 'sewing'] },
  other: { label: 'Diğer engel', reminder: '', ops: [] },
};
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function decoration(record, jobs = []) {
  if (['baski', 'nakis', 'ikisi', 'yok'].includes(record.decoration)) return record.decoration;
  const items = jobs.find(j => record.job_id != null && String(j.id) === String(record.job_id))?.baski_nakis_secim?.items || [];
  const p = items.some(i => i.type === 'baski'), e = items.some(i => i.type === 'nakis');
  return p && e ? 'ikisi' : p ? 'baski' : e ? 'nakis' : '';
}
function fingerprint(record, jobs) {
  const fields = [record.id, record.customer_name, record.quantity, record.status, decoration(record, jobs), record.est_delivery];
  if (record.product_type) fields.push(record.product_type); // preserve old untyped fingerprints
  return hash(fields);
}
function validateEntries(entries, record, text) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 9) throw new Error('İşlem anlaşılamadı; yapılan işlemi açıkça yazın.');
  const seen = new Set();
  return entries.map(e => {
    if (!e || !OPS[e.op] || seen.has(e.op)) throw new Error('Bildirimin işlem eşleşmesi belirsiz.');
    seen.add(e.op);
    if (!['completed', 'partial', 'in_progress', 'blocked', 'not_started'].includes(e.status)) throw new Error('İşlem durumu geçersiz.');
    if (typeof e.evidence !== 'string' || !e.evidence.trim() || !text.includes(e.evidence)) throw new Error('Bildirimde işlem kanıtı bulunamadı.');
    if (typeof e.reason !== 'string' || e.reason.length > 400 || (e.reason && !text.includes(e.reason))) throw new Error('Engel nedeni bildirimden alınmalı.');
    if (e.issue !== null && !ISSUES[e.issue]) throw new Error('Engel sınıfı geçersiz.');
    if (e.status === 'blocked' && !e.reason) throw new Error('Bekleme nedeni belirtilmeli.');
    // Counts are optional information, never a reason to reject an operation.
    const remaining = e.status === 'partial' && Number.isInteger(e.remaining) && e.remaining > 0 ? e.remaining : null;
    if (e.issue && (!e.reason || !['partial', 'blocked', 'not_started'].includes(e.status))) throw new Error('Engel gözlemi için açık neden gerekli.');
    if (e.issue && ISSUES[e.issue].ops.length && !ISSUES[e.issue].ops.includes(e.op)) throw new Error('Engel sınıfı bildirilen işleme uymuyor.');
    return { op: e.op, status: e.status, remaining, reason: e.reason, issue: e.issue, evidence: e.evidence };
  });
}
function latest(events, recordId) {
  const map = new Map();
  for (const event of events.filter(e => String(e.record_id) === String(recordId) && !e.voided)) {
    for (const entry of event.entries) map.set(entry.op, { ...entry, date: event.date, event_id: event.id });
  }
  return [...map.values()];
}
const STATUS = { completed: 'Tamamlandı', partial: 'Kısmen tamamlandı', in_progress: 'Devam ediyor', blocked: 'Engel var', not_started: 'Başlanmadı' };
function describe(entry) {
  return OPS[entry.op] + ': ' + STATUS[entry.status] + (entry.remaining != null ? ' — ' + entry.remaining + ' adet kaldı' : '') + (entry.reason ? ' · ' + entry.reason : '');
}
function partialAction(entry) {
  return OPS[entry.op] + (Number.isInteger(entry.remaining) && entry.remaining > 0
    ? ': kalan ' + entry.remaining + ' adedi tamamla' : ': kalanı tamamla');
}
const ACTIVE_STAGES = {
  fabric: 'Kumaş Geldi', cut: 'Kesimde', print_dropoff: 'Baskı/Nakışta',
  print: 'Baskı/Nakışta', embroidery_dropoff: 'Baskı/Nakışta', embroidery: 'Baskı/Nakışta',
  sewing: 'Dikimde', pack: 'Ütü-Pakette-Teslimat Bekliyor', delivery: 'Ütü-Pakette-Teslimat Bekliyor',
};
const STAGE_ORDER = ['Kumaş Geldi', 'Kesimde', 'Baskı/Nakışta', 'Dikimde', 'Ütü-Pakette-Teslimat Bekliyor'];
function revision(record, entries, deco) {
  if (!entries.length) return null;
  const incomplete = entries.filter(e => e.status !== 'completed');
  const active = incomplete.filter(e => ['partial', 'in_progress'].includes(e.status));
  const stage = active.map(e => ACTIVE_STAGES[e.op]).sort((a, b) => STAGE_ORDER.indexOf(a) - STAGE_ORDER.indexOf(b))[0];
  if (incomplete.length) return {
    status: stage || record.status, section: 'Gün içi revizyon', hold: true,
    action: incomplete.map(e => e.status === 'partial' ? partialAction(e) : describe(e)).join('; '),
    note: incomplete.map(e => e.reason).filter(Boolean).join('; '),
  };
  const done = new Set(entries.map(e => e.op));
  if (done.has('delivery')) return { status: 'Teslim Edildi', section: 'Tamamlanan', hold: false, action: 'Teslimat tamamlandı.', note: '' };
  if (done.has('pack')) return { status: 'Ütü-Pakette-Teslimat Bekliyor', section: 'Ütü / Paket / Teslimat', hold: false, action: 'Ütü / paket tamamlandı; teslimatı planla.', note: '' };
  if (done.has('sewing')) return { status: 'Ütü-Pakette-Teslimat Bekliyor', section: 'Ütü / Paket / Teslimat', hold: false, action: 'Dikim tamamlandı; ütü / paket yap.', note: '' };
  if (done.has('print') || done.has('embroidery')) {
    const ready = deco === 'baski' ? done.has('print') : deco === 'nakis' ? done.has('embroidery') : deco === 'ikisi' ? done.has('print') && done.has('embroidery') : false;
    return { status: 'Baskı/Nakışta', section: 'Baskı / Nakış', hold: !ready,
      action: ready ? 'Baskı/nakış tamamlandı; dikime götür.' : 'Bildirilen işlem tamamlandı; diğer baskı/nakış işlemlerini teyit et.', note: '' };
  }
  if (done.has('print_dropoff') || done.has('embroidery_dropoff')) return { status: 'Baskı/Nakışta', section: 'Baskı / Nakış', hold: true,
    action: 'Sevk tamamlandı; ' + (done.has('print_dropoff') ? 'baskının' : 'nakışın') + ' tamamlandığını teyit et.', note: '' };
  if (done.has('cut')) return { status: 'Kesimde', section: 'Kesim', hold: true,
    action: 'Kesim tamamlandı; ' + ({ baski: 'baskıya götür.', nakis: 'nakışa götür.', ikisi: 'ilgili parçaları baskıya ve nakışa götür.', yok: 'dikime götür.' }[deco] || 'baskı/nakış rotasını teyit et.'), note: '' };
  return { status: 'Kumaş Geldi', section: 'Kesim', hold: false, action: 'Kumaş hazır; kesimi planla.', note: '' };
}
module.exports = { OPS, ISSUES, STATUS, hash, decoration, fingerprint, validateEntries, latest, describe, partialAction, revision };
