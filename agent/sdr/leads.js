// Satis Ajani lead kayitlari - panel-data.json icindeki data.leads[] uzerinde.
// TUM yazmalar store.writePanelData'dan (tek atomik yol). Confirm-gated.
// Model burada UYDURMA yapmaz: normalizeCandidate sadece SEKIL temizler, alan uretmez.

const store = require('../store');
const { nextId, todayISO, round2 } = require('../lib/util');
const { LEAD_STATUSES, LEAD_TYPES, LEAD_PRIORITY, PIPELINE_STATUSES } = require('../lib/enums');

const SALES_OWNER = 'Mert Kıvanç Tekin'; // Q4: leadler Kıvanç'a

function normStr(v) { return v == null ? null : (String(v).trim() || null); }
function normArr(v) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => normStr(x)).filter(Boolean);
}
function normUrl(v) {
  const s = normStr(v);
  if (!s) return null;
  return /^https?:\/\//i.test(s) ? s : ('https://' + s.replace(/^\/+/, ''));
}
function normKey(s) {
  return String(s || '').toLocaleLowerCase('tr').replace(/[İıI]/g, 'i').replace(/[^a-z0-9ğüşöç]+/g, ' ').trim();
}

// Model ciktisindaki bir adayi normalize et (alan URETMEZ; eksik = null/[]).
function normalizeCandidate(raw) {
  raw = raw || {};
  const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : null; };
  return {
    kurum_adi: normStr(raw.kurum_adi),
    kurum_tipi: LEAD_TYPES.includes(raw.kurum_tipi) ? raw.kurum_tipi : 'Diğer',
    sektor: normStr(raw.sektor),
    sehir: normStr(raw.sehir),
    website: normUrl(raw.website),
    instagram: normUrl(raw.instagram),
    linkedin: normUrl(raw.linkedin),
    sosyal_ozet: normStr(raw.sosyal_ozet),
    emails: normArr(raw.emails),
    phones: normArr(raw.phones),
    ilgili_kisiler: Array.isArray(raw.ilgili_kisiler)
      ? raw.ilgili_kisiler.map((k) => ({
        ad: normStr(k && k.ad), unvan: normStr(k && k.unvan),
        email: normStr(k && k.email), kaynak: normUrl(k && k.kaynak),
      })).filter((k) => k.ad || k.email)
      : [],
    potansiyel_puan: (() => { const n = Number(raw.potansiyel_puan); return Number.isFinite(n) ? Math.max(1, Math.min(10, Math.round(n))) : null; })(),
    oncelik: LEAD_PRIORITY.includes(raw.oncelik) ? raw.oncelik : null,
    tahmini_siparis_adet: num(raw.tahmini_siparis_adet),
    tahmini_urun: normStr(raw.tahmini_urun),
    neden_uygun: normStr(raw.neden_uygun),
    kaynaklar: normArr(raw.kaynaklar).map(normUrl).filter(Boolean),
    confidence: (raw.confidence && typeof raw.confidence === 'object') ? raw.confidence : {},
  };
}

function listLeads(data, f = {}) {
  let list = Array.isArray(data && data.leads) ? data.leads.slice() : [];
  if (f.status) list = list.filter((l) => l.durum === f.status);
  if (f.city) list = list.filter((l) => normKey(l.sehir) === normKey(f.city));
  if (f.priority) list = list.filter((l) => l.oncelik === f.priority);
  return list;
}
function getLead(data, id) {
  return (Array.isArray(data && data.leads) ? data.leads : []).find((l) => l.id === Number(id)) || null;
}

// Aday listesini data.leads'e yaz. Mevcut lead / musteri adiyla cakisanlari ATLA.
function commitLeads(candidates, input) {
  input = input || {};
  if (input.confirm !== true) throw new Error('confirm=true gerekli.');
  const arr = Array.isArray(candidates) ? candidates : [];
  if (!arr.length) throw new Error('aday listesi boş.');

  const raw = store.readPanelRaw();
  if (!raw || !raw.data) throw new Error('panel-data.json yok.');
  const data = raw.data;
  data.leads = Array.isArray(data.leads) ? data.leads : [];

  const existingKeys = new Set([
    ...data.leads.map((l) => normKey(l.kurum_adi)),
    ...(data.customers || []).map((c) => normKey(c.name)),
  ].filter(Boolean));

  const created = [];
  const skipped = [];
  arr.forEach((cand) => {
    const c = normalizeCandidate(cand);
    if (!c.kurum_adi) { skipped.push({ kurum_adi: null, reason: 'kurum adı yok' }); return; }
    const key = normKey(c.kurum_adi);
    if (existingKeys.has(key)) { skipped.push({ kurum_adi: c.kurum_adi, reason: 'zaten kayıtlı (lead/müşteri)' }); return; }
    existingKeys.add(key);
    const id = nextId(data.leads);
    data.leads.unshift(Object.assign({
      id,
      created_date: todayISO(),
      source_query: normStr(input.source_query),
      durum: 'Yeni',
      assigned_to: SALES_OWNER,
      mail_taslagi: null,
      gonderilen_mailler: [],
      yanitlar: [],
      followup_tarihi: null,
      pipeline_id: null,
      customer_id: null,
      note: null,
    }, c));
    created.push(id);
  });

  if (!created.length) {
    return { created: [], skipped, updatedAt: raw.updatedAt };
  }
  const updatedAt = store.writePanelData(data, raw.updatedAt);
  return { created, skipped, updatedAt };
}

