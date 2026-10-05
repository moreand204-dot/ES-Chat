// Vercel Serverless Function: بيبعت إشعار فوري للمستلم لما حد يبعتله رسالة.
// محتاج متغير بيئة اسمه FIREBASE_SERVICE_ACCOUNT (محتوى ملف الـ JSON بتاع الـ service account).
const admin = require("firebase-admin");

function init() {
  if (admin.apps.length) return;
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "method" });
  try {
    init();
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
    if (!m) return res.status(401).json({ error: "no token" });
    const decoded = await admin.auth().verifyIdToken(m[1]);
    const uid = decoded.uid;

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const chatId = String(body.chatId || "");
    const text = String(body.text || "").slice(0, 120);
    const parts = chatId.split("_");
    if (parts.length !== 2 || !parts.includes(uid)) return res.status(403).json({ error: "bad chat" });
    const peer = parts.find(p => p !== uid);

    const db = admin.firestore();
    const [me, peerDoc, tokensSnap] = await Promise.all([
      db.doc("users/" + uid).get(),
      db.doc("users/" + peer).get(),
      db.collection("users/" + peer + "/tokens").get(),
    ]);
    if (!tokensSnap.size) return res.status(200).json({ sent: 0 });
    if (me.exists && me.data().banned) return res.status(403).json({ error: "banned" });

    const name = (me.exists && me.data().name) || "رسالة جديدة";
    const tokens = tokensSnap.docs.map(d => d.id);
    const r = await admin.messaging().sendEachForMulticast({
      tokens,
      data: { title: name, body: text, chatId },
      webpush: { headers: { Urgency: "high", TTL: "3600" } },
    });
    // نمسح التوكنز اللي اتبطلت
    const dead = [];
    r.responses.forEach((x, i) => {
      const c = x.error && x.error.code;
      if (c === "messaging/registration-token-not-registered" || c === "messaging/invalid-registration-token") dead.push(tokens[i]);
    });
    await Promise.all(dead.map(t => db.doc("users/" + peer + "/tokens/" + t).delete()));
    return res.status(200).json({ sent: r.successCount });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server" });
  }
};
