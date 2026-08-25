const ICON_PATH = "icons/";
const DEFAULT_LOCATION = { label: "Olathe, KS", query: "Olathe, KS", city: "Olathe", state: "KS", lat: 38.9, lon: -94.84 };
const LOCATION_STORAGE_KEY = "skystation-location";
const AUTO_LOCATION_STORAGE_KEY = "skystation-auto-location";
const DAILY_LAYOUT_STORAGE_KEY = "skystation-daily-layout";
const MORNING_NOTIFICATION_STORAGE_KEY = "skystation-morning-notification";
const AIRNOW_KEY_STORAGE_KEY = "skystation-airnow-key";
const PRESSURE_HISTORY_STORAGE_KEY = "skystation-pressure-history";
const NOTIFICATION_WORKER_URL = "https://skystation-notifications.cgarrett4.workers.dev";
const PRECIP_DISPLAY_THRESHOLD = 20;
const MAX_NEARBY_PRECIP_STATION_MILES = 10;
// SkyStation forecast-impact heuristics. These are not official NWS warning thresholds.
const FORECAST_HAZARD_THRESHOLDS = Object.freeze({
  windGustImpactMph: 40,
  windGustAlertMph: 58,
  rainfallImpactInches: 1.5,
  rainfallAlertInches: 3,
  rainfallAlertWithHeavySignalInches: 2,
  rainfallAlertPrecipChance: 80,
  snowImpactInches: 3,
  snowAlertInches: 8
});
const nwsPointUrl = ({ lat, lon }) => `https://api.weather.gov/points/${lat},${lon}`;
const nwsAlertsUrl = ({ lat, lon }) => `https://api.weather.gov/alerts/active?point=${lat},${lon}`;
const spcOutlookUrl = (layerId, { lat, lon }) => {
  const params = new URLSearchParams({
    f: "json",
    where: "1=1",
    outFields: "dn,label,label2,valid,valid_iso,expire,expire_iso",
    returnGeometry: "false",
    geometry: `${lon},${lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outSR: "4326"
  });
  return `https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/SPC_wx_outlks/FeatureServer/${layerId}/query?${params}`;
};
const airQualityUrl = ({ lat, lon }) => `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=us_aqi&hourly=us_aqi&timezone=auto&forecast_days=7`;
const openMeteoForecastUrl = ({ lat, lon }) => `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,dew_point_2m,apparent_temperature,precipitation,rain,showers,snowfall,pressure_msl,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m&hourly=relative_humidity_2m,dew_point_2m,precipitation_probability,precipitation,rain,showers,snowfall,visibility,pressure_msl,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,uv_index&minutely_15=precipitation_probability,precipitation,rain,showers,snowfall&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,snowfall_sum,uv_index_max,sunrise,sunset&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&snowfall_unit=inch&timezone=auto&forecast_days=7&forecast_hours=168`;
const epaUvUrl = (location) => location.zip
  ? `https://data.epa.gov/dmapservice/getEnvirofactsUVDAILY/ZIP/${location.zip}/JSON`
  : `https://data.epa.gov/dmapservice/getEnvirofactsUVDAILY/CITY/${encodeURIComponent(location.city || "")}/STATE/${location.state || ""}/JSON`;
const airNowUrl = ({ lat, lon }, apiKey) => `https://www.airnowapi.org/aq/observation/latLong/current/?format=application/json&latitude=${lat}&longitude=${lon}&distance=25&API_KEY=${encodeURIComponent(apiKey)}`;
const airNowCurrentSitesUrl = ({ lat, lon }) => {
  const latitude = Number(lat);
  const longitude = Number(lon);
  const params = new URLSearchParams({
    f: "json",
    where: "1=1",
    outFields: "SiteName,StateName,OZONEPM_AQI,OZONEPM_AQI_LABEL,OZONEPM_AQI_SORT,PM25_AQI,PM_AQI,OZONE_AQI,Latitude,Longitude,Status,ValidTime",
    returnGeometry: "false",
    geometry: `${longitude},${latitude}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    distance: "75",
    units: "esriSRUnit_StatuteMile",
    outSR: "4326"
  });
  return `https://services1.arcgis.com/YiULsZbgRKmBtdZN/ArcGIS/rest/services/Particulate_Matter_Map_WFL1/FeatureServer/0/query?${params}`;
};
const emptyWeather = {
  location: { city: DEFAULT_LOCATION.label },
  current: {
    temperature: null,
    icon: "weather-cloud.svg",
    condition: "Loading weather",
    feelsLike: null,
    high: null,
    low: null
  },
  summaryStats: [],
  narrative: "Weather data is loading.",
  precipitation: { active: false, type: "Rain", icon: "weather-rain.svg", summary: "No significant precipitation expected.", current: "0% now", nextHour: "0% next hour", amount: "0 in", today: "", timeline: [], note: "No precipitation expected soon." },
  details: [],
  alert: null,
  hourly: [],
  daily: []
};

class WeatherService {
  constructor() {
    this.pendingAirQualityPayloads = new Map();
    this.pendingAtmosporePollenPayloads = new Map();
  }

  async getWeather(location = DEFAULT_LOCATION) {
    const fallback = this.clone(emptyWeather);
    fallback.location = { city: location.label };

    try {
      const liveData = await this.getNwsWeather(location);
      return { ...fallback, ...liveData };
    } catch (error) {
      console.warn("Live weather unavailable.", error);
      try {
        const fallbackData = await this.getFallbackWeather(location);
        return { ...fallback, ...fallbackData };
      } catch (fallbackError) {
        console.warn("Fallback weather unavailable.", fallbackError);
        return fallback;
      }
    }
  }

  clone(data) {
    return JSON.parse(JSON.stringify(data));
  }

  async getNwsWeather(location) {
    const point = await this.fetchJson(nwsPointUrl(location));
    const properties = point.properties;
    if (!properties?.forecast && !properties?.forecastHourly) throw new Error("NWS forecast links unavailable.");

    const spcOutlooksPromise = this.getSpcOutlooks(location);
    const [forecast, hourly, gridData, alerts, observation, supplemental] = (await Promise.allSettled([
      properties.forecast ? this.withTimeout(this.fetchJson(properties.forecast), 13000, "NWS forecast") : Promise.resolve(null),
      properties.forecastHourly ? this.withTimeout(this.fetchJson(properties.forecastHourly), 13000, "NWS hourly forecast") : Promise.resolve(null),
      properties.forecastGridData ? this.withTimeout(this.fetchJson(properties.forecastGridData), 9000, "NWS grid forecast") : Promise.resolve(null),
      this.withTimeout(this.fetchJson(nwsAlertsUrl(location)), 9000, "NWS alerts"),
      properties.observationStations ? this.withTimeout(this.getLatestObservation(properties.observationStations, location), 9000, "NWS observations") : Promise.resolve(null),
      this.withTimeout(this.getSupplementalWeather(location), 9000, "supplemental weather")
    ])).map((result) => this.settledValue(result));

    const hourlyPeriods = hourly?.properties?.periods || [];
    const forecastPeriods = forecast?.properties?.periods || [];
    if (!hourlyPeriods.length && !forecastPeriods.length && !supplemental) {
      throw new Error("No usable forecast periods returned.");
    }
    const dailyPeriods = forecastPeriods.length ? forecastPeriods : this.dailyPeriodsFromSupplemental(supplemental);
    const currentPeriod = hourlyPeriods[0] || forecastPeriods[0] || dailyPeriods[0] || this.periodFromSupplemental(supplemental);
    const pressureTrend = this.pressureTrendFromHistory(location, observation, supplemental);
    const gridSupplemental = this.mapGridData(gridData);
    const basePollen = this.getPollenData(location, { ...supplemental, ...gridSupplemental }, { currentPeriod, dailyPeriods, observation });
    const enrichedSupplemental = {
      ...supplemental,
      ...gridSupplemental,
      pressureTrend,
      airQualityLabel: "Checking",
      dailyAirQuality: [],
      alertHazards: this.mapAlertHazards(alerts || { features: [] }),
      spcOutlooks: [],
      pollen: basePollen
    };
    enrichedSupplemental.pollen = {
      ...basePollen,
      health: this.mapHealthRisks(enrichedSupplemental, null)
    };
    const current = this.mapCurrent(currentPeriod, dailyPeriods, hourlyPeriods, observation, enrichedSupplemental);
    const precipitation = this.mapPrecipitation(currentPeriod, hourlyPeriods, enrichedSupplemental, observation);
    const supplementalUpdatePromise = this.getSupplementalDashboardUpdate(location, currentPeriod, dailyPeriods, observation, precipitation, enrichedSupplemental, spcOutlooksPromise);
    const dailyOutlookPromise = spcOutlooksPromise
      .then((spcOutlooks) => this.mapDaily(dailyPeriods, { ...enrichedSupplemental, spcOutlooks: spcOutlooks || [] }))
      .catch((error) => {
        console.warn("SPC outlooks unavailable.", error);
        return null;
      });

    return {
      location: { city: location.label },
      current,
      summaryStats: this.mapSummaryStats(current, currentPeriod, observation, precipitation, null, enrichedSupplemental),
      narrative: this.mapNarrative(currentPeriod, dailyPeriods),
      precipitation,
      details: this.mapDetails(currentPeriod, observation, precipitation, enrichedSupplemental),
      alert: this.mapAlert(alerts || { features: [] }),
      hourly: this.mapHourly(hourlyPeriods, enrichedSupplemental),
      daily: this.mapDaily(dailyPeriods, enrichedSupplemental),
      dailyOutlookPromise,
      supplementalUpdatePromise
    };
  }

  async getFallbackWeather(location) {
    const spcOutlooksPromise = this.getSpcOutlooks(location);
    const [supplemental] = (await Promise.allSettled([
      this.withTimeout(this.getSupplementalWeather(location), 9000, "supplemental weather")
    ])).map((result) => this.settledValue(result));
    if (!supplemental) throw new Error("Supplemental weather unavailable.");

    const currentPeriod = this.periodFromSupplemental(supplemental);
    const hourlyPeriods = [currentPeriod, this.periodFromSupplemental(supplemental, 1)];
    const forecastPeriods = this.dailyPeriodsFromSupplemental(supplemental);
    const pressureTrend = this.pressureTrendFromHistory(location, null, supplemental);
    const basePollen = this.getPollenData(location, supplemental, { currentPeriod, dailyPeriods: forecastPeriods });
    const enrichedSupplemental = {
      ...supplemental,
      pressureTrend,
      airQualityLabel: "Checking",
      dailyAirQuality: [],
      alertHazards: [],
      spcOutlooks: [],
      pollen: {
        ...basePollen,
        health: this.mapHealthRisks({ ...supplemental, pollen: basePollen }, null)
      }
    };
    const current = this.mapCurrent(currentPeriod, forecastPeriods, hourlyPeriods, null, enrichedSupplemental);
    const precipitation = this.mapPrecipitation(currentPeriod, hourlyPeriods, enrichedSupplemental, null);
    const supplementalUpdatePromise = this.getSupplementalDashboardUpdate(location, currentPeriod, forecastPeriods, null, precipitation, enrichedSupplemental, spcOutlooksPromise);
    const dailyOutlookPromise = spcOutlooksPromise
      .then((spcOutlooks) => this.mapDaily(forecastPeriods, { ...enrichedSupplemental, spcOutlooks: spcOutlooks || [] }))
      .catch((error) => {
        console.warn("SPC outlooks unavailable.", error);
        return null;
      });

    return {
      location: { city: location.label },
      current,
      summaryStats: this.mapSummaryStats(current, currentPeriod, null, precipitation, null, enrichedSupplemental),
      narrative: "Weather conditions are shown from the backup forecast source.",
      precipitation,
      details: this.mapDetails(currentPeriod, null, precipitation, enrichedSupplemental),
      alert: null,
      hourly: this.mapHourly(hourlyPeriods, enrichedSupplemental),
      daily: this.mapDaily(forecastPeriods, enrichedSupplemental),
      dailyOutlookPromise,
      supplementalUpdatePromise
    };
  }

  settledValue(result) {
    if (result.status === "fulfilled") return result.value;
    console.warn("Weather request skipped.", result.reason);
    return null;
  }

  withTimeout(promise, timeoutMs, label = "weather request") {
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = window.setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    });
    return Promise.race([promise, timeout])
      .finally(() => window.clearTimeout(timeoutId));
  }

  async resolveLocation(input) {
    const query = input.trim();
    if (!query) return DEFAULT_LOCATION;
    if (/^\d{5}$/.test(query)) return this.resolveZip(query);
    return this.resolvePlace(query);
  }

  async getAirQuality(location) {
    const airNow = await this.getAirNowQuality(location);
    const openMeteo = await this.getOpenMeteoAirQuality(location);
    if (airNow) {
      return {
        ...airNow,
        dailyAirQuality: openMeteo?.dailyAirQuality || []
      };
    }
    return openMeteo;
  }

  async getSpcOutlooks(location) {
    if (!Number.isFinite(Number(location?.lat)) || !Number.isFinite(Number(location?.lon))) return [];
    const layers = [
      { dayOffset: 0, layerId: 1, type: "categorical" },
      { dayOffset: 0, layerId: 3, type: "probability" },
      { dayOffset: 0, layerId: 5, type: "probability" },
      { dayOffset: 0, layerId: 7, type: "probability" },
      { dayOffset: 1, layerId: 9, type: "categorical" },
      { dayOffset: 1, layerId: 11, type: "probability" },
      { dayOffset: 1, layerId: 13, type: "probability" },
      { dayOffset: 1, layerId: 15, type: "probability" },
      { dayOffset: 2, layerId: 17, type: "categorical" },
      { dayOffset: 2, layerId: 19, type: "probability" },
      { dayOffset: 3, layerId: 21, type: "probability" },
      { dayOffset: 4, layerId: 22, type: "probability" },
      { dayOffset: 5, layerId: 23, type: "probability" },
      { dayOffset: 6, layerId: 24, type: "probability" },
      { dayOffset: 7, layerId: 25, type: "probability" }
    ];
    const results = await Promise.allSettled(layers.map(async (layer) => {
      const data = await this.fetchJson(spcOutlookUrl(layer.layerId, location));
      return this.mapSpcLayer(layer, data);
    }));
    return results
      .flatMap((result) => result.status === "fulfilled" ? result.value : [])
      .filter(Boolean)
      .reduce((items, outlook) => this.mergeSpcOutlook(items, outlook), []);
  }

  mapSpcLayer(layer, data) {
    const features = Array.isArray(data?.features) ? data.features : [];
    return features
      .map((feature) => this.spcOutlookFromAttributes(layer, feature.attributes || {}))
      .filter(Boolean);
  }

  spcOutlookFromAttributes(layer, attributes) {
    const dn = this.numberOrNull(attributes.dn);
    if (dn === null) return null;
    const label = String(attributes.label2 || attributes.label || `${dn}`).trim();
    const level = layer.type === "categorical"
      ? this.spcCategoricalLevel(dn, label)
      : this.spcProbabilityLevel(dn, layer.dayOffset);
    if (!level) return null;
    return {
      dayOffset: layer.dayOffset,
      level,
      source: label || `SPC ${dn}`,
      rank: level === "alert" ? 3 : level === "impact" ? 2 : 1
    };
  }

  spcCategoricalLevel(dn, label) {
    const value = String(label || "").toLowerCase();
    if (dn >= 4 || /enhanced|moderate|high/.test(value)) return "alert";
    if (dn >= 3 || /slight/.test(value)) return "impact";
    if (dn === 2 || /marginal/.test(value)) return "marginal";
    return "";
  }

  spcProbabilityLevel(dn, dayOffset) {
    if (dn >= 30) return "alert";
    if (dn >= 15) return "impact";
    return "";
  }

  mergeSpcOutlook(items, outlook) {
    const existingIndex = items.findIndex((item) => item.dayOffset === outlook.dayOffset);
    if (existingIndex === -1) return [...items, outlook];
    if (outlook.rank <= items[existingIndex].rank) return items;
    const next = [...items];
    next[existingIndex] = outlook;
    return next;
  }

  async getAirNowQuality(location) {
    const apiKey = localStorage.getItem(AIRNOW_KEY_STORAGE_KEY);
    if (!apiKey) return this.getPublicAirNowQuality(location);

    try {
      const data = await this.fetchJson(airNowUrl(location, apiKey));
      const bestReading = Array.isArray(data)
        ? data.filter((item) => Number.isFinite(Number(item.AQI))).sort((a, b) => Number(b.AQI) - Number(a.AQI))[0]
        : null;
      if (!bestReading) return null;
      const value = Math.round(Number(bestReading.AQI));
      return {
        value,
        category: bestReading.Category?.Name || this.airQualityCategory(value),
        tone: this.airQualityTone(value),
        source: "AirNow"
      };
    } catch (error) {
      console.warn("AirNow air quality unavailable.", error);
      return this.getPublicAirNowQuality(location);
    }
  }

  async getPublicAirNowQuality(location) {
    try {
      const data = await this.fetchJson(airNowCurrentSitesUrl(location));
      const features = Array.isArray(data.features) ? data.features : [];
      const readings = features
        .map((feature) => this.publicAirNowReading(feature.attributes, location))
        .filter(Boolean)
        .sort((a, b) => a.distance - b.distance || b.value - a.value);
      return readings[0] || null;
    } catch (error) {
      console.warn("Public AirNow monitor data unavailable.", error);
      return null;
    }
  }

  publicAirNowReading(attributes = {}, location) {
    const value = this.firstNumber(
      attributes.OZONEPM_AQI,
      attributes.OZONEPM_AQI_SORT,
      attributes.PM_AQI,
      attributes.PM25_AQI,
      attributes.OZONE_AQI
    );
    if (value === null || value < 0) return null;
    const lat = this.numberOrNull(attributes.Latitude);
    const lon = this.numberOrNull(attributes.Longitude);
    return {
      value: Math.round(value),
      category: this.airQualityCategory(value),
      tone: this.airQualityTone(value),
      source: "AirNow",
      siteName: attributes.SiteName || "",
      distance: lat === null || lon === null ? Number.POSITIVE_INFINITY : this.distanceMiles(location.lat, location.lon, lat, lon)
    };
  }

  async getOpenMeteoAirQuality(location) {
    try {
      const data = await this.getOpenMeteoAirQualityPayload(location);
      const value = Math.round(data.current?.us_aqi);
      if (!Number.isFinite(value)) return null;
      return {
        value,
        category: this.airQualityCategory(value),
        tone: this.airQualityTone(value),
        dailyAirQuality: this.dailyAirQualityFromHourly(data.hourly),
        source: "Open-Meteo"
      };
    } catch (error) {
      console.warn("Open-Meteo air quality unavailable.", error);
      return null;
    }
  }

  async getSupplementalWeather(location) {
    const [uvIndexResult, openMeteoResult] = await Promise.allSettled([
      this.withTimeout(this.getUvIndex(location), 6000, "UV index"),
      this.withTimeout(this.getOpenMeteoWeather(location), 9000, "Open-Meteo weather")
    ]);
    const uvIndex = this.settledValue(uvIndexResult);
    const openMeteo = this.settledValue(openMeteoResult);

    return {
      ...openMeteo,
      uvIndex: uvIndex ?? openMeteo?.uvIndex ?? null,
      sunrise: openMeteo?.sunrise || null,
      sunset: openMeteo?.sunset || null
    };
  }

  async getSupplementalDashboardUpdate(location, currentPeriod, dailyPeriods, observation, precipitation, baseSupplemental, spcOutlooksPromise = null) {
    const startDate = this.firstDailyForecastDate(dailyPeriods);
    const [airQualityResult, atmosporePollenResult] = await Promise.allSettled([
      this.withTimeout(this.getAirQuality(location), 5000, "air quality"),
      this.getAtmosporePollen(location, { startDate, forecastDays: 7 })
    ]);
    const airQuality = this.settledValue(airQualityResult);
    const providerPollen = this.settledValue(atmosporePollenResult);
    const spcOutlooks = spcOutlooksPromise
      ? await spcOutlooksPromise.catch((error) => {
        console.warn("SPC outlooks unavailable.", error);
        return [];
      })
      : (baseSupplemental?.spcOutlooks || []);
    const fallbackPollen = baseSupplemental?.pollen || this.getPollenData(location, baseSupplemental, { currentPeriod, dailyPeriods, observation });
    const pollen = this.mergeAtmosporePollen(fallbackPollen, providerPollen);
    const dailyPollenByDate = this.buildDailyPollenByDate(location, dailyPeriods, baseSupplemental, providerPollen, airQuality);
    const updatedSupplemental = {
      ...baseSupplemental,
      airQualityLabel: airQuality ? `${airQuality.value} ${airQuality.category}` : baseSupplemental.airQualityLabel,
      dailyAirQuality: airQuality?.dailyAirQuality || baseSupplemental.dailyAirQuality || [],
      dailyPollenByDate,
      spcOutlooks,
      pollen: {
        ...pollen,
        health: this.mapHealthRisks({ ...baseSupplemental, pollen }, airQuality)
      }
    };
    return {
      details: this.mapDetails(currentPeriod, observation, precipitation, updatedSupplemental),
      daily: this.mapDaily(dailyPeriods, updatedSupplemental)
    };
  }

  async getOpenMeteoAirQualityPayload(location) {
    const key = `${location.lat},${location.lon}`;
    if (!this.pendingAirQualityPayloads.has(key)) {
      const request = this.fetchJson(airQualityUrl(location), { timeoutMs: 10000 })
        .finally(() => this.pendingAirQualityPayloads.delete(key));
      this.pendingAirQualityPayloads.set(key, request);
    }
    return this.pendingAirQualityPayloads.get(key);
  }

  getPollenData(location, weather = {}, context = {}) {
    return this.calculateAllergyRisk(location, weather, context);
  }

  async getAtmosporePollen(location, options = {}) {
    const client = globalThis.SkyStationAtmosporeClient;
    const lat = this.numberOrNull(location?.lat);
    const lon = this.numberOrNull(location?.lon);
    if (!client?.getPollenData || lat === null || lon === null) return null;
    const startDate = /^\d{4}-\d{2}-\d{2}$/.test(String(options?.startDate || "")) ? options.startDate : "";
    const forecastDays = Math.max(1, Math.min(7, Math.round(Number(options?.forecastDays) || 7)));
    const key = `${lat},${lon},${startDate},${forecastDays}`;
    if (!this.pendingAtmosporePollenPayloads.has(key)) {
      const request = client.getPollenData({ lat, lon }, { startDate, forecastDays })
        .catch((error) => {
          console.debug("Atmospore pollen update skipped.", error);
          return null;
        })
        .finally(() => this.pendingAtmosporePollenPayloads.delete(key));
      this.pendingAtmosporePollenPayloads.set(key, request);
    }
    return this.pendingAtmosporePollenPayloads.get(key);
  }

  atmosporeScore(level) {
    // Existing grouped health scoring consumes a 0-100 pollen severity; provider risk text remains unchanged for display.
    return { Low: 10, Moderate: 35, High: 60, "Very High": 85 }[level] ?? 0;
  }

  mergeAtmosporePollen(fallback, providerData) {
    const baseline = fallback && Array.isArray(fallback.details) ? fallback : this.emptyPollen();
    if (!providerData?.categories) return baseline;
    const categoryLabels = {
      tree: "Tree Allergy Risk",
      grass: "Grass Allergy Risk",
      weed: "Weed Allergy Risk",
      ragweed: "Ragweed Allergy Risk"
    };
    const details = baseline.details.map((detail) => {
      const key = Object.keys(categoryLabels).find((category) => categoryLabels[category] === detail.label);
      const provider = key ? providerData.categories[key] : null;
      if (!provider?.riskLevel) return detail;
      return {
        ...detail,
        value: null,
        score: this.atmosporeScore(provider.riskLevel),
        category: provider.riskLevel,
        source: "atmospore",
        sourceName: "Atmospore",
        concentration: provider.value,
        units: providerData.units || null,
        providerRisk: provider.riskLevel,
        topSpecies: provider.topSpecies,
        topSpeciesId: provider.topSpeciesId,
        speciesCount: provider.speciesCount,
        activeSpeciesCount: provider.activeSpeciesCount,
        elevatedSpeciesCount: provider.elevatedSpeciesCount,
        activeSpecies: provider.activeSpecies,
        elevatedSpecies: provider.elevatedSpecies,
        description: "Atmospore pollen forecast data."
      };
    });
    const majorRisks = details.filter((item) => item.label !== "Outdoor Dust Risk");
    const dominant = majorRisks.slice().sort((a, b) => (b.score || 0) - (a.score || 0))[0] || details[0];
    const peak = Math.max(...majorRisks.map((item) => item.score || 0), 0);
    const usesAtmospore = details.some((item) => item.source === "atmospore");
    return {
      ...baseline,
      value: peak,
      category: this.allergyRiskLevel(peak),
      overall: { score: peak, level: this.allergyRiskLevel(peak) },
      dominantAllergen: dominant?.label || "",
      source: usesAtmospore ? "Mixed Atmospore and SkyStation Allergy Risk" : baseline.source,
      sourceName: usesAtmospore ? "Atmospore with SkyStation fallback" : baseline.sourceName,
      measured: false,
      estimated: true,
      updatedAt: providerData.generatedAt || baseline.updatedAt,
      note: usesAtmospore
        ? "Pollen risk uses Atmospore forecast data when available, with local weather-based estimates as fallback. Mold and dust are estimated from local weather conditions."
        : baseline.note,
      details
    };
  }

  firstDailyForecastDate(periods = []) {
    const daytime = Array.isArray(periods) ? periods.find((period) => period?.isDaytime) : null;
    return this.dateKey(daytime?.startTime || periods?.[0]?.startTime);
  }

  buildDailyPollenByDate(location, periods, supplemental, providerData, airQuality) {
    if (!Array.isArray(periods)) return {};
    const days = {};

    periods.forEach((dayPeriod, index) => {
      if (!dayPeriod?.isDaytime) return;
      const date = this.dateKey(dayPeriod.startTime);
      if (!date || days[date]) return;

      const dailyIndex = this.dailyIndexForStart(dayPeriod.startTime, supplemental, index);
      const nightPeriod = periods.slice(index + 1).find((period) => !period?.isDaytime) || null;
      const weather = this.dailyAllergyWeather(dayPeriod, nightPeriod, supplemental, dailyIndex);
      const context = {
        date,
        currentPeriod: dayPeriod,
        dailyPeriods: [dayPeriod, nightPeriod].filter(Boolean)
      };
      const baseline = this.getPollenData(location, weather, context);
      const pollen = this.mergeAtmosporePollen(baseline, providerData?.days?.[date]);
      days[date] = {
        ...pollen,
        health: this.mapHealthRisks({ ...weather, pollen }, airQuality)
      };
    });

    return days;
  }

  dailyAllergyWeather(dayPeriod, nightPeriod, supplemental, dayIndex) {
    const forecastText = `${dayPeriod?.shortForecast || ""} ${dayPeriod?.detailedForecast || ""} ${nightPeriod?.shortForecast || ""} ${nightPeriod?.detailedForecast || ""}`;
    const precipitationAmount = this.firstNumber(
      supplemental?.dailyGridPrecipAmounts?.[dayIndex],
      supplemental?.dailyPrecipAmounts?.[dayIndex]
    ) || 0;
    const pressure = this.firstNumber(supplemental?.dailyPressure?.[dayIndex], supplemental?.pressure);
    const previousPressure = this.firstNumber(supplemental?.dailyPressure?.[Math.max(0, dayIndex - 1)], supplemental?.pressure);
    return {
      temperature: dayPeriod?.temperature,
      high: dayPeriod?.temperature ?? supplemental?.dailyHighs?.[dayIndex],
      low: nightPeriod?.temperature ?? supplemental?.dailyLows?.[dayIndex],
      humidity: this.firstNumber(supplemental?.dailyHumidity?.[dayIndex], supplemental?.humidity),
      dewPoint: this.firstNumber(supplemental?.dailyDewPoints?.[dayIndex], supplemental?.dewPoint),
      windSpeed: this.firstNumber(supplemental?.dailyWindSpeeds?.[dayIndex], this.mphFromText(dayPeriod?.windSpeed)),
      windGusts: this.firstNumber(supplemental?.dailyWindGusts?.[dayIndex], this.mphFromText(forecastText)),
      gridPrecipChance: this.firstNumber(supplemental?.dailyGridPrecipChances?.[dayIndex]),
      precipitationAmount,
      cloudCover: this.firstNumber(supplemental?.dailyCloudCover?.[dayIndex], supplemental?.dailyGridCloudCover?.[dayIndex], supplemental?.cloudCover),
      pressure,
      pressureTrend: this.pressureTrend(pressure, previousPressure),
      uvIndex: this.firstNumber(supplemental?.dailyUvIndexes?.[dayIndex], supplemental?.dailyHourlyUvIndexes?.[dayIndex], supplemental?.uvIndex)
    };
  }

  calculateAllergyRisk(location, weather = {}, context = {}) {
    const inputs = this.allergyWeatherInputs(location, weather, context);
    const details = [
      this.allergyRiskDetail("Tree Allergy Risk", this.seasonalPollenRisk("tree", inputs)),
      this.allergyRiskDetail("Grass Allergy Risk", this.seasonalPollenRisk("grass", inputs)),
      this.allergyRiskDetail("Weed Allergy Risk", this.seasonalPollenRisk("weed", inputs)),
      this.allergyRiskDetail("Ragweed Allergy Risk", this.seasonalPollenRisk("ragweed", inputs)),
      this.allergyRiskDetail("Outdoor Mold Risk", this.outdoorMoldRisk(inputs)),
      this.allergyRiskDetail("Outdoor Dust Risk", this.outdoorDustRisk(inputs), "aqi.svg")
    ];
    const majorRisks = details.filter((item) => item.label !== "Outdoor Dust Risk");
    const dominant = majorRisks.slice().sort((a, b) => (b.score || 0) - (a.score || 0))[0] || details[0];
    const peak = Math.max(...majorRisks.map((item) => item.score || 0), 0);
    return {
      value: peak,
      category: this.allergyRiskLevel(peak),
      overall: { score: peak, level: this.allergyRiskLevel(peak) },
      dominantAllergen: dominant?.label || "",
      source: "SkyStation Allergy Risk",
      sourceName: "SkyStation Allergy Risk",
      measured: false,
      estimated: true,
      updatedAt: new Date().toISOString(),
      reason: this.allergyRiskReason(dominant, inputs),
      note: "Estimated from season and local weather conditions. This is an estimated outdoor allergy outlook, not a measured pollen count.",
      details
    };
  }

  allergyWeatherInputs(location = {}, weather = {}, context = {}) {
    const period = context?.currentPeriod || {};
    const daily = Array.isArray(context?.dailyPeriods) ? context.dailyPeriods : [];
    const text = `${period.shortForecast || ""} ${period.detailedForecast || ""}`;
    const precipAmount = this.firstNumber(
      weather?.precipitationAmount,
      weather?.rain,
      weather?.showers,
      weather?.snowfall,
      weather?.dailyGridPrecipAmounts?.[0],
      weather?.dailyPrecipAmount
    ) || 0;
    const date = context?.date ? new Date(context.date) : new Date();
    return {
      date,
      dayOfYear: this.dayOfYear(date),
      latitude: this.numberOrNull(location?.lat) ?? DEFAULT_LOCATION.lat,
      temperature: this.firstNumber(weather?.temperature, period.temperature, daily?.[0]?.temperature) ?? 60,
      high: this.firstNumber(weather?.high, daily?.[0]?.temperature, period.temperature) ?? 60,
      low: this.firstNumber(weather?.low, daily?.[1]?.temperature, weather?.temperature) ?? 50,
      humidity: this.numberOrNull(weather?.humidity) ?? 50,
      dewPoint: this.numberOrNull(weather?.dewPoint) ?? 50,
      windSpeed: this.firstNumber(weather?.windSpeed, this.mphFromText(period.windSpeed)) || 0,
      windGust: this.firstNumber(weather?.windGusts, this.mphFromText(text)) || 0,
      precipChance: this.firstNumber(weather?.gridPrecipChance, weather?.precipChance) || 0,
      precipAmount,
      cloudCover: this.firstNumber(weather?.cloudCover, weather?.gridCloudCover) ?? 40,
      conditionText: text
    };
  }

  seasonalPollenRisk(type, inputs) {
    const season = this.smoothSeasonScore(inputs.dayOfYear, this.allergySeasonWindow(type, inputs.latitude), 38);
    const stage = this.seasonalActivityStage(season);
    const activePrecip = this.isPrecipCondition(inputs.conditionText) || inputs.precipAmount >= 0.01;
    const freezing = inputs.temperature <= 32 || inputs.low <= 28 || /snow|sleet|ice|freez/i.test(inputs.conditionText);
    const temperature = this.pollenTemperatureComponent(inputs.temperature);
    const moisture = this.pollenMoistureComponent(inputs.humidity, inputs.precipAmount, activePrecip);
    const wind = this.pollenWindComponent(inputs.windSpeed, inputs.windGust);
    const exceptional = this.pollenExceptionalComponent(stage, inputs, activePrecip);
    let rainSuppression = 0;
    if (inputs.precipAmount >= 0.25) rainSuppression = -28;
    else if (inputs.precipAmount >= 0.1) rainSuppression = -22;
    else if (inputs.precipAmount >= 0.03) rainSuppression = -14;
    else if (inputs.precipAmount >= 0.005 || activePrecip) rainSuppression = -8;
    let score = season + temperature + moisture + wind + exceptional + rainSuppression;
    if (freezing) score = Math.min(score * 0.35, 18);
    score = Math.min(score, this.pollenSeasonCap(stage, inputs.precipAmount, activePrecip));
    score = Math.round(this.clamp(score, 0, 100));
    return {
      score,
      components: {
        season: Math.round(season),
        temperature,
        moisture,
        wind,
        exceptional,
        rainSuppression,
        cap: this.pollenSeasonCap(stage, inputs.precipAmount, activePrecip),
        stage
      }
    };
  }

  outdoorMoldRisk(inputs) {
    const day = inputs.dayOfYear;
    const season = day >= 100 && day <= 325 ? (day >= 225 && day <= 315 ? 28 : 18) : 6;
    const moisture = inputs.precipAmount >= 0.1
      ? 18
      : inputs.precipAmount >= 0.02 || this.isPrecipCondition(inputs.conditionText)
        ? 12
        : inputs.humidity >= 85 && inputs.dewPoint >= 68
          ? 10
          : inputs.humidity >= 75
            ? 6
            : 0;
    const humidity = inputs.humidity >= 90 && inputs.dewPoint >= 70 ? 12 : inputs.humidity >= 80 && inputs.dewPoint >= 65 ? 8 : 0;
    const temperature = inputs.temperature >= 60 && inputs.temperature <= 85 ? 8 : inputs.temperature >= 50 && inputs.temperature <= 90 ? 4 : 0;
    const dampPattern = moisture >= 12 && inputs.cloudCover >= 70 ? 8 : 0;
    const coldSuppression = inputs.temperature <= 32 || inputs.low <= 28 ? -24 : 0;
    const score = Math.round(this.clamp(season + moisture + humidity + temperature + dampPattern + coldSuppression, 0, 100));
    return {
      score,
      components: { season, moisture, humidity, temperature, dampPattern, coldSuppression }
    };
  }

  outdoorDustRisk(inputs) {
    const base = 10;
    const dryness = inputs.humidity < 25 ? 18 : inputs.humidity < 35 ? 12 : inputs.humidity < 45 ? 6 : 0;
    const wind = inputs.windSpeed >= 20 ? 20 : inputs.windSpeed >= 12 ? 14 : inputs.windSpeed >= 7 ? 8 : 0;
    const gust = inputs.windGust >= 30 ? 7 : inputs.windGust >= 22 ? 4 : 0;
    const rainSuppression = inputs.precipAmount >= 0.1 ? -28 : inputs.precipAmount >= 0.03 || this.isPrecipCondition(inputs.conditionText) ? -18 : 0;
    const score = Math.round(this.clamp(base + dryness + wind + gust + rainSuppression, 0, 100));
    return {
      score,
      components: { base, dryness, wind, gust, rainSuppression }
    };
  }

  allergyRiskDetail(label, risk, icon = "pollen.svg") {
    const score = typeof risk === "object" ? risk.score : risk;
    return {
      label,
      value: null,
      score: Math.round(score),
      category: this.allergyRiskLevel(score),
      icon,
      source: "calculated",
      sourceName: "SkyStation Allergy Risk",
      concentration: null,
      units: null,
      providerRisk: null,
      topSpecies: null,
      activeSpecies: [],
      elevatedSpecies: [],
      components: typeof risk === "object" ? risk.components : {},
      description: "Estimated from season and local weather conditions."
    };
  }

  seasonalActivityStage(seasonScore) {
    if (seasonScore >= 34) return "peak";
    if (seasonScore >= 24) return "active";
    if (seasonScore >= 10) return "shoulder";
    return "out";
  }

  pollenSeasonCap(stage, precipAmount, activePrecip) {
    if (precipAmount >= 0.25) return 35;
    if (precipAmount >= 0.1) return 42;
    if (activePrecip || precipAmount >= 0.03) return stage === "peak" ? 52 : 45;
    if (stage === "peak") return 82;
    if (stage === "active") return 62;
    if (stage === "shoulder") return 40;
    return 18;
  }

  pollenTemperatureComponent(temp) {
    if (temp >= 60 && temp <= 82) return 8;
    if (temp > 82 && temp <= 95) return 5;
    if (temp >= 50 && temp < 60) return 3;
    if (temp < 45) return -6;
    return 0;
  }

  pollenMoistureComponent(humidity, precipAmount, activePrecip) {
    if (activePrecip || precipAmount >= 0.005) return 0;
    if (humidity >= 35 && humidity <= 60) return 8;
    if (humidity < 35) return 5;
    if (humidity > 80) return -3;
    return 3;
  }

  pollenWindComponent(speed, gust) {
    if (speed >= 7 && speed <= 16) return gust >= 22 ? 12 : 10;
    if (speed >= 3 && speed < 7) return 5;
    if (speed > 16 && speed <= 25) return 7;
    if (speed > 25) return 2;
    return 0;
  }

  pollenExceptionalComponent(stage, inputs, activePrecip) {
    if (stage !== "peak" || activePrecip || inputs.precipAmount >= 0.03) return 0;
    const warmDryBreezy = inputs.temperature >= 65 && inputs.temperature <= 92
      && inputs.humidity >= 30 && inputs.humidity <= 62
      && inputs.windSpeed >= 7 && inputs.windSpeed <= 18;
    if (!warmDryBreezy) return 0;
    return inputs.windGust >= 22 ? 14 : 10;
  }

  allergyRiskLevel(score) {
    const value = this.numberOrNull(score) || 0;
    if (value >= 75) return "Very High";
    if (value >= 50) return "High";
    if (value >= 25) return "Moderate";
    return "Low";
  }

  allergyRiskReason(dominant, inputs) {
    if (!dominant || (dominant.score || 0) < 25) {
      return "Outdoor allergy risk is estimated to be low from current season and local weather conditions.";
    }
    if (/mold/i.test(dominant.label)) {
      return "Outdoor mold risk is elevated by humid conditions, recent or expected precipitation, and seasonal warmth.";
    }
    if (/dust/i.test(dominant.label)) {
      return "Outdoor dust risk is elevated by dry air and wind.";
    }
    if (inputs.precipAmount >= 0.03 || this.isPrecipCondition(inputs.conditionText)) {
      return `${dominant.label} is the leading allergy risk, though rain may reduce airborne pollen at times.`;
    }
    if (inputs.windSpeed >= 8 || inputs.windGust >= 18) {
      return `${dominant.label} is elevated, and breezy weather may help allergens spread.`;
    }
    return `${dominant.label} is elevated based on the local season and current weather pattern.`;
  }

  allergySeasonWindow(type, latitude) {
    const band = this.latitudeBand(latitude);
    const windows = {
      south: {
        tree: [25, 55, 105, 150],
        grass: [75, 105, 170, 240],
        weed: [155, 220, 285, 335],
        ragweed: [190, 230, 290, 330]
      },
      midSouth: {
        tree: [40, 70, 115, 155],
        grass: [95, 130, 180, 235],
        weed: [170, 225, 280, 320],
        ragweed: [200, 235, 285, 315]
      },
      central: {
        tree: [60, 95, 125, 165],
        grass: [120, 140, 180, 220],
        weed: [185, 230, 275, 305],
        ragweed: [210, 240, 280, 305]
      },
      north: {
        tree: [80, 110, 145, 175],
        grass: [135, 165, 205, 245],
        weed: [195, 235, 265, 295],
        ragweed: [220, 245, 270, 295]
      },
      farNorth: {
        tree: [95, 125, 155, 185],
        grass: [150, 170, 210, 245],
        weed: [205, 235, 260, 285],
        ragweed: [230, 250, 265, 285]
      }
    };
    return windows[band]?.[type] || windows.central[type];
  }

  latitudeBand(latitude) {
    const lat = this.numberOrNull(latitude) ?? DEFAULT_LOCATION.lat;
    if (lat < 32) return "south";
    if (lat < 37) return "midSouth";
    if (lat < 42) return "central";
    if (lat < 47) return "north";
    return "farNorth";
  }

  smoothSeasonScore(day, window, peak = 68) {
    const [start, peakStart, peakEnd, end] = window;
    if (!Number.isFinite(day) || day < start || day > end) return 0;
    if (day >= peakStart && day <= peakEnd) return peak;
    const smooth = (value) => value * value * (3 - 2 * value);
    if (day < peakStart) return peak * smooth((day - start) / Math.max(1, peakStart - start));
    return peak * (1 - smooth((day - peakEnd) / Math.max(1, end - peakEnd)));
  }

  dayOfYear(date = new Date()) {
    const start = new Date(date.getFullYear(), 0, 0);
    return Math.floor((date - start) / 86400000);
  }

  windAllergyModifier(windSpeed, windGust) {
    const speed = this.numberOrNull(windSpeed) || 0;
    const gust = this.numberOrNull(windGust) || 0;
    let score = 0;
    if (speed >= 3 && speed < 6) score += 3;
    else if (speed >= 6 && speed <= 15) score += 10;
    else if (speed > 15 && speed <= 25) score += 6;
    else if (speed > 25) score += 2;
    if (gust >= 25) score += 3;
    else if (gust >= 18) score += 2;
    return score;
  }

  isPrecipCondition(text = "") {
    return /rain|showers|thunderstorm|snow|sleet|drizzle|freezing rain/i.test(String(text));
  }

  mphFromText(text = "") {
    const values = [...String(text).matchAll(/(\d+(?:\.\d+)?)\s*mph/gi)]
      .map((match) => this.numberOrNull(match[1]))
      .filter((value) => value !== null);
    return values.length ? Math.max(...values) : null;
  }

  clamp(value, min, max) {
    return Math.min(max, Math.max(min, Number(value) || 0));
  }

  async getUvIndex(location) {
    const epaUv = await this.getEpaUvIndex(location);
    if (epaUv !== null) return epaUv;
    return null;
  }

  async getEpaUvIndex(location) {
    if (!location.zip && (!location.city || !location.state)) return null;

    try {
      const data = await this.fetchJson(epaUvUrl(location));
      const rows = Array.isArray(data) ? data : data?.Results || [];
      const firstValue = rows.map((row) => Number(row.UV_VALUE ?? row.UV_INDEX ?? row.UVI)).find(Number.isFinite);
      return Number.isFinite(firstValue) ? firstValue : null;
    } catch (error) {
      console.warn("EPA UV unavailable.", error);
      return null;
    }
  }

  async getOpenMeteoWeather(location) {
    try {
      const data = await this.fetchJson(openMeteoForecastUrl(location));
      const current = data.current || {};
      const daily = data.daily || {};
      const hourly = data.hourly || {};
      const dailySupplemental = this.dailyValuesFromHourly(hourly);
      return {
        temperature: this.numberOrNull(current.temperature_2m),
        humidity: this.numberOrNull(current.relative_humidity_2m),
        dewPoint: this.numberOrNull(current.dew_point_2m),
        feelsLike: this.numberOrNull(current.apparent_temperature),
        precipitationAmount: this.numberOrNull(current.precipitation),
        rain: this.numberOrNull(current.rain),
        showers: this.numberOrNull(current.showers),
        snowfall: this.numberOrNull(current.snowfall),
        pressure: this.numberOrNull(current.pressure_msl),
        cloudCover: this.numberOrNull(current.cloud_cover),
        windSpeed: this.numberOrNull(current.wind_speed_10m),
        windDirection: this.numberOrNull(current.wind_direction_10m),
        windGusts: this.numberOrNull(current.wind_gusts_10m),
        precipChance: this.numberOrNull(hourly.precipitation_probability?.[0]),
        hourlyPrecipChances: (hourly.precipitation_probability || []).map((value) => this.numberOrNull(value)),
        hourlyPrecipAmounts: (hourly.precipitation || []).map((value) => this.numberOrNull(value)),
        minutelyPrecipChances: (data.minutely_15?.precipitation_probability || []).map((value) => this.numberOrNull(value)),
        minutelyPrecipAmounts: (data.minutely_15?.precipitation || []).map((value) => this.numberOrNull(value)),
        minutelyRain: (data.minutely_15?.rain || []).map((value) => this.numberOrNull(value)),
        minutelyShowers: (data.minutely_15?.showers || []).map((value) => this.numberOrNull(value)),
        minutelySnowfall: (data.minutely_15?.snowfall || []).map((value) => this.numberOrNull(value)),
        hourlyHumidity: (hourly.relative_humidity_2m || []).map((value) => this.numberOrNull(value)),
        hourlyDewPoints: (hourly.dew_point_2m || []).map((value) => this.numberOrNull(value)),
        hourlyWindSpeeds: (hourly.wind_speed_10m || []).map((value) => this.numberOrNull(value)),
        hourlyWindDirections: (hourly.wind_direction_10m || []).map((value) => this.numberOrNull(value)),
        hourlyWindGusts: (hourly.wind_gusts_10m || []).map((value) => this.numberOrNull(value)),
        hourlyUvIndexes: (hourly.uv_index || []).map((value) => this.numberOrNull(value)),
        visibility: this.numberOrNull(hourly.visibility?.[0]),
        high: this.numberOrNull(daily.temperature_2m_max?.[0]),
        low: this.numberOrNull(daily.temperature_2m_min?.[0]),
        dailyPrecipAmount: this.numberOrNull(daily.precipitation_sum?.[0]),
        dailyPrecipAmounts: (daily.precipitation_sum || []).map((value) => this.numberOrNull(value)),
        dailySnowfallAmounts: (daily.snowfall_sum || []).map((value) => this.numberOrNull(value)),
        dailyHighs: (daily.temperature_2m_max || []).map((value) => this.numberOrNull(value)),
        dailyLows: (daily.temperature_2m_min || []).map((value) => this.numberOrNull(value)),
        dailyDates: Array.isArray(daily.time) && daily.time.length ? daily.time : dailySupplemental.dates,
        dailyUvIndexes: (daily.uv_index_max || []).map((value) => this.numberOrNull(value)),
        dailyHumidity: dailySupplemental.humidity,
        dailyDewPoints: dailySupplemental.dewPoints,
        dailyWindSpeeds: dailySupplemental.windSpeeds,
        dailyWindDirections: dailySupplemental.windDirections,
        dailyWindGusts: dailySupplemental.windGusts,
        dailyHourlyUvIndexes: dailySupplemental.uvIndexes,
        dailyCloudCover: dailySupplemental.cloudCover,
        dailyPressure: dailySupplemental.pressure,
        dailyVisibility: dailySupplemental.visibility,
        dailySunrise: (daily.sunrise || []).map((value) => this.formatSunTime(value)),
        dailySunset: (daily.sunset || []).map((value) => this.formatSunTime(value)),
        uvIndex: this.numberOrNull(hourly.uv_index?.[0]) ?? this.numberOrNull(daily.uv_index_max?.[0]),
        sunrise: this.formatSunTime(daily.sunrise?.[0]),
        sunset: this.formatSunTime(daily.sunset?.[0])
      };
    } catch (error) {
      console.warn("Open-Meteo supplemental weather unavailable.", error);
      return null;
    }
  }

  dailyValuesFromHourly(hourly = {}) {
    const times = hourly.time || [];
    const groups = new Map();
    times.forEach((time, index) => {
      const key = String(time || "").slice(0, 10);
      if (!key) return;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(index);
    });

    const average = (values) => {
      const valid = values.map((value) => this.numberOrNull(value)).filter(Number.isFinite);
      return valid.length ? valid.reduce((total, value) => total + value, 0) / valid.length : null;
    };
    const maximum = (values) => {
      const valid = values.map((value) => this.numberOrNull(value)).filter(Number.isFinite);
      return valid.length ? Math.max(...valid) : null;
    };

    const valuesFor = (field, indexes) => indexes.map((index) => field?.[index]);
    const humidity = [];
    const dewPoints = [];
    const windSpeeds = [];
    const windDirections = [];
    const windGusts = [];
    const uvIndexes = [];
    const cloudCover = [];
    const pressure = [];
    const visibility = [];
    const dates = [];

    [...groups.entries()].slice(0, 7).forEach(([date, indexes]) => {
      dates.push(date);
      humidity.push(average(valuesFor(hourly.relative_humidity_2m, indexes)));
      dewPoints.push(average(valuesFor(hourly.dew_point_2m, indexes)));
      windSpeeds.push(average(valuesFor(hourly.wind_speed_10m, indexes)));
      windDirections.push(average(valuesFor(hourly.wind_direction_10m, indexes)));
      windGusts.push(maximum(valuesFor(hourly.wind_gusts_10m, indexes)));
      uvIndexes.push(maximum(valuesFor(hourly.uv_index, indexes)));
      cloudCover.push(average(valuesFor(hourly.cloud_cover, indexes)));
      pressure.push(average(valuesFor(hourly.pressure_msl, indexes)));
      visibility.push(average(valuesFor(hourly.visibility, indexes)));
    });

    return { dates, humidity, dewPoints, windSpeeds, windDirections, windGusts, uvIndexes, cloudCover, pressure, visibility };
  }

  mapGridData(gridData) {
    const properties = gridData?.properties || {};
    if (!properties) return {};
    const qpf = this.gridValuesByDay(properties.quantitativePrecipitation?.values, (value) => this.mmToInches(value));
    const pop = this.gridValuesByDay(properties.probabilityOfPrecipitation?.values, (value) => this.numberOrNull(value), "max");
    const skyCover = this.gridValuesByDay(properties.skyCover?.values, (value) => this.numberOrNull(value), "average");
    const currentQpf = qpf[0] ?? null;
    const currentPop = pop[0] ?? null;
    const currentSky = skyCover[0] ?? null;
    return {
      gridPrecipAmount: currentQpf,
      gridPrecipChance: currentPop,
      gridCloudCover: currentSky,
      dailyGridPrecipAmounts: qpf,
      dailyGridPrecipChances: pop,
      dailyGridCloudCover: skyCover
    };
  }

  gridValuesByDay(values = [], mapper, mode = "sum") {
    const byDay = new Map();
    (Array.isArray(values) ? values : []).forEach((item) => {
      const amount = mapper(item?.value);
      if (amount === null || amount === undefined || !Number.isFinite(Number(amount))) return;
      const date = String(item?.validTime || "").slice(0, 10);
      if (!date) return;
      if (!byDay.has(date)) byDay.set(date, []);
      byDay.get(date).push(Number(amount));
    });
    return Array.from(byDay.values()).slice(0, 7).map((dayValues) => {
      if (!dayValues.length) return null;
      if (mode === "max") return Math.max(...dayValues);
      if (mode === "average") return dayValues.reduce((total, value) => total + value, 0) / dayValues.length;
      return dayValues.reduce((total, value) => total + value, 0);
    });
  }

  mmToInches(value) {
    const mm = this.numberOrNull(value);
    return mm === null ? null : mm / 25.4;
  }

  async resolveZip(zip) {
    const data = await this.fetchJson(`https://api.zippopotam.us/us/${zip}`);
    const place = data.places?.[0];
    if (!place) throw new Error("ZIP code not found.");
    const lat = this.numberOrNull(place.latitude);
    const lon = this.numberOrNull(place.longitude);
    if (lat === null || lon === null) throw new Error("ZIP code coordinates unavailable.");
    return {
      label: `${place["place name"]}, ${place["state abbreviation"]}`,
      query: zip,
      zip,
      city: place["place name"],
      state: place["state abbreviation"],
      lat: lat.toFixed(4),
      lon: lon.toFixed(4)
    };
  }

  async resolvePlace(query) {
    const data = await this.fetchJson(`https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=1&countrycodes=us&q=${encodeURIComponent(query)}`);
    const place = data?.[0];
    if (!place) throw new Error("Location not found.");
    const labelParts = place.display_name.split(",").map((part) => part.trim());
    const city = place.address?.city || place.address?.town || place.address?.village || labelParts[0] || query;
    const state = this.stateAbbreviation(place.address?.state || labelParts.find((part) => this.stateAbbreviation(part)));
    const lat = this.numberOrNull(place.lat);
    const lon = this.numberOrNull(place.lon);
    if (lat === null || lon === null) throw new Error("Location coordinates unavailable.");
    return {
      label: state ? `${city}, ${state}` : this.shortLocationLabel(labelParts, query),
      query,
      city,
      state,
      lat: lat.toFixed(4),
      lon: lon.toFixed(4)
    };
  }

  shortLocationLabel(parts, fallback) {
    if (parts.length >= 3) return `${parts[0]}, ${parts[2]}`;
    return fallback;
  }

  stateAbbreviation(value = "") {
    const states = {
      Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA", Colorado: "CO", Connecticut: "CT", Delaware: "DE", Florida: "FL", Georgia: "GA",
      Hawaii: "HI", Idaho: "ID", Illinois: "IL", Indiana: "IN", Iowa: "IA", Kansas: "KS", Kentucky: "KY", Louisiana: "LA", Maine: "ME", Maryland: "MD",
      Massachusetts: "MA", Michigan: "MI", Minnesota: "MN", Mississippi: "MS", Missouri: "MO", Montana: "MT", Nebraska: "NE", Nevada: "NV", "New Hampshire": "NH",
      "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY", "North Carolina": "NC", "North Dakota": "ND", Ohio: "OH", Oklahoma: "OK", Oregon: "OR",
      Pennsylvania: "PA", "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD", Tennessee: "TN", Texas: "TX", Utah: "UT", Vermont: "VT",
      Virginia: "VA", Washington: "WA", "West Virginia": "WV", Wisconsin: "WI", Wyoming: "WY", "District of Columbia": "DC"
    };
    const trimmed = String(value).trim();
    if (/^[A-Z]{2}$/.test(trimmed)) return trimmed;
    return states[trimmed] || "";
  }

  async getLatestObservation(stationsUrl, location) {
    try {
      const stations = await this.fetchJson(stationsUrl);
      const stationItems = (stations.features || [])
        .map((feature) => {
          const station = feature?.properties?.stationIdentifier;
          const [lon, lat] = Array.isArray(feature?.geometry?.coordinates) ? feature.geometry.coordinates : [];
          const distance = Number.isFinite(Number(lat)) && Number.isFinite(Number(lon))
            ? this.distanceMiles(location.lat, location.lon, lat, lon)
            : Number.POSITIVE_INFINITY;
          return station ? { station, distance } : null;
        })
        .filter(Boolean)
        .filter((item) => !Number.isFinite(item.distance) || item.distance <= MAX_NEARBY_PRECIP_STATION_MILES)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 2);
      if (!stationItems.length) return null;
      const observations = await Promise.allSettled(
        stationItems.map(({ station }) => this.fetchJson(`https://api.weather.gov/stations/${station}/observations/latest`))
      );
      const validObservations = observations
        .map((result, index) => result.status === "fulfilled" && result.value ? { ...stationItems[index], observation: result.value } : null)
        .filter(Boolean);
      const primaryObservation = validObservations[0]?.observation || null;
      if (!primaryObservation) return null;
      const localText = this.localObservedConditionText(primaryObservation);
      if (this.isFreshObservation(primaryObservation) && this.isPrecipText(localText)) {
        primaryObservation.properties = {
          ...primaryObservation.properties,
          localPrecipitationText: localText,
          localPrecipitationStation: validObservations[0].station
        };
      }
      const nearbyPrecip = validObservations.slice(1).find(({ observation, distance }) => (
        distance <= MAX_NEARBY_PRECIP_STATION_MILES
        && this.isFreshObservation(observation)
        && this.isPrecipText(this.localObservedConditionText(observation))
      ));
      if (nearbyPrecip) {
        primaryObservation.properties = {
          ...primaryObservation.properties,
          nearbyPrecipitationText: this.localObservedConditionText(nearbyPrecip.observation),
          nearbyPrecipitationStation: nearbyPrecip.station,
          nearbyPrecipitationDistance: nearbyPrecip.distance
        };
      }
      return primaryObservation;
    } catch {
      return null;
    }
  }

  async fetchJson(url, options = {}) {
    const response = await this.fetchWithTimeout(url, {
      headers: { Accept: "application/json, application/geo+json" },
      timeoutMs: options.timeoutMs || 12000
    });
    if (!response.ok) throw new Error(`Weather request failed: ${response.status}`);
    return response.json();
  }

  async fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), options.timeoutMs || 12000);
    try {
      return await fetch(url, {
        headers: options.headers,
        signal: controller.signal
      });
    } finally {
      window.clearTimeout(timeout);
    }
  }

  periodFromSupplemental(supplemental, hourIndex = 0) {
    const chance = this.numberOrNull(supplemental?.hourlyPrecipChances?.[hourIndex]) ?? this.numberOrNull(supplemental?.precipChance) ?? 0;
    const temperature = this.numberOrNull(hourIndex === 0 ? supplemental?.temperature : null) ?? this.numberOrNull(supplemental?.high) ?? this.numberOrNull(supplemental?.low);
    return {
      name: hourIndex === 0 ? "Now" : "Next Hour",
      startTime: new Date(Date.now() + hourIndex * 60 * 60 * 1000).toISOString(),
      isDaytime: true,
      temperature,
      shortForecast: chance >= PRECIP_DISPLAY_THRESHOLD ? "Rain" : "Current conditions",
      detailedForecast: chance >= PRECIP_DISPLAY_THRESHOLD ? `${chance}% chance of precipitation.` : "Current conditions are updating.",
      probabilityOfPrecipitation: { value: chance },
      windDirection: this.windDirectionLabel(supplemental?.windDirection),
      windSpeed: this.numberOrNull(supplemental?.windSpeed) === null ? "" : `${Math.round(supplemental.windSpeed)} mph`
    };
  }

  dailyPeriodsFromSupplemental(supplemental) {
    const highs = supplemental?.dailyHighs || [];
    const lows = supplemental?.dailyLows || [];
    const chances = supplemental?.dailyPrecipChances || [];
    const count = Math.max(highs.length, lows.length, 1);
    const periods = [];
    for (let index = 0; index < count; index += 1) {
      const date = new Date(Date.now() + index * 24 * 60 * 60 * 1000);
      const chance = this.numberOrNull(chances[index]) ?? 0;
      const high = this.numberOrNull(highs[index]) ?? this.numberOrNull(supplemental?.high);
      const low = this.numberOrNull(lows[index]) ?? this.numberOrNull(supplemental?.low) ?? high;
      periods.push({
        name: this.dayTitle(date),
        startTime: date.toISOString(),
        isDaytime: true,
        temperature: high,
        shortForecast: chance >= PRECIP_DISPLAY_THRESHOLD ? "Rain" : "Forecast",
        detailedForecast: chance >= PRECIP_DISPLAY_THRESHOLD ? `${chance}% chance of precipitation.` : "Forecast details are updating.",
        probabilityOfPrecipitation: { value: chance }
      });
      periods.push({
        name: this.nightTitle(date),
        startTime: date.toISOString(),
        isDaytime: false,
        temperature: low,
        shortForecast: chance >= PRECIP_DISPLAY_THRESHOLD ? "Rain" : "Forecast",
        detailedForecast: chance >= PRECIP_DISPLAY_THRESHOLD ? `${chance}% chance of precipitation overnight.` : "Night forecast details are updating.",
        probabilityOfPrecipitation: { value: chance }
      });
    }
    return periods;
  }

  mapCurrent(period, forecastPeriods, hourlyPeriods, observation, supplemental) {
    const observedTemp = this.isFreshObservation(observation)
      ? this.readTemperature(observation?.properties?.temperature?.value)
      : null;
    const temp = this.firstNumber(observedTemp, supplemental?.temperature, period?.temperature);
    const todayHigh = forecastPeriods.find((item) => item.isDaytime)?.temperature ?? supplemental?.high ?? temp;
    const tonightLow = forecastPeriods.find((item) => !item.isDaytime)?.temperature ?? supplemental?.low ?? null;
    const observedHeatIndex = this.readTemperature(observation?.properties?.heatIndex?.value);
    const observedWindChill = this.readTemperature(observation?.properties?.windChill?.value);
    const feelsLike = observedHeatIndex ?? observedWindChill ?? supplemental?.feelsLike ?? temp;
    const observedCondition = this.isFreshObservation(observation) ? this.visibleObservedConditionText(observation) : "";
    const condition = observedCondition || period?.shortForecast || "Current conditions";

    return {
      temperature: temp,
      icon: this.iconForForecast(condition, period?.isDaytime),
      condition,
      feelsLike,
      high: todayHigh,
      low: tonightLow
    };
  }

  mapSummaryStats(current, period, observation, precipitation, airQuality, supplemental) {
    const windValue = this.readObservedWind(observation)
      || this.formatOpenMeteoWind(supplemental)
      || `${period?.windDirection || ""} ${period?.windSpeed || ""}`.trim()
      || "0 mph";
    const precipAmount = this.currentPrecipAmount(period, precipitation, supplemental);

    return [
      { icon: "real-feel.svg", label: "High/Low", value: `${this.formatMaybeTemp(current.high)} / ${this.formatMaybeTemp(current.low)}` },
      { icon: "wind.svg", label: "Wind", value: windValue },
      {
        icon: "rain-chance.svg",
        label: "Precipitation",
        value: this.precipChance(period, supplemental),
        subvalue: this.showPrecipAmount(precipAmount) ? precipAmount : "",
        className: "precip-stat"
      }
    ];
  }

  emptyPollen(category = "Checking") {
    const emptyDetail = (label, icon = "pollen.svg") => ({ label, value: null, category, icon });
    if (/unavailable/i.test(category)) {
      return {
        value: null,
        category,
        source: "SkyStation Allergy Risk",
        estimated: true,
        reason: "Pollen outlook is temporarily unavailable.",
        note: "",
        details: [
          { label: "Pollen outlook temporarily unavailable", value: null, category: "", icon: "pollen.svg" }
        ]
      };
    }
    return {
      value: null,
      category,
        source: "SkyStation Allergy Risk",
      estimated: true,
      reason: category === "Checking" ? "Allergy risk is being estimated." : "Allergy risk is unavailable right now.",
      note: "Estimated from season and local weather conditions.",
      details: [
        emptyDetail("Tree Allergy Risk"),
        emptyDetail("Grass Allergy Risk"),
        emptyDetail("Weed Allergy Risk"),
        emptyDetail("Ragweed Allergy Risk"),
        emptyDetail("Outdoor Mold Risk"),
        emptyDetail("Outdoor Dust Risk", "aqi.svg")
      ]
    };
  }

  mapHealthRisks(supplemental, airQuality) {
    const humidity = this.numberOrNull(supplemental?.humidity) || 0;
    const pressure = this.numberOrNull(supplemental?.pressure) || 1013;
    const dewPoint = this.numberOrNull(supplemental?.dewPoint) || 50;
    const uv = this.numberOrNull(supplemental?.uvIndex) || 0;
    const aqi = airQuality?.value || 0;
    const pollenPeak = supplemental?.pollen?.value || 0;
    const precip = this.firstNumber(supplemental?.precipitationAmount, supplemental?.rain, supplemental?.showers, supplemental?.snowfall) || 0;
    const pressureTrend = supplemental?.pressureTrend || "Steady";
    return [
      this.healthDetail("Arthritis", this.arthritisRiskScore(pressure, pressureTrend, precip)),
      this.healthDetail("Sinus Pressure", this.sinusRiskScore(humidity, dewPoint, pressure, pressureTrend, precip)),
      this.healthDetail("Common Cold", this.commonColdRiskScore(humidity, dewPoint)),
      this.healthDetail("Flu", this.fluRiskScore(humidity, dewPoint)),
      this.healthDetail("Migraine", this.migraineRiskScore(pressure, pressureTrend, uv)),
      this.healthDetail("Asthma", this.asthmaRiskScore(aqi, pollenPeak, humidity, dewPoint, precip))
    ];
  }

  arthritisRiskScore(pressure, pressureTrend, precip) {
    const pressureScore = pressure < 995 ? 22 : pressure < 1005 ? 12 : 0;
    const trendScore = /falling/i.test(pressureTrend) ? 12 : 0;
    const weatherScore = precip >= 0.05 ? 8 : precip > 0 ? 4 : 0;
    return 12 + pressureScore + trendScore + weatherScore;
  }

  sinusRiskScore(humidity, dewPoint, pressure, pressureTrend, precip) {
    const moistureScore = humidity >= 85 && dewPoint >= 70 ? 18 : humidity >= 75 && dewPoint >= 65 ? 12 : humidity <= 30 ? 8 : 0;
    const pressureScore = pressure < 995 ? 16 : pressure < 1005 ? 8 : 0;
    const transitionScore = (/falling|rising/i.test(pressureTrend) ? 8 : 0) + (precip >= 0.03 ? 6 : 0);
    const combo = moistureScore >= 12 && pressureScore >= 8 ? 8 : 0;
    return 12 + moistureScore + pressureScore + transitionScore + combo;
  }

  commonColdRiskScore(humidity, dewPoint) {
    const dryAir = humidity < 30 || dewPoint < 30 ? 18 : humidity < 40 || dewPoint < 40 ? 10 : 0;
    return 10 + dryAir;
  }

  fluRiskScore(humidity, dewPoint) {
    const dryColdAir = humidity < 30 || dewPoint < 28 ? 18 : humidity < 40 || dewPoint < 36 ? 10 : 0;
    return 8 + dryColdAir;
  }

  migraineRiskScore(pressure, pressureTrend, uv) {
    const pressureScore = pressure < 995 ? 16 : pressure < 1005 ? 8 : 0;
    const trendScore = /falling|rising/i.test(pressureTrend) ? 10 : 0;
    const uvScore = uv >= 9 ? 12 : uv >= 7 ? 6 : 0;
    const combo = pressureScore && trendScore ? 6 : 0;
    return 12 + pressureScore + trendScore + uvScore + combo;
  }

  asthmaRiskScore(aqi, pollenPeak, humidity, dewPoint, precip) {
    const aqiScore = aqi > 150 ? 34 : aqi > 100 ? 24 : aqi > 75 ? 14 : aqi > 50 ? 8 : 0;
    const allergyScore = pollenPeak >= 75 ? 24 : pollenPeak >= 50 ? 16 : pollenPeak >= 25 ? 8 : 0;
    const moistureScore = humidity >= 85 && dewPoint >= 70 ? 10 : humidity >= 75 && dewPoint >= 65 ? 6 : 0;
    const weatherScore = precip >= 0.05 ? 4 : 0;
    const combo = aqiScore >= 14 && allergyScore >= 16 ? 8 : 0;
    return 10 + aqiScore + allergyScore + moistureScore + weatherScore + combo;
  }

  healthDetail(label, score) {
    const icons = {
      Arthritis: "pressure.svg",
      "Sinus Pressure": "pressure.svg",
      "Common Cold": "humidity.svg",
      Flu: "humidity.svg",
      Migraine: "uv.svg",
      Asthma: "aqi.svg"
    };
    return {
      label,
      value: Math.round(score),
      category: this.riskCategory(score),
      icon: icons[label] || "aqi.svg"
    };
  }

  riskCategory(value) {
    if (value >= 80) return "Extreme";
    if (value >= 50) return "High";
    if (value >= 25) return "Moderate";
    return "Low";
  }

  allergenDetail(label, value, type) {
    return {
      label,
      value: Math.round(value),
      category: type === "dust" ? this.dustCategory(value) : this.pollenCategory(value),
      icon: type === "dust" ? "aqi.svg" : "pollen.svg"
    };
  }

  moldRiskFromWeather(current = {}) {
    const humidity = this.numberOrNull(current?.relative_humidity_2m) || 0;
    if (humidity >= 85) return 70;
    if (humidity >= 70) return 42;
    return 8;
  }

  pollenCategory(value) {
    if (value >= 100) return "Very High";
    if (value >= 50) return "High";
    if (value >= 15) return "Moderate";
    return "Low";
  }

  dustCategory(value) {
    if (value >= 100) return "High";
    if (value >= 50) return "Moderate";
    return "Low";
  }

  airQualityCategory(value) {
    if (value <= 50) return "Good";
    if (value <= 100) return "Moderate";
    if (value <= 150) return "Unhealthy for Sensitive Groups";
    if (value <= 200) return "Unhealthy";
    if (value <= 300) return "Very Unhealthy";
    return "Hazardous";
  }

  airQualityTone(value) {
    if (value <= 100) return "";
    return "warning";
  }

  distanceMiles(latA, lonA, latB, lonB) {
    const toRadians = (value) => (Number(value) * Math.PI) / 180;
    const latitudeA = toRadians(latA);
    const latitudeB = toRadians(latB);
    const deltaLat = toRadians(latB - latA);
    const deltaLon = toRadians(lonB - lonA);
    const a = Math.sin(deltaLat / 2) ** 2 + Math.cos(latitudeA) * Math.cos(latitudeB) * Math.sin(deltaLon / 2) ** 2;
    return 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  dailyAirQualityFromHourly(hourly = {}) {
    const times = hourly.time || [];
    const values = hourly.us_aqi || [];
    const byDay = new Map();
    times.forEach((time, index) => {
      const value = this.numberOrNull(values[index]);
      if (value === null) return;
      const day = String(time).split("T")[0];
      if (!day) return;
      byDay.set(day, Math.max(byDay.get(day) || 0, value));
    });
    return Array.from(byDay.values()).slice(0, 7).map((value) => {
      const rounded = Math.round(value);
      return `${rounded} ${this.airQualityCategory(rounded)}`;
    });
  }

  mapDetails(period, observation, precipitation, supplemental) {
    const wind = this.readObservedWind(observation) || this.formatOpenMeteoWind(supplemental) || `${period?.windDirection || ""} ${period?.windSpeed || ""}`.trim() || "0 mph";
    const windGust = this.readWindGust(period, supplemental, observation);
    const humidity = this.readHumidity(observation, supplemental, period);
    const dewPoint = this.dewPointFahrenheit(observation, supplemental);
    const cloudCover = this.readPercent(this.firstNumber(supplemental?.cloudCover, supplemental?.gridCloudCover));
    const pressureTrend = supplemental?.pressureTrend || "Steady";
    const pollen = supplemental?.pollen || this.emptyPollen();
    return [
      { icon: "wind.svg", label: "Wind", value: wind },
      { icon: "wind.svg", label: "Wind Gust", value: windGust },
      { icon: "humidity.svg", label: "Humidity", value: humidity },
      {
        icon: "humidity.svg",
        label: "Dew Point",
        value: this.formatMaybeTemp(dewPoint),
        status: this.dewPointComfortLabel(dewPoint),
        statusTone: this.dewPointComfortTone(dewPoint)
      },
      { icon: "aqi.svg", label: "Air Quality", value: supplemental?.airQualityLabel || "Checking" },
      { icon: "uv.svg", label: "UV Index", value: this.formatUvIndex(supplemental?.uvIndex) },
      { icon: "weather-cloud.svg", label: "Cloud Cover", value: cloudCover },
      { icon: "visibility.svg", label: "Visibility", value: this.readDistance(this.firstNumber(observation?.properties?.visibility?.value, supplemental?.visibility)) },
      { icon: "pressure.svg", label: "Barometric Pressure", value: `${this.readPressureInHgWithFallback(observation?.properties?.barometricPressure?.value, supplemental?.pressure)} (${pressureTrend})` },
      { icon: "sunrise.svg", label: "Sunrise", value: supplemental?.sunrise || "--" },
      { icon: "sunrise.svg", label: "Sunset", value: supplemental?.sunset || "--" },
      { icon: "pollen.svg", label: "Pollen & Allergens", value: "View Details", type: "pollen", details: pollen.details, health: pollen.health, note: pollen.note || pollen.reason || "" }
    ];
  }

  currentPrecipDetail(period, precipitation, supplemental) {
    const chance = this.precipChance(period, supplemental);
    const amount = this.currentPrecipAmount(period, precipitation, supplemental);
    return this.showPrecipAmount(amount) ? `${chance} / ${amount}` : chance;
  }

  daylightDurationLabel(supplemental) {
    const sunrise = this.clockMinutes(supplemental?.sunrise);
    const sunset = this.clockMinutes(supplemental?.sunset);
    if (sunrise === null || sunset === null) return "--";
    const minutes = sunset >= sunrise ? sunset - sunrise : sunset + 1440 - sunrise;
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
  }

  clockMinutes(value) {
    if (!value || value === "--") return null;
    const match = String(value).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!match) return null;
    let hours = Number(match[1]);
    const minutes = Number(match[2]);
    const period = match[3].toUpperCase();
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
    if (period === "AM" && hours === 12) hours = 0;
    if (period === "PM" && hours !== 12) hours += 12;
    return hours * 60 + minutes;
  }

  formatUvIndex(value) {
    if (!Number.isFinite(value)) return "Low";
    const rounded = Math.round(value);
    if (rounded <= 2) return `${rounded} Low`;
    if (rounded <= 5) return `${rounded} Moderate`;
    if (rounded <= 7) return `${rounded} High`;
    if (rounded <= 10) return `${rounded} Very High`;
    return `${rounded} Extreme`;
  }

  mapNarrative(period, forecastPeriods) {
    const matchingPeriod = forecastPeriods.find((item) => item.isDaytime === period?.isDaytime) || forecastPeriods[0];
    return matchingPeriod?.detailedForecast || period?.detailedForecast || period?.shortForecast || "Current conditions are updating.";
  }

  mapPrecipitation(currentPeriod, hourlyPeriods, supplemental, observation = null) {
    const chance = this.precipValue(currentPeriod, supplemental);
    const nextHourPeriods = hourlyPeriods.slice(0, 2);
    const nextHourPeak = Math.max(...nextHourPeriods.map((period) => this.precipValue(period, supplemental)), 0);
    const wetHours = nextHourPeriods.filter((period) => this.precipValue(period, supplemental) >= PRECIP_DISPLAY_THRESHOLD);
    const observationText = this.observedConditionText(observation);
    const precipText = [observationText, currentPeriod, ...wetHours].map((period) => typeof period === "string" ? period : period?.shortForecast || "").join(" ");
    const type = this.precipType(precipText);
    const expectedAmount = this.expectedPrecipAmount(hourlyPeriods, supplemental);
    const localObserved = this.isLocalPrecipActivelyOccurring(currentPeriod, supplemental, observation);
    const nearbyObserved = this.isNearbyPrecipActivelyOccurring(observation);
    const activelyOccurring = localObserved || nearbyObserved;
    const active = this.isSupportedPrecipType(type) && (activelyOccurring || chance >= PRECIP_DISPLAY_THRESHOLD || nextHourPeak >= PRECIP_DISPLAY_THRESHOLD);
    const timeline = this.nextHourPrecipTimeline(hourlyPeriods, supplemental);
    if (active && activelyOccurring && !timeline.some((item) => this.numberOrNull(item?.amount) >= 0.001 || this.numberOrNull(item?.chance) >= PRECIP_DISPLAY_THRESHOLD)) {
      const activeChance = Math.max(chance, nextHourPeak, PRECIP_DISPLAY_THRESHOLD);
      const activeAmount = type === "Snow" || type === "Sleet" ? null : 0.004;
      timeline.splice(0, timeline.length, ...Array.from({ length: 21 }, (_, index) => ({
        chance: Math.max(PRECIP_DISPLAY_THRESHOLD, activeChance - Math.max(0, index - 6)),
        amount: activeAmount
      })));
    }
    const summary = nearbyObserved && !localObserved && nextHourPeak < PRECIP_DISPLAY_THRESHOLD
      ? `${type} is showing nearby.`
      : activelyOccurring && nextHourPeak < PRECIP_DISPLAY_THRESHOLD
      ? `${type} is currently occurring.`
      : expectedAmount >= 0.001
        ? `${type} totals may reach ${this.formatInches(expectedAmount)} based on the latest forecast.`
        : `${nextHourPeak}% chance of ${type.toLowerCase()} within the next hour.`;

    return {
      active,
      type,
      icon: type === "Snow" || type === "Sleet" ? "weather-snow.svg" : "weather-rain.svg",
      summary: active ? summary : "No significant precipitation expected.",
      current: active && nearbyObserved && !localObserved && chance < PRECIP_DISPLAY_THRESHOLD ? `${type} nearby` : active && activelyOccurring && chance < PRECIP_DISPLAY_THRESHOLD ? `${type} now` : active ? `${chance}% now` : "0% now",
      nextHour: `${this.precipValue(hourlyPeriods[1], supplemental)}% next hour`,
      amount: this.precipAmountLabel(expectedAmount, hourlyPeriods, supplemental),
      today: expectedAmount >= 0.001 ? `${this.formatInches(expectedAmount)} today` : "",
      timeline,
      note: this.precipNote(hourlyPeriods)
    };
  }

  mapAlert(alerts) {
    const activeAlerts = alerts?.features?.map((feature) => feature.properties).filter(Boolean) || [];
    if (!activeAlerts.length) return null;
    const headline = activeAlerts.length > 1 ? `${activeAlerts.length} Weather Alerts` : activeAlerts[0].event || "Weather Alert";
    const summary = activeAlerts.length > 1
      ? activeAlerts.map((alert) => alert.event || alert.headline || "Weather Alert").join(" • ")
      : activeAlerts[0].headline || activeAlerts[0].description || "An active weather alert has been issued for this area.";
    const sections = activeAlerts.map((alert, index) => ({
      title: activeAlerts.length > 1 ? `Alert ${index + 1}: ${alert.event || "Weather Alert"}` : alert.event || "Weather Alert",
      body: [
        this.cleanAlertText(alert.description),
        alert.instruction ? `What to do:\n${this.cleanAlertText(alert.instruction)}` : "",
        alert.areaDesc ? `Areas affected:\n${this.cleanAlertText(alert.areaDesc)}` : "",
        alert.expires ? `Expires:\n${this.formatAlertTime(alert.expires)}` : ""
      ].filter(Boolean).join("\n\n")
    }));

    return {
      headline,
      body: this.cleanAlertText(summary),
      details: sections.map((section) => [section.title, section.body].filter(Boolean).join("\n\n")).join("\n\n"),
      sections
    };
  }

  mapAlertHazards(alerts) {
    const activeAlerts = alerts?.features?.map((feature) => feature.properties).filter(Boolean) || [];
    return activeAlerts.map((alert) => {
      const event = alert.event || alert.headline || "Weather Alert";
      return {
        event,
        headline: alert.headline || event,
        description: alert.description || "",
        instruction: alert.instruction || "",
        severity: alert.severity || "",
        start: alert.onset || alert.effective || alert.sent || null,
        end: alert.ends || alert.expires || null,
        level: this.hazardLevelFromAlert(alert)
      };
    }).filter((alert) => alert.level);
  }

  hazardLevelFromAlert(alert = {}) {
    const textLevel = this.hazardLevelFromText(`${alert.event || ""} ${alert.headline || ""} ${alert.description || ""}`, true);
    if (textLevel === "alert") return "alert";
    const severity = String(alert.severity || "").toLowerCase();
    const urgency = String(alert.urgency || "").toLowerCase();
    const certainty = String(alert.certainty || "").toLowerCase();
    if (severity === "extreme" || (severity === "severe" && /immediate|expected|observed|likely/.test(`${urgency} ${certainty}`))) return "alert";
    if (textLevel === "impact") return "impact";
    if (["moderate", "severe"].includes(severity)) return "impact";
    return "";
  }

  cleanAlertText(value = "") {
    return String(value).replace(/\r?\n/g, " ").replace(/\s*\*\s+/g, "\n").replace(/[ \t]+/g, " ").trim();
  }

  formatAlertTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString([], {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short"
    });
  }

  mapHourly(periods, supplemental = {}) {
    return periods.slice(0, 12).map((period, index) => {
      const windSpeed = this.firstNumber(supplemental?.hourlyWindSpeeds?.[index]);
      const windDirection = this.windDirectionLabel(this.firstNumber(supplemental?.hourlyWindDirections?.[index])) || period.windDirection || "";
      const windGust = this.firstNumber(supplemental?.hourlyWindGusts?.[index]);
      const humidity = this.firstNumber(supplemental?.hourlyHumidity?.[index]);
      const dewPoint = this.firstNumber(supplemental?.hourlyDewPoints?.[index]);
      const uvIndex = this.firstNumber(supplemental?.hourlyUvIndexes?.[index], supplemental?.uvIndex);
      return {
        time: period.startTime,
        icon: this.iconForForecast(period.shortForecast, period.isDaytime),
        temp: period.temperature,
        precip: `${this.precipValue(period, supplemental)}%`,
        wind: windSpeed === null ? period.windSpeed || "0 mph" : `${Math.round(windSpeed)} mph`,
        windDirection,
        windGust: windGust === null ? "" : `${Math.round(windGust)} mph`,
        humidity: humidity === null ? "" : this.readPercent(humidity),
        dewPoint,
        dewPointLabel: this.formatMaybeTemp(dewPoint),
        uvIndex: this.formatUvIndex(uvIndex)
      };
    });
  }

  mapDaily(periods, supplemental) {
    const days = [];

    for (let index = 0; index < periods.length && days.length < 7; index += 1) {
      const dayPeriod = periods[index];
      if (!dayPeriod.isDaytime) continue;
      const nightPeriod = periods.slice(index + 1).find((period) => !period.isDaytime);
      days.push(this.buildDailyForecast(dayPeriod, nightPeriod, supplemental, days.length));
    }

    const todayLabel = this.currentForecastDayLabel(periods[0]?.startTime);
    if (days.length && days[0].day !== todayLabel) {
      days.unshift(this.buildTodayCarryover(periods[0], todayLabel, supplemental));
    }

    return days.slice(0, 7);
  }

  buildDailyForecast(dayPeriod, nightPeriod, supplemental, dayIndex) {
    const supplementalIndex = this.dailyIndexForStart(dayPeriod.startTime, supplemental, dayIndex);
    const low = nightPeriod?.temperature ?? supplemental?.dailyLows?.[supplementalIndex] ?? dayPeriod.temperature;
    const high = dayPeriod.temperature ?? supplemental?.dailyHighs?.[supplementalIndex];
    const gridChance = this.numberOrNull(supplemental?.dailyGridPrecipChances?.[supplementalIndex]) ?? 0;
    const precip = Math.max(this.precipValue(dayPeriod, supplemental), this.precipValue(nightPeriod, supplemental), Math.round(gridChance));
    const text = `${dayPeriod.detailedForecast || ""} ${nightPeriod?.detailedForecast || ""}`;
    const numericDailyAmount = this.formatInches(this.firstNumber(supplemental?.dailyGridPrecipAmounts?.[supplementalIndex], supplemental?.dailyPrecipAmounts?.[supplementalIndex]));
    const precipAmount = this.showPrecipAmount(numericDailyAmount) ? numericDailyAmount : this.precipAmountFromText(text);
    const designation = this.dayDesignation(dayPeriod, nightPeriod, text, high, low, supplemental, supplementalIndex);

    return {
      day: this.dayLabel(dayPeriod.startTime),
      date: this.dayNumber(dayPeriod.startTime),
      icon: this.iconForForecast(dayPeriod.shortForecast, true),
      condition: dayPeriod.shortForecast,
      high,
      low,
      precip: precip > 0 ? `${precip}%` : "0%",
      precipAmount,
      designation,
      range: this.rangeWidth(low, high),
      details: {
        story: [
          { icon: this.iconForForecast(dayPeriod.shortForecast, true), title: this.dayTitle(dayPeriod.startTime), text: dayPeriod.detailedForecast || dayPeriod.shortForecast },
          { icon: this.iconForForecast(nightPeriod?.shortForecast, false), title: this.nightTitle(dayPeriod.startTime), text: nightPeriod?.detailedForecast || "Night forecast is updating." }
        ],
        metrics: this.dayMetrics(low, high, precip, text, precipAmount, dayPeriod, nightPeriod, supplemental, supplementalIndex)
      }
    };
  }

  buildTodayCarryover(period, todayLabel, supplemental) {
    const supplementalIndex = this.dailyIndexForStart(period?.startTime, supplemental, 0);
    const temp = period?.temperature ?? null;
    const gridChance = this.numberOrNull(supplemental?.dailyGridPrecipChances?.[supplementalIndex]) ?? 0;
    const precip = Math.max(this.precipValue(period, supplemental), Math.round(gridChance));
    const text = period?.detailedForecast || period?.shortForecast || "Tonight forecast is updating.";
    const numericDailyAmount = this.formatInches(this.firstNumber(supplemental?.dailyGridPrecipAmounts?.[supplementalIndex], supplemental?.dailyPrecipAmounts?.[supplementalIndex]));
    const precipAmount = this.showPrecipAmount(numericDailyAmount) ? numericDailyAmount : this.precipAmountFromText(text);
    const designation = this.dayDesignation(period, null, text, temp, temp, supplemental, supplementalIndex);

    return {
      day: todayLabel,
      date: this.dayNumber(period?.startTime || new Date()),
      icon: this.iconForForecast(period?.shortForecast, false),
      condition: period?.shortForecast || "Tonight",
      high: temp,
      low: temp,
      precip: precip > 0 ? `${precip}%` : "0%",
      precipAmount,
      designation,
      range: this.rangeWidth(temp, temp),
      details: {
        story: [
          { icon: this.iconForForecast(period?.shortForecast, false), title: "Tonight", text }
        ],
        metrics: this.dayMetrics(temp, temp, precip, text, precipAmount, period, null, supplemental, supplementalIndex)
      }
    };
  }

  dailyIndexForStart(startTime, supplemental, fallbackIndex = 0) {
    const dates = supplemental?.dailyDates || [];
    const dateKey = this.dateKey(startTime);
    const matchedIndex = dateKey ? dates.findIndex((date) => date === dateKey) : -1;
    if (matchedIndex >= 0) return matchedIndex;
    const safeFallback = Number.isInteger(fallbackIndex) && fallbackIndex >= 0 ? fallbackIndex : 0;
    return Math.min(safeFallback, Math.max(0, dates.length - 1));
  }

  dateKey(value) {
    if (!value) return "";
    const localDate = String(value).match(/^\d{4}-\d{2}-\d{2}/)?.[0];
    if (localDate) return localDate;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toISOString().slice(0, 10);
  }

  dayMetrics(low, high, precip, text, precipAmount, dayPeriod, nightPeriod, supplemental, dayIndex = 0) {
    const combinedText = `${text || ""} ${dayPeriod?.shortForecast || ""} ${nightPeriod?.shortForecast || ""}`;
    const uv = this.firstNumber(supplemental?.dailyUvIndexes?.[dayIndex], supplemental?.dailyHourlyUvIndexes?.[dayIndex], supplemental?.uvIndex);
    const dailyWindSpeed = this.numberOrNull(supplemental?.dailyWindSpeeds?.[dayIndex]);
    const dailyWindDirection = this.windDirectionLabel(supplemental?.dailyWindDirections?.[dayIndex]);
    const dailyWind = dailyWindSpeed === null ? "" : `${Math.round(dailyWindSpeed)} mph`;
    const dailyGust = this.numberOrNull(supplemental?.dailyWindGusts?.[dayIndex]);
    const fallbackWindSpeed = this.numberOrNull(supplemental?.windSpeed);
    const wind = this.windFromText(combinedText) || dailyWind || (fallbackWindSpeed === null ? "" : `${Math.round(fallbackWindSpeed)} mph`) || "0 mph";
    const gusts = this.gustFromText(combinedText) || (dailyGust === null ? "" : `${Math.round(dailyGust)} mph`) || this.readWindGust(dayPeriod, supplemental);
    const windDirection = this.windDirectionFromText(combinedText) || dayPeriod?.windDirection || dailyWindDirection || this.windDirectionLabel(supplemental?.windDirection);
    const humidity = this.readPercent(this.firstNumber(supplemental?.dailyHumidity?.[dayIndex], supplemental?.humidity));
    const dewPointValue = this.firstNumber(supplemental?.dailyDewPoints?.[dayIndex], supplemental?.dewPoint);
    const dewPoint = this.formatMaybeTemp(dewPointValue);
    const airQuality = supplemental?.dailyAirQuality?.[dayIndex] || "Checking";
    const sunrise = supplemental?.dailySunrise?.[dayIndex] || supplemental?.sunrise || "--";
    const sunset = supplemental?.dailySunset?.[dayIndex] || supplemental?.sunset || "--";
    const cloudCover = this.readPercent(this.firstNumber(supplemental?.dailyCloudCover?.[dayIndex], supplemental?.dailyGridCloudCover?.[dayIndex], supplemental?.cloudCover, supplemental?.gridCloudCover));
    const pressureValue = this.firstNumber(supplemental?.dailyPressure?.[dayIndex], supplemental?.pressure);
    const previousPressure = this.firstNumber(supplemental?.dailyPressure?.[Math.max(0, dayIndex - 1)], supplemental?.pressure);
    const visibility = this.readDistance(this.firstNumber(supplemental?.dailyVisibility?.[dayIndex], supplemental?.visibility));
    const dailyPollen = supplemental?.dailyPollenByDate?.[this.dateKey(dayPeriod?.startTime)] || supplemental?.pollen || {};
    const pollenDetails = [
      ...(dailyPollen.details || []),
      ...(dailyPollen.health || [])
    ];
    const highPollenItems = pollenDetails.filter((item) => ["High", "Very High", "Extreme"].includes(item.category));
    const moderatePollenItems = pollenDetails.filter((item) => item.category === "Moderate");
    const pollenItems = highPollenItems.length ? highPollenItems : moderatePollenItems;
    const pollen = pollenItems.length ? "" : "Air is Clear";
    const precipValue = [precip > 0 ? `${precip}%` : "0%", this.showPrecipAmount(precipAmount) ? precipAmount : ""].filter(Boolean).join(" / ");
    const windValue = this.dayWindLabel(wind, windDirection, gusts);
    const pressureLabel = `${this.formatPressureInHg(pressureValue)} (${this.pressureTrend(pressureValue, previousPressure)})`;
    return [
      { icon: "rain-chance.svg", label: "Precipitation", value: precipValue },
      { icon: "wind.svg", label: "Wind & Gusts", value: windValue },
      { icon: "sunrise.svg", label: "Sunrise / Sunset", value: `Sunrise ${sunrise} | Sunset ${sunset}` },
      { icon: "weather-cloud.svg", label: "Cloud Cover", value: cloudCover },
      { icon: "pressure.svg", label: "Barometric Pressure", value: pressureLabel },
      { icon: "visibility.svg", label: "Visibility", value: visibility },
      { icon: "humidity.svg", label: "Humidity", value: humidity },
      {
        icon: "humidity.svg",
        label: "Dew Point",
        value: dewPoint,
        status: this.dewPointComfortLabel(dewPointValue),
        statusTone: this.dewPointComfortTone(dewPointValue)
      },
      { icon: "uv.svg", label: "UV Index", value: this.formatUvIndex(uv) },
      { icon: "aqi.svg", label: "Air Quality", value: airQuality },
      { icon: "pollen.svg", label: "Pollen & Allergens", value: pollen, type: "pollen-pills", items: pollenItems }
    ];
  }

  dayDesignation(dayPeriod, nightPeriod, text, high, low, supplemental, dayIndex = 0) {
    const dayStart = this.startOfLocalDay(dayPeriod?.startTime || nightPeriod?.startTime);
    const dayEnd = dayStart ? new Date(dayStart.getTime() + 24 * 60 * 60 * 1000) : null;
    const matchingHazards = (supplemental?.alertHazards || []).filter((alert) => this.alertOverlapsDay(alert, dayStart, dayEnd));
    const alertHazard = matchingHazards.find((alert) => alert.level === "alert");
    if (alertHazard) return { level: "alert", label: "Alert", reason: `Active NWS ${alertHazard.event}.` };
    const impactHazard = matchingHazards.find((alert) => alert.level === "impact");
    if (impactHazard) return { level: "impact", label: "Impact", reason: `Active NWS ${impactHazard.event}.` };

    const spcOutlook = this.spcOutlookForDay(dayStart, supplemental);
    if (spcOutlook?.level === "alert") return { level: "alert", label: "Alert", reason: `SPC ${spcOutlook.source} outlook for this area.` };
    if (spcOutlook?.level === "impact") return { level: "impact", label: "Impact", reason: `SPC ${spcOutlook.source} outlook for this area.` };

    const forecastText = `${text || ""} ${dayPeriod?.shortForecast || ""} ${nightPeriod?.shortForecast || ""}`;
    const forecastLevel = this.hazardLevelFromText(forecastText, false);
    if (forecastLevel === "alert") return { level: "alert", label: "Alert", reason: this.forecastHazardReason(forecastText, forecastLevel) };
    const quantitativeDesignation = this.quantitativeForecastHazardLevel(dayPeriod, nightPeriod, forecastText, supplemental, dayIndex);
    if (quantitativeDesignation?.level === "alert") return { label: "Alert", ...quantitativeDesignation };
    if (forecastLevel === "impact") return { level: "impact", label: "Impact", reason: this.forecastHazardReason(forecastText, forecastLevel) };
    if (quantitativeDesignation?.level === "impact") return { label: "Impact", ...quantitativeDesignation };
    if (spcOutlook?.level === "marginal" && this.hasSupportingSevereSignal(forecastText, supplemental)) {
      return { level: "impact", label: "Impact", reason: "SPC Marginal outlook with supporting severe-weather forecast signals." };
    }

    const apparentHigh = this.forecastHeatIndexValue(forecastText) ?? this.numberOrNull(high);
    const apparentLow = this.forecastWindChillValue(forecastText) ?? this.numberOrNull(low);
    if (apparentHigh !== null && apparentHigh >= 110) return { level: "alert", label: "Alert", reason: `Forecast heat index/high near ${Math.round(apparentHigh)}°F.` };
    if (apparentHigh !== null && apparentHigh >= 105) return { level: "impact", label: "Impact", reason: `Forecast heat index/high near ${Math.round(apparentHigh)}°F.` };
    if (apparentLow !== null && apparentLow <= -25) return { level: "alert", label: "Alert", reason: `Forecast wind chill/low near ${Math.round(apparentLow)}°F.` };
    if (apparentLow !== null && apparentLow <= -15) return { level: "impact", label: "Impact", reason: `Forecast wind chill/low near ${Math.round(apparentLow)}°F.` };

    return null;
  }

  forecastHazardReason(forecastText = "", level = "impact") {
    const text = String(forecastText || "").toLowerCase();
    if (/tornado(?:es)?/.test(text)) return "Forecast indicates tornado potential.";
    if (/blizzard/.test(text)) return "Forecast calls for blizzard conditions.";
    if (/icing|freezing rain/.test(text)) return level === "alert" ? "Forecast indicates significant icing." : "Forecast calls for travel-impacting ice.";
    if (/flood/.test(text)) return level === "alert" ? "Forecast indicates major flash flooding." : "Forecast calls for flooding concerns.";
    if (/strong|severe thunderstorms?/.test(text)) return "Forecast calls for strong thunderstorms.";
    if (/damaging winds?/.test(text)) return "Forecast calls for damaging winds.";
    if (/large hail/.test(text)) return "Forecast calls for large hail.";
    if (/heavy (?:rain|rainfall|snow)/.test(text)) return "Forecast calls for heavy precipitation.";
    if (/dense fog/.test(text)) return "Forecast calls for dense fog.";
    if (/smoke|air quality/.test(text)) return "Forecast calls for degraded air quality.";
    return "Forecast conditions may significantly affect plans.";
  }

  quantitativeForecastHazardLevel(dayPeriod, nightPeriod, forecastText, supplemental = {}, dayIndex = 0) {
    const index = Number.isInteger(dayIndex) && dayIndex >= 0 ? dayIndex : 0;
    const gusts = this.numberOrNull(supplemental?.dailyWindGusts?.[index]);
    const rainfall = this.firstNumber(
      supplemental?.dailyPrecipAmounts?.[index],
      supplemental?.dailyGridPrecipAmounts?.[index]
    );
    const snowfall = this.numberOrNull(supplemental?.dailySnowfallAmounts?.[index]);
    const precipChance = Math.max(
      this.precipValue(dayPeriod),
      this.precipValue(nightPeriod),
      this.numberOrNull(supplemental?.dailyGridPrecipChances?.[index]) ?? 0
    );
    const text = String(forecastText || "").toLowerCase();
    const heavyRainSignal = /heavy (?:rain|rainfall)|torrential|flash flood(?:ing)?|widespread flood(?:ing)?/.test(text);

    if (gusts !== null && gusts >= FORECAST_HAZARD_THRESHOLDS.windGustAlertMph) return { level: "alert", reason: `Forecast wind gusts up to ${Math.round(gusts)} mph.` };
    if (snowfall !== null && snowfall >= FORECAST_HAZARD_THRESHOLDS.snowAlertInches) return { level: "alert", reason: `Forecast snowfall around ${this.formatInches(snowfall)}.` };
    if (rainfall !== null && rainfall >= FORECAST_HAZARD_THRESHOLDS.rainfallAlertInches) return { level: "alert", reason: `Forecast rainfall around ${this.formatInches(rainfall)}.` };
    if (
      rainfall !== null
      && rainfall >= FORECAST_HAZARD_THRESHOLDS.rainfallAlertWithHeavySignalInches
      && precipChance >= FORECAST_HAZARD_THRESHOLDS.rainfallAlertPrecipChance
      && heavyRainSignal
    ) return { level: "alert", reason: `Forecast heavy rain around ${this.formatInches(rainfall)} with a ${Math.round(precipChance)}% chance.` };

    if (gusts !== null && gusts >= FORECAST_HAZARD_THRESHOLDS.windGustImpactMph) return { level: "impact", reason: `Forecast wind gusts up to ${Math.round(gusts)} mph.` };
    if (snowfall !== null && snowfall >= FORECAST_HAZARD_THRESHOLDS.snowImpactInches) return { level: "impact", reason: `Forecast snowfall around ${this.formatInches(snowfall)}.` };
    if (rainfall !== null && rainfall >= FORECAST_HAZARD_THRESHOLDS.rainfallImpactInches) return { level: "impact", reason: `Forecast rainfall around ${this.formatInches(rainfall)}.` };

    return null;
  }

  hazardLevelFromText(text = "", officialProduct = false) {
    const value = String(text || "").toLowerCase();
    const officialAlertPatterns = [
      /tornado (?:warning|watch)/,
      /severe thunderstorm (?:warning|watch)/,
      /flash flood (?:warning|watch)/,
      /flood warning/,
      /winter storm warning/,
      /winter storm watch/,
      /ice storm warning/,
      /blizzard warning/,
      /excessive heat warning/,
      /extreme heat warning/,
      /extreme cold warning/,
      /high wind warning/
    ];
    if (officialProduct && officialAlertPatterns.some((pattern) => pattern.test(value))) return "alert";

    const extremeForecastPatterns = [
      /tornado(?:es)? likely/,
      /blizzard conditions expected/,
      /significant icing expected/,
      /major flash flood(?:ing)? expected/,
      /life[- ]threatening/
    ];
    if (extremeForecastPatterns.some((pattern) => pattern.test(value))) return "alert";

    const impactOfficialPatterns = [
      /heat advisory/,
      /winter weather advisory/,
      /wind advisory/,
      /dense fog advisory/,
      /cold weather advisory/,
      /air quality alert/,
      /flood watch/
    ];
    if (officialProduct && impactOfficialPatterns.some((pattern) => pattern.test(value))) return "impact";

    const impactForecastPatterns = [
      /strong thunderstorms?/,
      /damaging winds?/,
      /large hail/,
      /heavy (?:rain|rainfall|snow)/,
      /localized flood(?:ing)?/,
      /ponding/,
      /accumulating snow/,
      /freezing rain/,
      /light icing/,
      /dense fog/,
      /areas of smoke/,
      /poor air quality/,
      /heat index values? as high as 10[5-9]/
    ];
    if (impactForecastPatterns.some((pattern) => pattern.test(value))) return "impact";

    return "";
  }

  alertOverlapsDay(alert, dayStart, dayEnd) {
    if (!dayStart || !dayEnd) return false;
    const start = alert.start ? new Date(alert.start) : dayStart;
    const end = alert.end ? new Date(alert.end) : dayEnd;
    const startTime = Number.isNaN(start.getTime()) ? dayStart.getTime() : start.getTime();
    const endTime = Number.isNaN(end.getTime()) ? dayEnd.getTime() : end.getTime();
    const overlapStart = Math.max(startTime, dayStart.getTime());
    const overlapEnd = Math.min(endTime, dayEnd.getTime());
    const overlapMinutes = Math.max(0, (overlapEnd - overlapStart) / 60000);
    if (overlapMinutes <= 0) return false;
    if (alert.level === "alert") return true;
    return overlapMinutes >= 90 || startTime >= dayStart.getTime() + 4 * 60 * 60 * 1000;
  }

  hasSupportingSevereSignal(text = "", supplemental = {}) {
    const value = String(text || "").toLowerCase();
    if (/strong thunderstorms?|severe thunderstorms?|damaging winds?|large hail|tornado|watch|warning|advisory/.test(value)) return true;
    return (supplemental?.alertHazards || []).some((alert) => alert.level);
  }

  forecastHeatIndexValue(text = "") {
    const match = String(text).match(/heat index(?: values?)?(?: as high as| up to| near)?\s*(-?\d+)/i);
    return match ? this.numberOrNull(match[1]) : null;
  }

  forecastWindChillValue(text = "") {
    const match = String(text).match(/wind chill(?: values?)?(?: as low as| down to| near)?\s*(-?\d+)/i);
    return match ? this.numberOrNull(match[1]) : null;
  }

  spcOutlookForDay(dayStart, supplemental) {
    if (!dayStart) return null;
    const today = this.startOfLocalDay(new Date());
    if (!today) return null;
    const dayOffset = Math.round((dayStart.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
    return (supplemental?.spcOutlooks || []).find((outlook) => outlook.dayOffset === dayOffset) || null;
  }

  startOfLocalDay(value) {
    if (!value) return null;
    const key = String(value).match(/^\d{4}-\d{2}-\d{2}/)?.[0];
    const date = key ? new Date(`${key}T00:00:00`) : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    date.setHours(0, 0, 0, 0);
    return date;
  }

  showPrecipAmount(value = "") {
    if (!value) return false;
    const text = String(value).trim();
    if (/^0(?:\.00)?\s*in$/i.test(text)) return false;
    return true;
  }

  iconForForecast(text = "", isDaytime = true) {
    const value = text.toLowerCase();
    if (value.includes("thunder") || value.includes("storm")) return "weather-storm.svg";
    if (value.includes("snow") || value.includes("sleet") || value.includes("ice")) return "weather-snow.svg";
    if (value.includes("rain") || value.includes("showers") || value.includes("drizzle")) return "weather-rain.svg";
    if (value.includes("cloud") || value.includes("overcast")) return value.includes("partly") ? "weather-partly.svg" : "weather-cloud.svg";
    return isDaytime ? "weather-sunny.svg" : "weather-cloud.svg";
  }

  precipType(text = "") {
    const value = text.toLowerCase();
    if (value.includes("sleet") || value.includes("ice pellets")) return "Sleet";
    if (value.includes("snow")) return "Snow";
    return "Rain";
  }

  isSupportedPrecipType(type) {
    return ["Rain", "Snow", "Sleet"].includes(type);
  }

  isPrecipActivelyOccurring(period, supplemental, observation = null) {
    return this.isLocalPrecipActivelyOccurring(period, supplemental, observation) || this.isNearbyPrecipActivelyOccurring(observation);
  }

  isLocalPrecipActivelyOccurring(period, supplemental, observation = null) {
    const currentAmount = this.firstNumber(supplemental?.precipitationAmount, supplemental?.rain, supplemental?.showers, supplemental?.snowfall);
    if (currentAmount >= 0.001) return true;
    const observedText = this.localObservedConditionText(observation);
    if (this.isFreshObservation(observation) && this.isPrecipText(observedText)) return true;
    const currentText = period?.shortForecast || "";
    if (/chance|possible|likely/i.test(currentText)) return false;
    return /rain|showers|drizzle|snow|sleet|ice pellets/i.test(currentText);
  }

  isNearbyPrecipActivelyOccurring(observation = null) {
    const nearbyText = observation?.properties?.nearbyPrecipitationText || "";
    const distance = this.numberOrNull(observation?.properties?.nearbyPrecipitationDistance);
    return this.isFreshObservation(observation)
      && distance !== null
      && distance <= MAX_NEARBY_PRECIP_STATION_MILES
      && this.isPrecipText(nearbyText);
  }

  localObservedConditionText(observation) {
    const properties = observation?.properties;
    if (!properties) return "";
    const presentWeather = Array.isArray(properties.presentWeather)
      ? properties.presentWeather.map((item) => [item?.weather, item?.rawString].filter(Boolean).join(" ")).join(" ")
      : "";
    return [
      properties.textDescription,
      properties.rawMessage,
      presentWeather,
      properties.localPrecipitationText
    ].filter(Boolean).join(" ");
  }

  visibleObservedConditionText(observation) {
    const properties = observation?.properties;
    if (!properties) return "";
    const description = this.cleanWeatherDescription(properties.textDescription);
    if (description) return description;
    const presentWeather = Array.isArray(properties.presentWeather)
      ? properties.presentWeather
        .map((item) => this.cleanWeatherDescription(item?.weather))
        .filter(Boolean)
      : [];
    return [...new Set(presentWeather)].slice(0, 3).join(" and ");
  }

  cleanWeatherDescription(value = "") {
    const text = String(value || "").trim().replace(/\s+/g, " ");
    if (!text || text.length > 64) return "";
    if (/\b(?:AUTO|RMK|KT|SM|SLP|A\d{4}|FEW\d{3}|SCT\d{3}|BKN\d{3}|OVC\d{3}|TSRA|RAE|RAB|TSE|TSB|\+RA|-RA|BR|FG|HZ|DZ|SN)\b/i.test(text)) return "";
    if (/\b[A-Z]{4}\b/.test(text)) return "";
    return text;
  }

  observedConditionText(observation) {
    return [
      this.localObservedConditionText(observation),
      observation?.properties?.nearbyPrecipitationText
    ].filter(Boolean).join(" ");
  }

  isPrecipText(text = "") {
    return /rain|showers|drizzle|snow|sleet|ice pellets|thunderstorm|thunderstorms|storm/i.test(String(text));
  }

  precipValue(period, supplemental) {
    const nwsValue = period?.probabilityOfPrecipitation?.value;
    const numericNws = this.numberOrNull(nwsValue);
    if (numericNws !== null) return Math.round(Math.max(0, numericNws));
    const fallbackValue = this.firstNumber(supplemental?.gridPrecipChance, supplemental?.precipChance);
    if (fallbackValue !== null) return Math.round(Math.max(0, fallbackValue));
    return this.precipChanceFromText(`${period?.shortForecast || ""} ${period?.detailedForecast || ""}`);
  }

  precipChanceFromText(text = "") {
    const value = String(text).toLowerCase();
    if (!/rain|showers|drizzle|snow|sleet|ice pellets|thunderstorm|storm/.test(value)) return 0;
    if (/likely|numerous|widespread/.test(value)) return 60;
    if (/slight chance|isolated|few/.test(value)) return PRECIP_DISPLAY_THRESHOLD;
    if (/chance|scattered/.test(value)) return 30;
    return 0;
  }

  precipChance(period, supplemental) {
    const chance = this.precipValue(period, supplemental);
    return `${chance}%`;
  }

  precipNote(periods) {
    const firstWetIndex = periods.slice(0, 7).findIndex((period) => this.precipValue(period) > 0);
    if (firstWetIndex < 0) return "No precipitation expected soon.";
    const lastWetIndex = periods.slice(0, 7).reduce((last, period, index) => this.precipValue(period) > 0 ? index : last, firstWetIndex);
    return `Rain starting in ${firstWetIndex * 10} min., stopping ${Math.max(10, (lastWetIndex - firstWetIndex + 1) * 10)} min. later.`;
  }

  expectedPrecipAmount(periods, supplemental) {
    const minutelyAmount = this.sumNumeric(supplemental?.minutelyPrecipAmounts?.slice(0, 5));
    if (minutelyAmount > 0) return minutelyAmount;
    const currentAmount = this.firstNumber(supplemental?.precipitationAmount, supplemental?.rain, supplemental?.showers, supplemental?.snowfall);
    if (currentAmount > 0) return currentAmount;
    const hourlyAmount = this.sumNumeric(supplemental?.hourlyPrecipAmounts?.slice(0, 2));
    if (hourlyAmount > 0) return hourlyAmount;
    const text = periods.slice(0, 12).map((period) => period.detailedForecast || period.shortForecast || "").join(" ");
    return this.precipAmountNumber(this.precipAmountFromText(text));
  }

  precipAmountLabel(amount, periods, supplemental) {
    if (amount > 0) return amount < 0.01 ? "<0.01 in" : `${amount.toFixed(2)} in`;
    const fallbackAmount = this.firstNumber(supplemental?.dailyPrecipAmount, supplemental?.precipitationAmount, supplemental?.rain, supplemental?.showers, supplemental?.snowfall);
    if (fallbackAmount > 0) return this.formatInches(fallbackAmount);
    const text = periods.slice(0, 12).map((period) => period.detailedForecast || period.shortForecast || "").join(" ");
    const textAmount = this.precipAmountFromText(text);
    if (textAmount) return textAmount;
    return "0 in";
  }

  currentPrecipAmount(period, precipitation, supplemental) {
    const chance = this.precipValue(period, supplemental);
    if (precipitation?.active || chance > 0) return precipitation?.amount || "Trace";
    return "0 in";
  }

  sumNumeric(values = []) {
    return values
      .map((value) => this.numberOrNull(value))
      .filter((value) => value !== null && value > 0)
      .reduce((total, value) => total + value, 0);
  }

  precipAmountNumber(value) {
    if (!value) return 0;
    if (value.includes("<")) {
      const limit = Number(value.match(/\d+(?:\.\d+)?/)?.[0] || 0);
      return limit > 0 ? Math.max(0.001, limit - 0.001) : 0;
    }
    const numbers = value.match(/\d+(?:\.\d+)?/g) || [];
    return numbers.length ? Math.max(...numbers.map(Number)) : 0;
  }

  numberOrNull(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  firstNumber(...values) {
    return values.map((value) => this.numberOrNull(value)).find((value) => value !== null) ?? null;
  }

  nextHourPrecipTimeline(periods, supplemental) {
    const minutelyAnchors = this.precipMinutelyAnchors(supplemental);
    if (minutelyAnchors.length) return this.interpolatePrecipAnchors(minutelyAnchors);
    const chanceAnchors = periods.slice(0, 2).map((period) => this.precipValue(period, supplemental));
    const amountAnchors = this.precipAmountAnchors(supplemental);
    const anchors = amountAnchors.length ? amountAnchors : chanceAnchors.map((chance) => ({ chance, amount: null }));
    if (!anchors.length) return [];
    return this.interpolatePrecipAnchors(anchors);
  }

  interpolatePrecipAnchors(anchors) {
    const values = [];
    for (let index = 0; index < 21; index += 1) {
      const position = (index / 20) * Math.max(1, anchors.length - 1);
      const leftIndex = Math.floor(position);
      const rightIndex = Math.min(anchors.length - 1, leftIndex + 1);
      const blend = position - leftIndex;
      const chance = anchors[leftIndex].chance + (anchors[rightIndex].chance - anchors[leftIndex].chance) * blend;
      const amount = anchors[leftIndex].amount === null || anchors[rightIndex].amount === null
        ? null
        : anchors[leftIndex].amount + (anchors[rightIndex].amount - anchors[leftIndex].amount) * blend;
      values.push({ chance: Math.round(chance), amount });
    }
    return values;
  }

  precipMinutelyAnchors(supplemental) {
    const chances = supplemental?.minutelyPrecipChances || [];
    const totals = (supplemental?.minutelyPrecipAmounts || []).map((value, index) => {
      const amount = this.firstNumber(value, supplemental?.minutelyRain?.[index], supplemental?.minutelyShowers?.[index], supplemental?.minutelySnowfall?.[index]);
      return amount ?? 0;
    });
    const count = Math.min(5, Math.max(chances.length, totals.length));
    const anchors = [];
    for (let index = 0; index < count; index += 1) {
      const chance = this.numberOrNull(chances[index]) ?? 0;
      const amount = this.numberOrNull(totals[index]) ?? 0;
      anchors.push({ chance, amount });
    }
    return anchors.some((item) => item.chance >= PRECIP_DISPLAY_THRESHOLD || item.amount >= 0.001) ? anchors : [];
  }

  precipAmountAnchors(supplemental) {
    const currentAmount = this.firstNumber(supplemental?.precipitationAmount, supplemental?.rain, supplemental?.showers, supplemental?.snowfall);
    const hourlyAmounts = supplemental?.hourlyPrecipAmounts || [];
    const amounts = [
      currentAmount ?? hourlyAmounts[0] ?? 0,
      hourlyAmounts[1] ?? hourlyAmounts[0] ?? currentAmount ?? 0
    ].map((value) => this.numberOrNull(value) ?? 0);
    if (!amounts.some((amount) => amount >= 0.001)) return [];
    const chances = supplemental?.hourlyPrecipChances || [];
    return amounts.slice(0, 2).map((amount, index) => ({
      chance: this.numberOrNull(chances[index]) ?? this.numberOrNull(supplemental?.precipChance) ?? 0,
      amount
    }));
  }

  readTemperature(value) {
    if (typeof value !== "number") return null;
    return Math.round((value * 9) / 5 + 32);
  }

  readTemperatureLabel(value, fallbackFahrenheit) {
    const temp = this.readTemperature(value);
    const fallback = this.numberOrNull(fallbackFahrenheit);
    return temp === null ? this.formatMaybeTemp(fallback) : `${temp}\u00B0`;
  }

  readPercent(value) {
    return typeof value === "number" ? `${Math.round(value)}%` : "--";
  }

  readHumidity(observation, supplemental, period) {
    const nwsHumidity = this.isFreshObservation(observation) ? this.numberOrNull(observation?.properties?.relativeHumidity?.value) : null;
    const fallbackHumidity = this.numberOrNull(supplemental?.humidity);
    const validHumidity = [nwsHumidity, fallbackHumidity].find((value) => Number.isFinite(value) && value > 0 && value <= 100);
    if (Number.isFinite(validHumidity)) return `${Math.round(validHumidity)}%`;
    return "0%";
  }

  readObservedWind(observation) {
    if (!this.isFreshObservation(observation)) return "";
    const speedMeters = this.numberOrNull(observation?.properties?.windSpeed?.value);
    const directionDegrees = this.numberOrNull(observation?.properties?.windDirection?.value);
    if (speedMeters === null) return "";
    const mph = Math.max(0, Math.round(speedMeters * 2.236936));
    return [this.windDirectionLabel(directionDegrees), `${mph} mph`].filter(Boolean).join(" ");
  }

  dewPointFahrenheit(observation, supplemental) {
    const observedDewPoint = this.isFreshObservation(observation)
      ? this.readTemperature(observation?.properties?.dewpoint?.value)
      : null;
    return this.firstNumber(
      observedDewPoint,
      supplemental?.dewPoint
    );
  }

  isFreshObservation(observation) {
    const timestamp = observation?.properties?.timestamp;
    if (!timestamp) return false;
    const observedAt = new Date(timestamp).getTime();
    if (!Number.isFinite(observedAt)) return false;
    return Date.now() - observedAt <= 90 * 60 * 1000;
  }

  dewPointComfortLabel(value) {
    const dewPoint = this.numberOrNull(value);
    if (dewPoint === null) return "";
    if (dewPoint >= 75) return "Miserable";
    if (dewPoint >= 70) return "Oppressive";
    if (dewPoint >= 65) return "Muggy";
    if (dewPoint >= 60) return "Sticky";
    if (dewPoint >= 50) return "Pleasant";
    return "Dry";
  }

  dewPointComfortTone(value) {
    const dewPoint = this.numberOrNull(value);
    if (dewPoint === null) return "";
    if (dewPoint >= 75) return "miserable";
    if (dewPoint >= 70) return "oppressive";
    if (dewPoint >= 65) return "muggy";
    if (dewPoint >= 60) return "sticky";
    if (dewPoint >= 50) return "pleasant";
    return "dry";
  }

  readDistance(value) {
    if (typeof value !== "number") return "--";
    return `${Math.round(value / 1609.344)} mi`;
  }

  readPressure(value) {
    if (typeof value !== "number") return "--";
    return `${(value / 3386.389).toFixed(2)} in`;
  }

  readPressureWithFallback(nwsPascalValue, fallbackHpaValue) {
    if (typeof nwsPascalValue === "number") return this.readPressure(nwsPascalValue);
    const hpa = this.numberOrNull(fallbackHpaValue);
    if (hpa === null) return "--";
    return `${(hpa * 0.029529983).toFixed(2)} in`;
  }

  readPressureInHgWithFallback(nwsPascalValue, fallbackHpaValue) {
    if (typeof nwsPascalValue === "number") return `${(nwsPascalValue / 3386.389).toFixed(2)} inHg`;
    return this.formatPressureInHg(fallbackHpaValue);
  }

  observationPressureHpa(observation) {
    const pascals = this.numberOrNull(observation?.properties?.barometricPressure?.value);
    return pascals === null ? null : pascals / 100;
  }

  currentPressureHpa(observation, supplemental) {
    return this.firstNumber(this.observationPressureHpa(observation), supplemental?.pressure);
  }

  formatPressureInHg(value) {
    const hpa = this.numberOrNull(value);
    if (hpa === null) return "--";
    return `${(hpa * 0.029529983).toFixed(2)} inHg`;
  }

  pressureTrend(currentValue, previousValue) {
    const current = this.numberOrNull(currentValue);
    const previous = this.numberOrNull(previousValue);
    if (current === null || previous === null) return "Steady";
    const delta = current - previous;
    if (delta >= 1) return "Rising";
    if (delta <= -1) return "Falling";
    return "Steady";
  }

  pressureTrendFromHistory(location, observation, supplemental) {
    const current = this.currentPressureHpa(observation, supplemental);
    if (current === null) return "Steady";
    const now = Date.now();
    const key = `${Number(location.lat).toFixed(2)},${Number(location.lon).toFixed(2)}`;
    let cache = {};
    try {
      cache = JSON.parse(localStorage.getItem(PRESSURE_HISTORY_STORAGE_KEY) || "{}");
    } catch {
      cache = {};
    }
    const history = Array.isArray(cache[key]) ? cache[key] : [];
    const recent = [...history, { time: now, value: current }]
      .filter((item) => now - Number(item.time) <= 4 * 60 * 60 * 1000)
      .sort((a, b) => a.time - b.time);
    cache[key] = recent;
    try {
      localStorage.setItem(PRESSURE_HISTORY_STORAGE_KEY, JSON.stringify(cache));
    } catch {
      // Pressure history is a convenience label only.
    }
    const findPrevious = (minimumAgeMs) => {
      for (let index = recent.length - 1; index >= 0; index -= 1) {
        if (now - recent[index].time >= minimumAgeMs) return recent[index];
      }
      return null;
    };
    const target = findPrevious(3 * 60 * 60 * 1000) || findPrevious(60 * 60 * 1000) || recent[0];
    if (!target || target.time === now) return "Steady";
    return this.pressureTrend(current, target.value);
  }

  dayWindLabel(wind, direction, gusts) {
    const speed = String(wind || "0 mph").trim();
    const dir = String(direction || "").trim();
    const gustText = String(gusts || "").replace(/^Gusts\s*/i, "").trim();
    const base = [speed, dir].filter(Boolean).join(" ");
    return gustText && gustText !== "0 mph" ? `${base} (Gusts up to ${gustText})` : base;
  }

  readWindGust(period, supplemental, observation = null) {
    if (this.isFreshObservation(observation)) {
      const observedGust = this.numberOrNull(observation?.properties?.windGust?.value);
      if (observedGust !== null) return `${Math.round(observedGust * 2.236936)} mph`;
    }
    const gust = this.numberOrNull(supplemental?.windGusts);
    if (gust !== null) return `${Math.round(gust)} mph`;
    const textGust = this.gustFromText(`${period?.detailedForecast || ""} ${period?.shortForecast || ""}`);
    return textGust || "0 mph";
  }

  windFromText(text = "") {
    const match = text.match(/(?:north|south|east|west|northeast|northwest|southeast|southwest|[NSEW]{1,3})\s+wind\s+(?:around\s+)?(\d+(?:\s+to\s+\d+)?)\s*mph/i)
      || text.match(/wind\s+(?:around\s+)?(\d+(?:\s+to\s+\d+)?)\s*mph/i);
    return match ? `${match[1].replace(/\s+/g, " ")} mph` : "";
  }

  windDirectionFromText(text = "") {
    const match = text.match(/\b(north|south|east|west|northeast|northwest|southeast|southwest|N|NE|E|SE|S|SW|W|NW|NNE|ENE|ESE|SSE|SSW|WSW|WNW|NNW)\s+wind\b/i);
    if (!match) return "";
    const value = match[1].toLowerCase();
    const labels = {
      north: "N",
      south: "S",
      east: "E",
      west: "W",
      northeast: "NE",
      northwest: "NW",
      southeast: "SE",
      southwest: "SW"
    };
    return labels[value] || match[1].toUpperCase();
  }

  gustFromText(text = "") {
    const match = text.match(/gusts? (?:as high as |up to )?(\d+)\s*mph/i);
    return match ? `${match[1]} mph` : "";
  }

  formatMaybeTemp(value) {
    const temp = this.numberOrNull(value);
    return temp === null ? "--" : `${Math.round(temp)}\u00B0`;
  }

  formatInches(value) {
    const amount = this.numberOrNull(value);
    if (amount === null || amount <= 0) return "";
    return amount < 0.01 ? "<0.01 in" : `${amount.toFixed(2)} in`;
  }

  formatOpenMeteoWind(supplemental) {
    const speed = this.numberOrNull(supplemental?.windSpeed);
    if (speed === null) return "";
    return `${this.windDirectionLabel(supplemental?.windDirection)} ${Math.round(speed)} mph`.trim();
  }

  windDirectionLabel(degrees) {
    const value = this.numberOrNull(degrees);
    if (value === null) return "";
    const labels = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
    return labels[Math.round(value / 22.5) % 16];
  }

  formatSunTime(value) {
    if (!value) return "--";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "--";
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  feelsLikeFromText(text, low, high) {
    const heatIndex = text.match(/heat index values? (?:as high as|up to|near) (-?\d+)/i)?.[1];
    if (heatIndex) return `Up to ${Math.round(Number(heatIndex))}\u00B0`;
    const windChill = text.match(/wind chill values? (?:as low as|down to|near) (-?\d+)/i)?.[1];
    if (windChill) return `Down to ${Math.round(Number(windChill))}\u00B0`;
    const windChillRange = text.match(/wind chill values? (?:between|from) (-?\d+)\s*(?:and|to|-)\s*(-?\d+)/i);
    if (windChillRange) {
      const lowChill = Math.min(Number(windChillRange[1]), Number(windChillRange[2]));
      return `Down to ${Math.round(lowChill)}\u00B0`;
    }
    return `${this.formatMaybeTemp(low)} - ${this.formatMaybeTemp(high)}`;
  }

  precipAmountFromText(text) {
    const amountContext = /(?:rainfall|rain|precip(?:itation)?|snow|sleet|ice)(?:\s+\w+){0,4}\s+(?:amounts?|accumulation|total|totals?)/i;
    if (!amountContext.test(text)) return "";
    if (/less than (?:a )?tenth/i.test(text)) return "<0.10 in";

    const wordRange = text.match(/between (?:a |an )?([a-z]+)(?:\s+of an?)? and (?:a |an )?([a-z]+)(?:\s+of an?)? inch/i);
    if (wordRange) {
      const first = this.precipFractionToInches(wordRange[1]);
      const second = this.precipFractionToInches(wordRange[2]);
      if (first && second) return `${Math.min(first, second).toFixed(2)} - ${Math.max(first, second).toFixed(2)} in`;
    }

    const wordSingle = text.match(/(?:around|near|up to|about)?\s*(?:a |an )?(tenth|quarter|half)(?:\s+of an?)? inch/i);
    if (wordSingle) {
      const amount = this.precipFractionToInches(wordSingle[1]);
      if (amount) return `${amount.toFixed(2)} in`;
    }

    const amount = text.match(/(?:rainfall|rain|precip(?:itation)?|snow|sleet|ice)(?:\s+\w+){0,5}\s+(?:amounts?|accumulation|total|totals?)\D{0,24}?(\d+(?:\.\d+)?)\s*(?:to|and|-)\s*(\d+(?:\.\d+)?)\s*in(?:ch|ches)?/i);
    if (amount) return `${amount[1]} - ${amount[2]} in`;
    const single = text.match(/(?:rainfall|rain|precip(?:itation)?|snow|sleet|ice)(?:\s+\w+){0,5}\s+(?:amounts?|accumulation|total|totals?)\D{0,24}?(\d+(?:\.\d+)?)\s*in(?:ch|ches)?/i);
    if (single) return `${single[1]} in`;
    return "";
  }

  precipFractionToInches(value = "") {
    const fractions = { tenth: 0.10, quarter: 0.25, half: 0.50 };
    return fractions[value.toLowerCase()] || 0;
  }

  currentCentralDayLabel() {
    return new Date().toLocaleDateString("en-US", { weekday: "short", timeZone: "America/Chicago" });
  }

  currentForecastDayLabel(startTime) {
    const offset = String(startTime || "").match(/([+-]\d{2}):?(\d{2})$/);
    if (!offset) return new Date().toLocaleDateString("en-US", { weekday: "short" });
    const sign = offset[1].startsWith("-") ? -1 : 1;
    const hours = Math.abs(Number(offset[1]));
    const minutes = Number(offset[2]);
    const shifted = new Date(Date.now() + sign * (hours * 60 + minutes) * 60 * 1000);
    return shifted.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  }

  dayLabel(value) {
    return new Date(value).toLocaleDateString([], { weekday: "short" });
  }

  dayTitle(value) {
    return new Date(value).toLocaleDateString([], { weekday: "long" });
  }

  dayNumber(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : String(date.getDate());
  }

  nightTitle(value) {
    return `${this.dayTitle(value)} Night`;
  }

  rangeWidth(low, high) {
    const lowTemp = this.numberOrNull(low);
    const highTemp = this.numberOrNull(high);
    if (lowTemp === null || highTemp === null) return 0;
    return Math.min(100, Math.max(35, Math.round(((highTemp - lowTemp) / 28) * 100)));
  }
}
const weatherService = new WeatherService();
const elements = {};
const safeNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const formatTemp = (value) => {
  const temp = safeNumber(value);
  return temp === null ? "--" : `${Math.round(temp)}\u00B0`;
};
const iconSrc = (icon) => `${ICON_PATH}${icon}`;
let currentLocation = loadSavedLocation();
let autoLocationEnabled = loadAutoLocationEnabled();
let morningNotificationPreference = loadMorningNotificationPreference();
let currentPollenDetails = [];
let currentHealthDetails = [];
let currentPollenNote = "";
let dashboardRequestId = 0;
let locationRequestId = 0;
let lastHourlyHours = [];
let lastDailyDays = [];
let activeDashboardData = null;
let activeHourlyIndex = 0;
let activeHourlyMetric = "precip";
let dailyLayoutMode = loadDailyLayoutMode();

function loadSavedLocation() {
  try {
    const saved = JSON.parse(localStorage.getItem(LOCATION_STORAGE_KEY));
    return isValidLocation(saved) ? saved : DEFAULT_LOCATION;
  } catch {
    return DEFAULT_LOCATION;
  }
}

function loadAutoLocationEnabled() {
  try {
    const saved = localStorage.getItem(AUTO_LOCATION_STORAGE_KEY);
    return saved === null ? true : saved === "true";
  } catch {
    return true;
  }
}

function saveAutoLocationEnabled(value) {
  autoLocationEnabled = Boolean(value);
  localStorage.setItem(AUTO_LOCATION_STORAGE_KEY, String(autoLocationEnabled));
}

function loadDailyLayoutMode() {
  try {
    return localStorage.getItem(DAILY_LAYOUT_STORAGE_KEY) === "horizontal" ? "horizontal" : "vertical";
  } catch {
    return "vertical";
  }
}

function saveDailyLayoutMode(value) {
  dailyLayoutMode = value === "horizontal" ? "horizontal" : "vertical";
  localStorage.setItem(DAILY_LAYOUT_STORAGE_KEY, dailyLayoutMode);
}

function loadMorningNotificationPreference() {
  try {
    const saved = JSON.parse(localStorage.getItem(MORNING_NOTIFICATION_STORAGE_KEY) || "{}");
    if (!saved || typeof saved !== "object") return { morningEnabled: false, severeAlertsEnabled: false, installationId: "", managementToken: "", subscriptionActive: false };
    return {
      morningEnabled: saved.morningEnabled === true || (saved.morningEnabled === undefined && saved.enabled === true),
      severeAlertsEnabled: saved.severeAlertsEnabled === true,
      installationId: typeof saved.installationId === "string" ? saved.installationId : "",
      managementToken: typeof saved.managementToken === "string" ? saved.managementToken : "",
      subscriptionActive: saved.subscriptionActive === true
    };
  } catch {
    return { morningEnabled: false, severeAlertsEnabled: false, installationId: "", managementToken: "", subscriptionActive: false };
  }
}

function saveMorningNotificationPreference(next) {
  const merged = { ...morningNotificationPreference, ...next };
  morningNotificationPreference = {
    ...merged,
    morningEnabled: merged.morningEnabled === true,
    severeAlertsEnabled: merged.severeAlertsEnabled === true,
    subscriptionActive: merged.subscriptionActive === true
  };
  localStorage.setItem(MORNING_NOTIFICATION_STORAGE_KEY, JSON.stringify(morningNotificationPreference));
}

function notificationsEnabled(preference = morningNotificationPreference) {
  return preference.morningEnabled === true || preference.severeAlertsEnabled === true;
}

function randomDeviceValue() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function ensureMorningNotificationIdentity() {
  if (!morningNotificationPreference.installationId || !morningNotificationPreference.managementToken) {
    saveMorningNotificationPreference({
      ...morningNotificationPreference,
      installationId: randomDeviceValue(),
      managementToken: randomDeviceValue(),
      morningEnabled: morningNotificationPreference.morningEnabled,
      severeAlertsEnabled: morningNotificationPreference.severeAlertsEnabled,
      subscriptionActive: morningNotificationPreference.subscriptionActive
    });
  }
  return morningNotificationPreference;
}

function pushNotificationsSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && "crypto" in window;
}

function urlBase64ToUint8Array(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const raw = atob(padded);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

async function notificationApi(path, options = {}) {
  const response = await fetch(`${NOTIFICATION_WORKER_URL}${path}`, {
    method: options.method || "GET",
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    const error = new Error(payload?.error || "Notification service unavailable.");
    error.status = response.status;
    throw error;
  }
  return payload;
}

function setMorningNotificationStatus(message) {
  if (elements.morningNotificationStatus) elements.morningNotificationStatus.textContent = message;
}

function syncMorningNotificationControls() {
  const permissionGranted = typeof Notification !== "undefined" && Notification.permission === "granted";
  const canTest = permissionGranted && morningNotificationPreference.subscriptionActive === true;
  if (elements.morningNotificationToggle) elements.morningNotificationToggle.checked = morningNotificationPreference.morningEnabled === true;
  if (elements.severeAlertsToggle) elements.severeAlertsToggle.checked = morningNotificationPreference.severeAlertsEnabled === true;
  if (elements.notificationAdvanced) elements.notificationAdvanced.hidden = !(canTest && notificationsEnabled());
  if (elements.notificationTestControl) elements.notificationTestControl.hidden = !(canTest && morningNotificationPreference.morningEnabled);
  if (elements.severeAlertTestControl) elements.severeAlertTestControl.hidden = !(canTest && morningNotificationPreference.severeAlertsEnabled);
  if (elements.sendTestNotification) elements.sendTestNotification.disabled = !(canTest && morningNotificationPreference.morningEnabled);
  if (elements.sendActiveNwsAlertTestNotification) elements.sendActiveNwsAlertTestNotification.disabled = !(canTest && morningNotificationPreference.severeAlertsEnabled);
}

async function refreshMorningNotificationState() {
  if (!pushNotificationsSupported()) {
    if (notificationsEnabled()) saveMorningNotificationPreference({ ...morningNotificationPreference, morningEnabled: false, severeAlertsEnabled: false, subscriptionActive: false });
    syncMorningNotificationControls();
    return false;
  }
  if (Notification.permission !== "granted") {
    if (notificationsEnabled()) saveMorningNotificationPreference({ ...morningNotificationPreference, morningEnabled: false, severeAlertsEnabled: false, subscriptionActive: false });
    syncMorningNotificationControls();
    return false;
  }
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    const active = Boolean(subscription);
    if (morningNotificationPreference.subscriptionActive !== active) {
      saveMorningNotificationPreference({ ...morningNotificationPreference, subscriptionActive: active });
    }
    syncMorningNotificationControls();
    return active;
  } catch {
    syncMorningNotificationControls();
    return false;
  }
}

async function enableNotificationPreferences(nextPreferences) {
  if (!pushNotificationsSupported()) {
    setMorningNotificationStatus("Notifications are not supported on this device.");
    saveMorningNotificationPreference({ ...nextPreferences, subscriptionActive: false });
    syncMorningNotificationControls();
    return;
  }

  setMorningNotificationStatus("Updating notifications...");
  let createdSubscription = false;
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("Notification permission was not granted.");
    const config = await notificationApi("/api/notifications/config");
    if (!config?.vapidPublicKey) throw new Error("Notification configuration is unavailable.");
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey)
      });
      createdSubscription = true;
    }
    const identity = ensureMorningNotificationIdentity();
    const location = await locationForDashboard();
    await notificationApi("/api/notifications/subscribe", {
      method: "POST",
      body: {
        installationId: identity.installationId,
        managementToken: identity.managementToken,
        subscription: subscription.toJSON(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Chicago",
        location: { lat: Number(location.lat), lon: Number(location.lon) },
        morningEnabled: nextPreferences.morningEnabled === true,
        severeAlertsEnabled: nextPreferences.severeAlertsEnabled === true
      }
    });
    saveMorningNotificationPreference({ ...identity, ...nextPreferences, subscriptionActive: true });
    setMorningNotificationStatus("Notification preferences updated.");
  } catch (error) {
    console.warn("Notification setup failed.", error);
    if (createdSubscription) {
      try {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        await subscription?.unsubscribe();
      } catch {}
    }
    saveMorningNotificationPreference({ ...morningNotificationPreference, subscriptionActive: false });
    setMorningNotificationStatus("Unable to update notifications.");
  }
  syncMorningNotificationControls();
}

