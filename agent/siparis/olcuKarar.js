'use strict';
// G61: the decision that turns one automatic measurement attempt into a size.
// A confirmation opens only when it is unclear whether the position carries a print
// at all; otherwise every print leaves with a size marked as one of three states:
//   otomatik  - measured on the picture and consistent;
//   yaklasik  - measured, but a check disagreed (≈ on the form, with the reason);
//   standart  - not measurable, the usual width of the position (≈, "standart ölçü").
// measure_source.durum carries the state for the customer page and the approval chain (G63/G64);
// olcuDurumu is the same value under its first name.
// Pure function: no database, no files. Sizes are integer millimetres.
const { standardFor } = require('./konumStandartlari');

const SLEEVES = ['kol', 'sol_kol', 'sag_kol'];
const WIDTH_STEP = 5; // mm; the workshop sets widths in half centimetres
const AGREE = .10; // eye and pixel widths within 10% confirm each other
const RATIO_NOTE = .05, RATIO_APPROX = .10;
const SLEEVE_VERTICAL = 2.5; // along/across of a text running down the sleeve
// An upright box around a slanted text understates its length (G61: a script along the sleeve
// gave 2.25 in the eye's box); set on one example, adjust with more.
const SLEEVE_VERTICAL_BOX = 2.0;
const SUGGESTION = 'Sistem önerisi';

const pct = n => `%${Math.round(n * 1000) / 10}`.replace('.', ',');
const cm = mm => String(Math.round(mm) / 10).replace('.', ',');
const positive = n => Number.isFinite(n) && n > 0;
const roundWidth = w => Math.max(WIDTH_STEP, Math.round(w / WIDTH_STEP) * WIDTH_STEP);

// The box the pixel path located, scaled, when it would not vouch for it (G58 suggestion).
function candidateSize(s) {
  const b = s?.candidateBoxPx, k = s?.mmPerPx;
  if (!b || !(k > 0) || ![b.w, b.h].every(positive)) return null;
  return { w: b.w * k, h: b.h * k };
}
// Width/height ratio usable for the height when the width is the only measured edge.
function shapeRatio(s, designRatio, sleeve, eyeAspect) {
  if (!sleeve && positive(designRatio)) return { ratio: designRatio, from: 'desen' };
  const g = s?.goz?.boxPx;
  if (!sleeve && g && positive(g.w) && positive(g.h)) return { ratio: g.w / g.h, from: 'goz_kutusu' };
  if (sleeve && positive(s?.observedAlongPx) && positive(s?.observedAcrossPx))
    return { ratio: s.observedAlongPx / s.observedAcrossPx, from: 'aday_kutu' };
  // The eye's box on a sleeve: its long side runs along the arm (a slanted script stays long).
  if (sleeve && positive(eyeAspect)) return { ratio: Math.max(eyeAspect, 1 / eyeAspect), from: 'goz_kutusu' };
  const b = s?.candidateBoxPx;
  if (!sleeve && b && positive(b.w) && positive(b.h)) return { ratio: b.w / b.h, from: 'aday_kutu' };
  return null;
}

/**
 * result: autoMeasure output after documents.explain (reasons, measure_source).
 * ctx: {position, product, standards (konumStandartlari table), designRatio, gozConflict,
 *   gozKol: the eye on a sleeve, {aspect} of its print box or {baskiYok}}.
 */
