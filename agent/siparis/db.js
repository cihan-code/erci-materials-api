'use strict';
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file, { timeout: 10000 });
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.transaction(() => db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'))).immediate();
    return db;
  } catch (err) { db.close(); throw err; }
}
// Synchronous callbacks only: never allow an async callback to commit before its writes.
function tx(db, fn) {
  return db.transaction(() => {
    const result = fn();
    if (result && typeof result.then === 'function') throw new Error('tx callback must be synchronous');
    return result;
  }).immediate();
}
function audit(db, userId, action, ref, detail = {}) {
  db.prepare('INSERT INTO audit_log(user_id,action,ref,detail_json) VALUES(?,?,?,?)')
    .run(userId ?? null, action, String(ref), JSON.stringify(detail));
}
function fail(message, status = 400) { const e = new Error(message); e.status = status; throw e; }
function integer(value, name, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) fail(`${name}: geçerli tam sayı gerekli`);
  return value;
}
module.exports = { openDb, tx, audit, fail, integer };
