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

const GOLDEN_ANGLE_RAD = Math.PI * (3 - Math.sqrt(5));

// Deterministic, evenly-spaced alternative to scatterOnSphereCap's random
// rejection sampling — a "sunflower" spiral (golden-angle azimuth, sqrt-
// radius for equal-area rings, same technique a flat-disc sunflower pattern
// uses) mapped onto the spherical cap instead of scatterOnSphereCap's
// uniform-random draw. Two things that matters for a crowd of people rather
// than a scatter of decorations: it never lands two points close enough to
// overlap (random rejection sampling has no such guarantee — two draws can
// land right next to each other by chance), and it's a pure function of
// `count`/the angle params, not Math.random() — so re-tuning where a crowd
// stands is a matter of adjusting fixed numbers and re-running, not
// re-rolling a random draw each time and hoping it looks the same.
export function scatterOnSphereCapEven(
  count: number,
  center: Vector3,
  radius: number,
  towardDir: Vector3,
  halfAngleRad: number,
  excludeHalfAngleRad = 0,
): SphereCapScatter {
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);

  const worldUp = new Vector3(0, 1, 0);
  const tangentU = new Vector3().crossVectors(worldUp, towardDir);
  if (tangentU.lengthSq() < 1e-6) tangentU.set(1, 0, 0);
  tangentU.normalize();
  const tangentV = new Vector3().crossVectors(towardDir, tangentU).normalize();

  const dir = new Vector3();
  for (let i = 0; i < count; i++) {
    const frac = (i + 0.5) / count;
    const angle = excludeHalfAngleRad + (halfAngleRad - excludeHalfAngleRad) * Math.sqrt(frac);
    const azimuth = i * GOLDEN_ANGLE_RAD;

    dir.copy(towardDir).multiplyScalar(Math.cos(angle));
    dir.addScaledVector(tangentU, Math.cos(azimuth) * Math.sin(angle));
    dir.addScaledVector(tangentV, Math.sin(azimuth) * Math.sin(angle));
    dir.normalize();

    normals[i * 3] = dir.x;
    normals[i * 3 + 1] = dir.y;
    normals[i * 3 + 2] = dir.z;
    positions[i * 3] = center.x + dir.x * radius;
    positions[i * 3 + 1] = center.y + dir.y * radius;
    positions[i * 3 + 2] = center.z + dir.z * radius;
  }

  return { positions, normals };
}

// Places `count` points along a semicircular ARC at a fixed angular radius
// from `towardDir` (e.g. a King standing dead-center of the cap — see
// fate-event-system.ts's KING_EXCLUSION_HALF_ANGLE) instead of filling the
// cap's whole disc — for a crowd meant to gather AROUND one central figure
// rather than scattered in front of them. The semicircle is centered on
// whichever half of the ring points away from the camera (tangentU's own
// sign, matching earth-situations-vfx-system.ts's existing bee-tangent
// convention: this is world-space "away from the player," not the ring's
// literal geometric center), so nobody stands in the sliver directly
// between the player and the central figure. Index 0 and 1 land at the
// arc's two open ends — the two points closest to the camera along the
// ring — matching fate-event-system.ts's own convention that its first two
// (named) figures sit at the most easily-reachable spots.
export function scatterSemicircleAroundPoint(
  count: number,
  center: Vector3,
  radius: number,
  towardDir: Vector3,
  arcAngleRad: number,
): SphereCapScatter {
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);

  const worldUp = new Vector3(0, 1, 0);
  const arbitrary = Math.abs(towardDir.y) < 0.9 ? worldUp : new Vector3(1, 0, 0);
  const tangentAway = new Vector3().crossVectors(towardDir, arbitrary).normalize();
  const tangentSide = new Vector3().crossVectors(towardDir, tangentAway).normalize();

  const half = Math.PI / 2;
  const dir = new Vector3();
  for (let i = 0; i < count; i++) {
    let phi: number;
    if (i === 0) phi = -half;
    else if (i === 1) phi = half;
    else {
      // (count-2) interior slots, strictly between the two ends (frac
      // ranges over (0,1) exclusive for i in [2, count-1], never reaching
      // the ±half endpoints i===0/1 already claimed).
      const frac = (i - 1) / (count - 1);
      phi = -half + Math.PI * frac;
    }

    dir.copy(towardDir).multiplyScalar(Math.cos(arcAngleRad));
    dir.addScaledVector(tangentAway, Math.cos(phi) * Math.sin(arcAngleRad));
    dir.addScaledVector(tangentSide, Math.sin(phi) * Math.sin(arcAngleRad));
    dir.normalize();

    normals[i * 3] = dir.x;
    normals[i * 3 + 1] = dir.y;
    normals[i * 3 + 2] = dir.z;
    positions[i * 3] = center.x + dir.x * radius;
    positions[i * 3 + 1] = center.y + dir.y * radius;
    positions[i * 3 + 2] = center.z + dir.z * radius;
  }

  return { positions, normals };
}
