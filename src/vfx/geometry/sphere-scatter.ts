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
export function scatterOnSphereCap(
  count: number,
  center: Vector3,
  radius: number,
  towardDir: Vector3,
  halfAngleRad: number,
): SphereCapScatter {
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const minDot = Math.cos(halfAngleRad);

  for (let i = 0; i < count; i++) {
    let dir: Vector3;
    do {
      dir = randomUnitVector3();
    } while (dir.dot(towardDir) < minDot);

    normals[i * 3] = dir.x;
    normals[i * 3 + 1] = dir.y;
    normals[i * 3 + 2] = dir.z;
    positions[i * 3] = center.x + dir.x * radius;
    positions[i * 3 + 1] = center.y + dir.y * radius;
    positions[i * 3 + 2] = center.z + dir.z * radius;
  }

  return { positions, normals };
}
