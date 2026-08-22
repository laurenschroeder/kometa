import { Vector3 } from '@iwsdk/core';
import { randomUnitVector3 } from './mesh-utils.js';
import { ConstellationDef } from '../../phases/constellations/constellation-set.js';

// N anchors evenly spread across a semicircle in front of the player
// (absolute world-space — the player doesn't move during this phase, same
// convention weave-path.ts's placePlanets uses for its full-circle ring).
// Centered on forward (-Z), spanning SEMICIRCLE_SPAN_RADIANS total.
const SEMICIRCLE_SPAN_RADIANS = (Math.PI * 2) / 3; // 120 degrees, i.e. +-60 deg
export function placeConstellationAnchors(
  count: number,
  radius: number,
  centerY: number,
): [number, number, number][] {
  const anchors: [number, number, number][] = [];
  const half = SEMICIRCLE_SPAN_RADIANS / 2;
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const angle = -half + t * SEMICIRCLE_SPAN_RADIANS;
    anchors.push([Math.sin(angle) * radius, centerY, -Math.cos(angle) * radius]);
  }
  return anchors;
}

// Standard 4-point Catmull-Rom, applied per-axis below. Hand-rolled rather
// than three.js's CatmullRomCurve3 — @iwsdk/core doesn't re-export three's
// Curve classes (checked), and project convention is three types only via
// @iwsdk/core, so this follows weave-path.ts's own precedent of hand-rolling
// path math instead of importing from 'three' directly.
function catmullRom1D(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

// padded must have length >= 4 (controlPoints with its first/last points
// duplicated as phantom endpoints, so the open path's tangents at the very
// start/end are well-defined). u wraps across the N-1 segments between the
// real control points.
function samplePathAt(u: number, padded: readonly Vector3[], out: Vector3): Vector3 {
  const segCount = padded.length - 3;
  const scaled = Math.min(segCount - 1e-6, Math.max(0, u * segCount));
  const seg = Math.floor(scaled);
  const t = scaled - seg;
  const p0 = padded[seg];
  const p1 = padded[seg + 1];
  const p2 = padded[seg + 2];
  const p3 = padded[seg + 3];
  out.set(
    catmullRom1D(p0.x, p1.x, p2.x, p3.x, t),
    catmullRom1D(p0.y, p1.y, p2.y, p3.y, t),
    catmullRom1D(p0.z, p1.z, p2.z, p3.z, t),
  );
  return out;
}

// N dots evenly spaced by arc length along the path — same "2000-sample
// table + cumulative length" technique weave-path.ts's placeDots() uses,
// generalized to an arbitrary padded control-point spline instead of the
// ring/weave-specific formula.
function placeDotsAlongPath(count: number, padded: readonly Vector3[]): Float32Array {
  const SAMPLES = 2000;
  const samplePoints: Vector3[] = new Array(SAMPLES + 1);
  const cumLength = new Float32Array(SAMPLES + 1);
  for (let i = 0; i <= SAMPLES; i++) {
    samplePoints[i] = samplePathAt(i / SAMPLES, padded, new Vector3());
    cumLength[i] = i === 0 ? 0 : cumLength[i - 1] + samplePoints[i].distanceTo(samplePoints[i - 1]);
  }
  const totalLength = cumLength[SAMPLES];

  const out = new Float32Array(count * 3);
  let sampleIdx = 0;
  for (let d = 0; d < count; d++) {
    const targetLength = (d / count) * totalLength;
    while (sampleIdx < SAMPLES && cumLength[sampleIdx] < targetLength) sampleIdx++;
    const p = samplePoints[sampleIdx];
    out[d * 3] = p.x;
    out[d * 3 + 1] = p.y;
    out[d * 3 + 2] = p.z;
  }
  return out;
}

export interface ConstellationLayout {
  starPositions: Float32Array; // decorative, non-interactive
  dotPositions: Float32Array; // the winding path's touch targets
}

// Scatters starCount stars and a winding path of dotCount evenly-spaced
// touch dots within a spreadRadius volume around anchor. No attempt at a
// recognizable shape yet (dog/human/horn/etc. are just names for now) —
// purely procedural, so size/complexity variety comes entirely from the
// ConstellationDef's own numbers (see constellation-set.ts).
export function generateConstellationLayout(
  def: ConstellationDef,
  anchor: readonly [number, number, number],
): ConstellationLayout {
  const [ax, ay, az] = anchor;

  const starPositions = new Float32Array(def.starCount * 3);
  for (let i = 0; i < def.starCount; i++) {
    const dir = randomUnitVector3();
    const r = Math.random() * def.spreadRadius;
    starPositions[i * 3] = ax + dir.x * r;
    starPositions[i * 3 + 1] = ay + dir.y * r;
    starPositions[i * 3 + 2] = az + dir.z * r;
  }

  const controlPoints: Vector3[] = [];
  for (let i = 0; i < def.controlPointCount; i++) {
    const dir = randomUnitVector3();
    const r = Math.random() * def.spreadRadius;
    controlPoints.push(new Vector3(dir.x * r, dir.y * r, dir.z * r));
  }
  const padded = [controlPoints[0], ...controlPoints, controlPoints[controlPoints.length - 1]];

  const localDots = placeDotsAlongPath(def.dotCount, padded);
  const dotPositions = new Float32Array(def.dotCount * 3);
  for (let i = 0; i < def.dotCount; i++) {
    dotPositions[i * 3] = ax + localDots[i * 3];
    dotPositions[i * 3 + 1] = ay + localDots[i * 3 + 1];
    dotPositions[i * 3 + 2] = az + localDots[i * 3 + 2];
  }

  return { starPositions, dotPositions };
}
