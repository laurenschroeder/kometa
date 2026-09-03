import { BufferAttribute, BufferGeometry, Vector3 } from '@iwsdk/core';

export interface SwooshCurveParams {
  center: [number, number, number];
  startRadius: number; // radius of the initial spiral loop
  turns: number; // how many full loops the spiral winds before unwinding
  dropHeight: number; // total vertical descent from start to end
  sweepLength: number; // how far the tail drifts out as the spiral unwinds
  driftDir: [number, number, number]; // direction the tail sweeps toward (any magnitude — scaled by sweepLength)
  wobble: number; // extra vertical waviness, fades out as the spiral tightens
}

// A spiral that unwinds into a long drifting sweep — radius decays while
// angle keeps advancing, and a t^2-weighted drift along driftDir (barely
// present near the tight start, dominant by the tail) pulls the unwound end
// out into a trailing streak. Modeled after a reference image of swirling
// light streaks: a tight loop at one end opening into a long sweeping tail.
// Hand-rolled rather than three.js's CatmullRomCurve3 — same reasoning
// constellation-path.ts's own hand-rolled spline gives: @iwsdk/core doesn't
// re-export three's Curve classes, and project convention is three types
// only via @iwsdk/core.
export function sampleSwooshCurve(params: SwooshCurveParams, segments: number): Vector3[] {
  const { center, startRadius, turns, dropHeight, sweepLength, driftDir, wobble } = params;
  const points: Vector3[] = new Array(segments + 1);
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const angle = t * turns * Math.PI * 2;
    const radiusFalloff = Math.pow(1 - t, 1.3);
    const radius = startRadius * radiusFalloff;
    const drift = t * t * sweepLength;
    const wob = Math.sin(t * Math.PI * 5) * wobble * radiusFalloff;
    points[i] = new Vector3(
      center[0] + Math.cos(angle) * radius + driftDir[0] * drift,
      center[1] - t * dropHeight + wob + driftDir[1] * drift,
      center[2] + Math.sin(angle) * radius + driftDir[2] * drift,
    );
  }
  return points;
}

// Thin at both ends, full width shortly after the start — reads as a tight
// bright loop opening into a tapering trailing streak, not a uniform-width
// ribbon.
function widthFactorAt(t: number): number {
  const growth = Math.min(1, t / 0.1);
  const taper = 1 - Math.pow(t, 1.4) * 0.92;
  return Math.max(0.04, growth * taper);
}

// A flat ribbon strip following `points`, oriented by each point's local
// tangent crossed with a world-up reference (falling back to world-+X when
// the tangent is nearly vertical, to avoid a degenerate near-zero cross
// product) — not billboarded, since these curves are already full 3D
// swooshes rather than flat lines that need to face the camera. uv.x runs
// along the curve's length (0-1, for end-fade/shimmer in the ribbon
// shader), uv.y runs across its width (0-1, for the cross-width glow
// falloff).
export function buildStreakRibbonGeometry(points: Vector3[], maxWidth: number): BufferGeometry {
  const n = points.length;
  const positions = new Float32Array(n * 2 * 3);
  const uvs = new Float32Array(n * 2 * 2);
  const up = new Vector3(0, 1, 0);
  const altUp = new Vector3(1, 0, 0);
  const tangent = new Vector3();
  const side = new Vector3();

  for (let i = 0; i < n; i++) {
    if (i === 0) tangent.subVectors(points[1], points[0]);
    else if (i === n - 1) tangent.subVectors(points[n - 1], points[n - 2]);
    else tangent.subVectors(points[i + 1], points[i - 1]);
    tangent.normalize();

    side.crossVectors(tangent, up);
    if (side.lengthSq() < 1e-6) side.crossVectors(tangent, altUp);
    side.normalize();

    const t = i / (n - 1);
    const halfWidth = (maxWidth * widthFactorAt(t)) / 2;
    const p = points[i];
    const li = i * 2;
    const ri = i * 2 + 1;
    positions[li * 3] = p.x + side.x * halfWidth;
    positions[li * 3 + 1] = p.y + side.y * halfWidth;
    positions[li * 3 + 2] = p.z + side.z * halfWidth;
    positions[ri * 3] = p.x - side.x * halfWidth;
    positions[ri * 3 + 1] = p.y - side.y * halfWidth;
    positions[ri * 3 + 2] = p.z - side.z * halfWidth;
    uvs[li * 2] = t;
    uvs[li * 2 + 1] = 1;
    uvs[ri * 2] = t;
    uvs[ri * 2 + 1] = 0;
  }

  const indices: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2;
    const b = i * 2 + 1;
    const c = (i + 1) * 2;
    const d = (i + 1) * 2 + 1;
    indices.push(a, b, c, b, d, c);
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(positions, 3));
  geo.setAttribute('uv', new BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}
