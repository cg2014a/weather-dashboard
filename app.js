const ICON_PATH = "icons/";
const DEFAULT_LOCATION = { label: "Olathe, KS", query: "Olathe, KS", city: "Olathe", state: "KS", lat: 38.9, lon: -94.84 };
const LOCATION_STORAGE_KEY = "skystation-location";
const AUTO_LOCATION_STORAGE_KEY = "skystation-auto-location";
const AIRNOW_KEY_STORAGE_KEY = "skystation-airnow-key";
const PRECIP_DISPLAY_THRESHOLD = 20;
const nwsPointUrl = ({ lat, lon }) => `https://api.weather.gov/points/${lat},${lon}`;
const nwsAlertsUrl = ({ lat, lon }) => `https://api.weather.gov/alerts/active?point=${lat},${lon}`;
const airQualityUrl = ({ lat, lon }) => `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=us_aqi,alder_pollen,birch_pollen,grass_pollen,mugwort_pollen,olive_pollen,ragweed_pollen,dust&timezone=auto`;
const openMeteoForecastUrl = ({ lat, lon }) => `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,dew_point_2m,apparent_temperature,precipitation,rain,showers,snowfall,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m&hourly=precipitation_probability,precipitation,rain,showers,snowfall,visibility&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,uv_index_max,sunrise,sunset&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=auto&forecast_days=7&forecast_hours=2`;
const epaUvUrl = (location) => location.zip
  ? `https://data.epa.gov/dmapservice/getEnvirofactsUVDAILY/ZIP/${location.zip}/JSON`
  : `https://data.epa.gov/dmapservice/getEnvirofactsUVDAILY/CITY/${encodeURIComponent(location.city || "")}/STATE/${location.state || ""}/JSON`;
