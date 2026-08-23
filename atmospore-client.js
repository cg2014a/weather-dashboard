(() => {
  "use strict";

  const WORKER_URL = "https://skystation-pollen.cgarrett4.workers.dev/";
  const VALID_LEVELS = new Map([
    ["low", "Low"],
    ["moderate", "Moderate"],
    ["high", "High"],
    ["very high", "Very High"]
  ]);

  function normalizeRiskLevel(value) {
    const key = String(value || "").trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
    return VALID_LEVELS.get(key) || null;
  }

  function normalizeSpecies(items) {
    if (!Array.isArray(items)) return [];
    return items.map((item) => {
      const riskLevel = normalizeRiskLevel(item?.riskLevel);
      const name = String(item?.name || "").trim();
      if (!riskLevel || !name) return null;
      return {
        id: String(item?.id || "").trim(),
        name,
        riskLevel,
        value: Number.isFinite(Number(item?.value)) ? Number(item.value) : null
      };
    }).filter(Boolean);
  }

  function normalizeCategory(category) {
    const riskLevel = normalizeRiskLevel(category?.riskLevel);
    if (!riskLevel) return null;
    return {
      riskLevel,
      value: Number.isFinite(Number(category?.value)) ? Number(category.value) : null,
      topSpecies: String(category?.topSpecies || "").trim() || null,
      topSpeciesId: String(category?.topSpeciesId || "").trim() || null,
      speciesCount: Number.isFinite(Number(category?.speciesCount)) ? Number(category.speciesCount) : 0,
      activeSpeciesCount: Number.isFinite(Number(category?.activeSpeciesCount)) ? Number(category.activeSpeciesCount) : 0,
      elevatedSpeciesCount: Number.isFinite(Number(category?.elevatedSpeciesCount)) ? Number(category.elevatedSpeciesCount) : 0,
      activeSpecies: normalizeSpecies(category?.activeSpecies),
      elevatedSpecies: normalizeSpecies(category?.elevatedSpecies)
    };
  }

  function validCoordinates(location) {
    const lat = Number(location?.lat);
    const lon = Number(location?.lon);
    return location?.lat !== null && location?.lon !== null
      && Number.isFinite(lat) && Number.isFinite(lon)
      && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
  }

  async function getPollenData(location, { timeoutMs = 6500 } = {}) {
    if (!validCoordinates(location) || typeof fetch !== "function") return null;
    const params = new URLSearchParams({ lat: String(Number(location.lat)), lon: String(Number(location.lon)) });
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

    try {
      const response = await fetch(`${WORKER_URL}?${params.toString()}`, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller?.signal
      });
      if (!response.ok) return null;
      const payload = await response.json();
      if (!payload || String(payload.provider || "").toLowerCase() !== "atmospore") return null;
      const categories = Object.fromEntries(
        ["tree", "grass", "weed", "ragweed"]
          .map((key) => [key, normalizeCategory(payload[key])])
          .filter(([, value]) => value)
      );
      if (!Object.keys(categories).length) return null;
      return {
        provider: "atmospore",
        date: String(payload.date || ""),
        generatedAt: String(payload.generatedAt || ""),
        units: String(payload.units || ""),
        location: validCoordinates(payload.location) ? { lat: Number(payload.location.lat), lon: Number(payload.location.lon) } : null,
        categories
      };
    } catch (error) {
      console.debug("Atmospore pollen request unavailable.", error);
      return null;
    } finally {
      if (timeoutId !== null) clearTimeout(timeoutId);
    }
  }

  globalThis.SkyStationAtmosporeClient = Object.freeze({ getPollenData, normalizeRiskLevel });
})();
