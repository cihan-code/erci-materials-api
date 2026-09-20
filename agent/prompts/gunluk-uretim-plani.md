## Bu çıktı: GÜNLÜK ÜRETİM PLANI

Her sabah atölyeye ve üretim sorumlusuna dönük, **o gün fiilen yapılacak işlerin** listesini üret.
Bu bir yönetim brifingi değil — **sahada uygulanacak bir iş listesidir.** Okuyan kişi listeyi eline
alıp atölyeye gidebilmeli.

**Tüm tarih, gün sayısı, adet ve kapasite tablodan. Hiçbir şey hesaplama.**

Use the recorded production progress and remaining quantities provided by the backend.
Show carried work as "Önceki günden kalan" with the operation's remaining amount.
Order quantity, remaining quantity, and daily target are different: never label the
remaining quantity as a daily target. Completed operations must not be assigned again.
Reported blocked jobs belong in the blockers section, not today's executable work.
Keep the explicit uncertainty about unreported progress and partial non-sewing durations.

### Doldurulacak bloklar (bu sırayla)

1. **Başlık** — tarih (gün adıyla), planlanan aktif iş sayısı, veri tazeliği.
2. **Veri güveni** — tablodaki "VERİ GÜVENİ" maddelerini kısaca aktar. Kendi yorumunu ekleme.
3. **🔧 BUGÜN YAPILACAKLAR** — tablodaki "BUGÜN YAPILACAK OPERASYONLAR" kaleminin tamamı.
   Her satır: `müşteri · adet ürün → operasyon`. Operasyonun nerede yapıldığını yazma. Parça bilgisi varsa (yaka ribanası,
   kaşkorse, kapüşon astarı) **aynen yaz** — sahadaki kişinin neyi keseceğini bilmesi gerekiyor.
   Riskli işler üstte. Bugün yapılacak bir şey yoksa bunu açıkça söyle, satır uydurma.
4. **⚠️ GECİKME RİSKİ OLAN İŞLER** — tablodaki "Durum" alanı GECİKME veya RİSKLİ olanlar.
   Her biri: iş, kaç gün, darboğazın hangi adımda olduğu. Kurtarma önerisi ver (sorumlu:
   **Cihan Berber**; müşteriyle konuşulması gerekiyorsa **Mert Kıvanç Tekin**).
5. **🧵 DİKİM ATÖLYESİ YÜKÜ** — kapasite paylaşımlı olduğu için hangi işin hangi işi beklettiği.
   Yığılma varsa söyle. Kapasite rakamlarını tablodan al.
6. **⛔ BLOKAJLAR** — fermuar/kordon eksiği gibi, bir adımı durduran şeyler. Her biri için
   "bugün ne yapılmalı" de (ör. "bugün sipariş verilmezse dikim kayar").
7. **❓ CEVAP BEKLEYENLER** — tablodaki "CEVAP BEKLİYOR" ve "EŞLEŞTİRİLEMEYEN / EKSİK VERİ"
   satırları. Bunlar yönetimin cevaplaması gereken sorular; **tahmin etme, olduğu gibi sor.**
8. **📅 SONRAKİ 3 GÜN** — kısa önizleme, sadece dikkat gerektirenler.

### Kalite çıtası

- **Kısa ve uygulanabilir.** 600 kelimeyi geçme. Her satır bir eylem.
- Operasyon adlarını tablodaki **haliyle** yaz. "Yaka ribanası kesimi"ni "kesim" diye kısaltma —
  sahadaki kişinin ihtiyacı olan ayrıntı tam olarak bu.
- Aşaması "BİLİNMİYOR" olan işte planı kesin gerçekmiş gibi sunma; "aşama bildirilmemiş,
  plan baştan kuruldu" de.
- "ÖN TAHMİN" işaretli işlerde tahmini kesin tarih gibi yazma.
- Tahmini bitiş tarihlerinde **"≈"** kullan. Kapasite ortalamadır, kesin tarih verme.
- Hiçbir öneri "yapıldı" dilinde değil — hepsi "yapılmalı".
- Türkçe yazım kurallarına tam uy. Uydurma kısaltma, bozuk kelime, İngilizce kelime yok.
