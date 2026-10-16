// api/_bot-e2ee.js
// مرآة Node.js لنفس بروتوكول التشفير الموجود في e2ee.js (ECDH P-256 + AES-GCM, protocol "e2ee-foundation-p256-v1").
// الهدف: إدي لكل بوت "جهاز" تشفير حقيقي، نفس الشكل اللي بيفهمه كود العميل بدون أي تعديل فيه.
// مفتاح البوت الخاص (identityDHPrivate...) بيتولّد ويتشفّر فورًا بمفتاح مشتق من BOT_PM_MASTER_KEY
// قبل ما يتخزن، وبيتفك تشفيره فقط لحظة الاستخدام على السيرفر. محدش بيبعت المفتاح الخام للمتصفح.
const nodeCrypto = require("crypto");
const { subtle } = nodeCrypto.webcrypto;

const DH = { name: "ECDH", namedCurve: "P-256" };
const SIGN = { name: "ECDSA", namedCurve: "P-256" };
const PROTOCOL = "e2ee-foundation-p256-v1";

const b64 = buf => Buffer.from(buf).toString("base64");
const unb64 = s => Buffer.from(String(s || ""), "base64");

async function generateBotDevice() {
  const identityDH = await subtle.generateKey(DH, true, ["deriveKey", "deriveBits"]);
  const identitySign = await subtle.generateKey(SIGN, true, ["sign", "verify"]);
  const signed = await subtle.generateKey(DH, true, ["deriveKey", "deriveBits"]);
  const signedPreKeyPublic = await subtle.exportKey("jwk", signed.publicKey);
  const sig = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, identitySign.privateKey, Buffer.from(JSON.stringify(signedPreKeyPublic)));
  const preKeys = [];
  for (let i = 0; i < 100; i++) {
    const k = await subtle.generateKey(DH, true, ["deriveKey", "deriveBits"]);
    preKeys.push({ id: i + 1, privateKey: await subtle.exportKey("jwk", k.privateKey), publicKey: await subtle.exportKey("jwk", k.publicKey) });
  }
  return {
    deviceId: "bd_" + nodeCrypto.randomBytes(9).toString("hex"),
    identityDHPrivate: await subtle.exportKey("jwk", identityDH.privateKey),
    identityDHPublic: await subtle.exportKey("jwk", identityDH.publicKey),
    identitySignPrivate: await subtle.exportKey("jwk", identitySign.privateKey),
    identitySignPublic: await subtle.exportKey("jwk", identitySign.publicKey),
    signedPreKeyPrivate: await subtle.exportKey("jwk", signed.privateKey),
    signedPreKeyPublic,
    signedPreKeySignature: b64(sig),
    preKeys,
  };
}

function publicBundleOf(priv) {
  return {
    deviceId: priv.deviceId,
    identityDHPublic: priv.identityDHPublic,
    identitySignPublic: priv.identitySignPublic,
    signedPreKeyPublic: priv.signedPreKeyPublic,
    signedPreKeySignature: priv.signedPreKeySignature,
    preKeysPublic: priv.preKeys.map(k => ({ id: k.id, publicKey: k.publicKey })),
    protocol: PROTOCOL,
  };
}

// تشفير بيانات اعتماد البوت الخاصة قبل تخزينها — AES-256-GCM بمفتاح مشتق (HKDF) من BOT_PM_MASTER_KEY + botId،
// يعني لو حد قرأ قاعدة البيانات لوحدها من غير الـ env secret مش هيقدر يفك أي بوت.
function deriveSealKey(botId) {
  const master = process.env.BOT_PM_MASTER_KEY;
  if (!master) throw Object.assign(new Error("BOT_PM_MASTER_KEY is not set"), { code: "env-missing" });
  const masterBytes = Buffer.from(master, "base64");
  if (masterBytes.length < 32) throw Object.assign(new Error("BOT_PM_MASTER_KEY must decode to at least 32 bytes"), { code: "env-weak" });
  return Buffer.from(nodeCrypto.hkdfSync("sha256", masterBytes, Buffer.alloc(0), Buffer.from("es-bot-pm:" + botId), 32));
}

