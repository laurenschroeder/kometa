import { AdditiveBlending, Blending, ShaderMaterial } from '@iwsdk/core';

export interface StarShapeParams {
  color: [number, number, number];
  blending?: Blending;
  pointSizeFactor?: number;
}

// Crisp 5-point star polygon sprites — for stardust that reads as literal
// hand-drawn star shapes scattered among fine dust (see the reference
// image), not just makeSparkleMaterial's plus-shaped twinkle glint. The
// star outline is built in polar coordinates: radius is linearly
// interpolated between an outer radius (at each spike's own angle) and an
// inner radius (at the valley angle exactly between two spikes) — a
// slightly curved edge rather than a mathematically straight one, but at
// point-sprite scale it reads unambiguously as a 5-point star, and the
// math is simple enough to get right without a way to render and check it
// in this environment. Requires uTime updated every frame (twinkle) and a
// per-instance aRotation attribute (gl_PointCoord sprites are always
// screen-aligned, so a field of these needs the UV itself rotated per
// instance or every star would render at an identical orientation).
export function makeStarShapeMaterial(params: StarShapeParams): ShaderMaterial {
  const pointSizeFactor = params.pointSizeFactor ?? 320.0;
  const [r, g, b] = params.color;

  const vertexShader = `
    attribute float aSize;
    attribute float aBright;
    attribute float aPhase;
    attribute float aRotation;
    varying float vBright;
    varying float vPhase;
    varying float vRotation;
    void main() {
      vBright = aBright;
      vPhase = aPhase;
      vRotation = aRotation;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = aSize * (${pointSizeFactor.toFixed(4)} / -mv.z);
      gl_Position  = projectionMatrix * mv;
    }
  `;

  const fragmentShader = `
    uniform float uTime;
    varying float vBright;
    varying float vPhase;
    varying float vRotation;

    void main() {
      vec2 uv = gl_PointCoord - 0.5;
      float cs = cos(vRotation), sn = sin(vRotation);
      uv = mat2(cs, -sn, sn, cs) * uv;

      const float PI = 3.14159265;
      const float POINTS = 5.0;
      const float SECTOR = (2.0 * PI) / POINTS;
      float angle = atan(uv.y, uv.x);
      float a = mod(angle + SECTOR * 0.5, SECTOR) - SECTOR * 0.5;
      float t = clamp(abs(a) / (SECTOR * 0.5), 0.0, 1.0);
      float edgeR = mix(0.46, 0.18, t);

      float dist = length(uv);
      float fill = smoothstep(edgeR + 0.03, edgeR - 0.03, dist);
      float glow = smoothstep(edgeR + 0.24, edgeR - 0.05, dist) * 0.35;

      float twinkle = 0.55 + 0.45 * sin(uTime * 2.6 + vPhase * 6.2831);
      float alpha = clamp(fill + glow, 0.0, 1.0) * vBright * twinkle;
      if (alpha < 0.01) discard;
      gl_FragColor = vec4(${r.toFixed(4)}, ${g.toFixed(4)}, ${b.toFixed(4)}, alpha);
    }
  `;

  return new ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader,
    fragmentShader,
    blending: params.blending ?? AdditiveBlending,
    depthWrite: false,
    transparent: true,
  });
}
