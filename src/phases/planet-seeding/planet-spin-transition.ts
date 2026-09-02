import { Vector3 } from '@iwsdk/core';
import { PLANET_RADIUS as SEEDING_PLANET_RADIUS } from './planet-seeding-system.js';

// Leg A of the Seeding -> Fate Events journey (see PlanetFateTransition for
// Leg B, the second/final leg). Lands the planet at an intermediate
// waypoint — far enough from the player, and small enough, that the 3
// constellation anchors (see constellation-path.ts's
// placeConstellationAnchorsAroundPlanet, fed THESE constants during
// Constellations) sit comfortably reachable in front of it, with the
// planet's own surface visibly farther back. First-pass numbers — expect to
// retune in-headset.
export const INTERMEDIATE_PLANET_CENTER: [number, number, number] = [0, 1.2, -1.6];
export const INTERMEDIATE_PLANET_RADIUS = 0.5;

const SPIN_DURATION = 4.0; // seconds — a bit longer than Leg B's 3.5s to give the accelerate/decelerate arc room
// Peak angular speed (rad/s), reached mid-transition — see the sin(pi*s)
// envelope in update() below.
const MAX_SPIN_SPEED = 7;

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

// Same "blend direction+distance from a fixed face-reference point, land
// exactly on a fixed end state" technique PlanetFateTransition uses, plus a
// self-terminating spin: angular speed follows MAX_SPIN_SPEED*sin(pi*s) (s =
// eased progress) — rises from 0, peaks at s=0.5, eases back to exactly 0 by
// s=1, so "spinning faster and faster, then stopping" falls out of the same
// curve without a separate deceleration phase to hand-author. Not a System —
// same explicitly-driven idiom (build/start/update/reset) as
// PlanetFateTransition/HeartBurstPool, owned and ticked every frame by
// PlanetSeedingVfxSystem, which also owns the sequencing between this (Leg
// A) and PlanetFateTransition (Leg B).
export class PlanetSpinTransition {
  private _currentPos = new Vector3();
  private _currentRadius = SEEDING_PLANET_RADIUS;
  private _spinAngle = 0;
  // Angular speed at the current frame, normalized 0-1 against
  // MAX_SPIN_SPEED — read by PlanetSpinSynth to drive its pitch/gain ramp in
  // lockstep with the visual spin.
  private _angularSpeedNorm = 0;

  private _active = false;
  private _started = false;
  private _elapsed = 0;

  private _growFromPos = new Vector3();
  private _growFromRadius = SEEDING_PLANET_RADIUS;
  private _growEndD = 0;
  private _faceRef!: Vector3;
  private _growEndDir!: Vector3;

  private _scratchDir0 = new Vector3();
  private _scratchDir = new Vector3();

  build(planetPosition: Float32Array): void {
    this._currentPos.fromArray(planetPosition);
    this._currentRadius = SEEDING_PLANET_RADIUS;
    this._spinAngle = 0;
    this._angularSpeedNorm = 0;

    this._faceRef = new Vector3(0, INTERMEDIATE_PLANET_CENTER[1], 0);
    const endOffset = new Vector3(...INTERMEDIATE_PLANET_CENTER).sub(this._faceRef);
    this._growEndD = endOffset.length() - INTERMEDIATE_PLANET_RADIUS;
    this._growEndDir = endOffset.normalize();
  }

  start(): void {
    this._elapsed = 0;
    this._active = true;
    this._started = true;
    this._growFromPos.copy(this._currentPos);
    this._growFromRadius = this._currentRadius;
    this._spinAngle = 0;
  }

  update(delta: number): void {
    if (!this._active) {
      this._angularSpeedNorm = 0;
      return;
    }
    this._elapsed += delta;

    const s = Math.min(1, this._elapsed / SPIN_DURATION);
    const eased = smoothstep(s);

    this._scratchDir0.copy(this._growFromPos).sub(this._faceRef);
    const startD = this._scratchDir0.length() - this._growFromRadius;
    this._scratchDir0.normalize();
    this._scratchDir.copy(this._scratchDir0).lerp(this._growEndDir, eased);
    if (this._scratchDir.lengthSq() > 1e-8) this._scratchDir.normalize();

    const d = startD + (this._growEndD - startD) * eased;
    const radius = this._growFromRadius + (INTERMEDIATE_PLANET_RADIUS - this._growFromRadius) * eased;
    const centerDist = d + radius;

    this._currentPos.copy(this._faceRef).addScaledVector(this._scratchDir, centerDist);
    this._currentRadius = radius;

    this._angularSpeedNorm = Math.sin(Math.PI * s);
    this._spinAngle += MAX_SPIN_SPEED * this._angularSpeedNorm * delta;

    if (s >= 1) {
      this._active = false;
      this._angularSpeedNorm = 0;
    }
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
  getCurrentRotationY(): number {
    return this._spinAngle;
  }
  // 0-1, normalized against MAX_SPIN_SPEED — for PlanetSpinSynth's pitch ramp.
  getAngularSpeedNorm(): number {
    return this._angularSpeedNorm;
  }
  // Raw 0-1 elapsed/SPIN_DURATION progress — for the civilization-forming
  // reveal (see FateEventVfxSystem).
  getProgress(): number {
    return this._active ? Math.min(1, this._elapsed / SPIN_DURATION) : this._started ? 1 : 0;
  }

  reset(planetPosition: Float32Array): void {
    this._currentPos.fromArray(planetPosition);
    this._currentRadius = SEEDING_PLANET_RADIUS;
    this._active = false;
    this._started = false;
    this._elapsed = 0;
    this._spinAngle = 0;
    this._angularSpeedNorm = 0;
  }
}
