import { ShaderChunk, ShaderMaterial, Vector3 } from '@iwsdk/core';

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
  // makeToonRimInstancedGrainyMaterial's sparkle flecks only — a fixed
  // color instead of the per-instance vTint (each pebble's own body tint).
  // Omit to keep the default (flecks glint in the pebble's own tint color).
  sparkleColor?: [number, number, number];
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

// Ink-stipple dot density, tuned to read as pen-and-ink pointillism
// (reference: dense/near-solid stippling in shadow, sparse flecks in light,
// the surface's OWN base tone never darkened directly — only ever covered
// by dots). MIN/MAX bound the dot coverage fraction so neither extreme goes
// perfectly flat: even the brightest fragment keeps a few flecks and even
// the darkest leaves a little of the base peeking through, matching the
// reference's texture at both ends rather than solid flat regions.
const INK_MIN_COVERAGE = 0.06;
const INK_MAX_COVERAGE = 0.94;
// Bumped 130 -> 480 for a much finer, dust-like grain (was reading as
// distinct blobs at plant scale rather than fine speckle).
const INK_DOT_FREQUENCY = 480.0;

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

// Same instanced/tinted setup as makeToonRimInstancedTintedMaterial above,
// but reworked from a smooth dark->light body ramp into fine colored-dust
// stippling: the base is solid black, and grain flecked on top carries the
// instance's own full tint — its DENSITY (not a flat lightening) carrying
// the shading — dense/near-solid near the silhouette edge, sparse where the
// surface faces the camera head-on, so it reads as dusty colored grain over
// a dark body rather than a smooth toon ramp. (Originally the inverse — a
// colored base flecked with black ink, per an early pen-and-ink reference —
// flipped per later feedback to read as colored dust instead.) Same cheap
// hash+floor+threshold idiom makeToonRimInstancedGrainyMaterial's own
// sparkle flecks use (see its comment) rather than a real distance-field
// halftone dot — good enough at this small a scale, and free of the
// regular/grid-like look an ordered (Bayer) dither would give. The outline
// itself stays a smooth smoothstep (undithered) — only the body shading
// stipples.
//
// `antialias` (opt-in, default off so existing callers like the planet
// sprouts render unchanged): once a dot cell shrinks below about a pixel —
// small pebbles at arm's length in the headset — the per-cell hash turns
// into shimmering noise that crawls as the head moves. With antialias on,
// the stipple fades (via fwidth) into its own average, a smooth tint *
// coverage shade, so distant pebbles keep the same darker-center /
// brighter-edge read without the shimmer, and still stipple up close.
export function makeToonRimInstancedDitherMaterial(
  palette: ToonRimPalette,
  params: { antialias?: boolean; dotFrequency?: number } = {},
): ShaderMaterial {
  const outlineLow = palette.outlineLow ?? DEFAULT_OUTLINE_LOW;
  const outlineHigh = palette.outlineHigh ?? DEFAULT_OUTLINE_HIGH;
  const antialias = params.antialias ?? false;
  // Dot cells per local unit — coarser dots stay readable as speckle on
  // small objects (see kOrganicRockMat) where the default is sub-pixel.
  const dotFrequency = params.dotFrequency ?? INK_DOT_FREQUENCY;

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

    // Same cheap 3D hash makeToonRimInstancedGrainyMaterial's own sparkle
    // flecks use — see that function's own comment on why this (rather than
    // a real noise texture) is enough at this scale.
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

      // Base stays the instance's own full-strength tint — no separate
      // darkened tone; light areas are just "current color" (see this
      // function's own top comment).
      vec3 bodyCol = mix(${vec3Glsl(palette.bodyColorDark)}, ${vec3Glsl(palette.bodyColorLight)}, vBright);
      bodyCol      = mix(bodyCol, vTint, vTinted);

      // Ink dot coverage rises toward the silhouette edge (1.0 - ndotv) —
      // the same shading term OUTLINE_GLSL's own edge already leans on —
      // sampled per-cell off object-space position so the pattern stays
      // glued to the surface (not swimming in screen space) and stereo-safe.
      float grain    = hash13(floor(vLocalPos * ${dotFrequency.toFixed(1)}));
      float shade    = 1.0 - ndotv;
      float coverage = mix(${INK_MIN_COVERAGE.toFixed(4)}, ${INK_MAX_COVERAGE.toFixed(4)}, shade);
      float ink      = step(1.0 - coverage, grain);
      ${
        antialias
          ? `// cells per pixel — 1.0 means one dot cell spans one pixel
      vec3  cellFw   = fwidth(vLocalPos * ${dotFrequency.toFixed(1)});
      float cellPx   = max(cellFw.x, max(cellFw.y, cellFw.z));
      ink            = mix(ink, coverage, smoothstep(0.35, 0.9, cellPx));`
          : ''
      }

      // Flipped from the original black-grain-on-color read: base is now
      // black and the grain itself carries the color, so this reads as
      // colored dust flecked over a dark body rather than dark ink flecked
      // over a colored body.
      vec3 col = mix(vec3(0.0), bodyCol, ink);
      col      = mix(col, ${vec3Glsl(palette.rimColor)}, outline);
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
// glinting in the instance's own tint color (or palette.sparkleColor, if
// given — a fixed color for every instance instead) and gently twinkling
// via uTime, reading like flecks of mineral embedded in dark rock rather than
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
      bodyCol += ${palette.sparkleColor ? vec3Glsl(palette.sparkleColor) : 'vTint'} * sparkle * 1.4;

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
// simplification the old billboard wiggle also made)
// — visually fine for a cheap dev-only art-test displacement, and avoids
// the cost of a real analytic/central-difference normal recalculation.
export function makeToonRimInstancedWigglyMaterial(
  palette: ToonRimPalette,
  params: { amplitude?: number; speed?: number; opacity?: number } = {},
): ShaderMaterial {
  const outlineLow = palette.outlineLow ?? DEFAULT_OUTLINE_LOW;
  const outlineHigh = palette.outlineHigh ?? DEFAULT_OUTLINE_HIGH;
  const amplitude = params.amplitude ?? 0.15;
  const speed = params.speed ?? 1.4;
  // Fully opaque by default (existing behavior, unchanged) — < 1 renders
  // translucent (e.g. a "soul" body you can faintly see through).
  const opacity = params.opacity ?? 1;

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

    // Same cheap 3D hash makeToonRimInstancedGrainyMaterial's own sparkle
    // flecks use — here it's not thresholded down to sparse flecks, it's
    // blended across the WHOLE body as a multiplicative brightness
    // modulation, so the non-rim surface itself reads as mottled/textured
    // rather than a single flat dark->light gradient. Two frequencies
    // layered together (coarse + fine) so it doesn't look like a uniform
    // regular grid at any one viewing distance.
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

      vec3 bodyCol = mix(${vec3Glsl(palette.bodyColorDark)}, ${vec3Glsl(palette.bodyColorLight)}, vBright);
      bodyCol      = mix(bodyCol, vTint, vTinted);

      float coarse  = hash13(floor(vLocalPos * 45.0));
      float fine    = hash13(floor(vLocalPos * 120.0 + 7.0));
      float texture = coarse * 0.6 + fine * 0.4;
      bodyCol *= 0.55 + texture * 0.9;

      vec3 col     = mix(bodyCol, ${vec3Glsl(palette.rimColor)}, outline);
      gl_FragColor = vec4(col, ${opacity.toFixed(4)});
    }
  `;

  return new ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader,
    fragmentShader,
    depthWrite: opacity >= 1,
    transparent: opacity < 1,
  });
}

// Same instanced/wiggly look as makeToonRimInstancedWigglyMaterial above, but
// with rim color as a live uRimColor uniform (initialized from palette.
// rimColor) instead of a value baked into the fragment shader's own GLSL
// text — for a caller that needs to animate ONE instance's rim at runtime
// (e.g. Fate Events' Beat 4 collectibles blinking gold while uncaptured; see
// fate-event-vfx-system.ts). Deliberately a separate function rather than
// adding a "live rim" flag to the original: that one backs kSoulIslandMat, a
// shared module-scope singleton reused by real soul-dust pebbles all over
// the game (see pebble-material.ts) — mutating a shared material's rim
// uniform at runtime would blink every pebble that shares it, not just the
// caller's own instance. Callers needing a live rim must construct their own
// instance of THIS function per object instead of sharing one.
export function makeToonRimInstancedWigglyLiveRimMaterial(
  palette: ToonRimPalette,
  params: { amplitude?: number; speed?: number; opacity?: number } = {},
): ShaderMaterial {
  const outlineLow = palette.outlineLow ?? DEFAULT_OUTLINE_LOW;
  const outlineHigh = palette.outlineHigh ?? DEFAULT_OUTLINE_HIGH;
  const amplitude = params.amplitude ?? 0.15;
  const speed = params.speed ?? 1.4;
  const opacity = params.opacity ?? 1;

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
    uniform vec3 uRimColor;
    varying float vBright;
    varying vec3  vTint;
    varying float vTinted;
    varying vec3  vViewNormal;
    varying vec3  vViewDir;
    varying vec3  vLocalPos;

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

      vec3 bodyCol = mix(${vec3Glsl(palette.bodyColorDark)}, ${vec3Glsl(palette.bodyColorLight)}, vBright);
      bodyCol      = mix(bodyCol, vTint, vTinted);

      float coarse  = hash13(floor(vLocalPos * 45.0));
      float fine    = hash13(floor(vLocalPos * 120.0 + 7.0));
      float texture = coarse * 0.6 + fine * 0.4;
      bodyCol *= 0.55 + texture * 0.9;

      vec3 col     = mix(bodyCol, uRimColor, outline);
      gl_FragColor = vec4(col, ${opacity.toFixed(4)});
    }
  `;

  return new ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uRimColor: { value: new Vector3(...palette.rimColor) } },
    vertexShader,
    fragmentShader,
    depthWrite: opacity >= 1,
    transparent: opacity < 1,
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

