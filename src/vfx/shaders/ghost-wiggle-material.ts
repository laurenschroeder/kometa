import { DoubleSide, ShaderMaterial, Texture } from '@iwsdk/core';

export interface GhostWiggleParams {
  texture: Texture;
  // How far (world units) the tail displaces at the peak of its wave.
  amplitude?: number;
  // How many wave cycles fit top-to-bottom across the plane.
  frequency?: number;
  // How fast the wave travels over time.
  speed?: number;
}

// A billboarded, textured, alpha-transparent quad (same base contract as a
// plain textured MeshBasicMaterial) with a vertex-shader wiggle layered on
// top — the "head" (uv.y = 1, top of the plane) stays fixed while the
// "tail" (uv.y = 0, bottom) waves side to side, tapered smoothly in
// between, so a vertical ghost-sheet sprite reads as gently billowing
// rather than a rigid flat card. Displacement happens in the plane's own
// local space before the view-facing billboard rotation is applied
// (ArtTestVfxSystem/_updateBillboards sets the mesh's quaternion each
// frame), so the wiggle always reads as "within the sprite" regardless of
// which way the sprite is currently facing.
export function makeGhostWiggleMaterial(params: GhostWiggleParams): ShaderMaterial {
  const amplitude = params.amplitude ?? 0.02;
  const frequency = params.frequency ?? 6.0;
  const speed = params.speed ?? 2.0;

  const vertexShader = `
    uniform float uTime;
    varying vec2 vUv;
    void main() {
      vUv = uv;
      float taper = 1.0 - uv.y;
      vec3 pos = position;
      pos.x += sin(uv.y * ${frequency.toFixed(4)} + uTime * ${speed.toFixed(4)}) * ${amplitude.toFixed(4)} * taper;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
    }
  `;

  const fragmentShader = `
    uniform sampler2D uMap;
    varying vec2 vUv;
    void main() {
      vec4 tex = texture2D(uMap, vUv);
      gl_FragColor = tex;
    }
  `;

  return new ShaderMaterial({
    uniforms: { uMap: { value: params.texture }, uTime: { value: 0 } },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  });
}
