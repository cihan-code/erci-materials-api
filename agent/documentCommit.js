// Onaylanan belgeyi FINANSA isle. YALNIZ kullanici "Onayla ve İşle" dedikten sonra.
// Kullanicinin duzenledigi alanlar (fields) modelin degerlerinden ONCELIKLIDIR.
// Duplicate suphesi varsa confirmDuplicate olmadan kayit OLUSTURULMAZ.
//
// input: {
//   fields: { finalType, finalDirection, date, total, currency, counterparty_name,
//             invoice_number, reference_number, subtotal, vat_amount, due_date, description,
//             sender_iban, receiver_iban, tax_number, tax_office },
//   links: { customer_id?, supplier_id?, job_id?, invoice_id?, debt_id? },
//   financeCategory?,          // gelen odeme: Kapora/Kalan Tahsilat/... (kullanici secer)
//   paymentAmount?,            // dekont bir faturaya/borca bagliysa: bu odeme tutari (delta)
//   confirm: true,
//   confirmDuplicate?: true
// }

const store = require('./store');
const docs = require('./documents');
const inv = require('./invoices');

const r2 = inv.round2;
const INCOME_CATS = ['Kapora', 'Kalan Tahsilat', 'Peşin Ödeme', 'Tahsilat', 'İş Geliri', 'Diğer Gelir'];

function num(v, label) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error((label || 'Tutar') + ' geçerli bir sayı olmalı.');
  return n;
}
function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
function todayISO() { return new Date().toISOString().slice(0, 10); }
function nextId(arr) { let m = 0; (arr || []).forEach((x) => { const n = Number(x && x.id); if (n > m) m = n; }); return m + 1; }

