// Caches the app shell so it opens instantly; forecast requests always go to the network.
const CACHE = "raincheck-v6";
const SHELL = ["./", "index.html", "base.css", "app.js", "manifest.webmanifest", "icon.svg",
  "designs/slate.css", "designs/aneroid.css", "designs/gate.css", "designs/minute.css", "designs/margin.css"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // APIs and fonts: straight to network
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request))
  );
});
