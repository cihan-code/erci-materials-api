# Sipariş çekirdeği — G1 entegrasyon sözleşmesi

CommonJS; Node >=20; `better-sqlite3` 12.x. Sunucu `DATA_DIR/siparis.sqlite` dosyasını açar. Şema WAL + foreign keys kullanır. `openDb` eski bir veritabanını bir kez ve idempotent biçimde günceller: `files` tablosundaki `UNIQUE(version_id,kind)` kaldırılır, `confirmations.kind` listesine `eski_surum` eklenir, `invoice_lines` ve `stock_items` tablolarına yeni sütunlar eklenir. Modül açılamazsa (`better-sqlite3` ya da veritabanı) `server.js` hatayı loglar, panelin geri kalanı çalışmaya devam eder ve `/api/siparis/*` uçları 503 döner. Bütün iş mutasyonları aynı `BEGIN IMMEDIATE` işlemi içinde denetim kaydı üretir; bekleyen dış işler onay işlemiyle birlikte yazılır. Dış çağrı veritabanı işleminin dışında yapılır.

## Dışa açık işlevler

İlk argüman her zaman `db`. `user`, kullanıcı nesnesi (`{id}`) veya kullanıcı kimliğidir; yetki veritabanından okunur. HTTP isteklerindeki `userId` alanına güvenilmez.

| Modül | İmzalar |
|---|---|
| db | `openDb(file)`, `tx(db, syncFn)`, `audit(db, userId, action, ref, detail?)` |
| auth | `createUser(db, {name,password,role,onayYetkisi?=true})`, `login(db,{name,password})`, `authFor(db) → requireUser(role?)`, `requireUser(db, role?)` |
| orders | `createOrder(db, {order_no,job_no?,customer_name?,lines?}, user)` → sipariş + `.version` |
| orders | `addLine(db,versionId,line,user)`, `addApplication(db,lineId,application,user)`, `addFile(db,versionId,{kind,path,sha256},user)` |
| orders | `snapshot(db,versionId)`, `submitForApproval(db,versionId,user)`, `reviseVersion(db,versionId,changes,user)` → sürüm + `.lines` + `.files` |
| orders | `updateOrder(db,orderId,{job_no?,customer_name?},user)`, `cancelOrder(db,orderId,user)` |
| approval | `approveVersion(db,{versionId,userId,fileId,recipes?})` → `{approval,allocations,outbox}` |
| stock | `importLegacyFabrics(db,stokData)` (yalnız kalemler), `stockSummary(db)`, `stockView(db)` (+ `*_kg`), `recordCount(db,{itemId,countedMilli,countKey,userId,note?})` |
| stock | `createStockItem(db,{tur,renk,ad?,unit,colorNo?,colorHex?},userId)`, `updateStockItem(db,id,{ad?,colorNo?,colorHex?},userId)`, `fillShortages(db,itemId,{keyPrefix,...})` |
| stock | `receiveDelivery(db,{invoiceLineId,itemId,qtyMilli,allocations?:[{orderLineId,qtyMilli}],userId})` |
| stock | `adjustStock(db,{itemId,qtyMilli,businessKey,userId,note})`, `consume(db,{orderLineId,materialKey,qtyMilli,businessKey,userId})` |
| outbox | `claimNext(db,kind?)`, `markDone(db,id,providerRef,claimToken?)`, `markFailed(db,id,err,claimToken?)` |
| outbox | `retry(db,id,user)`, `setManual(db,id,user?)`, `markManualSent(db,id,user,providerRef?)` |
| outbox | `registerHandler(kind,async (payload,context)=>result)` → unregister, `runOnce(db,kind?,{onError?,heartbeatMs?}?)`, `startWorker(db,{intervalMs?,onError?}?)` → stop |
| invoices | `ingest(db,{source,lines},{userId?})` → satır sonuçları, `deliver(db,id,{itemId?,allocations?},userId)`, `list(db,{durum?})` |
| routes | `require('./routes')(app,{dataDir,db?,worker?,recipes?})` → `{db,stop,close}` |

