const admin = require("firebase-admin");
const crypto = require("crypto");
// تحديد معدّل الطلبات: من غير ده، بوت بتوكن مسروق (أو يوزر عادي) يقدر يفتح create لا نهائي
// أو يقصف sendMessage بلا أي حد، على عكس /api/notify اللي عنده نفس الحماية دي أصلاً.
const rate = new Map();
function limited(key, max, windowMs = 10000) {
  const now = Date.now(), prev = rate.get(key) || [], recent = prev.filter(t => now - t < windowMs);
  if (recent.length >= max) return true;
  recent.push(now); rate.set(key, recent);
  if (rate.size > 10000) { for (const [k, ts] of rate) if (!ts.length || now - ts[ts.length - 1] > 60000) rate.delete(k); while (rate.size > 10000) rate.delete(rate.keys().next().value); }
  return false;
}
function init() {
  if (admin.apps.length) return;
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw Object.assign(new Error("FIREBASE_SERVICE_ACCOUNT is not set"), { code: "env-missing" });
  let cred; try { cred = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT); } catch { throw Object.assign(new Error("FIREBASE_SERVICE_ACCOUNT is not valid JSON"), { code: "env-bad-json" }); }
  admin.initializeApp({ credential: admin.credential.cert(cred) });
}
const hash = s => crypto.createHash("sha256").update(String(s)).digest("hex");
const id = () => crypto.randomBytes(9).toString("hex");
const makeToken = bid => `esb_live_${bid}_${crypto.randomBytes(24).toString("base64url")}`;
const send = (res, code, body) => res.status(code).json(body);
const text = (v, max) => String(v || "").trim().slice(0, max);
async function userFrom(req) { const m = /^Bearer\s+(.+)$/.exec(req.headers.authorization || ""); return m ? admin.auth().verifyIdToken(m[1]) : null; }
async function botFrom(db, req) {
  const raw = String(req.headers["x-es-bot-token"] || req.body?.token || ""); if (!/^esb_live_[A-Za-z0-9_-]{20,240}$/.test(raw)) return null;
  const sec = await db.doc(`botSecrets/${hash(raw)}`).get(); if (!sec.exists || sec.data().active !== true) return null;
  const b = await db.doc(`bots/${sec.data().botId}`).get(); if (!b.exists || b.data().active !== true || b.data().tokenHash !== hash(raw)) return null;
  return { id: b.id, ...b.data() };
}
function safeButtons(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map(x => ({ ar: text(x.ar || x.textAr || x.text, 40), en: text(x.en || x.textEn || x.text, 40), url: String(x.url || "").trim().slice(0, 500) })).filter(x => (x.ar || x.en) && /^https:\/\//i.test(x.url));
}
function safeCommands(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).map(x => ({ command: text(x.command, 32).replace(/^\//, "").toLowerCase(), ar: text(x.ar || x.descriptionAr, 120), en: text(x.en || x.descriptionEn, 120) })).filter(x => /^[a-z0-9_]{1,32}$/.test(x.command) && (x.ar || x.en));
}
async function rotate(db, b) {
  const raw = makeToken(b.id), h = hash(raw), old = b.tokenHash;
  await db.doc(`bots/${b.id}`).update({ tokenHash: h, tokenPrefix: raw.slice(0, 18), active: true });
  await db.doc(`botSecrets/${h}`).set({ botId: b.id, owner: b.owner, active: true, createdAt: admin.firestore.FieldValue.serverTimestamp() });
  if (old) await db.doc(`botSecrets/${old}`).update({ active: false }).catch(() => {});
  return raw;
}
module.exports = async (req, res) => {
  if (req.method !== "POST") return send(res, 405, { error: "method" });
  if (Number(req.headers["content-length"] || 0) > 20000) return send(res, 413, { error: "payload too large" });
  try {
    init(); const db = admin.firestore(); const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {}; req.body = body;
    const action = text(body.action, 40);
    if (action === "create") {
      const u = await userFrom(req); if (!u) return send(res, 401, { error: "user auth required" });
      if (limited("create:" + u.uid, 5, 60000)) return send(res, 429, { error: "rate" });
      const name = text(body.name, 40); if (name.length < 2) return send(res, 400, { error: "name required" });
      const bid = id(), raw = makeToken(bid), h = hash(raw), botUid = `bot_${bid}`, now = admin.firestore.FieldValue.serverTimestamp();
      await db.doc(`bots/${bid}`).set({ owner: u.uid, name, nameAr: text(body.nameAr || name, 40), nameEn: text(body.nameEn || name, 40), botUid, active: true, tokenHash: h, tokenPrefix: raw.slice(0, 18), createdAt: now, groups: [], commands: [], settings: { inline: false, inlineGeo: false, joinGroups: true, privacy: true } });
      await db.doc(`botSecrets/${h}`).set({ botId: bid, owner: u.uid, active: true, createdAt: now });
      await db.doc(`users/${botUid}/public/profile`).set({ uid: botUid, name, photo: "", gender: "male", bio: "بوت ES Chat Pro / ES Chat Pro Bot", username: bid, verified: false }, { merge: true });
      return send(res, 201, { bot: { id: bid, uid: botUid, name, active: true }, token: raw, warning: "احفظ الرمز الآن؛ لن يظهر مرة أخرى. / Save this token; it will not be shown again." });
    }
    if (["disable", "enable", "setname", "setdescription", "setabouttext", "setcommands", "setsettings", "setinline", "setinlinegeo", "setjoingroups", "setprivacy", "deletebot", "token"].includes(action)) {
      const u = await userFrom(req); if (!u) return send(res, 401, { error: "user auth required" });
      if (limited("manage:" + u.uid, 20, 10000)) return send(res, 429, { error: "rate" });
      const bid = text(body.botId, 80), ref = db.doc(`bots/${bid}`), snap = await ref.get(); if (!snap.exists || snap.data().owner !== u.uid) return send(res, 404, { error: "bot not found" });
      const b = { id: snap.id, ...snap.data() };
      if (action === "token") return send(res, 200, { token: await rotate(db, b), warning: "احفظ الرمز الآن؛ لن يظهر مرة أخرى." });
      if (action === "deletebot") { await ref.update({ active: false, deleted: true }); if (b.tokenHash) await db.doc(`botSecrets/${b.tokenHash}`).update({ active: false }).catch(() => {}); return send(res, 200, { ok: true, deleted: true }); }
      if (action === "disable" || action === "enable") { const active = action === "enable"; await ref.update({ active }); if (b.tokenHash) await db.doc(`botSecrets/${b.tokenHash}`).update({ active }); return send(res, 200, { ok: true, active }); }
      if (action === "setname") { const n = text(body.name, 40); if (n.length < 2) return send(res, 400, { error: "name required" }); await ref.update({ name: n, nameAr: text(body.nameAr || n, 40), nameEn: text(body.nameEn || n, 40) }); return send(res, 200, { ok: true }); }
      if (action === "setdescription") { await ref.update({ descriptionAr: text(body.ar || body.descriptionAr, 512), descriptionEn: text(body.en || body.descriptionEn, 512) }); return send(res, 200, { ok: true }); }
      if (action === "setabouttext") { await ref.update({ aboutAr: text(body.ar || body.aboutAr, 256), aboutEn: text(body.en || body.aboutEn, 256) }); return send(res, 200, { ok: true }); }
      if (action === "setcommands") { await ref.update({ commands: safeCommands(body.commands) }); return send(res, 200, { ok: true, count: safeCommands(body.commands).length }); }
      const oldSettings = b.settings || {}, next = { inline: action === "setinline" ? body.enabled === true : action === "setinlinegeo" ? oldSettings.inlineGeo : oldSettings.inline, inlineGeo: action === "setinlinegeo" ? body.enabled === true : oldSettings.inlineGeo, joinGroups: action === "setjoingroups" ? body.enabled !== false : oldSettings.joinGroups !== false, privacy: action === "setprivacy" ? body.enabled !== false : oldSettings.privacy !== false };
      if (action === "setsettings") Object.assign(next, { inline: body.inline === true, inlineGeo: body.inlineGeo === true, joinGroups: body.joinGroups !== false, privacy: body.privacy !== false });
      await ref.update({ settings: next }); return send(res, 200, { ok: true, settings: next });
    }
    const bot = await botFrom(db, req); if (!bot) return send(res, 401, { error: "invalid bot token" });
    if (limited("bot:" + bot.id, 20, 10000)) return send(res, 429, { error: "rate" });
    if (action === "addToGroup") {
      if (bot.settings?.joinGroups === false) return send(res, 403, { error: "bot cannot join groups" });
      const gid = text(body.groupId, 120), g = await db.doc(`groups/${gid}`).get(); if (!g.exists) return send(res, 404, { error: "group not found" }); const gd = g.data();
      if (gd.owner !== bot.owner && !(gd.admins || []).includes(bot.owner)) return send(res, 403, { error: "owner or admin required" });
      const adminBot = body.admin === true; await db.doc(`groups/${gid}`).update({ members: admin.firestore.FieldValue.arrayUnion(bot.botUid), ...(adminBot ? { admins: admin.firestore.FieldValue.arrayUnion(bot.botUid) } : {}) }); await db.doc(`bots/${bot.id}`).update({ groups: admin.firestore.FieldValue.arrayUnion(gid) }); return send(res, 200, { ok: true, groupId: gid, admin: adminBot });
    }
    if (action === "sendMessage") {
      const gid = text(body.groupId, 120), base = text(body.text, 2000), ar = text(body.textAr, 2000), en = text(body.textEn, 2000), message = base || ar || en; if (!gid || !message) return send(res, 400, { error: "groupId and text required" });
      const g = await db.doc(`groups/${gid}`).get(); if (!g.exists) return send(res, 404, { error: "group not found" }); const gd = g.data(); if (!(gd.members || []).includes(bot.botUid)) return send(res, 403, { error: "bot is not a member" }); if ((gd.kind === "channel" || gd.sendAdmins === true) && !(gd.admins || []).includes(bot.botUid)) return send(res, 403, { error: "bot must be an admin" });
      const buttons = safeButtons(body.buttons), ref = await db.collection(`groups/${gid}/messages`).add({ uid: bot.botUid, text: message, ...(ar ? { textAr: ar } : {}), ...(en ? { textEn: en } : {}), ...(buttons.length ? { buttons } : {}), at: admin.firestore.FieldValue.serverTimestamp() });
      await db.doc(`groups/${gid}`).update({ lastText: message.slice(0, 80), lastAt: admin.firestore.FieldValue.serverTimestamp(), lastUid: bot.botUid, lastName: bot.name.slice(0, 40) }); return send(res, 201, { ok: true, messageId: ref.id, buttons: buttons.length });
    }
    if (action === "me") return send(res, 200, { bot: { id: bot.id, uid: bot.botUid, name: bot.name, nameAr: bot.nameAr, nameEn: bot.nameEn, owner: bot.owner, active: bot.active, groups: bot.groups || [], commands: bot.commands || [], settings: bot.settings || {} } });
    return send(res, 400, { error: "unknown action" });
  } catch (e) { console.error(e); return send(res, 500, { error: "server", code: e.code || "", detail: String(e.message || e).slice(0, 160) }); }
};
