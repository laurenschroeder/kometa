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
// so it lands EXACTLY on PLANET_CENTER — shifted by however far the player
// has drifted from world origin since Constellations began (see start()'s
// own comment and FateEventSystem.play()) — at completion. comet-autopilot-
// system.ts's later orbit math reads the mesh's own live transform rather
// than these constants directly, so it stays consistent regardless of where
// this actually lands.
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
  private _growEndD = 0; // computed fresh every start() — see its own comment
  private _faceRef = new Vector3();
  private _growEndDir = new Vector3();
  private _scratchEndOffset = new Vector3();

  private _scratchDir0 = new Vector3();
  private _scratchDir = new Vector3();

  build(planetPosition: Float32Array): void {
    this._currentPos.fromArray(planetPosition);
    this._currentRadius = SEEDING_PLANET_RADIUS;
  }

  // driftX/driftZ: how far the player has actually wandered from world
  // origin by the time Fate Events begins (see FateEventSystem.play()'s own
  // comment) — shifts _faceRef and the end target by the same amount, so
  // the grow-in lands in front of wherever the player really is instead of
  // the raw authored PLANET_CENTER, without ever moving the player's camera
  // to match it (that used to be an instant teleport — see
  // FateEventSystem's own history). growEndD/growEndDir end up numerically
  // IDENTICAL to the undrifted case either way — _faceRef and the target
  // shift by the exact same amount, so their relative offset (the "how
  // far/which direction to grow" math) is unaffected; only _faceRef's
  // absolute position — and so _currentPos's whole output — actually moves.
  // Recomputed fresh here (rather than once in build()) since the drift is
  // only known once this phase actually begins.
  start(driftX = 0, driftZ = 0): void {
    this._elapsed = 0;
    this._active = true;
    this._started = true;
    this._growFromPos.copy(this._currentPos);
    this._growFromRadius = this._currentRadius;

    this._faceRef.set(driftX, PLANET_CENTER[1], driftZ);
    this._scratchEndOffset
      .set(PLANET_CENTER[0] + driftX, PLANET_CENTER[1], PLANET_CENTER[2] + driftZ)
      .sub(this._faceRef);
    this._growEndD = this._scratchEndOffset.length() - FATE_PLANET_RADIUS;
    this._growEndDir.copy(this._scratchEndOffset).normalize();
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
