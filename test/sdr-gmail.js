// SDR Gmail entegrasyonu duman testi - Google'a / Gmail API'ye HIC gitmez (SDR_GMAIL_MOCK=1).
//   node test/sdr-gmail.js
// Yonetim Ajani'na dokunmaz. Kendi gecici DATA_DIR'inde calisir, sonunda siler.

const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

process.env.SDR_GMAIL_MOCK = '1';
process.env.SDR_GMAIL_DAILY_CAP = '3';
process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
process.env.GOOGLE_REDIRECT_URI = 'https://erci-materials-api.onrender.com/api/sdr/gmail/callback';

const DATA_DIR = path.join(os.tmpdir(), 'sdr-gmail-test-' + Date.now());
process.env.DATA_DIR = DATA_DIR;
fs.mkdirSync(DATA_DIR, { recursive: true });

// Tek lead'li minimal panel-data.json (leads.js / store.js icin gerekli).
const panel = {
  data: {
    customers: [], jobs: [], pipeline: [], incomes: [], expenses: [],
    leads: [{
      id: 1,
      kurum_adi: 'Test Üniversitesi Spor Kulübü',
      kurum_tipi: 'Üniversite Kulübü',
      durum: 'Mail Hazır',
      assigned_to: 'Mert Kıvanç Tekin',
      emails: ['iletisim@testkulup.example'],
      ilgili_kisiler: [],
      mail_taslagi: {
        konu: 'Merci Tekstil İş Birliği Önerisi',
        govde: 'Merhaba,\n\nMerci Tekstil olarak kulübünüze özel tekstil üretimi hakkında görüşmek isteriz.\n\nSaygılarımızla,\nMert Kıvanç Tekin',
        olusturuldu: new Date().toISOString(),
      },
      gonderilen_mailler: [],
      yanitlar: [],
      followup_tarihi: null,
      pipeline_id: null,
      customer_id: null,
    }],
  },
  auth: {},
  updatedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(DATA_DIR, 'panel-data.json'), JSON.stringify(panel));

