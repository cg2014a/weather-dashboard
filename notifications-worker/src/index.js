import webpush from "web-push";

const ALLOWED_ORIGINS = new Set([
  "https://cg2014a.github.io",
  "http://localhost:5500"
]);
const TEST_COOLDOWN_MS = 60 * 1000;
const DELIVERY_LOCK_MS = 5 * 60 * 1000;
const PAYLOAD_RETRY_DELAY_MS = 60 * 1000;
const DUE_BATCH_SIZE = 25;
const SEVERE_ALERT_EVENTS = new Set([
  "Tornado Warning",
  "Severe Thunderstorm Warning",
  "Flash Flood Warning",
  "Flood Warning",
  "Blizzard Warning",
  "Winter Storm Warning",
  "Ice Storm Warning",
  "Extreme Heat Warning",
  "Excessive Heat Warning",
  "Extreme Cold Warning",
  "High Wind Warning",
  "Dust Storm Warning",
  "Tornado Watch",
  "Severe Thunderstorm Watch",
  "Flood Watch",
  "Winter Storm Watch",
  "Extreme Cold Watch",
  "High Wind Watch",
  "Heat Advisory",
  "Cold Weather Advisory",
  "Winter Weather Advisory",
  "Wind Advisory",
  "Dense Fog Advisory",
  "Red Flag Warning",
  "Special Weather Statement",
]);
const HIGH_URGENCY_ALERT_EVENTS = new Set([
  "Tornado Warning",
  "Severe Thunderstorm Warning",
  "Flash Flood Warning",
  "Flood Warning",
  "Blizzard Warning",
  "Winter Storm Warning",
  "Ice Storm Warning",
  "Extreme Heat Warning",
  "Excessive Heat Warning",
  "Extreme Cold Warning",
  "High Wind Warning",
  "Dust Storm Warning",
  "Red Flag Warning"
]);

function json(data, status = 200, origin = "") {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8" });
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function corsResponse(request) {
  const origin = request.headers.get("Origin") || "";
  if (!ALLOWED_ORIGINS.has(origin)) return json({ ok: false, error: "Origin is not allowed." }, 403);
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin"
    }
  });
}

function requestOrigin(request) {
  const origin = request.headers.get("Origin") || "";
  return ALLOWED_ORIGINS.has(origin) ? origin : "";
}

function requireAllowedOrigin(request) {
  const origin = requestOrigin(request);
  return origin ? { origin } : { error: json({ ok: false, error: "Origin is not allowed." }, 403) };
}

function validLocation(location) {
  const lat = Number(location?.lat);
  const lon = Number(location?.lon);
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function validSubscription(subscription) {
  return typeof subscription?.endpoint === "string"
    && subscription.endpoint.startsWith("https://")
    && typeof subscription?.keys?.p256dh === "string"
    && typeof subscription?.keys?.auth === "string";
}

function validIdentity(value) {
  return typeof value === "string" && /^[a-f0-9]{40,96}$/i.test(value);
}

function validTimezone(timezone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

async function hash(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function notificationPreference(value, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function localDateParts(timestamp, timezone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const values = Object.fromEntries(formatter.formatToParts(new Date(timestamp))
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, Number(part.value)]));
  return values;
}

function timezoneOffset(timestamp, timezone) {
  const parts = localDateParts(timestamp, timezone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - timestamp;
}

function zonedTimeToTimestamp(year, month, day, hour, minute, timezone) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  let result = utcGuess - timezoneOffset(utcGuess, timezone);
  result = utcGuess - timezoneOffset(result, timezone);
  return result;
}

function nextSixAm(timezone, now = Date.now()) {
  const local = localDateParts(now, timezone);
  let date = new Date(Date.UTC(local.year, local.month - 1, local.day));
  let candidate = zonedTimeToTimestamp(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), 6, 0, timezone);
  if (candidate <= now + 1000) {
    date = new Date(date.getTime() + 24 * 60 * 60 * 1000);
    candidate = zonedTimeToTimestamp(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), 6, 0, timezone);
  }
  return candidate;
}

function nwsHeaders(env) {
  return {
    Accept: "application/geo+json, application/json",
    "User-Agent": env.NWS_USER_AGENT || "SkyStation Notifications (weather@example.com)"
  };
}

