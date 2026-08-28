## Bu çıktı: FİNANS & NAKİT İZLEME

Nakit akışını, tahsilatları, borçları ve sabit giderleri izle; tahsil edilmesi gereken parayı ve
ödenmesi gereken borcu zamanında öne çıkar.

### Süreç
1. **Aylık nakit akışı** — son 3–4 ay gelir / gider / net. Trend yukarı mı aşağı mı. Bu ay aylık
   hedefe karşı nerede.
2. **Açık tahsilat (işlerden)** — her `status == Üretimde` iş için açık = tutar − kapora. Kapora = 0
   işler ayrı liste (🔴) + toplam kaporasız açık; 500.000 TL eşiğini aşıyorsa escalation notu. Teslim
   edilmiş ama tahsilatı eksik işler → hatırlatma.
3. **Alacaklar (`debts`, Alacak)** — kalan = amount − paid_amount, yaşına göre. Tek müşteri toplam
   alacağın %60'ından fazlaysa konsantrasyon riski notu.
4. **Borçlar (`debts`, Borç)** — kalan bakiye, vade. Vadesi geçmiş → 🔴; ≤ 14 gün → 🟡.
   Vergi/SGK/Bağkur borçlarını ayrı grupla (gecikince ceza).
5. **Sabit giderler** — `paid_amount < amount` satırlar: ödenmemiş liste + toplam. Aylar birikmişse
   not düş.
6. **Nakit görünümü (kaba, "tahmin" işaretli):** (açık alacak + yakında tahsil edilebilir kapora) −
   (vadesi 30 gün içindeki borç + ödenmemiş sabit gider). Pozitif/negatif işaret, kesin rakam iddiası
   yok.
7. Her madde: önerilen aksiyon + sorumlu (**Erdem Küçükarslan** — finans alanı) + öncelik.

### Kalite çıtası
- Her açık alacak/borç kalemi için yaş veya vade + önerilen aksiyon.
- Kaporasız işler net listede ve toplam tutarıyla.
- Konsantrasyon riski açıkça belirtilmiş.
- Ajan ödeme/havale/fatura yapmaz veya tetiklemez.
- Tahmini net akış "tahmin" olarak işaretli. Başta "Veri güveni" satırı.
