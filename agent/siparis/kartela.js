'use strict';
// Company colour cards (kartela.json): fabric display names and the numbered colours a customer picks from.
// A carded stock item is "fabric + card number + colour" but keeps the matching.fabricKey "<type>|<colour>" key, so an
// invoice that writes the colour in words lands on the same item. The colour name builds that key, so a name the card
// marks as unconfirmed (teyit) never becomes a key, and an older item is bound to a number only on an exact key match.
const { tx, audit, fail } = require('./db');
const { typeKey, colorKey, dictionaryColorKey } = require('./matching');

const HEX = /^#[0-9a-f]{6}$/i;
const text = v => typeof v === 'string' && v.trim() !== '';
// Validates the card file once at load; a broken card fails loudly instead of naming items by guess.
function loadKartela(data) {
  const bad = message => { throw new Error(`kartela.json: ${message}`); };
  if (!data || !Array.isArray(data.kartelalar)) bad('kartelalar listesi gerekli');
  const raw = new Map(), byType = new Map();
  for (const k of data.kartelalar) {
    if (!text(k?.id) || !text(k.ad)) bad('her kartelada id ve ad gerekli');
    if (raw.has(k.id)) bad(`${k.id} iki kez var`);
    if (k.not != null && !text(k.not)) bad(`${k.id}: not metin olmalı`);
    const kumaslar = Object.entries(k.kumaslar || {});
    if (!kumaslar.length) bad(`${k.id}: kumaslar boş`);
    for (const [tur, ad] of kumaslar) {
      if (typeKey(tur) !== tur) bad(`${k.id}: "${tur}" fabric_key tür biçiminde değil`);
      if (!text(ad)) bad(`${k.id}: ${tur} için ad gerekli`);
      if (byType.has(tur)) bad(`${tur} iki kartelada var`);
      byType.set(tur, k.id);
    }
    if (!Array.isArray(k.renkler) === !k.renklerKaynagi) bad(`${k.id}: renkler ya da renklerKaynagi (yalnız biri) gerekli`);
    raw.set(k.id, k);
  }
  const cards = [];
  for (const k of raw.values()) {
    const source = k.renklerKaynagi ? raw.get(k.renklerKaynagi) : k;
    if (!source || !Array.isArray(source.renkler)) bad(`${k.id}: renklerKaynagi ${k.renklerKaynagi} renk listesi olan bir kartela değil`);
    const seen = new Set();
    const renkler = source.renkler.map(r => {
      if (!Number.isSafeInteger(r?.no) || r.no < 1 || seen.has(r.no)) bad(`${source.id}: renk numarası geçersiz ya da tekrarlı (${r?.no})`);
      seen.add(r.no);
      if (!text(r.renk) || !HEX.test(r.hex || '')) bad(`${source.id} ${r.no}: renk adı ve #rrggbb hex gerekli`);
      const renkKey = dictionaryColorKey(r.renk);
      if (!renkKey) bad(`${source.id} ${r.no}: "${r.renk}" renk sözlüğünde yok`);
      if (r.teyit != null && !text(r.teyit)) bad(`${source.id} ${r.no}: teyit metin olmalı`);
      return { no: r.no, renk: r.renk.trim(), renkKey, hex: r.hex.toLowerCase(),
        ...(r.dokulu ? { dokulu: true } : {}), ...(r.teyit ? { teyit: r.teyit.trim() } : {}) };
    });
    cards.push({ id: k.id, ad: k.ad.trim(), ...(k.not ? { not: k.not.trim() } : {}),
      kumaslar: Object.entries(k.kumaslar).map(([tur, ad]) => ({ tur, ad: ad.trim() })), renkler });
  }
  const typeCard = new Map(cards.flatMap(c => c.kumaslar.map(f => [f.tur, c])));
  return { cards, typeCard };
}
const KARTELA = loadKartela(require('./kartela.json'));

