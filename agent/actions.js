// Panel uzerinde DAR create/update fonksiyonlari.
// Claude yalnizca "hangi aksiyon + hangi parametreler" cikarir (act.js); uygulamayi BURASI yapar.
// - safe   : dogrudan uygulanir (gorev, uretim durumu, takip tarihi, not).
// - confirm : finansal degisiklik / silme / kritik kayit -> kullanicidan onay istenir.
//
// Her aksiyon panel-data.json'da YALNIZ hedef kaydi degistirir; store.writePanelData yedek alir.

const store = require('./store');
const { URETIM_STATUSES, PIPELINE_STATUSES, JOB_STATUSES } = require('./metrics');

const RISK = { SAFE: 'safe', CONFIRM: 'confirm' };

const MANAGERS = ['Cihan Berber', 'Erdem Küçükarslan', 'Mert Kıvanç Tekin'];
// Panelin (index.html) gercek enum'lari - metrics.js'ten tek kaynak.
const PROD_STATUSES = URETIM_STATUSES; // uretimTakip.status
// PIPELINE_STATUSES ve JOB_STATUSES da metrics.js'ten geliyor.

function statusMatch(list, v) {
  return list.find((s) => s.toLowerCase() === String(v || '').trim().toLowerCase()) || null;
}

const INCOME_CATS = ['Kapora', 'Kalan Tahsilat', 'Peşin Ödeme', 'Tahsilat', 'İş Geliri', 'Diğer Gelir'];

function todayISO() { return new Date().toISOString().slice(0, 10); }
function nextId(arr) {
  let mx = 0;
  (arr || []).forEach((x) => { const n = Number(x && x.id); if (Number.isFinite(n) && n > mx) mx = n; });
  return mx + 1;
}
function str(v, max) { return v == null ? '' : String(v).slice(0, max || 300); }
function isISODate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
// Yonetici adini tam forma cevir; eslesme yoksa hata (yanlis kisiye atama engeli).
function resolveManager(v) {
  const q = String(v || '').trim().toLowerCase();
  if (!q) return '';
  const hit = MANAGERS.find((m) => m.toLowerCase().includes(q) || q.includes(m.split(' ')[0].toLowerCase()));
  if (!hit) throw new Error('Geçersiz kişi "' + v + '". Geçerli: ' + MANAGERS.join(', '));
  return hit;
}
// Tarih bugune gore makul araligada mi (+-400 gun)? Model yil hatasi yapmasin.
function saneDate(s, label) {
  if (!isISODate(s)) throw new Error((label || 'Tarih') + ' YYYY-MM-DD olmalı');
  const diff = Math.abs((new Date(s + 'T00:00:00Z') - new Date(todayISO() + 'T00:00:00Z')) / 86400000);
  if (diff > 400) throw new Error((label || 'Tarih') + ' bugünden çok uzak (' + s + ') - yıl hatası olabilir');
  return s;
}
function round2(v) { return Math.round((v || 0) * 100) / 100; }
// Bir odemenin DELTA tutari. Model bazen farkli isim kullaniyor - hepsini "bu seferki odeme" say.
function paymentDelta(p) {
  return p.odeme_tutari != null ? p.odeme_tutari
    : (p.odeme != null ? p.odeme
      : (p.amount != null ? p.amount : p.paid_amount));
}

// id ile veya serbest metin eslemesiyle tek kayit bul. Birden fazla eslesme -> hata.
function findOne(list, p, textFields, label) {
  list = list || [];
  if (p.id != null && p.id !== '') {
    const hit = list.find((x) => String(x.id) === String(p.id));
    if (!hit) throw new Error(label + ' bulunamadi (id=' + p.id + ')');
    return hit;
  }
  const q = String(p.match || p.customer_name || p.name || p.title || '').trim().toLowerCase();
  if (!q) throw new Error(label + ' icin id veya eslesme metni gerekli');
  const hits = list.filter((x) => textFields.some((f) => String(x[f] || '').toLowerCase().includes(q)));
  if (hits.length === 0) throw new Error(label + ' bulunamadi ("' + q + '")');
  if (hits.length > 1) throw new Error(label + ' icin "' + q + '" birden fazla kayda uyuyor (' + hits.length + ') - id verin');
  return hits[0];
}

