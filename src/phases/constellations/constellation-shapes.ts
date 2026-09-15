// Hand-authored 2D silhouettes for each named constellation (see
// constellation-set.ts) — normalized roughly to [-1, 1] on both axes, one
// entry per star, in a sensible single-stroke traversal order (constellation-
// path.ts embeds these into 3D and also uses this same order to trace a
// smooth curve through them for the ambient "shape traced out" animation —
// see ConstellationsVfxSystem). Point COUNT must exactly match that name's
// ConstellationDef.starCount in constellation-set.ts (each point doubles as
// an interactive touch/trace star) — generateConstellationLayout warns if
// they ever drift out of sync.
//
// These are deliberately abstracted, like real constellations — a
// recognizable gesture at the named shape with a handful of points, not a
// detailed outline.
export const CONSTELLATION_SHAPES: Record<string, [number, number][]> = {
  // Soul dust — named Shepherd (formerly Dog); the silhouette itself is
  // still a dog, unrenamed — a shepherd's dog, guiding the flock/souls.
  Shepherd: [
    [0.9, 0.2], // nose
    [0.55, 0.55], // head
    [-0.1, 0.6], // back
    [-0.85, 0.35], // tail
    [-0.5, -0.8], // back leg
    [0.35, -0.75], // front leg
  ],
  // Organic matter — named Harvest (formerly Tree); the silhouette itself
  // is still a tree, unrenamed. y-values compressed to 60% of the original
  // full [-1, 1] range (x left untouched) so the tree reads shorter/
  // squatter overall; combined with its own larger spreadRadius (see
  // constellation-set.ts, needed for 10-star point spacing), the original
  // full-height shape put its crown top uncomfortably high above the
  // anchor. x stays at full scale so the branch/canopy touch targets keep
  // their original horizontal spacing.
  Harvest: [
    [0.0, -0.6], // roots
    [0.0, -0.3], // trunk
    [-0.5, -0.06], // branch (left)
    [-0.85, 0.21], // leaf (left)
    [-0.4, 0.42], // canopy (upper left)
    [0.0, 0.57], // crown top
    [0.4, 0.42], // canopy (upper right)
    [0.85, 0.21], // leaf (right)
    [0.5, -0.06], // branch (right)
    [0.05, -0.27], // back toward trunk
  ],
  // Volatile gasses — named Throne (formerly Crown, renamed to avoid
  // confusion with the game's own universal CrownRise cinematic — see
  // constellation-set.ts's own comment). Reshaped from the old zigzag-
  // peaks crown silhouette into an actual throne outline: leg, seat,
  // armrest, then a flat-topped tall back — traced up one side and down
  // the other. 8 points (up from 6) so the seat/armrest/back proportions
  // each get their own touch target instead of jumping straight from leg
  // to armrest.
  Throne: [
    [-0.9, -0.85], // base (left leg)
    [-0.75, -0.45], // seat (left)
    [-0.55, -0.05], // armrest (left)
    [-0.3, 0.9], // back, top-left corner
    [0.3, 0.9], // back, top-right corner
    [0.55, -0.05], // armrest (right)
    [0.75, -0.45], // seat (right)
    [0.9, -0.85], // base (right leg)
  ],
};
