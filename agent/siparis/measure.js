'use strict';

const { PNG } = require('pngjs');

/** Measurements from uncertain images are advisory until confirmed. */
function measureApplication({ refLengthPx, refLengthCm, designBoxPx, imageKind, flags = {} } = {}) {
  if (!designBoxPx || !Number.isFinite(designBoxPx.w) || !Number.isFinite(designBoxPx.h) ||
      designBoxPx.w <= 0 || designBoxPx.h <= 0) {
    throw new RangeError('Desen kutusunun en ve boyu pozitif piksel değerleri olmalıdır.');
  }
  const reasons = [];
  if (imageKind !== 'flat') reasons.push('Fotoğraf veya düz olmayan görsel için ölçü teyidi gerekir.');
  if (flags.perspective) reasons.push('Perspektif ölçüyü etkileyebilir.');
  if (flags.wrinkled) reasons.push('Kırışıklık ölçüyü etkileyebilir.');
  const validReference = Number.isFinite(refLengthPx) && refLengthPx > 0 &&
    Number.isFinite(refLengthCm) && refLengthCm > 0;
  if (!validReference) reasons.push('Referans uzunluk (px ve cm) eksik veya geçersiz.');
  const scaleCmPerPx = validReference ? refLengthCm / refLengthPx : null;
  const width = validReference ? Math.round(designBoxPx.w * scaleCmPerPx * 10) : null;
  const height = validReference ? Math.round(designBoxPx.h * scaleCmPerPx * 10) : null;
  if (validReference && (!Number.isSafeInteger(width) || !Number.isSafeInteger(height))) {
    throw new RangeError('Hesaplanan ölçü güvenli tam sayı olmalıdır.');
  }
  return {
    width_mm: width, height_mm: height, scaleCmPerPx,
    needsConfirmation: reasons.length > 0, reasons, reason: reasons.join(' '),
  };
}

/** Inclusive pixel bounds. Fully transparent and pure white pixels are background. */
function designBoxFromPng(buffer) {
  const { width, height, data } = PNG.sync.read(buffer);
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] === 0 || (data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255)) continue;
      left = Math.min(left, x); top = Math.min(top, y);
      right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
  }
  return right < 0 ? null : { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}

module.exports = { measureApplication, designBoxFromPng };
