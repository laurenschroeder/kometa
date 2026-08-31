import { createSystem, Vector3 } from '@iwsdk/core';
import { CometBody } from '../../comet/comet-body-component.js';
import { HandAnchor } from '../../comet/hand-anchor-component.js';
import { getGlobals } from '../../core/globals.js';
import { StardustSystem } from '../stardust/stardust-system.js';

// Kept at 1 (not deleted) so planet-growth-pool.ts — which sizes its pool
// off N_PLANETS and indexes every call by planet — needs zero internal
// changes now that Seeding only ever has one planet; every call site here
// just always passes index 0. See planet-fate-transition.ts/
// planet-seeding-vfx-system.ts for the same convention.
export const N_PLANETS = 1;
export const N_MOONS = 6;
export const PLANET_RADIUS = 0.11;
const PLANET_HEIGHT = 1.2;
// Fixed — the single seed target sits right where the old ring's center
// used to be, so the player's spatial relationship to Seeding ("a small
// system floating around you") is unchanged even though it's now one body
// with orbiting moons instead of a ring of six.
const PLANET_POSITION: readonly [number, number, number] = [0, PLANET_HEIGHT, 0];

// Moons are grouped into 3 tilted rings of 2, radii/tilts staggered so the
// whole thing reads as a small solar system rather than one flat disc.
const MOONS_PER_RING = 2;
const MOON_RING_RADII = [0.22, 0.3, 0.38];
const MOON_RING_TILT_DEG = [-35, 0, 35];
const MOON_BASE_ANGULAR_SPEED = 0.5; // rad/s, alternated +/- and scaled per ring below
// How close a hand must get to a moon to "bump" it.
const MOON_BUMP_RADIUS = 0.09;
// Cooldown per moon after a bump — long enough that a lingering hand
// doesn't refire every frame, short enough that swinging between a couple
// of moons still feels responsive.
const MOON_BUMP_COOLDOWN = 0.6;
// How much captured stardust a single bump releases toward the planet.
const BURST_SIZE = 4;

interface QueueItem {
  particleIndex: number;
}

export interface LaunchEvent {
  particleIndex: number;
}

