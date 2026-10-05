// Shot definitions for render.mjs. Every field is consumed by
// page/main.ts's Shot/Comet interfaces — see there for what each one means.
// Face/pebble index order matches PEBBLE_TYPES: 0 = soul, 1 = organic, 2 = gas.

const BASE = {
  ss: 2,
  fov: 38,
  camDist: 0.3,
  faceTurn: [0, 0, 0],
  faceSize: 2.6,
  trueAspect: true,
  gameFace: true,
  headScale: 1.7,
  gasBoost: 0.45,
  gasSize: 0.7,
  nebula: 1,
  nebulaCenter: [0.5, 0.5],
  glow: 0.35,
  stars: 1,
  hazeBoost: 1.0,
  // Carved-stone face (RockyFaceParams in src/vfx/shaders/toon-rim-material.ts)
  // — same values as the game's HEAD_ROCKY_FACE. All zeros = original flat face.
  faceEdgeFade: 0.25,
  faceGrain: 0.95,
  faceTint: 0.5,
  bodyGrain: 1.0,
  title: 'none',
  titleX: 0.5,
  frame: false,
  time: 1.3,
};

const shot = (o) => ({ ...BASE, ...o, tail: { ...o.tail } });

// Pebble mixes that lean toward the face's own type (in-game the face IS the
// dominant pebble type) while still showing the other two.
const MIX = [
  [130, 60, 50], // soul
  [50, 200, 50], // organic
  [50, 60, 170], // gas
];
const FACES = ['soul', 'organic', 'gas'];
// The faces differ in width — gas spreads widest, so it sits a bit smaller.
const FACE_SIZE = [2.6, 2.9, 2.3];

// ── Covers ─────────────────────────────────────────────────────────────────
// Head upper-center looking straight out, tail swishing up and away behind
// it; title lockup in the lower band. Each face gets a titled + clean pair.
const covers = [];
for (const face of [0, 1, 2]) {
  const common = {
    seed: 100 + face * 7,
    face,
    counts: MIX[face],
    faceSize: FACE_SIZE[face] * 1.05,
    nebulaCenter: [0.5, 0.7],
  };
  const portrait = {
    ...common,
    w: 800, h: 1200,
    fov: 42,
    head: [-0.1, 0.16],
    camDist: 0.3,
    faceTurn: [0.03, 0.04, 0.04],
    tail: { angle: 52, length: 1.3, depth: 0.36, swish: 0.1, waves: 1.7, phase: 0.6 + face, spread: 0.75 },
  };
  const square = {
    ...common,
    w: 800, h: 800,
    head: [-0.18, 0.12],
    camDist: 0.32,
    faceTurn: [0.04, 0.03, 0.03],
    tail: { angle: 34, length: 1.3, depth: 0.38, swish: 0.1, waves: 1.6, phase: 0.6 + face, spread: 0.75 },
  };
  // HD landscape: comet on the left looking out, tail sweeping up and back
  // behind it, title lockup on the right.
  const landscape = {
    ...common,
    w: 1920, h: 1080,
    head: [-0.42, -0.08],
    camDist: 0.3,
    faceTurn: [0.06, 0.02, 0.03],
    tail: { angle: 128, length: 1.3, depth: 0.5, swish: 0.11, waves: 1.6, phase: 0.6 + face, spread: 0.75 },
    nebulaCenter: [0.3, 0.6],
  };
  covers.push(
    shot({ ...landscape, name: `cover-landscape-${FACES[face]}`, title: 'middle', titleX: 0.68, frame: true }),
    shot({ ...landscape, name: `cover-landscape-${FACES[face]}-clean`, head: [-0.1, -0.05], tail: { ...landscape.tail, angle: 150 } }),
    shot({ ...portrait, name: `cover-portrait-${FACES[face]}`, title: 'bottom', frame: true }),
    shot({ ...portrait, name: `cover-portrait-${FACES[face]}-clean` }),
    shot({ ...square, name: `cover-square-${FACES[face]}`, title: 'bottom', frame: true, head: [-0.2, 0.3], camDist: 0.34 }),
    shot({ ...square, name: `cover-square-${FACES[face]}-clean` }),
  );
}

