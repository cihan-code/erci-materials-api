CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('yonetici','ekip')), onay_yetkisi INTEGER NOT NULL DEFAULT 1 CHECK(onay_yetkisi IN (0,1)),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS sessions (
 id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), token_hash TEXT NOT NULL UNIQUE,
 expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS orders (
 id INTEGER PRIMARY KEY, order_no TEXT NOT NULL UNIQUE, job_no TEXT, customer_name TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 deleted_at TEXT, deleted_by INTEGER REFERENCES users(id), deleted_order_no TEXT
);
CREATE TABLE IF NOT EXISTS order_versions (
 id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), version_no INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'taslak' CHECK(status IN ('taslak','onay_bekliyor','onaylandi','eski','iptal')),
 previous_version_id INTEGER REFERENCES order_versions(id), created_by INTEGER NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), UNIQUE(order_id,version_no)
);
CREATE TABLE IF NOT EXISTS stock_items (
 id INTEGER PRIMARY KEY, fabric_key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, color_name TEXT, color_no TEXT,
 unit TEXT NOT NULL CHECK(unit IN ('kg','m','adet')), legacy_fabric_id TEXT UNIQUE, color_hex TEXT
);
CREATE TABLE IF NOT EXISTS order_lines (
 id INTEGER PRIMARY KEY, version_id INTEGER NOT NULL REFERENCES order_versions(id), line_key TEXT NOT NULL,
 product_key TEXT NOT NULL, recipe_version TEXT, fabric_item_id INTEGER REFERENCES stock_items(id), color_name TEXT, kalip_id TEXT, fabric_type TEXT,
 quantity INTEGER NOT NULL CHECK(typeof(quantity)='integer' AND quantity>=0), sizes_json TEXT NOT NULL DEFAULT '{}',
 lining INTEGER NOT NULL DEFAULT 0 CHECK(lining IN (0,1)), material_items_json TEXT NOT NULL DEFAULT '{}', note TEXT,
 numune INTEGER NOT NULL DEFAULT 0 CHECK(numune IN (0,1)),
 UNIQUE(version_id,line_key), CHECK(quantity>0 OR numune=1)
);
CREATE TABLE IF NOT EXISTS applications (
 id INTEGER PRIMARY KEY, line_id INTEGER NOT NULL REFERENCES order_lines(id), kind TEXT NOT NULL CHECK(kind IN ('baski','nakis')),
 position TEXT NOT NULL, width_mm REAL CHECK(width_mm>0), height_mm REAL CHECK(height_mm>0), measure_source TEXT,
 needs_confirmation INTEGER NOT NULL DEFAULT 0 CHECK(needs_confirmation IN (0,1))
);
CREATE TABLE IF NOT EXISTS files (
 id INTEGER PRIMARY KEY, version_id INTEGER NOT NULL REFERENCES order_versions(id), kind TEXT NOT NULL, path TEXT NOT NULL,
 sha256 TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS approvals (
 id INTEGER PRIMARY KEY, version_id INTEGER NOT NULL UNIQUE REFERENCES order_versions(id), approved_by INTEGER NOT NULL REFERENCES users(id),
 approved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), approved_file_id INTEGER NOT NULL REFERENCES files(id)
);
CREATE TABLE IF NOT EXISTS invoice_lines (
 id INTEGER PRIMARY KEY, source_invoice_id TEXT NOT NULL, source_line_id TEXT NOT NULL, supplier TEXT, description TEXT,
 fabric_key TEXT, color_name TEXT, qty_milli INTEGER NOT NULL CHECK(typeof(qty_milli)='integer' AND qty_milli>0),
 unit TEXT NOT NULL CHECK(unit IN ('kg','m','adet')), purchase_ref TEXT,
 delivery_status TEXT NOT NULL DEFAULT 'teslim_bekliyor' CHECK(delivery_status IN ('teslim_bekliyor','teslim_alindi')),
 match_status TEXT NOT NULL DEFAULT 'eslesmedi' CHECK(match_status IN ('eslesti','teyit','eslesmedi')),
 item_id INTEGER REFERENCES stock_items(id), allocation_json TEXT, source TEXT, invoice_no TEXT, invoice_date TEXT,
 supplier_vkn TEXT, unit_price REAL, content_hash TEXT, match_reasons_json TEXT, created_at TEXT, updated_at TEXT, delivery_request_json TEXT,
 UNIQUE(source_invoice_id,source_line_id)
);
CREATE TABLE IF NOT EXISTS stock_movements (
 id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES stock_items(id),
 type TEXT NOT NULL CHECK(type IN ('acilis','giris','tahsis','tahsis_iade','cikis','duzeltme')),
 qty_milli INTEGER NOT NULL CHECK(typeof(qty_milli)='integer' AND (type IN ('acilis','duzeltme') OR qty_milli>0)),
 order_line_id INTEGER REFERENCES order_lines(id), invoice_line_id INTEGER REFERENCES invoice_lines(id), business_key TEXT NOT NULL UNIQUE,
 created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), note TEXT,
 allocation_id INTEGER REFERENCES allocations(id)
);
CREATE TABLE IF NOT EXISTS allocations (
 id INTEGER PRIMARY KEY, order_line_id INTEGER NOT NULL REFERENCES order_lines(id), material_key TEXT NOT NULL,
 item_id INTEGER REFERENCES stock_items(id), need_milli INTEGER NOT NULL CHECK(typeof(need_milli)='integer' AND need_milli>=0),
 reserved_milli INTEGER NOT NULL DEFAULT 0 CHECK(typeof(reserved_milli)='integer' AND reserved_milli>=0),
 shortage_milli INTEGER NOT NULL DEFAULT 0 CHECK(typeof(shortage_milli)='integer' AND shortage_milli>=0),
 consumed_milli INTEGER NOT NULL DEFAULT 0 CHECK(typeof(consumed_milli)='integer' AND consumed_milli>=0), UNIQUE(order_line_id,material_key)
);
CREATE TABLE IF NOT EXISTS confirmations (
 id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('olcu','fatura_eslesme','eksik_alan','baglanti_hatasi','vektor_kalite','eski_surum','musteri_notu')),
 ref_table TEXT NOT NULL, ref_id INTEGER NOT NULL, message TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'acik' CHECK(status IN ('acik','cozuldu')), resolved_by INTEGER REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS outbox (
 id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('atolye_dosya','maliyet_aktarim')), idempotency_key TEXT NOT NULL UNIQUE,
 version_id INTEGER NOT NULL REFERENCES order_versions(id), payload_json TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'bekliyor' CHECK(status IN ('bekliyor','isleniyor','tamam','basarisiz','iptal','manuel_bekliyor','fiyat_bekliyor')),
 attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, provider_ref TEXT, claim_token TEXT,
 next_run_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS audit_log (
 id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), action TEXT NOT NULL, ref TEXT NOT NULL,
 detail_json TEXT NOT NULL DEFAULT '{}', at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS stock_movements_item ON stock_movements(item_id);
