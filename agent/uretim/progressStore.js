'use strict';

// Agent-owned ledger only. Callers supply DATA_DIR/uretim, never the panel file.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { addReport } = require('./progress');

function readReports(directory) {
  const file = path.join(directory, 'progress.json');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const ledger = JSON.parse(text);
  if (ledger.version !== 2 || !Array.isArray(ledger.reports)) {
    throw new Error('İlerleme kaydı okunamadı; boş kayıt varsayılmadı.');
  }
  return ledger.reports;
}

function saveReport(directory, report, jobs, rota) {
  fs.mkdirSync(directory, { recursive: true });
  const lock = path.join(directory, '.progress-lock');
  try { fs.mkdirSync(lock); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('İlerleme kaydı kullanımda; tekrar deneyin.');
    throw error;
  }
  const temp = path.join(directory, '.progress-' + crypto.randomUUID() + '.tmp');
  try {
    const before = readReports(directory);
    const reports = addReport(before, report, jobs, rota);
    if (reports === before) return { saved: false, id: report.id };
    fs.writeFileSync(temp, JSON.stringify({ version: 2, reports }, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, path.join(directory, 'progress.json'));
    return { saved: true, id: report.id };
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
    fs.rmdirSync(lock);
  }
}

module.exports = { readReports, saveReport };