// ── Gallery 1920x1080 ──────────────────────────────────────────────────────
const gallery = [
  shot({
    name: 'gallery-soul',
    w: 1920, h: 1080, seed: 11, face: 0, counts: MIX[0], faceSize: FACE_SIZE[0],
    head: [-0.42, -0.02],
    tail: { angle: 6, length: 1.3, depth: 0.3, swish: 0.13, waves: 1.6, phase: 3.6, spread: 0.8 },
    nebulaCenter: [0.62, 0.5],
  }),
  shot({
    name: 'gallery-organic',
    w: 1920, h: 1080, seed: 23, face: 1, counts: MIX[1], faceSize: FACE_SIZE[1],
    head: [0.36, 0.05],
    faceTurn: [0.12, 0, 0.05],
    tail: { angle: 176, length: 1.3, depth: 0.3, swish: 0.13, waves: 1.7, phase: 2.6, spread: 0.85 },
    nebulaCenter: [0.38, 0.5],
  }),
  shot({
    name: 'gallery-gas',
    w: 1920, h: 1080, seed: 37, face: 2, counts: MIX[2], faceSize: FACE_SIZE[2],
    head: [-0.3, -0.12],
    faceTurn: [-0.08, 0, -0.06],
    tail: { angle: 20, length: 1.3, depth: 0.3, swish: 0.12, waves: 1.5, phase: 0.8, spread: 0.85 },
    nebulaCenter: [0.6, 0.55],
  }),
  // Tight close-up: the head fills the right of frame, tail whipping off
  // to the upper left behind it.
  shot({
    name: 'gallery-closeup-gas',
    w: 1920, h: 1080, seed: 41, face: 2, counts: [60, 70, 200], faceSize: FACE_SIZE[2],
    head: [0.3, -0.08],
    camDist: 0.15,
    faceTurn: [0.18, 0.04, 0.08],
    tail: { angle: 158, length: 1.4, depth: 0.55, swish: 0.12, waves: 1.6, phase: 1.4, spread: 0.85 },
    nebulaCenter: [0.35, 0.6],
  }),
  // All three faces together, tails interleaving.
  shot({
    name: 'gallery-trio',
    w: 1920, h: 1080, seed: 59, face: 0, counts: MIX[0],
    nebulaCenter: [0.5, 0.45],
    comets: [
      {
        face: 0, counts: [110, 30, 25], faceSize: FACE_SIZE[0], camDist: 0.42, head: [-0.5, 0.18],
        faceTurn: [0.08, 0, 0.06],
        tail: { angle: 128, length: 1.1, depth: 0.45, swish: 0.1, waves: 1.5, phase: 0.6, spread: 0.7 },
      },
      {
        face: 1, counts: [25, 120, 25], faceSize: FACE_SIZE[1], camDist: 0.34, head: [0.02, -0.2],
        tail: { angle: 92, length: 1.2, depth: 0.5, swish: 0.1, waves: 1.6, phase: 2.2, spread: 0.7 },
      },
      {
        face: 2, counts: [25, 30, 110], faceSize: FACE_SIZE[2], camDist: 0.4, head: [0.52, 0.2],
        faceTurn: [-0.08, 0, -0.06],
        tail: { angle: 52, length: 1.1, depth: 0.45, swish: 0.1, waves: 1.5, phase: 1.3, spread: 0.7 },
      },
    ],
  }),
  // Key art with the title lockup up top.
  shot({
    name: 'gallery-keyart',
    w: 1920, h: 1080, seed: 71, face: 0, counts: MIX[0], faceSize: FACE_SIZE[0],
    head: [0.0, -0.3],
    camDist: 0.34,
    tail: { angle: 18, length: 1.35, depth: 0.42, swish: 0.12, waves: 1.6, phase: 0.9, spread: 0.75 },
    nebulaCenter: [0.6, 0.4],
    title: 'top',
  }),
];

// Side-by-side check of the in-game head vs. the promo treatment (stitched
// into promo/compare-faces.png by render.mjs).
const compare = [];
for (const face of [0, 1, 2]) {
  const c = {
    w: 600, h: 600, seed: 200 + face, face, counts: [0, 0, 0], head: [0, 0], camDist: 0.16,
    faceSize: FACE_SIZE[face], stars: 0.6, nebula: 0.6,
    tail: { angle: 0, length: 0.01, depth: 0, swish: 0, waves: 1, phase: 0, spread: 0.1 },
  };
  compare.push(shot({
    ...c, name: `compare-${FACES[face]}-game`,
    faceEdgeFade: 0, faceGrain: 0, faceTint: 0, bodyGrain: 0,
  }));
  compare.push(shot({ ...c, name: `compare-${FACES[face]}-rocky` }));
}

export const SHOTS = [...covers, ...gallery, ...compare];
