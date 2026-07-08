import { Vector3 } from '@iwsdk/core';
import { RadialField } from './particle-field.js';

// Extracted from the original comet-system.ts _place/_placeInstanced: samples
// a point along a CometTrail buffer by a particle's age (t), then offsets it
// in camera-relative space (right/up/forward) so particles billow behind and
// around the moving comet rather than sitting on a flat 1D line. Pure
// array-in/out — no allocation, no ECS — reused for both bulk Points
// position buffers (haze) and per-instance matrix composition (pebbles).
export function sampleTrailOffset(
  trail: Float32Array,
  samples: number,
  stride: number,
  t: number,
  dx: number,
  dy: number,
  dz: number,
  camRight: Vector3,
  camUp: Vector3,
  camFwd: Vector3,
  out: Vector3,
): Vector3 {
  const si = Math.min(samples - 1, Math.floor(t * samples));
  const ti = si * stride * 3;
  const bx = trail[ti], by = trail[ti + 1], bz = trail[ti + 2];
  out.set(
    bx + camRight.x * dx + camUp.x * dy + camFwd.x * dz,
    by + camRight.y * dx + camUp.y * dy + camFwd.y * dz,
    bz + camRight.z * dx + camUp.z * dy + camFwd.z * dz,
  );
  return out;
}

// Bulk variant for a flat position buffer (e.g. a Points BufferAttribute) —
// writes all of `field`'s particles into outPositions using the same
// pre-allocated scratch Vector3 for every sample.
export function sampleTrailField(
  trail: Float32Array,
  samples: number,
  stride: number,
  field: RadialField,
  camRight: Vector3,
  camUp: Vector3,
  camFwd: Vector3,
  outPositions: Float32Array,
  scratch: Vector3,
): void {
  const { t, dx, dy, dz } = field;
  for (let i = 0; i < t.length; i++) {
    sampleTrailOffset(trail, samples, stride, t[i], dx[i], dy[i], dz[i], camRight, camUp, camFwd, scratch);
    outPositions[i * 3] = scratch.x;
    outPositions[i * 3 + 1] = scratch.y;
    outPositions[i * 3 + 2] = scratch.z;
  }
}
