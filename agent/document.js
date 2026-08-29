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
const FINANCE_FIELDS = [
  'direction', 'date', 'amount', 'currency',
  'sender_name', 'receiver_name', 'sender_iban', 'receiver_iban',
  'sender_tax_number', 'receiver_tax_number', 'invoice_number', 'reference_number',
  'description', 'subtotal', 'vat_amount', 'total', 'due_date',
];
const PRODFORM_FIELDS = [
  'order_no', 'order_title', 'delivery_date', 'product_description', 'product_type',
  'color', 'total_quantity', 'customer_name', 'notes',
];
const ARR_FIELDS = new Set(['print_areas', 'embroidery_areas', 'special_instructions']);
const NUM_FIELDS = new Set(['amount', 'subtotal', 'vat_amount', 'total', 'total_quantity']);
const EXTRACTION_FIELDS = ['document_type'].concat(FINANCE_FIELDS, PRODFORM_FIELDS);

const EXAMPLE_FINANCE = JSON.stringify({
  document_type: 'payment_receipt', direction: 'incoming', date: '2026-08-28',
  amount: 78500, currency: 'TRY', sender_name: '...', receiver_name: '...',
  sender_iban: null, receiver_iban: '...', sender_tax_number: null, receiver_tax_number: null,
  invoice_number: null, reference_number: '...', description: '...',
  subtotal: null, vat_amount: null, total: 78500, due_date: null,
  confidence: { document_type: 0.98, direction: 0.95, amount: 0.99 },
});
const EXAMPLE_PRODFORM = JSON.stringify({
  document_type: 'production_form',
  order_no: 'MRC-63', order_title: 'Fire Ants Şort', delivery_date: '2026-08-25',
  product_description: '...', product_type: 'Şort', color: 'Siyah',
  print_areas: ['göğüs', 'kol'], embroidery_areas: [],
  size_breakdown: { XS: 0, S: 5, M: 8, L: 4, XL: 3, XXL: 0, '3XL': 0 },
  total_quantity: 20,
  special_instructions: [{ text: '2 L bedende sırt baskısı yok', affects: 'print', area: 'sırt', delta: -2 }],
  customer_name: null, notes: '...',
  confidence: { document_type: 0.97, total_quantity: 0.9 },
});

// JSON ayiklama/onarma - tek kaynak: lib/jsonParse (sdr/* ile paylasilir).
const { parseJsonLoose, tryRepairJson } = require('./lib/jsonParse');