async function disableAllNotifications() {
  setMorningNotificationStatus("Turning notifications off...");
  try {
    const identity = ensureMorningNotificationIdentity();
    await notificationApi("/api/notifications/unsubscribe", {
      method: "POST",
      body: { installationId: identity.installationId, managementToken: identity.managementToken }
    });
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    await subscription?.unsubscribe();
    saveMorningNotificationPreference({ ...identity, morningEnabled: false, severeAlertsEnabled: false, subscriptionActive: false });
    setMorningNotificationStatus("Notifications are off.");
  } catch (error) {
    console.warn("Morning notification removal failed.", error);
    setMorningNotificationStatus("Unable to turn off notifications.");
  }
  syncMorningNotificationControls();
}

async function handleMorningNotificationToggle() {
  const nextPreferences = { ...morningNotificationPreference, morningEnabled: elements.morningNotificationToggle?.checked === true };
  if (notificationsEnabled(nextPreferences)) await enableNotificationPreferences(nextPreferences);
  else await disableAllNotifications();
}

async function handleSevereAlertsToggle() {
  const nextPreferences = { ...morningNotificationPreference, severeAlertsEnabled: elements.severeAlertsToggle?.checked === true };
  if (notificationsEnabled(nextPreferences)) await enableNotificationPreferences(nextPreferences);
  else await disableAllNotifications();
}

