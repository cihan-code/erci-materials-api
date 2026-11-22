'use strict';
// G70: endpoints of the redraw worker (Mac). Own credential DESEN_ISCI_ANAHTARI: it opens only these routes, so the
// worker holds nothing that reads orders, prices or the panel summary. Unset or short key: 503. Wrong or missing: 401.
const express = require('express');
const { serviceKeyMatches } = require('./auth');
const isci = require('./desenIsci');

module.exports = function mountDesenIsci(router, { db, dataDir }) {
  const sub = express.Router();
  sub.use((req, res, next) => {
    const key = String(process.env.DESEN_ISCI_ANAHTARI ?? '').trim();
    if (key.length < 16) return res.status(503).json({ error: 'Desen işçisi kapalı: DESEN_ISCI_ANAHTARI tanımlı değil.' });
    if (!serviceKeyMatches(req.get('authorization'), key)) return res.status(401).json({ error: 'Yetkisiz: işçi anahtarı hatalı ya da eksik.' });
    next();
  });
  sub.use(express.json({ limit: '40mb' })); // PNG results travel as base64
  const wrap = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  const done = (res, r) => r.error ? res.status(r.status || 400).json({ error: r.error }) : res.json(r);
  sub.get('/is', (req, res) => res.json(isci.listing(db)));
  sub.post('/al', (req, res) => res.json({ is: isci.claim(db) }));
  sub.get('/is/:id/gorsel', (req, res) => {
    const r = isci.image(db, Number(req.params.id), String(req.query.kiralama || ''));
    if (r.error) return res.status(r.status).json({ error: r.error });
    res.type(r.mime).send(r.buffer);
  });
  sub.post('/is/:id/sonuc', wrap(async (req, res) => done(res, await isci.submit(db, dataDir, Number(req.params.id), String(req.body?.kiralama || ''), req.body?.sonuclar))));
  sub.post('/is/:id/hata', (req, res) => done(res, isci.fail(db, Number(req.params.id), String(req.body?.kiralama || ''), req.body?.mesaj)));
  router.use('/desen-isci', sub);
};
