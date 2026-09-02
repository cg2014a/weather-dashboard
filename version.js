self.SKYSTATION_VERSION = "v1-168";
self.SKYSTATION_CACHE_NAME = `skystation-${self.SKYSTATION_VERSION}`;

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", () => {
    const version = document.getElementById("appVersion");
    if (version) version.textContent = `Version ${self.SKYSTATION_VERSION}`;
  });
}
