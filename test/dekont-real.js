// GERCEK dekontlar uzerinde OFFLINE test - Anthropic API'ye HIC gitmez.
// Kullanicinin yukledigi 6 gercek dekont PDF'inden (Denizbank, Is Bankasi, Akbank,
// Yapi Kredi, Garanti x2) Vision'un URETMESI GEREKEN JSON elle transcribe edildi;
// normalizeExtraction + classify + pickCounterparty + categoryHint zincirinden gecirilir.
//
// Amac: sinif/yon/karsi taraf/kategori mantiginin gercek banka duzenlerinde dogru
// calistigini API harcamadan dogrulamak.
//
//   node test/dekont-real.js

const assert = require('assert');

// Merci profili: yalniz HERKESE ACIK bilgi (Ticaret Sicil VKN + unvan + yetkili adlari).
// GERCEK IBAN YOK - repo public.
process.env.MERCI_COMPANY_PROFILE = JSON.stringify({
  names: [
    'MERCI TEKSTİL SANAYİ VE TİCARET', 'MERCI TEKSTIL SANAYI VE TICARET',
    'MERCİ TEKSTİL SANAYİ VE TİCARET', 'MERCI TEKSTİL', 'MERCİ TEKSTİL',
    'Cihan Berber', 'Mert Kıvanç Tekin',
  ],
  persons: ['Cihan Berber', 'Mert Kıvanç Tekin'],
  vkn: '6160906794',
  taxOffice: 'PENDİK VERGİ DAİRESİ',
  ibans: [],
});
process.env.AGENT_MOCK = '1';

const { normalizeExtraction, classify } = require('../agent/document');
require('../agent/company-profile')._reset();

