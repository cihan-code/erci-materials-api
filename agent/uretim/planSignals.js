'use strict';

// Renders the production plan as a verified table for the model - the production
// counterpart of metrics.js -> signals.js.
//
// Same contract as the rest of the agent: EVERY number here is computed by code.
// Raw panel JSON never reaches the model, and the model is told not to derive any
// figure of its own. Dates, day counts, capacities and delay sizes are all final.

const fs = require('fs');
const path = require('path');

const { buildProgressPlan } = require('./progress');
const { readReports } = require('./progressStore');
const { buildJobsFromPanel } = require('./panelAdapter');
const cal = require('./lib/calendar');
const { gunlukIs, onaylananParcaNotu } = require('./lib/isMetni');

const ROTA_FILE = path.join(__dirname, 'rota.json');

const DAY_TR = {
  monday: 'Pazartesi', tuesday: 'Salı', wednesday: 'Çarşamba', thursday: 'Perşembe',
  friday: 'Cuma', saturday: 'Cumartesi', sunday: 'Pazar',
};

function loadRota() {
  return JSON.parse(fs.readFileSync(ROTA_FILE, 'utf8'));
}

// Operations grouped the way the workshop thinks about them, so the sheet reads as
// stations rather than as a flat timeline. Same order as the panel tab and the PDF.
// Beyond this many days a finish estimate carries too much shared-queue
// uncertainty to print as a warning. Same horizon as the panel tab and the PDF.
const RISK_HORIZON_DAYS = 5;

const STATIONS = [
  ['Kumaş', ['fabric_order', 'fabric_arrival']],
  ['Kesim', ['cut_main', 'cut_extra_parts']],
  ['Baskı / Nakış', ['print_dropoff', 'print_work', 'embroidery_dropoff', 'embroidery_work']],
  ['Dikim', ['sewing_dropoff', 'sewing']],
  ['İlik / Düğme', ['buttonhole_button']],
  ['Ütü - Paket', ['iron_pack']],
  ['Teslimat', ['delivery']],
];

function stationOf(opId) {
  const hit = STATIONS.find(([, ids]) => ids.includes(opId));
  return hit ? hit[0] : 'Diğer';
}

// A markdown cell must not be split by a pipe, and an empty cell reads as a
// skipped line to whoever holds the sheet.
function cell(v) {
  if (v === null || v === undefined || v === '') return '—';
  return String(v).replace(/\|/g, '/').replace(/\n+/g, ' ');
}

