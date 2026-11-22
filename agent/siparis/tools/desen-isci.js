#!/usr/bin/env node
'use strict';
// G70: the redraw worker. Runs on the owner's Mac (the ChatGPT subscription lives in its Codex login), takes one job
// at a time from the server queue, draws it with Codex (gpt-6-astra, whole-picture mode) and uploads the PNGs.
//   node agent/siparis/tools/desen-isci.js [--bir-kez] [--kuru]
//   SIPARIS_API          base address, e.g. https://<host>/api/siparis
//   DESEN_ISCI_ANAHTARI  worker key (env or ~/.mercitex/desen-isci.env, mode 600; never in the repo)
//   DESEN_ISCI_GUNLUK    most jobs per day (default 20)
// Only the product picture leaves this machine's disk for Codex; logs hold the job id and seconds, nothing else.
// No dependency beyond the repo's own modules and Node.
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const desenCizim = require('../desenCizim');

const HOME = os.homedir();
const ENV_FILE = path.join(HOME, '.mercitex', 'desen-isci.env');
const STATE_FILE = path.join(HOME, '.mercitex', 'desen-isci-durum.json');
const LIMIT_SCRIPT = path.join(HOME, '.claude', 'skills', 'limit-dengesi', 'scripts', 'limitler.py');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

function readEnvFile(file = ENV_FILE) {
  let st;
  try { st = fs.statSync(file); } catch { return {}; }
  if (st.mode & 0o077) throw new Error(`${file} yalnız sahibine açık olmalı (chmod 600)`);
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}
function today() { return new Date().toISOString().slice(0, 10); }
function readState(file) { try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); return s.gun === today() ? s : { gun: today(), sayi: 0 }; } catch { return { gun: today(), sayi: 0 }; } }
function writeState(file, s) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(s), { mode: 0o600 }); }

// Codex limit: wait at >= 80% of the 5-hour window or >= 90% of the weekly one. No script: only the daily cap applies.
function limitCheck({ script = LIMIT_SCRIPT, run = childProcess.spawnSync } = {}) {
  if (!fs.existsSync(script)) return { ok: true, bilinmiyor: true };
  try {
    const r = run('python3', [script, '--json'], { encoding: 'utf8', timeout: 20000 });
    const c = JSON.parse(r.stdout).codex;
    const five = c.bes_saat?.sifirlandi ? 0 : Number(c.bes_saat?.yuzde ?? 0), week = c.hafta?.sifirlandi ? 0 : Number(c.hafta?.yuzde ?? 0);
    return { ok: !(five >= 80 || week >= 90), besSaat: five, hafta: week };
  } catch { return { ok: true, bilinmiyor: true }; }
}

