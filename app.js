const ICON_PATH = "icons/";
const DEFAULT_LOCATION = { label: "Olathe, KS", query: "Olathe, KS", city: "Olathe", state: "KS", lat: 38.9, lon: -94.84 };
const LOCATION_STORAGE_KEY = "skystation-location";
const AIRNOW_KEY_STORAGE_KEY = "skystation-airnow-key";
const nwsPointUrl = ({ lat, lon }) => `https://api.weather.gov/points/${lat},${lon}`;
const nwsAlertsUrl = ({ lat, lon }) => `https://api.weather.gov/alerts/active?point=${lat},${lon}`;
const airQualityUrl = ({ lat, lon }) => `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=us_aqi&timezone=auto`;
const openMeteoForecastUrl = ({ lat, lon }) => `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,dew_point_2m,apparent_temperature,precipitation,rain,showers,snowfall,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m&hourly=precipitation_probability,visibility&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,uv_index_max,sunrise,sunset&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=auto&forecast_days=7&forecast_hours=1`;
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
  precipitation: { active: false, type: "Rain", icon: "weather-rain.svg", summary: "No significant precipitation expected.", current: "0% now", nextHour: "0% next hour", today: "", timeline: [], note: "No precipitation expected soon." },
  details: [],
  alert: null,
  hourly: [],
  daily: []
};

class WeatherService {
  async getWeather(location = DEFAULT_LOCATION) {
    const fallback = this.clone(emptyWeather);
    fallback.location = { city: location.label };

    try {
      const liveData = await this.getNwsWeather(location);
      return { ...fallback, ...liveData };
    } catch (error) {
      console.warn("Live weather unavailable.", error);
      return fallback;
    }
  }

  clone(data) {
    return JSON.parse(JSON.stringify(data));
  }

