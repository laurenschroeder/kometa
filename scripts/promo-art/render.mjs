#!/usr/bin/env node
// Renders Kometa promo / store art — hero shots of the comet with its face
// turned to camera and the tail swishing behind it.
//
// Usage:
//   node scripts/promo-art/render.mjs              # every shot in shots.mjs
//   node scripts/promo-art/render.mjs gallery-soul # only shots whose name contains this
//
// How it works: spins up a throwaway Vite server rooted at
// scripts/promo-art/page (so the page can import the game's own shader /
// geometry modules from src/ with TS + bare '@iwsdk/core' imports resolved
// exactly as the game does), drives the system Chrome headlessly via
// playwright-core with the GPU enabled, loads one page per shot, pulls the
// supersampled PNG back out, and downsamples it with sharp (lanczos) to the
// final size. Gallery shots that come out over the 2 MB store limit as PNG
// are re-encoded as high-quality JPEG instead.
//
// Output lands in promo/ at the project root.

import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { SHOTS } from './shots.mjs';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');
const outDir = path.join(projectRoot, 'promo');
// Decimal 2 MB, minus a little headroom — store limits are often 2,000,000 bytes.
const MAX_GALLERY_BYTES = 1_950_000;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].filter(Boolean);

async function main() {
  const filter = process.argv[2];
  const shots = SHOTS.filter((s) => !filter || s.name.includes(filter));
  if (!shots.length) {
    console.error(`No shots match "${filter}".`);
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });

  const server = await createServer({
    configFile: false,
    root: path.join(__dirname, 'page'),
    publicDir: path.join(projectRoot, 'public'),
    logLevel: 'warn',
    server: { port: 0, fs: { allow: [projectRoot] } },
    optimizeDeps: { exclude: ['@babylonjs/havok'], esbuildOptions: { target: 'esnext' } },
    esbuild: { target: 'esnext' },
  });
  await server.listen();
  const base = server.resolvedUrls.local[0];

  const executablePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=default', '--enable-unsafe-swiftshader'],
  });

  try {
    for (const shot of shots) {
      const t0 = Date.now();
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
      page.on('console', (msg) => {
        if (msg.type() === 'error' || msg.type() === 'warning') console.log(`  [page ${msg.type()}] ${msg.text()}`);
      });
      page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`));
      // A module that fails to transform never runs, so it can't report
      // through window.__error — surface that as a failure right away.
      page.on('response', (res) => {
        if (res.status() >= 500) page.evaluate((u) => (window.__error = `server error loading ${u}`), res.url()).catch(() => {});
      });
      const encoded = Buffer.from(JSON.stringify(shot)).toString('base64');
      await page.goto(`${base}?shot=${encodeURIComponent(encoded)}`);
      await page.waitForFunction(() => window.__result || window.__error, null, { timeout: 90_000 });
      const err = await page.evaluate(() => window.__error);
      if (err) throw new Error(`${shot.name}: ${err}`);
      const dataUrl = await page.evaluate(() => window.__result);
      await page.close();

      const raw = Buffer.from(dataUrl.split(',')[1], 'base64');
      const resized = sharp(raw).resize(shot.w, shot.h, { kernel: 'lanczos3' });
      let file = path.join(outDir, `${shot.name}.png`);
      let buf = await resized.clone().png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
      if (shot.name.startsWith('gallery') && buf.length > MAX_GALLERY_BYTES) {
        file = path.join(outDir, `${shot.name}.jpg`);
        buf = await resized.clone().jpeg({ quality: 93, mozjpeg: true, chromaSubsampling: '4:4:4' }).toBuffer();
      }
      for (const ext of ['.png', '.jpg']) {
        const stale = path.join(outDir, `${shot.name}${ext}`);
        if (stale !== file && fs.existsSync(stale)) fs.rmSync(stale);
      }
      fs.writeFileSync(file, buf);
      console.log(
        `${path.relative(projectRoot, file)}  ${shot.w}x${shot.h}  ${(buf.length / 1024).toFixed(0)} KB  (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
      );
    }
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
