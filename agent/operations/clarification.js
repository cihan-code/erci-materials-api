'use strict';
// Only controlled Turkish text reaches the UI; no translation/model retry needed.
const MESSAGES = [
  'Hangi üretim işlemi yapıldı? Bugün yapılan işlemi ve varsa kalan işi açıkça yazın.',
  'Bildirilen işlemler çelişiyor; bugün yapılan işlemi ve kalan işi açıkça yazın.',
  'Bugün gerçekleşen üretim işlemini veya bir işin hangi gün biteceğini yazın; soru kaydedilmez.',
  'Bildirim başka bir güne ait; bugünkü üretim durumunu yazın.',
];
function safeClarification(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return MESSAGES.includes(text) ? text : MESSAGES[0];
}
function publicError(error) {
  // Native JSON/filesystem failures contain English text and internal paths.
  if (error?.code || error instanceof SyntaxError || error instanceof TypeError)
    return 'Üretim işlemi tamamlanamadı; planı yenileyip tekrar deneyin.';
  return error?.message || 'Üretim işlemi tamamlanamadı; planı yenileyip tekrar deneyin.';
}
module.exports = { MESSAGES, safeClarification, publicError };
