// Single source of truth for the 3 constellations — which one shows up is
// picked by ConstellationsSystem from globals.dominantPebbleType, reusing
// pebble-type.ts's existing 0=soul dust/1=organic matter/2=volatile gasses
// ordering as this table's keys. Each type has exactly one constellation
// now (Shepherd/Harvest/Throne), so ConstellationsSystem.play()'s random
// slot pick always lands on index 0 — kept as a plain array (not a bare
// object) so a type could grow back to multiple names later without
// restructuring. Gas's own constellation was originally named 'Crown' —
// renamed to 'Throne' since it read as the same thing as the game's own
// universal CrownRise cinematic (every constellation's completion sends an
// actual crown up to the comet — see earth-situations-vfx-system.ts's
// _onCompletion), when it was really naming the King/tower/death vignette
// specifically.
// Each name's actual star SHAPE lives in constellation-shapes.ts
// (CONSTELLATION_SHAPES) — starCount here must match that shape's own point
// count exactly (constellation-path.ts warns if they drift out of sync).
export interface ConstellationDef {
  name: string;
  spreadRadius: number; // bounding size of the shape's region, meters
  verticalScale?: number; // squash of the shape's Y axis (default 0.5, see constellation-path.ts)
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
  // These three are authored directly in meters (see constellation-shapes.ts),
  // hence spreadRadius 1 / verticalScale 1, and exceed the 10-star cap above:
  // the shapes are now arm-sized loops (infinity / circles) that want a star
  // every ~15-20 cm to sweep up with one arm motion.
  0: [{ name: 'Shepherd', spreadRadius: 1, verticalScale: 1, starCount: 12 }], // soul dust — horizontal infinity
  1: [{ name: 'Harvest', spreadRadius: 1, verticalScale: 1, starCount: 16 }], // organic matter — two small circles
  2: [{ name: 'Throne', spreadRadius: 1, verticalScale: 1, starCount: 17 }], // volatile gasses — two circles, figure-eight line
};
