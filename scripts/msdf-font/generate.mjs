#!/usr/bin/env node
// Generates an MSDF (multi-channel signed distance field) bitmap-font atlas
// from a .ttf/.otf file and writes it as a TypeScript module compatible with
// @pmndrs/uikit's `fontFamilies` prop (same shape as @pmndrs/msdfonts's
// exports, e.g. `montserrat`).
//
// Why this exists: this project's PanelUI text renders through @pmndrs/uikit,
// which draws text from pre-baked MSDF atlases, not arbitrary web fonts —
// there's no @font-face equivalent. Getting a new typeface into the game
// means generating one of these atlases once, offline, and importing the
// result like any other bundled font.
//
// Usage:
//   node scripts/msdf-font/generate.mjs \
//     --font path/to/Font-Regular.ttf \
//     --name carroisGothicSC \
//     --out src/vfx/fonts/carrois-gothic-sc.ts \
//     [--weights normal,medium,semi-bold,bold] \
//     [--charset "chars to include"] \
//     [--fontSize 48] [--textureSize 1024]
//
// All requested --weights alias the SAME generated atlas when the source
// font file only has one static weight (most Google Fonts families do) —
// there's no real bold/medium variant, just the one face reused under
// multiple fontWeight keys so CSS `font-weight:` in .uikitml files doesn't
// silently fail to resolve.
//
// How it works: @zappar/msdf-generator does the actual MSDF baking via a
// WebAssembly build of msdfgen, but it's written for a browser (uses Worker +
// Canvas), so this script spins up a throwaway static file server, drives a
// headless Chromium page via playwright-core to run the generator, and pulls
// the resulting JSON (atlas image inlined as a base64 PNG data URI) back out.

import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    }
  }
  return args;
}

const DEFAULT_CHARSET =
  " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.font || !args.name || !args.out) {
    console.error(
      'Usage: node scripts/msdf-font/generate.mjs --font <path.ttf> --name <exportName> --out <path.ts> [--weights normal,bold] [--charset "..."] [--fontSize 48] [--textureSize 1024]',
    );
    process.exit(1);
  }

  const fontPath = path.resolve(process.cwd(), args.font);
  const outPath = path.resolve(process.cwd(), args.out);
  const exportName = args.name;
  const weights = (args.weights || 'normal,medium,semi-bold,bold')
    .split(',')
    .map((w) => w.trim())
    .filter(Boolean);
  const charset = args.charset || DEFAULT_CHARSET;
  const fontSize = Number(args.fontSize || 48);
  const textureSizeN = Number(args.textureSize || 1024);
  const fieldRange = Number(args.fieldRange || 4);

  if (!fs.existsSync(fontPath)) {
    console.error(`Font file not found: ${fontPath}`);
    process.exit(1);
  }

  // Stage a servable directory: generator dist + comlink (bare specifier
  // needs an import map — see page/index.html) + the source font.
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msdf-gen-'));
  fs.cpSync(path.join(projectRoot, 'scripts/msdf-font/page'), workDir, { recursive: true });
  fs.cpSync(
    path.join(projectRoot, 'node_modules/@zappar/msdf-generator/dist'),
    path.join(workDir, 'msdf-generator'),
    { recursive: true },
  );
  fs.copyFileSync(
    path.join(projectRoot, 'node_modules/comlink/dist/esm/comlink.mjs'),
    path.join(workDir, 'msdf-generator/comlink.mjs'),
  );
  // Import maps don't reliably extend into module Workers across browser
  // versions, and index.js/worker.js both import the bare specifier
  // "comlink" — rewrite it to a relative path so it resolves with no
  // import map needed at all (more robust than relying on worker inheritance).
  for (const f of ['index.js', 'worker.js']) {
    const p = path.join(workDir, 'msdf-generator', f);
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('"comlink"', '"./comlink.mjs"'));
  }
  fs.copyFileSync(fontPath, path.join(workDir, 'font.ttf'));

  const server = http.createServer((req, res) => {
    const reqPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const filePath = path.join(workDir, reqPath === '/' ? 'index.html' : reqPath);
    if (!filePath.startsWith(workDir) || !fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const ext = path.extname(filePath);
    const type =
      { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.ttf': 'font/ttf' }[
        ext
      ] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    fs.createReadStream(filePath).pipe(res);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (err) => console.error('[page error]', err.message));
    page.on('console', (msg) => console.log('[page]', msg.type(), msg.text()));

    await page.goto(`http://127.0.0.1:${port}/index.html`);
    console.log(`Generating MSDF atlas from ${path.basename(fontPath)} (fontSize=${fontSize}, texture=${textureSizeN})...`);

    await page.evaluate(
      (opts) => window.runGen(opts),
      { charset, fontSize, textureSize: [textureSizeN, textureSizeN], fieldRange },
    );
    await page.waitForFunction(() => window.__done === true, { timeout: 180000 });
    const result = await page.evaluate(() => window.__result);

    const faceNames = Object.keys(result);
    if (faceNames.length === 0) {
      throw new Error('Generator returned no font faces');
    }
    // Single input font file -> single generated weight; flatten it out
    // and alias it under every requested CSS font-weight key.
    const [faceName] = faceNames;
    const generatedWeights = Object.keys(result[faceName]);
    const [weightKey] = generatedWeights;
    const atlas = result[faceName][weightKey];

    const fontFamily = {};
    for (const w of weights) {
      fontFamily[w] = atlas;
    }

    const header = `// AUTO-GENERATED by scripts/msdf-font/generate.mjs — do not hand-edit.
// Source font: ${path.basename(fontPath)}
// Regenerate with:
//   node scripts/msdf-font/generate.mjs --font ${args.font} --name ${exportName} --out ${args.out}${args.weights ? ` --weights ${args.weights}` : ''}${args.charset ? ` --charset "${args.charset}"` : ''}
`;
    const body = `export const ${exportName} = ${JSON.stringify(fontFamily)};\n`;

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, header + body);

    console.log(`Wrote ${outPath}`);
    console.log(`  face: ${faceName}, source weight key: ${weightKey}, aliased as: ${weights.join(', ')}`);
    console.log(`  glyphs: ${atlas.chars.length}, atlas: ${textureSizeN}x${textureSizeN}`);
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
