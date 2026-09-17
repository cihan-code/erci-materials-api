'use strict';

// Renders the production plan as a verified table for the model - the production
// counterpart of metrics.js -> signals.js.
//
// Same contract as the rest of the agent: EVERY number here is computed by code.
// Raw panel JSON never reaches the model, and the model is told not to derive any
// figure of its own. Dates, day counts, capacities and delay sizes are all final.

const fs = require('fs');
const path = require('path');

const { buildPlan } = require('./scheduler');
const { buildJobsFromPanel } = require('./panelAdapter');
const cal = require('./lib/calendar');

const ROTA_FILE = path.join(__dirname, 'rota.json');

const DAY_TR = {
  monday: 'Pazartesi', tuesday: 'Salı', wednesday: 'Çarşamba', thursday: 'Perşembe',
  friday: 'Cuma', saturday: 'Cumartesi', sunday: 'Pazar',
};

const PLACE_TR = {
  internal: 'iç',
  subcontractor: 'fason',
  supplier: 'tedarikçi',
};

function loadRota() {
  return JSON.parse(fs.readFileSync(ROTA_FILE, 'utf8'));
}

function place(loc) {
  return loc ? (PLACE_TR[loc] || loc) : '—';
}

function jobTag(j) {
  return j.job_no ? '[' + j.job_no + ']' : '[#' + j.job_id + ']';
}

function riskLabel(j) {
  if (!j.est_delivery) return 'teslim tarihi yok';
  if (j.at_risk) {
    const worst = j.days_late_latest;
    const best = j.days_late_earliest;
    if (best > 0) return 'GECİKME: ' + best + '-' + worst + ' gün geç';
    return 'RİSKLİ: iyi ihtimalle ' + Math.abs(best) + ' gün erken, kötü ihtimalle ' + worst + ' gün geç';
  }
  const margin = Math.abs(j.days_late_latest);
  return 'akışta (' + margin + ' gün pay)';
}

// data = the `data` object inside panel-data.json
function buildProductionPlan(data, today, opts) {
  const rota = loadRota();
  const options = opts || {};
  const { jobs, needs_attention } = buildJobsFromPanel(rota, data, {
    confirmations: options.confirmations || {},
  });
  const plan = buildPlan(rota, jobs, today);
  return { rota, plan, needs_attention, sourceJobs: jobs };
}

