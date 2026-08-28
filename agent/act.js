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

// instruction: kullanici metni. Donen: { reply, applied:[], pending:[], errors:[], usage }
async function interpretAndAct(instruction) {
  const text = String(instruction || '').trim();
  if (!text) throw new Error('instruction bos.');
  if (text.length > 2000) throw new Error('instruction cok uzun (max 2000).');

  const { data, updatedAt } = store.loadPanelData();
  if (!data) throw new Error('panel-data.json yok - once panelden veri kaydedilmeli.');

  const today = process.env.PANEL_TODAY || new Date().toISOString().slice(0, 10);
  // Tum domain'ler - haiku'da ~6k token, ~$0.006. Domain tahmini kaybetmek riski daha buyuk:
  // model bir kaydi goremezse id ile eslesemez.
  const signals = buildSignals(data, today, undefined);

  const user = [
    'Bugün: ' + today,
    '',
    '## Panel metrik tablosu (kayıtları id ile eşleştir)',
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
  let rawActions = Array.isArray(parsed.actions) ? parsed.actions : [];
  rawActions = dedupeActions(rawActions, errors);

  for (const a of rawActions) {
    let params = {};
    try { params = a.params_json ? JSON.parse(a.params_json) : {}; }
    catch (e) { errors.push({ type: a.type, error: 'params_json parse edilemedi' }); continue; }

    if (!actions.ACTIONS[a.type]) { errors.push({ type: a.type, error: 'bilinmeyen aksiyon' }); continue; }
    const risk = actions.riskOf(a.type);

    if (risk === actions.RISK.CONFIRM) {
      // Onizleme: kuru calisma ile "ne olacak" (kalan bakiye vb.). Basarisizsa describe'e dus.
      let preview;
      try { preview = actions.dryRun(a.type, params); }
      catch (e) { preview = null; errors.push({ type: a.type, describe: actions.describe(a.type, params), error: String(e && e.message || e) }); }
      if (preview == null && errors.length && errors[errors.length - 1].type === a.type) continue;
      pending.push({
        type: a.type, params, reason: a.reason || '', risk,
        describe: preview || actions.describe(a.type, params),
      });
      continue;
    }
    // safe -> hemen uygula
    try {
      const r = actions.applyAction(a.type, params);
      applied.push({ type: a.type, params, reason: a.reason || '', summary: r.summary, describe: r.summary });
    } catch (e) {
      errors.push({ type: a.type, describe: actions.describe(a.type, params), error: String(e && e.message || e) });
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

// Model hem update_debt_payment hem add_income/add_expense urettiyse: borc odemesi zaten
// otomatik gelir/gider ekliyor -> fazlalik olani dusur (cift gelir/gider engeli).
function dedupeActions(list, errors) {
  const hasDebtPay = list.some((a) => a.type === 'update_debt_payment');
  if (!hasDebtPay) return list;
  return list.filter((a) => {
    if (a.type === 'add_income' || a.type === 'add_expense') {
      errors.push({ type: a.type, error: 'atlandı: borç/alacak ödemesi geliri/gideri zaten otomatik ekliyor (çift kayıt önlendi)' });
      return false;
    }
    return true;
  });
}

// Onaylanmis tek aksiyonu uygula (Claude cagrisi yok). action: { type, params }.
function confirmAction(action) {
  if (!action || !action.type) throw new Error('action.type gerekli.');
  if (!actions.ACTIONS[action.type]) throw new Error('bilinmeyen aksiyon: ' + action.type);
  const r = actions.applyAction(action.type, action.params || {});
  return { ok: true, type: action.type, summary: r.summary, updatedAt: r.updatedAt };
}

module.exports = { interpretAndAct, confirmAction };
