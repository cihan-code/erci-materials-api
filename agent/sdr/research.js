// SDR arastirma: KAYNAK katmani (Google Places) ile gercek kurum listesi topla ->
// modele dogrulanmis stub olarak ver -> model web_search/web_fetch ile zenginlestir + ustune ekle
// -> normalize -> arastirma logu kaydet.
// Haiku (ucuz) + web_search/web_fetch server tool. MOCK'ta fixture doner, $0.

const fs = require('fs');
const path = require('path');
const { callClaude } = require('../claude');
const { HAIKU } = require('../pricing');
const { parseModelJson } = require('../lib/jsonParse');
const sdrStore = require('./store');
const { gatherSources } = require('./sources');

const MOCK = process.env.AGENT_MOCK === '1';
const IDENTITY = fs.readFileSync(path.join(__dirname, 'prompts', 'identity.md'), 'utf8');
const RESEARCH_PROMPT = fs.readFileSync(path.join(__dirname, 'prompts', 'research.md'), 'utf8');
// Maliyet vs kalite: web_fetch her kurumun "Iletisim" sayfasini acip e-posta/telefon cikarmak
// icin ZORUNLU - cok dusuk tutunca lead'lerin iletisimi bos kaliyor (ise yaramaz). Asil maliyet
// kaldiraci `max_content_tokens` (cekilen sayfayi kirp), max_uses degil. Kaynak katmani
// (sources.js) + Google Places anahtari devredeyken model zaten daha az aramaya ihtiyac duyar.
const MAX_WEB_SEARCHES = parseInt(process.env.SDR_MAX_WEB_SEARCHES, 10) || 6;
const MAX_WEB_FETCHES = parseInt(process.env.SDR_MAX_WEB_FETCHES, 10) || 6;
const WEB_FETCH_MAX_CONTENT = parseInt(process.env.SDR_WEB_FETCH_MAX_CONTENT, 10) || 4000;

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'test', 'fixtures', name), 'utf8'));
}

// Kaynak stub listesini modele verilecek kompakt metne cevir.
function renderSourceList(candidates) {
  if (!candidates.length) return '(kaynak katmanindan dogrulanmis kurum gelmedi — tamamen web_search ile calis)';
  return candidates.slice(0, 60).map((c, i) => {
    const bits = [
      (i + 1) + '. ' + c.kurum_adi,
      c.website ? ('web: ' + c.website) : null,
      (c.phones || []).length ? ('tel: ' + c.phones.join(', ')) : null,
      (c.emails || []).length ? ('mail: ' + c.emails.join(', ')) : null,
      c.adres ? ('adres: ' + c.adres) : null,
      c.kaynak ? ('[' + c.kaynak + (c.kaynak_url ? ' ' + c.kaynak_url : '') + ']') : null,
    ].filter(Boolean);
    return bits.join(' · ');
  }).join('\n');
}

