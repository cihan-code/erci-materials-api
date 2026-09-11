// Panel verisi yazma yolunun HATA KODU sozlesmesi.
// Panel bu kodlara gore davranir (otomatik tekrar mi, kullaniciya soru mu), bu yuzden
// kodlar sessizce degismemeli. Express gerektirmez; store + sema + kod eslemesini dogrudan
// calistirir (npm bagimliligi olmadan da kosar).
//
// Kullanim: node test/paneldata-codes.js     (ucretsiz; Anthropic API'ye gitmez)

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'merci-codes-'));
process.env.DATA_DIR = TMP;
process.env.AGENT_MOCK = '1';
process.env.ANTHROPIC_API_KEY = 'mock-key-not-used';

const store = require('../agent/store');
const { validatePanelData } = require('../agent/panelSchema');
const { CODES, panelWriteError } = require('../agent/errorCodes');

let pass = 0, fail = 0;
function ok(label, fn) {
  try { fn(); console.log('  OK  ' + label); pass++; }
  catch (e) { console.log('  FAIL ' + label + '\n       ' + (e && e.message)); fail++; }
}
const sampleData = () => ({ customers: [], jobs: [{ id: 1, title: 'İş', quantity: 3, unit_price: 10 }], incomes: [], expenses: [], tasks: [] });
// server.js POST /api/paneldata ile ayni sira: sema -> yazma -> hata eslemesi
function writeAsPanel(body) {
  if (!body.data) return { status: 400, code: CODES.PD_400_NODATA };
  const v = validatePanelData(body.data);
  if (!v.ok) return { status: 422, code: CODES.PD_422_SCHEMA, details: v.errors };
  try {
    const updatedAt = store.writePanelDataFull({
      data: body.data,
      auth: body.auth || null,
      expectedUpdatedAt: (body.expectedUpdatedAt === undefined ? null : body.expectedUpdatedAt),
      requireExpected: true,
    });
    return { status: 200, updatedAt };
  } catch (e) {
    return panelWriteError(e);
  }
}

console.log('\n# Panel verisi hata kodlari (DATA_DIR=' + TMP + ')');

let stamp = null;
ok('ilk yazma (dosya yok) serbest -> 200 + updatedAt', () => {
  const r = writeAsPanel({ data: sampleData(), auth: { managers: [] } });
  assert.strictEqual(r.status, 200);
  assert(r.updatedAt, 'updatedAt dönmedi');
  stamp = r.updatedAt;
});

ok('data alani yok -> 400 PD-400-NODATA', () => {
  const r = writeAsPanel({ auth: null });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.code, 'PD-400-NODATA');
});

ok('damgasiz ikinci yazma -> 409 PD-409-STALE (bayat sekme korumasi)', () => {
  const r = writeAsPanel({ data: sampleData() });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.code, 'PD-409-STALE');
  assert.strictEqual(r.currentUpdatedAt, stamp);
});

ok('yanlis damga -> 409 PD-409-CONFLICT (baska cihaz yazmis)', () => {
  const r = writeAsPanel({ data: sampleData(), expectedUpdatedAt: '2020-01-01T00:00:00.000Z' });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.code, 'PD-409-CONFLICT');
});

ok('bozuk sayi alani -> 422 PD-422-SCHEMA + sorunlu alanin yolu', () => {
  const bad = sampleData();
  bad.jobs[0].quantity = '1.234,56';   // Türkçe biçimli sayı = sunucu için bozuk
  const r = writeAsPanel({ data: bad, expectedUpdatedAt: stamp });
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.code, 'PD-422-SCHEMA');
  assert(Array.isArray(r.details) && r.details.length, 'details boş');
  assert.strictEqual(r.details[0].path, 'jobs[0].quantity');
});

ok('422 reddi diske YAZMAZ (tüm veri seti korunur)', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(TMP, 'panel-data.json'), 'utf8'));
  assert.strictEqual(raw.data.jobs[0].quantity, 3);
  assert.strictEqual(raw.updatedAt, stamp);
});

ok('dogru damga -> 200 ve damga ilerler', () => {
  const d = sampleData();
  d.jobs[0].title = 'Güncellendi';
  const r = writeAsPanel({ data: d, expectedUpdatedAt: stamp });
  assert.strictEqual(r.status, 200);
  assert(r.updatedAt && r.updatedAt !== stamp, 'damga ilerlemedi');
  stamp = r.updatedAt;
});

ok('her yazmadan once yedek birakilir (geri donulebilir)', () => {
  const dir = path.join(TMP, 'paneldata-backups');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
  assert(files.length >= 1, 'yedek oluşmadı');
});

ok('bilinmeyen yazma hatasi -> 500 PD-500-WRITE', () => {
  const r = panelWriteError(new Error('disk dolu'));
  assert.strictEqual(r.status, 500);
  assert.strictEqual(r.code, 'PD-500-WRITE');
});

ok('kod listesi eksiksiz (panel tarafiyla sozlesme)', () => {
  ['AUTH-401', 'PD-400-NODATA', 'PD-400-BADINPUT', 'PD-422-SCHEMA', 'PD-409-CONFLICT',
   'PD-409-STALE', 'PD-500-READ', 'PD-500-WRITE', 'SD-400-NODATA', 'SD-500-READ', 'SD-500-WRITE']
    .forEach((c) => assert(Object.values(CODES).includes(c), 'eksik kod: ' + c));
});

console.log('\n=== ' + pass + ' geçti, ' + fail + ' başarısız ===');
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
