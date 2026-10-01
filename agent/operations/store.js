'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('../store');
const directory = path.join(DATA_DIR, 'operations');
const instance = crypto.randomUUID();
function read() {
  let text;
  try { text = fs.readFileSync(path.join(directory, 'journal.json'), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return { version: 1, revision: 0, events: [], rules: {} }; throw e; }
  const data = JSON.parse(text);
  if (data.version !== 1 || !Array.isArray(data.events) || !data.rules || !Number.isInteger(data.revision)) throw new Error('Üretim günlüğü okunamadı.');
  return data;
}
async function locked(fn) {
  fs.mkdirSync(directory, { recursive: true });
  const lock = path.join(directory, '.lock');
  try { fs.mkdirSync(lock); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let abandoned = false;
    try {
      const owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
      if (owner.pid === process.pid) abandoned = owner.instance !== instance;
      else {
        try { process.kill(owner.pid, 0); }
        catch (error) { abandoned = error.code === 'ESRCH'; }
      }
    } catch (_) {
      // A process could crash between mkdir and writing the owner. Never reclaim
      // a new ownerless lock while another writer may still be acquiring it.
      abandoned = Date.now() - fs.statSync(lock).mtimeMs > 120000;
    }
    if (!abandoned) throw new Error('Başka bir bildirim işleniyor; biraz sonra tekrar deneyin.');
    fs.rmSync(lock, { recursive: true });
    fs.mkdirSync(lock);
  }
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, instance }), { mode: 0o600 });
  try { return await fn(read()); }
  finally { fs.rmSync(lock, { recursive: true }); }
}
function write(data) {
  const file = path.join(directory, 'journal.json');
  const temp = file + '.' + crypto.randomUUID();
  try {
    fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
module.exports = { read, locked, write };
