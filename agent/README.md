# Yönetim Ajanı (panel entegrasyonu)

Merci Tekstil panelindeki **"🤖 Yönetim Ajanı"** sekmesini besleyen backend parçası.

## Modüller

| Dosya | İş |
|---|---|
| `store.js` | Ajan çıktı kovası (`DATA_DIR/agent/`), panel-data okuma/**dar yazma** (yedekli), API maliyet günlüğü |
| `signals.js` | `analyze_panel.py`'nin JS portu — **domain bazlı**: `production / tasks / sales / crm / finance`. Ham panel JSON modele **asla** gitmez |
| `pricing.js` | Model seçimi (`HAIKU`, `SONNET`) + USD maliyet tahmini |
| `claude.js` | **Tek Anthropic çağrı noktası** — streaming SSE, retry, **her çağrı `usage-log.jsonl`'e** (model, token, USD, opType) |
| `generate.js` | Rapor üretici — tipe göre model + domain seçer |
| `actions.js` | Panelde **dar create/update fonksiyonları** — `safe` / `confirm` (finansal/silme/kritik) |
| `act.js` | "Ajana söyle" — Haiku aksiyonları çıkarır (structured output), backend uygular. **İkinci Claude çağrısı yok** |
| `prompts/` | `identity.md` + rapor tipi başına süreç + `act.md` |

## Model yönlendirme

| Operasyon | Model | Ayar |
|---|---|---|
| gunluk-brifing, uretim-risk, satis-takip, finans, **act** | `claude-haiku-4-5` | thinking yok |
| haftalik-review, aylik-rapor | `claude-sonnet-5` | `effort: medium` + adaptive thinking |

Her rapor yalnız ihtiyacı olan domain sinyallerini alır (ör. `uretim-risk` → sadece `production`,
~700 token). Override: `HAIKU_MODEL` / `SONNET_MODEL` env.

## Uçlar (hepsi `x-api-key` arkasında)

| Metot & yol | İş |
|---|---|
| `GET  /api/agent/outputs`, `/outputs/:id`, `/latest`, `/status` | Rapor okuma |
| `POST /api/agent/run?type=` | Rapor üretimini başlat (async) |
| `POST /api/agent/outputs` | Dışarıdan hazır markdown kaydet (`publish_output.sh`) |
| `GET  /api/agent/usage` | API maliyet özeti (bugün / 7g / 30g; model & op bazında) |
| `POST /api/agent/act` `{instruction}` | Serbest metin komut → safe aksiyonlar uygulanır, `confirm` aksiyonlar `pending` döner |
| `POST /api/agent/act/confirm` `{action}` | Onaylanan tek aksiyonu uygula (Claude çağrısı yok) |

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
# 1) Ücretsiz duman testi — API'ye HİÇ gitmez (16 kontrol: sinyal, model yönlendirme,
#    prompt kurulumu, aksiyon uygulama, usage log, act akışı)
npm run smoke -- /yol/panel-snapshot.json

# 2) Mock sunucu — tüm uçlar çalışır, sahte yanıt, $0
DATA_DIR=./data npm run mock
curl -X POST localhost:3000/api/agent/run?type=gunluk-brifing -H "x-api-key: $API_KEY"

# 3) GERÇEK çağrı — yalnız çıktı KALİTESİ kontrol edilecekse, seyrek/toplu
DATA_DIR=./data ANTHROPIC_API_KEY=sk-ant-... node agent/generate.js gunluk-brifing
```

`AGENT_MOCK=1` yalnız yerelde; Render'da asla set edilmez → canlı akış her zaman gerçek.
Bu makinede node yoksa: `export ELECTRON_RUN_AS_NODE=1; NODE="/Applications/Visual Studio Code.app/Contents/MacOS/Code"; "$NODE" test/smoke.js snapshot.json`

## Zamanlama

`.github/workflows/agent-brief.yml` — her gün 04:00 UTC (07:00 İstanbul) `gunluk-brifing`;
Pazartesi + `haftalik-review`; ayın 1'i + `aylik-rapor`.
