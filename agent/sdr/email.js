// SDR ilk temas maili TASLAGI. Sonnet + effort:medium (kisisellestirme kalitesi = yanit orani).
// GONDERIM YOK - sadece taslak. MOCK'ta fixture, $0.

const fs = require('fs');
const path = require('path');
const { callClaude } = require('../claude');
const { SONNET } = require('../pricing');
const { parseModelJson } = require('../lib/jsonParse');

const MOCK = process.env.AGENT_MOCK === '1';
const IDENTITY = fs.readFileSync(path.join(__dirname, 'prompts', 'identity.md'), 'utf8');
const EMAIL_PROMPT = fs.readFileSync(path.join(__dirname, 'prompts', 'email.md'), 'utf8');

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'test', 'fixtures', name), 'utf8'));
}

// lead: data.leads kaydi. Doner: { konu, govde, notlar, hasRecipient }
async function draftEmail(lead) {
  if (!lead || !lead.kurum_adi) throw new Error('Geçerli bir lead gerekli.');

  const ctx = {
    kurum_adi: lead.kurum_adi,
    kurum_tipi: lead.kurum_tipi,
    sehir: lead.sehir,
    sektor: lead.sektor,
    neden_uygun: lead.neden_uygun,
    tahmini_urun: lead.tahmini_urun,
    sosyal_ozet: lead.sosyal_ozet,
    ilgili_kisi: (lead.ilgili_kisiler || [])[0] || null,
    gonderilecek_mail: (lead.emails || [])[0] || ((lead.ilgili_kisiler || []).find((k) => k.email) || {}).email || null,
  };

  let raw;
  if (MOCK) {
    raw = fixture('sdr-email.json');
  } else {
    const resp = await callClaude({
      model: SONNET,
      opType: 'sdr-email',
      system: IDENTITY + '\n\n---\n\n' + EMAIL_PROMPT,
      user: 'Lead bilgisi:\n' + JSON.stringify(ctx, null, 1),
      maxTokens: 2000,
      effort: 'medium',
    });
    raw = parseModelJson(resp.text, 'SDR mail taslağı');
  }

  return {
    konu: raw.konu ? String(raw.konu).slice(0, 200) : null,
    govde: raw.govde ? String(raw.govde).slice(0, 4000) : null,
    notlar: raw.notlar ? String(raw.notlar).slice(0, 600) : null,
    hasRecipient: !!ctx.gonderilecek_mail,
    recipient: ctx.gonderilecek_mail || null,
  };
}

module.exports = { draftEmail };
