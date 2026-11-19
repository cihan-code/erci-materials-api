'use strict';
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);
const { tx, audit, fail } = require('./db');
const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');
async function passwordHash(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 1024) fail('Şifre 8–1024 karakter olmalı');
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt:${salt}:${(await scrypt(password, salt, 64)).toString('hex')}`;
}
async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || password.length > 1024) return false;
  const [, salt, key] = encoded.split(':');
  const expected = Buffer.from(key, 'hex');
  const actual = await scrypt(password, salt, 64);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
// Everyone signed in may approve by default (owner's decision); onayYetkisi:false keeps a restricted account possible.
async function createUser(db, { name, password, role = 'ekip', onayYetkisi = true }) {
  if (typeof name !== 'string' || !name.trim()) fail('Kullanıcı adı gerekli');
  if (!['ekip', 'yonetici'].includes(role)) fail('Geçersiz rol');
  const encoded = await passwordHash(password);
  return tx(db, () => {
    const id = Number(db.prepare('INSERT INTO users(name,password_hash,role,onay_yetkisi) VALUES(?,?,?,?)').run(name.trim(), encoded, role, onayYetkisi ? 1 : 0).lastInsertRowid);
    audit(db, id, 'kullanici_ekle', id, { role, onayYetkisi });
    return db.prepare('SELECT id,name,role,onay_yetkisi FROM users WHERE id=?').get(id);
  });
}
async function login(db, { name, password }) {
  const user = typeof name === 'string' && db.prepare('SELECT * FROM users WHERE name=?').get(name);
  // A dummy scrypt prevents a fast path from revealing whether the account exists.
  const encoded = user?.password_hash || `scrypt:${'0'.repeat(32)}:${'0'.repeat(128)}`;
  if (!(await verifyPassword(password, encoded)) || !user) fail('Giriş bilgileri geçersiz', 401);
  return tx(db, () => {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO sessions(user_id,token_hash,expires_at) VALUES(?,?,?)').run(user.id, hashToken(token), expiresAt);
    audit(db, user.id, 'giris', user.id);
    return { token, expiresAt, user: { id: user.id, name: user.name, role: user.role, onay_yetkisi: user.onay_yetkisi } };
  });
}
function assertUser(db, userId, approval = false) {
  const user = db.prepare('SELECT id,name,role,onay_yetkisi FROM users WHERE id=?').get(userId ?? null);
  if (!user) fail('Giriş gerekli', 401);
  if (approval && user.role !== 'yonetici' && user.onay_yetkisi !== 1) fail('Onay yetkisi gerekli', 403);
  return user;
}
// Bind once per database; the returned middleware factory has requireUser(role?) shape.
function authFor(db) {
  return function requireUser(role) {
    return (req, res, next) => {
      const token = /^Bearer ([a-f0-9]{64})$/i.exec(req.get('authorization') || '')?.[1];
      const user = token && db.prepare(`SELECT u.id,u.name,u.role,u.onay_yetkisi FROM sessions s
        JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`).get(hashToken(token), new Date().toISOString());
      if (!user) return res.status(401).json({ error: 'Giriş gerekli' });
      if (role && !(role === 'onay' ? user.role === 'yonetici' || user.onay_yetkisi === 1 : user.role === role))
        return res.status(403).json({ error: 'Yetki gerekli' });
      req.user = user;
      next();
    };
  };
}
module.exports = { createUser, login, assertUser, authFor, requireUser: (db, role) => authFor(db)(role), passwordHash, verifyPassword };
