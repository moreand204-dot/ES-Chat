// ربط الأجهزة/البوتات بحساب المستخدم — شبيه بفكرة "الأجهزة المرتبطة" في واتساب.
// الفكرة: المالك يطلب كود (ويُعرض أيضًا كـ QR payload)، وبوت يملك رمزه السري الخاص
// يؤكد هذا الكود فيتسجل كـ "جهاز مرتبط" على حساب المالك. الربط ده بيدي البوت صلاحية
// الانضمام لمجموعات/قنوات المالك اللي هو عضو/مشرف فيها (bots.js: hasLinkedAuthority)
// من غير ما يحتاج صاحب الحساب يستدعي addToGroup يدويًا لكل بوت.
// ملحوظة خصوصية مهمة: المحادثات الخاصة مشفّرة طرف-لطرف، فمفيش أي ربط هنا بيدي
// البوت وصول لمحادثاتك الخاصة أو مفاتيح التشفير — نفس القيد الموجود في bot.js.
const admin = require("firebase-admin");
const crypto = require("crypto");
function init() {
  if (admin.apps.length) return;
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw Object.assign(new Error("FIREBASE_SERVICE_ACCOUNT is not set"), { code: "env-missing" });
  let cred; try { cred = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT); } catch { throw Object.assign(new Error("FIREBASE_SERVICE_ACCOUNT is not valid JSON"), { code: "env-bad-json" }); }
  admin.initializeApp({ credential: admin.credential.cert(cred) });
}
const hash = s => crypto.createHash("sha256").update(String(s)).digest("hex");
const id = (n = 6) => crypto.randomBytes(n).toString("hex");
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // بدون 0/O و1/I عشان ميتلخبطش وهو بيتكتب يدويًا
const makeCode = () => { const b = crypto.randomBytes(8); let s = ""; for (let i = 0; i < 8; i++) s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length]; return s; };
const send = (res, code, body) => res.status(code).json(body);
const text = (v, max) => String(v || "").trim().slice(0, max);
const REQUEST_TTL_MS = 70 * 1000;
const MAX_PENDING_PER_USER = 5;
const MAX_LINKED_DEVICES = 20;
const MAX_CONFIRM_ATTEMPTS = 8;

