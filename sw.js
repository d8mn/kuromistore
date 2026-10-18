// Service worker for Kuromi Store.
//
// Its only job is to exist and register: that is part of what makes a phone's
// "Add to Home Screen" install the site as a standalone app (no address bar or
// browser tabs) instead of just bookmarking a page.
//
// It deliberately does NOT cache anything. An earlier version cached the page
// shell, which could keep serving an old copy of the page even when the server
// was down or the site had been updated. Now every request goes straight to the
// network, so what you see is always what the server is serving right now.
// On activation it also deletes any caches the earlier version left behind.

self.addEventListener("install", () => {
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k.startsWith("kuromi-")).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

// A fetch handler must exist for installability. Not calling respondWith()
// means the browser handles the request normally (plain network).
self.addEventListener("fetch", () => {});
