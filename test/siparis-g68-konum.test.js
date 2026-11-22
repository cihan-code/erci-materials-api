'use strict';
// G68: area names in İşler and cost (order keys become flow area names). Invented data.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const areas = require('../agent/siparis/areas');
const standards = require('../agent/siparis/konumStandartlari');
const { decide, formNote } = require('../agent/siparis/olcuKarar');
const cost = require('../agent/siparis/costTransfer');
const sizes = require('../agent/siparis/boyutEsleme');

test('konum anahtarları İşler/maliyet akışının bölge adına çevrilir; ham anahtar kalmaz', () => {
  assert.deepEqual(['sol_gogus', 'sag_gogus', 'gogus', 'sol_kol', 'sag_kol', 'kol', 'sirt', 'ense', 'kapusan', 'kapuson'].map(areas.areaKey),
    ['sol göğüs', 'sağ göğüs', 'göğüs', 'sol kol', 'sağ kol', 'kol', 'sırt', 'ense', 'kapüşon', 'kapüşon']);
  assert.equal(areas.areaKey('sol göğüs'), 'sol göğüs', 'already a name: unchanged');
  const lines = [{ quantity: 10, applications: [{ kind: 'baski', position: 'sol_gogus' }, { kind: 'baski', position: 'sirt' }, { kind: 'nakis', position: 'sag_kol' }] }];
  assert.deepEqual(cost.applicationUnits(lines).map(a => a.area), ['sol göğüs', 'sırt', 'sağ kol']);
  const derived = sizes.derive([], lines, {});
  assert.deepEqual(derived.apps.map(a => a.konum), ['sol göğüs', 'sırt', 'sağ kol']);
});
