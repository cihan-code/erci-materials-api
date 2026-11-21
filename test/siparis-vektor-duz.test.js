'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCanvas } = require('@napi-rs/canvas');
const { vectorize } = require('../agent/siparis/vector');

// Invented artwork: a white X with rounded bars on a black ground, like a flat logo.
function xLogo({ width = 360, height = 240, bar = 40, ground = 'black', ink = 'white' } = {}) {
  const canvas = createCanvas(width, height), ctx = canvas.getContext('2d');
  if (ground) { ctx.fillStyle = ground; ctx.fillRect(0, 0, width, height); }
  ctx.fillStyle = ink;
  for (const s of [1, -1]) {
    ctx.beginPath();
    ctx.moveTo(width*.2-bar/2, height*(s > 0 ? .15 : .85)); ctx.lineTo(width*.2+bar/2, height*(s > 0 ? .15 : .85));
    ctx.lineTo(width*.8+bar/2, height*(s > 0 ? .85 : .15)); ctx.lineTo(width*.8-bar/2, height*(s > 0 ? .85 : .15));
    ctx.closePath(); ctx.fill();
  }
  ctx.beginPath(); ctx.roundRect(width*.05, height*.05, width*.25, height*.08, height*.04); ctx.fill();
  return canvas.toBuffer('image/png');
}

async function withTracer(name, run) {
  const previous = process.env.SIPARIS_VECTOR_TRACER;
  process.env.SIPARIS_VECTOR_TRACER = name;
  try { return await run(); }
  finally { if (previous === undefined) delete process.env.SIPARIS_VECTOR_TRACER; else process.env.SIPARIS_VECTOR_TRACER = previous; }
}

const flatReasons = reasons => reasons.filter(x => /çentik|Kenar sapması|Düz renk/.test(x));

test('G49 a flat two-colour X is traced on the flat path (imagetracerjs): clean intersection, sharp corners, no notches', async () => {
  const result = await vectorize({ buffer: xLogo(), mime: 'image/png', targetMm: { w: 120, h: 80 } });
  const quality = result.report.rasterQuality, flat = quality.flatQuality;
  assert.equal(result.report.vectorizer, 'imagetracer');
  assert.equal(quality.vectorizer, 'imagetracer');
  assert.equal(quality.flatClass, 'duz');
  assert.ok(quality.flatTrace.upscale >= 3 && quality.flatTrace.upscale <= 4, JSON.stringify(quality.flatTrace));
  assert.ok(flat.iou >= 0.98, JSON.stringify(flat));
  assert.ok(flat.edgeDeviationPx <= 1, JSON.stringify(flat));
  assert.equal(flat.notchCount, 0, JSON.stringify(flat.notches));
  assert.deepEqual(flatReasons(result.report.reasons), []);
  assert.equal(result.report.quality, 'iyi', result.report.reasons.join(' '));
  // One path per colour layer instead of one per traced patch.
  assert.ok(quality.pathCount <= 3, String(quality.pathCount));
});

test('G49 the previous vtracer output of the same X fails the notch check and needs review', async () => {
  const result = await withTracer('vtracer', () =>
    vectorize({ buffer: xLogo(), mime: 'image/png', targetMm: { w: 120, h: 80 } }));
  const flat = result.report.rasterQuality.flatQuality;
  assert.equal(result.report.vectorizer, 'vtracer');
  assert.ok(flat.notchCount > 0, JSON.stringify(flat));
  assert.ok(result.report.reasons.some(x => x.includes('çentik')), result.report.reasons.join(' '));
  assert.equal(result.report.quality, 'teyit');
});

test('G49 a black X on a transparent ground and a black X on paper both take the flat path', async () => {
  for (const ground of [null, 'white']) {
    const result = await vectorize({ buffer: xLogo({ ground, ink: 'black' }), mime: 'image/png' });
    const flat = result.report.rasterQuality.flatQuality;
    assert.equal(result.report.vectorizer, 'imagetracer', String(ground));
    assert.ok(flat.edgeDeviationPx <= 1 && flat.notchCount === 0, JSON.stringify(flat));
    // Natural-size previews postpone the verdict until the print size is known.
    assert.equal(result.report.quality, 'beklemede');
  }
});

