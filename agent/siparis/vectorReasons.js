'use strict';

// Turkish text for the short vector quality codes. Kept free of native
// libraries so the HTTP process can label stored reports. Sentences that the
// quality check already writes in Turkish pass through unchanged.
const REASON_TEXT = {
  raster_detay_ve_metin_gorsel_teyidi: 'Görselden çevrildi; ince detay ve yazılar gözle kontrol edilmeli.',
  karma_sayfada_raster_korundu: 'PDF içindeki piksel görsel vektöre çevrilmedi.',
  cok_yol: 'Çok sayıda yol var (2000 üstü).',
  ince_cizgi: '0,2 mm’den ince çizgi var.',
  metin: 'PDF yazı içeriyor; yazılar eğriye çevrilmeli.',
  dolgu_detay_kalinligi_olculemedi: 'Dolgu detaylarının kalınlığı ölçülemedi.',
  supheli_oran: 'Desenin en-boy oranı olağan dışı.',
  oran_bozuldu: 'Hedef ölçü desenin en-boy oranını değiştiriyor.',
};
const reasonText = reason => REASON_TEXT[reason] ?? String(reason);
const reasonTexts = reasons => (Array.isArray(reasons) ? reasons : []).map(reasonText);

module.exports = { REASON_TEXT, reasonText, reasonTexts };
