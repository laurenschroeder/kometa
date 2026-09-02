import { ShaderMaterial, Vector3 } from '@iwsdk/core';

// Palette-parameterized toon rim-light shading, generalized from the
// original comet-system.ts pebble/head shaders: a flat body color (mixed
// dark->light by a per-instance/vertex brightness value) with a thin wobbly
// white silhouette line traced at the true view-space edge. The wobble is a
// function of local (pre-transform) surface position, not screen space, so
// the hand-drawn irregularity stays fixed to each shape's own surface
// instead of swimming as the camera or object moves.
export interface ToonRimPalette {
  bodyColorDark: [number, number, number];
  bodyColorLight: [number, number, number];
  rimColor: [number, number, number];
  outlineLow?: number;
  outlineHigh?: number;
}

const DEFAULT_OUTLINE_LOW = 0.6;
const DEFAULT_OUTLINE_HIGH = 0.78;

function vec3Glsl([r, g, b]: [number, number, number]): string {
  return `vec3(${r.toFixed(4)}, ${g.toFixed(4)}, ${b.toFixed(4)})`;
}

// Shared wobble/edge/outline computation — both factories below splice this
// into their fragment shader so the silhouette technique is defined once.
const OUTLINE_GLSL = `
  float wobble = sin(vLocalPos.x * 6.0 + vLocalPos.y * 4.0 + 3.1) * 0.05
               + sin(vLocalPos.y * 5.0 - vLocalPos.z * 3.0 + 1.4) * 0.035;
  float edge    = (1.0 - ndotv) + wobble;
`;

// Instanced + per-instance-tinted variant — for InstancedMesh (e.g. pebble
// swarms), plus an aTint/aTinted attribute pair so individual instances can
// be pulled toward an arbitrary color (e.g. the Pebbles field, or the
// permanent comet body — see pebble-material.ts — coloring each pebble by
// which type it became). aTinted=0 reproduces the untinted look exactly; a
// caller ramps it toward 1 to fade an instance toward aTint. instanceMatrix
// is auto-declared by three.js for any InstancedMesh (prepended to the
// vertex shader prefix) but is NOT auto-applied for from-scratch custom
// shaders (that auto-multiply only happens via #include <instancing_vertex>
// in built-in ShaderLib templates) — it must be applied manually here.
export function makeToonRimInstancedTintedMaterial(palette: ToonRimPalette): ShaderMaterial {
  const outlineLow = palette.outlineLow ?? DEFAULT_OUTLINE_LOW;
  const outlineHigh = palette.outlineHigh ?? DEFAULT_OUTLINE_HIGH;

  const vertexShader = `
    attribute float aBright;
    attribute vec3  aTint;
    attribute float aTinted;
    varying   float vBright;
    varying   vec3  vTint;
    varying   float vTinted;
    varying   vec3  vViewNormal;
    varying   vec3  vViewDir;
    varying   vec3  vLocalPos;

    void main() {
      vBright = aBright;
      vTint = aTint;
      vTinted = aTinted;
      vLocalPos = position;
      vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);

      mat3 instanceNormalMatrix = mat3(instanceMatrix);
      vViewNormal = normalize(normalMatrix * instanceNormalMatrix * normal);
      vViewDir    = normalize(-mvPosition.xyz);

      gl_Position = projectionMatrix * mvPosition;
    }
  `;

  const fragmentShader = `
    varying float vBright;
    varying vec3  vTint;
    varying float vTinted;
    varying vec3  vViewNormal;
    varying vec3  vViewDir;
    varying vec3  vLocalPos;

    void main() {
      vec3  n     = normalize(vViewNormal);
      vec3  v     = normalize(vViewDir);
      float ndotv = max(0.0, dot(n, v));

      ${OUTLINE_GLSL}
      float outline = smoothstep(${outlineLow.toFixed(4)}, ${outlineHigh.toFixed(4)}, edge);

      vec3 bodyCol = mix(${vec3Glsl(palette.bodyColorDark)}, ${vec3Glsl(palette.bodyColorLight)}, vBright);
      bodyCol      = mix(bodyCol, vTint, vTinted);
      vec3 col     = mix(bodyCol, ${vec3Glsl(palette.rimColor)}, outline);
      gl_FragColor = vec4(col, 1.0);
    }
  `;

  return new ShaderMaterial({ vertexShader, fragmentShader, depthWrite: true, transparent: false });
}

