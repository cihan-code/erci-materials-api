'use strict';
const path = require('node:path');

function fileName(file) {
  return path.basename(file.name || file.filename || file.path || file.kind || 'dosya.pdf');
}

// Allowlist, never stringify the order: prices and customer contacts must stay private.
function buildWorkshopMessage(order = {}, files = []) {
  const lines = order.lines || order.items || [];
  return [
    `Siparis: ${order.order_no ?? order.orderNo ?? order.no ?? '-'}`,
    `Surum: ${order.version_no ?? order.versionNo ?? order.version ?? '-'}`,
    ...lines.map(item => `Urun: ${item.product_key ?? item.product ?? item.product_name ?? '-'} | Renk: ${item.color_name ?? item.color ?? '-'} | Adet: ${item.quantity ?? item.qty ?? '-'}`),
    `Dosyalar: ${files.map(fileName).join(', ')}`,
  ].join('\n');
}

module.exports = { buildWorkshopMessage, fileName };
