import { Blending, NormalBlending, ShaderMaterial, Texture } from '@iwsdk/core';

export interface SparkleParams {
  color: [number, number, number];
  blending?: Blending;
  depthWrite?: boolean;
  transparent?: boolean;
  pointSizeFactor?: number;
  // Opt-in "hero star" look: long thin additive cross-arms reaching toward
  // the point sprite's outer edge (an 8-point star via a second 45°-rotated
  // pair), instead of the default short glint clipped inside the core.
  // Default off — existing callers (stardust motes, seeding dust,
  // constellation stars) render unchanged.
  spiky?: boolean;
}

// A glitter/star point sprite — a soft core plus a faint 4-point cross glint,
// modulated by a per-particle twinkle phase so a field of them reads as
// scattered, non-uniformly sparkling dust rather than a flat glow (that's
// what point-sprite-material.ts's soft blob is for — haze, not stardust).
// Requires the material's uTime uniform to be updated every frame by the
// owning system.
export function makeSparkleMaterial(params: SparkleParams): ShaderMaterial {
  const pointSizeFactor = params.pointSizeFactor ?? 300.0;
  const [r, g, b] = params.color;
  const spiky = params.spiky ?? false;

  const vertexShader = `
    attribute float aSize;
    attribute float aBright;
    attribute float aPhase;
    varying   float vBright;
    varying   float vPhase;
    void main() {
      vBright = aBright;
      vPhase = aPhase;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = aSize * (${pointSizeFactor.toFixed(4)} / -mv.z);
      gl_Position  = projectionMatrix * mv;
    }
  `;

  // Long arms reach toward the sprite's edge (d up to ~0.5) rather than
  // being clipped inside the small bright core, unlike the default glint —
  // that's what makes this read as a spiky "hero" star instead of a soft
  // twinkle. exp() falloff across the short axis keeps each arm thin;
  // smoothstep along the long axis tapers it to a point before the edge.
  const SPIKY_FRAGMENT = `
    uniform float uTime;
    varying float vBright;
    varying float vPhase;
    void main() {
      vec2  uv = gl_PointCoord - 0.5;
      float d  = length(uv);
      if (d > 0.5) discard;

      float twinkle = 0.5 + 0.5 * sin(uTime * 3.0 + vPhase * 6.2831);
      float core = smoothstep(0.12, 0.0, d);

      float armX = exp(-abs(uv.y) * 60.0) * smoothstep(0.5, 0.0, abs(uv.x));
      float armY = exp(-abs(uv.x) * 60.0) * smoothstep(0.5, 0.0, abs(uv.y));
      vec2  duv  = vec2(uv.x * 0.7071 - uv.y * 0.7071, uv.x * 0.7071 + uv.y * 0.7071);
      float armD1 = exp(-abs(duv.y) * 60.0) * smoothstep(0.5, 0.0, abs(duv.x));
      float armD2 = exp(-abs(duv.x) * 60.0) * smoothstep(0.5, 0.0, abs(duv.y));
      float spikes = max(max(armX, armY), max(armD1, armD2) * 0.6);

      float alpha = clamp(core + spikes * 0.85, 0.0, 1.0) * vBright * (0.5 + 0.5 * twinkle);
      gl_FragColor = vec4(${r.toFixed(4)}, ${g.toFixed(4)}, ${b.toFixed(4)}, alpha);
    }
  `;

  const fragmentShader = spiky
    ? SPIKY_FRAGMENT
    : `
    uniform float uTime;
    varying float vBright;
    varying float vPhase;
    void main() {
      vec2  uv = gl_PointCoord - 0.5;
      float d  = length(uv);
      if (d > 0.5) discard;

      float twinkle = 0.5 + 0.5 * sin(uTime * 3.0 + vPhase * 6.2831);
      float core  = smoothstep(0.5, 0.0, d);
      float glint = clamp(max(1.0 - abs(uv.x) * 6.0, 0.0) + max(1.0 - abs(uv.y) * 6.0, 0.0), 0.0, 1.0) * core;
      float alpha = (core * 0.55 + glint * 0.75) * vBright * (0.35 + 0.65 * twinkle);

      gl_FragColor = vec4(${r.toFixed(4)}, ${g.toFixed(4)}, ${b.toFixed(4)}, alpha);
    }
  `;

  return new ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader,
    fragmentShader,
    blending: params.blending ?? NormalBlending,
    depthWrite: params.depthWrite ?? false,
    transparent: params.transparent ?? true,
  });
}