async function userFrom(req) {
  const m = /^Bearer\s+(.+)$/.exec(req.headers.authorization || ""); if (!m) return null;
  try { return await admin.auth().verifyIdToken(m[1], true); } catch { return null; } // توكن غلط/ملغي = 401 مش 500
}
async function botFrom(db, req) {
  const raw = String(req.headers["x-es-bot-token"] || req.body?.token || "");
  if (!/^esb_live_[A-Za-z0-9_-]{20,240}$/.test(raw)) return null;
  const sec = await db.doc(`botSecrets/${hash(raw)}`).get(); if (!sec.exists || sec.data().active !== true) return null;
  const b = await db.doc(`bots/${sec.data().botId}`).get(); if (!b.exists || b.data().active !== true || b.data().tokenHash !== hash(raw)) return null;
  return { id: b.id, ...b.data() };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return send(res, 405, { error: "method" });
  if (Number(req.headers["content-length"] || 0) > 4000) return send(res, 413, { error: "payload too large" });
  try {
    init();
    const db = admin.firestore();
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const action = text(body.action, 40);

    // المالك (Firebase ID Token) يطلب كود/QR جديد لربط جهاز أو بوت بحسابه.
    if (action === "create") {
      const u = await userFrom(req); if (!u) return send(res, 401, { error: "user auth required" });
      const now = Date.now();
      const pendingSnap = await db.collection("linkRequests").where("owner", "==", u.uid).where("status", "==", "pending").get();
      const stillPending = pendingSnap.docs.filter(d => d.data().status === "pending" && (d.data().expiresAtMs || 0) > now);
      if (stillPending.length >= MAX_PENDING_PER_USER) return send(res, 429, { error: "too many pending requests" });
      const devicesSnap = await db.collection(`users/${u.uid}/linkedDevices`).where("status", "==", "active").get();
      if (devicesSnap.size >= MAX_LINKED_DEVICES) return send(res, 429, { error: "linked device limit reached" });
      const reqId = id(6), code = makeCode(), expiresAtMs = now + REQUEST_TTL_MS;
      await db.doc(`linkRequests/${reqId}`).set({
        owner: u.uid, codeHash: hash(code), status: "pending", attempts: 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp(), expiresAtMs
      });
      return send(res, 201, { requestId: reqId, code, qrPayload: `esclink:${reqId}.${code}`, expiresInSeconds: REQUEST_TTL_MS / 1000 });
    }

    // المالك يستطلع حالة الكود (pending / confirmed / expired) لحد ما يظهر الجهاز في القائمة.
    if (action === "status") {
      const u = await userFrom(req); if (!u) return send(res, 401, { error: "user auth required" });
      const reqId = text(body.requestId, 40);
      const snap = await db.doc(`linkRequests/${reqId}`).get();
      if (!snap.exists || snap.data().owner !== u.uid) return send(res, 404, { error: "not found" });
      const d = snap.data();
      const expired = d.status === "pending" && Date.now() > (d.expiresAtMs || 0);
      return send(res, 200, { status: expired ? "expired" : d.status, device: d.status === "confirmed" ? (d.deviceSummary || null) : null });
    }

    // البوت (برمزه السري esb_live_...) يؤكد الكود اللي المستخدم إداله، فيتسجل كجهاز مرتبط بحساب المستخدم.
    if (action === "confirm") {
      const bot = await botFrom(db, req); if (!bot) return send(res, 401, { error: "invalid bot token" });
      const reqId = text(body.requestId, 40), code = text(body.code, 16).toUpperCase().replace(/\s+/g, "");
      if (!reqId || !code) return send(res, 400, { error: "requestId and code required" });
      const ref = db.doc(`linkRequests/${reqId}`);
      // مهم: الـ throw جوه runTransaction بيلغي كل الكتابات (Firestore بيعمل rollback)، فكان عدّاد المحاولات
      // الغلط عمره ما بيتحفظ والقفل بعد 8 محاولات ما كانش بيشتغل. عشان كده بنرجّع نتيجة ونرمي بعد الـ commit.
      const result = await db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists) return { err: "not_found" };
        const d = snap.data();
        if (d.status !== "pending") return { err: "already_used" };
        if (Date.now() > (d.expiresAtMs || 0)) return { err: "expired" };
        if ((d.attempts || 0) >= MAX_CONFIRM_ATTEMPTS) return { err: "too_many_attempts" };
        if (d.codeHash !== hash(code)) { tx.update(ref, { attempts: (d.attempts || 0) + 1 }); return { err: "bad_code" }; }
        // لو نفس البوت كان مربوط قبل كده بنفس الحساب: نلغي الجهاز القديم عشان القايمة ما تبقاش فيها كارت يتيم
        const linkRef = db.doc(`bots/${bot.id}/linkedAccounts/${d.owner}`);
        const prevLink = await tx.get(linkRef);
        const prevDeviceId = prevLink.exists ? String(prevLink.data().deviceId || "") : "";
        const prevDevRef = prevDeviceId ? db.doc(`users/${d.owner}/linkedDevices/${prevDeviceId}`) : null;
        const prevDev = prevDevRef ? await tx.get(prevDevRef) : null;
        if (prevDev && prevDev.exists) tx.update(prevDevRef, { status: "revoked", revokedAt: admin.firestore.FieldValue.serverTimestamp() });
        const deviceId = id(6);
        const deviceSummary = { type: "bot", botId: bot.id, botName: text(bot.name, 40) };
        tx.update(ref, { status: "confirmed", deviceSummary, confirmedAt: admin.firestore.FieldValue.serverTimestamp() });
        tx.set(db.doc(`users/${d.owner}/linkedDevices/${deviceId}`), {
          type: "bot", botId: bot.id, botName: text(bot.name, 40), scope: "owner-groups", status: "active",
          linkedAt: admin.firestore.FieldValue.serverTimestamp(), lastActiveAt: admin.firestore.FieldValue.serverTimestamp()
        });
        tx.set(db.doc(`bots/${bot.id}/linkedAccounts/${d.owner}`), { uid: d.owner, deviceId, linkedAt: admin.firestore.FieldValue.serverTimestamp() });
        return { deviceId };
      });
      if (result.err) throw Object.assign(new Error(result.err), { code: result.err });
      return send(res, 200, { ok: true, deviceId: result.deviceId });
    }

    // المالك يلغي ربط جهاز/بوت — يمسح الصلاحية فورًا من الطرفين.
    if (action === "revoke") {
      const u = await userFrom(req); if (!u) return send(res, 401, { error: "user auth required" });
      const deviceId = text(body.deviceId, 40);
      const ref = db.doc(`users/${u.uid}/linkedDevices/${deviceId}`);
      const snap = await ref.get();
      if (!snap.exists) return send(res, 404, { error: "not found" });
      const d = snap.data();
      if (d.status === "revoked") return send(res, 200, { ok: true, already: true });
      await ref.update({ status: "revoked", revokedAt: admin.firestore.FieldValue.serverTimestamp() });
      if (d.type === "bot" && d.botId) {
        // نمسح الربط بس لو لسه بيشاور على الجهاز ده (مش على ربط أحدث لنفس البوت)
        const linkRef = db.doc(`bots/${d.botId}/linkedAccounts/${u.uid}`);
        const link = await linkRef.get().catch(() => null);
        if (link && link.exists && link.data().deviceId === deviceId) await linkRef.delete().catch(() => {});
      }
      return send(res, 200, { ok: true });
    }

    return send(res, 400, { error: "unknown action" });
  } catch (e) {
    const known = ["not_found", "already_used", "expired", "bad_code", "too_many_attempts"];
    if (known.includes(e.code)) return send(res, 400, { error: e.code });
    console.error(e);
    const envErr = String(e.code || "").startsWith("env"); // تفاصيل الخطأ بتتعرض بس لمشاكل الإعداد، مش لأخطاء Firestore الداخلية
    return send(res, 500, { error: "server", code: e.code || "", ...(envErr ? { detail: String(e.message || e).slice(0, 160) } : {}) });
  }
};
