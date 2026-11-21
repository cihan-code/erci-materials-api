'use strict';
// G61: the one place where measurement reads a pattern's body points (pattern + size ->
// points). Today they come from the flat's L list (olculerL, cm); G66 replaces the source
// (pattern Excel tables, more points such as shoulder or sleeve width) here only.
// No database or filesystem access: this module also runs in the render worker.
const positive = n => Number.isFinite(n) && n > 0;

/**
 * points(flat, {size, requireL}) -> {beden, cm, mm}. cm keeps the stored values exactly
 * (the scale arithmetic uses them as before); mm is the same in millimetres.
 * requireL=false reads the list whatever size the record states (flat drawing calibration).
 */
function points(flat, { size = 'L', requireL = true } = {}) {
  const list = flat?.olculerL && typeof flat.olculerL === 'object' && !Array.isArray(flat.olculerL) ? flat.olculerL : null;
  if (!list || size !== 'L' || (requireL && flat.refBeden !== 'L')) return { beden: null, cm: {}, mm: {} };
  const cm = {}, mm = {};
  for (const [key, value] of Object.entries(list)) if (positive(value)) { cm[key] = value; mm[key] = Math.round(value * 100) / 10; }
  return { beden: 'L', cm, mm };
}
module.exports = { points };
