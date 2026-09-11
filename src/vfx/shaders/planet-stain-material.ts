import { ShaderMaterial, Vector3 } from '@iwsdk/core';

function vec3Glsl([r, g, b]: [number, number, number]): string {
  return `vec3(${r.toFixed(4)}, ${g.toFixed(4)}, ${b.toFixed(4)})`;
}

const OUTLINE_LOW = 0.6;
const OUTLINE_HIGH = 0.78;

// Same toon rim-light silhouette technique as toon-rim-material.ts
// (duplicated locally — that module doesn't export its OUTLINE_GLSL/
// vec3Glsl helpers) — planets share the game's toon visual language even
// though their core effect (colored splats) is unique to them.
const OUTLINE_GLSL = `
  float wobble = sin(vLocalPos.x * 6.0 + vLocalPos.y * 4.0 + 3.1) * 0.05
               + sin(vLocalPos.y * 5.0 - vLocalPos.z * 3.0 + 1.4) * 0.035;
  float edge    = (1.0 - ndotv) + wobble;
`;

// Number of fixed coverage cells spread evenly across the planet's surface
// (see planet-seeding-system.ts's CELL_DIRS, a Fibonacci-sphere layout built
// from this exact count) — also sizes the uniform arrays below at
// shader-compile time. Each cell owns a permanent splat slot: once a pebble
// lands nearest a cell, that cell's uSplatBirth/Color/Center are set ONCE
// and never reassigned to a different cell, so — unlike the old ring-buffer
// design — a splat can never be silently evicted by a later, unrelated
// landing. PlanetSeedingSystem's own win condition is "half of these cells
// have been colored" (see its COVERAGE_WIN_FRACTION).
export const MAX_SPLATS = 40;
// Splats now grow in TWO stages rather than one: during Seeding, a landing
// only ever grows to SEED_SPLAT_DOT (tiny — a ~8.6° cap, just enough to read
// as "something landed here"), so the planet fills in with a scatter of
// small dots rather than looking done already. Only once Leg A (the spin+
// recede transition into Constellations — see PlanetSpinTransition) starts
// does the whole surface bloom from those tiny dots up to FINAL_SPLAT_DOT's
// full ~21.6° patches — see uFinalGrowT below, driven every frame from
// PlanetSpinTransition.getProgress() (0 before Leg A, ramping to 1 across
// it, then holding at 1 forever). Local patches on the planet's small
// (~0.11m) radius either way — many overlapping splats from wandering near
// the planet are what eventually give it broad coverage.
const SEED_SPLAT_DOT = 0.988;
const FINAL_SPLAT_DOT = 0.93;
// Bumped from 0.5 — with each cell now only ever growing in once (see
// planet-seeding-vfx-system.ts's _addSplat), a slower, more visible grow-in
// reads as real progress forming rather than a near-instant pop.
const SPLAT_GROW_SECONDS = 0.9;
const SPLAT_SOFTNESS = 0.05;

// Each landing (see PlanetSeedingVfxSystem._addSplat) drops a small colored
// disc — the color of whichever pebble fell — at the exact surface point the
// player was near, growing in over SPLAT_GROW_SECONDS from a point to
// MAX_SPLAT_DOT. Color visibly follows the player around the planet's
// surface, and — since each splat's color is independently rolled from the
// comet's own pebble-type mix — the surface reads as multi-colored rather
// than a single flat hue. uSplatBirth defaults to -1 ("not yet colored");
// the loop below skips any cell still at that sentinel, so cells fill in in
// whatever order the player actually visits rather than a fixed prefix.
export function makePlanetStainMaterial(baseColor: [number, number, number]): ShaderMaterial {
  const vertexShader = `
    varying vec3 vViewNormal;
    varying vec3 vViewDir;
    varying vec3 vLocalPos;

    void main() {
      vLocalPos = position;
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      vViewNormal = normalize(normalMatrix * normal);
      vViewDir    = normalize(-mvPosition.xyz);
      gl_Position = projectionMatrix * mvPosition;
    }
  `;

  const fragmentShader = `
    uniform float uTime;
    uniform float uFinalGrowT;
    uniform vec3  uSplatCenter[${MAX_SPLATS}];
    uniform vec3  uSplatColor[${MAX_SPLATS}];
    uniform float uSplatBirth[${MAX_SPLATS}];
    varying vec3  vViewNormal;
    varying vec3  vViewDir;
    varying vec3  vLocalPos;

    void main() {
      vec3  n     = normalize(vViewNormal);
      vec3  v     = normalize(vViewDir);
      float ndotv = max(0.0, dot(n, v));

      ${OUTLINE_GLSL}
      float outline = smoothstep(${OUTLINE_LOW.toFixed(4)}, ${OUTLINE_HIGH.toFixed(4)}, edge);

      vec3 bodyCol = ${vec3Glsl(baseColor)};
      vec3 localDir = normalize(vLocalPos);
      for (int i = 0; i < ${MAX_SPLATS}; i++) {
        if (uSplatBirth[i] < 0.0) continue;
        float age    = max(0.0, uTime - uSplatBirth[i]);
        float growT  = clamp(age / ${SPLAT_GROW_SECONDS.toFixed(4)}, 0.0, 1.0);
        float stageDot = mix(${SEED_SPLAT_DOT.toFixed(4)}, ${FINAL_SPLAT_DOT.toFixed(4)}, uFinalGrowT);
        float threshold = mix(1.0, stageDot, growT);
        float d = dot(localDir, uSplatCenter[i]);
        float splatEdge = smoothstep(threshold - ${SPLAT_SOFTNESS.toFixed(4)}, threshold + ${SPLAT_SOFTNESS.toFixed(4)}, d);
        bodyCol = mix(bodyCol, uSplatColor[i], splatEdge);
      }

      vec3 col = mix(bodyCol, vec3(1.0), outline);
      gl_FragColor = vec4(col, 1.0);
    }
  `;

  const splatCenters: Vector3[] = Array.from({ length: MAX_SPLATS }, () => new Vector3(0, 1, 0));
  const splatColors: Vector3[] = Array.from({ length: MAX_SPLATS }, () => new Vector3(0, 0, 0));
  const splatBirths: number[] = new Array(MAX_SPLATS).fill(-1);

  return new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uFinalGrowT: { value: 0 },
      uSplatCenter: { value: splatCenters },
      uSplatColor: { value: splatColors },
      uSplatBirth: { value: splatBirths },
    },
    vertexShader,
    fragmentShader,
    depthWrite: true,
    transparent: false,
  });
}
