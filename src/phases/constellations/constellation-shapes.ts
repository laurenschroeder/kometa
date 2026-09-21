// Hand-authored 2D layouts for each named constellation (see
// constellation-set.ts). Coordinates are in METERS within the constellation's
// own plane (x = right, y = up), centered on its anchor — every def sets
// spreadRadius: 1 and verticalScale: 1 so nothing rescales them (constellation-
// path.ts embeds them into 3D). Point COUNT must exactly match that name's
// ConstellationDef.starCount in constellation-set.ts (each point doubles as an
// interactive touch star) — generateConstellationLayout warns if they drift.
//
// The visible yellow line is authored separately (CONSTELLATION_STROKES): the
// stars are where you touch, the strokes are the smooth outline traced through
// them, so the outline can be a true circle/infinity curve regardless of how
// many stars sit on it.
type Point = [number, number];

// `n` points around a circle, starting at `startAngle` (radians). Positive
// direction = counter-clockwise, negative = clockwise. `closed` repeats the
// first point at the end so the ribbon meets itself.
function circle(cx: number, cy: number, r: number, n: number, startAngle = 0, dir: 1 | -1 = 1, closed = false): Point[] {
  const pts: Point[] = [];
  const count = closed ? n + 1 : n;
  for (let i = 0; i < count; i++) {
    const a = startAngle + (dir * i * 2 * Math.PI) / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

// Horizontal infinity (lemniscate of Gerono): width 2*halfWidth, height
// 2*halfHeight, crossing at the center. `t0` offsets the start so evenly
// spaced stars never land on the crossing point (where the two passes meet).
function infinity(halfWidth: number, halfHeight: number, n: number, t0 = 0, closed = false): Point[] {
  const pts: Point[] = [];
  const count = closed ? n + 1 : n;
  for (let i = 0; i < count; i++) {
    const t = t0 + (i * 2 * Math.PI) / n;
    pts.push([halfWidth * Math.cos(t), halfHeight * Math.sin(2 * t)]);
  }
  return pts;
}

// Harvest — two small circles side by side, centered on the anchor (was three
// spread ~1.7 m wide, too far to reach across), left a bit lower and right a
// bit higher.
const HARVEST_RADIUS = 0.23;
const HARVEST_CENTERS: Point[] = [
  [-0.28, -0.07],
  [0.28, 0.07],
];
const HARVEST_STARS_PER_CIRCLE = 8;

// Throne — a small circle up around head height over a larger one, joined by
// a figure-eight (the two circles touch at the crossing, traced in opposite
// directions so the line flows through like an infinity symbol).
const THRONE_UPPER = { cx: 0, cy: 0.3, r: 0.22, stars: 7 };
const THRONE_LOWER_R = 0.35;
// Lower circle's top edge meets the upper circle's bottom edge.
const THRONE_LOWER = {
  cx: 0,
  cy: THRONE_UPPER.cy - THRONE_UPPER.r - THRONE_LOWER_R,
  r: THRONE_LOWER_R,
  stars: 10,
};

// Shepherd (soul dust) — a horizontal infinity, ~0.9 m wide, small enough to
// gather in one arm sweep.
const SOULS_HALF_WIDTH = 0.45;
const SOULS_HALF_HEIGHT = 0.22;
const SOULS_STARS = 12;

function throneFigureEight(pointsPerCircle: number): Point[] {
  // Upper: clockwise from its bottom point (moving left); lower: counter-
  // clockwise from its top point (also moving left) — a smooth hand-off.
  const upper = circle(THRONE_UPPER.cx, THRONE_UPPER.cy, THRONE_UPPER.r, pointsPerCircle, -Math.PI / 2, -1);
  const lower = circle(THRONE_LOWER.cx, THRONE_LOWER.cy, THRONE_LOWER.r, pointsPerCircle, Math.PI / 2, 1, true);
  return [...upper, ...lower];
}

export const CONSTELLATION_SHAPES: Record<string, Point[]> = {
  // Soul dust
  Shepherd: infinity(SOULS_HALF_WIDTH, SOULS_HALF_HEIGHT, SOULS_STARS, Math.PI / SOULS_STARS),
  // Organic matter
  Harvest: HARVEST_CENTERS.flatMap(([cx, cy]) =>
    circle(cx, cy, HARVEST_RADIUS, HARVEST_STARS_PER_CIRCLE, Math.PI / HARVEST_STARS_PER_CIRCLE),
  ),
  // Volatile gasses
  Throne: [
    ...circle(THRONE_UPPER.cx, THRONE_UPPER.cy, THRONE_UPPER.r, THRONE_UPPER.stars, Math.PI / 2),
    ...circle(THRONE_LOWER.cx, THRONE_LOWER.cy, THRONE_LOWER.r, THRONE_LOWER.stars, Math.PI / 2),
  ],
};

// The smooth yellow outline, as one or more strokes (each becomes its own
// ribbon, so separate circles don't get joined by stray lines). Dense point
// lists — constellation-path.ts's sampleSmoothPath resamples them.
export const CONSTELLATION_STROKES: Record<string, Point[][]> = {
  Shepherd: [infinity(SOULS_HALF_WIDTH, SOULS_HALF_HEIGHT, 64, 0, true)],
  Harvest: HARVEST_CENTERS.map(([cx, cy]) => circle(cx, cy, HARVEST_RADIUS, 32, 0, 1, true)),
  Throne: [throneFigureEight(40)],
};
