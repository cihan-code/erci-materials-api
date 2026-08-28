// Ucretsiz duman testi. Anthropic API'ye HIC gitmez (AGENT_MOCK=1).
// Kapsam: domain sinyalleri, model yonlendirme, prompt kurulumu, aksiyon uygulama,
//         usage log, /api/agent/* uclari.
//
// Kullanim:
//   node test/smoke.js /yol/panel-snapshot.json
//   (snapshot verilmezse ./data/panel-data.json'u kullanir)

const fs = require('fs');
const path = require('path');
const assert = require('assert');

process.env.AGENT_MOCK = '1';
process.env.DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'mock-key-not-used';
// Belge testleri icin sahte company profile (gercek IBAN/VKN degil)
process.env.MERCI_COMPANY_PROFILE = process.env.MERCI_COMPANY_PROFILE || JSON.stringify({
  names: ['MERCI TEKSTİL SANAYİ VE TİCARET', 'MERCI TEKSTİL', 'Cihan Berber', 'Mert Kıvanç Tekin'],
  vkn: '6160906794', taxOffice: 'PENDİK VERGİ DAİRESİ MÜDÜRLÜĞÜ',
  ibans: ['TR111122223333444455556666'],
});

const DATA_DIR = process.env.DATA_DIR;
const PANEL_FILE = path.join(DATA_DIR, 'panel-data.json');

function seed() {
  const src = process.argv[2];
  if (src) {
    const raw = JSON.parse(fs.readFileSync(src, 'utf8'));
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PANEL_FILE, JSON.stringify({ data: raw.data, auth: raw.auth || {}, updatedAt: raw.updatedAt || new Date().toISOString() }));
    console.log('seed:', src, '->', PANEL_FILE);
  } else if (!fs.existsSync(PANEL_FILE)) {
    throw new Error('panel-data.json yok ve snapshot verilmedi. Kullanim: node test/smoke.js snapshot.json');
  }
}

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); console.log('  OK  ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + ' -> ' + (e && e.message || e)); fail++; }
}

