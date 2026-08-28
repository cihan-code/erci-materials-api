// Merci sirket profili - belge yonunu (gelen/giden) belirlemek icin.
// SERVER-SIDE. Frontend'e gonderilmez, loglara yazilmaz.
//
// Duzenleme (kod degisikligi GEREKMEZ):
//   - IBAN eklemek: Render > Environment > MERCI_IBANS  (virgul ile ayrilmis)
//   - Isim/VKN eklemek: MERCI_COMPANY_PROFILE env'ine JSON, veya data/company-profile.json
//
// Isim ve VKN Ticaret Sicil kaydidir (herkese acik). IBAN'lar env'de tutulur (repo public).

const fs = require('fs');
const path = require('path');

const DEFAULT = {
  names: [
    'MERCI TEKSTİL SANAYİ VE TİCARET',
    'MERCI TEKSTIL SANAYI VE TICARET',
    'MERCI TEKSTİL',
    'MERCI TEKSTIL',
    'MERCİ TEKSTİL',
    'MERCICO',
    'Cihan Berber',
    'Mert Kıvanç Tekin',
  ],
  vkn: '6160906794',
  taxOffice: 'PENDİK VERGİ DAİRESİ MÜDÜRLÜĞÜ',
  ibans: [],
};

function normIban(s) {
  return String(s || '').replace(/\s+/g, '').toUpperCase();
}
function normName(s) {
  return String(s || '')
    .toLocaleLowerCase('tr')
    .replace(/[İıI]/g, 'i').replace(/\s+/g, ' ').trim();
}
function normVkn(s) {
  return String(s || '').replace(/\D/g, '');
}

function loadRaw() {
  // 1) data/company-profile.json (yerel / kalici disk)
  try {
    const p = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'company-profile.json');
    if (fs.existsSync(p)) return Object.assign({}, DEFAULT, JSON.parse(fs.readFileSync(p, 'utf8')));
  } catch (e) { /* yoksay */ }
  // 2) MERCI_COMPANY_PROFILE env (JSON)
  try {
    if (process.env.MERCI_COMPANY_PROFILE) return Object.assign({}, DEFAULT, JSON.parse(process.env.MERCI_COMPANY_PROFILE));
  } catch (e) { /* yoksay */ }
  // 3) DEFAULT + MERCI_IBANS env
  const out = Object.assign({}, DEFAULT);
  if (process.env.MERCI_IBANS) out.ibans = process.env.MERCI_IBANS.split(',').map((x) => x.trim()).filter(Boolean);
  return out;
}

let _cache = null;
function get() {
  if (_cache) return _cache;
  const raw = loadRaw();
  const ibans = Array.from(new Set((raw.ibans || []).map(normIban).filter((x) => /^TR\d{24}$/.test(x))));
  _cache = {
    names: Array.from(new Set((raw.names || []).filter(Boolean))),
    vkn: normVkn(raw.vkn),
    taxOffice: raw.taxOffice || '',
    ibans,
    ibanSet: new Set(ibans),
    nameNorms: (raw.names || []).map(normName).filter(Boolean),
  };
  return _cache;
}

// --- eslesme yardimcilari ---
function isCompanyIban(iban) { return get().ibanSet.has(normIban(iban)); }
function isCompanyVkn(vkn) {
  const v = normVkn(vkn);
  return !!v && v === get().vkn;
}
function isCompanyName(name) {
  const n = normName(name);
  if (!n) return false;
  return get().nameNorms.some((cn) => cn && (n.includes(cn) || cn.includes(n)));
}

// Modele giden MINIMUM profil (isim listesi kisa + vkn + ibans). Panel verisi yok.
function forPrompt() {
  const p = get();
  return {
    company_names: p.names.slice(0, 6),
    company_vkn: p.vkn,
    company_tax_office: p.taxOffice,
    company_ibans: p.ibans,
  };
}

module.exports = {
  get, forPrompt, isCompanyIban, isCompanyVkn, isCompanyName,
  normIban, normName, normVkn,
  _reset: () => { _cache = null; },
};
