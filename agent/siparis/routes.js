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
const { kartelaView, fabricTypeList } = require('./kartela');
const outbox = require('./outbox');
module.exports = function mount(app, { dataDir, db: suppliedDb, worker = true, recipes, customerLimits } = {}) {
  const db = suppliedDb || openDb(path.join(dataDir, 'siparis.sqlite'));
  const router = express.Router();
  const requireUser = authFor(db);
  const wrap = fn => (req,res,next) => Promise.resolve().then(() => fn(req,res)).catch(next);
  // G64: customer link (own body limit, no login); the staff link-minting route inside needs requireUser.
  require('./routes-musteri')(router, { db, dataDir, requireUser, recipes, ...(customerLimits ? { limits: customerLimits } : {}) });
  router.use(express.json({limit:'2mb'}));
  router.post('/giris', wrap(async (req,res) => res.json(await login(db, { name:req.body.name ?? req.body.ad, password:req.body.password ?? req.body.sifre }))));
  require('./routes-fatura')(router, { db, requireUser }); // before the user gate: intake also takes the service key
  require('./routes-panel')(router, db); // read-only Ajan Paneli summary; own auth (service key or user token)
  router.use(requireUser());
  router.use(require('./routes-belge')({db,dataDir}));
  router.get('/siparisler', (req,res) => res.json(db.prepare('SELECT * FROM orders WHERE deleted_at IS NULL ORDER BY id DESC').all()));
  router.post('/siparisler', wrap((req,res) => res.status(201).json(orders.createOrder(db,req.body,req.user))));
  router.get('/siparisler/:id', wrap((req,res) => {
    const order = db.prepare('SELECT * FROM orders WHERE id=? AND deleted_at IS NULL').get(req.params.id);
    if (!order) fail('Sipariş bulunamadı',404);
    res.json({...order,versions:db.prepare('SELECT id FROM order_versions WHERE order_id=? ORDER BY version_no').all(order.id).map(v => orders.snapshot(db,v.id))});
  }));
  router.patch('/siparisler/:id', wrap((req,res) => res.json(orders.updateOrder(db,Number(req.params.id),req.body,req.user))));
  router.delete('/siparisler/:id', wrap((req,res) => res.json(orders.cancelOrder(db,Number(req.params.id),req.user))));
  router.post('/siparisler/:id/sil', wrap((req,res) => res.json(orders.deleteOrder(db,Number(req.params.id),req.body,req.user))));
  router.get('/surumler/:id', wrap((req,res) => res.json(orders.snapshot(db,Number(req.params.id)))));
  router.post('/surumler/:id/satirlar', wrap((req,res) => res.status(201).json(orders.addLine(db,Number(req.params.id),req.body,req.user))));
  router.post('/satirlar/:id/uygulamalar', wrap((req,res) => res.status(201).json(orders.addApplication(db,Number(req.params.id),req.body,req.user))));
  router.post('/surumler/:id/dosyalar', wrap((req,res) => {
    const documents = require('./documents');
    const versionId = Number(req.params.id);
    if (!documents.UPLOAD_KINDS.includes(req.body.kind)) fail('Üretilen dosyalar yalnız hazırlama ile kaydedilir',403);
    const v = orders.snapshot(db,versionId);
    if (v.status !== 'taslak') fail('Yalnız taslak sürüme dosya eklenebilir',409);
    documents.unlocked(db,versionId);
    if (!dataDir || typeof req.body.path !== 'string') fail('Dosya dizini veya yolu yok');
    const order = db.prepare('SELECT order_no FROM orders WHERE id=?').get(v.order_id);
    const root = documents.directory(dataDir);
    const expected = documents.directory(dataDir,documents.safeSegment(order.order_no),`v${v.version_no}`);
    const candidate = path.resolve(root,req.body.path);
    if (!candidate.startsWith(expected+path.sep)) fail('Dosya bu sipariş sürümünün dizininde değil',403);
    let filePath;
    try { filePath = documents.filePath(dataDir,{path:candidate}); }
    catch (e) { if (e.code === 'ENOENT') fail('Dosya bulunamadı',404); throw e; }
    const buffer = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const validated = documents.validateUpload({buffer,originalname:path.basename(filePath),
      mimetype:{'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.pdf':'application/pdf','.svg':'image/svg+xml'}[ext]});
    if (req.body.kind === 'desen_kaynak_vektor' && !['pdf','svg'].includes(validated.ext)) fail('Hazır vektör PDF veya SVG olmalı');
    const sha256=crypto.createHash('sha256').update(buffer).digest('hex');
    res.status(201).json(orders.addFile(db,versionId,{kind:req.body.kind,path:filePath,sha256},req.user));
  }));
  router.post('/surumler/:id/gonder', wrap((req,res) => res.json(orders.submitForApproval(db,Number(req.params.id),req.user))));
  router.post('/surumler/:id/onay', requireUser('onay'), wrap((req,res) => res.json(approveVersion(db,{versionId:Number(req.params.id),fileId:req.body.fileId,userId:req.user.id,recipes}))));
  router.post('/surumler/:id/revizyon', wrap((req,res) => res.status(201).json(orders.reviseVersion(db,Number(req.params.id),req.body,req.user))));
  router.get('/stok', (req,res) => res.json(stock.stockView(db)));
  router.get('/kumas-turleri', (req,res) => res.json(fabricTypeList(db)));
  router.get('/kartela', (req,res) => res.json(kartelaView()));
  router.post('/stok/kalemler', wrap((req,res) => {
    try { const item = stock.createStockItem(db,req.body,req.user.id); res.status(item.mevcut ? 200 : 201).json(item); }
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
  // G61: measurement confirmations also carry the suggestion (oneri) and whether they ask front/back (onArkaSorusu).
  router.get('/teyitler', (req,res) => res.json(db.prepare('SELECT * FROM confirmations WHERE status=? ORDER BY id').all(req.query.status || 'acik')
    .map(c => require('./documents').confirmationDetails(db,c))));
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
  // G63: approval chain (İşler + Üretim Takip); does nothing unless ONAY_ZINCIRI=1.
  const stopChain = require('./onayZinciri').mount(db, { dataDir, recipes, worker });
  router.use((err,req,res,next) => {
    if (res.headersSent) return next(err);
    const status = err.status || (err.code?.startsWith('SQLITE_CONSTRAINT') ? 409 : 500);
    res.status(status).json({error:status===500 ? 'Sipariş işlemi tamamlanamadı' : err.message});
  });
  app.use('/api/siparis',router); // Parent app already applies CORS_ORIGIN before this router.
  const stopWorker = worker ? outbox.startWorker(db) : () => {};
  const stop = () => { stopWorker(); stopChain(); };
  return { db, stop, close() { stop(); if (!suppliedDb) db.close(); } };
};
