// Single source of truth for the three pebble types Chapter 2 can produce.
// Each pebble is pre-assigned one of these when it spawns (see
// assignPebbleType below), banded by spawn distance into three concentric
// shells around the player — the sky is filled with all three colors from
// the start, not tinted live by how you move.
export interface PebbleType {
  id: number;
  name: string;
  color: [number, number, number]; // 0-1 RGB
}

export const PEBBLE_TYPES: PebbleType[] = [
  { id: 0, name: 'soul dust', color: [0.35, 0.55, 1.0] }, // blue
  { id: 1, name: 'organic matter', color: [0.35, 0.85, 0.4] }, // green
  { id: 2, name: 'volatile gasses', color: [1.0, 0.32, 0.28] }, // red
];

// t <= lowT -> soul dust, t >= highT -> volatile gasses, otherwise organic
// matter — a plain 3-way split over a 0-1 axis.
export function classifyPebbleType(t: number, lowT: number, highT: number): number {
  if (t <= lowT) return 0;
  if (t >= highT) return 2;
  return 1;
}

// Shell boundaries over spawnRadiusT (0 = nearest possible spawn point, 1 =
// farthest — a full 360-degree sphere around the player, see
// GatherableField's randomUnitVector3 spawn direction). Deliberately
// unequal: blue's inner shell is a thin 20% band (it's already easy to
// reach, so it can afford to be sparser) while green and red each get a
// full 40% band — thicker shells, and since spawn radius is sampled
// uniformly in r, a thicker band means more actual pebbles landing in it —
// making the classes that require a real swing easier to find and string
// together.
const EASY_REACH_T = 0.2;
const BIG_SWING_T = 0.6;

// Called once per pebble at spawn/reset (see GatherableFieldParams.assignType).
// Deliberately a hard distance band, not a randomized blend — the three
// colors should read as clearly layered shells you can lean into (stay
// close and the sky reads mostly blue; reach for the far shell and you'll
// pull in red), not a fuzzy gradient.
export function assignPebbleType(spawnRadiusT: number): number {
  return classifyPebbleType(spawnRadiusT, EASY_REACH_T, BIG_SWING_T);
}
