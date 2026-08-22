import { ShaderMaterial, Vector3 } from '@iwsdk/core';

function vec3Glsl([r, g, b]: [number, number, number]): string {
  return `vec3(${r.toFixed(4)}, ${g.toFixed(4)}, ${b.toFixed(4)})`;
}

const OUTLINE_LOW = 0.6;
const OUTLINE_HIGH = 0.78;

// Same toon rim-light silhouette technique as toon-rim-material.ts
// (duplicated locally — that module doesn't export its OUTLINE_GLSL/
// vec3Glsl helpers) — planets share the game's toon visual language even
// though their core effect (a growing color stain) is unique to them.
const OUTLINE_GLSL = `
  float wobble = sin(vLocalPos.x * 6.0 + vLocalPos.y * 4.0 + 3.1) * 0.05
               + sin(vLocalPos.y * 5.0 - vLocalPos.z * 3.0 + 1.4) * 0.035;
  float edge    = (1.0 - ndotv) + wobble;
`;

// Grows a colored "seeded" stain outward from uStainCenter (a unit
// direction in local space) as uCoverage goes 0->1, eventually covering the
// whole sphere. Requires one ShaderMaterial instance per planet (unlike
// e.g. pebble-material.ts's single shared instance) — coverage and stain
// center are genuinely per-planet, per-frame-changing state, not shareable
// uniforms.
export function makePlanetStainMaterial(
  baseColor: [number, number, number],
  stainColor: [number, number, number],
): ShaderMaterial {
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
    uniform float uCoverage;
    uniform vec3  uStainCenter;
    varying vec3  vViewNormal;
    varying vec3  vViewDir;
    varying vec3  vLocalPos;

    void main() {
      vec3  n     = normalize(vViewNormal);
      vec3  v     = normalize(vViewDir);
      float ndotv = max(0.0, dot(n, v));

      ${OUTLINE_GLSL}
      float outline = smoothstep(${OUTLINE_LOW.toFixed(4)}, ${OUTLINE_HIGH.toFixed(4)}, edge);

      // threshold ranges from just above the max possible dot product (1.0)
      // at coverage=0 — so the stain is invisible everywhere, not even a
      // sliver at the exact stain center — down to just below the min
      // (-1.0) at coverage=1, so it covers the whole sphere.
      const float softness = 0.08;
      float threshold  = mix(1.0 + softness, -1.0 - softness, uCoverage);
      float stainEdge  = smoothstep(threshold - softness, threshold + softness, dot(normalize(vLocalPos), uStainCenter));
      vec3  bodyCol    = mix(${vec3Glsl(baseColor)}, ${vec3Glsl(stainColor)}, stainEdge);

      vec3 col = mix(bodyCol, vec3(1.0), outline);
      gl_FragColor = vec4(col, 1.0);
    }
  `;

  return new ShaderMaterial({
    uniforms: {
      uCoverage: { value: 0 },
      uStainCenter: { value: new Vector3(0, 1, 0) },
    },
    vertexShader,
    fragmentShader,
    depthWrite: true,
    transparent: false,
  });
}
