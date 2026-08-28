// Finansal belge okuma (Vision) + DETERMINISTIK siniflandirma.
//
// Akis:
//   1. Yuklu belge (image/pdf) + KISA talimat + MINIMUM company profile -> Sonnet Vision (TEK cagri)
//   2. Model yalniz JSON dondurur (schema). Cikaramadigi alan null.
//   3. Backend deterministik siniflandirma: IBAN/VKN kurallari. Model <-> kural celisirse -> kullaniciya sor.
//   4. HICBIR finans mutasyonu YOK - sadece belge kaydina yazilir.
//
// Panel JSON / AGENT.md / musteri-is-finans listeleri MODELE GONDERILMEZ (maliyet).

const fs = require('fs');
const path = require('path');
const store = require('./store');
const docs = require('./documents');
const cp = require('./company-profile');
const { callClaude } = require('./claude');
const { SONNET } = require('./pricing');
const { suggestLinks } = require('./documentMatch');

const MOCK = process.env.AGENT_MOCK === '1';

const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['document_type', 'direction', 'amount', 'currency', 'confidence'],
  properties: {
    document_type: { type: 'string', enum: ['payment_receipt', 'invoice', 'unknown'] },
    direction: { type: 'string', enum: ['incoming', 'outgoing', 'unknown'] },
    date: { type: ['string', 'null'] },
    amount: { type: ['number', 'null'] },
    currency: { type: ['string', 'null'] },
    sender_name: { type: ['string', 'null'] },
    receiver_name: { type: ['string', 'null'] },
    sender_iban: { type: ['string', 'null'] },
    receiver_iban: { type: ['string', 'null'] },
    sender_tax_number: { type: ['string', 'null'] },
    receiver_tax_number: { type: ['string', 'null'] },
    invoice_number: { type: ['string', 'null'] },
    reference_number: { type: ['string', 'null'] },
    description: { type: ['string', 'null'] },
    subtotal: { type: ['number', 'null'] },
    vat_amount: { type: ['number', 'null'] },
    total: { type: ['number', 'null'] },
    due_date: { type: ['string', 'null'] },
    confidence: {
      type: 'object',
      additionalProperties: false,
      required: ['document_type', 'direction', 'amount'],
      properties: {
        document_type: { type: 'number' },
        direction: { type: 'number' },
        amount: { type: 'number' },
      },
    },
  },
};

function buildSystem() {
  const p = cp.forPrompt();
  return [
    'Sen bir finansal belge çıkarım motorusun. Sana bir DEKONT (banka ödeme dekontu) veya',
    'FATURA (e-fatura/e-arşiv) görseli verilecek. Görseldeki bilgileri çıkar.',
    '',
    'YALNIZ verilen JSON şemasına uygun JSON döndür. Açıklama, yorum, markdown YOK.',
    'Görselde OLMAYAN bir alanı UYDURMA — null bırak. Emin değilsen düşük confidence ver.',
    '',
    'document_type: banka dekontu ise "payment_receipt", fatura ise "invoice", ayırt edemiyorsan "unknown".',
    'direction: para Merci\'ye geliyorsa "incoming", Merci\'den gidiyorsa "outgoing", belirsizse "unknown".',
    'Tutarlar sayı olsun (1.234,56 -> 1234.56). currency genelde "TRY".',
    'IBAN\'ları boşluksuz büyük harf yaz. Tarihleri YYYY-MM-DD.',
    'Fatura ise: invoice_number, subtotal (matrah), vat_amount (KDV), total (genel toplam), due_date.',
    'Dekont ise: reference_number (dekont/işlem no), amount = total.',
    '',
    'MERCİ ŞİRKET BİLGİSİ (yön tespiti için — bu isimler/VKN/IBAN Merci tarafıdır):',
    JSON.stringify(p),
  ].join('\n');
}

