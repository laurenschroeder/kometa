import { Vector3 } from '@iwsdk/core';
import { randomUnitVector3 } from './mesh-utils.js';

export interface SphereCapScatter {
  positions: Float32Array; // count*3, world-space points on the sphere surface
  normals: Float32Array; // count*3, outward unit normal ("up") at each point
}

// Scatters `count` points on a sphere's surface, restricted to the cap
// within halfAngleRad of towardDir — rejection-samples randomUnitVector3()
// (same technique that function already uses internally) until it lands in
// the cap, so callers only ever see points on the near/visible/reachable
// side of the sphere, never the far side. normals doubles as each point's
// "up" direction (for orienting something standing on the curved surface)
// and its outward offset direction (e.g. for a label floating above it).
// `excludeHalfAngleRad` (default 0, i.e. no exclusion) additionally rejects
// anything WITHIN that inner half-angle of towardDir — an annulus instead of
// a filled cap — for scattering a crowd around a single fixed dead-center
// point (e.g. the King) without any of them landing on top of it.
export function scatterOnSphereCap(
  count: number,
  center: Vector3,
  radius: number,
  towardDir: Vector3,
  halfAngleRad: number,
  excludeHalfAngleRad = 0,
): SphereCapScatter {
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const minDot = Math.cos(halfAngleRad);
  const maxDot = excludeHalfAngleRad > 0 ? Math.cos(excludeHalfAngleRad) : 1;

  for (let i = 0; i < count; i++) {
    let dir: Vector3;
    do {
      dir = randomUnitVector3();
    } while (dir.dot(towardDir) < minDot || dir.dot(towardDir) > maxDot);

    normals[i * 3] = dir.x;
    normals[i * 3 + 1] = dir.y;
    normals[i * 3 + 2] = dir.z;
    positions[i * 3] = center.x + dir.x * radius;
    positions[i * 3 + 1] = center.y + dir.y * radius;
    positions[i * 3 + 2] = center.z + dir.z * radius;
  }

  return { positions, normals };
}