async function main() {
  seed();
  const store = require('../agent/store');
  const { buildSignals, ALL_DOMAINS } = require('../agent/signals');
  const { computeMetrics } = require('../agent/metrics');
  const { generate, OP } = require('../agent/generate');
  const actions = require('../agent/actions');
  const { data } = store.loadPanelData();
  const TODAY = '2026-08-28';

  console.log('\n# 0. metrics.js — deterministik hesaplar (S1..S11)');
  const M = computeMetrics(data, TODAY);
  ok('gorev sayisi carried_forward haric', () => {
    const naive = data.tasks.filter((t) => !t.done).length;
    assert(M.tasks.acikSayisi < naive, 'acik gorev naive ile ayni (' + M.tasks.acikSayisi + ')');
    assert(M.tasks.acikSayisi === data.tasks.filter((t) => !t.done && !t.carried_forward).length);
  });
  ok('aktif is = Onaylandi + Uretimde', () => {
    const exp = data.jobs.filter((j) => ['Onaylandı', 'Üretimde'].includes(j.status)).length;
    assert(M.jobs.aktifSayisi === exp);
  });
  ok('is bagli tahsilat = job_id eslesen incomes', () => {
    const j = M.jobs.aktif.find((x) => x.bagliTahsilat > 0);
    if (j) {
      const sum = data.incomes.filter((i) => i.job_id === j.id).reduce((s, i) => s + i.amount, 0);
      assert(Math.abs(j.bagliTahsilat - sum) < 1);
    }
  });
  ok('S8: probability 0-1 normalize', () => {
    M.sales.acikFirsatlar.forEach((p) => { if (p.olasilik != null) assert(p.olasilik >= 0 && p.olasilik <= 1, 'olasilik ' + p.olasilik); });
  });
  ok('S1: debts alacak ile is tutari ayri alanlar', () => {
    assert(typeof M.finance.debtsAcikAlacak === 'number');
    assert(typeof M.jobs.aktifBagliTahsilatToplam === 'number');
    assert(!('toplamAlacak' in M.finance), 'birlesik toplam alani olmamali');
  });
  ok('S5: aylik yonetim sonucu sabit gideri dusuyor', () => {
    M.finance.aylik.forEach((a) => assert(Math.abs(a.yonetimSonucu - (a.gelir - a.gider - a.sabitGider)) < 1));
  });
  ok('hedef gerceklesen CANLI (gerceklesen_excel degil)', () => {
    const is = M.hedefler.yillik.find((h) => /İş/.test(h.ad));
    if (is) assert(is.gerceklesen === data.jobs.filter((j) => j.status === 'Teslim Edildi').length, 'is hedefi ' + is.gerceklesen);
  });
  ok('dataConfidence dolu ve gercek', () => {
    assert(M.dataConfidence.length >= 4);
    assert(!M.dataConfidence.some((c) => /sayac bozuk|sayaç bozuk/i.test(c)), 'panel sucla­yan madde var');
  });
  console.log('       aktif is:', M.jobs.aktifSayisi, '| acik gorev:', M.tasks.acikSayisi,
    '| acik firsat:', M.sales.acikFirsatSayisi, '| dataConfidence:', M.dataConfidence.length, 'madde');

  console.log('\n# 1. Domain sinyalleri (ham JSON gitmiyor, sayi tablosu)');
  ALL_DOMAINS.forEach((dom) => {
    ok(dom + ' sinyali uretiliyor', () => {
      const s = buildSignals(data, TODAY, [dom]);
      assert(s.length > 20, 'bos sinyal');
      assert(!s.includes('"customer_id":'), 'ham JSON sizmis');
      assert(/DOĞRULANMIŞ METRİK/.test(s), 'metrik tablosu basligi yok');
      console.log('       ~' + Math.round(s.length / 4) + ' token');
    });
  });

  console.log('\n# 2. Rapor uretimi (MOCK - $0)');
  for (const type of Object.keys(OP)) {
    // eslint-disable-next-line no-await-in-loop
    await (async () => {
      try {
        const rec = await generate(type);
        const cfg = OP[type];
        ok(type + ' (' + cfg.tier + ', ' + cfg.domains.join('+') + ')', () => {
          assert(rec && rec.markdown, 'markdown yok');
          assert(rec.meta.costUsd === 0, 'mock maliyet 0 degil');
        });
      } catch (e) { console.log('  FAIL ' + type + ' -> ' + e.message); fail++; }
    })();
  }

  console.log('\n# 3. Panel aksiyonlari (offline, gercek mutasyon)');
  ok('create_task', () => {
    const r = actions.applyAction('create_task', { title: 'smoke test', assigned_to: 'erdem', date: TODAY });
    assert(/Görev #\d+/.test(r.summary));
    assert(/Erdem Küçükarslan/.test(r.summary), 'kisi tam ada cevrilmedi');
  });
  ok('create_task gecersiz kisi reddedilir', () => {
    assert.throws(() => actions.applyAction('create_task', { title: 'x', assigned_to: 'Ahmet' }), /Geçersiz kişi/);
  });
  ok('gecersiz uretim durumu reddedilir', () => {
    assert.throws(() => actions.applyAction('set_production_status', { id: 11, status: 'Kargoda' }), /Geçersiz üretim/);
  });
  ok('unknown action reddedilir', () => {
    assert.throws(() => actions.applyAction('nuke', {}));
  });
  ok('confirm risk siniflari dogru', () => {
    assert.strictEqual(actions.riskOf('add_expense'), 'confirm');
    assert.strictEqual(actions.riskOf('update_debt_payment'), 'confirm');
    assert.strictEqual(actions.riskOf('create_task'), 'safe');
    assert.strictEqual(actions.riskOf('delete_task'), 'confirm');
  });

  console.log('\n# 3b. update_debt_payment DELTA + otomatik gelir (bug fix)');
  ok('odeme paid_amount += delta, silmez', () => {
    const raw = store.readPanelRaw();
    const alacak = raw.data.debts.find((d) => d.type === 'Alacak' && (d.amount - (d.paid_amount || 0)) > 20000);
    assert(alacak, 'test icin uygun alacak yok');
    const oncekiOdenen = alacak.paid_amount || 0;
    const oncekiGelirSayisi = raw.data.incomes.length;
    const r = actions.dryRun('update_debt_payment', { id: alacak.id, odeme_tutari: 10000 });
    // dryRun clone'da calisir - gercek veri degismedi
    const raw2 = store.readPanelRaw();
    assert.strictEqual(raw2.data.debts.find((d) => d.id === alacak.id).paid_amount, oncekiOdenen, 'dryRun gercek veriyi degistirdi!');
    assert.strictEqual(raw2.data.incomes.length, oncekiGelirSayisi, 'dryRun gelir ekledi!');
    assert(/kalan bakiye/i.test(r) && /→/.test(r), 'onizleme kalan bakiye gostermeli: ' + r);
    // simdi gercekten uygula
    actions.applyAction('update_debt_payment', { id: alacak.id, odeme_tutari: 10000 });
    const raw3 = store.readPanelRaw();
    const after = raw3.data.debts.find((d) => d.id === alacak.id);
    assert.strictEqual(after.paid_amount, oncekiOdenen + 10000, 'paid_amount delta ile artmadi: ' + after.paid_amount);
    assert(after.amount - after.paid_amount > 0, 'borc silinmis! kalan: ' + (after.amount - after.paid_amount));
    assert.strictEqual(raw3.data.incomes.length, oncekiGelirSayisi + 1, 'otomatik gelir eklenmedi');
    assert.strictEqual(raw3.data.incomes[0].amount, 10000);
    assert.strictEqual(raw3.data.incomes[0].category, 'Tahsilat');
  });

  // temizle: bu turda eklenen ajan gorevleri + geri al edilemeyen mutasyonlar icin taze seed
  seed();

  console.log('\n# 4. Usage log');
  ok('mock cagrilari $0 loglandi', () => {
    const u = store.readUsage({ limit: 20 });
    const mockCalls = u.entries.filter((e) => e.mock);
    assert(mockCalls.length >= Object.keys(OP).length, 'mock cagri kaydedilmemis');
    assert(u.summary.d30.costUsd < 0.01, 'mock testleri para gostermis: $' + u.summary.d30.costUsd);
  });

  console.log('\n# 5. act.js akisi (MOCK)');
  const { interpretAndAct } = require('../agent/act');
  const out = await interpretAndAct('Fener Dernek Numune uretimini kesimde goster');
  ok('interpretAndAct calisiyor', () => {
    assert(typeof out.reply === 'string');
    assert(Array.isArray(out.applied) && Array.isArray(out.pending));
  });

  console.log('\n# 6. Finansal belge isleme (MOCK Vision, $0)');
  const docs = require('../agent/documents');
  const { extractDocument } = require('../agent/document');
  const { commitDocument } = require('../agent/documentCommit');
  const cp2 = require('../agent/company-profile'); cp2._reset();

  const fakeBuf = (tag) => Buffer.from('FAKE-IMAGE-' + tag + '-' + Math.random());

  // 6a upload + duplicate hash
  const up1 = docs.saveDocument(fakeBuf('inc'), 'gelen-odeme-dekont.png', 'image/png');
  ok('belge yuklendi + sha256', () => { assert(/^[0-9a-f]{64}$/.test(up1.sha256)); assert(!up1.duplicateOf); });
  const sameBuf = Buffer.from('SAME-FILE-BYTES');
  docs.saveDocument(sameBuf, 'x.png', 'image/png');
  const up1b = docs.saveDocument(sameBuf, 'x-again.png', 'image/png');
  ok('ayni dosya -> duplicate uyarisi', () => { assert(up1b.duplicateOf, 'duplicate yakalanmadi'); });
  ok('desteklenmeyen tur reddedilir', () => { assert.throws(() => docs.saveDocument(fakeBuf('h'), 'a.heic', 'image/heic'), /Desteklenmeyen/); });

  // 6b extract (mock fixture) + siniflandirma
  const r1 = await extractDocument(up1.id);
  ok('gelen dekont -> Gelen Ödeme Dekontu, mutasyon YOK', () => {
    assert.strictEqual(r1.classification.humanLabel, 'Gelen Ödeme Dekontu');
    assert.strictEqual(r1.classification.finalDirection, 'incoming');
    assert.strictEqual(r1.status, 'extracted'); // committed degil
    const pd = store.readPanelRaw();
    assert.strictEqual((pd.data.incomes || []).filter((i) => i.document_id).length, 0, 'extract finans kaydi olusturdu!');
  });

  const upPI = docs.saveDocument(fakeBuf('pi'), 'alis-faturasi.png', 'image/png');
  const rPI = await extractDocument(upPI.id);
  ok('alis faturasi -> Gelen / Alış Faturası', () => assert.strictEqual(rPI.classification.humanLabel, 'Gelen / Alış Faturası'));

  const upCF = docs.saveDocument(fakeBuf('cf'), 'celiski-dekont.png', 'image/png');
  const rCF = await extractDocument(upCF.id);
  ok('isim kanıtı vs model çelişkisi -> needsUserDecision', () => {
    assert.strictEqual(rCF.classification.needsUserDecision, true);
    assert.strictEqual(rCF.classification.finalDirection, 'incoming'); // isim kanıtı kazanır
  });
  const upSO = docs.saveDocument(fakeBuf('so'), 'guclu-override-dekont.png', 'image/png');
  const rSO = await extractDocument(upSO.id);
  ok('güçlü IBAN kanıtı modeli EZER, kullanıcıya sormaz', () => {
    assert.strictEqual(rSO.classification.finalDirection, 'incoming'); // receiver IBAN = Merci
    assert.strictEqual(rSO.classification.needsUserDecision, false);
    assert.strictEqual(rSO.classification.counterparty.name, 'PARLAK GİYİM PERAKENDE TİC. LTD. ŞTİ.');
    assert.strictEqual(rSO.classification.categoryHint, 'Kalan Tahsilat');
  });

  // 6c commit ONAY olmadan reddedilir
  ok('confirm olmadan commit reddedilir', () => {
    assert.throws(() => commitDocument(up1.id, { fields: r1.extraction }), /confirm/);
  });

  // 6d gelen dekont commit -> income kaydi (kullanici kategori secer)
  const incBefore = store.readPanelRaw().data.incomes.length;
  const c1 = commitDocument(up1.id, {
    confirm: true,
    fields: { finalType: 'payment_receipt', finalDirection: 'incoming', date: '2026-08-25', total: 78500, currency: 'TRY', counterparty_name: 'ABC KULÜP DERNEĞİ', reference_number: 'DKT-2026-55512' },
    financeCategory: 'Kalan Tahsilat',
  });
  ok('gelen dekont commit -> income', () => {
    assert(c1.ok && c1.created.some((x) => x.kind === 'income'));
    const pd = store.readPanelRaw();
    assert.strictEqual(pd.data.incomes.length, incBefore + 1);
    const inc = pd.data.incomes[0];
    assert.strictEqual(inc.amount, 78500);
    assert.strictEqual(inc.category, 'Kalan Tahsilat');
    assert.strictEqual(inc.document_id, up1.id);
    assert.strictEqual(docs.getDocument(up1.id).status, 'committed');
  });
  ok('islenmis belge tekrar commit edilemez', () => {
    assert.throws(() => commitDocument(up1.id, { confirm: true, fields: { finalType: 'payment_receipt', finalDirection: 'incoming', total: 1 } }), /zaten işlendi/);
  });

  // 6e satis faturasi commit -> invoice kaydi
  const upSI = docs.saveDocument(fakeBuf('si'), 'satis-faturasi.png', 'image/png');
  const rSI = await extractDocument(upSI.id);
  const c2 = commitDocument(upSI.id, {
    confirm: true,
    fields: { finalType: 'invoice', finalDirection: 'outgoing', date: '2026-08-22', total: 120000, subtotal: 100000, vat_amount: 20000, currency: 'TRY', counterparty_name: 'İTÜ ROVER KULÜBÜ', invoice_number: 'MRC2026000045', tax_number: '9998887776', due_date: '2026-09-21' },
  });
  let salesInvId;
  ok('satis faturasi commit -> invoice (Tahsil Edilmedi)', () => {
    assert(c2.created.some((x) => x.kind === 'invoice'));
    const iv = store.readPanelRaw().data.invoices[0];
    salesInvId = iv.id;
    assert.strictEqual(iv.direction, 'outgoing');
    assert.strictEqual(iv.total_amount, 120000);
    assert.strictEqual(iv.paid_amount, 0);
  });
  ok('ayni fatura no + VKN -> duplicate onayi ister', () => {
    const upDup = docs.saveDocument(fakeBuf('dup'), 'satis-faturasi.png', 'image/png');
    const rr = commitDocument(upDup.id, { confirm: true, fields: { finalType: 'invoice', finalDirection: 'outgoing', total: 120000, counterparty_name: 'İTÜ ROVER KULÜBÜ', invoice_number: 'MRC2026000045', tax_number: '9998887776' } });
    assert.strictEqual(rr.needsDuplicateConfirm, true);
  });

  // 6f kismi tahsilat: 50.000 gelen dekont, satis faturasina bagli
  const upPay = docs.saveDocument(fakeBuf('pay'), 'gelen-odeme-dekont.png', 'image/png');
  await extractDocument(upPay.id);
  const c3 = commitDocument(upPay.id, {
    confirm: true,
    fields: { finalType: 'payment_receipt', finalDirection: 'incoming', date: '2026-08-28', total: 50000, currency: 'TRY', counterparty_name: 'İTÜ ROVER KULÜBÜ' },
    financeCategory: 'Kalan Tahsilat',
    links: { invoice_id: salesInvId },
  });
  ok('kismi tahsilat: fatura paid_amount += 50.000, kalan 70.000, Kısmi', () => {
    assert(c3.created.some((x) => x.kind === 'invoice_collection'));
    const { enrich } = require('../agent/invoices');
    const iv = enrich(store.readPanelRaw().data.invoices.find((x) => x.id === salesInvId));
    assert.strictEqual(iv.paid_amount, 50000);
    assert.strictEqual(iv.remaining_amount, 70000);
    assert.strictEqual(iv.status, 'Kısmi Tahsil Edildi');
  });

  // 6f2 karsi taraf adi + kategori onerisi (kullanicinin bildirdigi buglar)
  console.log('\n# 6f2 Dekont: karşı taraf + kategori');
  const { suggestCategory } = require('../agent/financeCategory');
  const upCargo = docs.saveDocument(fakeBuf('cargo'), 'giden-kargo-dekont.png', 'image/png');
  const rCargo = await extractDocument(upCargo.id);
  ok('giden kargo dekontu: yön outgoing, karşı taraf = kargo firması (kişi adı DEĞİL)', () => {
    assert.strictEqual(rCargo.classification.finalDirection, 'outgoing');
    assert.strictEqual(rCargo.classification.humanLabel, 'Yapılan Ödeme Dekontu');
    assert.strictEqual(rCargo.classification.counterparty.name, 'BASİT KARGO LOJİSTİK A.Ş.');
    assert.notStrictEqual(rCargo.classification.counterparty.name, 'Cihan Berber');
  });
  ok('kategori önerisi açıklamadan: "kargo gönderi bedeli" -> Kargo/Kurye', () => {
    assert.strictEqual(rCargo.classification.categoryHint, 'Kargo/Kurye');
  });
  const upVak = docs.saveDocument(fakeBuf('vak'), 'vakif-kargo-imza-dekont.png', 'image/png');
  const rVak = await extractDocument(upVak.id);
  ok('imza/operatör adı ayıklanır: "... LTD. ŞTİ. / MURAT DEMİR" -> şirket', () => {
    assert.strictEqual(rVak.extraction.sender_name, 'MERCİ TEKSTİL SANAYİ VE TİCARET LTD. ŞTİ.');
    assert.strictEqual(rVak.classification.finalDirection, 'outgoing');
    assert.strictEqual(rVak.classification.counterparty.name, 'YURTİÇİ KARGO SERVİSİ A.Ş.');
    assert.strictEqual(rVak.classification.categoryHint, 'Kargo/Kurye');
  });
  ok('suggestCategory: kapora/kalan/kira/maaş/vergi', () => {
    assert.strictEqual(suggestCategory('incoming', 'kapora ödemesi'), 'Kapora');
    assert.strictEqual(suggestCategory('incoming', 'kalan bakiye'), 'Kalan Tahsilat');
    assert.strictEqual(suggestCategory('incoming', 'sipariş için gönderim'), null);
    assert.strictEqual(suggestCategory('outgoing', 'ağustos kira'), 'Kira');
    assert.strictEqual(suggestCategory('outgoing', 'personel maaş'), 'Maaş');
    assert.strictEqual(suggestCategory('outgoing', 'kdv beyanname'), 'Vergi');
  });
  ok('giden dekont commit: gider kategorisi doğrulanır (geçersiz -> Diğer)', () => {
    const n0 = store.readPanelRaw().data.expenses.length;
    const cc = commitDocument(upCargo.id, {
      confirm: true,
      fields: { finalType: 'payment_receipt', finalDirection: 'outgoing', date: '2026-08-27', total: 2450, currency: 'TRY', counterparty_name: 'BASİT KARGO LOJİSTİK A.Ş.', reference_number: 'EFT-20260827-441' },
      financeCategory: 'Kargo/Kurye',
    });
    assert(cc.ok);
    const exp = store.readPanelRaw().data.expenses[0];
    assert.strictEqual(exp.category, 'Kargo/Kurye');
    assert.strictEqual(store.readPanelRaw().data.expenses.length, n0 + 1);
    assert.strictEqual(exp.payee, 'BASİT KARGO LOJİSTİK A.Ş.');
  });
  ok('giden dekont commit: geçersiz gider kategorisi -> Diğer', () => {
    const upX = docs.saveDocument(fakeBuf('cargo2'), 'giden-kargo-2.png', 'image/png');
    // eslint-disable-next-line no-unused-vars
    const cc = commitDocument(upX.id, {
      confirm: true,
      fields: { finalType: 'payment_receipt', finalDirection: 'outgoing', total: 100, counterparty_name: 'X', reference_number: 'r1' },
      financeCategory: 'Uyduruk Kategori',
    });
    assert.strictEqual(store.readPanelRaw().data.expenses[0].category, 'Diğer');
  });

  seed();

  // 6g URETIM FORMU -> Is Takip (finansa gitmez)
  console.log('\n# 6g Üretim Formu (MOCK)');
  const { recomputeProdForm } = require('../agent/document');
  const upUF = docs.saveDocument(fakeBuf('uf'), 'MRC-101-uretim-form.png', 'image/png');
  const rUF = await extractDocument(upUF.id);
  ok('uretim formu -> Üretim Formu, yon yok, finans mutasyonu YOK', () => {
    assert.strictEqual(rUF.classification.finalType, 'production_form');
    assert.strictEqual(rUF.classification.humanLabel, 'Üretim Formu');
    assert.strictEqual(rUF.classification.finalDirection, null);
    assert.strictEqual(rUF.status, 'extracted');
    const pd = store.readPanelRaw();
    assert.strictEqual((pd.data.incomes || []).filter((i) => i.document_id === upUF.id).length, 0);
    assert.strictEqual((pd.data.expenses || []).filter((e) => e.document_id === upUF.id).length, 0);
  });
  ok('uretim formu -> sablon eslesti (Sweatshirt), adetler hesaplandi', () => {
    const pc = rUF.prodComputation || {};
    assert(pc.quantities && pc.quantities.totalQty === 40);
    assert(pc.costMatch && pc.costMatch.templateMatch && pc.costMatch.templateMatch.name === 'Sweatshirt');
  });

  const upUFX = docs.saveDocument(fakeBuf('ufx'), 'MRC-102-uretim-form-istisna.png', 'image/png');
  const rUFX = await extractDocument(upUFX.id);
  ok('istisna: "2 L bedende sırt baskısı yok" -> sırt 18, göğüs/kol 20', () => {
    const q = rUFX.prodComputation.quantities;
    assert.strictEqual(q.printCounts['göğüs'], 20);
    assert.strictEqual(q.printCounts['kol'], 20);
    assert.strictEqual(q.printCounts['sırt'], 18);
    assert(q.unresolved.length >= 1, 'cozulemeyen talimat isaretlenmedi');
  });
  ok('istisna: Şort sablonu yok -> manuel maliyet/fiyat gerekli', () => {
    assert.strictEqual(rUFX.prodComputation.costMatch.needsManual, true);
  });

  ok('recompute: baski boyutu secilince maliyet kalemi olusur', () => {
    const rr = recomputeProdForm(upUF.id, { chosenSizes: { baski: { 'göğüs': 'Orta Boyut' }, nakis: { 'sol kol': 'Küçük Boyut' } } });
    const items = rr.prodComputation.costMatch.costItems || [];
    assert(items.some((it) => /Baskı/.test(it.category)), 'baski kalemi yok');
    assert(rr.prodComputation.costMatch.costTotal > 0);
  });
  ok('recompute: bir bölgede BİRDEN FAZLA baskı -> ayrı kalemler', () => {
    const rr = recomputeProdForm(upUF.id, { bnItems: [
      { type: 'baski', area: 'göğüs', size: 'Küçük Boyut', label: 'logo' },
      { type: 'baski', area: 'göğüs', size: 'Orta Boyut', label: 'yazı' },
      { type: 'nakis', area: 'sol kol', size: 'Küçük Boyut' },
    ] });
    const baskis = (rr.prodComputation.costMatch.costItems || []).filter((it) => /^Baskı/.test(it.category));
    assert.strictEqual(baskis.length, 2, 'göğüs için 2 ayrı baskı kalemi bekleniyordu, ' + baskis.length + ' bulundu');
    assert(rr.prodComputation.costMatch.baskiNakisItems.filter((x) => x.area === 'göğüs').length === 2);
  });

  ok('confirm olmadan uretim formu commit reddedilir', () => {
    assert.throws(() => commitDocument(upUF.id, { fields: { finalType: 'production_form', order_no: 'MRC-101' } }), /confirm/);
  });

  const jobsBefore = store.readPanelRaw().data.jobs.length;
  const cUF = commitDocument(upUF.id, {
    confirm: true,
    fields: { finalType: 'production_form', order_no: 'MRC-101', order_title: 'Kulüp Sweatshirt', product_type: 'Sweatshirt', total_quantity: 40, unit_price: 700, status: 'Onaylandı', delivery_date: '2026-09-15', cost_items: [{ category: 'Kumaş', amount: 8064 }] },
    links: { customer_id: null },
  });
  ok('uretim formu commit -> yeni is (jobs) kaydi', () => {
    assert(cUF.ok && cUF.created.some((x) => x.kind === 'job'));
    const pd = store.readPanelRaw();
    assert.strictEqual(pd.data.jobs.length, jobsBefore + 1);
    const j = pd.data.jobs.find((x) => x.id === cUF.jobId);
    assert.strictEqual(j.job_no, 'MRC-101');
    assert.strictEqual(j.quantity, 40);
    assert.strictEqual(j.unit_price, 700);
    assert.strictEqual(j.document_id, upUF.id);
    assert.strictEqual(docs.getDocument(upUF.id).status, 'committed');
  });

  const upUF2 = docs.saveDocument(fakeBuf('uf2'), 'MRC-101-uretim-form.png', 'image/png');
  await extractDocument(upUF2.id);
  ok('ayni Sipariş No -> ikinci is otomatik acilmaz, karar sorulur', () => {
    const rr = commitDocument(upUF2.id, { confirm: true, fields: { finalType: 'production_form', order_no: 'MRC-101', product_type: 'Sweatshirt', total_quantity: 40 } });
    assert(rr.needsExistingJobDecision && rr.needsExistingJobDecision.jobNo === 'MRC-101');
    assert.notStrictEqual(docs.getDocument(upUF2.id).status, 'committed');
  });
  ok('karar "update" -> mevcut is guncellenir, yeni kayit yok', () => {
    const n = store.readPanelRaw().data.jobs.length;
    const rr = commitDocument(upUF2.id, { confirm: true, existingJobAction: 'update', fields: { finalType: 'production_form', order_no: 'MRC-101', product_type: 'Sweatshirt', total_quantity: 45, unit_price: 720 } });
    assert(rr.ok);
    const pd = store.readPanelRaw();
    assert.strictEqual(pd.data.jobs.length, n);
    assert.strictEqual(pd.data.jobs.find((x) => x.id === rr.jobId).quantity, 45);
  });

  seed(); // belge testi mutasyonlarini geri al

  console.log('\n=== ' + pass + ' gecti, ' + fail + ' basarisiz ===');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('smoke HATA:', e); process.exit(1); });
