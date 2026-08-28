// Yonetim Ajani brifing ureticisi.
//
// Akis:
//   1. panel-data.json'u DISKTEN oku (HTTP yok) - SALT-OKUNUR
//   2. buildSignals() ile kompakt sinyal metni cikar (ham JSON modele GITMEZ)
//   3. Anthropic Messages API'ye system(kimlik+skill sureci) + user(sinyaller) gonder
//   4. sonucu agent/store.js ile kaydet, status.json guncelle
//
// Kullanim:
//   node agent/generate.js gunluk-brifing
//   node agent/generate.js haftalik-review
//
// Gerekli ortam degiskeni: ANTHROPIC_API_KEY  (Render > Environment; panel kodunda DEGIL)
// Opsiyonel: ANTHROPIC_MODEL (varsayilan claude-sonnet-5), PANEL_TODAY (YYYY-MM-DD, test icin)

const fs = require('fs');
const path = require('path');

const store = require('./store');
const { buildSignals } = require('./signals');

const PROMPTS_DIR = path.join(__dirname, 'prompts');
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

function readPrompt(name) {
  return fs.readFileSync(path.join(PROMPTS_DIR, name), 'utf8');
}

// Son N ciktinin "3 Baslik" / ilk paragrafini ozet olarak dondur ("dune gore degisim" icin).
function recentContext(type, n) {
  const list = store.listOutputs({ type, limit: n });
  if (!list.length) return '(onceki cikti yok - bu ilk dongu)';
  return list.map((meta) => {
    const rec = store.getOutput(meta.id);
    if (!rec) return null;
    const md = rec.markdown || '';
    // "Bugunun 3 Basligi" bolumunu yakala; yoksa ilk 800 karakter.
    const m = md.match(/##[^\n]*3 Ba[sş]l[ıi][gğ][ıi][\s\S]*?(?=\n## |\n---|\n\*|$)/i);
    const chunk = (m ? m[0] : md.slice(0, 800)).trim();
    return '### ' + rec.date + ' (' + rec.type + ')\n' + chunk;
  }).filter(Boolean).join('\n\n');
}

async function callClaude(system, userText) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY tanimli degil (Render > Environment).');

  const body = {
    model: MODEL,
    max_tokens: 4000,
    system,
    messages: [{ role: 'user', content: userText }],
  };

  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error('Anthropic HTTP ' + res.status + ': ' + (await res.text()).slice(0, 300));
        await new Promise((r) => setTimeout(r, attempt * 4000));
        continue;
      }
      if (!res.ok) {
        throw new Error('Anthropic HTTP ' + res.status + ': ' + (await res.text()).slice(0, 500));
      }
      const json = await res.json();
      const text = (json.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      if (!text) throw new Error('Anthropic bos yanit dondu.');
      return { text, usage: json.usage || null };
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, attempt * 4000));
    }
  }
  throw lastErr || new Error('Anthropic cagrisi basarisiz.');
}

async function generate(type) {
  if (!store.OUTPUT_TYPES.includes(type)) {
    throw new Error('Gecersiz tip: ' + type + ' (gecerli: ' + store.OUTPUT_TYPES.join(', ') + ')');
  }
  store.ensureAgentDirs();
  store.writeStatus({ running: true, type, startedAt: new Date().toISOString(), finishedAt: null, lastError: null });

  try {
    const { data, updatedAt } = store.loadPanelData();
    if (!data) throw new Error('panel-data.json bos veya yok - once panelden veri kaydedilmeli.');

    const today = process.env.PANEL_TODAY || new Date().toISOString().slice(0, 10);
    const signals = buildSignals(data, today);

    const staleHours = updatedAt ? Math.round((Date.now() - new Date(updatedAt).getTime()) / 3600000) : null;
    const staleNote = staleHours != null && staleHours > 24
      ? '\n\nUYARI: panel verisi ' + staleHours + ' saattir guncellenmemis - brifingde "veri bayat" uyarisi koy.'
      : '';

    const system = readPrompt('identity.md') + '\n\n' + readPrompt(type + '.md');
    const userText = [
      'Bugun: ' + today,
      'Panel updatedAt: ' + (updatedAt || 'bilinmiyor') + staleNote,
      '',
      '## Onceki ciktilar (dune gore degisim icin)',
      recentContext(type, type === 'gunluk-brifing' ? 2 : 1),
      '',
      '## Guncel panel sinyalleri',
      signals,
      '',
      'Yukaridaki sinyallere dayanarak istenen ciktiyi Turkce markdown olarak uret. Sadece belgeyi'
      + ' dondur, on/arka aciklama yazma.',
    ].join('\n');

    console.log('[generate] tip=%s bugun=%s sinyal_uzunlugu=%d kar', type, today, signals.length);

    const { text, usage } = await callClaude(system, userText);

    const dateMatch = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
    const rec = store.saveAgentOutput({
      type,
      title: store.TYPE_LABELS[type] + ' — ' + today,
      date: dateMatch ? dateMatch[1] : today,
      markdown: text,
      meta: {
        model: MODEL,
        panelUpdatedAt: updatedAt,
        generatedBy: 'cron/generate.js',
        usage: usage || null,
      },
    });

    store.writeStatus({ running: false, type, finishedAt: new Date().toISOString(), lastError: null, lastOutputId: rec.id });
    console.log('[generate] tamam id=%s', rec.id);
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
    console.error('Kullanim: node agent/generate.js <' + store.OUTPUT_TYPES.join('|') + '>');
    process.exit(2);
  }
  generate(type).then(() => process.exit(0)).catch((e) => {
    console.error('[generate] HATA:', e && e.message || e);
    process.exit(1);
  });
}

module.exports = { generate };
