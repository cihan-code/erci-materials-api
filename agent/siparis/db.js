'use strict';
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
// Constraint changes since the first schema. SQLite cannot alter CHECK/UNIQUE, so an older table is rebuilt once.
const REBUILDS = {
  confirmations: sql => !sql.includes("'eski_surum'"),
  files: sql => /UNIQUE\s*\(\s*version_id\s*,\s*kind\s*\)/i.test(sql),
};
const ADDED_COLUMNS = { order_lines: { kalip_id: 'TEXT' }, stock_items: { color_hex: 'TEXT' }, stock_movements: { allocation_id: 'INTEGER REFERENCES allocations(id)' },
  invoice_lines: { source: 'TEXT', invoice_no: 'TEXT', invoice_date: 'TEXT', supplier_vkn: 'TEXT', unit_price: 'REAL', content_hash: 'TEXT',
    match_reasons_json: 'TEXT', created_at: 'TEXT', updated_at: 'TEXT', delivery_request_json: 'TEXT' } };
const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
function migrate(db, schema) {
  const tableSql = name => db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name)?.sql;
  // foreign_keys cannot change inside a transaction; the table swap needs it off and is checked before commit.
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      for (const [name, stale] of Object.entries(REBUILDS)) {
        const sql = tableSql(name);
        if (!sql || !stale(sql)) continue;
        const create = new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`).exec(schema)?.[0];
        if (!create) throw new Error(`Şema tanımı yok: ${name}`);
        db.exec(create.replace(`IF NOT EXISTS ${name} (`, `${name}__new (`));
        const fresh = columns(db, `${name}__new`);
        const shared = columns(db, name).filter(c => fresh.includes(c)).join(',');
        db.exec(`INSERT INTO ${name}__new(${shared}) SELECT ${shared} FROM ${name}; DROP TABLE ${name}; ALTER TABLE ${name}__new RENAME TO ${name};`);
      }
      for (const [table, added] of Object.entries(ADDED_COLUMNS)) {
        if (!tableSql(table)) continue;
        const have = columns(db, table);
        for (const [col, decl] of Object.entries(added)) if (!have.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
      }
      if (db.pragma('foreign_key_check').length) throw new Error('Şema geçişi yabancı anahtar bütünlüğünü bozdu');
    }).immediate();
  } finally { db.pragma('foreign_keys = ON'); }
}
function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file, { timeout: 10000 });
  try {
    db.pragma('journal_mode = WAL');
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    migrate(db, schema);
    db.transaction(() => db.exec(schema)).immediate();
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
