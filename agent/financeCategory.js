// Dekont aciklamasindan gelir/gider kategorisi ONERISI (kesin degil - kullanici onizlemede secer).
// Backend hesaplamasi degil, sadece metin ipucu. Kullanici degeri her zaman oncelikli.

const INCOME_CATS = ['Kapora', 'Kalan Tahsilat', 'Peşin Ödeme', 'Tahsilat', 'İş Geliri', 'Diğer Gelir'];
// Panelin gider kategorileriyle ayni (index.html #formGider).
const EXPENSE_CATS = ['Kumaş', 'Kesim', 'Baskı/Nakış', 'Dikim', 'Ütü-Paket', 'Nakliye', 'Kargo/Kurye', 'İşçilik', 'Vergi', 'Kira', 'Maaş', 'Borç Ödemesi', 'Diğer'];

function normTr(s) {
  return String(s || '').toLocaleLowerCase('tr').replace(/[İıI]/g, 'i');
}

// direction: 'incoming' | 'outgoing'. text: aciklama (+ istenirse karsi taraf adi).
// Doner: kategori string'i veya null (null -> UI "otomatik" gosterir, backend notr varsayilan kullanir).
function suggestCategory(direction, text) {
  const t = normTr(text);
  if (!t) return null;

  if (direction === 'incoming') {
    if (/(kapora|kaparo|avans|pesinat|on ?odeme|ilk ?odeme|ilk ?taksit|depozito)/.test(t)) return 'Kapora';
    if (/(kalan|bakiye|son ?odeme|kapan(is|ış)|hesap ?kapama|kalan ?tahsilat)/.test(t)) return 'Kalan Tahsilat';
    if (/(pesin|tamami|tamamı|full ?odeme)/.test(t)) return 'Peşin Ödeme';
    if (/(is ?geliri|siparis ?bedeli|urun ?bedeli|hizmet ?bedeli)/.test(t)) return 'İş Geliri';
    return null; // -> 'Tahsilat' (backend notr varsayilan)
  }

  // outgoing (gider)
  if (/(kargo|kurye|gonderi|sevk(iyat)?|lojistik|teslimat ?ucreti|nakliye|tasima)/.test(t)) return t.includes('nakliye') || t.includes('tasima') ? 'Nakliye' : 'Kargo/Kurye';
  if (/(kumas|akrilik|penye|kaskorse|dokuma|iplik|ham ?bez|1x1|2x1|ribana|susen|selanik)/.test(t)) return 'Kumaş';
  if (/(baski|nakis|serigraf|transfer ?baski|dtf|dtg|dijital ?baski|sublimasyon|patch)/.test(t)) return 'Baskı/Nakış';
  if (/(kesim)/.test(t)) return 'Kesim';
  if (/(dikim|konfeksiyon|fason|overlok|remayoz)/.test(t)) return 'Dikim';
  if (/(utu|paket|ambalaj|poset|koli|etiket)/.test(t)) return 'Ütü-Paket';
  if (/(kira|isyeri ?kira|depo ?kira|ofis ?kira)/.test(t)) return 'Kira';
  if (/(maas|bordro|sgk|prim|avans ?odeme|personel|ucret ?odeme)/.test(t)) return 'Maaş';
  if (/(vergi|kdv|muhtasar|beyanname|stopaj|damga|mtv|gecici ?vergi)/.test(t)) return 'Vergi';
  if (/(isci(lik)?|yevmiye|gundelik|tadilat ?isci)/.test(t)) return 'İşçilik';
  if (/(borc ?odeme|kredi ?taksit|kredi ?odeme|senet|cek ?odeme)/.test(t)) return 'Borç Ödemesi';
  return null; // -> 'Diğer'
}

module.exports = { INCOME_CATS, EXPENSE_CATS, suggestCategory, normTr };
