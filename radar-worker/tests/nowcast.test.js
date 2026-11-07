import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { estimateRadarNowcast } from "../src/nowcast.js";
import { sampleIemN0q } from "../src/index.js";

function frame(blobX, { width = 321, centerX = 160 } = {}) {
  const pixels = new Uint8Array(width * width);
  if (blobX !== null) {
    for (let y = 142; y <= 178; y += 1) {
      for (let x = blobX - 10; x <= blobX + 10; x += 1) {
        if (y < 150 && x > blobX + 3) continue;
        pixels[y * width + x] = 145;
      }
    }
  }
  return { width, height: width, x0: 0, y0: 0, centerX, centerY: 160,
    validAt: "2026-11-07T18:00:00Z", pixels };
}

test("moving echoes support a short arrival estimate", () => {
  const nowcast = estimateRadarNowcast(frame(128), frame(138), 10, 38);
  assert.equal(nowcast?.kind, "arrival");
  assert.ok(nowcast.minutes >= 10 && nowcast.minutes <= 30);
});

test("moving echoes support a short clearing estimate", () => {
  const nowcast = estimateRadarNowcast(frame(150), frame(160), 10, 38);
  assert.equal(nowcast?.kind, "clearing");
  assert.ok(nowcast.minutes >= 5 && nowcast.minutes <= 20);
});

test("stationary or sparse echoes do not produce a motion forecast", () => {
  assert.equal(estimateRadarNowcast(frame(150), frame(150), 10, 38), null);
  const sparse = frame(null);
  sparse.pixels[160 * sparse.width + 155] = 145;
  assert.equal(estimateRadarNowcast(sparse, sparse, 10, 38), null);
});

function pngChunk(name, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(name), data, Buffer.alloc(4)]);
}

function indexedRadarPng(blobX) {
  const width = 400;
  const height = 400;
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 180; y <= 220; y += 1) {
    for (let x = blobX - 10; x <= blobX + 10; x += 1) raw[y * (width + 1) + 1 + x] = 145;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 3;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

test("worker reads consecutive archived scans and returns a radar arrival", async () => {
  const validAt = "2026-11-07T18:00:00Z";
  const currentPng = indexedRadarPng(180);
  const previousPng = indexedRadarPng(170);
  const requested = [];
  const fetcher = async (url) => {
    requested.push(url);
    if (url.endsWith(".json")) return Response.json({ meta: { valid: validAt } });
    if (url.endsWith("n0q_0.png")) return new Response(currentPng);
    if (url.endsWith("n0q_202611071750.png")) return new Response(previousPng);
    return new Response(null, { status: 404 });
  };
  const result = await sampleIemN0q(49, -125, { fetcher, now: Date.parse("2026-11-07T18:01:00Z") });
  assert.equal(result.dbz, null);
  assert.equal(result.nowcast?.kind, "arrival");
  assert.ok(requested.some((url) => url.endsWith("n0q_202611071750.png")));
});
