import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, enableNetwork, disableNetwork, waitForPendingWrites, doc, getDoc, setDoc, updateDoc, deleteDoc, collection, query, orderBy, limit, limitToLast, endBefore,
  onSnapshot, addDoc, where, serverTimestamp, increment, writeBatch, getDocs, deleteField, arrayUnion, arrayRemove }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import * as CFG from "./firebase-config.js";
import { initE2EEDevice, encryptPrivatePayload, decryptPrivatePayload, encryptSharedPayload, decryptSharedPayload } from "./e2ee.js";
import { MEDIA_MAX, fmtBytes, netType, splitChunks, joinChunks, sealBytes, openBytes, mPut, mGet, mDel, mList, askPersist, isPersisted, deviceQuota } from "./media.js";
const { firebaseConfig, OWNER_EMAIL } = CFG;
const VAPID_KEY = CFG.VAPID_KEY || "";
window.__esBooted = true; // مراقب الإقلاع في index.html بيعتمد عليها

/* ---------------- helpers ---------------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const S = { user: null, me: null, e2ee: { ready: false, error: "" }, users: new Map(), chats: [], chat: null, found: null, site: {}, groups: [], gseen: new Map(), seen: new Map(), unsub: {}, view: "boot", filter: "all", prefs: { pins: [], arch: [], hiddenChats: [], mute: [], block: [], labels: [], cl: {}, quick: [], stars: [] }, contacts: {}, contactNameByUid: new Map() };
let CALL = null, callSeen = new Set();
const STUN_ONLY = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302", "stun:stun.cloudflare.com:3478"] }, ...(Array.isArray(CFG.ICE_SERVERS) ? CFG.ICE_SERVERS : [])];
let _ice = null, _iceAt = 0;
// بيجيب بيانات TURN مؤقتة من /api/turn (لازم تتضبط على Vercel). من غيرها المكالمات على 4G بتفشل.
async function getRtcConfig() {
  if (_ice && Date.now() - _iceAt < 20 * 60 * 1000) return _ice;
  let extra = [];
  try {
    const t = await auth.currentUser.getIdToken();
    const r = await fetch("/api/turn", { headers: { Authorization: "Bearer " + t } });
    if (r.ok) { const j = await r.json(); extra = Array.isArray(j.iceServers) ? j.iceServers : []; }
  } catch {}
  const cfg = { iceServers: [...STUN_ONLY, ...extra], iceCandidatePoolSize: 2 };
  if (extra.length) { _ice = cfg; _iceAt = Date.now(); }
  return cfg;
}
function stopCallUI() { if (!CALL) return; CALL.stream?.getTracks().forEach(t => t.stop()); CALL.pc?.close(); CALL.unsub?.forEach(f => f && f()); CALL = null; closeModal(); }
async function finishCall(state = "ended") { const c = CALL; if (!c) return; try { await updateDoc(doc(db, "calls", c.id), { state, endedAt: serverTimestamp() }); } catch {} stopCallUI(); }
function callView(kind, name) { const sh = openModal(`<div class="call-screen"><div class="menu-h">${kind === "video" ? "مكالمة فيديو" : "مكالمة صوتية"}</div><div class="call-peer">${esc(name || "مستخدم")}</div><video id="callRemote" class="call-remote" autoplay playsinline></video><video id="callLocal" class="call-local ${kind === "video" ? "" : "hidden"}" autoplay muted playsinline></video><div class="call-status" id="callStatus">جاري الاتصال...</div><div class="call-actions"><button class="btn-ghost" id="callMute">كتم الميكروفون</button><button class="btn-ghost" id="callCam" ${kind === "video" ? "" : "disabled"}>الكاميرا</button><button class="btn-danger" id="callEnd">إنهاء</button></div></div>`); sh.querySelector("#callEnd").onclick = () => finishCall(); sh.querySelector("#callMute").onclick = () => { const t = CALL?.stream?.getAudioTracks()[0]; if (t) { t.enabled = !t.enabled; sh.querySelector("#callMute").textContent = t.enabled ? "كتم الميكروفون" : "تشغيل الميكروفون"; } }; const cam = sh.querySelector("#callCam"); cam.onclick = () => { const t = CALL?.stream?.getVideoTracks()[0]; if (t) { t.enabled = !t.enabled; cam.textContent = t.enabled ? "إيقاف الكاميرا" : "تشغيل الكاميرا"; } }; return sh; }
function wirePeer(pc, ref, remote, stream) {
  pc.ontrack = e => { remote.srcObject = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]); remote.play && remote.play().catch(() => {}); };
  pc.onicecandidate = e => { if (!e.candidate || !CALL) return; const c = { from: S.user.uid, candidate: e.candidate.toJSON() }; if (CALL.ready) addDoc(collection(db, "calls", ref.id, "candidates"), c).catch(() => {}); else CALL.out.push(c); };
  pc.onconnectionstatechange = () => { const st = document.querySelector("#callStatus"); const m = { connected: "متصل", connecting: "جاري الاتصال...", new: "جاري الاتصال...", disconnected: "الاتصال ضعيف...", failed: "فشل الاتصال", closed: "انتهت" }; if (st) st.textContent = m[pc.connectionState] || pc.connectionState; if (pc.connectionState === "failed") { toast(_ice ? "فشل الاتصال بالمكالمة. جرّب تاني" : "المكالمة محتاجة سيرفر TURN (مش مضبوط على Vercel لسه)"); finishCall(); } };
  stream.getTracks().forEach(t => pc.addTrack(t, stream));
}
async function flushCandidates() { if (!CALL) return; const q = CALL.q.splice(0); for (const c of q) await CALL.pc.addIceCandidate(c).catch(() => {}); }
function watchCandidates(ref, pc, own) {
  const seen = new Set();
  return onSnapshot(collection(db, "calls", ref.id, "candidates"), snap => snap.docChanges().forEach(ch => {
    const d = ch.doc.data(); if (ch.type !== "added" || d.from === own || seen.has(ch.doc.id)) return; seen.add(ch.doc.id);
    let c; try { c = new RTCIceCandidate(d.candidate); } catch { return; }
    if (pc.remoteDescription) pc.addIceCandidate(c).catch(() => {}); else if (CALL) CALL.q.push(c);
  }));
}
async function startCall(kind) {
  if (!S.chat?.peer || CALL) return;
  const peer = S.chat.peer, u = S.users.get(peer) || {}; let stream = null;
  try {
    if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) return toast("المتصفح مش بيدعم المكالمات");
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: kind === "video" ? { facingMode: "user" } : false });
    const pc = new RTCPeerConnection(await getRtcConfig()), ref = doc(collection(db, "calls"));
    const sh = callView(kind, u.name); const remote = sh.querySelector("#callRemote"), local = sh.querySelector("#callLocal"); local.srcObject = stream;
    CALL = { id: ref.id, role: "caller", pc, stream, unsub: [], kind, ready: false, out: [], q: [] };
    wirePeer(pc, ref, remote, stream);               // المسارات الأول وبعدها الـ offer (كان بالعكس وده سبب إن المكالمة من غير صوت/فيديو)
    await pc.setLocalDescription(await pc.createOffer());
    await setDoc(ref, { caller: S.user.uid, callee: peer, kind, offer: pc.localDescription.toJSON(), state: "ringing", createdAt: serverTimestamp(), expiresAt: new Date(Date.now() + 120000) });
    CALL.ready = true; for (const c of CALL.out.splice(0)) addDoc(collection(db, "calls", ref.id, "candidates"), c).catch(() => {});
    CALL.unsub.push(watchCandidates(ref, pc, S.user.uid));
    CALL.unsub.push(onSnapshot(ref, async s => { const d = s.data(); if (!d || d.state === "ended" || d.state === "rejected") { if (d && d.state === "rejected") toast("اترفضت المكالمة"); return stopCallUI(); } if (d.answer && !pc.currentRemoteDescription) { await pc.setRemoteDescription(new RTCSessionDescription(d.answer)).catch(console.error); flushCandidates(); } }));
    setTimeout(() => { if (CALL && CALL.id === ref.id && CALL.pc.connectionState !== "connected" && CALL.pc.connectionState !== "connecting") { toast("محدش رد"); finishCall("ended"); } }, 60000);
  } catch (e) {
    console.error(e); if (CALL) stopCallUI(); else stream && stream.getTracks().forEach(t => t.stop());
    toast(e.name === "NotAllowedError" ? "اسمح للميكروفون والكاميرا من إعدادات المتصفح" : e.name === "NotFoundError" ? "مفيش ميكروفون/كاميرا متاحة" : "تعذّر بدء المكالمة");
  }
}
async function acceptCall(id, data) {
  if (CALL) return; const u = S.users.get(data.caller) || {}; let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: data.kind === "video" ? { facingMode: "user" } : false });
    const pc = new RTCPeerConnection(await getRtcConfig()), ref = doc(db, "calls", id);
    const sh = callView(data.kind, u.name); const remote = sh.querySelector("#callRemote"), local = sh.querySelector("#callLocal"); local.srcObject = stream;
    CALL = { id, role: "callee", pc, stream, unsub: [], kind: data.kind, ready: true, out: [], q: [] };
    wirePeer(pc, ref, remote, stream);               // المسارات قبل الـ answer
    await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
    await pc.setLocalDescription(await pc.createAnswer());
    CALL.unsub.push(watchCandidates(ref, pc, S.user.uid)); flushCandidates();
    CALL.unsub.push(onSnapshot(ref, s => { if (["ended", "rejected"].includes(s.data()?.state)) stopCallUI(); }));
    await updateDoc(ref, { answer: pc.localDescription.toJSON(), state: "active" });
  } catch (e) {
    console.error(e); if (CALL) stopCallUI(); else stream && stream.getTracks().forEach(t => t.stop());
    toast(e.name === "NotAllowedError" ? "اسمح للميكروفون والكاميرا من إعدادات المتصفح" : "تعذّر قبول المكالمة");
  }
}
async function showIncomingCall(id, data) { if (callSeen.has(id) || CALL) return; callSeen.add(id); if (LS.get("quiet_unknown", false)) { try { const a = await getDoc(doc(db,"chats",S.user.uid+"_"+data.caller)); const b = a.exists() ? a : await getDoc(doc(db,"chats",data.caller+"_"+S.user.uid)); if (!a.exists() && !b.exists()) { await updateDoc(doc(db,"calls",id),{state:"rejected",endedAt:serverTimestamp()}); toast("تم رفض مكالمة من حساب غير معروف"); return; } } catch (e) { console.warn("unknown caller check",e); await updateDoc(doc(db,"calls",id),{state:"rejected",endedAt:serverTimestamp()}).catch(()=>{}); toast("تعذّر التحقق من المتصل؛ تم رفض المكالمة احتياطيًا"); return; } } await ensureUsers([data.caller]); const u = S.users.get(data.caller) || {}; const sh = openModal(`<div class="menu"><div class="menu-h">مكالمة واردة</div><p class="sub">${esc(contactName(data.caller, u.name || "مستخدم"))} يريد بدء مكالمة ${data.kind === "video" ? "فيديو" : "صوتية"}.</p><div class="actions"><button class="btn-primary" id="acceptCall">قبول</button><button class="btn-danger" id="rejectCall">رفض</button></div></div>`); sh.querySelector("#acceptCall").onclick = () => { closeModal(); acceptCall(id, data); }; sh.querySelector("#rejectCall").onclick = async () => { await updateDoc(doc(db, "calls", id), { state: "rejected", endedAt: serverTimestamp() }).catch(() => {}); closeModal(); }; }
function watchIncomingCalls() { if (S.unsub.incomingCalls) S.unsub.incomingCalls(); S.unsub.incomingCalls = onSnapshot(query(collection(db, "calls"), where("callee", "==", S.user.uid), limit(8)), snap => snap.docs.forEach(d => { const x = d.data(); if (x.state === "ringing" && (!x.expiresAt || toDate(x.expiresAt) > new Date())) showIncomingCall(d.id, x); }), () => {}); }
const DEFAULT_PREFS = () => ({ pins: [], arch: [], hiddenChats: [], mute: [], block: [], labels: [], cl: {}, quick: [], stars: [] });
try { const u = new URLSearchParams(location.search).get("u"); if (u) sessionStorage.es_u = u; const gp = new URLSearchParams(location.search).get("g"); if (gp) sessionStorage.es_g = gp; const cp = new URLSearchParams(location.search).get("c"); if (cp) sessionStorage.es_c = cp; const kp = new URLSearchParams(location.search).get("k"); if (kp && gp) sessionStorage.es_k = gp + "." + kp; const ap = new URLSearchParams(location.search).get("ai"); if (ap) sessionStorage.es_ai = ap; } catch {}
const LS = {
  get: (k, d) => { try { const v = localStorage.getItem("es_" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem("es_" + k, JSON.stringify(v)); } catch {} },
};
// Language foundation: apply the selected locale consistently to document semantics and layout.
function applyAppLanguage(lang) {
  const selected = lang === "en" ? "en" : "ar";
  try {
    document.documentElement.lang = selected;
    document.documentElement.dir = selected === "ar" ? "rtl" : "ltr";
    document.documentElement.dataset.language = selected;
    LS.set("lang", selected);
  } catch (e) { console.warn("language preference", e); }
  return selected;
}
applyAppLanguage(LS.get("lang", "ar"));
const PREV = new Map(), PVBUSY = new Set();
const previewOf = p => !p ? "" : p.poll ? "📊 " + p.poll.q : p.media ? (p.media.kind === "voice" ? "🎤 رسالة صوتية" : p.media.kind === "img" ? "📷 صورة" : "📎 ملف") : p.img ? "📷 صورة" : p.file ? (String(p.file.type || "").startsWith("audio/") ? "🎤 رسالة صوتية" : "📎 ملف") : p.sticker ? ((p.sticker.emoji || "🎨") + " ملصق") : p.loc ? "📍 موقع" : (p.text || "");
const lastMsOf = c => (toDate(c.lastAt) || { getTime: () => 0 }).getTime();
function dmPrev(c) {
  const t = String(c.lastText || ""); if (!t.startsWith("🔒")) return t;
  const e = PREV.get(c.id), ms = lastMsOf(c);
  if (e && (e.ms === ms || e.ms === -1)) return e.t;
  return ms ? "🔒 رسالة" : "🔒 جاري التحميل…";
}
async function loadDmPreview(c, ms) {
  const k = c.id + "|" + ms; if (PVBUSY.has(k)) return; PVBUSY.add(k);
  try {
    const s = await getDocs(query(collection(db, "chats", c.id, "messages"), orderBy("at", "desc"), limit(1)));
    const d = s.docs[0]; if (!d) return; const raw = d.data(); let t = "";
    if (raw.deleted) t = "🚫 الرسالة اتحذفت";
    else if (raw.cipher) { try { t = previewOf(await decryptPrivatePayload(S.user.uid, raw.cipher)); } catch { t = "🔒 رسالة"; } }
    else t = previewOf(raw);
    PREV.set(c.id, { ms, t: (t || "🔒 رسالة").slice(0, 80) });
    const l = $("#list"); if (l) l._h = ""; renderList();
  } catch (e) { PREV.set(c.id, { ms, t: "🔒 رسالة" }); }
  finally { PVBUSY.delete(k); }
}
function ensureDmPreviews(chats) {
  let n = 0;
  for (const c of chats) {
    if (c._t !== "dm" || !String(c.lastText || "").startsWith("🔒")) continue;
    const ms = lastMsOf(c); if (!ms) continue; if (++n > 25) break;
    const e = PREV.get(c.id); if (e && e.ms === ms) continue;
    loadDmPreview(c, ms);
  }
}

const dayKey = (d = new Date()) => "d_" + d.toLocaleDateString("en-CA");
const toDate = t => (t && t.toDate ? t.toDate() : null);
const fmtDT = t => { const d = toDate(t); return d ? d.toLocaleString("ar-EG", { dateStyle: "medium", timeStyle: "short" }) : "—"; };
const fmtTime = d => d.toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit", hour12: LS.get("h24", false) ? false : undefined });
const sameDay = (a, b) => a.toDateString() === b.toDateString();
function dayLabel(d) {
  const n = new Date(), y = new Date(Date.now() - 864e5);
  if (sameDay(d, n)) return "اليوم";
  if (sameDay(d, y)) return "أمس";
  return d.toLocaleDateString("ar-EG", { dateStyle: "long" });
}
let toastT;
const IC = {
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6"/>',
  send: '<path d="M22 2 15 22l-4-9-9-4z" fill="currentColor"/><path d="M22 2 11 13"/>',
  attach: '<path d="m21.4 11.6-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.5a1.8 1.8 0 0 1-2.6-2.6l7.9-7.8"/>',
  smile: '<circle cx="12" cy="12" r="9.5"/><path d="M8 14.2a4.6 4.6 0 0 0 8 0"/><path d="M9 9.5h.01M15 9.5h.01" stroke-width="2.8"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 1.8h6a2 2 0 0 0 2-1.8L18 7M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7"/>',
  play: '<path d="M8 5.2v13.6a.8.8 0 0 0 1.2.7l11-6.8a.8.8 0 0 0 0-1.4l-11-6.8A.8.8 0 0 0 8 5.2z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="3.5"/><circle cx="9" cy="10" r="1.8"/><path d="m21 16-5-5L6 20"/>',
  camera: '<path d="M3 8.5A2.5 2.5 0 0 1 5.5 6H8l1.4-2h5.2L16 6h2.5A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/><circle cx="12" cy="13" r="3.6"/>',
  file: '<path d="M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8z"/><path d="M14 3v4a1 1 0 0 0 1 1h4M9 13h6M9 16.5h4"/>',
  pin: '<path d="M12 21s7-6.2 7-11.5a7 7 0 0 0-14 0C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.6"/>',
  poll: '<rect x="4" y="11" width="3.6" height="9" rx="1.2"/><rect x="10.2" y="4" width="3.6" height="16" rx="1.2"/><rect x="16.4" y="8" width="3.6" height="12" rx="1.2"/>',
  sticker: '<path d="M20 12.5V7a3.5 3.5 0 0 0-3.5-3.5h-9A3.5 3.5 0 0 0 4 7v10a3.5 3.5 0 0 0 3.5 3.5H13a7.5 7.5 0 0 0 7-8z"/><path d="M20 12.5h-3.5A3.5 3.5 0 0 0 13 16v4.5"/><path d="M9 9.5h.01M14.5 9.5h.01" stroke-width="2.8"/>',
  phone: '<path d="M5 4h3.2l1.6 4-2 1.3a11 11 0 0 0 5.9 5.9l1.3-2 4 1.6V18a2 2 0 0 1-2.2 2A15.5 15.5 0 0 1 3 6.2 2 2 0 0 1 5 4z"/>',
  video: '<rect x="3" y="6.5" width="13" height="11" rx="3"/><path d="m16 10.5 4.2-2.4a.8.8 0 0 1 1.2.7v6.4a.8.8 0 0 1-1.2.7L16 13.5"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  star: '<path d="m12 3.3 2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.6l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/>',
  pushpin: '<path d="M9 3h6l-1 6 3 3v2H7v-2l3-3zM12 14v7"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.8h.01"/>',
  reply: '<path d="M9.5 6 4 11.5 9.5 17"/><path d="M4 11.5h9a6.5 6.5 0 0 1 6.5 6.5v1"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5V6.5A2.5 2.5 0 0 0 13 4H6.5A2.5 2.5 0 0 0 4 6.5V13a2.5 2.5 0 0 0 2.5 2.5h2"/>',
  edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  forward: '<path d="m14.5 6 5.5 5.5-5.5 5.5"/><path d="M20 11.5h-9A6.5 6.5 0 0 0 4.5 18v1"/>',
  eyeoff: '<path d="M3 3l18 18"/><path d="M10.6 6.2A9.6 9.6 0 0 1 12 6c5 0 8.5 4 9.5 6a12 12 0 0 1-2.6 3.3M6.3 7.5A12.5 12.5 0 0 0 2.5 12c1 2 4.5 6 9.5 6a9.5 9.5 0 0 0 3.3-.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4.5h11l-2 4 2 4H5"/>',
  user: '<circle cx="12" cy="8.5" r="3.7"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
  users: '<circle cx="9" cy="8.5" r="3.4"/><path d="M2.8 19.5a6.2 6.2 0 0 1 12.4 0"/><path d="M16 5.4a3.3 3.3 0 0 1 0 6.2M18 14a6 6 0 0 1 3.2 5.5"/>',
  archive: '<rect x="3.5" y="4.5" width="17" height="4.5" rx="1.5"/><path d="M5 9v8.5A2 2 0 0 0 7 19.5h10a2 2 0 0 0 2-2V9M10 13h4"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 21a2.2 2.2 0 0 0 4 0"/>',
  bellOff: '<path d="M3 3l18 18"/><path d="M8.5 5.3A6 6 0 0 1 18 11v4M6 11v5.5l-1.5 2H16"/><path d="M10 21a2.2 2.2 0 0 0 4 0"/>',
  folder: '<path d="M3.5 7a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V17.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  timer: '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 9.5v4l2.5 1.5M9.5 3h5"/>',
  block: '<circle cx="12" cy="12" r="9"/><path d="m5.7 5.7 12.6 12.6"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/>',
  share: '<circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="6" r="2.6"/><circle cx="18" cy="18" r="2.6"/><path d="m8.3 10.8 7.4-3.6M8.3 13.2l7.4 3.6"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  megaphone: '<path d="M4 10v4h3l8 4.5v-13L7 10z"/><path d="M18.5 9.5a4 4 0 0 1 0 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chev: '<path d="m14.5 6-6 6 6 6"/>',
  shield: '<path d="M12 3.5 5 6v5.5c0 4.4 2.9 7.6 7 9 4.1-1.4 7-4.6 7-9V6z"/><path d="m9 12 2.2 2.2L15.2 10"/>',
  device: '<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 18h2"/>',
  palette: '<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.4 0 2-.9 1.6-2-.4-1.2.3-2.2 1.6-2.2H17a3.5 3.5 0 0 0 3.5-3.5C20.5 7 16.8 3.5 12 3.5z"/><path d="M8 11h.01M11 7.8h.01M15 8.5h.01"/>',
  database: '<ellipse cx="12" cy="6" rx="7.5" ry="3"/><path d="M4.5 6v12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8.5-8.5M16 7l2.5 2.5M14 9l2 2"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.6 3.8 5.6 3.8 9s-1.2 6.4-3.8 9c-2.6-2.6-3.8-5.6-3.8-9S9.4 5.6 12 3z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  bot: '<rect x="4.5" y="8" width="15" height="11" rx="3"/><path d="M12 8V4.5M9 13h.01M15 13h.01M9.5 16.5h5"/>',
  bolt: '<path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/>',
  heart: '<path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.2 4.3 4.3 0 0 1 19.5 10C19.5 15.4 12 20 12 20z"/>',
  logout: '<path d="M9.5 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h3"/><path d="M15 8l4 4-4 4M19 12H9.5"/>',
  download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  story: '<circle cx="12" cy="12" r="8.5" stroke-dasharray="3.2 2.6"/><circle cx="12" cy="12" r="3.5"/>',
  hash: '<path d="M9.5 4 7.5 20M16.5 4l-2 16M4.5 9h15.5M4 15h15.5"/>',
  list: '<path d="M8 7h10M8 12h10M8 17h10M4.5 7h.01M4.5 12h.01M4.5 17h.01"/>',
  chat: '<path d="M4.5 6.5A2.5 2.5 0 0 1 7 4h10a2.5 2.5 0 0 1 2.5 2.5v7a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 4v-4A2.5 2.5 0 0 1 4.5 13.5z"/>',
  volume: '<path d="M5 9.5h3l4-3.5v12l-4-3.5H5z"/><path d="M16 9.5a3.5 3.5 0 0 1 0 5"/>',
  warning: '<path d="M12 4 3 19.5h18z"/><path d="M12 10v4.5M12 17.2h.01"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.3-5.4M19.5 4.5v4h-4"/>',
  battery: '<rect x="3" y="8" width="16" height="9" rx="2.2"/><path d="M21.5 11v3M7 12.5h6"/>',
  text: '<path d="M4 18 9 6l5 12M5.8 14h6.4M15.5 18l2.5-6 2.5 6M16.4 16.2h3.2"/>',
  more: '<circle cx="12" cy="5.5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="18.5" r="1.5"/>',
  pie: '<path d="M12 3.5v8.5h8.5A8.5 8.5 0 1 1 12 3.5z"/><path d="M15 3.8A8.5 8.5 0 0 1 20.2 9H15z"/>',
  signal: '<path d="M5 19v-3M10 19v-6M15 19V9M20 19V5"/>',
  wifi: '<path d="M3 9.5a13 13 0 0 1 18 0M6 13a8.5 8.5 0 0 1 12 0M9.2 16.4a4 4 0 0 1 5.6 0"/><path d="M12 19.5h.01"/>'
};
const ic = (n, s = 22, cls = "") => `<svg class="ico ${cls}" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${IC[n] || ""}</svg>`;
document.querySelectorAll("[data-ic]").forEach(el => { el.innerHTML = ic(el.dataset.ic, +el.dataset.s || 22); });

/* ---- أيقونات الخيارات في القوائم + تحويل رموز المعاينة (📷 📊 🔒 ...) لأيقونات SVG ---- */
const MENU_IC = { info: "info", reply: "reply", copy: "copy", edit: "edit", star: "star", fwd: "forward", hide: "eyeoff", report: "flag", pin: "pushpin", del: "trash", profile: "user", arch: "archive", mute: "bellOff", lbl: "folder", ttl: "timer", blk: "block", topics: "hash", story: "story", stories: "play", group: "users", channel: "megaphone", find: "search", leave: "logout", stLbl: "folder", stQr: "bolt", stStar: "star", mkL: "folder" };
function decorateMenus(root) {
  root.querySelectorAll("button.mrow").forEach(b => {
    if (b.querySelector(".mi")) return;
    const n = MENU_IC[b.dataset.a || b.id]; if (!n) return;
    b.insertAdjacentHTML("afterbegin", `<i class="mi">${ic(n, 18)}</i>`); b.classList.add("hasmi");
  });
}
const PV_IC = { "📊": "poll", "📷": "image", "🎤": "mic", "🎙": "mic", "📎": "attach", "🎨": "sticker", "📍": "pin", "🔒": "lock", "🚫": "block" };
const PV_RE = /^(\s*(?:[^\s:]{1,40}:\s)?)(📊|📷|🎤|🎙\uFE0F?|📎|🎨|📍|🔒|🚫)\s?/u, PV_SKIP = ".msg,textarea,input,.emo-row,.stk-grid,.emo-grid,[contenteditable]";
function pvIcons(root) {
  if (!root || root.nodeType === 8) return;
  const base = root.nodeType === 3 ? root.parentNode : root; if (!base || !base.nodeType) return;
  const todo = [];
  if (root.nodeType === 3) { if (PV_RE.test(root.nodeValue)) todo.push(root); }
  else { const w = document.createTreeWalker(base, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) if (PV_RE.test(n.nodeValue)) todo.push(n); }
  for (const n of todo) {
    if (!n.parentElement || n.parentElement.closest(PV_SKIP)) continue;
    const m = n.nodeValue.match(PV_RE), k = m[2].replace("\uFE0F", ""), s = document.createElement("span");
    s.className = "pvi"; s.innerHTML = ic(PV_IC[k] || "info", 15);
    n.nodeValue = n.nodeValue.slice(m[0].length); if (m[1]) n.parentNode.insertBefore(document.createTextNode(m[1]), n); n.parentNode.insertBefore(s, n);
  }
  if (base.querySelectorAll) base.querySelectorAll("img.emo-img").forEach(im => {
    const k = (im.alt || "").replace("\uFE0F", ""); if (!PV_IC[k] || im.closest(PV_SKIP)) return;
    const prev = im.previousSibling; if (prev && !(prev.nodeType === 3 && !prev.nodeValue.trim())) return;
    const s = document.createElement("span"); s.className = "pvi"; s.innerHTML = ic(PV_IC[k], 15); im.replaceWith(s);
  });
}
{ let pvQ = 0, pend = [];
  new MutationObserver(ms => { for (const m of ms) { if (m.type === "characterData") pend.push(m.target); else m.addedNodes.forEach(n => pend.push(n)); } if (pvQ) return; pvQ = requestAnimationFrame(() => { pvQ = 0; const l = pend; pend = []; l.forEach(pvIcons); }); }).observe(document.body, { childList: true, subtree: true, characterData: true });
  pvIcons(document.body); }

/* ---------------- شكل الإيموجي (النظام / أندرويد-واتساب / آيفون) ---------------- */
const EMO_STYLES = [["system", "النظام"], ["google", "أندرويد / واتساب"], ["apple", "آيفون"]];
const EMO_VER = "15.1.2";
const EMO_RE = /(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F)\p{Emoji_Modifier}?(?:\u200D(?:\p{Emoji_Presentation}|\p{Extended_Pictographic})\uFE0F?\p{Emoji_Modifier}?)*)/gu;
const emoMode = () => { const m = LS.get("emoji", "system"); return m === "google" || m === "apple" ? m : "system"; };
const emoFiles = str => { const cps = Array.from(str, c => c.codePointAt(0).toString(16)), bare = cps.filter(x => x !== "fe0f"), out = [cps.join("-")]; out.push(bare.join("-")); if (bare.length === 1) out.push(bare[0] + "-fe0f"); return [...new Set(out)]; };
const emoSrc = (mode, file) => `https://cdn.jsdelivr.net/npm/emoji-datasource-${mode}@${EMO_VER}/img/${mode}/64/${file}.png`;
function emoImg(str, mode) {
  const im = document.createElement("img"), f = emoFiles(str);
  im.className = "emo-img"; im.alt = str; im.draggable = false; im.decoding = "async";
  im.dataset.f = f.join(","); im.dataset.i = "0"; im.dataset.m = mode; im.src = emoSrc(mode, f[0]);
  return im;
}
document.addEventListener("error", e => {
  const im = e.target; if (!im || !im.classList || !im.classList.contains("emo-img")) return;
  const f = (im.dataset.f || "").split(","), i = +im.dataset.i + 1;
  if (i < f.length) { im.dataset.i = i; im.src = emoSrc(im.dataset.m, f[i]); return; }
  const sp = document.createElement("span"); sp.className = "emo-fb"; sp.textContent = im.alt; im.replaceWith(sp);
}, true);
const EMO_SKIP = "input,textarea,script,style,.emo-fb";
function emoText(n, mode) {
  if (mode === "system" || !n.parentElement || n.parentElement.closest(EMO_SKIP)) return;
  const t = n.nodeValue; EMO_RE.lastIndex = 0; if (!EMO_RE.test(t)) return; EMO_RE.lastIndex = 0;
  const frag = document.createDocumentFragment(); let last = 0, m;
  while ((m = EMO_RE.exec(t))) { if (m.index > last) frag.append(t.slice(last, m.index)); frag.append(emoImg(m[0], mode)); last = m.index + m[0].length; }
  if (last < t.length) frag.append(t.slice(last));
  n.replaceWith(frag);
}
function emoProcess(node, mode) {
  if (!node) return;
  if (node.nodeType === 3) return emoText(node, mode);
  if (node.nodeType !== 1 || (node.closest && node.closest(EMO_SKIP))) return;
  if (mode === "system") {
    node.querySelectorAll("img.emo-img").forEach(im => im.replaceWith(document.createTextNode(im.alt)));
    if (node.matches("img.emo-img")) node.replaceWith(document.createTextNode(node.alt));
    return;
  }
  const w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, { acceptNode: x => x.parentElement && !x.parentElement.closest(EMO_SKIP) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT }), list = [];
  while (w.nextNode()) list.push(w.currentNode);
  list.forEach(x => emoText(x, mode));
  node.querySelectorAll("img.emo-img").forEach(im => { if (im.dataset.m !== mode) { im.dataset.m = mode; im.dataset.i = "0"; im.src = emoSrc(mode, im.dataset.f.split(",")[0]); } });
}
const emoQ = new Set(); let emoT = 0;
new MutationObserver(ms => {
  if (emoMode() === "system") return;
  ms.forEach(m => m.addedNodes.forEach(n => emoQ.add(n)));
  if (!emoT) emoT = requestAnimationFrame(() => { emoT = 0; const q = [...emoQ]; emoQ.clear(); q.forEach(n => n.isConnected && emoProcess(n, emoMode())); });
}).observe(document.body, { childList: true, subtree: true });
function emoApply() { document.documentElement.dataset.emoji = emoMode(); emoProcess(document.body, emoMode()); }
emoApply();

/* ---------------- مشغّل الرسائل الصوتية (شكل تيليجرام) ---------------- */
const fmtDur = s => { s = Math.max(0, Math.round(+s || 0)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
function vpBars(wf, seed) {
  let a = Array.isArray(wf) && wf.length ? wf.slice(0, 48).map(x => Math.max(0, Math.min(31, +x || 0))) : null;
  if (!a) { let h = (seed | 0) || 7; a = Array.from({ length: 36 }, () => { h = (h * 1103515245 + 12345) & 0x7fffffff; return 4 + (h % 22); }); }
  return a.map(v => `<i style="height:${(3 + v / 31 * 21).toFixed(1)}px"></i>`).join("");
}
function voiceHtml(f) {
  const data = String(f.data), src = `data:${f.type};base64,${data}`, dur = Math.min(600, Math.max(0, +f.dur || 0));
  return `<div class="vp" data-vp data-src="${esc(src)}" data-dur="${dur}" data-k="${esc(data.length + ":" + data.slice(16, 40))}"><button type="button" class="vp-btn" aria-label="تشغيل">${ic("play", 22)}</button><div class="vp-body"><div class="vp-wave">${vpBars(f.wf, data.length)}</div><div class="vp-time">${dur ? fmtDur(dur) : "0:00"}</div></div></div>`;
}
let vpCur = null;
function vpPaint(el, ratio, label) {
  const bars = el.querySelectorAll(".vp-wave i"), n = Math.round(ratio * bars.length);
  bars.forEach((b, i) => b.classList.toggle("on", i < n));
  if (label != null) el.querySelector(".vp-time").textContent = label;
}
function vpReset(el) { if (!el) return; el.classList.remove("playing"); el.querySelector(".vp-btn").innerHTML = ic("play", 22); vpPaint(el, 0, fmtDur(el.dataset.dur)); }
function vpClick(e, el) {
  if (e.target.closest(".vp-wave") && vpCur && vpCur.el === el && isFinite(vpCur.au.duration) && vpCur.au.duration > 0) {
    const r = el.querySelector(".vp-wave").getBoundingClientRect();
    vpCur.au.currentTime = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * vpCur.au.duration; return;
  }
  if (vpCur && vpCur.el === el) { if (vpCur.au.paused) vpCur.au.play().catch(() => {}); else vpCur.au.pause(); return; }
  if (vpCur) { vpCur.au.pause(); vpReset(vpCur.el); vpCur = null; }
  const au = new Audio(el.dataset.src); vpCur = { el, au };
  const total = () => (isFinite(au.duration) && au.duration > 0 ? au.duration : +el.dataset.dur || 0);
  const mine = () => vpCur && vpCur.au === au;
  au.onplay = () => { if (mine()) { vpCur.el.classList.add("playing"); vpCur.el.querySelector(".vp-btn").innerHTML = ic("pause", 22); } };
  au.onpause = () => { if (mine()) { vpCur.el.classList.remove("playing"); vpCur.el.querySelector(".vp-btn").innerHTML = ic("play", 22); } };
  au.ontimeupdate = () => { if (!mine()) return; const t = total(); vpPaint(vpCur.el, t ? au.currentTime / t : 0, fmtDur(au.currentTime)); };
  au.onended = () => { if (mine()) { vpReset(vpCur.el); vpCur = null; } };
  au.onerror = () => { toast("تعذّر تشغيل الرسالة الصوتية"); if (mine()) { vpReset(vpCur.el); vpCur = null; } };
  au.play().catch(() => toast("تعذّر تشغيل الرسالة الصوتية"));
}

function toast(t) { const el = $("#toast"); el.textContent = String(t).replace(/[\p{Extended_Pictographic}\uFE0F]/gu, "").replace(/\s{2,}/g, " ").trim(); el.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove("show"), 2600); }

const isOfficial = uid => !!uid && !!S.site && S.site.ownerUid === uid;
const ownerBadge = s => `<span class="vbadge-wrap owner-badge" title="المالك · حساب رسمي" aria-label="المالك · حساب رسمي"><svg class="vbadge" width="${s}" height="${s}" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10.5" fill="#f5b800"/><path d="M6 16.5h12l.8-7-3.6 3L12 7.8 8.8 12.5l-3.6-3z" fill="#3a2600"/><rect x="6" y="17.3" width="12" height="1.6" rx=".8" fill="#3a2600"/></svg></span>`;
const badge = (u, s = 16) => u && u.uid && isOfficial(u.uid) ? ownerBadge(s) : u && u.verified
  ? `<span class="vbadge-wrap" title="حساب موثّق داخل ES Chat" aria-label="حساب موثّق"><svg class="vbadge" width="${s}" height="${s}" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10.5" fill="#1877f2"/><path d="m7.1 12.2 3.1 3.1 6.8-7" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`
  : "";
const avatar = (u, cls = "") => {
  const p = u && u.photo;
  return `<div class="avatar ${cls}"${u && u.uid ? ` data-au="${esc(u.uid)}"` : ""}>${p && p.startsWith("data:image/") ? `<img src="${esc(p)}" alt="">` : esc(((u && u.name) || "?").trim().charAt(0).toUpperCase())}</div>`;
};
const CROWN = `<svg viewBox="0 0 24 24" width="20" height="20"><path d="M3 18h18l-1.5-9-4.5 4-3-6-3 6-4.5-4L3 18z" fill="currentColor"/></svg>`;
const genderText = g => (g === "female" ? "أنثى" : g === "male" ? "ذكر" : "—");
const isOwnerUser = u => !!u && (u.email || "").toLowerCase() === OWNER_EMAIL.toLowerCase() && u.emailVerified;
const isOwner = () => isOwnerUser(S.user);

function show(view) {
  S.view = view;
  { const be = $("#bootError"); if (be) be.hidden = true; }
  for (const id of ["boot", "login", "onboard", "banned", "notice", "app"]) $("#" + id).classList.toggle("hidden", id !== view);
}
/* ---- طبقات التنقل: زر الرجوع في النظام بيقفل آخر طبقة (نافذة / محادثة / تبويب) بدل ما يخرّجك من الموقع ---- */
var _ownTimer = 0;
var _ldPollTimer = 0, _ldCountdownTimer = 0;
const LAYERS = []; let ignorePop = 0; const deferred = [];
function layerOpen(id, close) {
  const e = LAYERS.find(l => l.id === id); if (e) { e.close = close; return; }
  if (ignorePop > 0) { deferred.push(() => layerOpen(id, close)); return; }
  LAYERS.push({ id, close }); try { history.pushState({ es: LAYERS.length }, ""); } catch {}
}
function layerClose(id) {
  const i = LAYERS.findIndex(l => l.id === id); if (i < 0) return;
  const n = LAYERS.length - i; LAYERS.splice(i); ignorePop++; history.go(-n);
  setTimeout(() => { if (ignorePop > 0) { ignorePop = 0; deferred.splice(0).forEach(f => f()); } }, 900);
}
addEventListener("popstate", () => {
  if (ignorePop > 0) { ignorePop--; if (!ignorePop) deferred.splice(0).forEach(f => f()); return; }
  const l = LAYERS.pop(); if (l) l.close();
});
const MSTACK = [];
function modalDom() { MSTACK.length = 0; $("#modal").classList.add("hidden"); $("#sheet").innerHTML = ""; $("#sheet").classList.remove("wide", "page", "att-sheet", "emo-sheet", "owner-sheet", "sp-sheet", "bf-sheet", "tgp-sheet"); clearInterval(_ownTimer); clearInterval(_ldPollTimer); clearInterval(_ldCountdownTimer); }
function closeModal() {
  const was = !$("#modal").classList.contains("hidden"); modalDom();
  if (was) setTimeout(() => { if ($("#modal").classList.contains("hidden")) layerClose("modal"); }, 0);
}
/* مفتاح الشاشة: لو نفس الشاشة اتفتحت تاني (تحديث) بتتبدّل، لو شاشة تانية بتتحط فوقها ورجوع بيرجّعك للأولى */
const mKey = html => { const m = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>|class="menu-h"[^>]*>([\s\S]*?)<\/div>|<b>(لوحة المالك)<\/b>/); return m ? (m[1] || m[2] || m[3]).replace(/<[^>]*>/g, "").trim() : "h" + html.length + html.slice(0, 160); };
function snapModal() { const sh = $("#sheet"); return { nodes: Array.from(sh.childNodes), cls: sh.className, top: sh.scrollTop, key: sh.dataset.mk || "", h: { onclick: sh.onclick, onchange: sh.onchange, oninput: sh.oninput } }; }
function modalBack() {
  if (!MSTACK.length) return closeModal();
  const s = MSTACK.pop(), sh = $("#sheet");
  sh.innerHTML = ""; s.nodes.forEach(n => sh.appendChild(n)); sh.className = s.cls; Object.assign(sh, s.h); sh.dataset.mk = s.key; sh.scrollTop = s.top;
}
function modalLayerBack() { if (MSTACK.length) { modalBack(); layerOpen("modal", modalLayerBack); } else modalDom(); }
function openModal(html, wide = false, page = false) {
  const sh = $("#sheet"), was = !$("#modal").classList.contains("hidden"), key = mKey(html);
  if (was && sh.dataset.mk !== key) MSTACK.push(snapModal());
  page = page || /class="(prof|call-screen)"|sp-sub-h|stats-tabs/.test(html);
  sh.className = "sheet" + (wide ? " wide" : "") + (page ? " page" : "");
  sh.dataset.mk = key; sh.onclick = sh.onchange = sh.oninput = null;
  sh.scrollTop = 0;
  sh.innerHTML = `<button class="x" id="xBtn" aria-label="رجوع">${page ? ic("chev", 22) : ic("close", 18)}</button>` + html;
  $("#modal").classList.remove("hidden"); layerOpen("modal", modalLayerBack);
  $("#xBtn").onclick = modalBack;
  decorateMenus(sh);
  return sh;
}
$("#modal").addEventListener("mousedown", e => { if (e.target.id === "modal") closeModal(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") modalBack(); });

/* ---- منع النسخ والتحديد في الموقع (إلا جوه خانات الكتابة) ---- */
const inField = t => !!(t && t.closest && t.closest("input,textarea"));
document.addEventListener("copy", e => { if (!inField(e.target)) e.preventDefault(); });
document.addEventListener("cut", e => { if (!inField(e.target)) e.preventDefault(); });
document.addEventListener("selectstart", e => { if (!inField(e.target)) e.preventDefault(); });
document.addEventListener("dragstart", e => e.preventDefault());
document.addEventListener("contextmenu", e => { if (!inField(e.target)) e.preventDefault(); });

/* ---------------- firebase ---------------- */
const withTimeout = (p, ms = 15000) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(Object.assign(new Error("timeout"), { code: "timeout" })), ms))]);
function explain(e) {
  const c = (e && e.code) || "";
  if (c.includes("permission-denied")) return "القواعد (Rules) مش متظبطة في Firestore. الصق firestore.rules واضغط Publish.";
  if (c.includes("not-found")) return "قاعدة بيانات Firestore مش موجودة. اعمل Create database الأول.";
  if (c.includes("unavailable") || c === "timeout") return "الموقع مش عارف يوصل لقاعدة البيانات. اتأكد إن Firestore اتعمل وإن النت شغال.";
  return "حصل خطأ غير متوقع.";
}
async function fail(e) {
  console.error(e);
  $("#loginMsg").textContent = explain(e) + " (" + ((e && (e.code || e.message)) || "") + ")";
  try { await signOut(auth); } catch {}
  show("login"); $("#googleBtn").disabled = false;
}
const configured = !String(firebaseConfig.apiKey).startsWith("PASTE");
let auth, db, fbApp;
if (!configured) {
  show("login");
  $("#googleBtn").disabled = true;
  $("#loginMsg").textContent = "لازم تلصق إعدادات Firebase في ملف firebase-config.js الأول.";
} else {
  fbApp = initializeApp(firebaseConfig); const fb = fbApp;
  auth = getAuth(fb); try { db = initializeFirestore(fb, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }), experimentalAutoDetectLongPolling: true }); }
  catch (e) { console.warn("cache", e); db = initializeFirestore(fb, { experimentalAutoDetectLongPolling: true }); }
  countVisit();
  getRedirectResult(auth).catch(loginError);
  onAuthStateChanged(auth, onAuth);
  setTimeout(() => { if (S.view === "boot") fail(Object.assign(new Error("boot"), { code: "timeout" })); }, 45000);
}

function countVisit() {
  if (sessionStorage.es_visit) return;
  sessionStorage.es_visit = "1";
  setDoc(doc(db, "stats", "global"), { visits: increment(1) }, { merge: true }).catch(() => {});
  setDoc(doc(db, "stats", dayKey()), { visits: increment(1) }, { merge: true }).catch(() => {});
}

function loginError(e) {
  const m = {
    "auth/unauthorized-domain": "الدومين ده مش مضاف في Authorized domains جوه Firebase Authentication.",
    "auth/operation-not-allowed": "تسجيل الدخول بجوجل مش مفعّل في Firebase Authentication.",
    "auth/network-request-failed": "مشكلة في الاتصال بالإنترنت.",
  }[e && e.code] || "حصل خطأ في تسجيل الدخول: " + ((e && e.code) || e);
  $("#loginMsg").textContent = m; $("#googleBtn").disabled = false;
}
$("#googleBtn").onclick = async () => {
  $("#loginMsg").textContent = ""; $("#googleBtn").disabled = true;
  const p = new GoogleAuthProvider(); p.setCustomParameters({ prompt: "select_account" });
  try { await signInWithPopup(auth, p); }
  catch (e) {
    if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment"].includes(e.code)) { try { await signInWithRedirect(auth, p); return; } catch (e2) { e = e2; } }
    if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") loginError(e);
    $("#googleBtn").disabled = false;
  }
};
const doSignOut = async () => { closeModal(); await signOut(auth); };
$("#bannedOut").onclick = doSignOut;
$("#noticeOut").onclick = doSignOut;
function notice(t, p) { $("#noticeT").textContent = t; $("#noticeP").textContent = p; show("notice"); }

function cleanup() {
  if (CALL) stopCallUI();
  Object.values(S.unsub).forEach(f => f && f());
  clearInterval(S.beatT); clearInterval(S.tickT); clearTimeout(S.typT);
  S.unsub = {}; pubSig = ""; S.me = null; S.e2ee = { ready: false, error: "" }; S.chat = null; S.users = new Map(); S.chats = []; S.found = null; S.site = {}; S.seen = new Map(); S.chatsLoaded = false; S.fcm = null; S.prefs = DEFAULT_PREFS(); S.filter = "all"; S.groups = []; S.gseen = new Map(); S.groupsLoaded = false;
}

async function onAuth(user) {
  cleanup(); closeModal();
  if (!user) { S.user = null; $("#googleBtn").disabled = false; show("login"); return; }
  S.user = user;
  initE2EEDevice(user.uid, publicData => setDoc(doc(db, "users", user.uid, "crypto", publicData.deviceId), publicData, { merge: true }))
    .then(v => { S.e2ee = v; })
    .catch(e => { console.warn("E2EE foundation", e); S.e2ee = { ready: false, error: e.message || "crypto init failed" }; });
  S.unsub.site = onSnapshot(doc(db, "settings", "site"), s => { S.site = s.data() || {}; if (S.user && isOwner() && S.site.ownerUid !== S.user.uid) setDoc(doc(db, "settings", "site"), { ownerUid: S.user.uid }, { merge: true }).catch(() => {}); siteChanged(); }, () => {});
  watchIncomingCalls();
  try {
    const ref = doc(db, "users", user.uid);
    const snap = await withTimeout(getDoc(ref));
    const owner = isOwnerUser(user);
    const logIt = () => addDoc(collection(db, "logins"), { uid: user.uid, name: (user.displayName || "مستخدم").slice(0, 40), at: serverTimestamp() }).catch(() => {});
    if (!snap.exists()) {
      if (!owner) {
        let sd = {}; try { sd = (await getDoc(doc(db, "settings", "site"))).data() || {}; } catch {}
        if (sd.registrationOpen === false) { notice("التسجيل مقفول حاليًا", "الموقع مش بيقبل حسابات جديدة دلوقتي. جرّب بعدين."); return; }
      }
      const base = { uid: user.uid, name: (user.displayName || "مستخدم").slice(0, 40), createdAt: serverTimestamp(), lastLogin: serverTimestamp(), loginCount: 1, onboarded: false };
      await withTimeout(setDoc(ref, owner ? { ...base, verified: true, role: "owner" } : base));
      await withTimeout(setDoc(doc(db, "users", user.uid, "private", "account"), { uid: user.uid, email: user.email || "" }, { merge: true }));
      sessionStorage.es_login = "1"; logIt();
    } else {
      if (!sessionStorage.es_login) {
        sessionStorage.es_login = "1";
        updateDoc(ref, { lastLogin: serverTimestamp(), loginCount: increment(1) }).catch(() => {}); logIt();
      }
      const d = snap.data();
      setDoc(doc(db, "users", user.uid, "private", "account"), { uid: user.uid, email: user.email || "" }, { merge: true }).catch(() => {});
      if (owner && (!d.verified || d.role !== "owner")) updateDoc(ref, { verified: true, role: "owner" }).catch(() => {});
    }
    S.unsub.me = onSnapshot(ref, s => { S.me = s.data(); applyAppLanguage(S.me?.lang || LS.get("lang", "ar")); syncPublicProfile(user.uid); if (!S._sw) { S._sw = 1; localSweep(); } route(); }, e => fail(e));
  } catch (e) {
    await fail(e);
  }
}

let pubSig = "";
function syncPublicProfile(uid) {
  const m = S.me; if (!m) return;
  const patch = { uid, verified: !!m.verified, hideLastSeen: !!m.hideLastSeen };
  for (const k of ["name", "photo", "gender", "bio", "username"]) if (typeof m[k] === "string") patch[k] = m[k];
  if (m.hideProfilePhoto) patch.photo = "";
  if (m.hideBio) patch.bio = "";
  if (m.hideLastSeen) patch.hideLastSeen = true;
  const sig = JSON.stringify(patch).length + "|" + (patch.photo || "").length + "|" + (patch.username || "") + "|" + (patch.name || "") + "|" + (patch.bio || "") + "|" + (patch.verified ? 1 : 0) + "|" + (m.hideLastSeen ? 1 : 0) + "|" + (m.hideProfilePhoto ? 1 : 0) + "|" + (m.hideBio ? 1 : 0);
  if (sig === pubSig) return; pubSig = sig;
  setDoc(doc(db, "users", uid, "public", "profile"), patch, { merge: true }).catch(e => console.warn("public profile sync", e));
}
function route() {
  const me = S.me; if (!me) return;
  if (me.banned && !isOwner()) { show("banned"); return; }
  if (S.site.maintenance && !isOwner()) { notice("الموقع تحت الصيانة", S.site.maintenanceMsg || "هنرجع قريب. شكرًا على صبرك."); return; }
  if (!me.onboarded) { if (S.view !== "onboard") { show("onboard"); renderForm($("#onboardBox"), "onboard"); } return; }
  if (S.view !== "app") enterApp(); else paintMe();
}

/* ---------------- profile form (onboarding + edit) ---------------- */
function compressPhoto(file, size = 192) {
  return new Promise((res, rej) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const c = document.createElement("canvas"); c.width = c.height = size;
      const m = Math.min(img.width, img.height);
      c.getContext("2d").drawImage(img, (img.width - m) / 2, (img.height - m) / 2, m, m, 0, 0, size, size);
      URL.revokeObjectURL(url); res(c.toDataURL("image/jpeg", 0.78));
    };
    img.onerror = () => rej(new Error("bad image")); img.src = url;
  });
}

function renderForm(root, mode) {
  const me = S.me, edit = mode === "edit";
  let photo = me.photo || "", gender = me.gender || "", unameOk = edit, t;
  root.innerHTML = `
    <h2>${edit ? "تعديل البروفايل" : "كمّل بيانات حسابك"}</h2>
    <p class="sub">${edit ? "غيّر بياناتك وبعدها اضغط حفظ." : "خطوة واحدة وتبدأ تستخدم الموقع."}</p>
    <div class="field"><div class="photo-pick"><div id="pv"></div>
      <div><button type="button" class="btn-ghost" id="pickBtn">اختيار صورة من الجهاز</button><div class="hint" id="photoHint"></div></div></div>
      <input type="file" id="file" accept="image/*" hidden></div>
    <div class="field"><label for="fName">الاسم</label><input type="text" id="fName" maxlength="40" value="${esc(me.name || "")}" placeholder="اكتب اسمك"></div>
    <div class="field"><label>النوع</label><div class="seg"><button type="button" data-g="female">أنثى</button><button type="button" data-g="male">ذكر</button></div></div>
    <div class="field"><label for="fUser">اسم المستخدم</label>
      <input type="text" id="fUser" maxlength="20" value="${edit ? esc(me.username || "") : ""}" placeholder="مثال: ahmed_22" autocapitalize="none" autocomplete="off" spellcheck="false" style="direction:ltr;text-align:end">
      <div class="hint" id="uHint">${edit ? "تقدر تغيّر اسم المستخدم. لازم يكون متاحًا؛ روابط @ القديمة قد لا تعمل بعد التغيير." : "حروف إنجليزي صغيرة وأرقام و _ (من 3 لـ 20)"}</div></div>
    <div class="field"><label for="fBio">نبذة عنك</label><textarea id="fBio" maxlength="160" placeholder="اكتب وصف قصير عن نفسك">${esc(me.bio || "")}</textarea><div class="hint" id="bHint"></div></div>
    <div class="hint err" id="fErr"></div>
    <div class="actions" style="justify-content:space-between;margin-top:10px">
      <button type="button" class="btn-primary" id="save">${edit ? "حفظ التعديلات" : "ابدأ"}</button>
      <button type="button" class="btn-ghost" id="out">تسجيل الخروج</button></div>`;
  const q = s => root.querySelector(s);
  const paintPhoto = () => { q("#pv").innerHTML = avatar({ photo, name: q("#fName").value || me.name }); };
  const paintGender = () => root.querySelectorAll("[data-g]").forEach(b => b.classList.toggle("on", b.dataset.g === gender));
  paintPhoto(); paintGender();
  q("#fName").oninput = paintPhoto;
  root.querySelectorAll("[data-g]").forEach(b => b.onclick = () => { gender = b.dataset.g; paintGender(); });
  q("#pickBtn").onclick = () => q("#file").click();
  q("#file").onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try { photo = await compressPhoto(f); paintPhoto(); q("#photoHint").textContent = ""; } catch { q("#photoHint").textContent = "الصورة دي مش مدعومة"; }
  };
  const bio = q("#fBio"), bh = q("#bHint");
  const cnt = () => bh.textContent = bio.value.length + " / 160"; bio.oninput = cnt; cnt();
  q("#out").onclick = doSignOut;
  {
    const u = q("#fUser"), h = q("#uHint");
    if (edit) u.value = String(me.username || "");
    u.oninput = () => {
      clearTimeout(t);
      const v = u.value.trim().toLowerCase(), current = String(me.username || "").toLowerCase();
      if (v === current) { unameOk = true; h.className = "hint"; h.textContent = "ده اسم المستخدم الحالي."; return; }
      unameOk = false; h.className = "hint";
      if (!/^[a-z0-9_]{3,20}$/.test(v)) { h.textContent = "حروف إنجليزي صغيرة وأرقام و _ (من 3 لـ 20)"; return; }
      h.textContent = "بتأكد إن الاسم متاح...";
      t = setTimeout(async () => {
        try {
          const snap = await getDoc(doc(db, "usernames", v));
          if (u.value.trim().toLowerCase() !== v) return;
          unameOk = !snap.exists() || snap.data()?.uid === S.user.uid;
          h.className = "hint " + (unameOk ? "ok" : "err");
          h.textContent = unameOk ? "الاسم متاح" : "الاسم ده مستخدم، جرّب غيره";
        } catch { h.className = "hint err"; h.textContent = "تعذّر التحقق؛ حاول مرة تانية."; }
      }, 400);
    };
  }
  q("#save").onclick = async () => {
    const err = q("#fErr"); err.textContent = "";
    const name = q("#fName").value.trim(), b = bio.value.trim();
    if (!name) { err.textContent = "اكتب اسمك."; return; }
    if (!gender) { err.textContent = "اختار النوع (أنثى أو ذكر)."; return; }
    const un = q("#fUser").value.trim().toLowerCase(), oldUn = String(me.username || "").toLowerCase();
    if ((!edit || un !== oldUn) && !unameOk) { err.textContent = "اختار اسم مستخدم متاحًا وانتظر تأكيد الإتاحة."; return; }
    if (!/^[a-z0-9_]{3,20}$/.test(un)) { err.textContent = "اسم المستخدم لازم يكون من 3 إلى 20 حرفًا إنجليزيًا صغيرًا أو رقمًا أو _ ."; return; }
    q("#save").disabled = true;
    try {
      if (edit) {
        if (un !== oldUn) {
          const idToken = await auth.currentUser.getIdToken();
          const resp = await fetch("/api/username-change", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + idToken }, body: JSON.stringify({ username: un }) });
          const result = await resp.json().catch(() => ({}));
          if (!resp.ok) throw new Error(result.error === "username_taken" ? "اسم المستخدم ده اتاخد للتو؛ اختار غيره." : result.error === "invalid_username" ? "اسم المستخدم غير صالح." : "تعذّر تغيير اسم المستخدم؛ حاول مرة أخرى.");
          me.username = un;
        }
        await updateDoc(doc(db, "users", S.user.uid), { name, gender, bio: b, photo });
        await setDoc(doc(db, "users", S.user.uid, "public", "profile"), { uid: S.user.uid, name, gender, bio: b, photo, username: un }, { merge: true });
        syncPublicProfile(S.user.uid); closeModal(); toast(un !== oldUn ? "تم حفظ البروفايل وتغيير اسم المستخدم" : "اتحفظت التعديلات");
      } else {
        batch.set(doc(db, "usernames", un), { uid: S.user.uid });
        batch.update(doc(db, "users", S.user.uid), { name, gender, bio: b, photo, username: un, onboarded: true });
        await batch.commit();
        await setDoc(doc(db, "users", S.user.uid, "public", "profile"), { uid: S.user.uid, name, gender, bio: b, photo, username: un }, { merge: true });
      }
    } catch (e) { console.error(e); err.textContent = "حصل خطأ في الحفظ (" + (e.code || e.message) + "). جرّب تاني."; q("#save").disabled = false; }
  };
}

/* ---------------- الإشعارات والإعدادات ---------------- */
const prefs = { get notifs() { return LS.get("notifs", true); }, get sound() { return LS.get("sound", true); }, get preview() { return LS.get("preview", true); } };
const canNotify = () => "Notification" in window;
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("firebase-messaging-sw.js").catch(e => console.warn("sw", e));
  navigator.serviceWorker.addEventListener("message", e => { if (e.data && e.data.type === "open-chat") openFromId(e.data.chatId); });
}
function openFromId(chatId) {
  if (!S.user || !chatId) return;
  if (S.view !== "app") { S.pendingChat = chatId; return; }
  if (chatId.startsWith("g:")) return openGroup(chatId.slice(2));
  if (S.groups.some(g => g.id === chatId)) return openGroup(chatId);
  const parts = chatId.split("_"), peer = parts.find(p => p !== S.user.uid);
  if (parts.length === 2 && peer) openChat(peer);
}
let audioCtx;
addEventListener("pointerdown", () => { try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch {} }, { once: true });
function inQuiet() {
  if (!LS.get("quiet", false)) return false;
  const f = x => { const [h, m] = String(x).split(":"); return (+h || 0) * 60 + (+m || 0); };
  const n = new Date(), now = n.getHours() * 60 + n.getMinutes(), a = f(LS.get("qFrom", "23:00")), b = f(LS.get("qTo", "07:00"));
  return a <= b ? now >= a && now < b : now >= a || now < b;
}
function beep() {
  if (!prefs.sound || !audioCtx || inQuiet()) return;
  try {
    const t0 = audioCtx.currentTime;
    [[880, 0], [1175, 0.11]].forEach(([f, d]) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = "sine"; o.frequency.value = f; o.connect(g); g.connect(audioCtx.destination);
      g.gain.setValueAtTime(0.0001, t0 + d); g.gain.exponentialRampToValueAtTime(0.18, t0 + d + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.18);
      o.start(t0 + d); o.stop(t0 + d + 0.2);
    });
  } catch {}
}
async function showNotif(title, body, chatId) {
  if (inQuiet()) return;
  if (!canNotify() || Notification.permission !== "granted") return;
  const safeBody = prefs.preview ? body : "لديك رسالة جديدة";
  const opts = { body: safeBody, icon: "assets/icon-192.png", badge: "assets/favicon-64.png", tag: chatId, renotify: true, dir: (S.me?.lang === "en" ? "ltr" : "rtl"), lang: (S.me?.lang === "en" ? "en" : "ar"), data: { chatId } };
  try { const reg = await navigator.serviceWorker.ready; await reg.showNotification(title, opts); }
  catch { try { new Notification(title, opts); } catch {} }
}
const readKey = id => "read_" + (S.user ? S.user.uid : "") + "_" + id;
const uk = () => "unread_" + (S.user ? S.user.uid : "");
const unreadMap = () => LS.get(uk(), {});
function setUnread(id, n) { const m = unreadMap(); if (n) m[id] = n; else delete m[id]; LS.set(uk(), m); updateBadge(); }
function updateBadge() {
  const n = Object.values(unreadMap()).reduce((a, b) => a + b, 0);
  document.title = (n ? "(" + n + ") " : "") + "ES Chat Pro";
  try { n ? navigator.setAppBadge && navigator.setAppBadge(n) : navigator.clearAppBadge && navigator.clearAppBadge(); } catch {}
}
function markRead(chatId) {
  const c = S.chats.find(x => x.id === chatId) || S.groups.find(x => x.id === chatId), ms = c ? toDate(c.lastAt)?.getTime() || 0 : 0;
  LS.set(readKey(chatId), Math.max(Date.now(), ms));
  if (unreadMap()[chatId]) { setUnread(chatId, 0); renderList(); }
}
async function onIncoming(chatId, d) {
  if (S.prefs.block.includes(peerOf(d))) return;
  await ensureUsers([peerOf(d)]);
  const u = S.users.get(peerOf(d)) || { name: "رسالة جديدة" };
  const here = document.visibilityState === "visible";
  if (here && S.chat && S.chat.id === chatId) { markRead(chatId); return; }
  setUnread(chatId, (unreadMap()[chatId] || 0) + 1); renderList();
  if (!prefs.notifs || S.prefs.mute.includes(chatId)) return;
  const text = prefs.preview ? (d.lastText || "") : "رسالة جديدة";
  if (here) toast(u.name + ": " + text); else showNotif(u.name, text, chatId);
  beep();
}
async function onIncomingGroup(gid, d) {
  const here = document.visibilityState === "visible";
  if (here && S.chat && S.chat.id === gid) { markRead(gid); return; }
  setUnread(gid, (unreadMap()[gid] || 0) + 1); renderList();
  maybeMentionNotify(gid, d);
  if (!prefs.notifs || S.prefs.mute.includes(gid)) return;
  const text = prefs.preview ? (d.kind === "channel" ? (d.lastText || "") : (d.lastName ? d.lastName + ": " : "") + (d.lastText || "")) : "رسالة جديدة";
  if (here) toast(d.name + ": " + text); else showNotif(d.name, text, "g:" + gid);
  beep();
}
const mentionSeen = new Set();
function mentionPattern(username) { return new RegExp("(?:^|\\s)@" + String(username || "").replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&") + "(?:\\b|$)", "i"); }
function maybeMentionNotify(gid, d) {
  const username = S.me && S.me.username, text = String(d.lastText || "");
  if (!username || !text || d.lastUid === S.user.uid || !mentionPattern(username).test(text) || !prefs.notifs || inQuiet()) return;
  const key = gid + "|" + String(toDate(d.lastAt)?.getTime() || text);
  if (mentionSeen.has(key)) return; mentionSeen.add(key); if (mentionSeen.size > 240) mentionSeen.delete(mentionSeen.values().next().value);
  const title = "تم ذكرك في " + String(d.name || "المحادثة").slice(0, 50), body = prefs.preview ? String(d.lastText).slice(0, 120) : "فيه عضو ذكرك في رسالة";
  if (document.visibilityState === "visible") toast(title + ": " + body); else showNotif(title, body, "g:" + gid);
}
function paintNotifBar() {
  const bar = $("#notifBar");
  if (!(canNotify() && Notification.permission === "default" && !LS.get("notifAsked", false))) { bar.classList.add("hidden"); return; }
  bar.innerHTML = `<div class="nb-t"><b>فعّل الإشعارات</b><span>عشان توصلك الرسايل الجديدة حتى لو الموقع مقفول.</span></div><div class="nb-a"><button class="btn-mini" id="nbOn">تفعيل</button><button class="btn-mini ghost" id="nbLater">لاحقًا</button></div>`;
  bar.classList.remove("hidden");
  $("#nbOn").onclick = enableNotifs; $("#nbLater").onclick = () => { LS.set("notifAsked", true); paintNotifBar(); };
}
async function enableNotifs() {
  if (!canNotify()) { toast("المتصفح ده مش بيدعم الإشعارات (على الآيفون لازم تضيف الموقع للشاشة الرئيسية)"); return "unsupported"; }
  let p = Notification.permission;
  if (p === "default") p = await Notification.requestPermission();
  LS.set("notifAsked", true); paintNotifBar();
  if (p === "granted") { LS.set("notifs", true); toast("الإشعارات اتفعلت"); registerPush(); }
  else if (p === "denied") toast("الإشعارات مقفولة للموقع ده من إعدادات المتصفح");
  return p;
}
async function registerPush() {
  if (!VAPID_KEY || !S.user || !prefs.notifs || !canNotify() || Notification.permission !== "granted") return;
  try {
    const M = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js");
    if (!(await M.isSupported())) return;
    const reg = await navigator.serviceWorker.ready;
    const token = await M.getToken(M.getMessaging(fbApp), { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
    if (!token || !S.user) return;
    S.fcm = token;
    await setDoc(doc(db, "users", S.user.uid, "tokens", token), { at: serverTimestamp(), ua: navigator.userAgent.slice(0, 120) });
  } catch (e) { console.warn("push", e); }
}
async function unregisterPush() {
  try {
    if (!S.fcm || !VAPID_KEY) return;
    const M = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js");
    await deleteDoc(doc(db, "users", S.user.uid, "tokens", S.fcm)).catch(() => {});
    await M.deleteToken(M.getMessaging(fbApp)); S.fcm = null;
  } catch {}
}
/* طابور الإشعارات: لو إنت أوفلاين وقت الإرسال، الإشعار بيتبعت لما النت يرجع (حتى لو قفلت الموقع وفتحته تاني) */
const OBK = "es_pushq";
const obGet = () => { try { return JSON.parse(localStorage.getItem(OBK) || "[]"); } catch { return []; } };
const obSet = a => { try { localStorage.setItem(OBK, JSON.stringify(a.slice(-30))); } catch {} };
let obBusy = false;
async function flushPushOutbox() {
  if (obBusy || !S.user || !VAPID_KEY || !navigator.onLine || !obGet().length) return;
  obBusy = true;
  try {
    await withTimeout(waitForPendingWrites(db), 20000);
    for (const it of obGet()) {
      if (it.uid !== S.user.uid) continue;
      if (Date.now() - it.at > 6 * 3600e3) { obSet(obGet().filter(x => x.id !== it.id)); continue; }
      try {
        const t = await S.user.getIdToken();
        const r = await fetch("/api/notify", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + t }, body: JSON.stringify({ chatId: it.chatId, text: it.text, messageId: it.messageId || "" }) });
        if (r.status >= 500) throw new Error("srv");
        obSet(obGet().filter(x => x.id !== it.id));
      } catch { break; }
    }
  } catch {} finally { obBusy = false; }
}
function pushNotify(chatId, text, messageId = "") {
  if (!VAPID_KEY || !S.user) return;
  obSet([...obGet(), { id: Date.now() + "_" + Math.random().toString(36).slice(2, 7), chatId, messageId, text: String(text).slice(0, 120), at: Date.now(), uid: S.user.uid }]);
  flushPushOutbox();
}
/* رجوع النت / رجوع للتطبيق: بنجدد اتصال Firestore عشان الرسايل الفايتة توصل فورًا */
let resyncing = false, hiddenAt = 0;
function setNet(on) { $("#netBar").classList.toggle("hidden", on); }
async function resync() {
  if (!db || !S.user || resyncing || !navigator.onLine) return; resyncing = true;
  try { await disableNetwork(db); await enableNetwork(db); } catch {}
  resyncing = false; flushPushOutbox(); registerPush();
}
addEventListener("online", () => { setNet(true); setTimeout(resync, 300); });
addEventListener("offline", () => setNet(false));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") hiddenAt = Date.now();
  else if (hiddenAt && Date.now() - hiddenAt > 15000) { hiddenAt = 0; resync(); } else flushPushOutbox();
});
setNet(navigator.onLine);

const switchRow = (id, on, label, sub) => `<label class="tg-row"><div><b>${label}</b>${sub ? `<small>${sub}</small>` : ""}</div><input type="checkbox" class="tg" id="${id}" ${on ? "checked" : ""}><span class="tg-ui"></span></label>`;
function openEdit() { const sh = openModal(`<div class="settings-page-head"><div class="settings-kicker">ES CHAT PRO</div><h2>تعديل الحساب</h2><p>حدّث بياناتك العامة بدون كشف بياناتك الخاصة.</p></div><div id="editBox"></div>`, false, true); renderForm(sh.querySelector("#editBox"), "edit"); }
const ACCENTS = [["blue", "#2f6bff", "أزرق"], ["violet", "#8b5cf6", "بنفسجي"], ["emerald", "#10b981", "أخضر"], ["gold", "#f59e0b", "ذهبي"]];
const WALLS = [["dots", "نقط"], ["grid", "شبكة"], ["none", "سادة"]];
function applyTheme() { const r = document.documentElement; r.dataset.accent = LS.get("accent", "blue"); r.dataset.wp = LS.get("wp", "dots"); r.dataset.fs = LS.get("fs", "m"); r.dataset.dens = LS.get("dens", "n"); r.dataset.motion = LS.get("motion", true) ? "on" : "off"; }
applyTheme();
const ROW_IC = { botsManager: "bot", telegramBots: "bot", contactsBook: "user", security: "shield", privacyCalls: "phone", privacyContacts: "block", privacyLock: "lock", privacyAdvanced: "sliders", privacyCheckup: "shield", folders: "folder", quick: "bolt", stars: "star", chatMedia: "image", drafts: "edit", account: "user", privacy: "shield", devices: "device", chats: "chat", notifications: "bell", appearance: "palette", language: "globe", data: "database", power: "battery", about: "info", storage: "pie", adMobile: "signal", adWifi: "wifi" };
const settingsRow = (id, icon, title, sub = "") => `<button type="button" class="settings-row" data-settings="${id}"><span class="settings-row-icon">${ic(ROW_IC[id] || "sliders", 22)}</span><span class="settings-row-copy"><b>${title}</b>${sub ? `<small>${sub}</small>` : ""}</span><span class="settings-row-arrow">${ic("chev", 18)}</span></button>`;
function settingsPage(title, sub, html) {
  return openModal(`<div class="settings-page-head"><div class="settings-kicker">ES CHAT PRO · CONTROL CENTER</div><h2>${title}</h2><p>${sub}</p></div>${html}`, false, true);
}
function openSettingsSection(id) {
  const me = S.me;
  if (id === "account") return openEdit();
  if (id === "telegramBots") return openTelegramBots();
  if (id === "botsManager") return openBotsManager();
  if (id === "contactsBook") return openContacts();
  if (id === "security") {
    const u = S.user || {};
    const providers = (u.providerData || []).map(p => p.providerId === "google.com" ? "Google" : p.providerId).filter(Boolean);
    const created = u.metadata?.creationTime ? new Date(u.metadata.creationTime).toLocaleString() : "غير متاح";
    const last = u.metadata?.lastSignInTime ? new Date(u.metadata.lastSignInTime).toLocaleString() : "غير متاح";
    const sh = settingsPage("أمان الحساب والجلسات", "مراجعة معلومات تسجيل الدخول والحماية المتاحة لهذا الحساب.",
      `<div class="device-card"><b>طريقة تسجيل الدخول</b><span>${esc(providers.join("، ") || "مزود تسجيل الدخول الحالي")}</span><small>البريد: ${esc(u.email || "غير متاح")}</small><i>${u.emailVerified ? "البريد مؤكد لدى مزود تسجيل الدخول" : "حالة تأكيد البريد غير مؤكدة"}</i></div><div class="privacy-note"><b>إنشاء الحساب</b><span>${esc(created)}</span></div><div class="privacy-note"><b>آخر تسجيل دخول حسب Firebase</b><span>${esc(last)}</span></div><div class="privacy-note"><b>الجلسات</b><span>يمكنك إنهاء الجلسة الحالية. لا يتيح هذا الإصدار إبطال جلسات الأجهزة الأخرى من داخل الموقع.</span></div><button type="button" class="btn-danger" id="securitySignOut">تسجيل الخروج من هذا الجهاز</button><p class="hint">لا تشارك رموز تسجيل الدخول. إذا شككت في وصول شخص آخر إلى حساب Google، أمّن حساب Google من إعداداته الرسمية.</p>`);
    sh.querySelector("#securitySignOut").onclick=async()=>{if(confirm("تسجيل الخروج من هذا الجهاز؟")){closeModal();await signOut(auth);}};
    return sh;
  }
  if (id === "phone") {
    const current = String(me.phone || "");
    const sh = settingsPage("رقم الهاتف والعثور على حسابك", "أضف رقمك بصيغة دولية واختر إن كنت تسمح بالعثور على حسابك به. رقمك لا يظهر في الملف العام.", `<div class="field"><label for="profilePhone">رقم الهاتف بصيغة دولية</label><input id="profilePhone" type="tel" inputmode="tel" autocomplete="tel" maxlength="20" placeholder="+201xxxxxxxxx" value="${esc(current)}" dir="ltr"></div>${switchRow("phoneDiscover", me.phonePublic === true, "السماح بالعثور عليّ برقم الهاتف", "عند التفعيل سيتمكن المستخدمون من العثور على حسابك بهذا الرقم") }<div class="privacy-note"><b>تنبيه خصوصية</b><span>لن نعرض رقمك في الملف العام؛ نستخدمه فقط للبحث عند تفعيل الخيار. استخدم رقمًا تملكه فعلًا.</span></div><button class="btn-primary" id="savePhone">حفظ إعدادات الرقم</button>`);
    sh.querySelector("#savePhone").onclick = async () => { const input=sh.querySelector("#profilePhone"), phone=input.value.trim().replace(/[\s().-]/g, ""), discover=sh.querySelector("#phoneDiscover").checked; if (phone && !/^\+[1-9]\d{7,14}$/.test(phone)) { toast("اكتب الرقم بصيغة دولية مثل +201xxxxxxxxx"); return; } if (discover && !phone) { toast("أضف رقم الهاتف أولًا"); return; } const btn=sh.querySelector("#savePhone"); btn.disabled=true; try { const old=String(S.me.phone||"").replace(/[\s().-]/g, ""); if (old && (old!==phone || !discover)) await deleteDoc(doc(db,"phoneNumbers",old)); if (discover && phone) await setDoc(doc(db,"phoneNumbers",phone),{uid:S.user.uid}); else if(phone) { const oldMap=await getDoc(doc(db,"phoneNumbers",phone)); if(oldMap.exists()&&oldMap.data().uid===S.user.uid) await deleteDoc(doc(db,"phoneNumbers",phone)); } await updateDoc(doc(db,"users",S.user.uid),{phone,phonePublic:discover}); await setDoc(doc(db,"users",S.user.uid,"public","profile"),{uid:S.user.uid,phone:"",phonePublic:false},{merge:true}); S.me.phone=phone; S.me.phonePublic=discover; toast("تم حفظ إعدادات رقم الهاتف"); } catch(err) { console.error(err); toast("تعذّر الحفظ؛ قد تحتاج تحديث قواعد Firestore"); } finally { btn.disabled=false; } }; return sh;
  }
  if (id === "advanced") return openSettingsAdvanced();
  if (id === "privacy") {
    const sh = settingsPage("الخصوصية والأمان", "تحكم في ظهورك، اتصالاتك، وقواعد حماية محادثاتك الخاصة.", `<div class="panel-h">الظهور والتواصل</div>${switchRow("secHide", !!me.hideLastSeen, "إخفاء آخر ظهور والحالة", "إخفاء حالة الاتصال وآخر ظهورك عن الآخرين")}${switchRow("secPhoto", !!me.hideProfilePhoto, "إخفاء صورة الملف الشخصي", "إزالة الصورة من الملف العام حتى تعيد إظهارها")}${switchRow("secBio", !!me.hideBio, "إخفاء النبذة الشخصية", "إخفاء نبذتك من الملف العام")}${switchRow("secRR", me.readReceipts !== false, "تأكيدات القراءة", "عند الإيقاف لن تظهر علامة القراءة في المحادثات الخاصة")}${switchRow("secNoAdd", me.noAdd === true, "منع الإضافة للمجموعات", "يرفض التطبيق إضافتك مباشرة؛ يمكنك الانضمام عبر رابط")}${switchRow("secUnknown", LS.get("quiet_unknown", false), "كتم مكالمات الغرباء", "يرفض المكالمات الواردة من حسابات لا توجد بينك وبينها محادثة")}
      <div class="panel-h">حماية الرسائل</div>${switchRow("secPreview", LS.get("lcards", true), "معاينات الروابط", "إيقافها يمنع إنشاء بطاقة معاينة داخل المحادثة")}
      <div class="privacy-note"><b>ملاحظة أمنية</b><span>إعدادات الصورة والنبذة تُطبّق على الملف العام. كتم الغرباء ومعاينات الروابط إعدادات محلية لهذا المتصفح. لا تفعّل قفلًا شكليًا باعتباره بديلًا عن قفل الجهاز.</span></div><div class="panel-h">إعدادات إضافية</div>${settingsRow("privacyCalls","☎","المكالمات","كتم المتصلين غير المعروفين وتأمين الاتصال")}${settingsRow("privacyContacts","◎","جهات الاتصال المحظورة","عرض القائمة وإلغاء الحظر مباشرة")}${settingsRow("phone","☎","رقم الهاتف والعثور عليك",me.phonePublic?"العثور عليك بالرقم مفعّل":"العثور عليك بالرقم متوقف")}${settingsRow("privacyLock","▣","قفل التطبيق والمحادثات","إعدادات محلية للجلسة الحالية")}${settingsRow("privacyAdvanced","◆","متقدم","حماية عنوان الاتصال ومعاينات الروابط")}${settingsRow("privacyCheckup","✓","فحص الخصوصية","مراجعة سريعة لإعداداتك المهمة")}`);
    const q = x => sh.querySelector(x);
    q("#secHide").onchange = async e => { const on=e.target.checked; try { await updateDoc(doc(db,"users",S.user.uid), on ? {hideLastSeen:true,lastSeen:deleteField()} : {hideLastSeen:false}); S.me.hideLastSeen=on; syncPublicProfile(S.user.uid); toast(on?"تم إخفاء حالتك":"ظهرت حالتك"); } catch { e.target.checked=!on; toast("تعذّر الحفظ"); } };
    const setProfilePrivacy = async (field, on, input) => { try { await updateDoc(doc(db,"users",S.user.uid),{[field]:on}); S.me[field]=on; syncPublicProfile(S.user.uid); toast("تم حفظ إعداد الخصوصية"); } catch { input.checked=!on; toast("تعذّر الحفظ؛ تحقق من قواعد Firestore"); } };
    q("#secPhoto").onchange = e => setProfilePrivacy("hideProfilePhoto",e.target.checked,e.target);
    q("#secBio").onchange = e => setProfilePrivacy("hideBio",e.target.checked,e.target);
    q("#secRR").onchange = async e => { try { await updateDoc(doc(db,"users",S.user.uid),{readReceipts:e.target.checked}); S.me.readReceipts=e.target.checked; toast("تم حفظ تأكيدات القراءة"); } catch { e.target.checked=!e.target.checked; toast("تعذّر الحفظ"); } };
    q("#secNoAdd").onchange = async e => { try { await updateDoc(doc(db,"users",S.user.uid),{noAdd:e.target.checked}); S.me.noAdd=e.target.checked; toast("تم حفظ إعداد الإضافة"); } catch { e.target.checked=!e.target.checked; toast("تعذّر الحفظ"); } };
    q("#secUnknown").onchange = e => LS.set("quiet_unknown",e.target.checked);
    q("#secPreview").onchange = e => { LS.set("lcards",e.target.checked); if(S.chat?.lastDocs) renderMsgs(S.chat.lastDocs); };
    sh.querySelectorAll("[data-settings]").forEach(b => b.onclick = () => openSettingsSection(b.dataset.settings));
    return sh;
  }
  if (id === "privacyCalls") { const sh = settingsPage("المكالمات", "تحكم في الاتصالات الصوتية والمرئية داخل ES Chat Pro.", `${switchRow("pcUnknown",LS.get("quiet_unknown",false),"كتم المتصلين غير المعروفين","لا ترن المكالمات من حسابات بلا محادثة سابقة")}${switchRow("pcEffects",LS.get("call_effects",true),"تأثيرات الكاميرا","السماح بتأثيرات الكاميرا في مكالمات الفيديو")}${switchRow("pcProtect",LS.get("call_protect",true),"حماية عنوان الاتصال","استخدم طبقة الحماية المتاحة في المتصفح عند الاتصال")}`);const q=x=>sh.querySelector(x);q("#pcUnknown").onchange=e=>LS.set("quiet_unknown",e.target.checked);q("#pcEffects").onchange=e=>LS.set("call_effects",e.target.checked);q("#pcProtect").onchange=e=>LS.set("call_protect",e.target.checked);return sh; }
  if (id === "privacyContacts") {
    const ids = [...new Set(S.prefs.block || [])];
    const sh = settingsPage("جهات الاتصال المحظورة", "راجع قائمة الحظر وألغِ حظر أي حساب مباشرة من هنا.", `<div class="stats"><div class="stat"><b id="blockedCount">${ids.length}</b><span>حساب محظور</span></div></div><div class="privacy-note"><b>إدارة الحظر</b><span>قائمة الحظر خاصة بحسابك وتُحفظ في تفضيلاتك. إلغاء الحظر لا يعيد المحادثة تلقائيًا إلى القائمة إذا كانت مؤرشفة.</span></div><div id="blockedUsers">${ids.length ? '<div class="empty-list">جاري تحميل الحسابات المحظورة…</div>' : '<div class="empty-list">لا توجد حسابات محظورة.</div>'}</div>`);
    const out = sh.querySelector("#blockedUsers");
    if (ids.length) (async () => {
      const rows = await Promise.all(ids.map(async uid => ({ uid, user: await getUser(uid) })));
      if (!out.isConnected) return;
      out.innerHTML = rows.map(({uid,user}) => `<div class="row-item"><div class="avatar">${user?.photo ? `<img src="${esc(user.photo)}" alt="">` : esc((user?.name || "?").slice(0,1))}</div><div class="meta"><div class="name">${esc(user?.name || "مستخدم غير متاح")}</div><small><bdi>${esc(user?.username ? "@" + user.username : uid.slice(0,10))}</bdi></small></div><button type="button" class="btn-mini ghost" data-unblock="${esc(uid)}">إلغاء الحظر</button></div>`).join("");
      out.querySelectorAll("[data-unblock]").forEach(btn => btn.onclick = async () => { const uid=btn.dataset.unblock; btn.disabled=true; try { await savePrefs({block:(S.prefs.block||[]).filter(x=>x!==uid)}); toast("تم إلغاء الحظر"); openSettingsSection("privacyContacts"); } catch { btn.disabled=false; toast("تعذّر حفظ التغيير"); } });
    })();
    return sh;
  }
  if (id === "privacyLock") { const sh=settingsPage("قفل التطبيق والمحادثات", "حماية محلية للجلسة الحالية. لا يتم إرسال رمز القفل إلى Firebase.", `${switchRow("lockApp",LS.get("app_lock",false),"قفل التطبيق","تفعيل حالة القفل المحلية عند مغادرة التطبيق")}${switchRow("lockChat",LS.get("chat_lock",false),"قفل المحادثات الخاصة","إخفاء معاينات المحادثات الخاصة على هذا الجهاز")}<p class="hint">هذه الإعدادات محلية لهذا المتصفح. لا تعتبر بديلًا عن قفل نظام الهاتف أو كلمة مرور الحساب.</p>`);sh.querySelector("#lockApp").onchange=e=>{LS.set("app_lock",e.target.checked);toast(e.target.checked?"تم تفعيل القفل المحلي":"تم إيقاف القفل المحلي");};sh.querySelector("#lockChat").onchange=e=>LS.set("chat_lock",e.target.checked);return sh; }
  if (id === "privacyAdvanced") { const sh=settingsPage("الخصوصية المتقدمة", "خيارات تقلل البيانات الظاهرة أثناء التصفح والاتصال.", `${switchRow("paLinks",!LS.get("lcards",true),"تعطيل معاينات الروابط","لا تُنشئ بطاقة معاينة للرابط")}${switchRow("paIP",LS.get("call_protect",true),"حماية عنوان الاتصال","تفضيل طبقات الحماية المتاحة للمكالمات")}`);sh.querySelector("#paLinks").onchange=e=>{LS.set("lcards",!e.target.checked);if(S.chat?.lastDocs)renderMsgs(S.chat.lastDocs);};sh.querySelector("#paIP").onchange=e=>LS.set("call_protect",e.target.checked);return sh; }
  if (id === "privacyCheckup") { const sh=settingsPage("فحص الخصوصية", "مراجعة سريعة لأهم إعدادات الحماية في حسابك.", `<div class="privacy-note"><b>${ic(me.hideLastSeen?"check":"warning",15)} الظهور</b><span>${me.hideLastSeen?"آخر ظهورك مخفي":"آخر ظهورك ظاهر للحسابات المسموح لها"}</span></div><div class="privacy-note"><b>${ic(me.readReceipts!==false?"check":"warning",15)} تأكيدات القراءة</b><span>${me.readReceipts!==false?"مفعّلة":"متوقفة"}</span></div><div class="privacy-note"><b>${ic("shield", 15)} تشفير المحادثات الخاصة</b><span>يتم استخدام E2EE عند توفر مفاتيح الطرفين.</span></div><button type="button" class="btn-primary" id="pcBack">مراجعة الخصوصية</button>`);sh.querySelector("#pcBack").onclick=()=>openSettingsSection("privacy");return sh; }
  if (id === "notifications") {
    const perm = canNotify() ? Notification.permission : "unsupported";
    const sh = settingsPage("الإشعارات والأصوات", "تحكم في التنبيهات محليًا، وحدد ساعات الهدوء. بعض الخيارات تعتمد على دعم المتصفح وإذنه.", `${perm === "denied" ? `<div class="hint err">إذن الإشعارات مرفوض من المتصفح. فعّله من إعدادات الموقع ثم أعد المحاولة.</div>` : perm === "unsupported" ? `<div class="hint">المتصفح الحالي لا يدعم إشعارات النظام؛ تظل إعدادات الصوت وساعات الهدوء متاحة.</div>` : ""}${switchRow("nPush", prefs.notifs && perm === "granted", "إشعارات الرسائل", "تنبيه عند وصول رسالة جديدة")}${switchRow("nSound", prefs.sound, "أصوات التنبيه", "تشغيل صوت قصير عند وصول رسالة")}${switchRow("nPrev", prefs.preview, "إظهار نص الرسالة", "عند الإيقاف، لا تعرض الرسائل الجديدة نصها في إشعار النظام")}${switchRow("nQuiet", LS.get("quiet",false), "ساعات الهدوء", "إيقاف إشعارات التطبيق وأصواته خلال الفترة المحددة")}<div class="field qrow"><label for="nFrom">من</label><input type="time" id="nFrom" value="${esc(LS.get("qFrom","23:00"))}"><label for="nTo">إلى</label><input type="time" id="nTo" value="${esc(LS.get("qTo","07:00"))}"></div><p class="hint" id="quietHelp">الفترة الحالية: ${esc(LS.get("qFrom","23:00"))} – ${esc(LS.get("qTo","07:00"))}. تعمل الفترة العابرة لمنتصف الليل تلقائيًا.</p><div class="actions"><button class="btn-ghost" id="nTest" ${perm === "unsupported" ? "disabled" : ""}>تجربة إشعار</button><button class="btn-ghost" id="nCheck">فحص الإشعارات</button></div>`);
    const q=x=>sh.querySelector(x);
    q("#nPush").onchange=async e=>{if(e.target.checked){if(!canNotify()){e.target.checked=false;toast("المتصفح لا يدعم الإشعارات");return;}const p=await enableNotifs();if(p!=="granted"){e.target.checked=false;LS.set("notifs",false);return;}LS.set("notifs",true);registerPush();}else{LS.set("notifs",false);unregisterPush();}};
    q("#nSound").onchange=e=>{LS.set("sound",e.target.checked);if(e.target.checked)beep();};
    q("#nPrev").onchange=e=>LS.set("preview",e.target.checked);
    q("#nQuiet").onchange=e=>LS.set("quiet",e.target.checked);
    const saveQuietTime=()=>{const from=q("#nFrom").value||"23:00",to=q("#nTo").value||"07:00";LS.set("qFrom",from);LS.set("qTo",to);q("#quietHelp").textContent=`الفترة الحالية: ${from} – ${to}. تعمل الفترة العابرة لمنتصف الليل تلقائيًا.`;};
    q("#nFrom").onchange=saveQuietTime;q("#nTo").onchange=saveQuietTime;
    q("#nCheck").onclick=runPushCheck;
    q("#nTest").onclick=async()=>{if(!canNotify()){toast("المتصفح لا يدعم الإشعارات");return;}if(Notification.permission!=="granted"){const p=await enableNotifs();if(p!=="granted")return;}showNotif("ES Chat Pro",prefs.preview?"ده إشعار تجريبي":"رسالة جديدة","test");beep();};
    return sh;
  }
  if (id === "chats") {
    const sh = settingsPage("إعدادات المحادثات", "تحكم في شكل الرسائل والوسائط والأدوات اليومية.", `${switchRow("cLinks",LS.get("lcards",true),"معاينة الروابط","عرض بطاقة مختصرة عند إرسال رابط ES Chat Pro")}${switchRow("cDense",LS.get("dens","n")==="c","الوضع المدمج","مسافات أصغر لعرض رسائل أكثر")}${switchRow("cMotion",LS.get("motion",true),"الحركات والانتقالات","إيقافها للأجهزة البطيئة")}${switchRow("c24",LS.get("h24",false),"تنسيق 24 ساعة","عرض الوقت بصيغة 24 ساعة")}${switchRow("cEnter",LS.get("send_enter",false),"الإرسال بزر Enter","استخدم Shift+Enter لسطر جديد عند التفعيل")}${settingsRow("folders","▣","مجلدات الدردشة",`${S.prefs.labels.length} مجلد`)}${settingsRow("quick","↯","الردود السريعة",`${S.prefs.quick.length} اختصار`)}${settingsRow("stars","★","الرسائل المميزة",`${S.prefs.stars.length} رسالة`)}${settingsRow("chatMedia","▧","الوسائط والتنزيل","التنزيل التلقائي وحفظ الوسائط")}${settingsRow("drafts","◌","المسودات","إدارة المسودات المحلية لكل محادثة")}${settingsRow("hiddenChats","▣","المحادثات المخفية",`${(S.prefs.hiddenChats||[]).length} محادثة`)}`); const q=x=>sh.querySelector(x); q("#cLinks").onchange=e=>{LS.set("lcards",e.target.checked);if(S.chat?.lastDocs)renderMsgs(S.chat.lastDocs);};q("#cDense").onchange=e=>{LS.set("dens",e.target.checked?"c":"n");applyTheme();};q("#cMotion").onchange=e=>{LS.set("motion",e.target.checked);applyTheme();};q("#c24").onchange=e=>{LS.set("h24",e.target.checked);if(S.chat?.lastDocs)renderMsgs(S.chat.lastDocs);};q("#cEnter").onchange=e=>LS.set("send_enter",e.target.checked);sh.querySelectorAll("[data-settings]").forEach(b=>b.onclick=()=>({folders:manageLabels,quick:manageQuick,stars:openStars,chatMedia:()=>openSettingsSection("chatMedia"),drafts:()=>openSettingsSection("drafts"),hiddenChats:()=>openSettingsSection("hiddenChats")}[b.dataset.settings]?.()));return sh;
  }
  if (id === "chatMedia" || id === "data") return dataPage();
  if (id === "storage") return storagePage();
  if (id === "adMobile") return adPage("mobile");
  if (id === "adWifi") return adPage("wifi");
  if (id === "hiddenChats") {
    const ids = [...new Set(S.prefs.hiddenChats || [])];
    const rows = ids.map(id => { const c = S.chats.find(x => x.id === id); const peer = c && c._t === "dm" ? peerOf(c) : ""; const u = peer ? (S.users.get(peer) || {}) : {}; return `<div class="device-card"><b>${esc((peer && contactName(peer, "")) || u.name || (c && c.name) || "محادثة مخفية")}</b><small>${esc(id)}</small><button type="button" class="btn-ghost" data-restore-hidden="${esc(id)}">إرجاع لقائمة المحادثات</button></div>`; }).join("");
    const sh = settingsPage("المحادثات المخفية", "إخفاء الشات لا يحذف الرسائل المشتركة. تقدر ترجّع أي محادثة لقائمتك من هنا.", `${rows || '<div class="empty-list">مفيش محادثات مخفية.</div>'}`);
    sh.querySelectorAll("[data-restore-hidden]").forEach(btn => btn.onclick = async () => { const id = btn.dataset.restoreHidden; const old = [...(S.prefs.hiddenChats || [])]; const next = old.filter(x => x !== id); btn.disabled = true; S.prefs = { ...S.prefs, hiddenChats: next }; try { await setDoc(prefsRef(), { hiddenChats: next }, { merge: true }); renderList(); toast("رجعت المحادثة لقائمتك"); openSettingsSection("hiddenChats"); } catch { S.prefs = { ...S.prefs, hiddenChats: old }; btn.disabled = false; toast("تعذّر الحفظ؛ جرّب تاني"); } });
    return sh;
  }
  if (id === "drafts") { const ks=Object.keys(localStorage).filter(k=>k.startsWith("es_draft_"));const sh=settingsPage("المسودات","المسودات محفوظة محليًا لكل محادثة ولا تُرسل إلى الخادم.",`<div class="stats"><div class="stat"><b>${ks.length}</b><span>مسودة محفوظة</span></div></div><div class="actions"><button class="btn-danger" id="clearDrafts">مسح كل المسودات</button></div>`);sh.querySelector("#clearDrafts").onclick=()=>{if(!confirm("مسح كل المسودات من هذا الجهاز؟"))return;ks.forEach(k=>localStorage.removeItem(k));toast("تم مسح المسودات");openSettingsSection("drafts");};return sh; }
  if (id === "appearance") {
    const sh = settingsPage("المظهر", "خصص ألوان ES Chat Pro وخلفية الرسائل وحجم الخط.", `<div class="panel-h">اللون الرئيسي</div><div class="swatches">${ACCENTS.map(([k,c,t])=>`<button type="button" class="sw big ${LS.get("accent","blue")==k?"on":""}" data-acc="${k}" style="background:${c}" aria-label="${t}" title="${t}"></button>`).join("")}</div><div class="panel-h">خلفية الرسائل</div><div class="seg3">${WALLS.map(([k,t])=>`<button type="button" class="${LS.get("wp","dots")==k?"on":""}" data-wp="${k}">${t}</button>`).join("")}</div><div class="panel-h">حجم الخط</div><div class="seg3">${[["s","صغير"],["m","متوسط"],["l","كبير"]].map(([k,t])=>`<button type="button" class="${LS.get("fs","m")==k?"on":""}" data-fs="${k}">${t}</button>`).join("")}</div>`);sh.querySelectorAll("[data-acc]").forEach(b=>b.onclick=()=>{LS.set("accent",b.dataset.acc);applyTheme();sh.querySelectorAll("[data-acc]").forEach(x=>x.classList.toggle("on",x===b));});sh.querySelectorAll("[data-wp]").forEach(b=>b.onclick=()=>{LS.set("wp",b.dataset.wp);applyTheme();sh.querySelectorAll("[data-wp]").forEach(x=>x.classList.toggle("on",x===b));});sh.querySelectorAll("[data-fs]").forEach(b=>b.onclick=()=>{LS.set("fs",b.dataset.fs);applyTheme();sh.querySelectorAll("[data-fs]").forEach(x=>x.classList.toggle("on",x===b));});return sh;
  }
  if (id === "devices") return openLinkedDevices();
  if (id === "language") { const active = me.lang === "en" ? "en" : "ar"; const sh=settingsPage("اللغة / Language","اختر لغة الواجهة. يتغير اتجاه الصفحة بين RTL وLTR، ويُحفظ الاختيار على الحساب والجهاز.",`<div class="seg3"><button type="button" id="langAr" class="${active==="ar"?"on":""}">العربية</button><button type="button" id="langEn" class="${active==="en"?"on":""}">English</button></div><div class="privacy-note"><b>اتجاه الواجهة</b><span id="langDirection">${active === "en" ? "English · Left to right (LTR)" : "العربية · من اليمين إلى اليسار (RTL)"}</span></div><p class="hint">تُعرض الرسائل التي توفر textAr وtextEn باللغة المختارة. بقية النصوص التي لم تُترجم بعد ستظل بلغتها الأصلية.</p>`);const set=async lang=>{lang=lang==="en"?"en":"ar";const prev=me.lang==="en"?"en":"ar";applyAppLanguage(lang);sh.querySelectorAll(".seg3 button").forEach(x=>x.classList.toggle("on",x.id===(lang==="en"?"langEn":"langAr")));sh.querySelector("#langDirection").textContent=lang==="en"?"English · Left to right (LTR)":"العربية · من اليمين إلى اليسار (RTL)";try{await updateDoc(doc(db,"users",S.user.uid),{lang});await setDoc(doc(db,"users",S.user.uid,"public","profile"),{lang}, {merge:true});S.me.lang=lang;toast(lang==="en"?"Language saved":"تم حفظ اللغة");}catch(e){console.error("save language",e);applyAppLanguage(prev);sh.querySelectorAll(".seg3 button").forEach(x=>x.classList.toggle("on",x.id===(prev==="en"?"langEn":"langAr")));sh.querySelector("#langDirection").textContent=prev==="en"?"English · Left to right (LTR)":"العربية · من اليمين إلى اليسار (RTL)";toast("تعذّر حفظ اللغة على الحساب؛ تم إرجاع الاختيار السابق");}};sh.querySelector("#langAr").onclick=()=>set("ar");sh.querySelector("#langEn").onclick=()=>set("en");return sh; }
  if (id === "power") { const sh=settingsPage("توفير الطاقة","قلل الحركة واستهلاك الموارد على الأجهزة الضعيفة.",`${switchRow("pMotion",!LS.get("motion",true),"تقليل الحركة","إيقاف الانتقالات تلقائيًا")}${switchRow("pQuiet",LS.get("quiet",false),"توفير الإشعارات","استخدم ساعات الهدوء لتقليل التنبيهات")}`);sh.querySelector("#pMotion").onchange=e=>{LS.set("motion",!e.target.checked);applyTheme();};sh.querySelector("#pQuiet").onchange=e=>LS.set("quiet",e.target.checked);return sh; }
  return settingsPage("معلومات ES Chat Pro","منصة مراسلة أصلية بخصوصية قوية وتشفير للمحادثات الخاصة.",`<div class="privacy-note"><b>ES Chat Pro</b><span>الإصدار v38 · واجهة عربية وإنجليزية · E2EE للمحادثات الخاصة.</span></div>`);
}
/* ---------------- الأجهزة المرتبطة (ربط بوت بالحساب — زي واتساب) ---------------- */
async function linkDeviceApi(payload, hdrExtra = {}) {
  const headers = { "content-type": "application/json", ...hdrExtra };
  if (!hdrExtra.authorization && S.user) headers.authorization = `Bearer ${await S.user.getIdToken()}`;
  const r = await fetch("/api/link-device", { method: "POST", headers, body: JSON.stringify(payload) });
  let data = {}; try { data = await r.json(); } catch {}
  if (!r.ok) throw Object.assign(new Error(data.error || "request failed"), { status: r.status, data });
  return data;
}
function linkDeviceErr(e) {
  const m = e && e.message;
  if (m === "too many pending requests") return "في أكواد كتير شغالة دلوقتي، استنى شوية وجرّب تاني";
  if (m === "linked device limit reached") return "وصلت للحد الأقصى من الأجهزة المرتبطة (20). امسح جهاز قديم الأول";
  if (m === "expired") return "الكود انتهى، اطلب كود جديد";
  if (m === "bad_code") return "الكود غلط";
  if (m === "already_used") return "الكود ده اتستخدم قبل كده";
  if (m === "too_many_attempts") return "محاولات كتير غلط؛ اطلب كود جديد";
  if (e && e.status === 401) return "سجّل دخول تاني وجرّب";
  return "تعذّر تنفيذ العملية";
}
async function openLinkedDevices() {
  const did = LS.get("device_label", "") || ((navigator.userAgent.match(/Android|iPhone|iPad/i) || ["جهاز متصفح"])[0] + " · " + Math.random().toString(36).slice(2, 7));
  LS.set("device_label", did);
  const sh = settingsPage("الأجهزة المرتبطة", "اربط بوت بحسابك عشان يشتغل في مجموعاتك اللي إنت عضو أو مشرف فيها — زي فكرة ربط الأجهزة في واتساب بالظبط. ربط بوت مش بيديه وصول لمحادثاتك الخاصة المشفّرة أبدًا.", `
    <div class="device-card"><b>هذا الجهاز</b><span>${esc(did)}</span><small>المتصفح: ${esc(navigator.userAgent.slice(0, 90))}</small><i>مفتاح E2EE محلي</i></div>
    <div class="panel-h">ربط بوت بحسابك</div>
    <div class="device-card"><small>اضغط "توليد كود" وهاتخد كود صالح لمدة دقيقة تقريبًا. ادّي الكود ده (أو الرابط) لصاحب البوت عشان يأكّده من سيرفره بالرمز السري بتاعه.</small><div class="actions"><button type="button" class="btn-primary" id="ldGenerate">توليد كود ربط</button></div><div id="ldPending"></div></div>
    <div class="panel-h">الأجهزة/البوتات المرتبطة</div>
    <div id="ldList"><div class="hint">جارٍ التحميل…</div></div>
    <div class="privacy-note"><b>خصوصية الربط</b><span>تسجيل الخروج يلغي جلسة المتصفح الحالية فقط. إلغاء ربط بوت بيوقف صلاحيته فورًا، ولا يرسل أي مفتاح تشفير خاص إلى الخادم أو للبوت.</span></div>`);
  const stopTimers = () => { clearInterval(_ldPollTimer); clearInterval(_ldCountdownTimer); _ldPollTimer = 0; _ldCountdownTimer = 0; };

  const renderList = async () => {
    const list = sh.querySelector("#ldList");
    try {
      const qs = await getDocs(query(collection(db, "users", S.user.uid, "linkedDevices"), where("status", "==", "active")));
      const rows = qs.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => ((b.linkedAt && b.linkedAt.seconds) || 0) - ((a.linkedAt && a.linkedAt.seconds) || 0));
      list.innerHTML = rows.length ? rows.map(r => `<div class="device-card"><b>${esc(r.botName || "بوت")}</b><small>نوع الربط: بوت · صلاحية: مجموعاتك وقنواتك اللي إنت عضو/مشرف فيها بس</small><div class="actions"><button type="button" class="btn-danger" data-revoke="${esc(r.id)}">إلغاء الربط</button></div></div>`).join("") : `<div class="empty-list">مفيش بوتات مرتبطة بحسابك لسه.</div>`;
      list.querySelectorAll("[data-revoke]").forEach(btn => btn.onclick = async () => {
        if (!confirm("تلغي ربط البوت ده؟ هيفقد صلاحيته على مجموعاتك فورًا.")) return;
        btn.disabled = true;
        try { await linkDeviceApi({ action: "revoke", deviceId: btn.dataset.revoke }); toast("اتلغى الربط"); renderList(); }
        catch (e) { toast(linkDeviceErr(e)); btn.disabled = false; }
      });
    } catch { list.innerHTML = `<div class="empty-list">تعذّر تحميل القائمة. اتأكد إن firestore.rules منشورة.</div>`; }
  };

  sh.querySelector("#ldGenerate").onclick = async () => {
    const btn = sh.querySelector("#ldGenerate"), area = sh.querySelector("#ldPending");
    btn.disabled = true; stopTimers();
    try {
      const d = await linkDeviceApi({ action: "create" });
      let left = d.expiresInSeconds;
      const draw = () => { area.innerHTML = `<div class="device-card bm-secret-card"><b>كود الربط</b><small>صالح لمدة <span id="ldLeft">${left}</span> ثانية، بيتجدد تلقائيًا</small><input type="text" class="bm-secret" readonly dir="ltr" value="${esc(d.code)}"><div class="actions"><button type="button" class="btn-ghost" id="ldCopyCode">نسخ الكود</button><button type="button" class="btn-ghost" id="ldCopyLink">نسخ رابط الربط</button></div></div>`; area.querySelector("#ldCopyCode").onclick = () => copyText(d.code, "اتنسخ الكود"); area.querySelector("#ldCopyLink").onclick = () => copyText(d.qrPayload, "اتنسخ رابط الربط"); };
      draw();
      _ldCountdownTimer = setInterval(() => { if (!area.isConnected) return clearInterval(_ldCountdownTimer); left -= 1; const el = sh.querySelector("#ldLeft"); if (el) el.textContent = Math.max(left, 0); if (left <= 0) clearInterval(_ldCountdownTimer); }, 1000);
      _ldPollTimer = setInterval(async () => {
        if (!area.isConnected) return clearInterval(_ldPollTimer);
        try {
          const s = await linkDeviceApi({ action: "status", requestId: d.requestId });
          if (s.status === "confirmed") { stopTimers(); area.innerHTML = ""; btn.disabled = false; toast("اتربط البوت بنجاح"); renderList(); }
          else if (s.status === "expired") { stopTimers(); area.innerHTML = `<div class="hint">انتهت صلاحية الكود. اضغط توليد كود من جديد.</div>`; btn.disabled = false; }
        } catch { /* تجاهل أخطاء الاستطلاع المؤقتة */ }
      }, 3000);
    } catch (e) { toast(linkDeviceErr(e)); btn.disabled = false; }
  };
  renderList();
}
/* ---------------- مدير بوتات الموقع (ES Bots) ---------------- */
async function botApi(payload) {
  const token = await S.user.getIdToken();
  const r = await fetch("/api/bot", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(payload) });
  let data = {}; try { data = await r.json(); } catch {}
  if (!r.ok) throw Object.assign(new Error(data.error || "request failed"), { status: r.status, data });
  return data;
}
function botErr(e) {
  const m = e && e.message, code = e && e.data && e.data.code;
  if (code === "env-missing" || code === "env-bad-json") return "متغير FIREBASE_SERVICE_ACCOUNT على Vercel مش متظبط";
  if (e && e.status === 401) return "سجّل دخول تاني وجرّب";
  if (m === "https webhook required") return "لازم رابط https عام وصالح (مش محلي)";
  if (m === "name required") return "الاسم لازم يكون حرفين على الأقل";
  if (m === "webhook_not_configured") return "اضبط رابط Webhook الأول والبوت لازم يكون شغّال";
  if (m === "webhook_delivery_failed") return "الـ Webhook ماردّش بنجاح (لازم 200 لحد 299)";
  if (m === "bot limit reached") return "وصلت للحد الأقصى (20 بوت). احذف بوت قديم الأول";
  if (m === "request failed") return "مش قادر أوصل للخادم (/api/bot)";
  return "تعذّر تنفيذ العملية";
}
const botSecretCard = (label, value) => `<div class="device-card bm-secret-card"><b>${esc(label)}</b><small>احفظه الآن في مكان آمن؛ مش هيظهر تاني.</small><input type="text" class="bm-secret" readonly dir="ltr" value="${esc(value)}"><div class="actions"><button type="button" class="btn-primary" data-bm-copy>نسخ</button></div></div>`;
function showBotSecret(area, label, value) {
  area.innerHTML = botSecretCard(label, value);
  area.querySelector("[data-bm-copy]").onclick = () => copyText(value, "اتنسخ");
}
async function openBotsManager() {
  const sh = settingsPage("مدير البوتات", "أنشئ بوتات لموقعك وتحكم في أسمائها وأوامرها وWebhook والرمز السري. ده خاص بـ ES Chat Pro.", `<div id="bmBody"><div class="hint">جارٍ التحميل…</div></div>`);
  const body = sh.querySelector("#bmBody");
  let fresh = null;
  const render = async () => {
    let rows = [];
    try {
      const qs = await getDocs(query(collection(db, "bots"), where("owner", "==", S.user.uid)));
      rows = qs.docs.map(d => ({ id: d.id, ...d.data() })).filter(b => !b.deleted);
    } catch (e) { body.innerHTML = `<div class="empty-list">تعذّر تحميل البوتات. اتأكد إن firestore.rules منشورة.</div>`; return; }
    rows.sort((a, b) => ((b.createdAt && b.createdAt.seconds) || 0) - ((a.createdAt && a.createdAt.seconds) || 0));
    body.innerHTML = `<div id="bmFresh"></div>
      <div class="device-card"><b>ESFather</b><small>بوتك الخاص جوه موقعك — محادثة خاصة مشفّرة (E2EE) زي أي شات عادي، بدون أي علاقة بتيليجرام.</small><div class="actions"><button type="button" class="btn-primary" id="bmOpenESFather">فتح البوت</button></div></div>
      <div class="panel-h">إنشاء بوت جديد</div>
      <div class="field"><label for="bmName">اسم البوت</label><input type="text" id="bmName" maxlength="40" placeholder="مثال: بوت الدعم" autocomplete="off"></div>
      <div class="actions"><button type="button" class="btn-primary" id="bmCreate">إنشاء بوت</button></div>
      <div class="hint" id="bmCreateMsg"></div>
      <div class="panel-h">بوتاتك (${rows.length})</div>
      ${rows.length ? rows.map(b => `<button type="button" class="settings-row" data-bot="${esc(b.id)}"><span class="settings-row-icon">${ic("bot", 22)}</span><span class="settings-row-copy"><b>${esc(b.name)}</b><small><bdi>@${esc(b.id)}</bdi> · ${b.active ? "شغّال" : "موقوف"} · ${(b.commands || []).length} أمر · ${(b.groups || []).length} مجموعة</small></span><span class="settings-row-arrow">${ic("chev", 18)}</span></button>`).join("") : `<div class="empty-list">لسه معندكش بوتات. اكتب اسم فوق واضغط إنشاء.</div>`}`;
    if (fresh) showBotSecret(body.querySelector("#bmFresh"), `رمز البوت «${fresh.name}»`, fresh.token);
    body.querySelector("#bmCreate").onclick = async e => {
      const btn = e.currentTarget, name = body.querySelector("#bmName").value.trim(), msg = body.querySelector("#bmCreateMsg");
      if (name.length < 2) { msg.textContent = "الاسم لازم حرفين على الأقل."; return; }
      btn.disabled = true; msg.textContent = "جارٍ الإنشاء…";
      try { const d = await botApi({ action: "create", name }); fresh = { name: d.bot.name, token: d.token }; await render(); toast("اتعمل البوت"); }
      catch (er) { msg.textContent = botErr(er); btn.disabled = false; }
    };
    body.onclick = e => {
      const r = e.target.closest("[data-bot]"); if (r) { fresh = null; openBotDetail(r.dataset.bot, render); return; }
      const esf = e.target.closest("#bmOpenESFather"); if (esf) { esf.disabled = true; openBotPM().finally(() => { esf.disabled = false; }); }
    };
  };
  render();
}
async function openBotDetail(bid, onChange) {
  let b;
  try { const s = await getDoc(doc(db, "bots", bid)); if (!s.exists() || s.data().owner !== S.user.uid || s.data().deleted) throw new Error("nf"); b = { id: s.id, ...s.data() }; }
  catch { toast("تعذّر تحميل البوت"); return; }
  const st = b.settings || {};
  const cmdText = (b.commands || []).map(c => `${c.command} | ${c.ar || ""} | ${c.en || ""}`).join("\n");
  const sh = settingsPage(esc(b.name), `<bdi>@${esc(b.id)}</bdi> · <span id="bdState">${b.active ? "شغّال" : "موقوف"}</span>`, `
    <div id="bdSecret"></div>
    <div class="device-card"><b>الرمز السري</b><small dir="ltr">${esc(b.tokenPrefix || "esb_live_")}…</small><small>الرمز بيظهر مرة واحدة عند إصداره، والخادم بيخزن بصمته بس. لو ضاع أصدر رمز جديد (القديم بيتلغي).</small><div class="actions"><button type="button" class="btn-primary" id="bdRotate">إصدار رمز جديد</button><button type="button" class="btn-ghost" id="bdToggle">${b.active ? "إيقاف البوت" : "تشغيل البوت"}</button></div></div>
    <div class="device-card"><b>محادثة خاصة مشفّرة</b><small>افتح شات خاص مع البوت ده جوه موقعك — نفس تشفير الشات الخاص العادي (E2EE)، البوت عنده مفتاحه الخاص بس.</small><div class="actions"><button type="button" class="btn-primary" id="bdOpenPM">فتح البوت</button></div></div>
    <div class="panel-h">الاسم</div>
    <div class="field"><label for="bdUser">اسم المستخدم @username</label><input type="text" id="bdUser" maxlength="20" dir="ltr" autocapitalize="none" autocomplete="off" spellcheck="false" placeholder="mybot_name" value="${esc(b.username && !/^[0-9a-f]{18}$/.test(b.username) ? b.username : "")}"><small class="hint">3-20 حرف، يبدأ بحرف، أرقام وشرطة سفلية فقط. فريد لكل بوت.</small></div>
    <div class="actions"><button type="button" class="btn-primary" id="bdSaveUser">حفظ الـ Username</button></div>
    <div class="hint" id="bdUserMsg"></div>
    <div class="field"><label for="bdNameAr">الاسم بالعربي</label><input type="text" id="bdNameAr" maxlength="40" value="${esc(b.nameAr || b.name)}"></div>
    <div class="field"><label for="bdNameEn">الاسم بالإنجليزي</label><input type="text" id="bdNameEn" dir="ltr" maxlength="40" value="${esc(b.nameEn || b.name)}"></div>
    <div class="actions"><button type="button" class="btn-primary" id="bdSaveName">حفظ الاسم</button></div>
    <div class="panel-h">الوصف والنبذة</div>
    <div class="field"><label for="bdDescAr">الوصف بالعربي (حتى 512)</label><textarea id="bdDescAr" rows="3" maxlength="512">${esc(b.descriptionAr || "")}</textarea></div>
    <div class="field"><label for="bdDescEn">الوصف بالإنجليزي</label><textarea id="bdDescEn" dir="ltr" rows="3" maxlength="512">${esc(b.descriptionEn || "")}</textarea></div>
    <div class="field"><label for="bdAboutAr">النبذة بالعربي (حتى 256)</label><input type="text" id="bdAboutAr" maxlength="256" value="${esc(b.aboutAr || "")}"></div>
    <div class="field"><label for="bdAboutEn">النبذة بالإنجليزي</label><input type="text" id="bdAboutEn" dir="ltr" maxlength="256" value="${esc(b.aboutEn || "")}"></div>
    <div class="actions"><button type="button" class="btn-primary" id="bdSaveText">حفظ الوصف والنبذة</button></div>
    <div class="panel-h">الأوامر</div>
    <div class="field"><label for="bdCmds">كل سطر: الأمر | الوصف بالعربي | الوصف بالإنجليزي</label><textarea id="bdCmds" dir="ltr" rows="5" placeholder="start | ابدأ | Start&#10;help | المساعدة | Help">${esc(cmdText)}</textarea></div>
    <div class="actions"><button type="button" class="btn-primary" id="bdSaveCmds">حفظ الأوامر</button></div>
    <div class="panel-h">إعدادات البوت</div>
    ${switchRow("bdJoin", st.joinGroups !== false, "السماح بإضافته للمجموعات", "لو مقفول البوت ما يقدرش ينضم لأي مجموعة")}
    ${switchRow("bdPrivacy", st.privacy !== false, "وضع الخصوصية", "البوت يشوف الأوامر والردود عليه بس في المجموعات")}
    ${switchRow("bdInline", st.inline === true, "الوضع المضمّن (Inline)", "")}
    ${switchRow("bdGeo", st.inlineGeo === true, "الموقع في الوضع المضمّن", "")}
    <div class="actions"><button type="button" class="btn-primary" id="bdSaveSettings">حفظ الإعدادات</button></div>
    <div class="device-card"><b>ES Bot Engine</b><small>المحرك يحلل أوامر البوت بصيغة /command، يحترم وضع الخصوصية، ويرفض الرسائل غير الموجهة للبوت عند تفعيل الخصوصية.</small><small>حد التشغيل الحالي: 120 تحديثًا لكل بوت في الدقيقة داخل كل نسخة خادم.</small></div>
    <div class="panel-h">Webhook</div>
    <div class="field"><label for="bdHook">رابط https لاستقبال التحديثات</label><input type="text" id="bdHook" dir="ltr" inputmode="url" placeholder="https://example.com/hook" value="${esc(b.webhookUrl || "")}"></div>
    <div class="actions"><button type="button" class="btn-primary" id="bdHookSave">حفظ الرابط</button><button type="button" class="btn-ghost" id="bdHookTest">اختبار</button><button type="button" class="btn-danger" id="bdHookDel">حذف</button></div>
    <div class="hint" id="bdHookMsg">السر بيظهر مرة واحدة بعد الحفظ، وبيتحسب بيه توقيع كل تحديث (راجع docs/BOT_API_AR.md).</div>
    <div class="panel-h">طريقة الاستخدام</div>
    <div class="device-card"><small>المجموعات المضاف فيها: ${(b.groups || []).length}. الإرسال بيتم من خادمك بالرمز السري:</small><pre class="bm-code" dir="ltr">POST /api/bot
X-ES-Bot-Token: esb_live_...
{"action":"addToGroup","groupId":"GROUP_ID","admin":true}
{"action":"sendMessage","groupId":"GROUP_ID","text":"Hello"}</pre></div>
    <div class="panel-h">الإحصائيات والسجل</div>
    <div class="device-card"><div id="bdStatsView">اضغط تحديث لعرض نشاط البوت.</div><div class="actions"><button type="button" class="btn-ghost" id="bdStatsLoad">تحديث الإحصائيات</button></div><div id="bdStatsLog"></div></div>
    <div class="panel-h">منطقة خطرة</div>
    <div class="actions"><button type="button" class="btn-danger" id="bdDelete">حذف البوت نهائيًا</button></div>`);
  const $$ = id => sh.querySelector(id), val = id => $$(id).value.trim();
  const run = async (btn, fn, ok) => { btn.disabled = true; try { await fn(); if (onChange) onChange(); if (ok) toast(ok); } catch (er) { toast(botErr(er)); } btn.disabled = false; };
  $$("#bdStatsLoad").onclick = async e => { const view = $$("#bdStatsView"), log = $$("#bdStatsLog"); e.currentTarget.disabled = true; view.textContent = "جارٍ تحميل الإحصائيات…"; try { const d = await botApi({ action: "stats", botId: b.id }); const x = d.stats || {}; view.textContent = `التحديثات: ${x.updates || 0} · الرسائل: ${x.messages || 0} · الأوامر: ${x.commands || 0} · الأزرار: ${x.callbacks || 0} · Webhook ناجح: ${x.webhookSuccess || 0} · أخطاء Webhook: ${x.webhookErrors || 0}`; log.innerHTML = (d.logs || []).slice(0, 20).map(l => `<div class="row-item"><div class="meta"><b>${esc(l.type || "event")}</b><small>${esc(l.status || "received")}${l.detail ? " · " + esc(l.detail) : ""}</small></div></div>`).join("") || `<small>لا توجد سجلات بعد.</small>`; } catch (er) { view.textContent = botErr(er); } e.currentTarget.disabled = false; };
  $$("#bdRotate").onclick = e => { if (!confirm("إصدار رمز جديد هيلغي الرمز القديم فورًا. تكمل؟")) return; run(e.currentTarget, async () => { const d = await botApi({ action: "token", botId: b.id }); showBotSecret($$("#bdSecret"), "الرمز الجديد", d.token); $$("#bdSecret").scrollIntoView({ block: "nearest" }); }, "اتصدر رمز جديد"); };
  $$("#bdOpenPM").onclick = e => { e.currentTarget.disabled = true; openBotPM(b.id).finally(() => { e.currentTarget.disabled = false; }); };
  $$("#bdToggle").onclick = e => run(e.currentTarget, async () => { const d = await botApi({ action: b.active ? "disable" : "enable", botId: b.id }); b.active = d.active; $$("#bdState").textContent = b.active ? "شغّال" : "موقوف"; $$("#bdToggle").textContent = b.active ? "إيقاف البوت" : "تشغيل البوت"; }, "اتحدّثت الحالة");
  $$("#bdSaveUser").onclick = e => {
    const msg = $$("#bdUserMsg");
    const raw = ($$("#bdUser").value || "").trim().toLowerCase();
    if (!/^[a-z][a-z0-9_]{2,19}$/.test(raw)) { msg.textContent = "Username غير صالح — 3-20 حرف، يبدأ بحرف، بدون مسافات أو رموز خاصة."; msg.className = "hint err"; return; }
    msg.textContent = "";
    run(e.currentTarget, async () => {
      const d = await botApi({ action: "setusername", botId: b.id, username: raw });
      if (d.unchanged) { msg.textContent = "الـ username لم يتغير."; msg.className = "hint"; return; }
      b.username = d.username;
      $$("#bdUser").value = d.username;
      msg.textContent = `✓ تم حفظ @${d.username} — البحث عن البوت بيشتغل فورًا.`;
      msg.className = "hint";
      toast("اتحفظ @" + d.username);
      if (onChange) onChange();
    }, "اتحفظ الـ Username");
  };
  $$("#bdSaveName").onclick = e => { const ar = val("#bdNameAr"), en = val("#bdNameEn"), name = ar || en; if (name.length < 2) { toast("الاسم لازم حرفين على الأقل"); return; } run(e.currentTarget, async () => { await botApi({ action: "setname", botId: b.id, name, nameAr: ar || name, nameEn: en || name }); b.name = name; sh.querySelector("h2").textContent = name; }, "اتحفظ الاسم"); };
  $$("#bdSaveText").onclick = e => run(e.currentTarget, async () => { await botApi({ action: "setdescription", botId: b.id, ar: val("#bdDescAr"), en: val("#bdDescEn") }); await botApi({ action: "setabouttext", botId: b.id, ar: val("#bdAboutAr"), en: val("#bdAboutEn") }); }, "اتحفظ الوصف والنبذة");
  $$("#bdSaveCmds").onclick = e => {
    const lines = $$("#bdCmds").value.split("\n").map(x => x.trim()).filter(Boolean), commands = [];
    if (lines.length > 50) { toast("أقصى عدد أوامر 50"); return; }
    for (const ln of lines) {
      const [c, ar = "", en = ""] = ln.split("|").map(x => x.trim()), command = (c || "").replace(/^\//, "").toLowerCase();
      if (!/^[a-z0-9_]{1,32}$/.test(command)) { toast(`اسم الأمر غلط: ${ln.slice(0, 30)} (حروف إنجليزي وأرقام و_ بس)`); return; }
      if (!ar && !en) { toast(`الأمر ${command} محتاج وصف`); return; }
      if (commands.some(x => x.command === command)) { toast(`الأمر ${command} متكرر`); return; }
      commands.push({ command, ar, en });
    }
    run(e.currentTarget, () => botApi({ action: "setcommands", botId: b.id, commands }), "اتحفظت الأوامر");
  };
  $$("#bdSaveSettings").onclick = e => run(e.currentTarget, () => botApi({ action: "setsettings", botId: b.id, joinGroups: $$("#bdJoin").checked, privacy: $$("#bdPrivacy").checked, inline: $$("#bdInline").checked, inlineGeo: $$("#bdGeo").checked }), "اتحفظت الإعدادات");
  $$("#bdHookSave").onclick = e => { const url = val("#bdHook"); if (!/^https:\/\//i.test(url)) { toast("لازم رابط https"); return; } run(e.currentTarget, async () => { const d = await botApi({ action: "setwebhook", botId: b.id, url }); b.webhookUrl = d.url; showBotSecret($$("#bdSecret"), "سر الـ Webhook", d.secret); $$("#bdSecret").scrollIntoView({ block: "nearest" }); }, "اتحفظ الـ Webhook"); };
  $$("#bdHookTest").onclick = e => run(e.currentTarget, async () => { $$("#bdHookMsg").textContent = "جارٍ الاختبار…"; try { await botApi({ action: "testwebhook", botId: b.id }); $$("#bdHookMsg").textContent = "الاختبار نجح ✓"; } catch (er) { $$("#bdHookMsg").textContent = botErr(er); throw er; } });
  $$("#bdHookDel").onclick = e => run(e.currentTarget, async () => { await botApi({ action: "deletewebhook", botId: b.id }); b.webhookUrl = ""; $$("#bdHook").value = ""; }, "اتحذف الـ Webhook");
  $$("#bdDelete").onclick = e => { if (!confirm(`حذف البوت «${b.name}» نهائيًا؟ الرمز هيتلغي ومش هتقدر تسترجعه.`)) return; run(e.currentTarget, async () => { await botApi({ action: "deletebot", botId: b.id }); toast("اتحذف البوت"); modalBack(); }); };
}
function openTelegramBots() {
  const key = "es_telegram_bot_catalog_v1";
  const readBots = () => { try { const x = JSON.parse(localStorage.getItem(key) || "[]"); return Array.isArray(x) ? x.filter(b => b && typeof b.name === "string" && typeof b.username === "string").slice(0, 50) : []; } catch { return []; } };
  const writeBots = rows => localStorage.setItem(key, JSON.stringify(rows.slice(0, 50)));
  const ensurePrimaryBot = () => { const rows = readBots(); if (!rows.some(b => b.username.toLowerCase() === "estfather")) { rows.unshift({name:"ESFather",username:"ESFather",note:"البوت الأساسي للمشروع — الربط المباشر يتطلب إعداد الخادم الآمن",primary:true,addedAt:new Date().toISOString()}); writeBots(rows); } }; 
  ensurePrimaryBot();
  const botRows = () => { const rows = readBots(); return rows.length ? rows.map((b,i)=>`<div class="device-card"><b>${esc(b.name)}</b><span dir="ltr">@${esc(b.username.replace(/^@/,""))}</span><small>${esc(b.note || "بدون ملاحظات")}</small><div class="actions"><button class="btn-ghost" type="button" data-copy-bot="${i}">نسخ بيانات البوت</button><button class="btn-danger" type="button" data-remove-bot="${i}">حذف من القائمة</button></div></div>`).join("") : `<div class="empty-list">لسه مفيش بوتات في قائمتك. أنشئ بوت من BotFather ثم أضفه هنا للتنظيم.</div>`; };
  const sh = settingsPage("مدير بوتات تيليجرام", "إدارة بوتك ESFather وتجهيز التكامل الآمن مع Telegram Bot API. لا تحفظ أي توكنات في الواجهة؛ لا تضع التوكن داخل المتصفح.", `
    <div class="device-card"><b>البوت الأساسي: ESFather</b><span dir="ltr">@ESFather</span><small>تم تعيين الاسم الذي زودتني به كبوتك الأساسي. حالة الربط الفعلية تُفحص من الخادم عند ضبط متغيرات البيئة.</small><div class="actions"><button type="button" class="btn-primary" id="tgCheckConnection">فحص اتصال Telegram</button><a class="btn-ghost" href="https://t.me/ESFather" target="_blank" rel="noopener noreferrer" style="text-decoration:none;display:inline-flex;align-items:center">فتح البوت ↗</a></div><div id="tgConnectionStatus" class="hint" role="status">لم يتم فحص الاتصال بعد.</div></div>
    <div class="panel-h">اختيار البوت المتصل بالخادم</div><div class="field"><label for="tgServerBotSelect">البوت الذي ستُطبّق عليه الإعدادات</label><select id="tgServerBotSelect"><option value="primary">البوت الأساسي</option></select></div><div class="actions"><button type="button" class="btn-ghost" id="tgReloadServerBots">تحديث قائمة البوتات المتصلة</button></div><div id="tgServerBotsStatus" class="hint" role="status">يتم تحميل البوتات المعرفة في إعدادات الخادم.</div>
    <div class="panel-h">حالة Webhook والتشخيص</div><div class="device-card"><small>اعرف هل تيليجرام يرسل التحديثات إلى Webhook، وعدد التحديثات المنتظرة وآخر خطأ مسجل. لا يتم عرض مسار Webhook كاملًا أو أي أسرار.</small><div class="actions"><button type="button" class="btn-primary" id="tgWebhookCheck">فحص حالة Webhook</button></div><div id="tgWebhookStatus" class="hint" role="status">اضغط للفحص المباشر من Telegram.</div></div>
    <div class="panel-h">لوحة صحة جميع البوتات</div><div class="device-card"><small>فحص مستقل لكل بوت معرف في إعدادات الخادم، مع إظهار حالة الاتصال وWebhook وآخر خطأ دون كشف التوكن أو مسار Webhook الكامل.</small><div class="actions"><button type="button" class="btn-primary" id="tgFleetDiagnostics">فحص جميع البوتات</button></div><div id="tgFleetStatus" class="hint" role="status">اضغط لبدء الفحص الشامل.</div><div id="tgFleetCards"></div></div>
    <div class="panel-h">إدارة إعدادات البوت الفعلية</div>
    <div class="field"><label for="tgLiveName">اسم البوت</label><input id="tgLiveName" maxlength="64" placeholder="اسم البوت الجديد"></div><button type="button" class="btn-primary" id="tgSaveName">حفظ الاسم في تيليجرام</button>
    <div class="field"><label for="tgLiveDescription">الوصف (حتى 512 حرفًا)</label><textarea id="tgLiveDescription" maxlength="512" rows="3" placeholder="وصف البوت"></textarea></div><button type="button" class="btn-primary" id="tgSaveDescription">حفظ الوصف</button>
    <div class="field"><label for="tgLiveShort">النبذة القصيرة (حتى 120 حرفًا)</label><input id="tgLiveShort" maxlength="120" placeholder="نبذة تظهر في الملف الشخصي"></div><button type="button" class="btn-primary" id="tgSaveShort">حفظ النبذة</button>
    <div class="field"><label for="tgLiveCommands">قائمة الأوامر — كل سطر: command - description</label><textarea id="tgLiveCommands" rows="5" dir="ltr" placeholder="start - Start the bot
help - Show help"></textarea></div><div class="actions"><button type="button" class="btn-primary" id="tgSaveCommands">حفظ الأوامر</button><button type="button" class="btn-ghost" id="tgLoadCommands">تحميل الأوامر الحالية</button><button type="button" class="btn-danger" id="tgDeleteCommands">مسح قائمة الأوامر</button></div>
    <div id="tgManageStatus" class="hint" role="status">تعديل الإعدادات الفعلية متاح لمالك البوت بعد إعداد متغيرات الخادم.</div>
    <div class="privacy-note"><b>إعداد الربط الآمن على Vercel</b><span>أضف TELEGRAM_BOT_TOKEN و TELEGRAM_MANAGER_OWNER_UID و FIREBASE_SERVICE_ACCOUNT في Environment Variables، ثم أعد النشر. التوكن يبقى في الخادم ولا يظهر في الواجهة. عمليات التعديل مقيدة بمعرّف المالك.</span></div>
    <div class="privacy-note"><b>إنشاء بوت جديد</b><span>افتح BotFather الرسمي واضغط Start، ثم أرسل /newbot واتبع الخطوات لاختيار الاسم والـ username.</span></div>
    <div class="actions"><a class="btn-primary" href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" style="text-decoration:none;display:inline-flex;align-items:center;justify-content:center">فتح @BotFather ↗</a><button type="button" class="btn-ghost" id="tgCommands">أوامر BotFather</button></div>
    <div class="panel-h">إضافة بوت إلى قائمتك</div>
    <div class="field"><label for="tgBotName">اسم البوت</label><input id="tgBotName" maxlength="64" placeholder="مثال: ES Assistant"></div>
    <div class="field"><label for="tgBotUser">Username</label><input id="tgBotUser" maxlength="40" dir="ltr" placeholder="ES_Assistant_bot" autocomplete="off"></div>
    <div class="field"><label for="tgBotNote">ملاحظات (اختياري)</label><input id="tgBotNote" maxlength="180" placeholder="الغرض من البوت أو مكان استضافته"></div>
    <button type="button" class="btn-primary" id="tgAddBot">إضافة للقائمة</button>
    <p class="hint">تنبيه أمان: لا تضع توكن البوت في هذه الصفحة أو في محادثة عامة. القائمة محفوظة محليًا على هذا الجهاز فقط، وليست مزامنة مع حسابك.</p>
    <div class="panel-h">بوتاتي المحفوظة محليًا</div><div id="tgBotList">${botRows()}</div>
    <div class="panel-h">أوامر سريعة</div><div class="menu"><button class="mrow" type="button" data-tgcmd="/newbot"><span>/newbot</span><small>إنشاء بوت</small></button><button class="mrow" type="button" data-tgcmd="/mybots"><span>/mybots</span><small>إدارة بوتاتي</small></button><button class="mrow" type="button" data-tgcmd="/setname"><span>/setname</span><small>تغيير الاسم</small></button><button class="mrow" type="button" data-tgcmd="/setdescription"><span>/setdescription</span><small>الوصف</small></button><button class="mrow" type="button" data-tgcmd="/setabouttext"><span>/setabouttext</span><small>نبذة قصيرة</small></button><button class="mrow" type="button" data-tgcmd="/setuserpic"><span>/setuserpic</span><small>صورة البوت</small></button><button class="mrow" type="button" data-tgcmd="/setcommands"><span>/setcommands</span><small>قائمة الأوامر</small></button><button class="mrow" type="button" data-tgcmd="/revoke"><span>/revoke</span><small>إبطال التوكن الحالي</small></button></div>`);
  const bindRows = () => {
    sh.querySelectorAll("[data-remove-bot]").forEach(btn=>btn.onclick=()=>{const rows=readBots();const i=Number(btn.dataset.removeBot);if(!Number.isInteger(i)||i<0||i>=rows.length)return;rows.splice(i,1);writeBots(rows);sh.querySelector("#tgBotList").innerHTML=botRows();bindRows();});
    sh.querySelectorAll("[data-copy-bot]").forEach(btn=>btn.onclick=async()=>{const b=readBots()[Number(btn.dataset.copyBot)];if(!b)return;const text=`${b.name} (@${b.username.replace(/^@/,"")})${b.note?"\\n"+b.note:""}`;try{await navigator.clipboard.writeText(text);toast("تم نسخ بيانات البوت");}catch{toast(text);}});
  };
  const telegramRequest = async (payload) => { const token = await S.user.getIdToken(); const r = await fetch("/api/telegram-manager", { method:"POST", headers:{"content-type":"application/json",authorization:`Bearer ${token}`}, body:JSON.stringify({...payload,botId:sh.querySelector("#tgServerBotSelect")?.value||"primary"}) }); const data = await r.json().catch(()=>({})); if(!r.ok) throw new Error(data.description || data.error || "تعذر تنفيذ الطلب"); return data; };
  const loadServerBots = async () => { const out=sh.querySelector("#tgServerBotsStatus"); out.textContent="جارٍ تحميل البوتات الآمنة من الخادم…"; try { const data=await telegramRequest({action:"listBots",botId:"primary"}); const select=sh.querySelector("#tgServerBotSelect"); const previous=select.value; select.innerHTML=""; (data.bots||[]).forEach(b=>{const o=document.createElement("option");o.value=b.id;o.textContent=b.unavailable?`${b.id} — تعذر الاتصال`:`@${b.username||b.first_name||b.id} (${b.id})`;select.appendChild(o);}); if(!select.options.length){const o=document.createElement("option");o.value="primary";o.textContent="البوت الأساسي";select.appendChild(o);} if([...select.options].some(o=>o.value===previous))select.value=previous; out.textContent=`تم تحميل ${(data.bots||[]).length} إعداد بوت من الخادم. التوكنات لا تُرسل إلى المتصفح.`;} catch(e) { out.textContent=`تعذر تحميل القائمة: ${e.message}. تأكد من إعداد TELEGRAM_BOT_TOKEN أو TELEGRAM_BOTS_JSON.`; } };
  sh.querySelector("#tgReloadServerBots").onclick=loadServerBots; loadServerBots();
  const tgStatus = sh.querySelector("#tgManageStatus");
  const runTelegramAction = async (payload, success) => { tgStatus.textContent="جارٍ تنفيذ الطلب على Telegram…"; try { await telegramRequest(payload); tgStatus.textContent=success; toast(success); } catch(e) { tgStatus.textContent=`تعذر التنفيذ: ${e.message}`; } };
  sh.querySelector("#tgCheckConnection").onclick=async()=>{const out=sh.querySelector("#tgConnectionStatus");out.textContent="جارٍ فحص الاتصال…";try{const data=await telegramRequest({action:"status"});out.textContent=`متصل بنجاح: @${data.bot.username} · ${data.bot.first_name||"ESFather"}`;toast("اتصال Telegram يعمل");}catch(e){out.textContent=e.message==="telegram not configured"?"الربط غير مُعد بعد. أضف متغيرات Telegram وFirebase إلى إعدادات Vercel ثم أعد النشر.":`تعذّر فحص الاتصال: ${e.message||"خطأ غير معروف"}`;}};
  sh.querySelector("#tgFleetDiagnostics").onclick=async()=>{const status=sh.querySelector("#tgFleetStatus"),cards=sh.querySelector("#tgFleetCards");status.textContent="جارٍ فحص كل البوتات المعرفة على الخادم…";cards.replaceChildren();try{const data=await telegramRequest({action:"fleetDiagnostics",botId:"primary"});const bots=data.bots||[];status.textContent=`اكتمل الفحص: ${bots.filter(b=>b.available).length} من ${bots.length} بوت متصل.`;for(const b of bots){const card=document.createElement("div");card.className="device-card";const title=document.createElement("b");title.textContent=b.username?`@${b.username} (${b.id})`:b.id;const line=document.createElement("small");if(!b.available)line.textContent=`الاتصال: فشل${b.error?" — "+b.error:""}`;else if(!b.webhook)line.textContent=`الاتصال: يعمل · تعذر قراءة Webhook${b.error?" — "+b.error:""}`;else{const w=b.webhook;const when=w.last_error_date?new Date(w.last_error_date*1000).toLocaleString():"لا يوجد خطأ مسجل";line.textContent=`الاتصال: يعمل · Webhook: ${w.configured?"مضبوط":"غير مضبوط"} · التحديثات المعلقة: ${w.pending_update_count} · المضيف: ${w.host||"—"} · آخر خطأ: ${when}${w.last_error_message?" — "+w.last_error_message:""}`;}card.append(title,line);cards.append(card);}}catch(e){status.textContent=`تعذر إكمال الفحص: ${e.message}`;}};
  sh.querySelector("#tgWebhookCheck").onclick=async()=>{const out=sh.querySelector("#tgWebhookStatus");out.textContent="جارٍ فحص حالة Webhook…";try{const data=await telegramRequest({action:"webhookInfo"});const w=data.webhook||{};const when=w.last_error_date?new Date(w.last_error_date*1000).toLocaleString():"لا يوجد خطأ مسجل";out.textContent=`الحالة: ${w.configured?"Webhook مضبوط":"لا يوجد Webhook مضبوط"} · التحديثات المنتظرة: ${w.pending_update_count} · ${w.host?"المضيف: "+w.host:"لا يوجد عنوان"} · آخر خطأ: ${when}${w.last_error_message?" — "+w.last_error_message:""}`;if(w.max_connections)out.textContent+=` · الاتصالات القصوى: ${w.max_connections}`;if(w.allowed_updates.length)out.textContent+=` · أنواع التحديثات: ${w.allowed_updates.join(", ")}`;}catch(e){out.textContent=`تعذر فحص Webhook: ${e.message}`;}};
  sh.querySelector("#tgSaveName").onclick=()=>{const value=sh.querySelector("#tgLiveName").value.trim();if(!value)return toast("اكتب اسم البوت أولًا");runTelegramAction({action:"setName",value},"تم تحديث اسم البوت على تيليجرام");};
  sh.querySelector("#tgSaveDescription").onclick=()=>runTelegramAction({action:"setDescription",value:sh.querySelector("#tgLiveDescription").value},"تم تحديث وصف البوت");
  sh.querySelector("#tgSaveShort").onclick=()=>runTelegramAction({action:"setShortDescription",value:sh.querySelector("#tgLiveShort").value},"تم تحديث النبذة القصيرة");
  sh.querySelector("#tgLoadCommands").onclick=async()=>{tgStatus.textContent="جارٍ تحميل الأوامر…";try{const data=await telegramRequest({action:"getCommands"});sh.querySelector("#tgLiveCommands").value=(data.commands||[]).map(x=>`${x.command} - ${x.description}`).join("\n");tgStatus.textContent=`تم تحميل ${data.commands.length} أمرًا.`;}catch(e){tgStatus.textContent=`تعذر تحميل الأوامر: ${e.message}`;}};
  sh.querySelector("#tgSaveCommands").onclick=()=>{const raw=sh.querySelector("#tgLiveCommands").value.trim();const commands=raw?raw.split(/\r?\n/).map(line=>{const i=line.indexOf(" - ");return i<0?null:{command:line.slice(0,i).trim().replace(/^\//,""),description:line.slice(i+3).trim()};}):[];if(commands.some(x=>!x||!x.command||!x.description)){toast("استخدم الصيغة: start - وصف الأمر، كل أمر في سطر");return;}runTelegramAction({action:"setCommands",commands},"تم حفظ قائمة الأوامر");};
  sh.querySelector("#tgDeleteCommands").onclick=()=>{if(confirm("متأكد إنك عايز تمسح قائمة أوامر البوت من تيليجرام؟"))runTelegramAction({action:"deleteCommands"},"تم مسح قائمة الأوامر");};
  sh.querySelector("#tgAddBot").onclick=()=>{const name=sh.querySelector("#tgBotName").value.trim();const username=sh.querySelector("#tgBotUser").value.trim().replace(/^@/,"");const note=sh.querySelector("#tgBotNote").value.trim();if(name.length<2||!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username)||!username.toLowerCase().endsWith("bot")){toast("اكتب اسمًا واضحًا وUsername صالحًا ينتهي بـ bot");return;}const rows=readBots();if(rows.some(b=>b.username.toLowerCase()===username.toLowerCase())){toast("البوت موجود في القائمة بالفعل");return;}if(rows.length>=50){toast("القائمة وصلت للحد الأقصى: 50 بوتًا");return;}rows.push({name,username,note,addedAt:new Date().toISOString()});writeBots(rows);sh.querySelector("#tgBotName").value="";sh.querySelector("#tgBotUser").value="";sh.querySelector("#tgBotNote").value="";sh.querySelector("#tgBotList").innerHTML=botRows();bindRows();toast("تمت إضافة البوت للقائمة المحلية");};
  sh.querySelector("#tgCommands").onclick=()=>{const text="/newbot — إنشاء بوت\\n/mybots — إدارة بوتاتي\\n/setname — تغيير الاسم\\n/setdescription — الوصف\\n/setabouttext — النبذة\\n/setuserpic — الصورة\\n/setcommands — الأوامر\\n/revoke — إبطال التوكن";shareOrCopy(text,"أوامر BotFather","تم نسخ الأوامر");};
  sh.querySelectorAll("[data-tgcmd]").forEach(btn=>btn.onclick=async()=>{try{await navigator.clipboard.writeText(btn.dataset.tgcmd);toast("تم نسخ "+btn.dataset.tgcmd+"؛ افتح BotFather والصقه هناك");}catch{toast(btn.dataset.tgcmd);}});
  bindRows();return sh;
}

function openSettings() {
  const me = S.me;
  const sh = settingsPage("مركز الإعدادات والخصوصية", "كل إعدادات ES Chat Pro في مكان واحد — من الحساب وحتى التخزين والأمان.", `<div class="settings-profile">${avatar(me)}<div><b>${esc(me.name)}${badge(me,18)}</b><small><bdi>@${esc(me.username||"")}</bdi></small></div><button class="btn-ghost" id="settingsEdit">تعديل</button></div><div class="settings-group"><div class="settings-group-title">الحساب والتحكم</div>${settingsRow("account","◉","الحساب","الاسم، الصورة، اسم المستخدم والنبذة")}${settingsRow("privacy","◆","الخصوصية والأمان","آخر ظهور، القراءة، التشفير والحظر")}${settingsRow("security","shield","أمان الحساب والجلسات","طريقة الدخول، نشاط الحساب وتسجيل الخروج")}${settingsRow("phone","☎","رقم الهاتف والعثور عليك",me.phonePublic?"العثور عليك بالرقم مفعّل":"اختياري — مخفي افتراضيًا")}${settingsRow("contactsBook","◎","جهات الاتصال",`${Object.keys(S.contacts||{}).length} جهة — أضف بالاسم ورقم الهاتف`)}${settingsRow("devices","▣","الأجهزة المرتبطة","اربط بوت بحسابك زي ربط جهاز في واتساب")}${settingsRow("botsManager","🤖","مدير بوتات ES Chat","أنشئ بوتات لموقعك وتحكم في الرمز والأوامر والـ Webhook")}${settingsRow("telegramBots","✈","مدير ESFather على Telegram","إدارة الحساب المستقل وإعداداته عبر Telegram Bot API")}</div><div class="settings-group"><div class="settings-group-title">التطبيق والمحادثات</div>${settingsRow("chats","▤","إعدادات المحادثات","المجلدات، الرسائل، المعاينات والردود السريعة")}${settingsRow("notifications","◌","الإشعارات والأصوات","التنبيهات، المعاينة وساعات الهدوء")}${settingsRow("appearance","✦","المظهر","الألوان، الخلفية وحجم الخط")}${settingsRow("language","文","اللغة","العربية / English")}${settingsRow("data","◫","البيانات والتخزين","المسودات والملصقات وذاكرة الجهاز")}${settingsRow("power","◒","توفير الطاقة","الحركة والتنبيهات للأجهزة الضعيفة")}${settingsRow("about","ⓘ","عن ES Chat Pro","النسخة والخصوصية والدعم")}</div><div class="actions"><button class="btn-ghost" id="settingsAdvanced">الإعدادات المتقدمة</button><button class="btn-ghost" id="settingsOut">تسجيل الخروج</button></div>`);
  sh.querySelector("#settingsEdit").onclick=openEdit;sh.querySelector("#settingsAdvanced").onclick=openSettingsAdvanced;sh.querySelector("#settingsOut").onclick=doSignOut;sh.querySelectorAll("[data-settings]").forEach(b=>b.onclick=()=>openSettingsSection(b.dataset.settings));return sh;
}
function openSettingsAdvanced() {
  const me = S.me, perm = canNotify() ? Notification.permission : "unsupported";
  const link = `${location.origin}${location.pathname}?u=${me.username || ""}`;
  const note = perm === "denied" ? `<div class="hint err">الإشعارات مقفولة للموقع ده من إعدادات المتصفح. افتح إعدادات الموقع وفعّلها.</div>`
    : perm === "unsupported" ? `<div class="hint">المتصفح ده مش بيدعم الإشعارات. على الآيفون ضيف الموقع للشاشة الرئيسية الأول.</div>` : "";
  const sh = openModal(`<div class="settings-page-head"><div class="settings-kicker">ES CHAT PRO</div><h2>مركز الإعدادات والخصوصية</h2><p>تحكم كامل في حسابك ومحادثاتك وبياناتك — بإعدادات واضحة وخصوصية من البداية.</p></div><div class="prof" style="padding-top:6px">${avatar(me)}<h3>${esc(me.name)}${badge(me, 20)}</h3><div class="un"><bdi>@${esc(me.username || "")}</bdi></div></div>
    <div class="actions"><button class="btn-primary" id="stEdit">تعديل البروفايل</button><button class="btn-ghost" id="stLink">مشاركة رابط بروفايلك</button></div>
    <div class="panel-h">الإشعارات</div>${note}
    ${switchRow("stNotif", prefs.notifs && perm === "granted", "إشعارات الرسائل", "تنبيه لما حد يبعتلك")}
    ${switchRow("stSound", prefs.sound, "صوت التنبيه")}
    ${switchRow("stPrev", prefs.preview, "إظهار نص الرسالة", "لو اتقفل هيظهر «رسالة جديدة» بس")}
    <div class="actions" style="justify-content:flex-start"><button class="btn-ghost" id="stTest">جرّب إشعار</button><button class="btn-ghost" id="stCheck">فحص الإشعارات</button></div>
    <div class="panel-h">الخصوصية</div>
    ${switchRow("stHide", !!me.hideLastSeen, "إخفاء حالتي", "محدش هيشوف إنك متصل أو آخر ظهور أو إنك بتكتب")}
    ${switchRow("stRR", me.readReceipts !== false, "تأكيد القراءة ", "لو قفلته محدش هيعرف إنك قريت، وإنت كمان مش هتشوف إن اتقرت رسايلك")}
    ${switchRow("stNoAdd", me.noAdd === true, "منع إضافتي للمجموعات", "محدش يقدر يضيفك لمجموعة بدون ما تنضم بنفسك بالرابط")}
    <div class="panel-h">المظهر</div>
    <div class="swatches">${ACCENTS.map(([k, c, t]) => `<button type="button" class="sw big ${LS.get("accent", "blue") === k ? "on" : ""}" data-acc="${k}" style="background:${c}" aria-label="${t}" title="${t}"></button>`).join("")}</div>
    <div class="seg3">${WALLS.map(([k, t]) => `<button type="button" class="${LS.get("wp", "dots") === k ? "on" : ""}" data-wp="${k}">${t}</button>`).join("")}</div>
    <div class="panel-h">حجم الخط</div><div class="seg3">${[["s", "صغير"], ["m", "متوسط"], ["l", "كبير"]].map(([k, t]) => `<button type="button" class="${LS.get("fs", "m") === k ? "on" : ""}" data-fs="${k}">${t}</button>`).join("")}</div>
    <div class="panel-h">التطبيق</div>
    ${switchRow("stLc", LS.get("lcards", true), "معاينة الروابط", "كارت لروابط الموقع (بروفايل/قناة/مجموعة) جوه الشات")}
    ${switchRow("stDens", LS.get("dens", "n") === "c", "الوضع المدمج", "مسافات أصغر عشان تشوف رسايل أكتر")}
    ${switchRow("stMotion", LS.get("motion", true), "الحركات والانتقالات", "قفلها لو الجهاز بطيء")}
    ${switchRow("stH24", LS.get("h24", false), "الوقت 24 ساعة")}
    ${switchRow("stQuiet", LS.get("quiet", false), "ساعات الهدوء", "بيوقف صوت وإشعارات الموقع في الوقت ده")}
    <div class="field qrow"><label for="stQf">من</label><input type="time" id="stQf" value="${esc(LS.get("qFrom", "23:00"))}"><label for="stQt">إلى</label><input type="time" id="stQt" value="${esc(LS.get("qTo", "07:00"))}"></div>
    <div class="actions" style="justify-content:flex-start"><button class="btn-ghost" id="stReload">إعادة تحميل التطبيق</button></div>
    <div class="panel-h">أدوات الأعمال</div>
    <div class="menu" style="padding:0"><button class="mrow" id="stLbl"><span>مجلدات الدردشة</span><small>${S.prefs.labels.length}</small></button>
      <button class="mrow" id="stQr"><span>الردود السريعة</span><small>${S.prefs.quick.length}</small></button>
      <button class="mrow" id="stStar"><span>الرسائل المميزة</span><small>${S.prefs.stars.length}</small></button></div>
    <div class="actions" style="margin-top:22px"><button class="btn-ghost" id="stOut">تسجيل الخروج</button></div>`, false, true);
  const q = id => sh.querySelector(id);
  q("#stEdit").onclick = openEdit; q("#stOut").onclick = doSignOut;
  q("#stLink").onclick = () => shareOrCopy(link, me.name || "ES Chat Pro", "اتنسخ الرابط");
  q("#stLbl").onclick = manageLabels; q("#stQr").onclick = manageQuick; q("#stStar").onclick = openStars;
  sh.querySelectorAll("[data-acc]").forEach(b => b.onclick = () => { LS.set("accent", b.dataset.acc); applyTheme(); sh.querySelectorAll("[data-acc]").forEach(x => x.classList.toggle("on", x === b)); });
  sh.querySelectorAll("[data-wp]").forEach(b => b.onclick = () => { LS.set("wp", b.dataset.wp); applyTheme(); sh.querySelectorAll("[data-wp]").forEach(x => x.classList.toggle("on", x === b)); });
  sh.querySelectorAll("[data-fs]").forEach(b => b.onclick = () => { LS.set("fs", b.dataset.fs); applyTheme(); sh.querySelectorAll("[data-fs]").forEach(x => x.classList.toggle("on", x === b)); });
  q("#stNotif").onchange = async e => {
    if (e.target.checked) { const p = await enableNotifs(); if (p !== "granted") { e.target.checked = false; return; } LS.set("notifs", true); }
    else { LS.set("notifs", false); unregisterPush(); }
  };
  q("#stSound").onchange = e => { LS.set("sound", e.target.checked); if (e.target.checked) beep(); };
  q("#stPrev").onchange = e => LS.set("preview", e.target.checked);
  const redraw = () => { if (S.chat) { S.chat._h = ""; if (S.chat.lastDocs) renderMsgs(S.chat.lastDocs); } const l = $("#list"); if (l) l._h = ""; renderList(); };
  q("#stLc").onchange = e => { LS.set("lcards", e.target.checked); redraw(); };
  q("#stDens").onchange = e => { LS.set("dens", e.target.checked ? "c" : "n"); applyTheme(); };
  q("#stMotion").onchange = e => { LS.set("motion", e.target.checked); applyTheme(); };
  q("#stH24").onchange = e => { LS.set("h24", e.target.checked); redraw(); };
  q("#stQuiet").onchange = e => { LS.set("quiet", e.target.checked); toast(e.target.checked ? "ساعات الهدوء شغالة" : "ساعات الهدوء مقفولة"); };
  q("#stQf").onchange = e => LS.set("qFrom", e.target.value || "23:00");
  q("#stQt").onchange = e => LS.set("qTo", e.target.value || "07:00");
  q("#stReload").onclick = () => location.reload();
  q("#stCheck").onclick = runPushCheck;
  q("#stTest").onclick = async () => { if (Notification.permission !== "granted") { await enableNotifs(); } showNotif("ES Chat Pro", "ده إشعار تجريبي", "test"); beep(); };
  q("#stHide").onchange = async e => {
    const on = e.target.checked;
    try { await updateDoc(doc(db, "users", S.user.uid), on ? { hideLastSeen: true, lastSeen: deleteField() } : { hideLastSeen: false }); await updateDoc(doc(db, "users", S.user.uid, "public", "profile"), on ? { hideLastSeen: true, lastSeen: deleteField() } : { hideLastSeen: false }); if (!on) setTimeout(beat, 300); toast(on ? "حالتك مخفية" : "حالتك ظاهرة"); }
    catch { e.target.checked = !on; toast("تعذّر الحفظ"); }
  };
  q("#stNoAdd").onchange = async e => {
    try { await updateDoc(doc(db, "users", S.user.uid), { noAdd: e.target.checked }); toast(e.target.checked ? "محدش هيقدر يضيفك" : "ممكن يضيفوك"); }
    catch { e.target.checked = !e.target.checked; toast("تعذّر الحفظ"); }
  };
  q("#stRR").onchange = async e => {
    try { await updateDoc(doc(db, "users", S.user.uid), { readReceipts: e.target.checked }); toast(e.target.checked ? "تأكيد القراءة شغال" : "تأكيد القراءة مقفول"); }
    catch { e.target.checked = !e.target.checked; toast("تعذّر الحفظ"); }
  };
}
async function openByUsername(u) {
  try {
    const s = await getDoc(doc(db, "usernames", String(u).toLowerCase()));
    if (!s.exists()) return toast("مفيش حد بالـ username ده");
    if (s.data().uid === S.user.uid) return toast("ده بروفايلك 🙂");
    if (await getUser(s.data().uid)) openChat(s.data().uid);
  } catch { toast("تعذّر فتح البروفايل"); }
}

/* إعدادات الموقع (بتتحكم فيها من لوحة المالك) */
function siteChanged() {
  if (S.me && (S.view === "app" || S.view === "notice")) route();
  if (S.view === "app") { paintAnn(); applyComposerState(); renderList(); if (S.chat) paintHeadInner(); }
}
function paintAnn() {
  const bar = $("#annBar"), t = (S.site.announcement || "").trim();
  if (!t || LS.get("annHide", "") === t || S.view !== "app") { bar.classList.add("hidden"); return; }
  bar.innerHTML = `<span>${esc(t)}</span><button aria-label="إخفاء">${ic("close", 16)}</button>`; bar.classList.remove("hidden");
  bar.querySelector("button").onclick = () => { LS.set("annHide", t); paintAnn(); };
}
function applyComposerState() {
  const c = S.chat, form = $("#form"), ro = $("#roBar");
  let readOnly = false, roHtml = "";
  if (c && (c.type === "group" || c.type === "channel")) {
    const g = c.group;
    if (!isGMember(g)) { readOnly = true; roHtml = g.joinOpen ? `<button class="btn-primary" id="roJoin">${g.kind === "channel" ? "متابعة القناة" : "انضمام للمجموعة"}</button>` : `<span>رابط الانضمام مقفول.</span>`; }
    else if ((g.kind === "channel" || g.sendAdmins) && !isGAdmin(g)) { readOnly = true; roHtml = `<span>${g.kind === "channel" ? "القناة دي للقراءة بس. المشرفين هم اللي بينشروا." : "الإرسال هنا للمشرفين بس."}</span>`; }
  }
  if (!readOnly && c && c.group && isMutedG(c.group) && !isGAdmin(c.group)) { readOnly = true; roHtml = `<span>المشرف كتمك لحد ${esc(new Date(mutedUntil(c.group)).toLocaleString("ar-EG"))}</span>`; }
  form.classList.toggle("hidden", readOnly); ro.classList.toggle("hidden", !readOnly); ro.innerHTML = roHtml;
  const j = $("#roJoin"); if (j) j.onclick = async () => { j.disabled = true; if (!(await joinGroup(c.group))) j.disabled = false; };
  const blocked = !!(c && c.peer && S.prefs.block.includes(c.peer));
  const rdOnly = S.site.readOnly === true && !isOwner();
  const locked = blocked || rdOnly || !!(c && c.type === "public" && S.site.publicOpen === false && !isOwner());
  $("#input").disabled = locked; $("#input").placeholder = blocked ? "المستخدم ده محظور" : rdOnly ? "الموقع في وضع القراءة فقط" : locked ? "الغرفة العامة مقفولة حاليًا" : "اكتب رسالة...";
  $("#attachBtn").disabled = locked; $("#input").maxLength = isOwner() ? 2000 : Math.min(2000, +S.site.maxLen || 2000);
  $("#sendMic").disabled = locked; $("#emojiBtn").disabled = locked;
}

/* ---------------- app shell ---------------- */
function paintMe() {
  const me = S.me;
  $("#meBtn").innerHTML = me.photo ? `<img src="${esc(me.photo)}" alt="">` : esc((me.name || "?").charAt(0).toUpperCase());
  $("#whoami").innerHTML = "<bdi>@" + esc(me.username || "") + "</bdi>";
  $("#ownerBtn").classList.toggle("hidden", !isOwner());
}
async function getUser(uid, force = false) {
  if (!force && S.users.has(uid)) return S.users.get(uid);
  try { const s = await getDoc(doc(db, "users", uid, "public", "profile")); if (s.exists()) { let d = s.data(); if (S.user && uid === S.user.uid && S.me) { d = { ...d }; for (const k of ["name", "photo", "gender", "bio", "username"]) if (S.me[k]) d[k] = S.me[k]; } S.users.set(uid, d); return d; } } catch (e) { console.error(e); }
  return null;
}
async function ensureUsers(uids) {
  const miss = [...new Set(uids)].filter(u => u && !S.users.has(u));
  if (!miss.length) return false;
  await Promise.all(miss.map(u => getUser(u))); return true;
}
const peerOf = c => c.members.find(m => m !== S.user.uid);
const ONLINE_MS = 100000;
const isOnline = u => { if (u && u.hideLastSeen) return false; const t = toDate(u && u.lastSeen); return !!t && Date.now() - t.getTime() < ONLINE_MS; };

/* حضور المستخدم: بنسجّل آخر ظهور كل دقيقة طول ما الصفحة مفتوحة */
function beat() { if (S.user && S.view === "app" && !(S.me && S.me.hideLastSeen)) { updateDoc(doc(db, "users", S.user.uid), { lastSeen: serverTimestamp() }).catch(() => {}); updateDoc(doc(db, "users", S.user.uid, "public", "profile"), { lastSeen: serverTimestamp(), hideLastSeen: false }).catch(() => {}); } }
document.addEventListener("visibilitychange", () => { beat(); if (document.visibilityState === "visible" && S.view === "app" && S.chat) { markRead(S.chat.id); if (S.chat.lastDocs) renderMsgs(S.chat.lastDocs); } });
addEventListener("pagehide", beat);

const GDSIG = new Map();
function enterApp() {
  show("app"); paintMe();
  ["users", "chats", "prefs", "groups", "contacts"].forEach(k => { if (S.unsub[k]) S.unsub[k](); }); clearInterval(S.beatT); clearInterval(S.tickT);
  $("#ownerBtn").innerHTML = CROWN; $("#ownerBtn").classList.add("owner");
  S.chats = []; S.chatsLoaded = false; S.seen = new Map();
  S.unsub.prefs = onSnapshot(doc(db, "users", S.user.uid, "data", "prefs"), s => { S.prefs = { ...DEFAULT_PREFS(), ...(s.data() || {}) }; renderList(); if (S.chat) { applyComposerState(); paintHead(); } }, () => {});
  S.unsub.contacts = onSnapshot(doc(db, "users", S.user.uid, "data", "contacts"), s => applyContactsDoc(s.data() || {}), () => {});
  S.unsub.chats = onSnapshot(query(collection(db, "chats"), where("members", "array-contains", S.user.uid)), async snap => {
    S.chats = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(c => c.lastAt);
    if (snap.metadata.fromCache && !S.chatsLoaded) { await ensureUsers(S.chats.map(peerOf)); renderList(); return; }
    const first = !S.chatsLoaded; S.chatsLoaded = true;
    snap.docChanges().forEach(ch => {
      if (ch.type === "removed") return;
      const d = ch.doc.data(), ms = toDate(d.lastAt)?.getTime();
      if (!d.lastAt || !ms || d.lastUid === S.user.uid) return;
      const prev = S.seen.get(ch.doc.id); S.seen.set(ch.doc.id, ms);
      if (first) { if (ms > LS.get(readKey(ch.doc.id), 0) && !unreadMap()[ch.doc.id]) setUnread(ch.doc.id, 1); return; }
      if (prev !== ms) onIncoming(ch.doc.id, d);
    });
    await ensureUsers(S.chats.map(peerOf)); renderList();
  }, e => console.error(e));
  S.groups = []; S.gseen = new Map(); S.groupsLoaded = false;
  S.unsub.groups = onSnapshot(query(collection(db, "groups"), where("members", "array-contains", S.user.uid)), snap => {
    S.groups = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (isOwner()) S.groups.forEach(g => { const sg = [g.name, g.desc, (g.photo || "").length, g.public, g.verified, g.joinOpen, g.handle, g.lastText, toDate(g.lastAt)?.getTime()].join("|"); if (GDSIG.get(g.id) === sg) return; GDSIG.set(g.id, sg); setDoc(doc(db, "groupDirectory", g.id), { kind: g.kind, name: g.name, desc: g.desc || "", photo: g.photo || "", owner: g.owner, public: !!g.public, verified: !!g.verified, joinOpen: !!g.joinOpen, handle: g.handle || "", createdAt: g.createdAt, lastText: g.lastText || "", lastAt: g.lastAt || null, lastUid: g.lastUid || "" }, { merge: true }).catch(() => {}); });
    if (snap.metadata.fromCache && !S.groupsLoaded) { renderList(); return; }
    const first = !S.groupsLoaded; S.groupsLoaded = true;
    snap.docChanges().forEach(ch => {
      if (ch.type === "removed") return;
      const d = ch.doc.data(), ms = toDate(d.lastAt)?.getTime();
      if (!d.lastAt || !ms || d.lastUid === S.user.uid) return;
      const prev = S.gseen.get(ch.doc.id); S.gseen.set(ch.doc.id, ms);
      if (first) { if (ms > LS.get(readKey(ch.doc.id), 0) && !unreadMap()[ch.doc.id]) setUnread(ch.doc.id, 1); return; }
      if (prev !== ms) onIncomingGroup(ch.doc.id, d);
    });
    renderList();
  }, e => console.error(e));
  flushPushOutbox(); beat(); S.beatT = setInterval(() => { if (document.visibilityState === "visible") beat(); }, 60000);
  let n = 0;
  S.tickT = setInterval(async () => {
    if (S.view !== "app") return;
    if (S.chat && S.chat.peer) paintHead();
    if (S.chat && S.chat.lastDocs && S.chat.lastDocs.some(d => d.data().exp)) renderMsgs(S.chat.lastDocs);
    if (++n % 3 === 0 && document.visibilityState === "visible") {
      const top = [...S.chats].sort((a, b) => (toDate(b.lastAt)?.getTime() || 0) - (toDate(a.lastAt)?.getTime() || 0)).slice(0, 20);
      const sig = () => top.map(c => { const u = S.users.get(peerOf(c)) || {}; return (isOnline(u) ? 1 : 0) + (u.name || "") + ((u.photo || "").length); }).join("|");
      const before = sig(); await Promise.all(top.map(c => getUser(peerOf(c), true)));
      if (sig() !== before) renderList();
    }
  }, 20000);
  renderList(); showEmpty(); paintAnn(); paintNotifBar(); updateBadge(); registerPush();
  const q = new URLSearchParams(location.search).get("chat");
  if (q) { history.replaceState(null, "", location.pathname); S.pendingChat = q; }
  if (S.pendingChat) { const id = S.pendingChat; S.pendingChat = null; openFromId(id); }
  const un = sessionStorage.es_u; if (un) { sessionStorage.removeItem("es_u"); history.replaceState(null, "", location.pathname); openByUsername(un); }
  const cq = sessionStorage.es_c; if (cq) { sessionStorage.removeItem("es_c"); history.replaceState(null, "", location.pathname); openByHandle(cq); }
  const gq = sessionStorage.es_g; if (gq) { sessionStorage.removeItem("es_g"); history.replaceState(null, "", location.pathname); openGroup(gq); }
  const aiq = sessionStorage.es_ai; if (aiq) { sessionStorage.removeItem("es_ai"); history.replaceState(null, "", location.pathname); acceptAdminInvite(aiq); }
}
function showEmpty() {
  S.chat = null; closeChatSubs();
  $("#chatHead").innerHTML = ""; $("#chatSearchBtn").classList.add("hidden"); $("#pinBar").classList.add("hidden"); $("#composerWrap").classList.add("hidden");
  $("#messages").innerHTML = `<div class="empty"><div class="big">ES Chat Pro</div><p>ابحث عن صاحبك بالـ @يوزر عشان تبدأ محادثة.</p></div>`;
  $("#app").classList.remove("open"); layerClose("chat");
}
function chatUiClose() { if (CALL) finishCall(); $("#app").classList.remove("open"); }
$("#meBtn").onclick = () => openSettings();
$("#ownerBtn").onclick = () => openOwner();
$("#back").onclick = () => { chatUiClose(); layerClose("chat"); };
$("#chatHead").onclick = () => { if (!S.chat) return; if (S.chat.peer) openProfile(S.chat.peer); else if (S.chat.group) openGroupInfo(S.chat.id); };
$("#whoami").onclick = () => { const t = "@" + (S.me.username || ""); (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => toast("اتنسخ اليوزر " + t), () => toast(t)); };

/* البحث: بالـ username بالظبط فقط، مفيش قايمة أعضاء */
let searchT;
$("#search").oninput = () => { S.found = null; renderList(); clearTimeout(searchT); searchT = setTimeout(doSearch, 400); };
async function doSearch() {
  const raw = $("#search").value.trim().toLowerCase();
  if (raw.startsWith("#")) {
    const h = raw.slice(1); if (!/^[a-z0-9_]{3,20}$/.test(h)) { S.found = null; return renderList(); }
    try { const s = await getDoc(doc(db, "handles", h)); if ($("#search").value.trim().toLowerCase() !== raw) return; if (!s.exists()) S.found = { none: true }; else { const g = await fetchGroup(s.data().gid); S.found = g ? { g } : { none: true }; } }
    catch { S.found = { none: true }; }
    return renderList();
  }
  const rawTerm = $("#search").value.trim();
  const digits = rawTerm.replace(/[\s().-]/g, "");
  if (/^\+[1-9]\d{7,14}$/.test(digits)) {
    try { const ps=await getDoc(doc(db,"phoneNumbers",digits)); if($("#search").value.trim()!==rawTerm)return; if(!ps.exists()) S.found={none:true}; else if(ps.data().uid===S.user.uid) S.found={self:true}; else { const u=await getUser(ps.data().uid); S.found=u?{uid:ps.data().uid,u}: {none:true}; } } catch(e) { console.error(e); S.found={none:true}; } renderList(); return;
  }
  const term = rawTerm.toLowerCase().replace(/^@/, "");
  if (!/^[a-z0-9_]{3,20}$/.test(term)) { S.found = null; return renderList(); }
  try {
    const s = await getDoc(doc(db, "usernames", term));
    if ($("#search").value.trim().toLowerCase().replace(/^@/, "") !== term) return;
    if (!s.exists()) S.found = { none: true };
    else if (s.data().uid === S.user.uid) S.found = { self: true };
    else { const u = await getUser(s.data().uid); S.found = u ? { uid: s.data().uid, u } : { none: true }; }
  } catch (e) { console.error(e); S.found = { none: true }; }
  renderList();
}

/* ---------------- المحادثات (v4) ---------------- */
const dmId = peer => [S.user.uid, peer].sort().join("_");
const ttlLabel = s => ({ 86400: "24 ساعة", 604800: "7 أيام", 7776000: "90 يوم" }[s] || "");
const LABEL_COLORS = ["#4be0a0", "#ffd166", "#ff5c7a", "#2f6bff", "#b07cff", "#ff9f43"];
const nameOf = uid => uid === S.user.uid ? "أنت" : contactName(uid, (S.users.get(uid) || {}).name || "مستخدم");
function linkifyHtml(safe) {
  return safe.replace(/(https?:\/\/[^\s<]+)/gi, raw => {
    let url = raw, tail = ""; const m = url.match(/[).,;:!?؟،]+$/); if (m) { tail = m[0]; url = url.slice(0, -tail.length); }
    let u; try { u = new URL(url.replace(/&amp;/g, "&")); } catch { return raw; }
    const same = u.origin === location.origin && (u.searchParams.get("u") || u.searchParams.get("c") || u.searchParams.get("g"));
    return `<a class="mlink" href="${url}" ${same ? `data-site="1"` : `target="_blank" rel="noopener noreferrer nofollow"`}>${url.replace(/^https?:\/\//, "")}</a>${tail}`;
  });
}
function mentionHtml(text, enabled = false) {
  const safe = esc(text);
  if (!enabled) return linkifyHtml(safe);
  return linkifyHtml(safe).replace(/(^|\s)(@[a-z0-9_]{3,20})\b/gi, '$1<mark class="mention">$2</mark>');
}
const prefsRef = () => doc(db, "users", S.user.uid, "data", "prefs");
function savePrefs(patch) {
  S.prefs = { ...S.prefs, ...patch }; renderList(); if (S.chat) { applyComposerState(); paintHead(); }
  return setDoc(prefsRef(), patch, { merge: true }).catch(() => toast("تعذّر الحفظ"));
}
const toggleIn = (arr, v) => arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v];

function listTime(t) {
  const d = toDate(t); if (!d) return "";
  if (sameDay(d, new Date())) return fmtTime(d);
  if (sameDay(d, new Date(Date.now() - 864e5))) return "أمس";
  return d.toLocaleDateString("ar-EG", { day: "numeric", month: "short" });
}
function renderChips() {
  const P = S.prefs, um = unreadMap();
  const unreadN = S.chats.filter(c => um[c.id] && !P.arch.includes(c.id)).length;
  const items = [["all", "الكل"], ["unread", "غير مقروءة" + (unreadN ? " " + unreadN : "")], ["arch", "المؤرشفة" + (P.arch.length ? " " + P.arch.length : "")]];
  P.labels.forEach(l => items.push(["l:" + l.id, `<i class="ldot" style="background:${esc(l.c)}"></i>${esc(l.n)}`]));
  $("#chipsRow").innerHTML = items.map(([k, t]) => `<button class="chip-f ${S.filter === k ? "on" : ""}" data-f="${esc(k)}">${t}</button>`).join("");
}
$("#chipsRow").addEventListener("click", e => { const b = e.target.closest("[data-f]"); if (b) { S.filter = b.dataset.f; renderList(); } });

function groupRow(g, um, P, PIN, MUTE) {
  const n = um[g.id] || 0, muted = P.mute.includes(g.id);
  const dots = (P.cl[g.id] || []).map(id => P.labels.find(l => l.id === id)).filter(Boolean).map(l => `<i class="ldot" style="background:${esc(l.c)}"></i>`).join("");
  const last = g.lastText ? (g.lastUid === S.user.uid ? "أنت: " : (g.kind === "group" && g.lastName ? g.lastName + ": " : "")) + g.lastText : (g.kind === "channel" ? "قناة · " : "مجموعة · ") + gCount(g);
  return `<div class="chat-item ${g.kind === "channel" ? "ch-card" : ""} ${S.chat && S.chat.id === g.id ? "active" : ""} ${n ? "has-unread" : ""}" data-open="g:${esc(g.id)}" data-chat="1">${g.kind === "channel" ? `<span class="ch-ring sm">${gAvatar(g)}</span>` : gAvatar(g)}
    <div class="chat-meta"><div class="row1"><div class="name">${g.kind === "channel" ? CHAN_IC : ""}${esc(g.name)}${g.verified ? badge(g, 14) : ""}${dots}</div><span class="when">${esc(listTime(g.lastAt || g.createdAt))}</span></div>
    <div class="row2"><div class="preview">${esc(last)}</div>${P.pins.includes(g.id) ? PIN : ""}${muted ? MUTE : ""}${n ? `<b class="unread ${muted ? "muted" : ""}">${n > 99 ? "99+" : n}</b>` : ""}</div></div></div>`;
}
const PIN = `<svg class="mini-ic" width="13" height="13" viewBox="0 0 24 24"><path d="M14 3l7 7-3 1-4 4 1 5-2 2-4-4-5 5-1-1 5-5-4-4 2-2 5 1 4-4 1-3z" fill="currentColor"/></svg>`;
const MUTE = `<svg class="mini-ic" width="13" height="13" viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4V5zm5.5 3.5 5 7m0-7-5 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
S.tab = "chats";
const TABS_SEARCH = { chats: "ابحث باليوزر @ أو بالقناة #", channels: "ابحث عن قناة بالاسم أو #اسم_القناة" };
function paintTabs() {
  document.querySelectorAll("#tabbar [data-tab]").forEach(b => b.classList.toggle("on", b.dataset.tab === S.tab));
  $("#search").placeholder = TABS_SEARCH[S.tab] || TABS_SEARCH.chats;
  $("#chipsRow").classList.toggle("hidden", S.tab !== "chats");
  const um = unreadMap();
  $("#dotCh").classList.toggle("hidden", !S.groups.some(g => g.kind === "channel" && um[g.id]));
  $("#dotCh2").classList.toggle("hidden", !(S.chats.some(c => um[c.id]) || S.groups.some(g => g.kind === "group" && um[g.id])));
}
function setTab(t) {
  if (S.tab === t) return;
  const back = () => { S.tab = "chats"; $("#search").value = ""; S.found = null; renderList(); };
  S.tab = t; $("#search").value = ""; S.found = null;
  if (t === "chats") layerClose("tab"); else layerOpen("tab", back);
  renderList();
}
$("#tabbar").addEventListener("click", e => {
  const b = e.target.closest("[data-tab]"); if (!b) return; const t = b.dataset.tab;
  if (t === "settings") return openSettings();
  if (t === "profile") return openProfile(S.user.uid);
  setTab(t);
});
function renderChannelsTab() {
  const um = unreadMap(), P = S.prefs, raw = $("#search").value.trim().toLowerCase();
  let h = `<div class="ch-actions"><button class="btn-mini" data-ch="new">+ قناة جديدة</button><button class="btn-mini ghost" data-ch="find">استكشاف القنوات</button></div>`;
  let chans = S.groups.filter(g => g.kind === "channel" && !P.arch.includes(g.id));
  if (raw.startsWith("#")) {
    h += `<div class="section">نتيجة البحث</div>`; const r = S.found;
    h += r && r.g ? groupRow(r.g, um, P, PIN, MUTE) : r && r.none ? `<div class="empty-list">مفيش قناة بالاسم ده.</div>` : `<div class="empty-list">اكتب اسم القناة كامل (3 حروف على الأقل)...</div>`;
    chans = [];
  } else if (raw) chans = chans.filter(g => (g.name || "").toLowerCase().includes(raw) || (g.handle || "").includes(raw));
  chans.sort((a, b) => { const pa = P.pins.indexOf(a.id), pb = P.pins.indexOf(b.id); if ((pa >= 0) !== (pb >= 0)) return pa >= 0 ? -1 : 1; return (toDate(b.lastAt || b.createdAt)?.getTime() || 0) - (toDate(a.lastAt || a.createdAt)?.getTime() || 0); });
  if (!raw.startsWith("#")) h += `<div class="section">قنواتك</div>` + (chans.length ? chans.map(g => groupRow(g, um, P, PIN, MUTE)).join("") : `<div class="empty-list">${raw ? "مفيش قناة بالاسم ده في قنواتك." : "مش متابع أي قناة لسه.<br>استكشف القنوات العامة أو ابحث بـ #اسم_القناة."}</div>`);
  $("#list")._h = ""; $("#list").innerHTML = h; paintTabs();
}
let rlT = 0, rlLast = 0;
/* ---------------- جهات الاتصال (زي دفتر العناوين في واتساب/تيليجرام) ----------------
 * users/{uid}/data/contacts → { list: { [phone]: { name, phone, uid|null, addedAt } } }
 * phone هو المفتاح عشان يمنع تكرار نفس الرقم تلقائيًا. uid بيتملى لو الرقم ده مسجل وفعّل
 * "العثور عليه بالرقم"، وبيفضل null لو مش مسجل لسه (أو مسجل بس مخفي رقمه). */
const contactsRef = () => doc(db, "users", S.user.uid, "data", "contacts");
function applyContactsDoc(d) {
  S.contacts = d.list || {};
  S.contactNameByUid = new Map(Object.values(S.contacts).filter(c => c.uid).map(c => [c.uid, c.name]));
  renderList(); if (S.chat) paintHead();
}
const contactName = (uid, fallback) => S.contactNameByUid.get(uid) || fallback;
const normPhone = s => String(s || "").trim().replace(/[\s().-]/g, "");
const validPhone = p => /^\+[1-9]\d{7,14}$/.test(p);
async function lookupPhoneUid(phone) { try { const s = await getDoc(doc(db, "phoneNumbers", phone)); return s.exists() ? s.data().uid : null; } catch { return null; } }
async function addContact(name, phoneRaw) {
  name = String(name || "").trim().slice(0, 40); const phone = normPhone(phoneRaw);
  if (!name) { toast("اكتب اسم للشخص"); return false; }
  if (!validPhone(phone)) { toast("اكتب الرقم بصيغة دولية زي ‎+201xxxxxxxxx"); return false; }
  if (S.me && phone === normPhone(S.me.phone)) { toast("ده رقمك إنت"); return false; }
  const uid = await lookupPhoneUid(phone);
  await setDoc(contactsRef(), { list: { [phone]: { name, phone, uid: uid === S.user.uid ? null : uid, addedAt: Date.now() } } }, { merge: true });
  toast(uid ? "اتضافت! هو موجود على الموقع، تقدر تكلمه دلوقتي" : "اتضافت — لسه مش مسجل بالرقم ده، تقدر تبعتله دعوة");
  return true;
}
async function renameContact(phone, newName) {
  newName = String(newName || "").trim().slice(0, 40); if (!newName) { toast("اكتب اسم"); return; }
  await updateDoc(contactsRef(), { [`list.${phone}.name`]: newName }).catch(() => {});
}
async function deleteContact(phone) { await updateDoc(contactsRef(), { [`list.${phone}`]: deleteField() }).catch(() => {}); }
// نعيد فحص أرقام جهات الاتصال اللي لسه مش متطابقة (زي ما واتساب بيعمل "مزامنة" لما تفتح الشاشة) —
// من غير Cloud Functions، أبسط طريقة موثوقة هي إعادة الفحص وقت ما المستخدم يفتح شاشة جهات الاتصال.
async function refreshContactMatches() {
  const unmatched = Object.values(S.contacts).filter(c => !c.uid).slice(0, 60);
  if (!unmatched.length) return;
  const found = await Promise.all(unmatched.map(c => lookupPhoneUid(c.phone)));
  const patch = {}; found.forEach((uid, i) => { if (uid && uid !== S.user.uid) patch[`list.${unmatched[i].phone}.uid`] = uid; });
  if (Object.keys(patch).length) await updateDoc(contactsRef(), patch).catch(() => {});
}
function inviteContact(phone, name) {
  const link = location.origin + "/";
  const msg = `يلا بينا على ES Chat 👋 سجّل من هنا: ${link}`;
  if (navigator.share) { navigator.share({ title: "دعوة لـ ES Chat", text: msg, url: link }).catch(() => {}); return; }
  const a = document.createElement("a"); a.href = `sms:${encodeURIComponent(phone)}${/iPhone|iPad|iPod/.test(navigator.userAgent) ? "&" : "?"}body=${encodeURIComponent(msg)}`; a.click();
}
function openContacts() {
  let render;
  refreshContactMatches().then(() => render && render());
  ensureUsers(Object.values(S.contacts).filter(c => c.uid).map(c => c.uid)).then(ok => ok && render && render());
  render = () => {
    const list = Object.values(S.contacts).sort((a, b) => (a.name || "").localeCompare(b.name || "", "ar"));
    const rows = list.length ? list.map(c => `<div class="row-item" data-c="${esc(c.phone)}">${avatar(c.uid ? (S.users.get(c.uid) || {}) : { name: c.name })}<div class="meta"><div class="name">${esc(c.name)}</div><small dir="ltr">${esc(c.phone)}${c.uid ? " · على ES Chat" : " · لسه مش مسجل"}</small></div><div class="end">${c.uid ? `<button class="btn-mini" data-msg="${esc(c.uid)}">مراسلة</button>` : `<button class="btn-mini ghost" data-inv="${esc(c.phone)}">دعوة</button>`}<button class="btn-mini ghost" data-ren="${esc(c.phone)}">${ic("edit", 14)}</button><button class="btn-danger sm" data-del="${esc(c.phone)}">حذف</button></div></div>`).join("") : `<div class="empty-list">مفيش جهات اتصال لسه. ضيف حد بالاسم ورقم الهاتف.</div>`;
    const sh = settingsPage("جهات الاتصال", "ضيف اسم ورقم هاتف — لو الشخص موجود على الموقع تقدر تكلمه فورًا، ولو لسه مسجلش تقدر تبعتله دعوة.", `
      <div class="field"><label for="cName">الاسم</label><input id="cName" maxlength="40" placeholder="مثلاً: ماما، أحمد الجار..."></div>
      <div class="field"><label for="cPhone">رقم الهاتف</label><input id="cPhone" dir="ltr" placeholder="+201xxxxxxxxx"></div>
      <button type="button" class="btn-primary" id="cAdd">إضافة جهة اتصال</button>
      <div class="panel-h">جهاتك (${list.length})</div>${rows}`);
    sh.querySelector("#cAdd").onclick = async () => {
      const btn = sh.querySelector("#cAdd"); btn.disabled = true;
      const ok = await addContact(sh.querySelector("#cName").value, sh.querySelector("#cPhone").value);
      btn.disabled = false; if (ok) { sh.querySelector("#cName").value = ""; sh.querySelector("#cPhone").value = ""; render(); }
    };
    sh.onclick = e => {
      const msg = e.target.closest("[data-msg]"); if (msg) { closeModal(); openChat(msg.dataset.msg); return; }
      const inv = e.target.closest("[data-inv]"); if (inv) { const row = inv.closest("[data-c]"); inviteContact(inv.dataset.inv, (S.contacts[row.dataset.c] || {}).name); return; }
      const ren = e.target.closest("[data-ren]"); if (ren) { const phone = ren.closest("[data-c]").dataset.c, cur = (S.contacts[phone] || {}).name || ""; const n = prompt("الاسم الجديد:", cur); if (n && n.trim()) renameContact(phone, n).then(render); return; }
      const del = e.target.closest("[data-del]"); if (del) { if (confirm("تمسح جهة الاتصال دي؟")) deleteContact(del.dataset.del).then(render); }
    };
  };
  render();
}

// زرار سريع (أيقونة شات) في أعلى القايمة — بيعرض بس جهات الاتصال اللي فعلاً مسجّلة في الموقع
// (رقمها اتلقى في phoneNumbers)، عشان توصل لمراسلتهم بضغطة واحدة من غير ما تفوّت على شاشة
// الإعدادات الكاملة. بيعيد الفحص (refreshContactMatches) كل ما تفتحه عشان تبقى محدّثة.
async function openRegisteredContacts() {
  await refreshContactMatches();
  const matched = Object.values(S.contacts).filter(c => c.uid);
  await ensureUsers(matched.map(c => c.uid));
  const rows = matched.length ? matched.sort((a, b) => a.name.localeCompare(b.name, "ar")).map(c => { const u = S.users.get(c.uid) || { name: c.name }; return `<div class="row-item" data-open="${esc(c.uid)}">${avatar(u)}${isOnline(u) ? `<i class="dot"></i>` : ""}<div class="meta"><div class="name">${esc(c.name)}</div><small dir="ltr">${esc(c.phone)}</small></div><div class="end"><button class="btn-mini" data-open="${esc(c.uid)}">مراسلة</button></div></div>`; }).join("")
    : `<div class="empty-list">لسه مفيش جهات اتصال بتاعتك مسجّلة بالرقم على الموقع.<br>ضيف جهات اتصال وارجع افتح هنا تاني.</div>`;
  const sh = openModal(`<div class="menu"><div class="menu-h">جهات الاتصال المسجّلة (${matched.length})</div>${rows}<button type="button" class="btn-ghost" id="rcAll">كل جهات الاتصال وإضافة واحدة جديدة</button></div>`, true);
  sh.onclick = e => {
    const op = e.target.closest("[data-open]"); if (op) { closeModal(); openChat(op.dataset.open); return; }
    if (e.target.closest("#rcAll")) { closeModal(); openContacts(); }
  };
}
$("#contactsQuickBtn").onclick = openRegisteredContacts;

function renderList() {
  const now = Date.now(); clearTimeout(rlT);
  if (now - rlLast > 90) { rlLast = now; renderListNow(); }
  else rlT = setTimeout(() => { rlLast = Date.now(); renderListNow(); }, 90);
}
function renderListNow() {
  if (S.view !== "app") return;
  if (S.tab === "channels") return renderChannelsTab();
  renderChips(); paintTabs();
  const term = $("#search").value.trim().toLowerCase().replace(/^@/, "");
  const um = unreadMap(), P = S.prefs, f = S.filter;
  let h = "";
  if (f === "all") h += `<div class="section">الغرفة العامة</div>
    <div class="chat-item ${S.chat && S.chat.type === "public" ? "active" : ""}" data-open="public"><div class="avatar public">ES</div>
      <div class="chat-meta"><div class="row1"><div class="name">الغرفة العامة</div></div><div class="row2"><div class="preview">${S.site.publicOpen === false ? "مقفولة للكتابة حاليًا" : "محادثة مفتوحة لكل الأعضاء"}</div></div></div></div>`;
  if (term) {
    h += `<div class="section">نتيجة البحث</div>`;
    const r = S.found;
    if (r && r.uid) h += `<div class="chat-item" data-open="${esc(r.uid)}">${avatar(r.u)}<div class="chat-meta"><div class="row1"><div class="name">${esc(contactName(r.uid, r.u.name))}${badge(r.u, 15)}</div></div><div class="row2"><div class="preview"><bdi>@${esc(r.u.username)}</bdi></div></div></div></div>`;
    else if (r && r.g) h += `<div class="chat-item" data-open="g:${esc(r.g.id)}">${gAvatar(r.g)}<div class="chat-meta"><div class="row1"><div class="name">${esc(r.g.name)}</div></div><div class="row2"><div class="preview">${r.g.kind === "channel" ? "قناة" : "مجموعة"} · ${gCount(r.g)}</div></div></div></div>`;
    else if (r && r.self) h += `<div class="empty-list">ده اليوزر بتاعك</div>`;
    else if (r && r.none) h += `<div class="empty-list">مفيش نتايج. اتأكد إن الاسم مكتوب صح.</div>`;
    else h += `<div class="empty-list">اكتب اليوزر كامل (3 حروف على الأقل)...</div>`;
  }
  let chats = [...S.chats.filter(c => !P.block.includes(peerOf(c))).map(c => ({ ...c, _t: "dm" })), ...S.groups.filter(g => g.kind !== "channel").map(g => ({ ...g, _t: g.kind }))];
  chats = chats.filter(c => !P.hiddenChats.includes(c.id));
  chats = f === "arch" ? chats.filter(c => P.arch.includes(c.id)) : chats.filter(c => !P.arch.includes(c.id));
  const nm = $("#search").value.trim().toLowerCase(); if (nm && !/^[@#]/.test(nm)) chats = chats.filter(c => (((c._t === "dm" ? (S.users.get(peerOf(c)) || {}).name : c.name) || "") + "").toLowerCase().includes(nm));
  if (f === "unread") chats = chats.filter(c => um[c.id]);
  if (f.startsWith("l:")) chats = chats.filter(c => (P.cl[c.id] || []).includes(f.slice(2)));
  chats.sort((a, b) => {
    const pa = P.pins.indexOf(a.id), pb = P.pins.indexOf(b.id);
    if ((pa >= 0) !== (pb >= 0)) return pa >= 0 ? -1 : 1;
    if (pa >= 0) return pa - pb;
    return (toDate(b.lastAt || b.createdAt)?.getTime() || 0) - (toDate(a.lastAt || a.createdAt)?.getTime() || 0);
  });
  h += `<div class="section">${f === "arch" ? "المؤرشفة" : "محادثاتك"}</div>`;
  h += chats.length ? chats.map(c => {
    if (c._t !== "dm") return groupRow(c, um, P, PIN, MUTE);
    const pid = peerOf(c), u = S.users.get(pid) || { name: "مستخدم" }, n = um[c.id] || 0, muted = P.mute.includes(c.id);
    const dots = (P.cl[c.id] || []).map(id => P.labels.find(l => l.id === id)).filter(Boolean).map(l => `<i class="ldot" style="background:${esc(l.c)}"></i>`).join("");
    return `<div class="chat-item ${S.chat && S.chat.peer === pid ? "active" : ""} ${n ? "has-unread" : ""}" data-open="${esc(pid)}" data-chat="1"><div class="av-wrap">${avatar(u)}${isOnline(u) ? `<i class="dot"></i>` : ""}</div>
      <div class="chat-meta"><div class="row1"><div class="name">${esc(contactName(pid, u.name))}${badge(u, 15)}${dots}</div><span class="when">${esc(listTime(c.lastAt))}</span></div>
      <div class="row2"><div class="preview">${c.lastUid === S.user.uid ? "أنت: " : ""}${esc(dmPrev(c))}</div>${P.pins.includes(c.id) ? PIN : ""}${muted ? MUTE : ""}${n ? `<b class="unread ${muted ? "muted" : ""}">${n > 99 ? "99+" : n}</b>` : ""}</div></div></div>`;
  }).join("") : `<div class="empty-list">${f === "all" ? "مفيش محادثات لسه.<br>اطلب من صاحبك الـ @username بتاعه وابحث بيه فوق." : "مفيش محادثات هنا."}</div>`;
  const lst = $("#list"); if (lst._h !== h) { lst._h = h; lst.innerHTML = h; }
  ensureDmPreviews(chats);
}
let lpT, lpFired = false, lpX = 0, lpY = 0;
const openAnyMenu = v => v.startsWith("g:") ? openGroupMenu(v.slice(2)) : openChatMenu(v);
$("#list").addEventListener("pointerdown", e => {
  const it = e.target.closest("[data-chat]"); if (!it) return;
  lpFired = false; lpX = e.clientX; lpY = e.clientY; clearTimeout(lpT);
  lpT = setTimeout(() => { lpFired = true; openAnyMenu(it.dataset.open); }, 480);
});
$("#list").addEventListener("pointermove", e => { if (Math.abs(e.clientX - lpX) + Math.abs(e.clientY - lpY) > 10) clearTimeout(lpT); });
["pointerup", "pointerleave", "pointercancel"].forEach(ev => $("#list").addEventListener(ev, () => clearTimeout(lpT)));
$("#list").addEventListener("contextmenu", e => { const it = e.target.closest("[data-chat]"); if (it) { e.preventDefault(); clearTimeout(lpT); lpFired = true; openAnyMenu(it.dataset.open); } });
$("#list").addEventListener("click", e => {
  if (lpFired) { lpFired = false; return; }
  const chb = e.target.closest("[data-ch]"); if (chb) return chb.dataset.ch === "new" ? openCreate("channel") : openDiscover();
  const it = e.target.closest("[data-open]"); if (!it) return;
  const v = it.dataset.open; v === "public" ? openChat(null) : v.startsWith("g:") ? openGroup(v.slice(2)) : openChat(v);
});

function statusOf(u, c) {
  if (u && u.hideLastSeen) return { t: "", cls: "" };
  if (c && c.peer) {
    const ty = S.chat && S.chat.typingAt && Date.now() - S.chat.typingAt < 5000;
    if (ty) return { t: "يكتب...", cls: "typing" };
    if (isOnline(u)) return { t: "متصل", cls: "online" };
    const ls = toDate(u && u.lastSeen);
    if (ls) return { t: "آخر ظهور " + dayLabel(ls) + " " + fmtTime(ls), cls: "" };
  }
  return { t: "", cls: "" };
}
function paintHead() { paintHeadInner(); paintPin(); }
const groupPins = g => Array.isArray(g && g.pins) ? g.pins.slice(0, 3) : (g && g.pin ? [g.pin] : []);
const chatPins = c => c && c.group ? groupPins(c.group) : (Array.isArray(c && c.doc && c.doc.pins) ? c.doc.pins.slice(0, 3) : (c && c.doc && c.doc.pin ? [c.doc.pin] : []));
function paintPin() {
  const b = $("#pinBar"), c = S.chat, ps = chatPins(c);
  if (!ps.length) { b.classList.add("hidden"); b.innerHTML = ""; return; }
  b.innerHTML = ps.map((p, i) => `<button type="button" class="pin-item" data-pin="${esc(p.id)}"><span class="pin-i">${ic("pushpin", 16)}</span><span><b>رسالة مثبتة ${ps.length > 1 ? i + 1 : ""}</b><small>${esc(p.t || "")}</small></span></button>`).join("");
  b.classList.remove("hidden"); b.onclick = e => { const x = e.target.closest("[data-pin]"); if (x) jumpTo(x.dataset.pin); };
}
function paintHeadInner() {
  const c = S.chat; if (!c) return; $("#chatSearchBtn").classList.remove("hidden"); $("#callAudioBtn").classList.toggle("hidden", c.type !== "dm"); $("#callVideoBtn").classList.toggle("hidden", c.type !== "dm");
  $("#chatMenuBtn").classList.toggle("hidden", c.type === "public");
  if (c.type === "group" || c.type === "channel") {
    const g = c.group; $("#chatHead").innerHTML = `${gAvatar(g)}<div class="t"><b>${g.kind === "channel" ? CHAN_IC : ""}<span class="nm">${esc(g.name)}</span>${g.verified ? badge(g, 16) : ""}</b><small>${esc(gCount(g))}${g.handle ? " · <bdi>#" + esc(g.handle) + "</bdi>" : ""}</small></div>`; return;
  }
  if (c.type === "public") { $("#chatHead").innerHTML = `<div class="avatar public">ES</div><div class="t"><b>الغرفة العامة</b><small>محادثة مفتوحة لكل الأعضاء</small></div>`; return; }
  const u = S.users.get(c.peer) || {}, st = statusOf(u, c), ttl = c.doc && c.doc.ttl;
  $("#chatHead").innerHTML = `<div class="av-wrap">${avatar(u)}${isOnline(u) ? `<i class="dot"></i>` : ""}</div><div class="t"><b><span class="nm">${esc(contactName(c.peer, u.name || "مستخدم"))}</span>${badge(u, 16)}${ttl ? `<span class="ttl-chip">${ttlLabel(ttl)}</span>` : ""}</b><small class="st ${st.cls}">${st.t ? esc(st.t) : "<bdi>@" + esc(u.username || "") + "</bdi>"}</small></div>`;
}

$("#callAudioBtn").onclick = () => startCall("audio");
$("#callVideoBtn").onclick = () => startCall("video");
const MSG_PAGE = 40;
const msTs = d => toDate(d.data({ serverTimestamps: "estimate" }).at)?.getTime() || Infinity;
function liveMsgs(c, snap) {
  const all = c.all || (c.all = new Map());
  const first = snap.docs.length ? msTs(snap.docs[0]) : -Infinity;
  const added = snap.docChanges().some(x => x.type === "added");
  snap.docChanges().forEach(ch => {
    if (ch.type === "removed") { if (!(ch.oldIndex === 0 && added && snap.docs.length >= MSG_PAGE) && msTs(ch.doc) >= first || snap.docs.length < MSG_PAGE) all.delete(ch.doc.id); }
    else all.set(ch.doc.id, ch.doc);
  });
  c.live = new Set(snap.docs.map(d => d.id));
  return [...all.values()].sort((a, b) => msTs(a) - msTs(b));
}
async function loadOlder() {
  const c = S.chat; if (!c || c.loadingOld || c.noMore || !c.all || !c.all.size) return;
  c.loadingOld = true; const btn = $("#olderBtn"); if (btn) btn.textContent = "بيحمّل...";
  try {
    const sorted = [...c.all.values()].sort((a, b) => msTs(a) - msTs(b));
    const sn = await getDocs(query(collection(db, ...msgBase(c)), orderBy("at"), endBefore(sorted[0]), limitToLast(MSG_PAGE)));
    if (S.chat !== c) return;
    sn.docs.forEach(d => c.all.set(d.id, d)); if (sn.size < MSG_PAGE) c.noMore = true;
    const box = $("#messages"), prevH = box.scrollHeight, prevTop = box.scrollTop;
    await renderMsgs([...c.all.values()].sort((a, b) => msTs(a) - msTs(b)));
    box.scrollTop = box.scrollHeight - prevH + prevTop;
  } catch (e) { console.error(e); toast("تعذّر تحميل الرسايل الأقدم"); }
  finally { c.loadingOld = false; const b2 = $("#olderBtn"); if (b2) b2.textContent = "تحميل رسايل أقدم"; }
}
function openChat(peer) {
  closeChatSubs(); clearTimeout(S.typT);
  const id = peer ? dmId(peer) : "public";
  S.chat = { id, type: peer ? "dm" : "public", peer: peer || null, first: true, lastTyping: undefined, typingAt: 0, sentTyping: 0, sentRead: 0, reply: null, doc: null, sig: "", cleaned: new Set() };
  $("#composerWrap").classList.remove("hidden"); $("#app").classList.add("open"); layerOpen("chat", chatUiClose);
  $("#messages").innerHTML = ""; $("#input").value = LS.get("draft_" + id, ""); paintReply(); hideQuick(); markRead(id); applyComposerState(); syncSendMic(); paintHead(); renderList();
  S.unsub.msgs = onSnapshot(query(collection(db, "chats", id, "messages"), orderBy("at"), limitToLast(MSG_PAGE)),
    snap => { if (S.chat && S.chat.id === id) renderMsgs(liveMsgs(S.chat, snap)); }, e => { console.error(e); toast("مفيش صلاحية لقراءة الرسايل — راجع قواعد Firestore"); });
  if (peer) {
    getUser(peer).then(paintHead);
    S.unsub.peerDoc = onSnapshot(doc(db, "users", peer, "public", "profile"), s => { if (s.exists() && S.chat && S.chat.peer === peer) { S.users.set(peer, s.data()); paintHead(); } }, () => {});
    S.unsub.chatDoc = onSnapshot(doc(db, "chats", id), s => {
      if (!S.chat || S.chat.id !== id) return;
      const d = s.exists() ? s.data() : null; S.chat.doc = d;
      const t = (d && d.typing && d.typing[peer]) || 0;
      if (!t) S.chat.typingAt = 0;
      else if (S.chat.lastTyping !== undefined && t !== S.chat.lastTyping) { S.chat.typingAt = Date.now(); clearTimeout(S.typT); S.typT = setTimeout(paintHead, 5200); }
      S.chat.lastTyping = t; paintHead();
      const sig = JSON.stringify([d && d.read && Object.values(d.read).map(x => toDate(x)?.getTime()), d && d.ttl]);
      if (sig !== S.chat.sig) { S.chat.sig = sig; if (S.chat.lastDocs) renderMsgs(S.chat.lastDocs); }
    }, () => {});
  }
}

const TK1 = `<svg class="tk" width="15" height="11" viewBox="0 0 16 12"><path d="M1.5 6.5 5 10 14 1.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const TK2 = `<svg class="tk seen" width="19" height="11" viewBox="0 0 20 12"><path d="M1 6.5 4.5 10 13 1.5M7 9.5l1.2.8L18 1.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const msgBase = c => (c.type === "dm" || c.type === "public") ? ["chats", c.id, "messages"] : ["groups", c.id, "messages"];
const DEC = new Map();
const cKey = c => c ? ((c.recipient && c.recipient.iv) || "") + ((c.sender && c.sender.iv) || "") + (((c.recipient && c.recipient.ciphertext) || "").length) : "";
async function renderMsgs(docs) {
  const c = S.chat;
  if (c && c.type === "dm") {
    const decoded = await Promise.all(docs.map(async d => {
      const raw = d.data({ serverTimestamps: "estimate" });
      if (!raw.cipher) return d;
      try {
        const k1 = d.id + "|" + cKey(raw.cipher); let plain = DEC.get(k1);
        if (!plain) { plain = await decryptPrivatePayload(S.user.uid, raw.cipher); DEC.set(k1, plain); if (DEC.size > 260) DEC.delete(DEC.keys().next().value); }
        const reactions = {};
        for (const [uid, rc] of Object.entries(raw.reactionCiphers || {})) { try { const k2 = d.id + "|r|" + uid + "|" + cKey(rc); let x = DEC.get(k2); if (x === undefined) { x = await decryptSharedPayload(S.user.uid, rc); DEC.set(k2, x || null); } if (x?.reaction) reactions[uid] = x.reaction; } catch {} }
        return { id: d.id, data: () => ({ ...raw, ...plain, reactions, cipher: undefined }) };
      }
      catch { return { id: d.id, data: () => ({ ...raw, text: "🔒 رسالة مشفّرة — لا يمكن فكها بهذا الجهاز" }) }; }
    }));
    if (S.chat === c) { renderMsgsPlain(decoded); hydrateMedia(); if (!c._swept) { c._swept = 1; sweepRelay(c.id); } }
    return;
  }
  renderMsgsPlain(docs);
}
function renderMsgsPlain(docs) {
  const c = S.chat, box = $("#messages"), near = box.scrollHeight - box.scrollTop - box.clientHeight < 140 || c.first;
  const pub = c.type === "public" || c.type === "group", now = Date.now(), me = S.user.uid;
  c.lastDocs = docs;
  const hid = new Set(LS.get("hid_" + c.id, []));
  const peerRead = c.peer && S.me.readReceipts !== false ? toDate(c.doc && c.doc.read && c.doc.read[c.peer]) : null;
  const vis = [];
  for (const d of docs) {
    const m = d.data({ serverTimestamps: "estimate" });
    if (hid.has(d.id)) continue;
    if (c.type === "group" && c.topicId && m.topicId !== c.topicId) continue;
    if (m.exp && m.exp < now) { if (m.uid === me && !c.cleaned.has(d.id)) { c.cleaned.add(d.id); deleteDoc(doc(db, ...msgBase(c), d.id)).catch(() => {}); } continue; }
    vis.push([d, m]);
    if (m.uid !== me && c.type !== "public" && (!c.live || c.live.has(d.id))) markMessageReceipt(d.id, m);
  }
  const ttl = c.doc && c.doc.ttl;
  const notice = ttl ? `<div class="sys">الرسائل المختفية شغالة: بتتمسح بعد ${ttlLabel(ttl)}</div>` : "";
  if (!vis.length) {
    c._h = ""; box.innerHTML = notice + `<div class="empty"><div class="big">${c.type === "public" ? "الغرفة فاضية" : c.type === "channel" ? "مفيش منشورات لسه" : "ابدأ المحادثة"}</div><p>اكتب أول رسالة من الأسفل.</p></div>`;
    c.first = false; return;
  }
  if (pub) ensureUsers(vis.map(([, m]) => m.uid)).then(ch => { if (ch && S.chat && (S.chat.type === "public" || S.chat.type === "group")) renderMsgs(S.chat.lastDocs); });
  const stars = new Set(S.prefs.stars.map(s => s.c + "/" + s.m));
  const more = !c.noMore && (c.all ? c.all.size : docs.length) >= MSG_PAGE;
  const isCh = c.type === "channel", cg = isCh ? c.group : null;
  const hero = isCh && cg && !more ? `<div class="ch-hero"><div class="ch-ring">${gAvatar(cg, "big")}</div><h3>${esc(cg.name)}${cg.verified ? badge(cg, 18) : ""}</h3><div class="ch-hero-meta"><span class="ch-pill"><i class="ch-live"></i>قناة</span><span class="ch-pill">${esc(gCount(cg))}</span>${cg.handle ? `<span class="ch-pill"><bdi>#${esc(cg.handle)}</bdi></span>` : ""}</div>${cg.desc ? `<p>${esc(cg.desc)}</p>` : ""}</div>` : "";
  let last = "", h = notice + (more ? `<button type="button" class="older" id="olderBtn">تحميل رسايل أقدم</button>` : "") + hero, pu = "", pt = 0, lastMs = 0, lastUid = "";
  for (const [d, m] of vis) {
    const dt = toDate(m.at) || new Date(), mine = m.uid === me;
    const lbl = dayLabel(dt); if (lbl !== last) { h += `<div class="date-sep">${esc(lbl)}</div>`; last = lbl; pu = ""; }
    const sender = S.users.get(m.uid) || {};
    const shownText = S.me?.lang === "en" && m.textEn ? m.textEn : S.me?.lang !== "en" && m.textAr ? m.textAr : m.text;
    const cont = pu === m.uid && dt.getTime() - pt < 300000; pu = m.uid; pt = dt.getTime(); lastMs = pt; lastUid = m.uid;
    let body = "";
      if (m.deleted) body = `<div class="txt del-m">الرسالة دي اتحذفت</div>`;
      else {
      if (m.sticker && (m.sticker.emoji || m.sticker.img)) body += `<div class="sticker" title="${esc(m.sticker.label || "ملصق ES Chat Pro")}">${m.sticker.img ? `<img src="${esc(m.sticker.img)}" alt="${esc(m.sticker.label || "ملصق")}">` : `<span>${esc(m.sticker.emoji)}</span>`}</div>`;
      if (m.topicId) body += `<div class="msg-topic"># موضوع المجموعة</div>`;
      if (m.fwd) body += `<div class="fwd">معاد توجيهها</div>`;
      if (m.reply) body += `<div class="quote" data-q="${esc(m.reply.id)}"><b>${esc(nameOf(m.reply.uid))}</b><span>${esc(m.reply.t)}</span></div>`;
      if (m.media && m.media.id) body += mediaHtml(m.media, c.id);
      if (m.img && String(m.img).startsWith("data:image/")) body += `<img class="mimg" src="${esc(m.img)}" alt="صورة" data-img>`;
      if (m.file && m.file.data && String(m.file.type || "").startsWith("audio/")) body += voiceHtml(m.file);
      else if (m.file && m.file.data) body += `<a class="mfile" download="${esc(m.file.name || "file")}" href="data:${esc(m.file.type || "application/octet-stream")};base64,${esc(m.file.data)}">${ic("file", 22)}<span>${esc(m.file.name || "ملف")}</span><small>${Math.ceil((m.file.bytes || 0) / 1024)} KB</small></a>`;
      else if (m.file && /^\/api\/es-bot-file\?file_id=[a-f0-9]{24}&key=[A-Za-z0-9_-]{32,80}$/.test(String(m.file.url || ""))) body += `<a class="mfile" download="${esc(m.file.name || "file")}" href="${esc(m.file.url)}">${ic("file", 22)}<span>${esc(m.file.name || "ملف")}</span><small>${Math.ceil((m.file.bytes || 0) / 1024)} KB</small></a>`;
      if (m.loc) body += `<a class="mloc" href="https://www.google.com/maps?q=${+m.loc.lat},${+m.loc.lng}" target="_blank" rel="noopener"><svg width="18" height="18" viewBox="0 0 24 24"><path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z" fill="currentColor"/></svg><span>موقع على الخريطة</span></a>`;
      if (shownText) body += `<div class="txt">${mentionHtml(shownText, c.type === "group" || c.type === "channel")}${m.editedAt ? ` <small class="edited-label">(تم التعديل)</small>` : ""}</div>`;
      if (shownText) body += linkCardHtml(shownText);
      if (Array.isArray(m.buttons)) { const bs = m.buttons.filter(x => x && ((x.url && /^https:\/\//i.test(x.url)) || x.callback) && (x.ar || x.en)).slice(0, 8); if (bs.length) body += `<div class="bot-buttons">${bs.map(x => x.callback ? `<button type="button" class="bot-btn" data-bot-callback="${esc(x.callback)}" data-bot-mid="${esc(d.id)}">${esc(S.me?.lang === "en" ? (x.en || x.ar) : (x.ar || x.en))}</button>` : `<a class="bot-btn" href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(S.me?.lang === "en" ? (x.en || x.ar) : (x.ar || x.en))}</a>`).join("")}</div>`; }
      if (m.poll && Array.isArray(m.poll.o)) {
        const vs = m.votes || {}, tot = Object.keys(vs).length, cn = m.poll.o.map(() => 0);
        for (const v of Object.values(vs)) if (cn[v] !== undefined) cn[v]++;
        body += `<div class="poll"><div class="pq">${ic("poll", 16)}${esc(m.poll.q)}</div>${m.poll.o.map((t, i) => `<button type="button" class="po ${vs[me] === i ? "mine" : ""}" data-vote="${i}"><span class="pb" style="width:${tot ? Math.round(cn[i] * 100 / tot) : 0}%"></span><span class="pt">${esc(t)}</span><b>${cn[i]}</b></button>`).join("")}<div class="pn">${tot} صوت</div></div>`;
      }
      if (m.reactions) {
        const cnt = {}; for (const [u, e] of Object.entries(m.reactions)) if (e) cnt[e] = (cnt[e] || 0) + 1;
        const ks = Object.keys(cnt);
        if (ks.length) body += `<div class="reacts">${ks.map(e => `<button type="button" class="re ${m.reactions[me] === e ? "mine" : ""}" data-re="${esc(e)}">${esc(e)} <b>${cnt[e]}</b></button>`).join("")}</div>`;
      }
    }
    const seen = peerRead && peerRead.getTime() >= dt.getTime();
    const tick = mine && c.peer && !m.deleted ? (S.me.readReceipts === false ? TK1 : seen ? TK2 : TK1) : "";
    if (isCh) {
      const st = stars.has(c.id + "/" + d.id) ? `<span class="star">${ic("star", 11, "fill")}</span>` : "";
      const acts = m.deleted ? "" : `${cg && cg.noReact ? "" : `<button type="button" class="post-btn" data-pm aria-label="تفاعل">${ic("smile", 18)}<b>+</b></button>`}<button type="button" class="post-btn" data-pm aria-label="خيارات"><svg width="16" height="16" viewBox="0 0 24 24"><circle cx="5" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="19" cy="12" r="2" fill="currentColor"/></svg></button>`;
      h += `<div class="msg them post${m.deleted ? " gone" : ""}${m.sticker && !m.deleted && !m.text ? " stk" : ""}" data-mid="${esc(d.id)}"><div class="post-h">${cg ? gAvatar(cg, "tiny") : ""}<b>${cg ? esc(cg.name) : ""}</b>${cg && cg.verified ? badge(cg, 13) : ""}<span class="post-time">${fmtTime(dt)}</span></div>`
        + body + `<div class="post-f">${st}<span class="post-sp"></span>${acts}</div></div>`;
      continue;
    }
    h += `<div class="msg ${mine ? "me" : "them"}${cont ? " cont" : ""}${m.deleted ? " gone" : ""}${m.sticker && !m.deleted && !m.text ? " stk" : ""}" data-mid="${esc(d.id)}">`
      + (pub && !mine && !cont ? `<div class="who" data-uid="${esc(m.uid)}">${esc(contactName(m.uid, sender.name || "مستخدم"))}${badge(sender, 14)}</div>` : "")
      + body + `<div class="tm">${stars.has(c.id + "/" + d.id) ? `<span class="star">${ic("star", 11, "fill")}</span>` : ""}<span>${fmtTime(dt)}</span>${tick}</div></div>`;
  }
  if (c._h !== h) { c._h = h; box.innerHTML = h; hydrateLinkCards(); if (near) box.scrollTop = box.scrollHeight; }
  c.first = false;
  if (c.peer && lastUid && lastUid !== me && document.visibilityState === "visible") sendRead(lastMs);
}
function sendRead(lastMs) {
  const c = S.chat; if (!c || !c.peer || S.me.readReceipts === false) return;
  const mr = toDate(c.doc && c.doc.read && c.doc.read[S.user.uid]);
  if (mr && mr.getTime() >= lastMs) return;
  if (Date.now() - c.sentRead < 3000) return; c.sentRead = Date.now();
  setDoc(chatRef(), { members: membersOf(), read: { [S.user.uid]: serverTimestamp() } }, { merge: true }).catch(() => {});
}
function jumpTo(mid) {
  const el = $("#messages").querySelector(`[data-mid="${CSS.escape(mid)}"]`);
  if (!el) return toast("الرسالة الأصلية مش موجودة");
  el.scrollIntoView({ block: "center", behavior: "smooth" }); el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 1400);
}
function openSiteLink(href) {
  let u; try { u = new URL(href, location.origin); } catch { return false; }
  if (u.origin !== location.origin) return false;
  const p = u.searchParams, un = p.get("u"), cq = p.get("c"), gq = p.get("g"), k = p.get("k");
  if (un) { openByUsername(un); return true; }
  if (cq) { openByHandle(cq); return true; }
  if (gq) { if (k) try { sessionStorage.es_k = gq + "." + k; } catch {} openGroup(gq); return true; }
  return false;
}
document.addEventListener("click", e => {
  const a = e.target.closest && e.target.closest("a.mlink[data-site], a.lcard");
  if (!a) return;
  if (openSiteLink(a.getAttribute("href"))) e.preventDefault();
}, true);

// ضغطة على صورة شخص/قناة/مجموعة (جوه الهيدر، الرسايل، البروفايل، قوايم الأعضاء) = تفتح الصورة كبيرة
document.addEventListener("click", e => {
  const av = e.target.closest && e.target.closest(".avatar");
  if (!av || !av.closest("#chatHead, #messages, .prof, .row-item, .lcard")) return;
  const im = av.querySelector("img"); if (!im || !im.src) return;
  e.preventDefault(); e.stopPropagation();
  let name = "", open = null;
  if (av.dataset.au) { const uid = av.dataset.au, u = uid === (S.user && S.user.uid) ? S.me : S.users.get(uid); name = (u && u.name) || ""; if (!av.closest(".prof")) open = () => { closeModal(); openProfile(uid); }; }
  else if (av.dataset.ag) { const g = S.groups.find(x => x.id === av.dataset.ag); name = (g && g.name) || ""; if (!av.closest(".prof")) open = () => { closeModal(); openGroupInfo(av.dataset.ag); }; }
  const sh = openModal(`<div class="pv-name">${esc(name)}</div><img class="full-img" src="${esc(im.src)}" alt=""><div class="actions">${open ? `<button type="button" class="btn-primary" id="pvOpen">فتح الملف</button>` : ""}<a class="btn-ghost" download="es-chat.jpg" href="${esc(im.src)}" style="display:grid;place-items:center;text-decoration:none">حفظ الصورة</a></div>`, true);
  const o = sh.querySelector("#pvOpen"); if (o) o.onclick = open;
}, true);
function viewImage(src) {
  const sh = openModal(`<img class="full-img" src="${esc(src)}" alt=""><div class="actions"><a class="btn-ghost" download="es-chat.jpg" href="${esc(src)}" style="display:grid;place-items:center;text-decoration:none">حفظ الصورة</a></div>`, true);
}

async function voteTo(mid, i) {
  const c = S.chat; if (!c || (c.group && !isGMember(c.group))) return;
  const d = c.lastDocs && c.lastDocs.find(x => x.id === mid); if (!d) return;
  const cur = (d.data().votes || {})[S.user.uid];
  try { await updateDoc(doc(db, ...msgBase(c), mid), { ["votes." + S.user.uid]: cur === i ? deleteField() : i }); }
  catch { toast("تعذّر التصويت"); }
}
function openPollMaker() {
  const sh = openModal(`<div class="menu"><div class="menu-h">استفتاء جديد</div>
    <div class="field"><input id="plQ" maxlength="200" placeholder="السؤال" autocomplete="off"></div>
    <div id="plO"></div><button type="button" class="btn-ghost" id="plAdd">+ خيار</button>
    <div class="hint" id="plH"></div><div class="actions"><button class="btn-primary" id="plGo">نشر الاستفتاء</button></div></div>`);
  const box = sh.querySelector("#plO"), add = () => { if (box.children.length >= 12) return; const w = document.createElement("div"); w.className = "field"; w.innerHTML = `<input maxlength="80" placeholder="خيار ${box.children.length + 1}" autocomplete="off">`; box.appendChild(w); };
  add(); add(); sh.querySelector("#plAdd").onclick = add;
  sh.querySelector("#plGo").onclick = () => {
    const q = sh.querySelector("#plQ").value.trim(), o = [...box.querySelectorAll("input")].map(x => x.value.trim()).filter(Boolean), h = sh.querySelector("#plH");
    if (!q || o.length < 2) { h.className = "hint err"; h.textContent = "اكتب سؤال وخيارين على الأقل"; return; }
    const c = S.chat; closeModal(); sendTo(c, { poll: { q, o } }).catch(() => {});
  };
}
async function reactTo(mid, emo) {
  const c = S.chat, g = c && c.group;
  if (!c || (g ? (!isGMember(g) || g.noReact) : (c.type !== "dm" && c.type !== "public"))) return;
  const d = c.lastDocs && c.lastDocs.find(x => x.id === mid); if (!d) return;
  const cur = (d.data().reactions || {})[S.user.uid];
  try {
    if (c.type === "dm") {
      const bundle = await getPeerCrypto(c.peer); if (!bundle) throw new Error("no peer key");
      const cipher = await encryptSharedPayload(S.user.uid, bundle, { reaction: cur === emo ? null : emo });
      await updateDoc(doc(db, ...msgBase(c), mid), { ["reactionCiphers." + S.user.uid]: cur === emo ? deleteField() : cipher });
      if (c.lastDocs) renderMsgs(c.lastDocs);
    } else await updateDoc(doc(db, ...msgBase(c), mid), { ["reactions." + S.user.uid]: cur === emo ? deleteField() : emo });
  }
  catch { toast("تعذّر التفاعل"); }
}
async function markMessageReceipt(mid, m) {
  const c = S.chat; if (!c || c.type === "public" || !m || m.uid === S.user.uid) return;
  const key = c.type === "dm" ? ["chats", c.id, "messages", mid, "receipts", S.user.uid] : ["groups", c.id, "messages", mid, "receipts", S.user.uid];
  const k = "receipt_" + c.id + "_" + mid;
  if (sessionStorage.getItem(k)) return; sessionStorage.setItem(k, "1");
  setDoc(doc(db, ...key), { uid: S.user.uid, at: serverTimestamp() }).catch(() => sessionStorage.removeItem(k));
}
async function openMessageInfo(mid) {
  const c = S.chat, d = c && c.lastDocs && c.lastDocs.find(x => x.id === mid); if (!c || !d) return;
  const m = d.data(), mine = m.uid === S.user.uid, admin = c.group && isGAdmin(c.group);
  if (!mine && !admin && c.type !== "dm") return toast("معلومات الرسالة متاحة للمرسل أو المشرف");
  const sh = openModal(`<div class="menu"><div class="menu-h">معلومات الرسالة</div><div class="hint" id="miLoad">جاري تحميل حالات القراءة...</div><div id="miList"></div></div>`);
  try {
    const col = collection(db, ...msgBase(c), mid, "receipts");
    const rs = (await getDocs(col)).docs.map(x => x.data());
    await ensureUsers(rs.map(x => x.uid));
    const list = rs.sort((a,b) => (toDate(b.at)?.getTime()||0)-(toDate(a.at)?.getTime()||0));
    sh.querySelector("#miLoad").textContent = list.length ? `تمت القراءة بواسطة ${list.length} مستخدم` : "لم يقرأها أحد حتى الآن";
    sh.querySelector("#miList").innerHTML = list.slice(0, 100).map(x => { const u=S.users.get(x.uid)||{name:"مستخدم"}; return `<div class="row-item">${avatar(u)}<div class="meta"><div class="name">${esc(contactName(x.uid, u.name))}</div><small>${fmtDT(x.at)}</small></div></div>`; }).join("");
  } catch (e) { sh.querySelector("#miLoad").textContent = "لا توجد معلومات متاحة أو لا تسمح قواعد الخصوصية بعرضها."; }
}
async function openChannelStats(g) {
  if (!g || g.kind !== "channel" || !isGAdmin(g)) return;
  const sh = openModal(`<div class="settings-page-head"><div class="settings-kicker">ES CHAT PRO</div><h2>إحصائيات القناة</h2><p>مؤشرات مجمّعة تحترم خصوصية المتابعين ولا تعرض أسماءهم أو أرقامهم.</p></div><div class="menu"><div class="stats-tabs"><button class="on" data-st="overview">نظرة عامة</button><button data-st="posts">المنشورات</button><button data-st="audience">الجمهور</button><button data-st="growth">النمو</button></div><div id="csBody"><div class="empty-list">جاري الحساب...</div></div><p class="hint">الأرقام مبنية على البيانات المتاحة في التطبيق، وتتحدث مع فتح القناة أو تفاعل المستخدمين.</p></div>`, false, true);
  let analytics = [], messages = [];
  try { analytics = (await getDocs(collection(db, "groups", g.id, "analytics"))).docs.map(x => x.data()); } catch {}
  try { messages = (await getDocs(query(collection(db, "groups", g.id, "messages"), orderBy("at", "desc"), limit(150)))).docs.map(x => ({ id:x.id, ...x.data() })); } catch {}
  const body = sh.querySelector("#csBody");
  const render = tab => {
    sh.querySelectorAll("[data-st]").forEach(b => b.classList.toggle("on", b.dataset.st === tab));
    const now=Date.now(), d7=now-7*864e5, d30=now-30*864e5;
    const active7=analytics.filter(x => (toDate(x.lastOpen)?.getTime()||0)>=d7).length;
    const active30=analytics.filter(x => (toDate(x.lastOpen)?.getTime()||0)>=d30).length;
    const new7=analytics.filter(x => (toDate(x.firstOpen)?.getTime()||0)>=d7).length;
    const new30=analytics.filter(x => (toDate(x.firstOpen)?.getTime()||0)>=d30).length;
    if(tab === "overview") body.innerHTML=`<div class="stats"><div class="stat"><b>${g.members?.length||0}</b><span>إجمالي المتابعين</span></div><div class="stat"><b>${new7}</b><span>متابعون جدد آخر 7 أيام</span></div><div class="stat"><b>${new30}</b><span>متابعون جدد آخر 30 يوم</span></div><div class="stat"><b>${active30}</b><span>نشطون آخر 30 يوم</span></div><div class="stat"><b>${analytics.reduce((a,x)=>a+Number(x.opens||0),0)}</b><span>مرات فتح القناة</span></div><div class="stat"><b>${g.lastAt?fmtDT(g.lastAt):"—"}</b><span>آخر منشور</span></div></div>`;
    else if(tab === "posts") body.innerHTML=messages.length?`<div class="stats"><div class="stat"><b>${messages.length}</b><span>آخر منشورات محمّلة</span></div><div class="stat"><b>${messages.reduce((a,m)=>a+Object.keys(m.reactions||{}).length,0)}</b><span>تفاعلات عليها</span></div><div class="stat"><b>${messages.filter(m=>m.fwd).length}</b><span>منشورات معاد توجيهها</span></div></div><div class="panel-h">آخر المنشورات</div>`+messages.slice(0,20).map(m=>`<div class="row-item"><div class="meta"><div class="name">${esc(m.text?m.text.slice(0,80):m.poll?"📊 استفتاء":m.img?"📷 صورة":"منشور")}</div><small>${fmtDT(m.at)} · ${Object.keys(m.reactions||{}).length} تفاعل</small></div></div>`).join(""):"<div class=empty-list>لا توجد منشورات كافية.</div>";
    else if(tab === "audience") body.innerHTML=`<div class="stats"><div class="stat"><b>${active7}</b><span>نشطون آخر 7 أيام</span></div><div class="stat"><b>${active30}</b><span>نشطون آخر 30 يوم</span></div><div class="stat"><b>—</b><span>أكثر الدول: غير مفعّل</span></div><div class="stat"><b>—</b><span>ساعات النشاط: قيد التجميع</span></div></div><p class="hint">لا يتم جمع الدولة أو الموقع الجغرافي حاليًا حفاظًا على الخصوصية.</p>`;
    else body.innerHTML=`<div class="stats"><div class="stat"><b>${new7}</b><span>نمو مسجل آخر 7 أيام</span></div><div class="stat"><b>${new30}</b><span>نمو مسجل آخر 30 يوم</span></div><div class="stat"><b>—</b><span>إلغاء المتابعة: غير مسجل في النسخة الحالية</span></div><div class="stat"><b>24 ساعة</b><span>دورة تحديث المؤشرات</span></div></div><p class="hint">سيظهر صافي النمو بعد تفعيل سجل دخول/خروج المتابعين على مستوى الأحداث.</p>`;
  };
  render("overview"); sh.querySelectorAll("[data-st]").forEach(b=>b.onclick=()=>render(b.dataset.st));
}
/* قايمة الرسالة */
function openMsgMenu(mid) {
  const c = S.chat, d = c && c.lastDocs && c.lastDocs.find(x => x.id === mid); if (!d) return;
  const m = d.data(), mine = m.uid === S.user.uid; if (m.deleted) return;
  const starred = S.prefs.stars.some(s => s.c === c.id && s.m === mid);
  const rows = [["info", "معلومات الرسالة"], ["reply", "رد"]];
  if (m.text) rows.push(["copy", "نسخ"]);
  if (mine && m.text && !m.deleted) rows.push(["edit", "تعديل الرسالة"]);
  rows.push(["star", starred ? "إزالة النجمة" : "تمييز بنجمة"], ["fwd", "إعادة توجيه"], ["hide", "حذف عندي"]);
  if (!mine) rows.push(["report", "إبلاغ عن الرسالة", true]);
  const isG = c.type === "group" || c.type === "channel";
  if ((isG && isGAdmin(c.group)) || c.type === "dm") { const ps = chatPins(c), has = ps.some(p => p.id === mid); rows.push(["pin", has ? "إلغاء التثبيت" : (ps.length >= 3 ? "تثبيت (استبدال الأقدم)" : "تثبيت في الأعلى")]); }
  if (c.type === "dm" && mine) rows.push(["del", "حذف للجميع", true]);
  else if (isG && (mine || isGAdmin(c.group))) rows.push(["del", mine ? "حذف للجميع" : "حذف (مشرف)", true]);
  else if (c.type === "public" && isOwner()) rows.push(["del", "حذف من الغرفة (المالك)", true]);
  const prev = m.text ? m.text.slice(0, 70) : m.poll ? "📊 " + String(m.poll.q).slice(0, 60) : (m.img ? "📷 صورة" : "📍 موقع");
  const canRe = (isG ? isGMember(c.group) && !c.group.noReact : (c.type === "dm" ? !!c.peer : c.type === "public"));
  const sh = openModal(`<div class="menu"><div class="menu-h">${esc(prev)}</div>${canRe ? `<div class="emo-row">${EMO.map(e => `<button type="button" class="emo" data-e="${e}">${e}</button>`).join("")}</div>` : ""}${rows.map(([a, t, dng]) => `<button class="mrow ${dng ? "danger" : ""}" data-a="${a}"><span>${t}</span></button>`).join("")}</div>`);
  sh.querySelector(".menu").onclick = async e => {
    const eb = e.target.closest("[data-e]"); if (eb) { closeModal(); reactTo(mid, eb.dataset.e); return; }
    const b = e.target.closest("[data-a]"); if (!b) return; const a = b.dataset.a; closeModal();
    if (a === "info") { openMessageInfo(mid); return; }
    if (a === "reply") { c.reply = { id: mid, uid: m.uid, t: prev }; paintReply(); $("#input").focus(); }
    else if (a === "edit") {
      const next = prompt("عدّل نص المنشور", m.text || "");
      if (next !== null && next.trim() && next.trim() !== m.text) {
        try { const patch = c.type === "dm" ? { cipher: await encryptPrivatePayload(S.user.uid, await getPeerCrypto(c.peer), { text: next.trim() }), editedAt: serverTimestamp() } : { text: next.trim(), editedAt: serverTimestamp() }; await updateDoc(doc(db, ...msgBase(c), mid), patch); toast("اتعدلت الرسالة"); } catch { toast("تعذّر تعديل المنشور"); }
      }
    }
    else if (a === "report") {
      try { await addDoc(collection(db, "reports"), { reporter: S.user.uid, kind: c.type, chatId: c.id, messageId: mid, targetUid: m.uid, text: String(m.text || "").slice(0, 200), at: serverTimestamp() }); toast("اتبعث البلاغ للإدارة"); } catch { toast("تعذّر إرسال البلاغ"); }
    }
    else if (a === "copy") { (navigator.clipboard ? navigator.clipboard.writeText(m.text) : Promise.reject()).then(() => toast("اتنسخت"), () => toast("تعذّر النسخ")); }
    else if (a === "pin") {
      const old = chatPins(c), has = old.some(p => p.id === mid);
      const next = has ? old.filter(p => p.id !== mid) : [...old.filter(p => p.id !== mid), { id: mid, t: prev.slice(0, 70) }].slice(-3);
      const ref = c.group ? doc(db, "groups", c.id) : doc(db, "chats", c.id);
      updateDoc(ref, { pins: next, pin: deleteField() }).then(() => { if (c.group) { c.group.pins = next; delete c.group.pin; } else { c.doc = { ...(c.doc || {}), pins: next }; delete c.doc.pin; } paintPin(); toast(has ? "اتشال التثبيت" : "اتثبتت الرسالة"); }).catch(() => toast("تعذّر التثبيت"));
    }
    else if (a === "star") {
      const stars = starred ? S.prefs.stars.filter(s => !(s.c === c.id && s.m === mid)) : [...S.prefs.stars, { c: c.id, m: mid, t: prev, u: m.uid, a: toDate(m.at)?.getTime() || Date.now() }].slice(-100);
      savePrefs({ stars }); renderMsgs(c.lastDocs); toast(starred ? "اتشالت النجمة" : "اتميزت بنجمة");
    }
    else if (a === "fwd") m.media ? toast("إعادة توجيه الوسائط المحفوظة على الجهاز غير متاحة حاليًا") : openForward({ ...(m.text ? { text: m.text } : {}), ...(m.img ? { img: m.img } : {}), ...(m.loc ? { loc: m.loc } : {}), ...(m.poll ? { poll: m.poll } : {}) });
    else if (a === "hide") { const k = "hid_" + c.id, l = LS.get(k, []); l.push(mid); LS.set(k, l.slice(-500)); renderMsgs(c.lastDocs); }
    else if (a === "del") {
      if (!confirm(c.type === "dm" ? "تحذف الرسالة عند الطرفين؟" : "تحذف الرسالة للجميع؟")) return;
      const ref = doc(db, ...msgBase(c), mid);
      (c.type === "dm" ? updateDoc(ref, { deleted: true }) : (isG && mine) ? updateDoc(ref, { deleted: true, text: "", img: deleteField(), loc: deleteField(), reply: deleteField() }) : deleteDoc(ref)).catch(() => toast("مقدرتش أحذف الرسالة"));
    }
  };
}
function openForward(payload) {
  const dms = S.chats.filter(x => !S.prefs.block.includes(peerOf(x))).map(x => { const u = S.users.get(peerOf(x)) || {}; return { k: peerOf(x), av: avatar(u), n: contactName(peerOf(x), u.name || "مستخدم") }; });
  const gs = S.groups.filter(g => isGMember(g) && (g.kind === "group" || isGAdmin(g))).map(g => ({ k: "g:" + g.id, av: gAvatar(g), n: g.name }));
  const list = [...dms, ...gs];
  const sh = openModal(`<div class="menu"><div class="menu-h">إعادة توجيه إلى</div>${list.length ? list.map(x => `<button class="mrow" data-p="${esc(x.k)}"><span style="display:flex;align-items:center;gap:10px">${x.av}${esc(x.n)}</span></button>`).join("") : `<div class="empty-list">مفيش محادثات تبعتلها.</div>`}</div>`);
  sh.querySelector(".menu").onclick = async e => {
    const b = e.target.closest("[data-p]"); if (!b) return; closeModal(); const k = b.dataset.p;
    try {
      if (k.startsWith("g:")) { const g = S.groups.find(x => x.id === k.slice(2)); await sendTo({ id: g.id, type: g.kind }, { ...payload, fwd: true }); }
      else await sendTo({ id: dmId(k), peer: k }, { ...payload, fwd: true });
      toast("اتبعتت");
    } catch { toast("الرسالة ماتبعتتش"); }
  };
}
function paintReply() {
  const bar = $("#replyBar"), r = S.chat && S.chat.reply;
  if (!r) { bar.classList.add("hidden"); bar.innerHTML = ""; return; }
  bar.innerHTML = `<div class="rp-t"><b>رد على ${esc(nameOf(r.uid))}</b><span>${esc(r.t)}</span></div><button type="button" id="rpX" aria-label="إلغاء">${ic("close", 16)}</button>`;
  bar.classList.remove("hidden"); $("#rpX").onclick = () => { S.chat.reply = null; paintReply(); };
}
$("#messages").addEventListener("click", e => {
  const vpEl = e.target.closest("[data-vp]"); if (vpEl) return vpClick(e, vpEl);
  if (e.target.closest("#olderBtn")) return loadOlder();
  const w = e.target.closest("[data-uid]"); if (w) return openProfile(w.dataset.uid);
  const pv = e.target.closest("[data-vote]"); if (pv) { const mm = pv.closest("[data-mid]"); if (mm) voteTo(mm.dataset.mid, +pv.dataset.vote); return; }
  const pm = e.target.closest("[data-pm]"); if (pm) { const mm = pm.closest("[data-mid]"); if (mm) openMsgMenu(mm.dataset.mid); return; }
  const rc = e.target.closest("[data-re]"); if (rc) { const mm = rc.closest("[data-mid]"); if (mm) reactTo(mm.dataset.mid, rc.dataset.re); return; }
  const q = e.target.closest("[data-q]"); if (q) return jumpTo(q.dataset.q);
  const dl = e.target.closest("[data-dl]"); if (dl) { MFAIL.delete(dl.dataset.dl); mediaFetch(dl.dataset.dl).catch(() => {}); return; }
  const im = e.target.closest("[data-img]"); if (im) return viewImage(im.src);
});
let mT, mFired = false, mX = 0, mY = 0;
const mBox = $("#messages");
new MutationObserver(() => {
  if (!vpCur || vpCur.el.isConnected) return;
  const n = [...mBox.querySelectorAll("[data-vp]")].find(x => x.dataset.k === vpCur.el.dataset.k);
  if (!n) { vpCur.au.pause(); vpCur = null; return; }
  vpCur.el = n; const t = isFinite(vpCur.au.duration) && vpCur.au.duration > 0 ? vpCur.au.duration : +n.dataset.dur || 0;
  vpPaint(n, t ? vpCur.au.currentTime / t : 0, fmtDur(vpCur.au.currentTime));
  if (!vpCur.au.paused) { n.classList.add("playing"); n.querySelector(".vp-btn").innerHTML = ic("pause", 22); }
}).observe(mBox, { childList: true, subtree: true });
mBox.addEventListener("pointerdown", e => {
  const m = e.target.closest(".msg"); if (!m || !m.dataset.mid || e.target.closest("a")) return;
  mFired = false; mX = e.clientX; mY = e.clientY; clearTimeout(mT);
  mT = setTimeout(() => { mFired = true; try { navigator.vibrate && navigator.vibrate(12); } catch {} openMsgMenu(m.dataset.mid); }, 450);
});
mBox.addEventListener("pointermove", e => { if (Math.abs(e.clientX - mX) + Math.abs(e.clientY - mY) > 10) clearTimeout(mT); });
["pointerup", "pointerleave", "pointercancel"].forEach(ev => mBox.addEventListener(ev, () => clearTimeout(mT)));
mBox.addEventListener("contextmenu", e => { e.preventDefault(); const m = e.target.closest(".msg"); if (m && m.dataset.mid && !mFired) { clearTimeout(mT); mFired = true; openMsgMenu(m.dataset.mid); } });
mBox.addEventListener("click", e => { if (mFired) { mFired = false; e.stopImmediatePropagation(); e.preventDefault(); } }, true);

/* قايمة المحادثة + التصنيفات + المختفية */
function openChatMenu(peer) {
  const id = dmId(peer), P = S.prefs;
  const ttl = (S.chat && S.chat.id === id && S.chat.doc ? S.chat.doc.ttl : (S.chats.find(c => c.id === id) || {}).ttl) || 0;
  const u = S.users.get(peer) || {};
  const rows = [["profile", "عرض البروفايل"], ["pin", P.pins.includes(id) ? "إلغاء تثبيت المحادثة" : "تثبيت المحادثة"],
    ["arch", P.arch.includes(id) ? "إلغاء الأرشفة" : "أرشفة المحادثة"], ["mute", P.mute.includes(id) ? "إلغاء كتم الإشعارات" : "كتم الإشعارات"],
    ["lbl", "مجلدات الدردشة"], ["deletechat", "حذف الشات من عندي", "إزالة فورية من قائمتك فقط", true], ["ttl", "الرسائل المختفية", ttl ? ttlLabel(ttl) : "إيقاف"], ["blk", P.block.includes(peer) ? "إلغاء حظر المستخدم" : "حظر المستخدم", "", true]];
  const sh = openModal(`<div class="menu"><div class="menu-h">${esc(contactName(peer, u.name || "محادثة"))}</div>${rows.map(([a, t, v, dng]) => `<button class="mrow ${dng ? "danger" : ""}" data-a="${a}"><span>${t}</span>${v ? `<small>${v}</small>` : ""}</button>`).join("")}</div>`);
  sh.querySelector(".menu").onclick = async e => {
    const b = e.target.closest("[data-a]"); if (!b) return; const a = b.dataset.a; closeModal();
    if (a === "profile") openProfile(peer);
    else if (a === "pin") { if (!P.pins.includes(id) && P.pins.length >= 3) return toast("أقصى حاجة 3 محادثات مثبتة"); savePrefs({ pins: toggleIn(P.pins, id) }); }
    else if (a === "arch") { savePrefs({ arch: toggleIn(P.arch, id) }); toast(P.arch.includes(id) ? "اتأرشفت" : "رجعت للقايمة"); }
    else if (a === "mute") savePrefs({ mute: toggleIn(P.mute, id) });
    else if (a === "lbl") openLabelPicker(id);
    else if (a === "deletechat") {
      const previous = [...(P.hiddenChats || [])];
      const hidden = previous.includes(id) ? previous : [...previous, id];
      // Hide immediately in the UI, then persist the preference for this account only.
      S.prefs = { ...S.prefs, hiddenChats: hidden };
      renderList();
      if (S.chat && S.chat.type !== "public" && S.chat.peer === peer) showEmpty();
      try {
        await setDoc(prefsRef(), { hiddenChats: hidden }, { merge: true });
        toast("اتحذف الشات من عندك؛ لسه موجود عند الطرف التاني");
      } catch {
        S.prefs = { ...S.prefs, hiddenChats: previous };
        renderList();
        toast("الشات رجع للقائمة لأن الحذف ما اتحفظش. راجع اتصالك وحاول تاني.");
      }
    }
    else if (a === "ttl") openTtlPicker(peer, ttl);
    else if (a === "blk") {
      if (!P.block.includes(peer) && !confirm("تحظر المستخدم ده؟ مش هتشوف رسايله ولا هيجيلك إشعار منه.")) return;
      savePrefs({ block: toggleIn(P.block, peer) });
    }
  };
}
function openChatSearch() {
  const c = S.chat; if (!c) return; let flt = "all";
  const FL = [["all", "الكل"], ["img", "صور"], ["link", "روابط"], ["loc", "مواقع"], ["audio", "صوت"], ["file", "ملفات"]];
  const sh = openModal(`<div class="menu"><div class="menu-h">بحث في المحادثة</div><div class="field"><input id="csQ" placeholder="كلمة، أو from:اسم" autocomplete="off"></div><div class="seg3 four" id="csF">${FL.map(([k, t]) => `<button type="button" class="${k === "all" ? "on" : ""}" data-f="${k}">${t}</button>`).join("")}</div><div id="csR"></div></div>`);
  const inp = sh.querySelector("#csQ"), out = sh.querySelector("#csR");
  const go = () => {
    let t = inp.value.trim().toLowerCase(), from = "";
    const fm = /(?:^|\s)from:(\S+)/.exec(t); if (fm) { from = fm[1]; t = t.replace(fm[0], "").trim(); }
    if (!t && !from && flt === "all") { out.innerHTML = `<div class="empty-list">بيبحث في ${c.lastDocs?.length || 0} رسالة محمّلة على جهازك.</div>`; return; }
    const hits = (c.lastDocs || []).filter(d => {
      const m = d.data(); if (m.deleted) return false;
      if (flt === "img" && !(m.img || (m.media && m.media.kind === "img"))) return false;
      if (flt === "loc" && !m.loc) return false;
      if (flt === "audio" && !((m.file && String(m.file.type || "").startsWith("audio/")) || (m.media && m.media.kind === "voice"))) return false;
      if (flt === "file" && !((m.file && !String(m.file.type || "").startsWith("audio/")) || (m.media && m.media.kind === "file"))) return false;
      if (flt === "link" && !/https?:\/\/|www\./i.test(m.text || "")) return false;
      if (from && !nameOf(m.uid).toLowerCase().includes(from)) return false;
      return !t || ((m.text || "") + " " + (m.poll ? m.poll.q : "")).toLowerCase().includes(t);
    }).reverse().slice(0, 40);
    out.innerHTML = hits.length ? hits.map(d => { const m = d.data(), dt = toDate(m.at), label = m.text ? m.text.slice(0, 90) : m.img ? "📷 صورة" : m.file?.type?.startsWith("audio/") ? "🎙 رسالة صوتية" : m.file ? "📎 ملف" : m.loc ? "📍 موقع" : m.poll ? "📊 استفتاء" : "رسالة"; return `<div class="row-item" data-j="${esc(d.id)}"><div class="meta"><div class="name">${esc(nameOf(m.uid))}</div><small>${esc(label)}${dt ? " · " + esc(listTime(dt)) : ""}</small></div></div>`; }).join("") : `<div class="empty-list">مفيش نتايج.</div>`;
  };
  go(); inp.oninput = go;
  sh.querySelector("#csF").onclick = e => { const b = e.target.closest("[data-f]"); if (!b) return; flt = b.dataset.f; sh.querySelectorAll("#csF button").forEach(x => x.classList.toggle("on", x === b)); go(); };
  out.onclick = e => { const r = e.target.closest("[data-j]"); if (r) { const id = r.dataset.j; closeModal(); setTimeout(() => jumpTo(id), 120); } };
  setTimeout(() => inp.focus(), 50);
}
$("#chatSearchBtn").onclick = openChatSearch;
$("#chatMenuBtn").onclick = () => { if (!S.chat) return; if (S.chat.peer) openChatMenu(S.chat.peer); else if (S.chat.group) openGroupMenu(S.chat.id); };
function openTtlPicker(peer, cur) {
  const opts = [[0, "إيقاف"], [86400, "24 ساعة"], [604800, "7 أيام"], [7776000, "90 يوم"]];
  const sh = openModal(`<div class="menu"><div class="menu-h">الرسائل المختفية</div><p class="sub" style="margin:0 4px 8px">الرسايل الجديدة بس هتتمسح من المحادثة بعد المدة دي.</p>${opts.map(([s, t]) => `<button class="mrow ${s === cur ? "on" : ""}" data-s="${s}"><span>${t}</span>${s === cur ? `<small>${ic("check", 16)}</small>` : ""}</button>`).join("")}</div>`);
  sh.querySelector(".menu").onclick = async e => {
    const b = e.target.closest("[data-s]"); if (!b) return; closeModal();
    try { await setDoc(doc(db, "chats", dmId(peer)), { members: [S.user.uid, peer].sort(), ttl: +b.dataset.s }, { merge: true }); toast("اتحفظ"); } catch { toast("تعذّر الحفظ"); }
  };
}
function openLabelPicker(chatId) {
  const P = S.prefs;
  if (!P.labels.length) { const sh = openModal(`<div class="menu"><div class="menu-h">مجلدات الدردشة</div><div class="empty-list">لسه معملتش مجلدات.</div><button class="mrow" id="mkL"><span>إنشاء مجلد</span></button></div>`); sh.querySelector("#mkL").onclick = manageLabels; return; }
  const cur = P.cl[chatId] || [];
  const sh = openModal(`<div class="menu"><div class="menu-h">مجلدات الدردشة</div>${P.labels.map(l => switchRow("lp_" + l.id, cur.includes(l.id), `<i class="ldot" style="background:${esc(l.c)}"></i> ${esc(l.n)}`)).join("")}<button class="mrow" id="mkL"><span>إدارة المجلدات</span></button></div>`);
  P.labels.forEach(l => sh.querySelector("#lp_" + l.id).onchange = ev => {
    const now = S.prefs.cl[chatId] || []; savePrefs({ cl: { ...S.prefs.cl, [chatId]: ev.target.checked ? [...now, l.id] : now.filter(x => x !== l.id) } });
  });
  sh.querySelector("#mkL").onclick = manageLabels;
}
function manageLabels() {
  let col = LABEL_COLORS[0];
  const draw = () => {
    const P = S.prefs;
    const sh = openModal(`<div class="settings-page-head"><div class="settings-kicker">ES CHAT PRO</div><h2>مجلدات الدردشة</h2><p>نظّم محادثاتك محليًا على جهازك. التصنيفات لا تُرسل إلى Firebase.</p></div><div class="menu">
      ${P.labels.map(l => `<div class="mrow static"><span><i class="ldot" style="background:${esc(l.c)}"></i> ${esc(l.n)}</span><button class="btn-danger sm" data-d="${esc(l.id)}">حذف</button></div>`).join("") || `<div class="empty-list">مفيش تصنيفات.</div>`}
      ${P.labels.length < 8 ? `<div class="field" style="margin-top:12px"><label for="lN">مجلد جديد</label><input type="text" id="lN" maxlength="16" placeholder="مثال: العمل أو العائلة"></div>
      <div class="swatches">${LABEL_COLORS.map(c => `<button type="button" class="sw ${c === col ? "on" : ""}" data-c="${c}" style="background:${c}" aria-label="لون"></button>`).join("")}</div>
      <div class="actions"><button class="btn-primary" id="lAdd">إضافة</button></div>` : ""}</div>`, false, true);
    sh.querySelectorAll("[data-d]").forEach(b => b.onclick = () => { savePrefs({ labels: S.prefs.labels.filter(l => l.id !== b.dataset.d) }); draw(); });
    sh.querySelectorAll("[data-c]").forEach(b => b.onclick = () => { col = b.dataset.c; sh.querySelectorAll("[data-c]").forEach(x => x.classList.toggle("on", x === b)); });
    const add = sh.querySelector("#lAdd");
    if (add) add.onclick = () => { const n = sh.querySelector("#lN").value.trim(); if (!n) return; savePrefs({ labels: [...S.prefs.labels, { id: "l" + Date.now().toString(36), n, c: col }] }); draw(); };
  };
  draw();
}
function manageQuick() {
  const draw = () => {
    const Q = S.prefs.quick;
    const sh = openModal(`<div class="settings-page-head"><div class="settings-kicker">ES CHAT PRO</div><h2>الردود السريعة</h2><p>اختصاراتك محفوظة على جهازك وتظهر عند كتابة / داخل المحادثة.</p></div><div class="menu"><p class="sub" style="margin:0 4px 8px">اكتب <b>/</b> في المحادثة واختار الاختصار.</p>
      ${Q.map((q, i) => `<div class="mrow static col"><div><b>/${esc(q.k)}</b><small>${esc(q.t)}</small></div><button class="btn-danger sm" data-d="${i}">حذف</button></div>`).join("") || `<div class="empty-list">مفيش ردود سريعة لسه.</div>`}
      ${Q.length < 30 ? `<div class="field" style="margin-top:12px"><label for="qK">الاختصار</label><input type="text" id="qK" maxlength="20" placeholder="شكرا" style="direction:rtl"></div>
      <div class="field"><label for="qT">نص الرد</label><textarea id="qT" maxlength="300" placeholder="شكرًا لتواصلك معنا..."></textarea></div>
      <div class="actions"><button class="btn-primary" id="qAdd">إضافة</button></div>` : ""}</div>`, false, true);
    sh.querySelectorAll("[data-d]").forEach(b => b.onclick = () => { savePrefs({ quick: S.prefs.quick.filter((_, i) => i !== +b.dataset.d) }); draw(); });
    const add = sh.querySelector("#qAdd");
    if (add) add.onclick = () => {
      const k = sh.querySelector("#qK").value.trim().replace(/^\//, "").replace(/\s+/g, "_"), t = sh.querySelector("#qT").value.trim();
      if (!k || !t) return toast("اكتب الاختصار والنص");
      savePrefs({ quick: [...S.prefs.quick.filter(q => q.k !== k), { k, t }] }); draw();
    };
  };
  draw();
}
function openStars() {
  const L = [...S.prefs.stars].reverse();
  const sh = openModal(`<div class="settings-page-head"><div class="settings-kicker">ES CHAT PRO</div><h2>الرسائل المميزة</h2><p>احتفظ بالرسائل المهمة على جهازك للوصول إليها بسرعة.</p></div><div class="menu">${L.length ? L.map((s, i) => `<div class="mrow static col star-row" data-i="${i}"><div><b>${esc(nameOf(s.u))}</b><small>${esc(s.t)}</small></div><button class="btn-mini ghost" data-x="${i}">إزالة</button></div>`).join("") : `<div class="empty-list">مفيش رسايل مميزة. اضغط على رسالة واختار «تمييز بنجمة».</div>`}</div>`, false, true);
  sh.querySelector(".menu").onclick = e => {
    const x = e.target.closest("[data-x]");
    if (x) { const s = L[+x.dataset.x]; savePrefs({ stars: S.prefs.stars.filter(y => !(y.c === s.c && y.m === s.m)) }); return openStars(); }
    const r = e.target.closest("[data-i]"); if (!r) return; const s = L[+r.dataset.i]; closeModal();
    if (s.c === "public") openChat(null); else openFromId(s.c);
    setTimeout(() => jumpTo(s.m), 900);
  };
}

/* الرسايل: الكتابة والإرسال والمرفقات */
const mutedUntil = g => (g && g.muted && +g.muted[S.user.uid]) || 0;
const isMutedG = g => mutedUntil(g) > Date.now();
const EMO = ["👍","❤️","😂","😮","😢","🙏","🔥","👏","🎉","😍","🥰","😘","🤩","😎","🤔","🙄","😱","😡","🤬","🤯","😴","🤗","🤝","💯","✅","❌","⭐","🌟","✨","💙","💚","💛","💜","🖤","🤍","💔","💕","💖","💥","🚀","🎯","🏆","👑","💡","📌","🔒","🔓","👀","🙌","💪","🫡","🤣","🙂","😉","😅","😇","🤍","🫶"];
const chatRef = () => doc(db, "chats", S.chat.id);
const membersOf = () => [S.user.uid, S.chat.peer].sort();
const peerCrypto = new Map();
async function getPeerCrypto(uid) {
  if (peerCrypto.has(uid)) return peerCrypto.get(uid);
  try { const s = await getDocs(query(collection(db, "users", uid, "crypto"), limit(1))); const d = s.docs[0]; if (!d) return null; const v = d.data(); peerCrypto.set(uid, v); return v; } catch { return null; }
}
async function notifyBotUpdate(groupId, messageId) { try { const t = await S.user.getIdToken(); await fetch("/api/bot-update", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + t }, body: JSON.stringify({ groupId, messageId }) }); } catch {} }
// بعد ما نبعت رسالة مشفّرة لبوت (محادثة خاصة)، نقول للسيرفر يفكها بمفتاح البوت ويرد عليها بنفس التشفير.
async function notifyBotPM(botUid, dmId, messageId) { try { const t = await S.user.getIdToken(); await fetch("/api/bot-pm", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + t }, body: JSON.stringify({ action: "process", botId: String(botUid).replace(/^bot_/, ""), dmId, messageId }) }); } catch {} }
// فتح (أو إنشاء) محادثة خاصة مشفّرة مع بوت داخلي — botId اختياري: لو فاضي بيفتح/ينشئ بوت ESFather بتاعك.
async function openBotPM(botId = "") {
  try {
    const t = await S.user.getIdToken();
    const r = await fetch("/api/bot-pm", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + t }, body: JSON.stringify({ action: "open", botId }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { toast(d.error || "تعذّر فتح البوت"); return; }
    closeModal(); openChat(d.botUid);
  } catch { toast("تعذّر فتح البوت"); }
}
function siteGate(c, payload) {
  const st = S.site || {}, deny = t => { toast(t); throw new Error("blocked"); };
  if (isOwner()) return;
  if (st.readOnly === true) deny("الموقع في وضع القراءة فقط حاليًا");
  if ((payload.img || (payload.media && payload.media.kind === "img")) && st.allowImages === false) deny("إرسال الصور متوقف حاليًا");
  if (payload.loc && st.allowLoc === false) deny("إرسال المواقع متوقف حاليًا");
  if (payload.poll && st.allowPolls === false) deny("الاستفتاءات متوقفة حاليًا");
  if ((payload.file || (payload.media && payload.media.kind !== "img" && payload.media.kind !== "voice")) && st.allowFiles === false) deny("إرسال الملفات متوقف حاليًا");
  if (payload.text) {
    const lim = Math.min(2000, +st.maxLen || 2000);
    if (payload.text.length > lim) deny("أقصى طول للرسالة " + lim + " حرف");
    if (c.type !== "dm") {
      const bad = String(st.badWords || "").split(/[,،\n]/).map(x => x.trim().toLowerCase()).filter(Boolean), low = payload.text.toLowerCase();
      if (bad.some(w => low.includes(w))) deny("الرسالة فيها كلمات ممنوعة");
    }
  }
  if (c.type === "public" && +st.slowSec > 0) {
    const wait = LS.get("slow_public", 0) + st.slowSec * 1000 - Date.now();
    if (wait > 0) deny("استنى " + Math.ceil(wait / 1000) + " ثانية قبل الرسالة الجاية");
    LS.set("slow_public", Date.now());
  }
}
async function sendTo(c, payload) {
  if (c.peer && S.prefs.block.includes(c.peer)) { toast("ألغي حظر المستخدم الأول"); throw new Error("blocked"); }
  siteGate(c, payload);
  if (c.type === "group" || c.type === "channel") {
    const g = (S.chat && S.chat.id === c.id && S.chat.group) || S.groups.find(x => x.id === c.id);
    if (!isGMember(g) || ((g.kind === "channel" || g.sendAdmins) && !isGAdmin(g))) { toast("مش مسموحلك تبعت هنا"); throw new Error("blocked"); }
    if (isMutedG(g)) { toast("إنت مكتوم لحد " + new Date(mutedUntil(g)).toLocaleString("ar-EG")); throw new Error("blocked"); }
    const prev = payload.poll ? "📊 " + payload.poll.q : payload.img ? "📷 صورة" : payload.loc ? "📍 موقع" : (payload.text || "");
    const topicId = S.chat && S.chat.id === c.id ? S.chat.topicId : "";
    const wr = addDoc(collection(db, "groups", c.id, "messages"), { uid: S.user.uid, at: serverTimestamp(), ...(topicId ? { topicId } : {}), ...payload });
    updateDoc(doc(db, "groups", c.id), { lastText: prev.slice(0, 80), lastAt: serverTimestamp(), lastUid: S.user.uid, lastName: (S.me.name || "").slice(0, 40) }).catch(e => console.error(e));
    const posted = await wr;
    pushNotify("g:" + c.id, prev, posted.id);
    if (!String(S.user.uid).startsWith("bot_")) notifyBotUpdate(c.id, posted.id);
    return;
  }
  const meta = S.chats.find(x => x.id === c.id), ttl = c.peer ? ((S.chat && S.chat.id === c.id && S.chat.doc ? S.chat.doc.ttl : meta && meta.ttl) || 0) : 0;
  let data = { uid: S.user.uid, at: serverTimestamp(), ...payload };
  let encryptedPrivate = false;
  if (c.peer && (payload.text || payload.img || payload.file || payload.media || payload.loc || payload.poll || payload.sticker)) {
    const bundle = await getPeerCrypto(c.peer);
    if (!bundle) { toast("مفتاح التشفير للطرف الآخر غير جاهز. افتح الموقع من الجهاز الآخر مرة واحدة ثم جرّب."); throw new Error("peer-crypto-missing"); }
    const cipher = await encryptPrivatePayload(S.user.uid, bundle, payload);
    data = { uid: S.user.uid, at: serverTimestamp(), cipher };
    encryptedPrivate = true; PREV.set(c.id, { ms: -1, t: previewOf(payload).slice(0, 80) });
  }
  if (ttl) data.exp = Date.now() + ttl * 1000;
  const wr = addDoc(collection(db, "chats", c.id, "messages"), data);
  if (c.peer) {
    const prev = encryptedPrivate ? "🔒 رسالة مشفّرة" : (payload.poll ? "📊 " + payload.poll.q : payload.img ? "📷 صورة" : payload.file ? "📎 ملف" : payload.sticker ? "🎨 ملصق" : payload.loc ? "📍 موقع" : (payload.text || ""));
    if (S.chat && S.chat.id === c.id) S.chat.sentTyping = 0;
    setDoc(doc(db, "chats", c.id), { members: [S.user.uid, c.peer].sort(), lastText: prev.slice(0, 80), lastAt: serverTimestamp(), lastUid: S.user.uid, typing: { [S.user.uid]: 0 } }, { merge: true }).catch(e => console.error(e));
    pushNotify(c.id, encryptedPrivate ? "رسالة جديدة" : prev);
  }
  const posted = await wr;
  if (c.peer && c.peer.startsWith("bot_") && !String(S.user.uid).startsWith("bot_")) notifyBotPM(c.peer, c.id, posted.id);
}
function hideQuick() { $("#quickPop").classList.add("hidden"); $("#quickPop").innerHTML = ""; }
function mentionSuggest() {
  const input = $("#input"), v = input.value, m = v.match(/(?:^|\s)@([a-z0-9_]*)$/i);
  if (!m || !S.chat || (S.chat.type !== "group" && S.chat.type !== "channel")) return false;
  const q = m[1].toLowerCase(), ids = (S.chat.group?.members || []).slice(0, 80), missing = ids.filter(uid => !S.users.has(uid));
  if (missing.length) { ensureUsers(missing).then(() => { if ($("#input").value === v) mentionSuggest(); }); }
  const list = ids
    .map(uid => [uid, S.users.get(uid)])
    .filter(([, u]) => u && u.username && u.username.toLowerCase().startsWith(q)).slice(0, 8);
  if (!list.length) return false;
  const pop = $("#quickPop"); pop.innerHTML = list.map(([uid, u], i) => `<button type="button" data-mention="${i}"><b>@${esc(u.username)}</b><span>${esc(contactName(uid, u.name || uid))}</span></button>`).join("");
  pop.classList.remove("hidden");
  pop.onclick = e => { const b = e.target.closest("[data-mention]"); if (!b) return; const u = list[+b.dataset.mention][1]; input.value = v.slice(0, m.index + (m[0].startsWith("@") ? 0 : m[0].length - m[1].length - 1)) + "@" + u.username + " "; hideQuick(); input.focus(); saveDraft(); };
  return true;
}
function draftKey() { return S.chat ? "draft_" + S.chat.id : ""; }
function saveDraft() { const k = draftKey(); if (!k) return; const v = $("#input").value; if (v) LS.set(k, v.slice(0, 2000)); else { try { localStorage.removeItem("es_" + k); } catch {} } }
function quickSuggest() {
  if (mentionSuggest()) return;
  const v = $("#input").value; if (!v.startsWith("/")) return hideQuick();
  const t = v.slice(1).toLowerCase(), list = S.prefs.quick.filter(q => q.k.toLowerCase().startsWith(t)).slice(0, 6);
  if (!list.length) return hideQuick();
  const pop = $("#quickPop"); pop.innerHTML = list.map((q, i) => `<button type="button" data-i="${i}"><b>/${esc(q.k)}</b><span>${esc(q.t)}</span></button>`).join("");
  pop.classList.remove("hidden");
  pop.onclick = e => { const b = e.target.closest("[data-i]"); if (!b) return; $("#input").value = list[+b.dataset.i].t; hideQuick(); $("#input").focus(); };
}
$("#input").addEventListener("input", () => {
  saveDraft(); syncSendMic();
  quickSuggest();
  const c = S.chat; if (!c || !c.peer || !$("#input").value.trim() || (S.me && S.me.hideLastSeen)) return;
  if (Date.now() - c.sentTyping < 2500) return;
  c.sentTyping = Date.now();
  setDoc(chatRef(), { members: membersOf(), typing: { [S.user.uid]: Date.now() } }, { merge: true }).catch(() => {});
});
$("#input").addEventListener("keydown", e => {
  if (e.key !== "Enter" || e.shiftKey || !LS.get("send_enter", false)) return;
  e.preventDefault(); $("#form").requestSubmit();
});
$("#form").onsubmit = async e => {
  e.preventDefault();
  const text = $("#input").value.trim(); if (!text || !S.chat) return;
  const c = S.chat, payload = { text }; if (c.reply) payload.reply = c.reply;
  $("#input").value = ""; saveDraft(); syncSendMic(); c.reply = null; paintReply(); hideQuick();
  try { await sendTo(c, payload); } catch (er) { console.error(er); $("#input").value = text; saveDraft(); if (er.message !== "blocked") toast("الرسالة ماتبعتتش"); }
};
function compressImage(file, max = 960, q = 0.72) {
  return new Promise((res, rej) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height)), cv = document.createElement("canvas");
      cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height); URL.revokeObjectURL(url);
      let out = cv.toDataURL("image/jpeg", q); if (out.length > 380000) out = cv.toDataURL("image/jpeg", 0.5);
      res(out);
    };
    img.onerror = () => rej(new Error("bad image")); img.src = url;
  });
}
function imgToBlob(file, max = 1600, q = 0.82) {
  return new Promise((res, rej) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => { const k = Math.min(1, max / Math.max(img.width, img.height)), cv = document.createElement("canvas"); cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k); cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height); URL.revokeObjectURL(url); cv.toBlob(b => b ? res({ blob: b, w: cv.width, h: cv.height }) : rej(new Error("bad image")), "image/jpeg", q); };
    img.onerror = () => rej(new Error("bad image")); img.src = url;
  });
}
async function sendImage(file) {
  if (!file || !S.chat) return; const c = S.chat;
  try {
    toast("جاري إرسال الصورة...");
    if (c.peer) { const { blob, w, h } = await imgToBlob(file), thumb = await compressImage(file, 28, 0.5); await relaySend(c, blob, { kind: "img", name: "photo.jpg", type: "image/jpeg", w, h, thumb }); return; }
    const img = await compressImage(file, 960, 0.72); await sendTo(c, { img });
  } catch (e) { if (e.message !== "blocked") toast("الصورة ماتبعتتش"); }
}
async function sendFile(file) {
  if (!file || !S.chat) return;
  if (!S.chat.peer) return toast("إرسال الملفات متاح حاليًا في المحادثات الخاصة فقط");
  if (file.size > MEDIA_MAX) return toast("الملف أكبر من " + fmtBytes(MEDIA_MAX));
  try { toast("جاري رفع الملف..."); await relaySend(S.chat, file, { kind: "file", name: file.name.slice(0, 120), type: file.type || "application/octet-stream" }); toast("اتبعث الملف مشفّر"); }
  catch (e) { if (e.message !== "blocked") toast("الملف ماتبعتش"); }
}
/* ================= الوسائط على جهاز المستخدم =================
 * المرسل: يشفّر الملف ويرفعه أجزاء مؤقتة على Firebase، ويحتفظ بنسخته على جهازه.
 * المستلم: ينزّل الأجزاء (تلقائي أو بزر حسب الإعدادات)، يفكها ويحفظها على جهازه، وبعدها النسخة المؤقتة بتتمسح من السيرفر. */
const MURL = new Map(), MDESC = new Map(), MBUSY = new Map(), MFAIL = new Set();
const AD_DEF = () => ({ mobile: { img: { on: true, mb: 3 }, voice: { on: true, mb: 3 }, file: { on: false, mb: 2 } }, wifi: { img: { on: true, mb: 15 }, voice: { on: true, mb: 15 }, file: { on: true, mb: 15 } } });
const adGet = () => { const d = AD_DEF(), s = LS.get("ad", null) || {}; for (const n of ["mobile", "wifi"]) for (const k of ["img", "voice", "file"]) d[n][k] = { ...d[n][k], ...((s[n] || {})[k] || {}) }; return d; };
const shouldAuto = md => { const p = adGet()[netType()][md.kind === "voice" ? "voice" : md.kind === "img" ? "img" : "file"]; return !!p.on && (+md.bytes || 0) <= p.mb * 1048576; };
let _persistAsked = false;
async function relaySend(c, blob, meta) {
  if (blob.size > MEDIA_MAX) throw new Error("too-big");
  siteGate(c, { media: { kind: meta.kind } });
  const id = crypto.randomUUID(), u8 = new Uint8Array(await blob.arrayBuffer()), { ct, k, iv } = await sealBytes(u8), parts = splitChunks(ct);
  for (let i = 0; i < parts.length; i++) {
    if (parts.length > 1) toast(`جاري الرفع ${i + 1}/${parts.length}`);
    await setDoc(doc(db, "chats", c.id, "blobs", id + "_" + i), { uid: S.user.uid, at: serverTimestamp(), mid: id, i, d: parts[i] });
  }
  await mPut({ id, chat: c.id, kind: meta.kind, name: meta.name, type: meta.type, bytes: blob.size, at: Date.now(), blob, mine: true });
  MURL.set(id, URL.createObjectURL(blob));
  if (!_persistAsked) { _persistAsked = true; askPersist(); }
  await sendTo(c, { media: { id, n: parts.length, k, iv, ...meta, bytes: blob.size } });
}
const mediaWave = md => vpBars(md.wf, +md.bytes || 7);
function voiceBlobHtml(md, url) {
  const dur = Math.min(600, Math.max(0, +md.dur || 0));
  return `<div class="vp" data-vp data-media="${esc(md.id)}" data-src="${esc(url)}" data-dur="${dur}" data-k="${esc(md.id)}"><button type="button" class="vp-btn" aria-label="تشغيل">${ic("play", 22)}</button><div class="vp-body"><div class="vp-wave">${mediaWave(md)}</div><div class="vp-time">${dur ? fmtDur(dur) : "0:00"}</div></div></div>`;
}
function mediaHtml(md, chatId) {
  if (!md || !md.id) return "";
  MDESC.set(md.id, { ...md, chat: chatId });
  const id = esc(md.id), url = MURL.get(md.id), size = fmtBytes(md.bytes), fail = MFAIL.has(md.id);
  const state = `${fail ? " fail" : ""}`, label = fail ? "غير متاح — اضغط للمحاولة" : size;
  if (md.kind === "img") {
    if (url) return `<img class="mimg" src="${esc(url)}" alt="صورة" data-img data-media="${id}">`;
    // thumb جاي من المرسل: لازم يكون data URL صورة بحروف base64 بس. قبل كده كان بيتفحص بالبادئة فقط فيقدر مرسل خبيث
    // يقفل الـ style attribute ويحقن onmouseover/onerror (XSS عند كل مستلم).
    const th = typeof md.thumb === "string" && md.thumb.length < 30000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(md.thumb) ? `--t:url(${md.thumb});` : "";
    return `<div class="mph${state}" data-media="${id}" data-dl="${id}" style="${th}aspect-ratio:${+md.w || 4}/${+md.h || 3}"><span class="mdl">${ic("download", 22)}<span class="mdl-t">${label}</span></span></div>`;
  }
  if (md.kind === "voice") {
    if (url) return voiceBlobHtml(md, url);
    const dur = Math.min(600, Math.max(0, +md.dur || 0));
    return `<div class="vp vp-off${state}" data-media="${id}" data-dl="${id}"><span class="vp-btn">${ic("download", 22)}</span><div class="vp-body"><div class="vp-wave">${mediaWave(md)}</div><div class="vp-time mdl-t">${dur ? fmtDur(dur) + " · " : ""}${label}</div></div></div>`;
  }
  if (url) return `<a class="mfile" data-media="${id}" download="${esc(md.name || "file")}" href="${esc(url)}">${ic("file", 22)}<span>${esc(md.name || "ملف")}</span><small>${size}</small></a>`;
  return `<button type="button" class="mfile mfile-off${state}" data-media="${id}" data-dl="${id}">${ic("download", 22)}<span>${esc(md.name || "ملف")}</span><small class="mdl-t">${label}</small></button>`;
}
function swapMedia(id) {
  const md = MDESC.get(id); if (!md) return;
  document.querySelectorAll(`#messages [data-media="${id}"]`).forEach(el => { const t = document.createElement("div"); t.innerHTML = mediaHtml(md, md.chat); if (t.firstElementChild) el.replaceWith(t.firstElementChild); });
}
function mediaUi(id, cls, text) {
  document.querySelectorAll(`#messages [data-media="${id}"]`).forEach(el => { el.classList.remove("busy", "fail"); if (cls) el.classList.add(cls); const l = el.querySelector(".mdl-t"); if (l && text) l.textContent = text; });
}
function mediaFetch(id) {
  if (MBUSY.has(id)) return MBUSY.get(id);
  const md = MDESC.get(id); if (!md) return Promise.reject(new Error("no-desc"));
  const p = (async () => {
    mediaUi(id, "busy", "جاري التنزيل...");
    try {
      const snap = await getDocs(query(collection(db, "chats", md.chat, "blobs"), where("mid", "==", id)));
      const parts = snap.docs.map(x => x.data()).sort((a, b) => a.i - b.i);
      if (!parts.length || parts.length !== md.n || parts.some((x, i) => x.i !== i)) throw Object.assign(new Error("gone"), { gone: true });
      const u8 = await openBytes(joinChunks(parts.map(x => x.d)), md.k, md.iv), blob = new Blob([u8], { type: md.type || "application/octet-stream" });
      await mPut({ id, chat: md.chat, kind: md.kind, name: md.name, type: md.type, bytes: blob.size, at: Date.now(), blob });
      MURL.set(id, URL.createObjectURL(blob)); MFAIL.delete(id); swapMedia(id);
      if (!_persistAsked) { _persistAsked = true; askPersist(); }
      /* Firebase مجرد وسيط: بعد ما الملف اتحفظ على جهاز المستلم بنمسح النسخة المؤقتة */
      if (snap.docs.some(x => x.data().uid !== S.user.uid)) { const b = writeBatch(db); snap.docs.forEach(x => b.delete(x.ref)); b.commit().catch(() => {}); }
    } catch (e) { MFAIL.add(id); mediaUi(id, "fail", e.gone ? "الملف مش متاح (اتنزّل على جهاز تاني أو انتهت صلاحيته)" : "فشل التنزيل — اضغط للمحاولة"); throw e; }
    finally { MBUSY.delete(id); }
  })();
  MBUSY.set(id, p); p.catch(() => {}); return p;
}
async function hydrateMedia() {
  const ids = [...new Set([...document.querySelectorAll("#messages [data-media]")].map(e => e.dataset.media))];
  for (const id of ids) {
    if (MURL.has(id)) continue;
    try { const rec = await mGet(id); if (rec && rec.blob) { MURL.set(id, URL.createObjectURL(rec.blob)); swapMedia(id); continue; } } catch {}
    const md = MDESC.get(id); if (md && !MFAIL.has(id) && !MBUSY.has(id) && shouldAuto(md)) mediaFetch(id).catch(() => {});
  }
}
async function mediaPurge(pred) { const l = (await mList()).filter(pred || (() => true)); for (const x of l) { await mDel(x.id); const u = MURL.get(x.id); if (u) { URL.revokeObjectURL(u); MURL.delete(x.id); } } return l.length; }
async function localSweep() { const d = LS.get("keep_days", 0); if (!d) return; try { await mediaPurge(x => x.at && x.at < Date.now() - d * 864e5); } catch {} }
async function sweepRelay(chatId) {
  try {
    const s = await getDocs(query(collection(db, "chats", chatId, "blobs"), where("uid", "==", S.user.uid), limit(60))), cut = Date.now() - 30 * 864e5;
    const old = s.docs.filter(x => { const a = toDate(x.data().at); return a && a.getTime() < cut; });
    if (old.length) { const b = writeBatch(db); old.forEach(x => b.delete(x.ref)); await b.commit(); }
  } catch {}
}
/* ---------- شاشات الإعدادات: البيانات والتخزين (على نمط تليجرام) ---------- */
const ST_K = [["img", "الصور", "#3fb950"], ["voice", "الرسائل الصوتية", "#a371f7"], ["file", "الملفات", "#f0883e"]];
function donutSvg(parts, label) {
  const tot = parts.reduce((n, p) => n + p.v, 0), R = 52, C = 2 * Math.PI * R; let off = 0;
  const arcs = tot ? parts.filter(p => p.v > 0).map(p => { const len = p.v / tot * C, vis = Math.max(0, len - 2), el = `<circle cx="70" cy="70" r="${R}" fill="none" stroke="${p.c}" stroke-width="16" stroke-dasharray="${vis.toFixed(2)} ${(C - vis).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 70 70)"/>`; off += len; return el; }).join("") : "";
  return `<svg viewBox="0 0 140 140" class="donut" role="img"><circle cx="70" cy="70" r="${R}" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="16"/>${arcs}<text x="70" y="69" text-anchor="middle" class="d-n">${label}</text><text x="70" y="87" text-anchor="middle" class="d-s">على جهازك</text></svg>`;
}
function bindSettingsRows(sh) { sh.querySelectorAll("[data-settings]").forEach(b => b.onclick = () => openSettingsSection(b.dataset.settings)); }
function dataPage() {
  const ad = adGet(), nm = { img: "الصور", voice: "الصوتيات", file: "الملفات" };
  const sum = n => { const on = ["img", "voice", "file"].filter(k => ad[n][k].on); return on.length ? on.map(k => nm[k] + " (حتى " + ad[n][k].mb + " MB)").join("، ") : "معطّل"; };
  const sh = settingsPage("البيانات والتخزين", "الوسائط بتتحفظ على جهازك إنت، وFirebase مجرد وسيط بيوصّلها للطرف التاني وبيمسح نسخته بعد التنزيل.",
    `<div class="panel-h">استخدام التخزين</div>${settingsRow("storage", "", "استخدام التخزين", '<span id="dUse">جاري الحساب...</span>')}
    <div class="panel-h">تنزيل الوسائط تلقائيًا</div>${settingsRow("adMobile", "", "عند استخدام بيانات الجوال", sum("mobile"))}${settingsRow("adWifi", "", "عند الاتصال بالواي فاي", sum("wifi"))}
    <div class="actions" style="justify-content:flex-start"><button class="btn-ghost" id="adReset">إعادة تعيين إعدادات التنزيل التلقائي</button></div>
    <p class="hint">لو التنزيل التلقائي مقفول لنوع معين، هيظهرلك زر تنزيل على الوسيط في المحادثة وإنت اللي تقرر.</p>
    <div class="panel-h">الحفاظ على الوسائط</div>${switchRow("dPersist", false, "تخزين دائم", "يمنع المتصفح من مسح وسائطك لما مساحة الجهاز تقل")}
    <div class="panel-h">إدارة الذاكرة المحلية</div><div class="actions" style="justify-content:flex-start"><button class="btn-ghost" id="dDraft">مسح المسودات</button><button class="btn-ghost" id="dStick">مسح الملصقات الشخصية</button><button class="btn-danger" id="dAll">مسح كل إعدادات الجهاز</button></div><p class="hint">لا يتم حذف رسائلك من Firestore بهذه الأزرار. مسح إعدادات الجهاز قد يعيد تفضيلاتك للوضع الافتراضي.</p>`);
  bindSettingsRows(sh);
  mList().then(l => { const e = sh.querySelector("#dUse"); if (e) e.textContent = l.length ? fmtBytes(l.reduce((n, x) => n + x.bytes, 0)) + " · " + l.length + " ملف" : "مفيش وسائط محفوظة"; }).catch(() => {});
  isPersisted().then(v => { const e = sh.querySelector("#dPersist"); if (e && v) { e.checked = true; e.disabled = true; } });
  sh.querySelector("#dPersist").onchange = async e => { if (!e.target.checked) return; const ok = await askPersist(); if (!ok) { e.target.checked = false; toast("المتصفح رفض التخزين الدائم"); } else { e.target.disabled = true; toast("تم تفعيل التخزين الدائم"); } };
  sh.querySelector("#adReset").onclick = () => { LS.set("ad", {}); toast("اتعادت الإعدادات الافتراضية"); openSettingsSection("data"); };
  sh.querySelector("#dDraft").onclick = () => { Object.keys(localStorage).filter(k => k.startsWith("es_draft_")).forEach(k => localStorage.removeItem(k)); toast("تم مسح المسودات"); };
  sh.querySelector("#dStick").onclick = () => { LS.set("custom_stickers", []); LS.set("sticker_favs", []); toast("تم مسح الملصقات المحلية"); };
  sh.querySelector("#dAll").onclick = () => { if (!confirm("مسح إعدادات هذا الجهاز فقط؟")) return; Object.keys(localStorage).filter(k => k.startsWith("es_")).forEach(k => localStorage.removeItem(k)); toast("تم مسح إعدادات الجهاز"); setTimeout(() => location.reload(), 500); };
  return sh;
}
function adPage(net) {
  const ad = adGet()[net], title = net === "mobile" ? "عند استخدام بيانات الجوال" : "عند الاتصال بالواي فاي";
  const rows = [["img", "الصور", "تنزيل الصور تلقائيًا"], ["voice", "الرسائل الصوتية", "تنزيل التسجيلات الصوتية تلقائيًا"], ["file", "الملفات", "تنزيل المستندات والملفات تلقائيًا"]];
  const sh = settingsPage(title, "الوسائط اللي بتوصلك في المحادثات الخاصة بتتنزّل لوحدها لو حجمها أقل من الحد اللي تحدده، وغير كده بيظهرلك زر تنزيل.",
    rows.map(([k, t, s]) => `<div class="ad-block">${switchRow("ad_" + k, ad[k].on, t, s)}<div class="ad-lim"><span>الحد الأقصى للحجم</span><b id="lv_${k}">\u200E${ad[k].mb} MB</b></div><input type="range" class="ad-range" id="ls_${k}" min="1" max="15" step="1" value="${ad[k].mb}"></div>`).join(""));
  const save = (k, patch) => { const s = LS.get("ad", null) || {}; s[net] = s[net] || {}; s[net][k] = { ...(s[net][k] || {}), ...patch }; LS.set("ad", s); };
  rows.forEach(([k]) => { sh.querySelector("#ad_" + k).onchange = e => save(k, { on: e.target.checked }); const r = sh.querySelector("#ls_" + k); r.oninput = () => { sh.querySelector("#lv_" + k).textContent = "\u200E" + r.value + " MB"; }; r.onchange = () => save(k, { mb: +r.value }); });
  return sh;
}
function storagePage() {
  const sh = settingsPage("استخدام التخزين", "الوسائط اللي نزّلتها محفوظة على جهازك إنت. Firebase بيوصّلها بس وبعدين بيمسح نسخته.", `<div id="stBox"><p class="hint">جاري الحساب...</p></div>`);
  stRender(sh); return sh;
}
async function stRender(sh) {
  const box = sh.querySelector("#stBox"); if (!box) return;
  let list = []; try { list = await mList(); } catch {}
  const by = { img: 0, voice: 0, file: 0 }; list.forEach(x => { by[x.kind in by ? x.kind : "file"] += x.bytes; });
  const tot = by.img + by.voice + by.file, q = await deviceQuota(), chats = {}; list.forEach(x => { chats[x.chat] = (chats[x.chat] || 0) + x.bytes; });
  const cname = id => { const peer = String(id).split("_").find(u => u !== S.user.uid); return peer ? (nameOf(peer) || peer) : id; };
  const keep = LS.get("keep_days", 0);
  box.innerHTML = `<div class="donut-wrap">${donutSvg(ST_K.map(([k, , c]) => ({ v: by[k], c })), fmtBytes(tot))}</div>
    <p class="hint" style="text-align:center">${q ? `ES Chat Pro يستخدم ${fmtBytes(q.usage)} من مساحة المتصفح المتاحة (${fmtBytes(q.quota)})` : "وسائطك محفوظة على هذا الجهاز"}</p>
    <div class="st-list">${ST_K.map(([k, t, c]) => `<div class="st-row"><i style="background:${c}"></i><span>${t}</span><b>${tot ? Math.round(by[k] / tot * 100) : 0}%</b><em>${fmtBytes(by[k])}</em></div>`).join("")}</div>
    <div class="actions"><button class="btn-danger" id="stClear" ${tot ? "" : "disabled"}>مسح كل الوسائط من الجهاز</button></div>
    <p class="hint warn">${ic("warning", 15)} الوسائط بتتمسح من السيرفر بعد ما تتنزّل، فلو مسحتها من هنا مش هتقدر تنزّلها تاني. الرسائل نفسها بتفضل.</p>
    <div class="panel-h">الحذف التلقائي للوسائط القديمة</div>
    <div class="seg3" id="stKeep">${[[0, "للأبد"], [7, "أسبوع"], [30, "شهر"], [90, "٣ شهور"]].map(([d, t]) => `<button type="button" data-d="${d}" class="${keep === d ? "on" : ""}">${t}</button>`).join("")}</div>
    <div class="panel-h">حسب المحادثة</div>
    <div class="st-list">${Object.entries(chats).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([id, n]) => `<div class="st-row"><i style="background:#58a6ff"></i><span>${esc(cname(id))}</span><em>${fmtBytes(n)}</em><button type="button" class="st-x" data-chat="${esc(id)}" aria-label="مسح">${ic("trash", 16)}</button></div>`).join("") || `<p class="hint">مفيش وسائط محفوظة لسه.</p>`}</div>`;
  const refresh = () => { if (S.chat?.lastDocs) renderMsgs(S.chat.lastDocs); };
  box.querySelector("#stClear").onclick = async () => { if (!confirm("مسح كل الوسائط المحفوظة على الجهاز؟ مش هتقدر تنزّلها تاني.")) return; await mediaPurge(); toast("اتمسحت الوسائط من الجهاز"); stRender(sh); refresh(); };
  box.querySelectorAll("#stKeep button").forEach(b => b.onclick = async () => { LS.set("keep_days", +b.dataset.d); await localSweep(); stRender(sh); refresh(); });
  box.querySelectorAll("[data-chat]").forEach(b => b.onclick = async () => { await mediaPurge(x => x.chat === b.dataset.chat); toast("اتمسحت وسائط المحادثة"); stRender(sh); refresh(); });
}
let voiceRecorder = null, voiceChunks = [], voiceTimer = 0, voiceStarted = 0, voiceTick = 0, voiceCancel = false, voiceWf = [];
function syncSendMic() {
  const b = $("#sendMic"); if (!b) return;
  const has = !!voiceRecorder || !!$("#input").value.trim();
  b.classList.toggle("is-send", has); b.classList.toggle("is-mic", !has);
  b.setAttribute("aria-label", voiceRecorder ? "إرسال التسجيل" : has ? "إرسال" : "تسجيل رسالة صوتية");
}
function setVoiceState(active) { $("#form").classList.toggle("recording", active); $("#recBar").classList.toggle("hidden", !active); syncSendMic(); }
function bytesToB64(bytes) { let out = ""; for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(out); }
function vpDownsample(a, n = 40) {
  if (!a.length) return null;
  const out = []; let max = 0.001;
  for (let i = 0; i < n; i++) { const s0 = Math.floor(i * a.length / n), e0 = Math.max(s0 + 1, Math.floor((i + 1) * a.length / n)); let m = 0; for (let j = s0; j < e0 && j < a.length; j++) m = Math.max(m, a[j]); out.push(m); max = Math.max(max, m); }
  return out.map(v => Math.round(Math.min(1, v / max) * 31));
}
function finishVoice(cancel = false) {
  const r = voiceRecorder; if (!r) return;
  voiceCancel = !!cancel; voiceRecorder = null; clearTimeout(voiceTimer); clearInterval(voiceTick); setVoiceState(false);
  try { if (r.state !== "inactive") r.stop(); } catch {}
}
async function startVoice() {
  if (voiceRecorder) return finishVoice();
  const chat = S.chat;
  if (!chat || !chat.peer) return toast("الرسائل الصوتية المشفّرة متاحة حاليًا في الخاص فقط");
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast("المتصفح لا يدعم تسجيل الصوت");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const type = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
    const r = new MediaRecorder(stream, { mimeType: type, audioBitsPerSecond: 24000 });
    voiceRecorder = r; voiceChunks = []; voiceStarted = Date.now(); voiceCancel = false; voiceWf = [];
    $("#recTime").textContent = "0:00"; setVoiceState(true);
    let ctx = null, an = null, buf = null;
    try { ctx = new (window.AudioContext || window.webkitAudioContext)(); an = ctx.createAnalyser(); an.fftSize = 512; ctx.createMediaStreamSource(stream).connect(an); buf = new Uint8Array(an.fftSize); } catch { ctx = null; an = null; }
    voiceTick = setInterval(() => {
      if (an) { an.getByteTimeDomainData(buf); let sum = 0; for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; } voiceWf.push(Math.sqrt(sum / buf.length)); }
      const sec = Math.floor((Date.now() - voiceStarted) / 1000); $("#recTime").textContent = Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
    }, 100);
    r.ondataavailable = e => { if (e.data.size) voiceChunks.push(e.data); };
    r.onerror = () => { stream.getTracks().forEach(t => t.stop()); clearInterval(voiceTick); voiceRecorder = null; setVoiceState(false); toast("تعذّر تسجيل الصوت"); };
    r.onstop = async () => {
      stream.getTracks().forEach(t => t.stop()); try { ctx && ctx.close(); } catch {}
      const blob = new Blob(voiceChunks, { type }), dur = (Date.now() - voiceStarted) / 1000; voiceChunks = [];
      if (voiceCancel) return;
      if (dur < 0.7) return toast("التسجيل قصير جدًا");
      if (!chat.peer && blob.size > 180 * 1024) return toast("التسجيل أكبر من 180 KB؛ قرّبه أو سجّل مدة أقصر");
      try {
        const wf = vpDownsample(voiceWf);
        if (chat.peer) { await relaySend(chat, blob, { kind: "voice", name: "es-voice.webm", type, dur: Math.round(dur), ...(wf ? { wf } : {}) }); toast("اتبعثت الرسالة الصوتية مشفّرة"); return; }
        const raw = new Uint8Array(await blob.arrayBuffer()), file = { name: "es-voice.webm", type, bytes: raw.byteLength, data: bytesToB64(raw), dur: Math.round(dur) };
        if (wf) file.wf = wf;
        await sendTo(chat, { file }); toast("اتبعثت الرسالة الصوتية مشفّرة");
      } catch (e) { console.error(e); toast("الرسالة الصوتية ماتبعتتش"); }
    };
    r.start(250); voiceTimer = setTimeout(() => finishVoice(), 45000);
  } catch (e) { console.error(e); setVoiceState(false); toast(e?.name === "NotAllowedError" ? "اسمح للموقع باستخدام الميكروفون" : "تعذّر تشغيل الميكروفون"); }
}
$("#sendMic").addEventListener("pointerdown", e => e.preventDefault());
$("#sendMic").onclick = () => {
  if (voiceRecorder) return finishVoice();
  if ($("#input").value.trim()) return $("#form").dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
  startVoice();
};
$("#recCancel").onclick = () => finishVoice(true);
(() => { const inp = $("#input"), d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value"); Object.defineProperty(inp, "value", { get() { return d.get.call(this); }, set(v) { d.set.call(this, v); syncSendMic(); }, configurable: true }); })();
const ES_STICKERS = [
  ["⚡", "طاقة ES"], ["👑", "ملك الشات"], ["🔥", "حماس"], ["💙", "قلب أزرق"],
  ["🚀", "انطلق"], ["🎯", "في الهدف"], ["😂", "ضحكة"], ["🤝", "اتفقنا"],
  ["🫡", "تمام يا قائد"], ["✨", "لمعة"], ["🔒", "خاص وآمن"], ["🎉", "احتفال"]
];
const customStickerGet = () => LS.get("custom_stickers", []).filter(x => x && x.img && String(x.img).startsWith("data:image/")).slice(-24);
const stickerFavGet = () => LS.get("sticker_favs", []);
const EMO_GROUPS = [
  ["الوجوه", "😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 💩 🤡 👻 👽 🤖"],
  ["الإيماءات", "👍 👎 👊 ✊ 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 ✌️ 🤞 🤟 🤘 👌 🤌 🤏 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 🖖 👋 🤙 💪 🫶 🫡 ✍️"],
  ["قلوب ورموز", "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💯 💢 💥 💫 💦 💨 🔥 ⭐ 🌟 ✨ ⚡ 🎉 🎊 🎯 🏆 👑 💎 🔔 📌 🔒 🔓 💡 ✅ ❌ ❓ ❗ 💬 👀"],
  ["أشياء", "🚀 ✈️ 🚗 ⚽ 🏀 🎮 🎧 🎤 🎵 🎶 📱 💻 📷 🎁 🎈 ☕ 🍕 🍔 🍟 🍰 🍫 🌹 🌸 🌙 ☀️ 🌈 ☁️ 🐱 🐶 🦁 🐼"]
];
/* ---------------- بانل الإيموجي والملصقات (شكل تيليجرام) ---------------- */
const STK_FAV = "sticker_favs2", STK_REC = "sticker_recent", EMO_REC = "emo_recent";
function stickerItems() {
  const base = ES_STICKERS.map(([emoji, label]) => ({ id: "e:" + emoji, emoji, label }));
  return [...base, ...customStickerGet().map(x => ({ ...x, id: "c:" + x.at }))];
}
async function addCustomSticker(file) {
  if (!file || !S.chat?.peer) return;
  if (file.size > 2 * 1024 * 1024) return toast("صورة الملصق أكبر من 2 MB");
  try {
    const img = await compressImage(file, 320, 0.62);
    if (img.length > 72000) return toast("الملصق أكبر من 70 KB بعد الضغط");
    const list = [...customStickerGet(), { img, label: "ملصق شخصي", at: Date.now() }].slice(-24); LS.set("custom_stickers", list); toast("اتضافت للمكتبة على جهازك"); openPanel("stk");
  } catch { toast("ملف الملصق غير صالح"); }
}
function openPanel(tab = "emo") {
  if ($("#input").disabled) return;
  const dm = !!(S.chat && S.chat.peer);
  if (tab === "stk" && !dm) { toast("الملصقات المشفّرة متاحة حاليًا في الخاص فقط"); tab = "emo"; }
  const sh = openModal(`<div class="grab"></div><div class="tgp-body" id="tgpBody"></div><div class="tgp-bar" id="tgpBar"></div>`);
  sh.classList.add("emo-sheet", "tgp-sheet");
  const body = sh.querySelector("#tgpBody"), bar = sh.querySelector("#tgpBar");
  let cur = tab, lpT = 0, lpFired = false;
  const stkTile = (x, favs, removable = false) => `<button type="button" class="stk-tile" data-sid="${esc(x.id)}">${x.img ? `<img src="${esc(x.img)}" alt="" loading="lazy">` : `<span>${esc(x.emoji)}</span>`}${favs.includes(x.id) ? `<i class="stk-fav">${ic("star", 13)}</i>` : ""}${removable ? `<i class="stk-delete" data-del-sticker="${esc(x.id)}" role="button" aria-label="حذف الملصق" title="حذف">×</i>` : ""}</button>`;
  const stkHtml = (query = "") => {
    const items = stickerItems(), byId = new Map(items.map(x => [x.id, x])), favs = LS.get(STK_FAV, []).filter(i => byId.has(i)), rec = LS.get(STK_REC, []).filter(i => byId.has(i));
    const q = query.trim().toLocaleLowerCase();
    const matches = x => !q || `${x.label || ""} ${x.emoji || ""}`.toLocaleLowerCase().includes(q);
    const custom = items.filter(x => x.id[0] === "c" && matches(x)), pack = items.filter(x => x.id[0] === "e" && matches(x));
    const sec = (t, arr) => { const filtered = arr.filter(Boolean).filter(matches); return filtered.length ? `<div class="stk-h">${t}</div><div class="stk-grid">${filtered.map(x => stkTile(x, favs)).join("")}</div>` : ""; };
    if (q) return `<div class="stk-search-wrap"><input id="stkSearch" class="stk-search" type="search" value="${esc(query)}" placeholder="ابحث عن ملصق أو إيموجي…" aria-label="البحث عن ملصق"></div>${sec("نتائج البحث", [...custom, ...pack]) || `<p class="hint">مفيش ملصقات مطابقة للبحث.</p>`}`;
    return `<div class="stk-search-wrap"><input id="stkSearch" class="stk-search" type="search" placeholder="ابحث عن ملصق أو إيموجي…" aria-label="البحث عن ملصق"></div>`
      + (rec.length ? `<div class="stk-strip"><i class="stk-clock">${ic("clock", 15)}</i>${rec.slice(0, 14).map(i => stkTile(byId.get(i), favs)).join("")}</div>` : "")
      + sec("المفضلة", favs.map(i => byId.get(i)))
      + sec("مستخدمة حديثًا", rec.map(i => byId.get(i)).slice(0, 8))
      + `<div class="stk-h">ملصقاتي</div><div class="stk-grid"><button type="button" class="stk-tile stk-add" data-add="1"><span>＋</span><small>إنشاء</small></button>${custom.map(x => stkTile(x, favs, true)).join("")}</div>`
      + sec("ES Chat Pro", pack)
      + `<div class="hint stk-hint">اضغط مطوّلًا على ملصق لإضافته للمفضلة، واضغط × لحذف الملصق الشخصي.</div>`;
  };
  const emoHtml = () => {
    const rec = LS.get(EMO_REC, []);
    return `<div class="tgp-nav">${EMO_GROUPS.map(([t, g], i) => `<button type="button" data-go="eg${i}" title="${t}">${g.split(" ")[0]}</button>`).join("")}</div>`
      + (rec.length ? `<div class="panel-h">المستخدمة حديثًا</div><div class="emo-grid">${rec.map(e => `<button type="button" data-e="${e}">${e}</button>`).join("")}</div>` : "")
      + EMO_GROUPS.map(([t, g], i) => `<div class="panel-h" id="eg${i}">${t}</div><div class="emo-grid">${g.split(" ").map(e => `<button type="button" data-e="${e}">${e}</button>`).join("")}</div>`).join("");
  };
  const paint = (t, keep) => {
    cur = t; const st = keep ? body.scrollTop : 0;
    bar.innerHTML = dm ? `<div class="tgp-pill"><button type="button" data-t="stk" class="${t === "stk" ? "on" : ""}">الملصقات</button><button type="button" data-t="emo" class="${t === "emo" ? "on" : ""}">الرموز التعبيرية</button></div>` : "";
    body.innerHTML = t === "stk" ? stkHtml() : emoHtml(); body.scrollTop = st;
    const search = body.querySelector("#stkSearch");
    if (search) search.addEventListener("input", () => { const value = search.value, pos = value.length; body.innerHTML = stkHtml(value); const next = body.querySelector("#stkSearch"); if (next) { next.focus(); next.setSelectionRange(pos, pos); } });
  };
  paint(tab);
  bar.onclick = e => { const b = e.target.closest("[data-t]"); if (b && b.dataset.t !== cur) paint(b.dataset.t); };
  body.addEventListener("pointerdown", e => {
    if (e.target.closest("[data-del-sticker]")) return;
    const t = e.target.closest("[data-sid]"); if (!t) return; lpFired = false; clearTimeout(lpT);
    lpT = setTimeout(() => {
      lpFired = true; const id = t.dataset.sid, favs = LS.get(STK_FAV, []), has = favs.includes(id);
      LS.set(STK_FAV, has ? favs.filter(x => x !== id) : [...favs, id].slice(-30)); toast(has ? "اتشال من المفضلة" : "اتضاف للمفضلة"); paint("stk", true);
    }, 450);
  });
  for (const ev of ["pointerup", "pointerleave", "pointercancel", "scroll"]) body.addEventListener(ev, () => clearTimeout(lpT), true);
  body.addEventListener("contextmenu", e => e.preventDefault());
  body.onclick = async e => {
    const g = e.target.closest("[data-go]"); if (g) { const el = body.querySelector("#" + g.dataset.go); if (el) el.scrollIntoView({ block: "start", behavior: "smooth" }); return; }
    if (e.target.closest("[data-add]")) { $("#fileSticker").click(); return; }
    const del = e.target.closest("[data-del-sticker]");
    if (del) {
      e.preventDefault(); e.stopPropagation();
      const id = del.dataset.delSticker, at = Number(String(id).slice(2));
      const list = customStickerGet().filter(x => Number(x.at) !== at);
      LS.set("custom_stickers", list);
      LS.set(STK_FAV, LS.get(STK_FAV, []).filter(x => x !== id));
      LS.set(STK_REC, LS.get(STK_REC, []).filter(x => x !== id));
      toast("اتحذف الملصق من مكتبتك على الجهاز"); paint("stk", true); return;
    }
    const s = e.target.closest("[data-sid]");
    if (s) {
      if (lpFired) { lpFired = false; return; }
      const x = stickerItems().find(i => i.id === s.dataset.sid); if (!x) return;
      LS.set(STK_REC, [x.id, ...LS.get(STK_REC, []).filter(i => i !== x.id)].slice(0, 20));
      closeModal(); try { await sendTo(S.chat, { sticker: x.img ? { img: x.img, label: x.label } : { emoji: x.emoji, label: x.label } }); } catch { toast("الملصق ماتبعتش"); }
      return;
    }
    const b = e.target.closest("[data-e]"); if (!b) return;
    const inp = $("#input"), ch = b.dataset.e, v = inp.value, st = inp.selectionStart ?? v.length, en = inp.selectionEnd ?? st;
    if (v.length - (en - st) + ch.length > inp.maxLength) return;
    inp.value = v.slice(0, st) + ch + v.slice(en);
    const p = st + ch.length; try { inp.setSelectionRange(p, p); } catch {}
    inp.dispatchEvent(new Event("input"));
    LS.set(EMO_REC, [ch, ...LS.get(EMO_REC, []).filter(i => i !== ch)].slice(0, 24));
  };
}
const openStickerPicker = () => openPanel("stk");
const openEmojiPanel = () => openPanel("emo");

$("#emojiBtn").onclick = openEmojiPanel;
$("#fileImg").onchange = e => { sendImage(e.target.files[0]); e.target.value = ""; };
$("#fileCam").onchange = e => { sendImage(e.target.files[0]); e.target.value = ""; };
$("#fileDoc").onchange = e => { sendFile(e.target.files[0]); e.target.value = ""; };
$("#fileSticker").onchange = e => { addCustomSticker(e.target.files[0]); e.target.value = ""; };
$("#attachBtn").onclick = () => {
  if (!S.chat || $("#input").disabled) return;
  const ST = S.site || {}, ow = isOwner(), okI = ow || ST.allowImages !== false, okF = ow || ST.allowFiles !== false, okL = ow || ST.allowLoc !== false, okP = ow || ST.allowPolls !== false;
  const items = [];
  if (okI) items.push(["img", "image", "المعرض", "#3b82f6,#1d4ed8"], ["cam", "camera", "الكاميرا", "#f43f5e,#be123c"]);
  if (S.chat.peer && okF) items.push(["file", "file", "ملف", "#06b6d4,#0e7490"]);
  if (okL) items.push(["loc", "pin", "الموقع", "#22c55e,#15803d"]);
  if (okP) items.push(["poll", "poll", "استفتاء", "#f59e0b,#b45309"]);
  if (S.chat.peer) items.push(["sticker", "sticker", "ملصقات", "#a855f7,#6d28d9"]);
  const sh = openModal(`<div class="grab"></div><div class="att-title">إرفاق</div><div class="att-grid">${items.map(([a, i, t, g]) => `<button type="button" class="att" data-a="${a}"><span class="att-ic" style="background:linear-gradient(145deg,${g})">${ic(i, 26)}</span><b>${t}</b></button>`).join("")}</div>${S.chat.peer && okF ? `<div class="hint att-hint">الملفات المشفّرة حتى 180 KB</div>` : ""}`);
  sh.classList.add("att-sheet");
  sh.querySelector(".att-grid").onclick = e => {
    const b = e.target.closest("[data-a]"); if (!b) return; const a = b.dataset.a; closeModal();
    if (a === "sticker") openStickerPicker();
    else if (a === "poll") openPollMaker();
    else if (a === "img") $("#fileImg").click();
    else if (a === "cam") $("#fileCam").click();
    else if (a === "file") $("#fileDoc").click();
    else if (a === "loc") {
      if (!navigator.geolocation) return toast("المتصفح مش بيدعم المواقع");
      if (!confirm("تبعت موقعك الحالي؟")) return; const c = S.chat;
      navigator.geolocation.getCurrentPosition(p => sendTo(c, { loc: { lat: +p.coords.latitude.toFixed(5), lng: +p.coords.longitude.toFixed(5) } }).catch(() => {}), () => toast("مقدرتش أوصل لموقعك. تأكد إن إذن الموقع مفعّل."), { enableHighAccuracy: true, timeout: 12000 });
    }
  };
};

/* ---------------- المجموعات والقنوات ---------------- */
const isGMember = g => !!g && (g.members || []).includes(S.user.uid);
const isGAdmin = g => !!g && isGMember(g) && (g.owner === S.user.uid || (g.admins || []).includes(S.user.uid));
const gCount = g => (g.members || []).length + (g.kind === "channel" ? " متابع" : " عضو");
const gAvatar = (g, cls = "") => `<div class="avatar ${g.kind === "channel" ? "chan" : "grp"} ${cls}"${g.id ? ` data-ag="${esc(g.id)}"` : ""}>${g.photo && String(g.photo).startsWith("data:image/") ? `<img src="${esc(g.photo)}" alt="">` : esc((g.name || "?").trim().charAt(0).toUpperCase())}</div>`;
const CHAN_IC = `<svg class="mini-ic" width="14" height="14" viewBox="0 0 24 24" aria-label="قناة"><path d="M3 10v4l11 5V5L3 10zm13-1.5v7a3.5 3.5 0 0 0 0-7zM5 15l1 5h3l-1-4" fill="currentColor"/></svg>`;
const inviteLink = g => g.kind === "channel" && g.handle && g.public ? `${location.origin}${location.pathname}?c=${g.handle}` : `${location.origin}${location.pathname}?g=${g.id}${g._k ? "&k=" + g._k : ""}`;
const newKey = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), x => x.toString(16).padStart(2, "0")).join("");
const invKey = gid => { try { const [g, k] = String(sessionStorage.es_k || "").split("."); return g === gid ? k : ""; } catch { return ""; } };
const copyText = (t, ok) => (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => toast(ok), () => toast(t));

// ---------- كروت الروابط داخل الشات (روابط الموقع بس، بتتبني على جهاز المستقبل) ----------
function linkCardHtml(text) {
  if (!LS.get("lcards", true)) return "";
  const m = String(text || "").match(/https?:\/\/[^\s]+/); if (!m) return "";
  let u; try { u = new URL(m[0]); } catch { return ""; }
  if (u.origin !== location.origin) return "";
  const p = u.searchParams, k = p.get("u") ? "u" : p.get("c") ? "c" : p.get("g") ? "g" : ""; if (!k) return "";
  return `<a class="lcard" data-k="${k}" data-v="${esc(p.get(k))}" href="${esc(u.pathname + u.search)}"></a>`;
}
async function hydrateLinkCards() {
  for (const el of document.querySelectorAll(".lcard:not([data-done])")) {
    el.dataset.done = 1;
    const k = el.dataset.k, v = el.dataset.v; let d = null;
    try {
      if (k === "u") {
        const s = await getDoc(doc(db, "usernames", v));
        if (s.exists()) { const p = await getDoc(doc(db, "users", s.data().uid, "public", "profile")); if (p.exists()) d = { n: p.data().name, s: p.data().bio || "@" + v, p: p.data().photo, t: "بروفايل" }; }
      } else if (k === "c") {
        const h = await getDoc(doc(db, "handles", v));
        if (h.exists()) { const g = await getDoc(doc(db, "groupDirectory", h.data().gid)); if (g.exists()) d = { n: g.data().name, s: g.data().desc || "قناة", p: g.data().photo, t: "قناة" }; }
      } else {
        d = { n: "دعوة لمجموعة", s: "اضغط للانضمام", p: "", t: "مجموعة" };
        const g = await getDoc(doc(db, "groupDirectory", v));
        if (g.exists()) d = { n: g.data().name, s: g.data().desc || (g.data().kind === "channel" ? "قناة" : "اضغط للانضمام"), p: g.data().photo, t: g.data().kind === "channel" ? "قناة" : "مجموعة" };
      }
    } catch {}
    if (!d) { el.remove(); continue; }
    const ph = /^(https:\/\/|data:image\/)/.test(d.p || "") ? `<img src="${esc(d.p)}" alt="">` : `<span class="lc-ph">${esc((d.n || "?").slice(0, 1))}</span>`;
    el.innerHTML = `${ph}<div class="lc-t"><b>${esc(d.n)}</b><small>${esc(d.s)}</small><i>${esc(d.t)}</i></div>`;
  }
}
// مشاركة لأي برنامج لو المتصفح بيدعم، وإلا نسخ
const shareOrCopy = (url, title, ok) => (navigator.share ? navigator.share({ title, url }).catch(e => { if (e && e.name !== "AbortError") copyText(url, ok); }) : copyText(url, ok));
function closeChatSubs() { ["msgs", "peerDoc", "chatDoc", "gdoc"].forEach(k => { if (S.unsub[k]) { S.unsub[k](); delete S.unsub[k]; } }); }

async function fetchGroup(gid) {
  let g = S.groups.find(x => x.id === gid);
  if (g) return g;
  try { const s = await getDoc(doc(db, "groups", gid)); if (s.exists()) return { id: gid, ...s.data() }; const d = await getDoc(doc(db, "groupDirectory", gid)); return d.exists() ? { id: gid, ...d.data(), members: [], admins: [] } : null; } catch { try { const d = await getDoc(doc(db, "groupDirectory", gid)); return d.exists() ? { id: gid, ...d.data(), members: [], admins: [] } : null; } catch { return null; } }
}
async function openGroup(gid) {
  const g = await fetchGroup(gid);
  if (!g) return toast("المجموعة أو القناة مش موجودة");
  if (!isGMember(g) && !(g.kind === "channel" && g.public)) return openJoin(g);
  closeChatSubs(); clearTimeout(S.typT);
  S.chat = { id: gid, type: g.kind, peer: null, group: g, first: true, reply: null, doc: null, sig: "", cleaned: new Set(), lastTyping: undefined, typingAt: 0, sentTyping: 0, sentRead: 0 };
  $("#composerWrap").classList.remove("hidden"); $("#app").classList.add("open"); layerOpen("chat", chatUiClose);
  $("#messages").innerHTML = ""; paintReply(); hideQuick(); markRead(gid); applyComposerState(); paintHead(); renderList();
  S.unsub.msgs = onSnapshot(query(collection(db, "groups", gid, "messages"), orderBy("at"), limitToLast(MSG_PAGE)),
    snap => { if (S.chat && S.chat.id === gid) renderMsgs(liveMsgs(S.chat, snap)); }, e => { console.error(e); toast("مفيش صلاحية لقراءة الرسايل — راجع قواعد Firestore"); });
  S.unsub.gdoc = onSnapshot(doc(db, "groups", gid), s => {
    if (!S.chat || S.chat.id !== gid) return;
    if (!s.exists()) { toast("اتحذفت"); showEmpty(); return; }
    const old = S.chat.group; S.chat.group = { id: gid, ...s.data() };
    const sig = g => JSON.stringify([isGMember(g), isGAdmin(g), !!g.sendAdmins]);
    paintHead();
    if (sig(old) !== sig(S.chat.group)) { applyComposerState(); if (S.chat.lastDocs) renderMsgs(S.chat.lastDocs); }
  }, () => {});
}
function openJoin(g) {
  const sh = openModal(`<div class="prof">${gAvatar(g, "big")}<h3>${esc(g.name)}</h3><div class="chips"><span class="chip">${g.kind === "channel" ? "قناة" : "مجموعة"}</span><span class="chip">${gCount(g)}</span></div>
    ${g.desc ? `<div class="bio">${esc(g.desc)}</div>` : ""}
    ${g.joinOpen ? `<div class="actions"><button class="btn-primary" id="jGo">${g.kind === "channel" ? "متابعة القناة" : g.approve ? "طلب الانضمام" : "انضمام للمجموعة"}</button></div>` : `<div class="hint err" style="text-align:center">رابط الانضمام مقفول. اطلب من مشرف يضيفك.</div>`}</div>`);
  const b = sh.querySelector("#jGo"); if (b) b.onclick = async () => { b.disabled = true; if (await joinGroup(g)) { closeModal(); openGroup(g.id); } else b.disabled = false; };
}
async function joinGroup(g) {
  if ((g.banned || []).includes(S.user.uid)) { toast("مش مسموحلك تنضم هنا"); return false; }
  const me = S.user.uid, key = invKey(g.id), b = writeBatch(db);
  if (key) b.set(doc(db, "groups", g.id, "invites", me), { k: key });
  if (g.approve && g.kind === "group") {
    b.set(doc(db, "groups", g.id, "requests", me), { at: serverTimestamp(), name: (S.me.name || "").slice(0, 40) });
    try { await b.commit(); toast("اتبعت طلب الانضمام. مستني موافقة المشرف"); }
    catch {
      let pend = false; try { pend = (await getDoc(doc(db, "groups", g.id, "requests", me))).exists(); } catch {}
      toast(pend ? "طلبك لسه مستني موافقة المشرف" : "تعذّر إرسال الطلب (ممكن الرابط قديم. اطلب رابط جديد)");
    }
    return false;
  }
  b.update(doc(db, "groups", g.id), { members: arrayUnion(me) });
  try { await b.commit(); toast(g.kind === "channel" ? "بقيت متابع للقناة" : "اتضمّيت للمجموعة"); return true; }
  catch (e) { console.error(e); toast("تعذّر الانضمام (ممكن الرابط اتقفل أو اتغيّر أو العدد اكتمل). اطلب رابط جديد من مشرف."); return false; }
}
async function acceptAdminInvite(str) {
  const [gid, tok] = String(str).split(".");
  if (!gid || !tok) return toast("رابط دعوة المشرف مش صحيح");
  try {
    let g = await fetchGroup(gid); if (!g) return toast("المجموعة مش موجودة");
    if (isGAdmin(g)) return toast("إنت مشرف بالفعل");
    if (!isGMember(g)) { if (!(await joinGroup(g))) return; g = await fetchGroup(gid); }
    const b = writeBatch(db), me = S.user.uid;
    b.set(doc(db, "groups", gid, "adminAccepts", me), { t: tok });
    b.update(doc(db, "groups", gid), { admins: arrayUnion(me) });
    b.delete(doc(db, "groups", gid, "adminInvites", tok));
    await b.commit(); toast("بقيت مشرف 🎉"); openGroup(gid);
  } catch (e) { console.error(e); toast("الدعوة دي اتستخدمت أو اتلغت أو مش صحيحة"); }
}
async function leaveGroup(g) {
  const me = S.user.uid, mem = g.members || [];
  let patch = { members: arrayRemove(me), admins: arrayRemove(me) };
  if (g.owner === me) {
    const next = (g.admins || []).find(a => a !== me && mem.includes(a)) || mem.find(m => m !== me);
    if (!next) return toast("إنت الوحيد هنا. لو عايز تقفلها احذفها");
    await ensureUsers([next]);
    if (!confirm("هتنقل الملكية لـ " + ((S.users.get(next) || {}).name || "عضو") + " وتخرج. متأكد؟")) return;
    patch = { owner: next, members: mem.filter(x => x !== me), admins: [...new Set([...(g.admins || []).filter(x => x !== me), next])] };
  } else if (!confirm(g.kind === "channel" ? "تلغي متابعة القناة؟" : "تخرج من المجموعة؟")) return;
  try { await updateDoc(doc(db, "groups", g.id), patch); closeModal(); if (S.chat && S.chat.id === g.id) showEmpty(); toast("تم"); }
  catch { toast("تعذّر الخروج"); }
}

/* قايمة جديد + اكتشاف القنوات */
function openNewMenu() {
  const sh = openModal(`<div class="menu"><div class="menu-h">جديد</div>
    <button class="mrow" data-a="story"><span>حالة جديدة</span></button><button class="mrow" data-a="stories"><span>مشاهدة الحالات</span></button><button class="mrow" data-a="group"><span>مجموعة جديدة</span></button><button class="mrow" data-a="channel"><span>قناة جديدة</span></button><button class="mrow" data-a="find"><span>استكشاف القنوات</span></button></div>`);
  sh.querySelector(".menu").onclick = e => { const b = e.target.closest("[data-a]"); if (!b) return; closeModal(); if (b.dataset.a === "find") openDiscover(); else if (b.dataset.a === "story") openStoryComposer(); else if (b.dataset.a === "stories") openStories(); else openCreate(b.dataset.a); };
}
$("#newBtn").onclick = openNewMenu;
async function openStoryComposer() {
  const contacts = S.chats.map(c => { const id = peerOf(c), u = S.users.get(id) || {}; return { id, u }; }).filter(x => x.id && x.u.username);
  const sh = openModal(`<div class="menu"><div class="menu-h">حالة جديدة</div><div class="field"><label for="storyText">النص</label><textarea id="storyText" maxlength="2000" rows="4" placeholder="اكتب حالة..." style="width:100%"></textarea></div><div class="field"><button type="button" class="btn-ghost" id="storyPick">إضافة صورة</button><span class="hint" id="storyFileName">اختياري</span></div><div class="field"><label for="storyAudience">مين يشوفها؟</label><select id="storyAudience"><option value="public">الكل</option><option value="contacts">جهات الاتصال</option><option value="custom">أشخاص محددون</option></select></div><div id="storyCustom" class="story-custom hidden">${contacts.length ? contacts.map(x => `<label class="check-row"><input type="checkbox" value="${esc(x.id)}"><span>${esc(x.u.name || x.u.username)} <bdi>@${esc(x.u.username)}</bdi></span></label>`).join("") : `<div class="hint">لا توجد جهات اتصال جاهزة.</div>`}</div><button type="button" class="btn-primary" id="storySend">نشر الحالة</button></div>`);
  let img = "";
  const pick = sh.querySelector("#storyPick"), file = $("#storyFile");
  pick.onclick = () => file.click();
  file.onchange = async e => { const f = e.target.files[0]; e.target.value = ""; if (!f) return; if (f.size > 2 * 1024 * 1024) return toast("الصورة أكبر من 2 MB"); try { img = await compressImage(f, 720, .68); if (img.length >= 180000) { img = ""; return toast("الصورة أكبر من الحد بعد الضغط"); } sh.querySelector("#storyFileName").textContent = "تم اختيار صورة"; } catch { toast("الصورة غير صالحة"); } };
  sh.querySelector("#storyAudience").onchange = e => sh.querySelector("#storyCustom").classList.toggle("hidden", e.target.value !== "custom");
  sh.querySelector("#storySend").onclick = async () => { const text = sh.querySelector("#storyText").value.trim(), audience = sh.querySelector("#storyAudience").value, custom = [...sh.querySelectorAll("#storyCustom input:checked")].map(x => x.value); if (!text && !img) return toast("اكتب نص أو أضف صورة"); if (audience === "custom" && !custom.length) return toast("اختار شخصًا واحدًا على الأقل"); const b = sh.querySelector("#storySend"); b.disabled = true; try { const ref = await addDoc(collection(db, "stories", S.user.uid, "items"), { uid: S.user.uid, text, img, audience, custom, createdAt: serverTimestamp(), expiresAt: new Date(Date.now() + 86400000) }); const ix = await getDoc(doc(db, "users", S.user.uid, "public", "storyIndex")); const ids = ix.exists() ? (ix.data().ids || []) : []; await setDoc(doc(db, "users", S.user.uid, "public", "storyIndex"), { uid: S.user.uid, ids: [...ids.filter(x => x !== ref.id), ref.id].slice(-20), updatedAt: serverTimestamp() }, { merge: true }); closeModal(); toast("اتنشرت الحالة لمدة 24 ساعة"); } catch (e) { console.error(e); b.disabled = false; toast("تعذّر نشر الحالة"); } };
}
async function openStories() {
  const owners = [S.user.uid, ...S.chats.map(peerOf).filter(Boolean).slice(0, 30)], sh = openModal(`<div class="menu"><div class="menu-h">الحالات</div><div id="storyList"><div class="empty-list">جاري تحميل الحالات...</div></div></div>`), out = sh.querySelector("#storyList");
  const rows = [];
  for (const uid of [...new Set(owners)]) { try { const ix = await getDoc(doc(db, "users", uid, "public", "storyIndex")); if (!ix.exists()) continue; for (const sid of (ix.data().ids || []).slice(-20).reverse()) { const s = await getDoc(doc(db, "stories", uid, "items", sid)); if (!s.exists() || !toDate(s.data().expiresAt) || toDate(s.data().expiresAt) <= new Date()) continue; rows.push({ id: sid, uid, ...s.data() }); } } catch {} }
  await ensureUsers(rows.map(x => x.uid));
  out.innerHTML = rows.length ? rows.map((x, i) => { const u = x.uid === S.user.uid ? S.me : (S.users.get(x.uid) || {}); return `<div class="story-card" data-story="${i}">${x.img ? `<img src="${esc(x.img)}" alt="">` : ""}<div class="story-body"><b>${esc(u.name || "مستخدم")}</b><small>${fmtDT(x.createdAt)}</small>${x.text ? `<p>${mentionHtml(x.text, false)}</p>` : ""}</div>${x.uid === S.user.uid ? `<button class="btn-danger sm" data-del="${i}">حذف</button>` : ""}</div>`; }).join("") : `<div class="empty-list">مفيش حالات متاحة حاليًا.</div>`;
  out.onclick = async e => { const d = e.target.closest("[data-del]"); if (d) { const x = rows[+d.dataset.del]; if (!confirm("تحذف الحالة؟")) return; try { await deleteDoc(doc(db, "stories", S.user.uid, "items", x.id)); const ix = await getDoc(doc(db, "users", S.user.uid, "public", "storyIndex")); await setDoc(doc(db, "users", S.user.uid, "public", "storyIndex"), { uid: S.user.uid, ids: (ix.data()?.ids || []).filter(id => id !== x.id), updatedAt: serverTimestamp() }, { merge: true }); closeModal(); toast("اتحذفت الحالة"); } catch { toast("تعذّر الحذف"); } return; } const card = e.target.closest("[data-story]"); if (!card) return; const x = rows[+card.dataset.story]; if (x.uid !== S.user.uid) setDoc(doc(db, "stories", x.uid, "items", x.id, "views", S.user.uid), { uid: S.user.uid, at: serverTimestamp() }, { merge: true }).catch(() => {}); };
}
async function openDiscover() {
  const sh = openModal(`<div class="menu"><div class="menu-h">استكشاف القنوات</div><div id="dList"><div class="empty-list">جاري التحميل...</div></div></div>`);
  let list = [];
  try { list = (await getDocs(query(collection(db, "groupDirectory"), where("kind", "==", "channel"), where("public", "==", true), limit(30)))).docs.map(d => ({ id: d.id, ...d.data(), members: [], admins: [] })); }
  catch (e) { console.error(e); }
  list.sort((a, b) => (b.members || []).length - (a.members || []).length);
  const box = sh.querySelector("#dList");
  box.innerHTML = list.length ? list.map(g => `<div class="row-item" data-g="${esc(g.id)}">${gAvatar(g)}<div class="meta"><div class="name">${esc(g.name)}</div><small>${gCount(g)}${g.desc ? " · " + esc(g.desc.slice(0, 40)) : ""}</small></div></div>`).join("") : `<div class="empty-list">مفيش قنوات عامة لسه. اعمل أول واحدة!</div>`;
  box.onclick = e => { const r = e.target.closest("[data-g]"); if (r) { closeModal(); openGroup(r.dataset.g); } };
}

/* إنشاء مجموعة / قناة */
function openCreate(kind) {
  if (!isOwner() && (S.site || {}).allowGroups === false) return toast("إنشاء المجموعات والقنوات متوقف حاليًا");
  const isCh = kind === "channel";
  let photo = "", members = [], handleOk = true, pub = true, ht;
  const sh = openModal(`<div class="menu"><div class="menu-h">${isCh ? "قناة جديدة" : "مجموعة جديدة"}</div>
    <div class="field"><div class="photo-pick"><div id="cpv"></div><div><button type="button" class="btn-ghost" id="cpPick">اختيار صورة</button></div></div><input type="file" id="cpFile" accept="image/*" hidden></div>
    <div class="field"><label for="cN">الاسم</label><input type="text" id="cN" maxlength="50" placeholder="${isCh ? "اسم القناة" : "اسم المجموعة"}"></div>
    <div class="field"><label for="cD">الوصف (اختياري)</label><textarea id="cD" maxlength="${isCh ? 512 : 200}" style="min-height:70px"></textarea></div>
    ${isCh ? `${switchRow("cPub", true, "قناة عامة", "بتظهر في استكشاف القنوات وتقدر الناس تدور عليها بـ #الاسم")}
      <div class="field" id="cHWrap" style="margin-top:12px"><label for="cH">اسم القناة للبحث (اختياري)</label><input type="text" id="cH" maxlength="20" placeholder="my_channel" autocapitalize="none" style="direction:ltr;text-align:end"><div class="hint" id="cHH">حروف إنجليزي صغيرة وأرقام و _</div></div>`
      : `<div class="field"><label for="cM">أضف أعضاء (بالـ username)</label><div class="inline-add"><input type="text" id="cM" placeholder="username" autocapitalize="none" style="direction:ltr;text-align:end"><button type="button" class="btn-mini" id="cMAdd">إضافة</button></div><div class="chips-wrap" id="cMList"></div><div class="hint" id="cMH"></div></div>`}
    <div class="hint err" id="cErr"></div><div class="actions"><button class="btn-primary" id="cGo">إنشاء</button></div></div>`);
  const q = id => sh.querySelector(id);
  const paintPv = () => { q("#cpv").innerHTML = gAvatar({ kind, name: q("#cN").value || "?", photo }, "big"); }; paintPv(); q("#cN").oninput = paintPv;
  q("#cpPick").onclick = () => q("#cpFile").click();
  q("#cpFile").onchange = async e => { const f = e.target.files[0]; if (!f) return; try { photo = await compressPhoto(f); paintPv(); } catch { toast("الصورة دي مش مدعومة"); } };
  if (isCh) {
    q("#cPub").onchange = e => { pub = e.target.checked; q("#cHWrap").classList.toggle("hidden", !pub); };
    q("#cH").oninput = () => {
      handleOk = false; clearTimeout(ht); const v = q("#cH").value.trim().toLowerCase(), h = q("#cHH"); h.className = "hint";
      if (!v) { handleOk = true; h.textContent = "حروف إنجليزي صغيرة وأرقام و _"; return; }
      if (!/^[a-z0-9_]{3,20}$/.test(v)) { h.textContent = "حروف إنجليزي صغيرة وأرقام و _ (من 3 لـ 20)"; return; }
      h.textContent = "بتأكد إن الاسم متاح...";
      ht = setTimeout(async () => { try { const s = await getDoc(doc(db, "handles", v)); if (q("#cH").value.trim().toLowerCase() !== v) return; handleOk = !s.exists(); h.className = "hint " + (handleOk ? "ok" : "err"); h.textContent = handleOk ? "الاسم متاح" : "الاسم ده مستخدم، جرّب غيره"; } catch { h.className = "hint err"; h.textContent = "تعذّر التحقق"; } }, 400);
    };
  } else {
    const paintM = () => { q("#cMList").innerHTML = members.map(m => `<span class="m-chip" data-r="${esc(m.uid)}">${esc(m.u.name)} ${ic("close", 11)}</span>`).join(""); };
    q("#cMList").onclick = e => { const c = e.target.closest("[data-r]"); if (c) { members = members.filter(m => m.uid !== c.dataset.r); paintM(); } };
    q("#cMAdd").onclick = async () => {
      const name = q("#cM").value.trim().toLowerCase().replace(/^@/, ""), h = q("#cMH"); h.className = "hint";
      if (!/^[a-z0-9_]{3,20}$/.test(name)) { h.className = "hint err"; h.textContent = "اكتب اليوزر صح"; return; }
      if (members.length >= 50) { h.className = "hint err"; h.textContent = "أقصى حاجة 50 عضو وقت الإنشاء، وتقدر تضيف بعدين."; return; }
      try {
        const s = await getDoc(doc(db, "usernames", name));
        if (!s.exists()) { h.className = "hint err"; h.textContent = "مفيش حد بالاسم ده"; return; }
        const uid = s.data().uid; if (uid === S.user.uid || members.some(m => m.uid === uid)) { h.textContent = "متضاف بالفعل"; return; }
        const u = await getUser(uid); if (!u) { h.className = "hint err"; h.textContent = "مفيش حد بالاسم ده"; return; }
        members.push({ uid, u }); q("#cM").value = ""; h.textContent = ""; paintM();
      } catch { h.className = "hint err"; h.textContent = "تعذّر البحث"; }
    };
  }
  q("#cGo").onclick = async () => {
    const err = q("#cErr"); err.textContent = ""; const name = q("#cN").value.trim();
    if (!name) { err.textContent = "اكتب الاسم."; return; }
    const handle = isCh && pub ? q("#cH").value.trim().toLowerCase() : "";
    if (handle && !handleOk) { err.textContent = "اسم القناة للبحث مش متاح أو مش صحيح."; return; }
    q("#cGo").disabled = true;
    try {
      const gid = (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "") : Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 20);
      const b = writeBatch(db);
      b.set(doc(db, "groups", gid), { kind, name, desc: q("#cD").value.trim(), photo, owner: S.user.uid, admins: [S.user.uid], members: [S.user.uid, ...members.map(m => m.uid)], public: isCh && pub, joinOpen: true, handle, createdAt: serverTimestamp() });
      b.set(doc(db, "groupDirectory", gid), { kind, name, desc: q("#cD").value.trim(), photo, owner: S.user.uid, public: isCh && pub, verified: false, joinOpen: true, handle, createdAt: serverTimestamp() });
      b.set(doc(db, "groups", gid, "secret", "invite"), { key: newKey() });
      if (handle) b.set(doc(db, "handles", handle), { gid, owner: S.user.uid });
      await b.commit(); closeModal(); toast(isCh ? "اتعملت القناة" : "اتعملت المجموعة"); openGroup(gid);
    } catch (e) { console.error(e); err.textContent = "تعذّر الإنشاء (" + (e.code || e.message) + ")"; q("#cGo").disabled = false; }
  };
}

/* معلومات المجموعة / القناة */
async function openGroupInfo(gid) {
  const g = await fetchGroup(gid); if (!g) return;
  const me = S.user.uid, admin = isGAdmin(g), owner = g.owner === me, member = isGMember(g), ch = g.kind === "channel";
  const ids = ch ? (g.admins || []) : (g.members || []).slice(0, 100);
  let reqs = [];
  if (admin && !ch && g.approve) { try { reqs = (await getDocs(collection(db, "groups", gid, "requests"))).docs.map(d => d.id); } catch {} }
  g._k = ""; if (member) { try { const sk = await getDoc(doc(db, "groups", gid, "secret", "invite")); g._k = sk.exists() ? sk.data().key : ""; } catch {} }
  const bans = admin ? (g.banned || []).slice(0, 50) : [];
  await ensureUsers([...ids, ...reqs, ...bans]);
  const reqHtml = reqs.length ? `<div class="panel-h">طلبات الانضمام (${reqs.length})</div>` + reqs.map(id => { const u = S.users.get(id) || { name: "مستخدم" }; return `<div class="row-item">${avatar(u)}<div class="meta"><div class="name">${esc(contactName(id, u.name))}</div><small><bdi>@${esc(u.username || "")}</bdi></small></div><div class="end"><button class="btn-mini" data-ok="${esc(id)}">قبول</button><button class="btn-danger sm" data-no="${esc(id)}">رفض</button></div></div>`; }).join("") : "";
  const banHtml = bans.length ? `<div class="panel-h">الممنوعين (${bans.length})</div>` + bans.map(id => { const u = S.users.get(id) || { name: "مستخدم" }; return `<div class="row-item">${avatar(u)}<div class="meta"><div class="name">${esc(contactName(id, u.name))}</div><small><bdi>@${esc(u.username || "")}</bdi></small></div><div class="end"><button class="btn-mini ghost" data-unban="${esc(id)}">رفع المنع</button></div></div>`; }).join("") : "";
  const role = id => id === g.owner ? "المالك" : (g.admins || []).includes(id) ? "مشرف" : "";
  const rows = ids.map(id => { const u = S.users.get(id) || { name: "مستخدم" }, r = role(id);
    const canRm = admin && id !== g.owner && id !== me && (owner || !(g.admins || []).includes(id));
    return `<div class="row-item" data-u="${esc(id)}">${avatar(u)}<div class="meta"><div class="name">${esc(contactName(id, u.name))}${badge(u, 14)}${r ? ` <span class="chip sm ${r === "المالك" ? "owner" : ""}">${r}</span>` : ""}</div><small><bdi>@${esc(u.username || "")}</bdi></small></div>
      <div class="end">${owner && id !== me ? `<button class="btn-mini ghost" data-pro="${esc(id)}">${(g.admins || []).includes(id) ? "إلغاء الإشراف" : "ترقية"}</button>` : ""}${admin && !ch && canRm && !(g.admins || []).includes(id) ? `<button class="btn-mini ghost" data-mu="${esc(id)}">${g.muted && +g.muted[id] > Date.now() ? "إلغاء الكتم" : "كتم"}</button>` : ""}${canRm ? `<button class="btn-danger sm" data-rm="${esc(id)}">إزالة</button>` : ""}</div></div>`; }).join("");
  const sh = openModal(`<div class="prof">${gAvatar(g, "big")}<h3>${esc(g.name)}</h3>
      <div class="chips"><span class="chip">${ch ? "قناة" : "مجموعة"}</span><span class="chip">${gCount(g)}</span>${g.handle ? `<span class="chip"><bdi>#${esc(g.handle)}</bdi></span>` : ""}</div>
      ${ch ? `<div class="ci-tiles">${admin ? `<button type="button" class="ci-tile" id="giStats"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg><span>الإحصائيات</span></button>` : ""}<button type="button" class="ci-tile" id="giShare"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v14"/></svg><span>مشاركة</span></button><button type="button" class="ci-tile" id="giSearch"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg><span>بحث</span></button></div>
      <div class="ci-card"><div class="ci-k">الوصف</div><div class="ci-v">${g.desc ? esc(g.desc) : "<span class='hint'>مفيش وصف</span>"}</div>${g.joinOpen ? `<div class="ci-k">رابط الدعوة</div><div class="ci-v ci-link"><bdi dir="ltr">${esc(inviteLink(g).replace(/^https?:\/\//, ""))}</bdi></div>` : ""}</div>
      <div class="ci-card ci-stats"><div class="ci-row"><span>المتابعون</span><b>${(g.members || []).length}</b></div><div class="ci-row"><span>المشرفون</span><b>${(g.admins || []).length + 1}</b></div></div>` : g.desc ? `<div class="bio">${esc(g.desc)}</div>` : ""}
      <div class="actions">${g.joinOpen ? `<button class="btn-ghost" id="giLink">نسخ رابط الدعوة</button>` : ""}${admin && !(ch && g.public) ? `<button class="btn-ghost" id="giReset">إعادة تعيين الرابط</button>` : ""}${owner ? `<button class="btn-ghost" id="giAi">رابط دعوة مشرف</button><button class="btn-ghost" id="giAiX">إلغاء روابط المشرفين</button>` : ""}${admin ? `<button class="btn-primary" id="giEdit">تعديل</button>` : ""}</div></div>
    ${admin && ch ? `<div class="panel-h">الإعدادات</div>${isOwner() ? switchRow("giVer", !!g.verified, "قناة موثقة داخل ES Chat", "شارة زرقاء داخل موقعك فقط، وليست توثيق Meta أو واتساب") : ""}${switchRow("giOpen", !!g.joinOpen, "رابط الدعوة شغال", "لو اتقفل محدش يقدر ينضم بالرابط")}${switchRow("giRe", !g.noReact, "التفاعل بالإيموجي", "الأعضاء يقدروا يتفاعلوا على الرسايل")}${ch ? switchRow("giPub", !!g.public, "قناة عامة", "تظهر في استكشاف القنوات") : switchRow("giSend", !!g.sendAdmins, "الإرسال للمشرفين فقط", "باقي الأعضاء بيقروا بس") + switchRow("giApr", !!g.approve, "الموافقة على الأعضاء الجدد", "اللي ينضم بالرابط لازم مشرف يوافق عليه")}
      <div class="field" style="margin-top:14px"><label for="giAdd">إضافة ${ch ? "متابع" : "عضو"} باليوزر</label><div class="inline-add"><input type="text" id="giAdd" placeholder="username" autocapitalize="none" style="direction:ltr;text-align:end"><button class="btn-mini" id="giAddBtn">إضافة</button></div><div class="hint" id="giH"></div></div>${ch ? `<div class="field" style="margin-top:14px"><label for="giRm">إزالة متابع باليوزر</label><div class="inline-add"><input type="text" id="giRm" placeholder="username" autocapitalize="none" style="direction:ltr;text-align:end"><button class="btn-danger sm" id="giRmBtn">إزالة</button></div><div class="hint" id="giRmH">القايمة مخفية، فالإزالة بتتم باليوزر. وتقدر تمنعه من الرجوع بالرابط.</div></div>${owner ? `<div class="field" style="margin-top:14px"><label for="giPr">ترقية مشرف باليوزر</label><div class="inline-add"><input type="text" id="giPr" placeholder="username" autocapitalize="none" style="direction:ltr;text-align:end"><button class="btn-mini" id="giPrBtn">ترقية</button></div><div class="hint" id="giPrH">لازم يكون متابع. أقصى عدد مشرفين 15 + المالك.</div></div>` : ""}` : ""}` : ""}
    ${reqHtml}${banHtml}
    <div class="panel-h">${ch ? "المشرفين" : "الأعضاء"}</div>${!ch && ids.length > 8 ? `<div class="field"><input type="text" id="giFind" placeholder="بحث في الأعضاء..." autocomplete="off"></div>` : ""}<div id="giList">${rows}</div>${ch ? `<div class="hint">${gCount(g)} · قايمة المتابعين مخفية للخصوصية (حتى عن المشرفين)</div>` : (g.members || []).length > 100 ? `<div class="hint">عرض أول 100 فقط</div>` : ""}
    <div class="actions" style="margin-top:20px">${member && (!owner || (g.members || []).length > 1) ? `<button class="btn-danger" id="giLeave">${owner ? "الخروج ونقل الملكية" : ch ? "إلغاء المتابعة" : "الخروج من المجموعة"}</button>` : ""}${owner ? `<button class="btn-danger" id="giDel">حذف ${ch ? "القناة" : "المجموعة"}</button>` : ""}</div>`, true);
  const q = id => sh.querySelector(id), up = patch => updateDoc(doc(db, "groups", gid), patch).then(() => openGroupInfo(gid)).catch(() => toast("تعذّر الحفظ"));
  const l = q("#giLink"); if (l) l.onclick = () => shareOrCopy(inviteLink(g), g.name || "ES Chat Pro", "اتنسخ رابط الدعوة");
  const rs = q("#giReset"); if (rs) rs.onclick = async () => {
    if (!confirm("الرابط القديم هيبطّل يشتغل لأي حد جديد. تكمل؟")) return;
    const k = newKey();
    try { await setDoc(doc(db, "groups", gid, "secret", "invite"), { key: k }); g._k = k; copyText(inviteLink(g), "اتغيّر الرابط واتنسخ الجديد"); }
    catch { toast("تعذّر تغيير الرابط"); }
  };
  const ai = q("#giAi"); if (ai) ai.onclick = async () => {
    const t = newKey() + newKey().slice(0, 8);
    try { await setDoc(doc(db, "groups", gid, "adminInvites", t), { at: serverTimestamp() }); copyText(`${location.origin}${location.pathname}?ai=${gid}.${t}`, "اتنسخ رابط دعوة المشرف. بيشتغل مرة واحدة"); }
    catch { toast("تعذّر إنشاء الرابط"); }
  };
  const aix = q("#giAiX"); if (aix) aix.onclick = async () => {
    if (!confirm("تلغي كل روابط دعوة المشرفين اللي لسه ما اتستخدمتش؟")) return;
    try { const s = await getDocs(collection(db, "groups", gid, "adminInvites")); const b = writeBatch(db); s.docs.forEach(d => b.delete(d.ref)); await b.commit(); toast("اتلغت (" + s.size + ")"); }
    catch { toast("تعذّر الإلغاء"); }
  };
  const gst = q("#giStats"); if (gst) gst.onclick = () => openChannelStats(g);
  const gsh = q("#giShare"); if (gsh) gsh.onclick = () => shareOrCopy(inviteLink(g), g.name || "ES Chat Pro", "اتنسخ رابط القناة");
  const gse = q("#giSearch"); if (gse) gse.onclick = () => { closeModal(); if (S.chat && S.chat.id === gid) setTimeout(openChatSearch, 80); else toast("افتح القناة الأول"); };
  const gv = q("#giVer"); if (gv) gv.onchange = async e => { const next = e.target.checked; try { await updateDoc(doc(db, "groups", gid), { verified: next }); await setDoc(doc(db, "groupDirectory", gid), { verified: next }, { merge: true }); openGroupInfo(gid); } catch { e.target.checked = !next; toast("تعذّر حفظ التوثيق"); } };
  const ed = q("#giEdit"); if (ed) ed.onclick = () => openEditGroup(g);
  const o = q("#giOpen"); if (o) o.onchange = e => up({ joinOpen: e.target.checked });
  const ap = q("#giApr"); if (ap) ap.onchange = e => up({ approve: e.target.checked });
  sh.querySelectorAll("[data-ok],[data-no]").forEach(b => b.onclick = async () => {
    const id = b.dataset.ok || b.dataset.no;
    try { if (b.dataset.ok) await updateDoc(doc(db, "groups", gid), { members: arrayUnion(id) }); await deleteDoc(doc(db, "groups", gid, "requests", id)); toast(b.dataset.ok ? "اتقبل" : "اترفض"); openGroupInfo(gid); }
    catch { toast("تعذّر التنفيذ (ممكن العدد اكتمل)"); }
  });
  const rr = q("#giRe"); if (rr) rr.onchange = e => up({ noReact: !e.target.checked });
  const sb = q("#giSend"); if (sb) sb.onchange = e => up({ sendAdmins: e.target.checked });
  const pb = q("#giPub"); if (pb) pb.onchange = e => up({ public: e.target.checked });
  const ab = q("#giAddBtn"); if (ab) ab.onclick = async () => {
    const name = q("#giAdd").value.trim().toLowerCase().replace(/^@/, ""), h = q("#giH"); h.className = "hint";
    if (!/^[a-z0-9_]{3,20}$/.test(name)) { h.className = "hint err"; h.textContent = "اكتب اليوزر صح"; return; }
    try {
      const s = await getDoc(doc(db, "usernames", name)); if (!s.exists()) { h.className = "hint err"; h.textContent = "مفيش حد بالاسم ده"; return; }
      const uid = s.data().uid; if ((g.members || []).includes(uid)) { h.textContent = "موجود بالفعل"; return; }
      if ((g.banned || []).includes(uid)) { h.className = "hint err"; h.textContent = "الشخص ده ممنوع. ارفع المنع الأول."; return; }
      const tu = await getUser(uid); if (tu && tu.noAdd === true) { h.className = "hint err"; h.textContent = "الشخص ده مانع إضافته للمجموعات. ابعتله رابط الدعوة."; return; }
      await updateDoc(doc(db, "groups", gid), { members: arrayUnion(uid) }); toast("اتضاف"); openGroupInfo(gid);
    } catch { h.className = "hint err"; h.textContent = "تعذّرت الإضافة (ممكن العدد اكتمل)"; }
  };
  const rb = q("#giRmBtn"); if (rb) rb.onclick = async () => {
    const name = q("#giRm").value.trim().toLowerCase().replace(/^@/, ""), h = q("#giRmH"); h.className = "hint";
    if (!/^[a-z0-9_]{3,20}$/.test(name)) { h.className = "hint err"; h.textContent = "اكتب اليوزر صح"; return; }
    try {
      const s = await getDoc(doc(db, "usernames", name)); if (!s.exists()) { h.className = "hint err"; h.textContent = "مفيش حد بالاسم ده"; return; }
      const uid = s.data().uid;
      if (uid === g.owner || (!owner && (g.admins || []).includes(uid))) { h.className = "hint err"; h.textContent = "مينفعش تشيل مشرف"; return; }
      if (!(g.members || []).includes(uid)) { h.className = "hint err"; h.textContent = "مش متابع للقناة"; return; }
      if (!confirm("تشيل @" + name + " من القناة؟")) return;
      const bn = confirm("تمنعه كمان من الرجوع بالرابط؟ (OK = منع، Cancel = إزالة بس)");
      await updateDoc(doc(db, "groups", gid), { members: arrayRemove(uid), admins: arrayRemove(uid), ...(bn ? { banned: arrayUnion(uid) } : {}) }); toast("اتشال"); openGroupInfo(gid);
    } catch { h.className = "hint err"; h.textContent = "تعذّرت الإزالة"; }
  };
  sh.querySelectorAll("[data-unban]").forEach(b => b.onclick = () => up({ banned: arrayRemove(b.dataset.unban) }));
  const fd = q("#giFind"); if (fd) fd.oninput = () => { const t = fd.value.trim().toLowerCase(); sh.querySelectorAll("#giList .row-item").forEach(r => { r.style.display = !t || r.textContent.toLowerCase().includes(t) ? "" : "none"; }); };
  const pb2 = q("#giPrBtn"); if (pb2) pb2.onclick = async () => {
    const name = q("#giPr").value.trim().toLowerCase().replace(/^@/, ""), h = q("#giPrH"); h.className = "hint";
    if (!/^[a-z0-9_]{3,20}$/.test(name)) { h.className = "hint err"; h.textContent = "اكتب اليوزر صح"; return; }
    try {
      const s = await getDoc(doc(db, "usernames", name)); if (!s.exists()) { h.className = "hint err"; h.textContent = "مفيش حد بالاسم ده"; return; }
      const uid = s.data().uid;
      if ((g.admins || []).includes(uid)) { h.textContent = "هو مشرف بالفعل"; return; }
      if (!(g.members || []).includes(uid)) { h.className = "hint err"; h.textContent = "مش متابع للقناة"; return; }
      if ((g.admins || []).length >= 16) { h.className = "hint err"; h.textContent = "وصلت لأقصى عدد مشرفين (15 غير المالك)"; return; }
      await updateDoc(doc(db, "groups", gid), { admins: arrayUnion(uid) }); toast("اترقّى"); openGroupInfo(gid);
    } catch { h.className = "hint err"; h.textContent = "تعذّرت الترقية"; }
  };
  const list = q("#giList");
  list.onclick = async e => {
    const rm = e.target.closest("[data-rm]"), pro = e.target.closest("[data-pro]"), mu = e.target.closest("[data-mu]");
    if (mu) {
      const id = mu.dataset.mu, f = "muted." + id;
      if (g.muted && +g.muted[id] > Date.now()) return up({ [f]: deleteField() });
      const opts = [[86400000, "24 ساعة"], [604800000, "7 أيام"]];
      const m2 = openModal(`<div class="menu"><div class="menu-h">كتم ${esc(contactName(id, (S.users.get(id) || {}).name || "العضو"))}</div><p class="sub" style="margin:0 4px 8px">مش هيقدر يبعت رسايل للمدة دي.</p>${opts.map(([ms, t]) => `<button class="mrow" data-ms="${ms}"><span>${t}</span></button>`).join("")}</div>`);
      m2.querySelector(".menu").onclick = async ev => { const b = ev.target.closest("[data-ms]"); if (!b) return; try { await updateDoc(doc(db, "groups", gid), { [f]: Date.now() + +b.dataset.ms }); toast("اتكتم"); } catch { toast("تعذّر الكتم"); } openGroupInfo(gid); };
      return;
    }
    if (rm) { if (!confirm("تشيله؟")) return; const bn = confirm("تمنعه كمان من الرجوع بالرابط؟ (OK = منع، Cancel = إزالة بس)"); up({ members: arrayRemove(rm.dataset.rm), admins: arrayRemove(rm.dataset.rm), ...(bn ? { banned: arrayUnion(rm.dataset.rm) } : {}) }); }
    else if (pro) { const id = pro.dataset.pro; up({ admins: (g.admins || []).includes(id) ? arrayRemove(id) : arrayUnion(id) }); }
    else { const r = e.target.closest("[data-u]"); if (r) openProfile(r.dataset.u); }
  };
  const lv = q("#giLeave"); if (lv) lv.onclick = () => leaveGroup(g);
  const dl = q("#giDel"); if (dl) dl.onclick = async () => {
    if (!confirm("هيتم حذف " + (ch ? "القناة" : "المجموعة") + " نهائيًا. متأكد؟")) return;
    try { const b = writeBatch(db); b.delete(doc(db, "groups", gid)); if (g.handle) b.delete(doc(db, "handles", g.handle)); await b.commit(); closeModal(); if (S.chat && S.chat.id === gid) showEmpty(); toast("اتحذفت"); }
    catch { toast("تعذّر الحذف"); }
  };
}
function openEditGroup(g) {
  let photo = g.photo || "";
  const sh = openModal(`<div class="menu"><div class="menu-h">تعديل</div>
    <div class="field"><div class="photo-pick"><div id="epv"></div><div><button type="button" class="btn-ghost" id="epPick">تغيير الصورة</button></div></div><input type="file" id="epFile" accept="image/*" hidden></div>
    <div class="field"><label for="eN">الاسم</label><input type="text" id="eN" maxlength="50" value="${esc(g.name)}"></div>
    <div class="field"><label for="eD">الوصف</label><textarea id="eD" maxlength="${g.kind === "channel" ? 512 : 200}" style="min-height:70px">${esc(g.desc || "")}</textarea></div>
    <div class="actions"><button class="btn-primary" id="eGo">حفظ</button></div></div>`);
  const q = id => sh.querySelector(id), paint = () => { q("#epv").innerHTML = gAvatar({ kind: g.kind, name: q("#eN").value || "?", photo }, "big"); }; paint(); q("#eN").oninput = paint;
  q("#epPick").onclick = () => q("#epFile").click();
  q("#epFile").onchange = async e => { const f = e.target.files[0]; if (!f) return; try { photo = await compressPhoto(f); paint(); } catch { toast("الصورة دي مش مدعومة"); } };
  q("#eGo").onclick = async () => { const name = q("#eN").value.trim(); if (!name) return; try { await updateDoc(doc(db, "groups", g.id), { name, desc: q("#eD").value.trim(), photo }); toast("اتحفظ"); openGroupInfo(g.id); } catch { toast("تعذّر الحفظ"); } };
}
function openGroupMenu(gid) {
  const g = S.groups.find(x => x.id === gid); if (!g) return;
  const P = S.prefs, owner = g.owner === S.user.uid;
  const rows = [["info", g.kind === "channel" ? "معلومات القناة" : "معلومات المجموعة"], ...(g.kind === "group" ? [["topics", "مواضيع المجموعة"]] : []), ["pin", P.pins.includes(gid) ? "إلغاء تثبيت المحادثة" : "تثبيت المحادثة"], ["arch", P.arch.includes(gid) ? "إلغاء الأرشفة" : "أرشفة المحادثة"],
    ["mute", P.mute.includes(gid) ? "إلغاء كتم الإشعارات" : "كتم الإشعارات"], ["lbl", "مجلدات الدردشة"], ...(owner ? [] : [["leave", g.kind === "channel" ? "إلغاء المتابعة" : "الخروج من المجموعة", "", true]])];
  const sh = openModal(`<div class="menu"><div class="menu-h">${esc(g.name)}</div>${rows.map(([a, t, v, d]) => `<button class="mrow ${d ? "danger" : ""}" data-a="${a}"><span>${t}</span></button>`).join("")}</div>`);
  sh.querySelector(".menu").onclick = async e => {
    const b = e.target.closest("[data-a]"); if (!b) return; const a = b.dataset.a; closeModal();
    if (a === "info") openGroupInfo(gid);
    else if (a === "topics") openTopics(gid);
    else if (a === "pin") { if (!P.pins.includes(gid) && P.pins.length >= 3) return toast("أقصى حاجة 3 محادثات مثبتة"); savePrefs({ pins: toggleIn(P.pins, gid) }); }
    else if (a === "arch") savePrefs({ arch: toggleIn(P.arch, gid) });
    else if (a === "mute") savePrefs({ mute: toggleIn(P.mute, gid) });
    else if (a === "lbl") openLabelPicker(gid);
    else if (a === "leave") leaveGroup(g);
  };
}
async function openTopics(gid) {
  const g = await fetchGroup(gid); if (!g || !isGMember(g)) return toast("الموضوعات متاحة لأعضاء المجموعة فقط");
  const admin = isGAdmin(g), sh = openModal(`<div class="menu"><div class="menu-h">مواضيع المجموعة</div><p class="sub">اختار موضوعًا لتجميع الرسائل. الحالي: <b id="topicCurrent">${esc((S.chat && S.chat.id === gid && S.chat.topicName) || "الكل")}</b></p><div id="topicList"><div class="empty-list">جاري التحميل...</div></div>${admin ? `<div class="field"><input id="topicName" maxlength="40" placeholder="اسم موضوع جديد"></div><button class="btn-primary" id="topicAdd">إضافة موضوع</button>` : ""}</div>`), out = sh.querySelector("#topicList");
  let topics = [];
  try { topics = (await getDocs(collection(db, "groups", gid, "topics"))).docs.map(d => ({ id: d.id, ...d.data() })).filter(t => !t.archived).sort((a, b) => (toDate(a.createdAt)?.getTime() || 0) - (toDate(b.createdAt)?.getTime() || 0)); } catch { out.innerHTML = `<div class="empty-list">تعذّر تحميل المواضيع.</div>`; return; }
  const draw = () => { out.innerHTML = `<button class="topic-row ${!(S.chat && S.chat.topicId) ? "on" : ""}" data-topic=""><b>الكل</b><small>كل رسائل المجموعة</small></button>` + (topics.length ? topics.map(t => `<button class="topic-row ${(S.chat && S.chat.topicId === t.id) ? "on" : ""}" data-topic="${esc(t.id)}"><b># ${esc(t.name)}</b><small>${t.createdBy === S.user.uid ? "من إنشائك" : "موضوع المجموعة"}</small>${admin ? `<i data-archive="${esc(t.id)}">إخفاء</i>` : ""}</button>`).join("") : `<div class="empty-list">مفيش مواضيع لسه.</div>`); };
  draw();
  out.onclick = async e => { const ar = e.target.closest("[data-archive]"); if (ar) { e.stopPropagation(); try { await updateDoc(doc(db, "groups", gid, "topics", ar.dataset.archive), { archived: true }); topics = topics.filter(t => t.id !== ar.dataset.archive); draw(); } catch { toast("تعذّر إخفاء الموضوع"); } return; } const b = e.target.closest("[data-topic]"); if (!b) return; if (S.chat && S.chat.id === gid) { const t = topics.find(x => x.id === b.dataset.topic); S.chat.topicId = b.dataset.topic || ""; S.chat.topicName = t?.name || "الكل"; if (S.chat.lastDocs) renderMsgsPlain(S.chat.lastDocs); } closeModal(); toast(b.dataset.topic ? "اتحدد الموضوع: " + (topics.find(x => x.id === b.dataset.topic)?.name || "") : "هتظهر كل مواضيع المجموعة"); };
  const add = sh.querySelector("#topicAdd"); if (add) add.onclick = async () => { const name = sh.querySelector("#topicName").value.trim(); if (!name) return toast("اكتب اسم الموضوع"); add.disabled = true; try { const r = await addDoc(collection(db, "groups", gid, "topics"), { name, createdBy: S.user.uid, createdAt: serverTimestamp(), archived: false }); topics.push({ id: r.id, name, createdBy: S.user.uid, archived: false }); sh.querySelector("#topicName").value = ""; draw(); toast("اتضاف الموضوع"); } catch { toast("تعذّر إضافة الموضوع"); } add.disabled = false; };
}
async function openByHandle(h) {
  try {
    const s = await getDoc(doc(db, "handles", String(h).toLowerCase()));
    if (!s.exists()) return toast("مفيش قناة بالاسم ده");
    openGroup(s.data().gid);
  } catch { toast("تعذّر فتح القناة"); }
}


async function runPushCheck() {
  const sh = openModal(`<div class="menu"><div class="menu-h">فحص الإشعارات</div><div id="pcList"></div><div class="actions"><button class="btn-ghost" id="pcAgain">إعادة الفحص</button></div></div>`);
  sh.querySelector("#pcAgain").onclick = runPushCheck;
  const list = sh.querySelector("#pcList"), rows = [];
  const step = (ok, t, d) => { rows.push(`<div class="pc ${ok ? "ok" : "bad"}"><b>${ok ? ic("check", 16) : ic("close", 16)}</b><div><span>${esc(t)}</span>${d ? `<small>${esc(d)}</small>` : ""}</div></div>`); list.innerHTML = rows.join(""); return ok; };
  if (!step("Notification" in window && "serviceWorker" in navigator && "PushManager" in window, "المتصفح بيدعم الإشعارات", "على الآيفون لازم تضيف الموقع للشاشة الرئيسية. على الأندرويد استخدم كروم.")) return;
  if (!step(Notification.permission === "granted", "إذن الإشعارات", Notification.permission === "granted" ? "" : "الإذن حاليًا: " + Notification.permission + ". فعّله من إعدادات الموقع في المتصفح.")) return;
  if (!step(VAPID_KEY.length > 40, "مفتاح VAPID في firebase-config.js", VAPID_KEY ? "" : "فاضي. انسخ المفتاح من Firebase › Cloud Messaging › Web Push certificates والصقه في VAPID_KEY.")) return;
  let reg; try { reg = await withTimeout(navigator.serviceWorker.ready, 8000); } catch {}
  if (!step(!!(reg && reg.active), "الـ service worker شغال", reg ? "" : "ملف firebase-messaging-sw.js مش متحمّل. اتأكد إنه مرفوع جنب index.html.")) return;
  let token = "";
  try {
    const M = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js");
    if (!(await M.isSupported())) throw Object.assign(new Error("not supported"), { code: "unsupported" });
    token = await M.getToken(M.getMessaging(fbApp), { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
  } catch (e) { step(false, "الحصول على توكن من Firebase", (e.code || e.message) + " — اتأكد إن مفتاح VAPID صح وإن Firebase Cloud Messaging API مفعّل للمشروع."); return; }
  if (!step(!!token, "الحصول على توكن من Firebase", token ? "…" + token.slice(-8) : "")) return;
  S.fcm = token;
  try {
    await setDoc(doc(db, "users", S.user.uid, "tokens", token), { at: serverTimestamp(), ua: navigator.userAgent.slice(0, 120) });
    const s = await getDoc(doc(db, "users", S.user.uid, "tokens", token)); if (!step(s.exists(), "تسجيل التوكن في Firestore")) return;
  } catch (e) { step(false, "تسجيل التوكن في Firestore", (e.code || e.message) + " — راجع قواعد Firestore (لازم تكون اتنشرت)."); return; }
  let r;
  try { const t = await S.user.getIdToken(); r = await fetch("/api/notify", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + t }, body: JSON.stringify({ selfTest: true }) }); }
  catch { step(false, "الاتصال بالسيرفر /api/notify", "مفيش اتصال."); return; }
  const j = await r.json().catch(() => ({}));
  if (r.status === 404) { step(false, "السيرفر /api/notify", "الملف api/notify.js مش مرفوع على Vercel (404). ارفعه مع package.json وسوّي Redeploy."); return; }
  if (!r.ok) { step(false, "السيرفر /api/notify", ("خطأ " + r.status + ": " + (j.code || j.error || "") + " " + (j.detail || "")).trim() + (String(j.code || "").startsWith("env") ? " — راجع متغير FIREBASE_SERVICE_ACCOUNT في Vercel وسوّي Redeploy." : "")); return; }
  if (!step(j.sent > 0, "السيرفر بعت إشعار تجريبي", j.sent > 0 ? "اتبعت لـ " + j.sent + " جهاز. لازم يظهرلك إشعار دلوقتي." : "التوكنز: " + (j.tokens || 0) + "، فشل: " + (j.failed || 0) + " " + (j.codes || []).join(" "))) return;
  step(true, "كله تمام", "لو الإشعار ظهر يبقى الإعداد سليم. اقفل الموقع وخلّي حد يبعتلك.");
}

/* ---------------- profile view ---------------- */
async function openProfile(uid, opts = {}) {
  let u = S.users.get(uid);
  if (!u) { try { const s = await getDoc(doc(db, "users", uid)); u = s.exists() ? s.data() : null; } catch {} }
  if (!u) return toast("البروفايل مش موجود");
  const self = uid === S.user.uid, own = isOwner(), savedAs = contactName(uid, "");
  const sh = openModal(`<div class="prof">
    ${avatar(u)}
    <h3>${esc(savedAs || u.name)}${badge(u, 22)}</h3>
    ${savedAs && savedAs !== u.name ? `<div class="un">الاسم على الموقع: ${esc(u.name)}</div>` : ""}
    <div class="un"><bdi>@${esc(u.username || "—")}</bdi></div>
    ${isOfficial(uid) ? `<div class="official-card">${ownerBadge(22)}<div><b>الحساب الرسمي</b><small>ده الحساب الرسمي لصاحب ES Chat Pro</small></div></div>` : ""}
    <div class="chips">${u.role === "owner" || isOfficial(uid) ? `<span class="chip owner">${CROWN} المالك · حساب رسمي</span>` : ""}<span class="chip">${genderText(u.gender)}</span>${u.banned ? `<span class="tag-ban">موقوف</span>` : ""}</div>
    ${u.bio ? `<div class="bio">${esc(u.bio)}</div>` : ""}
    ${own ? `<div class="kv"><div>الإيميل<span>${esc(u.email || "—")}</span></div><div>آخر دخول<span>${esc(fmtDT(u.lastLogin))}</span></div><div>مرات الدخول<span>${u.loginCount || 0}</span></div><div>تاريخ التسجيل<span>${esc(fmtDT(u.createdAt))}</span></div><div>UID<span>${esc(uid)}</span></div></div>` : ""}
    <div class="actions">
      ${self ? `<button class="btn-primary" id="pEdit">تعديل بروفايلي</button>` : u.onboarded ? `<button class="btn-primary" id="pMsg">مراسلة</button>` : ""}
      ${opts.fromPanel ? `<button class="btn-ghost" id="pBack">رجوع للوحة</button>` : ""}
    </div>
    ${own && !self ? `<div class="actions"><button class="btn-ghost" id="pVer">${u.verified ? "إزالة التوثيق" : "توثيق الحساب"}</button><button class="btn-danger" id="pBan">${u.banned ? "فك الحظر" : "حظر"}</button><button class="btn-danger" id="pDel">حذف الحساب</button></div>` : ""}
  </div>`);
  const on = (id, f) => { const el = sh.querySelector(id); if (el) el.onclick = f; };
  on("#pEdit", () => openEdit());
  on("#pMsg", () => { closeModal(); openChat(uid); });
  on("#pBack", openOwner);
  on("#pVer", async () => { const next = !u.verified; await updateDoc(doc(db, "users", uid), { verified: next }); await setDoc(doc(db, "users", uid, "public", "profile"), { verified: next }, { merge: true }); S.users.set(uid, { ...u, verified: next }); _au.t = 0; toast("تم"); openProfile(uid, opts); });
  on("#pBan", async () => { const nb = !u.banned; await updateDoc(doc(db, "users", uid), { banned: nb }); S.users.set(uid, { ...u, banned: nb }); _au.t = 0; toast("تم"); openProfile(uid, opts); });
  on("#pDel", async () => {
    if (!confirm("هيتم حذف بيانات الحساب واسم المستخدم نهائيًا. متأكد؟")) return;
    const b = writeBatch(db); b.delete(doc(db, "users", uid)); if (u.username) b.delete(doc(db, "usernames", u.username));
    await b.commit(); S.users.delete(uid); _au.t = 0; toast("اتحذف الحساب"); opts.fromPanel ? openOwner() : closeModal();
  });
}

/* ---------------- owner panel ---------------- */
let _au = { t: 0, a: null };
async function loadAllUsers(force) {
  if (!force && _au.a && Date.now() - _au.t < 45000) return _au.a;
  try { const sn = await getDocs(query(collection(db, "users"), limit(500))); sn.docs.forEach(d => S.users.set(d.id, d.data())); _au = { t: Date.now(), a: sn.docs.map(d => [d.id, d.data()]) }; }
  catch (e) { console.error(e); toast("تعذّر قراءة المستخدمين"); _au.a = _au.a || []; }
  return _au.a;
}
const OWNER_TABS = [["overview", "نظرة عامة"], ["users", "المستخدمون"], ["reports", "البلاغات"], ["groups", "القنوات والمجموعات"], ["logins", "سجل الدخول"], ["activity", "سجل النشاط"], ["settings", "إعدادات الموقع"]];
async function ownerAudit(action, targetUid = "", details = "") {
  if (!isOwner() || !S.user) return;
  try { await addDoc(collection(db, "ownerActivity"), { actorUid: S.user.uid, actorEmail: S.user.email || "", action: String(action).slice(0, 60), targetUid: String(targetUid).slice(0, 128), details: String(details).slice(0, 300), at: serverTimestamp() }); }
  catch (e) { console.warn("تعذّر تسجيل نشاط المالك", e); }
}
async function openOwner(tab = "overview") {
  if (!isOwner()) return;
  clearInterval(_ownTimer);
  let sh = $("#sheet");
  const fresh = !(sh.classList.contains("owner-sheet") && !$("#modal").classList.contains("hidden"));
  if (fresh) {
    sh = openModal(`<div class="op-head"><div class="op-bar"><span class="op-crown">${CROWN}</span><div><b>لوحة المالك</b><small>ES Chat Pro · تحكم كامل</small></div></div>
      <div class="tabs" id="tabs">${OWNER_TABS.map(([k, t]) => `<button type="button" data-t="${k}">${t}</button>`).join("")}</div></div>
      <div id="pbody" class="op-body"></div>`, true);
    sh.classList.add("owner-sheet");
    ownerSwipe(sh);
  }
  const body = sh.querySelector("#pbody");
  body.innerHTML = `<div class="op-skel"><i></i><i></i><i></i><i></i></div>`;
  body.scrollTop = 0;
  sh.querySelectorAll("[data-t]").forEach(b => {
    const on = b.dataset.t === tab; b.classList.toggle("on", on); b.onclick = () => openOwner(b.dataset.t);
    if (on) { try { b.scrollIntoView({ inline: "center", block: "nearest", behavior: fresh ? "auto" : "smooth" }); } catch {} }
  });
  const users = tab === "settings" || tab === "reports" || tab === "groups" ? (_au.a || []) : await loadAllUsers(tab === "overview");
  const row = (id, u, end) => `<div class="row-item" data-p="${esc(id)}">${avatar(u)}<div class="meta"><div class="name">${esc(u.name)}${badge(u, 15)}${u.banned ? ` <span class="tag-ban">موقوف</span>` : ""}</div><small><bdi>@${esc(u.username || "—")}</bdi> · ${esc(u.email || "")}</small></div><div class="end">${end}</div></div>`;
  const wire = () => body.querySelectorAll("[data-p]").forEach(r => r.onclick = () => openProfile(r.dataset.p, { fromPanel: true }));

  if (tab === "overview") {
    let stats = {};
    try { (await getDocs(collection(db, "stats"))).forEach(d => stats[d.id] = d.data().visits || 0); } catch { toast("تعذّر قراءة الإحصائيات"); }
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const today = users.filter(([, u]) => (toDate(u.lastLogin) || 0) >= start).length;
    const newToday = users.filter(([, u]) => (toDate(u.createdAt) || 0) >= start).length;
    const days = [...Array(7)].map((_, i) => { const d = new Date(Date.now() - (6 - i) * 864e5); return { l: d.toLocaleDateString("ar-EG", { weekday: "short" }), v: stats[dayKey(d)] || 0 }; });
    const mx = Math.max(1, ...days.map(d => d.v));
    const recent = [...users].sort((a, b) => (toDate(b[1].createdAt)?.getTime() || 0) - (toDate(a[1].createdAt)?.getTime() || 0)).slice(0, 6);
    body.innerHTML = `<div class="stats">
      <div class="stat"><b>${users.length}</b><span>إجمالي المسجلين</span></div>
      <div class="stat"><b>${users.filter(([, u]) => u.onboarded).length}</b><span>أكملوا البروفايل</span></div>
      <div class="stat"><b>${users.filter(([, u]) => isOnline(u)).length}</b><span>متصلين الآن</span></div>
      <div class="stat"><b>${today}</b><span>دخلوا النهارده</span></div>
      <div class="stat"><b>${newToday}</b><span>تسجيلات جديدة النهارده</span></div>
      <div class="stat"><b>${stats.global || 0}</b><span>إجمالي الزيارات</span></div>
      <div class="stat"><b>${stats[dayKey()] || 0}</b><span>زيارات النهارده</span></div>
      <div class="stat"><b>${users.filter(([, u]) => u.banned).length}</b><span>حسابات موقوفة</span></div></div>
      <div class="panel-h">الزيارات آخر 7 أيام</div>
      <div class="bars">${days.map(d => `<div class="bar">${d.v}<i style="height:${Math.round(d.v / mx * 70)}px"></i>${esc(d.l)}</div>`).join("")}</div>
      <div class="panel-h">آخر المسجلين</div>${recent.map(([id, u]) => row(id, u, esc(fmtDT(u.createdAt)))).join("") || `<div class="empty-list">لسه مفيش</div>`}`;
    wire();
  } else if (tab === "users") {
    let flt = "all";
    const FL = [["all", "الكل"], ["on", "متصل"], ["new", "جدد (7 أيام)"], ["ban", "موقوف"], ["ver", "موثّق"], ["inc", "ما كملوش"]];
    body.innerHTML = `<input class="panel-search" id="pq" placeholder="ابحث بالاسم أو اليوزر أو الإيميل"><div class="fl" id="fl">${FL.map(([k, t]) => `<button type="button" data-f="${k}" class="${k === "all" ? "on" : ""}">${t}</button>`).join("")}</div><div class="hint" id="pc"></div><div id="pl"></div>`;
    const paint = () => {
      const t = body.querySelector("#pq").value.trim().toLowerCase().replace(/^@/, ""), wk = Date.now() - 7 * 864e5;
      const ok = u => flt === "all" || (flt === "on" && isOnline(u)) || (flt === "new" && (toDate(u.createdAt)?.getTime() || 0) > wk) || (flt === "ban" && u.banned) || (flt === "ver" && u.verified) || (flt === "inc" && !u.onboarded);
      const list = users.filter(([, u]) => ok(u) && (!t || [u.name, u.username, u.email].some(x => (x || "").toLowerCase().includes(t))))
        .sort((a, b) => (toDate(b[1].createdAt)?.getTime() || 0) - (toDate(a[1].createdAt)?.getTime() || 0));
      body.querySelector("#pc").textContent = list.length + " مستخدم";
      body.querySelector("#pl").innerHTML = list.slice(0, 150).map(([id, u]) => row(id, u, `<div class="owner-user-actions"><button type="button" class="btn-mini ghost" data-owner-action="${u.banned ? "unban" : "ban"}" data-target="${esc(id)}">${u.banned ? "إلغاء الإيقاف" : "إيقاف"}</button><button type="button" class="btn-mini ghost" data-owner-action="${u.verified ? "unverify" : "verify"}" data-target="${esc(id)}">${u.verified ? "إلغاء التوثيق" : "توثيق"}</button><button type="button" class="btn-mini ghost" data-owner-action="${u.siteRole === "moderator" ? "unmod" : "setmod"}" data-target="${esc(id)}">${u.siteRole === "moderator" ? "إزالة وسم المشرف" : "وسم كمشرف"}</button><small>${u.siteRole === "moderator" ? "وسم داخلي: مشرف مجتمع<br>" : ""}آخر دخول<br>${esc(fmtDT(u.lastLogin))}</small></div>`)).join("") || `<div class="empty-list">مفيش نتايج</div>`;
      wire();
    };
    body.querySelector("#pq").oninput = paint;
    body.querySelector("#fl").onclick = e => { const b = e.target.closest("[data-f]"); if (!b) return; flt = b.dataset.f; body.querySelectorAll("#fl button").forEach(x => x.classList.toggle("on", x === b)); paint(); };
    body.querySelector("#pl").addEventListener("click", async e => {
      const b = e.target.closest("[data-owner-action]");
      if (!b) return;
      e.preventDefault(); e.stopPropagation();
      const uid = b.dataset.target, action = b.dataset.ownerAction;
      if (!uid || uid === S.user.uid) return toast("مش مسموح بتغيير حالة حساب المالك الحالي من هنا");
      const labels = { ban: "إيقاف الحساب ومنعه من استخدام الخدمات؟", unban: "إلغاء إيقاف الحساب؟", verify: "توثيق هذا الحساب داخل ES Chat؟", unverify: "إلغاء توثيق هذا الحساب؟", setmod: "إضافة وسم مشرف مجتمع لهذا الحساب؟ (لا يمنحه صلاحيات المالك)", unmod: "إزالة وسم مشرف المجتمع؟" };
      if (!confirm(labels[action] || "تأكيد العملية؟")) return;
      b.disabled = true;
      try {
        const patch = action === "ban" ? { banned: true } : action === "unban" ? { banned: false } : action === "verify" ? { verified: true } : action === "unverify" ? { verified: false } : action === "setmod" ? { siteRole: "moderator" } : { siteRole: deleteField() };
        await updateDoc(doc(db, "users", uid), patch);
        const oldUser = S.users.get(uid) || {};
        S.users.set(uid, { ...oldUser, ...patch });
        const at = { ban: "suspend_user", unban: "restore_user", verify: "verify_user", unverify: "unverify_user", setmod: "set_community_moderator_label", unmod: "remove_community_moderator_label" }[action];
        await ownerAudit(at, uid, action === "setmod" || action === "unmod" ? "وسم إداري داخلي فقط؛ لا يمنح صلاحيات مالك أو وصولًا إضافيًا" : "تم من لوحة المستخدمين");
        _au.t = 0;
        toast(({ ban: "تم إيقاف الحساب", unban: "تم إلغاء الإيقاف", verify: "تم توثيق الحساب", unverify: "تم إلغاء التوثيق", setmod: "تم وضع وسم مشرف المجتمع", unmod: "تمت إزالة وسم المشرف" })[action]);
        await openOwner("users");
      } catch (err) { console.error(err); toast("فشلت العملية؛ راجع صلاحيات Firestore واتصالك"); b.disabled = false; }
    });
    paint();
  } else if (tab === "reports") {
    let rs = [];
    try { rs = (await getDocs(query(collection(db, "reports"), orderBy("at", "desc"), limit(100)))).docs.map(d => ({ id: d.id, ...d.data() })); } catch { toast("تعذّر قراءة البلاغات"); }
    await ensureUsers(rs.flatMap(r => [r.reporter, r.targetUid]));
    const kt = k => ({ dm: "خاصة", public: "الغرفة العامة", group: "مجموعة", channel: "قناة" }[k] || "بلاغ");
    body.innerHTML = rs.length ? `<div class="hint">${rs.length} بلاغ</div>` + rs.map(r => `<div class="rep" data-r="${esc(r.id)}"><div class="rh"><b>${esc(kt(r.kind))}</b><small>${esc(fmtDT(r.at))}</small></div>
      <div class="rt">${esc(r.text || "(رسالة من غير نص)")}</div>
      <small>من: ${esc(nameOf(r.reporter))} · عن: ${esc(nameOf(r.targetUid))}</small>
      <div class="actions" style="justify-content:flex-start;margin-top:8px"><button class="btn-ghost" data-a="prof">فتح الحساب</button><button class="btn-danger" data-a="ban">حظر المُبلَّغ عنه</button><button class="btn-ghost" data-a="del">تم · احذف البلاغ</button></div></div>`).join("") : `<div class="empty-list">مفيش بلاغات. كله تمام 👌</div>`;
    body.onclick = async e => {
      const b = e.target.closest("[data-a]"); if (!b) return; const el = b.closest("[data-r]"), r = rs.find(x => x.id === el.dataset.r); if (!r) return;
      if (b.dataset.a === "prof") return openProfile(r.targetUid, { fromPanel: true });
      try {
        if (b.dataset.a === "ban") { if (!confirm("تحظر الحساب ده؟")) return; await updateDoc(doc(db, "users", r.targetUid), { banned: true }); await ownerAudit("ban_user_from_report", r.targetUid, `report:${r.id}`); const u = S.users.get(r.targetUid); if (u) S.users.set(r.targetUid, { ...u, banned: true }); _au.t = 0; toast("اتحظر الحساب"); }
        else { await deleteDoc(doc(db, "reports", r.id)); await ownerAudit("delete_report", r.targetUid, `report:${r.id}`); el.remove(); toast("اتحذف البلاغ"); }
      } catch { toast("تعذّر التنفيذ"); }
    };
  } else if (tab === "groups") {
    let gs = [];
    try { gs = (await getDocs(query(collection(db, "groupDirectory"), limit(200)))).docs.map(d => ({ id: d.id, ...d.data() })); } catch { toast("تعذّر قراءة القنوات والمجموعات"); }
    gs.sort((a, b) => (toDate(b.lastAt || b.createdAt)?.getTime() || 0) - (toDate(a.lastAt || a.createdAt)?.getTime() || 0));
    body.innerHTML = `<div class="hint">${gs.length} في الدليل (${gs.filter(g => g.kind === "channel").length} قناة)</div>` + (gs.map(g => `<div class="row-item" data-g="${esc(g.id)}">${gAvatar(g)}<div class="meta"><div class="name">${esc(g.name)}${g.verified ? ` <span class="chip">موثّقة</span>` : ""}</div><small>${g.kind === "channel" ? "قناة" : "مجموعة"} · ${g.public ? "عامة" : "خاصة"}${g.handle ? " · #" + esc(g.handle) : ""}</small></div><button class="btn-danger" data-del="${esc(g.id)}">إخفاء من الدليل</button></div>`).join("") || `<div class="empty-list">الدليل فاضي</div>`);
    body.onclick = async e => {
      const b = e.target.closest("[data-del]"); if (!b) return;
      if (!confirm("تشيل العنصر ده من دليل الاستكشاف؟ (المجموعة نفسها مش هتتحذف)")) return;
      try { await deleteDoc(doc(db, "groupDirectory", b.dataset.del)); await ownerAudit("hide_group_directory", b.dataset.del, "إخفاء من دليل الاستكشاف فقط"); b.closest(".row-item").remove(); toast("اتشال من الدليل"); } catch { toast("تعذّر التنفيذ"); }
    };
  } else if (tab === "activity") {
    let logs = [];
    try { logs = (await getDocs(query(collection(db, "ownerActivity"), orderBy("at", "desc"), limit(100)))).docs.map(d => ({ id: d.id, ...d.data() })); }
    catch (e) { console.error(e); toast("تعذّر قراءة سجل النشاط"); }
    const labels = { ban_user_from_report: "إيقاف مستخدم من بلاغ", delete_report: "حذف بلاغ", hide_group_directory: "إخفاء عنصر من الدليل", update_site_settings: "تعديل إعدادات الموقع", suspend_user: "إيقاف حساب", restore_user: "إلغاء إيقاف حساب", verify_user: "توثيق حساب داخل ES Chat", unverify_user: "إلغاء توثيق حساب", set_community_moderator_label: "إضافة وسم مشرف مجتمع", remove_community_moderator_label: "إزالة وسم مشرف مجتمع" };
    const drawLogs = () => {
      const q = (body.querySelector("#activitySearch")?.value || "").trim().toLowerCase();
      const kind = body.querySelector("#activityKind")?.value || "all";
      const filtered = logs.filter(x => (kind === "all" || x.action === kind) && (!q || [labels[x.action], x.action, x.actorEmail, x.actorUid, x.targetUid, x.details].some(v => String(v || "").toLowerCase().includes(q))));
      const out = body.querySelector("#activityRows");
      body.querySelector("#activityCount").textContent = `عرض ${filtered.length} من ${logs.length} عملية`;
      out.innerHTML = filtered.map(x => `<div class="rep"><div class="rh"><b>${esc(labels[x.action] || x.action || "نشاط إداري")}</b><small>${esc(fmtDT(x.at))}</small></div><small>المالك: <bdi>${esc(x.actorEmail || x.actorUid || "—")}</bdi></small>${x.targetUid ? `<small>المستهدف: <bdi>${esc(x.targetUid)}</bdi></small>` : ""}${x.details ? `<div class="rt">${esc(x.details)}</div>` : ""}</div>`).join("") || `<div class="empty-list">لا توجد نتائج مطابقة.</div>`;
    };
    const kinds = [...new Set(logs.map(x => x.action).filter(Boolean))];
    body.innerHTML = `<div class="hint">سجل العمليات الإدارية. لا يعرض محتوى الرسائل الخاصة، ويمكن البحث والتصفية محليًا. التصدير يشمل السجلات المحمّلة حاليًا فقط (حتى 100 سجل).</div><input class="panel-search" id="activitySearch" placeholder="ابحث بالإجراء أو المالك أو معرّف الحساب"><select class="panel-search" id="activityKind"><option value="all">كل الإجراءات</option>${kinds.map(k => `<option value="${esc(k)}">${esc(labels[k] || k)}</option>`).join("")}</select><div class="actions" style="justify-content:flex-start;margin:8px 0"><button type="button" class="btn-ghost" id="activityExport">تصدير النتائج CSV</button></div><div class="hint" id="activityCount"></div><div id="activityRows"></div>`;
    body.querySelector("#activitySearch").oninput = drawLogs;
    body.querySelector("#activityKind").onchange = drawLogs;
    body.querySelector("#activityExport").onclick = () => {
      const q = (body.querySelector("#activitySearch")?.value || "").trim().toLowerCase();
      const kind = body.querySelector("#activityKind")?.value || "all";
      const filtered = logs.filter(x => (kind === "all" || x.action === kind) && (!q || [labels[x.action], x.action, x.actorEmail, x.actorUid, x.targetUid, x.details].some(v => String(v || "").toLowerCase().includes(q))));
      const cell = value => `"${String(value ?? "").replace(/"/g, '""').replace(/[\r\n]+/g, " ")}"`;
      const rows = [["وقت العملية", "الإجراء", "معرّف المالك", "بريد المالك", "الحساب المستهدف", "التفاصيل"], ...filtered.map(x => [fmtDT(x.at), labels[x.action] || x.action || "نشاط إداري", x.actorUid, x.actorEmail, x.targetUid, x.details])];
      const csv = "\ufeff" + rows.map(r => r.map(cell).join(",")).join("\r\n");
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      const a = document.createElement("a"); a.href = url; a.download = `es-chat-owner-activity-${new Date().toISOString().slice(0,10)}.csv`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      toast(`تم تجهيز ${filtered.length} سجل للتصدير`);
    };
    drawLogs();
  } else if (tab === "settings") {
    const st = S.site || {};
    body.innerHTML = `${switchRow("sMaint", !!st.maintenance, "وضع الصيانة", "بيقفل الموقع على كل الأعضاء ماعدا حسابك")}
      ${switchRow("sReg", st.registrationOpen !== false, "فتح التسجيل", "لو اتقفل محدش جديد يقدر يعمل حساب")}
      ${switchRow("sPub", st.publicOpen !== false, "الغرفة العامة مفتوحة للكتابة", "لو اتقفلت إنت بس اللي بتكتب فيها")}
      ${switchRow("sRO", st.readOnly === true, "وضع القراءة فقط", "الكل يقرا، وإنت بس اللي تكتب (في كل المحادثات)")}
      ${switchRow("sGrp", st.allowGroups !== false, "السماح بإنشاء مجموعات وقنوات")}
      ${switchRow("sImg", st.allowImages !== false, "السماح بإرسال الصور")}
      ${switchRow("sFile", st.allowFiles !== false, "السماح بإرسال الملفات")}
      ${switchRow("sLoc", st.allowLoc !== false, "السماح بإرسال المواقع")}
      ${switchRow("sPoll", st.allowPolls !== false, "السماح بالاستفتاءات")}
      <div class="field" style="margin-top:14px"><label for="sLen">أقصى طول للرسالة (حرف)</label><input type="text" inputmode="numeric" id="sLen" maxlength="4" value="${esc(st.maxLen || 2000)}"></div>
      <div class="field"><label for="sSlow">الوضع البطيء في الغرفة العامة (ثواني بين كل رسالتين، 0 = مقفول)</label><input type="text" inputmode="numeric" id="sSlow" maxlength="3" value="${esc(st.slowSec || 0)}"></div>
      <div class="field"><label for="sBad">كلمات ممنوعة في الغرفة العامة والمجموعات (افصل بينها بفاصلة)</label><textarea id="sBad" maxlength="600" placeholder="كلمة1، كلمة2">${esc(st.badWords || "")}</textarea></div>
      <div class="hint">الحدود دي بتتطبّق من التطبيق نفسه، المحادثات الخاصة المشفّرة مش بتتفلتر.</div>
      <div class="field" style="margin-top:14px"><label for="sMsg">رسالة الصيانة</label><input type="text" id="sMsg" maxlength="120" value="${esc(st.maintenanceMsg || "")}" placeholder="هنرجع قريب"></div>
      <div class="field"><label for="sAnn">إعلان لكل الأعضاء (بيظهر فوق القايمة)</label><textarea id="sAnn" maxlength="200" placeholder="اكتب الإعلان هنا">${esc(st.announcement || "")}</textarea></div>
      <div class="actions" style="justify-content:flex-start"><button class="btn-primary" id="sSave">حفظ الإعدادات</button><button class="btn-ghost" id="sClear">مسح الإعلان</button></div>
      <div class="panel-h">البيانات</div>
      <div class="actions" style="justify-content:flex-start"><button class="btn-ghost" id="sCsv">تصدير المستخدمين (CSV)</button><button class="btn-danger" id="sClrPub">مسح آخر 100 رسالة من الغرفة العامة</button></div>`;
    const save = async extra => {
      try {
        await setDoc(doc(db, "settings", "site"), { maintenance: body.querySelector("#sMaint").checked, registrationOpen: body.querySelector("#sReg").checked, publicOpen: body.querySelector("#sPub").checked,
          readOnly: body.querySelector("#sRO").checked, allowGroups: body.querySelector("#sGrp").checked, allowImages: body.querySelector("#sImg").checked,
          allowFiles: body.querySelector("#sFile").checked, allowLoc: body.querySelector("#sLoc").checked, allowPolls: body.querySelector("#sPoll").checked,
          maxLen: Math.max(20, Math.min(2000, parseInt(body.querySelector("#sLen").value, 10) || 2000)), slowSec: Math.max(0, Math.min(300, parseInt(body.querySelector("#sSlow").value, 10) || 0)),
          badWords: body.querySelector("#sBad").value.trim(),
          maintenanceMsg: body.querySelector("#sMsg").value.trim(), announcement: body.querySelector("#sAnn").value.trim(), updatedAt: serverTimestamp(), ...(extra || {}) }, { merge: true });
        await ownerAudit("update_site_settings", "", "تحديث إعدادات الموقع"); toast("اتحفظت الإعدادات");
      } catch (e) { console.error(e); toast("تعذّر الحفظ"); }
    };
    body.querySelector("#sSave").onclick = () => save();
    body.querySelector("#sClear").onclick = () => { body.querySelector("#sAnn").value = ""; save({ announcement: "" }); };
    body.querySelector("#sClrPub").onclick = async () => {
      if (!confirm("هتتمسح آخر 100 رسالة من الغرفة العامة نهائيًا. متأكد؟")) return;
      try {
        const sn = await getDocs(query(collection(db, "chats", "public", "messages"), orderBy("at", "desc"), limit(100)));
        const b = writeBatch(db); sn.docs.forEach(d => b.delete(d.ref)); await b.commit(); toast("اتمسح " + sn.size + " رسالة");
      } catch (e) { console.error(e); toast("تعذّر المسح"); }
    };
    body.querySelector("#sCsv").onclick = () => {
      const cell = v => '"' + String(v ?? "").replace(/"/g, '""') + '"';
      const rows = [["الاسم", "اليوزر", "الإيميل", "النوع", "تاريخ التسجيل", "آخر دخول", "مرات الدخول", "موثّق", "موقوف"]].concat(users.map(([, u]) =>
        [u.name, u.username, u.email, genderText(u.gender), fmtDT(u.createdAt), fmtDT(u.lastLogin), u.loginCount || 0, u.verified ? "نعم" : "", u.banned ? "نعم" : ""]));
      const blob = new Blob(["\ufeff" + rows.map(r => r.map(cell).join(",")).join("\n")], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "es-chat-users.csv"; document.body.append(a); a.click(); a.remove();
    };
  } else {
    let rows = [];
    try { rows = (await getDocs(query(collection(db, "logins"), orderBy("at", "desc"), limit(80)))).docs.map(d => d.data()); } catch { toast("تعذّر قراءة سجل الدخول"); }
    body.innerHTML = rows.map(r => row(r.uid, S.users.get(r.uid) || { name: r.name }, esc(fmtDT(r.at)))).join("") || `<div class="empty-list">مفيش سجل دخول لسه</div>`;
    wire();
  }
  ownerAfter(sh, tab);
}
/* حركة وتنقل لوحة المالك: عدّاد أرقام، أعمدة بتطلع، سحب يمين/شمال بين التابات، وتحديث تلقائي للنظرة العامة */
function ownerSwipe(sh) {
  let x0 = 0, y0 = 0, t0 = 0, ok = false;
  const body = sh.querySelector("#pbody");
  body.addEventListener("touchstart", e => { const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; t0 = Date.now(); ok = !e.target.closest("input,textarea,select,.fl,.tabs"); }, { passive: true });
  body.addEventListener("touchend", e => {
    if (!ok) return; const t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0;
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.8 || Date.now() - t0 > 700) return;
    const cur = OWNER_TABS.findIndex(([k]) => sh.querySelector(`[data-t="${k}"]`)?.classList.contains("on"));
    const nx = cur + (dx < 0 ? 1 : -1); // الموقع RTL: السحب لليسار = التالي
    if (nx >= 0 && nx < OWNER_TABS.length) openOwner(OWNER_TABS[nx][0]);
  }, { passive: true });
  const tabs = sh.querySelector("#tabs"); let dn = false, sx = 0, sl = 0;
  tabs.addEventListener("mousedown", e => { dn = true; sx = e.pageX; sl = tabs.scrollLeft; });
  addEventListener("mouseup", () => { dn = false; });
  tabs.addEventListener("mousemove", e => { if (dn) tabs.scrollLeft = sl - (e.pageX - sx); });
}
function ownerAfter(sh, tab) {
  const body = sh.querySelector("#pbody"); if (!body) return;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.motion === "off";
  body.classList.remove("op-in"); void body.offsetWidth; body.classList.add("op-in");
  if (!reduce) {
    body.querySelectorAll(".stat b").forEach(el => {
      const raw = String(el.textContent).trim(), to = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN; if (!isFinite(to) || to < 2) return;
      const t0 = performance.now(), dur = 700;
      const step = now => { const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3); el.textContent = Math.round(to * e); if (k < 1) requestAnimationFrame(step); else el.textContent = to; };
      requestAnimationFrame(step);
    });
    body.querySelectorAll(".bar i").forEach(i => { const h = i.style.height; i.style.height = "3px"; requestAnimationFrame(() => requestAnimationFrame(() => { i.style.height = h; })); });
  }
  clearInterval(_ownTimer);
  if (tab === "overview") _ownTimer = setInterval(() => {
    if ($("#modal").classList.contains("hidden") || !$("#sheet").classList.contains("owner-sheet")) { clearInterval(_ownTimer); return; }
    if (!document.hidden && body.scrollTop < 5) { _au.t = 0; openOwner("overview"); }
  }, 45000);
}
