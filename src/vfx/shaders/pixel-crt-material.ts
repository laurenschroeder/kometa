import { AdditiveBlending, Blending, ShaderMaterial } from '@iwsdk/core';

export interface PixelCrtParams {
  color: [number, number, number];
  blending?: Blending;
  pointSizeFactor?: number;
}

// A blocky, glowing square "pixel" sprite with a coherent screen-space CRT
// scanline darkening every few pixels, after a reference mood board of
// pixel-art/voxel portraits and glowing CRT-style scenes — a crisp square
// core (Chebyshev distance, max(|x|,|y|), not length(), so the shape reads
// as a square rather than a circle) plus a soft square glow halo, instead
// of makeSparkleMaterial's circular core+cross-glint look. The scanlines
// are computed from gl_FragCoord.y (real screen pixels), so they read as
// one continuous CRT raster across the whole view rather than a pattern
// repeating inside each individual point sprite. Requires uTime updated
// every frame for the twinkle, same contract as every other
// _timeUniformMats material in ArtTestVfxSystem.
export function makePixelCrtMaterial(params: PixelCrtParams): ShaderMaterial {
  const pointSizeFactor = params.pointSizeFactor ?? 260.0;
  const [r, g, b] = params.color;

  const vertexShader = `
    attribute float aSize;
    attribute float aBright;
    attribute float aPhase;
    varying float vBright;
    varying float vPhase;
    void main() {
      vBright = aBright;
      vPhase = aPhase;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = aSize * (${pointSizeFactor.toFixed(4)} / -mv.z);
      gl_Position  = projectionMatrix * mv;
    }
  `;

  // uOpacity (default 1, see uniforms below) — a whole-material fade
  // multiplier for callers that need to fade a cloud in/out (e.g. Stardust's
  // swirl finale, see pixel-swirl.ts) without rebuilding the shader; art-test
  // itself never touches this uniform, so its own look is unaffected.
  const fragmentShader = `
    uniform float uTime;
    uniform float uOpacity;
    varying float vBright;
    varying float vPhase;
    void main() {
      vec2 uv = gl_PointCoord - 0.5;
      float d = max(abs(uv.x), abs(uv.y));
      float core = 1.0 - smoothstep(0.26, 0.34, d);
      float halo = (1.0 - smoothstep(0.34, 0.5, d)) * 0.35;

      float scan = 0.6 + 0.4 * step(1.5, mod(gl_FragCoord.y, 3.0));
      float twinkle = 0.6 + 0.4 * sin(uTime * 2.2 + vPhase * 6.2831);

      float alpha = clamp(core + halo, 0.0, 1.0) * vBright * scan * twinkle * uOpacity;
      if (alpha < 0.01) discard;
      gl_FragColor = vec4(${r.toFixed(4)}, ${g.toFixed(4)}, ${b.toFixed(4)}, alpha);
    }
  `;

  return new ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uOpacity: { value: 1 } },
    vertexShader,
    fragmentShader,
    blending: params.blending ?? AdditiveBlending,
    depthWrite: false,
    transparent: true,
  });
}

export interface PixelCrtVertexColorParams {
  blending?: Blending;
  pointSizeFactor?: number;
}

// Same blocky glowing square pixel sprite as makePixelCrtMaterial, but
// color comes from a per-vertex aColor attribute instead of one color baked
// into the shader — for pixel-CRT points that should show "colors matched
// from the original image" (e.g. a higher-resolution ghost shape sampled
// straight from its own source PNG via sampleOpaquePixelPositions) rather
// than one flat recolor shared by every point.
export function makePixelCrtVertexColorMaterial(params: PixelCrtVertexColorParams = {}): ShaderMaterial {
  const pointSizeFactor = params.pointSizeFactor ?? 260.0;

  const vertexShader = `
    attribute float aSize;
    attribute float aBright;
    attribute float aPhase;
    attribute vec3  aColor;
    varying float vBright;
    varying float vPhase;
    varying vec3  vColor;
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
    uniform float uOpacity;
    varying float vBright;
    varying float vPhase;
    varying vec3  vColor;
    void main() {
      vec2 uv = gl_PointCoord - 0.5;
      float d = max(abs(uv.x), abs(uv.y));
      float core = 1.0 - smoothstep(0.26, 0.34, d);
      float halo = (1.0 - smoothstep(0.34, 0.5, d)) * 0.35;

      float scan = 0.6 + 0.4 * step(1.5, mod(gl_FragCoord.y, 3.0));
      float twinkle = 0.6 + 0.4 * sin(uTime * 2.2 + vPhase * 6.2831);

      float alpha = clamp(core + halo, 0.0, 1.0) * vBright * scan * twinkle * uOpacity;
      if (alpha < 0.01) discard;
      gl_FragColor = vec4(vColor, alpha);
    }
  `;

  return new ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uOpacity: { value: 1 } },
    vertexShader,
    fragmentShader,
    blending: params.blending ?? AdditiveBlending,
    depthWrite: false,
    transparent: true,
  });
}
