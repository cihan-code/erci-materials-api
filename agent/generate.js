// Yonetim Ajani rapor ureticisi (brifing / risk / takip / finans / haftalik / aylik).
//
// Akis:
//   1. panel-data.json'u DISKTEN oku (HTTP yok) - SALT-OKUNUR
//   2. buildSignals(data, today, DOMAINS) - yalniz o rapor icin gereken domain sinyalleri
//      (ham panel-data.json modele ASLA gitmez)
//   3. callClaude (claude.js) - model tipe gore secilir; her cagri usage-log'a yazilir
//   4. sonucu store.saveAgentOutput ile kaydet
//
// Model yonlendirme:
//   basit gunluk operasyonlar -> HAIKU (ucuz, hizli, thinking yok)
//   haftalik/aylik yonetim analizi -> SONNET + effort:medium + adaptive thinking
//
// Kullanim: node agent/generate.js gunluk-brifing
// Ortam: ANTHROPIC_API_KEY (zorunlu), HAIKU_MODEL / SONNET_MODEL (ops.), PANEL_TODAY (test)

const fs = require('fs');
const path = require('path');

const store = require('./store');
const { buildSignals } = require('./signals');
const { callClaude } = require('./claude');
const { HAIKU, SONNET } = require('./pricing');

const PROMPTS_DIR = path.join(__dirname, 'prompts');
function readPrompt(name) { return fs.readFileSync(path.join(PROMPTS_DIR, name), 'utf8'); }

// Her rapor tipi: hangi model, hangi domain sinyalleri, effort, max_tokens, onceki cikti sayisi.
const OP = {
  'gunluk-brifing':  { tier: 'haiku',  domains: ['production', 'tasks', 'sales', 'finance'], maxTokens: 7000, recent: 1 },
  'uretim-risk':     { tier: 'haiku',  domains: ['production'],                              maxTokens: 5000, recent: 0 },
  'satis-takip':     { tier: 'haiku',  domains: ['sales', 'crm'],                            maxTokens: 5000, recent: 0 },
  'finans':          { tier: 'haiku',  domains: ['finance'],                                 maxTokens: 5000, recent: 0 },
  'haftalik-review': { tier: 'sonnet', domains: ['production', 'tasks', 'sales', 'finance', 'crm'], maxTokens: 12000, effort: 'medium', recent: 1 },
  'aylik-rapor':     { tier: 'sonnet', domains: ['production', 'tasks', 'sales', 'finance', 'crm'], maxTokens: 16000, effort: 'medium', recent: 1 },
};

// Son N raporun "3 Baslik" ozeti ("dune gore degisim" icin). recent=0 -> hic.
function recentContext(type, n) {
  if (!n) return '';
  const list = store.listOutputs({ type, limit: n });
  if (!list.length) return '(onceki cikti yok - bu ilk dongu)';
  return list.map((meta) => {
    const rec = store.getOutput(meta.id);
    if (!rec) return null;
    const md = rec.markdown || '';
    const m = md.match(/##[^\n]*3 Ba[sş]l[ıi][gğ][ıi][\s\S]*?(?=\n## |\n---|\n\*|$)/i);
    const chunk = (m ? m[0] : md.slice(0, 700)).trim();
    return '### ' + rec.date + '\n' + chunk;
  }).filter(Boolean).join('\n\n');
}

async function generate(type) {
  const cfg = OP[type];
  if (!cfg) throw new Error('Gecersiz tip: ' + type + ' (gecerli: ' + Object.keys(OP).join(', ') + ')');

  store.ensureAgentDirs();
  store.writeStatus({ running: true, type, startedAt: new Date().toISOString(), finishedAt: null, lastError: null });

  try {
    const { data, updatedAt } = store.loadPanelData();
    if (!data) throw new Error('panel-data.json bos veya yok - once panelden veri kaydedilmeli.');

    const today = process.env.PANEL_TODAY || new Date().toISOString().slice(0, 10);
    const signals = buildSignals(data, today, cfg.domains);

    const staleHours = updatedAt ? Math.round((Date.now() - new Date(updatedAt).getTime()) / 3600000) : null;
    const staleNote = staleHours != null && staleHours > 24
      ? '\n\nUYARI: panel verisi ' + staleHours + ' saattir guncellenmemis - "veri bayat" uyarisi koy.'
      : '';

    const model = cfg.tier === 'sonnet' ? SONNET : HAIKU;
    const system = readPrompt('identity.md') + '\n\n' + readPrompt(type + '.md');
    const recent = recentContext(type, cfg.recent);
    const user = [
      'Bugun: ' + today,
      'Panel updatedAt: ' + (updatedAt || 'bilinmiyor') + staleNote,
      recent ? '\n## Onceki cikti (dune gore degisim icin)\n' + recent : '',
      '',
      '## Guncel panel sinyalleri (' + cfg.domains.join(', ') + ')',
      signals,
      '',
      'Yukaridaki sinyallere dayanarak istenen ciktiyi Turkce markdown olarak uret. Sadece belgeyi'
      + ' dondur, on/arka aciklama yazma.',
    ].join('\n');

    console.log('[generate] tip=%s model=%s domains=%s sinyal=%d kar', type, model, cfg.domains.join('+'), signals.length);

    const resp = await callClaude({
      model,
      opType: type,
      system,
      user,
      maxTokens: cfg.maxTokens,
      thinking: cfg.tier === 'sonnet' ? { type: 'adaptive' } : undefined,
      effort: cfg.effort,
    });

    const dateMatch = resp.text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
    const rec = store.saveAgentOutput({
      type,
      title: store.TYPE_LABELS[type] + ' — ' + today,
      date: dateMatch ? dateMatch[1] : today,
      markdown: resp.text,
      meta: {
        model: resp.model,
        tier: cfg.tier,
        domains: cfg.domains,
        panelUpdatedAt: updatedAt,
        generatedBy: 'generate.js',
        stopReason: resp.stopReason || null,
        truncated: resp.stopReason === 'max_tokens',
        inputTokens: resp.inputTokens,
        outputTokens: resp.outputTokens,
        costUsd: resp.costUsd,
      },
    });
    console.log('[generate] tamam id=%s uzunluk=%d kar maliyet=$%s stop=%s',
      rec.id, resp.text.length, resp.costUsd, resp.stopReason);

    store.writeStatus({ running: false, type, finishedAt: new Date().toISOString(), lastError: null, lastOutputId: rec.id });
    return rec;
  } catch (e) {
    store.writeStatus({ running: false, type, finishedAt: new Date().toISOString(), lastError: String(e && e.message || e) });
    throw e;
  }
}

// CLI
if (require.main === module) {
  const type = process.argv[2];
  if (!type) {
    console.error('Kullanim: node agent/generate.js <' + Object.keys(OP).join('|') + '>');
    process.exit(2);
  }
  generate(type).then(() => process.exit(0)).catch((e) => {
    console.error('[generate] HATA:', e && e.message || e);
    process.exit(1);
  });
}

module.exports = { generate, OP };
