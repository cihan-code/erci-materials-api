// Panelin (merci-tekstil-panel/index.html) gercek enum degerleri - TEK KAYNAK.
// Panel bu listelerden birini degistirirse BURASI da guncellenmeli (yoksa ajan
// gecerli bir durumu "gecersiz" sayar). Eskiden ayni listeler 2-3 dosyada kopyaydi.

const JOB_STATUSES = ['Teklif', 'Onaylandı', 'Üretimde', 'Teslim Edildi', 'İptal'];
const JOB_ACTIVE = ['Onaylandı', 'Üretimde'];

const URETIM_STATUSES = [
  'Kumaş Bekleniyor', 'Kumaş Geldi', 'Kesimde', 'Baskı/Nakışta', 'Dikimde',
  'Ütü-Pakette-Teslimat Bekliyor', 'Teslim Edildi',
];

const PIPELINE_STATUSES = ['Potansiyel', 'Fiyat Verildi', 'Görüşülüyor', 'Kazanıldı', 'Kaybedildi'];
const PIPELINE_CLOSED = ['Kazanıldı', 'Kaybedildi'];

const INCOME_CATS = ['Kapora', 'Kalan Tahsilat', 'Peşin Ödeme', 'Tahsilat', 'İş Geliri', 'Diğer Gelir'];
// Panelin #formGider kategorileri (+ Borç Ödemesi).
const EXPENSE_CATS = [
  'Kumaş', 'Kesim', 'Baskı/Nakış', 'Dikim', 'Ütü-Paket', 'Nakliye', 'Kargo/Kurye',
  'İşçilik', 'Vergi', 'Kira', 'Maaş', 'Borç Ödemesi', 'Diğer',
];

const INVOICE_INCOMING_STATUSES = ['Ödenmedi', 'Kısmi Ödendi', 'Ödendi', 'İptal'];
const INVOICE_OUTGOING_STATUSES = ['Tahsil Edilmedi', 'Kısmi Tahsil Edildi', 'Tahsil Edildi', 'İptal'];

// Merci yoneticileri (aksiyon atamalari icin). E=Finans, C=İşler&Üretim, M=Satış.
const MANAGERS = ['Cihan Berber', 'Erdem Küçükarslan', 'Mert Kıvanç Tekin'];

module.exports = {
  JOB_STATUSES, JOB_ACTIVE, URETIM_STATUSES, PIPELINE_STATUSES, PIPELINE_CLOSED,
  INCOME_CATS, EXPENSE_CATS, INVOICE_INCOMING_STATUSES, INVOICE_OUTGOING_STATUSES, MANAGERS,
};
