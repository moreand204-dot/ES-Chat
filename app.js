import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, enableNetwork, disableNetwork, waitForPendingWrites, doc, getDoc, setDoc, updateDoc, deleteDoc, collection, query, orderBy, limit, limitToLast,
  onSnapshot, addDoc, where, serverTimestamp, increment, writeBatch, getDocs, deleteField, arrayUnion, arrayRemove }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import * as CFG from "./firebase-config.js";
const { firebaseConfig, OWNER_EMAIL } = CFG;
const VAPID_KEY = CFG.VAPID_KEY || "";

/* ---------------- helpers ---------------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const S = { user: null, me: null, users: new Map(), chats: [], chat: null, found: null, site: {}, groups: [], gseen: new Map(), seen: new Map(), unsub: {}, view: "boot", filter: "all", prefs: { pins: [], arch: [], mute: [], block: [], labels: [], cl: {}, quick: [], stars: [] } };
const DEFAULT_PREFS = () => ({ pins: [], arch: [], mute: [], block: [], labels: [], cl: {}, quick: [], stars: [] });
try { const u = new URLSearchParams(location.search).get("u"); if (u) sessionStorage.es_u = u; const gp = new URLSearchParams(location.search).get("g"); if (gp) sessionStorage.es_g = gp; const cp = new URLSearchParams(location.search).get("c"); if (cp) sessionStorage.es_c = cp; } catch {}
const LS = {
  get: (k, d) => { try { const v = localStorage.getItem("es_" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem("es_" + k, JSON.stringify(v)); } catch {} },
};
const dayKey = (d = new Date()) => "d_" + d.toLocaleDateString("en-CA");
const toDate = t => (t && t.toDate ? t.toDate() : null);
const fmtDT = t => { const d = toDate(t); return d ? d.toLocaleString("ar-EG", { dateStyle: "medium", timeStyle: "short" }) : "—"; };
const fmtTime = d => d.toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" });
const sameDay = (a, b) => a.toDateString() === b.toDateString();
function dayLabel(d) {
  const n = new Date(), y = new Date(Date.now() - 864e5);
  if (sameDay(d, n)) return "اليوم";
  if (sameDay(d, y)) return "أمس";
  return d.toLocaleDateString("ar-EG", { dateStyle: "long" });
}
let toastT;
function toast(t) { const el = $("#toast"); el.textContent = t; el.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove("show"), 2600); }

const badge = (u, s = 16) => u && u.verified
  ? `<svg class="vbadge" width="${s}" height="${s}" viewBox="0 0 24 24" aria-label="حساب موثّق"><path d="M12 1.5l2.6 1.9 3.2-.1 1 3.1 2.6 1.9-1 3.1 1 3.1-2.6 1.9-1 3.1-3.2-.1L12 22.5l-2.6-1.9-3.2.1-1-3.1-2.6-1.9 1-3.1-1-3.1 2.6-1.9 1-3.1 3.2.1L12 1.5z" fill="#2f6bff" stroke="#cfdcff" stroke-width="1"/><path d="m7.8 12.2 3 3 5.6-6" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`
  : "";
const avatar = (u, cls = "") => {
  const p = u && u.photo;
  return `<div class="avatar ${cls}">${p && p.startsWith("data:image/") ? `<img src="${esc(p)}" alt="">` : esc(((u && u.name) || "?").trim().charAt(0).toUpperCase())}</div>`;
};
const CROWN = `<svg viewBox="0 0 24 24" width="20" height="20"><path d="M3 18h18l-1.5-9-4.5 4-3-6-3 6-4.5-4L3 18z" fill="currentColor"/></svg>`;
const genderText = g => (g === "female" ? "أنثى" : g === "male" ? "ذكر" : "—");
const isOwnerUser = u => !!u && (u.email || "").toLowerCase() === OWNER_EMAIL.toLowerCase() && u.emailVerified;
const isOwner = () => isOwnerUser(S.user);

function show(view) {
  S.view = view;
  for (const id of ["boot", "login", "onboard", "banned", "notice", "app"]) $("#" + id).classList.toggle("hidden", id !== view);
}
/* ---- طبقات التنقل: زر الرجوع في النظام بيقفل آخر طبقة (نافذة / محادثة / تبويب) بدل ما يخرّجك من الموقع ---- */
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
function modalDom() { $("#modal").classList.add("hidden"); $("#sheet").innerHTML = ""; $("#sheet").classList.remove("wide"); }
function closeModal() {
  const was = !$("#modal").classList.contains("hidden"); modalDom();
  if (was) setTimeout(() => { if ($("#modal").classList.contains("hidden")) layerClose("modal"); }, 0);
}
function openModal(html, wide = false) {
  const sh = $("#sheet");
  sh.classList.toggle("wide", wide);
  sh.innerHTML = `<button class="x" id="xBtn" aria-label="إغلاق">✕</button>` + html;
  $("#modal").classList.remove("hidden"); layerOpen("modal", modalDom);
  $("#xBtn").onclick = closeModal;
  return sh;
}
$("#modal").addEventListener("mousedown", e => { if (e.target.id === "modal") closeModal(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });

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
  setTimeout(() => { if (S.view === "boot") fail(Object.assign(new Error("boot"), { code: "timeout" })); }, 20000);
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
  Object.values(S.unsub).forEach(f => f && f());
  clearInterval(S.beatT); clearInterval(S.tickT); clearTimeout(S.typT);
  S.unsub = {}; S.me = null; S.chat = null; S.users = new Map(); S.chats = []; S.found = null; S.site = {}; S.seen = new Map(); S.chatsLoaded = false; S.fcm = null; S.prefs = DEFAULT_PREFS(); S.filter = "all"; S.groups = []; S.gseen = new Map(); S.groupsLoaded = false;
}

