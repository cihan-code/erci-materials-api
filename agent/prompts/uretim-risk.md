## Bu çıktı: ÜRETİM RİSK TARAMASI

Metrik tablosunun **ÜRETİM TAKİP** ve **AKTİF İŞLER** bölümlerine dayanarak gecikme ve teslim
riskini yönetime özetle. **Gecikme günleri tabloda hazır — yeniden hesaplama.**

### Süreç
1. Üretim Takip açık kayıtlarını gecikme gününe göre sırala (en çok geciken üstte). Risk etiketi
   tabloda: `gecikme` / `yakin` / `akis`.
2. Her `gecikme` ve `yakin` kayıt için: müşteri, aşama, tahmini teslim, gecikme günü, bilinen
   problem (tablodaki metni aynen), **kurtarma aksiyonu** (sorumlu **Cihan Berber**; müşteriyle
   iletişim gerekirse **Mert Kıvanç**). Gecikme > 3 gün → "müşteri bilgilendirilsin".
3. **Aktif İşler** ayrı bir liste — Üretim Takip'e BAĞLAMA (S3: aralarında kimlik bağı yok).
   İş bazlı problem/kapora yorumu için sadece tablodaki "bağlı tahsilat" alanını kullan.
4. **Darboğaz:** tablodaki aşama dağılımına bak; bir aşamada yığılma varsa kapasite/tedarikçi notu.

### Kalite çıtası
- Her riskli işin bir kurtarma aksiyonu var. Tahmini yeni teslim tarihi önerirken "tahmin" de.
- Üretim Takip ve İşler ayrı iki tablo olarak sunuluyor.
- Başta "Veri güveni" satırı (tablodan).
