# Desen işçisi (G70)

Sunucu (Render) Codex'e erişemez; ChatGPT aboneliği yalnız Patron'un Mac'indeki Codex girişinde. Sunucu yeniden çizim işini sıraya koyar, Mac'teki işçi (`agent/siparis/tools/desen-isci.js`) alır, Codex + `gpt-6-astra` ile çizdirir ve PNG'leri yükler. Sunucu sadakat denetiminden geçirip önbelleğe yazar. Kimse beklemez: çizim gelene kadar eski yol (doğrudan izleme) çalışır.

## Sunucu ortamı (Render)
- `DESEN_CIZIM=1`, `DESEN_CIZIM_SAGLAYICI=isci`
- `DESEN_ISCI_ANAHTARI` (en az 16 karakter, rastgele; yalnız `/api/siparis/desen-isci/*` uçlarını açar). Yoksa uçlar 503 döner.
- İsteğe bağlı: `DESEN_ISCI_KIRALAMA_SN` (varsayılan 900).

## Mac kurulumu
1. Anahtar dosyası (depoya girmez, yalnız sahibi okur):
   ```
   mkdir -p ~/.mercitex && chmod 700 ~/.mercitex
   printf 'SIPARIS_API=https://<sunucu>/api/siparis\nDESEN_ISCI_ANAHTARI=<anahtar>\nDESEN_ISCI_GUNLUK=20\n' > ~/.mercitex/desen-isci.env
   chmod 600 ~/.mercitex/desen-isci.env
   ```
2. Denemeler (iş almaz, yalnız bakar / tek iş):
   ```
   node agent/siparis/tools/desen-isci.js --kuru
   node agent/siparis/tools/desen-isci.js --bir-kez
   ```
3. Sürekli çalışma: aşağıdaki plist'i `~/Library/LaunchAgents/com.mercitex.desen-isci.plist` olarak kaydet (yolları düzelt), sonra
   ```
   launchctl load ~/Library/LaunchAgents/com.mercitex.desen-isci.plist
   ```
   Kaldırma:
   ```
   launchctl unload ~/Library/LaunchAgents/com.mercitex.desen-isci.plist && rm ~/Library/LaunchAgents/com.mercitex.desen-isci.plist
   ```

## Örnek plist
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.mercitex.desen-isci</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/YOL/erci-materials-api/agent/siparis/tools/desen-isci.js</string>
  </array>
  <key>WorkingDirectory</key><string>/YOL/erci-materials-api</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>/tmp/desen-isci.log</string>
  <key>StandardErrorPath</key><string>/tmp/desen-isci.log</string>
</dict>
</plist>
```
Anahtar plist'e yazılmaz; `~/.mercitex/desen-isci.env` okunur. Günlük (`DESEN_ISCI_GUNLUK`) sınırı ve Codex limiti (5 saatlik >= %80 ya da haftalık >= %90 ise bekler; `~/.claude/skills/limit-dengesi/scripts/limitler.py` yoksa yalnız günlük sınır) işçinin kendi içindedir. Anahtar yanlışsa işçi durur (KeepAlive 60 sn aralıkla yeniden dener).

## Kayıt
Yalnız iş kimliği, süre, durum yazılır: `is=12 sure=157s durum=tamam`. Müşteri adı, sipariş no, fiyat işçiye hiç gitmez; Codex'e yalnız ürün görseli verilir.
