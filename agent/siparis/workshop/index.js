'use strict';
const { manual } = require('./manual');
const { buildWorkshopMessage, fileName } = require('./message');
const { createMemoryStore, createTestAdapter, temporary } = require('./test');
const { createCloudAdapter } = require('./cloud');

function normalizeJob(job) {
  const payload = typeof job.payload_json === 'string' ? JSON.parse(job.payload_json)
    : job.payload_json || job.payload || job;
  const files = payload.files || (payload.file ? [payload.file] : []);
  if (!Array.isArray(files) || !files.length) throw new TypeError('payload.files veya payload.file gerekli');
  const base = job.idempotency_key || job.idempotencyKey || payload.idempotencyKey;
  if (!base) throw new TypeError('Kalici idempotency_key gerekli');
  const normalized = files.map(file => ({ ...file, name: fileName(file),
    ...(file.buffer?.type === 'Buffer' && Array.isArray(file.buffer.data)
      ? { buffer: Buffer.from(file.buffer.data) } : {}) }));
  const keys = normalized.map(file => normalized.length === 1 ? base : `${base}:${file.kind || file.id || file.name}`);
  if (new Set(keys).size !== keys.length) throw new TypeError('Dosya kimlikleri benzersiz olmali');
  return { payload, files: normalized, keys };
}

/** See README.md for durable checkpoint store and G1 outbox integration contract. */
function createWorkshopHandler(env = process.env, options = {}) {
  const mode = options.mode || env.WHATSAPP_MODE || env.ATOLYE_MODU || env.WORKSHOP_MODE || env.ATOLYE_MODE || 'manual';
  let provider, store;
  const locks = new Map();
  const handler = async job => {
    // Evaluate on EVERY invocation, even after the handler was constructed.
    if (env.OTOMATIK_GONDERIM !== '1' || mode === 'manual') return manual(job);
    if (!['test', 'cloud'].includes(mode)) return manual(job);
    // Cloud must never send without the caller's durable, awaited checkpoint storage.
    if (mode === 'cloud' && !options.store) return manual(job);
    store ||= options.store || createMemoryStore();
    provider ||= options.provider || (mode === 'test' ? createTestAdapter(options.test)
      : createCloudAdapter(env, options));
    handler.records = provider.records;
    const { payload, files, keys } = normalizeJob(job);
    const refs = [];
    for (let i = 0; i < files.length; i++) {
      const key = keys[i], file = files[i];
      const run = async () => {
        let state = await store.get(key) || {};
        if (state.status === 'complete') return { status: 'tamam', providerRef: state.providerRef };
        const providerRef = state.providerRef || (files.length === 1 ? job.provider_ref || job.providerRef : undefined);
        if (providerRef || ['sending', 'ambiguous', 'sent'].includes(state.status)) {
          const result = await provider.lookupStatus({ key, providerRef });
          if (['sent', 'delivered', 'read'].includes(result?.status)) {
            state = { ...state, status: 'complete', providerRef: result.providerRef || providerRef };
            await store.set(key, state);
            return { status: 'tamam', providerRef: state.providerRef };
          }
          if (!['failed', 'not_sent'].includes(result?.status)) {
            // Unknown/absent webhook is NOT proof that the message was not sent.
            return { status: 'manuel_bekliyor', ...(providerRef ? { providerRef } : {}) };
          }
          state = { ...state, status: 'uploaded', providerRef: undefined };
          await store.set(key, state);
        }
        const request = { key, file, groupId: payload.groupId || env.WHATSAPP_GROUP_ID,
          message: buildWorkshopMessage(payload.order || {}, files) };
        if (!state.mediaId) {
          state = { status: 'uploaded', mediaId: await provider.upload(request) };
          await store.set(key, state);
        }
        // A crash anywhere after this awaited write requires lookup before another send.
        state = { ...state, status: 'sending' };
        await store.set(key, state);
        let result;
        try { result = await provider.send({ ...request, mediaId: state.mediaId }); }
        catch (err) {
          state = { ...state, status: err.definiteNotSent ? 'uploaded' : 'ambiguous',
            ...(err.providerRef ? { providerRef: err.providerRef } : {}) };
          await store.set(key, state);
          if (err.permanent) return { status: 'manuel_bekliyor' };
          throw err;
        }
        if (!result?.providerRef) throw temporary('Gonderim referansi eksik', { ambiguous: true });
        await store.set(key, { ...state, status: 'complete', providerRef: result.providerRef });
        return { status: 'tamam', providerRef: result.providerRef };
      };
      // Serialize duplicate keys within this handler. The durable outbox serializes processes.
      const previous = locks.get(key) || Promise.resolve();
      const pending = previous.catch(() => {}).then(run);
      locks.set(key, pending);
      let result;
      try { result = await pending; }
      finally { if (locks.get(key) === pending) locks.delete(key); }
      if (result.status !== 'tamam') return result;
      refs.push(result.providerRef);
    }
    return { status: 'tamam', providerRef: refs.length === 1 ? refs[0] : JSON.stringify(refs) };
  };
  handler.records = options.provider?.records || options.test?.records || [];
  return handler;
}
module.exports = { createWorkshopHandler, normalizeJob, buildWorkshopMessage };
