// SDR akis orkestrasyonu: arastir -> puanla -> logu guncelle. server.js /api/sdr/research async cagirir.

const sdrStore = require('./store');
const { runResearch } = require('./research');
const { scoreCandidates } = require('./score');

async function researchAndScore({ query, city, type } = {}) {
  sdrStore.writeStatus({ running: true, startedAt: new Date().toISOString(), finishedAt: null, lastQuery: query, lastError: null });
  try {
    const rec = await runResearch({ query, city, type });
    let candidates = rec.candidates || [];
    if (candidates.length) {
      try { candidates = await scoreCandidates(candidates); }
      catch (e) { rec.scoreError = String(e && e.message || e); }
    }
    rec.candidates = candidates;
    sdrStore.research.save(rec);
    sdrStore.writeStatus({ running: false, finishedAt: new Date().toISOString(), lastResearchId: rec.id, lastError: null });
    return rec;
  } catch (e) {
    sdrStore.writeStatus({ running: false, finishedAt: new Date().toISOString(), lastError: String(e && e.message || e) });
    throw e;
  }
}

module.exports = { researchAndScore };
