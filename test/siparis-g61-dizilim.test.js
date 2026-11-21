'use strict';
// G61 rule 1: two garments with no evidence and no answer are read front-left (stacked: front-top).
// Invented geometry and mockups only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyViewHint, defaultViewHint, autoMeasure } = require('../agent/siparis/autoMeasure');
const { imageViewHint } = require('../agent/siparis/documents');
const { multiMockup } = require('./fixtures/siparis/oto-multi');

const ref = (x, y) => ({ box: { x, y, w: 100, h: 120 } });
const cues = (...views) => views.map(view => ({ view }));

test('G61 side by side the left garment is the default front, stacked the top one', () => {
  const pair = [ref(400, 10), ref(20, 10)];
  assert.deepEqual(defaultViewHint(pair), { front: 'sol', source: 'varsayilan' });
  const c = cues('teyit', 'teyit');
  applyViewHint(pair, c, defaultViewHint(pair));
  assert.deepEqual(c.map(x => x.view), ['arka', 'on']);
  assert.ok(c.every(x => x.viewSource === 'varsayilan' && /varsayılan dizilim/.test(x.pairVotes.at(-1))));
  const stacked = [ref(20, 300), ref(30, 10)], s = cues('teyit', 'teyit');
  assert.equal(defaultViewHint(stacked).front, 'ust');
  applyViewHint(stacked, s, defaultViewHint(stacked));
  assert.deepEqual(s.map(x => x.view), ['arka', 'on']);
  assert.equal(defaultViewHint([ref(0, 0)]), null);
});

test('G61 evidence and answers win over the default; a conflict falls back to it and stays a note', () => {
  const pair = [ref(20, 10), ref(400, 10)];
  // The existing vote put the front on the right: the default does not touch it.
  const decided = cues('arka', 'on');
  applyViewHint(pair, decided, defaultViewHint(pair));
  assert.deepEqual(decided.map(x => x.view), ['arka', 'on']);
  assert.ok(decided.every(x => x.viewSource === undefined));
  // The user's answer (right is front) is applied first and stays.
  const answered = cues('teyit', 'teyit');
  applyViewHint(pair, answered, { front: 'sag', source: 'kullanici' });
  applyViewHint(pair, answered, defaultViewHint(pair));
  assert.deepEqual(answered.map(x => x.view), ['arka', 'on']);
  assert.ok(answered.every(x => x.viewSource === 'kullanici'));
  // Conflicting cues: no longer a confirmation by themselves.
  const conflict = [{ view: 'teyit', viewConflict: 'yaka ve kapüşon çelişiyor' }, { view: 'teyit', viewConflict: 'yaka ve kapüşon çelişiyor' }];
  applyViewHint(pair, conflict, defaultViewHint(pair));
  assert.deepEqual(conflict.map(x => x.view), ['on', 'arka']);
  assert.ok(conflict.every(x => !x.viewConflict && x.viewConflictNote === 'yaka ve kapüşon çelişiyor'));
});

test('G61 the measurement uses the default only when asked (documents asks; direct calls keep G58)', async () => {
  const image = { buffer: multiMockup({ ambiguous: true }).image, mime: 'image/png', gorunum: 'arka' };
  const flat = { id: 'f', refBeden: 'L', olculerL: { omuzdan_boy: 71, etek: 52, gogus: 61, tum_omuz: 61.5 } };
  const plain = await autoMeasure({ image, flat, product: 'sweat', position: 'sirt' });
  assert.ok(plain.measure_source.views.every(v => v.view === 'teyit'));
  const fallback = await autoMeasure({ image, flat, product: 'sweat', position: 'sirt', viewDefault: true });
  const views = fallback.measure_source.views;
  assert.equal(views.find(v => v.view === 'on').productBoxPx.x < views.find(v => v.view === 'arka').productBoxPx.x, true);
  assert.ok(views.every(v => v.viewEvidence.viewSource === 'varsayilan'));
  assert.ok(!fallback.reasons.some(r => /görünüm ayrılamadı/.test(r)), fallback.reason);
});

test('G61 a default layout is not handed on to other prints of the picture as evidence', () => {
  const image = { id: 5, sha256: 'abc' };
  const measured = (source) => ({ id: 1, measure_source: JSON.stringify({ method: 'otomatik', gorselFileId: 5, selectedPage: 1,
    views: [{ page: 1, view: 'on', productBoxPx: { x: 0, y: 0, w: 10, h: 10 }, viewEvidence: { viewSource: source } },
      { page: 1, view: 'arka', productBoxPx: { x: 50, y: 0, w: 10, h: 10 }, viewEvidence: { viewSource: source } }] }) });
  const v = app => ({ id: null, files: [{ id: 5, kind: 'urun_gorsel', sha256: 'abc' }], lines: [{ applications: [app, { id: 2 }] }] });
  assert.equal(imageViewHint(null, v(measured('varsayilan')), image, 2), null);
  assert.equal(imageViewHint(null, v(measured('goz')), image, 2), null);
  assert.deepEqual(imageViewHint(null, v(measured(undefined)), image, 2), { front: 'sol', source: 'baska_baski' });
});
