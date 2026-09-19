'use strict';

// Turns raw panel data (panel-data.json) into scheduler jobs.
//
// Where each field comes from:
//   product / quantity / delivery / decoration   <- data.jobs        (reliable)
//   where the job currently is in production     <- data.uretimTakip (needs matching)
//
// The panel does not link the two lists: a uretimTakip record carries no job_id
// and no product, and its customer_name field is really a free-text description.
// See linkProductionRecords below for how the two are paired, and why a doubtful
// pairing is reported as a question rather than guessed.

const { optionsFromPanelJob } = require('./scheduler');

const ACTIVE_JOB_STATUSES = ['Onaylandı', 'Üretimde'];

// Which route operations are already behind a job sitting at a given panel stage.
// The stage names come from agent/lib/enums.js URETIM_STATUSES.
const STAGE_COMPLETED = {
  'Kumaş Bekleniyor': ['fabric_order'],
  'Kumaş Geldi': ['fabric_order', 'fabric_arrival'],
  'Kesimde': ['fabric_order', 'fabric_arrival'],
  'Baskı/Nakışta': ['fabric_order', 'fabric_arrival', 'cut_main', 'cut_extra_parts',
    'print_dropoff', 'embroidery_dropoff'],
  'Dikimde': ['fabric_order', 'fabric_arrival', 'cut_main', 'cut_extra_parts',
    'print_dropoff', 'print_work', 'embroidery_dropoff', 'embroidery_work', 'sewing_dropoff'],
  'Ütü-Pakette-Teslimat Bekliyor': ['fabric_order', 'fabric_arrival', 'cut_main', 'cut_extra_parts',
    'print_dropoff', 'print_work', 'embroidery_dropoff', 'embroidery_work', 'sewing_dropoff',
    'sewing', 'buttonhole_button'],
};

// Turkish-aware normalisation so "Tişört", "TİŞÖRT" and "tisort" all compare equal.
function normalize(s) {
  return String(s == null ? '' : s)
    .replace(/İ/g, 'i').replace(/I/g, 'i').replace(/ı/g, 'i')
    .toLowerCase()
    .replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's')
    .replace(/ö/g, 'o').replace(/ç/g, 'c')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Free-text product_type -> rota product key, via the alias table in rota.json.
function matchProduct(rota, productType) {
  const q = normalize(productType);
  if (!q) return null;
  let best = null;
  for (const [key, product] of Object.entries(rota.products)) {
    const candidates = [product.label, key, ...(product.aliases || [])];
    for (const c of candidates) {
      const n = normalize(c);
      if (!n) continue;
      if (q === n) return key;                       // exact wins outright
      if (q.includes(n) && (!best || n.length > best.len)) best = { key, len: n.length };
    }
  }
  return best ? best.key : null;
}

function customerNameOf(job, customers) {
  if (job.customer_id != null) {
    const c = (customers || []).find((x) => x.id === job.customer_id);
    if (c && c.name) return c.name;
  }
  return job.customer_name_free || '';
}

