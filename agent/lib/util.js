// Ortak kucuk yardimcilar - TEK KAYNAK. Eskiden round2/nextId/todayISO 4-5 dosyada
// ayri ayri tanimliydi ve bir yerde ince fark (nextId'de finite kontrolu eksik) vardi.

function round2(v) { return Math.round((v || 0) * 100) / 100; }

function todayISO() { return new Date().toISOString().slice(0, 10); }

function isISODate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }

function daysBetween(a, b) { return Math.round((a.getTime() - b.getTime()) / 86400000); }

// Bir dizide sonraki benzersiz sayisal id. Sayi olmayan / eksik id'ler yok sayilir
// (panelin eski Math.max(...ids)+1'i burada NaN uretebiliyordu).
function nextId(arr) {
  let mx = 0;
  (arr || []).forEach((x) => { const n = Number(x && x.id); if (Number.isFinite(n) && n > mx) mx = n; });
  return mx + 1;
}

// Turkiye kalici UTC+3 (2016'dan beri yaz saati yok). Bir ts'in ISTANBUL takvim gunu.
const IST_OFFSET_MS = 3 * 60 * 60 * 1000;
function istanbulDay(ts) {
  const ms = (ts instanceof Date ? ts.getTime() : new Date(ts).getTime());
  if (!Number.isFinite(ms)) return '';
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

module.exports = { round2, todayISO, isISODate, daysBetween, nextId, istanbulDay, IST_OFFSET_MS };
