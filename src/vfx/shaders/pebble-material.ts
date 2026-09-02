import { makeToonRimInstancedTintedMaterial, ToonRimPalette } from './toon-rim-material.js';

export const PEBBLE_PALETTE: ToonRimPalette = {
  bodyColorDark: [0.01, 0.02, 0.05],
  bodyColorLight: [0.05, 0.08, 0.14],
  rimColor: [1.0, 1.0, 1.0],
};

// Single shared material instance — safe to reuse across many InstancedMesh
// objects (unlike geometry, a ShaderMaterial carries no per-owner instance
// count/attribute state), so every "toon pebble" in the game — the ambient
// field gathered in Chapter 2, the permanent body riding the trail from
// Chapter 2 onward — renders with the exact same look from one shader
// program. Both owners write their own per-instance aTint/aTinted values —
// each individual pebble is assigned one of PEBBLE_TYPES' saturated colors,
// weighted by globals.pebbleTypeWeights for the permanent body — onto their
// own separate geometry instances (see PebbleFieldVfxSystem's kFieldPebbleGeos
// vs. PebbleCometPresentationSystem's kPebbleVariantGeos) — only the
// material/shader itself is shared here, never the per-instance attributes.
export const kPebbleFieldTintedMat = makeToonRimInstancedTintedMaterial(PEBBLE_PALETTE);