// Same flat black-body/white-rim look as makeToonRimFlatMaterial, but for a
// real SkinnedMesh (the shared BreathingIdle rig every "human" figure in
// Fate Events now uses — see animated-person.ts) — a plain ShaderMaterial's
// custom vertexShader completely replaces three's own built-in one, so
// nothing about skinning happens automatically just from `skinning: true`;
// the actual bone-transform GLSL has to be spliced in by hand. Rather than
// re-deriving that math, this pulls the exact same chunks three's own
// built-in materials use (ShaderChunk.skinning_pars_vertex/skinbase_vertex/
// skinning_vertex/skinnormal_vertex) — the standard boneTexture-based
// technique, correct for whatever three.js version this project has
// installed rather than a hand-copied (and potentially stale) GLSL literal.
// `transformed`/`objectNormal` are three's own conventional local names for
// "position/normal after skinning" — kept identical here so these chunks
// (written expecting exactly those names) drop in unmodified.
export function makeToonRimSkinnedMaterial(
  bodyColor: [number, number, number],
  rimColor: [number, number, number] = [1, 1, 1],
): ShaderMaterial {
  const vertexShader = `
    ${ShaderChunk.skinning_pars_vertex}

    // NO skinIndex/skinWeight declarations here on purpose — three.js
    // injects both itself into every non-Raw ShaderMaterial's vertex prefix
    // under '#ifdef USE_SKINNING' (see WebGLProgram.js), which it defines
    // automatically for any SkinnedMesh. Re-declaring them here is a
    // duplicate-declaration GLSL compile error, which silently renders
    // nothing at all — the cause of an earlier "figures exist but are
    // completely invisible" bug.

    varying vec3 vViewNormal;
    varying vec3 vViewDir;
    varying vec3 vLocalPos;

    void main() {
      vec3 transformed = position;
      vec3 objectNormal = normal;

      ${ShaderChunk.skinbase_vertex}
      ${ShaderChunk.skinning_vertex}
      ${ShaderChunk.skinnormal_vertex}

      vLocalPos = transformed;
      vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
      vViewNormal = normalize(normalMatrix * objectNormal);
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

  // No material.skinning flag to set — three.js (checked directly in this
  // project's installed r181) derives USE_SKINNING purely from the rendered
  // object being an actual SkinnedMesh (WebGLPrograms.js: `skinning:
  // object.isSkinnedMesh === true`), not from any material-side property.
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
// Cutout is driven by the decal texture's own alpha channel (soft-edged via
// smoothstep for antialiasing), and the decal's own shaded RGB is shown
// directly (not flattened to a fixed highlight color) — matches the current
// faceSoul/faceOrganic/faceGas decals, which are real shaded art on a
// transparent background. This replaced an earlier luma-based cutout built
// for the old beepchat/smile decals (dark line-art on an opaque light
// background, displayed as a flat near-white highlight color rather than
// the line art's own color); that approach read the new white-on-
// transparent decals as invisible, since white content has high luma just
// like the old textures' background did.
// How much of the head's local Y/Z extent the decal's own [0,1] UV square
// covers — bigger number = smaller decal, since a bigger multiplier reaches
// UV 1.0 at a smaller position offset. 3.0 keeps the decal roughly within a
// quarter of the front hemisphere's diameter — "like one face of a cube" on
// a rounded head, rather than the old 1.0 (no scale), which stretched the
// image across the whole visible front of the head.
const FACE_DECAL_SCALE = 3.0;

// `sizeMultiplier` scales the decal's own on-surface footprint — since a
// BIGGER FACE_DECAL_SCALE means a SMALLER decal (see that constant's own
// comment), a caller asking for a 2x bigger face passes sizeMultiplier=2 and
// this divides it in, rather than callers having to know/invert that
// relationship themselves.
// Optional "carved stone" treatment for the decal (see makeHeadMat for the
// tuned values the comet head uses). All noise is sampled in the head's
// local space, so it's glued to the surface rather than swimming. Omit it
// entirely for the original flat `mix(body, face, isFace * 0.96)` look.
export interface RockyFaceParams {
  faceGrain: number; // 0..1 granite mottling/speckle inside the face lines
  faceTint: number; // 0..1 pull the face's white toward warm stone
  faceEdgeFade: number; // 0..1 fade the face where the surface turns away
  bodyGrain: number; // 0..1+ rock patches/mottling/flecks on the dark body
}

// Warm pale stone the face is pulled toward by RockyFaceParams.faceTint.
const FACE_STONE: [number, number, number] = [0.86, 0.82, 0.74];

function rockyFaceGlsl(rocky: RockyFaceParams): { pars: string; blend: string } {
  const f = (n: number) => n.toFixed(4);
  return {
    pars: `
    float rh3(vec3 p) {
      p = fract(p * 0.3183099 + 0.1);
      p *= 17.0;
      return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
    }
    // Smooth value noise — unlike the per-cell hash used elsewhere in this
    // file, this reads as natural stone mottling rather than dots.
    float rnoise(vec3 p) {
      vec3 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(mix(rh3(i), rh3(i + vec3(1, 0, 0)), f.x), mix(rh3(i + vec3(0, 1, 0)), rh3(i + vec3(1, 1, 0)), f.x), f.y),
        mix(mix(rh3(i + vec3(0, 0, 1)), rh3(i + vec3(1, 0, 1)), f.x), mix(rh3(i + vec3(0, 1, 1)), rh3(i + vec3(1, 1, 1)), f.x), f.y),
        f.z);
    }
    float rfbm(vec3 p) {
      float v = 0.0, a = 0.5;
      for (int i = 0; i < 4; i++) { v += a * rnoise(p); p = p * 2.07 + 11.3; a *= 0.5; }
      return v;
    }
    // Fades a fine noise term to its 0.5 mean once its features shrink
    // below about a pixel, so it can't shimmer on a small head in VR.
    float rfine(float n, float freq, float fw) {
      return mix(n, 0.5, smoothstep(0.35, 1.0, fw * freq));
    }`,
    blend: `
      float fw      = length(fwidth(vLocalPos));
      float rock    = rfbm(vLocalPos * 7.0);
      float pits    = rfine(rnoise(vLocalPos * 70.0), 70.0, fw);
      float speck   = rfine(rnoise(vLocalPos * 140.0), 140.0, fw);
      float facing  = smoothstep(0.1, 0.9, ndotv);
      float fade    = isFace * 0.96 * mix(1.0, facing, ${f(rocky.faceEdgeFade)});
      // tonal stone variation only — kept well above black so it never
      // reads as missing pixels
      vec3  stone   = face.rgb * mix(1.0, 0.5 + 0.3 * rock + 0.2 * pits + 0.2 * speck, ${f(rocky.faceGrain)});
      stone         = mix(stone, stone * ${vec3Glsl(FACE_STONE)}, ${f(rocky.faceTint)});
      // The body is near-black, so multiplying alone barely shows — lift
      // broad lighter rock patches, finer mottling and sparse pale mineral
      // flecks additively on top (still dark, so the face keeps its pop).
      float patches = smoothstep(0.38, 0.78, rfbm(vLocalPos * 3.5 + 20.0));
      vec3  body    = uBodyColor * mix(1.0, (0.45 + 1.1 * rock) * (0.8 + 0.4 * pits), ${f(rocky.bodyGrain)})
                    + ${f(rocky.bodyGrain)} * (vec3(0.075, 0.08, 0.095) * patches
                                              + vec3(0.035, 0.037, 0.045) * rock * pits
                                              + vec3(0.12, 0.12, 0.13) * pow(speck, 9.0));
      vec3  col     = mix(body, stone, fade);`,
  };
}

export function makeToonRimDecalMaterial(
  palette: ToonRimPalette,
  sizeMultiplier = 1,
  rocky?: RockyFaceParams,
): ShaderMaterial {
  const outlineLow = palette.outlineLow ?? DEFAULT_OUTLINE_LOW;
  const outlineHigh = palette.outlineHigh ?? DEFAULT_OUTLINE_HIGH;
  const decalScale = FACE_DECAL_SCALE / sizeMultiplier;
  const rockyGlsl = rocky ? rockyFaceGlsl(rocky) : null;

  const vertexShader = `
    varying vec3 vViewNormal;
    varying vec3 vViewDir;
    varying vec3 vLocalPos;
    varying vec2 vDecalUV;

    void main() {
      vLocalPos = position;
      vDecalUV = vec2(
        0.5 + position.z * 0.5 * ${decalScale.toFixed(4)},
        0.5 - position.y * 0.5 * ${decalScale.toFixed(4)}
      );
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
    ${rockyGlsl?.pars ?? ''}

    void main() {
      vec3  n     = normalize(vViewNormal);
      vec3  v     = normalize(vViewDir);
      float ndotv = max(0.0, dot(n, v));

      ${OUTLINE_GLSL}
      float outline = smoothstep(${outlineLow.toFixed(4)}, ${outlineHigh.toFixed(4)}, edge);

      // Outside the shrunk decal square (see FACE_DECAL_SCALE), vDecalUV
      // falls outside [0,1] — clamp before sampling (always sample, no
      // branching around texture2D, so derivatives stay well-defined) and
      // zero the contribution via inBounds instead.
      vec2  clampedUV = clamp(vDecalUV, 0.0, 1.0);
      vec4  face      = texture2D(uFaceTex, clampedUV);
      float inBounds  = step(0.0, vDecalUV.x) * step(vDecalUV.x, 1.0)
                       * step(0.0, vDecalUV.y) * step(vDecalUV.y, 1.0);
      float isFace = smoothstep(0.3, 0.7, face.a) * inBounds;
      ${rockyGlsl?.blend ?? 'vec3  col     = mix(uBodyColor, face.rgb, isFace * 0.96);'}

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
