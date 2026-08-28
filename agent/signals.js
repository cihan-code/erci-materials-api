// analyze_panel.py'nin JS portu - DOMAIN BAZLI.
// Ham panel-data.json modele ASLA gonderilmez. Her istek yalniz ihtiyaci olan domain'in
// kompakt sinyal metnini alir:
//   production  -> uretimTakip + uretimdeki jobs
//   tasks       -> tasks
//   sales       -> pipeline + okulTakip + okulMail
//   crm         -> customers (ozet) + son teslim edilen isler
//   finance     -> aylik gelir/gider/net + alacak/borc + sabit gider + hedefler
//
// buildSignals(data, today, ['production','tasks']) -> sadece o iki blogu birlestirir.
// domain listesi verilmezse hepsi (geriye donuk uyumluluk).

function d(s) {
  if (!s) return null;
  const m = String(s).slice(0, 10);
  const dt = new Date(m + 'T00:00:00Z');
  return isNaN(dt.getTime()) ? null : dt;
}
function daysBetween(a, b) { return Math.round((a.getTime() - b.getTime()) / 86400000); }
function tl(n) { return (Math.round(n || 0)).toLocaleString('tr-TR') + ' TL'; }
function ymd(dt) { return dt.toISOString().slice(0, 10); }
function ym(s) { return String(s || '').slice(0, 7); }

function custMap(data) {
  const m = {};
  (data.customers || []).forEach((c) => { m[c.id] = c.name; });
  return m;
}

// Panel uzun durum etiketlerini temiz kisa forma cevir (model kisaltma uydurmasın).
function cleanStatus(s) {
  const map = {
    'Ütü-Pakette-Teslimat Bekliyor': 'Ütü-Paket (teslimat bekliyor)',
    'Ütü-Paket-Teslimat Bekliyor': 'Ütü-Paket (teslimat bekliyor)',
  };
  return map[String(s || '').trim()] || String(s || '').trim() || '-';
}

// ---------------- PRODUCTION ----------------
function production(data, T) {
  const out = ['## URETIM (uretimTakip - acik kayitlar)'];
  const cust = custMap(data);
  (data.uretimTakip || []).forEach((u) => {
    if (u.status === 'Teslim Edildi') return;
    const est = d(u.est_delivery);
    const gec = est ? daysBetween(T, est) : null;
    let flag = '';
    if (gec != null && gec > 0) flag = 'GECIKME';
    else if (gec != null && gec >= -3) flag = 'YAKIN';
    out.push('  [' + (flag || 'akis') + '] id=' + (u.id != null ? u.id : '-') +
      ' | ' + String(u.customer_name || '').trim() +
      ' | durum=' + cleanStatus(u.status) +
      ' | tah.teslim=' + (u.est_delivery || '-') + ' (' + (gec != null ? (gec > 0 ? '+' : '') + gec + ' gun' : '-') + ')' +
      ' | adet=' + (u.quantity != null ? u.quantity : '-') +
      ' | problem=' + (u.problem_note || '-') +
      (u.note ? ' | not=' + u.note : ''));
  });

  out.push('');
  out.push('## ISLER (jobs - status=Uretimde, tahsilat acigi)');
  let openCiro = 0, openAcik = 0;
  (data.jobs || []).forEach((j) => {
    if (j.status !== 'Uretimde' && j.status !== 'Üretimde') return;
    const tot = (j.quantity || 0) * (j.unit_price || 0);
    const dep = j.deposit_received || 0;
    openCiro += tot; openAcik += tot - dep;
    const name = cust[j.customer_id] || j.customer_name_free || '?';
    out.push('  ' + (j.job_no || '?') + ' | id=' + (j.id != null ? j.id : '-') + ' | ' + name +
      ' | ' + (j.product_type || '-') + ' x' + (j.quantity != null ? j.quantity : '-') +
      ' | tutar=' + tl(tot) + ' | kapora=' + tl(dep) + ' | acik=' + tl(tot - dep) +
      (dep === 0 ? '  <-- KAPORA YOK' : '') +
      (j.problem_note ? ' | problem=' + j.problem_note : ''));
  });
  out.push('  TOPLAM uretimdeki ciro=' + tl(openCiro) + ' | acik tahsilat=' + tl(openAcik));
  return out.join('\n');
}

