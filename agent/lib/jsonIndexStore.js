// dir/index.json (meta listesi) + dir/<id>.json (kayit) + ATOMIK yazma.
// Ajan-cikti deposu (store.js) ve belge deposu (documents.js) bu deseni ayri ayri
// implemente ediyordu; SDR arastirma deposu da ayni. Tek fabrika.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function jsonIndexStore(dir, opts = {}) {
  const INDEX = path.join(dir, 'index.json');
  const metaOf = opts.metaOf || ((r) => ({ id: r.id, createdAt: r.createdAt || null }));
  const maxIndex = opts.maxIndex || 1000;

  const ensure = () => fs.mkdirSync(dir, { recursive: true });
  const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return fb; } };
  const writeAtomic = (f, obj) => {
    ensure();
    const tmp = f + '.tmp-' + crypto.randomBytes(4).toString('hex');
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, f);
  };
  const loadIndex = () => { const i = readJson(INDEX, null); return Array.isArray(i) ? i : []; };
  const saveIndex = (l) => writeAtomic(INDEX, l.slice(0, maxIndex));
  const validId = (id) => !!id && !/[^A-Za-z0-9_-]/.test(String(id));

  return {
    dir,
    newId() { return new Date().toISOString().replace(/[:.]/g, '-') + '_' + crypto.randomBytes(4).toString('hex'); },
    save(record) {
      if (!record || !record.id) throw new Error('kayıtta id yok');
      writeAtomic(path.join(dir, record.id + '.json'), record);
      const idx = loadIndex();
      const i = idx.findIndex((m) => m.id === record.id);
      if (i >= 0) idx[i] = metaOf(record); else idx.unshift(metaOf(record));
      saveIndex(idx);
      return record;
    },
    get(id) { return validId(id) ? readJson(path.join(dir, id + '.json'), null) : null; },
    list(o) {
      const n = Math.max(1, Math.min(200, parseInt(o && o.limit, 10) || 50));
      return loadIndex().slice(0, n);
    },
    delete(id) {
      if (!validId(id)) return { deleted: 0 };
      const idx = loadIndex();
      const kept = idx.filter((m) => m.id !== id);
      saveIndex(kept);
      try { fs.unlinkSync(path.join(dir, id + '.json')); } catch (e) { /* zaten yok */ }
      return { deleted: idx.length - kept.length };
    },
    deleteMany({ ids, before } = {}) {
      const idSet = Array.isArray(ids) && ids.length ? new Set(ids) : null;
      if (!idSet && !before) return { deleted: 0, ids: [] };
      const idx = loadIndex();
      const doomed = idx.filter((m) => {
        if (idSet) return idSet.has(m.id);
        return String(m.createdAt || '').slice(0, 10) < before;
      });
      const doomedIds = new Set(doomed.map((m) => m.id));
      saveIndex(idx.filter((m) => !doomedIds.has(m.id)));
      doomedIds.forEach((id) => { try { fs.unlinkSync(path.join(dir, id + '.json')); } catch (e) {} });
      return { deleted: doomedIds.size, ids: [...doomedIds] };
    },
  };
}

module.exports = { jsonIndexStore };
