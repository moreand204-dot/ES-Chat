/**
 * ES Bot API SDK — JavaScript / Node.js 18+
 * لا تضع التوكن في الواجهة أو في مستودع عام.
 */
export class ESBotError extends Error {
  constructor(description, code, payload = {}) { super(description); this.name = "ESBotError"; this.code = code; this.payload = payload; }
}

export class ESBot {
  constructor(token, { baseUrl, fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
    if (!/^esb_live_[A-Za-z0-9_-]{20,240}$/.test(String(token || ""))) throw new TypeError("Invalid ES bot token");
    if (!baseUrl) throw new TypeError("baseUrl is required");
    this.token = token; this.baseUrl = String(baseUrl).replace(/\/$/, ""); this.fetch = fetchImpl; this.timeoutMs = timeoutMs;
  }
  async call(method, payload = {}) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(`${this.baseUrl}/bot${encodeURIComponent(this.token)}/${encodeURIComponent(method)}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(payload), signal: controller.signal });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) throw new ESBotError(data.description || "ES Bot API error", data.error_code || response.status, data);
      return data.result;
    } finally { clearTimeout(timer); }
  }
  getMe() { return this.call("getMe"); }
  sendMessage(chat_id, text, extra = {}) { return this.call("sendMessage", { chat_id, text, ...extra }); }
  sendPhoto(chat_id, photo, extra = {}) { return this.call("sendPhoto", { chat_id, photo, ...extra }); }
  sendDocument(chat_id, document, extra = {}) { return this.call("sendDocument", { chat_id, document, ...extra }); }
  sendAudio(chat_id, audio, extra = {}) { return this.call("sendAudio", { chat_id, audio, ...extra }); }
  sendVideo(chat_id, video, extra = {}) { return this.call("sendVideo", { chat_id, video, ...extra }); }
  getChat(chat_id) { return this.call("getChat", { chat_id }); }
  getChatMember(chat_id, user_id) { return this.call("getChatMember", { chat_id, user_id }); }
  getChatAdministrators(chat_id) { return this.call("getChatAdministrators", { chat_id }); }
  sendLocation(chat_id, latitude, longitude, extra = {}) { return this.call("sendLocation", { chat_id, latitude, longitude, ...extra }); }
  sendPoll(chat_id, question, options, extra = {}) { return this.call("sendPoll", { chat_id, question, options, ...extra }); }
  forwardMessage(chat_id, from_chat_id, message_id) { return this.call("forwardMessage", { chat_id, from_chat_id, message_id }); }
  copyMessage(chat_id, from_chat_id, message_id) { return this.call("copyMessage", { chat_id, from_chat_id, message_id }); }
  uploadFilePart(meta) { return this.call("uploadFile", meta); }
  completeFile(upload_id, access_key) { return this.call("completeFile", { upload_id, access_key }); }
  editMessageText(chat_id, message_id, text, extra = {}) { return this.call("editMessageText", { chat_id, message_id, text, ...extra }); }
  deleteMessage(chat_id, message_id) { return this.call("deleteMessage", { chat_id, message_id }); }
  setWebhook(url) { return this.call("setWebhook", { url }); }
  deleteWebhook() { return this.call("deleteWebhook"); }
  getWebhookInfo() { return this.call("getWebhookInfo"); }
  getUpdates(offset = 0, limit = 100) { return this.call("getUpdates", { offset, limit }); }
  answerCallbackQuery(callback_query_id, extra = {}) { return this.call("answerCallbackQuery", { callback_query_id, ...extra }); }
}