function commitDocument(id, input) {
  input = input || {};
  if (input.confirm !== true) throw new Error('confirm=true gerekli (kullanıcı "Onayla ve İşle" demeli).');

  const rec = docs.getDocument(id);
  if (!rec) throw new Error('Belge bulunamadı: ' + id);
  if (rec.status === 'committed') throw new Error('Bu belge zaten işlendi.');

  const f = input.fields || {};
  const type = f.finalType || (rec.classification && rec.classification.finalType);
  const dir = f.finalDirection || (rec.classification && rec.classification.finalDirection);
  if (!type || type === 'unknown' || !dir || dir === 'unknown') {
    throw new Error('Belge türü/yönü belirsiz — önizleme ekranında seçim yapılmalı.');
  }

  const raw = store.readPanelRaw();
  if (!raw || !raw.data) throw new Error('panel-data.json yok.');
  const data = raw.data;
  data.invoices = data.invoices || [];
  data.incomes = data.incomes || [];
  data.expenses = data.expenses || [];

  const links = input.links || {};
  const date = isDate(f.date) ? f.date : todayISO();
  const total = r2(num(f.total, 'Toplam tutar'));
  if (total <= 0) throw new Error('Toplam tutar pozitif olmalı.');
  const created = [];

  // ---------- FATURA ----------
  if (type === 'invoice') {
    const dup = inv.findDuplicate(data.invoices, { invoice_number: f.invoice_number, tax_number: f.tax_number });
    if (dup && !input.confirmDuplicate) {
      return { needsDuplicateConfirm: true, reason: 'Aynı fatura zaten kayıtlı (' + dup.reason + ', id=' + dup.hit.id + ').', existing: inv.enrich(dup.hit) };
    }
    const id2 = inv.nextInvoiceId(data.invoices);
    const now = new Date().toISOString();
    const invoice = {
      id: id2,
      direction: dir, // incoming = alış, outgoing = satış
      invoice_number: String(f.invoice_number || '').slice(0, 60) || null,
      invoice_date: date,
      due_date: isDate(f.due_date) ? f.due_date : null,
      counterparty_name: String(f.counterparty_name || '').slice(0, 160) || null,
      customer_id: dir === 'outgoing' ? (links.customer_id || null) : null,
      supplier_id: dir === 'incoming' ? (links.supplier_id || null) : null,
      related_job_id: links.job_id || null,
      tax_number: String(f.tax_number || '').replace(/\D/g, '') || null,
      tax_office: String(f.tax_office || '').slice(0, 120) || null,
      subtotal: f.subtotal != null ? r2(f.subtotal) : null,
      vat_amount: f.vat_amount != null ? r2(f.vat_amount) : null,
      total_amount: total,
      currency: (f.currency || 'TRY').slice(0, 8),
      paid_amount: 0,
      status: dir === 'outgoing' ? 'Tahsil Edilmedi' : 'Ödenmedi',
      document_id: rec.id,
      document_hash: rec.sha256,
      notes: String(f.description || '').slice(0, 300),
      created_at: now,
      updated_at: now,
    };
    data.invoices.unshift(invoice);
    created.push({ kind: 'invoice', id: id2, direction: dir });
  } else {
    // ---------- DEKONT ----------
    // duplicate: ayni document_id'li gelir/gider veya (tutar+tarih+taraf+referans)
    const ref = String(f.reference_number || '').trim().toLowerCase();
    const party = String(f.counterparty_name || '').trim().toLowerCase();
    const bag = dir === 'incoming' ? data.incomes : data.expenses;
    const dupHit = bag.find((x) => x.document_id === rec.id)
      || bag.find((x) => r2(x.amount) === total && String(x.date) === date
        && (ref && String(x.note || '').toLowerCase().includes(ref)
          || party && String((dir === 'incoming' ? x.source : x.payee) || '').toLowerCase().includes(party)));
    if (dupHit && !input.confirmDuplicate) {
      return { needsDuplicateConfirm: true, reason: 'Bu ödeme daha önce işlenmiş olabilir (id=' + dupHit.id + ', ' + dupHit.amount + ' TL, ' + dupHit.date + ').', existing: dupHit };
    }

    const note = '[Belge] ' + (f.description || (dir === 'incoming' ? 'gelen ödeme' : 'yapılan ödeme'))
      + (ref ? ' · ref: ' + f.reference_number : '');

    if (dir === 'incoming') {
      const cat = INCOME_CATS.includes(input.financeCategory) ? input.financeCategory : 'Tahsilat';
      const gid = nextId(data.incomes);
      data.incomes.unshift({
        id: gid, date, amount: total,
        category: cat,
        source: String(f.counterparty_name || '').slice(0, 160),
        job_id: links.job_id || null,
        payment_method: 'Havale/EFT',
        note: note.slice(0, 300),
        document_id: rec.id,
      });
      created.push({ kind: 'income', id: gid });
      // satis faturasina tahsilat baglama
      if (links.invoice_id) {
        const target = data.invoices.find((x) => x.id === links.invoice_id && x.direction === 'outgoing');
        if (target) {
          target.paid_amount = r2((target.paid_amount || 0) + total);
          target.updated_at = new Date().toISOString();
          Object.assign(target, inv.computeStatus(target));
          created.push({ kind: 'invoice_collection', id: target.id, applied: total });
        }
      }
    } else {
      const gid = nextId(data.expenses);
      const cat = links.debt_id ? 'Borç Ödemesi' : (input.financeCategory || 'Diğer');
      data.expenses.unshift({
        id: gid, date, amount: total,
        category: String(cat).slice(0, 40),
        payee: String(f.counterparty_name || '').slice(0, 160),
        job_id: links.job_id || null,
        payment_method: 'Havale/EFT',
        note: note.slice(0, 300),
        document_id: rec.id,
      });
      created.push({ kind: 'expense', id: gid });
      // alis faturasi odemesi
      if (links.invoice_id) {
        const target = data.invoices.find((x) => x.id === links.invoice_id && x.direction === 'incoming');
        if (target) {
          target.paid_amount = r2((target.paid_amount || 0) + total);
          target.updated_at = new Date().toISOString();
          Object.assign(target, inv.computeStatus(target));
          created.push({ kind: 'invoice_payment', id: target.id, applied: total });
        }
      }
      // borc odemesi
      if (links.debt_id) {
        const dbt = (data.debts || []).find((x) => x.id === links.debt_id);
        if (dbt) {
          dbt.paid_amount = r2((dbt.paid_amount || 0) + total);
          dbt.update_date = todayISO();
          dbt.note = (dbt.note ? dbt.note + ' | ' : '') + '[' + todayISO() + ' Belge] ' + total.toLocaleString('tr-TR') + ' TL ödeme';
          created.push({ kind: 'debt_payment', id: dbt.id, applied: total });
        }
      }
    }
  }

  const updatedAt = store.writePanelData(data, raw.updatedAt);
  docs.updateDocument(id, {
    status: 'committed',
    committedRecord: { kind: created[0] && created[0].kind, created, at: new Date().toISOString() },
    finalFields: f,
  });
  return { ok: true, created, updatedAt };
}

module.exports = { commitDocument, INCOME_CATS };