// Flat, non-instanced variant — for a single real Mesh (or several sharing
// one material instance) with one solid body color and no per-vertex
// brightness (e.g. a placeholder figure's limbs). Body/rim color are
// uniforms, not baked GLSL literals like the other variants above — this
// one needs to be retintable after construction (e.g. Fate Events' people
// color depends on which constellation the player won, not known until the
// phase's first play()). Environment lighting is all-black (see index.ts's
// DomeGradient), so a lit material like MeshStandardMaterial would render
// near-invisible — this stays self-lit like every other body/rim shader.
export function makeToonRimFlatMaterial(
  bodyColor: [number, number, number],
  rimColor: [number, number, number] = [1, 1, 1],
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
    uniform vec3 uBodyColor;
    uniform vec3 uRimColor;
    varying vec3 vViewNormal;
    varying vec3 vViewDir;
    varying vec3 vLocalPos;

    void main() {
      vec3  n     = normalize(vViewNormal);
      vec3  v     = normalize(vViewDir);
      float ndotv = max(0.0, dot(n, v));

      ${OUTLINE_GLSL}
      float outline = smoothstep(${DEFAULT_OUTLINE_LOW.toFixed(4)}, ${DEFAULT_OUTLINE_HIGH.toFixed(4)}, edge);

      vec3 col = mix(uBodyColor, uRimColor, outline);
      gl_FragColor = vec4(col, 1.0);
    }
  `;

  return new ShaderMaterial({
    uniforms: {
      uBodyColor: { value: new Vector3(...bodyColor) },
      uRimColor: { value: new Vector3(...rimColor) },
    },
    vertexShader,
    fragmentShader,
    depthWrite: true,
    transparent: false,
  });
}

// Mesh+decal variant — for a single real Mesh (e.g. the comet head) that
// projects a flat 2D texture onto its front-facing cap using local Y/Z
// (perpendicular to the local +X "forward" axis), not the geometry's
// built-in equirectangular UV (which would wrap and heavily stretch a flat
// image around the whole shape).
export function makeToonRimDecalMaterial(palette: ToonRimPalette): ShaderMaterial {
  const outlineLow = palette.outlineLow ?? DEFAULT_OUTLINE_LOW;
  const outlineHigh = palette.outlineHigh ?? DEFAULT_OUTLINE_HIGH;

  const vertexShader = `
    varying vec3 vViewNormal;
    varying vec3 vViewDir;
    varying vec3 vLocalPos;
    varying vec2 vDecalUV;

    void main() {
      vLocalPos = position;
      vDecalUV = vec2(0.5 + position.z * 0.5, 0.5 - position.y * 0.5);
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      vViewNormal = normalize(normalMatrix * normal);
      vViewDir    = normalize(-mvPosition.xyz);
      gl_Position = projectionMatrix * mvPosition;
    }
  `;

  const fragmentShader = `
    uniform sampler2D uFaceTex;
    varying vec3 vViewNormal;
    varying vec3 vViewDir;
    varying vec3 vLocalPos;
    varying vec2 vDecalUV;

    void main() {
      vec3  n     = normalize(vViewNormal);
      vec3  v     = normalize(vViewDir);
      float ndotv = max(0.0, dot(n, v));

      ${OUTLINE_GLSL}
      float outline = smoothstep(${outlineLow.toFixed(4)}, ${outlineHigh.toFixed(4)}, edge);

      vec4  face   = texture2D(uFaceTex, vDecalUV);
      float luma   = dot(face.rgb, vec3(0.299, 0.587, 0.114));
      float isFace = 1.0 - smoothstep(0.12, 0.38, luma);
      vec3  bodyCol = ${vec3Glsl(palette.bodyColorDark)};
      vec3  col     = mix(bodyCol, vec3(0.90, 0.97, 1.00), isFace * 0.96);

      col = mix(col, ${vec3Glsl(palette.rimColor)}, outline);
      gl_FragColor = vec4(col, 1.0);
    }
  `;

  return new ShaderMaterial({
    uniforms: { uFaceTex: { value: null } },
    vertexShader,
    fragmentShader,
    depthWrite: true,
    transparent: false,
  });
}
