'use strict';
// Invoice line → fabric stock item and open order need. Pure functions, no database.
// Finance invoice lines carry fabric and colour only in free text, and a wrong bind moves
// stock and cost to the wrong order, so a line is bound only on unambiguous evidence;
// everything else becomes 'teyit' and the team confirms it.
// Order (spec p.3): a) purchase/order reference with an open need, b) fabric + colour, the
// need's own fabric choice or product default filling a missing fabric type, c) of several
// candidates only one that colour and open kg need single out; otherwise 'teyit'.

const FABRICS = [
  { key: 'sardonlu_3_iplik', aliases: ['sardonlu 3 iplik', 'sardonlu uc iplik', '3 iplik sardonlu', 'uc iplik sardonlu'] },
  { key: 'sardonsuz_3_iplik', aliases: ['sardonsuz 3 iplik', 'sardonsuz uc iplik', '3 iplik sardonsuz', 'uc iplik sardonsuz'] },
  { key: 'lakost', aliases: ['lakost', 'lacoste', 'lakost pike', 'lacoste pike', 'pike lakost'] },
  { key: 'supren_30_1', aliases: ['supren 30/1', 'suprem 30/1', '30/1 suprem', '30/1 supren'] },
  { key: 'kaskorse', aliases: ['kaskorse', 'kas korse'] },
  { key: 'ribana', aliases: ['ribana'] },
  { key: 'astar', aliases: ['astar'] },
  { key: 'penye', aliases: ['penye'] },
];
// Partial fabric names ("3 iplik", "süprem" without yarn count): seen outside a full alias they leave the type open.
const FABRIC_HINTS = new Set(['iplik', 'sardonlu', 'sardonsuz', 'suprem', 'supren', 'pike', 'interlok', 'kase', 'scuba',
  'dalgic', 'selanik', 'jarse', 'polar', 'likra', 'likrali', 'elastan', 'elastanli']);
const COLORS = [
  { key: 'siyah', label: 'siyah', aliases: ['siyah'] },
  { key: 'beyaz', label: 'beyaz', aliases: ['beyaz'] },
  { key: 'kirik_beyaz', label: 'kırık beyaz', aliases: ['kirik beyaz'] },
  { key: 'ekru', label: 'ekru', aliases: ['ekru'] },
  { key: 'lacivert', label: 'lacivert', aliases: ['lacivert', 'laci'] },
  { key: 'bordo', label: 'bordo', aliases: ['bordo'] },
  { key: 'pembe', label: 'pembe', aliases: ['pembe'] },
  { key: 'gri_melanj', label: 'gri melanj', aliases: ['gri melanj', 'melanj gri'] },
  { key: 'gri', label: 'gri', aliases: ['gri'] },
  { key: 'antrasit', label: 'antrasit', aliases: ['antrasit'] },
  { key: 'kirmizi', label: 'kırmızı', aliases: ['kirmizi'] },
  { key: 'saks_mavi', label: 'saks mavi', aliases: ['saks mavi', 'saks'] },
  { key: 'bebe_mavi', label: 'bebe mavi', aliases: ['bebe mavi'] },
  { key: 'mavi', label: 'mavi', aliases: ['mavi'] },
  { key: 'yesil', label: 'yeşil', aliases: ['yesil'] },
  { key: 'haki', label: 'haki', aliases: ['haki'] },
  { key: 'sari', label: 'sarı', aliases: ['sari'] },
  { key: 'turuncu', label: 'turuncu', aliases: ['turuncu'] },
  { key: 'mor', label: 'mor', aliases: ['mor'] },
  { key: 'lila', label: 'lila', aliases: ['lila'] },
  { key: 'kahverengi', label: 'kahverengi', aliases: ['kahverengi', 'kahve'] },
  { key: 'bej', label: 'bej', aliases: ['bej'] },
  { key: 'fume', label: 'füme', aliases: ['fume'] },
  { key: 'indigo', label: 'indigo', aliases: ['indigo'] },
];
// A shade word next to a dictionary colour ("koyu lacivert") names a different stock item.
const COLOR_PRE = new Set(['acik', 'koyu', 'neon', 'pastel']);
const COLOR_POST = new Set(['melanj', 'tonu']);
const UNITS = { kg: 'kg', kgs: 'kg', kilo: 'kg', kilogram: 'kg', g: 'g', gr: 'g', gram: 'g',
  m: 'm', mt: 'm', mtr: 'm', metre: 'm', adet: 'adet', ad: 'adet' };
