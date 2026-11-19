'use strict';
// Invoice line endpoints under /api/siparis. Intake accepts the Finance agent's service key or a user token;
// listing and delivery are team actions and need a user token.
const invoices = require('./invoices');
const { serviceOrUser: serviceOrUserFor } = require('./auth');
module.exports = function mountFatura(router, { db, requireUser }) {
  const userAuth = requireUser();
  const wrap = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  const serviceOrUser = serviceOrUserFor(db);
  router.post('/fatura-satirlari', serviceOrUser, wrap((req, res) =>
    res.json({ results: invoices.ingest(db, req.body, { userId: req.user?.id ?? null }) })));
  router.get('/fatura-satirlari', userAuth, wrap((req, res) => res.json(invoices.list(db, { durum: req.query.durum }))));
  router.post('/fatura-satirlari/:id/teslim', userAuth, wrap((req, res) =>
    res.json(invoices.deliver(db, Number(req.params.id), req.body || {}, req.user.id))));
};
