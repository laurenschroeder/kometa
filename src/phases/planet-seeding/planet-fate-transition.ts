import { Vector3 } from '@iwsdk/core';
import { PLANET_CENTER, PLANET_RADIUS as FATE_PLANET_RADIUS } from '../fate-events/fate-event-system.js';
import { PLANET_RADIUS as SEEDING_PLANET_RADIUS } from './planet-seeding-system.js';

// Bumped from 3.5 — see PlanetSpinTransition's own SPIN_DURATION comment;
// the whole Constellations-onward stretch needed more breathing room.
const GROW_DURATION = 6.0; // seconds — the planet growing/receding into place

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

// Drives Seeding's single planet "becoming the Fate Events planet"
// transition: it grows from Seeding's small radius up to Fate Events'
// PLANET_RADIUS while its center recedes along a blended direction, timed
// so it lands EXACTLY on Fate Events' fixed PLANET_CENTER/PLANET_RADIUS at
// completion (no discontinuity for comet-autopilot-system.ts's later orbit
// math, which reads those same constants during Launch).
//
// Not a System — a plain, explicitly-driven helper (build/start/update/
// reset), same idiom as HeartBurstPool/PlanetGrowthPool. Owns the planet's
// *live* transform state (_currentPos/_currentRadius) — the owning
// PlanetSeedingVfxSystem writes these into its Mesh every frame, replacing
// the one-time position/scale set _buildPlanet() used to do. start() always
// reads FROM the current live state (never the original static position),
// so re-entering Fate Events without an intervening loop reset just
// smoothly re-targets from wherever the planet already is.
export class PlanetFateTransition {
  private _currentPos = new Vector3();
  private _currentRadius = SEEDING_PLANET_RADIUS;

  private _active = false;
  // Distinct from _active: stays true once start() has ever been called,
  // even after the grow animation finishes and _active goes back to false —
  // callers (e.g. hiding the atmosphere-glow flourish permanently) need to
  // know "has this planet begun becoming the Fate Events planet," not just
  // "is it mid-animation right now." Only reset() clears it.
  private _started = false;
  private _elapsed = 0;

  // grow-phase snapshot, captured in start()
  private _growFromPos = new Vector3();
  private _growFromRadius = SEEDING_PLANET_RADIUS;
  private _growEndD = 0; // fixed, computed once in build()
  private _faceRef!: Vector3;
  private _growEndDir!: Vector3; // fixed unit vector, computed once in build()

  private _scratchDir0 = new Vector3();
  private _scratchDir = new Vector3();

  build(planetPosition: Float32Array): void {
    this._currentPos.fromArray(planetPosition);
    this._currentRadius = SEEDING_PLANET_RADIUS;

    // Fixed reference point ("roughly your face") and the fixed end state
    // Fate Events' planet already occupies relative to it — both computed
    // once since PLANET_CENTER/PLANET_RADIUS never change.
    this._faceRef = new Vector3(0, PLANET_CENTER[1], 0);
    const endOffset = new Vector3(PLANET_CENTER[0], PLANET_CENTER[1], PLANET_CENTER[2]).sub(this._faceRef);
    this._growEndD = endOffset.length() - FATE_PLANET_RADIUS;
    this._growEndDir = endOffset.normalize();
  }

  start(): void {
    this._elapsed = 0;
    this._active = true;
    this._started = true;
    this._growFromPos.copy(this._currentPos);
    this._growFromRadius = this._currentRadius;
  }

  // Overwrites _currentPos/_currentRadius directly, without touching
  // _active/_started/_elapsed — for when a SEPARATE transition (see
  // PlanetSpinTransition) has been driving the planet up to this point.
  // Without this, start() would snapshot whatever stale position/radius this
  // instance last held (its own build()-time default), causing a visible
  // jump instead of continuing smoothly from wherever the other transition
  // actually left the planet. Call once, immediately before start().
  syncCurrentState(position: Vector3, radius: number): void {
    this._currentPos.copy(position);
    this._currentRadius = radius;
  }

  update(delta: number): void {
    if (!this._active) return;
    this._elapsed += delta;

    const s = Math.min(1, this._elapsed / GROW_DURATION);
    const eased = smoothstep(s);

    // Near-edge distance and direction both blend from their actual
    // starting values to Fate Events' own fixed end state, so the planet
    // lands exactly on PLANET_CENTER/PLANET_RADIUS at s=1 while still
    // reading as "growing outward" rather than the center jumping.
    this._scratchDir0.copy(this._growFromPos).sub(this._faceRef);
    const startD = this._scratchDir0.length() - this._growFromRadius;
    this._scratchDir0.normalize();
    this._scratchDir.copy(this._scratchDir0).lerp(this._growEndDir, eased);
    if (this._scratchDir.lengthSq() > 1e-8) this._scratchDir.normalize();

    const d = startD + (this._growEndD - startD) * eased;
    const radius = this._growFromRadius + (FATE_PLANET_RADIUS - this._growFromRadius) * eased;
    const centerDist = d + radius;

    this._currentPos.copy(this._faceRef).addScaledVector(this._scratchDir, centerDist);
    this._currentRadius = radius;

    if (s >= 1) this._active = false;
  }

  isActive(): boolean {
    return this._active;
  }

  hasStarted(): boolean {
    return this._started;
  }

  // Read-only for the caller — live planet world position/radius, driven
  // every frame while active and held fixed once settled.
  getCurrentPosition(): Vector3 {
    return this._currentPos;
  }
  getCurrentRadius(): number {
    return this._currentRadius;
  }

  reset(planetPosition: Float32Array): void {
    this._currentPos.fromArray(planetPosition);
    this._currentRadius = SEEDING_PLANET_RADIUS;
    this._active = false;
    this._started = false;
    this._elapsed = 0;
  }
}
