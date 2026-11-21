'use strict';
// G64: customer approval link routes. Token holders need no login; every call is rate limited and the body is small.
const express = require('express');
const crypto = require('crypto');
const { fail } = require('./db');
const musteri = require('./musteriOnay');

// In-memory fixed windows, one per presented token digest and one per IP. Enough for a single process.
function limiter({ perTokenMax, perIpMax, windowMs, now = () => Date.now() }) {
  const hits = new Map();
  const take = (key, max) => {
    const t = now();
    let e = hits.get(key);
    if (!e || t >= e.reset) { e = { n: 0, reset: t + windowMs }; hits.set(key, e); }
    e.n += 1;
    return e.n <= max;
  };
  return (token, ip) => {
    if (hits.size > 5000) for (const [k, e] of hits) if (now() >= e.reset) hits.delete(k);
    const digest = crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 24);
    // Both counters always advance, so a flood of random tokens still exhausts the IP budget.
    const a = take(`i:${ip}`, perIpMax), b = take(`t:${digest}`, perTokenMax);
    return a && b;
  };
}

module.exports = function mountCustomer(router, { db, dataDir, requireUser, recipes, panelOrigin, limits = {} }) {
  musteri.ensureCustomerUser(db);
  const allow = limiter({ perTokenMax: 30, perIpMax: 120, windowMs: 60 * 1000, ...limits });
  const wrap = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  const ctx = req => ({ ip: req.ip || req.socket?.remoteAddress || '', userAgent: req.get('user-agent') || '' });
  const origin = () => (panelOrigin ? String(panelOrigin).replace(/\/+$/, '') : musteri.panelOriginFrom().origin || '');

  // Staff: mint a link. Re-requesting revokes the previous one.
  router.post('/surumler/:id/musteri-link', requireUser(), wrap((req, res) => {
    res.status(201).json(musteri.createLink(db, Number(req.params.id), req.user, panelOrigin ? { panelOrigin: origin() } : {}));
  }));
  router.get('/surumler/:id/musteri-notlari', requireUser(), wrap((req, res) => res.json(musteri.notesOf(db, Number(req.params.id)))));

  const customer = express.Router();
  // CORS only for PANEL_ORIGIN (the parent app's own CORS runs before this router; configure CORS_ORIGIN to the same value).
  customer.use((req, res, next) => {
    const allowed = origin();
    res.removeHeader('Access-Control-Allow-Origin');
    res.set('Vary', 'Origin');
    if (allowed && req.get('origin') === allowed) res.set('Access-Control-Allow-Origin', allowed);
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Content-Type-Options', 'nosniff');
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      return res.sendStatus(204);
    }
    next();
  });
  customer.use(express.json({ limit: '8kb' }));
  customer.use('/:token', (req, res, next) => {
    if (!allow(req.params.token, req.ip || '')) return res.status(429).json({ error: 'Çok fazla istek; biraz sonra tekrar deneyin' });
    next();
  });
  customer.get('/:token', wrap((req, res) => res.json(musteri.summary(db, req.params.token))));
  customer.get('/:token/onay-formu.pdf', wrap((req, res) => {
    const f = musteri.file(db, dataDir, req.params.token, { kind: 'onay_formu' });
    res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    res.set('Content-Disposition', 'inline; filename="onay-formu.pdf"');
    res.type(f.mime).send(f.buffer);
  }));
  customer.get('/:token/gorsel/:fileId', wrap((req, res) => {
    const f = musteri.file(db, dataDir, req.params.token, { kind: 'urun_gorsel', fileId: Number(req.params.fileId) });
    res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    res.type(f.mime).send(f.buffer);
  }));
  customer.post('/:token/onayla', wrap((req, res) => res.json(musteri.approve(db, req.params.token, req.body, ctx(req), { recipes }))));
  customer.post('/:token/degisiklik', wrap((req, res) => res.status(201).json(musteri.requestChange(db, req.params.token, req.body, ctx(req)))));
  router.use('/musteri', customer);
};
module.exports.limiter = limiter;
