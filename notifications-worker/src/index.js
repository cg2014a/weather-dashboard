import webpush from "web-push";

const ALLOWED_ORIGINS = new Set([
  "https://cg2014a.github.io",
  "http://localhost:5500"
]);
const TEST_COOLDOWN_MS = 60 * 1000;
const DELIVERY_LOCK_MS = 5 * 60 * 1000;
const DUE_BATCH_SIZE = 25;

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

function weatherSummary(forecast, hourly, alerts) {
  const dayPeriods = forecast?.properties?.periods || [];
  const hourlyPeriods = hourly?.properties?.periods || [];
  const current = hourlyPeriods[0] || dayPeriods[0] || {};
  const day = dayPeriods.find((period) => period?.isDaytime) || dayPeriods[0] || {};
  const night = dayPeriods.slice(dayPeriods.indexOf(day) + 1).find((period) => !period?.isDaytime) || {};
  const temperature = Number.isFinite(Number(current.temperature)) ? `${Math.round(Number(current.temperature))}° now` : "Morning forecast";
  const high = Number.isFinite(Number(day.temperature)) ? `${Math.round(Number(day.temperature))}°` : "--";
  const low = Number.isFinite(Number(night.temperature)) ? `${Math.round(Number(night.temperature))}°` : "--";
  const precipitation = Number(day?.probabilityOfPrecipitation?.value);
  const weatherLine = [day.shortForecast || current.shortForecast || "Forecast updating", precipitation > 0 ? `Rain ${Math.round(precipitation)}%` : ""]
    .filter(Boolean)
    .join(" • ");
  const alert = alerts?.features?.[0]?.properties?.event;
  return {
    title: "SkyStation Morning Weather",
    body: [`${temperature} • High ${high} / Low ${low}`, weatherLine, alert || ""].filter(Boolean).join("\n"),
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
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  await webpush.sendNotification(JSON.parse(record.subscription_json), JSON.stringify(payload), { TTL: 900, urgency: "high" });
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
  await env.NOTIFICATIONS_DB.prepare(`
    INSERT INTO push_subscriptions (
      id, installation_id, management_token_hash, endpoint_hash, subscription_json, timezone,
      latitude, longitude, enabled, next_delivery_at, delivery_lock_until, test_cooldown_until, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, 0, 0, ?10, ?10)
    ON CONFLICT(installation_id) DO UPDATE SET
      management_token_hash = excluded.management_token_hash,
      endpoint_hash = excluded.endpoint_hash,
      subscription_json = excluded.subscription_json,
      timezone = excluded.timezone,
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      enabled = 1,
      next_delivery_at = excluded.next_delivery_at,
      delivery_lock_until = 0,
      updated_at = excluded.updated_at
  `).bind(id, body.installationId, managementTokenHash, endpointHash, JSON.stringify(body.subscription), body.timezone, Number(body.location.lat), Number(body.location.lon), nextDelivery, now).run();
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
    WHERE installation_id = ?1 AND management_token_hash = ?2 AND enabled = 1
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

async function processDueNotifications(env) {
  const now = Date.now();
  const due = await env.NOTIFICATIONS_DB.prepare(`
    SELECT * FROM push_subscriptions
    WHERE enabled = 1 AND next_delivery_at <= ?1 AND delivery_lock_until <= ?1
    ORDER BY next_delivery_at ASC LIMIT ?2
  `).bind(now, DUE_BATCH_SIZE).all();
  await Promise.all((due.results || []).map(async (record) => {
    const claimed = await env.NOTIFICATIONS_DB.prepare(`
      UPDATE push_subscriptions SET delivery_lock_until = ?1, updated_at = ?2
      WHERE id = ?3 AND enabled = 1 AND next_delivery_at <= ?2 AND delivery_lock_until <= ?2
    `).bind(now + DELIVERY_LOCK_MS, now, record.id).run();
    if (!claimed.meta.changed_db_rows) return;
    try {
      const payload = await buildMorningPayload(record, env);
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
    return json({ ok: false, error: "Not found." }, 404, allowed.origin);
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(processDueNotifications(env));
  }
};
