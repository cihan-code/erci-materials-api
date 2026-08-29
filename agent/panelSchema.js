// panel-data.json icin HAFIF dogrulama - sadece "bu kesinlikle bozuk veri" durumlarini yakalar.
// Amac: hatali bir panel build'i veya kotu bir yazma para alanina cop koyup TUM veri setini
// bozmasin. Sema/zorunlu-alan katiligi YOK (panel serbestce alan ekleyebilsin).

// Panelde dizi olmasi GEREKEN kayit koleksiyonlari.
const RECORD_ARRAYS = [
  'customers', 'jobs', 'incomes', 'expenses', 'fixedExpenses', 'debts', 'pipeline',
  'suppliers', 'hedefler', 'hedeflerAylik', 'uretimTakip', 'okulMail', 'okulTakip',
  'tasks', 'invoices', 'supplierCategories',
];

// Sayisal olmasi gereken alanlar (bir kayitta varsa: sayi | null | sayiya cevrilebilir string).
const NUMERIC_FIELDS = [
  'amount', 'total_amount', 'unit_price', 'quantity', 'paid_amount', 'deposit',
  'deposit_received', 'subtotal', 'vat_amount', 'manual_total_cost',
  'est_quantity', 'est_unit_price', 'probability', 'yillik_hedef', 'aylik_hedef',
];

function isBadNumericValue(v) {
  if (v == null || v === '') return false;
  if (typeof v === 'number') return !Number.isFinite(v);
  if (typeof v === 'string') {
    // panel bazen "1234.5" gonderir; "1.234,56" veya "abc" bozuktur
    return !/^-?\d+(\.\d+)?$/.test(v.trim());
  }
  return true; // obje/dizi/boolean bir para alaninda = bozuk
}

// Doner: { ok, errors: [{ path, problem }] }  (en fazla 20 hata)
function validatePanelData(data) {
  const errors = [];
  const add = (path, problem) => { if (errors.length < 20) errors.push({ path, problem }); };

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, errors: [{ path: 'data', problem: 'nesne olmalı' }] };
  }

  RECORD_ARRAYS.forEach((k) => {
    if (data[k] === undefined || data[k] === null) return;
    if (!Array.isArray(data[k])) { add(k, 'dizi olmalı (' + typeof data[k] + ' geldi)'); return; }
    data[k].forEach((rec, i) => {
      if (!rec || typeof rec !== 'object') return; // supplierCategories: string dizisi - sorun degil
      NUMERIC_FIELDS.forEach((f) => {
        if (f in rec && isBadNumericValue(rec[f])) {
          add(k + '[' + i + '].' + f, 'geçersiz sayı: ' + JSON.stringify(rec[f]));
        }
      });
    });
  });

  if (data.costTemplates !== undefined && data.costTemplates !== null && typeof data.costTemplates !== 'object') {
    add('costTemplates', 'nesne olmalı');
  }

  return { ok: errors.length === 0, errors };
}

module.exports = { validatePanelData, RECORD_ARRAYS, NUMERIC_FIELDS, isBadNumericValue };
