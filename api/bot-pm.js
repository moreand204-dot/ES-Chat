// api/bot-pm.js
// محادثة خاصة مشفّرة (E2EE) بين مستخدم وبوت — زي ما البوت بيفتح كـ "شات" في تيليجرام،
// بس هنا البوت "جهاز تشفير" حقيقي جوه نفس بروتوكول E2EE بتاع الموقع (e2ee.js)، والمفتاح الخاص
// بتاعه متخزن مشفّر على السيرفر فقط (شوف _bot-e2ee.js). محدش بيبعت أي مفتاح خام للمتصفح.
//
// action "open"    : يجهّز (أو ينشئ) بوت ESFather الداخلي بتاع صاحب الحساب، ويضمن إن عنده جهاز E2EE،
//                    وبيرجّع botUid عشان الواجهة تفتحه زي أي محادثة خاصة عادية (openChat).
// action "process" : بتتنادى من المتصفح بعد ما المستخدم يبعت رسالة للبوت؛ السيرفر بيجيب الرسالة
//                    المشفّرة من Firestore، يفكها بمفتاح البوت الخاص، يبني رد، ويشفّره بالمفتاح
//                    العام الحقيقي للمستخدم قبل ما يخزنه — نفس شكل التشفير اللي شغال بين أي مستخدمين.
const admin = require("firebase-admin");
const crypto = require("crypto");
const { generateBotDevice, publicBundleOf, sealPrivateDevice, openPrivateDevice, decryptForBot, encryptFromBot } = require("./_bot-e2ee");

function init() {
  if (admin.apps.length) return;
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw Object.assign(new Error("FIREBASE_SERVICE_ACCOUNT is not set"), { code: "env-missing" });
  let cred; try { cred = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT); } catch { throw Object.assign(new Error("FIREBASE_SERVICE_ACCOUNT is not valid JSON"), { code: "env-bad-json" }); }
  admin.initializeApp({ credential: admin.credential.cert(cred) });
}
const send = (res, code, body) => res.status(code).json(body);
const text = (v, max) => String(v || "").trim().slice(0, max);
async function userFrom(req) { const m = /^Bearer\s+(.+)$/.exec(req.headers.authorization || ""); if (!m) return null; try { return await admin.auth().verifyIdToken(m[1]); } catch { return null; } }

// ردود مبدئية مبنية جوه المنصة — ده بس حتى يبقى للبوت رد فعلي من غير ما تحتاج تجهّز سيرفر خارجي.
// لو ضبطت Webhook للبوت من "مدير البوتات"، تقدر بعدين تبني منطق رد مخصص بالكامل بدل الرد ده.
const BUILTIN = {
  start: "أهلاً بيك 👋 أنا ESFather، بوت موقعك الخاص. اكتب /help عشان تشوف الأوامر المتاحة.",
  help: "الأوامر المتاحة:\n/start — ابدأ من جديد\n/help — عرض المساعدة\n/ping — تأكيد إن البوت شغّال",
  ping: "pong 🏓",
};
function buildReply(msgText) {
  const t = String(msgText || "").trim();
  const m = /^\/([a-z0-9_]{1,32})/i.exec(t);
  const cmd = m ? m[1].toLowerCase() : "";
  if (BUILTIN[cmd]) return BUILTIN[cmd];
  if (!t) return BUILTIN.start;
  return `استلمت رسالتك: "${t.slice(0, 200)}"\n(رد تلقائي مبدئي من ESFather — اربط Webhook للبوت من "مدير البوتات" عشان تتحكم في الردود بنفسك)`;
}