// tuzel kisi eki (sirket / kurum / kargo vb.) - taraf adinda bunlardan biri varsa o parca taraftir.
// Turkce-i normalize edilmis metne karsi test edilir.
const CO_SUFFIX_RE = /(\ba\.?\s?s\.?\b|anonim\s+sirket|ltd\.?\s?sti\.?|limited\s+sirket|\bsan\.?\s+(ve\s+)?tic\.?|sanayi\s+ve\s+tic|ith\.?\s?ihr|ithalat\s+ihracat|dis\s+tic|\bholding\b|nakliyat|lojistik|tasimacilik|\bkargo\b|pazarlama|dagitim|musavirlik|mumessillik|\binsaat\b|\btekstil\b|\bgida\b|dernegi|vakfi|\bkoop\b|birligi|odasi|belediyesi|universitesi|mudurlugu|bakanligi|doner\s+sermaye|isletmesi|koll\.?\s?sti|kom\.?\s?sti)/;
function normTrLoose(s) {
  return String(s || '').toLocaleLowerCase('tr')
    .replace(/[İıI]/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g').replace(/ü/g, 'u')
    .replace(/ö/g, 'o').replace(/ç/g, 'c').replace(/\s+/g, ' ').trim();
}

// "MERCİ TEKSTİL LTD ŞTİ / Cihan Berber" -> "MERCİ TEKSTİL LTD ŞTİ"
function cleanPartyName(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const parts = s.split(/\s*(?:\/|\||·|—|–|\n)\s*|\s+adına\s+|\s+nam[ıi]na\s+|\s+vekaleten\s+/i)
    .map((x) => x.trim()).filter(Boolean);
  if (parts.length <= 1) return s;
  const co = parts.find((p) => CO_SUFFIX_RE.test(normTrLoose(p)));
  return co || parts[0];
}

function toNum(v) {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/\./g, '').replace(',', '.').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}
// modelden geleni normalize et: eksik alan null, sayilari coerce, dizileri temizle
function normalizeExtraction(raw) {
  const o = { confidence: {} };
  EXTRACTION_FIELDS.forEach((k) => {
    let v = raw[k];
    if (v === '' || v === undefined) v = null;
    if (v != null && NUM_FIELDS.has(k)) v = toNum(v);
    if (v != null && typeof v === 'string') v = v.trim();
    o[k] = v;
  });
  const dt = ['payment_receipt', 'invoice', 'production_form', 'unknown'];
  const dr = ['incoming', 'outgoing', 'unknown'];
  o.document_type = dt.includes(o.document_type) ? o.document_type : 'unknown';
  o.direction = dr.includes(o.direction) ? o.direction : (o.document_type === 'production_form' ? null : 'unknown');

  // taraf adlari: "/", "|", yeni satir, "adina/vekaleten" ile ayrilmis kisi adini at,
  // tuzel-kisi eki olan parcayi taraf kabul et (imza/operator adini eleme guvenlik agi)
  if (o.document_type !== 'production_form') {
    o.sender_name = cleanPartyName(o.sender_name);
    o.receiver_name = cleanPartyName(o.receiver_name);
  }

  // finans
  if (o.total == null && o.amount != null) o.total = o.amount;
  if (o.amount == null && o.total != null) o.amount = o.total;

  // uretim formu alanlari
  o.print_areas = Array.isArray(raw.print_areas) ? raw.print_areas.filter(Boolean).map((x) => String(x).trim()) : [];
  o.embroidery_areas = Array.isArray(raw.embroidery_areas) ? raw.embroidery_areas.filter(Boolean).map((x) => String(x).trim()) : [];
  o.special_instructions = Array.isArray(raw.special_instructions)
    ? raw.special_instructions.map((x) => (typeof x === 'string' ? { text: x, affects: null, area: null, delta: null } : {
      text: String(x.text || '').trim(), affects: x.affects || null, area: x.area || null,
      delta: (x.delta == null || x.delta === '') ? null : (Number.isFinite(Number(x.delta)) ? Number(x.delta) : null),
    })).filter((x) => x.text)
    : [];
  const sb = raw.size_breakdown && typeof raw.size_breakdown === 'object' ? raw.size_breakdown : {};
  o.size_breakdown = {};
  ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'].forEach((k) => { const n = parseInt(sb[k], 10); if (Number.isFinite(n)) o.size_breakdown[k] = n; });

  const c = raw.confidence || {};
  ['document_type', 'direction', 'amount', 'total_quantity'].forEach((k) => {
    const n = Number(c[k]);
    if (Number.isFinite(n)) o.confidence[k] = Math.max(0, Math.min(1, n));
  });
  if (o.confidence.document_type == null) o.confidence.document_type = 0.5;
  return o;
}

