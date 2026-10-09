/* ES Chat Pro — E2EE foundation, phase 1
 * WebCrypto only: private CryptoKeys stay in IndexedDB; only public JWKs leave the device.
 * This is key provisioning, not the Signal Protocol message layer yet.
 */
const DB_NAME = "es-chat-e2ee";
const STORE = "devices";
const openDB = () => new Promise((resolve, reject) => {
  const r = indexedDB.open(DB_NAME, 1);
  r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "uid" });
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
const idbGet = async uid => { const db = await openDB(); return new Promise((res, rej) => { const r=db.transaction(STORE,"readonly").objectStore(STORE).get(uid); r.onsuccess=()=>res(r.result||null); r.onerror=()=>rej(r.error); }); };
const idbPut = async v => { const db = await openDB(); return new Promise((res, rej) => { const r=db.transaction(STORE,"readwrite").objectStore(STORE).put(v); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error); }); };
const pair = (algorithm, extractable = false) => crypto.subtle.generateKey(algorithm, extractable, ["deriveKey", "deriveBits"]);
const publicJwk = k => crypto.subtle.exportKey("jwk", k);
const signBytes = async (key, data) => crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data);
const enc = new TextEncoder();
// ملاحظة أمنية: String.fromCharCode(...bytes) أو spread بيكرشوا بـ "Maximum call stack
// size exceeded" لأي مصفوفة كبيرة (بيبدأ يفشل من ~60-150 ألف بايت حسب المتصفح)، ده كان بيكسر
// فك/تشفير أي رسالة خاصة ciphertext قريبة من الحد المسموح به في firestore.rules (600000 حرف).
// الحل: نبني الـ base64 على دفعات صغيرة (chunks) بدل ما نعدي كل البايتات دفعة واحدة كـ arguments.
const b64 = a => {
  const bytes = new Uint8Array(a);
  let s = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(s);
};
const uid8 = () => crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);

export async function initE2EEDevice(uid, publishPublic) {
  if (!uid || !crypto.subtle || !indexedDB) throw new Error("WebCrypto/IndexedDB غير مدعوم");
  let d = await idbGet(uid);
  if (!d) {
    const identityDH = await pair({ name: "ECDH", namedCurve: "P-256" });
    const identitySign = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const signed = await pair({ name: "ECDH", namedCurve: "P-256" });
    const signedPub = await publicJwk(signed.publicKey);
    const sig = await signBytes(identitySign.privateKey, enc.encode(JSON.stringify(signedPub)));
    const preKeys = [];
    for (let i = 0; i < 100; i++) {
      const k = await pair({ name: "ECDH", namedCurve: "P-256" });
      preKeys.push({ id: i + 1, privateKey: k.privateKey, publicKey: k.publicKey });
    }
    d = { uid, deviceId: uid8(), identityDHPrivate: identityDH.privateKey, identitySignPrivate: identitySign.privateKey, signedPreKeyPrivate: signed.privateKey, preKeys, createdAt: Date.now(), usedPreKeys: [] };
    await idbPut(d);
    d.identityDHPublic = await publicJwk(identityDH.publicKey);
    d.identitySignPublic = await publicJwk(identitySign.publicKey);
    d.signedPreKeyPublic = signedPub;
    d.signedPreKeySignature = b64(sig);
    d.preKeysPublic = await Promise.all(preKeys.map(async x => ({ id: x.id, publicKey: await publicJwk(x.publicKey) })));
    await idbPut(d);
    await publishPublic({ deviceId: d.deviceId, identityDHPublic: d.identityDHPublic, identitySignPublic: d.identitySignPublic, signedPreKeyPublic: d.signedPreKeyPublic, signedPreKeySignature: d.signedPreKeySignature, preKeysPublic: d.preKeysPublic, protocol: "e2ee-foundation-p256-v1" });
    return { ready: true, created: true, deviceId: d.deviceId };
  }
  const pub = { deviceId: d.deviceId, identityDHPublic: d.identityDHPublic, identitySignPublic: d.identitySignPublic, signedPreKeyPublic: d.signedPreKeyPublic, signedPreKeySignature: d.signedPreKeySignature, preKeysPublic: d.preKeysPublic, protocol: "e2ee-foundation-p256-v1" };
  if (!pub.identityDHPublic || !pub.preKeysPublic) return { ready: false, reason: "المفتاح المحلي قديم ويحتاج إعادة إنشاء" };
  await publishPublic(pub);
  return { ready: true, created: false, deviceId: d.deviceId };
}

