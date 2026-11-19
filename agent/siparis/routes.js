'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { openDb, tx, audit, fail } = require('./db');
const { authFor, login } = require('./auth');
const orders = require('./orders');
const { approveVersion } = require('./approval');
const stock = require('./stock');
const outbox = require('./outbox');
module.exports = function mount(app, { dataDir, db: suppliedDb, worker = true, recipes } = {}) {
  const db = suppliedDb || openDb(path.join(dataDir, 'siparis.sqlite'));
  const router = express.Router();
  const requireUser = authFor(db);
  const wrap = fn => (req,res,next) => Promise.resolve().then(() => fn(req,res)).catch(next);
  router.use(express.json({limit:'2mb'}));
  router.post('/giris', wrap(async (req,res) => res.json(await login(db, { name:req.body.name ?? req.body.ad, password:req.body.password ?? req.body.sifre }))));
  require('./routes-fatura')(router, { db, requireUser }); // before the user gate: intake also takes the service key
  router.use(requireUser());
  router.use(require('./routes-belge')({db,dataDir}));
  router.get('/siparisler', (req,res) => res.json(db.prepare('SELECT * FROM orders ORDER BY id DESC').all()));
  router.post('/siparisler', wrap((req,res) => res.status(201).json(orders.createOrder(db,req.body,req.user))));
  router.get('/siparisler/:id', wrap((req,res) => {
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
    if (!order) fail('Sipariş bulunamadı',404);
    res.json({...order,versions:db.prepare('SELECT id FROM order_versions WHERE order_id=? ORDER BY version_no').all(order.id).map(v => orders.snapshot(db,v.id))});
  }));
  router.patch('/siparisler/:id', wrap((req,res) => res.json(orders.updateOrder(db,Number(req.params.id),req.body,req.user))));
  router.delete('/siparisler/:id', wrap((req,res) => res.json(orders.cancelOrder(db,Number(req.params.id),req.user))));
  router.get('/surumler/:id', wrap((req,res) => res.json(orders.snapshot(db,Number(req.params.id)))));
  router.post('/surumler/:id/satirlar', wrap((req,res) => res.status(201).json(orders.addLine(db,Number(req.params.id),req.body,req.user))));
  router.post('/satirlar/:id/uygulamalar', wrap((req,res) => res.status(201).json(orders.addApplication(db,Number(req.params.id),req.body,req.user))));
  router.post('/surumler/:id/dosyalar', wrap((req,res) => {
    // HTTP callers may register only existing generated files inside the dedicated directory.
    if (!dataDir || typeof req.body.path !== 'string') fail('Dosya dizini veya yolu yok');
    const root = fs.realpathSync(path.join(dataDir,'siparis','files'));
    const filePath = fs.realpathSync(path.resolve(root,req.body.path));
    if (!filePath.startsWith(root+path.sep) || !fs.statSync(filePath).isFile()) fail('Dosya izin verilen dizinde değil',403);
    const sha256=crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    res.status(201).json(orders.addFile(db,Number(req.params.id),{kind:req.body.kind,path:filePath,sha256},req.user));
  }));
  router.post('/surumler/:id/gonder', wrap((req,res) => res.json(orders.submitForApproval(db,Number(req.params.id),req.user))));
  router.post('/surumler/:id/onay', requireUser('onay'), wrap((req,res) => res.json(approveVersion(db,{versionId:Number(req.params.id),fileId:req.body.fileId,userId:req.user.id,recipes}))));
  router.post('/surumler/:id/revizyon', wrap((req,res) => res.status(201).json(orders.reviseVersion(db,Number(req.params.id),req.body,req.user))));
  router.get('/stok', (req,res) => res.json(stock.stockView(db)));
  router.post('/stok/kalemler', wrap((req,res) => {
    try { res.status(201).json(stock.createStockItem(db,req.body,req.user.id)); }
    catch (err) { if (err.item) return res.status(409).json({error:err.message,item:err.item}); throw err; }
  }));
  router.patch('/stok/kalemler/:id', wrap((req,res) => res.json(stock.updateStockItem(db,Number(req.params.id),req.body,req.user.id))));
  router.get('/stok/hareketler', (req,res) => res.json(req.query.itemId ? db.prepare('SELECT * FROM stock_movements WHERE item_id=? ORDER BY id DESC').all(req.query.itemId) : db.prepare('SELECT * FROM stock_movements ORDER BY id DESC').all()));
  router.post('/stok/teslim', wrap((req,res) => res.json(stock.receiveDelivery(db,{...req.body,userId:req.user.id}))));
  router.post('/stok/duzelt', requireUser('onay'), wrap((req,res) => res.json(stock.adjustStock(db,{...req.body,userId:req.user.id}))));
  router.post('/stok/sayim', requireUser('onay'), wrap((req,res) => {
    const b = req.body || {}, item = db.prepare('SELECT * FROM stock_items WHERE id=?').get(b.itemId ?? null);
    if (!item) fail('Stok kalemi bulunamadı',404);
    let counted = b.countedMilli;
    if (b.countedKg != null) {
      if (item.unit !== 'kg' || typeof b.countedKg !== 'number' || !Number.isFinite(b.countedKg) || b.countedKg < 0) fail('countedKg yalnız kg kalemde, sıfır veya pozitif sayı olarak verilir');
      if (counted != null && counted !== Math.round(b.countedKg*1000)) fail('countedKg ile countedMilli uyuşmuyor');
      counted = Math.round(b.countedKg*1000);
    }
    res.json(stock.recordCount(db,{itemId:item.id,countedMilli:counted,countKey:b.countKey,note:b.note ?? null,userId:req.user.id}));
  }));
  router.post('/stok/cikis', wrap((req,res) => res.json(stock.consume(db,{...req.body,userId:req.user.id}))));
  router.get('/teyitler', (req,res) => res.json(db.prepare('SELECT * FROM confirmations WHERE status=? ORDER BY id').all(req.query.status || 'acik')));
  router.post('/teyitler/:id/coz', wrap((req,res) => res.json(tx(db, () => {
    const row=db.prepare('SELECT * FROM confirmations WHERE id=?').get(req.params.id);
    if (!row) fail('Teyit bulunamadı',404);
    if (row.status !== 'cozuldu') {
      db.prepare("UPDATE confirmations SET status='cozuldu',resolved_by=? WHERE id=?").run(req.user.id,row.id);
      audit(db,req.user.id,'teyit_coz',row.id);
    }
    return db.prepare('SELECT * FROM confirmations WHERE id=?').get(row.id);
  }))));
  router.get('/outbox', (req,res) => res.json(db.prepare('SELECT * FROM outbox ORDER BY id DESC').all()));
  router.post('/outbox/:id/tekrar', requireUser('onay'), wrap((req,res) => res.json(outbox.retry(db,Number(req.params.id),req.user))));
  router.post('/outbox/:id/manuel', requireUser('onay'), wrap((req,res) => res.json(outbox.setManual(db,Number(req.params.id),req.user))));
  router.post('/outbox/:id/elle-gonderildi', requireUser('onay'), wrap((req,res) => res.json(outbox.markManualSent(db,Number(req.params.id),req.user,req.body.providerRef))));
  require('./routes-maliyet')(router, { db, dataDir, worker });
  router.use((err,req,res,next) => {
    if (res.headersSent) return next(err);
    const status = err.status || (err.code?.startsWith('SQLITE_CONSTRAINT') ? 409 : 500);
    res.status(status).json({error:status===500 ? 'Sipariş işlemi tamamlanamadı' : err.message});
  });
  app.use('/api/siparis',router); // Parent app already applies CORS_ORIGIN before this router.
  const stop = worker ? outbox.startWorker(db) : () => {};
  return { db, stop, close() { stop(); if (!suppliedDb) db.close(); } };
};
