import { AdditiveBlending, ShaderMaterial } from '@iwsdk/core';
import { ATMOSPHERE, hexToGlsl } from '../color/color-scheme.js';

// Fiery red/orange, independent of any planet's own STAIN_PALETTE hue — this
// represents volatile-gasses ignition specifically, not the generic seeded
// stain every class grows (see planet-stain-material.ts).
const ATMOSPHERE_COLOR = hexToGlsl(ATMOSPHERE);
const FLICKER_FREQ = 2.2;

// A thin, view-dependent glow shell wrapped around a planet — same ndotv
// fresnel technique toon-rim-material.ts/planet-stain-material.ts use for
// their silhouette outline, but soft (no smoothstep toon-step) since this
// reads as gaseous atmosphere, not a hard-edged rim line. uIntensity is
// driven per-planet, per-frame from PlanetSeedingVfxSystem's own eased
// _coverage[p] (see _easeCoverage) — same value the stain shader's
// uCoverage already tracks, just repurposed here as "how lit up" rather
// than "how much of the sphere is covered." One instance per planet:
// intensity is genuinely per-planet state, same reasoning
// makePlanetStainMaterial documents for its own per-planet uniforms.
export function makeAtmosphereGlowMaterial(): ShaderMaterial {
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
    uniform float uIntensity;
    uniform float uTime;
    varying vec3  vViewNormal;
    varying vec3  vViewDir;
    varying vec3  vLocalPos;

    void main() {
      vec3  n     = normalize(vViewNormal);
      vec3  v     = normalize(vViewDir);
      float ndotv = max(0.0, dot(n, v));

      float fresnel = pow(1.0 - ndotv, 2.5);
      float flicker = 0.85 + 0.15 * sin(uTime * ${FLICKER_FREQ.toFixed(4)} + vLocalPos.x * 9.0);
      float alpha   = fresnel * uIntensity * flicker;

      gl_FragColor = vec4(${ATMOSPHERE_COLOR}, alpha);
    }
  `;

  return new ShaderMaterial({
    uniforms: {
      uIntensity: { value: 0 },
      uTime: { value: 0 },
    },
    vertexShader,
    fragmentShader,
    blending: AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
}
