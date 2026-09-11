// Single source of truth for the 3 constellations — which one shows up is
// picked by ConstellationsSystem from globals.dominantPebbleType, reusing
// pebble-type.ts's existing 0=soul dust/1=organic matter/2=volatile gasses
// ordering as this table's keys. Each type has exactly one constellation
// now (Dog/Tree/Crown), so ConstellationsSystem.play()'s random slot pick
// always lands on index 0 — kept as a plain array (not a bare object) so a
// type could grow back to multiple names later without restructuring.
// Each name's actual star SHAPE lives in constellation-shapes.ts
// (CONSTELLATION_SHAPES) — starCount here must match that shape's own point
// count exactly (constellation-path.ts warns if they drift out of sync).
export interface ConstellationDef {
  name: string;
  spreadRadius: number; // bounding size of the shape's region, meters
  starCount: number; // number of points in this name's CONSTELLATION_SHAPES entry — also the number of interactive stars
}

// starCount is capped at 10 — a real constellation is a handful of named
// stars forming a rough shape, not a dense dot-to-dot outline. With far
// fewer stars, spreadRadius grows substantially (roughly 2-2.5x the
// previous 0.3-0.58 range) so the few stars that remain read as spread
// across a real patch of sky instead of clustering tightly. Flagged: this spread is wide enough
// that some stars may sit near the edge of comfortable reach, or (on the
// anchor's planet-facing side) clip toward the intermediate planet's surface
// (see ANCHOR_SURFACE_OFFSET in constellation-path.ts, unchanged at 0.3) —
// worth checking in-headset. ConstellationsVfxSystem also scatters a larger
// field of smaller, non-interactive background stars around whichever
// anchor is active, so the chosen constellation reads as picked out of a
// real sky instead of floating alone.
export const CONSTELLATION_SETS: Record<number, ConstellationDef[]> = {
  0: [{ name: 'Dog', spreadRadius: 0.9, starCount: 6 }], // soul dust
  1: [{ name: 'Tree', spreadRadius: 1.3, starCount: 10 }], // organic matter
  2: [{ name: 'Crown', spreadRadius: 0.9, starCount: 6 }], // volatile gasses
};
