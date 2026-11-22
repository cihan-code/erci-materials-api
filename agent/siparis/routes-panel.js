'use strict';
// Read-only summary for the Ajan Paneli. No price, amount or write path here.
const { serviceOrUser } = require('./auth');
function panelData(db) {
  const rows = (sql, ...a) => db.prepare(sql).all(...a);
  const confirmations = rows("SELECT kind,COUNT(*) AS n FROM confirmations WHERE status='acik' GROUP BY kind");
  const outboxCount = (kind, status) => db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE kind=? AND status=?').get(kind, status).n;
  const stok = rows(`SELECT s.name,s.color_name,s.unit,
      COALESCE((SELECT SUM(CASE WHEN type IN ('acilis','giris','duzeltme') THEN qty_milli WHEN type='cikis' THEN -qty_milli ELSE 0 END) FROM stock_movements WHERE item_id=s.id),0) AS total,
      COALESCE((SELECT SUM(reserved_milli) FROM allocations WHERE item_id=s.id),0) AS reserved,
      COALESCE((SELECT SUM(shortage_milli) FROM allocations WHERE item_id=s.id),0) AS shortage
    FROM stock_items s ORDER BY s.id`);
  return {
    surum: 1,
    uretildi: new Date().toISOString(),
    onay_bekleyen: rows(`SELECT o.order_no AS siparis_no,v.version_no AS surum,o.customer_name AS musteri,v.created_at AS gonderildi
      FROM order_versions v JOIN orders o ON o.id=v.order_id WHERE v.status='onay_bekliyor' AND o.deleted_at IS NULL ORDER BY v.id`),
    teyitler: {
      toplam: confirmations.reduce((s, r) => s + r.n, 0),
      turlere_gore: Object.fromEntries(confirmations.map(r => [r.kind, r.n])),
    },
    tedarik_bekleyen: stok.filter(i => i.shortage > 0).map(i => ({ kalem: i.name, renk: i.color_name, kg: i.unit === 'kg' ? i.shortage / 1000 : null })),
    atolye: { elle_bekleyen: outboxCount('atolye_dosya', 'manuel_bekliyor'), basarisiz: outboxCount('atolye_dosya', 'basarisiz') },
    maliyet: {
      fiyat_bekleyen: rows(`SELECT o.order_no AS siparis_no,v.version_no AS surum FROM outbox x JOIN order_versions v ON v.id=x.version_id
        JOIN orders o ON o.id=v.order_id WHERE x.kind='maliyet_aktarim' AND x.status='fiyat_bekliyor' ORDER BY x.id`),
      basarisiz: outboxCount('maliyet_aktarim', 'basarisiz'),
    },
    // G63: approval chain; failures and the last run's warnings (a field kept because it was changed by hand).
    onay_zinciri: {
      basarisiz: outboxCount('onay_zinciri', 'basarisiz'),
      bekleyen: outboxCount('onay_zinciri', 'bekliyor'),
      uyarilar: db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='onay_zinciri'").get()
        ? rows(`SELECT o.order_no AS siparis_no,z.warnings_json FROM onay_zinciri z JOIN orders o ON o.id=z.order_id
            WHERE z.warnings_json<>'[]' ORDER BY z.updated_at DESC LIMIT 50`).flatMap(r => JSON.parse(r.warnings_json).map(mesaj => ({ siparis_no: r.siparis_no, mesaj })))
        : [],
    },
    stok_ozet: {
      kalem_sayisi: stok.length,
      kullanilabilir_kg_toplam: stok.filter(i => i.unit === 'kg').reduce((s, i) => s + (i.total - i.reserved), 0) / 1000,
    },
  };
}
module.exports = function mountPanel(router, db) {
  router.get('/panel-veri', serviceOrUser(db), (req, res) => res.json(panelData(db)));
};
module.exports.panelData = panelData;
