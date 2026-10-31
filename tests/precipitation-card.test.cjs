const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

function loadApp() {
  const document = {
    addEventListener() {},
    createElement(tag) {
      return {
        tag,
        children: [],
        append(...children) { this.children.push(...children); },
        appendChild(child) { this.children.push(child); },
        replaceChildren(...children) { this.children = children; }
      };
    }
  };
  const context = {
    console,
    document,
    localStorage: { getItem: () => null },
    URL,
    URLSearchParams
  };
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.testApi = { WeatherService, renderPrecipitation, elements };`, context);
  return { ...context.testApi, document };
}

function weatherInputs({ condition = "Partly Cloudy", chance = 10, amounts = [0, 0, 0, 0], chances = [8, 11, 14, 17], radar = null, station = null, stationAgeMinutes = 0, currentAmount = 0 } = {}) {
  const now = Date.now();
  const period = {
    shortForecast: condition,
    startTime: new Date(now).toISOString(),
    endTime: new Date(now + 60 * 60000).toISOString(),
    probabilityOfPrecipitation: { value: chance }
  };
  const next = {
    shortForecast: "Partly Cloudy",
    startTime: period.endTime,
    endTime: new Date(now + 120 * 60000).toISOString(),
    probabilityOfPrecipitation: { value: 10 }
  };
  const supplemental = {
    minutelyPrecipTimes: [15, 30, 45, 60].map((minute) => now + minute * 60000),
    minutelyPrecipChances: chances,
    minutelyPrecipAmounts: amounts,
    precipitationAmount: currentAmount,
    iemRadar: radar === null ? null : { dbz: radar, validAt: new Date(now).toISOString() }
  };
  const observation = station === null ? null : {
    properties: { textDescription: station, timestamp: new Date(now - stationAgeMinutes * 60000).toISOString() }
  };
  return { period, hours: [period, next], supplemental, observation };
}

function card(service, options) {
  const { period, hours, supplemental, observation } = weatherInputs(options);
  return service.mapPrecipitation(period, hours, supplemental, observation);
}

test("low rain chances leave the precipitation card hidden", () => {
  const { WeatherService } = loadApp();
  const precipitation = card(new WeatherService(), { station: "Partly Cloudy" });
  assert.equal(precipitation.active, false);
});

test("fresh nearby rain report shows now without claiming the user's exact spot", () => {
  const { WeatherService } = loadApp();
  const precipitation = card(new WeatherService(), { station: "Light Rain" });
  assert.equal(precipitation.active, true);
  assert.equal(precipitation.timing, "Now");
  assert.equal(precipitation.intensity, "Light");
  assert.match(precipitation.summary, /Nearby station reports light rain now/);
});

test("strong radar return opens the card even when the station says partly cloudy", () => {
  const { WeatherService } = loadApp();
  const precipitation = card(new WeatherService(), { station: "Partly Cloudy", radar: 45 });
  assert.equal(precipitation.active, true);
  assert.equal(precipitation.signal, "radar");
  assert.equal(precipitation.intensity, "Strong radar");
  assert.match(precipitation.summary, /Radar detects precipitation/);
});

test("strong current model rain stays labelled forecast when radar has no echo", () => {
  const { WeatherService } = loadApp();
  const precipitation = card(new WeatherService(), {
    station: "Partly Cloudy", radar: 0, chance: 70, currentAmount: 0.08
  });
  assert.equal(precipitation.active, true);
  assert.equal(precipitation.signal, "model-current");
  assert.equal(precipitation.intensity, "Heavy forecast");
  assert.match(precipitation.summary, /forecast around now/);
});

test("stale rain report does not claim current rain", () => {
  const { WeatherService } = loadApp();
  const { period, hours, supplemental, observation } = weatherInputs({
    condition: "Partly Cloudy", station: "Light Rain", stationAgeMinutes: 45
  });
  const service = new WeatherService();
  assert.equal(service.currentConditionText(period, observation), "Partly Cloudy");
  assert.equal(service.mapPrecipitation(period, hours, supplemental, observation).active, false);
});

test("duration uses the end of the last wet 15-minute window", () => {
  const { WeatherService } = loadApp();
  const precipitation = card(new WeatherService(), {
    station: "Light Rain", chances: [70, 70, 10, 10], amounts: [0.02, 0.02, 0, 0]
  });
  assert.equal(precipitation.duration, "~30 min left");
});

test("high confidence 15-minute rain forecast gives a cautious heads up and duration", () => {
  const { WeatherService } = loadApp();
  const precipitation = card(new WeatherService(), {
    station: "Partly Cloudy",
    chances: [70, 70, 10, 10],
    amounts: [0.08, 0.08, 0, 0]
  });
  assert.equal(precipitation.active, true);
  assert.equal(precipitation.signal, "minute-forecast");
  assert.equal(precipitation.timing, "Within 15 min");
  assert.equal(precipitation.intensity, "Heavy forecast");
  assert.equal(precipitation.duration, "~30 min");
  assert.match(precipitation.summary, /possible within 15 min/);
});

test("NWS likely rain can give a forecast heads up when the 15-minute model is dry", () => {
  const { WeatherService } = loadApp();
  const precipitation = card(new WeatherService(), {
    condition: "Rain Showers Likely",
    chance: 70,
    station: "Partly Cloudy"
  });
  assert.equal(precipitation.active, true);
  assert.equal(precipitation.signal, "nws-forecast");
  assert.equal(precipitation.timing, "This hour");
  assert.match(precipitation.summary, /possible this hour \(NWS forecast\)/);
});

test("definite NWS rain forecast agrees in wording with a Light Rain current card", () => {
  const { WeatherService } = loadApp();
  const precipitation = card(new WeatherService(), {
    condition: "Light Rain", chance: 70
  });
  assert.equal(precipitation.active, true);
  assert.equal(precipitation.timing, "This hour");
  assert.equal(precipitation.intensity, "Light forecast");
  assert.equal(precipitation.summary, "NWS forecasts light rain this hour.");
  assert.equal(precipitation.duration, "~60 min left");
});

test("both layouts render exactly three fields and no forecast chart", () => {
  const { WeatherService, renderPrecipitation, elements } = loadApp();
  const precipitation = card(new WeatherService(), { station: "Light Rain" });
  elements.precipCard = { hidden: true };
  elements.precipIcon = {};
  elements.precipSummary = {};
  elements.precipAmounts = { children: [], replaceChildren(...children) { this.children = children; }, appendChild(child) { this.children.push(child); } };
  renderPrecipitation(precipitation);
  assert.equal(elements.precipCard.hidden, false);
  assert.equal(elements.precipAmounts.children.length, 1);
  const chips = elements.precipAmounts.children[0].children;
  assert.deepEqual(chips.map((chip) => chip.children[0].textContent), ["Timing", "Intensity", "Duration"]);
});
