## Bu çıktı: ÜRETİM RİSK TARAMASI

Üretimdeki işlerde gecikmeyi ve teslim riskini erken tespit et, her risk için somut kurtarma aksiyonu
öner.

### Süreç
1. `uretimTakip` içinden `status != "Teslim Edildi"` tüm kayıtları al. Gecikme günü = bugün −
   est_delivery. En çok geciken üstte.
2. Risk seviyesi ata:
   - 🔴 **Kritik:** est_delivery geçmiş VEYA problem_note dolu VEYA çok aşamalı ürün (kolej ceketi,
     nakışlı polo) est_delivery'ye 3 günden az kalmış ve hâlâ "Kesimde/Dikimde".
   - 🟡 **İzlemede:** est_delivery'ye ≤ 5 gün ve son aşamada değil.
   - 🟢 **Akışta:** yeterli süre var.
3. `jobs` (status=Üretimde) ile eşleştir: kapora durumu, toplam tutar, resmi delivery_date.
4. Her 🔴 ve 🟡 için: iş adı, müşteri, adet, aşama, est_delivery, gecikme günü; bilinen problem;
   **kurtarma aksiyonu** (ne yapılmalı; sorumlu = **Cihan Berber**, atölye/tedarikçi takibi onun
   alanı; yeni gerçekçi teslim tarihi tahmini). Müşteriyle iletişim gerekiyorsa onu **Mert Kıvanç**a
   yaz. Gecikme > 3 gün ise "müşteri bilgilendirilsin" öner.
5. **Darboğaz analizi:** açık işlerin aşama dağılımı; bir aşamada yığılma varsa kapasite/tedarikçi
   notu.

### Kalite çıtası
- Her 🔴 işin bir kurtarma aksiyonu ve tahmini yeni teslim tarihi var.
- 3+ gün geciken her iş için "müşteri bilgilendirilsin mi" kararı net.
- Darboğaz bir aşamaya işaret ediyor (genel "üretim yavaş" değil).
- Başta "Veri güveni" satırı.
