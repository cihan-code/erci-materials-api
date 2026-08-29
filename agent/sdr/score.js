// SDR puanlama: aday listesi -> her biri icin potansiyel_puan / oncelik / tahmini adet /
// ilk_iletisim_onerisi. Haiku, TEK batch cagri. MOCK'ta fixture, $0.

const fs = require('fs');
const path = require('path');
const { callClaude } = require('../claude');
const { HAIKU } = require('../pricing');
const { parseModelJson } = require('../lib/jsonParse');
const { LEAD_PRIORITY } = require('../lib/enums');

const MOCK = process.env.AGENT_MOCK === '1';
const IDENTITY = fs.readFileSync(path.join(__dirname, 'prompts', 'identity.md'), 'utf8');
const SCORE_PROMPT = fs.readFileSync(path.join(__dirname, 'prompts', 'score.md'), 'utf8');

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'test', 'fixtures', name), 'utf8'));
}

// candidates: normalizeCandidate cikti dizisi. Doner: ayni dizi + skor alanlari doldurulmus.
async function scoreCandidates(candidates) {
  const arr = Array.isArray(candidates) ? candidates : [];
  if (!arr.length) return [];

  // modele sadece gereken alanlar (tam JSON degil - maliyet)
  const slim = arr.map((c, i) => ({
    i,
    kurum_adi: c.kurum_adi, kurum_tipi: c.kurum_tipi, sehir: c.sehir, sektor: c.sektor,
    website: !!c.website, emails: (c.emails || []).length, ilgili_kisiler: (c.ilgili_kisiler || []).length,
    neden_uygun: c.neden_uygun, tahmini_urun: c.tahmini_urun, tahmini_siparis_adet: c.tahmini_siparis_adet,
    sosyal_ozet: c.sosyal_ozet,
  }));

  let raw;
  if (MOCK) {
    raw = fixture('sdr-score.json');
  } else {
    const resp = await callClaude({
      model: HAIKU,
      opType: 'sdr-score',
      system: IDENTITY + '\n\n---\n\n' + SCORE_PROMPT,
      cacheSystem: true,
      user: 'Adaylar (giriş sırası önemli):\n' + JSON.stringify(slim, null, 1),
      maxTokens: 4000,
    });
    raw = parseModelJson(resp.text, 'SDR puanlama');
  }

  const scores = Array.isArray(raw.scores) ? raw.scores : [];
  return arr.map((c, i) => {
    const s = scores[i] || {};
    const puan = Number(s.potansiyel_puan);
    return Object.assign({}, c, {
      potansiyel_puan: Number.isFinite(puan) ? Math.max(1, Math.min(10, Math.round(puan))) : c.potansiyel_puan,
      oncelik: LEAD_PRIORITY.includes(s.oncelik) ? s.oncelik : c.oncelik,
      tahmini_siparis_adet: (Number.isFinite(Number(s.tahmini_siparis_adet)) && Number(s.tahmini_siparis_adet) > 0)
        ? Math.round(Number(s.tahmini_siparis_adet)) : c.tahmini_siparis_adet,
      ilk_iletisim_onerisi: s.ilk_iletisim_onerisi ? String(s.ilk_iletisim_onerisi).slice(0, 400) : null,
    });
  });
}

module.exports = { scoreCandidates };