async function fetchJson(url, env) {
  const response = await fetch(url, { headers: nwsHeaders(env) });
  if (!response.ok) throw new Error(`Weather source returned ${response.status}.`);
  return response.json();
}

function precipitationLabel(text) {
  const value = String(text || "").toLowerCase();
  if (/snow|flurr/.test(value)) return "Snow";
  if (/sleet|freezing rain|ice pellet/.test(value)) return "Sleet";
  if (/rain|shower|drizzle/.test(value)) return "Rain";
  return "Rain";
}

function firstForecastNumber(text, pattern) {
  const match = String(text || "").match(pattern);
  return match ? Number(match[1]) : null;
}

function dynamicForecastLine(day, alerts) {
  const outlook = String(day?.detailedForecast || "").replace(/\s+/g, " ").trim();
  const shortForecast = String(day?.shortForecast || "");
  const text = `${shortForecast} ${outlook}`;
  const activeAlert = alerts?.features?.[0]?.properties?.event;
  if (activeAlert) return activeAlert;

  const heatIndex = firstForecastNumber(outlook, /heat index(?: values)?(?: as high as| up to)?\s*(\d+)/i);
  if (heatIndex !== null) return `Heat index up to ${heatIndex}°`;

  const snowRange = outlook.match(/(\d+(?:\.\d+)?)\s*(?:to|-)\s*(\d+(?:\.\d+)?)\s*in(?:ch|ches)?(?: of)?\s*snow|snow(?:fall)?(?:[^.]{0,40})?(\d+(?:\.\d+)?)\s*(?:to|-)\s*(\d+(?:\.\d+)?)\s*in(?:ch|ches)?/i);
  if (snowRange) {
    const low = snowRange[1] || snowRange[3];
    const high = snowRange[2] || snowRange[4];
    return `${low}–${high} in of snow possible`;
  }
  const snowTotal = firstForecastNumber(outlook, /(?:snow(?:fall)?(?:[^.]{0,40})?|)(\d+(?:\.\d+)?)\s*in(?:ch|ches)?(?: of)?\s*snow/i)
    ?? firstForecastNumber(outlook, /snow(?:fall)?(?:[^.]{0,40})?(\d+(?:\.\d+)?)\s*in(?:ch|ches)?/i);
  if (snowTotal !== null) return `${snowTotal} in of snow possible`;

  const gusts = firstForecastNumber(outlook, /gusts?(?: as high as| up to)?\s*(\d+)/i);
  if (gusts !== null) return `Gusts up to ${gusts} mph`;

  if (/thunderstorm|thunderstorms|strong storms/i.test(text)) {
    const timing = outlook.match(/\b(after|around|between)\s+([^,.]+)/i);
    return timing ? `Storms possible ${timing[1].toLowerCase()} ${timing[2]}` : "Storms possible today";
  }
  if (/rain|showers|drizzle/i.test(text)) {
    if (/afternoon/i.test(outlook)) return "Rain likely this afternoon";
    if (/evening|tonight/i.test(outlook)) return "Rain likely this evening";
    return "Rain likely today";
  }

  return "";
}

function weatherSummary(forecast, hourly, alerts) {
  const dayPeriods = forecast?.properties?.periods || [];
  const hourlyPeriods = hourly?.properties?.periods || [];
  const current = hourlyPeriods[0] || dayPeriods[0] || {};
  const day = dayPeriods.find((period) => period?.isDaytime) || dayPeriods[0] || {};
  const night = dayPeriods.slice(dayPeriods.indexOf(day) + 1).find((period) => !period?.isDaytime) || {};
  const temperature = Number.isFinite(Number(current.temperature)) ? `${Math.round(Number(current.temperature))}°` : "--°";
  const high = Number.isFinite(Number(day.temperature)) ? `${Math.round(Number(day.temperature))}°` : "--";
  const low = Number.isFinite(Number(night.temperature)) ? `${Math.round(Number(night.temperature))}°` : "--";
  const precipitation = Number(day?.probabilityOfPrecipitation?.value);
  const condition = day.shortForecast || current.shortForecast || "Forecast updating";
  const weatherLine = [condition, `${precipitationLabel(condition)} ${Number.isFinite(precipitation) ? Math.round(precipitation) : 0}%`]
    .filter(Boolean)
    .join(" • ");
  return {
    title: "Forecast",
    body: [`${temperature} now · High ${high} · Low ${low}`, weatherLine, dynamicForecastLine(day, alerts)].filter(Boolean).join("\n"),
    url: "https://cg2014a.github.io/weather-dashboard/"
  };
}

