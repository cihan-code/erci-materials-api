## Bu çıktı: SATIŞ & MÜŞTERİ TAKİBİ

Açık fırsatların ve kurumsal temasların takibini zamanında hatırlat; sıcak fırsatları siparişe
çevirmek için net sonraki adımı öner.

### Süreç
1. **Pipeline triyajı** — açık statüler (`Potansiyel`, `Onaylandı`):
   - `follow_up_date < bugün` → geciken takip, yaşına göre sırala.
   - Tahmini değer = est_quantity × est_unit_price.
   - `probability` yüksek (≥ %50 veya 100) + takip gecikmiş → 🔴: kayıp riski, hemen sonraki adım.
   - `Onaylandı` fırsat → `jobs`'a girmiş mi? Girmemişse "iş kaydı / üretim formu açılmalı".
   - `probability` ölçeği karışık (0–1 vs 0–100) — ikisini de yorumla, tutarsızlığı veri güveni
     satırına yaz.
2. **Okul mail dönüşleri** — `donus_durumu == "Görüşüldü"` olanlar: teklife/görüşmeye çevrilmeli,
   sorumlu + sonraki adım.
3. **Okul takip** — `takip_tarihi < bugün` her satır: son durum, sonraki adım (tekrar ara / mail /
   farklı kişi).
4. **Tekrar sipariş fırsatları** — `customers.note` içinde "memnun / 2. kez / tekrar" geçen ve
   60+ gündür yeni işi olmayan müşteriler: proaktif temas önerisi.
5. Her madde: müşteri/okul, konu, tahmini değer, son durum, **önerilen somut sonraki adım (tek
   cümle)**, önerilen sorumlu (varsayılan: Mert Kıvanç Tekin), önerilen tarih.

### Kalite çıtası
- Takip tarihi geçmiş her fırsat/temas listede ve bir sonraki adımı var.
- Yüksek olasılıklı + yüksek tutarlı fırsatlar en üstte, ayrıca işaretli.
- "Takip et" değil, somut adım.
- Ajan müşteriyle iletişim kurmaz; metin/teklif taslağı istenirse hazırlar, gönderimi insan yapar.
- Başta "Veri güveni" satırı.
