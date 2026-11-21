'use strict';

// Source-backed centimetres only. Never derive sizes from the L reference.
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const SOURCE_TYPES = ['excel', 'resim', 'elle'];
function validSizeChart(chart) {
  return object(chart) && chart.birim === 'cm' && (chart.kaynakTuru == null || SOURCE_TYPES.includes(chart.kaynakTuru)) && typeof chart.kaynak === 'string' && !!chart.kaynak.trim() &&
    object(chart.bedenler) && Object.keys(chart.bedenler).length > 0 &&
    Object.entries(chart.bedenler).every(([size, values]) => size.trim() && size.length <= 24 && object(values) &&
      Object.keys(values).length > 0 && Object.entries(values).every(([key, value]) =>
        /^[a-z][a-z0-9_]*$/.test(key) && Number.isFinite(value) && value > 0));
}
function bodyRows(chart) {
  if (!validSizeChart(chart)) return [];
  return Object.entries(chart.bedenler).filter(([, v]) => v.boy > 0 && v.gogus > 0);
}
// Priority of a stored chart: Excel (3) > picture (2); hand-entered (4) is never replaced.
// Charts written before G66 carry no kaynakTuru: those with a picture hash came from the
// picture tables, anything else was typed by hand.
const sourceType = chart => chart?.kaynakTuru ?? (typeof chart?.sha256 === 'string' ? 'resim' : 'elle');
const sourceRank = chart => ({ excel: 3, resim: 2 })[sourceType(chart)] ?? 4;
// Single entry point for measurement code: one size of a chart -> measurement points in
// whole millimetres plus where they came from. Returns null for unknown sizes.
function chartMeasurements(chart, size) {
  if (!validSizeChart(chart) || typeof size !== 'string') return null;
  const want = size.trim().toLocaleUpperCase('tr-TR');
  const found = Object.keys(chart.bedenler).find(s => s.trim().toLocaleUpperCase('tr-TR') === want);
  if (!found) return null;
  const olculerMm = Object.fromEntries(Object.entries(chart.bedenler[found]).map(([k, v]) => [k, Math.round(v * 10)]));
  return { beden: found, olculerMm, kaynak: chart.kaynak, kaynakTuru: sourceType(chart),
    hucreler: chart.hucreler?.[found] ?? null, gogusTuru: chart.gogusTuru ?? 'belirsiz' };
}
module.exports = { validSizeChart, bodyRows, sourceRank, chartMeasurements };
