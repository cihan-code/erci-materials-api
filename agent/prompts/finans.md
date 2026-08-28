## Bu çıktı: FİNANS & NAKİT İZLEME

Metrik tablosunun **FİNANS** bölümüne dayanarak nakit durumunu, tahsilatı, borçları ve sabit
giderleri yönetime özetle. **Sayıları tablodan al, yenisini hesaplama.**

### Bloklar
1. **İki metrik ayrı** — Sipariş Bedeli toplamı ve Tahsilat toplamı ayrı satır. "Ciro" deme.
   Tahsilat verisinin hangi aydan başladığını belirt.
2. **Aylık akış** — tablodan aylık gelir / gider / sabit gider / yönetim sonucu. Trend bir cümle.
   "Yönetim sonucu" güvenilir değilse "≈" kullan, "net kâr" deme.
3. **Alacak / Borç (debts)** — tablodaki açık alacak ve açık borç. **İşlerin bağlı tahsilatıyla
   TOPLAMA (S1).** Vadesi geçmiş → 🔴, vade yakın → 🟡. Tek taraf toplam alacağın büyük kısmıysa
   konsantrasyon riski notu (ama iki kaynağı birbirine ekleme).
4. **İşlerin bağlı tahsilatı** — aktif işlerin sipariş bedeli ve bağlı tahsilatı. Bağlı tahsilatı 0
   olanları işaretle ama "şu iş X TL borçlu" deme — sadece "bu işe bağlı tahsilat kaydı yok".
5b. **Faturalar** — tabloda varsa: açık alış faturası (ödememiz gereken) ve açık satış faturası
   (tahsil etmemiz gereken) toplamları + vadesi yaklaşanlar. **Bunları da debts / iş tutarıyla
   TOPLAMA (S1/S12)** — ayrı kalem olarak sun.
5. **Sabit giderler** — tablodaki kalemler ve toplam. **"Ödenmedi" DEME** (ödeme durumu verisi
   güvenilmez, S6). Sadece "aylık sabit gider yükü ~X TL".
6. **Şüpheli maaş çift kaydı** — tabloda varsa yönetime bildir (otomatik düzeltme yok, S7).
7. Her madde: önerilen aksiyon + sorumlu **Erdem Küçükarslan** + öncelik.

### Kalite çıtası
- Başta "Veri güveni" satırı (tablodaki maddelerden).
- Alacak (debts) ve iş tahsilatı asla toplanmıyor.
- Yönetim sonucu "kesin net kâr" olarak sunulmuyor.
- Ajan ödeme/havale/fatura yapmaz veya tetiklemez.
