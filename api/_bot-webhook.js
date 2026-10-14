const crypto = require("crypto");
const { recordBotEvent } = require("./_bot-stats");
const { resolvesToPublicOnly } = require("./_net-guard");

// Shared, bounded webhook transport for message updates and callback queries.
async function deliverWebhook(db, bot, update) {
  if (!bot || bot.active !== true || !bot.webhookUrl || !bot.tokenHash) return false;
  const secretDoc = await db.doc(`botSecrets/${bot.tokenHash}`).get();
  const secret = secretDoc.data()?.webhookSecret;
  if (!secret || secretDoc.data()?.active !== true) return false;

  const body = JSON.stringify({
    ...update,
    event_id: update.event_id || crypto.randomUUID(),
    api_version: 1,
    created_at: update.created_at || new Date().toISOString()
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);
  try {
    // SSRF: لازم اسم السيرفر يتحلّل لعناوين عامة بس (مش 127.x / 10.x / 169.254.x ...)
    let host = ""; try { host = new URL(bot.webhookUrl).hostname; } catch {}
    if (!host || !(await resolvesToPublicOnly(host))) {
      await recordBotEvent(db, bot.id, update, "webhook_error", "blocked host").catch(() => {});
      return false;
    }
    const response = await fetch(bot.webhookUrl, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        "user-agent": "ES-Chat-Bot-Webhook/1",
        "x-es-timestamp": timestamp,
        "x-es-event-id": JSON.parse(body).event_id,
        "x-es-signature": `sha256=${signature}`
      },
      body,
      signal: controller.signal
    });
    // Do not follow redirects: a redirect could route a previously checked URL elsewhere.
    const good = response.status >= 200 && response.status < 300;
    await recordBotEvent(db, bot.id, update, good ? "webhook_success" : "webhook_error", `HTTP ${response.status}`).catch(() => {});
    return good;
  } catch (e) {
    await recordBotEvent(db, bot.id, update, "webhook_error", e?.name === "AbortError" ? "timeout" : "network error").catch(() => {});
    return false;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { deliverWebhook };
