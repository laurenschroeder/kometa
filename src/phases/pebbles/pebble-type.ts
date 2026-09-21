import { hexToRgb, ORGANIC_MATTER, SOUL_DUST, VOLATILE_GASSES } from '../../vfx/color/color-scheme.js';

// Single source of truth for the three pebble types Chapter 2 can produce.
// Each pebble is pre-assigned one of these when it spawns — see
// pebble-layout.ts's assignPebbleSpawnPoint for the spatial layout (discrete
// groups spread around the player, one horizon-level ring plus a second
// ring higher overhead).
export interface PebbleType {
  id: number;
  name: string;
  color: [number, number, number]; // 0-1 RGB
}

// Hex strings indexed by PebbleType.id, for tinting UI.
export const PEBBLE_TYPE_HEX: string[] = [SOUL_DUST, ORGANIC_MATTER, VOLATILE_GASSES];

export const PEBBLE_TYPES: PebbleType[] = [
  { id: 0, name: 'soul dust', color: hexToRgb(SOUL_DUST) }, // blue
  { id: 1, name: 'organic matter', color: hexToRgb(ORGANIC_MATTER) }, // green
  { id: 2, name: 'volatile gasses', color: hexToRgb(VOLATILE_GASSES) }, // red
];
