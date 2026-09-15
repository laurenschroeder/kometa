import { Blending, NormalBlending, ShaderMaterial, Vector3 } from '@iwsdk/core';

export interface PointSpriteParams {
  color: [number, number, number];
  blending?: Blending;
  depthWrite?: boolean;
  transparent?: boolean;
  pointSizeFactor?: number;
}

// Generalized from the original comet-system.ts SHARED_VERT + HAZE_FRAG: a
// camera-facing circular point sprite with per-particle size/brightness
// attributes, soft-edged via a radial discard+smoothstep. Used for the haze
// glow layer today; any chapter needing soft point-based particles (stardust
// motes, event flashes) reuses this instead of re-deriving gl_PointSize math.
export function makePointSpriteMaterial(params: PointSpriteParams): ShaderMaterial {
  const pointSizeFactor = params.pointSizeFactor ?? 300.0;
  const [r, g, b] = params.color;

  const vertexShader = `
    attribute float aSize;
    attribute float aBright;
    varying   float vBright;
    void main() {
      vBright = aBright;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = aSize * (${pointSizeFactor.toFixed(4)} / -mv.z);
      gl_Position  = projectionMatrix * mv;
    }
  `;

  // Color lives in a uniform (not baked into the shader source, unlike this
  // factory's other params) so a caller can retint an already-built material
  // live — see pebble-comet-presentation-system.ts's dominantPebbleType-
  // driven haze retint, the one caller that actually needs this.
  const fragmentShader = `
    uniform vec3 uColor;
    uniform float uOpacity;
    varying float vBright;
    void main() {
      vec2  uv = gl_PointCoord - 0.5;
      float dist = length(uv);
      if (dist > 0.5) discard;
      float a = smoothstep(0.5, 0.0, dist) * vBright * uOpacity;
      gl_FragColor = vec4(uColor, a);
    }
  `;

  return new ShaderMaterial({
    // uOpacity defaults to 1 (a no-op) — existing callers are unaffected;
    // orbital-launch-vfx-system.ts's nebula marker is the one caller that
    // drives it down to fade the whole cloud out.
    uniforms: { uColor: { value: new Vector3(r, g, b) }, uOpacity: { value: 1 } },
    vertexShader,
    fragmentShader,
    blending: params.blending ?? NormalBlending,
    depthWrite: params.depthWrite ?? false,
    transparent: params.transparent ?? true,
  });
}
