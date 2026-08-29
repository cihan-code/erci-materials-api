// Dekont aciklamasindan gelir/gider kategorisi ONERISI (kesin degil - kullanici onizlemede secer).
// Backend hesaplamasi degil, sadece metin ipucu. Kullanici degeri her zaman oncelikli.

// Kategori listeleri tek kaynakta: agent/lib/enums.js (panel #formGelir / #formGider ile ayni).
const { INCOME_CATS, EXPENSE_CATS } = require('./lib/enums');

function normTr(s) {
  return String(s || '').toLocaleLowerCase('tr').replace(/[İıI]/g, 'i');
}

// direction: 'incoming' | 'outgoing'. text: aciklama (+ istenirse karsi taraf adi).
// Doner: kategori string'i veya null (null -> UI "otomatik" gosterir, backend notr varsayilan kullanir).
function suggestCategory(direction, text) {
  const t = normTr(text);
  if (!t) return null;

  if (direction === 'incoming') {
    if (/(kapora|kaparo|rezervasyon|booking)/.test(t)) return 'Kapora';
    if (/(avans|siparis ?avans)/.test(t)) return 'Kapora';
    if (/(pesinat|on ?odeme|onodeme|ilk ?odeme|ilk ?taksit|depozito|teminat|guvence)/.test(t)) return 'Kapora';
    if (/(kalan|bakiye|son ?odeme|son ?taksit|kapan(is|ış)|hesap ?kapama|kalan ?tahsilat|mahsuben|cari ?kapama)/.test(t)) return 'Kalan Tahsilat';
    if (/(pesin ?odeme|pesin|tamami|tamamı|full ?odeme|tek ?cekim)/.test(t)) return 'Peşin Ödeme';
    if (/(is ?geliri|siparis ?bedeli|siparis ?odemesi|urun ?bedeli|hizmet ?bedeli|mal ?bedeli|hakedis|numune ?bedeli)/.test(t)) return 'İş Geliri';
    if (/(iade|geri ?odeme|fazla ?odeme)/.test(t)) return 'Diğer Gelir';
    return null; // -> 'Tahsilat' (backend notr varsayilan)
  }

  // outgoing (gider)
  if (/(nakliye|tasima|tasıma|navlun|sevk(iyat)?)/.test(t)) return 'Nakliye';
  if (/(kargo|kurye|gonderi ?ucret|gönderi ?ucret|kapida ?odeme|kapıda ?odeme|teslimat ?ucret)/.test(t)) return 'Kargo/Kurye';
  if (/(kumas|kumaş|akrilik|penye|kaskorse|kaşkorse|dokuma|iplik|ham ?bez|ribana|susen|selanik|aksesuar|fermuar|dugme|düğme|hammadde)/.test(t)) return 'Kumaş';
  if (/(baski|baskı|nakis|nakış|serigraf|transfer ?baski|dtf|dtg|dijital ?baski|sublimasyon|patch)/.test(t)) return 'Baskı/Nakış';
  if (/(kesim)/.test(t)) return 'Kesim';
  if (/(dikim|konfeksiyon|fason|overlok|remayoz)/.test(t)) return 'Dikim';
  if (/(utu|ütü|paketleme|paket ?bedeli|ambalaj|poset|poşet|koli|etiket ?bedeli|kutu ?bedeli)/.test(t)) return 'Ütü-Paket';
  if (/(kira|isyeri ?kira|işyeri ?kira|depo ?kira|ofis ?kira|dukkan ?kira|dükkan ?kira)/.test(t)) return 'Kira';
  if (/(maas|maaş|bordro|sgk|prim|personel ?odeme|ucret ?odeme|huzur ?hakki|mesai)/.test(t)) return 'Maaş';
  if (/(vergi|kdv|muhtasar|beyanname|stopaj|damga|mtv|gecici ?vergi|geçici ?vergi|harc|harç|ba-bs)/.test(t)) return 'Vergi';
  if (/(iscilik|işçilik|yevmiye|gundelik|gündelik)/.test(t)) return 'İşçilik';
  if (/(borc ?odeme|borç ?odeme|borc ?kapama|kredi ?taksit|kredi ?odeme|senet|cek ?odeme|çek ?odeme|odunc|ödünç)/.test(t)) return 'Borç Ödemesi';
  return null; // -> 'Diğer'
}

module.exports = { INCOME_CATS, EXPENSE_CATS, suggestCategory, normTr };