async function onAuth(user) {
  cleanup(); closeModal();
  if (!user) { S.user = null; $("#googleBtn").disabled = false; show("login"); return; }
  S.user = user;
  S.unsub.site = onSnapshot(doc(db, "settings", "site"), s => { S.site = s.data() || {}; siteChanged(); }, () => {});
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
      const base = { uid: user.uid, name: (user.displayName || "مستخدم").slice(0, 40), email: user.email || "", createdAt: serverTimestamp(), lastLogin: serverTimestamp(), loginCount: 1, onboarded: false };
      await withTimeout(setDoc(ref, owner ? { ...base, verified: true, role: "owner" } : base));
      sessionStorage.es_login = "1"; logIt();
    } else {
      if (!sessionStorage.es_login) {
        sessionStorage.es_login = "1";
        updateDoc(ref, { lastLogin: serverTimestamp(), loginCount: increment(1) }).catch(() => {}); logIt();
      }
      const d = snap.data();
      if (owner && (!d.verified || d.role !== "owner")) updateDoc(ref, { verified: true, role: "owner" }).catch(() => {});
    }
    S.unsub.me = onSnapshot(ref, s => { S.me = s.data(); route(); }, e => fail(e));
  } catch (e) {
    await fail(e);
  }
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
      ${edit ? `<input type="text" id="fUser" value="@${esc(me.username)}" disabled style="opacity:.6;direction:ltr;text-align:end">`
             : `<input type="text" id="fUser" maxlength="20" placeholder="مثال: ahmed_22" autocapitalize="none" autocomplete="off" style="direction:ltr;text-align:end"><div class="hint" id="uHint">حروف إنجليزي صغيرة وأرقام و _ (من 3 لـ 20)</div>`}</div>
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
  if (!edit) {
    const u = q("#fUser"), h = q("#uHint");
    u.oninput = () => {
      unameOk = false; clearTimeout(t);
      const v = u.value.trim().toLowerCase();
      h.className = "hint";
      if (!/^[a-z0-9_]{3,20}$/.test(v)) { h.textContent = "حروف إنجليزي صغيرة وأرقام و _ (من 3 لـ 20)"; return; }
      h.textContent = "بتأكد إن الاسم متاح...";
      t = setTimeout(async () => {
        try {
          const s = await getDoc(doc(db, "usernames", v));
          if (u.value.trim().toLowerCase() !== v) return;
          unameOk = !s.exists(); h.className = "hint " + (unameOk ? "ok" : "err");
          h.textContent = unameOk ? "الاسم متاح ✓" : "الاسم ده مستخدم، جرّب غيره";
        } catch { h.className = "hint err"; h.textContent = "تعذّر التحقق (راجع قواعد Firestore)"; }
      }, 400);
    };
  }
  q("#save").onclick = async () => {
    const err = q("#fErr"); err.textContent = "";
    const name = q("#fName").value.trim(), b = bio.value.trim();
    if (!name) { err.textContent = "اكتب اسمك."; return; }
    if (!gender) { err.textContent = "اختار النوع (أنثى أو ذكر)."; return; }
    if (!edit && !unameOk) { err.textContent = "اختار اسم مستخدم متاح."; return; }
    q("#save").disabled = true;
    try {
      if (edit) {
        await updateDoc(doc(db, "users", S.user.uid), { name, gender, bio: b, photo });
        closeModal(); toast("اتحفظت التعديلات");
      } else {
        const un = q("#fUser").value.trim().toLowerCase(), batch = writeBatch(db);
        batch.set(doc(db, "usernames", un), { uid: S.user.uid });
        batch.update(doc(db, "users", S.user.uid), { name, gender, bio: b, photo, username: un, onboarded: true });
        await batch.commit();
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
function beep() {
  if (!prefs.sound || !audioCtx) return;
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
  if (!canNotify() || Notification.permission !== "granted") return;
  const opts = { body, icon: "assets/icon-192.png", badge: "assets/favicon-64.png", tag: chatId, renotify: true, dir: "rtl", lang: "ar", data: { chatId } };
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
  if (!prefs.notifs || S.prefs.mute.includes(gid)) return;
  const text = prefs.preview ? (d.kind === "channel" ? (d.lastText || "") : (d.lastName ? d.lastName + ": " : "") + (d.lastText || "")) : "رسالة جديدة";
  if (here) toast(d.name + ": " + text); else showNotif(d.name, text, "g:" + gid);
  beep();
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
        const r = await fetch("/api/notify", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + t }, body: JSON.stringify({ chatId: it.chatId, text: it.text }) });
        if (r.status >= 500) throw new Error("srv");
        obSet(obGet().filter(x => x.id !== it.id));
      } catch { break; }
    }
  } catch {} finally { obBusy = false; }
}
function pushNotify(chatId, text) {
  if (!VAPID_KEY || !S.user) return;
  obSet([...obGet(), { id: Date.now() + "_" + Math.random().toString(36).slice(2, 7), chatId, text: String(text).slice(0, 120), at: Date.now(), uid: S.user.uid }]);
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
function openEdit() { const sh = openModal(`<div id="editBox"></div>`); renderForm(sh.querySelector("#editBox"), "edit"); }
const ACCENTS = [["blue", "#2f6bff", "أزرق"], ["violet", "#8b5cf6", "بنفسجي"], ["emerald", "#10b981", "أخضر"], ["gold", "#f59e0b", "ذهبي"]];
const WALLS = [["dots", "نقط"], ["grid", "شبكة"], ["none", "سادة"]];
function applyTheme() { const r = document.documentElement; r.dataset.accent = LS.get("accent", "blue"); r.dataset.wp = LS.get("wp", "dots"); }
applyTheme();
function openSettings() {
  const me = S.me, perm = canNotify() ? Notification.permission : "unsupported";
  const link = `${location.origin}${location.pathname}?u=${me.username || ""}`;
  const note = perm === "denied" ? `<div class="hint err">الإشعارات مقفولة للموقع ده من إعدادات المتصفح. افتح إعدادات الموقع وفعّلها.</div>`
    : perm === "unsupported" ? `<div class="hint">المتصفح ده مش بيدعم الإشعارات. على الآيفون ضيف الموقع للشاشة الرئيسية الأول.</div>` : "";
  const sh = openModal(`<div class="prof" style="padding-top:6px">${avatar(me)}<h3>${esc(me.name)}${badge(me, 20)}</h3><div class="un"><bdi>@${esc(me.username || "")}</bdi></div></div>
    <div class="actions"><button class="btn-primary" id="stEdit">تعديل البروفايل</button><button class="btn-ghost" id="stLink">نسخ رابط بروفايلك</button></div>
    <div class="panel-h">الإشعارات</div>${note}
    ${switchRow("stNotif", prefs.notifs && perm === "granted", "إشعارات الرسائل", "تنبيه لما حد يبعتلك")}
    ${switchRow("stSound", prefs.sound, "صوت التنبيه")}
    ${switchRow("stPrev", prefs.preview, "إظهار نص الرسالة", "لو اتقفل هيظهر «رسالة جديدة» بس")}
    <div class="actions" style="justify-content:flex-start"><button class="btn-ghost" id="stTest">جرّب إشعار</button><button class="btn-ghost" id="stCheck">فحص الإشعارات</button></div>
    <div class="panel-h">الخصوصية</div>
    ${switchRow("stHide", !!me.hideLastSeen, "إخفاء حالتي", "محدش هيشوف إنك متصل أو آخر ظهور أو إنك بتكتب")}
    ${switchRow("stRR", me.readReceipts !== false, "تأكيد القراءة (✓✓)", "لو قفلته محدش هيعرف إنك قريت، وإنت كمان مش هتشوف إن اتقرت رسايلك")}
    <div class="panel-h">المظهر</div>
    <div class="swatches">${ACCENTS.map(([k, c, t]) => `<button type="button" class="sw big ${LS.get("accent", "blue") === k ? "on" : ""}" data-acc="${k}" style="background:${c}" aria-label="${t}" title="${t}"></button>`).join("")}</div>
    <div class="seg3">${WALLS.map(([k, t]) => `<button type="button" class="${LS.get("wp", "dots") === k ? "on" : ""}" data-wp="${k}">${t}</button>`).join("")}</div>
    <div class="panel-h">أدوات الأعمال</div>
    <div class="menu" style="padding:0"><button class="mrow" id="stLbl"><span>التصنيفات</span><small>${S.prefs.labels.length}</small></button>
      <button class="mrow" id="stQr"><span>الردود السريعة</span><small>${S.prefs.quick.length}</small></button>
      <button class="mrow" id="stStar"><span>الرسائل المميزة</span><small>${S.prefs.stars.length}</small></button></div>
    <div class="actions" style="margin-top:22px"><button class="btn-ghost" id="stOut">تسجيل الخروج</button></div>`);
  const q = id => sh.querySelector(id);
  q("#stEdit").onclick = openEdit; q("#stOut").onclick = doSignOut;
  q("#stLink").onclick = () => (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(() => toast("اتنسخ الرابط"), () => toast(link));
  q("#stLbl").onclick = manageLabels; q("#stQr").onclick = manageQuick; q("#stStar").onclick = openStars;
  sh.querySelectorAll("[data-acc]").forEach(b => b.onclick = () => { LS.set("accent", b.dataset.acc); applyTheme(); sh.querySelectorAll("[data-acc]").forEach(x => x.classList.toggle("on", x === b)); });
  sh.querySelectorAll("[data-wp]").forEach(b => b.onclick = () => { LS.set("wp", b.dataset.wp); applyTheme(); sh.querySelectorAll("[data-wp]").forEach(x => x.classList.toggle("on", x === b)); });
  q("#stNotif").onchange = async e => {
    if (e.target.checked) { const p = await enableNotifs(); if (p !== "granted") { e.target.checked = false; return; } LS.set("notifs", true); }
    else { LS.set("notifs", false); unregisterPush(); }
  };
  q("#stSound").onchange = e => { LS.set("sound", e.target.checked); if (e.target.checked) beep(); };
  q("#stPrev").onchange = e => LS.set("preview", e.target.checked);
  q("#stCheck").onclick = runPushCheck;
  q("#stTest").onclick = async () => { if (Notification.permission !== "granted") { await enableNotifs(); } showNotif("ES Chat Pro", "ده إشعار تجريبي", "test"); beep(); };
  q("#stHide").onchange = async e => {
    const on = e.target.checked;
    try { await updateDoc(doc(db, "users", S.user.uid), on ? { hideLastSeen: true, lastSeen: deleteField() } : { hideLastSeen: false }); if (!on) setTimeout(beat, 300); toast(on ? "حالتك مخفية" : "حالتك ظاهرة"); }
    catch { e.target.checked = !on; toast("تعذّر الحفظ"); }
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
  if (S.view === "app") { paintAnn(); applyComposerState(); renderList(); }
}
function paintAnn() {
  const bar = $("#annBar"), t = (S.site.announcement || "").trim();
  if (!t || LS.get("annHide", "") === t || S.view !== "app") { bar.classList.add("hidden"); return; }
  bar.innerHTML = `<span>${esc(t)}</span><button aria-label="إخفاء">✕</button>`; bar.classList.remove("hidden");
  bar.querySelector("button").onclick = () => { LS.set("annHide", t); paintAnn(); };
}
function applyComposerState() {
  const c = S.chat, form = $("#form"), ro = $("#roBar");
  let readOnly = false, roHtml = "";
  if (c && (c.type === "group" || c.type === "channel")) {
    const g = c.group;
    if (!isGMember(g)) { readOnly = true; roHtml = g.joinOpen ? `<button class="btn-primary" id="roJoin">${g.kind === "channel" ? "متابعة القناة" : "انضمام للمجموعة"}</button>` : `<span>رابط الانضمام مقفول.</span>`; }
    else if (g.kind === "channel" && !isGAdmin(g)) { readOnly = true; roHtml = `<span>القناة دي للقراءة بس. المشرفين هم اللي بينشروا.</span>`; }
  }
  form.classList.toggle("hidden", readOnly); ro.classList.toggle("hidden", !readOnly); ro.innerHTML = roHtml;
  const j = $("#roJoin"); if (j) j.onclick = async () => { j.disabled = true; if (!(await joinGroup(c.group))) j.disabled = false; };
  const blocked = !!(c && c.peer && S.prefs.block.includes(c.peer));
  const locked = blocked || !!(c && c.type === "public" && S.site.publicOpen === false && !isOwner());
  $("#input").disabled = locked; $("#input").placeholder = blocked ? "المستخدم ده محظور" : locked ? "الغرفة العامة مقفولة حاليًا" : "اكتب رسالة...";
  $("#attachBtn").disabled = locked;
  $("#form .send").disabled = locked;
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
  try { const s = await getDoc(doc(db, "users", uid)); if (s.exists()) { S.users.set(uid, s.data()); return s.data(); } } catch (e) { console.error(e); }
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
function beat() { if (S.user && S.view === "app" && !(S.me && S.me.hideLastSeen)) updateDoc(doc(db, "users", S.user.uid), { lastSeen: serverTimestamp() }).catch(() => {}); }
document.addEventListener("visibilitychange", () => { beat(); if (document.visibilityState === "visible" && S.view === "app" && S.chat) { markRead(S.chat.id); if (S.chat.lastDocs) renderMsgs(S.chat.lastDocs); } });
addEventListener("pagehide", beat);

function enterApp() {
  show("app"); paintMe();
  ["users", "chats", "prefs", "groups"].forEach(k => { if (S.unsub[k]) S.unsub[k](); }); clearInterval(S.beatT); clearInterval(S.tickT);
  $("#ownerBtn").innerHTML = CROWN; $("#ownerBtn").classList.add("owner");
  if (isOwner()) S.unsub.users = onSnapshot(query(collection(db, "users"), limit(500)), snap => { snap.docs.forEach(d => S.users.set(d.id, d.data())); }, e => console.error(e));
  S.chats = []; S.chatsLoaded = false; S.seen = new Map();
  S.unsub.prefs = onSnapshot(doc(db, "users", S.user.uid, "data", "prefs"), s => { S.prefs = { ...DEFAULT_PREFS(), ...(s.data() || {}) }; renderList(); if (S.chat) { applyComposerState(); paintHead(); } }, () => {});
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
    if (++n % 3 === 0) { await Promise.all(S.chats.map(c => getUser(peerOf(c), true))); renderList(); }
  }, 20000);
  renderList(); showEmpty(); paintAnn(); paintNotifBar(); updateBadge(); registerPush();
  const q = new URLSearchParams(location.search).get("chat");
  if (q) { history.replaceState(null, "", location.pathname); S.pendingChat = q; }
  if (S.pendingChat) { const id = S.pendingChat; S.pendingChat = null; openFromId(id); }
  const un = sessionStorage.es_u; if (un) { sessionStorage.removeItem("es_u"); history.replaceState(null, "", location.pathname); openByUsername(un); }
  const cq = sessionStorage.es_c; if (cq) { sessionStorage.removeItem("es_c"); history.replaceState(null, "", location.pathname); openByHandle(cq); }
  const gq = sessionStorage.es_g; if (gq) { sessionStorage.removeItem("es_g"); history.replaceState(null, "", location.pathname); openGroup(gq); }
}
function showEmpty() {
  S.chat = null; closeChatSubs();
  $("#chatHead").innerHTML = ""; $("#composerWrap").classList.add("hidden");
  $("#messages").innerHTML = `<div class="empty"><div class="big">ES Chat Pro</div><p>ابحث عن صاحبك بالـ @يوزر عشان تبدأ محادثة.</p></div>`;
  $("#app").classList.remove("open"); layerClose("chat");
}
function chatUiClose() { $("#app").classList.remove("open"); }
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
  const term = $("#search").value.trim().toLowerCase().replace(/^@/, "");
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
const nameOf = uid => uid === S.user.uid ? "أنت" : ((S.users.get(uid) || {}).name || "مستخدم");
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
  return `<div class="chat-item ${S.chat && S.chat.id === g.id ? "active" : ""} ${n ? "has-unread" : ""}" data-open="g:${esc(g.id)}" data-chat="1">${gAvatar(g)}
    <div class="chat-meta"><div class="row1"><div class="name">${g.kind === "channel" ? CHAN_IC : ""}${esc(g.name)}${dots}</div><span class="when">${esc(listTime(g.lastAt || g.createdAt))}</span></div>
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
  $("#list").innerHTML = h; paintTabs();
}
function renderList() {
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
    if (r && r.uid) h += `<div class="chat-item" data-open="${esc(r.uid)}">${avatar(r.u)}<div class="chat-meta"><div class="row1"><div class="name">${esc(r.u.name)}${badge(r.u, 15)}</div></div><div class="row2"><div class="preview"><bdi>@${esc(r.u.username)}</bdi></div></div></div></div>`;
    else if (r && r.g) h += `<div class="chat-item" data-open="g:${esc(r.g.id)}">${gAvatar(r.g)}<div class="chat-meta"><div class="row1"><div class="name">${esc(r.g.name)}</div></div><div class="row2"><div class="preview">${r.g.kind === "channel" ? "قناة" : "مجموعة"} · ${gCount(r.g)}</div></div></div></div>`;
    else if (r && r.self) h += `<div class="empty-list">ده اليوزر بتاعك 🙂</div>`;
    else if (r && r.none) h += `<div class="empty-list">مفيش نتايج. اتأكد إن الاسم مكتوب صح.</div>`;
    else h += `<div class="empty-list">اكتب اليوزر كامل (3 حروف على الأقل)...</div>`;
  }
  let chats = [...S.chats.filter(c => !P.block.includes(peerOf(c))).map(c => ({ ...c, _t: "dm" })), ...S.groups.filter(g => g.kind !== "channel").map(g => ({ ...g, _t: g.kind }))];
  chats = f === "arch" ? chats.filter(c => P.arch.includes(c.id)) : chats.filter(c => !P.arch.includes(c.id));
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
      <div class="chat-meta"><div class="row1"><div class="name">${esc(u.name)}${badge(u, 15)}${dots}</div><span class="when">${esc(listTime(c.lastAt))}</span></div>
      <div class="row2"><div class="preview">${c.lastUid === S.user.uid ? "أنت: " : ""}${esc(c.lastText || "")}</div>${P.pins.includes(c.id) ? PIN : ""}${muted ? MUTE : ""}${n ? `<b class="unread ${muted ? "muted" : ""}">${n > 99 ? "99+" : n}</b>` : ""}</div></div></div>`;
  }).join("") : `<div class="empty-list">${f === "all" ? "مفيش محادثات لسه.<br>اطلب من صاحبك الـ @username بتاعه وابحث بيه فوق." : "مفيش محادثات هنا."}</div>`;
  $("#list").innerHTML = h;
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
function paintHead() {
  const c = S.chat; if (!c) return;
  $("#chatMenuBtn").classList.toggle("hidden", c.type === "public");
  if (c.type === "group" || c.type === "channel") {
    const g = c.group; $("#chatHead").innerHTML = `${gAvatar(g)}<div class="t"><b>${g.kind === "channel" ? CHAN_IC : ""}${esc(g.name)}</b><small>${esc(gCount(g))}${g.handle ? " · <bdi>#" + esc(g.handle) + "</bdi>" : ""}</small></div>`; return;
  }
  if (c.type === "public") { $("#chatHead").innerHTML = `<div class="avatar public">ES</div><div class="t"><b>الغرفة العامة</b><small>محادثة مفتوحة لكل الأعضاء</small></div>`; return; }
  const u = S.users.get(c.peer) || {}, st = statusOf(u, c), ttl = c.doc && c.doc.ttl;
  $("#chatHead").innerHTML = `<div class="av-wrap">${avatar(u)}${isOnline(u) ? `<i class="dot"></i>` : ""}</div><div class="t"><b>${esc(u.name || "مستخدم")}${badge(u, 16)}${ttl ? `<span class="ttl-chip">${ttlLabel(ttl)}</span>` : ""}</b><small class="st ${st.cls}">${st.t ? esc(st.t) : "<bdi>@" + esc(u.username || "") + "</bdi>"}</small></div>`;
}

