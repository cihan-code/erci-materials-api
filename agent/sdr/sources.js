// SDR musteri arastirma KAYNAK katmani - modele gitmeden ONCE gercek kurum listesi toplar.
// Amac: "uydurma yok" kuralini guclendirmek + kapsami genisletmek. Model bu dogrulanmis
// stub'lari zenginlestirir (web_search/web_fetch) ve ustune ekler; iletisim bilgisi UYDURMAZ.
//
// Kaynaklar:
//   1. OpenStreetMap Overpass API  - UCRETSIZ, anahtar yok. Sehir + kurum tipi -> kurum listesi.
//   2. Google Places API (New) Text Search - GOOGLE_PLACES_API_KEY varsa. web/telefon/adres.
// MOCK (AGENT_MOCK=1): her iki kaynak da fixture doner, ag'a cikmaz, $0.

const fs = require('fs');
const path = require('path');

const MOCK = process.env.AGENT_MOCK === '1';

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const PLACES_URL = 'https://places.googleapis.com/v1/places:searchText';

const OVERPASS_MAX = parseInt(process.env.SDR_OVERPASS_MAX, 10) || 40;
const PLACES_MAX = Math.min(parseInt(process.env.SDR_PLACES_MAX, 10) || 20, 20);

// Kurum tipi -> OSM etiket filtreleri + Google Places metin sorgusu parcasi.
// Bilinmeyen/serbest tip: Overpass atlanir, Places ham query ile calisir.
const ORG_TYPES = {
  'Üniversite':            { osm: ['"amenity"="university"', '"amenity"="college"'], places: 'üniversite' },
  'Üniversite Kulübü':     { osm: [], places: 'üniversite öğrenci topluluğu' },
  'Özel Lise':             { osm: ['"amenity"="school"'], places: 'özel lise' },
  'Okul':                  { osm: ['"amenity"="school"'], places: 'okul' },
  'Kurumsal Firma':        { osm: ['"office"="company"', '"office"="it"', '"industrial"'], places: 'firma' },
  'Etkinlik/Organizasyon': { osm: ['"office"="event_management"'], places: 'organizasyon ajansı' },
  'Spor Kulübü':           { osm: ['"club"="sport"', '"leisure"="sports_centre"', '"sport"'], places: 'spor kulübü' },
  'Diğer':                 { osm: [], places: '' },
};

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'test', 'fixtures', name), 'utf8'));
}
function normStr(v) { return v == null ? null : (String(v).trim() || null); }
function normUrl(v) {
  const s = normStr(v);
  if (!s) return null;
  return /^https?:\/\//i.test(s) ? s : ('https://' + s.replace(/^\/+/, ''));
}
function normKey(s) {
  return String(s || '').toLocaleLowerCase('tr')
    .replace(/[İıI]/g, 'i').replace(/[^a-z0-9ğüşöç]+/g, ' ').trim();
}

// ---------------- OpenStreetMap Overpass ----------------
function buildOverpassQL(city, filters) {
  // Sehir sinirini isimden bul (TR sehir adlari OSM'de 'name' ile eslesir).
  // Beyaz liste: sadece harf/rakam/bosluk/nokta/tire (QL enjeksiyonu + kontrol karakteri engeli).
  const safeCity = String(city).replace(/[^\p{L}\p{N}\s.\-']/gu, '').trim().slice(0, 60);
  const blocks = [];
  for (const f of filters) {
    for (const kind of ['node', 'way', 'relation']) {
      blocks.push(`  ${kind}[${f}](area.searchArea);`);
    }
  }
  return `[out:json][timeout:25];
area["boundary"="administrative"]["name"="${safeCity}"]->.searchArea;
(
${blocks.join('\n')}
);
out center tags ${OVERPASS_MAX * 3};`;
}

async function fetchOverpass(city, type) {
  const conf = ORG_TYPES[type];
  const filters = conf ? conf.osm : [];
  if (!city || !filters.length) return { ran: false, reason: 'sehir yok veya bu tip icin OSM etiketi yok', candidates: [] };

  if (MOCK) {
    const fx = fixture('sdr-sources.json');
    return { ran: true, source: 'OpenStreetMap (MOCK)', candidates: (fx.overpass || []).map(normalizeStub) };
  }

  const ql = buildOverpassQL(city, filters);
  let lastErr = null;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(ql),
        signal: AbortSignal.timeout(30000),
      });
      if (!r.ok) { lastErr = new Error('Overpass ' + r.status); continue; }
      const j = await r.json();
      const els = Array.isArray(j.elements) ? j.elements : [];
      const seen = new Set();
      const candidates = [];
      for (const el of els) {
        const t = el.tags || {};
        const name = normStr(t.name || t['name:tr'] || t.official_name);
        if (!name) continue;
        const k = normKey(name);
        if (seen.has(k)) continue;
        seen.add(k);
        candidates.push(normalizeStub({
          kurum_adi: name,
          kurum_tipi: type,
          website: t.website || t['contact:website'] || t.url || null,
          phones: [t.phone || t['contact:phone'] || t['contact:mobile']].filter(Boolean),
          emails: [t.email || t['contact:email']].filter(Boolean),
          adres: [t['addr:street'], t['addr:housenumber'], t['addr:district'], t['addr:city'] || city].filter(Boolean).join(' '),
          instagram: t['contact:instagram'] ? normUrl(t['contact:instagram']) : null,
          kaynak: 'OpenStreetMap',
          kaynak_url: 'https://www.openstreetmap.org/' + el.type + '/' + el.id,
        }));
        if (candidates.length >= OVERPASS_MAX) break;
      }
      return { ran: true, source: 'OpenStreetMap', candidates };
    } catch (e) { lastErr = e; }
  }
  return { ran: false, reason: String(lastErr && lastErr.message || lastErr), candidates: [] };
}

