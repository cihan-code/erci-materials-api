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

// Tek bir streaming istegi. SSE'yi elle ayristirir (SDK yok). text + usage + stop_reason dondurur.
async function streamOnce(body, key) {
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
    const t = await res.text().catch(() => '');
    const err = new Error('Anthropic HTTP ' + res.status + ': ' + t.slice(0, 300));
    err.retryable = true;
    throw err;
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    const err = new Error('Anthropic HTTP ' + res.status + ': ' + t.slice(0, 500));
    err.retryable = false; // 400/401/404 - tekrar denemek anlamsiz
    throw err;
  }
  if (!res.body) throw new Error('Anthropic yanitinda govde (stream) yok.');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  let usage = null;
  let stopReason = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const dataStr = chunk.split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('');
      if (!dataStr || dataStr === '[DONE]') continue;
      let evt;
      try { evt = JSON.parse(dataStr); } catch (e) { continue; }
      if (evt.type === 'content_block_delta' && evt.delta && evt.delta.type === 'text_delta') {
        text += evt.delta.text || '';
      } else if (evt.type === 'message_start' && evt.message && evt.message.usage) {
        usage = Object.assign({}, evt.message.usage);
      } else if (evt.type === 'message_delta') {
        if (evt.delta && evt.delta.stop_reason) stopReason = evt.delta.stop_reason;
        if (evt.usage) usage = Object.assign(usage || {}, evt.usage);
      } else if (evt.type === 'error') {
        const err = new Error('Anthropic stream hatasi: ' + JSON.stringify(evt.error || {}));
        err.retryable = /overloaded|rate_limit|timeout/i.test(JSON.stringify(evt.error || {}));
        throw err;
      }
    }
  }

  return { text: text.trim(), usage, stopReason };
}

async function callClaude(system, userText) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY tanimli degil (Render > Environment).');

  // Streaming + genis max_tokens: kisa max_tokens brifingi cumlenin ortasinda kesiyordu
  // (Sonnet 5 adaptive thinking'i de token harciyor). Sonnet 5 budget_tokens'i reddeder -
  // adaptive tek dogru mod.
  const body = {
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    stream: true,
    system,
    messages: [{ role: 'user', content: userText }],
  };

  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const out = await streamOnce(body, key);
      if (!out.text) throw new Error('Anthropic bos yanit dondu.');
      if (out.stopReason === 'max_tokens') {
        console.warn('[generate] UYARI: yanit max_tokens (%d) sinirinda kesilmis olabilir.', body.max_tokens);
      }
      return out;
    } catch (e) {
      lastErr = e;
      if (e && e.retryable === false) throw e;
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 5000));
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

    const { text, usage, stopReason } = await callClaude(system, userText);

    const dateMatch = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
    const rec = store.saveAgentOutput({
      type,
      title: store.TYPE_LABELS[type] + ' — ' + today,
      date: dateMatch ? dateMatch[1] : today,
      markdown: text,
      meta: {
        model: MODEL,
        panelUpdatedAt: updatedAt,
        generatedBy: 'generate.js',
        stopReason: stopReason || null,
        truncated: stopReason === 'max_tokens',
        usage: usage || null,
      },
    });
    console.log('[generate] uzunluk=%d kar stop_reason=%s', text.length, stopReason);

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
