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

// Bumped from 6.5 — this is now the ENTIRE window PlanetGrowthPool has to
// grow every colored cell's plant from nothing up to full size (see its own
// activate()/update()), not just a second growth stage on top of plants
// already grown during Seeding — a slower, more legible "many years later"
// needs more room than the old two-stage version did.
const SPIN_DURATION = 11;
// Peak angular speed (rad/s), reached once spinEnvelope ramps up — see its
// own comment below. Pulled way down from 7 (over 1 full turn/sec at peak,
// plus the old linear ramp-up — see spinEnvelope's own comment — read as a
// toy engine revving rather than a planet turning) — this is now a slow,
// stately turn even at its peak.
const MAX_SPIN_SPEED = 2.2;

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

// Was a symmetric MAX_SPIN_SPEED*sin(pi*s) hump (rise from 0, peak at
// s=0.5, ease back to exactly 0 by s=1) — self-terminating, but it meant the
// spin was already slowing back down while PlanetGrowthPool's own plants
// were still only half-grown (their scale target rides this same raw s
// linearly — see planet-growth-pool.ts's update()). Per design: the spin
// should instead keep ramping up "as the plants get bigger," matching that
// same linear growth curve, only easing to a stop right at the very end so
// the transition still lands cleanly rather than cutting off at full speed.
// The rise itself is smoothstep, not linear — a straight linear ramp reads
// as a mechanical "revving" climb; easing it keeps the whole build (visual
// spin AND PlanetSpinSynth's pitch, which rides this same value) gentler
// and less cartoonish.
const SPIN_RAMP_DOWN_START = 0.85; // fraction of s where the final stop begins
function spinEnvelope(s: number): number {
  if (s < SPIN_RAMP_DOWN_START) return smoothstep(s / SPIN_RAMP_DOWN_START);
  const tailT = (s - SPIN_RAMP_DOWN_START) / (1 - SPIN_RAMP_DOWN_START);
  return 1 - smoothstep(tailT);
}

// Total angle (rad) this transition's spin adds by the time it fully
// settles — a fixed constant regardless of the STARTING angle it's synced
// from (syncCurrentRotation), since it's purely the integral of
// MAX_SPIN_SPEED*spinEnvelope(s) over the transition's own duration.
// Numerically integrated (not hand-derived via calculus) so it stays
// correct automatically if MAX_SPIN_SPEED/SPIN_DURATION/spinEnvelope's
// shape are ever retuned again. PlanetSeedingVfxSystem uses this to
// predict the mesh's FINAL rotation before this transition even starts
// (see its own _applyHumanZoneExclusion) — the only way to decide which
// cells will end up under Fate Events' crowd before plants have already
// grown there, since the transition's actual current rotation while it's
// running still has this much left to add.
const ROTATION_INTEGRATION_STEPS = 2000;
export const TOTAL_ROTATION_DELTA = (() => {
  let sum = 0;
  for (let i = 0; i < ROTATION_INTEGRATION_STEPS; i++) {
    sum += spinEnvelope((i + 0.5) / ROTATION_INTEGRATION_STEPS);
  }
  return MAX_SPIN_SPEED * SPIN_DURATION * (sum / ROTATION_INTEGRATION_STEPS);
})();

// Same "blend direction+distance from a fixed face-reference point, land
// exactly on a fixed end state" technique PlanetFateTransition uses, plus a
// self-terminating spin (see spinEnvelope above). Not a System — same
// explicitly-driven idiom (build/start/update/reset) as
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

  // Overwrites _currentPos/_currentRadius directly, without touching
  // _active/_started/_elapsed — for when Seeding's own live head-following
  // planet (see planet-seeding-system.ts) has been driving the mesh up to
  // this point. Without this, start() would snapshot whatever stale
  // position this instance last held from build() (its own construction-
  // time default), causing a visible jump instead of continuing smoothly
  // from wherever the player actually left the planet floating. Call once,
  // immediately before start().
  syncCurrentState(planetPosition: Float32Array, radius: number): void {
    this._currentPos.fromArray(planetPosition);
    this._currentRadius = radius;
  }

  // Same idiom as syncCurrentState above, for rotation: Seeding's own
  // live-following planet (see PlanetSeedingSystem.getSpinAngle())
  // already turns slowly in place before Leg A ever starts — without this,
  // start() would snap the spin back to angle 0, a visible jump right as the
  // transition begins. Call once, immediately before start().
  syncCurrentRotation(radiansY: number): void {
    this._spinAngle = radiansY;
  }

  start(): void {
    this._elapsed = 0;
    this._active = true;
    this._started = true;
    this._growFromPos.copy(this._currentPos);
    this._growFromRadius = this._currentRadius;
    // _spinAngle is deliberately NOT reset here — see syncCurrentRotation's
    // own comment; it must already carry whatever angle the caller synced
    // in immediately before this call.
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

    this._angularSpeedNorm = spinEnvelope(s);
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