async function sealPrivateDevice(priv, botId) {
  const keyBytes = deriveSealKey(botId);
  const key = await subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = nodeCrypto.randomBytes(12);
  const ct = Buffer.from(await subtle.encrypt({ name: "AES-GCM", iv }, key, Buffer.from(JSON.stringify(priv))));
  return { v: 1, alg: "AES-256-GCM", iv: b64(iv), ciphertext: b64(ct) };
}

async function openPrivateDevice(sealed, botId) {
  const keyBytes = deriveSealKey(botId);
  const key = await subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
  const pt = await subtle.decrypt({ name: "AES-GCM", iv: unb64(sealed.iv) }, key, unb64(sealed.ciphertext));
  return JSON.parse(Buffer.from(pt).toString("utf8"));
}

const importDhPub = jwk => subtle.importKey("jwk", jwk, DH, false, []);
const importDhPriv = jwk => subtle.importKey("jwk", jwk, DH, false, ["deriveBits"]);
const aesFromBits = (bits, usage) => subtle.importKey("raw", bits, { name: "AES-GCM" }, false, [usage]);

// فك تشفير رسالة وصلت من المستخدم للبوت (البوت هو المستلم) — بيستخدم مفتاح البوت الخاص بس.
async function decryptForBot(cipher, botPriv) {
  if (!cipher || cipher.alg !== "ECDH-P256-AESGCM-DUAL" || !cipher.recipient) return null;
  const part = cipher.recipient;
  const senderEphemeralPub = await importDhPub(part.senderEphemeralPublic);
  const myPriv = await importDhPriv(botPriv.identityDHPrivate);
  const bits = await subtle.deriveBits({ name: "ECDH", public: senderEphemeralPub }, myPriv, 256);
  const key = await aesFromBits(bits, "decrypt");
  const pt = await subtle.decrypt({ name: "AES-GCM", iv: unb64(part.iv) }, key, unb64(part.ciphertext));
  return JSON.parse(Buffer.from(pt).toString("utf8"));
}

// تشفير رد البوت للمستخدم الحقيقي (recipientBundle = بياناته من users/{uid}/crypto) — نفس شكل التشفير الثنائي v2
// اللي كود العميل (e2ee.js) عارف يفكه بدون أي تعديل.
async function encryptFromBot(payload, recipientBundle, botPriv) {
  const receiverPub = await importDhPub(recipientBundle.identityDHPublic);
  const eph = await subtle.generateKey(DH, true, ["deriveBits"]);
  const recipientBits = await subtle.deriveBits({ name: "ECDH", public: receiverPub }, eph.privateKey, 256);
  const recipientKey = await aesFromBits(recipientBits, "encrypt");
  const recipientIv = nodeCrypto.randomBytes(12);
  const plain = Buffer.from(JSON.stringify(payload));
  const recipientCt = Buffer.from(await subtle.encrypt({ name: "AES-GCM", iv: recipientIv }, recipientKey, plain));
  const ephPubJwk = await subtle.exportKey("jwk", eph.publicKey);

  const botPub = await importDhPub(botPriv.identityDHPublic);
  const myPriv = await importDhPriv(botPriv.identityDHPrivate);
  const senderBits = await subtle.deriveBits({ name: "ECDH", public: botPub }, myPriv, 256);
  const senderKey = await aesFromBits(senderBits, "encrypt");
  const senderIv = nodeCrypto.randomBytes(12);
  const senderCt = Buffer.from(await subtle.encrypt({ name: "AES-GCM", iv: senderIv }, senderKey, plain));

  return {
    v: 2,
    alg: "ECDH-P256-AESGCM-DUAL",
    recipient: { senderEphemeralPublic: ephPubJwk, iv: b64(recipientIv), ciphertext: b64(recipientCt) },
    sender: { senderIdentityPublic: botPriv.identityDHPublic, iv: b64(senderIv), ciphertext: b64(senderCt) },
  };
}

module.exports = { PROTOCOL, generateBotDevice, publicBundleOf, sealPrivateDevice, openPrivateDevice, decryptForBot, encryptFromBot };
