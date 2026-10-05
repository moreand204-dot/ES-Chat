/* Service worker: بيستقبل الإشعارات (حتى والموقع مقفول) ويفتح المحادثة لما تضغط عليها.
   مفيش اعتماد على مكتبات خارجية هنا عشان يكون أضمن. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(clients.claim()));

self.addEventListener("push", e => {
  let j = {};
  try { j = e.data ? e.data.json() : {}; } catch { try { j = { body: e.data.text() }; } catch {} }
  const d = j.data || j;              // رسايل FCM بتيجي جوه .data
  e.waitUntil((async () => {
    const wins = await clients.matchAll({ type: "window", includeUncontrolled: true });
    // لو الموقع قدامك مفتوح، التطبيق بيعرض التنبيه بنفسه (إلا في اختبار الإشعارات)
    if (!d.force && wins.some(w => w.visibilityState === "visible")) return;
    await self.registration.showNotification(d.title || "رسالة جديدة", {
      body: d.body || "",
      icon: "assets/icon-192.png",
      badge: "assets/favicon-64.png",
      tag: d.chatId || "es-chat",
      renotify: true,
      dir: "rtl",
      lang: "ar",
      data: { chatId: d.chatId || "" }
    });
  })());
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
