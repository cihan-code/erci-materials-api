'use strict';
// G61/G66: the measurement reads pattern points from one place. Invented values.
const test = require('node:test');
const assert = require('node:assert/strict');
const { points } = require('../agent/siparis/olcuNoktalari');

test('G61 the L list is read as before; another size or a missing L gives nothing', () => {
  const flat = { refBeden: 'L', olculerL: { omuzdan_boy: 112.2, etek: 60, bos: 0 } };
  assert.deepEqual(points(flat), { beden: 'L', cm: { omuzdan_boy: 112.2, etek: 60 }, mm: { omuzdan_boy: 1122, etek: 600 } });
  assert.deepEqual(points({ ...flat, refBeden: 'M' }).cm, {});
  assert.deepEqual(points({ ...flat, refBeden: 'M' }, { requireL: false }).cm.etek, 60);
  assert.deepEqual(points(flat, { size: 'M' }).cm, {});
});

test('G61 points resolved from the pattern tables (G66 shape) take precedence and keep the cm values exact', () => {
  const flat = { refBeden: 'L', olculerL: { etek: 50 }, olcuNoktalari: { beden: 'L', olculerMm: { omuzdan_boy: 1122, etek: 600, kol_boyu: 640 } } };
  const p = points(flat);
  assert.deepEqual(p.cm, { omuzdan_boy: 112.2, etek: 60, kol_boyu: 64 });
  assert.equal(p.mm.kol_boyu, 640);
  assert.deepEqual(points({ ...flat, olcuNoktalari: { beden: 'M', olculerMm: { etek: 580 } } }).cm, {});
});