async function runResearch({ query, city, type } = {}) {
  query = String(query || '').trim();
  if (!query) throw new Error('Araştırma hedefi (query) gerekli.');
  if (query.length > 400) throw new Error('Araştırma hedefi çok uzun.');
  if (!MOCK && sdrStore.dailyCapReached()) {
    throw new Error('Günlük araştırma limiti (' + sdrStore.DAILY_CAP + ') doldu — yarın tekrar deneyin veya SDR_DAILY_RESEARCH_CAP artırın.');
  }

  // 1) KAYNAK katmani - gercek kurum stub'lari (uydurma degil). MOCK'ta atlanir
  // (deterministik fixture akisi; gatherSources ayri test edilir - test/sdr.js #6).
  let sourceResult = { candidates: [], sources: [] };
  if (!MOCK) {
    try {
      sourceResult = await gatherSources({ query, city, type });
    } catch (e) {
      sourceResult = { candidates: [], sources: [{ name: 'kaynak katmanı', ran: false, reason: String(e && e.message || e) }] };
    }
  }

  const user = [
    city ? ('Şehir filtresi: ' + city) : '',
    type ? ('Kurum tipi filtresi: ' + type) : '',
    '',
    'Araştırma hedefi: ' + query,
    '',
    '## DOĞRULANMIŞ KAYNAK LİSTESİ (Google Places — bu kurumlar GERÇEK)',
    'Liste boş olabilir; o zaman tümüyle web_search/web_fetch ile çalış.',
    'Kaynak kurumlarını (varsa) çıktına dahil et ve web ile zenginleştir (iletişim, kişi, sosyal, neden uygun).',
    'Listede olmayan uygun kurumları da EKLE. Kaynakta olmayan iletişim bilgisini UYDURMA.',
    'RAKİP/TEDARİKÇİ tipini (tekstil üreticisi, baskı-nakış-promosyon firması, toptancı, matbaa) ASLA listeleme.',
    '',
    renderSourceList(sourceResult.candidates),
  ].filter((x) => x !== '').join('\n');

  let raw; let meta;
  if (MOCK) {
    raw = fixture('sdr-research.json');
    meta = { model: HAIKU, costUsd: 0, webSearches: 0, mock: true, at: new Date().toISOString() };
  } else {
    const resp = await callClaude({
      model: HAIKU,
      opType: 'sdr-research',
      system: IDENTITY + '\n\n---\n\n' + RESEARCH_PROMPT,
      cacheSystem: true, // statik sistem promptu -> tekrar arastirmalarda cache
      user,
      maxTokens: 7000,
      // Haiku 4.5 (Opus/Sonnet 4.6 oncesi) -> TEMEL arac varyantlari. _20260209
      // (dynamic filtering) yalniz Opus 4.6+ / Sonnet 4.6+ modellerde; Haiku'da 400 doner.
      // max_content_tokens: web_fetch'in cektigi sayfayi kirp (input token patlamasini onle).
      tools: [
        { type: 'web_search_20250305', name: 'web_search', max_uses: MAX_WEB_SEARCHES },
        { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: MAX_WEB_FETCHES, max_content_tokens: WEB_FETCH_MAX_CONTENT },
      ],
    });
    raw = parseModelJson(resp.text, 'SDR araştırma');
    meta = {
      model: resp.model, costUsd: resp.costUsd, webSearches: resp.webSearches || 0,
      mock: false, at: new Date().toISOString(), stopReason: resp.stopReason,
    };
  }

  const { normalizeCandidate } = require('./leads');
  const modelCandidates = (Array.isArray(raw.candidates) ? raw.candidates : [])
    .map(normalizeCandidate)
    .filter((c) => c.kurum_adi);

  // Model'in atladigi kaynak kurumlarini da ekle (kaybolmasin).
  const candidates = mergeCandidates(modelCandidates, sourceResult.candidates, city || null);

  return sdrStore.saveResearch({
    query, city: city || null, type: type || null,
    candidates,
    arastirma_notu: raw.arastirma_notu ? String(raw.arastirma_notu).slice(0, 1000) : null,
    sources: sourceResult.sources,
    meta,
  });
}

function normKey(s) {
  return String(s || '').toLocaleLowerCase('tr')
    .replace(/[İıI]/g, 'i').replace(/[^a-z0-9ğüşöç]+/g, ' ').trim();
}

// Model adaylari ana liste; kaynakta olup modelde olmayan kurumlari sona ekle.
function mergeCandidates(modelCands, sourceCands, city) {
  const { normalizeCandidate } = require('./leads');
  const seen = new Set(modelCands.map((c) => normKey(c.kurum_adi)));
  const extra = [];
  for (const s of sourceCands) {
    const k = normKey(s.kurum_adi);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    extra.push(normalizeCandidate({
      kurum_adi: s.kurum_adi,
      kurum_tipi: s.kurum_tipi,
      sektor: s.sektor,
      sehir: s.sehir || city || null,
      website: s.website,
      instagram: s.instagram,
      emails: s.emails,
      phones: s.phones,
      neden_uygun: null,
      kaynaklar: [s.kaynak_url].filter(Boolean),
    }));
  }
  return modelCands.concat(extra);
}

module.exports = { runResearch, MAX_WEB_SEARCHES, MAX_WEB_FETCHES, renderSourceList, mergeCandidates };
