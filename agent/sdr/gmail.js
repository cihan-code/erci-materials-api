// SDR Gmail entegrasyonu - Faz 2.
// Kapsam: OAuth ile TEK kurumsal hesabi baglama + ONAYLI tekli mail gonderimi + gonderim logu.
// YOK: otomatik toplu gonderim, gelen kutusu okuma/yonetimi.
//
// - Scope: gmail.send + openid email  -> ajan gelen kutusunu OKUYAMAZ, sadece gonderir.
// - refresh_token yalniz DATA_DIR/sdr/gmail-auth.json'da (Render diski). Git'e / panele girmez.
// - Google OAuth bilgileri environment variable:
//     GOOGLE_CLIENT_ID  GOOGLE_CLIENT_SECRET  GOOGLE_REDIRECT_URI
// - SDR_GMAIL_MOCK=1 (yalniz yerel): Google'a/Gmail'e HIC gitmez, sahte token+mesaj id, $0.
//   Production (Render) ortaminda MOCK yanlislikla acilirsa uygulama BASLAMAZ.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sdrStore = require('./store');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const SDR_DIR = path.join(DATA_DIR, 'sdr');
const AUTH_FILE = path.join(SDR_DIR, 'gmail-auth.json');

// --- MOCK guvenlik kilidi (claude.js ile ayni desen) ---
const MOCK = process.env.SDR_GMAIL_MOCK === '1';
if (MOCK) {
  const prod = [];
  if (process.env.RENDER) prod.push('RENDER');
  if (process.env.RENDER_SERVICE_ID) prod.push('RENDER_SERVICE_ID');
  if (process.env.NODE_ENV === 'production') prod.push('NODE_ENV=production');
  if (process.env.AGENT_ENV === 'production') prod.push('AGENT_ENV=production');
  if (prod.length) {
    console.error('\nKRITIK: SDR_GMAIL_MOCK=1 ama ortam PRODUCTION gorunuyor (' + prod.join(', ') +
      '). Sahte mail gonderimi canliya yazilmasin diye uygulama durduruluyor. Render > Environment > SDR_GMAIL_MOCK sil.\n');
    process.exit(1);
  }
  console.warn('[sdr/gmail] SDR_GMAIL_MOCK=1 - Google/Gmail cagrilmayacak (yerel test).');
}

// Gunluk gonderim limiti (anti-spam). Render env: SDR_GMAIL_DAILY_CAP.
const DAILY_CAP = parseInt(process.env.SDR_GMAIL_DAILY_CAP, 10) || 20;

const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.send'];
const OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const OAUTH_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

const STATE_TTL_MS = 10 * 60 * 1000;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function cfg() {
  return {
    clientId: (process.env.GOOGLE_CLIENT_ID || '').trim(),
    clientSecret: (process.env.GOOGLE_CLIENT_SECRET || '').trim(),
    redirectUri: (process.env.GOOGLE_REDIRECT_URI || '').trim(),
  };
}
function configured() {
  const c = cfg();
  return !!(c.clientId && c.clientSecret && c.redirectUri);
}

// ---------- auth dosyasi (cok-hesap destekli sekil, Faz 2'de tek hesap kullanilir) ----------
function readAuth() {
  try {
    const a = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    a.accounts = a.accounts || {};
    a.pendingStates = a.pendingStates || {};
    return a;
  } catch (e) {
    return { activeAccount: null, accounts: {}, pendingStates: {} };
  }
}
function writeAuth(obj) {
  fs.mkdirSync(SDR_DIR, { recursive: true });
  const tmp = AUTH_FILE + '.tmp-' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, AUTH_FILE);
}
function activeAccount(a) {
  a = a || readAuth();
  return (a.activeAccount && a.accounts[a.activeAccount]) || null;
}

// ---------- OAuth ----------
function buildAuthUrl() {
  if (!configured() && !MOCK) {
    throw new Error('Google OAuth yapilandirilmadi (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI).');
  }
  const c = cfg();
  const state = crypto.randomBytes(16).toString('hex');
  const a = readAuth();
  const now = Date.now();
  for (const k of Object.keys(a.pendingStates)) {
    if (now - a.pendingStates[k] > STATE_TTL_MS) delete a.pendingStates[k];
  }
  a.pendingStates[state] = now;
  writeAuth(a);

  const params = new URLSearchParams({
    client_id: c.clientId || 'mock-client-id',
    redirect_uri: c.redirectUri || 'https://example.invalid/callback',
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return OAUTH_AUTH_URL + '?' + params.toString();
}

function consumeState(state) {
  const a = readAuth();
  if (!state || !a.pendingStates[state]) return false;
  const born = a.pendingStates[state];
  delete a.pendingStates[state];
  writeAuth(a);
  return (Date.now() - born) <= STATE_TTL_MS;
}

async function postForm(url, params) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error('OAuth istegi basarisiz (' + r.status + '): ' + (j.error_description || j.error || 'bilinmeyen hata'));
  }
  return j;
}