function buildSystem() {
  const p = cp.forPrompt();
  return [
    'Sen bir belge çıkarım motorusun. Sana bir görsel/PDF verilecek; şu 4 türden biri:',
    '  DEKONT (banka ödeme dekontu) · FATURA (e-fatura/e-arşiv) · ÜRETİM FORMU (Merci iş emri) · belirsiz',
    '',
    'YALNIZ tek bir JSON nesnesi döndür. Açıklama/yorum/markdown/```json``` YOK. Kısa tut.',
    'Görselde OLMAYAN alanı UYDURMA — null bırak. HİÇBİR sayıyı/toplamı/adedi HESAPLAMA; sadece yazılanı oku.',
    'Belge bir HESAP ÖZETİ / EKSTRE (birden çok işlem satırı) ise: document_type="unknown", diğer alanlar null.',
    '',
    'document_type: "payment_receipt" | "invoice" | "production_form" | "unknown".',
    '',
    '— DEKONT/FATURA ise:',
    '  Tutarlar SAYI (1.234,56 -> 1234.56; bazı PDF\'lerde İngiliz formatı 2,500.00 -> 2500).',
    '  currency genelde "TRY". IBAN boşluksuz. Tarih YYYY-MM-DD.',
    '  document_type ayrımı: banka logosu + "DEKONT / İŞLEM BİLGİLERİ" + Sorgu/Referans No + "e-Dekont',
    '   yerine geçmez" => payment_receipt.  Kalem tablosu + Matrah + Hesaplanan KDV + ETTN => invoice.',
    '',
    '  YÖN (direction) — HER ZAMAN MERCİ AÇISINDAN. Para Merci\'ye/Merci adına geliyorsa "incoming",',
    '  Merci\'den/Merci adına gidiyorsa "outgoing".',
    '   • Dekont sahibi ("Sayın ...","Müşteri Bilgisi","MÜŞTERİ ÜNVANI", en üstteki IBAN/VKN bloğu) KİM?',
    '     - Sahip MERCİ ise: "GİDEN FAST / HESAPTAN / Çekilmiştir / Borç / negatif tutar" => outgoing;',
    '       "GELEN FAST / Hesabınıza yatmıştır / Alacak" => incoming.',
    '     - Sahip Merci DEĞİL, karşı tarafta Merci adı/IBAN/VKN var ise: dekonttaki GİDEN/GELEN o kişinin',
    '       yönüdür — Merci için TERSİNE çevir. (Sahip birine "Giden FAST" ile Merci\'ye para yolladıysa',
    '       Merci için bu "incoming".)',
    '   • "B/A" sütunu da dekont sahibinin yönüdür (B=Borç=sahip için çıkış, A=Alacak=sahip için giriş).',
    '   • Hiçbir sahip/Merci işareti yoksa direction="unknown", confidence.direction<=0.4.',
    '',
    '  TARAF ADLARI (sender_name = parayı gönderen, receiver_name = parayı alan):',
    '   • Etiketler: "Gönderen/Alıcı", "Gönderen Adı/Alıcı Adı", "Ad-Soyad/Unvan", "Ünvan",',
    '     "Borçlu/Alacaklı", "Lehdar" (=alıcı), "Gönderilen Kişi". Değerin İÇERİĞİNE bak, etikete değil',
    '     (bir banka "Gönderen Kişi" yazıp değere "... LTD. ŞTİ." koyabiliyor).',
    '   • Bir taraf değerinde tüzel-kişi eki varsa (A.Ş, LTD.ŞTİ, SAN.TİC, İTH.İHR, HOLDİNG, NAKLİYAT,',
    '     LOJİSTİK, KARGO, TAŞIMACILIK, İNŞAAT, TEKSTİL, GIDA, DERNEĞİ, VAKFI, BELEDİYESİ, ÜNİVERSİTESİ,',
    '     MÜDÜRLÜĞÜ, DÖNER SERMAYE ...) o metnin TAMAMI taraf adıdır.',
    '   • Aynı tarafta hem şirket ünvanı hem kişi adı varsa ("/","-","\\n","adına","vekaleten" ile',
    '     ayrılmış) => taraf = ŞİRKET. Kişi adını sender_name/receiver_name\'e YAZMA.',
    '   • ASLA taraf sayma: "İşlemi Yapan","Talimatı Veren","Kullanıcı Adı","Personel","Hazırlayan",',
    '     "Onaylayan", imza satırı. Bunlar operatör.',
    '   • Karşı taraf gerçekten kişiyse (hiç şirket eki yok) kişi adını yaz.',
    '   • Kargo/kurye ödemesinde alıcı = kargo firmasının tüzel ünvanı (şube görevlisi değil).',
    '',
    '  sender_tax_number / receiver_tax_number: sadece o tarafa ait AÇIKÇA yazılı numara.',
    '   10 hane = VKN (işletme), 11 hane = TCKN (kişi). Bireysel transferde genelde YOK => null.',
    '',
    '  reference_number önceliği: "Sorgu No/FAST Sorgu No" > "İşlem Referansı/İŞLEM REF" >',
    '   "Referans No" > "Dekont No" > "İşlem No" > "Sıra No/Fiş No". KULLANMA: "Müşteri No",',
    '   "Kolay Adres", "Mesaj Kodu/FAST Mesaj Kodu", "Mesaj Türü".',
    '',
    '  amount = net transfer tutarı. HARİÇ TUT: Masraf Tutarı, Komisyon, BSMV, Havale/EFT Ücreti,',
    '   Mesaj Ücreti. "GİDEN FAST TUTARI" / "Aktarılan Tutar" doğru; "TOPLAM TAHSİLAT TUTARI" masraf',
    '   dahil olabilir. Yazıyla yazılı tutar varsa çapraz kontrol et.',
    '',
    '  Fatura: invoice_number, subtotal (matrah), vat_amount (hesaplanan KDV), total (vergiler dahil),',
    '   due_date (son ödeme/vade).',
    '',
    '  description: gerçek kullanıcı notu ("AÇIKLAMA:" sonrası veya son "/" sonrası). MATBU metinleri',
    '   ATLA: "YUKARIDAKİ TUTAR ... KAYDEDİLMİŞTİR", "e-Dekont yerine geçmez", "(EFT) ÜCRETİ - FAST",',
    '   "havale işlemi gerçekleştirilmiştir".',
    '  Örnek: ' + EXAMPLE_FINANCE,
    '',
    '— ÜRETİM FORMU ise (Merci iş emri; genelde "Sipariş No", "MRC-XX", beden dağılımı, baskı/nakış bölgeleri içerir):',
    '  order_no, order_title, delivery_date (YYYY-MM-DD), product_description, product_type, color.',
    '  print_areas: baskı yapılacak bölgeler dizisi (göğüs, sırt, kol, ense, kapüşon vb.).',
    '  embroidery_areas: nakış yapılacak bölgeler dizisi.',
    '  size_breakdown: {XS,S,M,L,XL,XXL,3XL} adetleri (yazan bedenler).',
    '  total_quantity: formda yazan toplam adet.',
    '  special_instructions: ÖZEL / İSTİSNA notlar dizisi. HER BİRİNİ KAYBETME. Örnekler:',
    '    "2 L bedende sırt baskısı yok", "sağ göğüse kişiye özel soyadı", "logo baskıya sonra iletilecek".',
    '    Her not: {text: aynen yazılan cümle, affects: "print"|"embroidery"|null, area: bölge|null, delta: adet farkı (ör. -2)|null}.',
    '    delta\'yı ancak nottan NET çıkarabiliyorsan ver, yoksa null.',
    '  customer_name: formda müşteri/kulüp adı varsa. notes: diğer genel notlar.',
    '  Örnek: ' + EXAMPLE_PRODFORM,
    '',
    'confidence: {document_type: 0-1, ...} en azından document_type.',
    '',
    'MERCİ ŞİRKET BİLGİSİ (dekont/fatura yön tespiti için):',
    JSON.stringify(p),
  ].join('\n');
}

