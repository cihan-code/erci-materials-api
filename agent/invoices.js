// Fatura (invoices) yardimcilari. remaining_amount ve status BACKEND hesaplar.
// invoices, panel-data.json icinde yasar (jobs/incomes gibi).

const { round2, nextId } = require('./lib/util');
const {
  INVOICE_INCOMING_STATUSES: INCOMING_STATUSES,
  INVOICE_OUTGOING_STATUSES: OUTGOING_STATUSES,
} = require('./lib/enums');

// Bir faturanin kalan tutari ve durumu (deterministik).
function computeStatus(inv) {
  const total = round2(inv.total_amount || 0);
  const paid = round2(inv.paid_amount || 0);
  const remaining = round2(total - paid);
  if (inv.status === 'İptal') return { remaining, status: 'İptal' };
  let status;
  if (inv.direction === 'outgoing') {
    status = remaining <= 0.01 ? 'Tahsil Edildi' : (paid > 0.01 ? 'Kısmi Tahsil Edildi' : 'Tahsil Edilmedi');
  } else {
    status = remaining <= 0.01 ? 'Ödendi' : (paid > 0.01 ? 'Kısmi Ödendi' : 'Ödenmedi');
  }
  return { remaining, status };
}

// Panele/rapora giden zenginlestirilmis fatura (kalan + durum eklenmis).
function enrich(inv) {
  const c = computeStatus(inv);
  return Object.assign({}, inv, { remaining_amount: c.remaining, status: c.status });
}

function nextInvoiceId(list) { return nextId(list); }

// (invoice_number + tax_number) ayni mi? veya cok yakin (tutar+tarih+taraf)?
function findDuplicate(list, cand) {
  list = list || [];
  const inum = String(cand.invoice_number || '').trim().toLowerCase();
  const vkn = String(cand.tax_number || '').replace(/\D/g, '');
  if (inum && vkn) {
    const hit = list.find((x) => String(x.invoice_number || '').trim().toLowerCase() === inum
      && String(x.tax_number || '').replace(/\D/g, '') === vkn && x.status !== 'İptal');
    if (hit) return { hit, reason: 'aynı fatura no + VKN' };
  }
  if (inum) {
    const hit = list.find((x) => String(x.invoice_number || '').trim().toLowerCase() === inum && x.status !== 'İptal');
    if (hit) return { hit, reason: 'aynı fatura no' };
  }
  return null;
}

module.exports = {
  INCOMING_STATUSES, OUTGOING_STATUSES,
  computeStatus, enrich, nextInvoiceId, findDuplicate, round2,
};