// Words that say nothing about the fabric item; anything else unread blocks the default fabric fallback.
const FILLER = new Set(['kumas', 'kumasi', 'renk', 'rengi', 'top', 'rulo', 've', 'ile', 'x']);
const SWEAT_FABRIC = 'sardonlu_3_iplik';
const PRODUCT_DEFAULTS = { sweat: SWEAT_FABRIC, sweatshirt: SWEAT_FABRIC, hoodie: SWEAT_FABRIC, kapusonlu: SWEAT_FABRIC,
  polo: 'lakost', polo_yaka: 'lakost', tisort: 'supren_30_1', tshirt: 'supren_30_1', t_shirt: 'supren_30_1' };

function fold(text) {
  return String(text ?? '').toLocaleLowerCase('tr-TR').replace(/ı/g, 'i')
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function tokens(text) {
  return fold(text).replace(/[×*]/g, ' x ')
    .replace(/(\d)\s*\/\s*(\d)/g, '$1/$2')
    .replace(/(\d)([a-z])/g, '$1 $2').replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/[^a-z0-9/.,]+/g, ' ')
    .split(' ').map(t => t.replace(/^[.,/]+|[.,/]+$/g, '')).filter(Boolean);
}
const slug = text => tokens(text).join('_').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const uniq = list => [...new Set(list.filter(Boolean))];
const phrases = entries => entries.flatMap(e => e.aliases.map(a => ({ key: e.key, words: a.split(' ') })))
  .sort((a, b) => b.words.length - a.words.length);
const FABRIC_PHRASES = phrases(FABRICS), COLOR_PHRASES = phrases(COLORS);
const FABRIC_ALIAS = new Map(FABRIC_PHRASES.map(p => [p.words.join(' '), p.key]));
const COLOR_ALIAS = new Map(COLOR_PHRASES.map(p => [p.words.join(' '), p.key]));
const COLOR_LABEL = new Map(COLORS.map(c => [c.key, c.label]));

// Longest alias first; a token belongs to one phrase only.
function matchPhrases(toks, list, used) {
  const hits = [];
  for (const { key, words } of list)
    for (let i = 0; i + words.length <= toks.length; i++)
      if (words.every((w, k) => toks[i + k] === w && !used[i + k])) {
        for (let k = 0; k < words.length; k++) used[i + k] = true;
        hits.push({ key, start: i, end: i + words.length - 1 });
      }
  return hits;
}

// Turkish invoices write 1.250,5; "1.250" or "1,250" alone may be 1250 or 1,25, so it stays unread (null).
function parseNumber(tok) {
  if (/^\d+$/.test(tok)) return Number(tok);
  if (!/^\d+([.,]\d+)+$/.test(tok)) return null;
  const last = Math.max(tok.lastIndexOf('.'), tok.lastIndexOf(','));
  const dec = tok[last], int = tok.slice(0, last), frac = tok.slice(last + 1);
  const grouped = (s, sep) => new RegExp('^\\d{1,3}(\\' + sep + '\\d{3})+$').test(s);
  if (/[.]/.test(tok) && /[,]/.test(tok)) {
    const group = dec === ',' ? '.' : ',';
    return grouped(int, group) ? Number(int.split(group).join('') + '.' + frac) : null;
  }
  if (int.includes(dec)) return grouped(tok, dec) ? Number(tok.split(dec).join('')) : null;
  if (frac.length === 3 && int !== '0' && int.length <= 3) return null;
  return Number(int + '.' + frac);
}

