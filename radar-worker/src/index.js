import { estimateRadarNowcast } from "./nowcast.js";

const IEM_BASE_URL = "https://mesonet.agron.iastate.edu/data/gis/images/4326/USCOMP";
const IEM_METADATA_URL = `${IEM_BASE_URL}/n0q_0.json`;
const IEM_PNG_URL = `${IEM_BASE_URL}/n0q_0.png`;
const ALLOWED_ORIGINS = new Set([
  "https://cg2014a.github.io",
  "http://localhost:5500"
]);
const MAX_RADAR_AGE_MS = 15 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 2 * 60 * 1000;
const POINT_CACHE_SECONDS = 60;
const WINDOW_RADIUS_PIXELS = 160;
const IEM_WORLD = {
  pixelWidth: 0.005,
  pixelHeight: -0.005,
  originX: -126,
  originY: 50
};

const radarWindowCache = new Map();
const radarWindowPromises = new Map();

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}

function json(payload, status, origin, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(origin),
      ...headers
    }
  });
}

function allowedOrigin(request) {
  const origin = request.headers.get("Origin");
  return ALLOWED_ORIGINS.has(origin) ? origin : null;
}

function pngChunkType(bytes, offset) {
  return String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
}

async function decodeIndexedPngWindow(bytes, lat, lon) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (signature.some((value, index) => bytes[index] !== value)) throw new Error("IEM PNG signature is invalid.");

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatParts = [];
  let offset = signature.length;
  while (offset + 12 <= bytes.length) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
    const type = pngChunkType(bytes, offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) throw new Error("IEM PNG chunk is incomplete.");
    if (type === "IHDR") {
      const header = new DataView(bytes.buffer, bytes.byteOffset + dataStart, length);
      width = header.getUint32(0);
      height = header.getUint32(4);
      bitDepth = header.getUint8(8);
      colorType = header.getUint8(9);
      interlace = header.getUint8(12);
    } else if (type === "IDAT") {
      idatParts.push(bytes.subarray(dataStart, dataEnd));
    }
    offset = dataEnd + 4;
    if (type === "IEND") break;
  }

  if (!width || !height || bitDepth !== 8 || colorType !== 3 || interlace !== 0 || !idatParts.length) {
    throw new Error("IEM PNG raster layout is unsupported.");
  }

  const compressedLength = idatParts.reduce((total, part) => total + part.length, 0);
  const compressed = new Uint8Array(compressedLength);
  let compressedOffset = 0;
  for (const part of idatParts) {
    compressed.set(part, compressedOffset);
    compressedOffset += part.length;
  }

  const center = pixelForCoordinate(lat, lon, IEM_WORLD, width, height);
  const x0 = Math.max(0, center.x - WINDOW_RADIUS_PIXELS);
  const y0 = Math.max(0, center.y - WINDOW_RADIUS_PIXELS);
  const x1 = Math.min(width, center.x + WINDOW_RADIUS_PIXELS + 1);
  const y1 = Math.min(height, center.y + WINDOW_RADIUS_PIXELS + 1);
  const windowWidth = x1 - x0;
  const windowHeight = y1 - y0;
  const pixels = new Uint8Array(windowWidth * windowHeight);
  const stride = width + 1;
  const reader = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate")).getReader();
  let chunk = new Uint8Array(0);
  let chunkOffset = 0;
  let inflatedLength = 0;
  const rows = [new Uint8Array(stride), new Uint8Array(stride)];

  async function readRow(row) {
    let filled = 0;
    while (filled < stride) {
      if (chunkOffset >= chunk.length) {
        const next = await reader.read();
        if (next.done) throw new Error("IEM PNG raster size is invalid.");
        chunk = next.value;
        chunkOffset = 0;
      }
      const count = Math.min(stride - filled, chunk.length - chunkOffset);
      row.set(chunk.subarray(chunkOffset, chunkOffset + count), filled);
      chunkOffset += count;
      filled += count;
      inflatedLength += count;
    }
  }

  const paeth = (a, b, c) => {
    const estimate = a + b - c;
    const distanceA = Math.abs(estimate - a);
    const distanceB = Math.abs(estimate - b);
    const distanceC = Math.abs(estimate - c);
    return distanceA <= distanceB && distanceA <= distanceC ? a : distanceB <= distanceC ? b : c;
  };
  for (let y = 0; y < height; y += 1) {
    const row = rows[y % 2];
    await readRow(row);
    const current = row.subarray(1);
    const previous = y ? rows[(y + 1) % 2].subarray(1) : null;
    const filter = row[0];
    for (let x = 0; x < width; x += 1) {
      const left = x ? current[x - 1] : 0;
      const above = previous ? previous[x] : 0;
      const upperLeft = previous && x ? previous[x - 1] : 0;
      const value = current[x];
      if (filter === 1) current[x] = (value + left) & 255;
      else if (filter === 2) current[x] = (value + above) & 255;
      else if (filter === 3) current[x] = (value + Math.floor((left + above) / 2)) & 255;
      else if (filter === 4) current[x] = (value + paeth(left, above, upperLeft)) & 255;
      else if (filter !== 0) throw new Error("IEM PNG filter is unsupported.");
    }
    if (y >= y0 && y < y1) pixels.set(current.subarray(x0, x1), (y - y0) * windowWidth);
  }
  if (inflatedLength !== stride * height || chunkOffset < chunk.length) throw new Error("IEM PNG raster size is invalid.");
  for (let tail = await reader.read(); !tail.done; tail = await reader.read()) {
    if (tail.value.length) throw new Error("IEM PNG raster size is invalid.");
  }
  return { width: windowWidth, height: windowHeight, x0, y0,
    centerX: center.x - x0, centerY: center.y - y0, pixels };
}

