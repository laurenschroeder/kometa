import { Vector3 } from '@iwsdk/core';

export interface WeavePathParams {
  ringRadius: number;
  centerY: number;
  amplitude: number;
  planetCount: number;
}

// Closed 3D loop circling at ringRadius around the player, weaving
// vertically over/under each planet as it goes around ("weaves over and
// under each planet" read as a vertical thread-through-a-row-of-beads, not
// a depth/front-back weave — far more VR-comfortable, since it never asks
// the player to walk through the ring itself). u wraps at 1.
//
// Uses cos (not sin) so the wave hits its extremes — the actual over/under
// clearance points — exactly AT each planet's angular position (placePlanets
// below places planet i at u = i/planetCount; cos((i/planetCount)*planetCount*pi)
// = cos(i*pi) = ±1 there). It only crosses centerY, where the path is level
// with a planet's own center, at the midpoint BETWEEN two planets — sin
// would do the opposite (cross centerY exactly at each planet, threading
// straight through its middle instead of clearing over/under it).
export function samplePath(u: number, params: WeavePathParams, out: Vector3 = new Vector3()): Vector3 {
  const angle = u * Math.PI * 2;
  const y = params.centerY + params.amplitude * Math.cos(u * params.planetCount * Math.PI);
  out.set(Math.cos(angle) * params.ringRadius, y, Math.sin(angle) * params.ringRadius);
  return out;
}

// N planets evenly spaced by angle around the ring, sitting at the weave's
// center height (the path threads over/under them, they don't ride the
// wave themselves).
export function placePlanets(count: number, ringRadius: number, centerY: number): Float32Array {
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    out[i * 3] = Math.cos(angle) * ringRadius;
    out[i * 3 + 1] = centerY;
    out[i * 3 + 2] = Math.sin(angle) * ringRadius;
  }
  return out;
}

// N dots evenly spaced by arc length along the weave path — NOT evenly
// spaced by u, since the vertical weave adds extra path length near its
// crests/troughs; naive even-u spacing would visibly bunch dots there.
// Approximates arc length via a fine sample table — only ever runs once,
// from a phase system's init(), so the sample count can be generous.
export function placeDots(count: number, params: WeavePathParams): Float32Array {
  const SAMPLES = 2000;
  const samplePoints: Vector3[] = new Array(SAMPLES + 1);
  const cumLength = new Float32Array(SAMPLES + 1);
  for (let i = 0; i <= SAMPLES; i++) {
    samplePoints[i] = samplePath(i / SAMPLES, params);
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
