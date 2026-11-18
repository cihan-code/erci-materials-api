'use strict';

function temporary(message, extra = {}) {
  return Object.assign(new Error(message), { temporary: true, ...extra });
}

function createMemoryStore() {
  const entries = new Map();
  return { entries, async get(key) { return entries.get(key); },
    async set(key, value) { entries.set(key, { ...value }); } };
}

/** No network. failures: { 'dosya.pdf': N }; failFirst: first N send attempts globally. */
function createTestAdapter({ failFirst = 0, failures = {}, lostResponseFor = [], records = [] } = {}) {
  let attempts = 0, sequence = 0;
  const fileAttempts = new Map(), sent = new Map(), lost = new Set();
  return {
    records,
    async upload({ file }) { return `test-media:${file.name}`; },
    async send({ key, file }) {
      attempts++;
      const n = (fileAttempts.get(file.name) || 0) + 1;
      fileAttempts.set(file.name, n);
      if (attempts <= failFirst || n <= (failures[file.name] || 0)) {
        throw temporary('Test gecici gonderim hatasi', { definiteNotSent: true });
      }
      if (sent.has(key)) return { providerRef: sent.get(key) };
      const providerRef = `test:${++sequence}`;
      sent.set(key, providerRef);
      records.push({ key, file: file.name, status: 'gonderildi', providerRef });
      records.push({ key, file: file.name, status: 'ulasti', providerRef });
      if (lostResponseFor.includes(file.name) && !lost.has(key)) {
        lost.add(key);
        throw temporary('Test yaniti kayboldu', { providerRef, ambiguous: true });
      }
      return { providerRef };
    },
    async lookupStatus({ key, providerRef }) {
      records.push({ key, providerRef, status: 'durum_sorgulandi' });
      return sent.has(key) ? { status: 'delivered', providerRef: sent.get(key) } : { status: 'unknown' };
    },
  };
}
module.exports = { createTestAdapter, createMemoryStore, temporary };
