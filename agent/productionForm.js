// Uretim formu: DETERMINISTIK baski/nakis adet hesabi + maliyet/fiyat esleme.
// Model adet/toplam/maliyet HESAPLAMAZ - burasi hesaplar. Cozemedigini "manuel kontrol" isaretler.

const pe = require('./pricingEngine');
const r2 = pe.round2;

const SIZE_KEYS = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'];
const AREA_ALIASES = {
  'gogus': 'göğüs', 'göğüs': 'göğüs', 'sol gogus': 'sol göğüs', 'sag gogus': 'sağ göğüs',
  'sirt': 'sırt', 'sırt': 'sırt', 'arka': 'sırt',
  'kol': 'kol', 'sol kol': 'sol kol', 'sag kol': 'sağ kol', 'kollar': 'kol',
  'ense': 'ense', 'kapuson': 'kapüşon', 'kapüşon': 'kapüşon', 'yaka': 'yaka', 'on': 'ön', 'ön': 'ön',
};
function normArea(a) {
  const k = String(a || '').toLocaleLowerCase('tr').replace(/[İıI]/g, 'i').trim();
  return AREA_ALIASES[k] || String(a || '').trim();
}
function sizeTotal(sb) {
  if (!sb || typeof sb !== 'object') return 0;
  return SIZE_KEYS.reduce((s, k) => s + (parseInt(sb[k], 10) || 0), 0);
}

// special_instructions -> her biri { text, affects?, technique?, area?, delta?, resolved }
// delta: baski/nakis adedine eklenecek (genelde negatif). Model verdiyse kullan, yoksa metinden
// "N ... yok / hariç / eksik" kalibi ile cikar. Cikaramazsak resolved=false -> manuel.
function interpretInstructions(instructions) {
  return (instructions || []).map((raw) => {
    const s = typeof raw === 'string' ? { text: raw } : Object.assign({}, raw);
    const text = String(s.text || '').trim();
    const low = text.toLocaleLowerCase('tr').replace(/[İıI]/g, 'i');
    let delta = Number.isFinite(Number(s.delta)) ? Number(s.delta) : null;
    let affects = s.affects || null; // 'print' | 'embroidery'
    let area = s.area ? normArea(s.area) : null;

    if (!affects) {
      if (/nak[ıi]ş|nakis/.test(low)) affects = 'embroidery';
      else if (/bask[ıi]/.test(low)) affects = 'print';
    }
    if (!area) {
      // kelime siniri ile esle - "sonra" icindeki "on" gibi yanlis eslesmeleri onle
      for (const k of Object.keys(AREA_ALIASES)) {
        const re = new RegExp('(^|[^a-zğüşıöç])' + k.replace(/ /g, '\\s+') + '([^a-zğüşıöç]|$)', 'i');
        if (re.test(low)) { area = AREA_ALIASES[k]; break; }
      }
    }
    if (delta == null) {
      // "2 L bedende sirt baskisi yok" / "3 adet ... haric" / "... yok"
      const m = low.match(/(\d+)\s*(?:adet|tane|l|xl|s|m|xs|xxl|3xl)?[^0-9]*(yok|har[ıi]ç|haric|eksik|olmayacak|yapilmayacak|yapılmayacak)/);
      if (m && /(yok|har[ıi]ç|haric|eksik|olmayacak|yapilmayacak|yapılmayacak)/.test(low)) delta = -Math.abs(parseInt(m[1], 10));
    }
    const resolved = delta != null && affects && area;
    return { text, affects, technique: affects === 'embroidery' ? 'nakis' : 'baski', area, delta, resolved };
  });
}

