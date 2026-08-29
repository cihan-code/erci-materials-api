Bir lead için Merci Tekstil'den gönderilecek **ilk temas mailinin taslağını** yaz. Bu bir SATIŞ
maili ama soğuk/spam değil — kurumsal, kısa, saygılı.

## Gönderen
Merci Tekstil · `info@mercitex.com` · Satış: Mert Kıvanç Tekin

## Kişiselleştirme
Lead'in kurumuna göre aç: kurum adını, tipini, varsa yaklaşan ihtiyacı (etkinlik, dönem başı,
mezuniyet) kullan. Genel şablon gibi durmasın. Sosyal medya özeti verildiyse ondan somut bir
detay kullan.

## Yapı
- **Konu:** 4-7 kelime, net, kurumsal. Örn: "Merci Tekstil – kulüp/okul özel üretim iş birliği".
  ALL CAPS yok, "!!!" yok, "ÜCRETSİZ" yok.
- **Selamlama:** ilgili kişi adı varsa "Sayın [Ad] [Unvan]", yoksa "Merhaba," / "Sayın [Kurum] yetkilisi,".
- **1. paragraf (2-3 cümle):** kim olduğumuz + neden yazdığımız. Merci'nin farkı: düşük-orta
  adetli özel işler, teslim tarihine sadakat, numune, tek muhatap.
- **2. paragraf (2-3 cümle):** bu kuruma özgü değer (kulüp tişörtü / okul forması / etkinlik teksti;
  bütçe dostu, tasarım revizyonu, zamanında teslim).
- **Kapanış:** TEK net çağrı — "kısa bir görüşme" veya "numune/fiyat listesi paylaşımı". Telefon/mail.
- **İmza:** Mert Kıvanç Tekin, Merci Tekstil, info@mercitex.com, (telefon placeholder [TELEFON]).

## Anti-spam kontrol listesi (uy)
- Toplam 120-180 kelime. Kısa.
- En fazla 1 link (varsa web sitesi). Görsel yok, ek yok.
- Aciliyet baskısı yok, indirim çığırtkanlığı yok.
- "size özel fırsat", "kaçırmayın", "hemen" gibi ifadeler yok.
- Yalın, tek yazı tipi, düz metin.

## Çıktı
YALNIZ JSON:
```json
{ "konu": "...", "govde": "...", "notlar": "hangi kişiselleştirme kullanıldı / eksik bilgi" }
```
İletişim maili yoksa yine taslağı yaz ama notlar'da "gönderilecek mail adresi bulunamadı" yaz.
Kişi adı/unvan uydurma.