let pass = 0; let fail = 0;
function ok(name, fn) {
  try { fn(); console.log('  OK  ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + ' -> ' + (e && e.message || e)); fail++; }
}
function run(rawVision) {
  const ext = normalizeExtraction(rawVision);
  const cl = classify(ext);
  return { ext, cl };
}

// ---------------------------------------------------------------------------
// 1) Denizbank FAST — sahibi AHMET YİĞİT YILMAZ (Merci degil), alici MERT KIVANÇ TEKİN
//    "Giden FAST" AMA dekont sahibi karsi taraf -> Merci acisindan INCOMING (sahsi ad -> teyit)
console.log('\n# 1. Denizbank FAST (sahibi 3. kisi, alici Merci yetkilisi)');
{
  const { ext, cl } = run({
    document_type: 'payment_receipt', direction: 'incoming', date: '2026-08-28',
    amount: 19445, currency: 'TRY',
    sender_name: 'AHMET YİĞİT YILMAZ', receiver_name: 'MERT KIVANÇ TEKİN',
    sender_iban: 'TR230013400002087476100001', receiver_iban: 'TR600006400000191000722899',
    sender_tax_number: null, receiver_tax_number: null,
    reference_number: '616306343501099008', description: null,
    confidence: { document_type: 0.97, direction: 0.7 },
  });
  ok('payment_receipt + incoming', () => {
    assert.strictEqual(cl.finalType, 'payment_receipt');
    assert.strictEqual(cl.finalDirection, 'incoming');
  });
  ok('karşı taraf = gönderen (AHMET YİĞİT YILMAZ)', () => assert.strictEqual(cl.counterparty.name, 'AHMET YİĞİT YILMAZ'));
  ok('şahsi ad eşleşmesi -> kullanıcıya sor', () => assert.strictEqual(cl.needsUserDecision, true));
  ok('referans = FAST Sorgu No', () => assert.strictEqual(ext.reference_number, '616306343501099008'));
  ok('tutar masrafsız 19445', () => assert.strictEqual(ext.amount, 19445));
}

// ---------------------------------------------------------------------------
// 2) İş Bankası "Bilgi Dekontu" — sahibi MERT KIVANÇ TEKİN, Gelen FAST, HAWK PROMOSYON'dan
console.log('\n# 2. İş Bankası Bilgi Dekontu (Gelen FAST, ticari ödeme)');
{
  const { ext, cl } = run({
    document_type: 'payment_receipt', direction: 'incoming', date: '2026-08-28',
    amount: 10000, currency: 'TRY',
    sender_name: 'HAWK PROMOSYON HEDİYELİK', receiver_name: 'MERT KIVANÇ TEKİN',
    sender_iban: null, receiver_iban: 'TR600006400000191000722899',
    sender_tax_number: null, receiver_tax_number: null,
    reference_number: '645000150', description: null,
    confidence: { document_type: 0.95, direction: 0.9 },
  });
  ok('incoming', () => assert.strictEqual(cl.finalDirection, 'incoming'));
  ok('karşı taraf = HAWK PROMOSYON HEDİYELİK', () => assert.strictEqual(cl.counterparty.name, 'HAWK PROMOSYON HEDİYELİK'));
  ok('şahsi ad -> teyit iste', () => assert.strictEqual(cl.needsUserDecision, true));
  ok('referans = Sorgu No 645000150', () => assert.strictEqual(ext.reference_number, '645000150'));
}

// ---------------------------------------------------------------------------
// 3) Akbank EFT — gönderici KUTAY KOÇ, alıcı Mert Kıvanç Tekin, referans BOŞ
console.log('\n# 3. Akbank EFT (referans boş, işlemi yapan = gönderici)');
{
  const { ext, cl } = run({
    document_type: 'payment_receipt', direction: 'incoming', date: '2026-08-27',
    amount: 6175, currency: 'TRY',
    sender_name: 'KUTAY KOÇ', receiver_name: 'Mert Kıvanç Tekin',
    sender_iban: null, receiver_iban: 'TR030015700000000204552985',
    sender_tax_number: null, receiver_tax_number: null,
    reference_number: null, description: null,
    confidence: { document_type: 0.95, direction: 0.75 },
  });
  ok('incoming + karşı taraf KUTAY KOÇ', () => {
    assert.strictEqual(cl.finalDirection, 'incoming');
    assert.strictEqual(cl.counterparty.name, 'KUTAY KOÇ');
  });
  ok('referans null olabilir (Akbank alanı boş)', () => assert.strictEqual(ext.reference_number, null));
  ok('şahsi ad -> teyit', () => assert.strictEqual(cl.needsUserDecision, true));
}

// ---------------------------------------------------------------------------
// 4) Yapı Kredi e-Dekont "FAST GÖNDERİMİ" — sahibi HASAN ALİ YİĞİT, alıcı Mert Kıvanç Tekin
//    açıklama "... 20 adet özel t shirt baskı ödeme kalan yarısı" -> kategori Kalan Tahsilat
console.log('\n# 4. Yapı Kredi FAST GÖNDERİMİ (açıklamalı, negatif tutar)');
{
  const { ext, cl } = run({
    document_type: 'payment_receipt', direction: 'incoming', date: '2026-08-27',
    amount: 7000, currency: 'TRY',
    sender_name: 'HASAN ALİ YİĞİT', receiver_name: 'Mert Kıvanç Tekin',
    sender_iban: 'TR780006701000000024321832', receiver_iban: 'TR030015700000000204552985',
    sender_tax_number: null, receiver_tax_number: null,
    reference_number: '3245570104',
    description: 'AY-YILDIZ Takımı 20 adet özel t shirt baskı ödeme kalan yarısı (borç bitti)',
    confidence: { document_type: 0.96, direction: 0.7 },
  });
  ok('incoming, karşı taraf HASAN ALİ YİĞİT', () => {
    assert.strictEqual(cl.finalDirection, 'incoming');
    assert.strictEqual(cl.counterparty.name, 'HASAN ALİ YİĞİT');
  });
  ok('tutar 7000 (negatif işareti yok)', () => assert.strictEqual(ext.amount, 7000));
  ok('referans = Sorgu No (İşlem Ref değil)', () => assert.strictEqual(ext.reference_number, '3245570104'));
  ok('kategori önerisi = Kalan Tahsilat ("kalan yarısı")', () => assert.strictEqual(cl.categoryHint, 'Kalan Tahsilat'));
  ok('şahsi ad -> teyit', () => assert.strictEqual(cl.needsUserDecision, true));
}

// ---------------------------------------------------------------------------
// 5) Garanti "HESAPTAN HESABA HAVALE" — SAYIN MERCI TEKSTİL, VERGİ NO 6160906794 (Merci VKN),
//    ALACAKLI KARCANLAR TEKSTİL, TUTAR -1.742,40 -> OUTGOING (güçlü: VKN)
console.log('\n# 5. Garanti — Merci VKN\'li, tedarikçiye ödeme (güçlü kanıt)');
{
  const { ext, cl } = run({
    document_type: 'payment_receipt', direction: 'outgoing', date: '2026-08-28',
    amount: 1742.40, currency: 'TRY',
    sender_name: 'MERCI TEKSTİL SANAYİ VE TİCARET', receiver_name: 'KARCANLAR TEKSTİL SANAYİ TİCARET',
    sender_iban: 'TR460006200108900006291300', receiver_iban: 'TR140006200167000006296052',
    sender_tax_number: '6160906794', receiver_tax_number: null,
    reference_number: '2026-08-28-11.50.28.273945', description: null,
    confidence: { document_type: 0.98, direction: 0.9 },
  });
  ok('outgoing (gönderen VKN Merci = güçlü kanıt)', () => {
    assert.strictEqual(cl.finalDirection, 'outgoing');
    assert.strictEqual(cl.needsUserDecision, false);
    assert(/VKN/i.test(cl.reason));
  });
  ok('karşı taraf = alıcı KARCANLAR TEKSTİL', () => assert.strictEqual(cl.counterparty.name, 'KARCANLAR TEKSTİL SANAYİ TİCARET'));
  ok('tutar masraf/BSMV hariç 1742.4', () => assert.strictEqual(ext.amount, 1742.40));
}

// ---------------------------------------------------------------------------
// 6) Garanti aynı düzen — EFN SUNİ DERİ TEKSTİL, TUTAR -5.504,43
console.log('\n# 6. Garanti — ikinci tedarikçi ödemesi');
{
  const { ext, cl } = run({
    document_type: 'payment_receipt', direction: 'outgoing', date: '2026-08-27',
    amount: 5504.43, currency: 'TRY',
    sender_name: 'MERCI TEKSTİL SANAYİ VE TİCARET', receiver_name: 'EFN SUNİ DERİ TEKSTİL VE TİCARET',
    sender_iban: 'TR460006200108900006291300', receiver_iban: 'TR210006200073900006294082',
    sender_tax_number: '6160906794', receiver_tax_number: null,
    reference_number: '2026-08-27-14.51.23.985548', description: null,
    confidence: { document_type: 0.98, direction: 0.9 },
  });
  ok('outgoing, güçlü kanıt, teyit gerekmez', () => {
    assert.strictEqual(cl.finalDirection, 'outgoing');
    assert.strictEqual(cl.needsUserDecision, false);
  });
  ok('karşı taraf = EFN SUNİ DERİ TEKSTİL VE TİCARET', () => assert.strictEqual(cl.counterparty.name, 'EFN SUNİ DERİ TEKSTİL VE TİCARET'));
  ok('tutar 5504.43', () => assert.strictEqual(ext.amount, 5504.43));
}

// ---------------------------------------------------------------------------
// 7) Aynı Yapı Kredi ama model YÖNÜ YANLIŞ okursa ("outgoing" - GİDEN FAST başlığına aldanıp)
//    -> isim kanıtı incoming, model outgoing, şahsi ad -> kesinlikle needsUserDecision
console.log('\n# 7. Model yön çelişkisi (GİDEN FAST başlığına aldanma)');
{
  const { cl } = run({
    document_type: 'payment_receipt', direction: 'outgoing', date: '2026-08-27',
    amount: 7000, currency: 'TRY',
    sender_name: 'HASAN ALİ YİĞİT', receiver_name: 'Mert Kıvanç Tekin',
    sender_iban: null, receiver_iban: 'TR030015700000000204552985',
    reference_number: '3245570104', description: 'kalan ödeme',
    confidence: { document_type: 0.96, direction: 0.6 },
  });
  ok('çelişki -> needsUserDecision, isim kanıtı incoming', () => {
    assert.strictEqual(cl.finalDirection, 'incoming');
    assert.strictEqual(cl.needsUserDecision, true);
  });
}

// ---------------------------------------------------------------------------
console.log('\n=== ' + pass + ' geçti, ' + fail + ' başarısız ===');
process.exit(fail ? 1 : 0);
