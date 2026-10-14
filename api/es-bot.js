const admin = require("firebase-admin");
const crypto = require("crypto");
const { validPublicHttpsUrl } = require("./_net-guard");

function init() {
  if (admin.apps.length) return;
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error("FIREBASE_SERVICE_ACCOUNT is not set");
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}
const json = (res, code, body) => res.status(code).json(body);
const text = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const botToken = req => text(req.query?.token || req.headers["x-es-bot-token"] || req.body?.token, 260);
const methodOf = req => text(req.query?.method || req.body?.method || "", 64);
const MAX_INLINE = 480000;
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_PART_B64 = 480000;
const ok = (result = true) => ({ ok: true, result });
const fail = (description, error_code = 400) => ({ ok: false, error_code, description });

const validHttps = validPublicHttpsUrl; // نفس الفحص المشترك (كان هنا فحص أضعف بيسمح بـ 169.254.169.254 وغيره)

function buttons(markup) {
  const rows = Array.isArray(markup?.inline_keyboard) ? markup.inline_keyboard : [];
  const out = [];
  for (const row of rows.slice(0, 8)) {
    if (!Array.isArray(row)) continue;
    for (const item of row.slice(0, 8)) {
      const label = text(item?.text, 40);
      const callback = text(item?.callback_data, 128);
      const url = String(item?.url || "").trim();
      if (!label) continue;
      if (callback) out.push({ ar: label, en: label, callback });
      else if (validHttps(url)) out.push({ ar: label, en: label, url: url.slice(0, 500) });
    }
  }
  return out.slice(0, 8);
}

async function authenticate(db, token) {
  if (!/^esb_live_[A-Za-z0-9_-]{20,240}$/.test(token)) return null;
  const secret = await db.doc(`botSecrets/${hash(token)}`).get();
  if (!secret.exists || secret.data()?.active !== true) return null;
  const bot = await db.doc(`bots/${secret.data().botId}`).get();
  if (!bot.exists || bot.data()?.active !== true || bot.data()?.tokenHash !== hash(token)) return null;
  return { id: bot.id, ...bot.data() };
}

function publicBot(bot) {
  return { id: bot.botUid, is_bot: true, first_name: text(bot.name, 64), username: text(bot.username || bot.id, 64) };
}
function publicChat(group, id) {
  return { id: String(id), type: group?.kind === "channel" ? "channel" : "group", title: text(group?.name || id, 128) };
}
function messageResult(group, chatId, id, bot, data) {
  return { message_id: String(id), date: Math.floor(Date.now() / 1000), chat: publicChat(group, chatId), from: publicBot(bot), text: text(data.text, 2000), ...(data.buttons?.length ? { reply_markup: { inline_keyboard: [data.buttons.map(x => ({ text: x.ar || x.en, ...(x.callback ? { callback_data: x.callback } : { url: x.url }) }))] } } : {}) };
}

async function getGroup(db, bot, chatId) {
  const snap = await db.doc(`groups/${chatId}`).get();
  if (!snap.exists) return null;
  const group = snap.data();
  if (!(group.members || []).includes(bot.botUid)) return null;
  if ((group.kind === "channel" || group.sendAdmins === true) && !(group.admins || []).includes(bot.botUid)) return null;
  return group;
}

function inlineData(value, type) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > MAX_INLINE) return null;
  const expected = String(type || "application/octet-stream").slice(0, 80);
  if (!new RegExp(`^data:${expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")};base64,[A-Za-z0-9+/=_-]+$`, "i").test(raw)) return null;
  return raw;
}

