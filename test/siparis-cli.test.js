'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');
const { openDb } = require('../agent/siparis/db');

const CLI = path.join(__dirname, '../agent/siparis/cli.js');
const run = (dir, args, input = '', env = {}) => spawnSync(process.execPath, [CLI, ...args],
  { env: { ...process.env, DATA_DIR: dir, SIPARIS_SIFRE: '', ...env }, input, encoding: 'utf8' });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'siparis-cli-'));
const query = (dir, sql) => { const db = openDb(path.join(dir, 'siparis.sqlite')); try { return db.prepare(sql).all(); } finally { db.close(); } };

test('kullanici ekle, listele, onay yetkisi ve sifre degistir', () => {
  const dir = tmp();
  assert.equal(run(dir, ['kullanici-ekle', 'Deneme Bir', 'ekip'], 'gizli-sifre-1\n').status, 0);
  const list = run(dir, ['kullanici-listele']);
  assert.match(list.stdout, /Deneme Bir\tekip\tonay:evet\t/);
  assert.doesNotMatch(list.stdout, /scrypt/);
  assert.equal(run(dir, ['kullanici-onaysiz', 'Deneme Bir']).status, 0);
  assert.match(run(dir, ['kullanici-listele']).stdout, /onay:hayır/);
  assert.equal(run(dir, ['kullanici-onayli', 'Deneme Bir']).status, 0);
  assert.match(run(dir, ['kullanici-listele']).stdout, /onay:evet/);
  assert.equal(query(dir, "SELECT * FROM audit_log WHERE action='onay_yetkisi'").length, 2);
  assert.notEqual(run(dir, ['kullanici-onaysiz', 'Yok Kimse']).status, 0);

  const db = openDb(path.join(dir, 'siparis.sqlite'));
  const u = db.prepare("SELECT id,password_hash FROM users").get();
  db.prepare("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES(?,?,?)").run(u.id, 'tok', '2999-01-01T00:00:00Z');
  db.close();
  assert.equal(run(dir, ['sifre-degistir', 'Deneme Bir'], '', { SIPARIS_SIFRE: 'yeni-sifre-22' }).status, 0);
  assert.equal(query(dir, 'SELECT * FROM sessions').length, 0);
  assert.notEqual(query(dir, 'SELECT password_hash h FROM users')[0].h, u.password_hash);
  assert.equal(query(dir, "SELECT * FROM audit_log WHERE action='sifre_degistir'").length, 1);
});

test('eski kumaslari aktar: dosya yok, kuru calistirma, gercek ve ikinci calistirma', () => {
  const dir = tmp();
  const missing = run(dir, ['eski-kumaslari-aktar']);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /stok-data\.json/);

  fs.writeFileSync(path.join(dir, 'stok-data.json'), JSON.stringify({ data: { fabrics: [
    { id: 'k1', name: 'Zzz Bilinmez Kumaş', colorName: 'Qqq', unit: 'm' },
    { id: 'k2', name: 'Xxx Garip', unit: 'm' }
  ], openingBalances: [{ fabricId: 'k1', quantity: 50 }] } }));
  const dry = run(dir, ['eski-kumaslari-aktar', '--kuru']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /KURU/);
  assert.match(dry.stdout, /Aktarılan kalem: 2;.*legacy: kalan: 2; açılan teyit: 2/);
  assert.equal(query(dir, 'SELECT * FROM stock_items').length, 0);
  assert.equal(query(dir, 'SELECT * FROM confirmations').length, 0);

  const real = run(dir, ['eski-kumaslari-aktar']);
  assert.equal(real.status, 0, real.stderr);
  assert.match(real.stdout, /Aktarılan kalem: 2;/);
  assert.equal(query(dir, 'SELECT * FROM stock_items').length, 2);
  assert.equal(query(dir, 'SELECT * FROM stock_movements').length, 0);
  const again = run(dir, ['eski-kumaslari-aktar']);
  assert.match(again.stdout, /Aktarılan kalem: 0;/);
  assert.equal(query(dir, 'SELECT * FROM stock_items').length, 2);
});