async function ensureDevice(db, botId, botUid) {
  const secureRef = db.doc(`bots/${botId}/secure/e2ee`);
  const secureSnap = await secureRef.get();
  if (secureSnap.exists) {
    const priv = await openPrivateDevice(secureSnap.data().sealed, botId);
    await db.doc(`users/${botUid}/crypto/${priv.deviceId}`).set(publicBundleOf(priv), { merge: true });
    return priv;
  }
  const priv = await generateBotDevice();
  const sealed = await sealPrivateDevice(priv, botId);
  await secureRef.set({ sealed, deviceId: priv.deviceId, createdAt: admin.firestore.FieldValue.serverTimestamp() });
  await db.doc(`users/${botUid}/crypto/${priv.deviceId}`).set(publicBundleOf(priv), { merge: true });
  return priv;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return send(res, 405, { error: "method" });
  if (Number(req.headers["content-length"] || 0) > 20000) return send(res, 413, { error: "payload too large" });
  try {
    init(); const db = admin.firestore();
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const action = text(body.action, 40);
    const u = await userFrom(req); if (!u) return send(res, 401, { error: "user auth required" });

    if (action === "open") {
      let botId = text(body.botId, 80), botSnap;
      if (botId) {
        botSnap = await db.doc(`bots/${botId}`).get();
        if (!botSnap.exists || botSnap.data().owner !== u.uid || botSnap.data().deleted) return send(res, 404, { error: "bot not found" });
      } else {
        const existing = await db.collection("bots").where("owner", "==", u.uid).where("name", "==", "ESFather").limit(1).get();
        if (!existing.empty) { botSnap = existing.docs[0]; botId = botSnap.id; }
        else {
          botId = crypto.randomBytes(9).toString("hex");
          const token = `esb_live_${botId}_${crypto.randomBytes(24).toString("base64url")}`;
          const h = crypto.createHash("sha256").update(token).digest("hex");
          const botUid = `bot_${botId}`, now = admin.firestore.FieldValue.serverTimestamp();
          await db.doc(`bots/${botId}`).set({
            owner: u.uid, name: "ESFather", nameAr: "ESFather", nameEn: "ESFather", botUid, active: true,
            tokenHash: h, tokenPrefix: token.slice(0, 18), createdAt: now, groups: [], commands: [],
            settings: { inline: false, inlineGeo: false, joinGroups: true, privacy: true, allowPM: true },
          });
          await db.doc(`botSecrets/${h}`).set({ botId, owner: u.uid, active: true, createdAt: now });
          await db.doc(`users/${botUid}/public/profile`).set({ uid: botUid, name: "ESFather", photo: "", gender: "male", bio: "بوت موقعك الخاص — ESFather", username: botId, verified: true }, { merge: true });
          botSnap = await db.doc(`bots/${botId}`).get();
        }
      }
      const b = botSnap.data(), botUid = b.botUid || `bot_${botId}`;
      await ensureDevice(db, botId, botUid);
      return send(res, 200, { botId, botUid });
    }

    if (action === "process") {
      const botId = text(body.botId, 80), dmId = text(body.dmId, 160), messageId = text(body.messageId, 80);
      const botSnap = await db.doc(`bots/${botId}`).get();
      if (!botSnap.exists || botSnap.data().deleted) return send(res, 404, { error: "bot not found" });
      const b = botSnap.data(), botUid = b.botUid || `bot_${botId}`;
      if (b.active !== true) return send(res, 200, { skipped: "inactive" });
      if (dmId !== [u.uid, botUid].sort().join("_")) return send(res, 403, { error: "dm mismatch" });
      const secureSnap = await db.doc(`bots/${botId}/secure/e2ee`).get();
      if (!secureSnap.exists) return send(res, 200, { skipped: "pm-not-enabled" });
      const msgSnap = await db.doc(`chats/${dmId}/messages/${messageId}`).get();
      if (!msgSnap.exists) return send(res, 404, { error: "message not found" });
      const md = msgSnap.data();
      if (md.uid !== u.uid || !md.cipher) return send(res, 200, { skipped: "not-applicable" });

      const priv = await openPrivateDevice(secureSnap.data().sealed, botId);
      let plain; try { plain = await decryptForBot(md.cipher, priv); } catch (e) { console.error("decryptForBot failed", e); plain = null; }
      if (!plain) return send(res, 200, { skipped: "decrypt-failed" });

      const userCryptoSnap = await db.collection(`users/${u.uid}/crypto`).limit(1).get();
      if (userCryptoSnap.empty) return send(res, 200, { skipped: "peer-key-missing" });
      const recipientBundle = userCryptoSnap.docs[0].data();
      const cipher = await encryptFromBot({ text: buildReply(plain.text || "") }, recipientBundle, priv);
      await db.collection(`chats/${dmId}/messages`).add({ uid: botUid, at: admin.firestore.FieldValue.serverTimestamp(), cipher });
      await db.doc(`chats/${dmId}`).set({ members: [u.uid, botUid].sort(), lastText: "🔒 رسالة مشفّرة", lastAt: admin.firestore.FieldValue.serverTimestamp(), lastUid: botUid }, { merge: true });
      return send(res, 200, { replied: true });
    }

    return send(res, 400, { error: "unknown action" });
  } catch (e) {
    console.error(e);
    if (e && e.code === "env-missing") return send(res, 500, { error: "BOT_PM_MASTER_KEY أو FIREBASE_SERVICE_ACCOUNT غير مضبوط على الخادم" });
    return send(res, 500, { error: "server" });
  }
};
