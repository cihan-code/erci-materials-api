# Sipariş çekirdeği — G1 entegrasyon sözleşmesi

CommonJS; Node >=18; `better-sqlite3` 11.x. Sunucu `DATA_DIR/siparis.sqlite` dosyasını açar. Şema WAL + foreign keys kullanır. Bütün iş mutasyonları aynı `BEGIN IMMEDIATE` işlemi içinde denetim kaydı üretir; bekleyen dış işler onay işlemiyle birlikte yazılır. Dış çağrı veritabanı işleminin dışında yapılır.

## Dışa açık işlevler

İlk argüman her zaman `db`. `user`, kullanıcı nesnesi (`{id}`) veya kullanıcı kimliğidir; yetki veritabanından okunur. HTTP isteklerindeki `userId` alanına güvenilmez.

| Modül | İmzalar |
|---|---|
| db | `openDb(file)`, `tx(db, syncFn)`, `audit(db, userId, action, ref, detail?)` |
| auth | `createUser(db, {name,password,role,onayYetkisi?})`, `login(db,{name,password})`, `authFor(db) → requireUser(role?)`, `requireUser(db, role?)` |
| orders | `createOrder(db, {order_no,job_no?,customer_name?,lines?}, user)` → sipariş + `.version` |
| orders | `addLine(db,versionId,line,user)`, `addApplication(db,lineId,application,user)`, `addFile(db,versionId,{kind,path,sha256},user)` |
| orders | `snapshot(db,versionId)`, `submitForApproval(db,versionId,user)`, `reviseVersion(db,versionId,changes,user)` → sürüm + `.lines` + `.files` |
| orders | `updateOrder(db,orderId,{job_no?,customer_name?},user)`, `cancelOrder(db,orderId,user)` |
| approval | `approveVersion(db,{versionId,userId,fileId,recipes?})` → `{approval,allocations,outbox}` |
| stock | `importLegacyFabrics(db,stokData)`, `stockSummary(db)` |
| stock | `receiveDelivery(db,{invoiceLineId,itemId,qtyMilli,allocations?:[{orderLineId,qtyMilli}],userId})` |
| stock | `adjustStock(db,{itemId,qtyMilli,businessKey,userId,note})`, `consume(db,{orderLineId,materialKey,qtyMilli,businessKey,userId})` |
| outbox | `claimNext(db,kind?)`, `markDone(db,id,providerRef,claimToken?)`, `markFailed(db,id,err,claimToken?)` |
| outbox | `retry(db,id,user)`, `setManual(db,id,user?)`, `markManualSent(db,id,user,providerRef?)` |
| outbox | `registerHandler(kind,async (payload,context)=>result)` → unregister, `runOnce(db,kind?)`, `startWorker(db,{intervalMs?,onError?}?)` → stop |
| routes | `require('./routes')(app,{dataDir,db?,worker?,recipes?})` → `{db,stop,close}` |

`line`: `{product_key,fabric_item_id?,color_name?,quantity,sizes?,lining?,material_items?,applications?}`. `sizes` beden→adet nesnesi; verilirse toplamı `quantity` ile aynı olmalıdır. `lining`: bool/0/1/`var`/`yok`. `material_items`: reçete malzeme anahtarı→stok kalemi ID nesnesi (`{kaskorse:2,astar:3}`). `sizes_json` ve `material_items_json` da kabul edilir.

`application`: `{kind:'baski'|'nakis',position,width_mm?,height_mm?,measure_source?,needs_confirmation?}`. Ölçüler mm. Satır stok ihtiyaçları tam sayı; kg stokta 1000 birim = 1 kg.

## G2–G5 bağlantıları