// A real PTY catches echo/raw-mode regressions that piped child stdin cannot expose.
const PTY_RUNNER = String.raw`
import json, os, pty, select, signal, subprocess, sys, termios, time
config = json.load(sys.stdin)
master, slave = pty.openpty()
before = termios.tcgetattr(slave)
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave)
output = bytearray()
modes = []
def read_until(marker):
    deadline = time.monotonic() + 8
    start = len(output)
    while marker not in output[start:]:
        if time.monotonic() > deadline:
            raise RuntimeError('TTY prompt timeout: ' + output.decode('utf8', 'replace'))
        if select.select([master], [], [], 0.05)[0]:
            output.extend(os.read(master, 65536))
        elif child.poll() is not None:
            raise RuntimeError('CLI ended before TTY prompt')
try:
    for step in config['steps']:
        read_until(step['prompt'].encode('utf8'))
        flags = termios.tcgetattr(slave)[3]
        modes.append({'echo': bool(flags & termios.ECHO), 'canonical': bool(flags & termios.ICANON)})
        if 'signal' in step:
            child.send_signal(getattr(signal, step['signal']))
        else:
            os.write(master, step['input'].encode('utf8'))
    deadline = time.monotonic() + 8
    while child.poll() is None:
        if time.monotonic() > deadline:
            raise RuntimeError('CLI did not exit after TTY input')
        if select.select([master], [], [], 0.05)[0]:
            output.extend(os.read(master, 65536))
    while select.select([master], [], [], 0)[0]:
        output.extend(os.read(master, 65536))
    print(json.dumps({'status': child.returncode, 'output': output.decode('utf8', 'replace'),
        'modes': modes, 'restored': termios.tcgetattr(slave) == before}))
finally:
    if child.poll() is None:
        child.kill()
        child.wait()
    os.close(master)
    os.close(slave)
`;
const runTty = (dir, args, steps, env = {}) => {
  const result = spawnSync('python3', ['-c', PTY_RUNNER, process.execPath, CLI, ...args], {
    env: { ...process.env, DATA_DIR: dir, SIPARIS_SIFRE: '', ...env },
    input: JSON.stringify({ steps }), encoding: 'utf8', timeout: 20000
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.restored, true, 'terminal flags must be restored before CLI exits');
  assert.ok(response.modes.length > 0);
  for (const mode of response.modes) assert.deepEqual(mode, { echo: false, canonical: false });
  return response;
};
const passwordSteps = (password, repeat = password) => [
  { prompt: 'Şifre: ', input: password + '\r' },
  { prompt: 'Şifre (tekrar): ', input: repeat + '\r' }
];

test('non-TTY keeps stdin/env precedence and rejects empty or short passwords for both commands', () => {
  const dir = tmp();
  const first = run(dir, ['kullanici-ekle', 'Pipe', 'ekip'], 'pipe-password\r\n');
  assert.equal(first.status, 0, first.stderr);
  assert.doesNotMatch(first.stderr, /Şifre:/);
  const before = query(dir, 'SELECT password_hash FROM users')[0].password_hash;
  for (const args of [['kullanici-ekle', 'Invalid', 'ekip'], ['sifre-degistir', 'Pipe']]) {
    for (const password of ['', '1234567']) {
      for (const env of [{}, { SIPARIS_SIFRE: password }]) {
        const invalid = run(dir, args, password + '\n', env);
        assert.equal(invalid.status, 1);
        assert.match(invalid.stderr, /8–1024/);
        assert.doesNotMatch(invalid.stderr, /Şifre:/);
      }
    }
  }
  assert.equal(query(dir, 'SELECT password_hash FROM users')[0].password_hash, before);
  assert.equal(query(dir, 'SELECT count(*) n FROM users')[0].n, 1);
  const changed = run(dir, ['sifre-degistir', 'Pipe'], 'short\n', { SIPARIS_SIFRE: 'env-password' });
  assert.equal(changed.status, 0, changed.stderr);
  assert.notEqual(query(dir, 'SELECT password_hash FROM users')[0].password_hash, before);
});

test('TTY creates and changes passwords without echo, ignores env and supports Unicode/backspace', () => {
  const dir = tmp();
  const created = runTty(dir, ['kullanici-ekle', 'Terminal', 'ekip'],
    passwordSteps('şifre-🙂x\u007f-123', 'şifre-🙂-123'), { SIPARIS_SIFRE: 'ignored-env-password' });
  assert.equal(created.status, 0, created.output);
  assert.match(created.output, /Kullanıcı eklendi/);
  assert.doesNotMatch(created.output, /şifre-|ignored-env-password/);
  const { verifyPassword } = require('../agent/siparis/auth');
  const before = query(dir, 'SELECT password_hash FROM users')[0].password_hash;
  const changed = runTty(dir, ['sifre-degistir', 'Terminal'], passwordSteps('terminal-new-password'));
  assert.equal(changed.status, 0, changed.output);
  assert.match(changed.output, /Şifre değiştirildi/);
  assert.doesNotMatch(changed.output, /terminal-new-password/);
  assert.notEqual(query(dir, 'SELECT password_hash FROM users')[0].password_hash, before);
  return verifyPassword('şifre-🙂-123', before).then(valid => assert.equal(valid, true));
});

test('TTY accepts pasted CRLF password pairs in one chunk without waiting for more input', () => {
  const dir = tmp();
  const result = runTty(dir, ['kullanici-ekle', 'Paste', 'ekip'], [
    { prompt: 'Şifre: ', input: 'paste-password\r\npaste-password\r\n' }
  ]);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Şifre \(tekrar\):/);
  assert.doesNotMatch(result.output, /paste-password/);
});

