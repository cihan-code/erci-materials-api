# Türk Banka Dekontları — Vision çıkarımı için referans

Amaç: Belge Yükleme akışındaki Dekont (`payment_receipt`) Vision prompt'unu ve test
fixture'larını gerçek Türk EFT / Havale / FAST dekont düzenlerine göre kalibre etmek.

Çıkarılan alanlar: `direction`, `date`, `amount`, `currency`, `sender_name`,
`receiver_name`, `sender_iban`, `receiver_iban`, `sender_tax_number`,
`receiver_tax_number`, `reference_number`, `description`.

Bu dosya **halka açık** örnek dekontlar, banka yardım sayfaları ve TODEB/TÜRMOB
mevzuat belgeleri incelenerek hazırlandı. Hiçbir yere giriş yapılmadı.
İncelenen gerçek dekont örnekleri (alan adları birebir bunlardan alındı):

| # | Banka / kanal | Belge başlığı | Kaynak |
|---|---|---|---|
| A | Yapı Kredi — İnternet Bankacılığı | "Bilgi Dekontu / FAST GÖNDERİMİ" | rizeataturkortaokulu.meb.k12.tr/.../23190351_Dekont-21.pdf |
| B | Kuveyt Türk — İnternet Şube (kurumsal) | "DEKONT / Giden IBAN'a Para Transferi" | boutiqueottoman.com/wp-content/uploads/2023/02/Transaction-C6.pdf |
| C | VakıfBank — şube/internet | "İŞLEM BİLGİLERİ / Hesaptan Havale" | tcf.gov.tr/wp-content/uploads/2022/08/dekont.pdf |
| D | İş Bankası — İşCep | "DEKONT / Hesaba Para Aktarma İşlemi / İşCep İşlem Dekontu" | 91devresi.org/uploads/Dekont.html.pdf |
| E | İş Bankası / Enpara — İşCep (hesap hareketi tarzı) | "DEKONT" + "GIDEN FAST EFT" | tcf.gov.tr/wp-content/uploads/2022/08/islem-dekontunuz.pdf |
| F | Ziraat Bankası — Ziraat Mobil / İnternet Şubesi | "HESAPTAN FAST" | masertak.com/wp-content/uploads/quform/1/2024/02/Dekont.pdf |
| G | Elektronik Para Kuruluşu (Papara/Ininal vb.) — mevzuat şablonu | "DEKONT (Elektronik Para Kuruluşu)" | todeb.org.tr/source/Mevzuat/...Asgari Unsurlar.pdf |

Diğer bankalar (Garanti BBVA, Akbank, Halkbank, QNB Finansbank, DenizBank, TEB) için
alan adları banka yardım/SSS sayfaları + şikayet platformu ekran açıklamaları +
sektör bilgisi ile tamamlandı; işaretlendi.

Kaynak URL listesi dosyanın sonundadır.

---

## 1. Bankaya göre taraf etiketleri

`S` = para gönderen tarafın etiketi, `A` = para alan tarafın etiketi.

