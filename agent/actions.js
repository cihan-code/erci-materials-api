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

function todayISO() { return new Date().toISOString().slice(0, 10); }
function nextId(arr) {
  let mx = 0;
  (arr || []).forEach((x) => { const n = Number(x && x.id); if (Number.isFinite(n) && n > mx) mx = n; });
  return mx + 1;
}
function str(v, max) { return v == null ? '' : String(v).slice(0, max || 300); }
function isISODate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }

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
      if (p.date && !isISODate(p.date)) throw new Error('date YYYY-MM-DD olmali');
      data.tasks = data.tasks || [];
      const id = nextId(data.tasks);
      data.tasks.unshift({
        id, title: str(p.title, 200), note: str(p.note, 500),
        assigned_to: p.assigned_to && MANAGERS.find((m) => m.toLowerCase().includes(String(p.assigned_to).toLowerCase())) || p.assigned_to || '',
        created_by: 'Yönetim Ajanı', date: p.date || todayISO(),
        done: false, carried_forward: false, carried_from: null,
        created_date: todayISO(),
      });
      return 'Görev #' + id + ' eklendi';
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
      const t = findOne(data.tasks, p, ['title', 'note'], 'Görev');
      t.assigned_to = MANAGERS.find((m) => m.toLowerCase().includes(String(p.assigned_to).toLowerCase())) || p.assigned_to;
      return 'Görev #' + t.id + ' → ' + t.assigned_to;
    },
  },
  set_task_date: {
    risk: RISK.SAFE, domain: 'tasks',
    describe: (p) => 'Görev tarihi: ' + (p.id != null ? '#' + p.id : '"' + str(p.match, 60) + '"') + ' → ' + p.date,
    apply: (data, p) => {
      if (!isISODate(p.date)) throw new Error('date YYYY-MM-DD olmali');
      const t = findOne(data.tasks, p, ['title', 'note'], 'Görev');
      t.date = p.date;
      return 'Görev #' + t.id + ' tarihi → ' + p.date;
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
      if (!isISODate(p.est_delivery)) throw new Error('est_delivery YYYY-MM-DD olmali');
      const u = findOne(data.uretimTakip, p, ['customer_name', 'note'], 'Üretim kaydı');
      u.est_delivery = p.est_delivery;
      return 'Üretim (' + (u.customer_name || u.id) + ') tah. teslim → ' + p.est_delivery;
    },
  },
  set_pipeline_followup: {
    risk: RISK.SAFE, domain: 'sales',
    describe: (p) => 'Fırsat takip tarihi: ' + (p.id != null ? 'id=' + p.id : '"' + str(p.customer_name, 40) + '"') + ' → ' + p.follow_up_date,
    apply: (data, p) => {
      if (!isISODate(p.follow_up_date)) throw new Error('follow_up_date YYYY-MM-DD olmali');
      const pl = findOne(data.pipeline, p, ['customer_name', 'description', 'note'], 'Fırsat');
      pl.follow_up_date = p.follow_up_date;
      if (p.note !== undefined) pl.note = str(p.note, 300);
      return 'Fırsat (' + (pl.customer_name || pl.id) + ') takip → ' + p.follow_up_date;
    },
  },
  set_pipeline_status: {
    risk: RISK.SAFE, domain: 'sales',
    describe: (p) => 'Fırsat durumu: ' + (p.id != null ? 'id=' + p.id : '"' + str(p.customer_name, 40) + '"') + ' → ' + p.status,
    apply: (data, p) => {
      const pl = findOne(data.pipeline, p, ['customer_name', 'description', 'note'], 'Fırsat');
      const s = statusMatch(PIPELINE_STATUSES, p.status);
      if (!s) throw new Error('Geçersiz fırsat durumu. Geçerli: ' + PIPELINE_STATUSES.join(', '));
      pl.status = s;
      return 'Fırsat (' + (pl.customer_name || pl.id) + ') → ' + pl.status;
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
      if (!isISODate(p.takip_tarihi)) throw new Error('takip_tarihi YYYY-MM-DD olmali');
      const o = findOne(data.okulTakip, { id: p.id, match: p.okul_adi || p.match }, ['okul_adi'], 'Okul kaydı');
      o.takip_tarihi = p.takip_tarihi;
      if (p.gorusme_durumu !== undefined) o.gorusme_durumu = str(p.gorusme_durumu, 80);
      return 'Okul (' + o.okul_adi + ') takip → ' + p.takip_tarihi;
    },
  },

  // ---------------- CONFIRM (finansal / kritik / silme) ----------------
  add_income: {
    risk: RISK.CONFIRM, domain: 'finance',
    describe: (p) => 'GELİR kaydı ekle: ' + Number(p.amount || 0).toLocaleString('tr-TR') + ' TL — ' + str(p.source, 40) + ' (' + (p.category || 'Diğer Gelir') + ')',
    apply: (data, p) => {
      const amount = Number(p.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('amount pozitif sayi olmali');
      data.incomes = data.incomes || [];
      const id = nextId(data.incomes);
      data.incomes.unshift({
        id, date: isISODate(p.date) ? p.date : todayISO(), amount,
        category: str(p.category, 40) || 'Diğer Gelir', source: str(p.source, 120),
        job_id: p.job_id || null, payment_method: str(p.payment_method, 40), note: str(p.note, 300),
      });
      return 'Gelir #' + id + ' eklendi (' + amount.toLocaleString('tr-TR') + ' TL)';
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
  update_debt_payment: {
    risk: RISK.CONFIRM, domain: 'finance',
    describe: (p) => 'Borç/Alacak ödeme güncelle: ' + (p.id != null ? 'id=' + p.id : '"' + str(p.party_name, 40) + '"') + ' → ödenen ' + Number(p.paid_amount || 0).toLocaleString('tr-TR') + ' TL',
    apply: (data, p) => {
      const x = findOne(data.debts, { id: p.id, match: p.party_name }, ['party_name', 'category'], 'Borç/Alacak');
      const paid = Number(p.paid_amount);
      if (!Number.isFinite(paid) || paid < 0) throw new Error('paid_amount 0 veya pozitif olmali');
      x.paid_amount = paid;
      x.update_date = todayISO();
      return x.party_name + ' ödenen tutar → ' + paid.toLocaleString('tr-TR') + ' TL';
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

module.exports = { ACTIONS, ACTION_TYPES, RISK, riskOf, describe, applyAction, MANAGERS, PROD_STATUSES, PIPELINE_STATUSES, JOB_STATUSES };
