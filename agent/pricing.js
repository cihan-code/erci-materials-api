// Model secimi + USD maliyet tahmini. Fiyatlar: Anthropic 1. parti API, USD / 1M token.
// (Guncelleme gerekirse: https://www.anthropic.com/pricing)

const HAIKU = process.env.HAIKU_MODEL || 'claude-haiku-4-5';
const SONNET = process.env.SONNET_MODEL || process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

const PRICE = {
  'claude-haiku-4-5': { in: 1.00, out: 5.00 },
  'claude-sonnet-5': { in: 2.00, out: 10.00 },
  'claude-opus-5': { in: 5.00, out: 25.00 },
};

// Bilinmeyen model -> Sonnet fiyatiyla tahmin et (ust sinir, sasirtici dusuk gostermesin).
function priceFor(model) {
  return PRICE[model] || PRICE['claude-sonnet-5'];
}

function estCostUsd(model, inputTokens, outputTokens) {
  const p = priceFor(model);
  const usd = ((inputTokens || 0) * p.in + (outputTokens || 0) * p.out) / 1e6;
  return Math.round(usd * 10000) / 10000; // 4 ondalik
}

module.exports = { HAIKU, SONNET, PRICE, estCostUsd };