| Banka / kanal | Gönderen (S) etiketi | Alıcı (A) etiketi | Notlar |
|---|---|---|---|
| **Yapı Kredi** (A) | `GÖNDEREN HESAP NO`, `GÖNDEREN ADI` | `ALICI BANKA`, `ALICI ŞUBE`, `ALICI HESAP`, `ALICI ADI`, `ALICI TCKN/VD/VKN` | Başlıkta `FAST GÖNDERİMİ` / `GİDEN FAST TUTARI` (negatif) → giden. `ÖDEMENİN KAYNAĞI: İnternet Bankacılığı`, `MESAJ TÜRÜ: Bireysel Ödeme`. Kendi hesabı üst blokta: `MÜŞTERİ NO`, `IBAN NO`, `VKN/TCKN/YKN`. |
| **Kuveyt Türk** (B) | `Gönderen Kişi` (⚠ etiket "Kişi" der ama değer şirket unvanı olabilir) | `Gönderilen Kişi`, `Gönderilen IBAN`, `Gönderilen Banka` | `Müşteri Adı` = hesap sahibi (örnekte LTD ŞTİ). `Şube Adı`, `Vergi Dairesi`, `TC Kimlik No`, `İşlem Yeri: İnternet Şube`. Başlık `Giden IBAN'a Para Transferi` → giden. `Açıklama` satırı gönderen+alıcıyı tekrar düz metin yazar. |
| **VakıfBank** (C) | `GONDEREN HESAP NO`, `GONDEREN AD SOYAD/UNVAN` | `ALICI HESAP NO`, `ALICI AD SOYAD/UNVAN` | `İŞLEM: Hesaptan Havale`, `İŞLEM TARİHİ`, `İŞLEM TUTARI`, `MASRAF TUTARI`, `İŞLEM NO`, `FİŞ NO`, `İŞLEM AÇIKLAMASI`. "Ad Soyad/Unvan" tek alanda — kişi de kurum da aynı yere yazılır. |
| **İş Bankası / İşCep** (D) | İki sütun: sol başlık `Gönderen` → `İsim`, `Hesap (IBAN)` | sağ başlık `Alıcı` → `İsim`, `Hesap (IBAN)` | Başlıkta `Sayın <UNVAN>` = dekont sahibi. `İşlem Tarihi`, `İşlem Zamanı`, `Sıra No`, `Fiş Sıra No`. `Aktarılan Tutar(TL)`, `Havale Ücreti(TL) + Vergi`, `Açıklama`. Başlık `Hesaba Para Aktarma İşlemi` (yön belirsiz → sahip/masraf bakılır). |
| **İş Bankası / Enpara** İşCep hesap-hareketi tarzı (E) | `GÖNDEREN:`, `MÜŞTERİ ÜNVANI` | `ALICI ÜNVANI`, `ALICI IBAN`, `KATILIMCI` (alıcı banka) | Tablo başlığı `Hesap/Kart | IBAN | Açıklama | B/A | Para Cinsi | Tutar`. **`B/A` sütunu** = Borç/Alacak (B=giden, A=gelen). `sorgu no`, `Sıra No`, `Fiş No`. `GIDEN FAST EFT` başlığı. |
| **Ziraat Bankası** (F) | `Gönderen` | `Alıcı`, `Alıcı Hesap`, `Alan Banka` | Üst blok kendi hesabı: `ŞUBE KODU/ADI`, `IBAN`, `HESAP NUMARASI`, `VERGİ DAİRESİ`, `VERGİ KİMLİK NO`. `SAYIN <ad>` = karşı taraf değil, **dekont sahibi**. `Fast Mesaj Kodu` (A01…), `Fast Sorgu No`, `VALÖR`, `İŞLEM YERİ: ZİRAAT MOBİL`. `HESAPTAN FAST` + "Hesabınızdan … Çekilmiştir" → giden. |
| **Garanti BBVA** (yardım sayfası + sektör) | `Gönderen`, `Gönderen Hesap` | `Alıcı`, `Alıcı Hesap`, `Alıcı IBAN` | `İşlem Referans Numarası` / `Referans No`, `İşlem Tarihi`, `Tutar`, `Açıklama`. Mobil dekontta `FAST Referans No`. Kurumsalda dekont no e-Defter için ayrıca verilir. |
| **Akbank** (Ödeme Emri Bilgileri + sektör) | `Gönderen` veya `Borçlu Hesap`, `İşlemi Yapan` | `Alıcı` veya `Alacaklı`, `Alacaklı IBAN` | `Referans`, `Valör`, `Dekont No`, `İşlem Tarihi/Saati`. `İşlemi Yapan` = talimatı giren kişi, **taraf değil**. |
| **Halkbank** (yardım + sektör) | `Gönderen` | `Alıcı` | `İşlem No` / `Referans No`, `Fiş No`, `İşlem Tarihi`, `Tutar`, `Açıklama`. |
| **QNB Finansbank** (yardım + sektör) | `Gönderen` veya `Borçlu` | `Alıcı` veya `Lehdar` | `İşlem No`, `Dekont No`, `Referans No`. "Dekontlarım" menüsünden PDF. |
| **DenizBank** (sektör) | `Gönderen` | `Alıcı` | `Referans No`, `İşlem Tarihi`, `Açıklama`. |
| **TEB** (sektör) | `Gönderen` | `Alıcı` | `Referans Numarası`, `İşlem Tarihi`. |
| **Papara** (uygulama makbuzu + sektör) | `Gönderen`, `Papara No` | `Alıcı`, `Papara No` / `IBAN` | `İşlem No` / `Referans Numarası`, `Açıklama`, `Tarih`. Açıklamada bazen TCKN görünür. |
| **Enpara** (yukarıda E — İş Bankası altyapısı) | `GÖNDEREN` | `ALICI ÜNVANI` | Enpara ayrı bir dekont formatı üretmez, İşCep motorunu kullanır. |
| **Elektronik Para Kuruluşu** genel şablon (G) | `E-Para Hesabına Para Gönderen Hesap Bilgileri` | `Müşteri Ad-Soyad/Unvan` (cüzdan sahibi) | Zorunlu alanlar: `Dekont No`, `İşlem Referans No`, `Banka Provizyon No`, `İşlem Tarihi/Saati`, `İşlemin Valör Tarihi`, `İşlem Açıklaması`, `İşlemin Tutarı` (yazı+rakam), `İşlem Para Birimi`, `Kullanıcı Adı`. Anonim kartta müşteri alanına "Anonim". |

### Görülen diğer taraf etiketleri (normalize et)
`Borçlu` / `Alacaklı` (= gönderen / alıcı), `Lehdar` (= alıcı/beneficiary),
`Ödeyen` / `Ödenen`, `Karşı Taraf` (= diğer taraf, yön ayrı belirlenir),
`Talimatı Veren` / `İşlemi Yapan` / `Kullanıcı Adı` / `Personel Sicil` (**operatör, taraf değil**),
`Müşteri` / `Müşteri Adı` / `Müşteri Ünvanı` / `Sayın …` (= dekont sahibi),
`Hesap Sahibi`, `Ad Soyad/Unvan`, `Ünvan`, `Gönderilen Kişi`.

---

## 2. Şirket adı vs kişi adı ayrımı (prompt'a konacak kurallar)

**Problem:** Kurumsal bir hesabın dekontunda hesap sahibi olarak "AHMET YILMAZ" gibi
bir kişi adı görünebilir, oysa transfer aslında şirketten/şirkete yapılmıştır.
Kuveyt Türk örneği (B) bunu kanıtlıyor: etiket birebir `Gönderen Kişi` diyor, değer
ise `EMCO İNŞAAT GIDA TURİZM TEKSTİL BİLGİSAYAR İTHALAT İHRACAT SANAYİ VE TİCARET
LİMİTED ŞİRKETİ`. Etiketteki "Kişi" kelimesi yanıltıcı — **değerin içeriğine bak.**

### Kural 1 — Tüzel kişi eki taşıyan metin = taraf odur
Bir taraf alanının değeri şu büyük-harf eklerden birini içeriyorsa, o metnin
**tamamı** taraf adıdır (`sender_name` / `receiver_name`):

