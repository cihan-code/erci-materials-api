## Bu çıktı: AYLIK YÖNETİM RAPORU (ayın 1'i)

Biten ayı ciro / kâr / üretim / satış / tahsilat açısından hedeflere karşı değerlendiren, trend ve
aksiyon içeren yönetim raporu.

### Süreç
1. **Kapsam:** biten takvim ayı.
2. **Finansal özet:** ay geliri / gideri / net kâr; bir önceki ay ve 3 ay ortalamasıyla karşılaştır.
   Aylık hedefe (`hedeflerAylik`) karşı % gerçekleşme. Gider kırılımı (ilk 5 kategori). Ay sonu açık
   alacak / borç / ödenmemiş sabit gider.
3. **Üretim & teslimat:** ay içinde teslim edilen iş sayısı + toplam adet ("Aylık Tamamlanan İş"
   hedefine karşı — panel sayacı bozuksa kendin say, "panel sayacı 0, gerçek ~N" de). Zamanında
   teslim oranı. Gecikme yaşayan işler + ortalama gecikme.
4. **Satış & müşteri:** yeni müşteri sayısı (ölçülemiyorsa öyle yaz). Pipeline: kazanılan /
   kaybedilen fırsat, dönüşüm oranı, kaybedilenlerde ortak sebep. Segment dağılımı (kulüp / okul /
   ajans / mağaza). Tekrar eden müşteri oranı.
5. **Yıllık hedefe ilerleme:** `hedefler` tablosundaki her satır — yılın kaçında olduğumuza göre
   "yolunda / geride / önde".
6. **Riskler & konsantrasyon:** tek müşteri ciro payı, tek müşteri alacak payı, kaporasız iş yükü,
   tedarikçi bağımlılığı — yüzde ile.
7. **Panel veri kalitesi:** ay boyunca fark edilen hatalı/boş alanlar + yönetime düzeltme önerisi.
8. **Gelecek ay için 3–5 öneri** — veriden çıkan, önceliklendirilmiş.

### Kalite çıtası
- Her metrik hedefe VE bir önceki döneme karşı (tek başına rakam yok).
- Kaybedilen fırsat ve gecikmelerde sebep analizi.
- Konsantrasyon riskleri yüzde ile.
- Rapor 1–2 sayfa; uzun tablolar sona. Başta "Veri güveni" satırı.
