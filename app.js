const ICON_PATH = "icons/";
const NWS_POINT_URL = "https://api.weather.gov/points/38.9,-94.84";
const NWS_ALERTS_URL = "https://api.weather.gov/alerts/active?point=38.9,-94.84";

const placeholderWeather = {
  location: { city: "Olathe, Kansas" },
  current: {
    temperature: 84,
    icon: "weather-sunny.svg",
    condition: "Sunny",
    feelsLike: 89,
    high: 88,
    low: 64
  },
  summaryStats: [
    { label: "High/Low", value: "88\u00B0 / 64\u00B0" },
    { label: "Humidity", value: "58%" },
    { label: "Wind", value: "SSE 4 mph" },
    { label: "Precipitation", value: "Rain 0.01 in" },
    { label: "Air Quality", value: "Poor", tone: "warning" }
  ],
  narrative: "Clouds are increasing with intermittent rain nearby. Roads may be damp where showers pass through.",
  precipitation: {
    active: false,
    type: "Rain",
    icon: "weather-rain.svg",
    summary: "No precipitation expected soon.",
    current: "0% now",
    nextHour: "0% next hour",
    today: "0% today",
    timeline: [],
    note: "No precipitation expected soon."
  },
  details: [
    { icon: "rain-chance.svg", label: "Chance Rain", value: "30%" },
    { icon: "humidity.svg", label: "Humidity", value: "58%" },
    { icon: "dew.svg", label: "Dew Point", value: "57\u00B0" },
    { icon: "uv.svg", label: "UV Index", value: "5 Moderate" },
    { icon: "visibility.svg", label: "Visibility", value: "10 mi" },
    { icon: "pressure.svg", label: "Pressure", value: "29.92 in" }
  ],
  alert: null,
  hourly: [
    { time: "10 AM", icon: "weather-sunny.svg", temp: 84, precip: "0%" },
    { time: "11 AM", icon: "weather-sunny.svg", temp: 85, precip: "0%" },
    { time: "12 PM", icon: "weather-partly.svg", temp: 86, precip: "10%" },
    { time: "1 PM", icon: "weather-cloud.svg", temp: 87, precip: "20%" },
    { time: "2 PM", icon: "weather-rain.svg", temp: 86, precip: "30%" },
    { time: "3 PM", icon: "weather-storm.svg", temp: 84, precip: "40%" },
    { time: "4 PM", icon: "weather-storm.svg", temp: 82, precip: "60%" },
    { time: "5 PM", icon: "weather-cloud.svg", temp: 80, precip: "40%" }
  ],
  daily: [
    { day: "Fri", icon: "weather-partly.svg", condition: "Partly Cloudy", high: 90, low: 66, precip: "10%", range: 88, details: { story: [{ icon: "weather-partly.svg", title: "Today", text: "Humid with partly cloudy skies and afternoon heat building." }, { icon: "weather-cloud.svg", title: "Tonight", text: "Mild and partly cloudy with a light breeze." }], metrics: [{ label: "Temperature", value: "66 - 90\u00B0" }, { label: "Feels Like", value: "70 - 98\u00B0" }, { label: "Precip Chance", value: "10%" }, { label: "Precip Amount", value: "0.00 in" }, { label: "Sunrise", value: "6:27 AM" }, { label: "Sunset", value: "8:24 PM" }] } },
    { day: "Sat", icon: "weather-storm.svg", condition: "Scattered Storms", high: 86, low: 65, precip: "40%", range: 70, details: { story: [{ icon: "weather-storm.svg", title: "Saturday", text: "Scattered storms may develop during the afternoon and early evening." }, { icon: "weather-rain.svg", title: "Night", text: "Storm chances taper with clouds lingering overnight." }], metrics: [{ label: "Temperature", value: "65 - 86\u00B0" }, { label: "Feels Like", value: "68 - 92\u00B0" }, { label: "Precip Chance", value: "40%" }, { label: "Precip Amount", value: "0.18 in" }, { label: "Sunrise", value: "6:28 AM" }, { label: "Sunset", value: "8:23 PM" }] } },
    { day: "Sun", icon: "weather-sunny.svg", condition: "Sunny", high: 89, low: 67, precip: "10%", range: 84, details: { story: [{ icon: "weather-sunny.svg", title: "Sunday", text: "Sunny, warm, and mostly dry through the day." }, { icon: "weather-cloud.svg", title: "Night", text: "Mostly clear with a warm overnight low." }], metrics: [{ label: "Temperature", value: "67 - 89\u00B0" }, { label: "Feels Like", value: "70 - 95\u00B0" }, { label: "Precip Chance", value: "10%" }, { label: "Precip Amount", value: "0.00 in" }, { label: "Sunrise", value: "6:29 AM" }, { label: "Sunset", value: "8:22 PM" }] } },
    { day: "Mon", icon: "weather-partly.svg", condition: "Partly Cloudy", high: 91, low: 68, precip: "10%", range: 100, details: { story: [{ icon: "weather-partly.svg", title: "Monday", text: "Partly cloudy and hotter, with afternoon heat building." }, { icon: "weather-cloud.svg", title: "Night", text: "Warm and quiet with patchy clouds." }], metrics: [{ label: "Temperature", value: "68 - 91\u00B0" }, { label: "Feels Like", value: "72 - 99\u00B0" }, { label: "Precip Chance", value: "10%" }, { label: "Precip Amount", value: "0.00 in" }, { label: "Sunrise", value: "6:30 AM" }, { label: "Sunset", value: "8:21 PM" }] } },
    { day: "Tue", icon: "weather-storm.svg", condition: "Chance of Storms", high: 87, low: 66, precip: "30%", range: 74, details: { story: [{ icon: "weather-storm.svg", title: "Tuesday", text: "A few storms are possible later in the day." }, { icon: "weather-cloud.svg", title: "Night", text: "Partly cloudy after any evening showers move out." }], metrics: [{ label: "Temperature", value: "66 - 87\u00B0" }, { label: "Feels Like", value: "70 - 93\u00B0" }, { label: "Precip Chance", value: "30%" }, { label: "Precip Amount", value: "0.08 in" }, { label: "Sunrise", value: "6:31 AM" }, { label: "Sunset", value: "8:20 PM" }] } },
    { day: "Wed", icon: "weather-partly.svg", condition: "Partly Cloudy", high: 85, low: 64, precip: "20%", range: 66, details: { story: [{ icon: "weather-partly.svg", title: "Wednesday", text: "Partly cloudy with comfortable morning conditions." }, { icon: "weather-cloud.svg", title: "Night", text: "A few clouds with a slight shower chance." }], metrics: [{ label: "Temperature", value: "64 - 85\u00B0" }, { label: "Feels Like", value: "67 - 90\u00B0" }, { label: "Precip Chance", value: "20%" }, { label: "Precip Amount", value: "0.03 in" }, { label: "Sunrise", value: "6:32 AM" }, { label: "Sunset", value: "8:19 PM" }] } },
    { day: "Thu", icon: "weather-sunny.svg", condition: "Sunny", high: 88, low: 64, precip: "10%", range: 78, details: { story: [{ icon: "weather-sunny.svg", title: "Thursday", text: "Sunny and humid with a light south-southeast breeze." }, { icon: "weather-cloud.svg", title: "Night", text: "Warm evening with a few passing clouds and low rain chances." }], metrics: [{ label: "Temperature", value: "64 - 88\u00B0" }, { label: "Feels Like", value: "69 - 96\u00B0" }, { label: "Precip Chance", value: "10%" }, { label: "Precip Amount", value: "0.00 in" }, { label: "Sunrise", value: "6:33 AM" }, { label: "Sunset", value: "8:18 PM" }] } }
  ]
};