async function sendTestNotification() {
  if (!morningNotificationPreference.morningEnabled || !morningNotificationPreference.subscriptionActive) return;
  setMorningNotificationStatus("Sending test...");
  if (elements.sendTestNotification) elements.sendTestNotification.disabled = true;
  try {
    const identity = ensureMorningNotificationIdentity();
    await notificationApi("/api/notifications/test", {
      method: "POST",
      body: { installationId: identity.installationId, managementToken: identity.managementToken }
    });
    setMorningNotificationStatus("Test notification sent.");
  } catch (error) {
    console.warn("Test notification failed.", error);
    setMorningNotificationStatus(error?.status === 429
      ? "Please wait a minute before sending another test."
      : "Unable to send test notification.");
  }
  syncMorningNotificationControls();
}

async function sendActiveNwsAlertTestNotification() {
  if (!morningNotificationPreference.severeAlertsEnabled || !morningNotificationPreference.subscriptionActive) return;
  setMorningNotificationStatus("Finding an active NWS alert...");
  if (elements.sendActiveNwsAlertTestNotification) elements.sendActiveNwsAlertTestNotification.disabled = true;
  try {
    const identity = ensureMorningNotificationIdentity();
    await notificationApi("/api/notifications/severe-alerts/active-test", {
      method: "POST",
      body: { installationId: identity.installationId, managementToken: identity.managementToken }
    });
    setMorningNotificationStatus("Active NWS alert test sent.");
  } catch (error) {
    console.warn("Active NWS alert test failed.", error);
    setMorningNotificationStatus(error?.status === 404
      ? "No active supported NWS alert is available for testing."
      : error?.status === 429
        ? "Please wait a minute before sending another test."
        : "Unable to send active NWS alert test.");
  }
  syncMorningNotificationControls();
}

