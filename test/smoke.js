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
    const r = actions.applyAction('create_task', { title: 'smoke test', assigned_to: 'erdem', date: '2026-08-29' });
    assert(/Görev #\d+/.test(r.summary));
  });
  ok('unknown action reddedilir', () => {
    assert.throws(() => actions.applyAction('nuke', {}));
  });
  ok('confirm risk siniflari dogru', () => {
    assert.strictEqual(actions.riskOf('add_expense'), 'confirm');
    assert.strictEqual(actions.riskOf('create_task'), 'safe');
    assert.strictEqual(actions.riskOf('delete_task'), 'confirm');
  });
  // temizle
  const raw = store.readPanelRaw();
  raw.data.tasks = raw.data.tasks.filter((t) => t.title !== 'smoke test');
  store.writePanelData(raw.data);

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

  console.log('\n=== ' + pass + ' gecti, ' + fail + ' basarisiz ===');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('smoke HATA:', e); process.exit(1); });