function typeKey(text) {
  const phrase = tokens(text).join(' ');
  return phrase ? FABRIC_ALIAS.get(phrase) || slug(text) || null : null;
}
function colorKey(name) {
  const phrase = tokens(name).join(' ');
  return phrase ? COLOR_ALIAS.get(phrase) || slug(name) || null : null;
}
// Same format as stock_items.fabric_key: "<type>|<colour>", both canonical ASCII slugs.
function fabricKey(type, color) {
  const t = typeKey(type), c = colorKey(color);
  return t && c ? t + '|' + c : null;
}
function splitFabricKey(key) {
  if (key == null || String(key).trim() === '') return { type: null, color: null };
  const s = String(key), i = s.indexOf('|');
  return i < 0 ? { type: typeKey(s), color: null } : { type: typeKey(s.slice(0, i)), color: colorKey(s.slice(i + 1)) };
}

function defaultFabricFor(productKey) {
  const k = slug(productKey);
  if (!k) return null;
  if (PRODUCT_DEFAULTS[k]) return PRODUCT_DEFAULTS[k];
  return k.split('_').some(w => w === 'sweat' || w === 'sweatshirt') ? SWEAT_FABRIC : null;
}

function parseInvoiceDescription(text) {
  const toks = tokens(text), used = toks.map(() => false), issues = [];
  const issue = (field, message) => issues.push({ field, message });

  const fabrics = uniq(matchPhrases(toks, FABRIC_PHRASES, used).map(h => h.key));
  const hints = toks.filter((t, i) => !used[i] && FABRIC_HINTS.has(t));
  let fabricType = null;
  if (fabrics.length > 1) issue('fabricType', `Açıklamada birden çok kumaş türü var: ${fabrics.join(', ')}.`);
  else if (hints.length) issue('fabricType', `Kumaş türü net değil: "${toks.filter(t => FABRIC_HINTS.has(t) || /\d\/\d/.test(t)).join(' ')}".`);
  else fabricType = fabrics[0] || null;

  const colorHits = matchPhrases(toks, COLOR_PHRASES, used);
  const colors = uniq(colorHits.map(h => h.key));
  const shaded = colorHits.filter(h => COLOR_PRE.has(toks[h.start - 1]) || COLOR_POST.has(toks[h.end + 1]));
  let color = null;
  if (colors.length > 1) issue('colorName', `Açıklamada birden çok renk var: ${colors.map(c => COLOR_LABEL.get(c)).join(', ')}.`);
  else if (shaded.length) {
    const h = shaded[0], from = COLOR_PRE.has(toks[h.start - 1]) ? h.start - 1 : h.start;
    issue('colorName', `Renk tonu sözlükte yok: "${toks.slice(from, COLOR_POST.has(toks[h.end + 1]) ? h.end + 2 : h.end + 1).join(' ')}".`);
  } else color = colors[0] || null;
  for (const h of shaded) {
    if (COLOR_PRE.has(toks[h.start - 1])) used[h.start - 1] = true;
    if (COLOR_POST.has(toks[h.end + 1])) used[h.end + 1] = true;
  }

  const found = [];
  toks.forEach((t, i) => {
    const unit = UNITS[toks[i + 1]];
    if (!unit || !/^\d[\d.,]*$/.test(t)) return;
    used[i] = used[i + 1] = true;
    found.push({ raw: t + ' ' + toks[i + 1], value: parseNumber(t), unit, times: toks[i - 1] === 'x' || toks[i + 2] === 'x' });
  });
  const amounts = found.map(f => f.value == null ? null : f.unit === 'g'
    ? { unit: 'kg', qtyMilli: Math.round(f.value) } : { unit: f.unit, qtyMilli: Math.round(f.value * 1000) });
  let quantity = null, unit = null, qtyMilli = null;
  const bad = found.find(f => f.value == null);
  if (bad) issue('quantity', `Miktar okunamadı: "${bad.raw}" binlik mi ondalık mı belli değil.`);
  else if (found.some(f => f.times)) issue('quantity', 'Miktar çarpımla yazılmış; toplam okunamadı.');
  else if (uniq(amounts.map(a => a.qtyMilli + a.unit)).length > 1) issue('quantity', `Açıklamada birden çok miktar var: ${found.map(f => f.raw).join(', ')}.`);
  else if (amounts.length && amounts[0].qtyMilli <= 0) issue('quantity', 'Açıklamadaki miktar sıfır.');
  else if (amounts.length) {
    ({ unit, qtyMilli } = amounts[0]);
    quantity = qtyMilli / 1000;
  }

  const unknownWords = toks.filter((t, i) => !used[i] && /[a-z/]/.test(t) && !FILLER.has(t) && !FABRIC_HINTS.has(t));
  return { fabricType, colorName: color ? COLOR_LABEL.get(color) : null, colorKey: color, quantity, unit, qtyMilli, unknownWords, issues };
}

