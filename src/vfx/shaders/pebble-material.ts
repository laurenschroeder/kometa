import {
  makeToonRimInstancedMaterial,
  makeToonRimInstancedTintedMaterial,
  ToonRimPalette,
} from './toon-rim-material.js';

export const PEBBLE_PALETTE: ToonRimPalette = {
  bodyColorDark: [0.01, 0.02, 0.05],
  bodyColorLight: [0.05, 0.08, 0.14],
  rimColor: [1.0, 1.0, 1.0],
};

// Single shared material instance — safe to reuse across many InstancedMesh
// objects (unlike geometry, a ShaderMaterial carries no per-owner instance
// count/attribute state), so every "toon pebble" in the game — the ambient
// field gathered in Chapter 2, the body riding the trail from Chapter 2
// onward — renders with the exact same look from one shader program.
export const kPebbleInstMat = makeToonRimInstancedMaterial(PEBBLE_PALETTE);

// Tinted variant, used only by PebbleFieldVfxSystem to color individual
// Chapter 2 pebbles by which type they became — kPebbleInstMat above (and
// everything else that shares it, e.g. the persistent comet body) is left
// completely untouched.
export const kPebbleFieldTintedMat = makeToonRimInstancedTintedMaterial(PEBBLE_PALETTE);
