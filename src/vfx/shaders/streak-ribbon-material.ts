import { AdditiveBlending, Blending, DoubleSide, ShaderMaterial } from '@iwsdk/core';

export interface StreakRibbonParams {
  color: [number, number, number];
  blending?: Blending;
}

// A thin glowing "light streak" ribbon (see streak-path.ts's
// buildStreakRibbonGeometry) — gaussian-ish brightness falloff across its
// width (vUv.y), a soft fade-in/out at both ends along its length (vUv.x)
// so the ribbon doesn't cut off with a hard edge, a slow traveling shimmer,
// and a sparse hash-noise fine-grain sparkle overlay (same hash13 idiom
// toon-rim-material.ts's grainy pebble variant uses) so the surface itself
// reads as fine stardust riding the streak, not a flat glow. Requires
// uTime updated every frame, same contract as every other _timeUniformMats
// material in ArtTestVfxSystem.
export function makeStreakRibbonMaterial(params: StreakRibbonParams): ShaderMaterial {
  const [r, g, b] = params.color;

  const vertexShader = `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;

  const fragmentShader = `
    uniform float uTime;
    varying vec2 vUv;

    float hash13(vec3 p) {
      p = fract(p * 0.3183099 + 0.1);
      p *= 17.0;
      return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
    }

    void main() {
      float d = abs(vUv.y - 0.5) * 2.0;
      float core = pow(clamp(1.0 - d, 0.0, 1.0), 1.6);

      float endFade = smoothstep(0.0, 0.06, vUv.x) * smoothstep(1.0, 0.94, vUv.x);
      float shimmer = 0.75 + 0.25 * sin(uTime * 2.4 + vUv.x * 18.0);

      float grain = hash13(vec3(vUv * vec2(500.0, 60.0), 0.0));
      float fleck = step(0.986, grain) * (0.5 + 0.5 * sin(uTime * 5.0 + grain * 40.0));

      float alpha = clamp(core * shimmer + fleck * core * 1.5, 0.0, 1.0) * endFade;
      gl_FragColor = vec4(${r.toFixed(4)}, ${g.toFixed(4)}, ${b.toFixed(4)}, alpha);
    }
  `;

  return new ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader,
    fragmentShader,
    blending: params.blending ?? AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  });
}
