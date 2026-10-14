const admin = require("firebase-admin");
const { deliverWebhook } = require("./_bot-webhook");
const { enqueueBotUpdate } = require("./_bot-events");
const { prepareUpdate } = require("./_bot-engine");
function init() { if (admin.apps.length) return; if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error("FIREBASE_SERVICE_ACCOUNT is not set"); admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) }); }
const json = (res, c, v) => res.status(c).json(v);
async function auth(req) { const m = /^Bearer\s+(.+)$/.exec(req.headers.authorization || ""); if (!m) return null; try { return await admin.auth().verifyIdToken(m[1]); } catch { return null; } }
module.exports = async (req, res) => {
  if (req.method !== "POST") return json(res, 405, { error: "method" });
  try {
    init(); const u = await auth(req); if (!u) return json(res, 401, { error: "auth required" }); const db = admin.firestore(); const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {}, gid = String(body.groupId || ""), mid = String(body.messageId || "");
    const g = await db.doc(`groups/${gid}`).get(), m = await db.doc(`groups/${gid}/messages/${mid}`).get(); if (!g.exists || !m.exists) return json(res, 404, { error: "not found" }); const gd = g.data(), md = m.data();
    if (!(gd.members || []).includes(u.uid) || md.uid !== u.uid) return json(res, 403, { error: "not allowed" });
    const botIds = (gd.members || []).filter(x => String(x).startsWith("bot_")); if (!botIds.length) return json(res, 200, { delivered: 0 });
    const bots = (await db.getAll(...botIds.map(x => db.doc(`bots/${x.slice(4)}`)))).filter(x => x.exists && x.data().active === true && x.data().webhookUrl).map(x => ({ id: x.id, ...x.data() }));
    const update = { type: "message", group: { id: gid, name: gd.name || "" }, message: { id: mid, uid: md.uid, text: String(md.text || "").slice(0, 2000), textAr: String(md.textAr || "").slice(0, 2000), textEn: String(md.textEn || "").slice(0, 2000), buttons: Array.isArray(md.buttons) ? md.buttons.slice(0, 8) : [], ...(md.reply ? { replyTo: { uid: String(md.reply.uid || ""), id: String(md.reply.id || "") } } : {}) } };
    const routed = bots.map(b => ({ bot: b, update: prepareUpdate(b, update) })).filter(x => x.update);
    await Promise.all(routed.map(x => enqueueBotUpdate(db, x.bot.id, x.update)));
    const sent = await Promise.all(routed.map(x => deliverWebhook(db, x.bot, x.update))); return json(res, 200, { delivered: sent.filter(Boolean).length, total: bots.length, eligible: routed.length });
  } catch (e) { console.error(e); return json(res, 500, { error: "server" }); }
};
