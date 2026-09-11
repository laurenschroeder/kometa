import { Texture } from '@iwsdk/core';

export interface SpriteRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  aspect: number; // pixel width / pixel height, for sizing a plane without stretching
}

const ALPHA_THRESHOLD = 12; // out of 255 — treat near-fully-transparent pixels as background
const MIN_BLOB_DIMENSION_PX = 6; // reject anti-aliasing specks/stray pixels, not a real photo

// Connected-component (8-connectivity flood fill) extraction of every
// distinct non-transparent blob in a spritesheet image — each detected
// blob's own pixel bounding box becomes its own UV sub-rect. Deliberately
// NOT a fixed grid-slice: the source images (rocks.png, rockBW.png) are a
// hand-arranged scatter of individually-shot rock photos on a transparent
// background, with no fixed cell size or spacing, and the whole point (per
// how this was actually requested) is that the source image can keep being
// edited/replaced with more or different rocks later without any code
// change — so detection has to work from the actual pixel content on each
// call, not a baked-in row/column count.
export function extractSpriteRects(texture: Texture): SpriteRect[] {
  const image = texture.image as { width?: number; height?: number } | undefined;
  if (!image || !image.width || !image.height) return [];

  const width = image.width;
  const height = image.height;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return [];
  ctx.drawImage(image as unknown as CanvasImageSource, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);

  const visited = new Uint8Array(width * height);
  const stackX = new Int32Array(width * height);
  const stackY = new Int32Array(width * height);
  const rects: SpriteRect[] = [];

  const isOpaque = (x: number, y: number) => data[(y * width + x) * 4 + 3] > ALPHA_THRESHOLD;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (visited[idx] || !isOpaque(x, y)) continue;

      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      let sp = 0;
      stackX[sp] = x;
      stackY[sp] = y;
      sp++;
      visited[idx] = 1;

      while (sp > 0) {
        sp--;
        const cx = stackX[sp];
        const cy = stackY[sp];
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const nIdx = ny * width + nx;
            if (visited[nIdx] || !isOpaque(nx, ny)) continue;
            visited[nIdx] = 1;
            stackX[sp] = nx;
            stackY[sp] = ny;
            sp++;
          }
        }
      }

      const wPx = maxX - minX + 1;
      const hPx = maxY - minY + 1;
      if (wPx < MIN_BLOB_DIMENSION_PX || hPx < MIN_BLOB_DIMENSION_PX) continue;

      // v is flipped (1 - pixelRow/height) because three.js textures sample
      // with v=0 at the bottom of the image while pixel rows count down
      // from the top — matches the same convention a full [0,1]x[0,1] UV
      // already relies on to display a whole image right-side up.
      rects.push({
        u0: minX / width,
        u1: (maxX + 1) / width,
        v0: 1 - (maxY + 1) / height,
        v1: 1 - minY / height,
        aspect: wPx / hPx,
      });
    }
  }

  return rects;
}

export interface OpaquePixelSample {
  x: number; // normalized to the image's own aspect ratio (width:height), 0 at center
  y: number; // -0.5..0.5, 0 at center, positive = up
  r: number; // 0-1, the source image's own color at this exact pixel
  g: number;
  b: number;
}

// Rejection-samples `count` random points that land on an opaque pixel of
// the given texture's image — for scattering particles/points that should
// collectively read as the shape of whatever is drawn in that image (e.g.
// "a ghost shape made out of CRT pixels," reusing a fabric-ghost PNG purely
// as a silhouette mask rather than displaying its actual texture — a
// caller after that look can just ignore the r/g/b fields and use its own
// fixed color instead). Returns positions on a normalized [-0.5,0.5]-tall
// local plane, aspect-correct (x spans the image's real width:height ratio)
// so a caller can scale by whatever world-space size it wants without
// distorting the shape, plus the source image's own color at that exact
// pixel for callers that want "colors matched from the original image"
// instead of a flat recolor.
export function sampleOpaquePixelPositions(
  texture: Texture,
  count: number,
  maxAttemptsPerSample = 40,
): OpaquePixelSample[] {
  const image = texture.image as { width?: number; height?: number } | undefined;
  if (!image || !image.width || !image.height) return [];

  const width = image.width;
  const height = image.height;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return [];
  ctx.drawImage(image as unknown as CanvasImageSource, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);

  const aspect = width / height;
  const isOpaque = (px: number, py: number) => data[(py * width + px) * 4 + 3] > ALPHA_THRESHOLD;

  const out: OpaquePixelSample[] = [];
  for (let i = 0; i < count; i++) {
    let found = false;
    for (let attempt = 0; attempt < maxAttemptsPerSample; attempt++) {
      const px = Math.floor(Math.random() * width);
      const py = Math.floor(Math.random() * height);
      if (isOpaque(px, py)) {
        const p = (py * width + px) * 4;
        out.push({
          x: (px / width - 0.5) * aspect,
          y: 0.5 - py / height,
          r: data[p] / 255,
          g: data[p + 1] / 255,
          b: data[p + 2] / 255,
        });
        found = true;
        break;
      }
    }
    // Image is mostly/fully transparent (or count is unreasonably high
    // relative to its opaque area) — stop rather than spin forever burning
    // failed attempts once misses become likely.
    if (!found) break;
  }
  return out;
}
