'use strict';

// Source-backed centimetres only. Never derive sizes from the L reference.
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function validSizeChart(chart) {
  return object(chart) && chart.birim === 'cm' && typeof chart.kaynak === 'string' && !!chart.kaynak.trim() &&
    object(chart.bedenler) && Object.keys(chart.bedenler).length > 0 &&
    Object.entries(chart.bedenler).every(([size, values]) => size.trim() && size.length <= 24 && object(values) &&
      Object.keys(values).length > 0 && Object.entries(values).every(([key, value]) =>
        /^[a-z][a-z0-9_]*$/.test(key) && Number.isFinite(value) && value > 0));
}
function bodyRows(chart) {
  if (!validSizeChart(chart)) return [];
  return Object.entries(chart.bedenler).filter(([, v]) => v.boy > 0 && v.gogus > 0);
}
module.exports = { validSizeChart, bodyRows };
