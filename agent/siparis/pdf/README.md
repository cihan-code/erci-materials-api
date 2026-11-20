# Sipariş ölçüleri ve PDF formları

CommonJS, Node ≥18; veritabanı veya tarayıcı gerektirmez. `pdfkit` ve `pngjs` çalışma bağımlılığıdır. `pdf-parse` yalnız test bağımlılığıdır.

```js
const {
  renderProductionForm, renderApprovalForm,
  renderPrintForm, renderEmbroideryForm,
} = require('./agent/siparis/pdf');

const order = {
  orderNo: 'MRC-T001',
  name: 'Örnek Kulüp',
  date: '19.11.2026',          // Hazırlanma tarihi; gösterim metni
  deliveryDate: '30.11.2026',  // Teslim tarihi; gösterim metni
  version: 2,                // Pozitif tam sayı
  omitQuantities: true,      // Yerel adetsiz örnek için isteğe bağlı
  description: ['Dikişler numuneye uygun olacak.'],
  lines: [{
    id: 'satir-1',            // Benzersiz metin
    product: 'Örnek Tişört',
    color: 'Gece Mavisi',
    fabric: 'Pamuk',
    sizes: { XS: 3, S: 2, M: 4, L: 1 },
    images: { front: onGorselBuffer, back: arkaGorselBuffer },
  }],
  applications: [{
    type: 'baski',            // 'baski' | 'nakis'
    position: 'sirt',         // Göğüs, sırt, kol, ense ve kapüşon konumları
    width_mm: 280,            // Negatif olmayan tam sayı; onaylanmış ölçü
    height_mm: 120,
    preview: desenPngBuffer,
    lineIds: ['satir-1'],     // İsteğe bağlı; yoksa tüm satırlara uygulanır
  }],
};

// DATA_DIR'e erişim çağırandadır; modül gerçek marka dosyalarını kendisi aramaz.
const options = {
  brand: {
    logo: logoPngBuffer,      // İsteğe bağlı PNG/JPEG Buffer; yoksa assets/mercico-logo.png
    termsText: 'Şartlar…',    // İsteğe bağlı metin; yoksa sartlar.txt. \n ile satırlar, "1. " ile başlayan satır kalın başlık
  },
};
const pdf = await renderProductionForm(order, options); // Buffer
const printPdf = await renderPrintForm(order, options); // Buffer veya null
```

Üretim/onay fonksiyonları `Promise<Buffer>` döndürür. Baskı/nakış fonksiyonları ilgili uygulama yoksa doğrudan `null`, varsa `Promise<Buffer>` döndürür; her durumda `await` kullanılabilir. PDFKit akışları içeride Buffer olarak toplanır. Geçersiz girdiler hata verir; `await` çağrısını hata yakalama bloğunda kullanın. Girdi nesnesi değiştirilmez.

Bedenler `XS, S, M, L, XL, XXL, 3XL, 4XL`; eksik beden 0 sayılır. Adetler negatif olmayan güvenli tam sayılardır. Bilinmeyen beden, kesirli adet, geçersiz uygulama, olmayan satır kimliği ve eksik ölçü reddedilir. `applications: []` ve `description: []` geçerlidir. Ürün ve desen görselleri isteğe bağlı PNG/JPEG Buffer'lardır; yoksa açık bir yer tutucu görünür. Hatalı görsel sessizce atlanmaz.

Ölçüler bütün formlarda aynı biçimleyiciyle yalnız `width_mm` / `height_mm` alanlarından gelir: `280 / 10 × 120 / 10` → `28 × 12 cm`. Kesirli cm Türkçe virgülle yazılır (`7,5 × 4 cm`). Görselin sayfadaki boyutu fiziksel uygulama ölçüsü değildir. Konum hücresinde birden fazla uygulama varsa her ölçü ayrı satırda görünür. `lineIds` renk/ürün varyantına özel desenleri ayırır.

Belge servisi ürün görselinin dosyası, görünümü, sayfası ve ölçüm kutusu eşleştiğinde cetvel çizgilerini ürün üzerinde gösterir. Ölçüler tablolarda ve atölye detaylarında da okunabilir. Yerleşimi kayıtlı olmayan elle ölçüler tablo ve detay sayfalarında yer alır.

Yerel bir sipariş anlık görüntüsünden adetsiz örnek üretmek için `documents.formOrder(db, dataDir, snapshot, sourceByApp)` çağırın. `sourceByApp`, uygulama kimliğini ilgili desen dosyası kaydına eşleyen `Map` nesnesidir. Modeli stok veya sipariş kaydına yazmadan `await renderProductionForm({ ...model, omitQuantities: true })` biçiminde kullanabilirsiniz. Aynı seçenek onay, baskı ve nakış formlarında adet ve beden dağılımını gizler.

Üretim formu her sipariş satırı için bir dikey sayfa açar; satır beden toplamını ve bütün sipariş toplamını gösterir. Onay formu renk bazında ayrı yatay sayfalar oluşturur; aynı renkteki en fazla iki model aynı sayfada yer alır, renk toplamı bedenlerden hesaplanır. Son sayfa şartlardır. Baskı ve nakış ayrı belgelerdir: ilk sayfa açıklama ve en fazla iki satırın ön/arka görsellerini; ikinci sayfa yalnız ilgili türün desenlerini ve ölçülerini içerir. Daha fazla ürün, desen veya uzun açıklama ek devam sayfaları oluşturabilir. Bütün sayfalarda sipariş kodu ve sürüm alt bilgisi bulunur. Sayfa ölçüleri referanslardaki gibi dikey `810 × 1440`, onayda `1440 × 810` PDF puanıdır.

