/* Web2cmd service worker — handles Web Push and notification clicks. */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Web2cmd", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Web2cmd";
  const options = {
    body: data.body || "",
    icon: "/icon.svg",
    badge: "/icon.svg",
    tag: data.tag || "web2cmd",
    renotify: true,
    requireInteraction: true,
    vibrate: [120, 60, 120],
    data: { sessionId: data.sessionId || null },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const sid = event.notification.data && event.notification.data.sessionId;
  const url = sid ? `/?session=${encodeURIComponent(sid)}` : "/";
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of all) {
        if ("focus" in client) {
          await client.focus();
          if (sid && "navigate" in client) {
            try {
              await client.navigate(url);
            } catch {
              /* navigation may be blocked; focus is enough */
            }
          }
          return;
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(url);
    })(),
  );
});
