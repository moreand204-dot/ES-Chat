const admin = require("firebase-admin");

function increments(update, status) {
  const out = { updates: admin.firestore.FieldValue.increment(1) };
  if (update?.type === "message") out.messages = admin.firestore.FieldValue.increment(1);
  if (update?.type === "callback_query") out.callbacks = admin.firestore.FieldValue.increment(1);
  if (update?.message?.command) out.commands = admin.firestore.FieldValue.increment(1);
  if (status === "webhook_success") out.webhookSuccess = admin.firestore.FieldValue.increment(1);
  if (status === "webhook_error") out.webhookErrors = admin.firestore.FieldValue.increment(1);
  return out;
}

async function trimLogs(db, botId) {
  const snap = await db.collection(`botLogs/${botId}/items`).orderBy("at", "desc").limit(101).get();
  if (snap.size <= 100) return;
  const batch = db.batch(); snap.docs.slice(100).forEach(d => batch.delete(d.ref)); await batch.commit();
}

async function recordBotEvent(db, botId, update = {}, status = "received", detail = "") {
  if (!botId) return;
  const now = admin.firestore.FieldValue.serverTimestamp();
  await db.doc(`botStats/${botId}`).set({ ...increments(update, status), lastActivity: now, lastType: String(update.type || "event").slice(0, 40) }, { merge: true });
  await db.collection(`botLogs/${botId}/items`).add({ type: String(update.type || "event").slice(0, 40), status: String(status).slice(0, 40), detail: String(detail || "").slice(0, 240), eventId: String(update.event_id || "").slice(0, 100), at: now });
  await trimLogs(db, botId).catch(() => {});
}

async function readBotStats(db, botId) {
  const stats = (await db.doc(`botStats/${botId}`).get()).data() || {};
  const logs = await db.collection(`botLogs/${botId}/items`).orderBy("at", "desc").limit(50).get();
  return { stats, logs: logs.docs.map(d => ({ id: d.id, ...d.data() })) };
}

module.exports = { recordBotEvent, readBotStats };
