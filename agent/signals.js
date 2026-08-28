// Modele giden sinyal metni. Artik TUM SAYILAR agent/metrics.js'te (deterministik,
// panelin kendi mantigiyla) hesaplaniyor. Bu dosya yalniz metrics'i cagirip istenen
// domain'lerin metnini dondurur - kendi aritmetigi YOK.
//
// buildSignals(data, today, ['production','tasks'])  -> yalniz o domain'ler
// domain listesi verilmezse hepsi.

const { computeMetrics, renderMetricsText, DOMAIN_KEYS } = require('./metrics');

const DOMAINS = DOMAIN_KEYS.reduce((o, k) => { o[k] = true; return o; }, {});
const ALL_DOMAINS = DOMAIN_KEYS.slice();

function buildSignals(data, today, domainList) {
  const M = computeMetrics(data || {}, today);
  return renderMetricsText(M, domainList);
}

module.exports = { buildSignals, DOMAINS, ALL_DOMAINS };
