import { Vector3 } from '@iwsdk/core';
import { PLANET_CENTER, PLANET_RADIUS as FATE_PLANET_RADIUS } from '../fate-events/fate-event-system.js';
import { N_PLANETS, PLANET_RADIUS as SEEDING_PLANET_RADIUS } from './planet-seeding-system.js';

// Matches the codebase's existing "straight ahead from the player" convention
// (orbital-launch-system.ts's ORBIT_DIR=[0,0,-1]) — where the selected planet
// ends up facing you.
const FRONT_ANGLE = -Math.PI / 2;
const ROTATE_DURATION = 2.5; // seconds — the ring spinning the selected planet to front
const GROW_DURATION = 3.5; // seconds — selected planet growing/receding into place
const FAR_RING_RADIUS = 12; // meters — where the other 5 planets end up

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

// Wraps to (-pi, pi] — the shortest rotation, not always "positive/forward".
function normalizeAngleDelta(a: number): number {
  let d = a % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// Drives the Seeding ring's two-phase "become the Fate Events planet"
// transition: phase A rotates all N_PLANETS rigidly (radius/height fixed,
// only angle changes) until the selected planet reaches FRONT_ANGLE; phase B
// grows the selected planet from Seeding's small radius up to Fate Events'
// PLANET_RADIUS while its center recedes along a blended direction, timed so
// it lands EXACTLY on Fate Events' fixed PLANET_CENTER/PLANET_RADIUS at
// completion (no discontinuity for comet-autopilot-system.ts's later orbit
// math, which reads those same constants during Launch) — meanwhile every
// other planet's radius-from-origin grows out to FAR_RING_RADIUS at its own
// post-rotation angle, "still arranged in a circle, just very far away."
//
// Not a System — a plain, explicitly-driven helper (build/start/update/
// reset), same idiom as HeartBurstPool/PlanetGrowthPool. Owns the ring's
// *live* per-planet transform state (_currentPos/_currentRadius) — the
// owning PlanetSeedingVfxSystem writes these into its Mesh instances every
// frame, replacing the one-time position/scale set _buildPlanets() used to
// do. start() always reads FROM the current live state (never the original
// static layout), so re-entering Fate Events without an intervening loop
// reset just smoothly re-targets from wherever things already are.
export class PlanetFateTransition {
  private _currentPos!: Float32Array; // N_PLANETS*3
  private _currentRadius!: Float32Array; // N_PLANETS

  private _active = false;
  private _phase: 'rotate' | 'grow' | null = null;
  private _elapsed = 0;
  private _selectedPlanet = -1;

  // rotate-phase snapshot, captured in start()
  private _rotateFromAngle!: Float32Array;
  private _rotateFromOrbitR!: Float32Array;
  private _rotateFromHeight!: Float32Array;
  private _rotateDelta = 0;

  // grow-phase snapshot, captured the instant rotate completes
  private _growFromPos!: Float32Array; // N_PLANETS*3
  private _growFromRadius!: Float32Array; // N_PLANETS
  private _growEndD = 0; // fixed, computed once in build()
  private _faceRef!: Vector3;
  private _growEndDir!: Vector3; // fixed unit vector, computed once in build()

  private _scratchDir0!: Vector3;
  private _scratchDir!: Vector3;

  build(planetPositions: Float32Array): void {
    this._currentPos = new Float32Array(N_PLANETS * 3);
    this._currentPos.set(planetPositions);
    this._currentRadius = new Float32Array(N_PLANETS).fill(SEEDING_PLANET_RADIUS);

    this._rotateFromAngle = new Float32Array(N_PLANETS);
    this._rotateFromOrbitR = new Float32Array(N_PLANETS);
    this._rotateFromHeight = new Float32Array(N_PLANETS);
    this._growFromPos = new Float32Array(N_PLANETS * 3);
    this._growFromRadius = new Float32Array(N_PLANETS);

    // Fixed reference point ("roughly your face") and the fixed end state
    // Fate Events' planet already occupies relative to it — both computed
    // once since PLANET_CENTER/PLANET_RADIUS never change.
    this._faceRef = new Vector3(0, PLANET_CENTER[1], 0);
    const endOffset = new Vector3(PLANET_CENTER[0], PLANET_CENTER[1], PLANET_CENTER[2]).sub(this._faceRef);
    this._growEndD = endOffset.length() - FATE_PLANET_RADIUS;
    this._growEndDir = endOffset.normalize();

    this._scratchDir0 = new Vector3();
    this._scratchDir = new Vector3();
  }

  start(selectedPlanet: number): void {
    this._selectedPlanet = selectedPlanet;
    this._phase = 'rotate';
    this._elapsed = 0;
    this._active = true;

    for (let p = 0; p < N_PLANETS; p++) {
      const x = this._currentPos[p * 3];
      const y = this._currentPos[p * 3 + 1];
      const z = this._currentPos[p * 3 + 2];
      this._rotateFromAngle[p] = Math.atan2(z, x);
      this._rotateFromOrbitR[p] = Math.hypot(x, z);
      this._rotateFromHeight[p] = y;
    }
    this._rotateDelta = normalizeAngleDelta(FRONT_ANGLE - this._rotateFromAngle[selectedPlanet]);
  }

  update(delta: number): void {
    if (!this._active) return;
    this._elapsed += delta;

    if (this._phase === 'rotate') {
      const s = Math.min(1, this._elapsed / ROTATE_DURATION);
      const eased = smoothstep(s);
      for (let p = 0; p < N_PLANETS; p++) {
        const angle = this._rotateFromAngle[p] + this._rotateDelta * eased;
        const r = this._rotateFromOrbitR[p];
        this._currentPos[p * 3] = Math.cos(angle) * r;
        this._currentPos[p * 3 + 1] = this._rotateFromHeight[p];
        this._currentPos[p * 3 + 2] = Math.sin(angle) * r;
      }
      if (s >= 1) {
        this._growFromPos.set(this._currentPos);
        this._growFromRadius.set(this._currentRadius);
        this._phase = 'grow';
        this._elapsed = 0;
      }
      return;
    }

    const s = Math.min(1, this._elapsed / GROW_DURATION);
    const eased = smoothstep(s);
    const sel = this._selectedPlanet;

    // Selected planet: near-edge distance and direction both blend from
    // their actual starting values to Fate Events' own fixed end state, so
    // it lands exactly on PLANET_CENTER/PLANET_RADIUS at s=1 while still
    // reading as "growing outward" rather than the center jumping.
    {
      this._scratchDir0
        .set(this._growFromPos[sel * 3], this._growFromPos[sel * 3 + 1], this._growFromPos[sel * 3 + 2])
        .sub(this._faceRef);
      const startD = this._scratchDir0.length() - this._growFromRadius[sel];
      this._scratchDir0.normalize();
      this._scratchDir.copy(this._scratchDir0).lerp(this._growEndDir, eased);
      if (this._scratchDir.lengthSq() > 1e-8) this._scratchDir.normalize();

      const d = startD + (this._growEndD - startD) * eased;
      const radius = this._growFromRadius[sel] + (FATE_PLANET_RADIUS - this._growFromRadius[sel]) * eased;
      const centerDist = d + radius;

      this._currentPos[sel * 3] = this._faceRef.x + this._scratchDir.x * centerDist;
      this._currentPos[sel * 3 + 1] = this._faceRef.y + this._scratchDir.y * centerDist;
      this._currentPos[sel * 3 + 2] = this._faceRef.z + this._scratchDir.z * centerDist;
      this._currentRadius[sel] = radius;
    }

    // Every other planet: angle stays fixed at its post-rotation value, its
    // own radius-from-origin grows out to FAR_RING_RADIUS, and its sphere
    // size grows by the same amount as the selected planet (Seeding's
    // PLANET_RADIUS up to Fate Events' PLANET_RADIUS) — they read as equally
    // big worlds, just much further off, rather than shrinking into tiny
    // dots as they recede.
    for (let p = 0; p < N_PLANETS; p++) {
      if (p === sel) continue;
      const fx = this._growFromPos[p * 3];
      const fy = this._growFromPos[p * 3 + 1];
      const fz = this._growFromPos[p * 3 + 2];
      const angle = Math.atan2(fz, fx);
      const orbitR0 = Math.hypot(fx, fz);
      const orbitR = orbitR0 + (FAR_RING_RADIUS - orbitR0) * eased;
      this._currentPos[p * 3] = Math.cos(angle) * orbitR;
      this._currentPos[p * 3 + 1] = fy;
      this._currentPos[p * 3 + 2] = Math.sin(angle) * orbitR;
      this._currentRadius[p] = this._growFromRadius[p] + (FATE_PLANET_RADIUS - this._growFromRadius[p]) * eased;
    }

    if (s >= 1) {
      this._active = false;
      this._phase = null;
    }
  }

  isActive(): boolean {
    return this._active;
  }

  getSelectedPlanet(): number {
    return this._selectedPlanet;
  }

  // Read-only for the caller — live per-planet world position/radius,
  // driven every frame while active and held fixed once settled.
  getCurrentPositions(): Float32Array {
    return this._currentPos;
  }
  getCurrentRadii(): Float32Array {
    return this._currentRadius;
  }

  reset(planetPositions: Float32Array): void {
    this._currentPos.set(planetPositions);
    this._currentRadius.fill(SEEDING_PLANET_RADIUS);
    this._active = false;
    this._phase = null;
    this._elapsed = 0;
    this._selectedPlanet = -1;
  }
}
