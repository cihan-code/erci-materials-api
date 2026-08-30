// SDR musteri arastirma KAYNAK katmani - modele gitmeden ONCE gercek kurum listesi toplar.
// Amac: "uydurma yok" kuralini guclendirmek + kapsami genisletmek. Model bu dogrulanmis
// stub'lari zenginlestirir (web_search/web_fetch) ve ustune ekler; iletisim bilgisi UYDURMAZ.
//
// Kaynak: Google Places API (New) Text Search - GOOGLE_PLACES_API_KEY varsa. web/telefon/adres.
//   (2026-08-30: OpenStreetMap Overpass kaynak akisindan cikarildi - 3/3 timeout/502, cifte
//    30sn timeout Render free dyno'da arastirmayi stall ediyordu. Gerekirse git gecmisinden geri alinir.)
// MOCK (AGENT_MOCK=1): fixture doner, ag'a cikmaz, $0.

const fs = require('fs');
const path = require('path');

const MOCK = process.env.AGENT_MOCK === '1';

const PLACES_URL = 'https://places.googleapis.com/v1/places:searchText';
const PLACES_MAX = Math.min(parseInt(process.env.SDR_PLACES_MAX, 10) || 20, 20);

// Kurum tipi -> Google Places metin sorgusu parcasi. Serbest/bilinmeyen tip: ham query.
const ORG_TYPES = {
  'Üniversite':            { places: 'üniversite' },
  'Üniversite Kulübü':     { places: 'üniversite öğrenci topluluğu' },
  'Özel Lise':             { places: 'özel lise' },
  'Okul':                  { places: 'okul' },
  'Kurumsal Firma':        { places: 'firma' },
  'Etkinlik/Organizasyon': { places: 'organizasyon ajansı' },
  'Spor Kulübü':           { places: 'spor kulübü' },
  'Diğer':                 { places: '' },
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
      // Google hata mesajini istemciye ham gecirme - ama Render logunda tam goster (403 teshisi icin).
      const detay = r.status === 403 ? ' (API anahtarı / kota / kısıtlama)' : r.status === 400 ? ' (istek reddedildi)' : '';
      console.warn('[sdr/sources] Places HTTP', r.status, (j.error && j.error.status) || '', '-', (j.error && j.error.message) || '');
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

// ---------------- normalize + topla ----------------
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
  const pl = await fetchPlaces(query, city, type)
    .catch((e) => ({ ran: false, reason: String(e && e.message || e), candidates: [] }));

  const byKey = new Map();
  for (const c of pl.candidates || []) {
    if (!c.kurum_adi) continue;
    const k = normKey(c.kurum_adi);
    if (!byKey.has(k)) byKey.set(k, c);
  }

  return {
    candidates: Array.from(byKey.values()),
    sources: [
      { name: 'Google Places', ran: pl.ran, count: (pl.candidates || []).length, reason: pl.ran ? undefined : pl.reason },
    ],
  };
}

module.exports = { gatherSources, fetchPlaces, placesConfigured, ORG_TYPES, normalizeStub };