## Ölçü hesabı

```js
const { measureApplication, designBoxFromPng } = require('../measure');
const box = designBoxFromPng(pngBuffer); // {x, y, w, h} veya boş görselde null
const result = measureApplication({
  refLengthPx: 280, refLengthCm: 56,
  designBoxPx: { w: 140, h: 60 },
  imageKind: 'flat', flags: { perspective: false, wrinkled: false },
});
// {width_mm:280, height_mm:120, scaleCmPerPx:0.2,
//  needsConfirmation:false, reasons:[], reason:''}
```

Ölçek cm/px olarak hesaplanır; en ve boy bağımsız olarak en yakın tam mm'ye yuvarlanır. `imageKind !== 'flat'`, perspektif, kırışıklık veya eksik/geçersiz referans ayrı teyit gerekçeleridir. Referans geçersizse ölçüler ve ölçek `null` döner. Fotoğraf/perspektifte geçerli referansla hesaplanan değerler yalnız öneridir; `needsConfirmation` çağıran tarafından çözülmeden siparişe onaylı ölçü yazılmamalıdır. PDF üreticisi ölçü teyit akışını veya veritabanını yönetmez.

PNG sınır kutusu yalnız alfa değeri 0'dan büyük ve RGB'si saf beyaz (`255,255,255`) olmayan pikselleri içerir; yarı saydam renkler dahildir. Koordinatlar sol üstten 0 tabanlıdır; `w/h` kenar piksellerini içerir. Bozuk PNG hata verir. Beyaz desenin saydam zemindeki beyaz pikselleri de bu sözleşmeye göre dışlanır; beyaz desenler için kutu başka bir kaynaktan sağlanmalıdır.

## Çalıştırma ve kaynaklar

```sh
node --test test/siparis-olcu-pdf.test.js
npm run siparis:ornek-pdf
```

Örnek komut tamamen uydurma `test/fixtures/siparis/example-order.js` verisini ve kodla çizilmiş görselleri kullanarak `test/tmp/{uretim,onay,baski,nakis}.pdf` dosyalarını yazar. Bu klasör git tarafından dışlanır. Gerçek müşteri dosyası içermez.

`fonts/Montserrat-Regular.ttf` ve `fonts/Montserrat-Bold.ttf`, [Montserrat resmi deposundan](https://github.com/JulietaUla/Montserrat/tree/master/fonts/ttf) alınmıştır. SIL Open Font License 1.1 metni `fonts/OFL.txt` içindedir ([Google Fonts lisans kopyası](https://github.com/google/fonts/blob/main/ofl/montserrat/OFL.txt)). Türkçe metinler için font PDF'e gömülür. `assets/mercico-logo.png` gerçek MerciCo logosunun beyaz boşluğu kırpılmış hâlidir; `sartlar.txt` gerçek sipariş onay şartlarıdır (10 madde). `options.brand` sağlanmazsa bu ikisi varsayılandır. Şartlar sayfası yazıyı küçülterek tek sayfaya sığdırır; yalnız aşırı uzun özel metin devam sayfasına akar.

**Açıklama biçimi:** `description` maddeleri kırmızı kare imle basılır. Madde içinde `*…*` ile sarılan kısım kırmızı basılır (`Kapüşon *astarı ve kordon* olacak`); eşi olmayan yıldız olduğu gibi kalır. Ürün Formu'nda dolu özellik hücresine "+" ve altına küçük cm ölçüsü yazılır. Renk adı `(Kartela N)` ile biter; belge servisi bunu kumaş kaleminin `color_no` alanından üretir (`colorLabel`).

Görsel referanslar yalnız geçici klasörde görüntülenmiştir; repoya kopyalanmamıştır. Üretim Formu ve Onay Formu, Canva şablon görsellerinden ölçülen konum, renk ve yuvarlatılmış bant biçimine göre çizilir; atölye formları aynı başlık ve madde diline çekilmiştir. Üretim Formu'nda yalnız ön ya da arka görsel varsa ortada tek büyük görsel, ikisi de varsa yan yana basılır. Beden tablosu yalnız beden dağılımı varsa çizilir. Bilinen farklar: Montserrat yazı metrikleri, uydurma ürün/desen/logolar, eklenen cm ölçüleri ve alt bilgi; üretim beden tablosundaki elle kesim takibi yerine siparişin gerçek adetleri gösterilir. Yatay nakış görsel referansları, istenen iki sayfalı atölye formu için baskı formuyla aynı dikey düzene uyarlanmıştır.

## Bekleyen ölçü, adetsiz önizleme, çocuk bedenleri (G41c)

- `applications[].pending: true` olan uygulama üretim ve onay formunda "Ölçü teyit bekliyor" yazar; atölye formuna alınmaz, forma "Eksik:" satırı eklenir. Tümü bekliyorsa o tür için form çıkmaz (`null`).
- `omitQuantities: true` beden ve adet tablolarını boş çizer (üretim, onay, baskı/nakış). Sunucuda `POST /api/siparis/surumler/:id/onizleme?adetsiz=1` hiçbir şey kaydetmeden üç formu base64 döndürür.
- `7-8 yaş` gibi anahtarlar kendi sütununu alır; `line.note` (kumaş/kalıp açıklaması) üretim ve atölye formuna yazılır.
- Ayrı desen ya da ayrılmış desen yoksa baskı formu, ölçü kutusunu ürün görselinden kırpıp basar.
