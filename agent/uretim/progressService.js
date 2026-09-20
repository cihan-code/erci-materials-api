'use strict';

const path = require('path');
const crypto = require('crypto');
const store = require('../store');
const { istanbulDay } = require('../lib/util');
const { buildJobsFromPanel } = require('./panelAdapter');
const { expandRoute } = require('./scheduler');
const { prepareReport, latestEntries, applicableChecks, CHECKS, STATUS_LABELS } = require('./progress');
const { readReports, saveReport } = require('./progressStore');
const rota = require('./rota.json');

const directory = () => path.join(store.DATA_DIR, 'uretim');
const today = () => process.env.PANEL_TODAY || istanbulDay(new Date());

function summary(report, jobs) {
  return report.entries.map((entry) => {
    const job = jobs.find((j) => String(j.id) === String(entry.job_id));
    const label = entry.kind === 'check' ? CHECKS.find((c) => c.id === entry.check_id)?.label
      : rota.base_route.find((op) => op.id === entry.op_id)?.label;
    return (job?.job_no || '#' + entry.job_id) + ' · ' + label + ': ' + STATUS_LABELS[entry.status] +
      (entry.note ? ' · ' + entry.note : '');
  }).join('\n');
}

function recordProgress(data, params, dryRun = false) {
  const jobs = buildJobsFromPanel(rota, data).jobs;
  const reports = readReports(directory());
  const date = params.date || today();
  if (date > today()) throw new Error('Gelecekteki üretim gerçekleşmiş olarak kaydedilemez.');
  const id = params.report_id || crypto.createHash('sha256')
    .update(JSON.stringify({ date, entries: params.entries })).digest('hex');
  const existing = reports.find((r) => r.id === id);
  if (existing) return 'Bu bildirim zaten kaydedilmiş.\n' + summary(existing, jobs);
  if (!Array.isArray(params.entries)) throw new Error('İlerleme işlemleri gerekli.');
  const report = prepareReport({ id, date, entries: params.entries }, reports, jobs, rota);
  if (!dryRun) saveReport(directory(), report, jobs, rota);
  return (dryRun ? 'Kaydedilecek ilerleme:\n' : 'İlerleme kaydedildi; sonraki üretim planında kullanılacak.\n') +
    summary(report, jobs);
}

// Supply the model with exact job and operation IDs, not free-text guesses.
function progressContext(data, date) {
  const jobs = buildJobsFromPanel(rota, data).jobs;
  const latest = latestEntries(readReports(directory()), date);
  return JSON.stringify(jobs.map((job) => ({
    job_id: job.id, job_no: job.job_no, customer_name: job.customer_name,
    product: rota.products[job.product].label, order_quantity: job.quantity,
    operations: expandRoute(rota, job).map((op) => ({
      op_id: op.id, label: op.label,
      panel_completed: (job.completed_operations || []).includes(op.id),
      progress: latest.find((e) => String(e.job_id) === String(job.id) && e.op_id === op.id) || null,
    })),
    checks: applicableChecks(rota, job).map((check) => ({
      check_id: check.id, question: check.question,
      status: latest.find((e) => String(e.job_id) === String(job.id) && e.check_id === check.id)?.status || 'unknown',
    })),
  })));
}

module.exports = { recordProgress, progressContext, directory };
