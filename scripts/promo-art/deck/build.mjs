#!/usr/bin/env node
// Builds the festival documents from this folder's HTML sources:
//   deck.html        -> promo/kometa-artist-deck.{html,pdf}       (artistic presentation)
//   tech-sheet.html  -> promo/kometa-exhibition-sheet.{html,pdf}  (exhibition technical sheet)
//
// Usage: node scripts/promo-art/deck/build.mjs
//
// Edit the copy in the .html sources (plain HTML — every {{NAME}} is filled
// in here: the game's fonts, corner.png, and the promo/ renders as
// compressed JPEGs). Each output .html is self-contained and shareable; each
// .pdf has one 16:9 page per slide, printed via system Chrome.
// Re-render the phase art first (render.mjs phase-) if the images changed.

import { chromium } from 'playwright-core';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..', '..');
const promo = path.join(root, 'promo');

const dataUri = (buf, mime) => `data:${mime};base64,${buf.toString('base64')}`;
const jpg = async (file) =>
  dataUri(await sharp(path.join(promo, file)).resize(1600, 900).jpeg({ quality: 84, mozjpeg: true }).toBuffer(), 'image/jpeg');
const corner = dataUri(await sharp(path.join(root, 'public/textures/corner.png')).resize(160, 160).png().toBuffer(), 'image/png');

const subs = {
  FONT_CARROIS: dataUri(fs.readFileSync(path.join(root, 'public/fonts/CarroisGothicSC-Regular.ttf')), 'font/ttf'),
  FONT_IMPERIAL: dataUri(fs.readFileSync(path.join(root, 'public/fonts/ImperialScript-Regular.ttf')), 'font/ttf'),
  IMG_COVER: await jpg('gallery-soul.jpg'),
  IMG_CONCEPT: await jpg('gallery-closeup-gas.jpg'),
  IMG_INTENT: await jpg('gallery-organic.jpg'),
  IMG_UNIVERSE: await jpg('cover-landscape-organic-clean.png'),
  IMG_TRIO: await jpg('gallery-trio.jpg'),
  IMG_P1: await jpg('phase-1-stardust-labeled.png'),
  IMG_P2: await jpg('phase-2-pebbles-labeled.png'),
  IMG_P3: await jpg('phase-3-seeding-labeled.png'),
  IMG_P4: await jpg('phase-4-fate-labeled.png'),
  IMG_P5: await jpg('phase-5-launch-labeled.png'),
  CORNERS: ['bl', 'tl', 'tr', 'br'].map((c) => `<img class="corner ${c}" src="${corner}" alt="">`).join(''),
};

const DOCS = [
  ['deck.html', 'kometa-artist-deck'],
  ['tech-sheet.html', 'kometa-exhibition-sheet'],
];

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
});
try {
  for (const [source, outName] of DOCS) {
    const body = fs.readFileSync(path.join(__dirname, source), 'utf8').replace(/\{\{(\w+)\}\}/g, (_, k) => {
      if (!(k in subs)) throw new Error(`${source} uses unknown placeholder {{${k}}}`);
      return subs[k];
    });
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${body}</body></html>`;
    const htmlOut = path.join(promo, `${outName}.html`);
    fs.writeFileSync(htmlOut, html);

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    // A slide whose content runs taller than the page gets pushed or split
    // across PDF pages (blank or cut-off pages) — fail loudly instead.
    const overflowing = await page.evaluate(() =>
      [...document.querySelectorAll('.slide')]
        .filter((slide) => [...slide.querySelectorAll('*')].some((el) => el.getBoundingClientRect().bottom > slide.getBoundingClientRect().bottom + 1 && el.closest('.slide') === slide && getComputedStyle(el).position !== 'absolute' && el.scrollHeight > 0 && !el.matches('img.art')))
        .map((slide) => slide.getAttribute('aria-label')),
    );
    if (overflowing.length) throw new Error(`${source}: content overflows slide(s): ${overflowing.join(', ')} — trim copy`);
    const pdfOut = path.join(promo, `${outName}.pdf`);
    await page.pdf({ path: pdfOut, printBackground: true, preferCSSPageSize: true });
    await page.close();
    console.log(`${path.relative(root, htmlOut)}
${path.relative(root, pdfOut)}`);
  }
} finally {
  await browser.close();
}