test('G49 gradients and many-colour artwork stay on vtracer and record why', async () => {
  const gradient = createCanvas(200, 120), g = gradient.getContext('2d');
  const fill = g.createLinearGradient(0, 0, 200, 0);
  fill.addColorStop(0, '#102080'); fill.addColorStop(1, '#f0c020');
  g.fillStyle = fill; g.fillRect(0, 0, 200, 120);
  const colours = createCanvas(200, 120), c = colours.getContext('2d');
  ['#d02030', '#2040d0', '#20a040', '#f0a020'].forEach((colour, i) => { c.fillStyle = colour; c.fillRect(i*50, 0, 50, 120); });
  for (const [canvas, reason] of [[gradient, null], [colours, 'cok_renk']]) {
    const result = await vectorize({ buffer: canvas.toBuffer('image/png'), mime: 'image/png' });
    assert.equal(result.report.vectorizer, 'vtracer');
    assert.notEqual(result.report.rasterQuality.flatClass, 'duz');
    if (reason) assert.equal(result.report.rasterQuality.flatClass, reason);
    assert.equal(result.report.rasterQuality.flatQuality, null);
  }
});

test('G49 a cached flat preview keeps its tracer and flat checks when resized for print', async () => {
  const buffer = xLogo();
  const preview = await vectorize({ buffer, mime: 'image/png' });
  const result = await vectorize({ buffer: preview.pdf, mime: 'application/pdf', manualVector: true, targetMm: { w: 120, h: 80 },
    qualitySource: { buffer, mime: 'image/png', metrics: preview.report.rasterQuality } });
  const quality = result.report.rasterQuality;
  assert.equal(quality.vectorizer, 'imagetracer');
  assert.ok(quality.flatQuality.iou >= 0.98 && quality.flatQuality.notchCount === 0, JSON.stringify(quality.flatQuality));
  assert.equal(result.report.quality, 'iyi', result.report.reasons.join(' '));
});

test('G49b a large flat logo keeps its resolution; large non-flat artwork stays at the 800 px bound', async () => {
  const flat = await vectorize({ buffer: xLogo({ width: 1600, height: 1000, bar: 160 }), mime: 'image/png', targetMm: { w: 160, h: 100 } });
  assert.equal(flat.report.vectorizer, 'imagetracer');
  assert.ok(flat.report.designBox.w > 1500, JSON.stringify(flat.report.designBox));
  assert.ok(!flat.report.reasons.some(x => x.includes('küçültüldü')), flat.report.reasons.join(' '));
  assert.equal(flat.report.quality, 'iyi', flat.report.reasons.join(' '));
  // The cached-preview resize judges the vector against the same larger raster.
  const buffer = xLogo({ width: 1600, height: 1000, bar: 160 }), preview = await vectorize({ buffer, mime: 'image/png' });
  const resized = await vectorize({ buffer: preview.pdf, mime: 'application/pdf', manualVector: true, targetMm: { w: 160, h: 100 },
    qualitySource: { buffer, mime: 'image/png', metrics: preview.report.rasterQuality } });
  assert.equal(resized.report.quality, 'iyi', resized.report.reasons.join(' '));
  const gradient = createCanvas(1600, 1000), g = gradient.getContext('2d'), fill = g.createLinearGradient(0, 0, 1600, 0);
  fill.addColorStop(0, '#102080'); fill.addColorStop(1, '#f0c020');
  g.fillStyle = fill; g.fillRect(0, 0, 1600, 1000);
  const other = await vectorize({ buffer: gradient.toBuffer('image/png'), mime: 'image/png' });
  assert.equal(other.report.vectorizer, 'vtracer');
  assert.ok(other.report.designBox.w <= 800, JSON.stringify(other.report.designBox));
});