function openChat(peer) {
  closeChatSubs(); clearTimeout(S.typT);
  const id = peer ? dmId(peer) : "public";
  S.chat = { id, type: peer ? "dm" : "public", peer: peer || null, first: true, lastTyping: undefined, typingAt: 0, sentTyping: 0, sentRead: 0, reply: null, doc: null, sig: "", cleaned: new Set() };
  $("#composerWrap").classList.remove("hidden"); $("#app").classList.add("open"); layerOpen("chat", chatUiClose);
  $("#messages").innerHTML = ""; paintReply(); hideQuick(); markRead(id); applyComposerState(); paintHead(); renderList();
  S.unsub.msgs = onSnapshot(query(collection(db, "chats", id, "messages"), orderBy("at"), limitToLast(150)),
    snap => { S.chat && S.chat.id === id && renderMsgs(snap.docs); }, e => { console.error(e); toast("مفيش صلاحية لقراءة الرسايل — راجع قواعد Firestore"); });
  if (peer) {
    getUser(peer).then(paintHead);
    S.unsub.peerDoc = onSnapshot(doc(db, "users", peer), s => { if (s.exists() && S.chat && S.chat.peer === peer) { S.users.set(peer, s.data()); paintHead(); } }, () => {});
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
function renderMsgs(docs) {
  const c = S.chat, box = $("#messages"), near = box.scrollHeight - box.scrollTop - box.clientHeight < 140 || c.first;
  const pub = c.type === "public" || c.type === "group", now = Date.now(), me = S.user.uid;
  c.lastDocs = docs;
  const hid = new Set(LS.get("hid_" + c.id, []));
  const peerRead = c.peer && S.me.readReceipts !== false ? toDate(c.doc && c.doc.read && c.doc.read[c.peer]) : null;
  const vis = [];
  for (const d of docs) {
    const m = d.data({ serverTimestamps: "estimate" });
    if (hid.has(d.id)) continue;
    if (m.exp && m.exp < now) { if (m.uid === me && !c.cleaned.has(d.id)) { c.cleaned.add(d.id); deleteDoc(doc(db, ...msgBase(c), d.id)).catch(() => {}); } continue; }
    vis.push([d, m]);
  }
  const ttl = c.doc && c.doc.ttl;
  const notice = ttl ? `<div class="sys">الرسائل المختفية شغالة: بتتمسح بعد ${ttlLabel(ttl)}</div>` : "";
  if (!vis.length) {
    box.innerHTML = notice + `<div class="empty"><div class="big">${c.type === "public" ? "الغرفة فاضية" : c.type === "channel" ? "مفيش منشورات لسه" : "ابدأ المحادثة"}</div><p>اكتب أول رسالة من الأسفل.</p></div>`;
    c.first = false; return;
  }
  if (pub) ensureUsers(vis.map(([, m]) => m.uid)).then(ch => { if (ch && S.chat && (S.chat.type === "public" || S.chat.type === "group")) renderMsgs(S.chat.lastDocs); });
  const stars = new Set(S.prefs.stars.map(s => s.c + "/" + s.m));
  let last = "", h = notice, pu = "", pt = 0, lastMs = 0, lastUid = "";
  for (const [d, m] of vis) {
    const dt = toDate(m.at) || new Date(), mine = m.uid === me;
    const lbl = dayLabel(dt); if (lbl !== last) { h += `<div class="date-sep">${esc(lbl)}</div>`; last = lbl; pu = ""; }
    const sender = S.users.get(m.uid) || {};
    const cont = pu === m.uid && dt.getTime() - pt < 300000; pu = m.uid; pt = dt.getTime(); lastMs = pt; lastUid = m.uid;
    let body = "";
    if (m.deleted) body = `<div class="txt del-m">الرسالة دي اتحذفت</div>`;
    else {
      if (m.fwd) body += `<div class="fwd">معاد توجيهها</div>`;
      if (m.reply) body += `<div class="quote" data-q="${esc(m.reply.id)}"><b>${esc(nameOf(m.reply.uid))}</b><span>${esc(m.reply.t)}</span></div>`;
      if (m.img && String(m.img).startsWith("data:image/")) body += `<img class="mimg" src="${esc(m.img)}" alt="صورة" data-img>`;
      if (m.loc) body += `<a class="mloc" href="https://www.google.com/maps?q=${+m.loc.lat},${+m.loc.lng}" target="_blank" rel="noopener"><svg width="18" height="18" viewBox="0 0 24 24"><path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z" fill="currentColor"/></svg><span>موقع على الخريطة</span></a>`;
      if (m.text) body += `<div class="txt">${esc(m.text)}</div>`;
    }
    const seen = peerRead && peerRead.getTime() >= dt.getTime();
    const tick = mine && c.peer && !m.deleted ? (S.me.readReceipts === false ? TK1 : seen ? TK2 : TK1) : "";
    h += `<div class="msg ${mine ? "me" : "them"}${cont ? " cont" : ""}${m.deleted ? " gone" : ""}" data-mid="${esc(d.id)}">`
      + (pub && !mine && !cont ? `<div class="who" data-uid="${esc(m.uid)}">${esc(sender.name || "مستخدم")}${badge(sender, 14)}</div>` : "")
      + body + `<div class="tm">${stars.has(c.id + "/" + d.id) ? `<span class="star">★</span>` : ""}<span>${fmtTime(dt)}</span>${tick}</div></div>`;
  }
  box.innerHTML = h;
  if (near) box.scrollTop = box.scrollHeight;
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
function viewImage(src) {
  const sh = openModal(`<img class="full-img" src="${esc(src)}" alt=""><div class="actions"><a class="btn-ghost" download="es-chat.jpg" href="${esc(src)}" style="display:grid;place-items:center;text-decoration:none">حفظ الصورة</a></div>`, true);
}

/* قايمة الرسالة */
function openMsgMenu(mid) {
  const c = S.chat, d = c && c.lastDocs && c.lastDocs.find(x => x.id === mid); if (!d) return;
  const m = d.data(), mine = m.uid === S.user.uid; if (m.deleted) return;
  const starred = S.prefs.stars.some(s => s.c === c.id && s.m === mid);
  const rows = [["reply", "رد"]];
  if (m.text) rows.push(["copy", "نسخ"]);
  rows.push(["star", starred ? "إزالة النجمة" : "تمييز بنجمة"], ["fwd", "إعادة توجيه"], ["hide", "حذف عندي"]);
  const isG = c.type === "group" || c.type === "channel";
  if (c.type === "dm" && mine) rows.push(["del", "حذف للجميع", true]);
  else if (isG && (mine || isGAdmin(c.group))) rows.push(["del", mine ? "حذف للجميع" : "حذف (مشرف)", true]);
  else if (c.type === "public" && isOwner()) rows.push(["del", "حذف من الغرفة (المالك)", true]);
  const prev = m.text ? m.text.slice(0, 70) : (m.img ? "📷 صورة" : "📍 موقع");
  const sh = openModal(`<div class="menu"><div class="menu-h">${esc(prev)}</div>${rows.map(([a, t, dng]) => `<button class="mrow ${dng ? "danger" : ""}" data-a="${a}"><span>${t}</span></button>`).join("")}</div>`);
  sh.querySelector(".menu").onclick = async e => {
    const b = e.target.closest("[data-a]"); if (!b) return; const a = b.dataset.a; closeModal();
    if (a === "reply") { c.reply = { id: mid, uid: m.uid, t: prev }; paintReply(); $("#input").focus(); }
    else if (a === "copy") { (navigator.clipboard ? navigator.clipboard.writeText(m.text) : Promise.reject()).then(() => toast("اتنسخت"), () => toast("تعذّر النسخ")); }
    else if (a === "star") {
      const stars = starred ? S.prefs.stars.filter(s => !(s.c === c.id && s.m === mid)) : [...S.prefs.stars, { c: c.id, m: mid, t: prev, u: m.uid, a: toDate(m.at)?.getTime() || Date.now() }].slice(-100);
      savePrefs({ stars }); renderMsgs(c.lastDocs); toast(starred ? "اتشالت النجمة" : "اتميزت بنجمة");
    }
    else if (a === "fwd") openForward({ ...(m.text ? { text: m.text } : {}), ...(m.img ? { img: m.img } : {}), ...(m.loc ? { loc: m.loc } : {}) });
    else if (a === "hide") { const k = "hid_" + c.id, l = LS.get(k, []); l.push(mid); LS.set(k, l.slice(-500)); renderMsgs(c.lastDocs); }
    else if (a === "del") {
      if (!confirm(c.type === "dm" ? "تحذف الرسالة عند الطرفين؟" : "تحذف الرسالة للجميع؟")) return;
      const ref = doc(db, ...msgBase(c), mid);
      ((c.type === "dm" || (isG && mine)) ? updateDoc(ref, { deleted: true, text: "", img: deleteField(), loc: deleteField(), reply: deleteField() }) : deleteDoc(ref)).catch(() => toast("مقدرتش أحذف الرسالة"));
    }
  };
}
function openForward(payload) {
  const dms = S.chats.filter(x => !S.prefs.block.includes(peerOf(x))).map(x => { const u = S.users.get(peerOf(x)) || {}; return { k: peerOf(x), av: avatar(u), n: u.name || "مستخدم" }; });
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
  bar.innerHTML = `<div class="rp-t"><b>رد على ${esc(nameOf(r.uid))}</b><span>${esc(r.t)}</span></div><button type="button" id="rpX" aria-label="إلغاء">✕</button>`;
  bar.classList.remove("hidden"); $("#rpX").onclick = () => { S.chat.reply = null; paintReply(); };
}
$("#messages").addEventListener("click", e => {
  const w = e.target.closest("[data-uid]"); if (w) return openProfile(w.dataset.uid);
  const q = e.target.closest("[data-q]"); if (q) return jumpTo(q.dataset.q);
  const im = e.target.closest("[data-img]"); if (im) return viewImage(im.src);
});
let mT, mFired = false, mX = 0, mY = 0;
const mBox = $("#messages");
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
    ["lbl", "التصنيفات"], ["ttl", "الرسائل المختفية", ttl ? ttlLabel(ttl) : "إيقاف"], ["blk", P.block.includes(peer) ? "إلغاء حظر المستخدم" : "حظر المستخدم", "", true]];
  const sh = openModal(`<div class="menu"><div class="menu-h">${esc(u.name || "محادثة")}</div>${rows.map(([a, t, v, dng]) => `<button class="mrow ${dng ? "danger" : ""}" data-a="${a}"><span>${t}</span>${v ? `<small>${v}</small>` : ""}</button>`).join("")}</div>`);
  sh.querySelector(".menu").onclick = e => {
    const b = e.target.closest("[data-a]"); if (!b) return; const a = b.dataset.a; closeModal();
    if (a === "profile") openProfile(peer);
    else if (a === "pin") { if (!P.pins.includes(id) && P.pins.length >= 3) return toast("أقصى حاجة 3 محادثات مثبتة"); savePrefs({ pins: toggleIn(P.pins, id) }); }
    else if (a === "arch") { savePrefs({ arch: toggleIn(P.arch, id) }); toast(P.arch.includes(id) ? "اتأرشفت" : "رجعت للقايمة"); }
    else if (a === "mute") savePrefs({ mute: toggleIn(P.mute, id) });
    else if (a === "lbl") openLabelPicker(id);
    else if (a === "ttl") openTtlPicker(peer, ttl);
    else if (a === "blk") {
      if (!P.block.includes(peer) && !confirm("تحظر المستخدم ده؟ مش هتشوف رسايله ولا هيجيلك إشعار منه.")) return;
      savePrefs({ block: toggleIn(P.block, peer) });
    }
  };
}
$("#chatMenuBtn").onclick = () => { if (!S.chat) return; if (S.chat.peer) openChatMenu(S.chat.peer); else if (S.chat.group) openGroupMenu(S.chat.id); };
function openTtlPicker(peer, cur) {
  const opts = [[0, "إيقاف"], [86400, "24 ساعة"], [604800, "7 أيام"], [7776000, "90 يوم"]];
  const sh = openModal(`<div class="menu"><div class="menu-h">الرسائل المختفية</div><p class="sub" style="margin:0 4px 8px">الرسايل الجديدة بس هتتمسح من المحادثة بعد المدة دي.</p>${opts.map(([s, t]) => `<button class="mrow ${s === cur ? "on" : ""}" data-s="${s}"><span>${t}</span>${s === cur ? "<small>✓</small>" : ""}</button>`).join("")}</div>`);
  sh.querySelector(".menu").onclick = async e => {
    const b = e.target.closest("[data-s]"); if (!b) return; closeModal();
    try { await setDoc(doc(db, "chats", dmId(peer)), { members: [S.user.uid, peer].sort(), ttl: +b.dataset.s }, { merge: true }); toast("اتحفظ"); } catch { toast("تعذّر الحفظ"); }
  };
}
function openLabelPicker(chatId) {
  const P = S.prefs;
  if (!P.labels.length) { const sh = openModal(`<div class="menu"><div class="menu-h">التصنيفات</div><div class="empty-list">لسه معملتش تصنيفات.</div><button class="mrow" id="mkL"><span>إنشاء تصنيف</span></button></div>`); sh.querySelector("#mkL").onclick = manageLabels; return; }
  const cur = P.cl[chatId] || [];
  const sh = openModal(`<div class="menu"><div class="menu-h">التصنيفات</div>${P.labels.map(l => switchRow("lp_" + l.id, cur.includes(l.id), `<i class="ldot" style="background:${esc(l.c)}"></i> ${esc(l.n)}`)).join("")}<button class="mrow" id="mkL"><span>إدارة التصنيفات</span></button></div>`);
  P.labels.forEach(l => sh.querySelector("#lp_" + l.id).onchange = ev => {
    const now = S.prefs.cl[chatId] || []; savePrefs({ cl: { ...S.prefs.cl, [chatId]: ev.target.checked ? [...now, l.id] : now.filter(x => x !== l.id) } });
  });
  sh.querySelector("#mkL").onclick = manageLabels;
}
function manageLabels() {
  let col = LABEL_COLORS[0];
  const draw = () => {
    const P = S.prefs;
    const sh = openModal(`<div class="menu"><div class="menu-h">التصنيفات</div>
      ${P.labels.map(l => `<div class="mrow static"><span><i class="ldot" style="background:${esc(l.c)}"></i> ${esc(l.n)}</span><button class="btn-danger sm" data-d="${esc(l.id)}">حذف</button></div>`).join("") || `<div class="empty-list">مفيش تصنيفات.</div>`}
      ${P.labels.length < 8 ? `<div class="field" style="margin-top:12px"><label for="lN">تصنيف جديد</label><input type="text" id="lN" maxlength="16" placeholder="مثال: عميل جديد"></div>
      <div class="swatches">${LABEL_COLORS.map(c => `<button type="button" class="sw ${c === col ? "on" : ""}" data-c="${c}" style="background:${c}" aria-label="لون"></button>`).join("")}</div>
      <div class="actions"><button class="btn-primary" id="lAdd">إضافة</button></div>` : ""}</div>`);
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
    const sh = openModal(`<div class="menu"><div class="menu-h">الردود السريعة</div><p class="sub" style="margin:0 4px 8px">اكتب <b>/</b> في المحادثة واختار الاختصار.</p>
      ${Q.map((q, i) => `<div class="mrow static col"><div><b>/${esc(q.k)}</b><small>${esc(q.t)}</small></div><button class="btn-danger sm" data-d="${i}">حذف</button></div>`).join("") || `<div class="empty-list">مفيش ردود سريعة لسه.</div>`}
      ${Q.length < 30 ? `<div class="field" style="margin-top:12px"><label for="qK">الاختصار</label><input type="text" id="qK" maxlength="20" placeholder="شكرا" style="direction:rtl"></div>
      <div class="field"><label for="qT">نص الرد</label><textarea id="qT" maxlength="300" placeholder="شكرًا لتواصلك معنا..."></textarea></div>
      <div class="actions"><button class="btn-primary" id="qAdd">إضافة</button></div>` : ""}</div>`);
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
  const sh = openModal(`<div class="menu"><div class="menu-h">الرسائل المميزة</div>${L.length ? L.map((s, i) => `<div class="mrow static col star-row" data-i="${i}"><div><b>${esc(nameOf(s.u))}</b><small>${esc(s.t)}</small></div><button class="btn-mini ghost" data-x="${i}">إزالة</button></div>`).join("") : `<div class="empty-list">مفيش رسايل مميزة. اضغط على رسالة واختار «تمييز بنجمة».</div>`}</div>`);
  sh.querySelector(".menu").onclick = e => {
    const x = e.target.closest("[data-x]");
    if (x) { const s = L[+x.dataset.x]; savePrefs({ stars: S.prefs.stars.filter(y => !(y.c === s.c && y.m === s.m)) }); return openStars(); }
    const r = e.target.closest("[data-i]"); if (!r) return; const s = L[+r.dataset.i]; closeModal();
    if (s.c === "public") openChat(null); else openFromId(s.c);
    setTimeout(() => jumpTo(s.m), 900);
  };
}

/* الرسايل: الكتابة والإرسال والمرفقات */
const chatRef = () => doc(db, "chats", S.chat.id);
const membersOf = () => [S.user.uid, S.chat.peer].sort();
async function sendTo(c, payload) {
  if (c.peer && S.prefs.block.includes(c.peer)) { toast("ألغي حظر المستخدم الأول"); throw new Error("blocked"); }
  if (c.type === "group" || c.type === "channel") {
    const g = (S.chat && S.chat.id === c.id && S.chat.group) || S.groups.find(x => x.id === c.id);
    if (!isGMember(g) || (g.kind === "channel" && !isGAdmin(g))) { toast("مش مسموحلك تبعت هنا"); throw new Error("blocked"); }
    const prev = payload.img ? "📷 صورة" : payload.loc ? "📍 موقع" : (payload.text || "");
    const wr = addDoc(collection(db, "groups", c.id, "messages"), { uid: S.user.uid, at: serverTimestamp(), ...payload });
    updateDoc(doc(db, "groups", c.id), { lastText: prev.slice(0, 80), lastAt: serverTimestamp(), lastUid: S.user.uid, lastName: (S.me.name || "").slice(0, 40) }).catch(e => console.error(e));
    pushNotify("g:" + c.id, prev);
    await wr;
    return;
  }
  const meta = S.chats.find(x => x.id === c.id), ttl = c.peer ? ((S.chat && S.chat.id === c.id && S.chat.doc ? S.chat.doc.ttl : meta && meta.ttl) || 0) : 0;
  const data = { uid: S.user.uid, at: serverTimestamp(), ...payload };
  if (ttl) data.exp = Date.now() + ttl * 1000;
  const wr = addDoc(collection(db, "chats", c.id, "messages"), data);
  if (c.peer) {
    const prev = payload.img ? "📷 صورة" : payload.loc ? "📍 موقع" : (payload.text || "");
    if (S.chat && S.chat.id === c.id) S.chat.sentTyping = 0;
    setDoc(doc(db, "chats", c.id), { members: [S.user.uid, c.peer].sort(), lastText: prev.slice(0, 80), lastAt: serverTimestamp(), lastUid: S.user.uid, typing: { [S.user.uid]: 0 } }, { merge: true }).catch(e => console.error(e));
    pushNotify(c.id, prev);
  }
  await wr;
}
function hideQuick() { $("#quickPop").classList.add("hidden"); $("#quickPop").innerHTML = ""; }
function quickSuggest() {
  const v = $("#input").value; if (!v.startsWith("/")) return hideQuick();
  const t = v.slice(1).toLowerCase(), list = S.prefs.quick.filter(q => q.k.toLowerCase().startsWith(t)).slice(0, 6);
  if (!list.length) return hideQuick();
  const pop = $("#quickPop"); pop.innerHTML = list.map((q, i) => `<button type="button" data-i="${i}"><b>/${esc(q.k)}</b><span>${esc(q.t)}</span></button>`).join("");
  pop.classList.remove("hidden");
  pop.onclick = e => { const b = e.target.closest("[data-i]"); if (!b) return; $("#input").value = list[+b.dataset.i].t; hideQuick(); $("#input").focus(); };
}
$("#input").addEventListener("input", () => {
  quickSuggest();
  const c = S.chat; if (!c || !c.peer || !$("#input").value.trim() || (S.me && S.me.hideLastSeen)) return;
  if (Date.now() - c.sentTyping < 2500) return;
  c.sentTyping = Date.now();
  setDoc(chatRef(), { members: membersOf(), typing: { [S.user.uid]: Date.now() } }, { merge: true }).catch(() => {});
});
$("#form").onsubmit = async e => {
  e.preventDefault();
  const text = $("#input").value.trim(); if (!text || !S.chat) return;
  const c = S.chat, payload = { text }; if (c.reply) payload.reply = c.reply;
  $("#input").value = ""; c.reply = null; paintReply(); hideQuick();
  try { await sendTo(c, payload); } catch (er) { console.error(er); $("#input").value = text; if (er.message !== "blocked") toast("الرسالة ماتبعتتش"); }
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
async function sendImage(file) {
  if (!file || !S.chat) return; const c = S.chat;
  try { toast("جاري إرسال الصورة..."); const img = await compressImage(file); await sendTo(c, { img }); }
  catch (e) { if (e.message !== "blocked") toast("الصورة ماتبعتتش"); }
}
$("#fileImg").onchange = e => { sendImage(e.target.files[0]); e.target.value = ""; };
$("#fileCam").onchange = e => { sendImage(e.target.files[0]); e.target.value = ""; };
$("#attachBtn").onclick = () => {
  if (!S.chat || $("#input").disabled) return;
  const sh = openModal(`<div class="menu"><div class="menu-h">إرفاق</div>
    <button class="mrow" data-a="img"><span>صورة من المعرض</span></button><button class="mrow" data-a="cam"><span>الكاميرا</span></button><button class="mrow" data-a="loc"><span>موقعي الحالي</span></button></div>`);
  sh.querySelector(".menu").onclick = e => {
    const b = e.target.closest("[data-a]"); if (!b) return; const a = b.dataset.a; closeModal();
    if (a === "img") $("#fileImg").click();
    else if (a === "cam") $("#fileCam").click();
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
const gAvatar = (g, cls = "") => `<div class="avatar ${g.kind === "channel" ? "chan" : "grp"} ${cls}">${g.photo && String(g.photo).startsWith("data:image/") ? `<img src="${esc(g.photo)}" alt="">` : esc((g.name || "?").trim().charAt(0).toUpperCase())}</div>`;
const CHAN_IC = `<svg class="mini-ic" width="14" height="14" viewBox="0 0 24 24" aria-label="قناة"><path d="M3 10v4l11 5V5L3 10zm13-1.5v7a3.5 3.5 0 0 0 0-7zM5 15l1 5h3l-1-4" fill="currentColor"/></svg>`;
const inviteLink = g => g.kind === "channel" && g.handle ? `${location.origin}${location.pathname}?c=${g.handle}` : `${location.origin}${location.pathname}?g=${g.id}`;
const copyText = (t, ok) => (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => toast(ok), () => toast(t));
function closeChatSubs() { ["msgs", "peerDoc", "chatDoc", "gdoc"].forEach(k => { if (S.unsub[k]) { S.unsub[k](); delete S.unsub[k]; } }); }

async function fetchGroup(gid) {
  let g = S.groups.find(x => x.id === gid);
  if (g) return g;
  try { const s = await getDoc(doc(db, "groups", gid)); return s.exists() ? { id: gid, ...s.data() } : null; } catch { return null; }
}
async function openGroup(gid) {
  const g = await fetchGroup(gid);
  if (!g) return toast("المجموعة أو القناة مش موجودة");
  if (!isGMember(g) && !(g.kind === "channel" && g.public)) return openJoin(g);
  closeChatSubs(); clearTimeout(S.typT);
  S.chat = { id: gid, type: g.kind, peer: null, group: g, first: true, reply: null, doc: null, sig: "", cleaned: new Set(), lastTyping: undefined, typingAt: 0, sentTyping: 0, sentRead: 0 };
  $("#composerWrap").classList.remove("hidden"); $("#app").classList.add("open"); layerOpen("chat", chatUiClose);
  $("#messages").innerHTML = ""; paintReply(); hideQuick(); markRead(gid); applyComposerState(); paintHead(); renderList();
  S.unsub.msgs = onSnapshot(query(collection(db, "groups", gid, "messages"), orderBy("at"), limitToLast(150)),
    snap => { S.chat && S.chat.id === gid && renderMsgs(snap.docs); }, e => { console.error(e); toast("مفيش صلاحية لقراءة الرسايل — راجع قواعد Firestore"); });
  S.unsub.gdoc = onSnapshot(doc(db, "groups", gid), s => {
    if (!S.chat || S.chat.id !== gid) return;
    if (!s.exists()) { toast("اتحذفت"); showEmpty(); return; }
    const old = S.chat.group; S.chat.group = { id: gid, ...s.data() };
    const sig = g => JSON.stringify([isGMember(g), isGAdmin(g)]);
    paintHead();
    if (sig(old) !== sig(S.chat.group)) { applyComposerState(); if (S.chat.lastDocs) renderMsgs(S.chat.lastDocs); }
  }, () => {});
}
function openJoin(g) {
  const sh = openModal(`<div class="prof">${gAvatar(g, "big")}<h3>${esc(g.name)}</h3><div class="chips"><span class="chip">${g.kind === "channel" ? "قناة" : "مجموعة"}</span><span class="chip">${gCount(g)}</span></div>
    ${g.desc ? `<div class="bio">${esc(g.desc)}</div>` : ""}
    ${g.joinOpen ? `<div class="actions"><button class="btn-primary" id="jGo">${g.kind === "channel" ? "متابعة القناة" : "انضمام للمجموعة"}</button></div>` : `<div class="hint err" style="text-align:center">رابط الانضمام مقفول. اطلب من مشرف يضيفك.</div>`}</div>`);
  const b = sh.querySelector("#jGo"); if (b) b.onclick = async () => { b.disabled = true; if (await joinGroup(g)) { closeModal(); openGroup(g.id); } else b.disabled = false; };
}
async function joinGroup(g) {
  try { await updateDoc(doc(db, "groups", g.id), { members: arrayUnion(S.user.uid) }); toast(g.kind === "channel" ? "بقيت متابع للقناة" : "اتضمّيت للمجموعة"); return true; }
  catch (e) { console.error(e); toast("تعذّر الانضمام (ممكن الرابط اتقفل أو العدد اكتمل)"); return false; }
}
async function leaveGroup(g) {
  if (!confirm(g.kind === "channel" ? "تلغي متابعة القناة؟" : "تخرج من المجموعة؟")) return;
  try { await updateDoc(doc(db, "groups", g.id), { members: arrayRemove(S.user.uid), admins: arrayRemove(S.user.uid) }); closeModal(); if (S.chat && S.chat.id === g.id) showEmpty(); toast("تم"); }
  catch { toast("تعذّر الخروج"); }
}

/* قايمة جديد + اكتشاف القنوات */
function openNewMenu() {
  const sh = openModal(`<div class="menu"><div class="menu-h">جديد</div>
    <button class="mrow" data-a="group"><span>مجموعة جديدة</span></button><button class="mrow" data-a="channel"><span>قناة جديدة</span></button><button class="mrow" data-a="find"><span>استكشاف القنوات</span></button></div>`);
  sh.querySelector(".menu").onclick = e => { const b = e.target.closest("[data-a]"); if (!b) return; closeModal(); b.dataset.a === "find" ? openDiscover() : openCreate(b.dataset.a); };
}
$("#newBtn").onclick = openNewMenu;
async function openDiscover() {
  const sh = openModal(`<div class="menu"><div class="menu-h">استكشاف القنوات</div><div id="dList"><div class="empty-list">جاري التحميل...</div></div></div>`);
  let list = [];
  try { list = (await getDocs(query(collection(db, "groups"), where("kind", "==", "channel"), where("public", "==", true), limit(30)))).docs.map(d => ({ id: d.id, ...d.data() })); }
  catch (e) { console.error(e); }
  list.sort((a, b) => (b.members || []).length - (a.members || []).length);
  const box = sh.querySelector("#dList");
  box.innerHTML = list.length ? list.map(g => `<div class="row-item" data-g="${esc(g.id)}">${gAvatar(g)}<div class="meta"><div class="name">${esc(g.name)}</div><small>${gCount(g)}${g.desc ? " · " + esc(g.desc.slice(0, 40)) : ""}</small></div></div>`).join("") : `<div class="empty-list">مفيش قنوات عامة لسه. اعمل أول واحدة!</div>`;
  box.onclick = e => { const r = e.target.closest("[data-g]"); if (r) { closeModal(); openGroup(r.dataset.g); } };
}

/* إنشاء مجموعة / قناة */
function openCreate(kind) {
  const isCh = kind === "channel";
  let photo = "", members = [], handleOk = true, pub = true, ht;
  const sh = openModal(`<div class="menu"><div class="menu-h">${isCh ? "قناة جديدة" : "مجموعة جديدة"}</div>
    <div class="field"><div class="photo-pick"><div id="cpv"></div><div><button type="button" class="btn-ghost" id="cpPick">اختيار صورة</button></div></div><input type="file" id="cpFile" accept="image/*" hidden></div>
    <div class="field"><label for="cN">الاسم</label><input type="text" id="cN" maxlength="50" placeholder="${isCh ? "اسم القناة" : "اسم المجموعة"}"></div>
    <div class="field"><label for="cD">الوصف (اختياري)</label><textarea id="cD" maxlength="200" style="min-height:70px"></textarea></div>
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
      ht = setTimeout(async () => { try { const s = await getDoc(doc(db, "handles", v)); if (q("#cH").value.trim().toLowerCase() !== v) return; handleOk = !s.exists(); h.className = "hint " + (handleOk ? "ok" : "err"); h.textContent = handleOk ? "الاسم متاح ✓" : "الاسم ده مستخدم، جرّب غيره"; } catch { h.className = "hint err"; h.textContent = "تعذّر التحقق"; } }, 400);
    };
  } else {
    const paintM = () => { q("#cMList").innerHTML = members.map(m => `<span class="m-chip" data-r="${esc(m.uid)}">${esc(m.u.name)} ✕</span>`).join(""); };
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
      if (handle) b.set(doc(db, "handles", handle), { gid, owner: S.user.uid });
      await b.commit(); closeModal(); toast(isCh ? "اتعملت القناة" : "اتعملت المجموعة"); openGroup(gid);
    } catch (e) { console.error(e); err.textContent = "تعذّر الإنشاء (" + (e.code || e.message) + ")"; q("#cGo").disabled = false; }
  };
}

/* معلومات المجموعة / القناة */
async function openGroupInfo(gid) {
  const g = await fetchGroup(gid); if (!g) return;
  const me = S.user.uid, admin = isGAdmin(g), owner = g.owner === me, member = isGMember(g), ch = g.kind === "channel";
  const ids = ch && !admin ? (g.admins || []) : (g.members || []).slice(0, 100);
  await ensureUsers(ids);
  const role = id => id === g.owner ? "المالك" : (g.admins || []).includes(id) ? "مشرف" : "";
  const rows = ids.map(id => { const u = S.users.get(id) || { name: "مستخدم" }, r = role(id);
    const canRm = admin && id !== g.owner && id !== me && (owner || !(g.admins || []).includes(id));
    return `<div class="row-item" data-u="${esc(id)}">${avatar(u)}<div class="meta"><div class="name">${esc(u.name)}${badge(u, 14)}${r ? ` <span class="chip sm ${r === "المالك" ? "owner" : ""}">${r}</span>` : ""}</div><small><bdi>@${esc(u.username || "")}</bdi></small></div>
      <div class="end">${owner && id !== me ? `<button class="btn-mini ghost" data-pro="${esc(id)}">${(g.admins || []).includes(id) ? "إلغاء الإشراف" : "ترقية"}</button>` : ""}${canRm ? `<button class="btn-danger sm" data-rm="${esc(id)}">إزالة</button>` : ""}</div></div>`; }).join("");
  const sh = openModal(`<div class="prof">${gAvatar(g, "big")}<h3>${esc(g.name)}</h3>
      <div class="chips"><span class="chip">${ch ? "قناة" : "مجموعة"}</span><span class="chip">${gCount(g)}</span>${g.handle ? `<span class="chip"><bdi>#${esc(g.handle)}</bdi></span>` : ""}</div>
      ${g.desc ? `<div class="bio">${esc(g.desc)}</div>` : ""}
      <div class="actions">${g.joinOpen ? `<button class="btn-ghost" id="giLink">نسخ رابط الدعوة</button>` : ""}${admin ? `<button class="btn-primary" id="giEdit">تعديل</button>` : ""}</div></div>
    ${admin ? `<div class="panel-h">الإعدادات</div>${switchRow("giOpen", !!g.joinOpen, "رابط الدعوة شغال", "لو اتقفل محدش يقدر ينضم بالرابط")}${ch ? switchRow("giPub", !!g.public, "قناة عامة", "تظهر في استكشاف القنوات") : ""}
      <div class="field" style="margin-top:14px"><label for="giAdd">إضافة ${ch ? "متابع" : "عضو"} باليوزر</label><div class="inline-add"><input type="text" id="giAdd" placeholder="username" autocapitalize="none" style="direction:ltr;text-align:end"><button class="btn-mini" id="giAddBtn">إضافة</button></div><div class="hint" id="giH"></div></div>` : ""}
    <div class="panel-h">${ch && !admin ? "المشرفين" : "الأعضاء"}</div><div id="giList">${rows}</div>${ch && !admin ? `<div class="hint">${gCount(g)}</div>` : (g.members || []).length > 100 ? `<div class="hint">عرض أول 100 فقط</div>` : ""}
    <div class="actions" style="margin-top:20px">${member && !owner ? `<button class="btn-danger" id="giLeave">${ch ? "إلغاء المتابعة" : "الخروج من المجموعة"}</button>` : ""}${owner ? `<button class="btn-danger" id="giDel">حذف ${ch ? "القناة" : "المجموعة"}</button>` : ""}</div>`, true);
  const q = id => sh.querySelector(id), up = patch => updateDoc(doc(db, "groups", gid), patch).then(() => openGroupInfo(gid)).catch(() => toast("تعذّر الحفظ"));
  const l = q("#giLink"); if (l) l.onclick = () => copyText(inviteLink(g), "اتنسخ رابط الدعوة");
  const ed = q("#giEdit"); if (ed) ed.onclick = () => openEditGroup(g);
  const o = q("#giOpen"); if (o) o.onchange = e => up({ joinOpen: e.target.checked });
  const pb = q("#giPub"); if (pb) pb.onchange = e => up({ public: e.target.checked });
  const ab = q("#giAddBtn"); if (ab) ab.onclick = async () => {
    const name = q("#giAdd").value.trim().toLowerCase().replace(/^@/, ""), h = q("#giH"); h.className = "hint";
    if (!/^[a-z0-9_]{3,20}$/.test(name)) { h.className = "hint err"; h.textContent = "اكتب اليوزر صح"; return; }
    try {
      const s = await getDoc(doc(db, "usernames", name)); if (!s.exists()) { h.className = "hint err"; h.textContent = "مفيش حد بالاسم ده"; return; }
      const uid = s.data().uid; if ((g.members || []).includes(uid)) { h.textContent = "موجود بالفعل"; return; }
      await updateDoc(doc(db, "groups", gid), { members: arrayUnion(uid) }); toast("اتضاف"); openGroupInfo(gid);
    } catch { h.className = "hint err"; h.textContent = "تعذّرت الإضافة (ممكن العدد اكتمل)"; }
  };
  const list = q("#giList");
  list.onclick = async e => {
    const rm = e.target.closest("[data-rm]"), pro = e.target.closest("[data-pro]");
    if (rm) { if (!confirm("تشيله؟")) return; up({ members: arrayRemove(rm.dataset.rm), admins: arrayRemove(rm.dataset.rm) }); }
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
    <div class="field"><label for="eD">الوصف</label><textarea id="eD" maxlength="200" style="min-height:70px">${esc(g.desc || "")}</textarea></div>
    <div class="actions"><button class="btn-primary" id="eGo">حفظ</button></div></div>`);
  const q = id => sh.querySelector(id), paint = () => { q("#epv").innerHTML = gAvatar({ kind: g.kind, name: q("#eN").value || "?", photo }, "big"); }; paint(); q("#eN").oninput = paint;
  q("#epPick").onclick = () => q("#epFile").click();
  q("#epFile").onchange = async e => { const f = e.target.files[0]; if (!f) return; try { photo = await compressPhoto(f); paint(); } catch { toast("الصورة دي مش مدعومة"); } };
  q("#eGo").onclick = async () => { const name = q("#eN").value.trim(); if (!name) return; try { await updateDoc(doc(db, "groups", g.id), { name, desc: q("#eD").value.trim(), photo }); toast("اتحفظ"); openGroupInfo(g.id); } catch { toast("تعذّر الحفظ"); } };
}
function openGroupMenu(gid) {
  const g = S.groups.find(x => x.id === gid); if (!g) return;
  const P = S.prefs, owner = g.owner === S.user.uid;
  const rows = [["info", g.kind === "channel" ? "معلومات القناة" : "معلومات المجموعة"], ["pin", P.pins.includes(gid) ? "إلغاء تثبيت المحادثة" : "تثبيت المحادثة"], ["arch", P.arch.includes(gid) ? "إلغاء الأرشفة" : "أرشفة المحادثة"],
    ["mute", P.mute.includes(gid) ? "إلغاء كتم الإشعارات" : "كتم الإشعارات"], ["lbl", "التصنيفات"], ...(owner ? [] : [["leave", g.kind === "channel" ? "إلغاء المتابعة" : "الخروج من المجموعة", "", true]])];
  const sh = openModal(`<div class="menu"><div class="menu-h">${esc(g.name)}</div>${rows.map(([a, t, v, d]) => `<button class="mrow ${d ? "danger" : ""}" data-a="${a}"><span>${t}</span></button>`).join("")}</div>`);
  sh.querySelector(".menu").onclick = e => {
    const b = e.target.closest("[data-a]"); if (!b) return; const a = b.dataset.a; closeModal();
    if (a === "info") openGroupInfo(gid);
    else if (a === "pin") { if (!P.pins.includes(gid) && P.pins.length >= 3) return toast("أقصى حاجة 3 محادثات مثبتة"); savePrefs({ pins: toggleIn(P.pins, gid) }); }
    else if (a === "arch") savePrefs({ arch: toggleIn(P.arch, gid) });
    else if (a === "mute") savePrefs({ mute: toggleIn(P.mute, gid) });
    else if (a === "lbl") openLabelPicker(gid);
    else if (a === "leave") leaveGroup(g);
  };
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
  const step = (ok, t, d) => { rows.push(`<div class="pc ${ok ? "ok" : "bad"}"><b>${ok ? "✓" : "✗"}</b><div><span>${esc(t)}</span>${d ? `<small>${esc(d)}</small>` : ""}</div></div>`); list.innerHTML = rows.join(""); return ok; };
  if (!step("Notification" in window && "serviceWorker" in navigator && "PushManager" in window, "المتصفح بيدعم الإشعارات", "على الآيفون لازم تضيف الموقع للشاشة الرئيسية. على الأندرويد استخدم كروم.")) return;
  if (!step(Notification.permission === "granted", "إذن الإشعارات", Notification.permission === "granted" ? "" : "الإذن حاليًا: " + Notification.permission + ". فعّله من إعدادات الموقع في المتصفح.")) return;
  if (!step(VAPID_KEY.length > 40, "مفتاح VAPID في firebase-config.js", VAPID_KEY ? "" : "فاضي. انسخ المفتاح من Firebase ← Cloud Messaging ← Web Push certificates والصقه في VAPID_KEY.")) return;
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
  step(true, "كله تمام ✅", "لو الإشعار ظهر يبقى الإعداد سليم. اقفل الموقع وخلّي حد يبعتلك.");
}

/* ---------------- profile view ---------------- */
async function openProfile(uid, opts = {}) {
  let u = S.users.get(uid);
  if (!u) { try { const s = await getDoc(doc(db, "users", uid)); u = s.exists() ? s.data() : null; } catch {} }
  if (!u) return toast("البروفايل مش موجود");
  const self = uid === S.user.uid, own = isOwner();
  const sh = openModal(`<div class="prof">
    ${avatar(u)}
    <h3>${esc(u.name)}${badge(u, 22)}</h3>
    <div class="un"><bdi>@${esc(u.username || "—")}</bdi></div>
    <div class="chips">${u.role === "owner" ? `<span class="chip owner">المالك · حساب رسمي</span>` : ""}<span class="chip">${genderText(u.gender)}</span>${u.banned ? `<span class="tag-ban">موقوف</span>` : ""}</div>
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
  on("#pVer", async () => { await updateDoc(doc(db, "users", uid), { verified: !u.verified }); toast("تم"); openProfile(uid, opts); });
  on("#pBan", async () => { await updateDoc(doc(db, "users", uid), { banned: !u.banned }); toast("تم"); openProfile(uid, opts); });
  on("#pDel", async () => {
    if (!confirm("هيتم حذف بيانات الحساب واسم المستخدم نهائيًا. متأكد؟")) return;
    const b = writeBatch(db); b.delete(doc(db, "users", uid)); if (u.username) b.delete(doc(db, "usernames", u.username));
    await b.commit(); toast("اتحذف الحساب"); opts.fromPanel ? openOwner() : closeModal();
  });
}

/* ---------------- owner panel ---------------- */
async function openOwner(tab = "overview") {
  if (!isOwner()) return;
  const sh = openModal(`<div class="tabs" id="tabs">
      <button data-t="overview">نظرة عامة</button><button data-t="users">المستخدمون</button><button data-t="logins">سجل الدخول</button><button data-t="settings">إعدادات الموقع</button></div>
    <div id="pbody"><div class="empty-list">جاري التحميل...</div></div>`, true);
  const body = sh.querySelector("#pbody");
  sh.querySelectorAll("[data-t]").forEach(b => { b.classList.toggle("on", b.dataset.t === tab); b.onclick = () => openOwner(b.dataset.t); });
  const users = [...S.users.entries()];
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
    body.innerHTML = `<input class="panel-search" id="pq" placeholder="ابحث بالاسم أو اليوزر أو الإيميل"><div id="pl"></div>`;
    const paint = () => {
      const t = body.querySelector("#pq").value.trim().toLowerCase().replace(/^@/, "");
      body.querySelector("#pl").innerHTML = users.filter(([, u]) => !t || [u.name, u.username, u.email].some(x => (x || "").toLowerCase().includes(t)))
        .sort((a, b) => (toDate(b[1].createdAt)?.getTime() || 0) - (toDate(a[1].createdAt)?.getTime() || 0))
        .map(([id, u]) => row(id, u, `آخر دخول<br>${esc(fmtDT(u.lastLogin))}`)).join("") || `<div class="empty-list">مفيش نتايج</div>`;
      wire();
    };
    body.querySelector("#pq").oninput = paint; paint();
  } else if (tab === "settings") {
    const st = S.site || {};
    body.innerHTML = `${switchRow("sMaint", !!st.maintenance, "وضع الصيانة", "بيقفل الموقع على كل الأعضاء ماعدا حسابك")}
      ${switchRow("sReg", st.registrationOpen !== false, "فتح التسجيل", "لو اتقفل محدش جديد يقدر يعمل حساب")}
      ${switchRow("sPub", st.publicOpen !== false, "الغرفة العامة مفتوحة للكتابة", "لو اتقفلت إنت بس اللي بتكتب فيها")}
      <div class="field" style="margin-top:14px"><label for="sMsg">رسالة الصيانة</label><input type="text" id="sMsg" maxlength="120" value="${esc(st.maintenanceMsg || "")}" placeholder="هنرجع قريب"></div>
      <div class="field"><label for="sAnn">إعلان لكل الأعضاء (بيظهر فوق القايمة)</label><textarea id="sAnn" maxlength="200" placeholder="اكتب الإعلان هنا">${esc(st.announcement || "")}</textarea></div>
      <div class="actions" style="justify-content:flex-start"><button class="btn-primary" id="sSave">حفظ الإعدادات</button><button class="btn-ghost" id="sClear">مسح الإعلان</button></div>
      <div class="panel-h">البيانات</div>
      <div class="actions" style="justify-content:flex-start"><button class="btn-ghost" id="sCsv">تصدير المستخدمين (CSV)</button></div>`;
    const save = async extra => {
      try {
        await setDoc(doc(db, "settings", "site"), { maintenance: body.querySelector("#sMaint").checked, registrationOpen: body.querySelector("#sReg").checked, publicOpen: body.querySelector("#sPub").checked,
          maintenanceMsg: body.querySelector("#sMsg").value.trim(), announcement: body.querySelector("#sAnn").value.trim(), updatedAt: serverTimestamp(), ...(extra || {}) }, { merge: true });
        toast("اتحفظت الإعدادات");
      } catch (e) { console.error(e); toast("تعذّر الحفظ"); }
    };
    body.querySelector("#sSave").onclick = () => save();
    body.querySelector("#sClear").onclick = () => { body.querySelector("#sAnn").value = ""; save({ announcement: "" }); };
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
}
