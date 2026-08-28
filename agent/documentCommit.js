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

  // ---------- URETIM FORMU -> IS TAKIP (jobs). Finansa dokunmaz. ----------
  if (type === 'production_form') {
    return commitProductionForm(rec, input, f);
  }

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

// ---------- URETIM FORMU -> jobs (Is Takip) ----------
const JOB_STATUSES = ['Teklif', 'Onaylandı', 'Üretimde', 'Teslim Edildi', 'İptal'];
const SIZE_KEYS = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'];

function sizeSum(sb) {
  if (!sb || typeof sb !== 'object') return 0;
  return SIZE_KEYS.reduce((s, k) => s + (parseInt(sb[k], 10) || 0), 0);
}

function commitProductionForm(rec, input, f) {
  const raw = store.readPanelRaw();
  if (!raw || !raw.data) throw new Error('panel-data.json yok.');
  const data = raw.data;
  data.jobs = data.jobs || [];

  const links = input.links || {};
  const orderNo = String(f.order_no || '').trim();
  if (!orderNo) throw new Error('Sipariş No boş — önizleme ekranında girilmeli.');

  const qty = Number.isFinite(Number(f.total_quantity)) && Number(f.total_quantity) > 0
    ? Math.round(Number(f.total_quantity))
    : sizeSum(f.size_breakdown);
  if (!qty) throw new Error('Toplam adet belirlenemedi — önizleme ekranında girilmeli.');

  const status = JOB_STATUSES.includes(f.status) ? f.status : 'Onaylandı';
  const unitPrice = Number.isFinite(Number(f.unit_price)) ? r2(Number(f.unit_price)) : 0;
  const costItems = Array.isArray(f.cost_items)
    ? f.cost_items.filter((x) => x && x.category).map((x) => ({ category: String(x.category).slice(0, 80), amount: r2(Number(x.amount) || 0) }))
    : [];
  const bnSecim = (f.baski_nakis_secim && typeof f.baski_nakis_secim === 'object') ? f.baski_nakis_secim : null;

  // mevcut is ile ayni siparis no?
  const existing = data.jobs.find((j) => String(j.job_no || '').trim().toLowerCase() === orderNo.toLowerCase());
  if (existing && !input.existingJobAction) {
    return {
      needsExistingJobDecision: {
        jobId: existing.id, jobNo: existing.job_no, status: existing.status,
        title: existing.title,
      },
      reason: '"' + orderNo + '" numaralı iş zaten mevcut. Mevcut işi güncellemek mi, yeni kayıt oluşturmak mı istiyorsunuz?',
    };
  }
  const action = input.existingJobAction === 'update' && existing ? 'update' : 'new';

  const now = new Date().toISOString();
  const noteText = ['[Üretim Formu ' + rec.id + ']', f.color ? 'Renk: ' + f.color : '', f.notes || '']
    .filter(Boolean).join(' · ').slice(0, 500);

  const common = {
    title: String(f.order_title || f.product_description || orderNo).slice(0, 200),
    customer_id: links.customer_id || null,
    customer_name_free: links.customer_id ? null : (String(f.customer_name || '').slice(0, 160) || null),
    product_type: String(f.product_type || '').slice(0, 80) || null,
    quantity: qty,
    unit_price: unitPrice,
    cost_items: costItems,
    delivery_date: isDate(f.delivery_date) ? f.delivery_date : null,
    baski_nakis_secim: bnSecim,
    document_id: rec.id,
    document_hash: rec.sha256,
    prod_size_breakdown: f.size_breakdown || null,
    prod_print_areas: Array.isArray(f.print_areas) ? f.print_areas : [],
    prod_embroidery_areas: Array.isArray(f.embroidery_areas) ? f.embroidery_areas : [],
    prod_special_instructions: Array.isArray(f.special_instructions) ? f.special_instructions : [],
  };

  let jobId;
  if (action === 'update') {
    jobId = existing.id;
    Object.assign(existing, common, {
      status: JOB_STATUSES.includes(f.status) ? f.status : existing.status,
      note: (existing.note ? existing.note + ' | ' : '') + noteText,
      updated_at: now,
    });
  } else {
    jobId = nextId(data.jobs);
    data.jobs.unshift({
      id: jobId,
      job_no: orderNo,
      order_date: isDate(f.order_date) ? f.order_date : todayISO(),
      status,
      manual_total_cost: 0,
      deposit_received: 0,
      problem_note: null,
      note: noteText,
      created_at: now,
      updated_at: now,
      ...common,
    });
  }

  // opsiyonel: uretim takip kaydi
  const created = [{ kind: 'job', id: jobId, action, jobNo: orderNo }];
  if (input.createUretimTakip) {
    data.uretimTakip = data.uretimTakip || [];
    const utId = nextId(data.uretimTakip);
    data.uretimTakip.unshift({
      id: utId,
      date: todayISO(),
      customer_name: String(f.customer_name || common.customer_name_free || common.title).slice(0, 160),
      est_delivery: isDate(f.delivery_date) ? f.delivery_date : null,
      quantity: qty,
      status: 'Planlandı',
      note: '[Üretim Formu ' + rec.id + '] ' + (f.product_type || '') + (f.color ? ' / ' + f.color : ''),
      problem_note: null,
      follow_up_date: null,
      job_no: orderNo,
    });
    created.push({ kind: 'uretimTakip', id: utId });
  }

  const updatedAt = store.writePanelData(data, raw.updatedAt);
  docs.updateDocument(rec.id, {
    status: 'committed',
    committedRecord: { kind: 'job', created, at: now },
    finalFields: f,
  });
  return { ok: true, created, updatedAt, jobId };
}

module.exports = { commitDocument, commitProductionForm, INCOME_CATS, JOB_STATUSES };