class WeatherService {
  constructor(seedData) {
    this.seedData = seedData;
  }

  async getWeather() {
    const fallback = this.clone(this.seedData);

    try {
      const liveData = await this.getNwsWeather();
      return { ...fallback, ...liveData };
    } catch (error) {
      console.warn("Using placeholder weather data.", error);
      return fallback;
    }
  }

  clone(data) {
    return JSON.parse(JSON.stringify(data));
  }

  async getNwsWeather() {
    const point = await this.fetchJson(NWS_POINT_URL);
    const properties = point.properties;
    const [forecast, hourly, alerts, observation] = await Promise.all([
      this.fetchJson(properties.forecast),
      this.fetchJson(properties.forecastHourly),
      this.fetchJson(NWS_ALERTS_URL),
      this.getLatestObservation(properties.observationStations)
    ]);

    const hourlyPeriods = hourly.properties.periods || [];
    const forecastPeriods = forecast.properties.periods || [];
    const currentPeriod = hourlyPeriods[0] || forecastPeriods[0];
    const current = this.mapCurrent(currentPeriod, forecastPeriods, observation);
    const precipitation = this.mapPrecipitation(currentPeriod, hourlyPeriods);

    return {
      location: { city: "Olathe, Kansas" },
      current,
      summaryStats: this.mapSummaryStats(current, currentPeriod, observation, precipitation),
      narrative: this.mapNarrative(currentPeriod, forecastPeriods),
      precipitation,
      details: this.mapDetails(currentPeriod, observation),
      alert: this.mapAlert(alerts),
      hourly: this.mapHourly(hourlyPeriods),
      daily: this.mapDaily(forecastPeriods)
    };
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
    const response = await fetch(url, { headers: { Accept: "application/geo+json" } });
    if (!response.ok) throw new Error(`Weather request failed: ${response.status}`);
    return response.json();
  }