CREATE INDEX IF NOT EXISTS allocation_item ON allocations(item_id);
CREATE INDEX IF NOT EXISTS outbox_due ON outbox(status,next_run_at);
CREATE INDEX IF NOT EXISTS lines_version ON order_lines(version_id);
CREATE INDEX IF NOT EXISTS files_version ON files(version_id,kind);
CREATE INDEX IF NOT EXISTS confirmations_ref ON confirmations(ref_table,ref_id,status);
-- G64: customer link. Only the SHA-256 of the token is stored; the token itself is shown once.
CREATE TABLE IF NOT EXISTS customer_links (
 id INTEGER PRIMARY KEY, version_id INTEGER NOT NULL REFERENCES order_versions(id), token_hash TEXT NOT NULL UNIQUE,
 expires_at TEXT NOT NULL, revoked_at TEXT, created_by INTEGER NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS customer_notes (
 id INTEGER PRIMARY KEY, version_id INTEGER NOT NULL REFERENCES order_versions(id), link_id INTEGER NOT NULL REFERENCES customer_links(id),
 full_name TEXT NOT NULL, note TEXT NOT NULL, ip TEXT, user_agent TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS customer_approvals (
 id INTEGER PRIMARY KEY, version_id INTEGER NOT NULL UNIQUE REFERENCES order_versions(id), link_id INTEGER NOT NULL REFERENCES customer_links(id),
 full_name TEXT NOT NULL, ip TEXT, user_agent TEXT, approved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS customer_links_version ON customer_links(version_id);
CREATE INDEX IF NOT EXISTS customer_notes_version ON customer_notes(version_id);