export interface SparkleVertexColorParams {
  blending?: Blending;
  depthWrite?: boolean;
  transparent?: boolean;
  pointSizeFactor?: number;
}

// Same glitter/star point sprite as makeSparkleMaterial, but color comes
// from a per-vertex aColor attribute instead of one color baked into the
// shader — for a single Points pool whose individual particles need
// different colors (e.g. Seeding's in-flight dust motes, each carrying
// whichever pebble color it'll stain its planet with on landing). Callers
// must set an 'aColor' BufferAttribute (vec3) on the geometry.
export function makeSparkleMaterialVertexColor(params: SparkleVertexColorParams): ShaderMaterial {
  const pointSizeFactor = params.pointSizeFactor ?? 300.0;

  const vertexShader = `
    attribute float aSize;
    attribute float aBright;
    attribute float aPhase;
    attribute vec3  aColor;
    varying   float vBright;
    varying   float vPhase;
    varying   vec3  vColor;
    void main() {
      vBright = aBright;
      vPhase = aPhase;
      vColor = aColor;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = aSize * (${pointSizeFactor.toFixed(4)} / -mv.z);
      gl_Position  = projectionMatrix * mv;
    }
  `;

  const fragmentShader = `
    uniform float uTime;
    varying float vBright;
    varying float vPhase;
    varying vec3  vColor;
    void main() {
      vec2  uv = gl_PointCoord - 0.5;
      float d  = length(uv);
      if (d > 0.5) discard;

      float twinkle = 0.5 + 0.5 * sin(uTime * 3.0 + vPhase * 6.2831);
      float core  = smoothstep(0.5, 0.0, d);
      float glint = clamp(max(1.0 - abs(uv.x) * 6.0, 0.0) + max(1.0 - abs(uv.y) * 6.0, 0.0), 0.0, 1.0) * core;
      float alpha = (core * 0.55 + glint * 0.75) * vBright * (0.35 + 0.65 * twinkle);

      gl_FragColor = vec4(vColor, alpha);
    }
  `;

  return new ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader,
    fragmentShader,
    blending: params.blending ?? NormalBlending,
    depthWrite: params.depthWrite ?? false,
    transparent: params.transparent ?? true,
  });
}

export interface SparkleTexturedParams {
  texture: Texture;
  blending?: Blending;
  depthWrite?: boolean;
  transparent?: boolean;
}

// A real illustrated texture (an actual star image, not the procedural
// core+glint shape the other two variants above draw) with the same
// "generative sparkle" twinkle modulation layered on top via alpha —
// requires the material's uTime uniform to be updated every frame (same
// contract as the other sparkle materials) and a per-geometry `aPhase`
// attribute so instances sharing this one material don't all pulse in
// lockstep. Meant for individual billboarded Mesh+PlaneGeometry instances
// (see ArtTestVfxSystem), not a Points cloud — gl_PointCoord-based sprites
// can't host an arbitrary UV-mapped illustration cleanly, and a real Mesh
// also lets a caller actually orient/billboard it explicitly frame to
// frame instead of relying on point-sprite screen-facing.
export function makeSparkleTexturedMaterial(params: SparkleTexturedParams): ShaderMaterial {
  const vertexShader = `
    attribute float aPhase;
    varying vec2 vUv;
    varying float vPhase;
    void main() {
      vUv = uv;
      vPhase = aPhase;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;

  const fragmentShader = `
    uniform sampler2D uMap;
    uniform float uTime;
    varying vec2 vUv;
    varying float vPhase;
    void main() {
      vec4 tex = texture2D(uMap, vUv);
      float twinkle = 0.55 + 0.45 * sin(uTime * 3.0 + vPhase * 6.2831);
      gl_FragColor = vec4(tex.rgb, tex.a * twinkle);
    }
  `;

  return new ShaderMaterial({
    uniforms: { uMap: { value: params.texture }, uTime: { value: 0 } },
    vertexShader,
    fragmentShader,
    blending: params.blending ?? NormalBlending,
    depthWrite: params.depthWrite ?? false,
    transparent: params.transparent ?? true,
  });
}