// Link production records to jobs.
//
// Real panel data showed uretimTakip.customer_name is NOT a customer name - it is a
// free-text job description that usually embeds the customer ("SAU TECH Tişört") and
// sometimes a project name instead ("İTÜ İlk 1000 Tişört"). Exact equality therefore
// never matches. We look for the customer name INSIDE the description, and demand an
// exact quantity match plus mutual uniqueness before adopting a stage - a wrong stage
// yields a confidently wrong plan, which is worse than admitting we do not know.
function linkProductionRecords(rota, activeJobs, openProduction, customers) {
  const pairs = [];

  for (const job of activeJobs) {
    const name = normalize(customerNameOf(job, customers));
    if (!name) continue;
    const productKey = matchProduct(rota, job.product_type);
    const aliases = productKey
      ? [rota.products[productKey].label, ...(rota.products[productKey].aliases || [])].map(normalize)
      : [];

    for (const rec of openProduction) {
      const text = normalize(rec.customer_name);
      if (!text.includes(name)) continue;
      const jq = Number(job.quantity);
      const rq = Number(rec.quantity);
      const quantityMatches = Number.isFinite(jq) && Number.isFinite(rq) && jq > 0 && jq === rq;
      const productMentioned = aliases.some((a) => a && text.includes(a));
      pairs.push({ job, rec, quantityMatches, productMentioned });
    }
  }

  const links = new Map();
  const solid = pairs.filter((p) => p.quantityMatches);

  for (const p of solid) {
    const otherJobs = solid.filter((x) => x.job === p.job);
    const otherRecs = solid.filter((x) => x.rec === p.rec);
    if (otherJobs.length === 1 && otherRecs.length === 1) {
      links.set(p.job, { record: p.rec, reason: null });
    }
  }

  for (const job of activeJobs) {
    if (links.has(job)) continue;
    const mine = pairs.filter((p) => p.job === job);
    let reason;
    if (!mine.length) {
      reason = 'adı geçen açık üretim kaydı yok';
    } else if (!mine.some((p) => p.quantityMatches)) {
      reason = 'aday üretim kaydı var ama adetler tutmuyor (' + job.quantity + ' adet)';
    } else {
      reason = 'birden fazla aday eşleşiyor - hangisi olduğu belirsiz';
    }
    links.set(job, { record: null, reason });
  }
  return links;
}

// panelData is the `data` object inside panel-data.json.
function buildJobsFromPanel(rota, panelData, opts) {
  const options = opts || {};
  const confirmations = options.confirmations || {};
  const data = panelData || {};
  const customers = data.customers || [];

  const activeJobs = (data.jobs || []).filter((j) => ACTIVE_JOB_STATUSES.includes(j.status));
  const openProduction = (data.uretimTakip || []).filter((u) => u.status !== 'Teslim Edildi');

  const links = linkProductionRecords(rota, activeJobs, openProduction, customers);

  const jobs = [];
  const needsAttention = [];

  for (const job of activeJobs) {
    const name = customerNameOf(job, customers);
    const productKey = matchProduct(rota, job.product_type);

    if (!productKey) {
      needsAttention.push({
        job_id: job.id,
        job_no: job.job_no || null,
        customer_name: name,
        kind: 'product_unknown',
        message: 'Ürün tipi "' + (job.product_type || '(boş)') + '" rotadaki ürünlerle eşleşmedi - hangi ürün?',
      });
      continue;
    }

    const match = links.get(job) || { record: null, reason: 'eşleştirme yapılmadı' };
    const stage = match.record ? match.record.status : null;
    const completed = stage ? (STAGE_COMPLETED[stage] || []) : [];

    if (!match.record && job.status === 'Üretimde') {
      needsAttention.push({
        job_id: job.id,
        job_no: job.job_no || null,
        customer_name: name,
        kind: 'stage_unknown',
        message: 'İş üretimde ama hangi aşamada olduğu belirlenemedi (' + match.reason +
          ') - plan baştan kuruldu, aşamayı bildirin.',
      });
    }

    jobs.push({
      id: job.id,
      job_no: job.job_no || null,
      customer_name: name || '(müşteri adı yok)',
      product: productKey,
      quantity: Number(job.quantity) || 0,
      est_delivery: (match.record && match.record.est_delivery) || job.delivery_date || null,
      options: optionsFromPanelJob(job, confirmations[job.id] || {}),
      completed_operations: completed,
      panel_stage: stage,
      stage_source: stage ? 'uretimTakip' : 'bilinmiyor',
      production_record_id: match.record ? match.record.id : null,
      problem_note: (match.record && match.record.problem_note) || null,
    });
  }

  return { jobs, needs_attention: needsAttention };
}

module.exports = {
  buildJobsFromPanel,
  linkProductionRecords,
  matchProduct,
  normalize,
  customerNameOf,
  STAGE_COMPLETED,
  ACTIVE_JOB_STATUSES,
};
