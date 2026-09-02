import { Blending, NormalBlending, ShaderMaterial } from '@iwsdk/core';

export interface SparkleParams {
  color: [number, number, number];
  blending?: Blending;
  depthWrite?: boolean;
  transparent?: boolean;
  pointSizeFactor?: number;
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

  const fragmentShader = `
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
