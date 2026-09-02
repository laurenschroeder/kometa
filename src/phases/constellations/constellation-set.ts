// Single source of truth for the 9 constellations — which trio shows up is
// picked by ConstellationsSystem from globals.dominantPebbleType, reusing
// pebble-type.ts's existing 0=soul dust/1=organic matter/2=volatile gasses
// ordering as this table's keys. Within a type, one of the 3 is picked at
// random each time Constellations begins (see ConstellationsSystem.play()) —
// no meshes yet (see constellation-path.ts) — spreadRadius/controlPointCount/
// starCount are deliberately spread across small/simple through large/
// complex so there's real variety across playthroughs.
export interface ConstellationDef {
  name: string;
  spreadRadius: number; // bounding size of the winding path's region, meters
  controlPointCount: number; // path winding complexity
  starCount: number; // path length/resolution — also the number of interactive stars
}

// starCount is capped at 10 — a real constellation is a handful of named
// stars forming a rough shape, not a dense dot-to-dot outline. With far
// fewer stars, spreadRadius grows substantially (roughly 2-2.5x the
// previous 0.3-0.58 range) so the few stars that remain read as spread
// across a real patch of sky instead of clustering tightly. controlPointCount
// is trimmed to match — a path with more bends than stars to place along it
// would undersample into a jagged line. Flagged: this spread is wide enough
// that some stars may sit near the edge of comfortable reach, or (on the
// anchor's planet-facing side) clip toward the intermediate planet's surface
// (see ANCHOR_SURFACE_OFFSET in constellation-path.ts, unchanged at 0.3) —
// worth checking in-headset. ConstellationsVfxSystem also scatters a larger
// field of smaller, non-interactive background stars around whichever
// anchor is active, so the chosen constellation reads as picked out of a
// real sky instead of floating alone.
export const CONSTELLATION_SETS: Record<number, ConstellationDef[]> = {
  0: [
    // soul dust
    { name: 'Dog', spreadRadius: 0.9, controlPointCount: 3, starCount: 6 },
    { name: 'Human', spreadRadius: 1.1, controlPointCount: 4, starCount: 8 },
    { name: 'Horn', spreadRadius: 1.3, controlPointCount: 5, starCount: 10 },
  ],
  1: [
    // organic matter
    { name: 'Bird', spreadRadius: 0.95, controlPointCount: 3, starCount: 6 },
    { name: 'Giraffe', spreadRadius: 1.15, controlPointCount: 4, starCount: 8 },
    { name: 'Tree', spreadRadius: 1.3, controlPointCount: 5, starCount: 10 },
  ],
  2: [
    // volatile gasses
    { name: 'Locust', spreadRadius: 1.1, controlPointCount: 4, starCount: 8 },
    { name: 'Crown', spreadRadius: 0.9, controlPointCount: 3, starCount: 6 },
    { name: 'Bow and Arrow', spreadRadius: 1.3, controlPointCount: 5, starCount: 10 },
  ],
};
