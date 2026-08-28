// analyze_panel.py'nin JS portu. Ham panel verisinden kompakt "yonetim sinyalleri"
// metni uretir. Karar VERMEZ, sadece gecikme/tahsilat acigi/geciken gorev-takip gibi
// ham sinyalleri listeler. Bu metin modele gonderilir (ham panel-data.json degil).

function d(s) {
  if (!s) return null;
  const m = String(s).slice(0, 10);
  const dt = new Date(m + 'T00:00:00Z');
  return isNaN(dt.getTime()) ? null : dt;
}
function daysBetween(a, b) {
  return Math.round((a.getTime() - b.getTime()) / 86400000);
}
function tl(n) {
  return (Math.round(n || 0)).toLocaleString('tr-TR') + ' TL';
}
function ymd(dt) { return dt.toISOString().slice(0, 10); }
function ym(s) { return String(s || '').slice(0, 7); }

// today: 'YYYY-MM-DD' string veya Date. Yoksa sistem gunu.
function buildSignals(data, today) {
  data = data || {};
  const T = (today ? d(today) : null) || d(ymd(new Date()));
  const out = [];
  const p = (s) => out.push(s);

  p('# Yonetim Sinyalleri');
  p('# Bugun: ' + ymd(T));
  p('');

  const cust = {};
  (data.customers || []).forEach((c) => { cust[c.id] = c.name; });

  // ---- URETIM ----
  p('## URETIM (uretimTakip)');
  (data.uretimTakip || []).forEach((u) => {
    if (u.status === 'Teslim Edildi') return;
    const est = d(u.est_delivery);
    const gec = est ? daysBetween(T, est) : null;
    let flag = '';
    if (gec != null && gec > 0) flag = 'GECIKME';
    else if (gec != null && gec >= -3) flag = 'YAKIN';
    const name = String(u.customer_name || '').trim();
    p('  [' + (flag || 'akis') + '] ' + name + ' | durum=' + (u.status || '-') +
      ' | tah.teslim=' + (u.est_delivery || '-') + ' (' + (gec != null ? (gec > 0 ? '+' : '') + gec + ' gun' : '-') + ')' +
      ' | adet=' + (u.quantity != null ? u.quantity : '-') +
      ' | problem=' + (u.problem_note || '-') +
      (u.note ? ' | not=' + u.note : ''));
  });

  // ---- ISLER / TAHSILAT ----
  p('');
  p('## ISLER (jobs) - uretimde olanlar ve tahsilat acigi');
  let openCiro = 0, openAcik = 0;
  (data.jobs || []).forEach((j) => {
    if (j.status !== 'Uretimde' && j.status !== 'Üretimde') return;
    const tot = (j.quantity || 0) * (j.unit_price || 0);
    const dep = j.deposit_received || 0;
    openCiro += tot;
    openAcik += tot - dep;
    const name = cust[j.customer_id] || j.customer_name_free || '?';
    const kaporaFlag = dep === 0 ? '  <-- KAPORA YOK' : '';
    p('  ' + (j.job_no || '?') + ' | ' + name + ' | ' + (j.product_type || '-') + ' x' + (j.quantity != null ? j.quantity : '-') +
      ' | tutar=' + tl(tot) + ' | kapora=' + tl(dep) + ' | acik=' + tl(tot - dep) + kaporaFlag +
      (j.problem_note ? ' | problem=' + j.problem_note : ''));
  });
  p('  TOPLAM uretimdeki ciro=' + tl(openCiro) + ' | acik tahsilat=' + tl(openAcik));

  // ---- GOREVLER ----
  p('');
  p('## GOREVLER (tasks)');
  const openT = (data.tasks || []).filter((t) => !t.done);
  const byPerson = {};
  openT.forEach((t) => { const k = t.assigned_to || '?'; byPerson[k] = (byPerson[k] || 0) + 1; });
  const overdue = openT.filter((t) => { const dt = d(t.date); return dt && dt < T; });
  p('  acik=' + openT.length + ' | geciken=' + overdue.length +
    ' | devredilen=' + openT.filter((t) => t.carried_forward).length);
  p('  kisi bazli acik: ' + JSON.stringify(byPerson));
  p('  -- bugun / +2 gun --');
  const soon = openT.filter((t) => {
    const dt = d(t.date);
    if (!dt) return false;
    const gg = daysBetween(dt, T);
    return gg >= 0 && gg <= 2;
  }).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  soon.forEach((t) => p('    ' + (t.date || '-') + ' | ' + (t.assigned_to || '?') + ' | ' + (t.title || '-')));
  p('  -- 7 gunden eski geciken (en eski 12) --');
  overdue.slice().sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(0, 12)
    .forEach((t) => p('    ' + (t.date || '-') + ' | ' + (t.assigned_to || '?') + ' | ' + (t.title || '-')));

  // ---- PIPELINE ----
  p('');
  p('## PIPELINE (acik firsatlar)');
  (data.pipeline || []).forEach((pl) => {
    if (!['Potansiyel', 'Onaylandi', 'Onaylandı'].includes(pl.status)) return;
    const val = (pl.est_quantity || 0) * (pl.est_unit_price || 0);
    const fu = d(pl.follow_up_date);
    const flag = fu && fu < T ? 'TAKIP GECIKTI' : '';
    p('  [' + (flag || 'takip') + '] ' + (pl.customer_name || '-') + ' | ' + (pl.description || '-') +
      ' | ~' + tl(val) + ' | olasilik=' + (pl.probability != null ? pl.probability : '-') +
      ' | takip=' + (pl.follow_up_date || '-') + (pl.note ? ' | ' + pl.note : ''));
  });

  // ---- FINANS ----
  p('');
  p('## FINANS');
  const inc = {}, exp = {};
  (data.incomes || []).forEach((i) => { const m = ym(i.date); inc[m] = (inc[m] || 0) + (i.amount || 0); });
  (data.expenses || []).forEach((e) => { const m = ym(e.date); exp[m] = (exp[m] || 0) + (e.amount || 0); });
  Array.from(new Set([...Object.keys(inc), ...Object.keys(exp)])).sort().forEach((m) => {
    p('  ' + m + ' | gelir=' + tl(inc[m] || 0) + ' | gider=' + tl(exp[m] || 0) + ' | net=' + tl((inc[m] || 0) - (exp[m] || 0)));
  });
  let alacak = 0, borc = 0;
  (data.debts || []).forEach((x) => {
    const bal = (x.amount || 0) - (x.paid_amount || 0);
    if (x.type === 'Alacak') alacak += bal;
    else if (x.type === 'Borc' || x.type === 'Borç') borc += bal;
  });
  p('  Acik alacak=' + tl(alacak) + ' | Acik borc=' + tl(borc));
  (data.debts || []).forEach((x) => {
    const bal = (x.amount || 0) - (x.paid_amount || 0);
    if (bal <= 0) return;
    const due = d(x.due_date);
    let flag = '';
    if (due && due < T) flag = 'VADESI GECMIS';
    else if (due && daysBetween(due, T) <= 14) flag = 'VADE YAKIN';
    p('  [' + (x.type || '-') + '] ' + (x.party_name || '-') + ' | kalan=' + tl(bal) +
      ' | vade=' + (x.due_date || '-') + (flag ? ' ' + flag : ''));
  });
  const unpaidFixed = (data.fixedExpenses || [])
    .map((f) => [f.month_label, f.name, (f.amount || 0) - (f.paid_amount || 0)])
    .filter((r) => r[2] > 0);
  if (unpaidFixed.length) {
    p('  Odenmemis sabit giderler:');
    unpaidFixed.forEach((r) => p('    ' + (r[0] || '-') + ' | ' + (r[1] || '-') + ' | ' + tl(r[2])));
  }

  // ---- HEDEFLER ----
  p('');
  p('## HEDEFLER');
  const curMonth = ymd(T).slice(0, 7);
  p('  Bu ay (' + curMonth + '): gelir=' + tl(inc[curMonth] || 0) + ' | gider=' + tl(exp[curMonth] || 0) +
    ' | net=' + tl((inc[curMonth] || 0) - (exp[curMonth] || 0)));
  (data.hedefler || []).forEach((h) => {
    p('  ' + (h.hedef_adi || '-') + ' | yillik hedef=' + (h.yillik_hedef != null ? Number(h.yillik_hedef).toLocaleString('tr-TR') : '-') +
      ' | gerceklesen=' + (h.gerceklesen_excel != null ? h.gerceklesen_excel : '-') +
      (h.durum_excel ? ' | durum_etiketi=' + h.durum_excel : ''));
  });
  (data.hedeflerAylik || []).forEach((h) => {
    p('  ' + (h.hedef_adi || '-') + ' (aylik) | hedef=' + (h.aylik_hedef != null ? h.aylik_hedef : '-'));
  });

  // ---- OKUL / B2B TAKIP ----
  p('');
  p('## OKUL / KURUMSAL TAKIP');
  (data.okulTakip || []).forEach((o) => {
    const fu = d(o.takip_tarihi);
    const flag = fu && fu < T ? 'TAKIP GECIKTI' : '';
    p('  [' + (flag || 'takip') + '] ' + (o.okul_adi || '-') + ' | ' + (o.gorusme_durumu || '-') +
      ' | takip=' + (o.takip_tarihi || '-'));
  });
  (data.okulMail || []).forEach((o) => {
    if (['Gorusuldu', 'Görüşüldü'].includes(o.donus_durumu)) {
      p('  MAIL DONUS VAR -> ' + (o.okul_adi || '-') + ' (' + (o.ilgili_birim || '-') + ') - teklife cevrilmeli');
    }
  });

  return out.join('\n');
}

module.exports = { buildSignals };