// Gameplay for Chapter 3: the stardust carried in from Chapter 1 (still
// riding the hand trails — see StardustVfxSystem's gamePhase-driven
// visibility) gets "spent" here onto a single planet. Moons orbit the
// planet (see comet-autopilot-system.ts's orbit math for the same
// arbitrary-plane parametric-circle formula this reuses) and act as
// "valves": bumping one launches a burst of the player's captured stardust
// toward the planet (see PlanetSeedingVfxSystem for the actual flight/
// landing animation and stain-growth effect). The phase completes once all
// captured stardust has been launched. Pure simulation here: no mesh or
// entity creation happens in this file (see PlanetSeedingVfxSystem), only
// planet/moon layout math, bump-detection, and the stardust queue.
export class PlanetSeedingSystem extends createSystem({
  hands: { required: [CometBody, HandAnchor] },
}) {
  private _stardust!: StardustSystem;

  private _planetPositionArray!: Float32Array;

  // Per-moon orbit parameters, precomputed once in init() — a fixed
  // (radius, U, W, angularSpeed) tuple per moon, U/W being an orthonormal
  // basis spanning that moon's (possibly tilted) orbital plane. Advanced
  // with pure scalar math every frame, no allocation.
  private _moonRadius!: Float32Array;
  private _moonU!: Float32Array; // N_MOONS*3
  private _moonW!: Float32Array; // N_MOONS*3
  private _moonAngularSpeed!: Float32Array;
  private _moonAngle!: Float32Array;
  private _moonPositions!: Float32Array; // N_MOONS*3, live
  private _moonCooldown!: Float32Array;

  // Single migration queue, rebuilt fresh every play() from whatever
  // stardust is currently captured — with only one planet there's no need
  // to distribute across targets, everything just goes to the one queue.
  private _stardustQueue: QueueItem[] = [];
  private _pendingCount = 0;
  // Fixed snapshot of the queue's starting size, captured once in play() —
  // unlike _pendingCount (which drains toward 0), this is the denominator
  // PlanetSeedingVfxSystem uses so the stain's coverage reaches exactly 1.0
  // once everything captured has landed.
  private _totalStardust = 0;

  // This frame's drained launch/bump events. Reassigned (not mutated in
  // place) only on frames where something actually happens — steady-state
  // play allocates nothing most frames; the one exception is stop()'s
  // force-drain, a single one-time per-phase-transition burst.
  private _launchBatch: LaunchEvent[] = [];
  private _bumpBatch: number[] = [];

  private _scratchHandPos!: Vector3;

  init(): void {
    this._stardust = this.world.getSystem(StardustSystem)!;

    this._planetPositionArray = new Float32Array(PLANET_POSITION);

    this._moonRadius = new Float32Array(N_MOONS);
    this._moonU = new Float32Array(N_MOONS * 3);
    this._moonW = new Float32Array(N_MOONS * 3);
    this._moonAngularSpeed = new Float32Array(N_MOONS);
    this._moonAngle = new Float32Array(N_MOONS);
    this._moonPositions = new Float32Array(N_MOONS * 3);
    this._moonCooldown = new Float32Array(N_MOONS);

    const u = new Vector3();
    const w = new Vector3();
    for (let i = 0; i < N_MOONS; i++) {
      const ring = Math.floor(i / MOONS_PER_RING);
      const azimuth = (i / N_MOONS) * Math.PI * 2;
      const tilt = (MOON_RING_TILT_DEG[ring] * Math.PI) / 180;

      u.set(Math.cos(azimuth), 0, Math.sin(azimuth));
      w.set(0, 1, 0).applyAxisAngle(u, tilt);

      this._moonU[i * 3] = u.x;
      this._moonU[i * 3 + 1] = u.y;
      this._moonU[i * 3 + 2] = u.z;
      this._moonW[i * 3] = w.x;
      this._moonW[i * 3 + 1] = w.y;
      this._moonW[i * 3 + 2] = w.z;
      this._moonRadius[i] = MOON_RING_RADII[ring];
      this._moonAngularSpeed[i] = MOON_BASE_ANGULAR_SPEED * (0.8 + ring * 0.2) * (i % 2 === 0 ? 1 : -1);
    }

    this._scratchHandPos = new Vector3();
  }

  // Rebuilds the stardust queue from whatever is currently captured, resets
  // moon orbit angles/cooldowns — a fresh Seeding attempt every time this
  // phase is (re-)entered.
  play(): void {
    super.play();
    this._moonAngle.fill(0);
    this._moonCooldown.fill(0);
    this._stardustQueue.length = 0;

    const captured = this._stardust.getCapturedIndices();
    for (let i = 0; i < captured.length; i++) {
      this._stardustQueue.push({ particleIndex: captured[i] });
    }
    this._pendingCount = this._stardustQueue.length;
    this._totalStardust = this._pendingCount;
  }

  // Force-drains the remaining queue in one synchronous pass, so no
  // captured stardust is ever orphaned mid-trail if the phase ends (by
  // timeout or win) before it's all been spent. GameDirectorSystem calls
  // stop() at priority 0, before any priority-30+ system runs that same
  // frame, so this is safe/deterministic.
  stop(): void {
    super.stop();
    if (this._pendingCount === 0) return;
    while (this._stardustQueue.length > 0) this._launchFrom(this._stardustQueue.pop()!);
    this._pendingCount = 0;
  }

  update(delta: number): void {
    for (let i = 0; i < N_MOONS; i++) {
      this._moonAngle[i] += this._moonAngularSpeed[i] * delta;
      const cos = Math.cos(this._moonAngle[i]);
      const sin = Math.sin(this._moonAngle[i]);
      const r = this._moonRadius[i];
      this._moonPositions[i * 3] =
        PLANET_POSITION[0] + r * (cos * this._moonU[i * 3] + sin * this._moonW[i * 3]);
      this._moonPositions[i * 3 + 1] =
        PLANET_POSITION[1] + r * (cos * this._moonU[i * 3 + 1] + sin * this._moonW[i * 3 + 1]);
      this._moonPositions[i * 3 + 2] =
        PLANET_POSITION[2] + r * (cos * this._moonU[i * 3 + 2] + sin * this._moonW[i * 3 + 2]);

      if (this._moonCooldown[i] > 0) {
        this._moonCooldown[i] = Math.max(0, this._moonCooldown[i] - delta);
      }
    }

    if (this._pendingCount > 0) {
      outer: for (const entity of this.queries.hands.entities) {
        const posView = entity.getVectorView(CometBody, 'position') as Float32Array;
        this._scratchHandPos.fromArray(posView);

        for (let i = 0; i < N_MOONS; i++) {
          if (this._moonCooldown[i] > 0) continue;
          const dx = this._moonPositions[i * 3] - this._scratchHandPos.x;
          const dy = this._moonPositions[i * 3 + 1] - this._scratchHandPos.y;
          const dz = this._moonPositions[i * 3 + 2] - this._scratchHandPos.z;
          if (dx * dx + dy * dy + dz * dz <= MOON_BUMP_RADIUS * MOON_BUMP_RADIUS) {
            this._bumpMoon(i);
            if (this._pendingCount === 0) break outer;
          }
        }
      }
    }

    if (this._pendingCount === 0) {
      getGlobals(this.world).phaseComplete.value = true;
    }
  }

  private _bumpMoon(moon: number): void {
    const count = Math.min(BURST_SIZE, this._stardustQueue.length);
    for (let k = 0; k < count; k++) this._launchFrom(this._stardustQueue.pop()!);
    this._pendingCount -= count;
    this._moonCooldown[moon] = MOON_BUMP_COOLDOWN;
    this._bumpBatch.push(moon);
  }

  private _launchFrom(item: QueueItem): void {
    this._stardust.releaseCaptured(item.particleIndex);
    this._launchBatch.push({ particleIndex: item.particleIndex });
  }

  // Read-only accessors for PlanetSeedingVfxSystem — callers must not mutate.
  getPlanetPositions(): Float32Array {
    return this._planetPositionArray;
  }
  getMoonPositions(): Float32Array {
    return this._moonPositions;
  }
  getTotalStardust(): number {
    return this._totalStardust;
  }
  // Returns this frame's accumulated launch events and clears the batch.
  drainLaunchEvents(): readonly LaunchEvent[] {
    if (this._launchBatch.length === 0) return this._launchBatch;
    const events = this._launchBatch;
    this._launchBatch = [];
    return events;
  }
  // Returns this frame's bumped-moon indices and clears the batch.
  drainBumpEvents(): readonly number[] {
    if (this._bumpBatch.length === 0) return this._bumpBatch;
    const events = this._bumpBatch;
    this._bumpBatch = [];
    return events;
  }
}