function isValidLocation(location) {
  if (!location || typeof location !== "object") return false;
  if (!String(location.label || "").trim()) return false;
  return Number.isFinite(Number(location.lat)) && Number.isFinite(Number(location.lon));
}

function deviceLocationSupported() {
  return Boolean(navigator.geolocation?.getCurrentPosition);
}

function getDeviceLocation() {
  if (!autoLocationEnabled || !deviceLocationSupported()) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const lat = safeNumber(position.coords?.latitude);
        const lon = safeNumber(position.coords?.longitude);
        if (lat === null || lon === null) {
          resolve(null);
          return;
        }
        resolve({
          label: "Current Location",
          query: currentLocation.query || currentLocation.label,
          city: "",
          state: "",
          lat: lat.toFixed(4),
          lon: lon.toFixed(4),
          isDeviceLocation: true
        });
      },
      () => resolve(null),
      { enableHighAccuracy: false, maximumAge: 10 * 60 * 1000, timeout: 8000 }
    );
  });
}

async function locationForDashboard() {
  if (!autoLocationEnabled) return isValidLocation(currentLocation) ? currentLocation : DEFAULT_LOCATION;
  const detectedLocation = await getDeviceLocation();
  return isValidLocation(detectedLocation) ? detectedLocation : (isValidLocation(currentLocation) ? currentLocation : DEFAULT_LOCATION);
}

