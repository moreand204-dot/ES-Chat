const crypto = require("crypto");

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
    return response.status >= 200 && response.status < 300;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { deliverWebhook };
