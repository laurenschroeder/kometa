import { Vector3 } from '@iwsdk/core';
import { randomUnitVector3 } from '../../vfx/geometry/mesh-utils.js';

// Anchor for the first group — "straight ahead" from the player origin,
// same convention orbital-launch-system.ts's ORBIT_DIR already establishes
// (no locomotion, so player origin never moves). The rest are spaced evenly
// around it.
const FIRST_GROUP_DIR: [number, number, number] = [0, 0, -1];

const N_GROUPS = 9;
const GROUP_SPACING_DEG = 360 / N_GROUPS; // 40°
// Wider than half the spacing (20°) so neighboring groups' cones overlap a
// little rather than leaving a hard-edged gap between them.
const GROUP_HALF_ANGLE_DEG = 23;

export interface PebbleSpawnPoint {
  dir: Vector3;
  radiusT: number;
  type: number;
}

function rotateAroundY(base: [number, number, number], degrees: number): Vector3 {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return new Vector3(base[0] * cos + base[2] * sin, base[1], -base[0] * sin + base[2] * cos);
}

// Blue=0, Green=1, Red=2 — see pebble-type.ts's PEBBLE_TYPES. Cycling all
// three colors across N_GROUPS=9 (a multiple of 3) puts 3 groups of each
// color 120° apart from each other, interleaved with the other two colors
// every 40° — no two adjacent groups share a color, and each color is
// itself evenly spread around the full circle.
const GROUP_COLOR_CYCLE = [0, 1, 2];
const GROUP_DEFS: { center: Vector3; type: number }[] = Array.from({ length: N_GROUPS }, (_, i) => ({
  center: rotateAroundY(FIRST_GROUP_DIR, i * GROUP_SPACING_DEG),
  type: GROUP_COLOR_CYCLE[i % GROUP_COLOR_CYCLE.length],
}));

const GROUP_COS = Math.cos((GROUP_HALF_ANGLE_DEG * Math.PI) / 180);

function sampleGroupDirection(center: Vector3): Vector3 {
  let dir: Vector3;
  do {
    dir = randomUnitVector3();
  } while (dir.dot(center) < GROUP_COS);
  return dir;
}

// Chapter 2's spatial layout: red, green, and blue each form 3 discrete
// groups, spread evenly around the full 360° circle around the player
// (not clustered to any one side), with a bit of overlap between
// neighboring groups' cones rather than a hard gap — see GROUP_HALF_ANGLE_DEG.
// Called once per pebble (see GatherableFieldParams.spawnPoint) at
// field-construction time; radius stays full-range/uniform-in-r for every
// group, same as the field's default path — "group" describes the angular
// shape, not a thin radius shell.
export function assignPebbleSpawnPoint(): PebbleSpawnPoint {
  const group = GROUP_DEFS[Math.floor(Math.random() * GROUP_DEFS.length)];
  return { dir: sampleGroupDirection(group.center), radiusT: Math.random(), type: group.type };
}
