import { carroisGothicSC } from './carrois-gothic-sc.js';
import { imperialScript } from './imperial-script.js';

// Single source of truth for the game's UI fonts. This is the
// `fontFamilies` map @pmndrs/uikit expects: each font-family name pointing
// to a map of font-weight keys pointing to a generated MSDF atlas (see
// scripts/msdf-font/generate.mjs). Every .uikitml file selects one with
// `font-family: <name>;` + `font-weight: ...;` in its own CSS.
//
// Both fonts only have one static weight each (Google Fonts ships no
// separate Bold/Medium file for either), so every weight key below points
// at the same atlas per font — CSS font-weight still has to resolve to
// *something* in this map or @pmndrs/uikit silently falls back to its
// default font, which is what happened before this was wired up
// project-wide.
//
// "hud" is the main UI font (Carrois Gothic SC). "script" is available as
// an accent/decorative font (Imperial Script) for panels that want it —
// use it deliberately (e.g. a title or flourish), not as the default body
// font, since it's a cursive display face and hard to read at small sizes.
export const HUD_FONT_FAMILIES = { hud: carroisGothicSC, script: imperialScript };
