'use strict';

// Entirely fictional, geometric artwork; no reference/customer assets are used.
const { PNG } = require('pngjs');

function raster(width, height, paint) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const rgba = paint(x, y);
      const i = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) png.data[i + c] = rgba[c];
    }
  }
  return PNG.sync.write(png);
}

function inside(x, y, polygon) {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    if (((yi > y) !== (yj > y)) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) result = !result;
  }
  return result;
}

function shirt(color, back = false) {
  const silhouette = [[65, 65], [125, 30], [175, 30], [235, 65], [290, 125], [245, 170], [225, 145], [225, 340], [75, 340], [75, 145], [55, 170], [10, 125]];
  return raster(300, 370, (x, y) => {
    if (!inside(x, y, silhouette)) return [255, 255, 255, 0];
    if ((x - 150) ** 2 + (y - 23) ** 2 < 30 ** 2) return [245, 245, 245, 255];
    if (back && x > 105 && x < 195 && y > 105 && y < 153) return [224, 193, 103, 255];
    if (!back && (x - 180) ** 2 + (y - 115) ** 2 < 15 ** 2) return [224, 193, 103, 255];
    return [...color, 255];
  });
}

function preview() {
  return raster(280, 120, (x, y) => {
    if (x < 4 || y < 4 || x > 275 || y > 115) return [255, 255, 255, 0];
    const stripe = Math.abs(x - 140) + Math.abs(y - 60) < 65;
    return stripe ? [36, 50, 80, 255] : [224, 193, 103, 255];
  });
}

function makeExampleOrder({ twoColors = true } = {}) {
  const lines = [{ id: 'ornek-mavi', product: 'Örnek Tişört', color: 'Gece Mavisi', fabric: 'Pamuk',
    sizes: { XS: 3, S: 2, M: 4, L: 1 }, images: { front: shirt([36, 50, 80]), back: shirt([36, 50, 80], true) } }];
  if (twoColors) lines.push({ id: 'ornek-kirmizi', product: 'Örnek Tişört', color: 'Kiremit', fabric: 'Pamuk',
    sizes: { XS: 1, M: 2, XXL: 3 }, images: { front: shirt([151, 65, 50]), back: shirt([151, 65, 50], true) } });
  return {
    orderNo: 'MRC-T001', name: 'Örnek Kulüp · Şİğ', deliveryDate: '30.11.2026', date: '19.11.2026', version: 2,
    description: ['Dikiş ve kumaş rengi numuneyle eşleşecek.', 'Göğüs nakışı ve sırt baskısı uygulanacak.'],
    lines,
    applications: [
      { type: 'baski', position: 'sirt', width_mm: 280, height_mm: 120, preview: preview() },
      { type: 'nakis', position: 'gogus', width_mm: 75, height_mm: 40, preview: preview() },
    ],
  };
}

module.exports = { makeExampleOrder, raster };
