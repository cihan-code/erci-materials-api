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

// NOT: output_config.format (structured output) kullanmiyoruz - Anthropic "Schema is too complex"
// diyor (20+ alan + null union'lar). Bunun yerine prompt'ta net sema + "yalniz JSON" +
// saglam JSON ayiklama. Bu sema yalniz REFERANS / normalize icin.
const EXTRACTION_FIELDS = [
  'document_type', 'direction', 'date', 'amount', 'currency',
  'sender_name', 'receiver_name', 'sender_iban', 'receiver_iban',
  'sender_tax_number', 'receiver_tax_number', 'invoice_number', 'reference_number',
  'description', 'subtotal', 'vat_amount', 'total', 'due_date',
];
const NUM_FIELDS = new Set(['amount', 'subtotal', 'vat_amount', 'total']);

const EXAMPLE_JSON = JSON.stringify({
  document_type: 'payment_receipt', direction: 'incoming', date: '2026-08-28',
  amount: 78500, currency: 'TRY', sender_name: '...', receiver_name: '...',
  sender_iban: null, receiver_iban: '...', sender_tax_number: null, receiver_tax_number: null,
  invoice_number: null, reference_number: '...', description: '...',
  subtotal: null, vat_amount: null, total: 78500, due_date: null,
  confidence: { document_type: 0.98, direction: 0.95, amount: 0.99 },
});

// metinden JSON ayikla (```json ... ``` cit veya prose ile gelse bile)
function parseJsonLoose(text) {
  let t = String(text || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  if (t[0] !== '{') {
    const i = t.indexOf('{'); const j = t.lastIndexOf('}');
    if (i >= 0 && j > i) t = t.slice(i, j + 1);
  }
  return JSON.parse(t);
}

// modelden geleni normalize et: eksik alan null, sayilari coerce, string trim
function normalizeExtraction(raw) {
  const o = { confidence: {} };
  EXTRACTION_FIELDS.forEach((k) => {
    let v = raw[k];
    if (v === '' || v === undefined) v = null;
    if (v != null && NUM_FIELDS.has(k)) {
      const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/\./g, '').replace(',', '.').replace(/[^\d.-]/g, ''));
      v = Number.isFinite(n) ? n : null;
    }
    if (v != null && typeof v === 'string') v = v.trim();
    o[k] = v;
  });
  const dt = ['payment_receipt', 'invoice', 'unknown'];
  const dr = ['incoming', 'outgoing', 'unknown'];
  o.document_type = dt.includes(o.document_type) ? o.document_type : 'unknown';
  o.direction = dr.includes(o.direction) ? o.direction : 'unknown';
  const c = raw.confidence || {};
  ['document_type', 'direction', 'amount'].forEach((k) => {
    const n = Number(c[k]);
    o.confidence[k] = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
  });
  if (o.total == null && o.amount != null) o.total = o.amount;
  if (o.amount == null && o.total != null) o.amount = o.total;
  return o;
}

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
    'Tutarlar SAYI olsun (1.234,56 -> 1234.56). currency genelde "TRY".',
    'IBAN\'ları boşluksuz büyük harf yaz. Tarihleri YYYY-MM-DD.',
    'Fatura ise: invoice_number, subtotal (matrah), vat_amount (KDV), total (genel toplam), due_date.',
    'Dekont ise: reference_number (dekont/işlem no), amount = total.',
    'confidence: her alan için 0-1 arası güven.',
    '',
    'ÇIKTI ŞU JSON ŞEKLİNDE OLACAK (başka hiçbir metin YOK, ```json``` yok):',
    EXAMPLE_JSON,
    'Alanlar: ' + EXTRACTION_FIELDS.join(', ') + ', confidence{document_type,direction,amount}.',
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
  if (MOCK) return { extraction: normalizeExtraction(mockExtraction(rec)), model: SONNET, costUsd: 0, inputTokens: 0, outputTokens: 0 };

  const b64 = docs.fileBase64(rec).replace(/\s+/g, '');
  const block = rec.mime === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
    : { type: 'image', source: { type: 'base64', media_type: rec.mime, data: b64 } };

  const resp = await callClaude({
    model: SONNET,
    opType: 'document_extract',
    system: buildSystem(),
    user: [block, { type: 'text', text: 'Bu belgeyi çıkar. YALNIZ JSON döndür, başka metin yok.' }],
    maxTokens: 1200,
  });
  let raw;
  try { raw = parseJsonLoose(resp.text); }
  catch (e) { throw new Error('Model yanıtı JSON olarak ayrıştırılamadı: ' + String(resp.text).slice(0, 200)); }
  return { extraction: normalizeExtraction(raw), model: resp.model, costUsd: resp.costUsd, inputTokens: resp.inputTokens, outputTokens: resp.outputTokens };
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

module.exports = { extractDocument, classify, humanClass, buildSystem, parseJsonLoose, normalizeExtraction, EXTRACTION_FIELDS };
