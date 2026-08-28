## Bu çıktı: GÜNLÜK BRİFİNG

Her sabah, metrik tablosundan yönetim için tek sayfalık brifing ve o günün önceliklendirilmiş
yapılacaklar planını üret. **Tüm sayılar tablodan; hiçbir toplam/oran/gün farkı hesaplama.**

### Doldurulacak bloklar (bu sırayla)
1. **Başlık satırı** — tarih (gün adıyla), veri kaynağı + `updatedAt` + snapshot tazeliği, "düne
   göre" bir önceki brifing verildiyse kısa değişim özeti.
2. **Veri güveni** — snapshot tarihi + bu brifingdeki tahmini/şüpheli kalemler.
3. **🔴 Bugünün 3 Başlığı** — en kritik 3 durum (gecikme / risk / fırsat), her biri tek cümle + rakam.
   Her gün aynı jenerik cümleler değil; gerçekten en önemli 3 şey.
4. **Üretim Durumu** — tablodaki "ÜRETİM TAKİP" + "AKTİF İŞLER". Gecikmede olanlar üstte. Üretim
   Takip ile İşler ayrı iki tablo, birbirine bağlama (S3).
5. **Bugün / Yarın Teslim** — teslim/tahmini teslim tarihi bugün veya yarın olanlar.
6. **Tahsilat & Nakit** — tablodan: bağlı tahsilatı olmayan aktif işler, açık alacak/borç (debts,
   AYRI tut), sabit gider yükü. "Ödenmedi" deme, "ciro" deme.
7. **Satış Takibi** — takibi geciken açık fırsatlar + dönüş yapmış okul mailleri.
8. **Görev Tablosu** — tablodan: kişi bazlı açık görev, bugün vadeli, en eski geciken 5–8.
9. **Hedef Nabzı** — tablodaki hedefler bölümü (gerçekleşen + %). "hesaplanamıyor / ölçülemiyor"
   gelen satırı öyle yaz.
10. **📋 Günün Planı** — üç başlık: **Erdem (Finans)**, **Cihan (İşler & Üretim)**,
    **Mert Kıvanç (Satış & Müşteri)**. Her biri için en fazla 5 öncelikli madde, o kişinin yetki
    alanından. Format: `[öncelik] eylem — neden (panel referansı)`. Öncelik: 🔴 / 🟡 / 🟢.
    Bir maddeyi yanlış kişiye yazma (tahsilat → Erdem, üretim gecikmesi → Cihan, fırsat takibi →
    Mert Kıvanç).
11. **💡 Yönetime Aksiyon Önerileri** — 3–6 madde; panelde olmayan ama veriden çıkan çıkarımlar
    (ör. tek müşteri konsantrasyon riski, kapora politikası).
12. **Kapanış** — sonraki döngüde bakılacak kritik takipler.

### Kalite çıtası
- **Tek sayfa. Toplam ~600 kelimeyi geçme.** Kısa cümleler, tablo satırları 1 satır.
- Alt-senaryo (Plan A / Plan B), uzun paragraf, tekrar, giriş-kapanış dolgusu **yok**.
  Her madde: durum + rakam + tek net aksiyon.
- Her iddia bir rakama/panel kaydına dayanır.
- Günün planındaki her madde bir kişiye atanmış ve bir sebebe bağlı.
- Hiçbir öneri "yapıldı" dilinde değil; hepsi "yapılmalı / önerilir".
- Dünkü brifinge göre ne değişti belli.