async function buildMorningPayload(record, env) {
  const point = await fetchJson(`https://api.weather.gov/points/${record.latitude},${record.longitude}`, env);
  const properties = point?.properties || {};
  const [forecast, hourly, alerts] = await Promise.all([
    properties.forecast ? fetchJson(properties.forecast, env) : Promise.resolve(null),
    properties.forecastHourly ? fetchJson(properties.forecastHourly, env) : Promise.resolve(null),
    fetchJson(`https://api.weather.gov/alerts/active?point=${record.latitude},${record.longitude}`, env).catch(() => null)
  ]);
  return weatherSummary(forecast, hourly, alerts);
}

async function sendPush(record, payload, env) {
  const { urgency = "high", ...notification } = payload;
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  await webpush.sendNotification(JSON.parse(record.subscription_json), JSON.stringify(notification), { TTL: 900, urgency });
}

async function removeInvalidSubscription(record, env) {
  await env.NOTIFICATIONS_DB.prepare("DELETE FROM push_subscriptions WHERE id = ?1").bind(record.id).run();
}

async function sendToRecord(record, payload, env) {
  try {
    await sendPush(record, payload, env);
    return true;
  } catch (error) {
    const status = Number(error?.statusCode || error?.status || 0);
    if (status === 404 || status === 410) await removeInvalidSubscription(record, env);
    throw error;
  }
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function subscribe(request, env, origin) {
  const body = await readJson(request);
  if (!validIdentity(body?.installationId) || !validIdentity(body?.managementToken) || !validSubscription(body?.subscription) || !validLocation(body?.location) || !validTimezone(body?.timezone)) {
    return json({ ok: false, error: "Invalid notification subscription." }, 400, origin);
  }
  const now = Date.now();
  const id = crypto.randomUUID();
  const managementTokenHash = await hash(body.managementToken);
  const endpointHash = await hash(body.subscription.endpoint);
  const nextDelivery = nextSixAm(body.timezone, now);
  const morningEnabled = notificationPreference(body.morningEnabled, true);
  const severeAlertsEnabled = notificationPreference(body.severeAlertsEnabled, false);
  await env.NOTIFICATIONS_DB.prepare(`
    INSERT INTO push_subscriptions (
      id, installation_id, management_token_hash, endpoint_hash, subscription_json, timezone,
      latitude, longitude, enabled, morning_enabled, severe_alerts_enabled, next_delivery_at, delivery_lock_until, test_cooldown_until, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?10, ?11, 0, 0, ?12, ?12)
    ON CONFLICT(installation_id) DO UPDATE SET
      management_token_hash = excluded.management_token_hash,
      endpoint_hash = excluded.endpoint_hash,
      subscription_json = excluded.subscription_json,
      timezone = excluded.timezone,
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      enabled = 1,
      morning_enabled = excluded.morning_enabled,
      severe_alerts_enabled = excluded.severe_alerts_enabled,
      next_delivery_at = excluded.next_delivery_at,
      delivery_lock_until = 0,
      updated_at = excluded.updated_at
  `).bind(id, body.installationId, managementTokenHash, endpointHash, JSON.stringify(body.subscription), body.timezone, Number(body.location.lat), Number(body.location.lon), morningEnabled ? 1 : 0, severeAlertsEnabled ? 1 : 0, nextDelivery, now).run();
  return json({ ok: true }, 200, origin);
}

async function unsubscribe(request, env, origin) {
  const body = await readJson(request);
  if (!validIdentity(body?.installationId) || !validIdentity(body?.managementToken)) return json({ ok: false, error: "Invalid device." }, 400, origin);
  const managementTokenHash = await hash(body.managementToken);
  await env.NOTIFICATIONS_DB.prepare("DELETE FROM push_subscriptions WHERE installation_id = ?1 AND management_token_hash = ?2").bind(body.installationId, managementTokenHash).run();
  return json({ ok: true }, 200, origin);
}

async function sendTest(request, env, origin) {
  const body = await readJson(request);
  if (!validIdentity(body?.installationId) || !validIdentity(body?.managementToken)) return json({ ok: false, error: "Invalid device." }, 400, origin);
  const now = Date.now();
  const tokenHash = await hash(body.managementToken);
  const record = await env.NOTIFICATIONS_DB.prepare(`
    SELECT * FROM push_subscriptions
    WHERE installation_id = ?1 AND management_token_hash = ?2 AND enabled = 1 AND morning_enabled = 1
    LIMIT 1
  `).bind(body.installationId, tokenHash).first();
  if (!record) return json({ ok: false, error: "No active notification subscription." }, 404, origin);
  const claim = await env.NOTIFICATIONS_DB.prepare(`
    UPDATE push_subscriptions SET test_cooldown_until = ?1, updated_at = ?2
    WHERE id = ?3 AND test_cooldown_until <= ?2
  `).bind(now + TEST_COOLDOWN_MS, now, record.id).run();
  if (!claim.meta.changes) return json({ ok: false, error: "Please wait before sending another test." }, 429, origin);
  try {
    await sendToRecord(record, {
      title: "SkyStation Test",
      body: "Notifications are working. Your morning weather report will arrive at 6:00 AM.",
      url: "https://cg2014a.github.io/weather-dashboard/"
    }, env);
    return json({ ok: true }, 200, origin);
  } catch (error) {
    console.warn("Web Push test delivery failed.", {
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
      status: Number(error?.statusCode || error?.status || 0) || null,
      responseBody: typeof error?.body === "string" ? error.body.slice(0, 1000) : null
    });
    return json({ ok: false, error: "Unable to send test notification." }, 502, origin);
  }
}

async function activeTestRecord(request, env, origin) {
  const body = await readJson(request);
  if (!validIdentity(body?.installationId) || !validIdentity(body?.managementToken)) {
    return { error: json({ ok: false, error: "Invalid device." }, 400, origin) };
  }
  const tokenHash = await hash(body.managementToken);
  const record = await env.NOTIFICATIONS_DB.prepare(`
    SELECT * FROM push_subscriptions
    WHERE installation_id = ?1 AND management_token_hash = ?2 AND enabled = 1 AND severe_alerts_enabled = 1
    LIMIT 1
  `).bind(body.installationId, tokenHash).first();
  return record
    ? { record }
    : { error: json({ ok: false, error: "Severe weather alerts are not enabled." }, 404, origin) };
}

async function processDueNotifications(env) {
  const now = Date.now();
  const due = await env.NOTIFICATIONS_DB.prepare(`
    SELECT * FROM push_subscriptions
    WHERE enabled = 1 AND morning_enabled = 1 AND next_delivery_at <= ?1 AND delivery_lock_until <= ?1
    ORDER BY next_delivery_at ASC LIMIT ?2
  `).bind(now, DUE_BATCH_SIZE).all();
  await Promise.all((due.results || []).map(async (record) => {
    const claimed = await env.NOTIFICATIONS_DB.prepare(`
      UPDATE push_subscriptions SET delivery_lock_until = ?1, updated_at = ?2
      WHERE id = ?3 AND enabled = 1 AND morning_enabled = 1 AND next_delivery_at <= ?2 AND delivery_lock_until <= ?2
    `).bind(now + DELIVERY_LOCK_MS, now, record.id).run();
    if (!claimed.meta.changes) return;
    let payload;
    try {
      payload = await buildMorningPayload(record, env);
    } catch (error) {
      console.warn("Morning notification payload build failed.", error);
      await env.NOTIFICATIONS_DB.prepare("UPDATE push_subscriptions SET delivery_lock_until = ?1, updated_at = ?2 WHERE id = ?3")
        .bind(now + PAYLOAD_RETRY_DELAY_MS, now, record.id).run();
      return;
    }
    try {
      await sendToRecord(record, payload, env);
      await env.NOTIFICATIONS_DB.prepare("UPDATE push_subscriptions SET next_delivery_at = ?1, delivery_lock_until = 0, updated_at = ?2 WHERE id = ?3")
        .bind(nextSixAm(record.timezone, now), now, record.id).run();
    } catch (error) {
      console.warn("Morning notification delivery failed.", error);
      await env.NOTIFICATIONS_DB.prepare("UPDATE push_subscriptions SET delivery_lock_until = ?1, updated_at = ?2 WHERE id = ?3")
        .bind(now + DELIVERY_LOCK_MS, now, record.id).run();
    }
  }));
}

function alertExpiresAt(properties) {
  const values = [properties?.ends, properties?.expires, properties?.effective];
  for (const value of values) {
    const timestamp = new Date(value || "").getTime();
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

function formatAlertEnd(timestamp, timezone) {
  if (!timestamp) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: validTimezone(timezone) ? timezone : "America/Chicago",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(timestamp));
}

function conciseAlertDetail(alert) {
  const properties = alert?.properties || {};
  const candidates = [properties.headline, properties.description, properties.instruction];
  for (const value of candidates) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const sentence = text.match(/^.*?(?:[.!?](?:\s|$)|$)/)?.[0]?.trim() || text;
    if (sentence) return sentence.slice(0, 240);
  }
  return alert?.event || "NWS alert affecting your area.";
}

function qualifyingAlerts(payload, now) {
  return (payload?.features || []).map((feature) => {
    const properties = feature?.properties || {};
    const event = String(properties.event || "").trim();
    const alertId = String(feature?.id || properties.id || "").trim();
    const expiresAt = alertExpiresAt(properties);
    if (!alertId || !SEVERE_ALERT_EVENTS.has(event) || (expiresAt && expiresAt <= now)) return null;
    return { alertId, event, expiresAt, properties };
  }).filter(Boolean);
}

async function severeAlertHash(alert) {
  return hash(JSON.stringify({
    event: alert.event,
    ends: alert.properties.ends || "",
    expires: alert.properties.expires || "",
    headline: alert.properties.headline || "",
    description: alert.properties.description || "",
    instruction: alert.properties.instruction || "",
    messageType: alert.properties.messageType || "",
    severity: alert.properties.severity || "",
    urgency: alert.properties.urgency || ""
  }));
}

function severeAlertPayload(alert, timezone) {
  if (alert.event === "Special Weather Statement") {
    return {
      title: alert.event,
      body: "Special weather conditions are affecting your area. Tap for details.",
      url: "https://cg2014a.github.io/weather-dashboard/",
      urgency: "normal"
    };
  }
  const endTime = formatAlertEnd(alert.expiresAt, timezone);
  return {
    title: alert.event,
    body: `${conciseAlertDetail(alert)}${endTime ? ` Until ${endTime}.` : ""} Tap for details.`,
    url: "https://cg2014a.github.io/weather-dashboard/",
    urgency: HIGH_URGENCY_ALERT_EVENTS.has(alert.event) ? "high" : "normal"
  };
}

async function findActiveRemoteTestAlert(record, env, now) {
  const localPayload = await fetchJson(`https://api.weather.gov/alerts/active?point=${record.latitude},${record.longitude}`, env);
  const localAlertIds = new Set(qualifyingAlerts(localPayload, now).map((alert) => alert.alertId));
  for (const event of SEVERE_ALERT_EVENTS) {
    try {
      const payload = await fetchJson(`https://api.weather.gov/alerts/active?status=actual&event=${encodeURIComponent(event)}`, env);
      const alert = qualifyingAlerts(payload, now).find((item) => !localAlertIds.has(item.alertId));
      if (alert) return alert;
    } catch {
      // Try the remaining supported NWS event types without exposing request details.
    }
  }
  return null;
}

async function sendActiveNwsAlertTest(request, env, origin) {
  const active = await activeTestRecord(request, env, origin);
  if (active.error) return active.error;
  const now = Date.now();
  const alert = await findActiveRemoteTestAlert(active.record, env, now).catch(() => null);
  if (!alert) return json({ ok: false, error: "No active supported NWS alert is available for testing." }, 404, origin);
  const claim = await env.NOTIFICATIONS_DB.prepare(`
    UPDATE push_subscriptions SET test_cooldown_until = ?1, updated_at = ?2
    WHERE id = ?3 AND test_cooldown_until <= ?2
  `).bind(now + TEST_COOLDOWN_MS, now, active.record.id).run();
  if (!claim.meta.changes) return json({ ok: false, error: "Please wait before sending another test." }, 429, origin);
  try {
    const payload = severeAlertPayload(alert, active.record.timezone);
    await sendToRecord(active.record, { ...payload, title: `TEST — ${payload.title}` }, env);
    return json({ ok: true }, 200, origin);
  } catch (error) {
    console.warn("Active NWS alert test delivery failed.", {
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
      status: Number(error?.statusCode || error?.status || 0) || null
    });
    return json({ ok: false, error: "Unable to send active NWS alert test." }, 502, origin);
  }
}

async function claimSevereAlert(record, alert, contentHash, now, env) {
  const result = await env.NOTIFICATIONS_DB.prepare(`
    INSERT INTO severe_alert_notifications (subscription_id, alert_id, content_hash, expires_at, notified_at)
    VALUES (?1, ?2, ?3, ?4, ?5)
    ON CONFLICT(subscription_id, alert_id) DO UPDATE SET
      content_hash = excluded.content_hash,
      expires_at = excluded.expires_at,
      notified_at = excluded.notified_at
    WHERE severe_alert_notifications.content_hash <> excluded.content_hash
  `).bind(record.id, alert.alertId, contentHash, alert.expiresAt, now).run();
  return Boolean(result.meta.changes);
}

async function releaseSevereAlertClaim(record, alert, contentHash, env) {
  await env.NOTIFICATIONS_DB.prepare(`
    DELETE FROM severe_alert_notifications
    WHERE subscription_id = ?1 AND alert_id = ?2 AND content_hash = ?3
  `).bind(record.id, alert.alertId, contentHash).run();
}

async function processSevereAlerts(env) {
  const now = Date.now();
  const subscriptions = await env.NOTIFICATIONS_DB.prepare(`
    SELECT * FROM push_subscriptions
    WHERE enabled = 1 AND severe_alerts_enabled = 1
    ORDER BY updated_at ASC LIMIT ?1
  `).bind(DUE_BATCH_SIZE).all();
  await Promise.all((subscriptions.results || []).map(async (record) => {
    try {
      const payload = await fetchJson(`https://api.weather.gov/alerts/active?point=${record.latitude},${record.longitude}`, env);
      const alerts = qualifyingAlerts(payload, now);
      for (const alert of alerts) {
        const contentHash = await severeAlertHash(alert);
        if (!await claimSevereAlert(record, alert, contentHash, now, env)) continue;
        try {
          await sendToRecord(record, severeAlertPayload(alert, record.timezone), env);
        } catch (error) {
          await releaseSevereAlertClaim(record, alert, contentHash, env);
          console.warn("Severe weather alert delivery failed.", {
            event: alert.event,
            name: error instanceof Error ? error.name : "Error",
            status: Number(error?.statusCode || error?.status || 0) || null
          });
        }
      }
    } catch (error) {
      console.warn("Severe weather alert check failed.", {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }));
  await env.NOTIFICATIONS_DB.prepare("DELETE FROM severe_alert_notifications WHERE expires_at > 0 AND expires_at < ?1")
    .bind(now - 24 * 60 * 60 * 1000).run();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return corsResponse(request);
    const allowed = requireAllowedOrigin(request);
    if (allowed.error) return allowed.error;
    if (request.method === "GET" && url.pathname === "/api/notifications/config") {
      return json({ ok: true, vapidPublicKey: env.VAPID_PUBLIC_KEY }, 200, allowed.origin);
    }
    if (request.method === "POST" && url.pathname === "/api/notifications/subscribe") return subscribe(request, env, allowed.origin);
    if (request.method === "POST" && url.pathname === "/api/notifications/unsubscribe") return unsubscribe(request, env, allowed.origin);
    if (request.method === "POST" && url.pathname === "/api/notifications/test") return sendTest(request, env, allowed.origin);
    if (request.method === "POST" && url.pathname === "/api/notifications/severe-alerts/active-test") return sendActiveNwsAlertTest(request, env, allowed.origin);
    return json({ ok: false, error: "Not found." }, 404, allowed.origin);
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(Promise.all([processDueNotifications(env), processSevereAlerts(env)]));
  }
};
