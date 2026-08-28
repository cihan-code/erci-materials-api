// Bir belge cikariminda backend'in bulabilecegi ADAY eslesmeler.
// OTOMATIK BAGLAMAZ - yalniz onerir. Kullanici onizleme ekraninda secer.

const store = require('./store');
const inv = require('./invoices');
const cp = require('./company-profile');

function r2(v) { return Math.round((v || 0) * 100) / 100; }
function nn(s) { return cp.normName(s); }
function dnum(s) { try { return new Date(String(s).slice(0, 10) + 'T00:00:00Z').getTime(); } catch (e) { return NaN; } }

// Belgenin "karsi taraf" adi: yon Merci-degil olan taraf
function counterpartyName(ext, dir) {
  if (dir === 'incoming') return ext.sender_name || ext.counterparty_name;
  if (dir === 'outgoing') return ext.receiver_name || ext.counterparty_name;
  return ext.sender_name || ext.receiver_name;
}
function counterpartyVkn(ext, dir) {
  if (dir === 'incoming') return ext.sender_tax_number;
  if (dir === 'outgoing') return ext.receiver_tax_number;
  return ext.sender_tax_number || ext.receiver_tax_number;
}

// { customers:[], suppliers:[], jobs:[], invoices:[], debts:[] } - her biri {id, label, score, reason}
function suggestLinks(ext, classification) {
  const { data } = store.loadPanelData();
  if (!data) return { customers: [], suppliers: [], jobs: [], invoices: [], debts: [] };

  const type = classification.finalType;
  const dir = classification.finalDirection;

  // ---- URETIM FORMU: siparis no -> mevcut is, isim -> musteri ----
  if (type === 'production_form') {
    const out = { customers: [], suppliers: [], jobs: [], invoices: [], debts: [], existingJob: null };
    const orderNo = String(ext.order_no || '').trim().toLowerCase();
    const nCust = nn(ext.customer_name);
    (data.jobs || []).forEach((j) => {
      const jn = String(j.job_no || '').trim().toLowerCase();
      if (orderNo && jn && jn === orderNo) {
        const c = (data.customers || []).find((x) => x.id === j.customer_id);
        const label = (j.job_no || '#' + j.id) + ' · ' + ((c && c.name) || j.customer_name_free || '-') + ' · ' + (j.product_type || '-') + ' · ' + (j.status || '-');
        out.jobs.push({ id: j.id, label, score: 1, reason: 'Sipariş No birebir eşleşti' });
        out.existingJob = { id: j.id, jobNo: j.job_no, status: j.status };
      }
    });
    if (nCust) {
      (data.customers || []).forEach((c) => {
        const n = nn(c.name);
        if (!n) return;
        let s = 0;
        if (n === nCust) s = 1;
        else if (n.includes(nCust) || nCust.includes(n)) s = 0.7;
        if (s >= 0.6) out.customers.push({ id: c.id, label: c.name, score: r2(s), reason: 'isim benzerliği' });
      });
      out.customers.sort((a, b) => b.score - a.score);
      out.customers = out.customers.slice(0, 6);
    }
    return out;
  }

  const partyName = counterpartyName(ext, dir);
  const partyVkn = String(counterpartyVkn(ext, dir) || '').replace(/\D/g, '');
  const amount = r2(ext.total != null ? ext.total : ext.amount);
  const dateT = dnum(ext.date);
  const nQ = nn(partyName);

  const nameScore = (name) => {
    const n = nn(name);
    if (!n || !nQ) return 0;
    if (n === nQ) return 1;
    if (n.includes(nQ) || nQ.includes(n)) return 0.7;
    const a = new Set(nQ.split(' ')); const b = n.split(' ');
    const common = b.filter((w) => w.length > 2 && a.has(w)).length;
    return common ? Math.min(0.6, 0.25 * common) : 0;
  };

  const out = { customers: [], suppliers: [], jobs: [], invoices: [], debts: [] };

  // MUSTERI (gelen odeme / satis faturasi)
  if (dir === 'incoming' || (type === 'invoice' && dir === 'outgoing')) {
    (data.customers || []).forEach((c) => {
      const s = nameScore(c.name);
      if (s >= 0.6) out.customers.push({ id: c.id, label: c.name, score: r2(s), reason: 'isim benzerliği' });
    });
  }
  // TEDARIKCI (yapilan odeme / alis faturasi)
  if (dir === 'outgoing' || (type === 'invoice' && dir === 'incoming')) {
    (data.suppliers || []).forEach((sp) => {
      const s = nameScore(sp.name);
      if (s >= 0.6) out.suppliers.push({ id: sp.id, label: sp.name + ' (' + (sp.category || '-') + ')', score: r2(s), reason: 'isim benzerliği' });
    });
  }

  // ACIK FATURALAR - tutar/tarih/no/taraf
  const wantInvDir = dir === 'incoming' ? 'outgoing' : 'incoming'; // gelen odeme -> satis faturasi
  (data.invoices || []).forEach((iv) => {
    if (iv.direction !== wantInvDir) return;
    const en = inv.enrich(iv);
    if (en.remaining_amount <= 0.01 || en.status === 'İptal') return;
    let sc = 0; const rs = [];
    if (ext.invoice_number && String(iv.invoice_number || '').toLowerCase() === String(ext.invoice_number).toLowerCase()) { sc += 0.6; rs.push('fatura no'); }
    if (partyVkn && String(iv.tax_number || '').replace(/\D/g, '') === partyVkn) { sc += 0.3; rs.push('VKN'); }
    const ns = nameScore(iv.counterparty_name); if (ns >= 0.6) { sc += 0.2 * ns; rs.push('isim'); }
    if (amount && (r2(en.remaining_amount) === amount || r2(en.total_amount) === amount)) { sc += 0.35; rs.push('tutar'); }
    if (sc >= 0.4) out.invoices.push({ id: iv.id, label: (iv.invoice_number || '#' + iv.id) + ' · ' + (iv.counterparty_name || '-') + ' · kalan ' + en.remaining_amount.toLocaleString('tr-TR') + ' TL', score: r2(Math.min(1, sc)), reason: rs.join('+') });
  });

  // BORC/ALACAK - yapilan odeme icin
  if (dir === 'outgoing') {
    (data.debts || []).forEach((d) => {
      if (d.type !== 'Borç' && d.type !== 'Borc') return;
      const rem = r2((d.amount || 0) - (d.paid_amount || 0));
      if (rem <= 0.01) return;
      const ns = nameScore(d.party_name);
      if (ns >= 0.55 || (amount && rem === amount)) {
        out.debts.push({ id: d.id, label: d.party_name + ' · kalan ' + rem.toLocaleString('tr-TR') + ' TL', score: r2(Math.max(ns, amount && rem === amount ? 0.5 : 0)), reason: ns >= 0.55 ? 'isim' : 'tutar' });
      }
    });
  }

  // ISLER - musteri secilirse daralir; simdilik isim + acik is
  if (nQ) {
    const custIds = new Set(out.customers.map((c) => c.id));
    (data.jobs || []).forEach((j) => {
      if (!['Onaylandı', 'Üretimde'].includes(j.status)) return;
      const cn = (data.customers || []).find((c) => c.id === j.customer_id);
      const label = (cn && cn.name) || j.customer_name_free || '';
      if (custIds.has(j.customer_id) || nameScore(label) >= 0.6) {
        out.jobs.push({ id: j.id, label: (j.job_no || '#' + j.id) + ' · ' + label + ' · ' + (j.product_type || '-'), score: 0.6, reason: 'müşteri eşleşmesi' });
      }
    });
  }

  Object.keys(out).forEach((k) => { out[k] = out[k].sort((a, b) => b.score - a.score).slice(0, 6); });
  return out;
}

module.exports = { suggestLinks, counterpartyName, counterpartyVkn };