function pixelForCoordinate(lat, lon, world, width, height) {
  const x = Math.round((lon - world.originX) / world.pixelWidth);
  const y = Math.round((lat - world.originY) / world.pixelHeight);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height) {
    throw new Error("Location is outside the IEM N0Q mosaic.");
  }
  return { x, y };
}

export function indexToDbz(index) {
  return index > 0 ? -32 + (index - 1) * 0.5 : null;
}

async function loadRadarWindow(url, validAt, lat, lon, fetcher) {
  const key = `${validAt}:${lat.toFixed(4)}:${lon.toFixed(4)}`;
  const useCache = fetcher === fetch;
  if (useCache && radarWindowCache.has(key)) return radarWindowCache.get(key);
  if (useCache && radarWindowPromises.has(key)) return radarWindowPromises.get(key);
  const pending = (async () => {
    const response = await fetcher(url, { cf: { cacheEverything: true, cacheTtl: POINT_CACHE_SECONDS } });
    if (!response.ok) throw new Error("IEM PNG raster is unavailable.");
    return { validAt, ...(await decodeIndexedPngWindow(new Uint8Array(await response.arrayBuffer()), lat, lon)) };
  })();
  if (useCache) radarWindowPromises.set(key, pending);
  try {
    const window = await pending;
    if (useCache) {
      radarWindowCache.set(key, window);
      if (radarWindowCache.size > 12) radarWindowCache.delete(radarWindowCache.keys().next().value);
    }
    return window;
  } finally {
    if (useCache) radarWindowPromises.delete(key);
  }
}

function archivedN0qUrl(timestamp) {
  const date = new Date(timestamp);
  const stamp = date.toISOString().slice(0, 16).replace(/[-:T]/g, "");
  return `https://mesonet.agron.iastate.edu/archive/data/${stamp.slice(0, 4)}/${stamp.slice(4, 6)}/${stamp.slice(6, 8)}/GIS/uscomp/n0q_${stamp}.png`;
}

export async function sampleIemN0q(lat, lon, { fetcher = fetch, now = Date.now() } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("Latitude and longitude are required.");

  const metadataResponse = await fetcher(IEM_METADATA_URL, {
    cf: { cacheEverything: true, cacheTtl: POINT_CACHE_SECONDS }
  });
  if (!metadataResponse.ok) throw new Error("IEM radar metadata is unavailable.");
  const metadata = await metadataResponse.json();
  const validAt = String(metadata?.meta?.valid || "");
  const validAtMs = new Date(validAt).getTime();
  const ageMs = now - validAtMs;
  if (!Number.isFinite(validAtMs) || ageMs < -MAX_FUTURE_SKEW_MS || ageMs > MAX_RADAR_AGE_MS) {
    throw new Error("IEM radar data is stale.");
  }

  const current = await loadRadarWindow(IEM_PNG_URL, validAt, lat, lon, fetcher);
  const index = current.pixels[current.centerY * current.width + current.centerX];
  let nowcast = null;
  for (const minutesBetween of [10, 5]) {
    const previousTime = validAtMs - minutesBetween * 60 * 1000;
    try {
      const previous = await loadRadarWindow(archivedN0qUrl(previousTime), new Date(previousTime).toISOString(), lat, lon, fetcher);
      nowcast = estimateRadarNowcast(previous, current, minutesBetween, lat);
      break;
    } catch (error) {
      console.warn("IEM archived radar frame unavailable.", { minutesBetween, message: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    ok: true,
    source: "iem-n0q",
    validAt,
    dbz: indexToDbz(index),
    index,
    nowcast
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = allowedOrigin(request);
    if (request.method === "OPTIONS") {
      return origin
        ? new Response(null, { status: 204, headers: corsHeaders(origin) })
        : new Response(null, { status: 403 });
    }
    if (!origin) return new Response("Forbidden", { status: 403 });
    if (request.method !== "GET" || url.pathname !== "/api/radar/point") {
      return json({ ok: false, error: "Not found." }, 404, origin);
    }

    const lat = Number(url.searchParams.get("lat"));
    const lon = Number(url.searchParams.get("lon"));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return json({ ok: false, error: "Valid latitude and longitude are required." }, 400, origin);
    }

    const cacheKey = new Request(`${url.origin}${url.pathname}?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`);
    const cached = await caches.default.match(cacheKey);
    if (cached) {
      const payload = await cached.json();
      return json(payload, 200, origin, { "Cache-Control": `public, max-age=${POINT_CACHE_SECONDS}` });
    }

    try {
      const payload = await sampleIemN0q(lat, lon);
      const cacheResponse = new Response(JSON.stringify(payload), {
        headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${POINT_CACHE_SECONDS}` }
      });
      ctx.waitUntil(caches.default.put(cacheKey, cacheResponse));
      return json(payload, 200, origin, { "Cache-Control": `public, max-age=${POINT_CACHE_SECONDS}` });
    } catch (error) {
      console.warn("IEM radar point sample unavailable.", { message: error instanceof Error ? error.message : String(error) });
      return json({ ok: false, error: "Radar sample unavailable." }, 503, origin);
    }
  }
};