  async getNwsWeather(location) {
    const point = await this.fetchJson(nwsPointUrl(location));
    const properties = point.properties;
    const [forecast, hourly, alerts, observation, airQuality, supplemental] = await Promise.all([
      this.fetchJson(properties.forecast),
      this.fetchJson(properties.forecastHourly),
      this.fetchJson(nwsAlertsUrl(location)),
      this.getLatestObservation(properties.observationStations),
      this.getAirQuality(location),
      this.getSupplementalWeather(location)
    ]);

    const hourlyPeriods = hourly.properties.periods || [];
    const forecastPeriods = forecast.properties.periods || [];
    const currentPeriod = hourlyPeriods[0] || forecastPeriods[0];
    const current = this.mapCurrent(currentPeriod, forecastPeriods, observation, supplemental);
    const precipitation = this.mapPrecipitation(currentPeriod, hourlyPeriods, supplemental);

    return {
      location: { city: location.label },
      current,
      summaryStats: this.mapSummaryStats(current, currentPeriod, observation, precipitation, airQuality, supplemental),
      narrative: this.mapNarrative(currentPeriod, forecastPeriods),
      precipitation,
      details: this.mapDetails(currentPeriod, observation, precipitation, supplemental),
      alert: this.mapAlert(alerts),
      hourly: this.mapHourly(hourlyPeriods),
      daily: this.mapDaily(forecastPeriods, supplemental)
    };
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
      const data = await this.fetchJson(airQualityUrl(location));
      const value = Math.round(data.current?.us_aqi);
      if (!Number.isFinite(value)) return null;
      return {
        value,
        category: this.airQualityCategory(value),
        tone: this.airQualityTone(value),
        source: "Open-Meteo"
      };
    } catch (error) {
      console.warn("Open-Meteo air quality unavailable.", error);
      return null;
    }
  }

  async getSupplementalWeather(location) {
    const [sun, uvIndex, openMeteo] = await Promise.all([
      this.getSunData(location),
      this.getUvIndex(location),
      this.getOpenMeteoWeather(location)
    ]);

    return {
      ...openMeteo,
      uvIndex: uvIndex ?? openMeteo?.uvIndex ?? null,
      sunrise: sun?.sunrise || openMeteo?.sunrise || null,
      sunset: sun?.sunset || openMeteo?.sunset || null
    };
  }

  async getSunData(location) {
    try {
      const data = await this.fetchJson(sunUrl(location));
      return {
        sunrise: this.formatSunTime(data.sunrise),
        sunset: this.formatSunTime(data.sunset)
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
        visibility: this.numberOrNull(hourly.visibility?.[0]),
        high: this.numberOrNull(daily.temperature_2m_max?.[0]),
        low: this.numberOrNull(daily.temperature_2m_min?.[0]),
        dailyPrecipAmount: this.numberOrNull(daily.precipitation_sum?.[0]),
        dailyPrecipAmounts: (daily.precipitation_sum || []).map((value) => this.numberOrNull(value)),
        dailyHighs: (daily.temperature_2m_max || []).map((value) => this.numberOrNull(value)),
        dailyLows: (daily.temperature_2m_min || []).map((value) => this.numberOrNull(value)),
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
    return {
      label: `${place["place name"]}, ${place["state abbreviation"]}`,
      query: zip,
      zip,
      city: place["place name"],
      state: place["state abbreviation"],
      lat: Number(place.latitude).toFixed(4),
      lon: Number(place.longitude).toFixed(4)
    };
  }

  async resolvePlace(query) {
    const data = await this.fetchJson(`https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=1&countrycodes=us&q=${encodeURIComponent(query)}`);
    const place = data?.[0];
    if (!place) throw new Error("Location not found.");
    const labelParts = place.display_name.split(",").map((part) => part.trim());
    const city = place.address?.city || place.address?.town || place.address?.village || labelParts[0] || query;
    const state = this.stateAbbreviation(place.address?.state || labelParts.find((part) => this.stateAbbreviation(part)));
    return {
      label: state ? `${city}, ${state}` : this.shortLocationLabel(labelParts, query),
      query,
      city,
      state,
      lat: Number(place.lat).toFixed(4),
      lon: Number(place.lon).toFixed(4)
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

  mapCurrent(period, forecastPeriods, observation, supplemental) {
    const temp = period?.temperature ?? supplemental?.temperature ?? null;
    const todayHigh = forecastPeriods.find((item) => item.isDaytime)?.temperature ?? supplemental?.high ?? temp;
    const tonightLow = forecastPeriods.find((item) => !item.isDaytime)?.temperature ?? supplemental?.low ?? null;
    const feelsLike = this.readTemperature(observation?.properties?.heatIndex?.value)
      || this.readTemperature(observation?.properties?.windChill?.value)
      || supplemental?.feelsLike
      || temp;

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
    const airQualityValue = airQuality ? `${airQuality.value} ${airQuality.category}` : "0 Good";
    const windValue = `${period?.windDirection || ""} ${period?.windSpeed || ""}`.trim()
      || this.formatOpenMeteoWind(supplemental)
      || "0 mph";

    return [
      { label: "High/Low", value: `${this.formatMaybeTemp(current.high)} / ${this.formatMaybeTemp(current.low)}` },
      { label: "Humidity", value: this.readPercent(this.firstNumber(observation?.properties?.relativeHumidity?.value, supplemental?.humidity)) },
      { label: "Wind", value: windValue },
      { label: "Precipitation", value: precipitation.active ? `${precipitation.type} ${precipitation.current}` : "None" },
      { label: "Air Quality", value: airQualityValue, tone: airQuality?.tone }
    ];
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
    return [
      { icon: "rain-chance.svg", label: "Precip Chance", value: this.precipChance(period, supplemental) },
      { icon: "weather-rain.svg", label: "Precip Amount", value: precipitation?.today?.replace(" today", "") || "0.00 in" },
      { icon: "humidity.svg", label: "Humidity", value: this.readPercent(this.firstNumber(observation?.properties?.relativeHumidity?.value, supplemental?.humidity)) },
      { icon: "dew.svg", label: "Dew Point", value: this.readTemperatureLabel(observation?.properties?.dewpoint?.value, supplemental?.dewPoint) },
      { icon: "uv.svg", label: "UV Index", value: this.formatUvIndex(supplemental?.uvIndex) },
      { icon: "visibility.svg", label: "Visibility", value: this.readDistance(this.firstNumber(observation?.properties?.visibility?.value, supplemental?.visibility)) },
      { icon: "pressure.svg", label: "Pressure", value: this.readPressureWithFallback(observation?.properties?.barometricPressure?.value, supplemental?.pressure) },
      { icon: "sunrise.svg", label: "Sunrise / Sunset", value: `${supplemental?.sunrise || "--"} / ${supplemental?.sunset || "--"}`, type: "sun", sunrise: supplemental?.sunrise || "--", sunset: supplemental?.sunset || "--" }
    ];
  }

  formatUvIndex(value) {
    if (!Number.isFinite(value)) return "0 Low";
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
    const wetHours = hourlyPeriods.slice(0, 6).filter((period) => this.precipValue(period) > 0);
    const type = this.precipType(currentPeriod?.shortForecast || wetHours[0]?.shortForecast);
    const expectedAmount = this.expectedPrecipAmount(hourlyPeriods, supplemental);
    const active = expectedAmount >= 0.15;

    return {
      active,
      type,
      icon: type === "Snow" ? "weather-snow.svg" : "weather-rain.svg",
      summary: active ? `${type} totals may reach ${expectedAmount.toFixed(2)} in based on the latest forecast.` : "No significant precipitation expected.",
      current: active ? `${chance}% now` : "0% now",
      nextHour: `${this.precipValue(hourlyPeriods[1])}% next hour`,
      today: expectedAmount > 0 ? `${expectedAmount.toFixed(2)} in today` : "",
      timeline: this.nextHourPrecipTimeline(hourlyPeriods),
      note: this.precipNote(hourlyPeriods)
    };
  }

  mapAlert(alerts) {
    const activeAlert = alerts.features?.[0]?.properties;
    if (!activeAlert) return null;
    const headline = activeAlert.event || "Weather Alert";
    const summary = activeAlert.headline || activeAlert.description || "An active weather alert has been issued for this area.";
    const details = [
      this.cleanAlertText(activeAlert.description),
      activeAlert.instruction ? `What to do:\n${this.cleanAlertText(activeAlert.instruction)}` : "",
      activeAlert.areaDesc ? `Areas affected:\n${this.cleanAlertText(activeAlert.areaDesc)}` : "",
      activeAlert.expires ? `Expires:\n${this.formatAlertTime(activeAlert.expires)}` : ""
    ].filter(Boolean);

    return {
      headline,
      body: this.cleanAlertText(summary),
      details: [...new Set(details)].join("\n\n")
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

    const todayLabel = this.currentCentralDayLabel();
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
        metrics: this.dayMetrics(low, high, precip, text, precipAmount)
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
        metrics: this.dayMetrics(temp, temp, precip, text, precipAmount)
      }
    };
  }

  dayMetrics(low, high, precip, text, precipAmount) {
    return [
      { label: "Temperature", value: `${this.formatMaybeTemp(low)} - ${this.formatMaybeTemp(high)}` },
      { label: "Feels Like", value: this.feelsLikeFromText(text, low, high) },
      { label: "Precip Chance", value: precip > 0 ? `${precip}%` : "0%" },
      { label: "Precip Amount", value: precipAmount || "0.00 in" }
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
    if (value.includes("snow") || value.includes("sleet") || value.includes("ice")) return "Snow";
    return "Rain";
  }

  precipValue(period, supplemental) {
    const nwsValue = period?.probabilityOfPrecipitation?.value;
    const fallbackValue = supplemental?.precipChance;
    return Math.round(this.firstNumber(nwsValue, fallbackValue) || 0);
  }

  precipChance(period, supplemental) {
    const chance = this.precipValue(period, supplemental);
    return chance > 0 ? `${chance}%` : "None";
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

    const maxChance = Math.max(...periods.slice(0, 12).map((period) => this.precipValue(period)), 0);
    if (maxChance >= 70) return 0.18;
    if (maxChance >= 50) return 0.12;
    if (maxChance >= 30) return 0.06;
    return 0;
  }

  precipAmountNumber(value) {
    if (!value) return 0;
    if (value.includes("<")) return Number(value.match(/\d+(?:\.\d+)?/)?.[0] || 0);
    const numbers = value.match(/\d+(?:\.\d+)?/g) || [];
    return numbers.length ? Math.max(...numbers.map(Number)) : 0;
  }

  numberOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  firstNumber(...values) {
    return values.map((value) => this.numberOrNull(value)).find((value) => value !== null) ?? null;
  }

  nextHourPrecipTimeline(periods) {
    const anchors = periods.slice(0, 4).map((period) => this.precipValue(period));
    if (!anchors.length) return [];
    const values = [];
    for (let index = 0; index < 21; index += 1) {
      const position = (index / 20) * Math.max(1, anchors.length - 1);
      const leftIndex = Math.floor(position);
      const rightIndex = Math.min(anchors.length - 1, leftIndex + 1);
      const blend = position - leftIndex;
      const value = anchors[leftIndex] + (anchors[rightIndex] - anchors[leftIndex]) * blend;
      values.push(Math.round(value));
    }
    return values;
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
    return typeof value === "number" ? `${Math.round(value)}%` : "0%";
  }

  readDistance(value) {
    if (typeof value !== "number") return "0 mi";
    return `${Math.round(value / 1609.344)} mi`;
  }

  readPressure(value) {
    if (typeof value !== "number") return "0.00 in";
    return `${(value / 3386.389).toFixed(2)} in`;
  }

  readPressureWithFallback(nwsPascalValue, fallbackHpaValue) {
    if (typeof nwsPascalValue === "number") return this.readPressure(nwsPascalValue);
    const hpa = this.numberOrNull(fallbackHpaValue);
    if (hpa === null) return "0.00 in";
    return `${(hpa * 0.029529983).toFixed(2)} in`;
  }

  formatMaybeTemp(value) {
    return Number.isFinite(Number(value)) ? `${value}\u00B0` : "--";
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
    const heatIndex = text.match(/heat index values? as high as (\d+)/i)?.[1];
    if (heatIndex) return `Up to ${heatIndex}\u00B0`;
    return `${this.formatMaybeTemp(low)} - ${this.formatMaybeTemp(high)}`;
  }

  precipAmountFromText(text) {
    if (/less than a tenth/i.test(text)) return "<0.10 in";
    const amount = text.match(/(\d+(?:\.\d+)?)\s*(?:to|-)\s*(\d+(?:\.\d+)?)\s*in/i);
    if (amount) return `${amount[1]} - ${amount[2]} in`;
    const single = text.match(/(\d+(?:\.\d+)?)\s*in/i);
    if (single) return `${single[1]} in`;
    return "";
  }

  currentCentralDayLabel() {
    return new Date().toLocaleDateString("en-US", { weekday: "short", timeZone: "America/Chicago" });
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
    return Math.min(100, Math.max(35, Math.round(((high - low) / 28) * 100)));
  }
}
const weatherService = new WeatherService();
const elements = {};
const formatTemp = (value) => Number.isFinite(Number(value)) ? `${value}\u00B0` : "--";
const iconSrc = (icon) => `${ICON_PATH}${icon}`;
let currentLocation = loadSavedLocation();

function loadSavedLocation() {
  try {
    return JSON.parse(localStorage.getItem(LOCATION_STORAGE_KEY)) || DEFAULT_LOCATION;
  } catch {
    return DEFAULT_LOCATION;
  }
}

function saveLocation(location) {
  currentLocation = location;
  localStorage.setItem(LOCATION_STORAGE_KEY, JSON.stringify(location));
  setText("locationLabel", location.label);
}

function windyUrl(location) {
  return `https://embed.windy.com/embed.html?type=map&location=coordinates&metricRain=in&metricTemp=%C2%B0F&metricWind=mph&zoom=8&overlay=radar&product=radar&level=surface&lat=${location.lat}&lon=${location.lon}&detailLat=${location.lat}&detailLon=${location.lon}&marker=true&message=true`;
}

function updateRadarLocation(location) {
  const src = windyUrl(location);
  if (elements.radarPreviewFrame?.src !== src) elements.radarPreviewFrame.src = src;
  if (elements.radarFrame?.src !== src) elements.radarFrame.src = src;
  setText("radarPreviewLabel", `Windy radar centered on ${location.label}`);
  setText("radarPanelLabel", `Clean live radar view for ${location.label}.`);
}

function cacheElements() {
  [
    "locationLabel", "appClock", "settingsToggle", "settingsPanel", "settingsClose", "locationForm", "locationInput", "locationStatus",
    "currentCard", "currentTemp", "currentIcon",
    "condition", "feelsLike", "currentStats", "detailsGrid", "precipCard", "precipIcon", "precipSummary", "precipAmounts", "alertCard",
    "alertHeadline", "alertBody", "alertDetails", "hourlyForecast", "dailyForecast",
    "expandedWeather", "currentNarrative", "radarPreviewCard", "radarPreviewFrame", "radarFrame", "radarPreviewLabel", "radarPanelLabel", "radarToggle", "radarPanel", "radarClose", "radarTime"
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
  setText("condition", data.current.condition);
  setText("feelsLike", formatTemp(data.current.feelsLike));
  setText("currentNarrative", data.narrative);
}

function renderSummaryStats(stats) {
  elements.currentStats.replaceChildren();
  stats.forEach((item) => {
    const row = document.createElement("div");
    const label = document.createElement("span");
    const value = document.createElement("strong");
    row.className = item.tone ? `stat-row ${item.tone}` : "stat-row";
    label.textContent = item.label;
    value.textContent = item.value;
    row.append(label, value);
    elements.currentStats.appendChild(row);
  });
}

function renderDetails(details) {
  elements.detailsGrid.replaceChildren();
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
    } else {
      value.textContent = item.value;
      card.append(icon, label, value);
    }
    elements.detailsGrid.appendChild(card);
  });
}

function hasActivePrecipitation(precipitation) {
  if (!precipitation || !precipitation.active) return false;
  const amount = Number((precipitation.today || "").match(/\d+(?:\.\d+)?/)?.[0] || 0);
  return amount >= 0.15;
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

  ["High", "Med", "Low"].forEach((level) => {
    const label = document.createElement("span");
    label.textContent = level;
    scale.appendChild(label);
  });

  values.forEach((value) => {
    const bar = document.createElement("span");
    bar.style.setProperty("--bar-height", `${Math.max(12, value)}%`);
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
  const peak = Math.max(...values, 0);
  const type = precipitation.type === "Snow" ? "Snow" : "Rain";
  if (peak >= 70) return `High ${type.toLowerCase()} chance next hour`;
  if (peak >= 35) return `Moderate ${type.toLowerCase()} chance next hour`;
  if (peak > 0) return `Low ${type.toLowerCase()} chance next hour`;
  return `No ${type.toLowerCase()} chance next hour`;
}

function normalizeTimeline(values = []) {
  const timeline = values.length ? values : Array.from({ length: 21 }, () => 0);
  return timeline.slice(0, 21).map((value) => Math.max(0, Math.min(100, Number(value) || 0)));
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
  const weekLow = Math.min(...days.map((day) => Number(day.low)).filter(Number.isFinite));
  const weekHigh = Math.max(...days.map((day) => Number(day.high)).filter(Number.isFinite));
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
    const rangeStart = hasRange ? Math.max(0, Math.min(100, ((day.low - weekLow) / weekRange) * 100)) : 0;
    const rangeWidth = hasRange ? Math.max(6, Math.min(100 - rangeStart, ((day.high - day.low) / weekRange) * 100)) : 0;
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

function toggleSettings(force) {
  const shouldOpen = typeof force === "boolean" ? force : elements.settingsPanel.hidden;
  elements.settingsPanel.hidden = !shouldOpen;
  elements.settingsToggle.setAttribute("aria-expanded", String(shouldOpen));
  if (shouldOpen) {
    elements.locationInput.value = currentLocation.query || currentLocation.label;
    elements.locationStatus.textContent = "";
    elements.locationInput.focus();
  }
}

async function handleLocationSubmit(event) {
  event.preventDefault();
  const query = elements.locationInput.value.trim();
  if (!query) return;
  elements.locationStatus.textContent = "Updating location...";

  try {
    const location = await weatherService.resolveLocation(query);
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
  elements.alertCard.addEventListener("click", () => togglePanel(elements.alertCard, elements.alertDetails));
  elements.settingsToggle.addEventListener("click", () => toggleSettings());
  elements.settingsClose.addEventListener("click", () => toggleSettings(false));
  elements.settingsPanel.addEventListener("click", (event) => {
    if (event.target === elements.settingsPanel) toggleSettings(false);
  });
  elements.locationForm.addEventListener("submit", handleLocationSubmit);
}

function animateTemperatureRefresh() {
  elements.currentTemp.classList.add("is-refreshing");
  window.setTimeout(() => elements.currentTemp.classList.remove("is-refreshing"), 420);
}

async function renderDashboard() {
  setText("locationLabel", currentLocation.label);
  updateRadarLocation(currentLocation);
  const data = await weatherService.getWeather(currentLocation);
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