function decide(result, ctx = {}) {
  const s = { ...(result.measure_source || {}) }, sleeve = SLEEVES.includes(ctx.position);
  const pixelNotes = (result.reasons || []).filter(r => !String(r).startsWith(SUGGESTION));
  const notes = [];
  let state = 'otomatik', from = null, raw = null;
  const pixel = positive(result.width_mm) && positive(result.height_mm)
    ? { w: result.width_mm, h: result.height_mm, from: 'olcum' }
    : (() => { const c = candidateSize(s); return c && { ...c, from: 'aday' }; })();
  const eye = s.goz && positive(s.goz.width_mm) && positive(s.goz.height_mm) ? { w: s.goz.width_mm, h: s.goz.height_mm } : null;

  // Only the question "is there a print here at all" stays with the person.
  // Torso: garments were found and searched, no print. Sleeve/leg: the linked design was searched
  // on a found sleeve/leg without a hit (autoMeasureSleeve/Leg state exactly this).
  const products = Array.isArray(s.views) ? s.views.length : 0;
  // Without a design file the limb search has nothing to look for: that is no evidence of absence.
  const limbSearched = pixelNotes.some(r => /(Kol|Bacak) üzerinde desen adayı bulunamadı/.test(r)) && !pixelNotes.some(r => /desen dosyası yok/.test(r));
  const eyeMiss = s.goz?.baskiYok || (sleeve && ctx.gozKol?.baskiYok);
  const unclear = eyeMiss ? `Göz bu konumda baskı görmedi: ${eyeMiss}`
    : s.goz?.urunYok ? `Göz görselde ürün görmedi: ${s.goz.urunYok}`
      : !eye && !pixel && !s.candidateBoxPx && (products > 0 || limbSearched)
        ? `Görselde ürün var, ama bu konumda baskı bulunamadı; konumda baskı olup olmadığı teyit edilmeli.` : null;
  if (unclear) {
    const reasons = [...pixelNotes, unclear];
    return { ...result, width_mm: null, height_mm: null, needs_confirmation: true, reasons, reason: reasons.join(' '),
      measure_source: { ...s, olcuDurumu: 'teyit', notlar: reasons } };
  }

  if (eye) {
    raw = eye; from = 'görselden (göz)';
    if (pixel) {
      const difference = Math.abs(pixel.w - eye.w) / eye.w;
      s.gozPikselFarki = Math.round(difference * 1000) / 1000;
      if (difference > AGREE) {
        state = 'yaklasik';
        notes.push(`Göz kutusu ile piksel ölçüsü farklı (${cm(eye.w)} ve ${cm(pixel.w)} cm, fark ${pct(difference)}); göz kutusu esas alındı.`);
      }
    }
  } else if (pixel) {
    raw = pixel; from = pixel.from === 'olcum' ? 'görselden (piksel)' : 'görselden (aday kutu)';
    if (pixel.from === 'aday' || pixelNotes.length) state = 'yaklasik';
  }
  if (ctx.gozConflict) { notes.push(ctx.gozConflict); if (state === 'otomatik') state = 'yaklasik'; }
  if ((s.views || []).some(v => v?.viewEvidence?.viewSource === 'varsayilan')) {
    s.varsayilanDizilim = true;
    notes.push('Ön/arka: varsayılan dizilim (yan yanaysa soldaki, üst üsteyse üstteki ürün ön).');
  }

  const shape = shapeRatio(s, ctx.designRatio, sleeve, ctx.gozKol?.aspect);
  if (raw) s.hamOlcu = { width_mm: Math.round(raw.w), height_mm: Math.round(raw.h) };
  // Only the width is measured: the height follows the design's own proportion.
  if (raw && !sleeve && positive(ctx.designRatio)) {
    const r = ctx.designRatio, boxRatio = raw.w / raw.h, off = Math.abs(boxRatio / r - 1);
    // A partly found print is short on one edge: the edge that gives the larger print is the one consistent with the design.
    const width = boxRatio < r ? raw.h * r : raw.w;
    if (off > RATIO_NOTE) notes.push(`Kutu oranı (${boxRatio.toFixed(2)}) desen oranından (${r.toFixed(2)}) farklı; en ${boxRatio < r ? 'kutunun boyundan desen oranıyla' : 'kutunun eninden'} alındı, boy desen oranından.`);
    if (off > RATIO_APPROX && state === 'otomatik') state = 'yaklasik';
    raw = { w: width, h: width / r };
    s.boyKaynagi = 'desen_orani';
  }

  const along = shape?.ratio ?? (raw && positive(raw.h) ? raw.w / raw.h : null);
  const vertical = sleeve && along >= (shape?.from === 'goz_kutusu' ? SLEEVE_VERTICAL_BOX : SLEEVE_VERTICAL);
  const std = ctx.standards ? standardFor(ctx.standards, ctx.product, ctx.position, { dikey: vertical }) : null;
  if (std) s.konumStandardi = std;
  const band = std && `${cm(std.min)}–${cm(std.max)} cm`;
  if (raw && std) {
    if (raw.w < std.min / 2 || raw.w > std.max * 2) {
      notes.push(`Ölçülen en ${cm(raw.w)} cm, ${ctx.position} için olağan aralığın (${band}) çok dışında; ölçü yerine standart en (${cm(std.varsayilan)} cm) yazıldı.`);
      state = 'standart'; from = 'standart ölçü (ölçü aralık dışı)';
      // The measured box keeps the print's proportion even when its size is not believable.
      const r = s.boyKaynagi === 'desen_orani' ? ctx.designRatio : positive(raw.h) ? raw.w / raw.h : shape?.ratio;
      raw = { w: std.varsayilan, h: positive(r) ? std.varsayilan / r : null };
    } else if (raw.w < std.min || raw.w > std.max) {
      notes.push(`Ölçülen en ${cm(raw.w)} cm, ${ctx.position} için olağan aralığın (${band}) dışında.`);
      if (state === 'otomatik') state = 'yaklasik';
    }
    if (std.kasaMax && raw.w > std.kasaMax) {
      notes.push(`En ${cm(raw.w)} cm, baskı kasası sınırını (${cm(std.kasaMax)} cm) aşıyor.`);
      if (state === 'otomatik') state = 'yaklasik';
    }
  }
  if (!raw) {
    if (!std) {
      // No usual width for this position: nothing to write, the reasons stay a confirmation.
      const reasons = pixelNotes.length ? pixelNotes : ['Otomatik ölçü çıkmadı ve bu konum için standart en yok.'];
      return { ...result, width_mm: null, height_mm: null, needs_confirmation: true, reasons, reason: reasons.join(' '),
        measure_source: { ...s, olcuDurumu: 'teyit', notlar: reasons } };
    }
    state = 'standart'; from = 'standart ölçü (ölçülemedi)';
    const r = shape?.ratio;
    raw = { w: std.varsayilan, h: positive(r) ? std.varsayilan / r : null };
    notes.push(`Görselden ölçü çıkmadı; ${ctx.position} için standart en ${cm(std.varsayilan)} cm yazıldı${positive(r) ? ` (boy ${shape.from === 'desen' ? 'desen' : 'kutu'} oranından)` : '; boy için oran yok'}.`);
  }

  const width = roundWidth(raw.w);
  const ratio = s.boyKaynagi === 'desen_orani' ? ctx.designRatio : positive(raw.h) ? raw.w / raw.h : null;
  const height = positive(ratio) ? Math.max(1, Math.round(width / ratio)) : null;
  if (height == null) notes.push('Boy bilinmiyor: desen dosyası ya da ölçülebilir kutu yok; ölçü bekleniyor.');
  delete s.oneri;
  const all = [...pixelNotes, ...notes];
  // The form carries one short reason: the decision's own note first, else the measurement's.
  const lead = [...notes.filter(n => !/^Ön\/arka: varsayılan/.test(n)), ...pixelNotes][0];
  if (state !== 'otomatik' && lead) s.olcuNotu = lead.length > 160 ? `${lead.slice(0, 157)}…` : lead;
  return { ...result, width_mm: width, height_mm: height, needs_confirmation: false, reasons: [], reason: '',
    measure_source: { ...s, durum: state, olcuDurumu: state, olcuKaynagi: from, notlar: all } };
}
// Text for the forms' "≈" line: an approximate or standard size says so and why (first reason).
function formNote(source) {
  if (!source || !['yaklasik', 'standart'].includes(source.olcuDurumu)) return null;
  const first = source.olcuNotu;
  const head = source.olcuDurumu === 'standart' ? 'Standart ölçü' : 'Yaklaşık ölçü';
  return first ? `${head}: ${first}` : head;
}
module.exports = { decide, formNote, roundWidth, WIDTH_STEP, AGREE };