`line`: `{product_key,fabric_item_id?,color_name?,quantity,sizes?,lining?,material_items?,applications?}`. `sizes` beden→adet nesnesi; verilirse toplamı `quantity` ile aynı olmalıdır. `lining`: bool/0/1/`var`/`yok`. `material_items`: reçete malzeme anahtarı→stok kalemi ID nesnesi (`{kaskorse:2,astar:3}`). `sizes_json` ve `material_items_json` da kabul edilir.

`application`: `{kind:'baski'|'nakis',position,width_mm?,height_mm?,measure_source?,needs_confirmation?}`. Ölçüler mm. Satır stok ihtiyaçları tam sayı; kg stokta 1000 birim = 1 kg.

## G2–G5 bağlantıları

- **G2 (fatura):** `invoices.js` Finans Ajanı satırlarını alır, `matching.matchInvoiceLine` ile eşleştirir; ayrıntı aşağıda "Fatura satırları" bölümünde.
- **G3:** PDF dosyalarını sürüme özel, değişmez dosya adlarıyla üretip `addFile` ile kaydedin. Aynı sürümde bir türden birden çok dosya olabilir (her uygulama için bir `desen_vektor`, iki `urun_gorsel`); kuyruk anahtarı dosya başınadır. Revizyonda PDF kopyalanmaz; yeni sürüm için tekrar üretilir. HTTP dosya kaydı yalnız `DATA_DIR/siparis/files/` içindeki gerçek dosyaları kabul eder ve SHA256'yı kendisi hesaplar. İç modül çağrısı dosya/özet doğrulamasını üreticiye bırakır.
- **G4:** `registerHandler('atolye_dosya', handler)`. Atölyeye yalnız `baski_formu`, `nakis_formu` ve `desen_vektor` gider; anahtar `atolye:<versionId>:<fileId>`. Onay dosyası (`fileId`) o sürümün `onay_formu` dosyası olmalıdır, değilse 400. Payload `{versionId,orderNo,versionNo,file:{id,version_id,kind,path,sha256,created_at}}`. İşleyici dosyanın SHA256'sını gönderim öncesi doğrulamalıdır. `OTOMATIK_GONDERIM !== '1'` iken işleyici çağrılmaz; iş `manuel_bekliyor` olur.
- **G5:** `registerHandler('maliyet_aktarim', handler)`. Payload `{versionId,orderNo,versionNo}`; `context.db` ile onaylı sürüm okunabilir. Eksik fiyat sonucu `{status:'fiyat_bekliyor'}` olmalıdır.
- **İki bağdaştırıcı için:** `context={idempotencyKey,job,db}`; sağlayıcıda aynı `idempotencyKey` kullanılmalıdır. İş yalnız `{providerRef}` (ya da `{status:'tamam',providerRef}`) dönerse `tamam` olur; nesne referans JSON olarak saklanır. `{status:'fiyat_bekliyor'}` ve `{status:'manuel_bekliyor'}` işi o durumda bırakır: `fiyat_bekliyor` `retry` ile yeniden kuyruğa girer, `manuel_bekliyor` `markManualSent` ile kapanır. Bunların dışında bir dönüş sonucu belirsiz sayılır; iş `basarisiz` olur ve `baglanti_hatasi` teyidi açılır, kendiliğinden yeniden gönderilmez. Hata throw edilir. `err.permanent=true` olan hata yeniden denenmez: iş hemen `basarisiz` olur ve hata mesajıyla `eksik_alan` teyidi açılır. Diğer hatalarda bekleme 1 dk, 5 dk, 15 dk, 1 sa; beşinci hatada iş `basarisiz` olur ve `baglanti_hatasi` teyidi açılır. Kayıtlı işleyicisi olmayan tür hiç alınmaz, `bekliyor`da kalır. Sağlayıcı idempotensi olmadan ağ hatası sonrası tam bir kez gönderim garantisi verilemez. Süresi geçmiş `isleniyor` işi otomatik yeniden gönderilmez, sonucu teyit etmek için `basarisiz` olur. İşleyici sürerken yaşam sinyali yenilenir; yaşam sinyali hatası (ör. uzun kilit) süreci düşürmez, `onError`'a iletilir.
- **G13b — park sözleşmesi:** Bağdaştırıcının `{status:'fiyat_bekliyor'|'manuel_bekliyor', providerRef?, stillWaiting?}` sonucundaki `stillWaiting(db)` isteğe bağlı, eşzamanlı bir fonksiyondur. `outbox.js` içindeki `runOnce`, park dalında aynı veritabanı işlemi içinde bu fonksiyonu çağırır. Yalnız `false` dönerse iş hemen `bekliyor` durumuna alınır; fonksiyon yoksa veya başka değer dönerse park durumunda kalır. Böylece bağdaştırıcı çalışırken girilen fiyat gibi beklemeyi kaldıran bir değişiklik kaybolmaz.
- G4/G5 bağdaştırıcıları kendi modüllerini kaydetmelidir; bu çekirdekte gerçek sağlayıcı veya maliyet aktarımı yoktur.

