// DETERMINISTIK HESAP KATMANI.
// Tum adet / TL / yuzde / gun farki / toplam BURADA hesaplanir. Panelin kendi
// (index.html) fonksiyonlariyla ayni mantik. Model bu sayilari YALNIZ yorumlar,
// yeni sayi uretmez.
//
// Yonetim kararlari (2026-08-28, S1..S11):
//  S1  debts (Alacak) ile islerin acik tutari AYRI - asla toplanmaz.
//  S2  job_id bagli olmadigi icin is bazli KESIN kalan tahsilat uretilmez;
//      yalniz "bagli tahsilat" (Σ job_id eslesen incomes) gosterilir.
//  S3  uretimTakip <-> jobs otomatik eslestirilmez; ayri tutulur.
//  S4  "ciro" tek basina kullanilmaz -> Siparis Bedeli + Tahsilat ayri metrik.
//  S5  yonetim sonucu = gelir - gider - sabit gider; veri suphesi varsa "kesin net kar" denmez.
//  S6  fixedExpenses.paid_amount odeme durumu icin guvenilir degil -> "odenmedi" uyarisi URETILMEZ.
//  S7  expenses <-> fixedExpenses maas cift kaydi tespit + raporlanir; otomatik silinmez, iki kez toplanmaz.
//  S8  probability standardi 0-1; >1 degerler /100 normalize.
//  S9  pipeline "Onaylandi" otomatik "Kazanildi" sayilmaz -> veri temizligi uyarisi.
//  S10 id gercek benzersiz kimlik; tekrarli job_no otomatik birlestirilmez.
//  S11 aylik Tamamlanan Is teslim tarihine gore olcus; teslim tarihi alani yoksa "olculemiyor".

const {
  JOB_STATUSES, JOB_ACTIVE, URETIM_STATUSES, PIPELINE_STATUSES, PIPELINE_CLOSED,
} = require('./lib/enums');
const { round2, daysBetween } = require('./lib/util');

function d(s) {
  if (!s) return null;
  const m = String(s).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(m)) return null;
  const dt = new Date(m + 'T00:00:00Z');
  return isNaN(dt.getTime()) ? null : dt;
}
function ym(s) { return String(s || '').slice(0, 7); }
function tl(n) { return (Math.round(n || 0)).toLocaleString('tr-TR') + ' TL'; }
function pct(n) { return (Math.round((n || 0) * 1000) / 10).toFixed(1) + '%'; }
function num(n) { return (n == null ? '-' : Number(n).toLocaleString('tr-TR')); }
function cleanStatus(s) {
  const map = { 'Ütü-Pakette-Teslimat Bekliyor': 'Ütü-Paket (teslimat bekliyor)' };
  return map[String(s || '').trim()] || String(s || '').trim() || '-';
}

// panel: jobTotalCost - cost_items varsa toplami, yoksa manual_total_cost
function jobCost(j) {
  const items = j.cost_items || [];
  const sum = items.reduce((s, c) => s + (c.amount || 0), 0);
  return round2(items.length ? sum : (j.manual_total_cost || 0));
}
// S8: 0-1 disi degeri normalize et
function normProbability(p) {
  const n = Number(p);
  if (!Number.isFinite(n)) return { value: null, normalized: false };
  if (n > 1) return { value: Math.min(1, n / 100), normalized: true };
  if (n < 0) return { value: 0, normalized: true };
  return { value: n, normalized: false };
}

// Fatura rollup - remaining ve status BACKEND. (agent/invoices.js ile ayni mantik.)
function computeInvoices(list) {
  const enrich = (iv) => {
    const total = round2(iv.total_amount || 0);
    const paid = round2(iv.paid_amount || 0);
    const remaining = round2(total - paid);
    let status = iv.status;
    if (status !== 'İptal') {
      if (iv.direction === 'outgoing') status = remaining <= 0.01 ? 'Tahsil Edildi' : (paid > 0.01 ? 'Kısmi Tahsil Edildi' : 'Tahsil Edilmedi');
      else status = remaining <= 0.01 ? 'Ödendi' : (paid > 0.01 ? 'Kısmi Ödendi' : 'Ödenmedi');
    }
    return {
      id: iv.id, direction: iv.direction, no: iv.invoice_number || null,
      tarih: iv.invoice_date || null, vade: iv.due_date || null,
      taraf: iv.counterparty_name || '-', total, paid, remaining, status,
      job_id: iv.related_job_id || null, document_id: iv.document_id || null,
    };
  };
  const all = (list || []).map(enrich);
  const alis = all.filter((x) => x.direction === 'incoming');
  const satis = all.filter((x) => x.direction === 'outgoing');
  const openSum = (a) => round2(a.filter((x) => x.status !== 'İptal').reduce((s, x) => s + x.remaining, 0));
  return {
    alis, satis,
    alisAcikToplam: openSum(alis),   // odememiz gereken
    satisAcikToplam: openSum(satis), // tahsil etmemiz gereken
    alisSayisi: alis.length, satisSayisi: satis.length,
  };
}

