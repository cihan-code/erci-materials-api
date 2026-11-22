'use strict';
// Order application positions are keys (sol_gogus, sag_kol, kapusan ...). Two readings of them:
//  - areaKey: the area name İşler and the production-form flow use (productionForm.normArea: "sol göğüs", "sırt");
//  - positionLabel / positionText: the Turkish label people read on forms and notes ("Sağ kol", in a sentence "sağ kol").
const { normArea } = require('../productionForm');

const POSITION_LABELS = Object.freeze({ gogus: 'Göğüs', sol_gogus: 'Sol göğüs', sag_gogus: 'Sağ göğüs', kol: 'Kol', sol_kol: 'Sol kol',
  sag_kol: 'Sağ kol', sirt: 'Sırt', ense: 'Ense', kapusan: 'Kapüşon', kapuson: 'Kapüşon', bacak: 'Bacak', sol_bacak: 'Sol bacak', sag_bacak: 'Sağ bacak' });
// The order keys spell the hood two ways; both are the same area.
const KEY_ALIASES = { kapusan: 'kapuson' };

function areaKey(position) {
  const raw = String(position ?? '').trim();
  const key = KEY_ALIASES[raw] || raw;
  return normArea(key.replace(/_/g, ' ').replace(/\s+/g, ' '));
}
const positionLabel = key => (Object.hasOwn(POSITION_LABELS, key) ? POSITION_LABELS[key] : String(key ?? ''));
const positionText = key => (Object.hasOwn(POSITION_LABELS, key) ? POSITION_LABELS[key].toLocaleLowerCase('tr') : String(key ?? ''));
// Notes written before the labels existed carry raw keys; forms show them in words. Longest keys first (sol_gogus before gogus).
const KEY_PATTERN = new RegExp(`(?<![A-Za-z0-9_])(${Object.keys(POSITION_LABELS).filter(k => k.includes('_')).sort((a, b) => b.length - a.length).join('|')})(?![A-Za-z0-9_])`, 'g');
const RAW_TEXT_KEYS = new Set(['sirt', 'gogus', 'kapusan', 'kapuson']);
const WORD_PATTERN = new RegExp(`(?<![A-Za-zÇĞİÖŞÜçğıöşü0-9_])(${[...RAW_TEXT_KEYS].join('|')})(?= için)`, 'g');
function labelRawKeys(text) {
  if (typeof text !== 'string') return text;
  return text.replace(KEY_PATTERN, k => positionText(k)).replace(WORD_PATTERN, k => positionText(k));
}

module.exports = { POSITION_LABELS, areaKey, positionLabel, positionText, labelRawKeys };
