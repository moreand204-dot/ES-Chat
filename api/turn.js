// بيرجّع بيانات اتصال TURN مؤقتة للمكالمات (صوت/فيديو). من غير TURN المكالمات بين شبكات الموبايل (4G) بتفشل.
// اختار واحد من الاتنين وحط متغيراته في Vercel ← Settings ← Environment Variables:
//   (أ) Cloudflare (مجاني): CF_TURN_KEY_ID + CF_TURN_API_TOKEN   (Cloudflare Dashboard ← Realtime ← TURN)
//   (ب) Metered (مجاني 50GB/شهر): METERED_DOMAIN (مثال: myapp.metered.live أو myapp) + METERED_API_KEY
const admin = require("firebase-admin");
const rate = new Map();
function limited(k, max, win = 60000) { const n = Date.now(), r = (rate.get(k) || []).filter(t => n - t < win); if (r.length >= max) return true; r.push(n); rate.set(k, r); if (rate.size > 5000) rate.clear(); return false; }
function init() {
  if (admin.apps.length) return;
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}
module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    init();
    const m = /^Bearer\s+(.+)$/.exec(req.headers.authorization || "");
    if (!m) return res.status(401).json({ error: "auth" });
    const u = await admin.auth().verifyIdToken(m[1]);
    if (limited(u.uid, 12)) return res.status(429).json({ error: "rate" });
    const e = process.env;
    if (e.CF_TURN_KEY_ID && e.CF_TURN_API_TOKEN) {
      const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(e.CF_TURN_KEY_ID)}/credentials/generate`, {
        method: "POST", headers: { Authorization: "Bearer " + e.CF_TURN_API_TOKEN, "Content-Type": "application/json" }, body: JSON.stringify({ ttl: 7200 })
      });
      if (!r.ok) return res.status(502).json({ error: "cloudflare " + r.status });
      const j = await r.json(); const ice = j.iceServers;
      return res.status(200).json({ iceServers: Array.isArray(ice) ? ice : ice ? [ice] : [], provider: "cloudflare" });
    }
    if (e.METERED_DOMAIN && e.METERED_API_KEY) {
      const dom = String(e.METERED_DOMAIN).replace(/^https?:\/\//, "").replace(/\.metered\.live.*$/, "");
      const r = await fetch(`https://${dom}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(e.METERED_API_KEY)}`);
      if (!r.ok) return res.status(502).json({ error: "metered " + r.status });
      return res.status(200).json({ iceServers: await r.json(), provider: "metered" });
    }
    return res.status(200).json({ iceServers: [], configured: false });
  } catch (err) { console.error("turn:", err.message); return res.status(500).json({ error: "server" }); }
};
