const admin = require('firebase-admin');
function init() {
  if (admin.apps.length) return;
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error('Firebase service account is not configured');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}
const send = (res, status, body) => res.status(status).json(body);
const limits = { setName: 64, setDescription: 512, setShortDescription: 120 };
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  if (Number(req.headers['content-length'] || 0) > 8192) return send(res, 413, { error: 'payload_too_large' });
  try {
    init();
    const match = /^Bearer\s+(.+)$/.exec(req.headers.authorization || '');
    if (!match) return send(res, 401, { error: 'auth_required' });
    const user = await admin.auth().verifyIdToken(match[1]);
    const owner = process.env.TELEGRAM_MANAGER_OWNER_UID;
    if (!owner || user.uid !== owner) return send(res, 403, { error: 'owner_only' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const action = String(body.action || '');
    let configured = [];
    if (process.env.TELEGRAM_BOTS_JSON) {
      try { const parsed = JSON.parse(process.env.TELEGRAM_BOTS_JSON); if (Array.isArray(parsed)) configured = parsed.filter(x => x && typeof x.id === 'string' && /^[a-z0-9_-]{1,40}$/.test(x.id) && typeof x.token === 'string' && /^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(x.token)).slice(0, 20); } catch {}
    }
    if (process.env.TELEGRAM_BOT_TOKEN && !configured.some(x => x.id === 'primary')) configured.unshift({ id: 'primary', token: process.env.TELEGRAM_BOT_TOKEN });
    configured = configured.slice(0, 20);
    if (!configured.length) return send(res, 503, { error: 'telegram not configured' });
    if (action === 'listBots') {
      const bots = [];
      for (const item of configured) {
        const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 5000);
        try { const r = await fetch(`https://api.telegram.org/bot${item.token}/getMe`, { method: 'POST', redirect: 'error', signal: controller.signal, headers: { accept: 'application/json' }, body: '{}' }); const d = await r.json().catch(() => ({})); if (r.ok && d.ok && d.result) bots.push({ id: item.id, username: d.result.username || '', first_name: d.result.first_name || '' }); else bots.push({ id: item.id, unavailable: true }); } catch { bots.push({ id: item.id, unavailable: true }); } finally { clearTimeout(timeout); }
      }
      return send(res, 200, { ok: true, bots });
    }
    if (action === 'fleetDiagnostics') {
      const diagnostics = [];
      for (const item of configured) {
        const entry = { id: item.id, available: false, username: '', first_name: '', webhook: null, error: '' };
        const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 6500);
        try {
          const r = await fetch(`https://api.telegram.org/bot${item.token}/getMe`, { method: 'POST', redirect: 'error', signal: controller.signal, headers: { accept: 'application/json' }, body: '{}' });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || d.ok !== true || !d.result) { entry.error = String(d.description || 'telegram_api_error').slice(0, 160); }
          else {
            entry.available = true; entry.username = String(d.result.username || '').slice(0, 64); entry.first_name = String(d.result.first_name || '').slice(0, 64);
            const wr = await fetch(`https://api.telegram.org/bot${item.token}/getWebhookInfo`, { method: 'POST', redirect: 'error', signal: controller.signal, headers: { accept: 'application/json' }, body: '{}' });
            const wd = await wr.json().catch(() => ({}));
            if (wr.ok && wd.ok === true && wd.result) { const w = wd.result; let host = ''; try { host = w.url ? new URL(w.url).host : ''; } catch {} entry.webhook = { configured: Boolean(w.url), host, pending_update_count: Number(w.pending_update_count || 0), last_error_date: Number(w.last_error_date || 0), last_error_message: String(w.last_error_message || '').slice(0, 180), max_connections: Number(w.max_connections || 0) }; }
            else entry.error = String(wd.description || 'webhook_info_unavailable').slice(0, 160);
          }
        } catch (e) { entry.error = e && e.name === 'AbortError' ? 'telegram_timeout' : 'telegram_connection_failed'; }
        finally { clearTimeout(timeout); }
        diagnostics.push(entry);
      }
      return send(res, 200, { ok: true, bots: diagnostics });
    }
    const requestedId = typeof body.botId === 'string' ? body.botId : (configured.some(x => x.id === 'primary') ? 'primary' : configured[0].id);
    const selected = configured.find(x => x.id === requestedId);
    if (!selected) return send(res, 400, { error: 'unknown_bot' });
    const token = selected.token;
    let method, payload = {};
    if (action === 'status') method = 'getMe';
    else if (action === 'webhookInfo') method = 'getWebhookInfo';
    else if (action === 'getCommands') method = 'getMyCommands';
    else if (Object.hasOwn(limits, action)) {
      const field = action === 'setName' ? 'name' : action === 'setDescription' ? 'description' : 'short_description';
      const value = String(body.value || '').trim();
      if (value.length > limits[action] || (action === 'setName' && !value)) return send(res, 400, { error: 'invalid_value', max_length: limits[action] });
      payload[field] = value;
      method = action === 'setName' ? 'setMyName' : action === 'setDescription' ? 'setMyDescription' : 'setMyShortDescription';
    } else if (action === 'setCommands') {
      if (!Array.isArray(body.commands) || body.commands.length > 100) return send(res, 400, { error: 'invalid_commands' });
      const commands = [];
      for (const item of body.commands) {
        if (!item || typeof item.command !== 'string' || !/^[a-z0-9_]{1,32}$/.test(item.command) || typeof item.description !== 'string' || !item.description.trim() || item.description.length > 256) return send(res, 400, { error: 'invalid_commands' });
        commands.push({ command: item.command, description: item.description.trim() });
      }
      if (new Set(commands.map(x => x.command)).size !== commands.length) return send(res, 400, { error: 'duplicate_commands' });
      payload.commands = commands; method = 'setMyCommands';
    } else if (action === 'deleteCommands') method = 'deleteMyCommands';
    else return send(res, 400, { error: 'unsupported_action' });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    let response;
    try {
      response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'content-type': 'application/json', 'accept': 'application/json' },
        body: JSON.stringify(payload)
      });
    } finally { clearTimeout(timeout); }
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok !== true) {
      const description = String(result.description || 'telegram_api_error').slice(0, 180);
      return send(res, 502, { error: 'telegram_api_error', description });
    }
    // Never return the token or the raw Telegram response to the client.
    if (action === 'status') return send(res, 200, { ok: true, bot: { id: String(result.result.id), username: result.result.username || '', first_name: result.result.first_name || '' } });
    if (action === 'getCommands') return send(res, 200, { ok: true, commands: Array.isArray(result.result) ? result.result : [] });
    if (action === 'webhookInfo') {
      const info = result.result || {};
      let webhookHost = '';
      try { webhookHost = info.url ? new URL(info.url).host : ''; } catch {}
      return send(res, 200, { ok: true, webhook: { configured: Boolean(info.url), host: webhookHost, has_custom_certificate: Boolean(info.has_custom_certificate), pending_update_count: Number(info.pending_update_count || 0), last_error_date: Number(info.last_error_date || 0), last_error_message: String(info.last_error_message || '').slice(0, 240), max_connections: Number(info.max_connections || 0), allowed_updates: Array.isArray(info.allowed_updates) ? info.allowed_updates.slice(0, 30) : [] } });
    }
    return send(res, 200, { ok: true, action, result: result.result === true ? true : undefined });
  } catch (e) {
    if (e && e.name === 'AbortError') return send(res, 504, { error: 'telegram_timeout' });
    if (e && (e.code === 'auth/id-token-expired' || e.code === 'auth/argument-error' || e.code === 'auth/invalid-id-token')) return send(res, 401, { error: 'invalid_auth' });
    console.error('telegram-manager failure', e && e.message ? e.message : 'unknown');
    return send(res, 500, { error: 'server_error' });
  }
};
