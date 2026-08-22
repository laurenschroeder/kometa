import { sampleRadialPoint } from './particle-field.js';

// Mesh-space scale factor: pebbleSizeFromSample below was originally tuned
// as a gl_PointSize screen-space pixel heuristic, not a world-space meter
// radius — this converts it to one. Shared so every pebble mesh in the game
// (final body, ambient field) is built from the same real-world scale.
export const PEBBLE_MESH_SCALE = 0.22;

// Larger pebbles read as "near the head" (small t / small r), tiny ones as
// far tail. Shared by every pebble render — the final body and the ambient
// field gathered in Chapter 2 — so a pebble is already the size it will be
// once captured into the body, no separate "ambient" size heuristic needed.
export function pebbleSizeFromSample(t: number, r: number): number {
  return Math.max(0.006, (0.038 - t * 0.02) * (1.0 - Math.min(r, 2.5) * 0.08));
}

// N independent size samples drawn from the same age/spread distribution
// params as the final pebble body's own tail (see
// PebbleCometPresentationSystem / pebble-weaving-system.ts) — for callers
// that need a size per pebble before that pebble has an actual trail
// position (e.g. the ambient field, which isn't riding a trail yet).
export function samplePebbleSizes(
  count: number,
  ageDecay: number,
  spreadBase: number,
  spreadGrowth: number,
  depthRatio: number,
): Float32Array {
  const sizes = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const sample = sampleRadialPoint(ageDecay, spreadBase, spreadGrowth, depthRatio);
    sizes[i] = pebbleSizeFromSample(sample.t, sample.r);
  }
  return sizes;
}
