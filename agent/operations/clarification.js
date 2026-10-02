'use strict';
// Only controlled Turkish text reaches the UI; no translation/model retry needed.
const MESSAGES = [
  'Hangi üretim işlemi yapıldı? Bugün yapılan işlemi ve varsa kalan işi açıkça yazın.',
  'Bildirilen işlemler çelişiyor; bugün yapılan işlemi ve kalan işi açıkça yazın.',
  'Bugün gerçekleşen üretim işlemini yazın; soru veya gelecek planı kaydedilmez.',
  'Bildirim başka bir güne ait; bugünkü üretim durumunu yazın.',
];
function safeClarification(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return MESSAGES.includes(text) ? text : MESSAGES[0];
}
module.exports = { MESSAGES, safeClarification };