function saveLocation(location) {
  const safeLocation = isValidLocation(location) ? location : DEFAULT_LOCATION;
  currentLocation = safeLocation;
  localStorage.setItem(LOCATION_STORAGE_KEY, JSON.stringify(safeLocation));
  setText("locationLabel", safeLocation.label);
}

function windyUrl(location, zoom = 9) {
  const safeLocation = isValidLocation(location) ? location : DEFAULT_LOCATION;
  const lat = Number(safeLocation.lat).toFixed(4);
  const lon = Number(safeLocation.lon).toFixed(4);
  return `https://embed.windy.com/embed2.html?lat=${lat}&lon=${lon}&detailLat=${lat}&detailLon=${lon}&zoom=${zoom}&level=surface&overlay=radar&product=radar&menu=&message=true&marker=true&calendar=12&pressure=&type=map&location=coordinates&detail=&metricWind=mph&metricTemp=%C2%B0F&metricRain=in&radarRange=-1`;
}

function updateRadarLocation(location) {
  const previewSrc = windyUrl(location, 9);
  const fullSrc = windyUrl(location, 10);
  if (elements.radarPreviewFrame?.getAttribute("src") !== previewSrc) elements.radarPreviewFrame.src = previewSrc;
  if (elements.radarFrame?.getAttribute("src") !== fullSrc) elements.radarFrame.src = fullSrc;
  setText("radarPreviewLabel", `Windy radar centered on ${location.label}`);
  setText("radarPanelLabel", `Clean live radar view for ${location.label}.`);
}

