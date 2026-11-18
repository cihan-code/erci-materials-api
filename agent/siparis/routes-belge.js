'use strict';
const express = require('express');
const multer = require('multer');
const documents = require('./documents');
const flats = require('./flats');
const orders = require('./orders');
const { authFor } = require('./auth');
const { fail, integer } = require('./db');

// Mounted after authentication and before the core /dosyalar and /gonder routes.
module.exports = function documentRouter({db,dataDir}) {
  documents.init(db);
  documents.registerWorkshop(db,dataDir);
  const router=express.Router();
  const requireUser=authFor(db);
  const wrap=fn=>(req,res,next)=>Promise.resolve().then(()=>fn(req,res,next)).catch(next);
  const id=req=>integer(Number(req.params.id),'id',1);
  const upload=multer({storage:multer.memoryStorage(),preservePath:true,
    limits:{fileSize:25*1024*1024,files:1,fields:12,fieldSize:8192,parts:13}}).single('file');
  const receive=(req,res,next)=>upload(req,res,err=> {
    if (err) return res.status(err.code==='LIMIT_FILE_SIZE'?413:400).json({error:err.code==='LIMIT_FILE_SIZE'?'Dosya en çok 25 MB olabilir':'Geçersiz yükleme'});
    next();
  });
  router.post('/surumler/:id/dosyalar',(req,res,next)=> {
    // Preserve the existing core interface for registered generated paths.
    if (!req.is('multipart/form-data')) return next('route');
    next();
  },receive,wrap((req,res)=>res.status(201).json(documents.upload(db,dataDir,id(req),req.body,documents.validateUpload(req.file),req.user))));
  router.get('/dosyalar/:id',wrap((req,res)=> {
    const file=db.prepare('SELECT * FROM files WHERE id=?').get(id(req));
    if (!file) fail('Dosya bulunamadı',404);
    const buffer=documents.readFile(dataDir,file);
    const meta=db.prepare('SELECT mime FROM document_file_meta WHERE file_id=?').get(file.id);
    res.set('X-Content-Type-Options','nosniff');
    res.set('Content-Security-Policy',"default-src 'none'; sandbox");
    res.attachment(require('node:path').basename(file.path));
    res.type(meta?.mime || 'application/octet-stream').send(buffer);
  }));
  router.get('/duz-cizimler',wrap((req,res)=>res.json(flats.list(db))));
  router.post('/duz-cizimler',receive,wrap((req,res)=>res.status(201).json(flats.upload(db,dataDir,req.body,documents.validateUpload(req.file),req.user))));
  router.put('/duz-cizimler/:id/referans',requireUser('onay'),wrap((req,res)=>res.json(flats.saveReference(db,req.params.id,req.body,req.user))));
  router.post('/uygulamalar/olc',wrap((req,res)=>res.status(201).json(documents.measure(db,dataDir,req.body,req.user))));
  router.post('/surumler/:id/hazirla',wrap(async(req,res)=>res.json(await documents.prepare(db,dataDir,id(req),req.user,req.query.yeniden==='1'))));
  router.post('/surumler/:id/gonder',wrap((req,res,next)=> {
    const v=orders.snapshot(db,id(req));
    documents.unlocked(db,v.id);
    documents.assertMeasurements(db,v);
    documents.assertFresh(db,v);
    if (!v.files.some(f=>f.kind==='onay_formu')) fail('Onay formu olmayan sürüm onaya gönderilemez; önce hazırlayın',409);
    next();
  }));
  router.post('/surumler/:id/onay',requireUser('onay'),wrap((req,res,next)=> {
    const v=orders.snapshot(db,id(req));
    if (!v.files.some(f=>f.id===req.body.fileId && f.kind==='onay_formu')) fail('Onay dosyası bu sürümün onay_formu olmalı',409);
    documents.assertMeasurements(db,v);
    documents.assertFresh(db,v);
    next();
  }));
  router.get('/surumler/:id/atolye-paketi',wrap((req,res)=>res.json(documents.workshopPackage(db,id(req)))));
  return router;
};
