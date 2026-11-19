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

/** Read dimensions without allocating/decompressing pixels (including JPEG SOF markers). */
function imageSize(buffer, mime) {
  let width, height;
  if (mime === 'image/png') {
    if (buffer.length < 33 || !buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
        buffer.readUInt32BE(8) !== 13 || buffer.subarray(12,16).toString() !== 'IHDR') throw new Error('Geçersiz PNG');
    width = buffer.readUInt32BE(16); height = buffer.readUInt32BE(20);
  } else {
    if (buffer[0] !== 255 || buffer[1] !== 216) throw new Error('Geçersiz JPG');
    let offset = 2;
    const sof = new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
    while (offset < buffer.length) {
      if (buffer[offset++] !== 255) throw new Error('Geçersiz JPG işaretçisi');
      while (buffer[offset] === 255) offset++;
      const marker = buffer[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset+2 > buffer.length) break;
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset+length > buffer.length) throw new Error('Geçersiz JPG başlığı');
      if (sof.has(marker)) {
        if (length < 8) throw new Error('Geçersiz JPG boyutu');
        height = buffer.readUInt16BE(offset+3); width = buffer.readUInt16BE(offset+5); break;
      }
      offset += length;
    }
  }
  if (!width || !height) throw new Error('Geçersiz görsel boyutu');
  if (width*height > 40e6) throw Object.assign(new Error('Görsel en çok 40 megapiksel olabilir'), {status:413});
  return {width,height};
}

/** Inclusive pixel bounds. Transparent and white pixels are background. */
function pixelBounds({width,height,data,pixels}, white = 255) {
  data ||= pixels;
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    if (data[i+3] === 0 || (data[i] >= white && data[i+1] >= white && data[i+2] >= white)) continue;
    left = Math.min(left,x); top = Math.min(top,y);
    right = Math.max(right,x); bottom = Math.max(bottom,y);
  }
  return right < 0 ? null : {x:left,y:top,w:right-left+1,h:bottom-top+1};
}
function designBoxFromPng(buffer) {
  imageSize(buffer,'image/png');
  return pixelBounds(PNG.sync.read(buffer));
}

module.exports = { measureApplication, designBoxFromPng, imageSize, pixelBounds };
