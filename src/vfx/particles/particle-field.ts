export interface RadialFieldParams {
  count: number;
  ageDecay: number; // exponential decay rate for the age (t) distribution
  spreadBase: number;
  spreadGrowth: number; // spread = spreadBase + t * spreadGrowth
  depthRatio: number; // z-offset scale relative to lateral radius*spread
}

export interface RadialSample {
  t: number;
  dx: number;
  dy: number;
  dz: number;
  r: number;
}

// Single-sample version of the distribution generateRadialField() below
// produces in bulk. Used where particles join a trail-following pool
// incrementally at runtime (e.g. stardust motes getting captured one at a
// time) instead of all at once at init (e.g. pebbles).
export function sampleRadialPoint(
  ageDecay: number,
  spreadBase: number,
  spreadGrowth: number,
  depthRatio: number,
): RadialSample {
  const t = Math.min(1.0, -Math.log(1.0 - Math.random() * 0.9999) / ageDecay);
  const angle = Math.random() * Math.PI * 2;
  const r = Math.sqrt(-2.0 * Math.log(1.0 - Math.random() * 0.9999));
  const spread = spreadBase + t * spreadGrowth;
  const dx = Math.cos(angle) * r * spread;
  const dy = Math.sin(angle) * r * spread;
  const dz = (Math.random() - 0.5) * r * spread * depthRatio;
  return { t, dx, dy, dz, r };
}

export interface RadialField {
  t: Float32Array;
  dx: Float32Array;
  dy: Float32Array;
  dz: Float32Array;
  // Raw Gaussian radius before spread scaling — exposed because some
  // per-particle visuals (e.g. pebble size falloff) key off "how far out"
  // independent of the age-scaled spread applied to dx/dy/dz.
  r: Float32Array;
}

// Generalized from the near-duplicate pebble/haze distribution loops in the
// original comet-system.ts: each particle gets an "age" t (0=newest/near
// the comet, 1=oldest/tail end, exponentially distributed so most particles
// cluster near the head) and a camera-relative (dx, dy, dz) offset from its
// sampled trail point, radius Gaussian-distributed and spread scaled by age
// so the tail widens as it trails off. Per-particle size/brightness/variant
// assignment stays chapter-specific and is layered on top of this by the
// caller — this utility only owns the shared age+offset distribution.
export function generateRadialField(params: RadialFieldParams): RadialField {
  const { count, ageDecay, spreadBase, spreadGrowth, depthRatio } = params;
  const t = new Float32Array(count);
  const dx = new Float32Array(count);
  const dy = new Float32Array(count);
  const dz = new Float32Array(count);
  const r = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const sample = sampleRadialPoint(ageDecay, spreadBase, spreadGrowth, depthRatio);
    t[i] = sample.t;
    dx[i] = sample.dx;
    dy[i] = sample.dy;
    dz[i] = sample.dz;
    r[i] = sample.r;
  }

  return { t, dx, dy, dz, r };
}