function computeMetrics(data, today) {
  data = data || {};
  const T = d(today) || d(new Date().toISOString().slice(0, 10));
  const todayStr = T.toISOString().slice(0, 10);
  const curMonth = todayStr.slice(0, 7);
  const cust = {};
  (data.customers || []).forEach((c) => { cust[c.id] = c.name; });
  const custName = (j) => cust[j.customer_id] || j.customer_name_free || '?';

  const conf = []; // dataConfidence - yalniz GERCEK bosluklar
  const M = { today: todayStr, curMonth };

  // ---------------- JOBS ----------------
  const jobs = data.jobs || [];
  const incByJob = {};
  (data.incomes || []).forEach((i) => { if (i.job_id != null) incByJob[i.job_id] = round2((incByJob[i.job_id] || 0) + (i.amount || 0)); });

  const jobByStatus = {};
  jobs.forEach((j) => { jobByStatus[j.status] = (jobByStatus[j.status] || 0) + 1; });

  const activeJobs = jobs.filter((j) => JOB_ACTIVE.includes(j.status)).map((j) => {
    const siparisBedeli = round2((j.quantity || 0) * (j.unit_price || 0));
    const maliyet = jobCost(j);
    const dd = d(j.delivery_date);
    return {
      id: j.id, job_no: j.job_no, musteri: custName(j), urun: j.product_type || '-',
      adet: j.quantity || 0, birimFiyat: j.unit_price || 0,
      siparisBedeli, maliyet, brutKar: round2(siparisBedeli - maliyet),
      bagliTahsilat: incByJob[j.id] || 0,
      durum: j.status,
      teslimTarihi: j.delivery_date || null,
      teslimGecikmeGun: dd ? daysBetween(T, dd) : null,
      problem: j.problem_note || null,
      birimFiyatSifir: !j.unit_price,
    };
  });

  // S10 - tekrarli job_no
  const jobNoCount = {};
  jobs.forEach((j) => { if (j.job_no) jobNoCount[j.job_no] = (jobNoCount[j.job_no] || 0) + 1; });
  const dupJobNo = Object.entries(jobNoCount).filter(([, c]) => c > 1).map(([k]) => k);
  if (dupJobNo.length) conf.push('Tekrarlı job_no: ' + dupJobNo.join(', ') + ' - kayıtlar id ile ayırt edildi, job_no birleştirilmedi.');
  if (activeJobs.some((j) => j.birimFiyatSifir)) conf.push('Bazı aktif işlerde birim fiyat 0 - sipariş bedeli eksik hesaplanmış olabilir.');

  M.jobs = {
    toplamKayit: jobs.length,
    durumDagilimi: jobByStatus,
    teslimEdilenSayisi: jobByStatus['Teslim Edildi'] || 0,
    aktif: activeJobs,
    aktifSayisi: activeJobs.length,
    aktifSiparisBedeliToplam: round2(activeJobs.reduce((s, j) => s + j.siparisBedeli, 0)),
    aktifBagliTahsilatToplam: round2(activeJobs.reduce((s, j) => s + j.bagliTahsilat, 0)),
  };

  // ---------------- PRODUCTION (uretimTakip) - S3: jobs'a baglanmaz ----------------
  const ut = (data.uretimTakip || []).filter((u) => u.status !== 'Teslim Edildi').map((u) => {
    const est = d(u.est_delivery);
    const g = est ? daysBetween(T, est) : null;
    let risk = 'akis';
    if (g != null && g > 0) risk = 'gecikme';
    else if (g != null && g >= -3) risk = 'yakin';
    return {
      id: u.id, musteri: String(u.customer_name || '').trim(),
      durum: cleanStatus(u.status), adet: u.quantity != null ? u.quantity : null,
      tahminiTeslim: u.est_delivery || null, gecikmeGun: g, risk,
      problem: u.problem_note || null, not: u.note || null,
    };
  });
  const utByStage = {};
  ut.forEach((u) => { utByStage[u.durum] = (utByStage[u.durum] || 0) + 1; });
  M.production = {
    acikKayit: ut,
    acikSayisi: ut.length,
    gecikmeSayisi: ut.filter((u) => u.risk === 'gecikme').length,
    asamaDagilimi: utByStage,
  };
  conf.push('Üretim Takip kayıtları işlere bağlı değil (job_id yok) - ayrı raporlanır, isim eşleştirmesi yapılmadı.');

  // ---------------- TASKS - carried_forward HARIC ----------------
  const allTasks = data.tasks || [];
  const acikTasks = allTasks.filter((t) => !t.done && !t.carried_forward);
  const gecikenTasks = acikTasks.filter((t) => { const dt = d(t.date); return dt && dt < T; });
  const kisiBazli = {};
  acikTasks.forEach((t) => { const k = t.assigned_to || '(atanmamış)'; kisiBazli[k] = (kisiBazli[k] || 0) + 1; });
  const bugunVe2 = acikTasks.filter((t) => { const dt = d(t.date); if (!dt) return false; const g = daysBetween(dt, T); return g >= 0 && g <= 2; })
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map((t) => ({ id: t.id, tarih: t.date, kisi: t.assigned_to || '?', baslik: t.title || '-' }));
  const enEski = gecikenTasks.slice().sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(0, 15)
    .map((t) => ({ id: t.id, tarih: t.date, kisi: t.assigned_to || '?', baslik: t.title || '-', gecikmeGun: daysBetween(T, d(t.date)) }));
  M.tasks = {
    acikSayisi: acikTasks.length,
    gecikenSayisi: gecikenTasks.length,
    devredilenToplam: allTasks.filter((t) => t.carried_forward).length,
    kisiBazliAcik: kisiBazli,
    bugunVe2GunVadeli: bugunVe2,
    enEskiGeciken: enEski,
  };
  conf.push('Açık/geciken görev sayısı carried_forward=true kayıtlar HARİÇ hesaplandı (taşınan görevlerin ölü kopyaları sayılmaz).');

  // ---------------- SALES (pipeline + okul) ----------------
  let probNormCount = 0;
  const acikFirsatlar = [];
  const onaylandiUyari = [];
  (data.pipeline || []).forEach((p) => {
    if (p.status === 'Onaylandı') onaylandiUyari.push({ id: p.id, musteri: p.customer_name || '-', aciklama: p.description || '-' });
    if (PIPELINE_CLOSED.includes(p.status)) return;
    const pr = normProbability(p.probability);
    if (pr.normalized) probNormCount++;
    const val = round2((p.est_quantity || 0) * (p.est_unit_price || 0));
    const fu = d(p.follow_up_date);
    acikFirsatlar.push({
      id: p.id, musteri: p.customer_name || '-', aciklama: p.description || '-',
      tahminiDeger: val, olasilik: pr.value,
      takipTarihi: p.follow_up_date || null,
      takipGecikmeGun: fu ? daysBetween(T, fu) : null,
      durum: p.status, not: p.note || null,
    });
  });
  if (probNormCount) conf.push(probNormCount + ' pipeline kaydında olasılık 0-1 dışıydı, /100 ile normalize edildi (S8).');
  if (onaylandiUyari.length) conf.push(onaylandiUyari.length + " pipeline kaydı geçersiz 'Onaylandı' durumunda - veri temizliği gerekli (S9). Otomatik Kazanıldı sayılmadı.");

  const okulTakip = (data.okulTakip || []).map((o) => {
    const fu = d(o.takip_tarihi);
    return { id: o.id, okul: o.okul_adi || '-', durum: o.gorusme_durumu || '-', takipTarihi: o.takip_tarihi || null, takipGecikmeGun: fu ? daysBetween(T, fu) : null };
  });
  const okulMailDonus = (data.okulMail || []).filter((o) => ['Görüşüldü', 'Gorusuldu'].includes(o.donus_durumu))
    .map((o) => ({ id: o.id, okul: o.okul_adi || '-', birim: o.ilgili_birim || '-' }));

  M.sales = {
    acikFirsatlar,
    acikFirsatSayisi: acikFirsatlar.length,
    tahminiDegerToplam: round2(acikFirsatlar.reduce((s, p) => s + p.tahminiDeger, 0)),
    takipGecikenSayisi: acikFirsatlar.filter((p) => p.takipGecikmeGun != null && p.takipGecikmeGun > 0).length,
    onaylandiVeriUyarisi: onaylandiUyari,
    okulTakip,
    okulTakipGecikenSayisi: okulTakip.filter((o) => o.takipGecikmeGun != null && o.takipGecikmeGun > 0).length,
    okulMailDonus,
  };

  // ---------------- CRM ----------------
  const jobsByCust = {};
  jobs.forEach((j) => { if (j.customer_id != null) (jobsByCust[j.customer_id] = jobsByCust[j.customer_id] || []).push(j); });
  M.crm = {
    musteriSayisi: (data.customers || []).length,
    musteriler: (data.customers || []).map((c) => {
      const js = jobsByCust[c.id] || [];
      return {
        id: c.id, ad: c.name || '-', tip: c.type || '-', kategori: c.category || '-',
        isSayisi: js.length,
        teslimSayisi: js.filter((j) => j.status === 'Teslim Edildi').length,
        siparisBedeliToplam: round2(js.reduce((s, j) => s + (j.quantity || 0) * (j.unit_price || 0), 0)),
        sonSiparis: js.map((j) => j.order_date).filter(Boolean).sort().slice(-1)[0] || null,
        not: c.note ? String(c.note).slice(0, 160) : null,
      };
    }),
  };

  // ---------------- FINANCE ----------------
  const incomes = data.incomes || [];
  const expenses = data.expenses || [];
  const fixed = data.fixedExpenses || [];

  const incMonths = incomes.map((i) => ym(i.date)).filter(Boolean).sort();
  const gelirBaslangic = incMonths[0] || null;
  const jobLinkedInc = incomes.filter((i) => i.job_id != null).length;

  const byM = {};
  const bump = (m, k, v) => { if (!m) return; byM[m] = byM[m] || { gelir: 0, gider: 0, sabit: 0 }; byM[m][k] += v || 0; };
  incomes.forEach((i) => bump(ym(i.date), 'gelir', i.amount));
  expenses.forEach((e) => bump(ym(e.date), 'gider', e.amount));
  fixed.forEach((f) => bump(ym(f.date), 'sabit', f.amount));

  // S7 - supheli maas cift kaydi
  const maasFixed = fixed.filter((f) => /maa[şs]/i.test(f.name || ''));
  const supheli = [];
  maasFixed.forEach((f) => {
    const fm = ym(f.date);
    expenses.forEach((e) => {
      if (e.category === 'Maaş' && ym(e.date) === fm && Math.abs((e.amount || 0) - (f.amount || 0)) < 1) {
        supheli.push({ ay: fm, tutar: f.amount || 0, fixedAd: f.name, expensePayee: e.payee || '-' });
      }
    });
  });
  const supheliToplam = round2(supheli.reduce((s, x) => s + x.tutar, 0));
  if (supheli.length) conf.push(supheli.length + ' şüpheli maaş çift kaydı (expenses ↔ fixedExpenses, ' + tl(supheliToplam) + ') - otomatik silinmedi, gider toplamı bu kadar yüksek olmayabilir (S7).');

  const aylik = Object.keys(byM).sort().map((m) => {
    const g = byM[m];
    return {
      ay: m, gelir: round2(g.gelir), gider: round2(g.gider), sabitGider: round2(g.sabit),
      yonetimSonucu: round2(g.gelir - g.gider - g.sabit), // S5: gelir - gider - sabit
    };
  });

  // debts - S1: AYRI, asla islerin acik tutariyla toplanmaz
  let alacak = 0, borc = 0;
  const borcVadeleri = [];
  (data.debts || []).forEach((x) => {
    const bal = round2((x.amount || 0) - (x.paid_amount || 0));
    if (bal <= 0) return;
    if (x.type === 'Alacak') alacak += bal;
    else if (x.type === 'Borç' || x.type === 'Borc') borc += bal;
    const due = d(x.due_date);
    let flag = null;
    if (due && due < T) flag = 'vadesi geçmiş';
    else if (due && daysBetween(due, T) <= 14) flag = 'vade yakın (14 gün)';
    borcVadeleri.push({ id: x.id, tip: x.type, taraf: x.party_name || '-', kalan: bal, vade: x.due_date || null, uyari: flag });
  });

  const gelirToplam = round2(incomes.reduce((s, i) => s + (i.amount || 0), 0));
  const giderToplamHam = round2(expenses.reduce((s, e) => s + (e.amount || 0), 0) + fixed.reduce((s, f) => s + (f.amount || 0), 0));
  const siparisBedeliToplamTum = round2(jobs.reduce((s, j) => s + (j.quantity || 0) * (j.unit_price || 0), 0));

  // S5: hem supheli maas cift kaydi hem de gelir verisinin eksik baslangici sonucu belirsizlestirir
  const finansGuvenilir = false; // tum-zaman "yonetim sonucu" her zaman kaba/yaklasik - "kesin net kar" denmez
  if (gelirBaslangic) conf.push('Gelir verisi ' + gelirBaslangic + " tarihinden itibaren var; daha eski dönem yok - 'yıllık' kıyas ve toplam yönetim sonucu kaba.");
  conf.push('74 gelir kaydının ' + jobLinkedInc + " tanesi bir işe bağlı - iş bazlı KESİN kalan tahsilat üretilmedi, yalnız 'bağlı tahsilat' gösterilir (S2).");
  conf.push('Sabit gider ödeme durumu (paid_amount) güvenilir değil - "ödenmedi" uyarısı üretilmedi (S6).');

  M.finance = {
    // S4: iki ayri metrik, "ciro" tek kelimesi yok
    siparisBedeliToplam: siparisBedeliToplamTum,
    tahsilatToplam: gelirToplam,
    giderToplam: giderToplamHam,
    yonetimSonucuTahmini: round2(gelirToplam - giderToplamHam),
    yonetimSonucuGuvenilir: finansGuvenilir,
    aylik,
    buAy: aylik.find((a) => a.ay === curMonth) || { ay: curMonth, gelir: 0, gider: 0, sabitGider: 0, yonetimSonucu: 0 },
    gelirVeriBaslangic: gelirBaslangic,
    gelirIseBagliOran: jobLinkedInc + '/' + incomes.length,
    // S1: debts AYRI
    debtsAcikAlacak: round2(alacak),
    debtsAcikBorc: round2(borc),
    debtsVadeler: borcVadeleri,
    // S7
    supheliMaasCiftKayit: supheli,
    supheliMaasCiftToplam: supheliToplam,
    // S6: liste ama "odenmedi" YOK
    sabitGiderKalemleri: fixed.map((f) => ({ ay: f.month_label || ym(f.date), ad: f.name, tutar: f.amount || 0 })),
    // FATURALAR (kalan/durum backend hesaplar)
    faturalar: computeInvoices(data.invoices || []),
  };

  // ---------------- HEDEFLER - panelin computeHedefGerceklesen'i (CANLI) ----------------
  const teslimEdilen = M.jobs.teslimEdilenSayisi;
  M.hedefler = {
    yillik: (data.hedefler || []).map((h) => {
      const ad = h.hedef_adi || '';
      let g = null, hesaplandi = true;
      if (/Ciro/i.test(ad)) g = gelirToplam;
      else if (/İş|Is\b/i.test(ad)) g = teslimEdilen;
      else if (/Müşteri|Musteri/i.test(ad)) g = M.crm.musteriSayisi;
      else { hesaplandi = false; g = null; }
      return {
        ad, hedef: h.yillik_hedef || 0, gerceklesen: g, hesaplandi,
        yuzde: (hesaplandi && h.yillik_hedef) ? round2(g / h.yillik_hedef) : null,
        paraBirimi: !!h.is_currency,
      };
    }),
    aylik: (data.hedeflerAylik || []).map((h) => {
      const ad = h.hedef_adi || '';
      const bu = M.finance.buAy;
      let g = null, hesaplandi = true, notu = null;
      if (/Net Kâr|Net Kar/i.test(ad)) g = bu.yonetimSonucu; // S5: sabit dahil
      else if (/Ciro/i.test(ad)) g = bu.gelir;
      else if (/İş|Is\b/i.test(ad)) { hesaplandi = false; notu = 'ölçülemiyor - gerçek teslim tarihi alanı yok (S11)'; }
      else if (/Müşteri|Musteri/i.test(ad)) { hesaplandi = false; notu = 'ölçülemiyor - müşterilerin çoğunda created_date yok'; }
      else hesaplandi = false;
      return {
        ad, hedef: h.aylik_hedef || 0, gerceklesen: hesaplandi ? round2(g) : null, hesaplandi, notu,
        yuzde: (hesaplandi && h.aylik_hedef) ? round2(g / h.aylik_hedef) : null,
        paraBirimi: !!h.is_currency,
      };
    }),
  };
  conf.push('Hedef "gerçekleşen" değerleri panelin canlı hesabıyla üretildi (gerceklesen_excel donuk alanı KULLANILMADI).');

  M.dataConfidence = conf;
  return M;
}