```
A.Ş.  AŞ  ANONİM ŞİRKETİ  A.Ş  A. Ş.
LTD. ŞTİ.  LTD.ŞTİ.  LİMİTED ŞİRKETİ  LTD  ŞTİ
SAN. TİC.  SAN. VE TİC.  SANAYİ VE TİCARET  SAN.  TİC.
İTH.  İHR.  İTHALAT İHRACAT  DIŞ TİCARET  DIŞ TİC.
KOLL. ŞTİ.  KOM. ŞTİ.  ADİ ORTAKLIK  ORT.
HOLDİNG  GRUP  GROUP  İŞLETMESİ  İŞLETMELERİ
NAK.  NAKLİYAT  LOJİSTİK  TAŞIMACILIK  KARGO
PAZARLAMA  DAĞITIM  MÜMESSİLLİK  MÜŞAVİRLİK  İNŞAAT  TEKSTİL  GIDA
DERNEĞİ  VAKFI  KOOP.  S.S.  BİRLİĞİ  ODASI
BELEDİYESİ  ÜNİVERSİTESİ  MÜDÜRLÜĞÜ  BAKANLIĞI  DÖNER SERMAYE  DÖNER SERMAYE İŞLETMESİ
```

### Kural 2 — Ayrı görünen kişi adı = imza/operatör, taraf değil
Aynı tarafta hem şirket unvanı hem de bir kişi adı görünüyorsa (farklı alanlarda
ya da `/`, `-`, yeni satır, `adına`, `vekaleten` ile ayrılmış), **taraf = şirket**;
kişi adı en fazla imzalayan/talimatı verendir, çıkarımda kullanılmaz.
`/`, `-`, `\n`, `adına`, `nam-ı hesabına`, `vekaleten` ayraçlarından böl; tüzel-kişi
eki olan parçayı al.

Kişi adı **kesinlikle taraf değildir** şu alanlardan geliyorsa:
`İşlemi Yapan`, `Talimatı Veren`, `Kullanıcı Adı`, `Personel Sicil`, `Personel`,
`İşlem Yapan Kullanıcı`, imza satırı, `Hazırlayan`, `Onaylayan`.

### Kural 3 — Vergi numarası uzunluğu tarafın tipini söyler
- **10 hane** = VKN → tüzel kişi (veya şahıs firması). Ad kişi gibi görünse bile
  yanına 10 haneli vergi no + `Vergi Dairesi` varsa taraf bir **işletmedir**.
- **11 hane** = TCKN → gerçek kişi.
- Alan etiketleri: `VKN`, `VKN/TCKN`, `TC Kimlik No`, `Vergi Kimlik No`,
  `ALICI TCKN/VD/VKN`, `Vergi Dairesi`, `Vergi No`.
- `sender_tax_number` / `receiver_tax_number`: yalnız dekontta **o tarafa ait**
  açıkça yazılmış VKN/TCKN'yi doldur. Bireysel transferlerde genelde **yoktur** →
  `null`. Kurumsal/İnternet Şube dekontlarında gönderen tarafın VKN'si sık görülür,
  alıcınınki nadir.

### Kural 4 — Şahıs firması / esnaf durumu
Hesap yasal olarak kişi adına ama ticari faaliyet var:
- Gerçek ticari ad çoğu zaman **açıklama satırının** sonunda `/` sonrası ya da
  `İŞLEM AÇIKLAMASI` içinde geçer (VakıfBank C: gönderen `ERDAL TÖRE`, açıklamada
  "… / Erdal Töre Koordinasyon Parkuru Tanıtım, Bilgilendirme ve Uygulama").
- `Vergi Dairesi` + 10 haneli VKN varsa → işletme muamelesi yap.
- Aksi halde kişi adını taraf olarak bırak ama `confidence.direction` düşür.

### Kural 5 — IBAN / VKN eşleşmesi her şeyi ezer (yön için asıl kanıt)
`sender_iban` ∈ `MERCI_IBANS` → `direction = outgoing` (isimde ne yazarsa yazsın).
`receiver_iban` ∈ `MERCI_IBANS` → `direction = incoming`.
`sender_tax_number` == Merci VKN → outgoing; `receiver_tax_number` == Merci VKN → incoming.
İsim benzerliği ("MERCİ" geçmesi) ikincil, zayıf sinyal.

### Kural 6 — Taraf adı için öncelik sırası
1. İçinde tüzel-kişi eki olan `Unvan` alanı
2. İçinde tüzel-kişi eki olan isim alanı değeri (`GÖNDEREN ADI`, `ALICI ADI`, `İsim`)
3. `Müşteri Adı` / `Müşteri Ünvanı` bloğu (hesap sahibi) — **yalnız o taraf dekont sahibiyse**
4. `Sayın` / `SAYIN` başlığı — **yalnız o taraf dekont sahibiyse**
5. Düz `Ad Soyad`
Asla: `İşlemi Yapan`, `Kullanıcı`, `Personel`, `Talimatı Veren`, imza adı.

### Kural 7 — "… adına / namına / hesabına" ifadesi
"X adına Y'ye ödeme" → esas lehtar **X**. İş Bankası D örneği: açıklama
"MERHUME SATI ERSOY ADINA" → ödeme merhume S.E. adına yapılmış; `receiver_name`
resmi alıcı unvanı kalır, açıklama bu notu taşır.