  mapCurrent(period, forecastPeriods, observation) {
    const temp = period?.temperature ?? this.seedData.current.temperature;
    const todayHigh = forecastPeriods.find((item) => item.isDaytime)?.temperature ?? temp;
    const tonightLow = forecastPeriods.find((item) => !item.isDaytime)?.temperature ?? this.seedData.current.low;
    const feelsLike = this.readTemperature(observation?.properties?.heatIndex?.value)
      || this.readTemperature(observation?.properties?.windChill?.value)
      || temp;

    return {
      temperature: temp,
      icon: this.iconForForecast(period?.shortForecast, period?.isDaytime),
      condition: period?.shortForecast || this.seedData.current.condition,
      feelsLike,
      high: todayHigh,
      low: tonightLow
    };
  }

  mapSummaryStats(current, period, observation, precipitation) {
    const airQuality = this.seedSummary("Air Quality");

    return [
      { label: "High/Low", value: `${current.high}\u00B0 / ${current.low}\u00B0` },
      { label: "Humidity", value: this.readPercent(observation?.properties?.relativeHumidity?.value, this.seedSummaryValue("Humidity")) },
      { label: "Wind", value: `${period?.windDirection || ""} ${period?.windSpeed || ""}`.trim() || this.seedSummaryValue("Wind") },
      { label: "Precipitation", value: precipitation.active ? `${precipitation.type} ${precipitation.current}` : "None" },
      { label: "Air Quality", value: airQuality?.value || "Good", tone: airQuality?.tone }
    ];
  }

  mapDetails(period, observation) {
    return [
      { icon: "rain-chance.svg", label: "Chance Rain", value: this.precipChance(period) },
      { icon: "humidity.svg", label: "Humidity", value: this.readPercent(observation?.properties?.relativeHumidity?.value, this.seedDetailValue("Humidity")) },
      { icon: "dew.svg", label: "Dew Point", value: this.readTemperatureLabel(observation?.properties?.dewpoint?.value, this.seedDetailValue("Dew Point")) },
      { icon: "uv.svg", label: "UV Index", value: this.seedDetailValue("UV Index") },
      { icon: "visibility.svg", label: "Visibility", value: this.readDistance(observation?.properties?.visibility?.value, this.seedDetailValue("Visibility")) },
      { icon: "pressure.svg", label: "Pressure", value: this.readPressure(observation?.properties?.barometricPressure?.value, this.seedDetailValue("Pressure")) }
    ];
  }

  mapNarrative(period, forecastPeriods) {
    const matchingPeriod = forecastPeriods.find((item) => item.isDaytime === period?.isDaytime) || forecastPeriods[0];
    return matchingPeriod?.detailedForecast || period?.detailedForecast || period?.shortForecast || this.seedData.narrative;
  }