## Stok ve revizyon

`stockSummary`: her kalemde `total_milli`, `reserved_milli`, `available_milli`, `shortage_milli`, `awaiting_delivery_milli`. Toplam fiziksel giriş/çıkış/düzeltme defterinden, ayrılan ve eksik tahsislerden, teslim bekleyen eşlenmiş ve henüz teslim alınmamış fatura satırlarından hesaplanır. Eksik ihtiyaç ile yoldaki teslimat ayrı değerlerdir; eşlenmemiş fatura hiçbir kaleme tahminen eklenmez. `GET /stok` aynı satırlara yalnız gösterim için `*_kg` alanlarını ekler (kg dışı kalemde `null`).

**Açılış ve sayım:** `importLegacyFabrics` yalnız kalemleri aktarır, hareket yazmaz. Fiziksel stok `recordCount` ile girilir: kalemin hiç hareketi yoksa `acilis`, varsa fark kadar `duzeltme` yazılır, fark 0 ise yalnız audit düşer. Anahtar `sayim:<countKey>:<itemId>`; aynı yük idempotent, farklı yük 409. Sayım ayrılmış miktarın altına inemez (409).

**Serbest kalan stok (FIFO):** Kullanılabilir stok arttığında aynı işlemde o kalemin açık eksikleri onay sırasıyla kapatılır: revizyonla serbest kalan miktar (`tahsis_iade`), artı yönlü `duzeltme`, sayım artışı ve teslimat. Açık dağıtımlı teslimatta önce verilen hedefler doldurulur, artan miktar aynı FIFO kuralıyla diğer açık eksikleri (hedeflerin kalan eksiği dahil) kapatır; ancak geri kalanı kullanılabilir olur. Revizyonun kendi yeni ihtiyacı, onayı en son olduğu için sıranın sonundadır.

**İdempotentlik:** `consume`, `adjustStock`, `receiveDelivery` ve `recordCount` aynı anahtarla farklı yük gelirse 409 verir; aynı yükte ilk sonucu döndürür. Yükün parçaları şunlardır:
- `consume`: satır, malzeme (tahsis kimliği, `stock_movements.allocation_id`), kalem ve miktar. Aynı satırın kumaşı ve astarı aynı kalemde olsa da ayrı sayılır.
- `receiveDelivery`: kalem, miktar ve ilk teslimde istenen dağıtım (`invoice_lines.delivery_request_json`; FIFO ya da sıralanmış açık liste). Gövdesiz tekrar ilk dağıtımı tekrarlar.

Onaylı sürümün revizyonu onay yetkisi ister; taslak ve `onay_bekliyor` sürümü her kullanıcı revize edebilir. Revizyon, eski sürümlerin `bekliyor`, `fiyat_bekliyor` ve `manuel_bekliyor` durumundaki `maliyet_aktarim` işlerini `iptal` eder; tamamlanmış işler değişmez. Atölyede kalmış eski sürüm `eski_surum` teyidi açar.

`reviseVersion` içinde `changes.lines` verilirse **yeni sürümün tam satır listesi** olur; mevcut satırlarda `id` veya `line_key` ile kaynak belirtilir, değişmeyen alanlar kopyalanır. Liste dışındaki satırlar kaldırılır. Kaynaksız satırlar yeni satırdır. `changes.lines` verilmezse bütün satırlar/uygulamalar kopyalanır. Yeni sürüm `onay_bekliyor`, eski sürüm `eski` olur. Revizyon başlarken eski atölye işleri iptal edilir. İşlenmekte olan gönderim varsa revizyon 409 verir; dış çağrı bitmeden yeni sürüme geçilmez.