### Kural 8 — Kargo / kurye ödemeleri
Ödeme alıcısı bir kargo firmasıysa **firmanın tüzel unvanı** yakalanır, şube
görevlisi ya da `Sayın` kişi değil. Türkiye'deki büyük kargo firmalarının resmi
unvanları (fixture'larda gerçekçi olması için):

| Marka | Resmi unvan (yaklaşık) |
|---|---|
| Aras Kargo | Aras Kargo Yurt İçi Yurt Dışı Taşımacılık A.Ş. |
| Yurtiçi Kargo | Yurtiçi Kargo Servisi A.Ş. |
| MNG Kargo | MNG Kargo Yurtiçi ve Yurtdışı Taşımacılık A.Ş. |
| Sürat Kargo | Sürat Kargo Lojistik Dağıtım ve Taşımacılık Hizmetleri A.Ş. |
| PTT Kargo | Posta ve Telgraf Teşkilatı A.Ş. |
| Hepsijet | Hepsi Dağıtım Hizmetleri ve Lojistik A.Ş. |
| Sendeo | Sendeo Dağıtım Hizmetleri A.Ş. |

Açıklama tipik ifadeler: "kargo ödemesi", "gönderi ücreti", "aylık kargo bedeli",
"kapıda ödeme tahsilatı", "kurye", "navlun", "cari ödeme".

### Not — dekont ≠ fatura
Dekont bir bankacılık işleminin gerçekleştiğini gösterir; KDV/matrah taşımaz,
"e-Dekont yerine geçmez bilgi amaçlıdır" gibi ibareler taşır. Fatura (e-Fatura /
e-Arşiv) ETTN, `Mal/Hizmet` kalemleri, `Matrah`, `Hesaplanan KDV`, `Vergiler Dahil
Toplam Tutar`, `Ödenecek Tutar` ve senaryo gereği `Sayın / ALICI` VKN'si taşır.
`document_type` ayrımı: banka logosu + "DEKONT/İŞLEM BİLGİLERİ" + Sorgu/Referans No
→ `payment_receipt`; kalem tablosu + KDV + ETTN → `invoice`.

---

## 3. Referans numarası alan adları (görülen tam liste)

Öncelik (traceability için en iyisi üstte):

| Alan adı varyantları | Ne olduğu | reference_number için |
|---|---|---|
| `Sorgu No`, `Sorgu Numarası`, `SORGU NO`, `sorgu no`, `Fast Sorgu No`, `FAST Sorgu No` | FAST/EFT takip no — müşterinin paylaşıp işlemi izlettiği numara | **Birinci tercih** (FAST/EFT dekontunda) |
| `İşlem Referansı`, `İŞLEM REF`, `İşlem Referans No`, `İşlem Referans Numarası` | Bankanın işlem referansı | Birinci/ikinci tercih |
| `Referans No`, `Referans Numarası`, `Referans` | Genel referans | İkinci tercih |
| `Dekont No`, `Dekont Numarası`, `BELGE NUMARASI` | Dekont belge no | Üçüncü tercih |
| `İşlem No`, `İŞLEM NO`, `İşlem Kodu` | İşlem no | Dördüncü tercih |
| `Sıra No`, `SIRA NO/ID`, `Sıra Numarası`, `Fiş Sıra No` | Sıra/fiş no | Son tercih (en az kalıcı) |
| `Fiş No`, `FİŞ NO` | Fiş no | Son tercih |
| `Banka Provizyon No`, `Provizyon No` | Provizyon | Fallback |
| `Fast Mesaj Kodu`, `FAST Mesaj Kodu`, `Mesaj Türü` | Amaç/tür kodu (A01, "Bireysel Ödeme") — **kimlik değil** | kullanma |
| `Kolay Adres`, `KOLAY ADRES` | Kolas takma adı (@handle / telefon / TCKN) — **referans değil** | kullanma |
| `ETTN` | e-belge UUID (sadece e-dekont) | genelde `null` |
| `Müşteri No`, `MÜŞTERİ NO`, `Müşteri Numarası` | Müşteri kimliği — **işlem no değil** | kullanma |
| `MUR`, `UETR`, `Referans (MUR)` | SWIFT referansları (yurt dışı) | SWIFT dekontunda birinci |
| `Dosya No`, `İşlem Takip No` | Şube işlem dosyası | Fallback |

Kural: birden çok aday varsa yukarıdaki öncelik; `Sorgu No` ile `İşlem Referansı`
ikisi de varsa `Sorgu No`'yu al (kullanıcı bunu paylaşır).

---

## 4. Tutar / tarih / açıklama alan adları

### Tutar
- `Tutar`, `İşlem Tutarı`, `İŞLEM TUTARI`
- `GİDEN FAST TUTARI`, `Giden Tutar`, `Gönderilen Tutar`, `EFT TUTARI`, `FAST TUTARI`, `Gönderilen Tutar`
- `Aktarılan Tutar`, `Aktarılan Tutar(TL)`
- `TOPLAM TAHSILAT TUTARI`, `Toplam Tutar`, `Hesabınızdan çekilen tutar`
- `Yalnız <yazıyla> TL` — tutarın yazıyla hâli, **çapraz kontrol için kullan**
- Masraf kalemleri (ana tutara **dahil etme**): `Masraf Tutarı`, `MASRAF TUTARI`,
  `Komisyon`, `BSMV`, `Mesaj Ücreti`, `Havale Ücreti`, `EFT Ücreti`, `Toplam Masraf`,
  `Vergi`, `EFT ÜCRETİ(BSMV DAHİL)`
- `amount` = gönderilen/alınan net transfer tutarı (masraf hariç). Yapı Kredi'de
  `GİDEN FAST TUTARI` bunu verir; `TOPLAM TAHSILAT TUTARI` masraf dahildir → kullanma.

### Para birimi ve format
- `TL`, `TRY`, `₺`, `Döviz Cinsi: TL`, `DÖVİZ CİNSİ`, `İşlem Para Birimi`, `Para Cinsi`
- Türk formatı: **nokta = binlik, virgül = kuruş** → `1.500,00 TL`, `3.000,00 TRY`, `78.500,00 TL`
- Bazı PDF dışa aktarımları İngiliz formatı verir: İşCep örneği `2,500.00` →
  **her iki formatı da tanı**, sonucu her zaman sayı (`78500`) olarak yaz.
- Giden işlemlerde tutar negatif / `-` önekli olabilir (Yapı Kredi: `-13000`).
- **`B/A` sütunu** (İş Bankası/Enpara hesap-hareketi dekontu): `B` = Borç = para
  çıkışı (**outgoing**), `A` = Alacak = para girişi (**incoming**). En güçlü yön sinyali.

### Tarih
- `İşlem Tarihi`, `İŞLEM TARİHİ`, `İşlem Tarihi ve Saati`, `İşlem Tarihi/Saati`,
  `Tarih/Saat`, `İşlem Zamanı`
- `Valör`, `VALÖR`, `Valör Tarihi`, `İşlemin Valör Tarihi` — hafta sonu EFT'de farklı olabilir
- `Düzenleme Tarihi`, `Düzenleme Tarihi/Saati`
- Format: `dd.mm.yyyy` veya `dd/mm/yyyy`, saat `HH:MM:SS`
- `date` = **`İşlem Tarihi`** (yoksa `Düzenleme Tarihi`); ISO'ya çevir (`2026-08-25`).

### Açıklama
- `Açıklama`, `AÇIKLAMA`, `İşlem Açıklaması`, `İŞLEM AÇIKLAMASI`
- `Transfer Açıklaması`, `Ödeme Açıklaması`, `Dekont Açıklaması`, `Gönderen Açıklaması`, `Alıcıya Not`
- **Yok sayılacak matbu metinler** (bunları `description`'a koyma):
  - "YUKARIDAKİ TUTAR HESABINIZA BORÇ/ALACAK KAYDEDİLMİŞTİR."
  - "Yukarıda detay bilgileri verilen havale işlemi gerçekleştirilmiştir."
  - "İşbu dekont Bankamız kayıtları çerçevesinde…", "e-Dekont yerine geçmez bilgi amaçlıdır."
  - "ELEKTRONİK FON TRANSFERİ (EFT) ÜCRETİ - FAST" (ücret açıklaması)
- Gerçek kullanıcı notu genelde `AÇIKLAMA:` sonrası veya son `/` sonrasıdır.
  Yapı Kredi A: "…(EFT) ÜCRETİ - FAST/**Azer bebek**" → not = "Azer bebek".
  Kuveyt Türk B: "**BoutiqueOttoman Müşterilerinden Toplanan Bağış** Gönderen:… Alıcı:…" → not = ilk cümle.

---

## 5. Açıklama → ödeme amacı anahtar kelime haritası

| Açıklamada geçen (küçük harfe indir, kısmi eşleşme) | Ödeme amacı |
|---|---|
| `kapora`, `kapora bedeli`, `rezervasyon` | kapora / booking deposit |
| `avans`, `avans ödemesi`, `sipariş avansı` | avans |
| `ön ödeme`, `önödeme`, `peşinat`, `peşin`, `peşin ödeme` | peşin / down payment |
| `sipariş bedeli`, `sipariş ödemesi`, `sipariş no` | sipariş ödemesi |
| `kalan`, `kalan ödeme`, `bakiye`, `bakiye ödemesi`, `kalan bakiye`, `son taksit` | kalan bakiye |
| `fatura`, `fatura bedeli`, `fatura ödemesi`, `fatura no`, `e-fatura`, `irsaliye` | fatura ödemesi (fatura no taşıyabilir) |
| `cari`, `cari ödeme`, `cari hesap`, `hesaben`, `mahsuben`, `cari kapama` | cari hesap kapama |
| `kira`, `kira bedeli`, `işyeri kirası`, `ofis kira`, `depo kira`, `dükkan kirası` | kira |
| `maaş`, `ücret`, `maaş ödemesi`, `bordro`, `sgk`, `prim`, `huzur hakkı`, `avans maaş`, `mesai` | maaş / bordro |
| `kargo`, `kargo ödemesi`, `gönderi ücreti`, `kapıda ödeme`, `kurye`, `navlun`, `nakliye`, `taşıma bedeli`, `sevkiyat` | kargo / nakliye |
| `iade`, `geri ödeme`, `para iadesi`, `fazla ödeme iadesi` | iade |
| `borç`, `borç ödemesi`, `borç kapama`, `ödünç`, `harçlık`, `elden` | borç / kişisel |
| `teminat`, `depozito`, `güvence bedeli`, `kesin teminat`, `geçici teminat` | teminat / depozito |
| `komisyon`, `hakediş`, `hizmet bedeli`, `danışmanlık`, `müşavirlik` | komisyon / hizmet |
| `bağış`, `yardım`, `aidat`, `zekat`, `fitre` | bağış / aidat |
| `vergi`, `kdv`, `stopaj`, `muhtasar`, `mtv`, `harç`, `ba-bs`, `geçici vergi` | vergi ödemesi |
| `hammadde`, `kumaş`, `iplik`, `aksesuar`, `fermuar`, `düğme`, `etiket bedeli`, `kutu`, `poşet` | malzeme (Merci) |
| `dikim`, `kesim`, `fason`, `fason bedeli`, `işçilik`, `overlok`, `ütü`, `paketleme` | fason / işçilik (Merci) |
| `numune`, `numune bedeli`, `örnek dikim` | numune |

---

## 6. Yön (`direction`) belirleme — sinyal önceliği

1. **IBAN/VKN eşleşmesi** (`MERCI_IBANS` / `MERCI_COMPANY_PROFILE`) — kesin, ezer.
2. **`B/A` sütunu**: `B` → outgoing, `A` → incoming.
3. **Başlık / fiil**:
   - Outgoing: `FAST GÖNDERİMİ`, `GİDEN FAST`, `HESAPTAN FAST`, `Giden IBAN'a Para Transferi`,
     `Hesaptan Havale`, `Giden EFT`, `GIDEN FAST EFT`, "Hesabınızdan … Çekilmiştir",
     "… borç kaydedilmiştir"
   - Incoming: `Gelen FAST`, `Gelen EFT`, "Hesabınıza … yatmıştır", "… alacak kaydedilmiştir",
     "Lehinize"
   - Belirsiz: `Hesaba Para Aktarma İşlemi`, `Havale`, `EFT` (tek başına) → 4/5'e bak
4. **Negatif tutar / `-` öneki** → outgoing.
5. **Masraf/komisyon/BSMV bu hesaptan alınmış** → hesap gönderendir → outgoing
   (gelen transferde alıcıdan ücret alınmaz).
6. **Dekont sahibi kim?** `Sayın …`, `Müşteri Adı`, `MÜŞTERİ ÜNVANI`, üst IBAN bloğu →
   sahip = gönderen ise outgoing, sahip = alıcı ise incoming.
7. Yalnız isimler var, sahip işareti / `B/A` / fiil yok → `direction = "unknown"`,
   `confidence.direction ≤ 0.4`, kullanıcıya sor.

---

## 7. Altı fixture taslağı

> Tüm isim / IBAN / VKN / tutarlar **UYDURMA**. IBAN'lar `TR00` ile başlar.
> Şema mevcut `extract-*.json` fixture'larıyla aynı. Merci tarafı için
> `MERCI_IBANS` içindeki sahte değer: `TR00 1111 2222 3333 4444 5555 6666`,
> Merci VKN (sahte): `1234567890`.

### 6.1 Gelen müşteri ödemesi — İş Bankası İşCep iki sütun düzeni (D)
Dekont: "DEKONT / Hesaba Para Aktarma İşlemi", `Sayın MERCI TEKSTİL SANAYİ VE TİCARET`.
Gönderen İsim: `PARLAK GİYİM PERAKENDE TİC. LTD. ŞTİ.`, Alıcı İsim: `MERCI TEKSTİL
SANAYİ VE TİCARET`, alıcı IBAN Merci → incoming. `Aktarılan Tutar(TL) 145.000,00`,
`Açıklama: 4021 nolu sipariş kalan ödeme`.

```json
{
  "document_type": "payment_receipt",
  "direction": "incoming",
  "date": "2026-08-24",
  "amount": 145000,
  "currency": "TRY",
  "sender_name": "PARLAK GİYİM PERAKENDE TİC. LTD. ŞTİ.",
  "receiver_name": "MERCI TEKSTİL SANAYİ VE TİCARET",
  "sender_iban": "TR000099887766554433221100",
  "receiver_iban": "TR001111222233334444555566",
  "sender_tax_number": null,
  "receiver_tax_number": null,
  "invoice_number": null,
  "reference_number": "9516",
  "description": "4021 nolu sipariş kalan ödeme",
  "subtotal": null,
  "vat_amount": null,
  "total": 145000,
  "due_date": null,
  "confidence": { "document_type": 0.97, "direction": 0.95, "amount": 0.98 }
}
```
Not: İşCep dekontunda tek referans `Sıra No` / `Fiş Sıra No`; `Sorgu No` yoksa
`Sıra No` alınır. "kalan ödeme" → keyword: kalan bakiye.

### 6.2 Giden tedarikçi ödemesi — Ziraat "HESAPTAN FAST" (F)
`SAYIN MERCİ TEKSTİL SAN. VE TİC. LTD. ŞTİ.` (üst blok = kendi hesabı, VKN
`1234567890`, HIZIRBEY V.D.). `Gönderen: MERCİ TEKSTİL SAN. VE TİC. LTD. ŞTİ.`,
`Alan Banka: 0015 - Türkiye Vakıflar Bankası`, `Alıcı: ÖZDEN İPLİK DOKUMA SAN. TİC.
A.Ş.`, `Alıcı Hesap: TR00...`. "Hesabınızdan … Çekilmiştir" + gönderen IBAN Merci → outgoing.

```json
{
  "document_type": "payment_receipt",
  "direction": "outgoing",
  "date": "2026-08-26",
  "amount": 236500,
  "currency": "TRY",
  "sender_name": "MERCİ TEKSTİL SAN. VE TİC. LTD. ŞTİ.",
  "receiver_name": "ÖZDEN İPLİK DOKUMA SAN. TİC. A.Ş.",
  "sender_iban": "TR001111222233334444555566",
  "receiver_iban": "TR000015001580073063398610",
  "sender_tax_number": "1234567890",
  "receiver_tax_number": null,
  "invoice_number": null,
  "reference_number": "2383575454",
  "description": "iplik alımı avans ödemesi",
  "subtotal": null,
  "vat_amount": null,
  "total": 236500,
  "due_date": null,
  "confidence": { "document_type": 0.98, "direction": 0.97, "amount": 0.99 }
}
```
Not: `reference_number` = `Fast Sorgu No`. `Toplam Masraf` (komisyon+BSMV+mesaj)
ana tutara dahil edilmez. "avans" → keyword: avans.

### 6.3 Giden kargo ödemesi — VakıfBank "İŞLEM BİLGİLERİ / Hesaptan Havale" (C)
`GONDEREN AD SOYAD/UNVAN: MERCİ TEKSTİL SAN. VE TİC. LTD. ŞTİ.`,
`ALICI AD SOYAD/UNVAN: YURTİÇİ KARGO SERVİSİ A.Ş.`. Dekontta ayrıca `SAYIN`
başlığında operatör "MURAT DEMİR" görünüyor — **taraf değil** (Kural 2).
`İŞLEM AÇIKLAMASI: Ağustos ayı kargo cari ödemesi / Merci Tekstil`.

```json
{
  "document_type": "payment_receipt",
  "direction": "outgoing",
  "date": "2026-08-20",
  "amount": 18750.5,
  "currency": "TRY",
  "sender_name": "MERCİ TEKSTİL SAN. VE TİC. LTD. ŞTİ.",
  "receiver_name": "YURTİÇİ KARGO SERVİSİ A.Ş.",
  "sender_iban": "TR001111222233334444555566",
  "receiver_iban": "TR000001500158000000123456",
  "sender_tax_number": null,
  "receiver_tax_number": null,
  "invoice_number": null,
  "reference_number": "2022003572846205",
  "description": "Ağustos ayı kargo cari ödemesi",
  "subtotal": null,
  "vat_amount": null,
  "total": 18750.5,
  "due_date": null,
  "confidence": { "document_type": 0.96, "direction": 0.9, "amount": 0.97 }
}
```
Not: `reference_number` = `İŞLEM NO`. Alıcı adında `A.Ş.` var → kişi adı ("MURAT
DEMİR", `SAYIN` bloğu) yok sayıldı. "kargo" + "cari ödeme" → keyword: kargo/nakliye.

### 6.4 Kurumsal İnternet Şube dekontu — VKN'li, Kuveyt Türk (B)
`Müşteri Adı: MERCİ TEKSTİL SANAYİ VE TİCARET LİMİTED ŞİRKETİ`, `Vergi Dairesi:
MİMAR SİNAN V.D.`, `TC Kimlik No: 12******90` (aslında VKN, 10 hane).
`Gönderen Kişi: MERCİ TEKSTİL SANAYİ VE TİCARET LİMİTED ŞİRKETİ` (⚠ etiket "Kişi"),
`Gönderilen Kişi: KUZEY AKSESUAR İTHALAT İHRACAT LTD. ŞTİ.`,
`Gönderilen IBAN: TR00...`, `Gönderilen Banka: TÜRKİYE İŞ BANKASI A.Ş.`,
`İşlem Yeri: İnternet Şube`, `İşlem Referansı: MRC12-B-2026082612`.
`Açıklama: 2026/000188 nolu fatura bedeli`.

```json
{
  "document_type": "payment_receipt",
  "direction": "outgoing",
  "date": "2026-08-26",
  "amount": 92340,
  "currency": "TRY",
  "sender_name": "MERCİ TEKSTİL SANAYİ VE TİCARET LİMİTED ŞİRKETİ",
  "receiver_name": "KUZEY AKSESUAR İTHALAT İHRACAT LTD. ŞTİ.",
  "sender_iban": "TR001111222233334444555566",
  "receiver_iban": "TR000006400000110211380059",
  "sender_tax_number": "1234567890",
  "receiver_tax_number": null,
  "invoice_number": "2026/000188",
  "reference_number": "MRC12-B-2026082612",
  "description": "2026/000188 nolu fatura bedeli",
  "subtotal": null,
  "vat_amount": null,
  "total": 92340,
  "due_date": null,
  "confidence": { "document_type": 0.98, "direction": 0.96, "amount": 0.98 }
}
```
Not: `reference_number` = `İşlem Referansı` (Kuveyt Türk'te `Sorgu Numarası` de var,
ama İşlem Referansı daha kalıcı). Açıklamadaki "nolu fatura" → `invoice_number`
ayrıca doldurulur. Etiket "Gönderen Kişi" olmasına rağmen değer LTD ŞTİ → şirket taraf.

### 6.5 Dijital cüzdan transferi — Papara / Enpara
Enpara İşCep motoru (E) baz alındı: tablo `B/A` sütunu `B` → outgoing.
`MÜŞTERİ ÜNVANI: MERCİ TEKSTİL SAN. VE TİC. LTD. ŞTİ.`, `GÖNDEREN: Merci Tekstil`,
`ALICI ÜNVANI: Papara Elektronik Para A.Ş. - Selin Kaya` (cüzdan sahibi kişi + EPK),
`ALICI IBAN: TR00...` (Papara IBAN'ı), `sorgu no: 771002345`.
`AÇIKLAMA: freelance desen çizim ödemesi`.

```json
{
  "document_type": "payment_receipt",
  "direction": "outgoing",
  "date": "2026-08-23",
  "amount": 6500,
  "currency": "TRY",
  "sender_name": "MERCİ TEKSTİL SAN. VE TİC. LTD. ŞTİ.",
  "receiver_name": "Selin Kaya",
  "sender_iban": "TR001111222233334444555566",
  "receiver_iban": "TR000010000000000077100234",
  "sender_tax_number": null,
  "receiver_tax_number": null,
  "invoice_number": null,
  "reference_number": "771002345",
  "description": "freelance desen çizim ödemesi",
  "subtotal": null,
  "vat_amount": null,
  "total": 6500,
  "due_date": null,
  "confidence": { "document_type": 0.9, "direction": 0.85, "amount": 0.95 }
}
```
Not: Alıcı alanında hem "Papara Elektronik Para A.Ş." (EPK altyapısı) hem kişi adı
var → burada EPK **taşıyıcıdır**, gerçek lehtar cüzdan sahibi kişi (Kural 7 mantığı).
`receiver_name` = "Selin Kaya". `reference_number` = `sorgu no`.

### 6.6 Belirsiz — yön isimlerden çıkarılamıyor
Sade havale dekontu, `B/A` yok, başlık yalnızca "HAVALE DEKONTU", sahip işareti yok,
iki taraf da tüzel: `Gönderen: AKÇA TEKSTİL SAN. TİC. LTD. ŞTİ.`,
`Alıcı: MERCİ MODA KONFEKSİYON LTD. ŞTİ.` (isim "MERCİ" içeriyor ama Merci Tekstil
değil, farklı firma), iki IBAN da `MERCI_IBANS` dışında, VKN yok.

```json
{
  "document_type": "payment_receipt",
  "direction": "unknown",
  "date": "2026-08-22",
  "amount": 54000,
  "currency": "TRY",
  "sender_name": "AKÇA TEKSTİL SAN. TİC. LTD. ŞTİ.",
  "receiver_name": "MERCİ MODA KONFEKSİYON LTD. ŞTİ.",
  "sender_iban": "TR000055667788990011223344",
  "receiver_iban": "TR000044556677889900112233",
  "sender_tax_number": null,
  "receiver_tax_number": null,
  "invoice_number": null,
  "reference_number": "884412007",
  "description": "mal bedeli",
  "subtotal": null,
  "vat_amount": null,
  "total": 54000,
  "due_date": null,
  "confidence": { "document_type": 0.95, "direction": 0.3, "amount": 0.97 }
}
```
Not: İsimde "MERCİ" geçmesi zayıf sinyal — IBAN/VKN eşleşmesi yok, `B/A` yok,
fiil yok → `direction = "unknown"`, kullanıcıya sorulur (`conflict`/`ambiguous`
akışı). "mal bedeli" → keyword: fatura/cari (belirsiz).

---

## 8. Kaynaklar (URL)

Gerçek dekont örnekleri:
- https://rizeataturkortaokulu.meb.k12.tr/meb_iys_dosyalar/53/01/712269/dosyalar/2023_05/23190351_Dekont-21.pdf (Yapı Kredi FAST)
- https://www.boutiqueottoman.com/wp-content/uploads/2023/02/Transaction-C6.pdf (Kuveyt Türk)
- https://www.tcf.gov.tr/wp-content/uploads/2022/08/dekont.pdf (VakıfBank)
- https://www.tcf.gov.tr/wp-content/uploads/2022/08/islem-dekontunuz.pdf (İş Bankası / Enpara İşCep)
- https://www.91devresi.org/uploads/Dekont.html.pdf (İş Bankası İşCep iki sütun)
- https://masertak.com/wp-content/uploads/quform/1/2024/02/Dekont.pdf (Ziraat HESAPTAN FAST)

Mevzuat / şablon:
- https://todeb.org.tr/source/Mevzuat/Elektronik%20Para%20Kurulu%C5%9Fu%20Taraf%C4%B1ndan%20M%C3%BC%C5%9Fteriye%20Verilmesi%20Gereken%20Dekontun%20%C4%B0%C3%A7ermesi%20Gereken%20Asgari%20Unsurlar.pdf (EPK dekont asgari unsurlar, Kasım 2024)
- https://www.turmob.org.tr/arsiv/mbs/resmigazete/-e-DekontK%C4%B1lavuz.pdf (e-Dekont kılavuzu)

Banka yardım / açıklama sayfaları:
- https://www.isbank.com.tr/e-dekont-sorgulama
- https://www.garantibbva.com.tr/sikca-sorulan-sorular/odemeler
- https://www.garantibbva.com.tr/sikca-sorulan-sorular/dijital-bankacilik
- https://www.akbank.com/odeme-para-transferi/odemeler/guvenli-odeme-sistemi
- https://www.halkbank.com.tr/tr/dijital-bankacilik/mobil-bankacilik/halkbank-mobil/yenilikler/fast-islemleri
- https://www.qnb.com.tr/sss/internet-subesi/islemler
- https://bireysel.ziraatbank.com.tr/Transactions/General/GenericFaqPage.aspx
- https://www.enpara.com/bilgi-bankasi/eft-havale-ve-para-transferleri
- https://topluluk.papara.com/t/papara-referans-numarasina-nerden-bakabilirim/14389

Genel / sektör:
- https://www.parasut.com/blog/dekont-ve-e-dekont-nedir-nasil-alinir
- https://www.enuygunfinans.com/finans-rehberi/banka-dekontu-nedir-ve-uzerinde-neler-yer-alir/
- https://multinet.com.tr/blog/vergi-muhasebe/dekont-e-dekont-farki-nedir
- https://www.edenred.com.tr/dekont-ve-e-dekont-nedir-nasil-alinir
- https://www.milliyet.com.tr/ekonomi/eekont-nedir-nasil-alinir-banka-dekontlarinda-dekont-no-nerede-yazar-6446182
- https://www.yurticikargo.com/urun-ve-hizmetler/ozel-cozum-ve-hizmetler/tahsilatli-gonderi
- https://ozgurhukukdanismanlik.com/makaleler-borclar-hukuku/havale-ile-gonderilen-paralarda-aciklama-kisminin-bos-birakilmasi-halinde-havale
