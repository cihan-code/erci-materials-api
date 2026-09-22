# Ajan altyapısı (panel entegrasyonu)

Panelin ajan sekmelerini besleyen paylaşılan backend parçası. **Not (2026-09-22):** Yönetim
Ajanı (günlük brifing / üretim risk / satış takip / finans / haftalık-aylık rapor + "Ajana Söyle"
serbest metin kutusu) kaldırıldı. Kalan tek rapor tipi `gunluk-uretim-plani` — panelin
"📋 Üretim Takip Ajanı" sekmesindeki "AI Brifing" alt bölümünü besler. Bu modülün kendi mantığı
`agent/uretim/` altında, kendi dokümanı `agent/uretim/PROGRESS.md`'de.

## Modüller

| Dosya | İş |
|---|---|
| `store.js` | Ajan çıktı kovası (`DATA_DIR/agent/`), panel-data okuma/**dar yazma** (yedekli), API maliyet günlüğü — paylaşılan altyapı |
| `signals.js` | `analyze_panel.py`'nin JS portu — **domain bazlı**: `production / tasks / sales / crm / finance`. Ham panel JSON modele **asla** gitmez. `act.js` "Ajana Söyle" bağlamı için kullanır |
| `pricing.js` | Model seçimi (`HAIKU`, `SONNET`) + USD maliyet tahmini |
| `claude.js` | **Tek Anthropic çağrı noktası** — streaming SSE, retry, **her çağrı `usage-log.jsonl`'e** (model, token, USD, opType). SDR ve belge Vision okuma da bunu kullanır |
| `generate.js` | Rapor üretici — jenerik `OP` sözlüğüyle tipe göre model/domain/prompt seçer. Şu an tek giriş: `gunluk-uretim-plani` |
| `actions.js` | Panelde **dar create/update fonksiyonları** — `safe` / `confirm` (finansal/silme/kritik); `record_production_progress` dahil |
| `act.js` | Serbest metin komuttan aksiyon çıkarır (Haiku, structured output), backend uygular. **İkinci Claude çağrısı yok** |
| `prompts/` | `identity.md` (paylaşılan sistem tanımı) + `gunluk-uretim-plani.md` + `act.md` |

## Uçlar (hepsi `x-api-key` arkasında)

| Metot & yol | İş |
|---|---|
| `GET  /api/agent/outputs`, `/outputs/:id`, `/latest`, `/status` | Rapor okuma |
| `POST /api/agent/run?type=gunluk-uretim-plani` | Rapor üretimini başlat (async) |
| `POST /api/agent/outputs` | Dışarıdan hazır markdown kaydet |
| `GET  /api/agent/usage` | API maliyet özeti (bugün / 7g / 30g; model & op bazında) |
| `POST /api/agent/act` `{instruction}` | Serbest metin komut → safe aksiyonlar uygulanır, `confirm` aksiyonlar `pending` döner |
| `POST /api/agent/act/confirm` `{action}` | Onaylanan tek aksiyonu uygula (Claude çağrısı yok) |
| `GET  /api/agent/production-progress` | Üretim Takip Ajanı'nın aşama kaydı (bkz. `agent/uretim/`) |

## Güvenlik

- Ajan `/api/paneldata`'yı toptan yazmaz; `actions.js` yalnız **hedef kaydı** değiştirir, `writePanelData`
  her seferinde yedek alır ve optimistic-concurrency uygular.
- **Onay gerektirenler:** `add_income`, `add_expense`, `update_debt_payment`, `set_job_deposit`,
  `set_job_status`, `delete_task` — panelde "Onayla" butonuyla uygulanır.
- `ANTHROPIC_API_KEY` yalnız Render env — panel `index.html`'e veya git'e girmez.

## Kurulum

```
Render → Environment: ANTHROPIC_API_KEY = sk-ant-...   (DATA_DIR=/data, API_KEY, CORS_ORIGIN zaten var)
GitHub → repo secret: MERCI_API_KEY = panelin x-api-key'i
```

## Test — ÖNCE ücretsiz yol

Her değişiklikte canlı API çağırmak = para. Bunun yerine:

```bash
# 1) Ücretsiz duman testi — API'ye HİÇ gitmez
npm run smoke -- /yol/panel-snapshot.json

# 2) Mock sunucu — tüm uçlar çalışır, sahte yanıt, $0
DATA_DIR=./data npm run mock
curl -X POST localhost:3000/api/agent/run?type=gunluk-uretim-plani -H "x-api-key: $API_KEY"

# 3) GERÇEK çağrı — yalnız çıktı KALİTESİ kontrol edilecekse, seyrek/toplu
DATA_DIR=./data ANTHROPIC_API_KEY=sk-ant-... node agent/generate.js gunluk-uretim-plani
```

**Güvenlik kilidi:** `AGENT_MOCK=1` production'da (Render `RENDER=true` veya `NODE_ENV=production`)
ise `agent/claude.js` açık uyarı basıp `process.exit(1)` yapar — `server.js` claude.js'i eager
require ettiği için uygulama `app.listen`'e gelmeden durur. Sahte çıktının canlıya yazılması
imkânsız. Yerelde (RENDER yok) sadece uyarı verir, devam eder.

Bu makinede node yoksa: `export ELECTRON_RUN_AS_NODE=1; NODE="/Applications/Visual Studio Code.app/Contents/MacOS/Code"; "$NODE" test/smoke.js snapshot.json`

## Zamanlama

`.github/workflows/agent-brief.yml` — her gün 05:00 UTC (08:00 İstanbul) `gunluk-uretim-plani`.
Şu an **manuel olarak devre dışı** (`gh workflow list --all`) — kullanıcı isteğiyle arka planda
çalışmıyor; `gh workflow enable "Uretim Plani Ajani"` ile açılabilir.

## Finansal belge işleme (dekont / fatura)

`company-profile.js` · `documents.js` (kalıcı disk store) · `document.js` (Sonnet Vision +
deterministik sınıflandırma) · `documentMatch.js` (aday eşleşmeler) · `documentCommit.js`
(onaylı finans kaydı) · `invoices.js` (fatura durum/kalan hesabı).

**Akış:** panel "📄 Belgeler" → yükle (jpg/png/webp/pdf) → Vision okur → backend IBAN/VKN ile
sınıflandırır → kullanıcı önizleme ekranında düzeltir → **"Onayla ve İşle"** → `income` / `expense`
/ `invoice` / borç ödemesi kaydı. Onaysız hiçbir mutasyon yok.

**Uçlar:** `POST /api/agent/documents` (upload) · `GET /api/agent/documents[/:id]` ·
`GET /api/agent/documents/:id/file` · `POST /:id/extract` · `POST /:id/commit` · `DELETE /:id`.

**Faturalar:** `data.invoices[]` (panel-data içinde). `remaining_amount` ve `status` backend
hesaplar (`invoices.js`). Panelde "Faturalar" sekmesi.

**Company profile (Render env):**
- `MERCI_IBANS` = virgülle ayrılmış IBAN listesi (repo public — git'e YAZILMAZ)
- `MERCI_COMPANY_PROFILE` (ops.) = tam profil JSON'u, veya `data/company-profile.json`
- İsim/VKN/vergi dairesi kodda varsayılan (Ticaret Sicil kaydı).
Frontend'e hiç girmez.

**Maliyet:** belge başına 1 Vision çağrısı (Sonnet), yalnız belge + kısa talimat + minimum profil
gönderilir (panel JSON gönderilmez). Belge başına ~$0.01–0.02. `usage-log` opType `document_extract`.