test('TTY rejects mismatched, empty and short passwords without changing users or sessions', () => {
  const dir = tmp();
  assert.equal(run(dir, ['kullanici-ekle', 'Existing', 'ekip'], 'existing-password\n').status, 0);
  const before = query(dir, 'SELECT password_hash FROM users')[0].password_hash;
  const db = openDb(path.join(dir, 'siparis.sqlite'));
  db.prepare("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES(1,'keep','2999-01-01T00:00:00Z')").run();
  db.close();
  for (const args of [['kullanici-ekle', 'Invalid', 'ekip'], ['sifre-degistir', 'Existing']]) {
    for (const [password, repeat, message] of [
      ['first-password', 'other-password', /uyuşmuyor/], ['', '', /8–1024/], ['1234567', '1234567', /8–1024/]
    ]) {
      const invalid = runTty(dir, args, passwordSteps(password, repeat));
      assert.equal(invalid.status, 1, invalid.output);
      assert.match(invalid.output, message);
      if (password) assert.ok(!invalid.output.includes(password), 'password must not be echoed');
    }
  }
  assert.equal(query(dir, 'SELECT password_hash FROM users')[0].password_hash, before);
  assert.equal(query(dir, 'SELECT count(*) n FROM users')[0].n, 1);
  assert.equal(query(dir, 'SELECT count(*) n FROM sessions')[0].n, 1);
});

test('TTY restores terminal flags after Ctrl+C, external signals and Ctrl+D', () => {
  for (const [action, status, message] of [
    [{ input: 'partial-secret\u0003' }, 130, /iptal/],
    [{ signal: 'SIGINT' }, 130, /iptal/],
    [{ signal: 'SIGTERM' }, 143, /iptal/],
    [{ input: '\u0004' }, 1, /tamamlanmadı/]
  ]) {
    const dir = tmp();
    const result = runTty(dir, ['kullanici-ekle', 'Cancelled', 'ekip'], [{ prompt: 'Şifre: ', ...action }]);
    assert.equal(result.status, status, result.output);
    assert.match(result.output, message);
    assert.doesNotMatch(result.output, /partial-secret/);
    assert.equal(fs.existsSync(path.join(dir, 'siparis.sqlite')), false);
  }
});
