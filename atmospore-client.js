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

  function isDateKey(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
  }

  function normalizeCategories(source) {
    return Object.fromEntries(
      ["tree", "grass", "weed", "ragweed"]
        .map((key) => [key, normalizeCategory(source?.[key])])
        .filter(([, value]) => value)
    );
  }

  function normalizeDays(days) {
    if (!days || typeof days !== "object" || Array.isArray(days)) return {};
    return Object.fromEntries(
      Object.entries(days)
        .filter(([date]) => isDateKey(date))
        .map(([date, value]) => [date, normalizeCategories(value)])
        .filter(([, categories]) => Object.keys(categories).length)
    );
  }

  function validCoordinates(location) {
    const lat = Number(location?.lat);
    const lon = Number(location?.lon);
    return location?.lat !== null && location?.lon !== null
      && Number.isFinite(lat) && Number.isFinite(lon)
      && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
  }

  async function getPollenData(location, { timeoutMs = 6500, startDate = "", forecastDays = 7 } = {}) {
    if (!validCoordinates(location) || typeof fetch !== "function") return null;
    const params = new URLSearchParams({ lat: String(Number(location.lat)), lon: String(Number(location.lon)) });
    if (isDateKey(startDate)) params.set("start_date", startDate);
    const requestedDays = Math.max(1, Math.min(7, Math.round(Number(forecastDays) || 7)));
    params.set("forecast_days", String(requestedDays));
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
      const categories = normalizeCategories(payload);
      const days = normalizeDays(payload.days);
      if (!Object.keys(categories).length && !Object.keys(days).length) return null;
      return {
        provider: "atmospore",
        date: String(payload.date || ""),
        generatedAt: String(payload.generatedAt || ""),
        units: String(payload.units || ""),
        location: validCoordinates(payload.location) ? { lat: Number(payload.location.lat), lon: Number(payload.location.lon) } : null,
        categories,
        days,
        forecastDays: Math.max(0, Math.round(Number(payload.forecastDays) || Object.keys(days).length))
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
