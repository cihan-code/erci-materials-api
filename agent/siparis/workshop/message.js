'use strict';
const path = require('node:path');
const recipeReader = require('../../operations/recipes');

function fileName(file) {
  return path.basename(file.name || file.filename || file.path || file.kind || 'dosya.pdf');
}

// Allowlist, never stringify the order: prices and customer contacts must stay private.
function buildWorkshopMessage(order = {}, files = [], recipes = recipeReader.load()) {
  const lines = order.lines || order.items || [];
  return [
    `Sipariş: ${order.order_no ?? order.orderNo ?? order.no ?? '-'}`,
    `Sürüm: ${order.version_no ?? order.versionNo ?? order.version ?? '-'}`,
    ...lines.map(item => {
      const product = item.product_key ?? item.product ?? item.product_name ?? '-';
      const label = recipes.products?.[product]?.label ?? item.product_name ?? product;
      return `Ürün: ${label} | Renk: ${item.color_name ?? item.color ?? '-'} | Adet: ${item.quantity ?? item.qty ?? '-'}`;
    }),
    `Dosyalar: ${files.map(fileName).join(', ')}`,
  ].join('\n');
}

module.exports = { buildWorkshopMessage, fileName };