// ---------------- METIN CIKTISI (modele giden) ----------------
// domainList: ['production','tasks','sales','crm','finance'] alt kumesi. Yoksa hepsi.
const DOMAIN_KEYS = ['production', 'tasks', 'sales', 'crm', 'finance'];

function renderMetricsText(M, domainList) {
  const doms = (Array.isArray(domainList) && domainList.length) ? domainList : DOMAIN_KEYS;
  const L = [];
  L.push('# DOĞRULANMIŞ METRİK TABLOSU (backend hesapladı — bu sayıları AYNEN kullan, yeni sayı üretme)');
  L.push('Bugün: ' + M.today);
  L.push('');

  if (doms.includes('production')) {
    L.push('## AKTİF İŞLER (jobs, durum = Onaylandı veya Üretimde) — ' + M.jobs.aktifSayisi + ' iş');
    L.push('Toplam sipariş bedeli: ' + tl(M.jobs.aktifSiparisBedeliToplam) + ' | Toplam bağlı tahsilat: ' + tl(M.jobs.aktifBagliTahsilatToplam));
    L.push('(Sipariş bedeli = adet×birim fiyat. Bağlı tahsilat = bu işe job_id ile bağlanmış gelir kayıtları. İş bazlı "kalan/açık" KESİN DEĞİL — S2.)');
    M.jobs.aktif.forEach((j) => {
      L.push('  id=' + j.id + ' ' + (j.job_no || '') + ' | ' + j.musteri + ' | ' + j.urun + ' x' + num(j.adet) +
        ' | sipariş bedeli=' + tl(j.siparisBedeli) + ' | maliyet=' + tl(j.maliyet) + ' | brüt kâr=' + tl(j.brutKar) +
        ' | bağlı tahsilat=' + tl(j.bagliTahsilat) + ' | durum=' + j.durum +
        (j.teslimTarihi ? ' | teslim=' + j.teslimTarihi + ' (' + gunStr(j.teslimGecikmeGun) + ')' : '') +
        (j.problem ? ' | problem="' + j.problem + '"' : ''));
    });
    L.push('İş durum dağılımı (tüm işler): ' + JSON.stringify(M.jobs.durumDagilimi) + ' | teslim edilen toplam: ' + M.jobs.teslimEdilenSayisi);
    L.push('');
    L.push('## ÜRETİM TAKİP (uretimTakip — açık kayıtlar) — ' + M.production.acikSayisi + ' kayıt, ' + M.production.gecikmeSayisi + ' gecikmede');
    L.push('(İşlere BAĞLI DEĞİL — ayrı tablo, S3. Bu tablonun kendi tahmini teslim tarihi var.)');
    M.production.acikKayit.forEach((u) => {
      L.push('  [' + u.risk + '] id=' + u.id + ' | ' + u.musteri + ' | ' + u.durum + ' | adet=' + num(u.adet) +
        ' | tah.teslim=' + (u.tahminiTeslim || '-') + ' (' + gunStr(u.gecikmeGun) + ')' +
        (u.problem ? ' | problem="' + u.problem + '"' : '') + (u.not ? ' | not="' + u.not + '"' : ''));
    });
    L.push('Aşama dağılımı: ' + JSON.stringify(M.production.asamaDagilimi));
    L.push('');
  }

  if (doms.includes('tasks')) {
    L.push('## GÖREVLER (taşınmış kopyalar carried_forward=true HARİÇ)');
    L.push('Açık görev: ' + M.tasks.acikSayisi + ' | Geciken: ' + M.tasks.gecikenSayisi + ' | (bilgi: devredilmiş kayıt toplamı ' + M.tasks.devredilenToplam + ')');
    L.push('Kişi bazlı açık: ' + JSON.stringify(M.tasks.kisiBazliAcik));
    L.push('Bugün/+2 gün vadeli:' + (M.tasks.bugunVe2GunVadeli.length ? '' : ' (yok)'));
    M.tasks.bugunVe2GunVadeli.forEach((t) => L.push('  id=' + t.id + ' | ' + t.tarih + ' | ' + t.kisi + ' | ' + t.baslik));
    L.push('En eski geciken (' + M.tasks.enEskiGeciken.length + '):');
    M.tasks.enEskiGeciken.forEach((t) => L.push('  id=' + t.id + ' | ' + t.tarih + ' | ' + t.kisi + ' | ' + t.baslik + ' | ' + t.gecikmeGun + ' gün'));
    L.push('');
  }

  if (doms.includes('sales')) {
    L.push('## AÇIK FIRSATLAR (pipeline, durum ≠ Kazanıldı/Kaybedildi) — ' + M.sales.acikFirsatSayisi + ' fırsat');
    L.push('Tahmini değer toplamı: ' + tl(M.sales.tahminiDegerToplam) + ' | Takibi geciken: ' + M.sales.takipGecikenSayisi);
    L.push('(Olasılık 0-1 ölçeğinde. "Tahmini değer × olasılık" ile beklenen değer üretme — olasılık verisi zayıf.)');
    M.sales.acikFirsatlar.forEach((p) => {
      L.push('  id=' + p.id + ' | ' + p.musteri + ' | ' + p.aciklama + ' | tahmini değer=' + tl(p.tahminiDeger) +
        ' | olasılık=' + (p.olasilik == null ? '-' : pct(p.olasilik)) + ' | durum=' + p.durum +
        ' | takip=' + (p.takipTarihi || '-') + ' (' + gunStr(p.takipGecikmeGun) + ')' + (p.not ? ' | not="' + p.not + '"' : ''));
    });
    if (M.sales.onaylandiVeriUyarisi.length) {
      L.push('VERİ TEMİZLİĞİ: ' + M.sales.onaylandiVeriUyarisi.length + " kayıt geçersiz 'Onaylandı' durumunda (S9): " +
        M.sales.onaylandiVeriUyarisi.map((o) => 'id=' + o.id + ' ' + o.musteri).join(', '));
    }
    L.push('Okul takip — geciken ' + M.sales.okulTakipGecikenSayisi + '/' + M.sales.okulTakip.length + ':');
    M.sales.okulTakip.forEach((o) => L.push('  id=' + o.id + ' | ' + o.okul + ' | ' + o.durum + ' | takip=' + (o.takipTarihi || '-') + ' (' + gunStr(o.takipGecikmeGun) + ')'));
    if (M.sales.okulMailDonus.length) {
      L.push('Okul mail dönüşü var (teklife çevrilmeli): ' + M.sales.okulMailDonus.map((o) => o.okul + ' (' + o.birim + ')').join(', '));
    }
    L.push('');
  }

  if (doms.includes('crm')) {
    L.push('## MÜŞTERİLER — ' + M.crm.musteriSayisi + ' kayıt');
    L.push('(sipariş bedeli toplamı = o müşterinin işlerinin adet×fiyat toplamı; tahsilat değil.)');
    M.crm.musteriler.forEach((c) => {
      L.push('  id=' + c.id + ' | ' + c.ad + ' | ' + c.tip + '/' + c.kategori + ' | iş=' + c.isSayisi + ' (teslim ' + c.teslimSayisi + ')' +
        ' | sipariş bedeli top.=' + tl(c.siparisBedeliToplam) + ' | son sipariş=' + (c.sonSiparis || '-') + (c.not ? ' | not="' + c.not + '"' : ''));
    });
    L.push('');
  }

  if (doms.includes('finance')) {
    const F = M.finance;
    L.push('## FİNANS');
    L.push('İki ayrı metrik (S4 — "ciro" tek kelimesi kullanma):');
    L.push('  Sipariş Bedeli toplamı (tüm işler, adet×fiyat): ' + tl(F.siparisBedeliToplam));
    L.push('  Tahsilat toplamı (tüm gelir kayıtları): ' + tl(F.tahsilatToplam) + '  [gelir verisi ' + (F.gelirVeriBaslangic || '?') + "'dan itibaren]");
    L.push('  Gider toplamı (genel + sabit): ' + tl(F.giderToplam));
    L.push('  Yönetim sonucu (tahsilat − gider) ≈ ' + tl(F.yonetimSonucuTahmini) +
      (F.yonetimSonucuGuvenilir ? '' : '  ← KESİN NET KÂR DEĞİL (veri şüphesi var, S5/S7)'));
    L.push('');
    L.push('Aylık (yönetim sonucu = gelir − gider − sabit gider, S5):');
    F.aylik.forEach((a) => L.push('  ' + a.ay + ' | gelir=' + tl(a.gelir) + ' | gider=' + tl(a.gider) + ' | sabit=' + tl(a.sabitGider) + ' | yönetim sonucu=' + tl(a.yonetimSonucu)));
    L.push('');
    L.push('ALACAK / BORÇ (debts — S1: işlerin açık tutarından AYRI, asla toplama):');
    L.push('  Açık alacak (debts): ' + tl(F.debtsAcikAlacak) + ' | Açık borç (debts): ' + tl(F.debtsAcikBorc));
    F.debtsVadeler.forEach((x) => L.push('  ' + x.tip + ' | id=' + x.id + ' | ' + x.taraf + ' | kalan=' + tl(x.kalan) + ' | vade=' + (x.vade || '-') + (x.uyari ? ' | ' + x.uyari : '')));
    L.push('');
    if (F.supheliMaasCiftKayit.length) {
      L.push('ŞÜPHELİ MAAŞ ÇİFT KAYDI (S7 — otomatik silinmedi, gider toplamı ' + tl(F.supheliMaasCiftToplam) + ' fazla olabilir):');
      F.supheliMaasCiftKayit.forEach((s) => L.push('  ' + s.ay + ' | ' + tl(s.tutar) + ' | fixedExpenses:"' + s.fixedAd + '" ↔ expenses payee:"' + s.expensePayee + '"'));
      L.push('');
    }
    L.push('Aylık sabit gider kalemleri (ödeme durumu bilinmiyor, S6 — "ödenmedi" deme):');
    F.sabitGiderKalemleri.forEach((f) => L.push('  ' + f.ay + ' | ' + f.ad + ' | ' + tl(f.tutar)));
    L.push('');
    if (F.faturalar && (F.faturalar.alisSayisi || F.faturalar.satisSayisi)) {
      L.push('FATURALAR (invoices — kalan/durum backend hesabı, işlerin açık tutarıyla TOPLAMA):');
      L.push('  Açık ALIŞ faturası (ödememiz gereken): ' + tl(F.faturalar.alisAcikToplam) + ' (' + F.faturalar.alisSayisi + ' fatura)');
      L.push('  Açık SATIŞ faturası (tahsil etmemiz gereken): ' + tl(F.faturalar.satisAcikToplam) + ' (' + F.faturalar.satisSayisi + ' fatura)');
      F.faturalar.alis.concat(F.faturalar.satis).filter((x) => x.status !== 'İptal' && x.remaining > 0.01).slice(0, 20)
        .forEach((x) => L.push('  ' + (x.direction === 'incoming' ? 'ALIŞ' : 'SATIŞ') + ' id=' + x.id + ' ' + (x.no || '') + ' | ' + x.taraf + ' | toplam ' + tl(x.total) + ' | kalan ' + tl(x.remaining) + ' | ' + x.status + (x.vade ? ' | vade ' + x.vade : '')));
      L.push('');
    }
    L.push('## HEDEFLER (gerçekleşen = panelin CANLI hesabı, donuk Excel alanı değil):');
    M.hedefler.yillik.forEach((h) => {
      const fmt = (v) => h.paraBirimi ? tl(v) : num(v);
      L.push('  ' + h.ad + ' | yıllık hedef=' + fmt(h.hedef) + ' | gerçekleşen=' +
        (h.hesaplandi ? fmt(h.gerceklesen) + ' (' + pct(h.yuzde) + ')' : 'hesaplanamıyor'));
    });
    M.hedefler.aylik.forEach((h) => {
      const fmt = (v) => h.paraBirimi ? tl(v) : num(v);
      L.push('  ' + h.ad + ' (aylık) | hedef=' + fmt(h.hedef) + ' | gerçekleşen=' +
        (h.hesaplandi ? fmt(h.gerceklesen) + ' (' + pct(h.yuzde) + ')' : (h.notu || 'hesaplanamıyor')));
    });
    L.push('');
  }

  L.push('## VERİ GÜVENİ (raporun "Veri güveni" satırında SADECE bunları kullan — kendi "panel hatalı" yorumunu ekleme):');
  M.dataConfidence.forEach((c) => L.push('  - ' + c));

  return L.join('\n');
}

function gunStr(g) {
  if (g == null) return 'tarih yok';
  if (g > 0) return '+' + g + ' gün gecikme';
  if (g === 0) return 'bugün';
  return Math.abs(g) + ' gün kaldı';
}

module.exports = {
  computeMetrics, renderMetricsText, DOMAIN_KEYS,
  JOB_STATUSES, JOB_ACTIVE, URETIM_STATUSES, PIPELINE_STATUSES, PIPELINE_CLOSED,
};
