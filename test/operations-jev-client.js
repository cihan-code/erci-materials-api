'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Only synthetic credentials and state; the real fetch is never called.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'merci-jev-client-'));
delete process.env.TYPESAFE_API_KEY;
delete process.env.TYPESAFE_MODEL;
const dir = process.env.DATA_DIR;
const privateDir = path.join(dir, 'operations', 'private');
const keyFile = path.join(privateDir, 'jev-key.json');
const client = require('../agent/operations/jev-client');
const storedKey = 'synthetic-stored-key-0000000000';
const envKey = 'synthetic-environment-key-0000000000';
const state = { jobs: [{ code: 'IS-TEST', remaining: 5, completed: ['cut'] }] };
const questions = { next: { type: 'choice', instructions: 'Choose the next safe task for IS-TEST.',
  criteria: { confirm: 'Confirm missing paper for five pieces.', defer: 'Leave for later.' } } };
const good = () => ({ model: 'jev-1.13.0', answers: { next: { type: 'choice', choice: 'confirm',
  confidence: 0.8, probabilities: { confirm: 0.9, defer: 0.1 } } }, usage: { input_tokens: 123, output_tokens: 20 } });
let calls = 0;
global.fetch = async () => { throw new Error('Unexpected request: test fetch stub not configured.'); };
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

test('private key setting is atomic, private, reusable and never returned', () => {
  assert.deepEqual(client.config(), { configured: false, model: 'jev-latest', keyFingerprint: null });
  const configured = client.configure(storedKey);
  assert.equal(configured.configured, true);
  assert.match(configured.keyFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(configured).includes(storedKey), false);
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(privateDir).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(privateDir), ['jev-key.json']);
  assert.equal(JSON.parse(fs.readFileSync(keyFile, 'utf8')).apiKey, storedKey);
  assert.deepEqual(client.config(), configured);
  const next = client.configure(storedKey + '-replacement');
  assert.notEqual(next.keyFingerprint, configured.keyFingerprint);
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  client.configure(storedKey);
});

test('rejects invalid keys without replacing the valid credential or echoing input', () => {
  const before = fs.readFileSync(keyFile, 'utf8');
  for (const key of [null, {}, '', 'short', 'x'.repeat(4097), 'a'.repeat(20) + '\n', 'bad whitespace credential', 'ü'.repeat(20)]) {
    assert.throws(() => client.configure(key), { message: 'Jev anahtarının biçimi geçersiz.' });
    assert.equal(fs.readFileSync(keyFile, 'utf8'), before);
  }
});

test('failed atomic replacement preserves the existing key and removes temporary files', () => {
  const before = fs.readFileSync(keyFile, 'utf8');
  const actualRename = fs.renameSync;
  fs.renameSync = () => { throw new Error('Synthetic filesystem failure with private details'); };
  try { assert.throws(() => client.configure(envKey), { message: 'Jev bağlantı ayarı kaydedilemedi.' }); }
  finally { fs.renameSync = actualRename; }
  assert.equal(fs.readFileSync(keyFile, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(privateDir), ['jev-key.json']);
});

test('environment key wins and the request uses one timed, nonredirecting call', async () => {
  const diskFingerprint = client.config().keyFingerprint;
  process.env.TYPESAFE_API_KEY = envKey;
  process.env.TYPESAFE_MODEL = 'jev-1.13.0';
  assert.notEqual(client.config().keyFingerprint, diskFingerprint);
  assert.equal(client.config().model, 'jev-1.13.0');
  calls = 0;
  const actualTimeout = AbortSignal.timeout;
  let timeout;
  AbortSignal.timeout = milliseconds => { timeout = milliseconds; return new AbortController().signal; };
  global.fetch = async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer ' + envKey);
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(options.body), { model: 'jev-1.13.0', state, questions });
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, json: async () => good() };
  };
  try { assert.deepEqual(await client.evaluate(state, questions), good()); }
  finally { AbortSignal.timeout = actualTimeout; }
  assert.equal(timeout, 30000);
  assert.equal(calls, 1);
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_MODEL;
  assert.equal(client.config().keyFingerprint, diskFingerprint);
});