async function uploadPart(db, bot, body) {
  const name = text(body.file_name || body.filename, 120), mime = text(body.mime_type || "application/octet-stream", 80);
  const bytes = Number(body.bytes || 0), parts = Number(body.total_parts || 0), index = Number(body.part_index || 0);
  const raw = String(body.data || "").trim();
  if (!/^[a-z0-9][a-z0-9.+-]{0,60}\/[a-z0-9][a-z0-9.+-]{0,60}$/i.test(mime)) return fail("invalid mime_type");
  if (!name || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_FILE_BYTES || !Number.isInteger(parts) || parts < 1 || parts > 60 || !Number.isInteger(index) || index < 0 || index >= parts || !/^[A-Za-z0-9+/=_-]+$/.test(raw) || raw.length > MAX_PART_B64) return fail("invalid upload part");
  const isNew = !/^[a-f0-9]{24}$/.test(String(body.upload_id || ""));
  const fileId = isNew ? crypto.randomBytes(12).toString("hex") : String(body.upload_id);
  const accessKey = isNew ? crypto.randomBytes(32).toString("base64url") : "";
  const ref = db.doc(`botFiles/${fileId}`); const snap = await ref.get();
  if (!isNew && !snap.exists) return fail("upload not found", 404); // مفيش اختيار id من عندك
  if (snap.exists && snap.data().botId !== bot.id) return fail("upload not found", 404);
  if (!snap.exists) await ref.set({ botId: bot.id, name, type: mime, bytes, parts, keyHash: hash(accessKey), status: "uploading", createdAt: admin.firestore.FieldValue.serverTimestamp() });
  const current = (await ref.get()).data(); if (current.status !== "uploading" || current.bytes !== bytes || current.parts !== parts) return fail("upload metadata mismatch");
  const partBytes = Number(body.part_bytes || 0);
  if (!Number.isSafeInteger(partBytes) || partBytes < 1 || partBytes > 400000) return fail("invalid part size");
  await db.doc(`botFiles/${fileId}/parts/p${index}`).set({ index, data: raw, bytes: partBytes });
  return ok({ upload_id: fileId, part_index: index, received: true, next_part: index + 1 < parts ? index + 1 : null, ...(isNew ? { access_key: accessKey } : {}) });
}
async function completeUpload(db, bot, body) {
  const fileId = String(body.upload_id || ""), accessKey = String(body.access_key || "");
  if (!/^[a-f0-9]{24}$/.test(fileId) || !/^[A-Za-z0-9_-]{32,80}$/.test(accessKey)) return fail("upload_id and access_key are required");
  const ref = db.doc(`botFiles/${fileId}`), snap = await ref.get(); if (!snap.exists || snap.data().botId !== bot.id) return fail("upload not found", 404);
  const file = snap.data(); if (file.status !== "uploading" || file.keyHash !== hash(accessKey)) return fail("invalid upload key", 403);
  const partsSnap = await db.collection(`botFiles/${fileId}/parts`).get(); const rows = partsSnap.docs.map(d => d.data()).sort((a,b) => Number(a.index) - Number(b.index));
  if (rows.length !== Number(file.parts) || rows.some((x, i) => x.index !== i)) return fail("upload is incomplete");
  const total = rows.reduce((n, x) => n + Number(x.bytes || 0), 0); if (total !== Number(file.bytes)) return fail("uploaded size mismatch");
  await ref.update({ status: "ready", completedAt: admin.firestore.FieldValue.serverTimestamp() });
  return ok({ file_id: `esfile_${fileId}`, file_name: file.name, mime_type: file.type, file_size: file.bytes, file_url: `/api/es-bot-file?file_id=${fileId}&key=${encodeURIComponent(accessKey)}` });
}
async function getStoredFile(db, bot, source, accessKey) {
  const fileId = String(source || "").replace(/^esfile_/, ""); if (!/^[a-f0-9]{24}$/.test(fileId) || !/^[A-Za-z0-9_-]{32,80}$/.test(String(accessKey || ""))) return null;
  const snap = await db.doc(`botFiles/${fileId}`).get(); if (!snap.exists || snap.data().botId !== bot.id || snap.data().status !== "ready" || snap.data().keyHash !== hash(accessKey)) return null;
  const file = snap.data(); return { ...file, fileId, url: `/api/es-bot-file?file_id=${fileId}&key=${encodeURIComponent(accessKey)}` };
}

