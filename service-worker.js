importScripts("./version.js");

const CACHE_NAME = self.SKYSTATION_CACHE_NAME;
const APP_SHELL = [
  "./",
  "./index.html",
  "./version.js",
  "./style.css",
  "./atmospore-client.js",
  "./app.js",
  "./manifest.json",
  "./offline.html",
  "./assets/apple-touch-icon.svg",
  "./icons/app-icon.svg",
  "./icons/weather-sunny.svg",
  "./icons/weather-partly.svg",
  "./icons/weather-cloud.svg",
  "./icons/weather-rain.svg",
  "./icons/weather-storm.svg",
  "./icons/wind.svg",
  "./icons/humidity.svg",
  "./icons/pressure.svg",
  "./icons/uv.svg",
  "./icons/visibility.svg",
  "./icons/dew.svg",
  "./icons/gust.svg",
  "./icons/real-feel.svg",
  "./icons/rain-chance.svg",
  "./icons/sunrise.svg",
  "./icons/sunset.svg",
  "./icons/aqi.svg",
  "./icons/pollen.svg",
  "./icons/moon.svg",
  "./icons/alert.svg",
  "./icons/nav-settings.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (event.request.url.startsWith(self.location.origin) && response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE_NAME)
            .then((cache) => cache.put(event.request, copy))
            .catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => {
        if (cached) return cached;
        if (event.request.mode === "navigate") return caches.match("./offline.html");
        return Response.error();
      }))
  );
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data?.json() || {};
  } catch {
    payload = { body: event.data?.text?.() || "Your SkyStation weather update is ready." };
  }
  const title = typeof payload.title === "string" && payload.title ? payload.title : "SkyStation Morning Weather";
  const body = typeof payload.body === "string" && payload.body ? payload.body : "Your SkyStation weather update is ready.";
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: "icons/app-icon.svg",
    badge: "icons/app-icon.svg",
    tag: "skystation-morning-weather",
    renotify: false,
    data: { url: typeof payload.url === "string" ? payload.url : "https://cg2014a.github.io/weather-dashboard/" }
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const targetUrl = "https://cg2014a.github.io/weather-dashboard/";
    const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => client.url.startsWith(targetUrl));
    if (existing) return existing.focus();
    return clients.openWindow(targetUrl);
  })());
});











