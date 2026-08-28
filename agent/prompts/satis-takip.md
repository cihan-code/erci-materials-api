## Bu çıktı: SATIŞ & MÜŞTERİ TAKİBİ

Metrik tablosunun **AÇIK FIRSATLAR** + **MÜŞTERİLER** bölümlerine dayanarak takip listesi çıkar.
**Tahmini değerler tabloda hazır; olasılık 0–1 ölçeğinde normalize edilmiş.**

### Süreç
1. **Fırsat triyajı** — açık fırsatları takip gecikme gününe göre sırala. Yüksek tahmini değer +
   yüksek olasılık + takip gecikmiş → 🔴 kayıp riski. Her fırsat için somut sonraki adım.
   - **"Tahmini değer × olasılık" ile beklenen değer HESAPLAMA** — olasılık verisi zayıf.
   - Tabloda "VERİ TEMİZLİĞİ: Onaylandı" uyarısı varsa yönetime bildir (o kayıtları otomatik
     "kazanıldı" sayma, S9).
2. **Okul mail dönüşleri** — tablodaki "mail dönüşü var" satırları: teklife çevrilmeli.
3. **Okul takip** — takibi geciken satırlar: sonraki adım (tekrar ara / mail / farklı kişi).
4. **Tekrar sipariş** — müşteri notunda "memnun / 2. kez / tekrar" geçen ve uzun süredir yeni işi
   olmayan müşteriler: proaktif temas önerisi.
5. Her madde: müşteri/okul, konu, tahmini değer, son durum, **somut sonraki adım**, sorumlu
   (varsayılan **Mert Kıvanç Tekin**), önerilen tarih.

### Kalite çıtası
- Takibi geçmiş her fırsat/temas listede ve bir sonraki adımı var.
- Yüksek değerli + yüksek olasılıklı fırsatlar üstte ve işaretli.
- "Takip et" değil, somut adım.
- Ajan müşteriyle iletişim kurmaz; taslak isterse hazırlar, gönderimi insan yapar.
- Başta "Veri güveni" satırı (tablodan).
