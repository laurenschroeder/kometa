// Single source of truth for the 9 constellations — which trio shows up is
// picked by ConstellationsSystem from globals.dominantPebbleType, reusing
// pebble-type.ts's existing 0=soul dust/1=organic matter/2=volatile gasses
// ordering as this table's keys. No meshes yet (see constellation-path.ts) —
// starCount/spreadRadius/controlPointCount/dotCount are deliberately spread
// across small/simple through large/complex so there's real variety to test
// before any custom shapes exist.
export interface ConstellationDef {
  name: string;
  starCount: number;
  spreadRadius: number; // bounding size of the star cluster/path region, meters
  controlPointCount: number; // path winding complexity
  dotCount: number; // path length/resolution
}

// spreadRadius values are scaled to stay reachable given ANCHOR_RADIUS
// (see constellations-system.ts) — the star cluster/path region is a full
// sphere around the anchor, so a dot can land anywhere within
// anchor +/- spreadRadius, not just at the edge.
export const CONSTELLATION_SETS: Record<number, ConstellationDef[]> = {
  0: [
    // soul dust
    { name: 'Dog', starCount: 12, spreadRadius: 0.28, controlPointCount: 4, dotCount: 40 },
    { name: 'Human', starCount: 20, spreadRadius: 0.4, controlPointCount: 6, dotCount: 70 },
    { name: 'Horn', starCount: 28, spreadRadius: 0.5, controlPointCount: 9, dotCount: 110 },
  ],
  1: [
    // organic matter
    { name: 'Bird', starCount: 14, spreadRadius: 0.3, controlPointCount: 5, dotCount: 50 },
    { name: 'Giraffe', starCount: 22, spreadRadius: 0.48, controlPointCount: 5, dotCount: 80 },
    { name: 'Tree', starCount: 24, spreadRadius: 0.42, controlPointCount: 8, dotCount: 90 },
  ],
  2: [
    // volatile gasses
    { name: 'Locust', starCount: 26, spreadRadius: 0.4, controlPointCount: 9, dotCount: 95 },
    { name: 'Crown', starCount: 16, spreadRadius: 0.26, controlPointCount: 8, dotCount: 60 },
    { name: 'Bow and Arrow', starCount: 18, spreadRadius: 0.5, controlPointCount: 4, dotCount: 70 },
  ],
};