async function exchangeCode(code) {
  if (MOCK) {
    return { access_token: 'mock-access-token', expires_in: 3600, refresh_token: 'mock-refresh-token', scope: SCOPES.join(' '), token_type: 'Bearer', _mockEmail: 'info@mercitex.com' };
  }
  const c = cfg();
  return postForm(OAUTH_TOKEN_URL, {
    code, client_id: c.clientId, client_secret: c.clientSecret,
    redirect_uri: c.redirectUri, grant_type: 'authorization_code',
  });
}

async function refreshAccessToken(refreshToken) {
  if (MOCK) return { access_token: 'mock-access-token-' + Date.now(), expires_in: 3600, token_type: 'Bearer' };
  const c = cfg();
  return postForm(OAUTH_TOKEN_URL, {
    client_id: c.clientId, client_secret: c.clientSecret,
    refresh_token: refreshToken, grant_type: 'refresh_token',
  });
}

function decodeJwtPayload(jwt) {
  try {
    const p = String(jwt).split('.')[1];
    return JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch (e) { return null; }
}

async function resolveEmail(tok) {
  if (MOCK) return tok._mockEmail || 'info@mercitex.com';
  const p = tok.id_token && decodeJwtPayload(tok.id_token);
  if (p && p.email) return p.email;
  try {
    const r = await fetch(USERINFO_URL, { headers: { Authorization: 'Bearer ' + tok.access_token } });
    const j = await r.json().catch(() => ({}));
    if (j.email) return j.email;
  } catch (e) { /* yut */ }
  return 'bilinmeyen@hesap';
}

// Google callback: ?code=&state=  ->  hesabi bagla, refresh_token sakla.
async function handleCallback({ code, state } = {}) {
  if (!consumeState(state)) throw new Error('Gecersiz veya suresi gecmis state - baglantiyi panelden yeniden baslatin.');
  if (!code) throw new Error('Yetkilendirme kodu (code) alinamadi.');

  const tok = await exchangeCode(code);
  const email = await resolveEmail(tok);

  const a = readAuth();
  const existing = a.accounts[email] || {};
  const refresh = tok.refresh_token || existing.refresh_token || null;
  a.accounts[email] = {
    email,
    refresh_token: refresh,
    access_token: tok.access_token || null,
    access_expiry: Date.now() + ((tok.expires_in || 3600) * 1000) - 60000,
    scope: tok.scope || SCOPES.join(' '),
    connected_at: new Date().toISOString(),
  };
  a.activeAccount = email;
  writeAuth(a);

  if (!refresh) {
    throw new Error('Google refresh_token gondermedi. Google Hesabi > Guvenlik > Ucuncu taraf erisimi altindan "Merci Satis Ajani" iznini kaldirip panelden tekrar baglayin.');
  }
  return { email };
}

async function getValidAccessToken() {
  const a = readAuth();
  const acc = activeAccount(a);
  if (!acc) throw new Error('Gmail hesabi bagli degil. Panelden "Gmail Bagla" ile baglayin.');
  if (acc.access_token && acc.access_expiry && Date.now() < acc.access_expiry) {
    return { token: acc.access_token, email: acc.email };
  }
  if (!acc.refresh_token) throw new Error('refresh_token yok - panelden yeniden baglayin.');
  const t = await refreshAccessToken(acc.refresh_token);
  acc.access_token = t.access_token;
  acc.access_expiry = Date.now() + ((t.expires_in || 3600) * 1000) - 60000;
  a.accounts[acc.email] = acc;
  writeAuth(a);
  return { token: acc.access_token, email: acc.email };
}

async function disconnect() {
  const a = readAuth();
  const acc = activeAccount(a);
  if (acc && acc.refresh_token && !MOCK) {
    try {
      await fetch(OAUTH_REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'token=' + encodeURIComponent(acc.refresh_token),
      });
    } catch (e) { /* best-effort */ }
  }
  if (acc) delete a.accounts[acc.email];
  a.activeAccount = Object.keys(a.accounts)[0] || null;
  writeAuth(a);
  return { ok: true };
}