const airNowUrl = ({ lat, lon }, apiKey) => `https://www.airnowapi.org/aq/observation/latLong/current/?format=application/json&latitude=${lat}&longitude=${lon}&distance=25&API_KEY=${encodeURIComponent(apiKey)}`;
const sunUrl = ({ lat, lon }) => `https://api.sunrise-sunset.org/v2?lat=${lat}&lng=${lon}`;

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

    const [forecast, hourly, alerts, observation, airQuality, supplemental] = (await Promise.allSettled([
      properties.forecast ? this.fetchJson(properties.forecast) : Promise.resolve(null),
      properties.forecastHourly ? this.fetchJson(properties.forecastHourly) : Promise.resolve(null),
      this.fetchJson(nwsAlertsUrl(location)),
      properties.observationStations ? this.getLatestObservation(properties.observationStations) : Promise.resolve(null),
      this.getAirQuality(location),
      this.getSupplementalWeather(location)
    ])).map((result) => this.settledValue(result));

    const hourlyPeriods = hourly?.properties?.periods || [];
    const forecastPeriods = forecast?.properties?.periods || [];
    if (!hourlyPeriods.length && !forecastPeriods.length && !supplemental) {
      throw new Error("No usable forecast periods returned.");
    }
    const dailyPeriods = forecastPeriods.length ? forecastPeriods : this.dailyPeriodsFromSupplemental(supplemental);
    const currentPeriod = hourlyPeriods[0] || forecastPeriods[0] || dailyPeriods[0] || this.periodFromSupplemental(supplemental);
    const basePollen = airQuality?.pollen || supplemental?.pollen || this.emptyPollen();
    const enrichedSupplemental = {
      ...supplemental,
      airQualityLabel: airQuality ? `${airQuality.value} ${airQuality.category}` : "Checking",
      pollen: basePollen
    };
    enrichedSupplemental.pollen = {
      ...basePollen,
      health: this.mapHealthRisks(enrichedSupplemental, airQuality)
    };
    const current = this.mapCurrent(currentPeriod, dailyPeriods, hourlyPeriods, observation, enrichedSupplemental);
    const precipitation = this.mapPrecipitation(currentPeriod, hourlyPeriods, enrichedSupplemental);

    return {
      location: { city: location.label },
      current,
      summaryStats: this.mapSummaryStats(current, currentPeriod, observation, precipitation, airQuality, enrichedSupplemental),
      narrative: this.mapNarrative(currentPeriod, dailyPeriods),
      precipitation,
      details: this.mapDetails(currentPeriod, observation, precipitation, enrichedSupplemental),
      alert: this.mapAlert(alerts || { features: [] }),
      hourly: this.mapHourly(hourlyPeriods),
      daily: this.mapDaily(dailyPeriods, enrichedSupplemental)
    };
  }

  async getFallbackWeather(location) {
    const [airQuality, supplemental] = await Promise.all([
      this.getAirQuality(location),
      this.getSupplementalWeather(location)
    ]);
    if (!supplemental) throw new Error("Supplemental weather unavailable.");

    const currentPeriod = this.periodFromSupplemental(supplemental);
    const hourlyPeriods = [currentPeriod, this.periodFromSupplemental(supplemental, 1)];
    const forecastPeriods = this.dailyPeriodsFromSupplemental(supplemental);
    const basePollen = airQuality?.pollen || supplemental.pollen || this.emptyPollen();
    const enrichedSupplemental = {
      ...supplemental,
      airQualityLabel: airQuality ? `${airQuality.value} ${airQuality.category}` : "Checking",
      pollen: {
        ...basePollen,
        health: this.mapHealthRisks({ ...supplemental, pollen: basePollen }, airQuality)
      }
    };
    const current = this.mapCurrent(currentPeriod, forecastPeriods, hourlyPeriods, null, enrichedSupplemental);
    const precipitation = this.mapPrecipitation(currentPeriod, hourlyPeriods, enrichedSupplemental);

    return {
      location: { city: location.label },
      current,
      summaryStats: this.mapSummaryStats(current, currentPeriod, null, precipitation, airQuality, enrichedSupplemental),
      narrative: "Weather conditions are shown from the backup forecast source.",
      precipitation,
      details: this.mapDetails(currentPeriod, null, precipitation, enrichedSupplemental),
      alert: null,
      hourly: this.mapHourly(hourlyPeriods),
      daily: this.mapDaily(forecastPeriods, enrichedSupplemental)
    };
  }

  settledValue(result) {
    if (result.status === "fulfilled") return result.value;
    console.warn("Weather request skipped.", result.reason);
    return null;
  }

  async resolveLocation(input) {
    const query = input.trim();
    if (!query) return DEFAULT_LOCATION;
    if (/^\d{5}$/.test(query)) return this.resolveZip(query);
    return this.resolvePlace(query);
  }

  async getAirQuality(location) {
    const airNow = await this.getAirNowQuality(location);
    if (airNow) return airNow;
    return this.getOpenMeteoAirQuality(location);
  }

  async getAirNowQuality(location) {
    const apiKey = localStorage.getItem(AIRNOW_KEY_STORAGE_KEY);
    if (!apiKey) return null;

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
      return null;
    }
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
        pollen: this.mapPollen(data.current),
        source: "Open-Meteo"
      };
    } catch (error) {
      console.warn("Open-Meteo air quality unavailable.", error);
      return null;
    }
  }

  async getSupplementalWeather(location) {
    const [sun, uvIndex, openMeteo, pollen] = await Promise.all([
      this.getSunData(location),
      this.getUvIndex(location),
      this.getOpenMeteoWeather(location),
      this.getPollen(location)
    ]);

    return {
      ...openMeteo,
      pollen,
      uvIndex: uvIndex ?? openMeteo?.uvIndex ?? null,
      sunrise: sun?.sunrise || openMeteo?.sunrise || null,
      sunset: sun?.sunset || openMeteo?.sunset || null
    };
  }

  async getPollen(location) {
    try {
      const data = await this.getOpenMeteoAirQualityPayload(location);
      return this.mapPollen(data.current);
    } catch (error) {
      console.warn("Pollen data unavailable.", error);
      return this.emptyPollen();
    }
  }

  async getOpenMeteoAirQualityPayload(location) {
    const key = `${location.lat},${location.lon}`;
    if (!this.pendingAirQualityPayloads.has(key)) {
      const request = this.fetchJson(airQualityUrl(location))
        .finally(() => this.pendingAirQualityPayloads.delete(key));
      this.pendingAirQualityPayloads.set(key, request);
    }
    return this.pendingAirQualityPayloads.get(key);
  }

  async getSunData(location) {
    try {
      const data = await this.fetchJson(sunUrl(location));
      const result = data.results || data;
      return {
        sunrise: this.formatSunTime(result.sunrise),
        sunset: this.formatSunTime(result.sunset)
      };
    } catch (error) {
      console.warn("Sunrise and sunset unavailable.", error);
      return null;
    }
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
        windSpeed: this.numberOrNull(current.wind_speed_10m),
        windDirection: this.numberOrNull(current.wind_direction_10m),
        windGusts: this.numberOrNull(current.wind_gusts_10m),
        precipChance: this.numberOrNull(hourly.precipitation_probability?.[0]),
        hourlyPrecipChances: (hourly.precipitation_probability || []).map((value) => this.numberOrNull(value)),
        hourlyPrecipAmounts: (hourly.precipitation || []).map((value) => this.numberOrNull(value)),
        visibility: this.numberOrNull(hourly.visibility?.[0]),
        high: this.numberOrNull(daily.temperature_2m_max?.[0]),
        low: this.numberOrNull(daily.temperature_2m_min?.[0]),
        dailyPrecipAmount: this.numberOrNull(daily.precipitation_sum?.[0]),
        dailyPrecipAmounts: (daily.precipitation_sum || []).map((value) => this.numberOrNull(value)),
        dailyHighs: (daily.temperature_2m_max || []).map((value) => this.numberOrNull(value)),
        dailyLows: (daily.temperature_2m_min || []).map((value) => this.numberOrNull(value)),
        dailyUvIndexes: (daily.uv_index_max || []).map((value) => this.numberOrNull(value)),
        uvIndex: this.numberOrNull(daily.uv_index_max?.[0]),
        sunrise: this.formatSunTime(daily.sunrise?.[0]),
        sunset: this.formatSunTime(daily.sunset?.[0])
      };
    } catch (error) {
      console.warn("Open-Meteo supplemental weather unavailable.", error);
      return null;
    }
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

  async getLatestObservation(stationsUrl) {
    try {
      const stations = await this.fetchJson(stationsUrl);
      const station = stations.features?.[0]?.properties?.stationIdentifier;
      if (!station) return null;
      return this.fetchJson(`https://api.weather.gov/stations/${station}/observations/latest`);
    } catch {
      return null;
    }
  }

  async fetchJson(url) {
    const response = await fetch(url, { headers: { Accept: "application/json, application/geo+json" } });
    if (!response.ok) throw new Error(`Weather request failed: ${response.status}`);
    return response.json();
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
    const temp = period?.temperature ?? supplemental?.temperature ?? null;
    const todayHigh = forecastPeriods.find((item) => item.isDaytime)?.temperature ?? supplemental?.high ?? temp;
    const tonightLow = forecastPeriods.find((item) => !item.isDaytime)?.temperature ?? supplemental?.low ?? null;
    const observedHeatIndex = this.readTemperature(observation?.properties?.heatIndex?.value);
    const observedWindChill = this.readTemperature(observation?.properties?.windChill?.value);
    const feelsLike = observedHeatIndex ?? observedWindChill ?? supplemental?.feelsLike ?? temp;

    return {
      temperature: temp,
      icon: this.iconForForecast(period?.shortForecast, period?.isDaytime),
      condition: period?.shortForecast || "Current conditions",
      feelsLike,
      high: todayHigh,
      low: tonightLow
    };
  }

  mapSummaryStats(current, period, observation, precipitation, airQuality, supplemental) {
    const windValue = `${period?.windDirection || ""} ${period?.windSpeed || ""}`.trim()
      || this.formatOpenMeteoWind(supplemental)
      || "0 mph";
    const humidity = this.readHumidity(observation, supplemental, period);
    const dewPoint = this.dewPointFahrenheit(observation, supplemental);

    return [
      { icon: "real-feel.svg", label: "High/Low", value: `${this.formatMaybeTemp(current.high)} / ${this.formatMaybeTemp(current.low)}` },
      { icon: "humidity.svg", label: "Humidity", value: humidity },
      { icon: "dew.svg", label: "Dew Point", value: this.formatMaybeTemp(dewPoint), status: this.dewPointComfortLabel(dewPoint), statusTone: this.dewPointComfortTone(dewPoint) },
      { icon: "wind.svg", label: "Wind", value: windValue },
      { icon: "rain-chance.svg", label: "Precipitation", value: this.precipChance(period, supplemental) }
    ];
  }

  mapPollen(current = {}) {
    const hasPollenData = [
      "alder_pollen",
      "birch_pollen",
      "olive_pollen",
      "ragweed_pollen",
      "grass_pollen",
      "mugwort_pollen",
      "dust"
    ].some((field) => this.numberOrNull(current?.[field]) !== null);
    if (!hasPollenData) return this.emptyPollen();

    const treeValue = Math.max(
      this.numberOrNull(current?.alder_pollen) || 0,
      this.numberOrNull(current?.birch_pollen) || 0,
      this.numberOrNull(current?.olive_pollen) || 0
    );
    const ragweedValue = this.numberOrNull(current?.ragweed_pollen) || 0;
    const grassValue = this.numberOrNull(current?.grass_pollen) || 0;
    const weedValue = this.numberOrNull(current?.mugwort_pollen) || 0;
    const dustValue = this.numberOrNull(current?.dust) || 0;
    const moldValue = this.moldRiskFromWeather(current);
    const danderValue = Math.max(dustValue, treeValue * 0.35, grassValue * 0.35);
    const peak = Math.max(treeValue, ragweedValue, grassValue, weedValue, moldValue, danderValue);
    const details = [
      this.allergenDetail("Tree Pollen", treeValue, "pollen"),
      this.allergenDetail("Ragweed Pollen", ragweedValue, "pollen"),
      this.allergenDetail("Grass Pollen", grassValue, "pollen"),
      this.allergenDetail("Mold", moldValue, "pollen"),
      this.allergenDetail("Dust & Dander", danderValue, "dust"),
      this.allergenDetail("Weed Pollen", weedValue, "pollen")
    ];
    return { value: peak, category: this.pollenCategory(peak), details };
  }

  emptyPollen() {
    const emptyDetail = (label, icon = "pollen.svg") => ({ label, value: null, category: "Checking", icon });
    return {
      value: null,
      category: "Checking",
      details: [
        emptyDetail("Tree Pollen"),
        emptyDetail("Ragweed Pollen"),
        emptyDetail("Grass Pollen"),
        emptyDetail("Mold"),
        emptyDetail("Dust & Dander", "aqi.svg"),
        emptyDetail("Weed Pollen")
      ]
    };
  }

  mapHealthRisks(supplemental, airQuality) {
    const humidity = this.numberOrNull(supplemental?.humidity) || 0;
    const pressure = this.numberOrNull(supplemental?.pressure) || 1013;
    const uv = this.numberOrNull(supplemental?.uvIndex) || 0;
    const aqi = airQuality?.value || 0;
    const pollenPeak = supplemental?.pollen?.value || 0;
    return [
      this.healthDetail("Arthritis", pressure < 1005 ? 52 : 12),
      this.healthDetail("Sinus Pressure", humidity > 70 || pressure < 1005 ? 64 : 18),
      this.healthDetail("Common Cold", humidity < 35 ? 42 : 12),
      this.healthDetail("Flu", humidity < 35 ? 40 : 10),
      this.healthDetail("Migraine", pressure < 1005 || uv >= 8 ? 58 : 16),
      this.healthDetail("Asthma", Math.max(aqi, pollenPeak, humidity > 75 ? 52 : 0))
    ];
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

  mapDetails(period, observation, precipitation, supplemental) {
    const humidity = this.readHumidity(observation, supplemental, period);
    const dewPoint = this.readTemperatureLabel(observation?.properties?.dewpoint?.value, supplemental?.dewPoint);
    const wind = `${period?.windDirection || ""} ${period?.windSpeed || ""}`.trim() || this.formatOpenMeteoWind(supplemental) || "0 mph";
    const pollen = supplemental?.pollen || this.emptyPollen();
    return [
      { icon: "rain-chance.svg", label: "Precipitation", value: `${this.precipChance(period, supplemental)} / ${this.currentPrecipAmount(period, precipitation, supplemental)}` },
      { icon: "humidity.svg", label: "Humidity / Dew Point", value: `${humidity} / ${dewPoint}` },
      { icon: "wind.svg", label: "Wind / Gust", value: `${wind} / ${this.readWindGust(period, supplemental)}` },
      { icon: "aqi.svg", label: "Air Quality", value: supplemental?.airQualityLabel || "Checking" },
      { icon: "pollen.svg", label: "Pollen & Allergens", value: "View Details", type: "pollen", details: pollen.details, health: pollen.health },
      { icon: "uv.svg", label: "UV Index", value: this.formatUvIndex(supplemental?.uvIndex) },
      { icon: "visibility.svg", label: "Visibility", value: this.readDistance(this.firstNumber(observation?.properties?.visibility?.value, supplemental?.visibility)) },
      { icon: "pressure.svg", label: "Pressure", value: this.readPressureWithFallback(observation?.properties?.barometricPressure?.value, supplemental?.pressure) },
      { icon: "sunrise.svg", label: "Sunrise / Sunset", value: `${supplemental?.sunrise || "--"} / ${supplemental?.sunset || "--"}`, type: "sun", sunrise: supplemental?.sunrise || "--", sunset: supplemental?.sunset || "--" }
    ];
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

  mapPrecipitation(currentPeriod, hourlyPeriods, supplemental) {
    const chance = this.precipValue(currentPeriod, supplemental);
    const nextHourPeriods = hourlyPeriods.slice(0, 2);
    const nextHourPeak = Math.max(...nextHourPeriods.map((period) => this.precipValue(period, supplemental)), 0);
    const wetHours = nextHourPeriods.filter((period) => this.precipValue(period, supplemental) >= PRECIP_DISPLAY_THRESHOLD);
    const precipText = [currentPeriod, ...wetHours].map((period) => period?.shortForecast || "").join(" ");
    const type = this.precipType(precipText);
    const expectedAmount = this.expectedPrecipAmount(hourlyPeriods, supplemental);
    const activelyOccurring = this.isPrecipActivelyOccurring(currentPeriod, supplemental);
    const active = this.isSupportedPrecipType(type) && (activelyOccurring || nextHourPeak >= PRECIP_DISPLAY_THRESHOLD);
    const summary = activelyOccurring && nextHourPeak < PRECIP_DISPLAY_THRESHOLD
      ? `${type} is currently occurring.`
      : expectedAmount >= 0.001
        ? `${type} totals may reach ${this.formatInches(expectedAmount)} based on the latest forecast.`
        : `${nextHourPeak}% chance of ${type.toLowerCase()} within the next hour.`;

    return {
      active,
      type,
      icon: type === "Snow" || type === "Sleet" ? "weather-snow.svg" : "weather-rain.svg",
      summary: active ? summary : "No significant precipitation expected.",
      current: active ? `${chance}% now` : "0% now",
      nextHour: `${this.precipValue(hourlyPeriods[1], supplemental)}% next hour`,
      amount: this.precipAmountLabel(expectedAmount, hourlyPeriods, supplemental),
      today: expectedAmount >= 0.001 ? `${this.formatInches(expectedAmount)} today` : "",
      timeline: this.nextHourPrecipTimeline(hourlyPeriods, supplemental),
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
    const details = activeAlerts.map((alert, index) => [
      activeAlerts.length > 1 ? `Alert ${index + 1}: ${alert.event || "Weather Alert"}` : "",
      this.cleanAlertText(alert.description),
      alert.instruction ? `What to do:\n${this.cleanAlertText(alert.instruction)}` : "",
      alert.areaDesc ? `Areas affected:\n${this.cleanAlertText(alert.areaDesc)}` : "",
      alert.expires ? `Expires:\n${this.formatAlertTime(alert.expires)}` : ""
    ].filter(Boolean).join("\n\n"));

    return {
      headline,
      body: this.cleanAlertText(summary),
      details: details.join("\n\n")
    };
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

  mapHourly(periods) {
    return periods.slice(0, 12).map((period) => ({
      time: period.startTime,
      icon: this.iconForForecast(period.shortForecast, period.isDaytime),
      temp: period.temperature,
      precip: `${this.precipValue(period)}%`
    }));
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
    const low = nightPeriod?.temperature ?? supplemental?.dailyLows?.[dayIndex] ?? dayPeriod.temperature;
    const high = dayPeriod.temperature ?? supplemental?.dailyHighs?.[dayIndex];
    const precip = Math.max(this.precipValue(dayPeriod), this.precipValue(nightPeriod));
    const text = `${dayPeriod.detailedForecast || ""} ${nightPeriod?.detailedForecast || ""}`;
    const precipAmount = this.precipAmountFromText(text) || this.formatInches(supplemental?.dailyPrecipAmounts?.[dayIndex]);

    return {
      day: this.dayLabel(dayPeriod.startTime),
      icon: this.iconForForecast(dayPeriod.shortForecast, true),
      condition: dayPeriod.shortForecast,
      high,
      low,
      precip: precip > 0 ? `${precip}%` : "0%",
      precipAmount,
      range: this.rangeWidth(low, high),
      details: {
        story: [
          { icon: this.iconForForecast(dayPeriod.shortForecast, true), title: this.dayTitle(dayPeriod.startTime), text: dayPeriod.detailedForecast || dayPeriod.shortForecast },
          { icon: this.iconForForecast(nightPeriod?.shortForecast, false), title: this.nightTitle(dayPeriod.startTime), text: nightPeriod?.detailedForecast || "Night forecast is updating." }
        ],
        metrics: this.dayMetrics(low, high, precip, text, precipAmount, dayPeriod, nightPeriod, supplemental, dayIndex)
      }
    };
  }

  buildTodayCarryover(period, todayLabel, supplemental) {
    const temp = period?.temperature ?? null;
    const precip = this.precipValue(period);
    const text = period?.detailedForecast || period?.shortForecast || "Tonight forecast is updating.";
    const precipAmount = this.precipAmountFromText(text) || this.formatInches(supplemental?.dailyPrecipAmounts?.[0]);

    return {
      day: todayLabel,
      icon: this.iconForForecast(period?.shortForecast, false),
      condition: period?.shortForecast || "Tonight",
      high: temp,
      low: temp,
      precip: precip > 0 ? `${precip}%` : "0%",
      precipAmount,
      range: this.rangeWidth(temp, temp),
      details: {
        story: [
          { icon: this.iconForForecast(period?.shortForecast, false), title: "Tonight", text }
        ],
        metrics: this.dayMetrics(temp, temp, precip, text, precipAmount, period, null, supplemental, 0)
      }
    };
  }

  dayMetrics(low, high, precip, text, precipAmount, dayPeriod, nightPeriod, supplemental, dayIndex = 0) {
    const combinedText = `${text || ""} ${dayPeriod?.shortForecast || ""} ${nightPeriod?.shortForecast || ""}`;
    const uv = supplemental?.dailyUvIndexes?.[dayIndex] ?? supplemental?.uvIndex;
    return [
      { label: "Feels Like", value: this.feelsLikeFromText(text, low, high) },
      { label: "Precip Chance", value: precip > 0 ? `${precip}%` : "0%" },
      { label: "Precip Amount", value: precipAmount || "0 in" },
      { label: "Wind", value: this.windFromText(combinedText) || this.formatOpenMeteoWind(supplemental) || "0 mph" },
      { label: "Gusts", value: this.gustFromText(combinedText) || this.readWindGust(dayPeriod, supplemental) },
      { label: "Humidity", value: this.readPercent(supplemental?.humidity) },
      { label: "UV", value: this.formatUvIndex(uv) },
      { label: "Air Quality Now", value: supplemental?.airQualityLabel || "Checking" },
      { label: "Pollen Now", value: supplemental?.pollen?.category || "Checking" }
    ];
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

  isPrecipActivelyOccurring(period, supplemental) {
    const currentAmount = this.firstNumber(supplemental?.precipitationAmount, supplemental?.rain, supplemental?.showers, supplemental?.snowfall);
    if (currentAmount >= 0.001) return true;
    const currentText = period?.shortForecast || "";
    if (/chance|possible|likely/i.test(currentText)) return false;
    return /rain|showers|drizzle|snow|sleet|ice pellets/i.test(currentText);
  }

  precipValue(period, supplemental) {
    const nwsValue = period?.probabilityOfPrecipitation?.value;
    const fallbackValue = supplemental?.precipChance;
    return Math.round(this.firstNumber(nwsValue, fallbackValue) || 0);
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
    const text = periods.slice(0, 12).map((period) => period.detailedForecast || period.shortForecast || "").join(" ");
    const parsed = this.precipAmountNumber(this.precipAmountFromText(text));
    if (parsed > 0) return parsed;

    const fallbackAmount = this.firstNumber(supplemental?.dailyPrecipAmount, supplemental?.precipitationAmount, supplemental?.rain, supplemental?.showers, supplemental?.snowfall);
    if (fallbackAmount > 0) return fallbackAmount;

    return 0;
  }

  precipAmountLabel(amount, periods, supplemental) {
    if (amount > 0) return amount < 0.01 ? "<0.01 in" : `${amount.toFixed(2)} in`;
    const text = periods.slice(0, 12).map((period) => period.detailedForecast || period.shortForecast || "").join(" ");
    const textAmount = this.precipAmountFromText(text);
    if (textAmount) return textAmount;
    const fallbackAmount = this.firstNumber(supplemental?.dailyPrecipAmount, supplemental?.precipitationAmount, supplemental?.rain, supplemental?.showers, supplemental?.snowfall);
    if (fallbackAmount > 0) return this.formatInches(fallbackAmount);
    return "0 in";
  }

  currentPrecipAmount(period, precipitation, supplemental) {
    const chance = this.precipValue(period, supplemental);
    if (precipitation?.active || chance > 0) return precipitation?.amount || "Trace";
    return "0 in";
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
    const chanceAnchors = periods.slice(0, 2).map((period) => this.precipValue(period, supplemental));
    const amountAnchors = this.precipAmountAnchors(supplemental);
    const anchors = amountAnchors.length ? amountAnchors : chanceAnchors.map((chance) => ({ chance, amount: null }));
    if (!anchors.length) return [];
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
    const nwsHumidity = this.numberOrNull(observation?.properties?.relativeHumidity?.value);
    const fallbackHumidity = this.numberOrNull(supplemental?.humidity);
    const validHumidity = [nwsHumidity, fallbackHumidity].find((value) => Number.isFinite(value) && value > 0 && value <= 100);
    if (Number.isFinite(validHumidity)) return `${Math.round(validHumidity)}%`;
    if (/rain|showers|thunder|storm|drizzle|fog/i.test(period?.shortForecast || "")) return "High";
    return "--";
  }

  dewPointFahrenheit(observation, supplemental) {
    return this.firstNumber(
      this.readTemperature(observation?.properties?.dewpoint?.value),
      supplemental?.dewPoint
    );
  }

  dewPointComfortLabel(value) {
    const dewPoint = this.numberOrNull(value);
    if (dewPoint === null) return "";
    if (dewPoint >= 70) return "Miserable";
    if (dewPoint >= 65) return "Muggy";
    if (dewPoint >= 60) return "Sticky";
    if (dewPoint >= 50) return "Pleasant";
    return "Dry";
  }

  dewPointComfortTone(value) {
    const dewPoint = this.numberOrNull(value);
    if (dewPoint === null) return "";
    if (dewPoint >= 70) return "miserable";
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

  readWindGust(period, supplemental) {
    const textGust = this.gustFromText(`${period?.detailedForecast || ""} ${period?.shortForecast || ""}`);
    if (textGust) return textGust;
    const gust = this.numberOrNull(supplemental?.windGusts);
    return gust === null ? "0 mph" : `${Math.round(gust)} mph`;
  }

  windFromText(text = "") {
    const match = text.match(/(?:north|south|east|west|northeast|northwest|southeast|southwest|[NSEW]{1,3})\s+wind\s+(?:around\s+)?(\d+(?:\s+to\s+\d+)?)\s*mph/i)
      || text.match(/wind\s+(?:around\s+)?(\d+(?:\s+to\s+\d+)?)\s*mph/i);
    return match ? `${match[1].replace(/\s+/g, " ")} mph` : "";
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
let currentPollenDetails = [];
let currentHealthDetails = [];
let dashboardRequestId = 0;
let locationRequestId = 0;

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
    "pullRefresh", "locationLabel", "appClock", "settingsToggle", "settingsPanel", "settingsClose", "locationForm", "locationInput", "locationStatus", "autoLocationToggle",
    "currentCard", "currentTemp", "currentIcon", "allergenAlerts",
    "condition", "outlookIcon", "feelsLike", "currentStats", "detailsGrid", "precipCard", "precipIcon", "precipSummary", "precipAmounts", "alertCard",
    "alertHeadline", "alertBody", "alertDetails", "hourlyForecast", "dailyForecast",
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
    row.className = item.tone ? `stat-row ${item.tone}` : "stat-row";
    text.className = "stat-label";
    valueWrap.className = "stat-value";
    if (item.status && !item.subvalue) valueWrap.classList.add("inline-status");
    setIcon(icon, item.icon || "weather-cloud.svg", "");
    label.textContent = item.label;
    value.textContent = item.value;
    text.append(icon, label);
    valueWrap.appendChild(value);
    if (item.subvalue || item.status) {
      const detail = document.createElement("small");
      if (item.statusTone) detail.className = `dew-status ${item.statusTone}`;
      detail.textContent = [item.subvalue, item.status].filter(Boolean).join(" • ");
      valueWrap.appendChild(detail);
    }
    row.append(text, valueWrap);
    elements.currentStats.appendChild(row);
  });
}

function renderDetails(details) {
  elements.detailsGrid.replaceChildren();
  currentPollenDetails = [];
  currentHealthDetails = [];
  details.forEach((item) => {
    const card = document.createElement("article");
    const icon = document.createElement("img");
    const label = document.createElement("span");
    const value = document.createElement("span");
    card.className = item.type === "sun" ? "quick-item sun-card" : "quick-item";
    label.className = "quick-label";
    value.className = "quick-value";
    setIcon(icon, item.icon, "");
    label.textContent = item.label;
    if (item.type === "sun") {
      const times = document.createElement("div");
      times.className = "sun-times";
      times.innerHTML = `<div><span>Sunrise</span><strong>${item.sunrise}</strong></div><div><span>Sunset</span><strong>${item.sunset}</strong></div>`;
      card.append(icon, label, times);
    } else if (item.type === "pollen") {
      currentPollenDetails = item.details || [];
      currentHealthDetails = item.health || [];
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
      card.append(icon, label, value);
    }
    elements.detailsGrid.appendChild(card);
  });
  renderAllergenAlerts(currentPollenDetails, currentHealthDetails);
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
    .replace("Dust & Dander", "Dander")
    .replace("Sinus Pressure", "Sinus")
    .replace("Common Cold", "Cold");
}

function renderPollenPanel() {
  elements.pollenList.replaceChildren();
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
  value.textContent = item.category;
  card.append(icon, label, value);
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
    elements.alertDetails.textContent = "";
    return;
  }
  elements.alertCard.hidden = false;
  elements.alertCard.setAttribute("aria-expanded", "false");
  setText("alertHeadline", alert.headline);
  setText("alertBody", alert.body);
  elements.alertDetails.textContent = alert.details || alert.body;
  elements.alertDetails.hidden = true;
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
function renderHourly(hours) {
  elements.hourlyForecast.replaceChildren();
  getCurrentHourForecast(hours).forEach((hour, index) => {
    const item = document.createElement("article");
    const time = document.createElement("span");
    const icon = document.createElement("img");
    const temp = document.createElement("span");
    const precip = document.createElement("span");
    item.className = "hour-item";
    item.style.animationDelay = `${index * 35}ms`;
    time.className = "hour-time";
    temp.className = "hour-temp";
    precip.className = "precip";
    item.setAttribute("aria-label", `${hour.time}, ${formatTemp(hour.temp)}, precipitation ${hour.precip}`);
    time.textContent = hour.time;
    setIcon(icon, hour.icon, "");
    temp.textContent = formatTemp(hour.temp);
    precip.textContent = hour.precip;
    item.append(time, icon, temp, precip);
    elements.hourlyForecast.appendChild(item);
  });
}

function renderDaily(days) {
  elements.dailyForecast.replaceChildren();
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
    const iconLine = document.createElement("span");
    const condition = document.createElement("span");
    const low = document.createElement("span");
    const track = document.createElement("span");
    const high = document.createElement("span");
    const chevron = document.createElement("span");
    const detailPanel = renderDailyDetailPanel(day.details, index);

    card.className = "daily-day-card";
    row.className = "daily-row";
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
    chevron.className = "day-chevron";
    chevron.setAttribute("aria-hidden", "true");

    dayName.textContent = day.day;
    setIcon(icon, day.icon, "");
    precip.textContent = dailyPrecipText(day);
    precip.hidden = !dailyPrecipText(day);
    condition.textContent = day.condition;
    iconLine.append(icon, precip);
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

    row.append(dayName, iconGroup, low, track, high, chevron);
    row.addEventListener("click", () => togglePanel(row, detailPanel));
    card.append(row, detailPanel);
    elements.dailyForecast.appendChild(card);
  });
}

function renderDailyDetailPanel(details, index) {
  const panel = document.createElement("section");
  const story = document.createElement("div");
  const metrics = document.createElement("div");
  panel.className = "daily-detail-panel";
  panel.id = `dailyDetail${index}`;
  panel.hidden = true;
  story.className = "day-story";
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
    const label = document.createElement("span");
    const value = document.createElement("strong");
    metric.className = "day-metric";
    label.textContent = item.label;
    value.textContent = item.value;
    metric.append(label, value);
    metrics.appendChild(metric);
  });

  panel.append(story, metrics);
  return panel;
}