function cacheElements() {
  [
    "pullRefresh", "locationLabel", "appClock", "settingsToggle", "settingsPanel", "settingsClose", "locationForm", "locationInput", "locationStatus", "autoLocationToggle", "dailyLayoutToggle", "morningNotificationToggle", "severeAlertsToggle", "notificationAdvanced", "notificationTestControl", "severeAlertTestControl", "sendTestNotification", "sendActiveNwsAlertTestNotification", "morningNotificationStatus",
    "currentCard", "currentTemp", "currentIcon", "allergenAlerts",
    "condition", "outlookIcon", "feelsLike", "currentStats", "detailsGrid", "precipCard", "precipIcon", "precipSummary", "precipAmounts", "alertCard",
    "alertHeadline", "alertBody", "alertDetails", "hourlyForecast", "hourlyPrecipToggle", "hourlyWindToggle", "dailyForecast",
    "expandedWeather", "currentNarrative", "radarPreviewCard", "radarPreviewFrame", "radarFrame", "radarPreviewLabel", "radarPanelLabel", "radarToggle", "radarPanel", "radarClose", "radarTime",
    "pollenPanel", "pollenClose", "pollenList", "pollenSummary"
  ].forEach((id) => {
    elements[id] = document.getElementById(id);
  });
}

function setText(id, value) {
  if (elements[id]) elements[id].textContent = value;
}