- **G2:** Saf eşleştirme sonucunu çağıran katman `invoice_lines` tablosuna `(source_invoice_id,source_line_id)` tekil çiftiyle kaydeder; mutasyon `tx` ve `audit` içinde olmalıdır. `delivery_status='teslim_bekliyor'`; eşleştirme stoğu artırmaz. Gerçek teslimde `receiveDelivery` çağrılır. Bu görev fatura eşleştirme bağdaştırıcısı kurmaz.
- **G3:** PDF dosyalarını sürüme özel, değişmez dosya adlarıyla üretip `addFile` ile kaydedin. Aynı sürüm/türde yalnız bir dosya vardır (kuyruk anahtarı tür başınadır). Revizyonda PDF kopyalanmaz; yeni sürüm için tekrar üretilir. HTTP dosya kaydı yalnız `DATA_DIR/siparis/files/` içindeki gerçek dosyaları kabul eder ve SHA256'yı kendisi hesaplar. İç modül çağrısı dosya/özet doğrulamasını üreticiye bırakır.
- **G4:** `registerHandler('atolye_dosya', handler)`. Payload `{versionId,orderNo,versionNo,file:{id,version_id,kind,path,sha256,created_at}}`. İşleyici dosyanın SHA256'sını gönderim öncesi doğrulamalıdır. `OTOMATIK_GONDERIM !== '1'` iken işleyici çağrılmaz; iş `manuel_bekliyor` olur.
- **G5:** `registerHandler('maliyet_aktarim', handler)`. Payload `{versionId,orderNo,versionNo}`; `context.db` ile onaylı sürüm okunabilir. Eksik fiyat sonucu `{status:'fiyat_bekliyor'}` olmalıdır.
- **İki bağdaştırıcı için:** `context={idempotencyKey,job,db}`; sağlayıcıda aynı `idempotencyKey` kullanılmalıdır. Başarı `{providerRef}` döndürür; hata throw edilir. Sağlayıcı idempotensi olmadan ağ hatası sonrası tam bir kez gönderim garantisi verilemez. Beş hata sonrası teyit açılır. Süresi geçmiş `isleniyor` işi otomatik yeniden gönderilmez, sonucu teyit etmek için `basarisiz` olur. İşleyici sürerken yaşam sinyali yenilenir.
- G4/G5 bağdaştırıcıları kendi modüllerini kaydetmelidir; bu çekirdekte gerçek sağlayıcı veya maliyet aktarımı yoktur.

## Stok ve revizyon

`stockSummary`: her kalemde `total_milli`, `reserved_milli`, `available_milli`, `shortage_milli`, `awaiting_delivery_milli`. Toplam fiziksel giriş/çıkış/düzeltme defterinden, ayrılan ve eksik tahsislerden, teslim bekleyen eşlenmiş ve henüz teslim alınmamış fatura satırlarından hesaplanır. Eksik ihtiyaç ile yoldaki teslimat ayrı değerlerdir; eşlenmemiş fatura hiçbir kaleme tahminen eklenmez.

`reviseVersion` içinde `changes.lines` verilirse **yeni sürümün tam satır listesi** olur; mevcut satırlarda `id` veya `line_key` ile kaynak belirtilir, değişmeyen alanlar kopyalanır. Liste dışındaki satırlar kaldırılır. Kaynaksız satırlar yeni satırdır. `changes.lines` verilmezse bütün satırlar/uygulamalar kopyalanır. Yeni sürüm `onay_bekliyor`, eski sürüm `eski` olur. Revizyon başlarken eski atölye işleri iptal edilir. İşlenmekte olan gönderim varsa revizyon 409 verir; dış çağrı bitmeden yeni sürüme geçilmez.

Onay, son onaylı sürümle sabit `line_key` üzerinden karşılaştırır. Ayrılanlar yeni tahsis satırına taşınır; yalnız fazlalık için `tahsis_iade`, artış için `tahsis` yazılır. Tüketilen miktar yeni ihtiyaca sayılır; önceki sürümde tarihsel tüketim kaydı korunur. Tarihsel tahsislerde reserved/shortage sıfırlanır. Tüketilmiş malzeme silinemez veya tüketimden küçük ihtiyaca indirilemez.

## Açık kararlar / sözleşme önerileri

