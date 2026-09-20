'use strict';

// Human-reported, cumulative progress. This module never changes panel data.
// A plan is not evidence of production: only explicit reports complete work.
const { expandRoute, buildPlan } = require('./scheduler');

const STATUSES = ['not_started', 'in_progress', 'completed', 'blocked'];

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value + 'T00:00:00Z')) &&
    new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
}

function validateReport(report, jobs, rota) {
  if (!report || !/^[a-zA-Z0-9_-]{1,100}$/.test(report.id || '')) {
    throw new Error('Bildirime benzersiz bir id verilmeli.');
  }
  if (!validDate(report.date)) throw new Error('Geçerli bir bildirim tarihi gerekli.');
  if (!Array.isArray(report.entries) || !report.entries.length) {
    throw new Error('Bildirim en az bir işlem içermeli.');
  }
  const seen = new Set();
  const entries = report.entries.map((entry) => {
    const job = jobs.find((j) => String(j.id) === String(entry.job_id));
    if (!job) throw new Error('Aktif iş bulunamadı: ' + entry.job_id);
    if (!Number.isSafeInteger(job.quantity) || job.quantity <= 0) {
      throw new Error('İşin adedi geçersiz: ' + job.id);
    }
    const operation = expandRoute(rota, job).find((op) => op.id === entry.op_id);
    if (!operation) throw new Error('Bu işte işlem bulunamadı: ' + entry.op_id);
    const key = JSON.stringify([String(job.id), entry.op_id]);
    if (seen.has(key)) throw new Error('Aynı iş ve işlem bir bildirimde iki kez yazılamaz.');
    seen.add(key);
    if (!STATUSES.includes(entry.status)) throw new Error('Geçersiz ilerleme durumu.');
    const amount = entry.completed_quantity;
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > job.quantity) {
      throw new Error('Tamamlanan toplam adet 0 ile işin adedi arasında olmalı.');
    }
    if (entry.status === 'completed' && amount !== job.quantity) {
      throw new Error('Tamamlandı denilen işlemde toplam adet eksik.');
    }
    if (entry.status !== 'completed' && amount === job.quantity) {
      throw new Error('Bütün adetler tamamlandıysa durum completed olmalı.');
    }
    if (entry.status === 'not_started' && amount !== 0) {
      throw new Error('Başlanmadı denilen işlemde tamamlanan adet olamaz.');
    }
    if (typeof entry.note !== 'undefined' && typeof entry.note !== 'string') {
      throw new Error('Açıklama metin olmalı.');
    }
    const note = (entry.note || '').trim();
    if (entry.status === 'blocked' && !note) throw new Error('Bekleme nedeni gerekli.');
    const result = { job_id: job.id, op_id: entry.op_id, status: entry.status,
      completed_quantity: amount, note };
    if (entry.expected_completed_quantity !== undefined) {
      if (!Number.isSafeInteger(entry.expected_completed_quantity) || entry.expected_completed_quantity < 0) {
        throw new Error('Önceki toplam adet geçersiz.');
      }
      result.expected_completed_quantity = entry.expected_completed_quantity;
    }
    return result;
  });
  return { id: report.id, date: report.date, entries };
}

// Date order controls effective progress, insertion order resolves same-day
// updates. Reports contain cumulative totals, never implicitly additive deltas.
function latestEntries(reports, today) {
  if (!validDate(today)) throw new Error('Geçerli plan tarihi gerekli.');
  const latest = new Map();
  reports.map((report, index) => ({ report, index }))
    .filter(({ report }) => report.date <= today)
    .sort((a, b) => a.report.date.localeCompare(b.report.date) || a.index - b.index)
    .forEach(({ report }) => {
      for (const entry of report.entries) {
        latest.set(JSON.stringify([String(entry.job_id), entry.op_id]),
          { ...entry, date: report.date, report_id: report.id });
      }
    });
  return [...latest.values()];
}

function addReport(reports, report, jobs, rota) {
  const normalized = validateReport(report, jobs, rota);
  const existing = reports.find((r) => r.id === normalized.id);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(normalized)) {
      throw new Error('Bu bildirim id farklı içerikle zaten kaydedilmiş.');
    }
    return reports; // Network retries cannot count the same work twice.
  }
  for (const entry of normalized.entries) {
    const history = reports.flatMap((r) => r.entries
      .filter((e) => String(e.job_id) === String(entry.job_id) && e.op_id === entry.op_id)
      .map((e) => ({ ...e, date: r.date })));
    if (history.some((e) => e.date > normalized.date)) {
      throw new Error('Bu işlem için daha yeni bildirim var; geçmişe kayıt eklenemez.');
    }
    if (history.some((e) => e.completed_quantity > entry.completed_quantity)) {
      throw new Error('Tamamlanan toplam adet azaltılamaz; kayıt düzeltmesi gerekir.');
    }
    const job = jobs.find((j) => String(j.id) === String(entry.job_id));
    const previous = latestEntries(reports, normalized.date).find((e) =>
      String(e.job_id) === String(entry.job_id) && e.op_id === entry.op_id);
    if (entry.expected_completed_quantity !== undefined &&
        entry.expected_completed_quantity !== (previous?.completed_quantity || 0)) {
      throw new Error('Taslak hazırlandıktan sonra ilerleme değişti; taslağı yenileyin.');
    }
    if ((job.completed_operations || []).includes(entry.op_id) && entry.status !== 'completed') {
      throw new Error('Panel bu işlemi tamamlanmış gösteriyor; çelişki çözülmeli.');
    }
  }
  return [...reports, normalized];
}

