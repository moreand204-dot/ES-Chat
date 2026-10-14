const admin = require("firebase-admin");
const crypto = require("crypto");
function init() {
  if (admin.apps.length) return;
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error("FIREBASE_SERVICE_ACCOUNT is not set");
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}
const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const safeName = value => String(value || "file").replace(/[\\\r\n\"\/]/g, "_").slice(0, 120) || "file";
// بس الأنواع دي تتعرض جوه المتصفح؛ أي حاجة تانية (html/svg/js...) بتتنزّل كملف. غير كده كان أي بوت يرفع HTML بسكريبت
// ويتفتح من نفس دومين الموقع (Stored XSS) فيسرق جلسات اللي يفتحوه.
const SAFE_INLINE = /^(image\/(png|jpe?g|gif|webp)|audio\/(mpeg|mp3|ogg|wav|webm|mp4|aac|x-m4a)|video\/(mp4|webm|ogg))$/i;
const asciiName = n => safeName(n).replace(/[^\x20-\x7e]/g, "_");
module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ ok: false, error_code: 405, description: "method not allowed" });
  try {
    init(); const db = admin.firestore(); const id = String(req.query?.file_id || "").replace(/[^a-f0-9]/g, ""); const key = String(req.query?.key || "");
    if (!/^[a-f0-9]{24}$/.test(id) || !/^[A-Za-z0-9_-]{32,80}$/.test(key)) return res.status(404).end();
    const snap = await db.doc(`botFiles/${id}`).get(); if (!snap.exists) return res.status(404).end(); const file = snap.data();
    if (file.status !== "ready" || file.keyHash !== hash(key) || Number(file.bytes || 0) > 15 * 1024 * 1024) return res.status(404).end();
    const partsSnap = await db.collection(`botFiles/${id}/parts`).get(); const parts = partsSnap.docs.map(d => d.data()).sort((a,b) => Number(a.index) - Number(b.index));
    if (parts.length !== Number(file.parts || 0) || parts.some((p, i) => p.index !== i || typeof p.data !== "string")) return res.status(409).end();
    const chunks = parts.map(p => Buffer.from(p.data, "base64")); const data = Buffer.concat(chunks); if (data.length !== Number(file.bytes)) return res.status(409).end();
    const type = String(file.type || "").toLowerCase().split(";")[0].trim(), inline = SAFE_INLINE.test(type);
    res.setHeader("Content-Type", inline ? type : "application/octet-stream"); res.setHeader("Content-Length", String(data.length));
    // اسم الملف العربي كان بيرمي خطأ في الهيدر (500) — بنبعت نسخة ASCII + filename* بالـ UTF-8
    res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${asciiName(file.name)}"; filename*=UTF-8''${encodeURIComponent(safeName(file.name))}`);
    res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox"); res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Cache-Control", "private, max-age=3600"); return res.status(200).send(data);
  } catch (e) { console.error("es bot file error", e?.message || e); return res.status(500).end(); }
};