test('ties are allowed, sum rounding tolerated, and unrecognized provider fields discarded', async () => {
  const result = good();
  result.answers.next.probabilities = { confirm: 0.5, defer: 0.5 };
  result.answers.next.choice = 'defer';
  result.provider_debug = 'Do not return this';
  result.answers.next.trace = 'Do not return this either';
  global.fetch = async () => ({ ok: true, json: async () => result });
  const validated = await client.evaluate(state, questions);
  assert.equal(validated.answers.next.choice, 'defer');
  assert.equal(JSON.stringify(validated).includes('Do not return'), false);
  result.answers.next.probabilities = { confirm: 0.5001, defer: 0.5001 };
  await client.evaluate(state, questions);
  assert.deepEqual(client.validate_choices(result, questions), await client.evaluate(state, questions));
});

test('rejects incomplete, inconsistent and out-of-range Choice responses as a whole', async () => {
  const changes = [
    r => { delete r.answers; },
    r => { r.answers = []; },
    r => { r.answers.other = r.answers.next; },
    r => { r.answers.next.type = 'noul'; },
    r => { r.answers.next.choice = 'invented'; },
    r => { r.answers.next.choice = 'defer'; },
    r => { delete r.answers.next.confidence; },
    r => { r.answers.next.confidence = NaN; },
    r => { r.answers.next.confidence = true; },
    r => { r.answers.next.confidence = 1.1; },
    r => { delete r.answers.next.probabilities.defer; },
    r => { r.answers.next.probabilities.other = 0; },
    r => { r.answers.next.probabilities.confirm = Infinity; },
    r => { r.answers.next.probabilities.confirm = -0.1; },
    r => { r.answers.next.probabilities.confirm = '0.9'; },
    r => { r.answers.next.probabilities.confirm = 0.5; },
    r => { r.model = 'unexpected\ncontent'; },
  ];
  for (const change of changes) {
    const result = good(); change(result);
    global.fetch = async () => ({ ok: true, json: async () => result });
    await assert.rejects(client.evaluate(state, questions), { message: 'Jev karar yanıtı doğrulanamadı.' });
  }
});

test('invalid requests fail before fetch, including Choice option overflow', async () => {
  calls = 0;
  global.fetch = async () => { calls++; throw new Error('Should not call'); };
  for (const request of [{}, [], { next: { type: 'score', criteria: ['a', 'b'], instructions: 'Choose' } },
    { next: { type: 'choice', criteria: {}, instructions: 'Choose' } },
    { next: { type: 'choice', criteria: Object.fromEntries(Array.from({ length: 256 }, (_, i) => ['o' + i, 'Option'])), instructions: 'Choose' } }]) {
    await assert.rejects(client.evaluate(state, request));
  }
  await assert.rejects(client.evaluate(undefined, questions));
  assert.equal(calls, 0);
});

test('HTTP, network and malformed JSON failures never retry or expose details', async () => {
  const secretDetail = 'provider debug synthetic confidential details';
  for (const mode of ['http', 'network', 'json']) {
    calls = 0;
    global.fetch = async () => {
      calls++;
      if (mode === 'network') throw new Error(secretDetail);
      if (mode === 'http') return { ok: false, status: 429,
        text: async () => { throw new Error('Error body must not be read'); } };
      return { ok: true, json: async () => { throw new Error(secretDetail); } };
    };
    await assert.rejects(client.evaluate(state, questions), error => !error.message.includes(secretDetail));
    assert.equal(calls, 1);
  }
});

test('missing, corrupt and invalid environment configuration cannot make a request', async () => {
  calls = 0;
  global.fetch = async () => { calls++; throw new Error('Should not call'); };
  process.env.TYPESAFE_API_KEY = 'invalid key';
  assert.equal(client.config().configured, false); // Do not silently use disk over an explicit env setting.
  await assert.rejects(client.evaluate(state, questions), { message: 'Jev bağlantısı henüz yapılandırılmadı.' });
  delete process.env.TYPESAFE_API_KEY;
  fs.writeFileSync(keyFile, 'corrupt JSON');
  assert.equal(client.config().configured, false);
  await assert.rejects(client.evaluate(state, questions));
  fs.unlinkSync(keyFile);
  assert.equal(client.config().configured, false);
  await assert.rejects(client.evaluate(state, questions));
  assert.equal(calls, 0);
});