function needProfile(need) {
  const own = splitFabricKey(need.fabricKey), named = colorKey(need.colorName);
  const type = own.type || defaultFabricFor(need.productKey), s = need.shortageMilli;
  return {
    need, type, color: own.color || named,
    typeSource: own.type ? 'siparis' : type ? 'varsayilan' : null,
    inconsistent: !!(own.color && named && own.color !== named),
    state: Number.isInteger(s) && s > 0 ? 'open' : s === 0 ? 'closed' : 'invalid',
  };
}
const within = (a, b) => a.split('_').every(w => b.split('_').includes(w));
// 'match': same fabric item; 'conflict': provably different; 'unknown': cannot tell.
// Without a reference the need must name its own type and colour; a reference lets the line fill the gap.
function relate(lineType, lineColor, p, viaRef) {
  if (p.inconsistent) return 'unknown';
  if (lineType && p.type && lineType !== p.type) return 'conflict';
  if (lineColor && p.color && lineColor !== p.color)
    return !viaRef && (within(lineColor, p.color) || within(p.color, lineColor)) ? 'unknown' : 'conflict';
  if (!(lineType || p.type) || !(lineColor || p.color)) return 'unknown';
  if (!viaRef && (!p.type || !p.color)) return 'unknown';
  return 'match';
}
const refKey = v => (v == null ? '' : fold(v).replace(/[^a-z0-9]/g, ''));
const kg = milli => String(milli / 1000).replace('.', ',') + ' kg';
const labels = ps => uniq(ps.map(p => String(p.need.orderNo || p.need.orderLineId))).join(', ');
const colorText = c => COLOR_LABEL.get(c) || c;