// The finished table the model is told to paste verbatim. One row per
// (job x station), written as the work to be done - the model writes no part of
// it, so no quantity, date or operation can drift.
//
// An operation waiting on a preparation check is never rendered as an
// instruction; it becomes an explicit "başlatma" warning in the same row.
function todayTable(plan, today) {
  const groups = new Map();
  for (const it of plan.today_plan) {
    const key = it.job_id + '::' + stationOf(it.op_id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }

  const rows = [];
  for (const ops of groups.values()) {
    const first = ops[0];
    const ready = ops.filter((o) => o.actionable !== false);
    const waiting = ops.filter((o) => o.actionable === false);
    // gunlukIs returns the sentence itself.
    const done = ready.length ? gunlukIs(ready, today) : '';

    const notes = [];
    const confirmed = onaylananParcaNotu(ops);
    if (confirmed) notes.push(confirmed);
    if (waiting.length) notes.push('BAŞLATMA — teyit bekliyor: ' + gunlukIs(waiting, today));
    if (ops.some((o) => o.carried_over)) notes.push('Önceki günden kalan');
    if (ops.some((o) => o.progress_status === 'in_progress')) notes.push('Devam ediyor');
    ops.filter((o) => o.progress_note).forEach((o) => notes.push('Not: ' + o.progress_note));
    // A delivery date already passed is a fact and always shown. A finish estimate
    // is only worth a warning close to the deadline - further out the shared-queue
    // uncertainty marks every row and the sheet stops meaning anything.
    if (first.est_delivery) {
      const left = cal.diffDays(today, first.est_delivery);
      if (left < 0) notes.push('TESLİM ' + Math.abs(left) + ' GÜN GEÇTİ');
      else if (first.at_risk && left <= RISK_HORIZON_DAYS) notes.push('TESLİME ' + left + ' GÜN — RİSKLİ');
    }

    rows.push({
      station: stationOf(first.op_id),
      job_no: first.job_no || '#' + first.job_id,
      customer_name: first.customer_name,
      product_label: first.product_label,
      quantity: first.quantity,
      action: done || 'Hazırlık teyidi bekleniyor',
      note: notes.join(' · '),
    });
  }

  const L = [];
  for (const [station] of STATIONS) {
    const mine = rows.filter((r) => r.station === station);
    if (!mine.length) continue; // empty station heading is skipped, never left blank
    const qty = mine.reduce((a, r) => a + (Number(r.quantity) || 0), 0);
    L.push('### ' + station + ' — ' + mine.length + ' iş · ' + qty + ' adet');
    L.push('');
    L.push('| İş No | Müşteri | Ürün | Adet | Bugün yapılacak | Dikkat |');
    L.push('|---|---|---|---|---|---|');
    mine.forEach((r) => {
      L.push('| ' + [cell(r.job_no), cell(r.customer_name), cell(r.product_label),
        cell(r.quantity), cell(r.action), cell(r.note)].join(' | ') + ' |');
    });
    L.push('');
  }
  return L;
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
  const reports = options.progressReports || readReports(path.join(
    process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data'), 'uretim'));
  const plan = buildProgressPlan(rota, jobs, reports, today);
  return { rota, plan, needs_attention: [...needs_attention, ...plan.needs_attention.map((n) => {
    const job = jobs.find((j) => String(j.id) === String(n.job_id));
    return { ...n, job_no: job?.job_no, customer_name: job?.customer_name };
  })], sourceJobs: jobs };
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
      ' · sipariş ' + it.quantity + ' ' + it.product_label +
      ' → ' + it.label + parts +
      (it.progress_status === 'in_progress' ? ' · DEVAM EDİYOR' : '') +
      (it.readiness === 'confirmation_required' ? ' · BAŞLAMADAN ÖNCE TEYİT GEREKLİ' : '') +
      (it.readiness === 'blocked' ? ' · HAZIRLIK EKSİK — BAŞLATMA' : '') +
      (it.carried_over ? ' · ÖNCEKİ GÜNDEN KALAN (bildirim: ' + it.progress_date + ')' : '') +
      (it.progress_note ? ' · Not: ' + it.progress_note : '') +
      (it.at_risk ? ' · RİSKLİ' : ''));
  }
  L.push('');

  // The same rows again, already laid out. The prompt tells the model to paste
  // this block unchanged, so the day's list is a table nobody rewrote.
  L.push('## BUGÜN YAPILACAKLAR TABLOSU — AYNEN KOPYALA');
  L.push('Bu blok hazır. Satır ekleme, çıkarma, birleştirme; kelime veya sayı değiştirme.');
  L.push('Başlıklarıyla birlikte olduğu gibi brifinge koy.');
  L.push('');
  const table = todayTable(plan, today);
  if (table.length) {
    table.forEach((line) => L.push(line));
  } else {
    L.push('(bugün hiçbir istasyonda planlanan operasyon yok)');
    L.push('');
  }

  L.push('## KAYITLI ÜRETİM İLERLEMESİ');
  for (const row of plan.progress_rows) {
    L.push('- ' + (row.job_no || '#' + row.job_id) + ' · ' + row.op_label + ': ' +
      row.status_label +
      ' · son bildirim ' + row.date + (row.note ? ' · ' + row.note : ''));
  }
  L.push('Bildirilmeyen işlem tamamlanmış sayılmaz. Aşamalar siparişin bütünü için takip edilir.');
  L.push('Devam eden işlemlerin kalan süresi bilinmiyorsa tarihler ön tahmindir.');
  L.push('');
  L.push('## BUGÜN TEYİT EDİLECEK HAZIRLIKLAR');
  if (!plan.reminders.length) L.push('(bugün için açık hazırlık teyidi yok)');
  for (const row of plan.reminders) {
    L.push('- ' + (row.job_no || '#' + row.job_id) + ' · ' + row.customer_name + ': ' + row.message);
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
      (j.provisional ? '  [ÖN TAHMİN — açık teyit veya süre belirsizliği var]' : ''));
    L.push('- Durum: ' + riskLabel(j));
    if (src.problem_note) L.push('- Panelde kayıtlı problem: "' + src.problem_note + '"');

    const upcoming = j.timeline.filter((o) => o.start > today).slice(0, 6);
    if (upcoming.length) {
      L.push('- Sıradaki adımlar:');
      for (const o of upcoming) {
        const span = o.start === o.end ? o.start : o.start + '→' + o.end;
        L.push('    ' + span + '  ' + o.label);
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