// AGENT_MOCK icin: dosya adindan ipucu al, uygun fixture dondur.
function mockExtraction(rec) {
  const n = (rec.originalName || '').toLowerCase();
  const fxDir = path.join(__dirname, '..', 'test', 'fixtures');
  let name = 'extract-incoming-receipt.json';
  if (/giden|outgoing|odenen|payment-out/.test(n)) name = 'extract-outgoing-receipt.json';
  else if (/alis|purchase|gelen-fatura|incoming-invoice/.test(n)) name = 'extract-purchase-invoice.json';
  else if (/satis|sales|kesilen|outgoing-invoice/.test(n)) name = 'extract-sales-invoice.json';
  else if (/belirsiz|ambiguous|unknown/.test(n)) name = 'extract-ambiguous.json';
  else if (/celiski|conflict|wrong-iban/.test(n)) name = 'extract-conflict.json';
  try { return JSON.parse(fs.readFileSync(path.join(fxDir, name), 'utf8')); }
  catch (e) { return JSON.parse(fs.readFileSync(path.join(fxDir, 'extract-incoming-receipt.json'), 'utf8')); }
}

async function runVision(rec) {
  if (MOCK) return { extraction: mockExtraction(rec), model: SONNET, costUsd: 0, inputTokens: 0, outputTokens: 0 };

  const b64 = docs.fileBase64(rec).replace(/\s+/g, '');
  const block = rec.mime === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
    : { type: 'image', source: { type: 'base64', media_type: rec.mime, data: b64 } };

  const resp = await callClaude({
    model: SONNET,
    opType: 'document_extract',
    system: buildSystem(),
    user: [block, { type: 'text', text: 'Bu belgeyi çıkar. Yalnız şemaya uygun JSON döndür.' }],
    maxTokens: 1500,
    schema: EXTRACTION_SCHEMA,
  });
  let extraction;
  try { extraction = JSON.parse(resp.text); }
  catch (e) { throw new Error('Model yanıtı JSON değil: ' + String(resp.text).slice(0, 200)); }
  return { extraction, model: resp.model, costUsd: resp.costUsd, inputTokens: resp.inputTokens, outputTokens: resp.outputTokens };
}

