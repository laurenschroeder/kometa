// Single source of truth for every fixed "identity" color in the game —
// stored as '#rrggbb' strings (rather than 0xrrggbb numeric literals) so
// VS Code's built-in color decorator recognizes them, showing an inline
// swatch and a click-to-edit picker right in this file, with small helpers
// below to convert into whatever shape a given caller actually needs (a 0-1
// RGB float triple for ToonRimPalette/shader uniforms, an RGBA quad for
// DomeGradient, a GLSL `vec3(...)` literal for a baked-in shader string, or
// the hex string itself — three.js's ColorRepresentation accepts a CSS-style
// hex string anywhere it accepts a numeric hex/Color). Every value below was
// moved here byte-for-byte from wherever it used to be hardcoded (converted
// to the nearest hex — 8-bit quantization means a round trip can drift by up
// to ~1/255, imperceptible visually) — see each constant's own comment for
// where it moved from and what still imports it. ORGANIC_PALETTE below is
// the one exception to "single fixed swatch" — a small hand-picked set of 5,
// not a single color, but still fixed (not procedurally generated) so it
// belongs here rather than off in its own palette-builder module.
//
// Not covered here: src/phases/art-test/ — a dev-only art-style sandbox
// with its own large, throwaway set of tuning colors (including its own
// still-procedural blue-green-palette.ts sweep), deliberately left alone
// rather than folded into the shipped game's palette.

export type HexColor = `#${string}`;
export type RGB = [number, number, number];
export type RGBA = [number, number, number, number];

export function hexToRgb(hex: HexColor): RGB {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

export function hexToRgba(hex: HexColor, alpha: number): RGBA {
  const [r, g, b] = hexToRgb(hex);
  return [r, g, b, alpha];
}

// For splicing a fixed color directly into a GLSL string template (same
// role toon-rim-material.ts's own local vec3Glsl helper plays for a
// per-call palette) — every component fixed to 4 decimal places.
export function hexToGlsl(hex: HexColor): string {
  const [r, g, b] = hexToRgb(hex);
  return `vec3(${r.toFixed(4)}, ${g.toFixed(4)}, ${b.toFixed(4)})`;
}

// ── Shared neutrals ─────────────────────────────────────────────────────
export const WHITE: HexColor = '#fffae2';
export const BLACK: HexColor = '#000000';

// ── Pebble type identity colors (pebble-type.ts's PEBBLE_TYPES) ──────────
// Also drives dominant-type coloring throughout Fate Events/Constellations/
// Launch wherever no more-specific color below applies.
export const SOUL_DUST: HexColor = '#85aaff'; // blue
export const ORGANIC_MATTER: HexColor = '#caff81'; // green
export const VOLATILE_GASSES: HexColor = '#ff7053'; // red

// ── Toon-rim palettes (pebble-material.ts) ────────────────────────────────
export const SOUL_ISLAND_DARK: HexColor = '#bfe0ff';
export const SOUL_ISLAND_LIGHT: HexColor = '#e6f7ff';
export const ORGANIC_GLITTER_DARK: HexColor = '#050506';
export const ORGANIC_GLITTER_LIGHT: HexColor = '#0b0b0e';
export const GAS_CLOUD: HexColor = '#f26638';

// ── Sky dome gradient (index.ts's DomeGradient setup) ─────────────────────
export const DOME_SKY: HexColor = '#03050d';
export const DOME_EQUATOR: HexColor = '#050d12';
export const DOME_GROUND: HexColor = '#030305';

// ── Stardust (stardust-vfx-system.ts) ─────────────────────────────────────
export const SWIRL_GOLD: HexColor = '#ffff75';
export const STARDUST: HexColor = '#fff5d1';

// ── Shared humanoid rig (animated-person.ts) ──────────────────────────────
export const PERSON_BODY: HexColor = '#050505';

// ── Notification HUD (notification-hud-system.ts) ─────────────────────────
export const NOTIFICATION_TEXT_DEFAULT: HexColor = WHITE;

// ── Background starfield (starfield-system.ts) ────────────────────────────
export const STARFIELD_COOL_WHITE: HexColor = '#bfd9ff';
export const STARFIELD_WARM_WHITE: HexColor = '#ffebcc';

// ── Fate Events (fate-event-vfx-system.ts / earth-situations-vfx-system.ts)
export const NAMED_RIM: HexColor = '#ffd973'; // the two featured figures' gold rim
export const MACHINE: HexColor = '#808594';
export const CROWN: HexColor = '#ffd933';
export const TOWER: HexColor = '#736e66';
export const GRAVE: HexColor = '#66666b';

// ── Fate dialogue accent color (notification-copy.ts's FATE_DIALOGUE.Crown)
// Close to but distinct from CROWN above (the king's own tower/body
// material) — kept separate since they're conceptually different uses that
// may want to diverge later.
export const FATE_CROWN_DIALOGUE: HexColor = '#ffd126';

// ── Planet/moon (planet-seeding-vfx-system.ts) ────────────────────────────
export const PLANET_BASE: HexColor = '#05080d';
export const MOON: HexColor = '#8c9eb3';

// ── Constellations (constellations-vfx-system.ts) ─────────────────────────
export const UNTOUCHED_STAR: HexColor = '#ffd933';
export const FIELD_STAR: HexColor = '#ccd9f2';

// ── Orbital Launch (orbital-launch-vfx-system.ts) ─────────────────────────
export const ORBIT: HexColor = '#4a9aff';
export const UNKNOWN: HexColor = '#8c6fca';

// ── Pebble comet presentation (pebble-comet-presentation-system.ts) ───────
export const HAZE: HexColor = '#9bbeff';
export const HAZE_GAS: HexColor = '#ee9982';
export const COMET_HEAD: HexColor = '#080d17'; // decal material's dark navy body

// ── Planet atmosphere glow (atmosphere-glow-material.ts) ──────────────────
export const ATMOSPHERE: HexColor = '#ff7c7c';

// ── Organic matter's fixed accent palette (planet-growth-pool.ts's plants,
// pebble-comet-presentation-system.ts/pebble-field-vfx-system.ts's organic
// pebble tail, earth-situations-vfx-system.ts/fate-event-vfx-system.ts's
// seed collectibles) — replaces the old procedural blue<->green HSL sweep
// (blue-green-palette.ts's buildBlueGreenPalette, still used by
// src/phases/art-test/'s own PEBBLE_COLORED_PALETTE variant only) with one
// shared, hand-picked set of 5 instead of an algorithmically generated
// spectrum.
export const ORGANIC1: HexColor = '#bcd588';
export const ORGANIC2: HexColor = '#88d5ab';
export const ORGANIC3: HexColor = '#b8ff1e';
export const ORGANIC4: HexColor = '#72844b';
export const ORGANIC5: HexColor = '#30632e';
export const ORGANIC_PALETTE: RGB[] = [ORGANIC1, ORGANIC2, ORGANIC3, ORGANIC4, ORGANIC5].map(hexToRgb);