// ---------------- TASKS ----------------
function tasks(data, T) {
  const out = ['## GOREVLER (tasks)'];
  const openT = (data.tasks || []).filter((t) => !t.done);
  const byPerson = {};
  openT.forEach((t) => { const k = t.assigned_to || '?'; byPerson[k] = (byPerson[k] || 0) + 1; });
  const overdue = openT.filter((t) => { const dt = d(t.date); return dt && dt < T; });
  out.push('  acik=' + openT.length + ' | geciken=' + overdue.length +
    ' | devredilen=' + openT.filter((t) => t.carried_forward).length);
  out.push('  kisi bazli acik: ' + JSON.stringify(byPerson));
  out.push('  -- bugun / +2 gun --');
  openT.filter((t) => { const dt = d(t.date); if (!dt) return false; const g = daysBetween(dt, T); return g >= 0 && g <= 2; })
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .forEach((t) => out.push('    id=' + t.id + ' | ' + (t.date || '-') + ' | ' + (t.assigned_to || '?') + ' | ' + (t.title || '-')));
  out.push('  -- geciken (en eski 15) --');
  overdue.slice().sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(0, 15)
    .forEach((t) => out.push('    id=' + t.id + ' | ' + (t.date || '-') + ' | ' + (t.assigned_to || '?') + ' | ' + (t.title || '-')));
  return out.join('\n');
}

// ---------------- SALES ----------------
function sales(data, T) {
  const out = ['## PIPELINE (acik firsatlar)'];
  (data.pipeline || []).forEach((pl) => {
    if (!['Potansiyel', 'Onaylandi', 'Onaylandı'].includes(pl.status)) return;
    const val = (pl.est_quantity || 0) * (pl.est_unit_price || 0);
    const fu = d(pl.follow_up_date);
    const flag = fu && fu < T ? 'TAKIP GECIKTI' : '';
    out.push('  [' + (flag || 'takip') + '] id=' + (pl.id != null ? pl.id : '-') +
      ' | ' + (pl.customer_name || '-') + ' | ' + (pl.description || '-') +
      ' | ~' + tl(val) + ' | olasilik=' + (pl.probability != null ? pl.probability : '-') +
      ' | takip=' + (pl.follow_up_date || '-') + (pl.note ? ' | ' + pl.note : ''));
  });
  out.push('');
  out.push('## OKUL / KURUMSAL TAKIP');
  (data.okulTakip || []).forEach((o) => {
    const fu = d(o.takip_tarihi);
    out.push('  [' + (fu && fu < T ? 'TAKIP GECIKTI' : 'takip') + '] id=' + (o.id != null ? o.id : '-') +
      ' | ' + (o.okul_adi || '-') + ' | ' + (o.gorusme_durumu || '-') + ' | takip=' + (o.takip_tarihi || '-'));
  });
  (data.okulMail || []).forEach((o) => {
    if (['Gorusuldu', 'Görüşüldü'].includes(o.donus_durumu)) {
      out.push('  MAIL DONUS VAR -> id=' + (o.id != null ? o.id : '-') + ' | ' + (o.okul_adi || '-') +
        ' (' + (o.ilgili_birim || '-') + ') - teklife cevrilmeli');
    }
  });
  return out.join('\n');
}

// ---------------- CRM ----------------
function crm(data, T) {
  const out = ['## MUSTERILER (customers - ozet)'];
  const jobsByCust = {};
  (data.jobs || []).forEach((j) => {
    if (j.customer_id == null) return;
    (jobsByCust[j.customer_id] = jobsByCust[j.customer_id] || []).push(j);
  });
  (data.customers || []).forEach((c) => {
    const js = jobsByCust[c.id] || [];
    const delivered = js.filter((j) => j.status === 'Teslim Edildi' || j.status === 'Tamamlandı');
    const lastOrder = js.map((j) => j.order_date).filter(Boolean).sort().slice(-1)[0] || '-';
    out.push('  id=' + c.id + ' | ' + (c.name || '-') + ' | tip=' + (c.type || '-') +
      ' | kategori=' + (c.category || '-') +
      ' | is sayisi=' + js.length + ' (teslim ' + delivered.length + ')' +
      ' | son siparis=' + lastOrder +
      (c.note ? ' | not=' + String(c.note).slice(0, 120) : ''));
  });
  return out.join('\n');
}

