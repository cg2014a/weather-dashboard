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
const IEM_WORLD = {
  pixelWidth: 0.005,
  pixelHeight: -0.005,
  originX: -126,
  originY: 50
};

let decodedRasterCache = null;
let decodedRasterPromise = null;

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

async function decodeIndexedPng(bytes) {
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

  const inflated = new Uint8Array(await new Response(
    new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate"))
  ).arrayBuffer());
  const stride = width + 1;
  if (inflated.length !== stride * height) throw new Error("IEM PNG raster size is invalid.");

  const paeth = (a, b, c) => {
    const estimate = a + b - c;
    const distanceA = Math.abs(estimate - a);
    const distanceB = Math.abs(estimate - b);
    const distanceC = Math.abs(estimate - c);
    return distanceA <= distanceB && distanceA <= distanceC ? a : distanceB <= distanceC ? b : c;
  };
  for (let y = 0; y < height; y += 1) {
    const sourceStart = y * stride + 1;
    const targetStart = y * width;
    const filter = inflated[sourceStart - 1];
    for (let x = 0; x < width; x += 1) {
      const left = x ? inflated[targetStart + x - 1] : 0;
      const above = y ? inflated[(y - 1) * width + x] : 0;
      const upperLeft = y && x ? inflated[(y - 1) * width + x - 1] : 0;
      const value = inflated[sourceStart + x];
      if (filter === 0) inflated[targetStart + x] = value;
      else if (filter === 1) inflated[targetStart + x] = (value + left) & 255;
      else if (filter === 2) inflated[targetStart + x] = (value + above) & 255;
      else if (filter === 3) inflated[targetStart + x] = (value + Math.floor((left + above) / 2)) & 255;
      else if (filter === 4) inflated[targetStart + x] = (value + paeth(left, above, upperLeft)) & 255;
      else throw new Error("IEM PNG filter is unsupported.");
    }
  }

  return { width, height, pixels: inflated.subarray(0, width * height) };
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

  if (!decodedRasterCache || decodedRasterCache.validAt !== validAt) {
    if (!decodedRasterPromise) {
      decodedRasterPromise = (async () => {
        const rasterResponse = await fetcher(IEM_PNG_URL, {
          cf: { cacheEverything: true, cacheTtl: POINT_CACHE_SECONDS }
        });
        if (!rasterResponse.ok) throw new Error("IEM PNG raster is unavailable.");
        return decodeIndexedPng(new Uint8Array(await rasterResponse.arrayBuffer()));
      })().finally(() => {
        decodedRasterPromise = null;
      });
    }
    decodedRasterCache = { validAt, ...(await decodedRasterPromise) };
  }

  const { width, height, pixels } = decodedRasterCache;
  const { x, y } = pixelForCoordinate(lat, lon, IEM_WORLD, width, height);
  const index = pixels[y * width + x];

  return {
    ok: true,
    source: "iem-n0q",
    validAt,
    dbz: indexToDbz(index),
    index
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
