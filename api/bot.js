const admin = require("firebase-admin");
const crypto = require("crypto");
const { deliverWebhook } = require("./_bot-webhook");
const { readBotStats } = require("./_bot-stats");
const { validPublicHttpsUrl } = require("./_net-guard");
function init() {
  if (admin.apps.length) return;
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw Object.assign(new Error("FIREBASE_SERVICE_ACCOUNT is not set"), { code: "env-missing" });
  let cred; try { cred = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT); } catch { throw Object.assign(new Error("FIREBASE_SERVICE_ACCOUNT is not valid JSON"), { code: "env-bad-json" }); }
  admin.initializeApp({ credential: admin.credential.cert(cred) });
}
const MAX_BOTS = 20;
const hash = s => crypto.createHash("sha256").update(String(s)).digest("hex");
const id = () => crypto.randomBytes(9).toString("hex");
const makeToken = bid => `esb_live_${bid}_${crypto.randomBytes(24).toString("base64url")}`;
const send = (res, code, body) => res.status(code).json(body);
const text = (v, max) => String(v || "").trim().slice(0, max);
async function userFrom(req) { const m = /^Bearer\s+(.+)$/.exec(req.headers.authorization || ""); if (!m) return null; try { return await admin.auth().verifyIdToken(m[1]); } catch { return null; } }
async function botFrom(db, req) {
  const raw = String(req.headers["x-es-bot-token"] || req.body?.token || ""); if (!/^esb_live_[A-Za-z0-9_-]{20,240}$/.test(raw)) return null;
  const sec = await db.doc(`botSecrets/${hash(raw)}`).get(); if (!sec.exists || sec.data().active !== true) return null;
  const b = await db.doc(`bots/${sec.data().botId}`).get(); if (!b.exists || b.data().active !== true || b.data().tokenHash !== hash(raw)) return null;
  return { id: b.id, ...b.data() };
}
const validWebhook = validPublicHttpsUrl; // نفس الفحص المشترك في _net-guard.js
function safeButtons(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map(x => ({ ar: text(x.ar || x.textAr || x.text, 40), en: text(x.en || x.textEn || x.text, 40), ...(validWebhook(x.url) ? { url: String(x.url).trim().slice(0, 500) } : {}), ...(x.callback ? { callback: text(x.callback, 128) } : {}) })).filter(x => (x.ar || x.en) && (x.url || x.callback));
}
function safeCommands(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).map(x => ({ command: String(x?.command || "").trim().replace(/^\//, "").toLowerCase(), ar: text(x?.ar || x?.descriptionAr, 120), en: text(x?.en || x?.descriptionEn, 120) })).filter(x => x.command.length <= 32 && /^[a-z0-9_]{1,32}$/.test(x.command) && (x.ar || x.en));
}
// صاحب المجموعة أو أحد مشرفيها لازم يكون "ربط" البوت ده كجهاز مرتبط بحسابه (عبر api/link-device.js)،
// أو يكون هو مالك البوت أصلاً. ده بيسمح لأي حد يملك/يشرف مجموعة إنه ينصّب بوت حد تاني عليها
// من غير ما يحتاج يبقى هو صاحب البوت، وبنفس الوقت ميديش أي بوت وصول لمجموعة محدش فيها ربطه.
// بترجّع أعلى مستوى صلاحية بيزكّي البوت ده في المجموعة: "owner" أو "admin" أو null.
// المستوى مهم: المشرف العادي يقدر يضيف البوت كعضو، لكن ترقية البوت لمشرف للمالك بس
// (قواعد Firestore بتمنع المشرف من تعيين مشرفين، فلازم الـ API ما يفتحش الباب ده من الجنب).
async function authorityLevel(db, bot, gd) {
  const admins = gd.admins || [];
  let level = null;
  if (gd.owner === bot.owner) return "owner";
  if (admins.includes(bot.owner)) level = "admin";
  const candidates = [...new Set([gd.owner, ...admins].filter(Boolean))].slice(0, 50);
  const snaps = await Promise.all(candidates.map(uid => db.doc(`bots/${bot.id}/linkedAccounts/${uid}`).get()));
  snaps.forEach((s, i) => { if (!s.exists) return; if (candidates[i] === gd.owner) level = "owner"; else if (level !== "owner") level = "admin"; });
  return level;
}
async function rotate(db, b) {
  const raw = makeToken(b.id), h = hash(raw), old = b.tokenHash;
  // كان تغيير الرمز بيضيّع webhookSecret فالـ webhooks تقف بصمت — نورّثه للسر الجديد
  const oldSec = old ? await db.doc(`botSecrets/${old}`).get().catch(() => null) : null;
  const webhookSecret = oldSec && oldSec.exists ? String(oldSec.data().webhookSecret || "") : "";
  // الترتيب مهم: نكتب السر الجديد الأول، وبعدين نحوّل البوت له (لو الكتابة التانية فشلت البوت ما يتقفلش)
  await db.doc(`botSecrets/${h}`).set({ botId: b.id, owner: b.owner, active: true, ...(webhookSecret ? { webhookSecret } : {}), createdAt: admin.firestore.FieldValue.serverTimestamp() });
  await db.doc(`bots/${b.id}`).update({ tokenHash: h, tokenPrefix: raw.slice(0, 18), active: true });
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
      const name = text(body.name, 40); if (name.length < 2) return send(res, 400, { error: "name required" });
      const owned = await db.collection("bots").where("owner", "==", u.uid).get(); if (owned.docs.filter(d => d.data().deleted !== true).length >= MAX_BOTS) return send(res, 429, { error: "bot limit reached" });
      const bid = id(), raw = makeToken(bid), h = hash(raw), botUid = `bot_${bid}`, now = admin.firestore.FieldValue.serverTimestamp();
      await db.doc(`bots/${bid}`).set({ owner: u.uid, name, nameAr: text(body.nameAr || name, 40), nameEn: text(body.nameEn || name, 40), botUid, active: true, tokenHash: h, tokenPrefix: raw.slice(0, 18), createdAt: now, groups: [], commands: [], settings: { inline: false, inlineGeo: false, joinGroups: true, privacy: true } });
      await db.doc(`botSecrets/${h}`).set({ botId: bid, owner: u.uid, active: true, createdAt: now });
      await db.doc(`users/${botUid}/public/profile`).set({ uid: botUid, name, photo: "", gender: "male", bio: "بوت ES Chat Pro / ES Chat Pro Bot", username: bid, verified: false }, { merge: true });
      return send(res, 201, { bot: { id: bid, uid: botUid, name, active: true }, token: raw, warning: "احفظ الرمز الآن؛ لن يظهر مرة أخرى. / Save this token; it will not be shown again." });
    }
    if (["disable", "enable", "setname", "setdescription", "setabouttext", "setcommands", "setsettings", "setinline", "setinlinegeo", "setjoingroups", "setprivacy", "deletebot", "token", "setwebhook", "deletewebhook", "testwebhook", "stats", "setusername"].includes(action)) {
      const u = await userFrom(req); if (!u) return send(res, 401, { error: "user auth required" });
      const bid = text(body.botId, 80), ref = db.doc(`bots/${bid}`), snap = await ref.get(); if (!snap.exists || snap.data().owner !== u.uid || snap.data().deleted === true) return send(res, 404, { error: "bot not found" });
      const b = { id: snap.id, ...snap.data() };
      if (action === "stats") {
        const data = await readBotStats(db, b.id);
        return send(res, 200, { ok: true, stats: data.stats, logs: data.logs });
      }
      if (action === "testwebhook") {
        if (b.active !== true || !b.webhookUrl || !b.tokenHash) return send(res, 400, { error: "webhook_not_configured" });
        const delivered = await deliverWebhook(db, b, { type: "webhook_test", test: true, bot: { id: b.id, name: text(b.name, 40) }, message: { text: "ES Chat webhook test", textAr: "اختبار اتصال Webhook من ES Chat", textEn: "ES Chat webhook test" } });
        return send(res, delivered ? 200 : 502, { ok: delivered, action: "testwebhook", error: delivered ? undefined : "webhook_delivery_failed" });
      }
      if (action === "token") return send(res, 200, { token: await rotate(db, b), warning: "احفظ الرمز الآن؛ لن يظهر مرة أخرى." });
      if (action === "deletebot") {
      // release username claim before deleting
      const oldUn = typeof b.username === "string" ? b.username.toLowerCase() : "";
      if (oldUn && !/^[0-9a-f]{18}$/.test(oldUn)) {
        const unSnap = await db.doc(`usernames/${oldUn}`).get().catch(() => null);
        if (unSnap && unSnap.exists && unSnap.data().uid === b.botUid) {
          await db.doc(`usernames/${oldUn}`).delete().catch(() => {});
        }
      }
      // امسح الربط بحسابات المستخدمين عشان يختفي من "الأجهزة المرتبطة" ومايفضلش له أثر
      try {
        const links = await db.collection(`bots/${b.id}/linkedAccounts`).get();
        for (const l of links.docs) {
          const dev = String(l.data().deviceId || "");
          if (dev) await db.doc(`users/${l.id}/linkedDevices/${dev}`).update({ status: "revoked", revokedAt: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
          await db.doc(`bots/${b.id}/linkedAccounts/${l.id}`).delete().catch(() => {});
        }
      } catch {}
      await ref.update({ active: false, deleted: true });
      if (b.tokenHash) await db.doc(`botSecrets/${b.tokenHash}`).update({ active: false }).catch(() => {});
      return send(res, 200, { ok: true, deleted: true });
    }
    if (action === "setusername") {
      const raw = text(body.username, 20).toLowerCase();
      if (!/^[a-z][a-z0-9_]{2,19}$/.test(raw)) return send(res, 400, { error: "invalid_username", hint: "3-20 chars, start with a letter, letters/digits/_ only" });
      const outcome = await db.runTransaction(async tx => {
        const botRef = db.doc(`bots/${bid}`);
        const profileRef = db.doc(`users/${b.botUid}/public/profile`);
        const nextRef = db.doc(`usernames/${raw}`);
        const [botSnap, nextSnap] = await Promise.all([tx.get(botRef), tx.get(nextRef)]);
        if (!botSnap.exists) throw Object.assign(new Error("bot_missing"), { code: "bot_missing" });
        const current = typeof botSnap.data().username === "string" ? botSnap.data().username.toLowerCase() : "";
        if (current === raw) return { unchanged: true, username: raw };
        if (nextSnap.exists && nextSnap.data().uid !== b.botUid) throw Object.assign(new Error("username_taken"), { code: "username_taken" });
        // release old claim if it was a custom one (not the hex bid)
        if (current && !/^[0-9a-f]{18}$/.test(current)) {
          const oldRef = db.doc(`usernames/${current}`);
          const oldSnap = await tx.get(oldRef);
          if (oldSnap.exists && oldSnap.data().uid === b.botUid) tx.delete(oldRef);
        }
        tx.set(nextRef, { uid: b.botUid });
        tx.update(botRef, { username: raw });
        tx.set(profileRef, { uid: b.botUid, username: raw }, { merge: true });
        return { unchanged: false, username: raw };
      });
      return send(res, 200, { ok: true, username: outcome.username, unchanged: !!outcome.unchanged });
    }
      if (action === "disable" || action === "enable") { const active = action === "enable"; await ref.update({ active }); if (b.tokenHash) await db.doc(`botSecrets/${b.tokenHash}`).update({ active }); return send(res, 200, { ok: true, active }); }
      if (action === "setname") { const n = text(body.name, 40); if (n.length < 2) return send(res, 400, { error: "name required" }); await ref.update({ name: n, nameAr: text(body.nameAr || n, 40), nameEn: text(body.nameEn || n, 40) }); return send(res, 200, { ok: true }); }
      if (action === "setdescription") { await ref.update({ descriptionAr: text(body.ar || body.descriptionAr, 512), descriptionEn: text(body.en || body.descriptionEn, 512) }); return send(res, 200, { ok: true }); }
      if (action === "setabouttext") { await ref.update({ aboutAr: text(body.ar || body.aboutAr, 256), aboutEn: text(body.en || body.aboutEn, 256) }); return send(res, 200, { ok: true }); }
      if (action === "setcommands") { await ref.update({ commands: safeCommands(body.commands) }); return send(res, 200, { ok: true, count: safeCommands(body.commands).length }); }
      if (action === "setwebhook") { const url = String(body.url || "").trim(); if (!validWebhook(url)) return send(res, 400, { error: "https webhook required" }); const secret = crypto.randomBytes(24).toString("base64url"); await ref.update({ webhookUrl: url }); await db.doc(`botSecrets/${b.tokenHash}`).set({ botId: b.id, owner: b.owner, active: b.active === true, webhookSecret: secret }, { merge: true }); return send(res, 200, { ok: true, url, secret, warning: "احفظ secret الآن؛ لن يظهر مرة أخرى." }); }
      if (action === "deletewebhook") { await ref.update({ webhookUrl: "" }); if (b.tokenHash) await db.doc(`botSecrets/${b.tokenHash}`).set({ webhookSecret: "" }, { merge: true }); return send(res, 200, { ok: true }); }
      const oldSettings = b.settings || {}, next = { inline: action === "setinline" ? body.enabled === true : action === "setinlinegeo" ? oldSettings.inlineGeo : oldSettings.inline, inlineGeo: action === "setinlinegeo" ? body.enabled === true : oldSettings.inlineGeo, joinGroups: action === "setjoingroups" ? body.enabled !== false : oldSettings.joinGroups !== false, privacy: action === "setprivacy" ? body.enabled !== false : oldSettings.privacy !== false };
      if (action === "setsettings") Object.assign(next, { inline: body.inline === true, inlineGeo: body.inlineGeo === true, joinGroups: body.joinGroups !== false, privacy: body.privacy !== false });
      await ref.update({ settings: next }); return send(res, 200, { ok: true, settings: next });
    }
    const bot = await botFrom(db, req); if (!bot) return send(res, 401, { error: "invalid bot token" });
    if (action === "addToGroup") {
      if (bot.settings?.joinGroups === false) return send(res, 403, { error: "bot cannot join groups" });
      const gid = text(body.groupId, 120), g = await db.doc(`groups/${gid}`).get(); if (!g.exists) return send(res, 404, { error: "group not found" }); const gd = g.data();
      const level = await authorityLevel(db, bot, gd); if (!level) return send(res, 403, { error: "owner or admin required" });
      const already = (gd.members || []).includes(bot.botUid);
      if ((gd.banned || []).includes(bot.botUid)) return send(res, 403, { error: "bot is banned from this group" });
      if (!already && (gd.members || []).length >= (gd.kind === "channel" ? 5000 : 256)) return send(res, 403, { error: "group is full" });
      const adminBot = body.admin === true;
      if (adminBot && level !== "owner") return send(res, 403, { error: "only the group owner can make a bot admin" });
      if (adminBot && gd.kind === "channel" && !(gd.admins || []).includes(bot.botUid) && (gd.admins || []).length >= 15) return send(res, 403, { error: "admin limit reached" });
      await db.doc(`groups/${gid}`).update({ members: admin.firestore.FieldValue.arrayUnion(bot.botUid), ...(adminBot ? { admins: admin.firestore.FieldValue.arrayUnion(bot.botUid) } : {}) }); await db.doc(`bots/${bot.id}`).update({ groups: admin.firestore.FieldValue.arrayUnion(gid) }); return send(res, 200, { ok: true, groupId: gid, admin: adminBot });
    }
    if (action === "sendMessage") {
      const gid = text(body.groupId, 120), base = text(body.text, 2000), ar = text(body.textAr, 2000), en = text(body.textEn, 2000), message = base || ar || en; if (!gid || !message) return send(res, 400, { error: "groupId and text required" });
      const g = await db.doc(`groups/${gid}`).get(); if (!g.exists) return send(res, 404, { error: "group not found" }); const gd = g.data(); if (!(gd.members || []).includes(bot.botUid)) return send(res, 403, { error: "bot is not a member" }); if ((gd.kind === "channel" || gd.sendAdmins === true) && !(gd.admins || []).includes(bot.botUid)) return send(res, 403, { error: "bot must be an admin" });
      const buttons = safeButtons(body.buttons), ref = await db.collection(`groups/${gid}/messages`).add({ uid: bot.botUid, text: message, ...(ar ? { textAr: ar } : {}), ...(en ? { textEn: en } : {}), ...(buttons.length ? { buttons } : {}), at: admin.firestore.FieldValue.serverTimestamp() });
      await db.doc(`groups/${gid}`).update({ lastText: message.slice(0, 80), lastAt: admin.firestore.FieldValue.serverTimestamp(), lastUid: bot.botUid, lastName: bot.name.slice(0, 40) }); return send(res, 201, { ok: true, messageId: ref.id, buttons: buttons.length });
    }
    if (action === "me") return send(res, 200, { bot: { id: bot.id, uid: bot.botUid, name: bot.name, nameAr: bot.nameAr, nameEn: bot.nameEn, owner: bot.owner, active: bot.active, groups: bot.groups || [], commands: bot.commands || [], settings: bot.settings || {} } });
    return send(res, 400, { error: "unknown action" });
  } catch (e) { console.error(e); return send(res, 500, { error: "server", code: e.code || "", ...(String(e.code || "").startsWith("env") ? { detail: String(e.message || e).slice(0, 160) } : {}) }); }
};
