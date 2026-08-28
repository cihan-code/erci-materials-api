// "Ajana soyle" akisi:
//   1. Ilgili domain sinyallerini cikar (ham JSON GITMEZ)
//   2. Haiku'ya TEK cagri (structured output) -> { reply, actions:[{type,params,reason}] }
//   3. safe aksiyonlari uygula, confirm aksiyonlari "pending" olarak dondur
//   4. IKINCI CLAUDE CAGRISI YOK - backend dogrudan sonuc doner
//
// Onay gereken (finansal/silme/kritik) aksiyonlar kullanici panelde "Onayla" deyince
// /api/agent/act/confirm ile dogrudan uygulanir (yine Claude cagrisi yok).

const fs = require('fs');
const path = require('path');
const store = require('./store');
const { buildSignals } = require('./signals');
const { callClaude } = require('./claude');
const actions = require('./actions');
const { HAIKU } = require('./pricing');

const SYSTEM = fs.readFileSync(path.join(__dirname, 'prompts', 'act.md'), 'utf8');

// Structured output semasi: params bir JSON STRING (sema kisitlari icinde serbest nesne tutamayiz).
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'actions'],
  properties: {
    reply: { type: 'string' },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'params_json', 'reason'],
        properties: {
          type: { type: 'string', enum: actions.ACTION_TYPES },
          params_json: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
  },
};

function pickDomains(instruction) {
  const s = String(instruction || '').toLowerCase();
  const set = new Set();
  if (/gorev|görev|task|yapılacak|atama|ata /.test(s)) set.add('tasks');
  if (/uretim|üretim|kesim|dikim|teslim|kargo|nakış|baskı|production/.test(s)) set.add('production');
  if (/firsat|fırsat|pipeline|teklif|takip|okul|satış|satis|müşteri aday/.test(s)) set.add('sales');
  if (/müşteri|musteri|customer|not ekle|iletişim/.test(s)) set.add('crm');
  if (/gelir|gider|ödeme|odeme|tahsilat|borç|borc|alacak|kapora|fatura|nakit|finans/.test(s)) set.add('finance');
  if (set.size === 0) { set.add('tasks'); set.add('production'); set.add('sales'); }
  return Array.from(set);
}

// instruction: kullanici metni. Donen: { reply, applied:[], pending:[], errors:[], usage }
async function interpretAndAct(instruction) {
  const text = String(instruction || '').trim();
  if (!text) throw new Error('instruction bos.');
  if (text.length > 2000) throw new Error('instruction cok uzun (max 2000).');

  const { data, updatedAt } = store.loadPanelData();
  if (!data) throw new Error('panel-data.json yok - once panelden veri kaydedilmeli.');

  const today = process.env.PANEL_TODAY || new Date().toISOString().slice(0, 10);
  const domains = pickDomains(text);
  const signals = buildSignals(data, today, domains);

  const user = [
    'Bugün: ' + today,
    '',
    '## İlgili panel sinyalleri (' + domains.join(', ') + ')',
    signals,
    '',
    '## Yöneticinin isteği',
    text,
    '',
    'İsteği yerine getirmek için gereken aksiyonları çıkar. Kayıtları yukarıdaki sinyallerdeki'
    + ' id değerleriyle eşleştir. Emin olmadığın veya sinyalde olmayan bir kayıt için aksiyon'
    + ' üretme; reply alanında nedenini yaz.',
  ].join('\n');

  const resp = await callClaude({
    model: HAIKU,
    opType: 'act',
    system: SYSTEM,
    user,
    maxTokens: 2000,
    schema: SCHEMA,
  });

  let parsed;
  try { parsed = JSON.parse(resp.text); }
  catch (e) { throw new Error('Model yaniti JSON degil: ' + resp.text.slice(0, 200)); }

  const applied = [], pending = [], errors = [];
  const rawActions = Array.isArray(parsed.actions) ? parsed.actions : [];

  for (const a of rawActions) {
    let params = {};
    try { params = a.params_json ? JSON.parse(a.params_json) : {}; }
    catch (e) { errors.push({ type: a.type, error: 'params_json parse edilemedi' }); continue; }

    if (!actions.ACTIONS[a.type]) { errors.push({ type: a.type, error: 'bilinmeyen aksiyon' }); continue; }

    const risk = actions.riskOf(a.type);
    const desc = actions.describe(a.type, params);

    if (risk === actions.RISK.CONFIRM) {
      pending.push({ type: a.type, params, reason: a.reason || '', risk, describe: desc });
      continue;
    }
    // safe -> hemen uygula
    try {
      const r = actions.applyAction(a.type, params); // expectedUpdatedAt: readPanelRaw icinde guncel alinir
      applied.push({ type: a.type, params, reason: a.reason || '', summary: r.summary, describe: desc });
    } catch (e) {
      errors.push({ type: a.type, describe: desc, error: String(e && e.message || e) });
    }
  }

  return {
    reply: String(parsed.reply || '').slice(0, 4000),
    applied,
    pending,
    errors,
    model: resp.model,
    costUsd: resp.costUsd,
    panelUpdatedAtBefore: updatedAt,
  };
}

// Onaylanmis tek aksiyonu uygula (Claude cagrisi yok). action: { type, params }.
function confirmAction(action) {
  if (!action || !action.type) throw new Error('action.type gerekli.');
  if (!actions.ACTIONS[action.type]) throw new Error('bilinmeyen aksiyon: ' + action.type);
  const r = actions.applyAction(action.type, action.params || {});
  return { ok: true, type: action.type, summary: r.summary, updatedAt: r.updatedAt };
}

module.exports = { interpretAndAct, confirmAction };