function matchInvoiceLine({ line, openNeeds, purchaseAllocations } = {}) {
  if (!line || typeof line !== 'object') throw new TypeError('matchInvoiceLine: line gerekli.');
  if (!Array.isArray(openNeeds)) throw new TypeError('matchInvoiceLine: openNeeds dizi olmalı.');
  const reasons = [];
  let lineType = null, lineColor = null;
  const fail = message => ({ status: 'teyit', fabricKey: lineType && lineColor ? fabricKey(lineType, lineColor) : null,
    allocations: [], unallocatedMilli: null, reasons: [...reasons, message] });

  // Line identity: explicit fields and the description must agree.
  const parsed = parseInvoiceDescription(line.description), own = splitFabricKey(line.fabricKey);
  const types = uniq([own.type, parsed.fabricType]);
  const colors = uniq([own.color, colorKey(line.colorName), parsed.colorKey]);
  if (types.length > 1) return fail(`Kumaş türü çelişiyor: ${types.join(' / ')}.`);
  if (colors.length > 1) return fail(`Renk çelişiyor: ${colors.map(colorText).join(' / ')}.`);
  const issueOf = field => parsed.issues.find(i => i.field === field);
  if (issueOf('fabricType') && !own.type) return fail(issueOf('fabricType').message);
  if (issueOf('colorName') && !own.color && !colorKey(line.colorName)) return fail(issueOf('colorName').message);
  lineType = types[0] || null;
  lineColor = colors[0] || null;

  // Quantity: kg only; the description, when it states an amount, must match the line amount.
  const lineUnit = line.unit == null || line.unit === '' ? null : UNITS[tokens(line.unit).join(' ')] || String(line.unit);
  if (lineUnit && parsed.unit && lineUnit !== parsed.unit) return fail(`Birim çelişiyor: satırda ${lineUnit}, açıklamada ${parsed.unit}.`);
  const unit = lineUnit || parsed.unit;
  if (unit !== 'kg') return fail(unit ? `Birim kg değil (${unit}); kumaş ihtiyacı kg ile tutulur.` : 'Birim okunamadı.');
  if (issueOf('quantity')) return fail(issueOf('quantity').message);
  let qty;
  if (line.qtyMilli == null) {
    if (parsed.qtyMilli == null) return fail('Miktar okunamadı.');
    qty = parsed.qtyMilli;
  } else {
    if (!Number.isInteger(line.qtyMilli) || line.qtyMilli <= 0) return fail('Satır miktarı geçersiz.');
    if (parsed.qtyMilli != null && parsed.qtyMilli !== line.qtyMilli)
      return fail(`Miktar çelişiyor: satırda ${kg(line.qtyMilli)}, açıklamada ${kg(parsed.qtyMilli)}.`);
    qty = line.qtyMilli;
  }

  const ids = openNeeds.map(n => (n && n.orderLineId != null ? String(n.orderLineId) : null));
  if (ids.includes(null)) return fail('Açık ihtiyaç listesinde sipariş satırı kimliği eksik.');
  if (new Set(ids).size !== ids.length) return fail('Açık ihtiyaç listesinde aynı sipariş satırı birden çok kez var.');
  const profiles = openNeeds.map(needProfile);

  // a) Reference, then b) fabric + colour; c) is the single-candidate rule further down.
  const ref = refKey(line.purchaseRef);
  let candidates;
  if (ref) {
    const linked = profiles.filter(p => p.state !== 'closed' && (refKey(p.need.purchaseRef) === ref || refKey(p.need.orderNo) === ref));
    if (!linked.length) return fail(`Referans ${line.purchaseRef} açık bir ihtiyaçla eşleşmedi; satır renge bakılarak başka siparişe bağlanmaz.`);
    const rel = linked.map(p => [p, relate(lineType, lineColor, p, true)]);
    const unclear = rel.filter(([p, r]) => r === 'unknown' || (r === 'match' && p.state !== 'open')).map(([p]) => p);
    if (unclear.length) return fail(`Referans ${line.purchaseRef}: ${labels(unclear)} için kumaş, renk ya da açık miktar bilgisi net değil.`);
    candidates = rel.filter(([, r]) => r === 'match').map(([p]) => p);
    if (!candidates.length) {
      const said = [lineType, lineColor && colorText(lineColor)].filter(Boolean).join(' ');
      return fail(`Referans ${line.purchaseRef} ${labels(linked)} siparişini gösteriyor ama fatura satırındaki "${said}" onunla çelişiyor.`);
    }
    reasons.push(`Referans ${line.purchaseRef} açık ihtiyaçla eşleşti (${labels(candidates)}).`);
  } else {
    if (!lineColor) return fail('Referans yok ve renk okunamadı; satırın hangi ihtiyaca gideceği belli değil.');
    const unclear = [];
    candidates = [];
    for (const p of profiles) {
      if (p.state === 'closed') continue;
      const r = relate(lineType, lineColor, p, false);
      if (r === 'conflict') continue;
      (r === 'match' && p.state === 'open' ? candidates : unclear).push(p);
    }
    if (unclear.length) return fail(`${labels(unclear)} için kumaş, renk ya da açık miktar net değil; satır bu siparişlere de ait olabilir.`);
    if (!candidates.length) {
      if (!lineType) return fail(`Kumaş türü yazmıyor ve ${colorText(lineColor)} renginde açık ihtiyaç yok.`);
      const key = fabricKey(lineType, lineColor);
      return { status: 'eslesti', fabricKey: key, allocations: [], unallocatedMilli: qty,
        reasons: [...reasons, `${key} için açık ihtiyaç yok; ${kg(qty)} kullanılabilir stoğa kalır.`] };
    }
    reasons.push(`Kumaş ve renk açık ihtiyaçla eşleşti (${labels(candidates)}).`);
  }

  // Missing fabric or colour may come from the need only when nothing in the text was left unread.
  if ((!lineType || !lineColor) && parsed.unknownWords.length)
    return fail(`Açıklamada tanınmayan sözcük var ("${parsed.unknownWords.join(' ')}"); eksik kumaş bilgisi siparişten tamamlanmaz.`);
  const keys = uniq(candidates.map(p => fabricKey(lineType || p.type, lineColor || p.color)));
  if (keys.length !== 1) return fail(`Adaylar farklı kumaş kalemlerine ait: ${keys.join(', ')}.`);
  const key = keys[0];
  if (!lineType) for (const src of ['siparis', 'varsayilan']) {
    const from = candidates.filter(p => p.typeSource === src);
    if (from.length) reasons.push(`Kumaş türü yazmıyor; ${labels(from)} için ${src === 'siparis' ? 'siparişte seçilen' : 'ürün varsayılanı'} ${key.split('|')[0]} kullanıldı.`);
  }
  if (!lineColor) reasons.push(`Renk yazmıyor; referanstaki siparişin rengi ${colorText(key.split('|')[1])} kullanıldı.`);

  // Distribution: purchase record allocation when given, else exactly one candidate.
  const plan = Array.isArray(purchaseAllocations)
    ? purchaseAllocations.filter(a => a && (!a.purchaseRef || (ref && refKey(a.purchaseRef) === ref))) : [];
  const byId = new Map(candidates.map(p => [String(p.need.orderLineId), p]));
  let allocations;
  if (plan.length) {
    const seen = new Set();
    for (const a of plan) {
      const id = String(a.orderLineId);
      if (!byId.has(id)) return fail(`Satın alma tahsisi ${a.orderLineId} satırını gösteriyor ama bu satır bu fatura kalemi için açık bir aday değil.`);
      if (seen.has(id)) return fail('Satın alma tahsisinde aynı sipariş satırı birden çok kez var.');
      if (!Number.isInteger(a.qtyMilli) || a.qtyMilli <= 0) return fail('Satın alma tahsisinde geçersiz miktar var.');
      seen.add(id);
    }
    const planned = plan.reduce((sum, a) => sum + a.qtyMilli, 0);
    if (plan.length > 1 && planned > qty)
      return fail(`Gelen ${kg(qty)}, satın alma tahsisindeki ${kg(planned)} toplamından az; hangi siparişe ne kadar gideceğini ekip doğrulamalı.`);
    reasons.push('Dağıtım satın alma kaydındaki tahsise göre yapıldı.');
    allocations = plan.map(a => {
      const p = byId.get(String(a.orderLineId));
      const given = Math.min(a.qtyMilli, p.need.shortageMilli, qty);
      if (given < Math.min(a.qtyMilli, qty)) reasons.push(`${labels([p])} tahsisi ${kg(a.qtyMilli)}, açık ihtiyaç ${kg(p.need.shortageMilli)}; fazlası ayrılmadı.`);
      return { orderLineId: p.need.orderLineId, qtyMilli: given };
    });
  } else if (candidates.length > 1) {
    return fail(`Birden çok açık ihtiyaç aynı kumaşı bekliyor (${labels(candidates)}) ve satın alma tahsisi yok; ekip miktarları doğrulamalı.`);
  } else {
    const p = candidates[0];
    allocations = [{ orderLineId: p.need.orderLineId, qtyMilli: Math.min(qty, p.need.shortageMilli) }];
  }
  for (const a of allocations) reasons.push(`${labels([byId.get(String(a.orderLineId))])} için ${kg(a.qtyMilli)} ayrıldı.`);
  const rest = qty - allocations.reduce((sum, a) => sum + a.qtyMilli, 0);
  if (rest > 0) reasons.push(`${kg(rest)} dağıtılmadan kullanılabilir stoğa kalır.`);
  return { status: 'eslesti', fabricKey: key, allocations, unallocatedMilli: rest, reasons };
}

module.exports = { parseInvoiceDescription, fabricKey, defaultFabricFor, matchInvoiceLine, colorKey, splitFabricKey };
