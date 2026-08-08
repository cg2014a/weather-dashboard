const CACHE_NAME = "skystation-v1-4";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
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
  "./icons/moon.svg",
  "./icons/alert.svg"
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
        if (event.request.url.startsWith(self.location.origin)) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("./offline.html")))
  );
});
