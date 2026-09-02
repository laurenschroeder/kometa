import { CanvasTexture } from '@iwsdk/core';

const SIZE = 256;
const SPIKE_COUNT = 8;

// Canvas-drawn "hero star" texture — a soft blue-white halo, 8 tapered
// diffraction spikes (alternating long/short, like a real lens artifact),
// and a bright warm core on top. Same technique as fate-event-vfx-system.ts's
// buildFireTexture(): canvas 2D gradients give much easier control over soft
// tapering/color grading than point-sprite GLSL would at this size, and this
// is meant to be the one photographic-fidelity accent against the rest of
// the game's flat toon shading, not a reusable shader. Built once (SkyBackdrop
// System.init()), applied to an additive-blended billboard.
export function buildHeroStarTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const cx = SIZE / 2;
  const cy = SIZE / 2;

  ctx.globalCompositeOperation = 'lighter';

  const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, SIZE * 0.5);
  halo.addColorStop(0, 'rgba(255, 226, 160, 0.5)');
  halo.addColorStop(0.4, 'rgba(140, 190, 255, 0.16)');
  halo.addColorStop(1, 'rgba(140, 190, 255, 0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, SIZE, SIZE);

  for (let i = 0; i < SPIKE_COUNT; i++) {
    const angle = (i / SPIKE_COUNT) * Math.PI * 2;
    const long = i % 2 === 0;
    const length = SIZE * (long ? 0.48 : 0.28);
    const width = SIZE * (long ? 0.022 : 0.012);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);

    const grad = ctx.createLinearGradient(0, 0, length, 0);
    grad.addColorStop(0, 'rgba(255, 250, 235, 0.9)');
    grad.addColorStop(0.35, 'rgba(255, 236, 190, 0.32)');
    grad.addColorStop(1, 'rgba(255, 236, 190, 0)');
    ctx.fillStyle = grad;

    ctx.beginPath();
    ctx.moveTo(0, -width / 2);
    ctx.lineTo(length, 0);
    ctx.lineTo(0, width / 2);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }

  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, SIZE * 0.09);
  core.addColorStop(0, 'rgba(255, 255, 250, 1)');
  core.addColorStop(0.5, 'rgba(255, 240, 200, 0.9)');
  core.addColorStop(1, 'rgba(255, 220, 160, 0)');
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(cx, cy, SIZE * 0.09, 0, Math.PI * 2);
  ctx.fill();

  return new CanvasTexture(canvas);
}
