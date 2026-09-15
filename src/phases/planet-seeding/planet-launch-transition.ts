import { Vector3 } from '@iwsdk/core';

// Bumped from 3.0 — see PlanetSpinTransition's own SPIN_DURATION comment;
// the whole Constellations-onward stretch needed more breathing room. Bumped
// again from 5.5 — this recede/shrink starts right as Fate Events ends (see
// its farewellMessage, "they watch you go, and don't look away"), and read
// as too quick right on the heels of that quiet beat.
const RECEDE_DURATION = 9; // seconds

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

// Leg C of the Seeding -> ... -> Launch journey (see PlanetSpinTransition for
// Leg A, PlanetFateTransition for Leg B). Simpler than either of those: no
// "grow outward from a face-reference point" cleverness needed here, just a
// straightforward smoothstep-eased lerp of position and radius from wherever
// Leg B left the planet to a fixed new end state (see
// OrbitalLaunchSystem.play(), which supplies that end state — its own
// left-side orbit-choice zone center, and Seeding's own small PLANET_RADIUS)
// — "the planet recedes and shrinks back down as Launch begins." Not a
// System — same explicitly-driven idiom (build/start/update/reset) as
// PlanetSpinTransition/PlanetFateTransition, owned and ticked every frame by
// PlanetSeedingVfxSystem, which also owns the sequencing between this and
// the earlier two legs.
export class PlanetLaunchTransition {
  private _currentPos = new Vector3();
  private _currentRadius = 0;

  private _active = false;
  private _started = false;
  private _elapsed = 0;

  private _fromPos = new Vector3();
  private _fromRadius = 0;
  private _toPos = new Vector3();
  private _toRadius = 0;

  build(planetPosition: Float32Array, radius: number): void {
    this._currentPos.fromArray(planetPosition);
    this._currentRadius = radius;
  }

  // Overwrites _currentPos/_currentRadius directly, without touching
  // _active/_started/_elapsed — reads straight from PlanetSeedingVfxSystem's
  // own live mesh transform (see its getLivePlanetPosition/Radius), which
  // already tracks whichever leg (or plain Seeding-follow) was driving the
  // planet up to this point, so Leg C always continues smoothly from
  // wherever the planet actually is rather than a stale build()-time
  // snapshot. Call once, immediately before start().
  syncCurrentState(position: Vector3, radius: number): void {
    this._currentPos.copy(position);
    this._currentRadius = radius;
  }

  start(targetPos: Vector3, targetRadius: number): void {
    this._elapsed = 0;
    this._active = true;
    this._started = true;
    this._fromPos.copy(this._currentPos);
    this._fromRadius = this._currentRadius;
    this._toPos.copy(targetPos);
    this._toRadius = targetRadius;
  }

  update(delta: number): void {
    if (!this._active) return;
    this._elapsed += delta;

    const s = Math.min(1, this._elapsed / RECEDE_DURATION);
    const eased = smoothstep(s);

    this._currentPos.copy(this._fromPos).lerp(this._toPos, eased);
    this._currentRadius = this._fromRadius + (this._toRadius - this._fromRadius) * eased;

    if (s >= 1) this._active = false;
  }

  isActive(): boolean {
    return this._active;
  }

  hasStarted(): boolean {
    return this._started;
  }

  getCurrentPosition(): Vector3 {
    return this._currentPos;
  }
  getCurrentRadius(): number {
    return this._currentRadius;
  }

  reset(planetPosition: Float32Array, radius: number): void {
    this._currentPos.fromArray(planetPosition);
    this._currentRadius = radius;
    this._active = false;
    this._started = false;
    this._elapsed = 0;
  }
}
