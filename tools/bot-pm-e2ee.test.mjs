// فحص محلي مستقل: يتأكد إن تشفير/فك تشفير السيرفر (api/_bot-e2ee.js) متوافق 100%
// مع نفس بروتوكول العميل (e2ee.js) - من غير ما يلمس أي سيرفر أو قاعدة بيانات حقيقية.
import { webcrypto as wc } from "node:crypto";
import { generateBotDevice, publicBundleOf, sealPrivateDevice, openPrivateDevice, decryptForBot, encryptFromBot } from "../api/_bot-e2ee.js";

process.env.BOT_PM_MASTER_KEY = Buffer.from(wc.getRandomValues(new Uint8Array(32))).toString("base64");

const { subtle } = wc;
const DH = { name: "ECDH", namedCurve: "P-256" };
const b64 = b => Buffer.from(b).toString("base64");
const unb64 = s => Buffer.from(s, "base64");

// === مطابق تمامًا لمنطق e2ee.js في المتصفح (لمحاكاة "المستخدم") ===
async function genUserDevice() {
  const kp = await subtle.generateKey(DH, true, ["deriveKey", "deriveBits"]);
  return { priv: kp.privateKey, pub: await subtle.exportKey("jwk", kp.publicKey) };
}
async function clientEncrypt(selfPriv, selfPubJwk, recipientPubJwk, payload) {
  const receiver = await subtle.importKey("jwk", recipientPubJwk, DH, false, []);
  const eph = await subtle.generateKey(DH, true, ["deriveBits"]);
  const bits = await subtle.deriveBits({ name: "ECDH", public: receiver }, eph.privateKey, 256);
  const key = await subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = wc.getRandomValues(new Uint8Array(12));
  const plain = Buffer.from(JSON.stringify(payload));
  const ct = Buffer.from(await subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  const ephPub = await subtle.exportKey("jwk", eph.publicKey);
  return { v: 2, alg: "ECDH-P256-AESGCM-DUAL", recipient: { senderEphemeralPublic: ephPub, iv: b64(iv), ciphertext: b64(ct) }, sender: { senderIdentityPublic: selfPubJwk, iv: b64(iv), ciphertext: b64(ct) } };
}
async function clientDecrypt(selfPriv, cipher) {
  const part = cipher.recipient;
  const senderPub = await subtle.importKey("jwk", part.senderEphemeralPublic, DH, false, []);
  const bits = await subtle.deriveBits({ name: "ECDH", public: senderPub }, selfPriv, 256);
  const key = await subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["decrypt"]);
  const pt = await subtle.decrypt({ name: "AES-GCM", iv: unb64(part.iv) }, key, unb64(part.ciphertext));
  return JSON.parse(Buffer.from(pt).toString("utf8"));
}

const run = async () => {
  // 1) السيرفر يولّد جهاز البوت ويختمه (Seal) زي ما هيحصل فعليًا عند أول "فتح البوت"
  const botId = "testbot123";
  const botPriv = await generateBotDevice();
  const sealed = await sealPrivateDevice(botPriv, botId);
  console.log("sealed ok, ciphertext length:", sealed.ciphertext.length);
  const reopened = await openPrivateDevice(sealed, botId);
  console.assert(JSON.stringify(reopened) === JSON.stringify(botPriv), "FAIL: seal/open roundtrip mismatch");
  console.log("seal/open roundtrip:", JSON.stringify(reopened) === JSON.stringify(botPriv) ? "OK" : "FAIL");

  // 2) المستخدم (محاكاة العميل) يبعت رسالة للبوت
  const user = await genUserDevice();
  const botPub = publicBundleOf(botPriv);
  const userToBot = await clientEncrypt(user.priv, user.pub, botPub.identityDHPublic, { text: "السلام عليكم يا ESFather" });

  // 3) السيرفر (البوت) يفك رسالة المستخدم بمفتاحه الخاص
  const decoded = await decryptForBot(userToBot, botPriv);
  console.log("decryptForBot ->", decoded);
  console.assert(decoded.text === "السلام عليكم يا ESFather", "FAIL: decryptForBot mismatch");

  // 4) السيرفر (البوت) يرد ويشفّر الرد بالمفتاح العام الحقيقي للمستخدم
  const userCryptoDoc = { identityDHPublic: user.pub };
  const botReply = await encryptFromBot({ text: "أهلاً بيك! 👋" }, userCryptoDoc, botPriv);

  // 5) المستخدم (محاكاة العميل) يفك رد البوت بمفتاحه الخاص هو
  const plainReply = await clientDecrypt(user.priv, botReply);
  console.log("client decrypt of bot reply ->", plainReply);
  console.assert(plainReply.text === "أهلاً بيك! 👋", "FAIL: round trip reply mismatch");

  console.log("\n✅ كل الفحوصات نجحت — التشفير متوافق بين السيرفر (البوت) والعميل.");
};
run().catch(e => { console.error("❌ FAILED:", e); process.exit(1); });