// ---------------- FINANCE ----------------
function finance(data, T) {
  const out = ['## FINANS - aylik akis'];
  const inc = {}, exp = {};
  (data.incomes || []).forEach((i) => { const m = ym(i.date); inc[m] = (inc[m] || 0) + (i.amount || 0); });
  (data.expenses || []).forEach((e) => { const m = ym(e.date); exp[m] = (exp[m] || 0) + (e.amount || 0); });
  Array.from(new Set([...Object.keys(inc), ...Object.keys(exp)])).sort().forEach((m) => {
    out.push('  ' + m + ' | gelir=' + tl(inc[m] || 0) + ' | gider=' + tl(exp[m] || 0) + ' | net=' + tl((inc[m] || 0) - (exp[m] || 0)));
  });

  out.push('');
  out.push('## ALACAK / BORC (debts)');
  let alacak = 0, borc = 0;
  (data.debts || []).forEach((x) => {
    const bal = (x.amount || 0) - (x.paid_amount || 0);
    if (x.type === 'Alacak') alacak += bal;
    else if (x.type === 'Borc' || x.type === 'Borç') borc += bal;
  });
  out.push('  Acik alacak=' + tl(alacak) + ' | Acik borc=' + tl(borc));
  (data.debts || []).forEach((x) => {
    const bal = (x.amount || 0) - (x.paid_amount || 0);
    if (bal <= 0) return;
    const due = d(x.due_date);
    let flag = '';
    if (due && due < T) flag = 'VADESI GECMIS';
    else if (due && daysBetween(due, T) <= 14) flag = 'VADE YAKIN';
    out.push('  [' + (x.type || '-') + '] id=' + (x.id != null ? x.id : '-') + ' | ' + (x.party_name || '-') +
      ' | kalan=' + tl(bal) + ' | vade=' + (x.due_date || '-') + (flag ? ' ' + flag : ''));
  });

  const unpaidFixed = (data.fixedExpenses || [])
    .map((f) => [f.month_label, f.name, (f.amount || 0) - (f.paid_amount || 0)])
    .filter((r) => r[2] > 0);
  if (unpaidFixed.length) {
    out.push('');
    out.push('## ODENMEMIS SABIT GIDERLER');
    unpaidFixed.forEach((r) => out.push('  ' + (r[0] || '-') + ' | ' + (r[1] || '-') + ' | ' + tl(r[2])));
  }

  out.push('');
  out.push('## HEDEFLER');
  const curMonth = ymd(T).slice(0, 7);
  out.push('  Bu ay (' + curMonth + '): gelir=' + tl(inc[curMonth] || 0) + ' | gider=' + tl(exp[curMonth] || 0) +
    ' | net=' + tl((inc[curMonth] || 0) - (exp[curMonth] || 0)));
  (data.hedefler || []).forEach((h) => {
    out.push('  ' + (h.hedef_adi || '-') + ' | yillik hedef=' + (h.yillik_hedef != null ? Number(h.yillik_hedef).toLocaleString('tr-TR') : '-') +
      ' | gerceklesen=' + (h.gerceklesen_excel != null ? h.gerceklesen_excel : '-') +
      (h.durum_excel ? ' | durum_etiketi=' + h.durum_excel : ''));
  });
  (data.hedeflerAylik || []).forEach((h) => {
    out.push('  ' + (h.hedef_adi || '-') + ' (aylik) | hedef=' + (h.aylik_hedef != null ? h.aylik_hedef : '-'));
  });
  return out.join('\n');
}

const DOMAINS = { production, tasks, sales, crm, finance };
const ALL_DOMAINS = Object.keys(DOMAINS);

// domainList verilmezse hepsi. today: 'YYYY-MM-DD' | Date | undefined.
function buildSignals(data, today, domainList) {
  data = data || {};
  const T = (today ? d(today) : null) || d(ymd(new Date()));
  const list = (Array.isArray(domainList) && domainList.length) ? domainList : ALL_DOMAINS;
  const parts = ['# Yonetim Sinyalleri (' + list.join(', ') + ')', '# Bugun: ' + ymd(T), ''];
  list.forEach((name) => {
    const fn = DOMAINS[name];
    if (fn) { parts.push(fn(data, T)); parts.push(''); }
  });
  return parts.join('\n').trim();
}

module.exports = { buildSignals, DOMAINS, ALL_DOMAINS };
