// Vercel Serverless Function: بيبعت إشعارات فورية (حتى والموقع مقفول).
// محتاج متغير بيئة اسمه FIREBASE_SERVICE_ACCOUNT (محتوى ملف الـ JSON بتاع الـ service account).
const admin = require("firebase-admin");
const rate = new Map();
const notified = new Map();

function init() {
  if (admin.apps.length) return;
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw Object.assign(new Error("FIREBASE_SERVICE_ACCOUNT is not set"), { code: "env-missing" });
  let cred;
  try { cred = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT); }
  catch { throw Object.assign(new Error("FIREBASE_SERVICE_ACCOUNT is not valid JSON"), { code: "env-bad-json" }); }
  admin.initializeApp({ credential: admin.credential.cert(cred) });
}

const tokensOf = async (db, uid) => (await db.collection("users/" + uid + "/tokens").get()).docs.map(d => d.id);
const prefsOf = async (db, uid) => { const s = await db.doc("users/" + uid + "/data/prefs").get(); return s.exists ? s.data() : {}; };

async function push(db, uids, data) {
  let sent = 0, failed = 0, tokens = 0; const codes = [];
  for (let i = 0; i < uids.length; i += 25) {
    const lists = await Promise.all(uids.slice(i, i + 25).map(async u => ({ u, t: await tokensOf(db, u) })));
    const msgs = []; lists.forEach(({ u, t }) => t.forEach(tok => msgs.push({ u, tok })));
    tokens += msgs.length;
    for (let j = 0; j < msgs.length; j += 500) {
      const part = msgs.slice(j, j + 500);
      const r = await admin.messaging().sendEachForMulticast({ tokens: part.map(x => x.tok), data, webpush: { headers: { Urgency: "high", TTL: "604800" } } });
      sent += r.successCount; failed += r.failureCount;
      await Promise.all(r.responses.map(async (x, k) => {
        const c = x.error && x.error.code; if (!c) return; codes.push(c);
        if (c === "messaging/registration-token-not-registered" || c === "messaging/invalid-registration-token")
          await db.doc("users/" + part[k].u + "/tokens/" + part[k].tok).delete().catch(() => {});
      }));
    }
  }
  return { sent, failed, tokens, codes: [...new Set(codes)] };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "method" });
  try {
    const rawLength = Number(req.headers["content-length"] || 0);
    if (rawLength > 20000) return res.status(413).json({ error: "payload too large" });
    init();
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
    if (!m) return res.status(401).json({ error: "no token" });
    const uid = (await admin.auth().verifyIdToken(m[1])).uid;
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const db = admin.firestore();
    const now = Date.now(), prev = rate.get(uid) || [], recent = prev.filter(t => now - t < 10000);
    if (recent.length >= (body.selfTest ? 3 : 20)) return res.status(429).json({ error: "rate" });
    recent.push(now); rate.set(uid, recent);
    if (rate.size > 10000) { for (const [k, ts] of rate) if (!ts.length || now - ts[ts.length - 1] > 60000) rate.delete(k); while (rate.size > 10000) rate.delete(rate.keys().next().value); }

    // اختبار: بيبعت إشعار لأجهزتك إنت
    if (body.selfTest) {
      const r = await push(db, [uid], { title: "ES Chat Pro", body: "إشعار تجريبي من السيرفر ✅", chatId: "test", force: "1" });
      return res.status(200).json(r);
    }

    const chatId = String(body.chatId || "").slice(0, 180), text = String(body.text || "").slice(0, 120), messageId = String(body.messageId || "").slice(0, 180);
    const me = await db.doc("users/" + uid).get();
    if (me.exists && me.data().banned) return res.status(403).json({ error: "banned" });
    const myName = (me.exists && me.data().name) || "رسالة جديدة";

    if (chatId.startsWith("g:")) {            // مجموعة / قناة
      const gid = chatId.slice(2), g = await db.doc("groups/" + gid).get();
      if (!g.exists) return res.status(404).json({ error: "no group" });
      const G = g.data();
      if (!messageId) return res.status(400).json({ error: "message required" });
      const posted = await db.doc("groups/" + gid + "/messages/" + messageId).get();
      if (!posted.exists || posted.data().uid !== uid) return res.status(403).json({ error: "message not found" });
      const dedupeKey = uid + ":" + messageId;
      if (notified.size > 10000) { const cutoff = now - 86400000; for (const [k, t] of notified) if (t < cutoff) notified.delete(k); while (notified.size > 10000) notified.delete(notified.keys().next().value); }
      if (notified.has(dedupeKey) && now - notified.get(dedupeKey) < 86400000) return res.status(200).json({ sent: 0, duplicate: true });
      notified.set(dedupeKey, now);
      if (!(G.members || []).includes(uid)) return res.status(403).json({ error: "not member" });
      if (G.muted && +G.muted[uid] > Date.now() && G.owner !== uid) return res.status(403).json({ error: "muted" });
      if ((G.kind === "channel" || G.sendAdmins) && G.owner !== uid && !(G.admins || []).includes(uid)) return res.status(403).json({ error: "not admin" });
      const cand = (G.members || []).filter(x => x !== uid).slice(0, 300);
      const prefs = await Promise.all(cand.map(async u => ({ u, p: await prefsOf(db, u) })));
      const to = prefs.filter(({ p }) => !(p.mute || []).includes(gid) && !(p.block || []).includes(uid)).map(x => x.u);
      const r = await push(db, to, { title: G.name || "مجموعة", body: G.kind === "channel" ? text : myName + ": " + text, chatId });
      return res.status(200).json(r);
    }

    const parts = chatId.split("_");           // محادثة خاصة
    if (parts.length !== 2 || !parts.includes(uid)) return res.status(403).json({ error: "bad chat" });
    const chat = await db.doc("chats/" + chatId).get();
    if (!chat.exists || !Array.isArray(chat.data().members) || chat.data().members.length !== 2 || !chat.data().members.includes(uid)) return res.status(403).json({ error: "chat not found" });
    const peer = parts.find(p => p !== uid), p = await prefsOf(db, peer);
    if ((p.mute || []).includes(chatId) || (p.block || []).includes(uid)) return res.status(200).json({ sent: 0, skipped: true });
    const r = await push(db, [peer], { title: myName, body: text, chatId });
    return res.status(200).json(r);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server", code: e.code || "", detail: String(e.message || e).slice(0, 200) });
  }
};