Onay, son onaylı sürümle sabit `line_key` üzerinden karşılaştırır. Ayrılanlar yeni tahsis satırına taşınır; yalnız fazlalık için `tahsis_iade`, artış için `tahsis` yazılır. Tüketilen miktar yeni ihtiyaca sayılır; önceki sürümde tarihsel tüketim kaydı korunur. Tarihsel tahsislerde reserved/shortage sıfırlanır. Tüketilmiş malzeme silinemez veya tüketimden küçük ihtiyaca indirilemez.

## Açık kararlar / sözleşme önerileri

1. Ortak şemada satır başına tek kumaş var; ek reçete malzemeleri hangi stok kalemine bağlanacak? Öneri: eklenen `material_items_json` eşlemesini onaylamak. Ana `kumas`, `fabric_item_id` kullanır; diğer malzemeler eşlenmemişse `item_id=NULL`, tamamı shortage ve `eksik_alan` teyidi olur. Eşleme revizyonla yapılabilir.
2. `g_per_unit:null` malzemeler için miktar ve kullanım nasıl onaylanacak? Çekirdek miktar uydurmaz: teyit açar, o malzeme için miktarlı tahsis oluşturmaz. Gerekirse onayı tamamen engelleme politikası ayrıca belirlenmeli.
3. Kısmi/çoklu teslimat gerekiyor mu? `giris:<invoiceLineId>` anahtarı yalnız tek teslimata izin veriyor. Şimdilik miktar fatura satırına eşit olmalı; farklı miktar reddedilir. Çoklu teslimat için teslimat kimliği ve ayrı receipts tablosu gerekir.
4. Eski stokta hangi hareket türleri ve birim yazımları var? Import `acilis/giris/cikis/duzeltme` ve `kg/m/adet` kabul eder; başka değerleri tahmin etmez, işlemi geri alır. `fabric_key='legacy:<id>'`; anlamsal anahtara geçiş için G2 ile eşleme gerekir.
5. `Atölyede eski sürüm` teyidi `eski_surum` türünü kullanır (karar verildi).
6. Onaylanmış siparişin tamamen iptali ve tüketilmiş stok iadesi politikası belirtilmedi; DELETE yalnız hiç onaylanmamış siparişleri `iptal` yapar. Onaylı iptal 409 verir.
7. Dosya türleri ortak sözleşmede sabit (`urun_gorsel`, `desen_kaynak`, `onay_formu`, `uretim_formu`, `baski_formu`, `nakis_formu`, `desen_vektor`). Onay kaydı her zaman sürümün `onay_formu` dosyasını gösterir.

## Fatura satırları