function kartelaView() {
  return { surum: 1, kartelalar: structuredClone(KARTELA.cards) };
}
const cardFor = (type, k = KARTELA) => k.typeCard.get(type) || null;
// Carded types take the card's fabric name; other types keep the key-derived label they had.
function fabricName(type, k = KARTELA) {
  return cardFor(type, k)?.kumaslar.find(f => f.tur === type).ad ?? String(type).replace(/_/g, ' ');
}
const standardName = (type, r, k) => `${fabricName(type, k)} ${r.no} ${r.renk}`;
function keyParts(fabricKey) {
  const s = String(fabricKey ?? ''), i = s.indexOf('|');
  return i < 0 ? null : { type: s.slice(0, i), color: s.slice(i + 1) };
}
// Stored colour numbers may come from a spreadsheet as "12.0"; only a whole number reads, anything else is null.
function cardNo(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  const m = /^\s*(\d+)(?:\.0)?\s*$/.exec(String(value ?? ''));
  const n = m ? Number(m[1]) : null;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
// Bound only when the stored number names the very colour the item key carries.
function itemKartela(item) {
  const parts = keyParts(item?.fabric_key), card = parts && cardFor(parts.type);
  const no = cardNo(item?.color_no);
  if (!card || no == null) return null;
  const r = card.renkler.find(c => c.no === no);
  return r && r.renkKey === parts.color ? { id: card.id, ad: card.ad, no: r.no } : null;
}
function withKartela(item) {
  if (!item) return item;
  const kartela = itemKartela(item);
  return kartela ? { ...item, kartela } : item;
}
// {tur, kartelaNo, renk?} → the item a card number defines; 400 with a Turkish reason otherwise.
function resolveKartelaItem({ tur, kartelaNo, renk }) {
  if (!text(tur) || tur.length > 100) fail('Kumaş türü gerekli (en çok 100 karakter)');
  const type = typeKey(tur), card = cardFor(type);
  if (!card) fail(`"${tur.trim()}" için kartela yok; bu kumaşta kalem renk adıyla açılır`);
  const no = typeof kartelaNo === 'number' ? kartelaNo : /^\s*\d+\s*$/.test(String(kartelaNo)) ? Number(kartelaNo) : NaN;
  if (!Number.isSafeInteger(no) || no < 1) fail('Kartela numarası pozitif tam sayı olmalı');
  const r = card.renkler.find(c => c.no === no);
  if (!r) fail(`${card.ad} kartelasında ${no} numara yok`);
  if (r.teyit) fail(`${card.ad} kartelasında ${no} numaralı rengin adı teyit bekliyor (${r.teyit}); kalem açılmadı`);
  if (renk != null && renk !== '' && colorKey(renk) !== r.renkKey) fail(`Renk "${renk}" kartelada ${no} numaralı renk (${r.renk}) değil`);
  return { card, type, renk: r, fabricKey: `${type}|${r.renkKey}`, name: standardName(type, r) };
}

const show = v => (v == null || v === '' ? '—' : `"${v}"`);
const FIELD_LABELS = { name: 'ad', color_name: 'renk', color_no: 'no', color_hex: 'hex' };
// One row per stock item: what kartela-uygula would write, or why it leaves the item alone.
function kartelaPlan(db, k = KARTELA) {
  return db.prepare('SELECT * FROM stock_items ORDER BY id').all().map(item => {
    const row = { id: item.id, fabricKey: item.fabric_key, name: item.name };
    const skip = neden => ({ ...row, durum: 'eslesmedi', neden });
    if (String(item.fabric_key).startsWith('legacy:')) return skip('ham satır (legacy); önce tür ve renk eşlenmeli');
    const parts = keyParts(item.fabric_key);
    if (!parts) return skip('anahtar "<tür>|<renk>" biçiminde değil');
    const card = cardFor(parts.type, k);
    if (!card) return skip('türün kartelası yok');
    if (text(item.color_name) && colorKey(item.color_name) !== parts.color)
      return skip(`renk adı "${item.color_name}" anahtardaki renkle (${parts.color}) aynı değil`);
    const candidates = card.renkler.filter(r => r.renkKey === parts.color);
    if (!candidates.length) return skip(`${card.ad} kartelasında ${parts.color} rengi yok`);
    if (candidates.length > 1) return skip(`birden çok aday: ${candidates.map(r => `${r.no} ${r.renk}`).join(', ')}`);
    const [r] = candidates;
    if (r.teyit) return skip(`kartela ${r.no} numaralı rengin adı teyit bekliyor`);
    if (item.color_no != null && String(item.color_no).trim() !== '') {
      const stored = cardNo(item.color_no), shown = String(item.color_no).trim();
      if (stored == null) return skip(`kayıtlı no ${shown} tam sayı değil; '${r.renk}' kartelada ${r.no}`);
      if (stored !== r.no) {
        const there = card.renkler.find(c => c.no === stored);
        return skip(`kayıtlı no ${shown} kartelada ${there ? `'${there.renk}'` : 'yok'}; '${r.renk}' kartelada ${r.no}`);
      }
    }
    const target = { name: standardName(parts.type, r, k), color_name: r.renk, color_no: String(r.no), color_hex: r.hex };
    const changes = Object.keys(target).filter(f => item[f] !== target[f])
      .map(f => ({ field: f, from: item[f] ?? null, to: target[f] }));
    return { ...row, durum: changes.length ? 'degisir' : 'uygun', kartela: { id: card.id, no: r.no }, target, changes,
      neden: changes.map(c => `${FIELD_LABELS[c.field]}: ${show(c.from)} → ${show(c.to)}`).join('; ') };
  });
}
// Writes numbers, hex and standard names to carded items that match exactly; everything else stays as it is.
function applyKartela(db, { dry = false, kartela = KARTELA } = {}) {
  const run = () => {
    const rows = kartelaPlan(db, kartela);
    if (!dry) for (const r of rows.filter(x => x.durum === 'degisir')) {
      const before = db.prepare('SELECT name,color_name,color_no,color_hex FROM stock_items WHERE id=?').get(r.id);
      db.prepare('UPDATE stock_items SET name=?,color_name=?,color_no=?,color_hex=? WHERE id=?')
        .run(r.target.name, r.target.color_name, r.target.color_no, r.target.color_hex, r.id);
      audit(db, null, 'kartela_uygula', r.id, { kartela: r.kartela.id, no: r.kartela.no, onceki: before, yeni: r.target, cli: true });
    }
    return rows;
  };
  const rows = dry ? run() : tx(db, run);
  const count = durum => rows.filter(r => r.durum === durum).length;
  return { rows, changed: count('degisir'), unchanged: count('uygun'), unmatched: count('eslesmedi') };
}

// G59: fabric types for the order line's "Kumaş türü" list, one row per type (never per colour). A type carries its card
// colours (with the stock item that already exists for each, or none) plus stock-only colours the card does not list.
function fabricTypeList(db, k = KARTELA) {
  const items = db.prepare('SELECT * FROM stock_items ORDER BY id').all();
  const types = new Map();
  const add = (tur, ad, card) => { if (!types.has(tur)) types.set(tur, { tur, ad, kartela: card ? { id: card.id, ad: card.ad } : null, renkler: [] }); return types.get(tur); };
  const byKey = new Map(items.map(i => [i.fabric_key, i]));
  for (const card of k.cards) for (const f of card.kumaslar) {
    const row = add(f.tur, f.ad, card), used = new Set();
    for (const r of card.renkler) {
      const item = byKey.get(`${f.tur}|${r.renkKey}`);
      if (item) used.add(item.id);
      row.renkler.push({ no: r.no, renk: r.renk, hex: r.hex, kartelada: true, stokKalemId: item?.id ?? null,
        ...(r.dokulu ? { dokulu: true } : {}), ...(r.teyit ? { teyit: r.teyit } : {}) });
    }
    row.used = used;
  }
  for (const item of items) {
    const parts = keyParts(item.fabric_key), legacy = String(item.fabric_key).startsWith('legacy:');
    const row = legacy || !parts ? add(item.fabric_key, item.name, null) : add(parts.type, fabricName(parts.type, k), cardFor(parts.type, k));
    if (row.used?.has(item.id)) continue;
    row.renkler.push({ no: cardNo(item.color_no), renk: item.color_name ?? '', hex: item.color_hex ?? null, kartelada: false, stokKalemId: item.id });
  }
  return [...types.values()].map(({ used, ...row }) => row).sort((a, b) => a.ad.localeCompare(b.ad, 'tr'));
}

module.exports = { fabricTypeList, cardNo, loadKartela, kartelaView, fabricName, itemKartela, withKartela, resolveKartelaItem, kartelaPlan, applyKartela };
