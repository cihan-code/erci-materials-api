// Satis Ajani (SDR) duman testi - Anthropic API'ye HIC gitmez (AGENT_MOCK=1).
//   node test/sdr.js /yol/panel-snapshot.json   (yoksa ./data/panel-data.json)

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
  } else if (!fs.existsSync(PANEL_FILE)) {
    throw new Error('panel-data.json yok ve snapshot verilmedi.');
  }
}

let pass = 0; let fail = 0;
function ok(name, fn) {
  try { fn(); console.log('  OK  ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + ' -> ' + (e && e.message || e)); fail++; }
}

async function main() {
  seed();
  const store = require('../agent/store');
  const sdrStore = require('../agent/sdr/store');
  const { runResearch } = require('../agent/sdr/research');
  const { scoreCandidates } = require('../agent/sdr/score');
  const { researchAndScore } = require('../agent/sdr/flow');
  const { draftEmail } = require('../agent/sdr/email');
  const leads = require('../agent/sdr/leads');
  const { validatePanelData } = require('../agent/panelSchema');

  console.log('\n# 1. Araştırma (MOCK web_search, $0)');
  const rec = await researchAndScore({ query: 'İstanbul üniversite kulüpleri', city: 'İstanbul' });
  ok('araştırma logu kaydedildi, adaylar var', () => {
    assert(rec.id && Array.isArray(rec.candidates) && rec.candidates.length === 3);
    assert.strictEqual(sdrStore.research.get(rec.id).candidates.length, 3);
  });
  ok('normalize: iletişimsiz aday emails=[] (uydurma yok)', () => {
    const c = rec.candidates.find((x) => x.kurum_adi === 'Bilinmeyen İletişimli Aday');
    assert.deepStrictEqual(c.emails, []);
    assert.strictEqual(c.website, 'https://bilinmeyen.example');
  });
  ok('puanlama uygulandı (puan + öncelik + iletişim önerisi)', () => {
    const c = rec.candidates[0];
    assert.strictEqual(c.potansiyel_puan, 9);
    assert.strictEqual(c.oncelik, 'Yüksek');
    assert(c.ilk_iletisim_onerisi && c.ilk_iletisim_onerisi.length > 5);
  });

  console.log('\n# 2. Lead Havuzuna aktarım (data.leads)');
  const before = (store.readPanelRaw().data.leads || []).length;
  const commit = leads.commitLeads(rec.candidates, { confirm: true, source_query: rec.query });
  ok('3 lead oluştu, sahibi Kıvanç, durum Yeni', () => {
    assert.strictEqual(commit.created.length, 3);
    const pd = store.readPanelRaw().data;
    assert.strictEqual(pd.leads.length, before + 3);
    const l = pd.leads.find((x) => x.id === commit.created[0]);
    assert.strictEqual(l.assigned_to, 'Mert Kıvanç Tekin');
    assert.strictEqual(l.durum, 'Yeni');
    assert.strictEqual(l.pipeline_id, null);
  });
  ok('confirm olmadan commit reddedilir', () => {
    assert.throws(() => leads.commitLeads(rec.candidates, {}), /confirm/);
  });
  ok('aynı kurum tekrar aktarılmaz (dedup)', () => {
    const again = leads.commitLeads(rec.candidates, { confirm: true });
    assert.strictEqual(again.created.length, 0);
    assert.strictEqual(again.skipped.length, 3);
  });
  ok('mevcut MÜŞTERİ adıyla çakışan aday atlanır', () => {
    const custName = store.readPanelRaw().data.customers[0].name;
    const r = leads.commitLeads([{ kurum_adi: custName, kurum_tipi: 'Kulüp' }], { confirm: true });
    assert.strictEqual(r.created.length, 0);
    assert(/müşteri/i.test(r.skipped[0].reason));
  });

  console.log('\n# 3. Mail taslağı (MOCK Sonnet, $0) — GÖNDERİM YOK');
  const leadId = commit.created[0];
  const draft = await draftEmail(leads.getLead(store.readPanelRaw().data, leadId));
  ok('taslak konu+gövde döndü, gönderim yapılmadı', () => {
    assert(draft.konu && draft.govde && draft.govde.includes('Merci Tekstil'));
    assert.strictEqual(draft.hasRecipient, true); // 1. adayda iletisim@ var
  });
  ok('taslak lead\'e kaydedilince durum "Mail Hazır"', () => {
    const r = leads.updateLead(leadId, { mail_taslagi: { konu: draft.konu, govde: draft.govde } }, { confirm: true });
    assert.strictEqual(r.lead.durum, 'Mail Hazır');
    assert(r.lead.mail_taslagi.olusturuldu);
  });
  ok('gönderildi işaretle -> durum "Mail Gönderildi" + takip tarihi', () => {
    const r = leads.updateLead(leadId, { mark_sent: true }, { confirm: true });
    assert.strictEqual(r.lead.durum, 'Mail Gönderildi');
    assert(r.lead.followup_tarihi);
    assert.strictEqual(r.lead.gonderilen_mailler.length, 1);
  });
  ok('taslak yokken gönderildi işaretlenemez', () => {
    const other = commit.created[2];
    assert.throws(() => leads.updateLead(other, { mark_sent: true }, { confirm: true }), /taslağı yok/);
  });
  ok('geçersiz durum reddedilir', () => {
    assert.throws(() => leads.updateLead(leadId, { durum: 'Uyduruk' }, { confirm: true }), /Geçersiz durum/);
  });

  console.log('\n# 4. Lead -> pipeline dönüşümü');
  const pipeBefore = store.readPanelRaw().data.pipeline.length;
  const conv = leads.convertToPipeline(leadId, { confirm: true, est_unit_price: 300 });
  ok('pipeline kaydı oluştu, lead bağlandı, durum Görüşülüyor', () => {
    assert(conv.pipelineId);
    const pd = store.readPanelRaw().data;
    assert.strictEqual(pd.pipeline.length, pipeBefore + 1);
    const p = pd.pipeline.find((x) => x.id === conv.pipelineId);
    assert(p.note.includes('[SDR lead #'));
    assert.strictEqual(p.est_unit_price, 300);
    const l = pd.leads.find((x) => x.id === leadId);
    assert.strictEqual(l.pipeline_id, conv.pipelineId);
    assert.strictEqual(l.durum, 'Görüşülüyor');
  });
  ok('ikinci dönüşüm yeni pipeline açmaz', () => {
    const c2 = leads.convertToPipeline(leadId, { confirm: true });
    assert(c2.alreadyLinked);
  });

  console.log('\n# 5. Şema + temizlik');
  ok('leads[] panelSchema doğrulamasını geçer', () => {
    assert.strictEqual(validatePanelData(store.readPanelRaw().data).ok, true);
  });
  ok('bozuk potansiyel_puan (string) -> 422 sınıfı', () => {
    assert.strictEqual(validatePanelData({ leads: [{ id: 1, potansiyel_puan: 'çok' }] }).ok, false);
  });
  ok('deleteLead lead\'i kaldırır', () => {
    const n = store.readPanelRaw().data.leads.length;
    leads.deleteLead(leadId);
    assert.strictEqual(store.readPanelRaw().data.leads.length, n - 1);
  });
  ok('research.delete araştırma logunu siler', () => {
    assert.strictEqual(sdrStore.research.delete(rec.id).deleted, 1);
    assert.strictEqual(sdrStore.research.get(rec.id), null);
  });

  seed(); // panel-data'yı geri al

  console.log('\n=== ' + pass + ' geçti, ' + fail + ' başarısız ===');
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('sdr HATA:', e); process.exit(1); });
