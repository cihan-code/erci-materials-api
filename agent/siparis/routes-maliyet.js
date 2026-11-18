'use strict';
const { authFor } = require('./auth');
const cost = require('./costTransfer');
// Mounted by routes.js inside the authenticated /api/siparis router, before its error handler.
module.exports = function mountCost(router, { db, dataDir, worker = false } = {}) {
  cost.ensureSchema(db);
  const requireUser = authFor(db);
  const wrap = fn => (req,res,next) => Promise.resolve().then(() => fn(req,res)).catch(next);
  router.get('/siparisler/:id/maliyet', wrap((req,res) => res.json(cost.costStatus(db,Number(req.params.id)))));
  router.post('/siparisler/:id/fiyat', requireUser('onay'), wrap((req,res) => res.json(cost.setPrice(db,Number(req.params.id),req.body,req.user))));
  // Only the process that runs the queue worker owns the adapter; it writes the shared panel data.
  return { unregister: worker ? cost.register({ dataDir }) : () => {} };
};
