# G4 entegrasyon sözleşmesi

CommonJS, Node >=18.20 önerilir (deponun >=18 tabanıyla uyumlu API'ler; yerelde Node 24.21 ile doğrulandı).
`pdfjs-dist` 4.8.69 Node >=18, `@napi-rs/canvas` Node >=10 bildirir. Native paketlerin platforma uygun ikilileri npm ile kurulur.

## Vektör

```js
const { vectorize } = require('../vector');
const { pdf, kind, report } = await vectorize({ buffer, mime,
  targetMm: { w: 280, h: 120 }, applicationType: 'nakis' });
// applicationType: 'baski' (varsayılan) veya 'nakis'; targetMm isteğe bağlı.
```

PNG/JPEG: yerel `@neplex/vectorizer` (Rust vtracer) → SVG → `svg-to-pdfkit`/PDFKit yolları.
Mevcut içerik kırpması korunur: alfa sıfır ve beyaz kenarlar dışarıda, JPEG için açık kenar toleransı vardır.
Yalnız tamamen beyaz, şeffaf zeminli PNG'de içerik bulunamazsa alfa kutusu kullanılır.
Hedef, kırpılmış içeriğin iki boyutuna uygulanır; en ve boy bağımsız ölçeklenir. Oran farkı %1'i aşarsa teyit istenir.
Hedef yoksa PDF önizlemesinin doğal boyutu 96 dpi kabul edilir; dosya DPI metadata'sı kullanılmaz.
PNG/JPEG kalite kararı hedef olmadan `beklemede` kalır; `qualityLabel` tam olarak
`Kalite ölçüden sonra değerlendirilecek` olur ve kalite teyidi açılmaz. Fiziksel metrikler `null` döner.
Hazırlama özgün kaynağı her uygulamanın hedef mm ölçüsü ve baskı/nakış türüyle yeniden değerlendirir;
önizlemenin kalite kararını ölçüm yerine kullanmaz. Hazır önizleme PDF'sinin yolları yeniden trace edilmeden
ölçeklenir; aynı worker'da `qualitySource` özgün raster ve önizleme SVG karmaşıklık metriklerini taşır,
hedef PDF özgün piksellerle yeniden karşılaştırılır. Açık kalite teyidi gönderimi ve onayı engeller.

PNG/JPEG artık her durumda teyit istemez. `report.rasterQuality` içindeki ölçümler ve eşikler kararı açıklar:

| Sinyal | Varsayılan iyi sınırı | Ortam değişkeni (`SIPARIS_VECTOR_` önekiyle) |
|---|---|---|
| Renk sayısı | ≤6 | `MAX_COLORS` |
| Yeni algısal renk kümesi uzaklığı | DeltaE >10 (CIE76, D65 Lab) | `COLOR_DELTA_E` |
| Sayılan renk kümesinin en küçük mürekkep alan oranı | ≥%0.5 | `MIN_COLOR_AREA_RATIO` |
| En ince çizgi | baskı ≥0.8 mm, nakış ≥1.2 mm | `BASKI_MIN_LINE_MM`, `NAKIS_MIN_LINE_MM` |
| En küçük boşluk | baskı ≥0.8 mm, nakış ≥1.2 mm | `BASKI_MIN_GAP_MM`, `NAKIS_MIN_GAP_MM` |
| En küçük kapalı renk şekli veya delik alanı | baskı ≥0.64 mm², nakış ≥1.44 mm² | `BASKI_MIN_SHAPE_MM2`, `NAKIS_MIN_SHAPE_MM2` |
| Kaynak/çıktı silüet IoU | ≥0.97 | `MIN_IOU` |
| Ortalama RGB piksel farkı | ≤0.03 | `MAX_PIXEL_DIFFERENCE` |
| Alfa kenarındaki yarı saydam piksel oranı | ≤0.02 | `MAX_SEMI_TRANSPARENT_RATIO` |
| SVG yol / düğüm sayısı | ≤500 / ≤10000 | `MAX_PATHS`, `MAX_NODES` |

RGB histogramı Lab uzayına dönüştürülür; en sık, komşularıyla tutarlı iç renkler kümeleri başlatır.
Merkezden DeltaE 10'u aşan ton ayrı küme olur. Alfa ve komşularıyla sert geçiş yapan antialias
karışımları yeni mürekkep sayılmaz; alanı toplam opak mürekkebin %0.5'inden küçük kümeler renk sayısına girmez.
Bununla birlikte küçük, kararlı gerçek renk şekilleri fiziksel alan/çizgi denetimine girer.
Opak zeminde en küçük RGB kanalı <245, şeffaf zeminde alfa >127 mürekkep maskesini verir.
Beyaz/açık mürekkep şeffaf zeminde korunur; opak beyaz zemin üzerindeki beyaz desen otomatik ayırt edilemez.
Düz paletli kaynaklarda trace öncesi yakın RGB tonları ve kararsız kenar renkleri baskın mürekkeplere
normalize edilir; dört pikselden küçük speckle süzülür. Özgün piksel verisi benzerlik kontrolünde korunur.
Fotoğraf/degrade veya güvenilir ayrışmayan renk dokusu teyit ister; OCR kullanılmaz.

Bir piksellik morfolojik açma gürültüyü süzer. Kararlı renk bölgelerinin Zhang–Suen iskeleti üzerinde fiziksel piksel aralığıyla Öklid uzaklık dönüşümü hesaplanır.
Çap eksi bir piksel aralığı (en az bir piksel) çizgi genişliğini muhafazakâr tahmin eder. 4 komşulu bileşenler
kapalı renk şekillerinin ve iç deliklerin en küçük alanını verir. Boşluk maskesi kapalı delikleri ve en az bir eksende
iki mürekkep arasında kalan arka planı kapsar; dışarı açılan kanallar da ölçülür, dış boş kenarlar ölçülmez.
Boşluk iskeletinin açık uçları boşluk eşiği kadar fiziksel uzunlukta budanır; köşeye doğru incelen kısa
uçlar gerçek dar kanal sayılmaz. Uzun paralel ince aralıklar ölçülür; küçük kapalı delikler ayrıca alanla denetlenir.
`minGapMm: null` böyle bir boşluk bulunmadığını veya yalnız kısa uçlar kaldığını belirtir. Birden çok renk bölgesi inceyse en küçüğü kullanılır.

Çıktı PDF'si yeniden rasterleştirilir ve kırpılmış kaynakla aynı piksel ızgarasında karşılaştırılır.
`iou`, bir piksel kenar toleransıyla mürekkep maskelerinin uyuşmasıdır; tolerans içinde karşı maskeye
yakın pikseller hata sayılmaz, diğer farklar birleşim alanına bölünür; `pixelDifference` beyaz üzerine birleştirilmiş RGB'nin
0..1 aralığındaki ortalama mutlak farkıdır. Kontrol düğümleri dahil SVG koordinat grupları sayılır;
komut harfi yazılmadan yinelenen koordinatlar da düğüm sayısına girer. `report.pathCount` ise eskisi gibi
PDF boyama operatörü sayısıdır. Alfa 9..246 piksellerde, analiz ızgarasında iki piksel eşdeğeri
uzaklıkta opak iç alan varsa piksel antialias kapsaması kabul edilir. Kalan yarı saydam piksel sayısı bütün
alfa kenar piksellerine bölünür; geniş saydam şeritler dolu iç alanla seyreltilmez.

Analiz hedefte en fazla 300 dpi, en çok 1 milyon piksel kullanır; kaynak düşük çözünürlüklüyse büyütülmez.
Bir piksellik morfolojik açma ve boşluk uç budaması daha düşük analiz çözünürlüğünde de gürültüyü süzer.
Küçültme tek başına teyit nedeni değildir. Renk sayısı eşiği veya 64 aday küme aşılırsa pahalı renk başına
iskelet/alan ölçümleri yapılmaz (`minLineMm`, bazen `minShapeMm2`: null); ölçülemedi gerekçesi eklenir.
Eşikler üretim onayı değildir. `minLineWidth` eski alanı mm tahmini olarak korunur.
Yeni PNG/JPEG nedenleri `report.reasons` içinde düz Türkçedir; PDF neden kodları değişmez.

Ortam değerleri her çağrıda okunur. Boş, sıfır, negatif, sonlu olmayan veya sınır dışı değerler varsayılana döner.
Oran üst sınırı 1, çizgi/boşluk üst sınırı 100 mm, DeltaE üst sınırı 100, diğer ayarların üst sınırı 1 milyon; geçerli pozitif değerler
üretim yöntemine göre ayarlanabilir. Etkin değerler `rasterQuality.limits` içinde bulunur.
`measurementSize: 'pending'|'target'`, `widthMm`, `heightMm` kararın hangi fiziksel ölçüde verildiğini gösterir.
Hedef yoksa bu iki ölçü ve fiziksel çizgi/boşluk/şekil metrikleri `null` olur. `analysisDpi`,
`noiseFilter`, `colorDeltaE`, `minColorAreaRatio`, `iouTolerancePx` analiz yöntemini açıklar.
Nakış çağrısı açıkça `applicationType:'nakis'` taşır.

PDF kuralları korunur: `pdf-lib` vektör içeriğini, fontlarını ve form nesnelerini tutar; hedef yoksa saf vektör
PDF aynen döner. Hedefte içerik ve ek açıklamalar mevcut kırpma/dönüş kurallarıyla ölçeklenir.
PDF.js Form XObject içeriklerini açar; yalnız görüntü içeren sayfalar 144 dpi çizilir ve yerel vtracer'a girer.
Böylece sayfa crop, transform, alfa maskesi ve birden fazla görüntünün yerleşimi korunur.
Vektör/metin sayfa rasterleştirilmez; karma sayfadaki raster korunur ve teyit ister. Tam raster PDF yeni belgeye
alınır, kaynak `/Image` nesneleri çıktıya taşınmaz; karma çok sayfalı belgede orijinal form korunur.
PDF girdileri eski kuralları kullanır: raster her zaman teyit; <0.2 mm stroke, metin, ölçülemeyen dolgu kalınlığı,
>2000 yol, olağan dışı kaynak oranı veya oran bozulması teyit nedenidir. `manualVector` sözleşmesi değişmez.

```sh
node agent/siparis/vector.js --karsilastir /yerel/girdi --output /ayri/cikti
```

`--output` yoksa sistem geçici dizini kullanılır. Girdiye ve içine yönlenen symlink output'a yazılmaz.
Üst seviye dosyalar için ayrı PDF, JSON ve sayfa PNG'leri üretilir; var olan çıktının üstüne yazılmaz.
Gerçek desen ve önizlemeleri repoya koymayın. 40 MP üstü görsel/PDF render hata verir.

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