let pass = 0; let fail = 0;
async function ok(name, fn) {
  try { await fn(); console.log('  OK  ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + ' -> ' + (e && e.message || e)); fail++; }
}

async function main() {
  const gmail = require('../agent/sdr/gmail');
  const sdrStore = require('../agent/sdr/store');
  const leads = require('../agent/sdr/leads');

  console.log('\n# 1. Yapılandırma + OAuth URL');
  await ok('configured() env değişkenleriyle true', () => {
    assert.strictEqual(gmail.configured(), true);
  });
  await ok('configured() GOOGLE_CLIENT_ID yoksa false', () => {
    const save = process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_ID;
    const v = gmail.configured();
    process.env.GOOGLE_CLIENT_ID = save;
    assert.strictEqual(v, false);
  });
  await ok('buildAuthUrl: offline + consent + gmail.send scope + state', () => {
    const url = gmail.buildAuthUrl();
    assert(url.startsWith('https://accounts.google.com/o/oauth2/v2/auth?'), 'auth endpoint');
    const u = new URL(url);
    assert.strictEqual(u.searchParams.get('access_type'), 'offline');
    assert.strictEqual(u.searchParams.get('prompt'), 'consent');
    assert.strictEqual(u.searchParams.get('response_type'), 'code');
    assert(u.searchParams.get('scope').includes('https://www.googleapis.com/auth/gmail.send'), 'gmail.send scope');
    assert((u.searchParams.get('state') || '').length >= 16, 'state uzunlugu');
  });
  await ok('geçersiz state ile callback reddedilir', async () => {
    await assert.rejects(() => gmail.handleCallback({ code: 'x', state: 'bogus-state-xxxx' }), /state/i);
  });

  console.log('\n# 2. Bağlanma (MOCK token değişimi — Google\'a gitmez)');
  let connectedEmail = null;
  await ok('geçerli state ile callback hesabı bağlar', async () => {
    const state = new URL(gmail.buildAuthUrl()).searchParams.get('state');
    const r = await gmail.handleCallback({ code: 'auth-code-123', state });
    connectedEmail = r.email;
    assert(r.email, 'email dondu');
    const st = gmail.status();
    assert.strictEqual(st.connected, true);
    assert.strictEqual(st.email, r.email);
  });
  await ok('aynı state ikinci kez kullanılamaz (replay koruması)', async () => {
    const state = new URL(gmail.buildAuthUrl()).searchParams.get('state');
    await gmail.handleCallback({ code: 'c1', state });
    await assert.rejects(() => gmail.handleCallback({ code: 'c2', state }), /state/i);
  });
  await ok('auth dosyası diskte, refresh_token dolu, activeAccount set', () => {
    const a = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sdr', 'gmail-auth.json'), 'utf8'));
    assert(a.accounts[connectedEmail].refresh_token, 'refresh_token');
    assert.strictEqual(a.activeAccount, connectedEmail);
  });

  console.log('\n# 3. MIME kurulumu (Türkçe karakter)');
  await ok('buildMime: Türkçe konu RFC2047 encoded-word, gövde base64 korunur', () => {
    const mime = gmail.buildMime({
      fromName: 'Merci Tekstil', fromEmail: 'info@mercitex.com',
      to: 'x@y.com', subject: 'İş Birliği Teklifi', bodyText: 'Merhaba, ğüşöç İ.',
    });
    assert(/\r\nSubject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=\r\n/.test(mime), 'Subject encoded-word');
    assert(/^From: Merci Tekstil <info@mercitex\.com>\r\n/.test(mime), 'ASCII From encode edilmez');
    const body = mime.split('\r\n\r\n')[1].replace(/\r\n/g, '');
    assert.strictEqual(Buffer.from(body, 'base64').toString('utf8'), 'Merhaba, ğüşöç İ.');
  });
  await ok('toBase64Url: RFC4648 url-safe, padding yok', () => {
    const s = gmail.toBase64Url('ab>?c'); // '+' ve '/' uretebilecek girdi
    assert(!/[+/=]/.test(s), 'url-safe');
  });

  console.log('\n# 4. Gönderim (MOCK) + günlük limit');
  await ok('sendEmail MOCK: messageId döndürür, sent loguna yazar', async () => {
    const before = sdrStore.sentCountToday();
    const r = await gmail.sendEmail({ to: 'a@b.com', subject: 'Konu', body: 'Gövde', leadId: 99 });
    assert(r.ok && r.messageId, 'messageId');
    assert.strictEqual(sdrStore.sentCountToday(), before + 1);
  });
  await ok('geçersiz alıcı reddedilir', async () => {
    await assert.rejects(() => gmail.sendEmail({ to: 'not-an-email', subject: 'K', body: 'G' }), /e-posta/i);
  });
  await ok('günlük limit (3) aşılınca DAILY_CAP hatası', async () => {
    await gmail.sendEmail({ to: 'a@b.com', subject: 'K', body: 'G', leadId: 99 });
    await gmail.sendEmail({ to: 'a@b.com', subject: 'K', body: 'G', leadId: 99 });
    await assert.rejects(
      () => gmail.sendEmail({ to: 'a@b.com', subject: 'K', body: 'G' }),
      (e) => e && e.code === 'DAILY_CAP',
    );
  });

  console.log('\n# 5. Alıcı çözümleme + 24s tekrar koruması');
  await ok('resolveRecipient: override > lead.emails > ilgili_kisiler > null', () => {
    const lead = { emails: ['e@ma.il'], ilgili_kisiler: [{ email: 'k@ma.il' }] };
    assert.strictEqual(gmail.resolveRecipient(lead, 'o@ver.ride'), 'o@ver.ride');
    assert.strictEqual(gmail.resolveRecipient(lead, null), 'e@ma.il');
    assert.strictEqual(gmail.resolveRecipient({ emails: [], ilgili_kisiler: [{ email: 'k@ma.il' }] }, null), 'k@ma.il');
    assert.strictEqual(gmail.resolveRecipient({ emails: [], ilgili_kisiler: [] }, null), null);
  });
  await ok('recentlySentTo: gönderim yapılmış leadId için true, bilinmeyen için false', () => {
    assert.strictEqual(gmail.recentlySentTo(99), true);
    assert.strictEqual(gmail.recentlySentTo(454545), false);
  });

  console.log('\n# 6. updateLead mark_sent — message_id + alıcı saklanır');
  await ok('updateLead mark_sent gonderilen_mailler\'e message_id + alıcı yazar', () => {
    const r = leads.updateLead(1, {
      mark_sent: true, konu: 'Merci Tekstil İş Birliği Önerisi',
      kanal: 'email (Gmail)', to: 'iletisim@testkulup.example', message_id: 'msg-abc-123',
    }, { confirm: true });
    const gm = r.lead.gonderilen_mailler[0];
    assert.strictEqual(gm.message_id, 'msg-abc-123');
    assert.strictEqual(gm.alici, 'iletisim@testkulup.example');
    assert.strictEqual(r.lead.durum, 'Mail Gönderildi');
    assert(r.lead.followup_tarihi, 'takip tarihi atandı');
  });

  console.log('\n# 7. Bağlantıyı kes');
  await ok('disconnect: status().connected false', async () => {
    await gmail.disconnect();
    assert.strictEqual(gmail.status().connected, false);
  });

  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) { /* yok say */ }

  console.log('\n=== ' + pass + ' geçti, ' + fail + ' başarısız ===');
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('sdr-gmail HATA:', e); process.exit(1); });
