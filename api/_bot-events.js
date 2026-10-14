const crypto = require("crypto");
const { recordBotEvent } = require("./_bot-stats");

async function enqueueBotUpdate(db, botId, update) {
  if (!botId || !update) return null;
  const updateId = Date.now() * 1000 + crypto.randomInt(0, 1000);
  const ref = await db.collection(`botUpdates/${botId}/items`).add({ update_id: updateId, ...update, createdAt: new Date() });
  await recordBotEvent(db, botId, update, "received").catch(() => {});
  return { id: ref.id, update_id: updateId };
}

module.exports = { enqueueBotUpdate };
