const commandPattern = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{3,32}))?(?:\s+([\s\S]*))?$/;
const windows = new Map();
const WINDOW_MS = 60_000;
const MAX_PER_BOT = 120;

function parseCommand(value, botUsername = "") {
  const match = commandPattern.exec(String(value || "").trim());
  if (!match) return null;
  const target = match[2] ? match[2].toLowerCase() : "";
  const username = String(botUsername || "").replace(/^@/, "").toLowerCase();
  if (target && username && target !== username) return null;
  return { command: match[1].toLowerCase(), args: String(match[3] || "").trim(), target: target || null };
}

function withinRate(botId) {
  const now = Date.now();
  const current = (windows.get(botId) || []).filter(t => now - t < WINDOW_MS);
  if (current.length >= MAX_PER_BOT) { windows.set(botId, current); return false; }
  current.push(now); windows.set(botId, current);
  if (windows.size > 5000) for (const [id, times] of windows) if (!times.some(t => now - t < WINDOW_MS)) windows.delete(id);
  return true;
}

function prepareUpdate(bot, update) {
  const message = update?.message || {};
  const parsed = parseCommand(message.text, bot.username);
  const replyToBot = message.replyUid === bot.botUid || message.replyTo?.uid === bot.botUid;
  const privacy = bot.settings?.privacy !== false;
  if (privacy && !parsed && !replyToBot) return null;
  if (!withinRate(bot.id)) return null;
  return { ...update, message: { ...message, ...(parsed ? { command: parsed } : {}) }, engine: { privacy, matched_command: Boolean(parsed), rate_window: "1m", rate_limit: MAX_PER_BOT } };
}

module.exports = { parseCommand, prepareUpdate, MAX_PER_BOT };
