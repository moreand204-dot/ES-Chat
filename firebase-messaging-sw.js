/* Service worker: بيعرض الإشعارات ويفتح المحادثة لما تضغط عليها */
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyCts7srrieOCyWb0MBIHfJbZ6Sh5FrUrxQ",
  authDomain: "escanor-chat-8178c.firebaseapp.com",
  projectId: "escanor-chat-8178c",
  storageBucket: "escanor-chat-8178c.firebasestorage.app",
  messagingSenderId: "657166584629",
  appId: "1:657166584629:web:070063bf65194bcaa0da7c"
});
const messaging = firebase.messaging();

// رسالة وصلت والموقع مقفول أو في الخلفية
messaging.onBackgroundMessage(async payload => {
  const d = payload.data || {};
  const wins = await clients.matchAll({ type: "window", includeUncontrolled: true });
  if (wins.some(w => w.visibilityState === "visible")) return; // الموقع قدامك، مفيش داعي
  return self.registration.showNotification(d.title || "رسالة جديدة", {
    body: d.body || "",
    icon: "assets/icon-192.png",
    badge: "assets/favicon-64.png",
    tag: d.chatId || "es-chat",
    renotify: true,
    dir: "rtl",
    lang: "ar",
    data: { chatId: d.chatId || "" }
  });
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const chatId = (e.notification.data && e.notification.data.chatId) || "";
  e.waitUntil((async () => {
    const wins = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      await w.focus();
      w.postMessage({ type: "open-chat", chatId });
      return;
    }
    await clients.openWindow("./?chat=" + encodeURIComponent(chatId));
  })());
});

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(clients.claim()));
