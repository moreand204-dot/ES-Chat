// Vercel Serverless Function: بيحقن وسوم Open Graph جوه index.html حسب الرابط
// (?u=يوزر | ?c=قناة | ?g=مجموعة) عشان واتساب/تليجرام وغيرهم يعرضوا كارت للرابط.
// بيستخدم نفس متغير البيئة FIREBASE_SERVICE_ACCOUNT بتاع notify.js.
const admin = require("firebase-admin");
const fs = require("fs"), path = require("path");

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const OK = /^[a-z0-9_]{3,20}$/;

function init() {
  if (admin.apps.length) return;
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}

module.exports = async (req, res) => {
  const origin = "https://" + req.headers.host;
  const q = req.query || {};
  let title = "ES Chat Pro", desc = "شات عربي سريع وآمن", image = origin + "/assets/icon-512.png", param = "";
  try {
    init();
    const db = admin.firestore();
    let d = null;
    if (OK.test(String(q.u || ""))) {
      param = "u=" + q.u;
      const un = await db.doc("usernames/" + q.u).get();
      if (un.exists) {
        const p = await db.doc(`users/${un.data().uid}/public/profile`).get();
        if (p.exists) d = { t: p.data().name + (p.data().verified ? " ✓" : "") + " على ES Chat Pro", s: p.data().bio || "افتح الرابط وابدأ محادثة", p: p.data().photo, img: "u=" + q.u };
      }
    } else if (OK.test(String(q.c || ""))) {
      param = "c=" + q.c;
      const h = await db.doc("handles/" + q.c).get();
      if (h.exists) {
        const g = await db.doc("groupDirectory/" + h.data().gid).get();
        if (g.exists && g.data().public) d = { t: g.data().name, s: g.data().desc || "قناة على ES Chat Pro — اضغط للانضمام", p: g.data().photo, img: "c=" + q.c };
      }
    } else if (q.g) {
      param = "g=" + q.g; title = "دعوة لمجموعة على ES Chat Pro"; desc = "اضغط عشان تنضم للمجموعة";
      if (/^[A-Za-z0-9]{10,40}$/.test(String(q.g))) {
        const g = await db.doc("groups/" + q.g).get();
        if (g.exists && g.data().joinOpen) { const x = g.data(), n = (x.members || []).length; d = { t: (x.kind === "channel" ? "قناة " : "دعوة للانضمام إلى ") + x.name, s: x.desc || (n + (x.kind === "channel" ? " متابع" : " عضو") + " — اضغط للانضمام"), p: x.photo, img: "g=" + q.g }; }
      }
    }
    if (d) { title = d.t; desc = d.s; if (/^data:image\//.test(d.p || "") && d.img) image = origin + "/api/img?" + d.img; else if (/^https:\/\//.test(d.p || "")) image = d.p; }
  } catch (e) { console.error("og:", e.message); }

  let html;
  try { html = fs.readFileSync(path.join(process.cwd(), "index.html"), "utf8"); }
  catch { res.statusCode = 302; res.setHeader("Location", "/index.html"); return res.end(); }

  // شيل وسوم og القديمة وحط الجديدة
  html = html.replace(/<meta\s+property="og:[^>]*>\s*/gi, "").replace(/<meta\s+name="twitter:[^>]*>\s*/gi, "");
  const tags = `
<meta property="og:type" content="website">
<meta property="og:site_name" content="ES Chat Pro">
<meta property="og:locale" content="ar_AR">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(String(desc).slice(0, 160))}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:url" content="${esc(origin + "/" + (param ? "?" + param : ""))}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(String(desc).slice(0, 160))}">
<meta name="twitter:image" content="${esc(image)}">`;
  html = html.replace(/<head[^>]*>/i, m => m + tags);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
  res.status(200).send(html);
};