function setIcon(element, icon, label = "") {
  element.src = iconSrc(icon);
  element.alt = label;
}

function updateClock() {
  const time = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  setText("appClock", time);
  setText("radarTime", time);
}

function renderCurrentWeather(data) {
  setText("currentTemp", formatTemp(data.current.temperature));
  setIcon(elements.currentIcon, data.current.icon, data.current.condition);
  setIcon(elements.outlookIcon, data.current.icon, "");
  setText("condition", data.current.condition);
  setText("feelsLike", formatTemp(data.current.feelsLike));
  setText("currentNarrative", data.narrative);
}

function renderSummaryStats(stats) {
  elements.currentStats.replaceChildren();
  stats.forEach((item) => {
    const row = document.createElement("div");
    const icon = document.createElement("img");
    const text = document.createElement("span");
    const label = document.createElement("span");
    const valueWrap = document.createElement("span");
    const value = document.createElement("strong");
    row.className = ["stat-row", item.tone, item.className].filter(Boolean).join(" ");
    text.className = "stat-label";
    valueWrap.className = "stat-value";
    if (item.status && !item.subvalue && item.inlineStatus) valueWrap.classList.add("inline-status");
    if (item.inlineDetail) valueWrap.classList.add("inline-detail");
    setIcon(icon, item.icon || "weather-cloud.svg", "");
    label.textContent = item.label;
    value.textContent = item.value;
    if (!item.label) {
      text.append(icon);
    } else if (item.subLabel) {
      const labelStack = document.createElement("span");
      const subLabel = document.createElement("small");
      labelStack.className = "stat-label-stack";
      subLabel.className = "stat-sublabel";
      subLabel.textContent = item.subLabel;
      labelStack.append(label, subLabel);
      text.append(icon, labelStack);
    } else {
      text.append(icon, label);
    }
    if (!item.statusOnly) valueWrap.appendChild(value);
    if (item.subvalue || item.status) {
      const detail = document.createElement("small");
      detail.className = "stat-detail-line";
      if (item.subvalue) {
        const subvalue = document.createElement("span");
        subvalue.textContent = item.subvalue;
        detail.appendChild(subvalue);
      }
      if (item.status) {
        const status = document.createElement("span");
        status.className = item.statusTone ? `dew-status ${item.statusTone}` : "";
        status.textContent = item.status;
        detail.appendChild(status);
      }
      valueWrap.appendChild(detail);
    }
    row.append(text, valueWrap);
    elements.currentStats.appendChild(row);
  });
}

function renderDetails(details, options = {}) {
  elements.detailsGrid.replaceChildren();
  currentPollenDetails = [];
  currentHealthDetails = [];
  currentPollenNote = "";
  details.forEach((item) => {
    const card = document.createElement("article");
    const icon = document.createElement("img");
    const label = document.createElement("span");
    const value = document.createElement("span");
    card.className = item.type === "sun" ? "quick-item sun-card" : "quick-item";
    if (item.wide) card.classList.add("is-wide");
    label.className = "quick-label";
    value.className = "quick-value";
    setIcon(icon, item.icon, "");
    label.textContent = item.label;
    if (item.type === "sun") {
      const times = document.createElement("div");
      times.className = "sun-times";
      times.innerHTML = `<div><span>Sunrise</span><strong>${item.sunrise}</strong></div><div><span>Sunset</span><strong>${item.sunset}</strong></div>`;
      value.textContent = item.value;
      card.append(icon, label, value, times);
    } else if (item.type === "pollen") {
      currentPollenDetails = item.details || [];
      currentHealthDetails = item.health || [];
      currentPollenNote = item.note || "";
      card.classList.add("is-clickable");
      card.setAttribute("role", "button");
      card.setAttribute("tabindex", "0");
      card.setAttribute("aria-label", "Open pollen and allergen details");
      value.textContent = item.value;
      card.append(icon, label, value);
      card.addEventListener("click", (event) => {
        event.stopPropagation();
        renderPollenPanel();
        togglePollen(true);
      });
      card.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        renderPollenPanel();
        togglePollen(true);
      });
    } else {
      value.textContent = item.value;
      if (item.status) card.classList.add("has-status");
      if (item.status) {
        const status = document.createElement("span");
        status.className = item.statusTone ? `dew-status ${item.statusTone}` : "dew-status";
        status.textContent = item.status;
        value.appendChild(status);
      }
      card.append(icon, label, value);
    }
    elements.detailsGrid.appendChild(card);
  });
  if (!options.preserveAllergenAlerts) renderAllergenAlerts(currentPollenDetails, currentHealthDetails);
}

function detailsByLabel(details = []) {
  return new Map((Array.isArray(details) ? details : []).map((item) => [item.label, item]));
}

function hourlyDetailCards(hour, baseDetails = []) {
  if (!hour) return Array.isArray(baseDetails) ? baseDetails : [];
  const base = detailsByLabel(baseDetails);
  const baseWind = base.get("Wind");
  const baseGust = base.get("Wind Gust");
  const baseHumidity = base.get("Humidity");
  const baseDewPoint = base.get("Dew Point");
  const dewPoint = safeNumber(hour.dewPoint);
  const dewStatus = weatherService.dewPointComfortLabel(dewPoint);
  const dewTone = weatherService.dewPointComfortTone(dewPoint);
  const fallbackItem = (label) => base.get(label);
  const cards = [
    { icon: "wind.svg", label: "Wind", value: [hour.windDirection, hour.wind || baseWind?.value || "0 mph"].filter(Boolean).join(" ").trim() },
    { icon: "wind.svg", label: "Wind Gust", value: hour.windGust || baseGust?.value || "0 mph" },
    { icon: "humidity.svg", label: "Humidity", value: hour.humidity || baseHumidity?.value || "0%" },
    {
      icon: "humidity.svg",
      label: "Dew Point",
      value: hour.dewPointLabel || baseDewPoint?.value || "--",
      status: dewStatus || baseDewPoint?.status || "",
      statusTone: dewTone || baseDewPoint?.statusTone || ""
    },
    { ...(fallbackItem("Air Quality") || { icon: "aqi.svg", label: "Air Quality", value: "Checking" }) },
    { icon: "uv.svg", label: "UV Index", value: hour.uvIndex || fallbackItem("UV Index")?.value || "0 Low" },
    { ...(fallbackItem("Cloud Cover") || { icon: "weather-cloud.svg", label: "Cloud Cover", value: "0%" }) },
    { ...(fallbackItem("Visibility") || { icon: "visibility.svg", label: "Visibility", value: "10 mi" }) },
    { ...(fallbackItem("Barometric Pressure") || { icon: "pressure.svg", label: "Barometric Pressure", value: "0 inHg (Steady)" }) },
    { ...(fallbackItem("Sunrise") || { icon: "sunrise.svg", label: "Sunrise", value: "--" }) },
    { ...(fallbackItem("Sunset") || { icon: "sunrise.svg", label: "Sunset", value: "--" }) },
    { ...(fallbackItem("Pollen & Allergens") || { icon: "pollen.svg", label: "Pollen & Allergens", value: "View Details", type: "pollen", details: [], health: [] }) }
  ];
  return cards;
}

function renderAllergenAlerts(pollenDetails = [], healthDetails = []) {
  const highItems = [...pollenDetails, ...healthDetails]
    .filter((item) => ["High", "Very High", "Extreme"].includes(item.category))
    .slice(0, 10);

  elements.allergenAlerts.replaceChildren();
  elements.allergenAlerts.hidden = highItems.length === 0;
  if (!highItems.length) return;

  highItems.forEach((item) => {
    const badge = document.createElement("span");
    const icon = document.createElement("img");
    const name = document.createElement("span");
    const severity = document.createElement("strong");
    badge.className = `allergen-badge ${item.category.toLowerCase().replace(/\s+/g, "-")}`;
    badge.title = `${item.label}: ${item.category}`;
    badge.setAttribute("aria-label", `${item.label}: ${item.category}`);
    setIcon(icon, item.icon || "pollen.svg", "");
    name.textContent = shortAllergenLabel(item.label);
    severity.textContent = item.category;
    badge.append(icon, name, severity);
    elements.allergenAlerts.appendChild(badge);
  });
}

function shortAllergenLabel(label = "") {
  return label
    .replace(" Pollen", "")
    .replace(" Allergy Risk", "")
    .replace("Outdoor ", "")
    .replace("Dust & Dander", "Dander")
    .replace("Sinus Pressure", "Sinus")
    .replace("Common Cold", "Cold");
}

function renderPollenPanel() {
  elements.pollenList.replaceChildren();
  if (elements.pollenSummary) {
    elements.pollenSummary.hidden = !currentPollenNote;
    elements.pollenSummary.textContent = currentPollenNote;
  }
  const details = currentPollenDetails.length ? currentPollenDetails : [
    { label: "Tree Pollen", value: 0, category: "Low" },
    { label: "Ragweed Pollen", value: 0, category: "Low" },
    { label: "Grass Pollen", value: 0, category: "Low" },
    { label: "Mold", value: 0, category: "Low" },
    { label: "Dust & Dander", value: 0, category: "Low" },
    { label: "Weed Pollen", value: 0, category: "Low" }
  ];
  const health = currentHealthDetails.length ? currentHealthDetails : [
    { label: "Arthritis", value: 0, category: "Low" },
    { label: "Sinus Pressure", value: 0, category: "Low" },
    { label: "Common Cold", value: 0, category: "Low" },
    { label: "Flu", value: 0, category: "Low" },
    { label: "Migraine", value: 0, category: "Low" },
    { label: "Asthma", value: 0, category: "Low" }
  ];

  elements.pollenList.append(
    renderPollenSection("Allergies", details),
    renderPollenSection("Health", health)
  );
}

function renderPollenSection(titleText, items) {
  const section = document.createElement("section");
  const title = document.createElement("h3");
  const grid = document.createElement("div");
  section.className = "pollen-section";
  title.textContent = titleText;
  grid.className = "pollen-card-grid";
  items.forEach((item) => grid.appendChild(renderPollenCard(item)));
  section.append(title, grid);
  return section;
}

function renderPollenCard(item) {
  const card = document.createElement("article");
  const icon = document.createElement("img");
  const label = document.createElement("strong");
  const value = document.createElement("span");
  card.className = `pollen-card ${item.category.toLowerCase().replace(/\s+/g, "-")}`;
  setIcon(icon, item.icon || "pollen.svg", "");
  label.textContent = item.label;
  value.textContent = item.value === null || item.value === undefined || item.value === ""
    ? item.category
    : `${Number(item.value).toLocaleString()} ${item.category}`.trim();
  card.append(icon, label, value);
  const species = Array.isArray(item.elevatedSpecies) && item.elevatedSpecies.length
    ? item.elevatedSpecies
    : Array.isArray(item.activeSpecies) ? item.activeSpecies : [];
  const visibleSpecies = species.filter((speciesItem) => speciesItem?.name && speciesItem?.riskLevel).slice(0, 6);
  if (visibleSpecies.length) {
    const speciesList = document.createElement("ul");
    speciesList.className = "pollen-species-list";
    visibleSpecies.forEach((speciesItem) => {
      const speciesRow = document.createElement("li");
      speciesRow.textContent = `${speciesItem.name} - ${speciesItem.riskLevel}`;
      speciesList.appendChild(speciesRow);
    });
    card.appendChild(speciesList);
  }
  return card;
}

function hasActivePrecipitation(precipitation) {
  return Boolean(precipitation?.active);
}

function shouldShowPrecipPercent(value) {
  const chance = Number(String(value || "").replace("%", ""));
  return Number.isFinite(chance) && chance > 9;
}
function renderPrecipitation(precipitation) {
  if (!hasActivePrecipitation(precipitation)) {
    elements.precipCard.hidden = true;
    return;
  }

  elements.precipCard.hidden = false;
  setIcon(elements.precipIcon, precipitation.icon, "");
  setText("precipSummary", precipitation.summary);
  elements.precipAmounts.replaceChildren();

  elements.precipAmounts.appendChild(renderPrecipTimeline(precipitation));
}

function renderPrecipTimeline(precipitation) {
  const chart = document.createElement("div");
  const title = document.createElement("div");
  const plot = document.createElement("div");
  const scale = document.createElement("div");
  const bars = document.createElement("div");
  const labels = document.createElement("div");
  const values = normalizeTimeline(precipitation.timeline);

  chart.className = "precip-timeline";
  title.className = "precip-chart-title";
  scale.className = "precip-scale";
  plot.className = "precip-plot";
  bars.className = "precip-bars";
  labels.className = "precip-time-labels";
  title.textContent = precipTimelineTitle(precipitation, values);

  ["High", "Med", "Low", "Drizzle"].forEach((level) => {
    const label = document.createElement("span");
    label.textContent = level;
    scale.appendChild(label);
  });

  values.forEach((value) => {
    const bar = document.createElement("span");
    const displayValue = precipBarHeight(value, bars.childElementCount);
    bar.style.height = `${Math.max(0, Math.round(displayValue))}%`;
    bars.appendChild(bar);
  });

  ["Now", "10m", "20m", "30m", "40m", "50m"].forEach((time) => {
    const label = document.createElement("span");
    label.textContent = time;
    labels.appendChild(label);
  });

  plot.append(scale, bars, labels);
  chart.append(title, plot);
  return chart;
}

function precipTimelineTitle(precipitation, values) {
  const peakAmount = Math.max(...values.map((value) => value.amount || 0), 0);
  const peakChance = Math.max(...values.map((value) => value.chance || 0), 0);
  const type = precipitation.type || "Rain";
  const nowIntensity = precipIntensityFromAmount(values[0]?.amount || 0);
  const peakIntensity = precipIntensityFromAmount(peakAmount);
  const now = precipitation.current || "0% now";
  const next = precipitation.nextHour || "0% next hour";
  if (nowIntensity !== "Dry") {
    const label = nowIntensity === "Drizzle" ? "Drizzle now" : `${nowIntensity} ${type.toLowerCase()} now`;
    return `${label} / ${next}`;
  }
  if (peakIntensity !== "Dry") {
    const label = peakIntensity === "Drizzle" ? "drizzle possible next hour" : `${peakIntensity.toLowerCase()} ${type.toLowerCase()} possible next hour`;
    return `${now} / ${label}`;
  }
  if (peakChance >= 70) return `${now} / high chance next hour`;
  if (peakChance >= 40) return `${now} / med chance next hour`;
  if (peakChance >= PRECIP_DISPLAY_THRESHOLD) return `${now} / ${next}`;
  return `${now} / ${next}`;
}

function normalizeTimeline(values = []) {
  const timeline = values.length ? values : Array.from({ length: 21 }, () => 0);
  return timeline.slice(0, 21).map((value) => {
    const chanceValue = typeof value === "object" ? value.chance : value;
    const amountValue = typeof value === "object" ? value.amount : null;
    const chance = Math.max(0, Math.min(100, Number(chanceValue) || 0));
    const amount = amountValue === null || amountValue === undefined || amountValue === ""
      ? null
      : Math.max(0, Number(amountValue));
    return {
      chance: chance < PRECIP_DISPLAY_THRESHOLD ? 0 : chance,
      amount: Number.isFinite(amount) ? amount : null
    };
  });
}

function precipBarHeight(value, index) {
  if (value.amount !== null && value.amount >= 0.001) return precipAmountBarHeight(value.amount, index);
  if (value.chance < PRECIP_DISPLAY_THRESHOLD) return 0;
  const wave = Math.sin(index * 0.92) * 4 + Math.cos(index * 0.47) * 2;
  if (value.chance < 40) return Math.max(24, Math.min(44, value.chance + wave));
  if (value.chance < 70) return Math.max(45, Math.min(69, value.chance + wave));
  return Math.max(70, Math.min(100, value.chance + wave));
}

function precipIntensityFromAmount(amount) {
  if (amount < 0.001) return "Dry";
  if (amount < 0.01) return "Drizzle";
  if (amount < 0.10) return "Light";
  if (amount < 0.30) return "Moderate";
  return "Heavy";
}

function precipAmountBarHeight(amount, index) {
  if (amount < 0.001) return 0;
  const wave = Math.sin(index * 0.92) * 2.5 + Math.cos(index * 0.47) * 1.5;
  if (amount < 0.01) return Math.max(8, Math.min(22, 15 + wave));
  if (amount < 0.10) return Math.max(24, Math.min(44, 34 + wave));
  if (amount < 0.30) return Math.max(45, Math.min(69, 58 + wave));
  return Math.max(70, Math.min(100, 84 + wave));
}
function renderAlert(alert) {
  if (!alert) {
    elements.alertCard.hidden = true;
    elements.alertCard.setAttribute("aria-expanded", "false");
    elements.alertDetails.hidden = true;
    elements.alertDetails.replaceChildren();
    return;
  }
  elements.alertCard.hidden = false;
  elements.alertCard.setAttribute("aria-expanded", "false");
  setText("alertHeadline", alert.headline);
  setText("alertBody", alert.body);
  renderAlertDetails(alert);
  elements.alertDetails.hidden = true;
}

function renderAlertDetails(alert) {
  elements.alertDetails.replaceChildren();
  const sections = Array.isArray(alert?.sections) && alert.sections.length
    ? alert.sections
    : [{ title: alert?.headline || "Weather Alert", body: alert?.details || alert?.body || "" }];

  sections.forEach((section) => {
    const block = document.createElement("article");
    const title = document.createElement("h3");
    const body = document.createElement("p");
    block.className = "alert-detail-section";
    title.textContent = section.title || "Weather Alert";
    body.textContent = section.body || "";
    block.append(title, body);
    elements.alertDetails.appendChild(block);
  });
}

function formatHourLabel(date) {
  return date.toLocaleTimeString([], { hour: "numeric" }).replace(" ", "");
}

function getCurrentHourForecast(hours) {
  const now = new Date();
  return hours.map((hour, index) => {
    const displayTime = new Date(now);
    displayTime.setMinutes(0, 0, 0);
    displayTime.setHours(now.getHours() + index);
    return {
      ...hour,
      time: index === 0 ? "Now" : formatHourLabel(displayTime)
    };
  });
}

function parsePercentValue(value) {
  const parsed = Number(String(value || "0").replace("%", ""));
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 0;
}

function parseWindMph(value) {
  const speeds = String(value || "")
    .match(/\d+(?:\.\d+)?/g)
    ?.map(Number)
    .filter(Number.isFinite) || [];
  return speeds.length ? Math.round(Math.max(...speeds)) : 0;
}

function precipChartY(chance) {
  const value = parsePercentValue(chance);
  if (value <= 0) return 82;
  return Math.max(8, Math.min(82, 84 - (Math.pow(value, 0.7) * 3.05)));
}

function windChartY(speed, maxSpeed) {
  const value = Math.max(0, Number(speed) || 0);
  const max = Math.max(1, Number(maxSpeed) || 1);
  return Math.max(8, Math.min(82, 84 - ((value / max) * 68)));
}

function renderHourly(hours) {
  elements.hourlyForecast.replaceChildren();
  lastHourlyHours = Array.isArray(hours) ? hours : [];
  const chartHours = getCurrentHourForecast(lastHourlyHours).slice(0, 8);
  activeHourlyIndex = Math.max(0, Math.min(activeHourlyIndex, Math.max(0, chartHours.length - 1)));
  if (!chartHours.length) {
    const empty = document.createElement("p");
    empty.className = "hourly-empty";
    empty.textContent = "Hourly forecast is updating.";
    elements.hourlyForecast.appendChild(empty);
    return;
  }
  const temps = chartHours.map((hour) => safeNumber(hour.temp)).filter(Number.isFinite);
  const lowTemp = temps.length ? Math.min(...temps) : 0;
  const highTemp = temps.length ? Math.max(...temps) : 1;
  const tempRange = Math.max(1, highTemp - lowTemp);
  const chart = document.createElement("div");
  const svgNs = "http://www.w3.org/2000/svg";
  const precipLayer = document.createElement("div");
  const precipSvg = document.createElementNS(svgNs, "svg");
  const metricPoints = [];
  const maxWindSpeed = Math.max(1, ...chartHours.map((hour) => parseWindMph(hour.wind)));

  chart.className = "hourly-chart hourly-bar-chart";
  precipLayer.className = "hourly-precip-layer";
  precipSvg.classList.add("hourly-precip-line");
  precipSvg.setAttribute("viewBox", "0 0 100 100");
  precipSvg.setAttribute("preserveAspectRatio", "none");

  chartHours.forEach((hour, index) => {
    const column = document.createElement("div");
    const icon = document.createElement("img");
    const tempLabel = document.createElement("span");
    const graph = document.createElement("div");
    const tempBar = document.createElement("span");
    const time = document.createElement("span");
    const precip = document.createElement("span");
    const wind = document.createElement("span");
    const windDirection = document.createElement("span");
    const tempValue = safeNumber(hour.temp);
    const precipChance = parsePercentValue(hour.precip);
    const windSpeed = parseWindMph(hour.wind);
    const tempOffset = tempValue === null ? 44 : 18 + (1 - ((tempValue - lowTemp) / tempRange)) * 38;

    column.className = `hourly-column${index === activeHourlyIndex ? " is-active" : ""}`;
    column.setAttribute("role", "button");
    column.setAttribute("tabindex", "0");
    column.setAttribute("aria-pressed", index === activeHourlyIndex ? "true" : "false");
    column.setAttribute("aria-label", `${hour.time}, ${formatTemp(tempValue)}, precipitation ${precipChance}%, wind ${windSpeed} mph${hour.windDirection ? ` ${hour.windDirection}` : ""}`);
    graph.className = "hourly-column-graph";
    tempBar.className = "hourly-temp-bar";
    icon.className = "hourly-weather-icon";
    tempLabel.className = "hourly-temp-label";
    time.className = "hourly-time-label";
    precip.className = "hourly-precip-label";
    wind.className = "hourly-wind-label";
    windDirection.className = "hourly-wind-direction";

    tempLabel.textContent = formatTemp(tempValue);
    time.textContent = hour.time;
    precip.textContent = `${precipChance}%`;
    wind.textContent = `${windSpeed} mph`;
    windDirection.textContent = hour.windDirection || "";
    precip.hidden = activeHourlyMetric !== "precip";
    wind.hidden = activeHourlyMetric !== "wind";
    windDirection.hidden = activeHourlyMetric !== "wind";
    icon.src = iconSrc(hour.icon);
    icon.alt = "";
    tempBar.style.setProperty("--temp-top", `${tempOffset}%`);
    if (activeHourlyMetric === "wind" || precipChance > 0) {
      metricPoints.push({
        index,
        x: ((index + 0.5) / chartHours.length) * 100,
        y: activeHourlyMetric === "wind" ? windChartY(windSpeed, maxWindSpeed) : precipChartY(precipChance)
      });
    }

    column.addEventListener("click", (event) => {
      event.stopPropagation();
      setActiveHourly(index);
    });
    column.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      setActiveHourly(index);
    });

    graph.append(tempBar);
    column.append(time, icon, tempLabel, graph, precip, wind, windDirection);
    chart.appendChild(column);
  });

  if (metricPoints.length > 1) {
    for (let index = 1; index < metricPoints.length; index += 1) {
      const previous = metricPoints[index - 1];
      const current = metricPoints[index];
      if (current.index !== previous.index + 1) continue;
      const line = document.createElementNS(svgNs, "line");
      line.classList.add("hourly-precip-connector");
      if (activeHourlyMetric === "wind") line.classList.add("is-wind");
      line.setAttribute("x1", previous.x);
      line.setAttribute("y1", previous.y);
      line.setAttribute("x2", current.x);
      line.setAttribute("y2", current.y);
      line.setAttribute("vector-effect", "non-scaling-stroke");
      precipSvg.appendChild(line);
    }
  }

  metricPoints.forEach((point) => {
    const dot = document.createElement("span");
    dot.className = "hourly-precip-dot";
    if (activeHourlyMetric === "wind") dot.classList.add("is-wind");
    dot.style.setProperty("--precip-x", `${point.x}%`);
    dot.style.setProperty("--precip-y", `${point.y}%`);
    precipLayer.appendChild(dot);
  });

  chart.style.setProperty("--hour-count", chartHours.length);
  precipLayer.prepend(precipSvg);
  chart.appendChild(precipLayer);
  elements.hourlyForecast.appendChild(chart);
}

