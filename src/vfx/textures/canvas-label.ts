import { CanvasTexture } from '@iwsdk/core';

// Shared canvas-texture text label — a rounded dark card with a white
// border and centered white text, baked once to a <canvas> and wrapped as a
// CanvasTexture on a PlaneGeometry by the caller. Originally lived only in
// orbital-launch-vfx-system.ts (the choice-zone labels); extracted here so
// StartMenuSystem's new cube buttons can reuse the exact same visual
// language instead of duplicating this code.
const LABEL_CANVAS_W = 384;
const LABEL_CANVAS_H = 128;

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

export function drawLabel(text: string): CanvasTexture {
  const w = LABEL_CANVAS_W;
  const h = LABEL_CANVAS_H;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const pad = 12;

  ctx.fillStyle = 'rgba(8, 8, 16, 0.82)';
  roundRectPath(ctx, pad, pad, w - pad * 2, h - pad * 2, 20);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.lineWidth = 3;
  roundRectPath(ctx, pad, pad, w - pad * 2, h - pad * 2, 20);
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 42px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2);

  return new CanvasTexture(canvas);
}
