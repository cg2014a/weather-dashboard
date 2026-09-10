const IEM_BASE_URL = "https://mesonet.agron.iastate.edu/data/gis/images/4326/USCOMP";
const IEM_METADATA_URL = `${IEM_BASE_URL}/n0q_0.json`;
const IEM_WORLD_FILE_URL = `${IEM_BASE_URL}/n0q_0.wld`;
const IEM_TIFF_URL = `${IEM_BASE_URL}/n0q_0.tif`;
const ALLOWED_ORIGINS = new Set([
  "https://cg2014a.github.io",
  "http://localhost:5500"
]);
const MAX_RADAR_AGE_MS = 15 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 2 * 60 * 1000;
const POINT_CACHE_SECONDS = 60;

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

function parseContentRange(value) {
  const match = String(value || "").match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
  if (!match) return null;
  return { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) };
}

async function fetchRange(fetcher, url, start, end) {
  const response = await fetcher(url, {
    headers: { Range: `bytes=${start}-${end}` },
    cf: { cacheEverything: true, cacheTtl: POINT_CACHE_SECONDS }
  });
  const range = parseContentRange(response.headers.get("Content-Range"));
  if (response.status !== 206 || !range || range.start !== start) {
    throw new Error("IEM raster does not support the required byte range.");
  }
  return { bytes: new Uint8Array(await response.arrayBuffer()), ...range };
}

function parseWorldFile(text) {
  const values = String(text || "")
    .trim()
    .split(/\s+/)
    .map(Number);
  if (values.length < 6 || values.some((value) => !Number.isFinite(value))) {
    throw new Error("IEM world file is invalid.");
  }
  const [pixelWidth, rotationY, rotationX, pixelHeight, originX, originY] = values;
  if (!pixelWidth || !pixelHeight || rotationX !== 0 || rotationY !== 0) {
    throw new Error("IEM world grid is unsupported.");
  }
  return { pixelWidth, pixelHeight, originX, originY };
}

function readTiffTags(bytes, rangeStart) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entryCount = view.getUint16(0, true);
  const tags = new Map();
  for (let index = 0; index < entryCount; index += 1) {
    const offset = 2 + index * 12;
    if (offset + 12 > bytes.byteLength) throw new Error("IEM TIFF directory is incomplete.");
    tags.set(view.getUint16(offset, true), {
      type: view.getUint16(offset + 2, true),
      count: view.getUint32(offset + 4, true),
      value: view.getUint32(offset + 8, true)
    });
  }
  return { view, rangeStart, tags };
}

function scalarTag(tags, id) {
  const tag = tags.get(id);
  if (!tag || tag.count !== 1) throw new Error(`IEM TIFF tag ${id} is missing.`);
  return tag.value;
}

function longArrayFromDirectory(directory, tag) {
  if (!tag || tag.type !== 4 || !tag.count) throw new Error("IEM TIFF strip table is invalid.");
  const offset = tag.value - directory.rangeStart;
  const byteLength = tag.count * 4;
  if (offset < 0 || offset + byteLength > directory.view.byteLength) {
    throw new Error("IEM TIFF strip table is outside the directory range.");
  }
  return Array.from({ length: tag.count }, (_, index) => directory.view.getUint32(offset + index * 4, true));
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

  const worldResponse = await fetcher(IEM_WORLD_FILE_URL, {
    cf: { cacheEverything: true, cacheTtl: POINT_CACHE_SECONDS }
  });
  if (!worldResponse.ok) throw new Error("IEM radar grid is unavailable.");
  const world = parseWorldFile(await worldResponse.text());

  const header = await fetchRange(fetcher, IEM_TIFF_URL, 0, 65535);
  const headerView = new DataView(header.bytes.buffer, header.bytes.byteOffset, header.bytes.byteLength);
  if (headerView.getUint16(0, false) !== 0x4949 || headerView.getUint16(2, true) !== 42) {
    throw new Error("IEM TIFF format is unsupported.");
  }
  const directoryOffset = headerView.getUint32(4, true);
  const directory = await fetchRange(fetcher, IEM_TIFF_URL, directoryOffset, Math.min(directoryOffset + 65535, header.total - 1));
  const parsed = readTiffTags(directory.bytes, directory.start);
  const width = scalarTag(parsed.tags, 256);
  const height = scalarTag(parsed.tags, 257);
  const compression = scalarTag(parsed.tags, 259);
  const bitsPerSample = scalarTag(parsed.tags, 258);
  const samplesPerPixel = scalarTag(parsed.tags, 277);
  const rowsPerStrip = scalarTag(parsed.tags, 278);
  if (compression !== 1 || bitsPerSample !== 8 || samplesPerPixel !== 1 || !rowsPerStrip) {
    throw new Error("IEM TIFF raster layout is unsupported.");
  }

  const stripOffsets = longArrayFromDirectory(parsed, parsed.tags.get(273));
  const stripIndex = Math.floor(pixelForCoordinate(lat, lon, world, width, height).y / rowsPerStrip);
  const { x, y } = pixelForCoordinate(lat, lon, world, width, height);
  if (stripIndex < 0 || stripIndex >= stripOffsets.length) throw new Error("IEM TIFF strip is unavailable.");
  const byteOffset = stripOffsets[stripIndex] + (y % rowsPerStrip) * width + x;
  const pixel = await fetchRange(fetcher, IEM_TIFF_URL, byteOffset, byteOffset);
  const index = pixel.bytes[0];

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
