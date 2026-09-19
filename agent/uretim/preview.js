'use strict';

// Prints the verified production table exactly as the model will receive it.
// No Anthropic call, no cost. Reads DATA_DIR/panel-data.json, or a snapshot file.
//
//   node agent/uretim/preview.js [snapshot.json] [YYYY-MM-DD]

const fs = require('fs');
const path = require('path');
const { buildPlanSignals } = require('./planSignals');

const args = process.argv.slice(2);
const dateArg = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const fileArg = args.find((a) => !/^\d{4}-\d{2}-\d{2}$/.test(a));

const today = dateArg || new Date().toISOString().slice(0, 10);
const file = fileArg ||
  path.join(process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data'), 'panel-data.json');

if (!fs.existsSync(file)) {
  console.error('Panel verisi bulunamadı: ' + file);
  console.error('Kullanım: node agent/uretim/preview.js [snapshot.json] [YYYY-MM-DD]');
  process.exit(2);
}

const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const data = raw.data || raw;
console.log(buildPlanSignals(data, today, { panelUpdatedAt: raw.updatedAt || null }));
