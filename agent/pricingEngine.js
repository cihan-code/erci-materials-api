// Panelin (index.html) maliyet/fiyat motorunun BIREBIR portu.
// YENI motor DEGIL - ayni fonksiyonlar: getTemplate, calcTemplateCostItems, suggestedPrice.
// Kaynak: costTemplates (panel-data icinde).

const { round2 } = require('./lib/util');
function norm(s) {
  return String(s || '').toLocaleLowerCase('tr').replace(/[İıI]/g, 'i').replace(/[^a-z0-9ğüşöç]+/g, ' ').trim();
}

function getTemplate(ct, name) {
  return (ct && ct.products || []).find((p) => p.name === name) || null;
}

// urun tipi metnini sablon adiyla esle (fuzzy). Doner: { name, score } | null
function matchTemplate(ct, productTypeText) {
  const products = (ct && ct.products || []);
  if (!products.length || !productTypeText) return null;
  const q = norm(productTypeText);
  // tam
  let hit = products.find((p) => norm(p.name) === q);
  if (hit) return { name: hit.name, score: 1 };
  // icerme
  hit = products.find((p) => q.includes(norm(p.name)) || norm(p.name).includes(q));
  if (hit) return { name: hit.name, score: 0.8 };
  // yaygin esanlamlar
  const syn = {
    'tshirt': 'Tişört', 't shirt': 'Tişört', 'tisort': 'Tişört', 'tişört': 'Tişört', 'ti̇şört': 'Tişört',
    'sweat': 'Sweatshirt', 'sweatshirt': 'Sweatshirt', 'hoodie': 'Sweatshirt', 'kapusonlu': 'Sweatshirt', 'kapüşonlu': 'Sweatshirt', 'kapşonlu': 'Sweatshirt',
    'polar': 'Polar', 'polo': 'Polo Yaka', 'polo yaka': 'Polo Yaka',
    'esofman': 'Eşofman Altı', 'eşofman': 'Eşofman Altı', 'esofman alti': 'Eşofman Altı',
  };
  for (const k of Object.keys(syn)) {
    if (q.includes(k)) { const p = products.find((x) => x.name === syn[k]); if (p) return { name: p.name, score: 0.6 }; }
  }
  // kelime ortakligi
  const qs = new Set(q.split(' ').filter((w) => w.length > 2));
  let best = null;
  products.forEach((p) => {
    const common = norm(p.name).split(' ').filter((w) => w.length > 2 && qs.has(w)).length;
    if (common && (!best || common > best.common)) best = { name: p.name, common };
  });
  return best ? { name: best.name, score: 0.5 } : null;
}

// panel calcTemplateCostItems birebir. baskiNakisItems: [{type:'baski'|'nakis', size:'Orta Boyut', qty?}]
// qty verilmezse tumTutar (toplam adet). qty verilirse o kalem icin o adet.
function calcTemplateCostItems(ct, templateName, totalQty, extraNames, baskiNakisItems) {
  const items = [];
  const tpl = getTemplate(ct, templateName);
  if (tpl) {
    (tpl.items || []).forEach((it) => items.push({ category: it.category, amount: round2(it.amount * totalQty) }));
    (tpl.extras || []).forEach((ex) => {
      if ((extraNames || []).includes(ex.name) && ex.amount) items.push({ category: ex.name, amount: round2(ex.amount * totalQty) });
    });
  }
  (baskiNakisItems || []).forEach((it) => {
    const dict = it.type === 'baski' ? (ct.baski || {}) : (ct.nakis || {});
    const label = it.type === 'baski' ? 'Baskı' : 'Nakış';
    const q = it.qty != null ? it.qty : totalQty;
    const tag = it.label || it.area || '';
    if (dict[it.size] != null) items.push({ category: label + ' (' + (tag ? tag + ' - ' : '') + it.size + ', ' + q + ' adet)', amount: round2(dict[it.size] * q) });
  });
  return items;
}

// panel suggestedPrice birebir. Adet tabloda yoksa null.
function suggestedPrice(ct, templateName, qty) {
  const list = (ct.price_list || {})[templateName];
  if (!list) return null;
  const tiers = ct.price_tiers || [];
  const idx = tiers.findIndex((t) => qty >= t.min && qty <= t.max);
  if (idx === -1) return null;
  return list[idx] != null ? list[idx] : null;
}

function totalOf(items) { return round2((items || []).reduce((s, x) => s + (x.amount || 0), 0)); }

module.exports = { getTemplate, matchTemplate, calcTemplateCostItems, suggestedPrice, totalOf, round2, norm };
