'use strict';
// Eski uclar (x-api-key) panel icin kisi oturumunu (Bearer) da kabul eder. Gercek server.js alt
// surecte calisir; anahtar, kullanici ve veriler uydurmadir ve gecici klasordedir.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn } = require('child_process');
const { openDb } = require('../agent/siparis/db');
const auth = require('../agent/siparis/auth');

const KEY = 'synthetic-legacy-key';
const SERVICE_KEY = 'synthetic-service-key-0123456789';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eski-uc-oturum-'));
const port = 20000 + Math.floor(Math.random() * 10000);
const base = 'http://127.0.0.1:' + port;
let child, db, logs = '';

before(async () => {
  db = openDb(path.join(dir, 'siparis.sqlite'));
  await auth.createUser(db, { name: 'Deneme Ekip', password: 'synthetic-password', role: 'ekip', onayYetkisi: false });
  child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR: dir, API_KEY: KEY, SIPARIS_SERVIS_ANAHTARI: SERVICE_KEY, PORT: String(port),
      CORS_ORIGIN: 'https://panel.example.invalid', ANTHROPIC_API_KEY: 'test-placeholder', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', d => { logs += d; }); child.stderr.on('data', d => { logs += d; });
  for (let i = 0; i < 200 && !logs.includes('uzerinde calisiyor'); i++) await new Promise(r => setTimeout(r, 30));
  assert.ok(logs.includes('uzerinde calisiyor'), logs);
  assert.doesNotMatch(logs, /modul acilamadi/);
});
after(() => { child?.kill(); db?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const login = async () => {
  const res = await fetch(base + '/api/siparis/giris', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ad: 'Deneme Ekip', sifre: 'synthetic-password' }) });
  assert.equal(res.status, 200);
  return (await res.json()).token;
};
const bearer = token => ({ authorization: 'Bearer ' + token });
const get = (route, headers = {}) => fetch(base + route, { headers });
const post = (route, body, headers = {}) => fetch(base + route, { method: 'POST',
  headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const stokFile = path.join(dir, 'stok-data.json');
const writes = () => db.prepare("SELECT * FROM audit_log WHERE action='eski_uc_yazma' ORDER BY id").all();
// Yanit 'close' olayindan sonra yazilir; istemci yaniti aldiginda kayit birkac ms gecikebilir.
async function waitFor(fn) { for (let i = 0; i < 50 && !fn(); i++) await new Promise(r => setTimeout(r, 10)); return fn(); }

test('no key and no session is 401 and the write does not happen', async () => {
  for (const route of ['/api/stokdata', '/api/paneldata', '/api/folders', '/api/agent/operations']) {
    const res = await get(route);
    assert.equal(res.status, 401, route);
    assert.equal((await res.json()).code, 'AUTH-401');
  }
  assert.equal((await post('/api/stokdata', { data: { samples: [] } })).status, 401);
  assert.equal(fs.existsSync(stokFile), false);
  assert.equal((await get('/api/stokdata', { 'x-api-key': 'wrong-key' })).status, 401);
});

test('a valid session opens legacy reads and writes, and session writes are audited under the person', async () => {
  const token = await login();
  const read = await get('/api/stokdata', bearer(token));
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), { data: null, updatedAt: null });
  assert.equal((await get('/api/folders', bearer(token))).status, 200);
  assert.equal(writes().length, 0, 'reads are not audited');

  const saved = await post('/api/stokdata', { data: { samples: [{ id: 's1', name: 'Uydurma numune' }] } }, bearer(token));
  assert.equal(saved.status, 200);
  assert.equal(JSON.parse(fs.readFileSync(stokFile, 'utf8')).data.samples[0].name, 'Uydurma numune');
  assert.ok(await waitFor(() => writes().length === 1));
  const row = writes()[0];
  const user = db.prepare("SELECT id FROM users WHERE name='Deneme Ekip'").get();
  assert.equal(row.user_id, user.id);
  assert.equal(row.ref, 'POST /api/stokdata');
  assert.deepEqual(JSON.parse(row.detail_json), { user: 'Deneme Ekip', status: 200 });

  // A rejected write is still attributed, with its real status.
  assert.equal((await post('/api/stokdata', {}, bearer(token))).status, 400);
  assert.ok(await waitFor(() => writes().length === 2));
  assert.equal(JSON.parse(writes()[1].detail_json).status, 400);
});

test('an expired, deleted or malformed session is 401', async () => {
  const expiredToken = 'ab'.repeat(32);
  const user = db.prepare("SELECT id FROM users WHERE name='Deneme Ekip'").get();
  db.prepare('INSERT INTO sessions(user_id,token_hash,expires_at) VALUES(?,?,?)')
    .run(user.id, require('crypto').createHash('sha256').update(expiredToken).digest('hex'), new Date(Date.now() - 1000).toISOString());
  assert.equal((await get('/api/stokdata', bearer(expiredToken))).status, 401);

  const token = await login();
  assert.equal((await get('/api/stokdata', bearer(token))).status, 200);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
  assert.equal((await get('/api/stokdata', bearer(token))).status, 401);
  const before = writes().length;
  assert.equal((await post('/api/stokdata', { data: { samples: [] } }, bearer(token))).status, 401);

  for (const header of ['Bearer ' + 'zz'.repeat(32), 'Bearer ' + KEY, 'Basic ' + 'ab'.repeat(32), 'Bearer'])
    assert.equal((await get('/api/stokdata', { authorization: header })).status, 401, header);
  assert.equal(JSON.parse(fs.readFileSync(stokFile, 'utf8')).data.samples[0].name, 'Uydurma numune');
  assert.equal(writes().length, before);
});

test('the siparis service key stays separate and does not open legacy routes', async () => {
  assert.equal((await get('/api/stokdata', bearer(SERVICE_KEY))).status, 401);
  assert.equal((await get('/api/siparis/panel-veri', bearer(SERVICE_KEY))).status, 200);
});

test('the legacy key still works for server-to-server clients and is not audited as a person', async () => {
  const before = writes().length;
  assert.equal((await get('/api/stokdata', { 'x-api-key': KEY })).status, 200);
  assert.equal((await post('/api/stokdata', { data: { samples: [] } }, { 'x-api-key': KEY })).status, 200);
  assert.equal((await get('/api/paneldata', { 'x-api-key': KEY })).status, 200);
  // A valid key wins even if a stale session is also sent.
  assert.equal((await get('/api/stokdata', { 'x-api-key': KEY, ...bearer('cd'.repeat(32)) })).status, 200);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(writes().length, before);
});

test('CORS preflight allows the Authorization header from the panel origin', async () => {
  const res = await fetch(base + '/api/stokdata', { method: 'OPTIONS', headers: { origin: 'https://panel.example.invalid',
    'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } });
  assert.ok(res.status === 204 || res.status === 200, String(res.status));
  assert.match(res.headers.get('access-control-allow-headers') || '', /authorization/i);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://panel.example.invalid');
});
