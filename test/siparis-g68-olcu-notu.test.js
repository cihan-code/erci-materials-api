'use strict';
// G68: Turkish position words in measurement notes on the forms. Invented data.
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

test('ölçü notu konumu Türkçe yazar; eski kayıtlardaki ham anahtar formda sözcüğe çevrilir', () => {
  const table = standards.load(fs.mkdtempSync(path.join(os.tmpdir(), 'g68-std-')));
  const measured = (w, h) => ({ width_mm: w, height_mm: h, needs_confirmation: false, reasons: [], measure_source: { method: 'otomatik', views: [{ page: 1, view: 'on' }] } });
  const wide = decide(measured(150, 50), { position: 'sol_gogus', product: 'tisort', standards: table });
  assert.match(wide.measure_source.olcuNotu, /sol göğüs için olağan aralığın/);
  assert.doesNotMatch(formNote(wide.measure_source), /sol_gogus/);
  const back = decide(measured(420, 300), { position: 'sirt', product: 'sweat', standards: table });
  assert.match(back.measure_source.olcuNotu, /sırt için/);
  assert.equal(areas.labelRawKeys('Yaklaşık ölçü: Ölçülen en 19 cm, sag_kol için olağan aralığın (3–11 cm) dışında. · sirt için standart'),
    'Yaklaşık ölçü: Ölçülen en 19 cm, sağ kol için olağan aralığın (3–11 cm) dışında. · sırt için standart');
  assert.equal(areas.labelRawKeys('sirtlik deseni'), 'sirtlik deseni', 'only whole keys');
});
