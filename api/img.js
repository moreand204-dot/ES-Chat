// صورة بروفايل/قناة/مجموعة كملف صورة حقيقي (https) عشان كروت الروابط (واتساب/تيليجرام)
// الصور متخزنة base64 جوه Firestore، فالدالة دي بتفكّها وبتقدّمها كصورة.
const admin = require("firebase-admin");
const OK = /^[a-z0-9_]{3,20}$/;
function init() {
  if (admin.apps.length) return;
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}
module.exports = async (req, res) => {
  const q = req.query || {};
  let photo = "";
  try {
    init(); const db = admin.firestore();
    if (OK.test(String(q.u || ""))) {
      const un = await db.doc("usernames/" + q.u).get();
      if (un.exists) { const p = await db.doc(`users/${un.data().uid}/public/profile`).get(); photo = p.exists ? p.data().photo : ""; }
    } else if (OK.test(String(q.c || ""))) {
      const h = await db.doc("handles/" + q.c).get();
      if (h.exists) { const g = await db.doc("groupDirectory/" + h.data().gid).get(); if (g.exists && g.data().public) photo = g.data().photo; }
    } else if (/^[A-Za-z0-9]{10,40}$/.test(String(q.g || ""))) {
      const g = await db.doc("groups/" + q.g).get(); if (g.exists && g.data().joinOpen) photo = g.data().photo;
    }
  } catch (e) { console.error("img:", e.message); }
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(photo || ""));
  if (!m) { res.statusCode = 302; res.setHeader("Location", "/assets/icon-512.png"); return res.end(); }
  res.setHeader("Content-Type", m[1]);
  res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=3600");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.status(200).send(Buffer.from(m[2], "base64"));
};