- **Giriş:** `POST /api/siparis/fatura-satirlari`, gövde Finans Ajanı `uretim-aktar` biçimi: `{source, lines:[{sourceInvoiceId, sourceLineId, invoiceNo, invoiceDate, supplier, supplierVkn, description, quantity, unit, unitPrice, purchaseRef, deliveryConfirmed}]}` (en çok 500 satır). Kimlik `Authorization: Bearer <SIPARIS_SERVIS_ANAHTARI>` (sabit sürede karşılaştırma) ya da kullanıcı token'ı. Servis anahtarı denetimi `auth.serviceKeyMatches` / `auth.serviceOrUser` ortak yardımcısındadır (fatura girişi ve `panel-veri` aynı kuralı kullanır). Değişken boşsa ya da 16 karakterden kısaysa servis anahtarı kabul edilmez.
- **Yanıt:** `{results:[{id, sourceInvoiceId, sourceLineId, status: yeni|ayni|guncellendi|reddedildi, matchStatus, deliveryStatus, reasons}]}`. Finans Ajanı 2xx alan partiyi gönderilmiş sayar; bu yüzden saklanamayan satır (kimlik, miktar ya da birim okunamadı) `reddedildi` olur ve `audit_log`'a bağlı açık bir `fatura_eslesme` teyidiyle görünür kalır. Beklenmeyen hata partinin tamamını 500 yapar; satırlar tekil olduğundan yeniden gönderim güvenlidir.
- **Birim:** `kg/kgm/kilo`, `g/gr` (kg'a çevrilir), `m/mt/mtr/metre`, `adet/c62/nar`. Birim boşsa açıklamadaki birim yalnız oradaki miktar satır miktarıyla birebir aynıysa kabul edilir.
- **Tekillik ve değişiklik:** `(source_invoice_id, source_line_id)`. İçerik özeti (açıklama, miktar, birim, `purchaseRef`; fiyat dahil değil) aynıysa `ayni`. Bu durumda tek istisna teslimdir: satır `teslim_bekliyor` ve `eslesti` iken `deliveryConfirmed:true` gelirse teslim aynı işlemde eşleşmedeki öneriyle işlenir. Öneri eskidiyse ya da satır `teyit`teyse stoğa yazılmaz, `fatura_eslesme` teyidi açılır. Değiştiyse teslim alınmamış satır güncellenir, eski fatura teyitleri kapanır ve yeniden eşleştirilir (`guncellendi`); teslim alınmış satır değişmez, `fatura_eslesme` teyidi açılır (`reddedildi`).
- **Eşleştirme:** `openNeeds` onaylı sürümlerde `shortage_milli>0` olan tahsislerdir. Bağlı kalemin anlamlı `fabric_key`'i ihtiyacın kumaşıdır. Kalemi bağlı olmayan ya da `legacy:` kaleme bağlı ana kumaş ürün varsayılanı ve sipariş rengiyle aday olur, diğer malzemeler kendi türüyle. Böyle bir ihtiyaca giden öneri bağlanmaz, `teyit` olur: rezervasyon için ihtiyacın tahsisi önerilen kalemde olmalıdır. Kalem birimi fatura birimiyle aynı olmalıdır.
- **`eslesti`:** Kalem `fabric_key` ile bulunur ya da oluşturulur. `item_id`, `fabric_key` ve önerilen dağıtım (`allocation_json`) yazılır, satır `teslim_bekliyor` kalır, stok artmaz (`awaiting_delivery_milli`'de görünür). `deliveryConfirmed=true` ise aynı işlemde `receive` çağrılır.
- **`teyit`:** `item_id` boş kalır, stoğa yazılmaz; gerekçeler `fatura_eslesme` teyidine yazılır.
- **Teslim:** `POST /fatura-satirlari/:id/teslim`. Gövde boşsa öneri kullanılır; öneri eskidiyse (ihtiyaç küçüldü ya da kalem değişti) 409 döner ve dağıtım elle verilir. Ekip teyitteki satır için `itemId` ve `allocations` verebilir. Teslimden sonra satırın teyitleri `cozuldu` olur. Aynı satır ikinci kez teslim alınmaz.
- **Listeleme:** `GET /fatura-satirlari?durum=...` satırları, `reasons`, `allocations` (sipariş numarasıyla), `orders` ve açık teyitlerle döndürür (en yeni 500).

**Sözlük (`matching.js`):**
- **Örme kumaş türü** taban, iplik numarası ve esneklikten kurulur:
  - Taban `süprem`, `ribana` ya da `interlok` olur; anahtar sırası taban, `_NN_1`, sonra `_likrali`. Örnekler: `supren_30_1`, `supren_24_1`, `ribana_30_1_likrali`.
  - İplik numarası `30/1` ya da `30 1` biçiminde yazılır. Süpremde zorunludur, numarasız süprem `teyit`tir. Ribana ve interlokta numara yazılmışsa anahtara girer, yazılmamışsa girmez. Farklı numaralar ayrı kalemdir: `supren_24_1`, `supren_30_1` ihtiyacını karşılamaz.
  - `likralı`, `likra` ve `elastan` esneklik niteliğidir.
  - `penye` ve `örme` yalnız niteleyicidir: örme bir tabanla gelirse okunur, tek başına `penye` `teyit`tir. Bitişik "SÜPREMÖRME" yazımı da tanınır.
- **Diğer türler** sabit adla tanınır: `sardonlu_3_iplik`, `sardonsuz_3_iplik`, `lakost`, `kaskorse`, `astar`, `polar`, `pike_rasel` ("pike raşel" ya da "raşel pike"). Pike raşel lakosttan ayrı bir kalemdir. Tek başına "pike" ya da "raşel" `teyit` olur.
- **İçerik bilgisi** gürültüdür; yalnız yüzdeli yazım bu kapsama girer ("%100 pamuk", "%95 pamuk %5 elastan"). İçerikte elastan varsa örme kumaş likralı sayılır. "%100 pamuk" ile "likralı" birlikte yazılırsa çelişki sayılır ve satır `teyit` olur. Örme olmayan bir kumaşın içeriğinde elastan varsa satır yine `teyit` olur. Yüzdesiz lif sözcüğü ("pamuklu") tanınmayan sözcüktür.
- **Renkler:**
  - siyah, beyaz, kırık beyaz, ekru, lacivert, bordo, pembe;
  - gri melanj (bitişik "grimelanj" de), gri, açık gri, koyu gri, antrasit, füme, taş, vizon;
  - kırmızı, kiremit, mürdüm, mor, lila;
  - saks mavi, bebe mavi, açık mavi, mavi, indigo, nefti ("nefti yeşil" de), yeşil, haki;
  - sarı, hardal, turuncu, kahverengi, bej.
- **Tekrar eden renk:** Stok aktarımı `ad + ' ' + renk` okur. Aynı rengin iki kez geçmesi çelişki değildir; iki farklı renk geçmesi (ör. "Pike Raşel Lacivert" + "İndigo") `teyit` olur.
- **Renk tonu:** Sözlükte olmayan bir ton sözcüğü (`açık`, `koyu`, `neon`, `pastel`, `melanj`, `tonu`) rengi açık bırakır; örneğin "koyu lacivert" `teyit` olur.

**Tanınmayan sözcük:** Tür ve renk bulunsa bile açıklamada sözlükte olmayan bir sözcük varsa satır `teyit` olur; örneğin "Lakost petrol mavi" `lakost|mavi` sayılmaz. Kişinin açıkça verdiği tür ve renk bu kuralın önüne geçer.
- **İzinli tedarikçi gürültüsü** (`FILLER`): `kumaş`, `kumaşı`, `örme`, `renk`, `rengi`, `top`, `rulo`, `ve`, `ile`, `x`, `adet`, `ad`, `en`, `boy`, `g`, `gr`, `gram`, `gramaj`, `gsm`, `gr/m`, `g/m`, `kg`, `kilo`, `m`, `mt`, `metre`, `cm`, `mm`.
- **Sayılar ve ölçüler** ("180 cm", "250 gr/m2") okunmaz. "gramaj 300 gr" miktar sayılmaz.

**`fabric_key` sözleşmesi:** Anlamlı anahtar `"<tür>|<renk>"` biçimindedir ve yalnız `matching.fabricKey()` ile üretilir (ASCII, alt çizgili: `sardonlu_3_iplik|gri_melanj`). Eski kumaşlar `parseInvoiceDescription(ad + ' ' + renk)` ile okunur. Tür ve renk net, okunmayan sözcük yoksa anlamlı anahtar alır. Okunamazsa `legacy:<id>` kalır ve `eksik_alan` teyidi açılır. Aynı anahtara iki eski kumaş (ya da var olan bir kalem) çıkarsa ikisi de `legacy` kalır.

**Ortam değişkenleri:** `SIPARIS_SERVIS_ANAHTARI` (Finans Ajanı ve Ajan Paneli servis anahtarı, en az 16 karakter), `OTOMATIK_GONDERIM=1` (atölye gönderimi), `DATA_DIR`.

## HTTP

Tüm yollar `/api/siparis` altında. Yalnız `POST /giris` açıktır (`{ad,sifre}` veya `{name,password}`); cevap `{token,expiresAt,user}`. Diğer yollar `Authorization: Bearer <token>` ister, eski `x-api-key` kabul edilmez. CORS ana uygulamadaki `CORS_ORIGIN` değerinden gelir.

- `GET/POST /siparisler`, `GET/PATCH/DELETE /siparisler/:id`
- `GET /surumler/:id`, `POST /surumler/:id/satirlar`, `POST /satirlar/:id/uygulamalar`
- `POST /surumler/:id/dosyalar`, `/gonder`, `/onay` (`{fileId}`), `/revizyon`
- `GET /stok`, `/stok/hareketler?itemId=...`; `POST /stok/teslim`, `/stok/duzelt`, `/stok/cikis`, `/stok/sayim` (`{itemId,countedKg|countedMilli,countKey,note?}`)
- `POST /stok/kalemler` (`{tur,renk,ad?,unit,colorNo?,colorHex?}`; aynı anahtar varsa 409 ve `{item}`), `PATCH /stok/kalemler/:id` (yalnız `ad`, `colorNo`, `colorHex`)
- `POST /fatura-satirlari` (servis anahtarı ya da kullanıcı), `GET /fatura-satirlari?durum=eslesti|teyit|eslesmedi|teslim_bekliyor|teslim_alindi`, `POST /fatura-satirlari/:id/teslim` (`{itemId?,allocations?}`)
- `GET /teyitler?status=acik`, `POST /teyitler/:id/coz`
- `GET /outbox`; `POST /outbox/:id/tekrar`, `/manuel`, `/elle-gonderildi`

Onay, düzeltme, sayım, tekrar gönderim, elle gönderildi işareti ve onaylı sürüm revizyonu: `yonetici` veya `onay_yetkisi=1`. Patron kararıyla yeni kullanıcılar varsayılan olarak `onay_yetkisi=1` alır, yani giriş yapan herkes bu işlemleri yapabilir; kim yaptığı audit kaydında kalır. Kısıtlamak için kullanıcıyı `--onaysiz` ile ekleyin ya da `onay_yetkisi`ni 0 yapın. Kullanıcı ekleme:

```sh
# Şifreyi stdin'den verin veya SIPARIS_SIFRE ortam değişkenini ayarlayın.
node agent/siparis/cli.js kullanici-ekle 'Örnek Kullanıcı' ekip            # onay yetkili (varsayılan)
node agent/siparis/cli.js kullanici-ekle 'Örnek Stajyer' ekip --onaysiz    # kısıtlı
node agent/siparis/cli.js kullanici-listele                               # ad, rol, onay yetkisi, tarih
node agent/siparis/cli.js sifre-degistir 'Örnek Kullanıcı'                # yeni şifre; açık oturumlar kapanır
node agent/siparis/cli.js kullanici-onaysiz 'Örnek Kullanıcı'             # onay yetkisini kapat (audit'li)
node agent/siparis/cli.js kullanici-onayli 'Örnek Kullanıcı'              # onay yetkisini aç
# DATA_DIR/stok-data.json içindeki eski kumaş kalemlerini aktarır (açılış bakiyesi aktarılmaz; sayım ayrıca girilir).
node agent/siparis/cli.js eski-kumaslari-aktar --kuru                     # önce dene: hiçbir şey yazmaz, özeti verir
node agent/siparis/cli.js eski-kumaslari-aktar                            # ikinci çalıştırma yeni kalem eklemez
```

## Doğrulama

```sh
node --test test/siparis-*.test.js
npm run operations
TASK_SMOKE_DIR=$(mktemp -d /tmp/siparis-smoke.XXXXXX)
DATA_DIR="$TASK_SMOKE_DIR" npm run smoke -- test/fixtures/siparis/smoke-panel.json
```

Smoke mevcut haliyle bir panel snapshot'ı gerektirir; sağlanan fixture tamamen uydurmadır. Gerçek `data/` veya `.env` kullanılmaz. Yerel HTTP testleri için loopback port açma izni gerekir.

Çalışma zamanı notu: Node 24 + better-sqlite3 11.10, rastgele GC anlarında `RemoveEnvironmentCleanupHook ... env != nullptr` native hatasıyla süreci düşürüyordu (Worker Thread'de ve testlerde; fatura testlerinde 15 koşunun 11–12'sinde). better-sqlite3 12.11 ile aynı koşularda görülmedi (0/15, `fetch`'li eski test biçimiyle de). Bu yüzden `engines` `>=20` oldu. Sunucu tek iş parçacığında setInterval kullanır; eşzamanlılık testi iki ayrı Node sürecinde iki bağlantıyla yapılır.

### Düz çizim hazırlama ve toplu yükleme

`tools/duz-cizim-hazirla.js <kaynak> <çıktı> --ayar <ayar.json>` PNG'lerden
`kirpilmis/`, özgün üstünde yeşil referans/mavi kırpma kutulu `onizleme/` ve
`duz-cizimler.json` üretir. Kaynak PNG'leri, gerçek ölçü ayarını ve çıktıları
repo dışında tutun. Hazırlama aracı yükleme yapmaz.

Ayar bir dosya adı → nesne eşlemesidir. Örneğin **uydurma** bir çizim için:

```json
{"ornek.png":{"ad":"Örnek","urun":"tisort","refLengthCm":52,
"refAciklama":"M / 1 - GÖĞÜS","bolge":{"x":50,"y":55,"w":260,"h":250},"refY":[135,145]}}
```

M beden cm değeri ve etiket görselden okunarak ayara yazılır; OCR veya cm
tahmini yapılmaz. `bolge`, tablo/logo/açıklama dışındaki ürün arama alanıdır;
`refY`, ilgili yatay ölçüyü diğer oklardan ayıran **manuel** y aralığıdır.
Araç bu alanda kırmızı piksel maskesinden yatay gövdeyi, numara dairesi
boşluğunu ve uç çizgisi/nokta merkezlerini bulur; uçlar veya px uzunluğu
ayardan alınmaz. Yakındaki izole dikey çizgi yatay uca katılmaz. Genellikle
1/göğüs seçilir; etiket farklıysa göğüs etiketi kullanılır. Alt giyimde anlamlı
yatay bel/basen ölçüsü seçilir; bel oku ürünün 20 px payı dışında kalıyorsa
basen seçimi açıklanır. Yalnız yatay tek cm/px ölçeği vardır.

Kırpma koyu ürün çizgilerinin sınır kutusuna 20 px pay ekler. Kırmızı işaretler
komşu açık arka plan rengiyle temizlenir, mevcut koyu ürün çizgileri korunur.
Kaynakta numara dairesinin örttüğü ürün çizgisi görünmediğinden temiz çıktıdaki
bu boşluklar yeniden çizilmez. Önizlemeyi kontrol edin. Belirsiz seçim/cm
`belirsiz` alanıyla, null referansla raporlanır; okunabilir PNG için özgün
önizleme yine üretilir. Başarılı kayıtta `refUcNoktalar` kırpılmış görüntü
koordinatındadır ve `refLengthPx=x2-x1`; kırpmada yeniden boyutlandırma yoktur.

`node agent/siparis/tools/duz-cizim-yukle.js --api http://127.0.0.1:3000 --json <çıktı>/duz-cizimler.json --kuru`
yalnız liste verir; giriş veya ağ isteği yapmaz. `--kuru` kaldırıldığında araç
TTY'den kullanıcı adını ve **gizli** şifreyi sorar, `/api/siparis/giris` ile
aldığı token'ı yalnız bellekte tutar. Her kalıp için multipart `POST /duz-cizimler`
ve JSON `PUT /duz-cizimler/:id/referans` kullanılır. Aynı adlı kalıp tekrar
yüklenmez; önceki işlem referans kaydetmeden kesildiyse eksik referans onarılır.
Uzak sunucuda HTTPS gerekir; yönlendirme takip edilmez. Canlı yüklemeyi ayrıca
hedefleyip çalıştırmanız gerekir. `urun` yalnız `agent/operations/recipes.json`
anahtarıdır; eşleşme yoksa `null` kalır ve API zorunlu ürün istediği için
**atlanır**. Örneğin ceket için recipe yoktur; ölçüsü net olsa da yüklenmez.

Bu kaynaklar yalnız ön görünümdür. Sırt baskısının ölçüsü aynı ön çizimin yatay
referansından hesaplanır; arka görünüm türetilmez. `measure.js` hem en hem boya
aynı ölçeği uygular. Bu worktree'de ekran placement kutusunu yöneten panel
kodu yoktur; ekranda en-boy oranı kilidi doğrulanamamıştır.

Test: `node --test test/siparis-duz-cizim-araclari.test.js`. Çizimler ve ayarlar
uydurmadır; geçici DATA_DIR ve 127.0.0.1 API üzerinde yükleme, tekrar yükleme ve
göğüs okunun yarısı genişliğinde desenin 26 cm ölçülmesi denetlenir.