// AGENT_MOCK icin: dosya adindan ipucu al, uygun fixture dondur.
function mockExtraction(rec) {
  const n = (rec.originalName || '').toLowerCase();
  const fxDir = path.join(__dirname, '..', 'test', 'fixtures');
  let name = 'extract-incoming-receipt.json';
  if (/uretim.?form|production.?form|is.?emri|siparis.?form|prodform/.test(n)) {
    name = /istisna|exception|haric|yok/.test(n) ? 'extract-production-form-exception.json' : 'extract-production-form.json';
  }
  else if (/vakif.?kargo|kargo.?vakif|imza|signatory|operator/.test(n)) name = 'extract-vakif-cargo.json';
  else if (/kargo|cargo/.test(n)) name = 'extract-outgoing-cargo.json';
  else if (/giden|outgoing|odenen|payment-out/.test(n)) name = 'extract-outgoing-receipt.json';
  else if (/alis|purchase|gelen-fatura|incoming-invoice/.test(n)) name = 'extract-purchase-invoice.json';
  else if (/satis|sales|kesilen|outgoing-invoice/.test(n)) name = 'extract-sales-invoice.json';
  else if (/belirsiz|ambiguous|unknown/.test(n)) name = 'extract-ambiguous.json';
  else if (/override|guclu|strong/.test(n)) name = 'extract-strong-override.json';
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
    user: [block, { type: 'text', text: 'Bu belgeyi çıkar. YALNIZ JSON döndür, başka metin/markdown/```json``` yok.' }],
    maxTokens: 4000,
  });
  let raw = null;
  let repaired = false;
  try {
    raw = parseJsonLoose(resp.text);
  } catch (e) {
    raw = tryRepairJson(resp.text);
    repaired = !!raw;
  }
  if (!raw) {
    const hint = resp.stopReason === 'max_tokens' ? ' (yanıt token sınırında kesildi)' : '';
    throw new Error('Model yanıtı JSON olarak ayrıştırılamadı' + hint + ': ' + String(resp.text).slice(0, 300));
  }
  if (repaired) console.warn('[document] Vision yanıtı kesikti, onarıldı (stop=%s).', resp.stopReason);
  return {
    extraction: normalizeExtraction(raw),
    model: resp.model, costUsd: resp.costUsd, inputTokens: resp.inputTokens, outputTokens: resp.outputTokens,
    stopReason: resp.stopReason, repaired,
  };
}