const ACTIONS = {
  // ---------------- SAFE ----------------
  create_task: {
    risk: RISK.SAFE, domain: 'tasks',
    describe: (p) => 'Görev ekle: "' + str(p.title, 80) + '" → ' + (p.assigned_to || 'atanmamış') + ' (' + (p.date || todayISO()) + ')',
    apply: (data, p) => {
      if (!p.title) throw new Error('title gerekli');
      const date = p.date ? saneDate(p.date, 'Görev tarihi') : todayISO();
      const kisi = p.assigned_to ? resolveManager(p.assigned_to) : '';
      data.tasks = data.tasks || [];
      const id = nextId(data.tasks);
      data.tasks.unshift({
        id, title: str(p.title, 200), note: str(p.note, 500),
        assigned_to: kisi,
        created_by: 'Yönetim Ajanı', date,
        done: false, carried_forward: false, carried_from: null,
        created_date: todayISO(),
      });
      return 'Görev #' + id + ' eklendi: "' + str(p.title, 80) + '" → ' + (kisi || 'atanmamış') + ' (' + date + ')';
    },
  },
  complete_task: {
    risk: RISK.SAFE, domain: 'tasks',
    describe: (p) => 'Görevi tamamlandı yap: ' + (p.id != null ? '#' + p.id : '"' + str(p.match, 60) + '"'),
    apply: (data, p) => {
      const t = findOne(data.tasks, p, ['title', 'note'], 'Görev');
      t.done = true;
      return 'Görev #' + t.id + ' tamamlandı: ' + str(t.title, 80);
    },
  },
  reassign_task: {
    risk: RISK.SAFE, domain: 'tasks',
    describe: (p) => 'Görevi ata: ' + (p.id != null ? '#' + p.id : '"' + str(p.match, 60) + '"') + ' → ' + p.assigned_to,
    apply: (data, p) => {
      if (!p.assigned_to) throw new Error('assigned_to gerekli');
      const kisi = resolveManager(p.assigned_to);
      const t = findOne(data.tasks, p, ['title', 'note'], 'Görev');
      t.assigned_to = kisi;
      return 'Görev #' + t.id + ' "' + str(t.title, 60) + '" → ' + kisi;
    },
  },
  set_task_date: {
    risk: RISK.SAFE, domain: 'tasks',
    describe: (p) => 'Görev tarihi: ' + (p.id != null ? '#' + p.id : '"' + str(p.match, 60) + '"') + ' → ' + p.date,
    apply: (data, p) => {
      const date = saneDate(p.date, 'Görev tarihi');
      const t = findOne(data.tasks, p, ['title', 'note'], 'Görev');
      t.date = date;
      return 'Görev #' + t.id + ' "' + str(t.title, 60) + '" tarihi → ' + date;
    },
  },
  set_production_status: {
    risk: RISK.SAFE, domain: 'production',
    describe: (p) => 'Üretim durumu: ' + (p.id != null ? 'id=' + p.id : '"' + str(p.customer_name, 40) + '"') + ' → ' + p.status,
    apply: (data, p) => {
      const u = findOne(data.uretimTakip, p, ['customer_name', 'note'], 'Üretim kaydı');
      const s = statusMatch(PROD_STATUSES, p.status);
      if (!s) throw new Error('Geçersiz üretim durumu. Geçerli: ' + PROD_STATUSES.join(', '));
      u.status = s;
      if (p.problem_note !== undefined) u.problem_note = str(p.problem_note, 300);
      return 'Üretim (' + (u.customer_name || u.id) + ') → ' + u.status;
    },
  },
  set_production_delivery: {
    risk: RISK.SAFE, domain: 'production',
    describe: (p) => 'Tahmini teslim: ' + (p.id != null ? 'id=' + p.id : '"' + str(p.customer_name, 40) + '"') + ' → ' + p.est_delivery,
    apply: (data, p) => {
      const u = findOne(data.uretimTakip, p, ['customer_name', 'note'], 'Üretim kaydı');
      u.est_delivery = saneDate(p.est_delivery, 'Tahmini teslim');
      return 'Üretim (' + (u.customer_name || u.id) + ') tah. teslim → ' + p.est_delivery;
    },
  },
  set_pipeline_followup: {
    risk: RISK.SAFE, domain: 'sales',
    describe: (p) => 'Fırsat takip tarihi: ' + (p.id != null ? 'id=' + p.id : '"' + str(p.customer_name, 40) + '"') + ' → ' + p.follow_up_date,
    apply: (data, p) => {
      const fu = saneDate(p.follow_up_date, 'Takip tarihi');
      const pl = findOne(data.pipeline, p, ['customer_name', 'description', 'note'], 'Fırsat');
      pl.follow_up_date = fu;
      if (p.note !== undefined) pl.note = str(p.note, 300);
      return 'Fırsat (' + (pl.customer_name || pl.id) + ') takip → ' + fu;
    },
  },
  set_pipeline_status: {
    risk: RISK.SAFE, domain: 'sales',
    describe: (p) => 'Fırsat durumu: ' + (p.id != null ? 'id=' + p.id : '"' + str(p.customer_name, 40) + '"') + ' → ' + p.status,
    apply: (data, p) => {
      const pl = findOne(data.pipeline, p, ['customer_name', 'description', 'note'], 'Fırsat');
      const s = statusMatch(PIPELINE_STATUSES, p.status);
      if (!s) throw new Error('Geçersiz fırsat durumu. Geçerli: ' + PIPELINE_STATUSES.join(', '));
      const eski = pl.status;
      pl.status = s;
      const not = (s === 'Kazanıldı') ? ' — bu fırsat için ayrıca İşler sekmesinden bir iş kaydı açılmalı (panelde elle).' : '';
      return 'Fırsat (' + (pl.customer_name || pl.id) + ') ' + eski + ' → ' + pl.status + not;
    },
  },
  append_customer_note: {
    risk: RISK.SAFE, domain: 'crm',
    describe: (p) => 'Müşteri notu ekle: ' + (p.id != null ? 'id=' + p.id : '"' + str(p.name, 40) + '"'),
    apply: (data, p) => {
      const c = findOne(data.customers, p, ['name', 'contact_person'], 'Müşteri');
      if (!p.note) throw new Error('note gerekli');
      const stamp = todayISO();
      c.note = (c.note ? c.note + '\n' : '') + '[' + stamp + ' Ajan] ' + str(p.note, 400);
      return 'Müşteri (' + c.name + ') notuna eklendi';
    },
  },
  set_school_followup: {
    risk: RISK.SAFE, domain: 'sales',
    describe: (p) => 'Okul takip tarihi: "' + str(p.okul_adi || p.match, 40) + '" → ' + p.takip_tarihi,
    apply: (data, p) => {
      const tt = saneDate(p.takip_tarihi, 'Takip tarihi');
      const o = findOne(data.okulTakip, { id: p.id, match: p.okul_adi || p.match }, ['okul_adi'], 'Okul kaydı');
      o.takip_tarihi = tt;
      if (p.gorusme_durumu !== undefined) o.gorusme_durumu = str(p.gorusme_durumu, 80);
      return 'Okul (' + o.okul_adi + ') takip → ' + tt;
    },
  },

  // ---------------- CONFIRM (finansal / kritik / silme) ----------------
  add_income: {
    risk: RISK.CONFIRM, domain: 'finance',
    describe: (p) => 'GELİR kaydı ekle: ' + Number(p.amount || 0).toLocaleString('tr-TR') + ' TL — ' + str(p.source, 40) + ' (' + (statusMatch(INCOME_CATS, p.category) || 'Diğer Gelir') + ')',
    apply: (data, p) => {
      const amount = Number(p.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('amount pozitif sayı olmalı');
      data.incomes = data.incomes || [];
      const id = nextId(data.incomes);
      data.incomes.unshift({
        id, date: isISODate(p.date) ? p.date : todayISO(), amount,
        category: statusMatch(INCOME_CATS, p.category) || 'Diğer Gelir', source: str(p.source, 120),
        job_id: p.job_id || null, payment_method: str(p.payment_method, 40), note: str(p.note, 300),
      });
      return 'Gelir #' + id + ' eklendi (' + amount.toLocaleString('tr-TR') + ' TL, ' + (statusMatch(INCOME_CATS, p.category) || 'Diğer Gelir') + ')';
    },
  },
  add_expense: {
    risk: RISK.CONFIRM, domain: 'finance',
    describe: (p) => 'GİDER kaydı ekle: ' + Number(p.amount || 0).toLocaleString('tr-TR') + ' TL — ' + str(p.payee, 40) + ' (' + (p.category || 'Diğer') + ')',
    apply: (data, p) => {
      const amount = Number(p.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('amount pozitif sayi olmali');
      data.expenses = data.expenses || [];
      const id = nextId(data.expenses);
      data.expenses.unshift({
        id, date: isISODate(p.date) ? p.date : todayISO(), amount,
        category: str(p.category, 40) || 'Diğer', payee: str(p.payee, 120),
        job_id: p.job_id || null, payment_method: str(p.payment_method, 40), note: str(p.note, 300),
      });
      return 'Gider #' + id + ' eklendi (' + amount.toLocaleString('tr-TR') + ' TL)';
    },
  },
  // Bir borca/alacağa ÖDEME İŞLE. odeme_tutari = bu seferki ödeme (delta), TOPLAM değil.
  // Panelin formBorcOdeme'siyle aynı: paid_amount += odeme, + otomatik Gelir(Alacak)/Gider(Borç).
  // Model bakiye HESAPLAMAZ; backend düşürür.
  update_debt_payment: {
    risk: RISK.CONFIRM, domain: 'finance',
    describe: (p) => {
      const o = Number(paymentDelta(p)) || 0;
      return 'Borç/Alacak ödemesi: ' + (p.id != null ? 'id=' + p.id : '"' + str(p.party_name, 40) + '"') +
        ' → ' + o.toLocaleString('tr-TR') + ' TL ödeme işle (kalan bakiye bu kadar düşer + otomatik gelir/gider kaydı)';
    },
    apply: (data, p) => {
      const x = findOne(data.debts, { id: p.id, match: p.party_name }, ['party_name', 'category'], 'Borç/Alacak');
      const odeme = Number(paymentDelta(p));
      if (!Number.isFinite(odeme) || odeme <= 0) throw new Error('odeme_tutari pozitif bir ödeme tutarı olmalı (bu seferki ödeme, toplam değil)');
      const tutar = Number(x.amount) || 0;
      const oncekiOdenen = Number(x.paid_amount) || 0;
      const oncekiKalan = round2(tutar - oncekiOdenen);
      x.paid_amount = round2(oncekiOdenen + odeme);
      x.update_date = todayISO();
      x.note = (x.note ? x.note + ' | ' : '') + '[' + todayISO() + ' Ajan] ' + odeme.toLocaleString('tr-TR') + ' TL ödeme';
      const yeniKalan = round2(tutar - x.paid_amount);

      // panelin recordDebtAutoTransaction'ı: Alacak -> Gelir, Borç -> Gider
      const not = '[Borç/Alacak] ' + x.party_name + ' — ödeme (Ajan)';
      if (x.type === 'Alacak') {
        data.incomes = data.incomes || [];
        data.incomes.unshift({ id: nextId(data.incomes), date: todayISO(), amount: odeme, category: 'Tahsilat', source: x.party_name, job_id: null, payment_method: str(p.payment_method, 40), note: not });
      } else {
        data.expenses = data.expenses || [];
        data.expenses.unshift({ id: nextId(data.expenses), date: todayISO(), amount: odeme, category: 'Borç Ödemesi', payee: x.party_name, job_id: null, payment_method: str(p.payment_method, 40), note: not });
      }
      const warn = yeniKalan < -1 ? '  ⚠️ FAZLA ÖDEME (kalan negatif — kontrol edin)' : '';
      return x.party_name + ' (' + x.type + ') · ' + odeme.toLocaleString('tr-TR') + ' TL ödeme + otomatik ' +
        (x.type === 'Alacak' ? 'Gelir' : 'Gider') + ' kaydı · kalan bakiye ' +
        oncekiKalan.toLocaleString('tr-TR') + ' → ' + yeniKalan.toLocaleString('tr-TR') + ' TL' + warn;
    },
  },
  add_job_payment: {
    risk: RISK.CONFIRM, domain: 'finance',
    describe: (p) => 'İşe tahsilat kaydı ekle: ' + (p.id != null ? 'iş id=' + p.id : p.job_no) + ' → ' + Number(p.amount || 0).toLocaleString('tr-TR') + ' TL (' + (p.category || 'Kalan Tahsilat') + ')',
    apply: (data, p) => {
      // Panelin gercek modeli: tahsilat = incomes icinde job_id bagli kayit.
      // deposit_received alani panelin guvenmedigi Excel artefakti - ona yazmiyoruz (S2).
      const j = findOne(data.jobs, { id: p.id, match: p.job_no || p.match }, ['job_no', 'title', 'customer_name_free'], 'İş');
      const amount = Number(p.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('amount pozitif sayı olmalı');
      const cat = statusMatch(['Kapora', 'Kalan Tahsilat', 'Peşin Ödeme', 'Diğer Gelir'], p.category) || 'Kalan Tahsilat';
      data.incomes = data.incomes || [];
      const id = nextId(data.incomes);
      const custName = (data.customers || []).find((c) => c.id === j.customer_id);
      data.incomes.unshift({
        id, date: isISODate(p.date) ? p.date : todayISO(), amount, category: cat,
        source: (custName && custName.name) || j.customer_name_free || '', job_id: j.id,
        payment_method: str(p.payment_method, 40), note: str(p.note, 200) || 'Ajan üzerinden',
      });
      return (j.job_no || 'İş #' + j.id) + ' işine ' + amount.toLocaleString('tr-TR') + ' TL tahsilat (gelir #' + id + ')';
    },
  },
  set_job_status: {
    risk: RISK.CONFIRM, domain: 'production',
    describe: (p) => 'İş durumu değiştir: ' + (p.id != null ? 'id=' + p.id : p.job_no) + ' → ' + p.status,
    apply: (data, p) => {
      const j = findOne(data.jobs, { id: p.id, match: p.job_no || p.match }, ['job_no', 'title', 'customer_name_free'], 'İş');
      const s = statusMatch(JOB_STATUSES, p.status);
      if (!s) throw new Error('Geçersiz iş durumu. Geçerli: ' + JOB_STATUSES.join(', '));
      j.status = s;
      return (j.job_no || 'İş #' + j.id) + ' → ' + j.status;
    },
  },
  delete_task: {
    risk: RISK.CONFIRM, domain: 'tasks',
    describe: (p) => 'Görev SİL: ' + (p.id != null ? '#' + p.id : '"' + str(p.match, 60) + '"'),
    apply: (data, p) => {
      const t = findOne(data.tasks, p, ['title', 'note'], 'Görev');
      data.tasks = data.tasks.filter((x) => x !== t);
      return 'Görev #' + t.id + ' silindi';
    },
  },
};

const ACTION_TYPES = Object.keys(ACTIONS);

function riskOf(type) { return ACTIONS[type] ? ACTIONS[type].risk : RISK.CONFIRM; }
function describe(type, params) {
  try { return ACTIONS[type] ? ACTIONS[type].describe(params || {}) : type; }
  catch (e) { return type; }
}

// Tek aksiyonu uygula. { type, params }. expectedUpdatedAt opsiyonel (cakisma korumasi).
// Donen: { ok, summary, updatedAt } ya da hata firlatir.
function applyAction(type, params, expectedUpdatedAt) {
  const def = ACTIONS[type];
  if (!def) throw new Error('Bilinmeyen aksiyon tipi: ' + type);
  const raw = store.readPanelRaw();
  if (!raw || !raw.data) throw new Error('panel-data.json yok.');
  const data = raw.data;
  const summary = def.apply(data, params || {});
  const updatedAt = store.writePanelData(data, expectedUpdatedAt != null ? expectedUpdatedAt : raw.updatedAt);
  return { ok: true, type, summary, updatedAt };
}

// KURU CALISMA: panel verisini KLONLA, aksiyonu uygula, ozeti dondur - KAYDETMEZ.
// Onay bekleyen aksiyonlarin kartinda "ne olacak" onizlemesi icin (kalan bakiye vb.).
function dryRun(type, params) {
  const def = ACTIONS[type];
  if (!def) throw new Error('Bilinmeyen aksiyon tipi: ' + type);
  const raw = store.readPanelRaw();
  if (!raw || !raw.data) throw new Error('panel-data.json yok.');
  const clone = JSON.parse(JSON.stringify(raw.data));
  return def.apply(clone, params || {}); // clone mutate olur, kaydedilmez
}

module.exports = {
  ACTIONS, ACTION_TYPES, RISK, riskOf, describe, applyAction, dryRun,
  MANAGERS, PROD_STATUSES, PIPELINE_STATUSES, JOB_STATUSES, INCOME_CATS,
};