async function sendMedia(db, bot, body, kind) {
  const chatId = text(body.chat_id, 120), caption = text(body.caption || body.text, 2000);
  if (!chatId) return fail("chat_id is required");
  const group = await getGroup(db, bot, chatId);
  if (!group) return fail("chat not found or bot is not allowed", 403);
  let payload = {}, responseMedia = {};
  if (kind === "photo") {
    const value = Array.isArray(body.photo) ? body.photo[body.photo.length - 1]?.file_id || body.photo[body.photo.length - 1] : body.photo;
    const data = inlineData(value, String(body.mime_type || "image/jpeg").startsWith("image/") ? body.mime_type : "image/jpeg");
    if (!data || data.length > 400000) return fail("photo must be an inline base64 data URL under 400 KB");
    payload.img = data; responseMedia.photo = [{ file_id: "es_" + crypto.randomBytes(8).toString("hex"), width: Number(body.width || 0), height: Number(body.height || 0), file_size: Math.max(0, Math.floor((data.length * 3) / 4)) }];
  } else {
    const source = body[kind] || body.file;
    const stored = String(source || "").startsWith("esfile_") ? await getStoredFile(db, bot, source, body.access_key || body.file_access_key) : null;
    if (String(source || "").startsWith("esfile_")) {
      if (!stored) return fail("invalid or unavailable file", 404);
      payload.file = { name: stored.name, type: stored.type, bytes: stored.bytes, url: stored.url };
      responseMedia[kind] = { file_id: `esfile_${stored.fileId}`, file_name: stored.name, mime_type: stored.type, file_size: stored.bytes };
    } else {
      const mime = String(body.mime_type || body.content_type || (kind === "audio" ? "audio/mpeg" : kind === "video" ? "video/mp4" : "application/octet-stream"));
      const data = inlineData(source, mime);
      if (!data) return fail(`${kind} must be an inline base64 data URL or uploaded file_id`);
      const raw = data.split(",", 2)[1] || "";
      if (raw.length > MAX_INLINE) return fail(`${kind} is too large; use uploadFile and completeFile`);
      const name = text(body.file_name || body.filename || `${kind}.${kind === "audio" ? "mp3" : kind === "video" ? "mp4" : "bin"}`, 120);
      payload.file = { name, type: mime.slice(0, 80), bytes: Math.floor(raw.replace(/=+$/, "").length * 3 / 4), data: raw };
      responseMedia[kind] = { file_id: "es_" + crypto.randomBytes(8).toString("hex"), file_name: name, mime_type: mime, file_size: payload.file.bytes };
    }
  }
  const replyButtons = buttons(body.reply_markup);
  const ref = await db.collection(`groups/${chatId}/messages`).add({ uid: bot.botUid, ...(caption ? { text: caption } : {}), ...payload, ...(replyButtons.length ? { buttons: replyButtons } : {}), at: admin.firestore.FieldValue.serverTimestamp() });
  await db.doc(`groups/${chatId}`).update({ lastText: caption || (kind === "photo" ? "📷 صورة" : `📎 ${kind}`), lastAt: admin.firestore.FieldValue.serverTimestamp(), lastUid: bot.botUid, lastName: text(bot.name, 40) });
  return ok({ ...messageResult(group, chatId, ref.id, bot, { text: caption, buttons: replyButtons }), ...responseMedia });
}

