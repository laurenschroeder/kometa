---
name: msdf-font
description: Generate or swap the game's MSDF bitmap-font atlas from a .ttf/.otf file and wire it into every PanelUI text element. Use when the user wants to change/add a UI font, regenerate an existing font atlas, or asks why a `font-family` change in a .uikitml file isn't showing up.
argument-hint: [font name or path, e.g. "Carrois Gothic SC" or path/to/Font.ttf]
---

# UI font (MSDF atlas) generation

This project's PanelUI/.uikitml text renders through `@pmndrs/uikit`, which
draws glyphs from pre-baked MSDF (multi-channel signed distance field) bitmap
atlases — there is no CSS `@font-face`/web-font loading path. Every UI font
change needs an atlas generated once, then referenced from code.

**This is why "I set font-family in the .uikitml but nothing changed"
happens** — either the font has no generated atlas yet, or the atlas exists
but the tag actually rendering that text (`<span>`, `<button>`, etc.) has no
kit registration wiring `fontFamilies` in at construction time (see below).

## Regenerating / adding a font

1. Get the font file (.ttf/.otf). For a Google Fonts family, the raw files
   live in `https://github.com/google/fonts` under `ofl/<family-name-no-spaces-lowercase>/`,
   e.g. `ofl/carroisgothicsc/CarroisGothicSC-Regular.ttf`. Download with curl.
2. Run the generator (already committed, uses the project's own
   `@zappar/msdf-generator` + `playwright-core` deps — no new installs):
   ```
   node scripts/msdf-font/generate.mjs \
     --font path/to/Font-Regular.ttf \
     --name someFontName \
     --out src/vfx/fonts/some-font-name.ts
   ```
   This drives a headless Chromium page (via playwright-core) that runs the
   WASM msdfgen build in-browser (it needs Worker + Canvas, so it can't run
   in plain Node) and writes a TS module shaped exactly like
   `@pmndrs/msdfonts`'s exports (e.g. `montserrat`): `{ [weightKey]: atlasJson }`.
   Takes ~1-3 minutes. See the script's own header comment for all flags
   (`--weights`, `--charset`, `--fontSize`, `--textureSize`).
   - If the source font file only has one static weight (most Google Fonts
     families do — check the GitHub `ofl/<family>/` folder for how many
     `.ttf` files exist), the script aliases that single atlas under every
     requested `--weights` key (default `normal,medium,semi-bold,bold`) so
     `font-weight: bold;` etc. in .uikitml CSS still resolves to *something*
     instead of silently falling back to the default font.
3. Add the new export as another key in `src/vfx/fonts/font-registry.ts`'s
   `HUD_FONT_FAMILIES` map (currently `{ hud: carroisGothicSC, script:
   imperialScript }`). Everything downstream references this one map —
   panels never import a font module directly. A `.uikitml` file opts into
   a given key with `font-family: <key>;` in its own CSS (e.g.
   `font-family: script;` for the Imperial Script accent font). Reserve
   decorative/display fonts like `script` for deliberate accents (titles,
   flourishes) rather than making them the default body font — cursive
   faces are hard to read at small sizes.
4. Run `npx tsc --noEmit` to confirm the generated module type-checks.
5. Visually confirm via the `iwsdk-ui` skill (ScreenSpace full-screen
   preview) or by starting the dev server and checking a panel in-headset/
   in-browser.

## How the font actually reaches every panel

- `src/core/ui-font-kit.ts` defines `GameSpan`/`GameButton`, thin
  `UIKit.Container` subclasses that inject `fontFamilies: HUD_FONT_FAMILIES`
  via `defaultOverrides`. `fontFamilies` (the map) only takes effect if
  present **at construction time** — setting it later via `setProperties()`
  does not retroactively reshape already-built glyphs — so it can't be
  supplied from plain .uikitml markup or CSS.
- `src/index.ts`'s `World.create` registers these as the global
  `features.spatialUI.kits` for the `span`/`button` tags (alongside
  `notification-hud-system.ts`'s pre-existing `hudtext` custom tag). This
  makes the override apply to **every** `<span>`/`<button>` in **every**
  `.uikitml` file project-wide, not just the HUD.
- Each `.uikitml` file's own CSS still needs `font-family: hud;` (and
  optionally `font-weight: ...;`) to actually select the atlas — the kit
  only makes the map *available*, CSS picks which entry of it to use. If a
  panel's text still isn't in the font, check its `.uikitml` for a missing
  `font-family: hud;` declaration first.
- `<div>` is hard-mapped to a plain `Container` by `@pmndrs/uikitml`'s
  parser and can never be a kit target — any panel putting raw text
  directly inside a `<div>` (not wrapped in `<span>`) won't pick up the
  font. Wrap it in a `<span>` instead.