// The language model extracts fields; arithmetic stays here. Ambiguous phrases
// must be clarified before calling this function (today's count vs total count).
function prepareReport(draft, reports, jobs, rota) {
  if (!Array.isArray(draft?.entries)) throw new Error('İşlem listesi gerekli.');
  const latest = latestEntries(reports, draft.date);
  const entries = draft.entries.map((entry) => {
    const previous = latest.find((e) => String(e.job_id) === String(entry.job_id) && e.op_id === entry.op_id);
    const before = previous?.completed_quantity || 0;
    if (!['total', 'increment'].includes(entry.quantity_mode) ||
        !Number.isSafeInteger(entry.quantity) || entry.quantity < 0) {
      throw new Error('Adet ve quantity_mode (total/increment) açıkça belirtilmeli.');
    }
    // An increment requires a known baseline, unless the user explicitly says
    // this is the first production on the operation.
    if (entry.quantity_mode === 'increment' && !previous && entry.first_progress !== true) {
      throw new Error('Önceki tamamlanan toplam bilinmiyor; toplam adedi teyit edin.');
    }
    const total = entry.quantity_mode === 'increment' ? before + entry.quantity : entry.quantity;
    const job = jobs.find((j) => String(j.id) === String(entry.job_id));
    return { job_id: entry.job_id, op_id: entry.op_id,
      status: total === job?.quantity ? 'completed' : entry.status,
      completed_quantity: total, expected_completed_quantity: before, note: entry.note || '' };
  });
  const report = validateReport({ id: draft.id, date: draft.date, entries }, jobs, rota);
  addReport(reports, report, jobs, rota); // Check conflicts before showing a preview.
  return report;
}

function applyProgress(rota, jobs, reports, today) {
  const latest = latestEntries(reports, today);
  const attention = [];
  const rows = [];
  const ready = [];
  for (const job of jobs) {
    const route = expandRoute(rota, job);
    const done = new Set(job.completed_operations || []);
    const remaining = {};
    let held = false;
    for (const entry of latest.filter((e) => String(e.job_id) === String(job.id))) {
      const op = route.find((o) => o.id === entry.op_id);
      // A newer panel stage may supersede old partial progress. Never rewind it.
      if (done.has(entry.op_id)) continue;
      let invalid = !op || !Number.isSafeInteger(entry.completed_quantity) ||
        entry.completed_quantity < 0 || entry.completed_quantity > job.quantity ||
        (entry.status === 'completed' && entry.completed_quantity !== job.quantity);
      if (invalid) {
        held = true;
        attention.push({ job_id: job.id, kind: 'progress_conflict',
          message: 'İş miktarı veya rotası ilerleme kaydıyla çelişiyor; teyit gerekli.' });
        continue;
      }
      remaining[entry.op_id] = job.quantity - entry.completed_quantity;
      if (entry.status === 'completed') done.add(entry.op_id);
      if (entry.status === 'blocked') {
        held = true;
        attention.push({ job_id: job.id, kind: 'progress_blocked', message: entry.note });
      }
      rows.push({ ...entry, job_no: job.job_no || null, customer_name: job.customer_name,
        op_label: op.label, quantity: job.quantity, remaining_quantity: remaining[entry.op_id] });
    }
    // Be conservative: a reported blocked job waits for explicit release. Other
    // jobs can use its sewing capacity; parallel work on the held job is not promised.
    if (!held) ready.push({ ...job, completed_operations: [...done], operation_remaining: remaining });
  }
  return { jobs: ready, progress_rows: rows, needs_attention: attention };
}

function buildProgressPlan(rota, jobs, reports, today) {
  const applied = applyProgress(rota, jobs, reports, today);
  const plan = buildPlan(rota, applied.jobs, today);
  for (const row of plan.today_plan) {
    const progress = applied.progress_rows.find((p) =>
      String(p.job_id) === String(row.job_id) && p.op_id === row.op_id);
    row.progress_date = progress?.date || null;
    row.progress_note = progress?.note || null;
    row.carried_over = !!progress && progress.date < today && progress.remaining_quantity > 0;
  }
  return { ...plan, progress_rows: applied.progress_rows, needs_attention: applied.needs_attention };
}

module.exports = { validateReport, latestEntries, addReport, prepareReport, applyProgress, buildProgressPlan };