function setActiveHourly(index) {
  const chartHours = getCurrentHourForecast(lastHourlyHours).slice(0, 8);
  if (!chartHours.length) return;
  activeHourlyIndex = Math.max(0, Math.min(index, chartHours.length - 1));
  elements.hourlyForecast.querySelectorAll(".hourly-column").forEach((column, columnIndex) => {
    const isActive = columnIndex === activeHourlyIndex;
    column.classList.toggle("is-active", isActive);
    column.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
  if (activeDashboardData?.details) {
    renderDetails(hourlyDetailCards(chartHours[activeHourlyIndex], activeDashboardData.details), { preserveAllergenAlerts: true });
  }
}

function renderDaily(days) {
  lastDailyDays = Array.isArray(days) ? days : [];
  elements.dailyForecast.replaceChildren();
  elements.dailyForecast.classList.toggle("is-horizontal", dailyLayoutMode === "horizontal");
  const isHorizontal = dailyLayoutMode === "horizontal";
  const horizontalPanels = [];
  const lowValues = days.map((day) => safeNumber(day.low)).filter(Number.isFinite);
  const highValues = days.map((day) => safeNumber(day.high)).filter(Number.isFinite);
  const weekLow = lowValues.length ? Math.min(...lowValues) : null;
  const weekHigh = highValues.length ? Math.max(...highValues) : null;
  const hasRange = Number.isFinite(weekLow) && Number.isFinite(weekHigh);
  const weekRange = hasRange ? Math.max(1, weekHigh - weekLow) : 1;

  days.forEach((day, index) => {
    const card = document.createElement("article");
    const row = document.createElement("button");
    const dayName = document.createElement("span");
    const iconGroup = document.createElement("span");
    const icon = document.createElement("img");
    const precip = document.createElement("span");
    const designation = document.createElement("span");
    const iconLine = document.createElement("span");
    const condition = document.createElement("span");
    const low = document.createElement("span");
    const track = document.createElement("span");
    const high = document.createElement("span");
    const chevron = document.createElement("span");
    const detailPanel = renderDailyDetailPanel(day.details, index, day.designation);

    card.className = "daily-day-card";
    row.className = "daily-row";
    if (dailyLayoutMode === "horizontal") row.classList.add("daily-chart-day");
    row.type = "button";
    row.id = `dailyRow${index}`;
    row.style.animationDelay = `${index * 45}ms`;
    row.setAttribute("aria-expanded", "false");
    row.setAttribute("aria-controls", detailPanel.id);
    row.setAttribute("aria-label", `${day.day}, ${day.condition}, low ${formatTemp(day.low)}, high ${formatTemp(day.high)}, precipitation ${day.precip}`);
    dayName.className = "daily-day";
    iconGroup.className = "daily-icon-group";
    iconLine.className = "daily-icon-line";
    condition.className = "daily-condition";
    low.className = "daily-low";
    track.className = "daily-range";
    high.className = "daily-high";
    precip.className = "daily-rain";
    designation.className = "day-designation";
    chevron.className = "day-chevron";
    chevron.setAttribute("aria-hidden", "true");

    dayName.textContent = "";
    dayName.append(document.createTextNode(day.day));
    if (day.date) {
      const dayNumber = document.createElement("small");
      dayNumber.textContent = day.date;
      dayName.appendChild(dayNumber);
    }
    setIcon(icon, day.icon, "");
    if (day.designation?.level) {
      card.classList.add(`is-${day.designation.level}-day`);
      row.classList.add("has-designation");
      designation.textContent = day.designation.label;
      designation.classList.add(day.designation.level);
    } else {
      designation.hidden = true;
    }
    if (isHorizontal) {
      const precipParts = dailyPrecipParts(day);
      precip.replaceChildren();
      if (precipParts.percent) {
        const percent = document.createElement("span");
        percent.className = "daily-rain-percent";
        percent.textContent = precipParts.percent;
        precip.appendChild(percent);
      }
      if (precipParts.amount) {
        const amount = document.createElement("span");
        amount.className = "daily-rain-amount";
        appendDailyPrecipAmount(amount, precipParts.amount);
        precip.appendChild(amount);
      }
      precip.hidden = !precipParts.percent && !precipParts.amount;
    } else {
      precip.textContent = dailyPrecipText(day);
      precip.hidden = !dailyPrecipText(day);
    }
    condition.textContent = day.condition;
    iconLine.append(icon);
    if (!isHorizontal) iconLine.append(precip);
    iconGroup.append(iconLine, condition);
    low.textContent = formatTemp(day.low);
    const dayLow = safeNumber(day.low);
    const dayHigh = safeNumber(day.high);
    const hasDayRange = hasRange && dayLow !== null && dayHigh !== null;
    const rangeStart = hasDayRange ? Math.max(0, Math.min(100, ((dayLow - weekLow) / weekRange) * 100)) : 0;
    const rangeWidth = hasDayRange ? Math.max(6, Math.min(100 - rangeStart, ((dayHigh - dayLow) / weekRange) * 100)) : 0;
    track.style.setProperty("--range-start", `${rangeStart}%`);
    track.style.setProperty("--range-width", `${rangeWidth}%`);
    high.textContent = formatTemp(day.high);

    if (isHorizontal) {
      row.append(designation, iconGroup, high, track, low, precip, dayName, chevron);
    } else {
      if (day.designation?.level) row.append(designation);
      row.append(dayName, iconGroup, low, track, high, chevron);
    }
    row.addEventListener("click", () => togglePanel(row, detailPanel));
    if (isHorizontal) {
      card.append(row);
      horizontalPanels.push(detailPanel);
    } else {
      card.append(row, detailPanel);
    }
    elements.dailyForecast.appendChild(card);
  });

  horizontalPanels.forEach((panel) => elements.dailyForecast.appendChild(panel));
}

function renderDailyDetailPanel(details, index, designation = null) {
  const panel = document.createElement("section");
  const story = document.createElement("div");
  const metricHeader = document.createElement("h3");
  const metrics = document.createElement("div");
  const designationNotice = designation?.level ? renderDesignationNotice(designation) : null;
  panel.className = "daily-detail-panel";
  panel.id = `dailyDetail${index}`;
  panel.hidden = true;
  story.className = "day-story";
  metricHeader.className = "day-metrics-title";
  metricHeader.textContent = "Conditions";
  metrics.className = "day-metrics";

  details.story.forEach((item) => {
    const block = document.createElement("article");
    const icon = document.createElement("img");
    const text = document.createElement("div");
    const title = document.createElement("strong");
    const body = document.createElement("p");
    block.className = "story-block";
    setIcon(icon, item.icon, "");
    title.textContent = item.title;
    body.textContent = item.text;
    text.append(title, body);
    block.append(icon, text);
    story.appendChild(block);
  });

  details.metrics.forEach((item) => {
    const metric = document.createElement("article");
    const icon = document.createElement("img");
    const content = document.createElement("div");
    const label = document.createElement("span");
    const valueGroup = document.createElement("div");
    const value = document.createElement("strong");
    metric.className = "day-metric";
    content.className = "day-metric-content";
    valueGroup.className = "day-metric-value";
    if (item.status) valueGroup.classList.add("has-status");
    setIcon(icon, item.icon || "weather-cloud.svg", "");
    label.textContent = item.label;
    if (item.type === "pollen-pills" && item.items?.length) {
      const pillList = document.createElement("div");
      pillList.className = "day-allergen-pills";
      item.items.forEach((allergen) => pillList.appendChild(createAllergenBadge(allergen)));
      valueGroup.appendChild(pillList);
    } else {
      value.textContent = item.value;
      valueGroup.appendChild(value);
    }
    if (item.status) {
      const status = document.createElement("span");
      status.className = item.statusTone ? `dew-status ${item.statusTone}` : "dew-status";
      status.textContent = item.status;
      valueGroup.appendChild(status);
    }
    if (item.subvalue) {
      const subvalue = document.createElement("small");
      subvalue.textContent = item.subvalue;
      valueGroup.appendChild(subvalue);
    }
    content.append(label, valueGroup);
    metric.append(icon, content);
    metrics.appendChild(metric);
  });

  if (designationNotice) panel.appendChild(designationNotice);
  panel.append(story);
  panel.append(metricHeader, metrics);
  return panel;
}

function createAllergenBadge(item) {
  const badge = document.createElement("span");
  const icon = document.createElement("img");
  const name = document.createElement("span");
  const severity = document.createElement("strong");
  badge.className = `allergen-badge ${String(item.category || "").toLowerCase().replace(/\s+/g, "-")}`;
  badge.title = `${item.label}: ${item.category}`;
  badge.setAttribute("aria-label", `${item.label}: ${item.category}`);
  setIcon(icon, item.icon || "pollen.svg", "");
  name.textContent = shortAllergenLabel(item.label);
  severity.textContent = item.category;
  badge.append(icon, name, severity);
  return badge;
}

function dailyPrecipText(day) {
  const amount = day.precipAmount || "";
  const percent = shouldShowPrecipPercent(day.precip) || amount ? day.precip : "";
  return [percent, amount].filter(Boolean).join(" / ");
}

function dailyPrecipParts(day) {
  const amount = day.precipAmount || "";
  const percent = shouldShowPrecipPercent(day.precip) || amount ? day.precip : "";
  return {
    percent,
    amount: amount || ""
  };
}

function appendDailyPrecipAmount(element, amount) {
  const text = String(amount || "").trim();
  const range = text.match(/^(.+?-\s*)(.+?\s*in)$/i);
  if (!range) {
    element.textContent = text;
    return;
  }
  const firstLine = document.createElement("span");
  const secondLine = document.createElement("span");
  firstLine.textContent = range[1].trimEnd();
  secondLine.textContent = range[2].trim();
  element.append(firstLine, secondLine);
}

function renderDesignationNotice(designation) {
  const notice = document.createElement("aside");
  const badge = document.createElement("span");
  const copy = document.createElement("span");
  const level = designation?.level === "alert" ? "alert" : "impact";
  notice.className = `day-designation-notice ${level}`;
  badge.className = `day-designation ${level}`;
  badge.textContent = level === "alert" ? "Alert" : "Impact";
  copy.textContent = level === "alert"
    ? `${designation?.reason || "Potentially dangerous or high-impact weather is expected."} Stay aware and be ready to take action.`
    : `${designation?.reason || "Weather may significantly affect your plans."} Stay weather-aware and prepare for possible disruptions.`;
  notice.append(badge, copy);
  return notice;
}

function togglePanel(button, panel, force) {
  const shouldOpen = typeof force === "boolean" ? force : panel.hidden;
  const dailyCard = button.closest?.(".daily-day-card");
  const isHorizontalDaily = Boolean(dailyCard && elements.dailyForecast?.classList.contains("is-horizontal"));
  if (isHorizontalDaily && shouldOpen) {
    elements.dailyForecast.querySelectorAll(".daily-row[aria-expanded='true']").forEach((row) => {
      if (row === button) return;
      row.setAttribute("aria-expanded", "false");
      row.closest?.(".daily-day-card")?.classList.remove("is-open");
      const controlledPanel = document.getElementById(row.getAttribute("aria-controls"));
      if (controlledPanel) controlledPanel.hidden = true;
    });
  }
  panel.hidden = !shouldOpen;
  button.setAttribute("aria-expanded", String(shouldOpen));
  if (dailyCard) dailyCard.classList.toggle("is-open", shouldOpen);
}

function toggleRadar(force) {
  const shouldOpen = typeof force === "boolean" ? force : elements.radarPanel.hidden;
  togglePanel(elements.radarToggle, elements.radarPanel, shouldOpen);
  elements.radarPanel.classList.toggle("is-fullscreen", shouldOpen);
  document.body.classList.toggle("radar-open", shouldOpen);
  elements.radarClose.textContent = shouldOpen ? "Back" : "Close";
}

function togglePollen(force) {
  const shouldOpen = typeof force === "boolean" ? force : elements.pollenPanel.hidden;
  elements.pollenPanel.hidden = !shouldOpen;
  elements.pollenPanel.classList.toggle("is-fullscreen", shouldOpen);
  document.body.classList.toggle("pollen-open", shouldOpen);
}

function setHourlyMetric(metric) {
  activeHourlyMetric = metric === "wind" ? "wind" : "precip";
  syncHourlyMetricControls();
  renderHourly(lastHourlyHours);
}

function syncHourlyMetricControls() {
  elements.hourlyPrecipToggle.classList.toggle("is-active", activeHourlyMetric === "precip");
  elements.hourlyWindToggle.classList.toggle("is-active", activeHourlyMetric === "wind");
  elements.hourlyPrecipToggle.setAttribute("aria-pressed", activeHourlyMetric === "precip" ? "true" : "false");
  elements.hourlyWindToggle.setAttribute("aria-pressed", activeHourlyMetric === "wind" ? "true" : "false");
}

function toggleSettings(force) {
  const shouldOpen = typeof force === "boolean" ? force : elements.settingsPanel.hidden;
  elements.settingsPanel.hidden = !shouldOpen;
  elements.settingsToggle.setAttribute("aria-expanded", String(shouldOpen));
  if (shouldOpen) {
    if (elements.autoLocationToggle) elements.autoLocationToggle.checked = autoLocationEnabled;
    if (elements.dailyLayoutToggle) elements.dailyLayoutToggle.checked = dailyLayoutMode === "horizontal";
    refreshMorningNotificationState();
    elements.locationInput.value = currentLocation.query || currentLocation.label;
    elements.locationStatus.textContent = "";
  }
}

async function handleLocationSubmit(event) {
  event.preventDefault();
  const query = elements.locationInput.value.trim();
  if (!query) return;
  const requestId = ++locationRequestId;
  elements.locationStatus.textContent = "Updating location...";

  try {
    const location = await weatherService.resolveLocation(query);
    if (requestId !== locationRequestId) return;
    saveLocation(location);
    toggleSettings(false);
    await renderDashboard();
  } catch (error) {
    console.warn("Location update failed.", error);
    elements.locationStatus.textContent = "I couldn't find that location. Try a ZIP code or City, State.";
  }
}

function bindInteractions() {
  elements.currentCard.addEventListener("click", (event) => {
    if (event.target.closest("#hourlyForecast") || event.target.closest(".hourly-metric-toggle")) return;
    togglePanel(elements.currentCard, elements.expandedWeather);
  });
  elements.currentCard.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (event.target.closest("#hourlyForecast") || event.target.closest(".hourly-metric-toggle")) return;
    event.preventDefault();
    togglePanel(elements.currentCard, elements.expandedWeather);
  });
  elements.radarPreviewCard.addEventListener("click", () => toggleRadar(true));
  elements.radarToggle.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleRadar(true);
  });
  elements.radarClose.addEventListener("click", () => toggleRadar(false));
  elements.pollenClose.addEventListener("click", () => togglePollen(false));
  elements.hourlyPrecipToggle.addEventListener("click", (event) => {
    event.stopPropagation();
    setHourlyMetric("precip");
  });
  elements.hourlyWindToggle.addEventListener("click", (event) => {
    event.stopPropagation();
    setHourlyMetric("wind");
  });
  elements.alertCard.addEventListener("click", () => togglePanel(elements.alertCard, elements.alertDetails));
  elements.settingsToggle.addEventListener("click", () => toggleSettings());
  elements.settingsClose.addEventListener("click", () => toggleSettings(false));
  elements.settingsPanel.addEventListener("click", (event) => {
    if (event.target === elements.settingsPanel) toggleSettings(false);
  });
  elements.autoLocationToggle.addEventListener("change", () => {
    saveAutoLocationEnabled(elements.autoLocationToggle.checked);
    elements.locationStatus.textContent = autoLocationEnabled
      ? "Current location will be used on load and refresh if allowed."
      : "Automatic location is off. The ZIP or city above will be used.";
  });
  elements.dailyLayoutToggle.addEventListener("change", () => {
    saveDailyLayoutMode(elements.dailyLayoutToggle.checked ? "horizontal" : "vertical");
    elements.dailyForecast.classList.toggle("is-horizontal", dailyLayoutMode === "horizontal");
    renderDaily(lastDailyDays);
    elements.locationStatus.textContent = dailyLayoutMode === "horizontal"
      ? "7-Day Forecast is using the horizontal chart view."
      : "7-Day Forecast is using the vertical list view.";
  });
  elements.morningNotificationToggle.addEventListener("change", handleMorningNotificationToggle);
  elements.severeAlertsToggle.addEventListener("change", handleSevereAlertsToggle);
  elements.sendTestNotification.addEventListener("click", sendTestNotification);
  elements.sendActiveNwsAlertTestNotification.addEventListener("click", sendActiveNwsAlertTestNotification);
  elements.locationForm.addEventListener("submit", handleLocationSubmit);
  bindPullToRefresh();
}

function bindPullToRefresh() {
  if (!("ontouchstart" in window) || !elements.pullRefresh) return;
  let startY = 0;
  let distance = 0;
  let tracking = false;

  window.addEventListener("touchstart", (event) => {
    if (window.scrollY > 0 || elements.radarPanel?.classList.contains("is-fullscreen")) return;
    tracking = true;
    startY = event.touches[0].clientY;
    distance = 0;
  }, { passive: true });

  window.addEventListener("touchmove", (event) => {
    if (!tracking) return;
    distance = event.touches[0].clientY - startY;
    elements.pullRefresh.classList.toggle("is-visible", distance > 42);
    elements.pullRefresh.textContent = distance > 92 ? "Release to refresh" : "Pull to refresh";
  }, { passive: true });

  window.addEventListener("touchend", async () => {
    if (!tracking) return;
    tracking = false;
    if (distance <= 92) {
      elements.pullRefresh.classList.remove("is-visible");
      return;
    }
    elements.pullRefresh.classList.add("is-refreshing");
    elements.pullRefresh.textContent = "Refreshing...";
    await renderDashboard();
    elements.pullRefresh.textContent = "Updated";
    window.setTimeout(() => {
      elements.pullRefresh.classList.remove("is-visible", "is-refreshing");
    }, 650);
  }, { passive: true });
}

function animateTemperatureRefresh() {
  elements.currentTemp.classList.add("is-refreshing");
  window.setTimeout(() => elements.currentTemp.classList.remove("is-refreshing"), 420);
}

async function renderDashboard() {
  const requestId = ++dashboardRequestId;
  try {
    const location = await locationForDashboard();
    if (requestId !== dashboardRequestId) return;
    setText("locationLabel", location.label);
    updateRadarLocation(location);
    const data = await weatherService.getWeather(location);
    if (requestId !== dashboardRequestId) return;
    activeDashboardData = data;
    activeHourlyIndex = 0;
    activeHourlyMetric = "precip";
    syncHourlyMetricControls();
    renderCurrentWeather(data);
    renderSummaryStats(data.summaryStats);
    renderDetails(hourlyDetailCards(getCurrentHourForecast(Array.isArray(data.hourly) ? data.hourly : []).slice(0, 8)[0], data.details));
    renderPrecipitation(data.precipitation);
    renderAlert(data.alert);
    renderHourly(data.hourly);
    renderDaily(data.daily);
    if (data.dailyOutlookPromise) {
      data.dailyOutlookPromise.then((daily) => {
        if (requestId !== dashboardRequestId || !Array.isArray(daily)) return;
        activeDashboardData.daily = daily;
        lastDailyDays = daily;
        renderDaily(daily);
      }).catch((error) => console.warn("Daily outlook update skipped.", error));
    }
    if (data.supplementalUpdatePromise) {
      data.supplementalUpdatePromise.then((update) => {
        if (requestId !== dashboardRequestId || !update) return;
        activeDashboardData.details = update.details || activeDashboardData.details;
        if (Array.isArray(update.daily) && update.daily.length) {
          activeDashboardData.daily = update.daily;
          lastDailyDays = update.daily;
          renderDaily(update.daily);
        }
        const hour = getCurrentHourForecast(Array.isArray(activeDashboardData.hourly) ? activeDashboardData.hourly : []).slice(0, 8)[activeHourlyIndex];
        renderDetails(hourlyDetailCards(hour, activeDashboardData.details));
        if (!elements.pollenPanel.hidden) renderPollenPanel();
      }).catch((error) => console.warn("Supplemental dashboard update skipped.", error));
    }
    animateTemperatureRefresh();
  } catch (error) {
    console.warn("Dashboard render failed.", error);
    const fallback = weatherService.clone(emptyWeather);
    fallback.location = { city: currentLocation?.label || DEFAULT_LOCATION.label };
    activeDashboardData = fallback;
    renderCurrentWeather(fallback);
    renderSummaryStats(fallback.summaryStats);
    renderDetails(fallback.details);
    renderPrecipitation(fallback.precipitation);
    renderAlert(fallback.alert);
    renderHourly(fallback.hourly);
    renderDaily(fallback.daily);
  }
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  }
}

function startApp() {
  cacheElements();
  bindInteractions();
  updateClock();
  renderDashboard();
  registerServiceWorker();
  refreshMorningNotificationState();
  window.setInterval(updateClock, 30000);
}

document.addEventListener("DOMContentLoaded", startApp);














