'use strict';

// Private TypeSafe adapter. Only validated, bounded Choice answers leave this module.
// Contract: https://docs.typesafe.ai/api and /primitives/choice.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('../store');

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const PRIVATE_DIR = path.join(DATA_DIR, 'operations', 'private');
const KEY_FILE = path.join(PRIVATE_DIR, 'jev-key.json');
const TIMEOUT_MS = 30000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validKey = value => typeof value === 'string' && /^[\x21-\x7e]{16,4096}$/.test(value);
const probability = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const sameKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length &&
  keys.every(key => Object.prototype.hasOwnProperty.call(value, key));

function credentials() {
  // An explicitly configured environment key always takes precedence over disk.
  if (process.env.TYPESAFE_API_KEY) return validKey(process.env.TYPESAFE_API_KEY) ? process.env.TYPESAFE_API_KEY : null;
  try {
    const saved = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
    return saved?.version === 1 && validKey(saved.apiKey) ? saved.apiKey : null;
  } catch (_) { return null; }
}

function config() {
  const key = credentials();
  return { configured: !!key, model: process.env.TYPESAFE_MODEL || 'jev-latest',
    keyFingerprint: key ? crypto.createHash('sha256').update(key).digest('hex') : null };
}

function configure(apiKey) {
  // Do not trim: whitespace or control characters are likely a bad paste.
  if (!validKey(apiKey)) throw new Error('Jev anahtarının biçimi geçersiz.');
  const temporary = path.join(PRIVATE_DIR, '.jev-key-' + crypto.randomUUID() + '.tmp');
  try {
    fs.mkdirSync(PRIVATE_DIR, { recursive: true, mode: 0o700 });
    fs.chmodSync(PRIVATE_DIR, 0o700);
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, apiKey }), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, KEY_FILE);
  } catch (_) {
    throw new Error('Jev bağlantı ayarı kaydedilemedi.');
  } finally {
    try { fs.unlinkSync(temporary); } catch (_) { /* The atomic rename normally removed it. */ }
  }
  return config();
}

function validateQuestions(state, questions) {
  if (!(typeof state === 'string' || object(state) || Array.isArray(state)) ||
      !object(questions) || !Object.keys(questions).length) throw new Error('Jev karar isteği geçersiz.');
  for (const [name, question] of Object.entries(questions)) {
    if (!name.trim() || !object(question) || question.type !== 'choice' || !object(question.criteria) ||
        !(typeof question.instructions === 'string' || object(question.instructions) || Array.isArray(question.instructions))) {
      throw new Error('Jev karar isteği geçersiz.');
    }
    const options = Object.keys(question.criteria);
    if (!options.length || options.length > 255 || options.some(option => !option.trim())) {
      throw new Error('Jev karar seçenekleri geçersiz.');
    }
  }
}

function validateResponse(response, questions) {
  const invalid = () => new Error('Jev karar yanıtı doğrulanamadı.');
  const names = Object.keys(questions);
  if (!object(response) || !sameKeys(response.answers, names) || typeof response.model !== 'string' ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(response.model)) throw invalid();
  const answers = [];
  for (const name of names) {
    const answer = response.answers[name];
    const options = Object.keys(questions[name].criteria);
    if (!object(answer) || answer.type !== 'choice' || !options.includes(answer.choice) ||
        !probability(answer.confidence) || !sameKeys(answer.probabilities, options) ||
        !options.every(option => probability(answer.probabilities[option]))) throw invalid();
    const values = options.map(option => answer.probabilities[option]);
    if (Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 0.001 ||
        answer.probabilities[answer.choice] < Math.max(...values)) throw invalid();
    // Ignore all unrecognized provider fields; never propagate echoed content.
    answers.push([name, { type: 'choice', choice: answer.choice, confidence: answer.confidence,
      probabilities: Object.fromEntries(options.map(option => [option, answer.probabilities[option]])) }]);
  }
  const result = { model: response.model, answers: Object.fromEntries(answers) };
  if (object(response.usage) && ['input_tokens', 'output_tokens'].every(field =>
    Number.isSafeInteger(response.usage[field]) && response.usage[field] >= 0)) {
    result.usage = { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens };
  }
  return result;
}

async function evaluate(state, questions) {
  validateQuestions(state, questions);
  const key = credentials();
  if (!key) throw new Error('Jev bağlantısı henüz yapılandırılmadı.');
  let body;
  try { body = JSON.stringify({ model: process.env.TYPESAFE_MODEL || 'jev-latest', state, questions }); }
  catch (_) { throw new Error('Jev karar isteği geçersiz.'); }
  let response;
  try {
    response = await fetch(ENDPOINT, { method: 'POST', redirect: 'error',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (_) { throw new Error('Jev bağlantısı başarısız veya zaman aşımına uğradı.'); }
  // Do not read or expose provider error bodies, credentials or request state.
  if (!response.ok) throw new Error('Jev karar hizmetine ulaşılamadı.');
  let result;
  try { result = await response.json(); }
  catch (_) { throw new Error('Jev karar yanıtı okunamadı.'); }
  return validateResponse(result, questions);
}

module.exports = { config, configure, evaluate, validate_choices: validateResponse };
