// SDR arastirma: web_search ile kurum adaylari bul -> normalize -> arastirma logu kaydet.
// Haiku (ucuz) + web_search server tool. MOCK'ta fixture doner, $0.

const fs = require('fs');
const path = require('path');
const { callClaude } = require('../claude');
const { HAIKU } = require('../pricing');
const { parseModelJson } = require('../lib/jsonParse');
const sdrStore = require('./store');

const MOCK = process.env.AGENT_MOCK === '1';
const IDENTITY = fs.readFileSync(path.join(__dirname, 'prompts', 'identity.md'), 'utf8');
const RESEARCH_PROMPT = fs.readFileSync(path.join(__dirname, 'prompts', 'research.md'), 'utf8');
const MAX_WEB_SEARCHES = parseInt(process.env.SDR_MAX_WEB_SEARCHES, 10) || 8;

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'test', 'fixtures', name), 'utf8'));
}

async function runResearch({ query, city, type } = {}) {
  query = String(query || '').trim();
  if (!query) throw new Error('Araştırma hedefi (query) gerekli.');
  if (query.length > 400) throw new Error('Araştırma hedefi çok uzun.');
  if (!MOCK && sdrStore.dailyCapReached()) {
    throw new Error('Günlük araştırma limiti (' + sdrStore.DAILY_CAP + ') doldu — yarın tekrar deneyin veya SDR_DAILY_RESEARCH_CAP artırın.');
  }

  const user = [
    city ? ('Şehir filtresi: ' + city) : '',
    type ? ('Kurum tipi filtresi: ' + type) : '',
    '',
    'Araştırma hedefi: ' + query,
  ].filter(Boolean).join('\n');

  let raw; let meta;
  if (MOCK) {
    raw = fixture('sdr-research.json');
    meta = { model: HAIKU, costUsd: 0, webSearches: 0, mock: true, at: new Date().toISOString() };
  } else {
    const resp = await callClaude({
      model: HAIKU,
      opType: 'sdr-research',
      system: IDENTITY + '\n\n---\n\n' + RESEARCH_PROMPT,
      user,
      maxTokens: 8000,
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: MAX_WEB_SEARCHES }],
    });
    raw = parseModelJson(resp.text, 'SDR araştırma');
    meta = {
      model: resp.model, costUsd: resp.costUsd, webSearches: resp.webSearches || 0,
      mock: false, at: new Date().toISOString(), stopReason: resp.stopReason,
    };
  }

  const { normalizeCandidate } = require('./leads');
  const candidates = (Array.isArray(raw.candidates) ? raw.candidates : [])
    .map(normalizeCandidate)
    .filter((c) => c.kurum_adi);

  return sdrStore.saveResearch({
    query, city: city || null, type: type || null,
    candidates,
    arastirma_notu: raw.arastirma_notu ? String(raw.arastirma_notu).slice(0, 1000) : null,
    meta,
  });
}

module.exports = { runResearch, MAX_WEB_SEARCHES };
