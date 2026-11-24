/* Service worker: receives Web Push and opens the briefing on click. */
self.addEventListener("push", (event) => {
  let payload = { title: "digithive", body: "새 알림이 있습니다." };
  try {
    payload = event.data ? event.data.json() : payload;
  } catch {
    // keep the default payload
  }
  event.waitUntil(
    self.registration.showNotification(payload.title || "digithive", {
      body: payload.body || "",
      data: { url: "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow(event.notification.data?.url || "/"));
});
