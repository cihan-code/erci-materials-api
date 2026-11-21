'use strict';
// G58: one front/back decision per product picture. Invented boxes and records only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyViewHint } = require('../agent/siparis/autoMeasure');
const { garmentCrop, frontSide, imageViewHint } = require('../agent/siparis/documents');

// Index 0 is drawn on the right, as the scanner may order them.
const refs = () => [{ box: { x: 780, y: 60, w: 560, h: 960 } }, { box: { x: 160, y: 60, w: 560, h: 960 } }];
const open = () => [{ view: 'teyit' }, { view: 'teyit' }];

test('G58 a hint from another print settles an undecided pair by place on the sheet, not by scan order', () => {
  const cues = open();
  applyViewHint(refs(), cues, { front: 'sol', source: 'baska_baski' });
  assert.deepEqual(cues.map(c => c.view), ['arka', 'on']);
  assert.ok(cues.every(c => c.viewSource === 'baska_baski' && c.pairVotes.at(-1).includes('2. ürün ön')));
  const right = open();
  applyViewHint(refs(), right, { front: 'sag', source: 'baska_baski' });
  assert.deepEqual(right.map(c => c.view), ['on', 'arka']);
});

test('G58 a handed-on hint never overrides: agreement is kept, a contradiction becomes one open question', () => {
  const agree = [{ view: 'arka' }, { view: 'on' }];
  applyViewHint(refs(), agree, { front: 'sol', source: 'baska_baski' });
  assert.deepEqual(agree.map(c => c.view), ['arka', 'on']);
  assert.ok(agree.every(c => !c.viewConflict));
  const against = [{ view: 'on' }, { view: 'arka' }];
  applyViewHint(refs(), against, { front: 'sol', source: 'baska_baski' });
  assert.deepEqual(against.map(c => c.view), ['teyit', 'teyit']);
  assert.match(against[0].viewConflict, /1\. ürünü.*2\. ürünü ön buldu/);
  // Its own conflicting cues stay open too.
  const conflicted = [{ view: 'teyit', viewConflict: 'etiket ve yaka çelişiyor' }, { view: 'teyit', viewConflict: 'etiket ve yaka çelişiyor' }];
  applyViewHint(refs(), conflicted, { front: 'sol', source: 'baska_baski' });
  assert.deepEqual(conflicted.map(c => c.view), ['teyit', 'teyit']);
  const split = open();
  applyViewHint(refs(), split, { conflict: 'baskılar çelişiyor' });
  assert.ok(split.every(c => c.view === 'teyit' && c.viewConflict === 'baskılar çelişiyor'));
});

test('G58 the user answer wins over the picture cues; an axis the garments do not separate on is ignored', () => {
  const cues = [{ view: 'on' }, { view: 'arka', viewConflict: 'x' }];
  applyViewHint(refs(), cues, { front: 'sol', source: 'kullanici' });
  assert.deepEqual(cues.map(c => c.view), ['arka', 'on']);
  assert.ok(cues.every(c => !c.viewConflict && c.viewSource === 'kullanici'));
  const sideBySide = open();
  applyViewHint(refs(), sideBySide, { front: 'ust', source: 'kullanici' });
  assert.deepEqual(sideBySide.map(c => c.view), ['teyit', 'teyit']);
  const single = [{ view: 'teyit' }];
  applyViewHint([refs()[0]], single, { front: 'sol', source: 'kullanici' });
  assert.equal(single[0].view, 'teyit');
});

const views = (left, right) => [
  { page: 1, index: 0, view: right, productBoxPx: { x: 742, y: 123, w: 732, h: 873 } },
  { page: 1, index: 1, view: left, productBoxPx: { x: 18, y: 124, w: 724, h: 871 } }];
const SHA = 'a'.repeat(64), OTHER = 'b'.repeat(64);
function version(apps) {
  return { files: [{ id: 1, kind: 'urun_gorsel', sha256: SHA }, { id: 2, kind: 'urun_gorsel', sha256: SHA }, { id: 3, kind: 'urun_gorsel', sha256: OTHER }],
    lines: [{ applications: apps.map((s, i) => ({ id: i + 1, measure_source: JSON.stringify({ method: 'otomatik', selectedPage: 1, rasterWidth: 1491, rasterHeight: 1055, ...s }) })) }] };
}

test('G58 frontSide names where the front garment sits; undecided or partial pairs give null', () => {
  assert.equal(frontSide(views('on', 'arka')), 'sol');
  assert.equal(frontSide(views('arka', 'on')), 'sag');
  assert.equal(frontSide(views('teyit', 'teyit')), null);
  assert.equal(frontSide([{ page: 1, view: 'on', productBoxPx: { x: 0, y: 0, w: 10, h: 10 } }, { page: 1, view: 'arka', productBoxPx: { x: 0, y: 30, w: 10, h: 10 } }]), 'ust');
});

test('G58 imageViewHint: the same bytes uploaded twice share one answer; its own record, handed-on answers and other pictures do not count', () => {
  const v = version([{ gorselFileId: 1, views: views('on', 'arka') }, { gorselFileId: 2, views: views('teyit', 'teyit') }]);
  const image = { id: 2, sha256: SHA };
  assert.deepEqual(imageViewHint(null, v, image, 2), { front: 'sol', source: 'baska_baski' });
  assert.equal(imageViewHint(null, v, image, 1), null);
  assert.equal(imageViewHint(null, v, { id: 3, sha256: OTHER }, 9), null);
  const handedOn = version([{ gorselFileId: 1, views: views('on', 'arka').map(g => ({ ...g, viewEvidence: { viewSource: 'baska_baski' } })) }]);
  assert.equal(imageViewHint(null, handedOn, image, 2), null);
  const disagree = version([{ gorselFileId: 1, views: views('on', 'arka') }, { gorselFileId: 2, views: views('arka', 'on') }]);
  assert.match(imageViewHint(null, disagree, image, 3).conflict, /önü farklı üründe/);
});

test('G58 form crop reads every upload of the same picture, so ÖN and ARKA are cut alike', () => {
  const apps = version([{ gorselFileId: 1, views: views('on', 'arka') }, { gorselFileId: 2, views: views('on', 'arka') }]).lines[0].applications;
  const front = garmentCrop(apps, new Set([1, 2]), 'on'), back = garmentCrop(apps, new Set([1, 2]), 'arka');
  assert.ok(front && back);
  assert.ok(front.x + front.w <= 742 && back.x >= 742);
  // One upload still undecided means the picture's answer is not settled: whole picture.
  const mixed = version([{ gorselFileId: 1, views: views('on', 'arka') }, { gorselFileId: 2, views: views('teyit', 'teyit') }]).lines[0].applications;
  assert.equal(garmentCrop(mixed, new Set([1, 2]), 'arka'), null);
  // A single id keeps the old behaviour.
  assert.ok(garmentCrop(mixed, 1, 'on'));
});
