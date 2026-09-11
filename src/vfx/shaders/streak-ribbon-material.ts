import { AdditiveBlending, Blending, DoubleSide, ShaderMaterial } from '@iwsdk/core';

export interface StreakRibbonParams {
  color: [number, number, number];
  blending?: Blending;
  // One full grow-in/fade-out cycle takes this many seconds.
  loopDurationSeconds?: number;
  // Fraction of the loop (0-1) spent "growing in" head-first before the
  // fade-out phase takes over the rest of the cycle.
  revealFraction?: number;
  // Shifts this instance's own cycle in time — pass a different value per
  // ribbon (e.g. two curves sharing the scene) so multiple shooting stars
  // don't all grow/fade in perfect lockstep.
  phaseOffsetSeconds?: number;
  // Extra idle time (seconds) appended AFTER the reveal+fade (the existing
  // loopDurationSeconds/revealFraction pair, unchanged in meaning) before
  // the cycle repeats — 0 (default) preserves the original continuous
  // "always drawing or fading" loop. > 0 gives a "trace, fade, then wait a
  // while before repeating" cadence instead.
  waitSeconds?: number;
}

// A thin glowing "light streak" ribbon (see streak-path.ts's
// buildStreakRibbonGeometry) — gaussian-ish brightness falloff across its
// width (vUv.y), a soft fade-in/out at both ends along its length (vUv.x)
// so the ribbon doesn't cut off with a hard edge, a slow traveling shimmer,
// and a sparse hash-noise fine-grain sparkle overlay (same hash13 idiom
// toon-rim-material.ts's grainy pebble variant uses) so the surface itself
// reads as fine stardust riding the streak, not a flat glow — ON TOP of a
// looping "shooting star" reveal: headMask sweeps a soft leading edge along
// vUv.x from 0 to 1 over the first `revealFraction` of the loop (so the
// trail appears to grow in from its tight-loop end, like something flying
// past), then fadeMask ramps the WHOLE ribbon's opacity down to 0 over the
// remainder of the loop, then it all repeats from headMask=0 again. This is
// deliberately a uv/time-space animation, not an actual moving light
// source — cheap, and correct for a ribbon whose own geometry never
// changes. Requires uTime updated every frame, same contract as every
// other _timeUniformMats material in ArtTestVfxSystem.
export function makeStreakRibbonMaterial(params: StreakRibbonParams): ShaderMaterial {
  const [r, g, b] = params.color;
  const loopDuration = params.loopDurationSeconds ?? 3.5;
  const revealFraction = params.revealFraction ?? 0.55;
  const phaseOffset = params.phaseOffsetSeconds ?? 0;
  const waitSeconds = params.waitSeconds ?? 0;
  const revealSeconds = loopDuration * revealFraction;
  const fadeSeconds = loopDuration * (1 - revealFraction);
  const totalSeconds = loopDuration + waitSeconds;

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
      // Absolute seconds within the loop (NOT normalized 0-1 — wait can be
      // much longer than the reveal+fade portion, so a 0-1 fraction of the
      // WHOLE loop would make revealFraction's own meaning depend on
      // waitSeconds too). revealT/fadeT below stay 0-1 fractions of just
      // their own phase, same as before waitSeconds existed.
      float loopSec = mod(uTime + ${phaseOffset.toFixed(4)}, ${totalSeconds.toFixed(4)});

      float revealT  = clamp(loopSec / ${revealSeconds.toFixed(4)}, 0.0, 1.0);
      float headMask = smoothstep(revealT + 0.06, revealT - 0.06, vUv.x);

      // Clamps to (and stays at) 1 once loopSec passes the reveal+fade
      // portion, so fadeMask is already 0 for the whole wait period without
      // needing a separate branch.
      float fadeT    = clamp((loopSec - ${revealSeconds.toFixed(4)}) / ${fadeSeconds.toFixed(4)}, 0.0, 1.0);
      float fadeMask = 1.0 - fadeT;

      float d = abs(vUv.y - 0.5) * 2.0;
      float core = pow(clamp(1.0 - d, 0.0, 1.0), 1.6);

      float endFade = smoothstep(0.0, 0.06, vUv.x) * smoothstep(1.0, 0.94, vUv.x);
      float shimmer = 0.75 + 0.25 * sin(uTime * 2.4 + vUv.x * 18.0);

      float grain = hash13(vec3(vUv * vec2(500.0, 60.0), 0.0));
      float fleck = step(0.986, grain) * (0.5 + 0.5 * sin(uTime * 5.0 + grain * 40.0));

      float alpha = clamp(core * shimmer + fleck * core * 1.5, 0.0, 1.0) * endFade * headMask * fadeMask;
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