function dailyPrecipText(day) {
  const amount = day.precipAmount || "";
  const percent = shouldShowPrecipPercent(day.precip) || amount ? day.precip : "";
  return [percent, amount].filter(Boolean).join(" / ");
}

function togglePanel(button, panel, force) {
  const shouldOpen = typeof force === "boolean" ? force : panel.hidden;
  panel.hidden = !shouldOpen;
  button.setAttribute("aria-expanded", String(shouldOpen));
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

function toggleSettings(force) {
  const shouldOpen = typeof force === "boolean" ? force : elements.settingsPanel.hidden;
  elements.settingsPanel.hidden = !shouldOpen;
  elements.settingsToggle.setAttribute("aria-expanded", String(shouldOpen));
  if (shouldOpen) {
    if (elements.autoLocationToggle) elements.autoLocationToggle.checked = autoLocationEnabled;
    elements.locationInput.value = currentLocation.query || currentLocation.label;
    elements.locationStatus.textContent = "";
    elements.locationInput.focus();
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
    if (event.target.closest("#hourlyForecast")) return;
    togglePanel(elements.currentCard, elements.expandedWeather);
  });
  elements.currentCard.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
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
  const location = await locationForDashboard();
  if (requestId !== dashboardRequestId) return;
  setText("locationLabel", location.label);
  updateRadarLocation(location);
  const data = await weatherService.getWeather(location);
  if (requestId !== dashboardRequestId) return;
  renderCurrentWeather(data);
  renderSummaryStats(data.summaryStats);
  renderDetails(data.details);
  renderPrecipitation(data.precipitation);
  renderAlert(data.alert);
  renderHourly(data.hourly);
  renderDaily(data.daily);
  animateTemperatureRefresh();
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
  window.setInterval(updateClock, 30000);
}

document.addEventListener("DOMContentLoaded", startApp);











