const admin = require("firebase-admin");
const crypto = require("crypto");
const { deliverWebhook } = require("./_bot-webhook");
function init() { if (admin.apps.length) return; if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error("FIREBASE_SERVICE_ACCOUNT is not set"); admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) }); }
const json = (res, c, v) => res.status(c).json(v);
async function auth(req) { const m = /^Bearer\s+(.+)$/.exec(req.headers.authorization || ""); return m ? admin.auth().verifyIdToken(m[1]) : null; }
module.exports = async (req, res) => {
  if (req.method !== "POST") return json(res, 405, { error: "method" });
  try {
    init(); const u = await auth(req); if (!u) return json(res, 401, { error: "auth required" }); const db = admin.firestore(); const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {}, gid = String(body.groupId || ""), mid = String(body.messageId || ""), data = String(body.data || "").slice(0, 128);
    const g = await db.doc(`groups/${gid}`).get(), m = await db.doc(`groups/${gid}/messages/${mid}`).get(); if (!g.exists || !m.exists) return json(res, 404, { error: "not found" }); const gd = g.data(), md = m.data(); if (!(gd.members || []).includes(u.uid)) return json(res, 403, { error: "not a member" });
    const button = (md.buttons || []).find(x => x && x.callback === data); if (!button || !String(md.uid).startsWith("bot_")) return json(res, 400, { error: "callback not found" });
    const b = await db.doc(`bots/${String(md.uid).slice(4)}`).get(); if (!b.exists || !b.data().active) return json(res, 404, { error: "bot not found" }); const bot = { id: b.id, ...b.data() };
    const ok = await deliverWebhook(db, bot, { type: "callback_query", id: crypto.randomBytes(8).toString("hex"), data, from: { uid: u.uid }, group: { id: gid, name: gd.name || "" }, message: { id: mid, uid: md.uid } }); return json(res, ok ? 200 : 502, { ok });
  } catch (e) { console.error(e); return json(res, 500, { error: "server" }); }
};