// Ana hesap. input: {
//   total_quantity, size_breakdown, print_areas:[], embroidery_areas:[], special_instructions:[]
// }
// Doner: {
//   totalQty, sizeTotalMismatch, printCounts:{area:qty}, embroideryCounts:{area:qty},
//   instructions:[...], unresolved:[...], warnings:[]
// }
function computeQuantities(input) {
  const warnings = [];
  const sbT = sizeTotal(input.size_breakdown);
  let totalQty = parseInt(input.total_quantity, 10);
  if (!Number.isFinite(totalQty) || totalQty <= 0) {
    totalQty = sbT || 0;
    if (totalQty) warnings.push('Toplam adet formda okunamadı, beden dağılımı toplamı (' + totalQty + ') kullanıldı.');
  }
  const sizeTotalMismatch = (sbT > 0 && totalQty > 0 && sbT !== totalQty);
  if (sizeTotalMismatch) warnings.push('Beden dağılımı toplamı (' + sbT + ') ile toplam adet (' + totalQty + ') uyuşmuyor — manuel kontrol.');

  const instructions = interpretInstructions(input.special_instructions);
  const unresolved = instructions.filter((i) => !i.resolved).map((i) => i.text);
  if (unresolved.length) warnings.push(unresolved.length + ' özel talimat otomatik yorumlanamadı — baskı/nakış adetlerini manuel doğrulayın: "' + unresolved.join('" ; "') + '"');

  const buildCounts = (areas, technique) => {
    const out = {};
    (areas || []).forEach((a) => {
      const A = normArea(a);
      let q = totalQty;
      instructions.forEach((ins) => {
        if (ins.resolved && ins.technique === technique && ins.area && ins.area === A) q = r2(q + ins.delta);
      });
      out[A] = Math.max(0, q);
    });
    return out;
  };

  return {
    totalQty,
    sizeTotalMismatch,
    printCounts: buildCounts(input.print_areas, 'baski'),
    embroideryCounts: buildCounts(input.embroidery_areas, 'nakis'),
    instructions,
    unresolved,
    warnings,
  };
}

// Panelin maliyet/fiyat motoruyla esle. ct = data.costTemplates.
// input: uretim formu cikarimi. sizes: {baski: {area:'Orta Boyut'}, nakis:{...}} - kullanici secer,
//        verilmemisse null -> "boyut manuel".
// Doner: { templateMatch, costItems, costTotal, suggestedUnitPrice, priceTierAvailable, needsManual, notes:[] }
function matchCostAndPrice(ct, input, qtyResult, chosenSizes) {
  const notes = [];
  let needsManual = false;
  if (!ct || !(ct.products || []).length) {
    return { templateMatch: null, costItems: [], costTotal: 0, suggestedUnitPrice: null, priceTierAvailable: false, needsManual: true, notes: ['Maliyet şablonları yüklü değil — manuel maliyet/fiyat gerekli.'] };
  }
  const tm = pe.matchTemplate(ct, input.product_type || input.product_description);
  if (!tm) {
    needsManual = true;
    notes.push('Ürün tipi "' + (input.product_type || '-') + '" bir maliyet şablonuyla eşleşmedi — manuel maliyet/fiyat gerekli.');
    return { templateMatch: null, costItems: [], costTotal: 0, suggestedUnitPrice: null, priceTierAvailable: false, needsManual, notes };
  }
  if (tm.score < 0.75) notes.push('Şablon eşleşmesi kesin değil (%' + Math.round(tm.score * 100) + '): "' + tm.name + '" — kontrol edin.');

  // baski/nakis kalemleri: her bolge icin adet qtyResult'tan, boyut kullanicidan
  const bnItems = [];
  const areaSize = (technique, area) => {
    const cs = chosenSizes && chosenSizes[technique];
    if (cs && cs[area]) return cs[area];
    if (cs && cs['*']) return cs['*'];
    return null;
  };
  Object.entries(qtyResult.printCounts).forEach(([area, qty]) => {
    const size = areaSize('baski', area);
    if (!size) { needsManual = true; notes.push('Baskı boyutu seçilmeli: "' + area + '" (' + qty + ' adet).'); }
    else bnItems.push({ type: 'baski', size, area, qty });
  });
  Object.entries(qtyResult.embroideryCounts).forEach(([area, qty]) => {
    const size = areaSize('nakis', area);
    if (!size) { needsManual = true; notes.push('Nakış boyutu seçilmeli: "' + area + '" (' + qty + ' adet).'); }
    else bnItems.push({ type: 'nakis', size, area, qty });
  });

  const costItems = pe.calcTemplateCostItems(ct, tm.name, qtyResult.totalQty, [], bnItems);
  const costTotal = pe.totalOf(costItems);

  const sp = pe.suggestedPrice(ct, tm.name, qtyResult.totalQty);
  const priceTierAvailable = sp != null;
  if (!priceTierAvailable) notes.push('"' + tm.name + '" için fiyat tablosu yok — satış fiyatı manuel girilmeli.');

  return {
    templateMatch: tm,
    baskiNakisItems: bnItems,
    costItems, costTotal,
    suggestedUnitPrice: sp,
    priceTierAvailable,
    needsManual,
    notes,
  };
}

module.exports = { computeQuantities, matchCostAndPrice, interpretInstructions, normArea, SIZE_KEYS, sizeTotal };