const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const importDhPublic = jwk => crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, []);
const aesKey = bits => crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);

/* المرحلة الثانية الأساسية: رسالة مستقلة بمفتاح مؤقت للمستلم.
 * هذا يحمي النص من Firebase، لكنه ليس Double Ratchet كاملًا بعد. */
export async function encryptPrivatePayload(uid, recipientBundle, payload) {
  const d = await idbGet(uid);
  if (!d || !recipientBundle || !recipientBundle.identityDHPublic) throw new Error("مفتاح الطرف الآخر غير متاح");
  const receiver = await importDhPublic(recipientBundle.identityDHPublic);
  const eph = await pair({ name: "ECDH", namedCurve: "P-256" });
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: receiver }, eph.privateKey, 256);
  const recipientKey = await aesKey(bits), recipientIv = crypto.getRandomValues(new Uint8Array(12));
  const plain = enc.encode(JSON.stringify(payload));
  const recipientCiphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: recipientIv }, recipientKey, plain);
  const selfPublic = await importDhPublic(d.identityDHPublic);
  const selfBits = await crypto.subtle.deriveBits({ name: "ECDH", public: selfPublic }, d.identityDHPrivate, 256);
  const senderKey = await aesKey(selfBits), senderIv = crypto.getRandomValues(new Uint8Array(12));
  const senderCiphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: senderIv }, senderKey, plain);
  return { v: 2, alg: "ECDH-P256-AESGCM-DUAL", recipient: { senderEphemeralPublic: await publicJwk(eph.publicKey), iv: b64(recipientIv), ciphertext: b64(recipientCiphertext) }, sender: { senderIdentityPublic: d.identityDHPublic, iv: b64(senderIv), ciphertext: b64(senderCiphertext) } };
}

export async function decryptPrivatePayload(uid, cipher) {
  if (!cipher || cipher.alg === "ECDH-P256-AESGCM") return decryptLegacyPrivatePayload(uid, cipher);
  if (cipher.alg !== "ECDH-P256-AESGCM-DUAL") return null;
  const d = await idbGet(uid); if (!d || !d.identityDHPrivate) return null;
  let part = cipher.recipient;
  try { const sender = await importDhPublic(part.senderEphemeralPublic); const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: sender }, d.identityDHPrivate, 256); const key = await aesKey(bits); const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(part.iv) }, key, fromB64(part.ciphertext)); return JSON.parse(new TextDecoder().decode(plain)); } catch {}
  part = cipher.sender;
  const sender = await importDhPublic(part.senderIdentityPublic);
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: sender }, d.identityDHPrivate, 256);
  const key = await aesKey(bits);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(part.iv) }, key, fromB64(part.ciphertext));
  return JSON.parse(new TextDecoder().decode(plain));
}

async function decryptLegacyPrivatePayload(uid, cipher) {
  if (!cipher || cipher.alg !== "ECDH-P256-AESGCM") return null;
  const d = await idbGet(uid); if (!d || !d.identityDHPrivate) return null;
  const sender = await importDhPublic(cipher.senderEphemeralPublic); const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: sender }, d.identityDHPrivate, 256); const key = await aesKey(bits);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(cipher.iv) }, key, fromB64(cipher.ciphertext)); return JSON.parse(new TextDecoder().decode(plain));
}

export async function encryptSharedPayload(uid, recipientBundle, payload) {
  const d = await idbGet(uid);
  if (!d || !d.identityDHPrivate || !recipientBundle?.identityDHPublic) throw new Error("مفتاح التفاعل غير متاح");
  const receiver = await importDhPublic(recipientBundle.identityDHPublic);
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: receiver }, d.identityDHPrivate, 256);
  const key = await aesKey(bits), iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(payload)));
  return { v: 1, alg: "ECDH-P256-AESGCM-SHARED", senderIdentityPublic: d.identityDHPublic, iv: b64(iv), ciphertext: b64(ciphertext) };
}

export async function decryptSharedPayload(uid, cipher) {
  if (!cipher || cipher.alg !== "ECDH-P256-AESGCM-SHARED") return null;
  const d = await idbGet(uid); if (!d?.identityDHPrivate) return null;
  const sender = await importDhPublic(cipher.senderIdentityPublic);
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: sender }, d.identityDHPrivate, 256);
  const key = await aesKey(bits);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(cipher.iv) }, key, fromB64(cipher.ciphertext));
  return JSON.parse(new TextDecoder().decode(plain));
}
