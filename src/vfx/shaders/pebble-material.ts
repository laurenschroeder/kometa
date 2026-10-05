import { AdditiveBlending } from '@iwsdk/core';
import {
  makeToonRimInstancedDitherMaterial,
  makeToonRimInstancedGrainyMaterial,
  makeToonRimInstancedWigglyMaterial,
  ToonRimPalette,
} from './toon-rim-material.js';
import { makePointSpriteMaterial } from './point-sprite-material.js';
import {
  GAS_CLOUD,
  hexToRgb,
  ORGANIC_GLITTER_DARK,
  ORGANIC_GLITTER_LIGHT,
  SOUL_ISLAND_DARK,
  SOUL_ISLAND_LIGHT,
  WHITE,
} from '../color/color-scheme.js';

// The three pebble types (see pebble-type.ts) are drawn as three genuinely
// different art styles, not just three tint colors on one shared rock mesh —
// see pebble-field-vfx-system.ts/pebble-comet-presentation-system.ts for how
// each material below is actually bucketed/assigned. Every material here is
// a shared module-scope singleton (no per-owner instance-count state),
// exactly like the single shared material this replaced — safe to reuse
// across many InstancedMesh/Points objects, and across both the ambient
// field and the permanent comet body.

// ── Soul (type 0) — translucent wiggly OBJ islands ─────────────────────────
export const SOUL_ISLAND_PALETTE: ToonRimPalette = {
  bodyColorDark: hexToRgb(SOUL_ISLAND_DARK),
  bodyColorLight: hexToRgb(SOUL_ISLAND_LIGHT),
  rimColor: hexToRgb(WHITE),
};
// amplitude 0.19 vs. the art-test wiggly-islands reference's bare default
// (0.15) — "slightly stronger than the art level." opacity 0.55 for
// "translucent very light blue" instead of that reference's opaque black.
export const kSoulIslandMat = makeToonRimInstancedWigglyMaterial(SOUL_ISLAND_PALETTE, {
  amplitude: 0.19,
  opacity: 0.55,
});
// Souls read too small/insubstantial next to organic/gas at their shared
// base pebble size — doubled to stand out.
export const SOUL_SIZE_MULTIPLIER = 2;

// Was the raw virtualpebble_2026-09-03_13-09-21.obj scan (7MB, undecimated —
// loadObjLargestIslands's extracted "islands" still ran ~54,500-133,000
// triangles EACH, instanced dozens of times per comet — the single biggest
// GPU cost in the whole game once the comet turns visible at Seeding, ~4.4M
// triangles measured live). Replaced with hand-decimated (~700-2000 tri)
// island shapes the artist separated out of that same scan and folded into
// blobpeople.fbx (naming wasn't matched 1:1 to the old OBJ groups — these are
// just whichever of blobpeople.fbx's small "blob" shapes aren't already
// spoken for by GHOST_MESH_NAMES/SEED_MESH_NAMES in fate-event-vfx-system.ts).
// Shared constants so every caller hits the same loadFbxMeshesByName cache
// key.
export const PEBBLE_ISLAND_MESH_URL = '/medium/blobpeople.fbx';
export const PEBBLE_ISLAND_MESH_NAMES = ['ProperPerson', 'BlobPerson', 'MinimalPerson', 'Person', 'Dog', 'star'] as const;

// ── Organic (type 1) — glitter blue/green spectrum body, white rim ─────────
// Dark body (glitter/sparkle carries the color, same read as the art-test
// "colored pebbles" reference) but rim AND sparkle are white, not that
// reference's neon yellow — the reference ties rim/sparkle to the same
// fixed color, so "make the rim white" carries sparkle along with it.
export const ORGANIC_GLITTER_PALETTE: ToonRimPalette = {
  bodyColorDark: hexToRgb(ORGANIC_GLITTER_DARK),
  bodyColorLight: hexToRgb(ORGANIC_GLITTER_LIGHT),
  rimColor: hexToRgb(WHITE),
  sparkleColor: hexToRgb(WHITE),
};
export const kOrganicGlitterMat = makeToonRimInstancedGrainyMaterial(ORGANIC_GLITTER_PALETTE);

// The organic PEBBLES themselves (ambient Pebbles field + the comet's tail —
// the same pebbles before and after capture, so both must match) use this
// instead of kOrganicGlitterMat: colored-dust stipple over a dark body,
// densest toward the silhouette, which reads as a round rock rather than
// the glitter material's flat dark disc. antialias fades the stipple to its
// average shade once dots go sub-pixel, so distant pebbles don't shimmer
// in the headset. dotFrequency 25 (vs. the plants' 480): pebbles are tiny,
// so the default dots are sub-pixel even up close — 25 gives ~2-3px dots on
// near/in-hand pebbles (visible dusty speckle), ~1px on typical tail
// pebbles at arm's length, where antialias smooths them instead.
// kOrganicGlitterMat stays for seed collectibles/blossoms. No uniforms —
// nothing to tick per frame.
export const kOrganicRockMat = makeToonRimInstancedDitherMaterial(ORGANIC_GLITTER_PALETTE, {
  antialias: true,
  dotFrequency: 25,
});

// ── Gas (type 2) — little additive gas-cloud puffs ──────────────────────────
// Warm red/orange, NOT the nebula reference's teal — PEBBLE_TYPES[2].color
// (red) still drives the notification-copy "red violence of raw gasses"
// line, Fate Events fire/people, planet moons, constellations, and the sky
// backdrop whenever gas is dominant, so staying red/orange keeps this type's
// identity color consistent across the rest of the game. Real emission
// nebulae read naturally as red/orange anyway.
export const GAS_CLOUD_COLOR: [number, number, number] = hexToRgb(GAS_CLOUD);
export const kGasCloudMat = makePointSpriteMaterial({
  color: GAS_CLOUD_COLOR,
  blending: AdditiveBlending,
  depthWrite: false,
  transparent: true,
});
