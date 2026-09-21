import { CanvasTexture } from '@iwsdk/core';

// Shared canvas-texture text label — a rounded dark card with a white
// border and centered white text, baked once to a <canvas> and wrapped as a
// CanvasTexture on a PlaneGeometry by the caller. Originally lived only in
// orbital-launch-vfx-system.ts (the choice-zone labels); extracted here so
// StartMenuSystem's new cube buttons can reuse the exact same visual
// language instead of duplicating this code.
const LABEL_CANVAS_W = 384;
const LABEL_CANVAS_H = 128;

// This is plain 2D Canvas text, not @pmndrs/uikit's MSDF-atlas panels (see
// src/vfx/fonts/), so it can load the game's font as a normal web font via
// the FontFace API instead of needing a generated atlas. The .ttf here is
// the same source file scripts/msdf-font/generate.mjs bakes into
// carrois-gothic-sc.ts — kept in public/fonts too since this is a
// completely separate rendering path.
// Exported so every OTHER canvas-text drawing site in the game (fate-events'
// speech bubbles, the banner text, art-test's debug labels) loads and
// references the exact same font instead of each hardcoding its own
// 'sans-serif' — see each of those files' own use of labelFont/fontReady.
export const FONT_FAMILY = 'Carrois Gothic SC';
const FONT_URL = '/fonts/CarroisGothicSC-Regular.ttf';

export function labelFont(sizePx: number): string {
  return `bold ${sizePx}px "${FONT_FAMILY}", sans-serif`;
}

// Kicked off once at module load (not per-label) and reused by every
// drawLabel() call — see the ready-check below for why each call still
// bothers awaiting it individually.
export const fontReady: Promise<FontFace> = new FontFace(FONT_FAMILY, `url(${FONT_URL})`)
  .load()
  .then((loaded) => {
    document.fonts.add(loaded);
    return loaded;
  });

export function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function paint(ctx: CanvasRenderingContext2D, text: string, radius: number, widthScale: number): void {
  const w = Math.round(LABEL_CANVAS_W * widthScale);
  const h = LABEL_CANVAS_H;
  const pad = 12;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.86)';
  roundRectPath(ctx, pad, pad, w - pad * 2, h - pad * 2, radius);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.lineWidth = 3;
  roundRectPath(ctx, pad, pad, w - pad * 2, h - pad * 2, radius);
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.font = labelFont(42);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2);
}

// `radius` defaults to a modest rounded-card look (the original, still used
// by OrbitalLaunchVfxSystem's zone labels and PebbleChoiceBubbleSystem's own
// "(CONTINUE?)" prompt) — pass 0 for a square-cornered card instead (e.g.
// poke-button.ts's own label, to match that template's pure-90°-corners
// diamond/flourish look).
export function drawLabel(text: string, radius = 0, widthScale = 1): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(LABEL_CANVAS_W * widthScale);
  canvas.height = LABEL_CANVAS_H;
  const ctx = canvas.getContext('2d')!;

  paint(ctx, text, radius, widthScale);
  const texture = new CanvasTexture(canvas);

  // The FIRST label drawn before the font finishes loading falls back to
  // sans-serif above (a blank canvas beats a stalled button). Repaint once
  // the real font is available and push the update to the GPU — a no-op if
  // this exact texture was already replaced/disposed by then (setLabel()
  // callers swap textures on later calls, e.g. Settings' toggle labels).
  if (!document.fonts.check(labelFont(42))) {
    fontReady.then(() => {
      paint(ctx, text, radius, widthScale);
      texture.needsUpdate = true;
    });
  }

  return texture;
}
