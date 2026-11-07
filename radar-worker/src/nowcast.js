const WET_INDEX = 125; // 30 dBZ in the IEM N0Q palette.
const MAX_SHIFT = 40;
const FORECAST_MINUTES = 45;

function matchScore(previous, current, dx, dy) {
  const { width, height } = current;
  let previousWet = 0;
  let currentWet = 0;
  let overlap = 0;
  for (let y = MAX_SHIFT + 8; y < height - MAX_SHIFT - 8; y += 4) {
    for (let x = MAX_SHIFT + 8; x < width - MAX_SHIFT - 8; x += 4) {
      const wasWet = previous.pixels[(y - dy) * width + x - dx] >= WET_INDEX;
      const isWet = current.pixels[y * width + x] >= WET_INDEX;
      previousWet += Number(wasWet);
      currentWet += Number(isWet);
      overlap += Number(wasWet && isWet);
    }
  }
  if (previousWet < 20 || currentWet < 20) return 0;
  return (2 * overlap) / (previousWet + currentWet);
}

function wetNear(frame, x, y) {
  const centerX = Math.round(x);
  const centerY = Math.round(y);
  if (centerX < 2 || centerY < 2 || centerX >= frame.width - 2 || centerY >= frame.height - 2) return false;
  let wet = 0;
  for (let offsetY = -2; offsetY <= 2; offsetY += 1) {
    for (let offsetX = -2; offsetX <= 2; offsetX += 1) {
      wet += Number(frame.pixels[(centerY + offsetY) * frame.width + centerX + offsetX] >= WET_INDEX);
    }
  }
  return wet >= 4;
}

export function estimateRadarNowcast(previous, current, minutesBetween, latitude) {
  if (!previous || !current || previous.width !== current.width || previous.height !== current.height
    || previous.x0 !== current.x0 || previous.y0 !== current.y0
    || !Number.isFinite(minutesBetween) || minutesBetween < 4 || minutesBetween > 15
    || current.width < 2 * MAX_SHIFT + 100 || current.height < 2 * MAX_SHIFT + 100) return null;

  let best = { dx: 0, dy: 0, score: 0 };
  for (let dy = -MAX_SHIFT; dy <= MAX_SHIFT; dy += 4) {
    for (let dx = -MAX_SHIFT; dx <= MAX_SHIFT; dx += 4) {
      const score = matchScore(previous, current, dx, dy);
      if (score > best.score) best = { dx, dy, score };
    }
  }
  const coarse = best;
  for (let dy = Math.max(-MAX_SHIFT, coarse.dy - 3); dy <= Math.min(MAX_SHIFT, coarse.dy + 3); dy += 1) {
    for (let dx = Math.max(-MAX_SHIFT, coarse.dx - 3); dx <= Math.min(MAX_SHIFT, coarse.dx + 3); dx += 1) {
      const score = matchScore(previous, current, dx, dy);
      if (score > best.score) best = { dx, dy, score };
    }
  }
  const stationaryScore = matchScore(previous, current, 0, 0);
  const milesEast = best.dx * 0.005 * 69 * Math.cos(latitude * Math.PI / 180);
  const milesSouth = best.dy * 0.005 * 69;
  const speedMph = Math.hypot(milesEast, milesSouth) * 60 / minutesBetween;
  if (best.score < 0.62 || best.score - stationaryScore < 0.08 || speedMph < 4 || speedMph > 75) return null;

  const { centerX, centerY } = current;
  const wetNow = wetNear(current, centerX, centerY);
  let firstChange = null;
  for (let minutes = 5; minutes <= FORECAST_MINUTES + 5; minutes += 5) {
    const factor = minutes / minutesBetween;
    const wet = wetNear(current, centerX - best.dx * factor, centerY - best.dy * factor);
    if (wet === wetNow) {
      firstChange = null;
      continue;
    }
    if (firstChange === null) firstChange = minutes;
    else if (firstChange <= FORECAST_MINUTES) {
      return { kind: wetNow ? "clearing" : "arrival", minutes: firstChange, validAt: current.validAt };
    }
  }
  return null;
}