1. Ortak şemada satır başına tek kumaş var; ek reçete malzemeleri hangi stok kalemine bağlanacak? Öneri: eklenen `material_items_json` eşlemesini onaylamak. Ana `kumas`, `fabric_item_id` kullanır; diğer malzemeler eşlenmemişse `item_id=NULL`, tamamı shortage ve `eksik_alan` teyidi olur. Eşleme revizyonla yapılabilir.
2. `g_per_unit:null` malzemeler için miktar ve kullanım nasıl onaylanacak? Çekirdek miktar uydurmaz: teyit açar, o malzeme için miktarlı tahsis oluşturmaz. Gerekirse onayı tamamen engelleme politikası ayrıca belirlenmeli.
3. Kısmi/çoklu teslimat gerekiyor mu? `giris:<invoiceLineId>` anahtarı yalnız tek teslimata izin veriyor. Şimdilik miktar fatura satırına eşit olmalı; farklı miktar reddedilir. Çoklu teslimat için teslimat kimliği ve ayrı receipts tablosu gerekir.
4. Eski stokta hangi hareket türleri ve birim yazımları var? Import `acilis/giris/cikis/duzeltme` ve `kg/m/adet` kabul eder; başka değerleri tahmin etmez, işlemi geri alır. `fabric_key='legacy:<id>'`; anlamsal anahtara geçiş için G2 ile eşleme gerekir.
5. `Atölyede eski sürüm` teyidinin ortak listede özel türü yok; mevcut `eksik_alan` kullanılıyor. Ayrı `eski_surum` kararlaştırılabilir.
6. Onaylanmış siparişin tamamen iptali ve tüketilmiş stok iadesi politikası belirtilmedi; DELETE yalnız hiç onaylanmamış siparişleri `iptal` yapar. Onaylı iptal 409 verir.
7. G3'ün dört dosya türünün sabit adları belirtilmedi. Çekirdek tür adlarını değiştirmez; dosya başına kayıt ve sürüme ait bir `approved_file_id` ister, dört türün varlığını tahmin ederek zorunlu kılmaz.

## HTTP

Tüm yollar `/api/siparis` altında. Yalnız `POST /giris` açıktır (`{ad,sifre}` veya `{name,password}`); cevap `{token,expiresAt,user}`. Diğer yollar `Authorization: Bearer <token>` ister, eski `x-api-key` kabul edilmez. CORS ana uygulamadaki `CORS_ORIGIN` değerinden gelir.

- `GET/POST /siparisler`, `GET/PATCH/DELETE /siparisler/:id`
- `GET /surumler/:id`, `POST /surumler/:id/satirlar`, `POST /satirlar/:id/uygulamalar`
- `POST /surumler/:id/dosyalar`, `/gonder`, `/onay` (`{fileId}`), `/revizyon`
- `GET /stok`, `/stok/hareketler?itemId=...`; `POST /stok/teslim`, `/stok/duzelt`, `/stok/cikis`
- `GET /teyitler?status=acik`, `POST /teyitler/:id/coz`
- `GET /outbox`; `POST /outbox/:id/tekrar`, `/manuel`, `/elle-gonderildi`

Onay, düzeltme, tekrar gönderim ve elle gönderildi işareti: `yonetici` veya `onay_yetkisi=1`. Kullanıcı ekleme:

```sh
# Şifreyi stdin'den verin veya SIPARIS_SIFRE ortam değişkenini ayarlayın.
node agent/siparis/cli.js kullanici-ekle 'Örnek Kullanıcı' ekip --onay
```

## Doğrulama

```sh
node --test test/siparis-cekirdek.test.js
npm run operations
TASK_SMOKE_DIR=$(mktemp -d /tmp/siparis-smoke.XXXXXX)
DATA_DIR="$TASK_SMOKE_DIR" npm run smoke -- test/fixtures/siparis/smoke-panel.json
```

Smoke mevcut haliyle bir panel snapshot'ı gerektirir; sağlanan fixture tamamen uydurmadır. Gerçek `data/` veya `.env` kullanılmaz. Yerel HTTP testleri için loopback port açma izni gerekir.

Çalışma zamanı notu: Bu makinedeki Node 24.21.0 + better-sqlite3 11.10.0, Worker Thread denemesinde native cleanup assertion üretti. Sunucu tek iş parçacığında setInterval kullanır; eşzamanlılık testi iki ayrı Node sürecinde iki bağlantıyla yapılır. Bu sürüm kombinasyonunda veritabanını Worker Thread içine taşımayın; Node 18 uyumluluğunu kaldırmadan 12+ sürümüne geçilmedi.
