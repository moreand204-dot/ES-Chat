/* ES Chat Pro — تخزين الوسائط على جهاز المستخدم (IndexedDB) + تشفير وتقطيع الوسائط للترحيل عبر Firebase.
 * Firebase هنا مجرد وسيط مؤقت: الملف بيتشفّر على جهاز المرسل، المستلم بينزّله ويحفظه على جهازه، وبعدها النسخة المؤقتة بتتمسح من السيرفر. */
export const MEDIA_MAX = 15 * 1024 * 1024;   // أقصى حجم ملف في المحادثات الخاصة
export const CHUNK_RAW = 480 * 1024;         // حجم الجزء قبل base64 (يطلع ~640KB وهو أقل من حد مستند Firestore)
export const fmtBytes = n => { n = +n || 0; const L = "\u200E"; /* LRM: عشان الرقم والوحدة يتعرضوا صح جوه النص العربي */ if (n < 1024) return L + n + " B"; if (n < 1048576) return L + Math.max(1, Math.round(n / 1024)) + " KB"; if (n < 1073741824) return L + (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + " MB"; return L + (n / 1073741824).toFixed(2) + " GB"; };
export function netType() {
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!c) return "wifi";
  if (c.saveData) return "mobile";
  if (c.type) return c.type === "cellular" ? "mobile" : "wifi";
  return ["slow-2g", "2g", "3g"].includes(c.effectiveType) ? "mobile" : "wifi";
}
/* ---------- base64 ---------- */
export function u8ToB64(u8) { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
export const b64ToU8 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
export function splitChunks(u8) { const out = []; for (let i = 0; i < u8.length; i += CHUNK_RAW) out.push(u8ToB64(u8.subarray(i, i + CHUNK_RAW))); return out.length ? out : [""]; }
export function joinChunks(parts) { const arr = parts.map(b64ToU8), len = arr.reduce((n, a) => n + a.length, 0), out = new Uint8Array(len); let o = 0; for (const a of arr) { out.set(a, o); o += a.length; } return out; }
/* ---------- AES-GCM: مفتاح عشوائي لكل ملف، بيتبعت جوه الرسالة المشفّرة ---------- */
export async function sealBytes(u8) {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, u8));
  return { ct, k: u8ToB64(new Uint8Array(await crypto.subtle.exportKey("raw", key))), iv: u8ToB64(iv) };
}
export async function openBytes(ct, k, iv) {
  const key = await crypto.subtle.importKey("raw", b64ToU8(k), { name: "AES-GCM" }, false, ["decrypt"]);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToU8(iv) }, key, ct));
}
/* ---------- IndexedDB: الوسائط على الجهاز ---------- */
const DB = "es_media", ST = "files"; let _db = null;
function openDB() { return _db || (_db = new Promise((res, rej) => { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => { r.result.createObjectStore(ST, { keyPath: "id" }); }; r.onsuccess = () => res(r.result); r.onerror = () => { _db = null; rej(r.error); }; })); }
async function tx(mode, fn) { const db = await openDB(); return new Promise((res, rej) => { const t = db.transaction(ST, mode); let out; const rq = fn(t.objectStore(ST)); if (rq) rq.onsuccess = () => { out = rq.result; }; t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); }
export const mPut = rec => tx("readwrite", s => s.put(rec));
export const mGet = id => tx("readonly", s => s.get(id));
export const mDel = id => tx("readwrite", s => s.delete(id));
export async function mList() {
  const db = await openDB();
  return new Promise((res, rej) => { const out = [], r = db.transaction(ST).objectStore(ST).openCursor(); r.onsuccess = () => { const c = r.result; if (!c) return res(out); const v = c.value; out.push({ id: v.id, chat: v.chat, kind: v.kind, name: v.name, type: v.type, bytes: v.bytes || (v.blob && v.blob.size) || 0, at: v.at || 0 }); c.continue(); }; r.onerror = () => rej(r.error); });
}
export async function mClear(pred) { const l = (await mList()).filter(pred || (() => true)); for (const x of l) await mDel(x.id); return l.length; }
export async function askPersist() { try { return !!(navigator.storage && navigator.storage.persist && await navigator.storage.persist()); } catch { return false; } }
export async function isPersisted() { try { return !!(navigator.storage && navigator.storage.persisted && await navigator.storage.persisted()); } catch { return false; } }
export async function deviceQuota() { try { const e = await navigator.storage.estimate(); return { usage: e.usage || 0, quota: e.quota || 0 }; } catch { return null; } }
