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

// Art-test-only variant of makeToonRimInstancedTintedMaterial above (same
// vertex shader/attributes, kept as its own function rather than a flag on
// that one so the real pebble field's production look is never at risk) —
// "more organic, minimal, dark, grainy/sparkly" per the user's own framing.
// A much darker, barely-tinted body (the RGB hue only hints through at low
// strength, not the production version's full saturated wash) replaces the
// bold rim outline with scattered bright flecks instead — a cheap
// hash-noise field thresholded down to a sparse set of "grains," each
// glinting in the instance's own tint color and gently twinkling via
// uTime, reading like flecks of mineral embedded in dark rock rather than
// a smooth toon-shaded surface.
export function makeToonRimInstancedGrainyMaterial(palette: ToonRimPalette): ShaderMaterial {
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
    uniform float uTime;
    varying float vBright;
    varying vec3  vTint;
    varying float vTinted;
    varying vec3  vViewNormal;
    varying vec3  vViewDir;
    varying vec3  vLocalPos;

    // Cheap 3D hash — same local-space-position idiom OUTLINE_GLSL's own
    // wobble uses, so the grain pattern stays fixed to each pebble's own
    // surface (not swimming as it moves/rotates) and reads differently per
    // instance purely from each one's own random rotation, no extra
    // per-instance seed attribute needed.
    float hash13(vec3 p) {
      p = fract(p * 0.3183099 + 0.1);
      p *= 17.0;
      return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
    }

    void main() {
      vec3  n     = normalize(vViewNormal);
      vec3  v     = normalize(vViewDir);
      float ndotv = max(0.0, dot(n, v));

      ${OUTLINE_GLSL}
      float outline = smoothstep(${outlineLow.toFixed(4)}, ${outlineHigh.toFixed(4)}, edge);

      vec3 darkBase = mix(${vec3Glsl(palette.bodyColorDark)}, ${vec3Glsl(palette.bodyColorLight)}, vBright);
      vec3 bodyCol  = mix(darkBase, vTint, vTinted * 0.35);

      float grain   = hash13(floor(vLocalPos * 140.0));
      float sparkle = step(0.986, grain) * (0.5 + 0.5 * sin(uTime * 4.0 + grain * 40.0));
      bodyCol += vTint * sparkle * 1.4;

      vec3 col = mix(bodyCol, ${vec3Glsl(palette.rimColor)}, outline * 0.5);
      gl_FragColor = vec4(col, 1.0);
    }
  `;

  return new ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader,
    fragmentShader,
    depthWrite: true,
    transparent: false,
  });
}

// Same instanced black-rim look as makeToonRimInstancedTintedMaterial
// (identical fragment shader), but with a per-vertex wiggle displacement
// added in the vertex stage before the instance transform — art-test-only,
// for "make the 8 islands wiggly." Displaces each vertex radially in/out
// from the geometry's own local origin (relies on .center()-ed geometry,
// same guarantee obj-island-extractor.ts's own extractMeshIslands already
// provides) by a sine wave driven off the vertex's own UNIT direction
// (normalize(position), not raw position) so the wiggle's frequency/pattern
// looks consistent regardless of a given island's raw local coordinate
// scale — the 8 extracted OBJ islands are each their own arbitrary raw
// size before their instance transform normalizes them down to a shared
// target radius (see loadObjLargestIslands), and a frequency tied to raw
// position instead would turn into meaningless high-frequency noise on a
// large-scale island. A per-instance aWigglePhase attribute desyncs the
// wiggle across instances so a whole field of these doesn't pulse in
// lockstep. Normals are NOT recomputed for the displaced surface (same
// simplification ghost-wiggle-material.ts's billboard wiggle already makes)
// — visually fine for a cheap dev-only art-test displacement, and avoids
// the cost of a real analytic/central-difference normal recalculation.
export function makeToonRimInstancedWigglyMaterial(
  palette: ToonRimPalette,
  params: { amplitude?: number; speed?: number } = {},
): ShaderMaterial {
  const outlineLow = palette.outlineLow ?? DEFAULT_OUTLINE_LOW;
  const outlineHigh = palette.outlineHigh ?? DEFAULT_OUTLINE_HIGH;
  const amplitude = params.amplitude ?? 0.15;
  const speed = params.speed ?? 1.4;

  const vertexShader = `
    uniform float uTime;
    attribute float aBright;
    attribute vec3  aTint;
    attribute float aTinted;
    attribute float aWigglePhase;
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

      vec3 dir = length(position) > 0.0001 ? normalize(position) : vec3(0.0, 1.0, 0.0);
      float wiggle = sin(dir.x * 6.0 + dir.y * 4.5 - dir.z * 5.0 + uTime * ${speed.toFixed(4)} + aWigglePhase * 6.2831) * 0.5
                   + sin(dir.y * 7.0 - dir.x * 3.0 + uTime * ${(speed * 0.8).toFixed(4)} + aWigglePhase * 3.1) * 0.3;
      vec3 wiggled = position * (1.0 + wiggle * ${amplitude.toFixed(4)});

      vLocalPos = wiggled;
      vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(wiggled, 1.0);

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

  return new ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader,
    fragmentShader,
    depthWrite: true,
    transparent: false,
  });
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
// image around the whole shape). Body color is a uniform (uBodyColor,
// seeded from palette.bodyColorDark) rather than a baked GLSL literal like
// this file's other variants — the comet head needs to be retinted after
// construction, to the player's majority pebble color once Seeding begins
// (see PebbleCometPresentationSystem's gamePhase subscribe).
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
    uniform vec3 uBodyColor;
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
      vec3  col     = mix(uBodyColor, vec3(0.90, 0.97, 1.00), isFace * 0.96);

      col = mix(col, ${vec3Glsl(palette.rimColor)}, outline);
      gl_FragColor = vec4(col, 1.0);
    }
  `;

  return new ShaderMaterial({
    uniforms: {
      uFaceTex: { value: null },
      uBodyColor: { value: new Vector3(...palette.bodyColorDark) },
    },
    vertexShader,
    fragmentShader,
    depthWrite: true,
    transparent: false,
  });
}

// Same front-face decal projection as makeToonRimDecalMaterial above, but
// blends via the decal texture's own alpha channel instead of approximating
// a cutout from luma — for a real transparent-PNG decal (e.g.
// ArtTestVfxSystem's fabric-ghost-textured pebbles, "plastered on... the
// same way we did for the comet") rather than the light-background line-art
// textures makeToonRimDecalMaterial was built for (the comet head's own
// beepchat/smile faces). Kept as its own function rather than adding an
// alpha-mode flag to that one, so the comet head's real production
// rendering is never at risk of a regression from a change made for this
// art-test use case.
export function makeToonRimAlphaDecalMaterial(palette: ToonRimPalette): ShaderMaterial {
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
    uniform sampler2D uDecalTex;
    uniform vec3 uBodyColor;
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

      vec4  decal = texture2D(uDecalTex, vDecalUV);
      vec3  col   = mix(uBodyColor, decal.rgb, decal.a);

      col = mix(col, ${vec3Glsl(palette.rimColor)}, outline);
      gl_FragColor = vec4(col, 1.0);
    }
  `;

  return new ShaderMaterial({
    uniforms: {
      uDecalTex: { value: null },
      uBodyColor: { value: new Vector3(...palette.bodyColorDark) },
    },
    vertexShader,
    fragmentShader,
    depthWrite: true,
    transparent: false,
  });
}