function renderPlanText(built, today, panelUpdatedAt) {
  const { rota, plan, needs_attention } = built;
  const L = [];
  const dayName = DAY_TR[cal.dayName(today)] || '';

  L.push('# DOĞRULANMIŞ ÜRETİM PLANI TABLOSU — ' + today + ' (' + dayName + ')');
  L.push('Panel verisi updatedAt: ' + (panelUpdatedAt || 'bilinmiyor'));
  L.push('Planlanan aktif iş: ' + plan.jobs.length);
  L.push('');
  L.push('KURAL: Aşağıdaki tüm tarih, gün sayısı, adet ve kapasite değerleri backend tarafından');
  L.push('hesaplandı. Yeni tarih, gün farkı, toplam veya oran HESAPLAMA. Tabloda olmayan hiçbir');
  L.push('sayıyı yazma.');
  L.push('');

  // ---------------- today's operations ----------------
  L.push('## BUGÜN YAPILACAK OPERASYONLAR — ' + plan.today_plan.length + ' kalem');
  if (!plan.today_plan.length) {
    L.push('(bugün için planlanmış operasyon yok)');
  }
  for (const it of plan.today_plan) {
    // The operation label already names the pieces (expandRoute builds it that way),
    // so only append them when they would add something.
    const partsText = (it.parts || []).join(', ');
    const parts = partsText && !it.label.includes(partsText) ? ' — parçalar: ' + partsText : '';
    L.push('- ' + (it.job_no ? '[' + it.job_no + '] ' : '') + it.customer_name +
      ' · ' + it.quantity + ' ' + it.product_label +
      ' → ' + it.label + ' (' + place(it.location) + ')' + parts +
      (it.at_risk ? ' · RİSKLİ' : ''));
  }
  L.push('');

  // ---------------- per job ----------------
  L.push('## İŞ BAZLI PLAN');
  for (const j of plan.jobs) {
    const src = built.sourceJobs.find((s) => s.id === j.job_id) || {};
    L.push('');
    L.push('### ' + jobTag(j) + ' ' + j.customer_name + ' · ' + j.quantity + ' ' + j.product_label);
    L.push('- Şu anki aşama: ' + (src.panel_stage || 'BİLİNMİYOR') +
      ' (kaynak: ' + (src.stage_source || 'bilinmiyor') + ')');
    L.push('- Teslim sözü: ' + (j.est_delivery || '—'));
    L.push('- Tahmini bitiş: ' + j.finish_earliest + ' … ' + j.finish_latest +
      (j.provisional ? '  [ÖN TAHMİN — cevaplanmamış soru var]' : ''));
    L.push('- Durum: ' + riskLabel(j));
    if (src.problem_note) L.push('- Panelde kayıtlı problem: "' + src.problem_note + '"');

    const upcoming = j.timeline.filter((o) => o.start > today).slice(0, 6);
    if (upcoming.length) {
      L.push('- Sıradaki adımlar:');
      for (const o of upcoming) {
        const span = o.start === o.end ? o.start : o.start + '→' + o.end;
        L.push('    ' + span + '  ' + o.label + ' (' + place(o.location) + ')');
      }
    }
    if (j.blockers.length) {
      for (const b of j.blockers) L.push('- BLOKAJ: ' + b.message);
    }
    if (j.open_questions.length) {
      L.push('- CEVAP BEKLİYOR: ' + j.open_questions.join(' / '));
    }
  }
  L.push('');

  // ---------------- sewing load ----------------
  const sewingJobs = plan.jobs
    .map((j) => ({ j, op: j.timeline.find((o) => o.op_id === 'sewing') }))
    .filter((x) => x.op);
  L.push('## DİKİM ATÖLYESİ YÜKÜ (paylaşımlı kapasite)');
  if (!sewingJobs.length) {
    L.push('(dikim sırasında iş yok)');
  } else {
    L.push('Kapasite atölyenin TOPLAMIDIR, işler paylaşır. Ürün başına günlük kapasite:');
    const caps = [...new Set(sewingJobs.map((x) => x.j.product_label + ' ' + x.op.capacity_per_day + '/gün'))];
    L.push('  ' + caps.join(' · '));
    for (const { j, op } of sewingJobs) {
      L.push('- ' + jobTag(j) + ' ' + j.customer_name + ' · ' + j.quantity + ' adet · dikim ' +
        op.start + '→' + op.end);
    }
  }
  L.push('');

  // ---------------- attention ----------------
  L.push('## EŞLEŞTİRİLEMEYEN / EKSİK VERİ — ' + needs_attention.length + ' kayıt');
  if (!needs_attention.length) {
    L.push('(yok)');
  }
  for (const n of needs_attention) {
    L.push('- ' + (n.job_no ? '[' + n.job_no + '] ' : '') + n.customer_name + ': ' + n.message);
  }
  L.push('');

  // ---------------- data confidence ----------------
  L.push('## VERİ GÜVENİ');
  L.push('- Dikim kapasitesi ortalamadır (±%20 dalgalanır) — tahminler yaklaşıktır, "≈" kullan.');
  L.push('- Baskı 1-3, nakış 1-2 iş günü aralığıdır; iki uç iyi/kötü senaryoyu verir.');
  L.push('- Panelde üretim kaydı işlere bağlı değil; aşama yalnız tek ve kesin eşleşmede alındı.');
  L.push('  "BİLİNMİYOR" yazan işlerde plan baştan kurulmuştur, gerçekte daha ileride olabilir.');
  const provisional = plan.jobs.filter((j) => j.provisional).length;
  if (provisional) {
    L.push('- ' + provisional + ' işte cevaplanmamış soru var; o işlerin tahmini ÖN TAHMİNDİR.');
  }
  const unknowns = [...new Set(plan.jobs.flatMap((j) => j.unknowns))];
  if (unknowns.length) {
    L.push('- Tanımsız süreler: ' + unknowns.join(' | '));
  }
  L.push('- Rota sürümü: rota.json v' + rota.version);

  return L.join('\n');
}

// Entry point used by generate.js
function buildPlanSignals(data, today, opts) {
  const built = buildProductionPlan(data, today, opts);
  return renderPlanText(built, today, (opts && opts.panelUpdatedAt) || null);
}

module.exports = { buildPlanSignals, buildProductionPlan, renderPlanText, loadRota };
