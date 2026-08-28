# test/fixtures

`AGENT_MOCK=1` altında `agent/document.js` Vision yerine bu JSON'ları döndürür.
Gerçek Anthropic çağrısı yapılmaz.

**Bu dosyalardaki IBAN/VKN değerleri sahtedir.** Gerçek Merci IBAN'ları yalnız
`MERCI_IBANS` env değişkenindedir (repo public). Smoke testi bu sahte değerleri
`MERCI_IBANS` + `MERCI_COMPANY_PROFILE` ile eşleştirir.

| Dosya | Senaryo |
|---|---|
| `extract-incoming-receipt.json` | müşteriden Merci'ye ödeme — alıcı IBAN Merci |
| `extract-outgoing-receipt.json` | Merci'den tedarikçiye ödeme — gönderen IBAN Merci |
| `extract-purchase-invoice.json` | tedarikçi Merci'ye fatura kesmiş — alıcı VKN Merci |
| `extract-sales-invoice.json` | Merci müşteriye fatura kesmiş — satıcı VKN Merci |
| `extract-ambiguous.json` | IBAN/VKN okunamadı, model güveni düşük |
| `extract-conflict.json` | IBAN kanıtı "incoming" ama model "outgoing" dedi → kullanıcıya sor |
| `extract-production-form.json` | üretim formu (istisna yok) — finansa gitmez, İş Takip'e aktarılır |
| `extract-production-form-exception.json` | üretim formu, "2 L bedende sırt baskısı yok" → sırt baskı 18, göğüs/kol 20 |

Dosya adında `uretim-form` / `production-form` / `is-emri` / `siparis-form` geçen yükleme
üretim formu fixture'ına yönlenir; ek olarak `istisna` / `exception` geçerse exception fixture'ı.
