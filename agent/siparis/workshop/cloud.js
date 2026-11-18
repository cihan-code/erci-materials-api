'use strict';
const fs = require('node:fs/promises');
const { temporary } = require('./test');

/** Meta Groups API skeleton. Credentials ONLY from env. No invented message-status GET.
 * Sources, checked 2026-11-19:
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/groups-messaging/
 * https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media
 * Status callback must query the application's durable webhook/event ledger.
 */
function createCloudAdapter(env = process.env, { fetch: fetchImpl = globalThis.fetch, lookupStatus } = {}) {
  const token = env.WHATSAPP_ACCESS_TOKEN;
  const phone = env.WHATSAPP_PHONE_NUMBER_ID;
  const version = env.WHATSAPP_API_VERSION;
  if (!token || !/^\d+$/.test(phone || '') || !/^v\d+\.\d+$/.test(version || '')) {
    throw new Error('WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_API_VERSION gerekli');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch gerekli');
  const base = `https://graph.facebook.com/${version}/${phone}`;
  async function post(endpoint, body, json) {
    let response;
    try {
      response = await fetchImpl(`${base}/${endpoint}`, { method: 'POST',
        headers: { Authorization: `Bearer ${token}`, ...(json ? { 'Content-Type': 'application/json' } : {}) },
        body: json ? JSON.stringify(body) : body, signal: AbortSignal.timeout(30_000) });
    } catch (_) {
      // Tokens, provider responses and arbitrary exception text must not enter logs/errors.
      throw temporary('Cloud yaniti alinamadi', { ambiguous: endpoint === 'messages' });
    }
    if (!response.ok) {
      if (response.status === 429) throw temporary('Cloud hiz siniri', { definiteNotSent: true });
      if (response.status >= 500) throw temporary('Cloud gecici hata', { ambiguous: endpoint === 'messages' });
      throw Object.assign(new Error(`Cloud istek reddi (${response.status})`), { definiteNotSent: true, permanent: true });
    }
    try { return await response.json(); }
    catch (_) { throw temporary('Cloud yaniti okunamadi', { ambiguous: endpoint === 'messages' }); }
  }
  return {
    async upload({ file }) {
      const bytes = Buffer.isBuffer(file.buffer) ? file.buffer : await fs.readFile(file.path);
      const form = new FormData();
      form.append('messaging_product', 'whatsapp');
      form.append('type', file.mime || 'application/pdf');
      form.append('file', new Blob([bytes], { type: file.mime || 'application/pdf' }), file.name);
      const data = await post('media', form, false);
      if (!data.id) throw temporary('Cloud medya kimligi eksik', { definiteNotSent: true });
      return data.id;
    },
    async send({ file, mediaId, message, groupId }) {
      if (!groupId) throw Object.assign(new Error('Groups API groupId gerekli'), { definiteNotSent: true, permanent: true });
      const data = await post('messages', { messaging_product: 'whatsapp', recipient_type: 'group',
        to: groupId, type: 'document', document: { id: mediaId, filename: file.name, caption: message } }, true);
      const providerRef = data.messages?.[0]?.id;
      if (!providerRef) throw temporary('Cloud mesaj kimligi eksik', { ambiguous: true });
      return { providerRef };
    },
    lookupStatus: lookupStatus || (async () => ({ status: 'unknown' })),
  };
}
module.exports = { createCloudAdapter };
