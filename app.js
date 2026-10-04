import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, collection, query, orderBy, limit, limitToLast,
  onSnapshot, addDoc, where, serverTimestamp, increment, writeBatch, getDocs }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, OWNER_EMAIL } from "./firebase-config.js";

/* ---------------- helpers ---------------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const S = { user: null, me: null, users: new Map(), chats: [], chat: null, found: null, unsub: {}, view: "boot" };
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
  for (const id of ["boot", "login", "onboard", "banned", "app"]) $("#" + id).classList.toggle("hidden", id !== view);
}
function closeModal() { $("#modal").classList.add("hidden"); $("#sheet").innerHTML = ""; $("#sheet").classList.remove("wide"); }
function openModal(html, wide = false) {
  const sh = $("#sheet");
  sh.classList.toggle("wide", wide);
  sh.innerHTML = `<button class="x" id="xBtn" aria-label="إغلاق">✕</button>` + html;
  $("#modal").classList.remove("hidden");
  $("#xBtn").onclick = closeModal;
  return sh;
}
$("#modal").addEventListener("mousedown", e => { if (e.target.id === "modal") closeModal(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });

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
let auth, db;
if (!configured) {
  show("login");
  $("#googleBtn").disabled = true;
  $("#loginMsg").textContent = "لازم تلصق إعدادات Firebase في ملف firebase-config.js الأول.";
} else {
  const fb = initializeApp(firebaseConfig);
  auth = getAuth(fb); db = initializeFirestore(fb, { experimentalAutoDetectLongPolling: true });
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

function cleanup() {
  Object.values(S.unsub).forEach(f => f && f());
  clearInterval(S.beatT); clearInterval(S.tickT); clearTimeout(S.typT);
  S.unsub = {}; S.me = null; S.chat = null; S.users = new Map(); S.chats = []; S.found = null;
}

async function onAuth(user) {
  cleanup(); closeModal();
  if (!user) { S.user = null; $("#googleBtn").disabled = false; show("login"); return; }
  S.user = user;
  try {
    const ref = doc(db, "users", user.uid);
    const snap = await withTimeout(getDoc(ref));
    const owner = isOwnerUser(user);
    const logIt = () => addDoc(collection(db, "logins"), { uid: user.uid, name: (user.displayName || "مستخدم").slice(0, 40), at: serverTimestamp() }).catch(() => {});
    if (!snap.exists()) {
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

/* ---------------- app shell ---------------- */
function paintMe() {
  const me = S.me;
  $("#meBtn").innerHTML = me.photo ? `<img src="${esc(me.photo)}" alt="">` : esc((me.name || "?").charAt(0).toUpperCase());
  $("#whoami").textContent = "@" + (me.username || "");
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
const isOnline = u => { const t = toDate(u && u.lastSeen); return !!t && Date.now() - t.getTime() < ONLINE_MS; };

/* حضور المستخدم: بنسجّل آخر ظهور كل دقيقة طول ما الصفحة مفتوحة */
function beat() { if (S.user && S.view === "app") updateDoc(doc(db, "users", S.user.uid), { lastSeen: serverTimestamp() }).catch(() => {}); }
document.addEventListener("visibilitychange", beat);
addEventListener("pagehide", beat);

function enterApp() {
  show("app"); paintMe();
  $("#ownerBtn").innerHTML = CROWN; $("#ownerBtn").classList.add("owner");
  if (isOwner()) S.unsub.users = onSnapshot(query(collection(db, "users"), limit(500)), snap => { snap.docs.forEach(d => S.users.set(d.id, d.data())); }, e => console.error(e));
  S.chats = [];
  S.unsub.chats = onSnapshot(query(collection(db, "chats"), where("members", "array-contains", S.user.uid)), async snap => {
    S.chats = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(c => c.lastAt);
    await ensureUsers(S.chats.map(peerOf)); renderList();
  }, e => console.error(e));
  beat(); S.beatT = setInterval(() => { if (document.visibilityState === "visible") beat(); }, 60000);
  let n = 0;
  S.tickT = setInterval(async () => {
    if (S.view !== "app") return;
    if (S.chat && S.chat.peer) paintHead();
    if (++n % 3 === 0) { await Promise.all(S.chats.map(c => getUser(peerOf(c), true))); renderList(); }
  }, 20000);
  renderList(); showEmpty();
}
function showEmpty() {
  S.chat = null; if (S.unsub.msgs) S.unsub.msgs(); if (S.unsub.peerDoc) S.unsub.peerDoc(); if (S.unsub.chatDoc) S.unsub.chatDoc();
  $("#chatHead").innerHTML = ""; $("#composerWrap").classList.add("hidden");
  $("#messages").innerHTML = `<div class="empty"><div class="big">ES Chat Pro</div><p>ابحث عن صاحبك بالـ @يوزر عشان تبدأ محادثة.</p></div>`;
  $("#app").classList.remove("open");
}
$("#meBtn").onclick = () => { const sh = openModal(`<div id="editBox"></div>`); renderForm(sh.querySelector("#editBox"), "edit"); };
$("#ownerBtn").onclick = () => openOwner();
$("#back").onclick = () => { $("#app").classList.remove("open"); };
$("#chatHead").onclick = () => { if (S.chat && S.chat.peer) openProfile(S.chat.peer); };
$("#whoami").onclick = () => { const t = "@" + (S.me.username || ""); (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => toast("اتنسخ اليوزر " + t), () => toast(t)); };

/* البحث: بالـ username بالظبط فقط، مفيش قايمة أعضاء */
let searchT;
$("#search").oninput = () => { S.found = null; renderList(); clearTimeout(searchT); searchT = setTimeout(doSearch, 400); };
async function doSearch() {
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

function renderList() {
  if (S.view !== "app") return;
  const term = $("#search").value.trim().toLowerCase().replace(/^@/, "");
  let h = `<div class="section">الغرفة العامة</div>
    <div class="chat-item ${S.chat && S.chat.id === "public" ? "active" : ""}" data-open="public"><div class="avatar public">ES</div>
      <div class="chat-meta"><div class="name">الغرفة العامة</div><div class="preview">محادثة مفتوحة لكل الأعضاء</div></div></div>`;
  if (term) {
    h += `<div class="section">نتيجة البحث</div>`;
    const f = S.found;
    if (f && f.uid) h += `<div class="chat-item" data-open="${esc(f.uid)}">${avatar(f.u)}<div class="chat-meta"><div class="name">${esc(f.u.name)}${badge(f.u, 15)}</div><div class="preview">@${esc(f.u.username)}</div></div></div>`;
    else if (f && f.self) h += `<div class="empty-list">ده اليوزر بتاعك 🙂</div>`;
    else if (f && f.none) h += `<div class="empty-list">مفيش حد بالـ username ده. اتأكد إنه مكتوب صح.</div>`;
    else h += `<div class="empty-list">اكتب اليوزر كامل (3 حروف على الأقل)...</div>`;
  }
  h += `<div class="section">محادثاتك</div>`;
  const chats = [...S.chats].sort((a, b) => (toDate(b.lastAt)?.getTime() || 0) - (toDate(a.lastAt)?.getTime() || 0));
  h += chats.length ? chats.map(c => {
    const pid = peerOf(c), u = S.users.get(pid) || { name: "مستخدم" };
    return `<div class="chat-item ${S.chat && S.chat.peer === pid ? "active" : ""}" data-open="${esc(pid)}"><div class="av-wrap">${avatar(u)}${isOnline(u) ? `<i class="dot"></i>` : ""}</div>
      <div class="chat-meta"><div class="name">${esc(u.name)}${badge(u, 15)}</div><div class="preview">${c.lastUid === S.user.uid ? "أنت: " : ""}${esc(c.lastText || "")}</div></div></div>`;
  }).join("") : `<div class="empty-list">مفيش محادثات لسه.<br>اطلب من صاحبك الـ @username بتاعه وابحث بيه فوق.</div>`;
  $("#list").innerHTML = h;
}
$("#list").addEventListener("click", e => {
  const it = e.target.closest("[data-open]"); if (!it) return;
  const v = it.dataset.open; openChat(v === "public" ? null : v);
});

function statusOf(u, c) {
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
  if (!c.peer) { $("#chatHead").innerHTML = `<div class="avatar public">ES</div><div class="t"><b>الغرفة العامة</b><small>محادثة مفتوحة لكل الأعضاء</small></div>`; return; }
  const u = S.users.get(c.peer) || {}, st = statusOf(u, c);
  $("#chatHead").innerHTML = `<div class="av-wrap">${avatar(u)}${isOnline(u) ? `<i class="dot"></i>` : ""}</div><div class="t"><b>${esc(u.name || "مستخدم")}${badge(u, 16)}</b><small class="st ${st.cls}">${esc(st.t || "@" + (u.username || ""))}</small></div>`;
}

function openChat(peer) {
  if (S.unsub.msgs) S.unsub.msgs(); if (S.unsub.peerDoc) S.unsub.peerDoc(); if (S.unsub.chatDoc) S.unsub.chatDoc();
  clearTimeout(S.typT);
  const id = peer ? [S.user.uid, peer].sort().join("_") : "public";
  S.chat = { id, peer: peer || null, first: true, lastTyping: undefined, typingAt: 0, sentTyping: 0 };
  $("#composerWrap").classList.remove("hidden"); $("#app").classList.add("open");
  $("#messages").innerHTML = ""; paintHead(); renderList();
  S.unsub.msgs = onSnapshot(query(collection(db, "chats", id, "messages"), orderBy("at"), limitToLast(150)),
    snap => { S.chat && S.chat.id === id && renderMsgs(snap.docs); }, e => { console.error(e); toast("مفيش صلاحية لقراءة الرسايل — راجع قواعد Firestore"); });
  if (peer) {
    getUser(peer).then(paintHead);
    S.unsub.peerDoc = onSnapshot(doc(db, "users", peer), s => { if (s.exists() && S.chat && S.chat.peer === peer) { S.users.set(peer, s.data()); paintHead(); } }, () => {});
    S.unsub.chatDoc = onSnapshot(doc(db, "chats", id), s => {
      if (!S.chat || S.chat.id !== id) return;
      const t = (s.exists() && s.data().typing && s.data().typing[peer]) || 0;
      if (!t) S.chat.typingAt = 0;
      else if (S.chat.lastTyping !== undefined && t !== S.chat.lastTyping) { S.chat.typingAt = Date.now(); clearTimeout(S.typT); S.typT = setTimeout(paintHead, 5200); }
      S.chat.lastTyping = t; paintHead();
    }, () => {});
  }
}

function renderMsgs(docs) {
  const box = $("#messages"), near = box.scrollHeight - box.scrollTop - box.clientHeight < 140 || S.chat.first;
  const pub = !S.chat.peer, canDelAll = isOwner() && pub;
  S.chat.lastDocs = docs;
  if (!docs.length) {
    box.innerHTML = `<div class="empty"><div class="big">${pub ? "الغرفة فاضية" : "ابدأ المحادثة"}</div><p>اكتب أول رسالة من الأسفل.</p></div>`;
    S.chat.first = false; return;
  }
  if (pub) ensureUsers(docs.map(d => d.data().uid)).then(ch => { if (ch && S.chat && !S.chat.peer) renderMsgs(S.chat.lastDocs); });
  let last = "", h = "";
  for (const d of docs) {
    const m = d.data({ serverTimestamps: "estimate" }), dt = toDate(m.at) || new Date(), mine = m.uid === S.user.uid;
    const lbl = dayLabel(dt); if (lbl !== last) { h += `<div class="date-sep">${esc(lbl)}</div>`; last = lbl; }
    const sender = S.users.get(m.uid) || {};
    h += `<div class="msg ${mine ? "me" : "them"}">`
      + (pub && !mine ? `<div class="who" data-uid="${esc(m.uid)}">${esc(sender.name || "مستخدم")}${badge(sender, 14)}</div>` : "")
      + `<div class="txt">${esc(m.text)}</div>`
      + `<div class="tm">${(mine || canDelAll) ? `<button class="del" data-del="${esc(d.id)}">حذف</button>` : ""}<span>${fmtTime(dt)}</span></div></div>`;
  }
  box.innerHTML = h;
  if (near) box.scrollTop = box.scrollHeight;
  S.chat.first = false;
}
$("#messages").addEventListener("click", async e => {
  const w = e.target.closest("[data-uid]"); if (w) return openProfile(w.dataset.uid);
  const b = e.target.closest("[data-del]");
  if (b && confirm("تحذف الرسالة دي؟")) deleteDoc(doc(db, "chats", S.chat.id, "messages", b.dataset.del)).catch(() => toast("مقدرتش أحذف الرسالة"));
});

const chatRef = () => doc(db, "chats", S.chat.id);
const membersOf = () => [S.user.uid, S.chat.peer].sort();
$("#input").addEventListener("input", () => {
  const c = S.chat; if (!c || !c.peer || !$("#input").value.trim()) return;
  if (Date.now() - c.sentTyping < 2500) return;
  c.sentTyping = Date.now();
  setDoc(chatRef(), { members: membersOf(), typing: { [S.user.uid]: Date.now() } }, { merge: true }).catch(() => {});
});
$("#form").onsubmit = async e => {
  e.preventDefault();
  const text = $("#input").value.trim(); if (!text || !S.chat) return;
  $("#input").value = ""; const c = S.chat;
  try {
    await addDoc(collection(db, "chats", c.id, "messages"), { uid: S.user.uid, text, at: serverTimestamp() });
    if (c.peer) { c.sentTyping = 0; setDoc(chatRef(), { members: membersOf(), lastText: text.slice(0, 80), lastAt: serverTimestamp(), lastUid: S.user.uid, typing: { [S.user.uid]: 0 } }, { merge: true }).catch(e => console.error(e)); }
  } catch (er) { console.error(er); $("#input").value = text; toast("الرسالة ماتبعتتش"); }
};

/* ---------------- profile view ---------------- */
async function openProfile(uid, opts = {}) {
  let u = S.users.get(uid);
  if (!u) { try { const s = await getDoc(doc(db, "users", uid)); u = s.exists() ? s.data() : null; } catch {} }
  if (!u) return toast("البروفايل مش موجود");
  const self = uid === S.user.uid, own = isOwner();
  const sh = openModal(`<div class="prof">
    ${avatar(u)}
    <h3>${esc(u.name)}${badge(u, 22)}</h3>
    <div class="un">@${esc(u.username || "—")}</div>
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
  on("#pEdit", () => $("#meBtn").click());
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
      <button data-t="overview">نظرة عامة</button><button data-t="users">المستخدمون</button><button data-t="logins">سجل الدخول</button></div>
    <div id="pbody"><div class="empty-list">جاري التحميل...</div></div>`, true);
  const body = sh.querySelector("#pbody");
  sh.querySelectorAll("[data-t]").forEach(b => { b.classList.toggle("on", b.dataset.t === tab); b.onclick = () => openOwner(b.dataset.t); });
  const users = [...S.users.entries()];
  const row = (id, u, end) => `<div class="row-item" data-p="${esc(id)}">${avatar(u)}<div class="meta"><div class="name">${esc(u.name)}${badge(u, 15)}${u.banned ? ` <span class="tag-ban">موقوف</span>` : ""}</div><small>@${esc(u.username || "—")} · ${esc(u.email || "")}</small></div><div class="end">${end}</div></div>`;
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
  } else {
    let rows = [];
    try { rows = (await getDocs(query(collection(db, "logins"), orderBy("at", "desc"), limit(80)))).docs.map(d => d.data()); } catch { toast("تعذّر قراءة سجل الدخول"); }
    body.innerHTML = rows.map(r => row(r.uid, S.users.get(r.uid) || { name: r.name }, esc(fmtDT(r.at)))).join("") || `<div class="empty-list">مفيش سجل دخول لسه</div>`;
    wire();
  }
}