async function writeGroupMessage(db, bot, group, chatId, payload, buttonsList = []) {
  const textValue = text(payload.text, 2000), data = { uid: bot.botUid, ...(textValue ? { text: textValue } : {}), ...payload, ...(buttonsList.length ? { buttons: buttonsList } : {}), at: admin.firestore.FieldValue.serverTimestamp() };
  const ref = await db.collection(`groups/${chatId}/messages`).add(data);
  const preview = textValue || (payload.loc ? "📍 موقع" : payload.poll ? "📊 استفتاء" : payload.fwd ? "↪️ رسالة معاد توجيهها" : "رسالة");
  await db.doc(`groups/${chatId}`).update({ lastText: preview.slice(0, 80), lastAt: admin.firestore.FieldValue.serverTimestamp(), lastUid: bot.botUid, lastName: text(bot.name, 40) });
  const result = messageResult(group, chatId, ref.id, bot, { text: textValue, buttons: buttonsList });
  if (payload.loc) result.location = { latitude: payload.loc.lat, longitude: payload.loc.lng };
  if (payload.poll) result.poll = { question: payload.poll.q, options: payload.poll.o.map(x => ({ text: x, voter_count: 0 })) };
  return result;
}
function validLocation(body) {
  const latitude = Number(body.latitude), longitude = Number(body.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { lat: latitude, lng: longitude };
}
async function sendLocation(db, bot, body) {
  const chatId = text(body.chat_id, 120), group = await getGroup(db, bot, chatId), loc = validLocation(body);
  if (!chatId || !group || !loc) return fail(!group ? "chat not found or bot is not allowed" : "valid latitude and longitude are required", !group ? 403 : 400);
  return ok(await writeGroupMessage(db, bot, group, chatId, { loc, text: text(body.caption, 2000) }, buttons(body.reply_markup)));
}
async function sendPoll(db, bot, body) {
  const chatId = text(body.chat_id, 120), group = await getGroup(db, bot, chatId), question = text(body.question || body.q, 200), options = Array.isArray(body.options || body.o) ? (body.options || body.o).map(x => text(x, 100)).filter(Boolean).slice(0, 12) : [];
  if (!chatId || !group || question.length < 1 || options.length < 2) return fail(!group ? "chat not found or bot is not allowed" : "question and at least two options are required", !group ? 403 : 400);
  return ok(await writeGroupMessage(db, bot, group, chatId, { poll: { q: question, o: options }, text: text(body.caption, 2000) }, buttons(body.reply_markup)));
}
async function chatInfo(db, bot, body) {
  const chatId = text(body.chat_id, 120), group = await getGroup(db, bot, chatId); if (!group) return fail("chat not found or bot is not allowed", 403);
  return ok({ ...publicChat(group, chatId), description: text(group.desc || group.description, 512), members_count: Array.isArray(group.members) ? group.members.length : 0, administrators_count: Array.isArray(group.admins) ? group.admins.length : 0, username: text(group.handle || group.username, 64) || undefined });
}
async function memberInfo(db, bot, body, adminsOnly = false) {
  const chatId = text(body.chat_id, 120), uid = text(body.user_id, 120), group = await getGroup(db, bot, chatId); if (!group) return fail("chat not found or bot is not allowed", 403);
  if (adminsOnly && !(group.admins || []).includes(uid)) return null;
  const profile = uid ? await db.doc(`users/${uid}/public/profile`).get() : null, data = profile?.exists ? profile.data() : {};
  return ok({ user: { id: uid, is_bot: uid.startsWith("bot_"), first_name: text(data.name || uid, 80), username: text(data.username, 64) }, status: uid === group.owner ? "creator" : (group.admins || []).includes(uid) ? "administrator" : (group.members || []).includes(uid) ? "member" : "left" });
}
async function copyOrForward(db, bot, body, forwarded) {
  const fromId = text(body.from_chat_id || body.source_chat_id, 120), toId = text(body.chat_id, 120), messageId = text(body.message_id, 120), source = await getGroup(db, bot, fromId), target = await getGroup(db, bot, toId);
  if (!source || !target) return fail("source or destination chat is unavailable", 403);
  const snap = await db.doc(`groups/${fromId}/messages/${messageId}`).get(); if (!snap.exists || snap.data().deleted) return fail("message not found", 404);
  const m = snap.data(), payload = {};
  for (const key of ["text", "textAr", "textEn", "img", "loc", "poll", "sticker", "file"]) if (m[key] !== undefined) payload[key] = m[key];
  if (forwarded) payload.fwd = { chatId: fromId, messageId, uid: m.uid };
  const result = await writeGroupMessage(db, bot, target, toId, payload, Array.isArray(m.buttons) ? m.buttons.slice(0, 8) : []);
  return ok(result);
}

async function sendMessage(db, bot, body) {
  const chatId = text(body.chat_id, 120), value = text(body.text, 2000);
  if (!chatId || !value) return fail("chat_id and text are required");
  const group = await getGroup(db, bot, chatId);
  if (!group) return fail("chat not found or bot is not allowed", 403);
  const replyButtons = buttons(body.reply_markup);
  const ref = await db.collection(`groups/${chatId}/messages`).add({ uid: bot.botUid, text: value, ...(replyButtons.length ? { buttons: replyButtons } : {}), at: admin.firestore.FieldValue.serverTimestamp() });
  await db.doc(`groups/${chatId}`).update({ lastText: value.slice(0, 80), lastAt: admin.firestore.FieldValue.serverTimestamp(), lastUid: bot.botUid, lastName: text(bot.name, 40) });
  return ok(messageResult(group, chatId, ref.id, bot, { text: value, buttons: replyButtons }));
}

async function handle(req, res) {
  init();
  const db = admin.firestore();
  const token = botToken(req);
  const bot = await authenticate(db, token);
  if (!bot) return json(res, 401, fail("Unauthorized", 401));
  const method = methodOf(req);
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

  if (method === "getMe") return json(res, 200, ok(publicBot(bot)));
  if (method === "getChat") return json(res, 200, await chatInfo(db, bot, body));
  if (method === "getChatMember") return json(res, 200, await memberInfo(db, bot, body));
  if (method === "getChatAdministrators") { const g = await getGroup(db, bot, text(body.chat_id, 120)); if (!g) return json(res, 200, fail("chat not found or bot is not allowed", 403)); const rows = []; for (const uid of (g.admins || [])) { const x = await memberInfo(db, bot, { chat_id: body.chat_id, user_id: uid }); if (x?.result) rows.push(x.result); } return json(res, 200, ok(rows)); }
  if (method === "sendLocation") return json(res, 200, await sendLocation(db, bot, body));
  if (method === "sendPoll") return json(res, 200, await sendPoll(db, bot, body));
  if (method === "forwardMessage") return json(res, 200, await copyOrForward(db, bot, body, true));
  if (method === "copyMessage") return json(res, 200, await copyOrForward(db, bot, body, false));
  if (method === "sendMessage") return json(res, 200, await sendMessage(db, bot, body));
  if (method === "sendPhoto") return json(res, 200, await sendMedia(db, bot, body, "photo"));
  if (method === "sendDocument") return json(res, 200, await sendMedia(db, bot, body, "document"));
  if (method === "sendAudio") return json(res, 200, await sendMedia(db, bot, body, "audio"));
  if (method === "sendVideo") return json(res, 200, await sendMedia(db, bot, body, "video"));
  if (method === "uploadFile") return json(res, 200, await uploadPart(db, bot, body));
  if (method === "completeFile") return json(res, 200, await completeUpload(db, bot, body));
  if (method === "editMessageText") {
    const chatId = text(body.chat_id, 120), messageId = text(body.message_id, 120), value = text(body.text, 2000);
    if (!chatId || !messageId || !value) return json(res, 200, fail("chat_id, message_id and text are required"));
    const group = await getGroup(db, bot, chatId); const ref = db.doc(`groups/${chatId}/messages/${messageId}`); const snap = await ref.get();
    if (!group || !snap.exists || snap.data().uid !== bot.botUid) return json(res, 200, fail("message not found", 404));
    const replyButtons = buttons(body.reply_markup); await ref.update({ text: value, editedAt: admin.firestore.FieldValue.serverTimestamp(), ...(replyButtons.length ? { buttons: replyButtons } : { buttons: [] }) });
    return json(res, 200, ok(messageResult(group, chatId, messageId, bot, { text: value, buttons: replyButtons })));
  }
  if (method === "deleteMessage") {
    const chatId = text(body.chat_id, 120), messageId = text(body.message_id, 120); const group = await getGroup(db, bot, chatId); const ref = db.doc(`groups/${chatId}/messages/${messageId}`); const snap = await ref.get();
    if (!group || !snap.exists || snap.data().uid !== bot.botUid) return json(res, 200, fail("message not found", 404));
    await ref.update({ deleted: true, text: "" }); return json(res, 200, ok(true));
  }
  if (method === "setWebhook") {
    const url = String(body.url || "").trim(); if (!validHttps(url)) return json(res, 200, fail("HTTPS webhook URL required"));
    const webhookSecret = crypto.randomBytes(24).toString("base64url");
    await db.doc(`bots/${bot.id}`).update({ webhookUrl: url });
    await db.doc(`botSecrets/${bot.tokenHash}`).set({ webhookSecret }, { merge: true });
    return json(res, 200, ok(true));
  }
  if (method === "deleteWebhook") { await db.doc(`bots/${bot.id}`).update({ webhookUrl: "" }); await db.doc(`botSecrets/${bot.tokenHash}`).set({ webhookSecret: "" }, { merge: true }); return json(res, 200, ok(true)); }
  if (method === "getWebhookInfo") {
    let host = ""; try { host = bot.webhookUrl ? new URL(bot.webhookUrl).host : ""; } catch {}
    return json(res, 200, ok({ url: bot.webhookUrl ? `https://${host}/…` : "", has_custom_certificate: false, pending_update_count: 0, last_error_date: 0, last_error_message: "", max_connections: 40 }));
  }
  if (method === "getUpdates") {
    const offset = Number(body.offset || 0), limit = Math.min(Math.max(Number(body.limit || 100), 1), 100);
    // استعلام محدود بدل قراءة كل التحديثات في كل طلب (كان بيكبّر الفاتورة ويبطّأ مع الوقت)
    const snap = await db.collection(`botUpdates/${bot.id}/items`).where("update_id", ">=", offset).orderBy("update_id").limit(limit).get();
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return json(res, 200, ok(rows.map(x => { const y = {...x}; delete y.id; delete y.createdAt; return y; })));
  }
  if (method === "answerCallbackQuery") return json(res, 200, ok(true));
  return json(res, 200, fail("method not supported", 404));
}

module.exports = async (req, res) => {
  if (Number(req.headers?.["content-length"] || 0) > 700000) return json(res, 413, fail("payload too large", 413));
  if (!['GET', 'POST'].includes(req.method)) return json(res, 405, fail("method not allowed", 405));
  try { return await handle(req, res); } catch (e) { console.error("es bot api error", e?.message || e); return json(res, 500, fail("internal server error", 500)); }
};
