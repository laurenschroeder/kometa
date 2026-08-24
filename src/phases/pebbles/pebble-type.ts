// Single source of truth for the three pebble types Chapter 2 can produce.
// Each pebble is pre-assigned one of these when it spawns — see
// pebble-layout.ts's assignPebbleSpawnPoint for the spatial layout (9
// discrete groups, 3 per color, spread evenly around the full 360° circle
// around the player).
export interface PebbleType {
  id: number;
  name: string;
  color: [number, number, number]; // 0-1 RGB
}

export const PEBBLE_TYPES: PebbleType[] = [
  { id: 0, name: 'soul dust', color: [0.35, 0.55, 1.0] }, // blue
  { id: 1, name: 'organic matter', color: [0.35, 0.85, 0.4] }, // green
  { id: 2, name: 'volatile gasses', color: [1.0, 0.32, 0.28] }, // red
];
