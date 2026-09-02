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

// Bounds the per-planet splat ring buffer — see PlanetSeedingVfxSystem's
// own MAX_SPLATS/_addSplat, which must stay in sync with this value (the
// uniform arrays below are sized to it at shader-compile time).
export const MAX_SPLATS = 24;
// Dot-product threshold a fully-grown splat reaches — 0.93 ≈ a ~21.6°
// angular cap, a local patch on the planet's small (~0.11m) radius rather
// than something that could cover the whole sphere on its own; many
// overlapping splats from wandering near the planet are what eventually
// give it broad coverage.
const MAX_SPLAT_DOT = 0.93;
const SPLAT_GROW_SECONDS = 0.5;
const SPLAT_SOFTNESS = 0.05;

// Each landing (see PlanetSeedingVfxSystem._addSplat) drops a small colored
// disc — the color of whichever pebble fell — at the exact surface point the
// player was near, growing in over SPLAT_GROW_SECONDS from a point to
// MAX_SPLAT_DOT. Replaces the old single global stain-center/coverage
// design: instead of one blob expanding from wherever the first dust
// happened to land, color now visibly follows the player around the
// planet's surface, and — since each splat's color is independently rolled
// from the comet's own pebble-type mix — the surface reads as multi-colored
// rather than a single flat hue. uSplatCount gates the loop below at
// whichever slot the ring buffer has reached; slots beyond it hold stale
// data from a previous loop of the buffer but are never read.
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
    uniform int   uSplatCount;
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
        if (i >= uSplatCount) break;
        float age    = max(0.0, uTime - uSplatBirth[i]);
        float growT  = clamp(age / ${SPLAT_GROW_SECONDS.toFixed(4)}, 0.0, 1.0);
        float threshold = mix(1.0, ${MAX_SPLAT_DOT.toFixed(4)}, growT);
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
  const splatBirths: number[] = new Array(MAX_SPLATS).fill(0);

  return new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uSplatCount: { value: 0 },
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
