import { Vector3 } from '@iwsdk/core';
import { randomUnitVector3 } from '../../vfx/geometry/mesh-utils.js';

// Reverted from a "typed vein" spiral layout (each type as one continuous
// winding ribbon) back to this discrete-group version — the veins read as
// too fiddly to actually follow in practice. This is the original group
// layout plus one addition: a second, higher ring of groups so pebbles also
// cluster genuinely overhead, not just in a single ring around head height.

// Anchor for the first (horizon-ring) group — "straight ahead" from the
// player origin, same convention orbital-launch-system.ts's ORBIT_DIR
// already establishes (no locomotion, so player origin never moves). The
// rest of that ring is spaced evenly around it.
const FIRST_GROUP_DIR: [number, number, number] = [0, 0, -1];

const N_GROUPS = 9;
const GROUP_SPACING_DEG = 360 / N_GROUPS; // 40°
// Wider than half the spacing (20°) so neighboring groups' cones overlap a
// little rather than leaving a hard-edged gap between them.
const GROUP_HALF_ANGLE_DEG = 23;

// A second, higher ring — six groups tilted UPPER_ELEVATION_DEG above the
// horizon, offset in azimuth from the lower ring (see
// UPPER_GROUP_AZIMUTH_OFFSET_DEG) so they sit between the lower groups
// rather than stacking directly above them, reading as a distinct overhead
// layer rather than a taller version of the same ring.
const UPPER_ELEVATION_DEG = 55;
const N_UPPER_GROUPS = 6;
const UPPER_GROUP_SPACING_DEG = 360 / N_UPPER_GROUPS; // 60°
const UPPER_GROUP_AZIMUTH_OFFSET_DEG = UPPER_GROUP_SPACING_DEG / 2;
const UPPER_FIRST_GROUP_DIR: [number, number, number] = [
  0,
  Math.sin((UPPER_ELEVATION_DEG * Math.PI) / 180),
  -Math.cos((UPPER_ELEVATION_DEG * Math.PI) / 180),
];
// Same overlap idea as GROUP_HALF_ANGLE_DEG, sized for this ring's own
// wider per-group spacing (60° vs. the horizon ring's 40°).
const UPPER_GROUP_HALF_ANGLE_DEG = 28;

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
// three colors across every group (15 total between both rings, still a
// multiple of 3) keeps each color represented evenly in both the horizon
// ring and the overhead ring, rather than one layer skewing toward one
// color.
const GROUP_COLOR_CYCLE = [0, 1, 2];
interface GroupDef {
  center: Vector3;
  type: number;
  cosHalfAngle: number;
}
const GROUP_DEFS: GroupDef[] = [
  ...Array.from({ length: N_GROUPS }, (_, i) => ({
    center: rotateAroundY(FIRST_GROUP_DIR, i * GROUP_SPACING_DEG),
    type: GROUP_COLOR_CYCLE[i % GROUP_COLOR_CYCLE.length],
    cosHalfAngle: Math.cos((GROUP_HALF_ANGLE_DEG * Math.PI) / 180),
  })),
  ...Array.from({ length: N_UPPER_GROUPS }, (_, i) => ({
    center: rotateAroundY(UPPER_FIRST_GROUP_DIR, UPPER_GROUP_AZIMUTH_OFFSET_DEG + i * UPPER_GROUP_SPACING_DEG),
    type: GROUP_COLOR_CYCLE[(N_GROUPS + i) % GROUP_COLOR_CYCLE.length],
    cosHalfAngle: Math.cos((UPPER_GROUP_HALF_ANGLE_DEG * Math.PI) / 180),
  })),
];

function sampleGroupDirection(center: Vector3, cosHalfAngle: number): Vector3 {
  let dir: Vector3;
  do {
    dir = randomUnitVector3();
  } while (dir.dot(center) < cosHalfAngle);
  return dir;
}

// Chapter 2's spatial layout: red, green, and blue each form discrete
// groups — 9 spread evenly around the horizon (not clustered to any one
// side), plus 6 more up in a higher overhead ring (see UPPER_ELEVATION_DEG)
// so pebbles also cluster genuinely above you, not just anywhere in one
// flat ring — with a bit of overlap between neighboring groups' cones
// rather than a hard gap (see *_HALF_ANGLE_DEG). Called once per pebble
// (see GatherableFieldParams.spawnPoint) at field-construction time;
// radius stays full-range/uniform-in-r for every group, same as the
// field's default path — "group" describes the angular shape, not a thin
// radius shell.
export function assignPebbleSpawnPoint(): PebbleSpawnPoint {
  const group = GROUP_DEFS[Math.floor(Math.random() * GROUP_DEFS.length)];
  return { dir: sampleGroupDirection(group.center, group.cosHalfAngle), radiusT: Math.random(), type: group.type };
}

// Must match the spawnCenter/spawnRadiusMin/spawnRadiusMax the pebble field
// is actually constructed with (see PebbleWeavingSystem.init()) — kept as
// separate constants here (not imported/shared) since this is only ever
// used for the approximate "where does this call come from" placement
// below, not gameplay itself; a small mismatch would be cosmetically
// unnoticeable either way.
const FIELD_SPAWN_CENTER: [number, number, number] = [0, 1.2, 0];
const FIELD_SPAWN_RADIUS_MID = (0.5 + 1.8) / 2;

// For the "Three paths call to you" intro beat (see notification-copy.ts's
// Phase.Pebbles entry and PebbleWeavingSystem.TYPE_REVEAL_AT_SECONDS) — of
// this type's groups, picks whichever one's center sits closest to the
// given forward direction (typically the camera forward captured once at
// phase start) and returns a world-space point roughly in the middle of
// that group's cluster, for a positional "this path is calling" chime.
export function closestGroupOriginForType(type: number, forward: Vector3, out: Vector3): Vector3 {
  let best: GroupDef | null = null;
  let bestDot = -Infinity;
  for (const group of GROUP_DEFS) {
    if (group.type !== type) continue;
    const dot = group.center.dot(forward);
    if (dot > bestDot) {
      bestDot = dot;
      best = group;
    }
  }
  const dir = best ? best.center : GROUP_DEFS[0].center;
  return out.set(
    FIELD_SPAWN_CENTER[0] + dir.x * FIELD_SPAWN_RADIUS_MID,
    FIELD_SPAWN_CENTER[1] + dir.y * FIELD_SPAWN_RADIUS_MID,
    FIELD_SPAWN_CENTER[2] + dir.z * FIELD_SPAWN_RADIUS_MID,
  );
}
