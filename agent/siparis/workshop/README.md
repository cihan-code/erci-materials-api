# G4 entegrasyon sözleşmesi

CommonJS, Node >=18.20 önerilir (deponun >=18 tabanıyla uyumlu API'ler; yerelde Node 24.21 ile doğrulandı).
`pdfjs-dist` 4.8.69 Node >=18, `@napi-rs/canvas` Node >=10 bildirir. Native paketlerin platforma uygun ikilileri npm ile kurulur.

## Vektör

```js
const { vectorize } = require('../vector');
const { pdf, kind, report } = await vectorize({ buffer, mime,
  targetMm: { w: 280, h: 120 } }); // isteğe bağlı, TAM sayfa mm
```

PNG/JPEG: yerel `@neplex/vectorizer` (Rust vtracer) → SVG → `svg-to-pdfkit`/PDFKit yolları.
Hedef sayfaya tek ölçek katsayısıyla ortalı fit yapılır; boş kenarlar olabilir. Hedef yoksa raster 96 dpi kabul edilir.
`pdf-lib` vektör sayfaların içeriğini, fontlarını ve form nesnelerini tutar. Hedef yoksa saf vektör PDF aynen döner;
hedefte mevcut içerik ve ek açıklamalar orantılı ölçeklenir. Sayfa dönüşü ve crop origin dikkate alınır.

PDF.js operator list Form XObject içeriklerini açarak yolları/metni/görüntüleri sınıflandırır.
**Yalnız görüntü içeren sayfalar** PDF.js + Skia canvas ile 144 dpi render edilir, sonra yerel vtracer'a girer.
Ham image extraction yerine bu yol seçildi: sayfa crop, image transform, alfa maskesi ve birden fazla görüntünün yerleşimi korunur.
Vektör/metin sayfa hiçbir zaman rasterleştirilmez. Karma sayfadaki mevcut raster da korunur ve `teyit` olur.
Tamamen raster PDF için yeni belge oluşturulur; kaynak `/Image` nesneleri bile çıktıda bulunmaz.
Karma çok sayfalı belgede orijinal form yapısını korumak için mevcut belge kullanılır; değişen raster sayfaların kullanılmayan kaynak nesneleri kalabilir.

Rapor: `pathCount` boyama operatörü sayısıdır (Bezier segment sayısı değil); `colorCount` kullanılan renk tanımlarının tahminidir.
`minLineWidth` mm cinsinden tahmindir: PDF stroke genişliği × transform; rasterda iki yönde foreground pixel run.
Dolgu konturunun gerçek nakış/baskı kalınlığı ölçülemez. Ölçülemeyen dolgu detayı, <0.2 mm çizgi, metin,
>2000 yol, aşırı kaynak oranı ve karma raster için `quality: 'teyit'` döner. Raster sonuçlar OCR olmadan
ince yazı güvenilir ayırt edilemediği için her zaman görsel `teyit` ister. Bu rapor üretim onayı değildir.
`aspectRatioPreserved` ve `aspectRatioError`, uniform transform değişmezinden hesaplanır; görüntü benzerliği skoru değildir.
Testlerde çıktı önizlemesindeki renkli şeklin en-boy oranı da ±%1 içinde ölçülür.

```sh
node agent/siparis/vector.js --karsilastir /yerel/girdi --output /ayri/cikti
```

`--output` yoksa sistem geçici dizini kullanılır. Girdi klasörüne dosya/dizin yazılmaz; içerisine yönlenen symlink output da reddedilir.
Desteklenen üst seviye dosyalar için ayrı PDF, JSON ve sayfa başına PNG üretilir. Var olan çıktının üstüne yazılmaz.
Gerçek desen ve önizlemeleri repoya koymayın. 40 MP üstü PDF render hata verir.

## Atölye

```js
const { createWorkshopHandler, buildWorkshopMessage } = require('./workshop');
const handler = createWorkshopHandler(process.env, { store, lookupStatus, fetch });
registerHandler('atolye_dosya', handler); // G1 dışarıda bağlar; bu modül outbox yazmaz.
```

`WHATSAPP_MODE=manual|test|cloud` (varsayılan manual). `OTOMATIK_GONDERIM !== '1'` her çağrıda
ilk kontrol edilir; cloud dahil hiçbir upload/send/status çağrısı yapılmaz. `manual.js` daima `manuel_bekliyor` döndürür.
`async handler(job)` → `{status:'tamam'|'manuel_bekliyor', providerRef?}`; geçici hata `throw` (`temporary:true`).
`tamam` sağlayıcı tarafından kabul edilen gönderimdir; fiziksel teslim/read garantisi değildir.

```js
job = {
  idempotency_key: 'atolye:VERSION_ID:desen', // G1 dosya BAŞINA anahtar
  provider_ref: null,                        // varsa yeni send öncesi sorgulanır
  payload_json: {                            // object VEYA JSON string
    order: { order_no: 'MRC-T001', version_no: 2,
      lines: [{ product_key: 'forma', color_name: 'Kirmizi', quantity: 12 }] },
    file: { kind: 'desen', name: 'ornek-desen.pdf', path: '/guvenilir/dosya.pdf', mime: 'application/pdf' },
    groupId: 'META_GROUPS_API_ID'
  }
};
```

`payload.files:[...]` alternatifi de kabul edilir; tek dosyada anahtar aynen, çok dosyada
`<idempotency_key>:<file.kind || file.id || file.name>` olur. Kimlikler benzersiz olmalıdır.
Dosyada güvenilir `path` veya uygulama içi `buffer:Buffer` kullanılır; JSON serialize Buffer biçimi de normalize edilir.
Sabit anahtara bağlı dosya/sürüm değiştirilemez. Çok dosyada hata sonrası yeniden aynı job verilince tamamlanmış dosya atlanır.
`providerRef` tek dosyada sağlayıcı kimliği, çok dosyada kimliklerin JSON dizgesidir. G1 için dosya başına job önerilir.
Mesaj yalnız sipariş no/sürüm, ürün-renk-adet ve dosya adlarını allowlist ile okur; fiyat ve müşteri iletişimini taşımaz.

`test.js`: `createTestAdapter({failFirst:N, failures:{'ornek.pdf':N}, lostResponseFor:['ornek.pdf'], records:[]})`.
Bellekte `gonderildi`, `ulasti`, `durum_sorgulandi` kayıtları; ağ yok. `createMemoryStore()` yalnız test içindir.
Enjeksiyon: `createWorkshopHandler(env,{mode:'test',provider,store})`; `.records` da izlenebilir.

Cloud iskeleti için `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_API_VERSION` ortamda olmalıdır.
Grup `payload.groupId` veya `WHATSAPP_GROUP_ID` ile seçilir. Grup önceden Meta Groups API ile hazırlanmış ve hesap erişimi açık olmalıdır.
Upload: `POST /{phone}/media`; sonra `POST /{phone}/messages`, `recipient_type:'group'`, `type:'document'`.
Token/numara kimliği job veya options üzerinden alınmaz. API sürümü otomatik varsayılmaz.

Cloud **kalıcı store verilmezse manual bekler**. `store.get(key)` ve `store.set(key,state)` async olmalı;
set resolve olduğunda kayıt diskte kalıcı olmalıdır. `sending` checkpoint send'den ÖNCE yazılır.
G1 aynı anahtarı süreçler arasında tek işçiyle seri işlemelidir; handler yalnız kendi sürecindeki çakışmaları sıraya alır.
State en az `status,mediaId,providerRef` tutar. Bir restart sonrası complete atlanır; sending/ambiguous/provider_ref önce sorgulanır.

`lookupStatus({key,providerRef})` uygulamanın kalıcı **webhook kayıt defterini** sorgulayan enjekte callback'tir;
Meta için belgelenmemiş `GET message/status` endpoint'i uydurulmaz.
Sonuç `{status:'sent'|'delivered'|'read'|'failed'|'not_sent'|'unknown',providerRef?}`.
Yalnız kesin `failed`/`not_sent` tekrar gönderime izin verir. Kayıt yokluğu `not_sent` sayılmaz.
Yanıt kaybında ilk çağrı geçici hata fırlatır; sonraki çağrı lookup yapar. Bilinmeyen sonuç manual bekler, kör resend olmaz.
ProviderRef de kaybolduysa webhook'un key ile güvenilir eşleştirilmesi uygulamanın sorumluluğudur;
Groups belgelerinde opaque callback desteği doğrulanamadığından bu iskelet key'i Meta'ya göndermez.
Güvenilir eşleştirme yoksa callback `unknown` döndürmelidir. Bu durumda operatör kontrolü gerekir.
HTTP 429 kesin reddedilmiş geçici denemedir; timeout/5xx belirsizdir. Kalıcı 4xx manual bekler.

2026-11-19 resmi kaynakları:
- [Meta Groups messaging](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/groups-messaging/)
- [Meta media upload](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media)
- [Meta message API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api)
- [Vtracer Node bağlaması](https://github.com/neplextech/vectorizer)
- [PDF.js](https://mozilla.github.io/pdf.js/examples/), [pdf-lib](https://pdf-lib.js.org/docs/api/classes/pdfpage), [SVG-to-PDFKit](https://github.com/alafr/SVG-to-PDFKit)

Doğrulama: `node --test test/siparis-vektor-atolye.test.js` (sentetik şekiller; gerçek API/veri yok).
