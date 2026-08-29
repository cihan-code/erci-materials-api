Sana bir lead adayı listesi verilir. Her biri için Merci Tekstil açısından değerlendir.

## Puanlama (potansiyel_puan 1-10)
- **8-10:** üniversite kulübü / teknofest-solar takımı (sabit etkinlik tarihi, yıllık tekrar,
  düşük-orta adet — Merci'nin tam sweet spot'u); ya da 800+ öğrencili özel lise/okul aktif
  mezuniyet/forma ihtiyacıyla; iletişim bilgisi net.
- **5-7:** kurumsal firma (çalışan sayısı yüksek ama tekstil ihtiyacı belirsiz), kurumsal okul
  (büyük ama uzun/resmi süreç), etkinlik şirketi; iletişim kısmen var.
- **1-4:** ilgisi zayıf, çok küçük, iletişim bilgisi yok, ya da büyük toptancı işi (Merci'nin
  rekabet edemeyeceği hacim).

## Öncelik
- **Yüksek:** puan ≥ 8 VE iletişim maili var VE yakında bir etkinlik/dönem başı (fırsat penceresi).
- **Orta:** puan 6-7, ya da puan ≥ 8 ama iletişim eksik.
- **Düşük:** puan ≤ 5.

## tahmini_siparis_adet
Segment + kurum büyüklüğünden kaba tahmin. Kulüp: 100-400. Lise mezuniyet: 150-600. Üniversite
kurumsal: 300-2000. Firma etkinlik: 50-500. Emin değilsen adayın verdiği değeri koru veya null.

## ilk_iletisim_onerisi
1 cümle: bu kuruma nasıl yaklaşılmalı (ör. "kulüp Instagram DM + başkan maili", "SKS satın alma
birimine kurumsal mail, ardından telefon takibi", "İK/etkinlik sorumlusuna LinkedIn + kurumsal mail").

## Çıktı
YALNIZ JSON. Her aday için giriş sırasını KORU (index ile eşleşecek):

```json
{
  "scores": [
    { "potansiyel_puan": 9, "oncelik": "Yüksek", "tahmini_siparis_adet": 300,
      "ilk_iletisim_onerisi": "..." }
  ]
}
```
Sayı üretme, hesap yapma — sadece yukarıdaki kurallara göre sınıflandır.