// ---------------- Google Places API (New) ----------------
function placesConfigured() { return !!(process.env.GOOGLE_PLACES_API_KEY || '').trim(); }

async function fetchPlaces(query, city, type) {
  if (!placesConfigured() && !MOCK) {
    return { ran: false, reason: 'GOOGLE_PLACES_API_KEY yok', candidates: [] };
  }
  if (MOCK) {
    const fx = fixture('sdr-sources.json');
    return { ran: true, source: 'Google Places (MOCK)', candidates: (fx.places || []).map(normalizeStub) };
  }

  const conf = ORG_TYPES[type];
  const textQuery = [conf && conf.places, query, city].filter(Boolean).join(' ').trim();
  try {
    const r = await fetch(PLACES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY.trim(),
        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.websiteUri,places.internationalPhoneNumber,places.primaryTypeDisplayName,places.googleMapsUri',
      },
      body: JSON.stringify({ textQuery, languageCode: 'tr', regionCode: 'TR', maxResultCount: PLACES_MAX }),
      signal: AbortSignal.timeout(20000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      // Google hata mesajini ham gecirme (anahtar yansimasa da temiz tut).
      const detay = r.status === 403 ? ' (API anahtarı / kota / kısıtlama)' : r.status === 400 ? ' (istek reddedildi)' : '';
      console.warn('[sdr/sources] Places HTTP', r.status, (j.error && j.error.status) || '');
      return { ran: false, reason: 'Google Places HTTP ' + r.status + detay, candidates: [] };
    }
    const candidates = (Array.isArray(j.places) ? j.places : []).map((p) => normalizeStub({
      kurum_adi: p.displayName && p.displayName.text,
      kurum_tipi: type,
      sektor: p.primaryTypeDisplayName && p.primaryTypeDisplayName.text,
      website: p.websiteUri || null,
      phones: [p.internationalPhoneNumber].filter(Boolean),
      adres: p.formattedAddress || null,
      kaynak: 'Google Places',
      kaynak_url: p.googleMapsUri || null,
    })).filter((c) => c.kurum_adi);
    return { ran: true, source: 'Google Places', candidates };
  } catch (e) {
    return { ran: false, reason: String(e && e.message || e), candidates: [] };
  }
}

// ---------------- birlestir ----------------
function normalizeStub(raw) {
  raw = raw || {};
  return {
    kurum_adi: normStr(raw.kurum_adi),
    kurum_tipi: normStr(raw.kurum_tipi),
    sektor: normStr(raw.sektor),
    sehir: normStr(raw.sehir),
    website: normUrl(raw.website),
    instagram: raw.instagram ? normUrl(raw.instagram) : null,
    emails: (Array.isArray(raw.emails) ? raw.emails : []).map(normStr).filter(Boolean),
    phones: (Array.isArray(raw.phones) ? raw.phones : []).map(normStr).filter(Boolean),
    adres: normStr(raw.adres),
    kaynak: normStr(raw.kaynak),
    kaynak_url: normStr(raw.kaynak_url),
  };
}

// { query, city, type } -> { candidates:[stub...], sources:[{name,count,ran,reason?}] }
async function gatherSources({ query, city, type } = {}) {
  const [op, pl] = await Promise.all([
    fetchOverpass(city, type).catch((e) => ({ ran: false, reason: String(e && e.message || e), candidates: [] })),
    fetchPlaces(query, city, type).catch((e) => ({ ran: false, reason: String(e && e.message || e), candidates: [] })),
  ]);

  const byKey = new Map();
  for (const res of [pl, op]) { // Places once (daha zengin web/telefon), sonra OSM tamamlar
    for (const c of res.candidates || []) {
      if (!c.kurum_adi) continue;
      const k = normKey(c.kurum_adi);
      if (!byKey.has(k)) { byKey.set(k, c); continue; }
      const ex = byKey.get(k);
      ex.website = ex.website || c.website;
      ex.instagram = ex.instagram || c.instagram;
      ex.adres = ex.adres || c.adres;
      ex.sektor = ex.sektor || c.sektor;
      ex.phones = Array.from(new Set([...(ex.phones || []), ...(c.phones || [])]));
      ex.emails = Array.from(new Set([...(ex.emails || []), ...(c.emails || [])]));
      if (c.kaynak && ex.kaynak && !ex.kaynak.includes(c.kaynak)) ex.kaynak += ' + ' + c.kaynak;
    }
  }

  return {
    candidates: Array.from(byKey.values()),
    sources: [
      { name: 'Google Places', ran: pl.ran, count: (pl.candidates || []).length, reason: pl.ran ? undefined : pl.reason },
      { name: 'OpenStreetMap', ran: op.ran, count: (op.candidates || []).length, reason: op.ran ? undefined : op.reason },
    ],
  };
}

module.exports = { gatherSources, fetchOverpass, fetchPlaces, placesConfigured, ORG_TYPES, normalizeStub };