// ---- DETERMINISTIK SINIFLANDIRMA ----
// Doner: { finalType, finalDirection, method, needsUserDecision, reason, modelSuggestion }
function classify(ext) {
  const modelType = ext.document_type || 'unknown';
  const modelDir = ext.direction || 'unknown';

  const senderCo = cp.isCompanyIban(ext.sender_iban) || cp.isCompanyName(ext.sender_name);
  const receiverCo = cp.isCompanyIban(ext.receiver_iban) || cp.isCompanyName(ext.receiver_name);
  const sellerVknCo = cp.isCompanyVkn(ext.sender_tax_number); // faturayi kesen = satici
  const buyerVknCo = cp.isCompanyVkn(ext.receiver_tax_number);

  let detType = 'unknown';
  let detDir = 'unknown';
  const ev = [];

  if (modelType === 'payment_receipt' || (ext.reference_number && !ext.invoice_number)) {
    detType = 'payment_receipt';
    if (cp.isCompanyIban(ext.receiver_iban)) { detDir = 'incoming'; ev.push('alıcı IBAN Merci hesabı'); }
    else if (cp.isCompanyIban(ext.sender_iban)) { detDir = 'outgoing'; ev.push('gönderen IBAN Merci hesabı'); }
    else if (receiverCo && !senderCo) { detDir = 'incoming'; ev.push('alıcı adı Merci'); }
    else if (senderCo && !receiverCo) { detDir = 'outgoing'; ev.push('gönderen adı Merci'); }
  } else if (modelType === 'invoice' || ext.invoice_number) {
    detType = 'invoice';
    if (sellerVknCo && !buyerVknCo) { detDir = 'outgoing'; ev.push('satıcı VKN Merci (kesilen/satış faturası)'); }
    else if (buyerVknCo && !sellerVknCo) { detDir = 'incoming'; ev.push('alıcı VKN Merci (gelen/alış faturası)'); }
    else if (cp.isCompanyName(ext.sender_name) && !cp.isCompanyName(ext.receiver_name)) { detDir = 'outgoing'; ev.push('satıcı adı Merci'); }
    else if (cp.isCompanyName(ext.receiver_name) && !cp.isCompanyName(ext.sender_name)) { detDir = 'incoming'; ev.push('alıcı adı Merci'); }
  }

  const finalType = detType !== 'unknown' ? detType : (modelType !== 'unknown' ? modelType : 'unknown');

  let finalDirection = 'unknown';
  let needsUserDecision = false;
  let reason = '';
  let method = 'deterministic';

  if (detDir !== 'unknown') {
    finalDirection = detDir;
    if (modelDir !== 'unknown' && modelDir !== detDir) {
      // celiski: deterministik kanit modelle celisiyor -> KULLANICIYA SOR
      needsUserDecision = true;
      reason = 'Belge yönü kesin belirlenemedi: IBAN/VKN kanıtı "' + detDir + '" diyor, model "' + modelDir + '" dedi.';
    } else {
      reason = ev.join('; ');
    }
  } else if (finalType === 'unknown') {
    needsUserDecision = true;
    reason = 'Belge türü ayırt edilemedi.';
    method = 'none';
  } else {
    // deterministik kanit yok, sadece model onerisi var
    method = 'model_only';
    if (modelDir !== 'unknown' && (ext.confidence && ext.confidence.direction >= 0.85)) {
      finalDirection = modelDir;
      reason = 'Deterministik kanıt yok; model yüksek güvenle "' + modelDir + '" dedi.';
      needsUserDecision = true; // model_only -> yine de kullaniciya dogrulat
      reason += ' Onay gerekli.';
    } else {
      needsUserDecision = true;
      reason = 'Yön için yeterli kanıt yok (IBAN/VKN okunamadı, model güveni düşük).';
    }
  }

  return {
    finalType, finalDirection, method, needsUserDecision, reason,
    modelSuggestion: { type: modelType, direction: modelDir },
    evidence: ev,
  };
}

// Kullanici dostu 5 sinif etiketi
function humanClass(finalType, finalDirection) {
  if (finalType === 'payment_receipt' && finalDirection === 'incoming') return 'Gelen Ödeme Dekontu';
  if (finalType === 'payment_receipt' && finalDirection === 'outgoing') return 'Yapılan Ödeme Dekontu';
  if (finalType === 'invoice' && finalDirection === 'incoming') return 'Gelen / Alış Faturası';
  if (finalType === 'invoice' && finalDirection === 'outgoing') return 'Kesilen / Satış Faturası';
  return 'Belirsiz Belge';
}

// Ana giris: belgeyi oku, siniflandir, kaydet. Finans mutasyonu YOK.
async function extractDocument(id) {
  const rec = docs.getDocument(id);
  if (!rec) throw new Error('Belge bulunamadı: ' + id);
  if (rec.status === 'committed') throw new Error('Bu belge zaten işlendi.');

  const v = await runVision(rec);
  const classification = classify(v.extraction);
  classification.humanLabel = humanClass(classification.finalType, classification.finalDirection);

  // ADAY eslesmeler (otomatik baglamaz - kullanici secer)
  let suggestions = { customers: [], suppliers: [], jobs: [], invoices: [], debts: [] };
  try { suggestions = suggestLinks(v.extraction, classification); } catch (e) { /* yoksay */ }

  const updated = docs.updateDocument(id, {
    status: 'extracted',
    extraction: v.extraction,
    classification,
    suggestions,
    extractMeta: { model: v.model, costUsd: v.costUsd, at: new Date().toISOString(), mock: !!MOCK },
  });
  return updated;
}

module.exports = { extractDocument, classify, humanClass, EXTRACTION_SCHEMA, buildSystem };