// ---- DETERMINISTIK SINIFLANDIRMA ----
// Doner: { finalType, finalDirection, method, needsUserDecision, reason, modelSuggestion }
function classify(ext) {
  const modelType = ext.document_type || 'unknown';
  const modelDir = ext.direction || 'unknown';

  // ---- URETIM FORMU: finans akisina girmez, IBAN/VKN mantigi yok ----
  if (modelType === 'production_form') {
    const missing = [];
    if (!ext.order_no) missing.push('Sipariş No');
    if (!ext.product_type && !ext.product_description) missing.push('ürün tipi');
    if (!ext.total_quantity && !Object.keys(ext.size_breakdown || {}).length) missing.push('toplam adet');
    return {
      finalType: 'production_form',
      finalDirection: null,
      method: 'model_only',
      needsUserDecision: missing.length > 0,
      reason: missing.length
        ? 'Üretim formunda eksik alan(lar): ' + missing.join(', ') + '. Önizlemede tamamlayın.'
        : 'Üretim formu — İş Takip akışına aktarılacak (finansa gitmez).',
      modelSuggestion: { type: modelType, direction: null },
      evidence: [],
      missingFields: missing,
    };
  }

  const senderIbanCo = cp.isCompanyIban(ext.sender_iban);
  const receiverIbanCo = cp.isCompanyIban(ext.receiver_iban);
  const senderVknCo = cp.isCompanyVkn(ext.sender_tax_number);
  const receiverVknCo = cp.isCompanyVkn(ext.receiver_tax_number);
  const senderNameCo = cp.isCompanyName(ext.sender_name);
  const receiverNameCo = cp.isCompanyName(ext.receiver_name);
  const senderCo = senderIbanCo || senderNameCo || senderVknCo;
  const receiverCo = receiverIbanCo || receiverNameCo || receiverVknCo;

  let detType = 'unknown';
  let detDir = 'unknown';
  let strong = false; // IBAN veya VKN eslesmesi -> guclu kanit
  const ev = [];

  if (modelType === 'payment_receipt' || (ext.reference_number && !ext.invoice_number)) {
    detType = 'payment_receipt';
    if (receiverIbanCo) { detDir = 'incoming'; strong = true; ev.push('alıcı IBAN Merci hesabı'); }
    else if (senderIbanCo) { detDir = 'outgoing'; strong = true; ev.push('gönderen IBAN Merci hesabı'); }
    else if (receiverVknCo && !senderVknCo) { detDir = 'incoming'; strong = true; ev.push('alıcı VKN Merci'); }
    else if (senderVknCo && !receiverVknCo) { detDir = 'outgoing'; strong = true; ev.push('gönderen VKN Merci'); }
    else if (receiverNameCo && !senderNameCo) { detDir = 'incoming'; ev.push('alıcı adı Merci'); }
    else if (senderNameCo && !receiverNameCo) { detDir = 'outgoing'; ev.push('gönderen adı Merci'); }
  } else if (modelType === 'invoice' || ext.invoice_number) {
    detType = 'invoice';
    if (senderVknCo && !receiverVknCo) { detDir = 'outgoing'; strong = true; ev.push('satıcı VKN Merci (kesilen/satış faturası)'); }
    else if (receiverVknCo && !senderVknCo) { detDir = 'incoming'; strong = true; ev.push('alıcı VKN Merci (gelen/alış faturası)'); }
    else if (senderNameCo && !receiverNameCo) { detDir = 'outgoing'; ev.push('satıcı adı Merci'); }
    else if (receiverNameCo && !senderNameCo) { detDir = 'incoming'; ev.push('alıcı adı Merci'); }
  }

  const finalType = detType !== 'unknown' ? detType : (modelType !== 'unknown' ? modelType : 'unknown');

  let finalDirection = 'unknown';
  let needsUserDecision = false;
  let reason = '';
  let method = 'deterministic';

  // Merci tarafi tuzel sirket adi mi, yoksa yetkilinin SAHSI adi mi eslesti?
  const merciSideName = detDir === 'incoming' ? ext.receiver_name : (detDir === 'outgoing' ? ext.sender_name : null);
  const personOnly = !strong && detDir !== 'unknown' && cp.isPersonName(merciSideName) && !cp.isLegalName(merciSideName);

  if (detDir !== 'unknown') {
    finalDirection = detDir;
    if (modelDir !== 'unknown' && modelDir !== detDir) {
      if (strong) {
        // IBAN/VKN kesin - modeli ez, kullaniciya sorma ama not dus
        reason = ev.join('; ') + ' (model "' + modelDir + '" demişti; IBAN/VKN kanıtı esas alındı)';
      } else {
        // yalniz isim eslesmesi + model celisiyor -> KULLANICIYA SOR
        needsUserDecision = true;
        reason = 'Belge yönü kesin belirlenemedi: isim kanıtı "' + detDir + '" diyor, model "' + modelDir + '" dedi. Dekont sahibi Merci değilse yön Merci açısından ters olabilir.';
      }
    } else if (personOnly) {
      // Merci yetkilisinin sahsi adiyla eslesti - is mi sahsi mi belirsiz
      needsUserDecision = true;
      reason = ev.join('; ') + ' — ancak bu Merci yetkilisinin ŞAHSİ adı. İşlem şirket işi mi yoksa şahsi mi, kontrol edin.';
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

  const counterparty = pickCounterparty(ext, finalDirection);
  const categoryHint = finalType === 'payment_receipt'
    ? require('./financeCategory').suggestCategory(finalDirection, [ext.description, counterparty.name].filter(Boolean).join(' '))
    : null;

  return {
    finalType, finalDirection, method, needsUserDecision, reason,
    modelSuggestion: { type: modelType, direction: modelDir },
    evidence: ev,
    counterparty,
    categoryHint,
  };
}

// Karsi taraf = Merci OLMAYAN taraf. Panel bunu "Firma / Kişi" alanina koyar.
// Yon biliniyorsa net; bilinmiyorsa Merci olmayan tarafi tahmin et.
function pickCounterparty(ext, dir) {
  const S = { name: ext.sender_name || null, iban: ext.sender_iban || null, taxNumber: ext.sender_tax_number || null };
  const R = { name: ext.receiver_name || null, iban: ext.receiver_iban || null, taxNumber: ext.receiver_tax_number || null };
  if (dir === 'incoming') return S; // para gonderen = karsi taraf
  if (dir === 'outgoing') return R; // para alan = karsi taraf
  const sCo = cp.isCompanyName(ext.sender_name) || cp.isCompanyIban(ext.sender_iban) || cp.isCompanyVkn(ext.sender_tax_number);
  const rCo = cp.isCompanyName(ext.receiver_name) || cp.isCompanyIban(ext.receiver_iban) || cp.isCompanyVkn(ext.receiver_tax_number);
  if (sCo && !rCo) return R;
  if (rCo && !sCo) return S;
  return { name: ext.sender_name || ext.receiver_name || null, iban: null, taxNumber: null };
}

// Kullanici dostu sinif etiketi
function humanClass(finalType, finalDirection) {
  if (finalType === 'production_form') return 'Üretim Formu';
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

  // ---- URETIM FORMU: DETERMINISTIK adet + maliyet/fiyat (model hesaplamaz) ----
  let prodComputation = null;
  if (classification.finalType === 'production_form') {
    try {
      const pf = require('./productionForm');
      const panel = store.loadPanelData();
      const ct = (panel.data && panel.data.costTemplates) || null;
      const qty = pf.computeQuantities(v.extraction);
      const match = pf.matchCostAndPrice(ct, v.extraction, qty, null);
      prodComputation = { quantities: qty, costMatch: match };
    } catch (e) {
      prodComputation = { error: String(e && e.message || e) };
    }
  }

  const updated = docs.updateDocument(id, {
    status: 'extracted',
    extraction: v.extraction,
    classification,
    suggestions,
    prodComputation,
    extractMeta: {
      model: v.model, costUsd: v.costUsd, at: new Date().toISOString(), mock: !!MOCK,
      repaired: !!v.repaired, stopReason: v.stopReason || null,
    },
  });
  return updated;
}

// Uretim formu: kullanici onizlemede alan/baski-nakis boyutu degistirince adet+maliyeti
// YENIDEN hesapla (panel verisine DOKUNMAZ - sadece belge kaydindaki prodComputation guncellenir).
function recomputeProdForm(id, patch) {
  const rec = docs.getDocument(id);
  if (!rec) throw new Error('Belge bulunamadı: ' + id);
  if (rec.status === 'committed') throw new Error('Bu belge zaten işlendi.');
  if (!rec.classification || rec.classification.finalType !== 'production_form') {
    throw new Error('Bu belge bir üretim formu değil.');
  }
  const pf = require('./productionForm');
  const panel = store.loadPanelData();
  const ct = (panel.data && panel.data.costTemplates) || null;

  // model cikarimi + kullanici duzenlemeleri (kullanici oncelikli)
  const p = patch || {};
  const merged = Object.assign({}, rec.extraction, {
    order_no: p.order_no != null ? p.order_no : rec.extraction.order_no,
    product_type: p.product_type != null ? p.product_type : rec.extraction.product_type,
    product_description: p.product_description != null ? p.product_description : rec.extraction.product_description,
    total_quantity: p.total_quantity != null ? p.total_quantity : rec.extraction.total_quantity,
    size_breakdown: p.size_breakdown != null ? p.size_breakdown : rec.extraction.size_breakdown,
    print_areas: Array.isArray(p.print_areas) ? p.print_areas : rec.extraction.print_areas,
    embroidery_areas: Array.isArray(p.embroidery_areas) ? p.embroidery_areas : rec.extraction.embroidery_areas,
    special_instructions: Array.isArray(p.special_instructions) ? p.special_instructions : rec.extraction.special_instructions,
  });
  const qty = pf.computeQuantities(merged);
  // bnItems: kullanicinin girdigi baski/nakis kalemleri (bir bolgede birden fazla olabilir).
  // Eski chosenSizes objesi de kabul edilir (geriye donuk uyum).
  const bn = Array.isArray(p.bnItems) ? p.bnItems : (p.chosenSizes || null);
  const match = pf.matchCostAndPrice(ct, merged, qty, bn);
  const prodComputation = { quantities: qty, costMatch: match, recomputedAt: new Date().toISOString() };
  return docs.updateDocument(id, { prodComputation, prodEdits: p });
}

module.exports = { extractDocument, recomputeProdForm, classify, humanClass, buildSystem, parseJsonLoose, tryRepairJson, normalizeExtraction, EXTRACTION_FIELDS, runVision };
