// Caches the app shell so the app opens without a network. API calls always
// go to the network: advice and field state must never be shown from a cache.
const CACHE = "wheat-water-v3";   // bump when app files change, so installed copies update
const SHELL = ["./", "index.html", "styles.css", "app.js", "api.js", "notify.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "demo_season.json"];
self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (u.pathname.includes("/api/") || e.request.method !== "GET") return;
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
