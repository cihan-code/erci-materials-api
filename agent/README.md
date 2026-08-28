# Yönetim Ajanı (panel entegrasyonu)

Merci Tekstil panelindeki **"🤖 Yönetim Ajanı"** sekmesini besleyen backend parçası.

## Ne yapar

1. `store.loadPanelData()` — `DATA_DIR/panel-data.json`'u **diskten, salt-okunur** okur.
2. `signals.buildSignals()` — `analyze_panel.py`'nin JS portu; ham JSON yerine kompakt bir
   "yönetim sinyalleri" metni üretir (gecikmeler, kaporasız işler, geciken görev/takip, nakit,
   hedefler).
3. `generate.js` — sinyalleri + ajan kimliği + skill sürecini Claude API'ye (`claude-sonnet-5`)
   gönderir, dönen markdown'ı `store.saveAgentOutput()` ile kaydeder.
4. `server.js` içindeki `/api/agent/*` uçları paneldeki sekmeye veri verir.

Ajan **yalnızca** `DATA_DIR/agent/` altına yazar. `/api/paneldata` onun için salt-okunur.

## Kurulum

| Yer | Ayar |
|-----|------|
| Render → `erci-materials-api` → Environment | `ANTHROPIC_API_KEY` = `sk-ant-...` |
| Render (zaten var) | `DATA_DIR=/data`, `API_KEY=...`, `CORS_ORIGIN=https://cihan-code.github.io` |
| GitHub → repo → Settings → Secrets → Actions | `MERCI_API_KEY` = panelin `x-api-key`'i |

`ANTHROPIC_API_KEY` alma: https://console.anthropic.com → Billing (ödeme yöntemi + birkaç $ kredi) →
API keys → Create Key. Anahtar **yalnızca** Render ortam değişkeni; panel `index.html`'e veya git'e
asla girmez.

## Elle çalıştırma / test

```bash
# yerel
DATA_DIR=./data ANTHROPIC_API_KEY=sk-ant-... node agent/generate.js gunluk-brifing
DATA_DIR=./data node server.js
curl "localhost:3000/api/agent/latest?type=gunluk-brifing" -H "x-api-key: $API_KEY"

# canlı
curl -X POST "https://erci-materials-api.onrender.com/api/agent/run?type=gunluk-brifing" \
  -H "x-api-key: $MERCI_API_KEY"
```

## Zamanlama

`.github/workflows/agent-brief.yml` — her gün 04:00 UTC (07:00 İstanbul) `gunluk-brifing`;
Pazartesi ayrıca `haftalik-review`; ayın 1'i ayrıca `aylik-rapor`. Elle:
Actions → "Yonetim Ajani brifing" → Run workflow → tip seç.

## Çıktı tipleri

`gunluk-brifing`, `uretim-risk`, `satis-takip`, `finans`, `haftalik-review`, `aylik-rapor`