// Genel guncelleme (durum / taslak / not / followup). Confirm-gated.
function updateLead(id, patch, input) {
  input = input || {};
  if (input.confirm !== true) throw new Error('confirm=true gerekli.');
  const raw = store.readPanelRaw();
  if (!raw || !raw.data) throw new Error('panel-data.json yok.');
  const data = raw.data;
  const lead = getLead(data, id);
  if (!lead) throw new Error('Lead bulunamadı: ' + id);

  if (patch.durum !== undefined) {
    if (!LEAD_STATUSES.includes(patch.durum)) throw new Error('Geçersiz durum: ' + patch.durum);
    lead.durum = patch.durum;
  }
  if (patch.followup_tarihi !== undefined) {
    lead.followup_tarihi = /^\d{4}-\d{2}-\d{2}$/.test(String(patch.followup_tarihi || '')) ? patch.followup_tarihi : null;
  }
  if (patch.note !== undefined) lead.note = normStr(patch.note);
  if (patch.assigned_to !== undefined) lead.assigned_to = normStr(patch.assigned_to) || SALES_OWNER;

  if (patch.mail_taslagi !== undefined) {
    const m = patch.mail_taslagi;
    lead.mail_taslagi = (m && (m.konu || m.govde))
      ? { konu: normStr(m.konu), govde: normStr(m.govde), olusturuldu: new Date().toISOString() }
      : null;
    if (lead.mail_taslagi && lead.durum === 'Yeni') lead.durum = 'Mail Hazır';
    if (lead.mail_taslagi && lead.durum === 'Araştırıldı') lead.durum = 'Mail Hazır';
  }
  if (patch.mark_sent === true) {
    if (!lead.mail_taslagi) throw new Error('Gönderilecek mail taslağı yok.');
    lead.gonderilen_mailler = lead.gonderilen_mailler || [];
    lead.gonderilen_mailler.unshift({
      tarih: todayISO(),
      konu: (patch.konu != null ? normStr(patch.konu) : lead.mail_taslagi.konu),
      kanal: normStr(patch.kanal) || 'email (manuel)',
    });
    lead.durum = 'Mail Gönderildi';
    if (!lead.followup_tarihi) {
      const d = new Date(); d.setDate(d.getDate() + 5);
      lead.followup_tarihi = d.toISOString().slice(0, 10);
    }
  }

  lead.updated_at = new Date().toISOString();
  const updatedAt = store.writePanelData(data, raw.updatedAt);
  return { ok: true, lead, updatedAt };
}

// Lead -> pipeline (Potansiyel İşler). Mevcut CRM akisi devralir.
function convertToPipeline(id, input) {
  input = input || {};
  if (input.confirm !== true) throw new Error('confirm=true gerekli.');
  const raw = store.readPanelRaw();
  if (!raw || !raw.data) throw new Error('panel-data.json yok.');
  const data = raw.data;
  const lead = getLead(data, id);
  if (!lead) throw new Error('Lead bulunamadı: ' + id);
  if (lead.pipeline_id) return { ok: true, pipelineId: lead.pipeline_id, alreadyLinked: true };

  data.pipeline = Array.isArray(data.pipeline) ? data.pipeline : [];
  const pid = nextId(data.pipeline);
  data.pipeline.unshift({
    id: pid,
    date: todayISO(),
    customer_name: lead.kurum_adi,
    description: normStr(input.description) || lead.tahmini_urun || 'Özel tekstil',
    est_quantity: lead.tahmini_siparis_adet || 0,
    est_unit_price: round2(Number(input.est_unit_price) || 0),
    probability: 0.1,
    status: PIPELINE_STATUSES.includes(input.status) ? input.status : 'Potansiyel',
    follow_up_date: lead.followup_tarihi || null,
    note: '[SDR lead #' + lead.id + '] ' + (lead.neden_uygun || ''),
  });
  lead.pipeline_id = pid;
  if (['Yeni', 'Araştırıldı', 'Mail Hazır', 'Mail Gönderildi', 'Yanıt Var'].includes(lead.durum)) {
    lead.durum = 'Görüşülüyor';
  }
  lead.updated_at = new Date().toISOString();
  const updatedAt = store.writePanelData(data, raw.updatedAt);
  return { ok: true, pipelineId: pid, updatedAt };
}

// Lead'i tamamen sil (yanlis/test kaydi). panel-data'dan cikarir.
function deleteLead(id) {
  const raw = store.readPanelRaw();
  if (!raw || !raw.data) throw new Error('panel-data.json yok.');
  const data = raw.data;
  data.leads = Array.isArray(data.leads) ? data.leads : [];
  const before = data.leads.length;
  data.leads = data.leads.filter((l) => l.id !== Number(id));
  if (data.leads.length === before) return { deleted: 0 };
  const updatedAt = store.writePanelData(data, raw.updatedAt);
  return { deleted: 1, updatedAt };
}

module.exports = {
  SALES_OWNER, normalizeCandidate, normKey,
  listLeads, getLead, commitLeads, updateLead, convertToPipeline, deleteLead,
};