  mapPrecipitation(currentPeriod, hourlyPeriods) {
    const chance = this.precipValue(currentPeriod);
    const wetHours = hourlyPeriods.slice(0, 6).filter((period) => this.precipValue(period) > 0);
    const type = this.precipType(currentPeriod?.shortForecast || wetHours[0]?.shortForecast);
    const expectedAmount = this.expectedPrecipAmount(hourlyPeriods);
    const active = expectedAmount >= 0.15;

    return {
      active,
      type,
      icon: type === "Snow" ? "weather-snow.svg" : "weather-rain.svg",
      summary: active ? `${type} totals may reach ${expectedAmount.toFixed(2)} in based on the latest forecast.` : "No significant precipitation expected.",
      current: active ? `${chance}% now` : "0% now",
      nextHour: `${this.precipValue(hourlyPeriods[1])}% next hour`,
      today: `${expectedAmount.toFixed(2)} in today`,
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

  mapDaily(periods) {
    const days = [];

    for (let index = 0; index < periods.length && days.length < 7; index += 1) {
      const dayPeriod = periods[index];
      if (!dayPeriod.isDaytime) continue;
      const nightPeriod = periods.slice(index + 1).find((period) => !period.isDaytime);
      days.push(this.buildDailyForecast(dayPeriod, nightPeriod));
    }

    const todayLabel = this.currentCentralDayLabel();
    if (days.length && days[0].day !== todayLabel) {
      days.unshift(this.buildTodayCarryover(periods[0], todayLabel));
    }

    return days.length ? days.slice(0, 7) : this.clone(this.seedData.daily);
  }

  buildDailyForecast(dayPeriod, nightPeriod) {
    const low = nightPeriod?.temperature ?? dayPeriod.temperature;
    const high = dayPeriod.temperature;
    const precip = Math.max(this.precipValue(dayPeriod), this.precipValue(nightPeriod));
    const text = `${dayPeriod.detailedForecast || ""} ${nightPeriod?.detailedForecast || ""}`;
    const fallbackDay = this.seedDay(this.dayLabel(dayPeriod.startTime));

    return {
      day: this.dayLabel(dayPeriod.startTime),
      icon: this.iconForForecast(dayPeriod.shortForecast, true),
      condition: dayPeriod.shortForecast,
      high,
      low,
      precip: precip > 0 ? `${precip}%` : "0%",
      precipAmount: this.precipAmountFromText(text, fallbackDay),
      range: this.rangeWidth(low, high),
      details: {
        story: [
          { icon: this.iconForForecast(dayPeriod.shortForecast, true), title: this.dayTitle(dayPeriod.startTime), text: dayPeriod.detailedForecast || dayPeriod.shortForecast },
          { icon: this.iconForForecast(nightPeriod?.shortForecast, false), title: this.nightTitle(dayPeriod.startTime), text: nightPeriod?.detailedForecast || fallbackDay.details.story[1].text }
        ],
        metrics: this.dayMetrics(low, high, precip, text, fallbackDay)
      }
    };
  }

  buildTodayCarryover(period, todayLabel) {
    const fallbackDay = this.seedDay(todayLabel);
    const low = fallbackDay.low ?? this.seedData.current.low;
    const high = fallbackDay.high ?? this.seedData.current.high;
    const precip = this.precipValue(period) || Number((fallbackDay.precip || "0").replace("%", ""));
    const text = period?.detailedForecast || fallbackDay.details.story[1].text;

    return {
      ...fallbackDay,
      day: todayLabel,
      icon: this.iconForForecast(period?.shortForecast || fallbackDay.condition, false),
      condition: period?.shortForecast || fallbackDay.condition,
      high,
      low,
      precip: precip > 0 ? `${precip}%` : "0%",
      precipAmount: this.precipAmountFromText(text, fallbackDay),
      range: this.rangeWidth(low, high),
      details: {
        story: [
          fallbackDay.details.story[0],
          { icon: this.iconForForecast(period?.shortForecast || fallbackDay.condition, false), title: "Tonight", text }
        ],
        metrics: this.dayMetrics(low, high, precip, text, fallbackDay)
      }
    };
  }

  dayMetrics(low, high, precip, text, fallbackDay) {
    return [
      { label: "Temperature", value: `${low} - ${high}\u00B0` },
      { label: "Feels Like", value: this.feelsLikeFromText(text, low, high, fallbackDay) },
      { label: "Precip Chance", value: precip > 0 ? `${precip}%` : "0%" },
      { label: "Precip Amount", value: this.precipAmountFromText(text, fallbackDay) },
      { label: "Sunrise", value: this.seedMetricValue(fallbackDay, "Sunrise") },
      { label: "Sunset", value: this.seedMetricValue(fallbackDay, "Sunset") }
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

  precipValue(period) {
    return Math.round(period?.probabilityOfPrecipitation?.value || 0);
  }

  precipChance(period) {
    const chance = this.precipValue(period);
    return chance > 0 ? `${chance}%` : "None";
  }

  precipNote(periods) {
    const firstWetIndex = periods.slice(0, 7).findIndex((period) => this.precipValue(period) > 0);
    if (firstWetIndex < 0) return "No precipitation expected soon.";
    const lastWetIndex = periods.slice(0, 7).reduce((last, period, index) => this.precipValue(period) > 0 ? index : last, firstWetIndex);
    return `Rain starting in ${firstWetIndex * 10} min., stopping ${Math.max(10, (lastWetIndex - firstWetIndex + 1) * 10)} min. later.`;
  }

  expectedPrecipAmount(periods) {
    const text = periods.slice(0, 12).map((period) => period.detailedForecast || period.shortForecast || "").join(" ");
    const parsed = this.precipAmountNumber(this.precipAmountFromText(text, this.seedData.daily[0]));
    if (parsed > 0) return parsed;

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

  readTemperatureLabel(value, fallback = "57\u00B0") {
    const temp = this.readTemperature(value);
    return temp === null ? fallback : `${temp}\u00B0`;
  }

  readPercent(value, fallback = "0%") {
    return typeof value === "number" ? `${Math.round(value)}%` : fallback;
  }

  readDistance(value, fallback = "10 mi") {
    if (typeof value !== "number") return fallback;
    return `${Math.round(value / 1609.344)} mi`;
  }

  readPressure(value, fallback = "29.92 in") {
    if (typeof value !== "number") return fallback;
    return `${(value / 3386.389).toFixed(2)} in`;
  }

  seedSummary(label) {
    return this.seedData.summaryStats.find((item) => item.label === label);
  }

  seedSummaryValue(label) {
    return this.seedSummary(label)?.value || "Current";
  }

  seedDetailValue(label) {
    return this.seedData.details.find((item) => item.label === label)?.value || "Current";
  }

  seedDay(day) {
    return this.seedData.daily.find((item) => item.day === day) || this.seedData.daily[0];
  }

  seedMetricValue(day, label) {
    return day.details.metrics.find((item) => item.label === label)?.value || this.seedData.daily[0].details.metrics.find((item) => item.label === label)?.value;
  }

  feelsLikeFromText(text, low, high, fallbackDay) {
    const heatIndex = text.match(/heat index values? as high as (\d+)/i)?.[1];
    if (heatIndex) return `Up to ${heatIndex}\u00B0`;
    return this.seedMetricValue(fallbackDay, "Feels Like") || `${low} - ${high}\u00B0`;
  }

  precipAmountFromText(text, fallbackDay) {
    if (/less than a tenth/i.test(text)) return "<0.10 in";
    const amount = text.match(/(\d+(?:\.\d+)?)\s*(?:to|-)\s*(\d+(?:\.\d+)?)\s*in/i);
    if (amount) return `${amount[1]} - ${amount[2]} in`;
    const single = text.match(/(\d+(?:\.\d+)?)\s*in/i);
    if (single) return `${single[1]} in`;
    return this.seedMetricValue(fallbackDay, "Precip Amount") || "0.00 in";
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
const weatherService = new WeatherService(placeholderWeather);
const elements = {};
const formatTemp = (value) => `${value}\u00B0`;
const iconSrc = (icon) => `${ICON_PATH}${icon}`;

function cacheElements() {
  [
    "currentWeatherTitle", "currentClock", "currentTemp", "currentIcon",
    "condition", "feelsLike", "currentStats", "detailsGrid", "precipCard", "precipIcon", "precipSummary", "precipAmounts", "alertCard",
    "alertHeadline", "alertBody", "alertDetails", "hourlyForecast", "dailyForecast",
    "expandedWeather", "detailsToggle", "currentNarrative", "radarToggle", "radarPanel", "radarClose", "radarTime"
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
  setText("currentClock", time);
  setText("radarTime", time);
}

function renderCurrentWeather(data) {
  setText("currentWeatherTitle", `Current Weather in ${data.location.city}`);
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
    card.className = "quick-item";
    label.className = "quick-label";
    value.className = "quick-value";
    setIcon(icon, item.icon, "");
    label.textContent = item.label;
    value.textContent = item.value;
    card.append(icon, label, value);
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
  const weekRange = Math.max(1, weekHigh - weekLow);

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
    const rangeStart = Math.max(0, Math.min(100, ((day.low - weekLow) / weekRange) * 100));
    const rangeWidth = Math.max(6, Math.min(100 - rangeStart, ((day.high - day.low) / weekRange) * 100));
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
  const amount = day.precipAmount && day.precipAmount !== "0.00 in" ? day.precipAmount : "";
  const percent = shouldShowPrecipPercent(day.precip) || amount ? day.precip : "";
  return [percent, amount].filter(Boolean).join(" / ");
}

function togglePanel(button, panel, force) {
  const shouldOpen = typeof force === "boolean" ? force : panel.hidden;
  panel.hidden = !shouldOpen;
  button.setAttribute("aria-expanded", String(shouldOpen));
}

function bindInteractions() {
  elements.detailsToggle.addEventListener("click", () => togglePanel(elements.detailsToggle, elements.expandedWeather));
  elements.radarToggle.addEventListener("click", () => togglePanel(elements.radarToggle, elements.radarPanel));
  elements.radarClose.addEventListener("click", () => togglePanel(elements.radarToggle, elements.radarPanel, false));
  elements.alertCard.addEventListener("click", () => togglePanel(elements.alertCard, elements.alertDetails));
}

function animateTemperatureRefresh() {
  elements.currentTemp.classList.add("is-refreshing");
  window.setTimeout(() => elements.currentTemp.classList.remove("is-refreshing"), 420);
}

async function renderDashboard() {
  const data = await weatherService.getWeather();
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











