import { Vector3 } from '@iwsdk/core';
import { randomUnitVector3 } from '../../vfx/geometry/mesh-utils.js';

export interface PebbleSpawnPoint {
  dir: Vector3;
  radiusT: number;
  type: number;
}

// Same spawn shell PebbleWeavingSystem builds its GatherableField against —
// exported so both files share one source of truth. The vein curves below
// are authored in terms of these two numbers (see VEIN_BASE_RADIUS's own
// comment), so drifting them out of sync here vs. the field's own
// spawnRadiusMin/Max would silently distort the intended shape (GatherableField
// re-derives world radius from radiusT against ITS OWN min/max — see its own
// comment on the spawnPoint contract).
export const PEBBLE_SPAWN_RADIUS_MIN = 0.5;
export const PEBBLE_SPAWN_RADIUS_MAX = 1.8;
const PEBBLE_SPAWN_CENTER: [number, number, number] = [0, 1.2, 0];

const N_VEIN_TYPES = 3; // matches PEBBLE_TYPES' blue/green/red ordering

// Chapter 2's spatial layout: each pebble type winds through its own loose
// "vein" — a wavy, spiraling path around the player (matching this phase's
// own name, "Weaving") — rather than being scattered independently within
// a shared cloud/cone. The three veins share the same vertical axis, each
// offset AZIMUTH_OFFSET apart (120°) so they read as three distinct braided
// strands, but their radius/height each ride their own out-of-phase wave
// (see RADIUS_PHASE_MULT/HEIGHT_PHASE_MULT) so the strands visibly swell
// toward and away from each other — twisting around one another — rather
// than tracing three perfectly parallel rings. Chasing one color becomes
// "follow this strand," not "avoid everything else in a mixed blob."
// First-pass numbers — expect to retune in-headset.
const VEIN_TURNS = 2.25; // full loops around the vertical axis over one vein's length
// Middle of the spawn shell's own radius range (see PEBBLE_SPAWN_RADIUS_MIN/
// MAX) — the wave amplitude below swings around this, not off some
// unrelated baseline.
const VEIN_BASE_RADIUS = (PEBBLE_SPAWN_RADIUS_MIN + PEBBLE_SPAWN_RADIUS_MAX) / 2;
const VEIN_RADIUS_WAVE_AMPLITUDE = 0.35;
const VEIN_RADIUS_WAVE_FREQ = 2; // wave cycles over one vein's length
const VEIN_HEIGHT_AMPLITUDE = 0.45;
const VEIN_HEIGHT_WAVE_FREQ = 1.5;
// Small random offset around the exact curve point so a vein reads as a
// loose tube of pebbles, not an infinitely thin line.
const VEIN_THICKNESS = 0.13;

const AZIMUTH_OFFSET = (Math.PI * 2) / N_VEIN_TYPES; // 120° apart
// Deliberately NOT matching AZIMUTH_OFFSET's own 120° spacing — keeps the
// three veins' radius/height swells out of lockstep with their angular
// spacing, so the braid reads as organic rather than a perfectly repeating
// pattern.
const RADIUS_PHASE_MULT = 2.1;
const HEIGHT_PHASE_MULT = 1.7;

const _scratchPoint = new Vector3();
const _scratchJitter = new Vector3();

// Called once per pebble (see GatherableFieldParams.spawnPoint) at
// field-construction time. Picks a random type and a random position `s`
// along that type's own vein (0=start, 1=end), evaluates the curve, adds a
// small random jitter for thickness, then converts the resulting absolute
// point back into the {dir, radiusT} shape GatherableField expects (a unit
// direction + 0-1 radius fraction from spawnCenter) — the field itself is
// never touched; any point in the shell can be expressed this way.
export function assignPebbleSpawnPoint(): PebbleSpawnPoint {
  const type = Math.floor(Math.random() * N_VEIN_TYPES);
  const s = Math.random();

  const azimuth = s * VEIN_TURNS * Math.PI * 2 + type * AZIMUTH_OFFSET;
  const radius =
    VEIN_BASE_RADIUS +
    Math.sin(s * VEIN_RADIUS_WAVE_FREQ * Math.PI * 2 + type * RADIUS_PHASE_MULT) * VEIN_RADIUS_WAVE_AMPLITUDE;
  const height =
    Math.sin(s * VEIN_HEIGHT_WAVE_FREQ * Math.PI * 2 + type * HEIGHT_PHASE_MULT) * VEIN_HEIGHT_AMPLITUDE;

  _scratchPoint.set(Math.cos(azimuth) * radius, height, Math.sin(azimuth) * radius);
  _scratchJitter.copy(randomUnitVector3()).multiplyScalar(Math.random() * VEIN_THICKNESS);
  _scratchPoint.add(_scratchJitter);

  const dist = _scratchPoint.length();
  const dir = dist > 1e-6 ? _scratchPoint.clone().multiplyScalar(1 / dist) : new Vector3(0, 1, 0);
  const range = PEBBLE_SPAWN_RADIUS_MAX - PEBBLE_SPAWN_RADIUS_MIN;
  const radiusT = Math.min(1, Math.max(0, (dist - PEBBLE_SPAWN_RADIUS_MIN) / range));

  return { dir, radiusT, type };
}

// Exported for PebbleWeavingSystem's own GatherableField construction, so
// its spawnCenter always matches what this file's vein math assumes.
export function getPebbleSpawnCenter(): [number, number, number] {
  return PEBBLE_SPAWN_CENTER;
}
