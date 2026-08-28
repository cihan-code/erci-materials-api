// Tek Anthropic cagri noktasi. generate.js ve act.js buradan gecer.
// - Streaming (SSE elle ayristirma, SDK yok) -> buyuk max_tokens'ta HTTP timeout yok.
// - HER cagri store.logUsage ile kaydedilir: model, opType, input/output token, tahmini USD.
// - AGENT_MOCK=1 (yalniz yerel gelistirme): gercek API'ye gitmez, sahte yanit doner, $0 loglar.
//   Boylece tum akis (sinyal -> prompt -> parse -> kayit -> uc -> panel) para harcamadan test edilir.
//   Render'da bu degisken ASLA set edilmez; canli akis her zaman gercek.

const store = require('./store');
const { estCostUsd } = require('./pricing');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// --- AGENT_MOCK guvenlik kilidi ---
// Mock modu SADECE yerel/gelistirme icindir. Production (Render) ortaminda AGENT_MOCK=1
// yanlislikla set edilirse uygulama BASLAMAZ - sahte brifingin canliya yazilmasini onler.
// Render tum servislerinde RENDER=true tanimlar; ayrica NODE_ENV=production kontrol edilir.
const MOCK = process.env.AGENT_MOCK === '1';
if (MOCK) {
  const prodSignals = [];
  if (process.env.RENDER) prodSignals.push('RENDER=' + process.env.RENDER);
  if (process.env.RENDER_SERVICE_ID) prodSignals.push('RENDER_SERVICE_ID');
  if (process.env.NODE_ENV === 'production') prodSignals.push('NODE_ENV=production');
  if (process.env.AGENT_ENV === 'production') prodSignals.push('AGENT_ENV=production');

  if (prodSignals.length) {
    console.error(
      '\n==================================================================\n' +
      ' KRITIK: AGENT_MOCK=1 ama ortam PRODUCTION gorunuyor (' + prodSignals.join(', ') + ').\n' +
      ' Mock modu yalnizca yerel gelistirme icindir. Uygulama durduruluyor.\n' +
      ' Render > Environment altindan AGENT_MOCK degiskenini SILIN.\n' +
      '==================================================================\n'
    );
    process.exit(1);
  }
  console.warn('[claude] AGENT_MOCK=1 - SAHTE yanit modu (yerel). Anthropic API cagrilmayacak, ucret olusmayacak.');
}

// Sahte yanit: act icin sema-uyumlu bos JSON; rapor icin kisa markdown iskeleti.
function mockText(opts) {
  if (opts.schema) {
    return JSON.stringify({
      reply: '[MOCK] Gercek API cagrisi yapilmadi (AGENT_MOCK=1). Istek: ' + String(opts.user || '').slice(-120),
      actions: [],
    });
  }
  const t = opts.opType || 'rapor';
  return [
    '# [MOCK] ' + t + ' — ' + new Date().toISOString().slice(0, 10),
    '',
    '## Veri Guveni',
    'Bu bir SAHTE ciktidir (AGENT_MOCK=1). Anthropic API cagrilmadi, ucret olusmadi.',
    '',
    '## Prompt kontrolu',
    '- system uzunlugu: ' + String(opts.system || '').length + ' kar',
    '- user uzunlugu: ' + String(opts.user || '').length + ' kar (~' + Math.round(String(opts.user || '').length / 4) + ' token)',
    '- model: ' + opts.model + ' | maxTokens: ' + (opts.maxTokens || 8000) + (opts.effort ? ' | effort: ' + opts.effort : ''),
    '',
    '## user metninin ilk 400 karakteri',
    String(opts.user || '').slice(0, 400),
  ].join('\n');
}

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
    err.retryable = false;
    throw err;
  }
  if (!res.body) throw new Error('Anthropic yanitinda govde (stream) yok.');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', text = '', usage = null, stopReason = null;

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

// opts: { model, opType, system, user, maxTokens, thinking, effort, schema }
async function callClaude(opts) {
  // ---- MOCK: gercek cagriyi atla, $0 logla ----
  if (MOCK) {
    const text = mockText(opts);
    const inTok = Math.round(String(opts.system || '').length / 4 + String(opts.user || '').length / 4);
    const outTok = Math.round(text.length / 4);
    store.logUsage({ opType: opts.opType || 'unknown', model: opts.model, inputTokens: inTok, outputTokens: outTok, costUsd: 0, stopReason: 'end_turn', ok: true, mock: true });
    console.log('[claude] MOCK yanit (%s) - API cagrilmadi, $0', opts.opType);
    return { text, stopReason: 'end_turn', model: opts.model, inputTokens: inTok, outputTokens: outTok, costUsd: 0, mock: true };
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY tanimli degil (Render > Environment).');

  const body = {
    model: opts.model,
    max_tokens: opts.maxTokens || 8000,
    stream: true,
    system: opts.system,
    messages: [{ role: 'user', content: opts.user }],
  };
  if (opts.thinking) body.thinking = opts.thinking;
  if (opts.effort) body.output_config = Object.assign(body.output_config || {}, { effort: opts.effort });
  if (opts.schema) {
    body.output_config = Object.assign(body.output_config || {}, {
      format: { type: 'json_schema', schema: opts.schema },
    });
  }

  let out = null, lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      out = await streamOnce(body, key);
      if (!out.text) throw new Error('Anthropic bos yanit dondu.');
      break;
    } catch (e) {
      lastErr = e;
      out = null;
      if (e && e.retryable === false) break;
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 5000));
    }
  }

  const inTok = (out && out.usage && out.usage.input_tokens) || 0;
  const outTok = (out && out.usage && out.usage.output_tokens) || 0;
  const costUsd = estCostUsd(opts.model, inTok, outTok);
  store.logUsage({
    opType: opts.opType || 'unknown',
    model: opts.model,
    inputTokens: inTok,
    outputTokens: outTok,
    costUsd,
    stopReason: out ? out.stopReason : null,
    ok: !!out,
    error: out ? null : String(lastErr && lastErr.message || lastErr || 'bilinmeyen'),
  });

  if (!out) throw lastErr || new Error('Anthropic cagrisi basarisiz.');
  if (out.stopReason === 'max_tokens') {
    console.warn('[claude] UYARI: %s yaniti max_tokens (%d) sinirinda kesilmis olabilir.', opts.opType, body.max_tokens);
  }
  return {
    text: out.text,
    stopReason: out.stopReason,
    model: opts.model,
    inputTokens: inTok,
    outputTokens: outTok,
    costUsd,
  };
}

module.exports = { callClaude };