async function api(cfg, method, url, body) {
  const res = await cfg.fetch(`${cfg.base}/desen-isci${url}`, { method, headers: { authorization: `Bearer ${cfg.key}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (res.status === 401 || res.status === 503) throw Object.assign(new Error(`Sunucu işçiyi kabul etmedi (${res.status})`), { fatal: true });
  return res;
}

// One job: claim, download, draw, upload. Returns 'yok' | 'tamam' | 'hata'.
async function oneJob(cfg) {
  const claimed = await (await api(cfg, 'POST', '/al', {})).json();
  const job = claimed.is;
  if (!job) return 'yok';
  const t0 = Date.now(); // the picture is held in memory; the Codex helper writes it to its own temp folder and removes that afterwards
  try {
    let sonuclar = [];
    if (job.kip === 'kirpik') {
      // Second attempt: one Codex call per weak print, from its cut-out alone. A print whose drawing fails is simply left out
      // (the server then keeps its whole-picture drawing); if every call fails the job goes back to the queue.
      let errors = 0;
      for (const konum of job.konumlar) {
        try {
          const cut = await api(cfg, 'GET', `/is/${job.id}/kirpim/${encodeURIComponent(konum)}?kiralama=${job.kiralama}`);
          if (!cut.ok) throw new Error(`kırpım indirilemedi (${cut.status})`);
          const out = await cfg.draw({ files: [{ name: 'print', buffer: Buffer.from(await cut.arrayBuffer()) }], prompt: desenCizim.promptCrop(), outputs: ['print'] }, cfg.env);
          sonuclar.push({ konum, png: out.get('print').toString('base64') });
        } catch (e) { if (e.fatal) throw e; errors++; }
      }
      if (!sonuclar.length && errors) throw new Error('kırpım çizimleri alınamadı');
    } else {
      const img = await api(cfg, 'GET', `/is/${job.id}/gorsel?kiralama=${job.kiralama}`);
      if (!img.ok) throw new Error(`görsel indirilemedi (${img.status})`);
      const buffer = Buffer.from(await img.arrayBuffer());
      const prints = job.konumlar.map(position => ({ position, name: position }));
      const out = await cfg.draw({ files: [{ name: 'product', buffer }], prompt: desenCizim.promptFull(prints), outputs: prints.map(p => p.name) }, cfg.env);
      sonuclar = [...out].map(([konum, png]) => ({ konum, png: png.toString('base64') }));
    }
    const up = await api(cfg, 'POST', `/is/${job.id}/sonuc`, { kiralama: job.kiralama, sonuclar });
    if (!up.ok) throw new Error(`sonuç yüklenemedi (${up.status})`);
    log(`is=${job.id} kip=${job.kip} sure=${Math.round((Date.now() - t0) / 1000)}s durum=tamam`);
    return 'tamam';
  } catch (e) {
    if (e.fatal) throw e;
    log(`is=${job.id} sure=${Math.round((Date.now() - t0) / 1000)}s durum=hata`);
    try { await api(cfg, 'POST', `/is/${job.id}/hata`, { kiralama: job.kiralama, mesaj: String(e.message).slice(0, 200) }); } catch (x) { if (x.fatal) throw x; }
    return 'hata';
  }
}

// The loop. deps are injectable for tests: fetch, draw, limit, sleep, stateFile, quick waits.
async function run({ birKez = false, kuru = false, env = process.env, deps = {} } = {}) {
  const fileEnv = deps.envFile ?? readEnvFile();
  const cfg = {
    base: String(env.SIPARIS_API || fileEnv.SIPARIS_API || '').replace(/\/$/, ''), key: env.DESEN_ISCI_ANAHTARI || fileEnv.DESEN_ISCI_ANAHTARI || '',
    fetch: deps.fetch || fetch, draw: deps.draw || desenCizim.codexDraw, env: { ...env, DESEN_CIZIM_MODEL: env.DESEN_CIZIM_MODEL || 'gpt-6-astra' },
  };
  if (!cfg.base || !cfg.key) throw new Error('SIPARIS_API ve DESEN_ISCI_ANAHTARI gerekli (ortam ya da ~/.mercitex/desen-isci.env)');
  const daily = Number(env.DESEN_ISCI_GUNLUK || fileEnv.DESEN_ISCI_GUNLUK) || 20, stateFile = deps.stateFile || STATE_FILE;
  const wait = deps.sleep || sleep, limit = deps.limit || limitCheck, idle = deps.bosBekleme ?? 60e3;
  let backoff = deps.ilkGeriCekilme ?? 30e3;
  for (;;) {
    const st = readState(stateFile), lim = limit();
    if (kuru) {
      const list = await (await api(cfg, 'GET', '/is')).json();
      log(`kuru: bekleyen=${list.bekleyen.length} bugun=${st.sayi}/${daily} limit=${lim.ok ? 'uygun' : 'dolu'}${lim.bilinmiyor ? ' (bilinmiyor)' : ` bes_saat=${lim.besSaat} hafta=${lim.hafta}`}`);
      return { kuru: true, bekleyen: list.bekleyen.length, bugun: st.sayi, limitOk: lim.ok };
    }
    if (st.sayi >= daily) { log(`gunluk sinir (${daily}) doldu`); if (birKez) return { durum: 'gunluk-sinir' }; await wait(30 * 60e3); continue; }
    if (!lim.ok) { log(`codex limiti dolu (bes_saat=${lim.besSaat} hafta=${lim.hafta}); bekleniyor`); if (birKez) return { durum: 'limit' }; await wait(15 * 60e3); continue; }
    let result;
    try { result = await oneJob(cfg); }
    catch (e) {
      if (e.fatal) throw e;
      log(`baglanti hatasi: ${String(e.message).slice(0, 120)}`); result = 'hata';
    }
    if (result === 'tamam') { writeState(stateFile, { gun: today(), sayi: st.sayi + 1 }); backoff = deps.ilkGeriCekilme ?? 30e3; }
    if (birKez) return { durum: result };
    if (result === 'hata') { await wait(backoff); backoff = Math.min(backoff * 2, 15 * 60e3); }
    else if (result === 'yok') await wait(idle);
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--yardim')) { console.log('Kullanım: desen-isci.js [--bir-kez] [--kuru]\nOrtam: SIPARIS_API, DESEN_ISCI_ANAHTARI (ya da ~/.mercitex/desen-isci.env), DESEN_ISCI_GUNLUK'); process.exit(0); }
  run({ birKez: args.includes('--bir-kez'), kuru: args.includes('--kuru') }).then(r => { if (r) log(JSON.stringify(r)); }, e => { log(`durdu: ${e.message}`); process.exit(1); });
}
module.exports = { run, oneJob, limitCheck, readEnvFile, readState };
