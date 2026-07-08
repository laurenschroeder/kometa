import { Blending, NormalBlending, ShaderMaterial } from '@iwsdk/core';

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

  const fragmentShader = `
    varying float vBright;
    void main() {
      vec2  uv = gl_PointCoord - 0.5;
      float r  = length(uv);
      if (r > 0.5) discard;
      float a  = smoothstep(0.5, 0.0, r) * vBright;
      gl_FragColor = vec4(${r.toFixed(4)}, ${g.toFixed(4)}, ${b.toFixed(4)}, a);
    }
  `;

  return new ShaderMaterial({
    vertexShader,
    fragmentShader,
    blending: params.blending ?? NormalBlending,
    depthWrite: params.depthWrite ?? false,
    transparent: params.transparent ?? true,
  });
}