function status() {
  const a = readAuth();
  const acc = activeAccount(a);
  return {
    configured: configured() || MOCK,
    connected: !!(acc && acc.refresh_token),
    email: acc ? acc.email : null,
    connectedAt: acc ? acc.connected_at : null,
    scope: acc ? acc.scope : null,
    dailyCap: DAILY_CAP,
    sentToday: sdrStore.sentCountToday(),
    mock: MOCK,
  };
}

// ---------- MIME ----------
function encodeHeaderWord(str) {
  str = String(str == null ? '' : str);
  if (/^[\x00-\x7F]*$/.test(str)) return str;
  return '=?UTF-8?B?' + Buffer.from(str, 'utf8').toString('base64') + '?=';
}

function buildMime({ fromName, fromEmail, to, subject, bodyText } = {}) {
  const fromDisplay = fromName
    ? (encodeHeaderWord(fromName) + ' <' + fromEmail + '>')
    : fromEmail;
  const bodyB64 = Buffer.from(String(bodyText == null ? '' : bodyText), 'utf8')
    .toString('base64').replace(/(.{76})/g, '$1\r\n');
  const headers = [
    'From: ' + fromDisplay,
    'To: ' + to,
    'Subject: ' + encodeHeaderWord(subject),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ];
  return headers.join('\r\n') + '\r\n\r\n' + bodyB64;
}

function toBase64Url(str) {
  return Buffer.from(String(str), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function gmailSendRaw(accessToken, raw) {
  if (MOCK) return { id: 'mock-msg-' + crypto.randomBytes(5).toString('hex'), threadId: 'mock-thread-' + crypto.randomBytes(4).toString('hex') };
  const r = await fetch(GMAIL_SEND_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error('Gmail gonderim basarisiz (' + r.status + '): ' + ((j.error && j.error.message) || 'bilinmeyen hata'));
  }
  return j;
}

// ---------- gonderim ----------
// { to, subject, body, leadId? } -> { ok, messageId, threadId, from, sentId }
async function sendEmail({ to, subject, body, leadId } = {}) {
  if (!configured() && !MOCK) throw new Error('Gmail yapilandirilmadi.');
  to = String(to || '').trim();
  if (!EMAIL_RE.test(to)) throw new Error('Gecerli bir alici e-posta adresi yok: "' + to + '"');
  if (!subject || !String(subject).trim()) throw new Error('Mail konusu bos.');
  if (!body || !String(body).trim()) throw new Error('Mail govdesi bos.');

  const sentToday = sdrStore.sentCountToday();
  if (sentToday >= DAILY_CAP) {
    const e = new Error('Gunluk gonderim limiti (' + DAILY_CAP + ') doldu. Yarin tekrar deneyin veya SDR_GMAIL_DAILY_CAP degerini artirin.');
    e.code = 'DAILY_CAP';
    throw e;
  }

  const { token, email } = await getValidAccessToken();
  const mime = buildMime({ fromName: 'Merci Tekstil', fromEmail: email, to, subject, bodyText: body });
  const result = await gmailSendRaw(token, toBase64Url(mime));

  const rec = sdrStore.saveSent({
    leadId: leadId != null ? leadId : null,
    to, subject: String(subject), from: email,
    messageId: result.id || null, threadId: result.threadId || null,
    mock: MOCK,
  });
  return { ok: true, messageId: result.id || null, threadId: result.threadId || null, from: email, sentId: rec.id };
}

// ---------- route yardimcilari ----------
function resolveRecipient(lead, override) {
  const o = override != null ? String(override).trim() : '';
  if (o) return o;
  lead = lead || {};
  const fromEmails = (lead.emails || []).map((x) => String(x || '').trim()).filter(Boolean)[0];
  if (fromEmails) return fromEmails;
  const fromKisi = (lead.ilgili_kisiler || []).map((k) => k && String(k.email || '').trim()).filter(Boolean)[0];
  return fromKisi || null;
}

function recentlySentTo(leadId, withinMs = 24 * 60 * 60 * 1000) {
  const now = Date.now();
  // jsonIndexStore.list tavani 200; gunluk cap 20 -> son 200 kayit fazlasiyla yeter.
  return sdrStore.sent.list({ limit: 200 }).some((m) =>
    String(m.leadId) === String(leadId) && (now - new Date(m.createdAt).getTime()) < withinMs);
}

module.exports = {
  DAILY_CAP, SCOPES,
  configured, buildAuthUrl, handleCallback, disconnect, status,
  buildMime, toBase64Url, encodeHeaderWord,
  sendEmail, resolveRecipient, recentlySentTo,
  getValidAccessToken,
};
