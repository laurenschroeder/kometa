import { createSystem, Vector3 } from '@iwsdk/core';
import { CometBody } from '../../comet/comet-body-component.js';
import { HandAnchor } from '../../comet/hand-anchor-component.js';
import { getGlobals } from '../../core/globals.js';
import { MAX_SPLATS } from '../../vfx/shaders/planet-stain-material.js';
import { StardustSystem } from '../stardust/stardust-system.js';

// Kept at 1 (not deleted) so planet-growth-pool.ts — which sizes its pool
// off N_PLANETS and indexes every call by planet — needs zero internal
// changes now that Seeding only ever has one planet; every call site here
// just always passes index 0. See planet-fate-transition.ts/
// planet-seeding-vfx-system.ts for the same convention.
export const N_PLANETS = 1;
export const N_MOONS = 6;
export const PLANET_RADIUS = 0.11;
// Harmless placeholder for _planetPositionArray before the first update()
// frame ever runs (this system's update() is director-gated to Phase.Seeding
// — see index.ts — so nothing reads a "wrong" position before then; VFX's
// own build()-time snapshot just needs *some* starting value). Real position
// is driven every frame below, easing toward the player's head.
const PLANET_INITIAL_POSITION: readonly [number, number, number] = [0, 1.5, -0.6];

// The planet floats loosely in front of the player's head rather than
// sitting at a fixed world point — eased toward a target recomputed every
// frame from the live camera transform, so turning to look elsewhere slowly
// drags the planet back in front of you instead of leaving it behind.
// Bumped from 0.6 — that put the planet close enough to feel cramped right
// in front of the face, especially with orbiting moons around it needing
// room of their own; ~3 feet gives a fuller view of the whole scene.
const PLANET_FOLLOW_DISTANCE = 0.9; // ~3 feet
// Deliberately slow (1/s time-constant ~1s) — "very gentle," a loose float
// rather than a locked-to-view HUD element (contrast NotificationHudSystem's
// much tighter Follower settings).
const PLANET_FOLLOW_EASE_RATE = 1.0;

// How close a hand must get to the planet's own SURFACE (not center) to
// drop a pebble — simple proximity rather than any gesture requirement, so
// "get near it" is the whole mechanic. Bumped up from 3 inches (0.0762) —
// at that range the trigger point was basically touching the surface
// already, so the pebble's fall (sampled from the comet trail near the
// hand, see PlanetSeedingVfxSystem._launchQueued) barely had any distance
// to travel and read as just appearing on the planet rather than falling
// onto it.
const SURFACE_TRIGGER_DISTANCE = 0.2; // ~8 inches
// Pacing between drops while a hand lingers within range — without this a
// stationary hand would dump the whole queue in one frame. Scaled by the
// hand's own speed (see _fallCooldownFor) rather than fixed, so orbiting the
// planet quickly seeds faster than just holding a hand still near it — a
// near-stationary hand drops at FALL_COOLDOWN_SLOW, ramping down to
// FALL_COOLDOWN_FAST once speed reaches FALL_SPEED_FOR_FAST_COOLDOWN.
const FALL_COOLDOWN_SLOW = 0.5;
const FALL_COOLDOWN_FAST = 0.05;
const FALL_SPEED_FOR_FAST_COOLDOWN = 2.0; // m/s — a brisk swing/orbit, not a full sprint
// Half the planet's coverage cells (see CELL_DIRS) must be colored to
// complete the phase — see getCoverageFraction()/COVERAGE_WIN_FRACTION.
const COVERAGE_WIN_FRACTION = 0.5;

// Moons are grouped into 3 tilted rings of 2, radii/tilts staggered so the
// whole thing reads as a small solar system rather than one flat disc.
// Purely decorative — bumping one still flashes/chimes for the fun of it
// (see MOON_BUMP_RADIUS/COOLDOWN below), but has no effect on seeding;
// getting near the planet's own surface (see SURFACE_TRIGGER_DISTANCE) is
// the only way to seed.
const MOONS_PER_RING = 2;
const MOON_RING_RADII = [0.22, 0.3, 0.38];
const MOON_RING_TILT_DEG = [-35, 0, 35];
const MOON_BASE_ANGULAR_SPEED = 0.5; // rad/s, alternated +/- and scaled per ring below
const MOON_BUMP_RADIUS = 0.09;
const MOON_BUMP_COOLDOWN = 0.6;

// Evenly-spread unit directions across the sphere (Fibonacci lattice) — the
// planet's fixed set of "coverage cells." A landing is assigned to whichever
// cell direction it's nearest to; once a cell has received one landing it's
// permanently "colored" (see PlanetSeedingSystem.play()/_dropPebble) and
// never reassigned to a different cell — this is what keeps a colored patch
// from ever disappearing, unlike the old shader ring-buffer design. Count
// must match planet-stain-material.ts's MAX_SPLATS (the shader's uniform
// arrays are sized to it, one permanent slot per cell).
function buildFibonacciSphere(count: number): Float32Array {
  const out = new Float32Array(count * 3);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = count > 1 ? 1 - (i / (count - 1)) * 2 : 0;
    const radiusAtY = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = goldenAngle * i;
    out[i * 3] = Math.cos(theta) * radiusAtY;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = Math.sin(theta) * radiusAtY;
  }
  return out;
}
const CELL_DIRS = buildFibonacciSphere(MAX_SPLATS);

interface QueueItem {
  particleIndex: number;
}

export interface LaunchEvent {
  particleIndex: number;
  // Which coverage cell this landing claimed/refreshed, and the exact local
  // unit direction it lands at — see PlanetSeedingVfxSystem's _launchQueued/
  // _addSplat, which write straight into that cell's own permanent shader
  // slot rather than a rotating ring-buffer index.
  cellIndex: number;
  dirX: number;
  dirY: number;
  dirZ: number;
}

// Gameplay for Chapter 3: the stardust carried in from Chapter 1 (still
// riding the hand trails — see StardustVfxSystem's gamePhase-driven
// visibility) gets "spent" here onto a single planet that floats loosely in
// front of the player's head (see PLANET_FOLLOW_DISTANCE/EASE_RATE).
// Getting a hand within range (see SURFACE_TRIGGER_DISTANCE) of the
// planet's own surface drops a pebble off the comet, which falls under
// gravity and lands as a colored patch (see SURFACE_TRIGGER_DISTANCE/
// _fallCooldownFor and PlanetSeedingVfxSystem for the actual fall animation/
// stain rendering) — the faster the hand is moving when it triggers a drop,
// the sooner the next one is allowed, so orbiting the planet quickly seeds
// it faster than just holding a hand still near the surface. Moons still
// orbit and flash when bumped, but are decoration only. The
// phase completes once half the planet's fixed coverage cells have been
// colored (see CELL_DIRS/COVERAGE_WIN_FRACTION/getCoverageFraction) — not
// simply once the stardust queue empties, so a player can run out of
// captured stardust before finishing (the phase's own timeoutSeconds in
// index.ts is the safety net for that). Pure simulation here: no mesh or
// entity creation happens in this file (see PlanetSeedingVfxSystem), only
// planet/moon layout math, proximity-detection, and the stardust queue.
export class PlanetSeedingSystem extends createSystem({
  hands: { required: [CometBody, HandAnchor] },
}) {
  private _stardust!: StardustSystem;

  private _planetPositionArray!: Float32Array;
  private _camPos!: Vector3;
  private _camFwd!: Vector3;
  private _followTarget!: Vector3;

  // Per-moon orbit parameters, precomputed once in init() — a fixed
  // (radius, U, W, angularSpeed) tuple per moon, U/W being an orthonormal
  // basis spanning that moon's (possibly tilted) orbital plane. Advanced
  // with pure scalar math every frame, no allocation. Orbit center is the
  // planet's own LIVE position (_planetPositionArray), not a fixed point.
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
  private _fallCooldown = 0;

  // Which of CELL_DIRS' coverage cells have been colored — see _dropPebble.
  private _cellColored!: Uint8Array;
  private _coloredCount = 0;

  // This frame's drained launch/bump events. Reassigned (not mutated in
  // place) only on frames where something actually happens — steady-state
  // play allocates nothing most frames; the one exception is stop()'s
  // force-drain, a single one-time per-phase-transition burst.
  private _launchBatch: LaunchEvent[] = [];
  private _bumpBatch: number[] = [];

  private _scratchHandPos!: Vector3;

  init(): void {
    this._stardust = this.world.getSystem(StardustSystem)!;

    this._planetPositionArray = new Float32Array(PLANET_INITIAL_POSITION);
    this._camPos = new Vector3();
    this._camFwd = new Vector3();
    this._followTarget = new Vector3();

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

    this._cellColored = new Uint8Array(MAX_SPLATS);
    this._scratchHandPos = new Vector3();
  }

  // Rebuilds the stardust queue from whatever is currently captured, resets
  // moon orbit angles/cooldowns, the coverage cells, and the planet back to
  // its default float spot (it'll ease back in front of the player within
  // the first second or so) — a fresh Seeding attempt every time this phase
  // is (re-)entered.
  play(): void {
    super.play();
    this._planetPositionArray.set(PLANET_INITIAL_POSITION);
    this._moonAngle.fill(0);
    this._moonCooldown.fill(0);
    this._fallCooldown = 0;
    this._stardustQueue.length = 0;
    this._cellColored.fill(0);
    this._coloredCount = 0;

    const captured = this._stardust.getCapturedIndices();
    for (let i = 0; i < captured.length; i++) {
      this._stardustQueue.push({ particleIndex: captured[i] });
    }
    this._pendingCount = this._stardustQueue.length;
  }

  // Force-drains the remaining queue in one synchronous pass, so no
  // captured stardust is ever orphaned mid-trail if the phase ends (by
  // timeout or win) before it's all been spent. GameDirectorSystem calls
  // stop() at priority 0, before any priority-30+ system runs that same
  // frame, so this is safe/deterministic.
  stop(): void {
    super.stop();
    if (this._pendingCount === 0) return;
    while (this._stardustQueue.length > 0) this._dropPebble(this._stardustQueue.pop()!);
    this._pendingCount = 0;
  }

  update(delta: number): void {
    this._updatePlanetPosition(delta);
    this._updateMoons(delta);

    if (this._fallCooldown > 0) {
      this._fallCooldown = Math.max(0, this._fallCooldown - delta);
    }

    if (this._pendingCount > 0) {
      for (const entity of this.queries.hands.entities) {
        const posView = entity.getVectorView(CometBody, 'position') as Float32Array;
        this._scratchHandPos.fromArray(posView);

        // Moons: proximity flash only, no stardust interaction — see the
        // class comment and MOON_BUMP_RADIUS's own comment above.
        for (let i = 0; i < N_MOONS; i++) {
          if (this._moonCooldown[i] > 0) continue;
          const mdx = this._moonPositions[i * 3] - this._scratchHandPos.x;
          const mdy = this._moonPositions[i * 3 + 1] - this._scratchHandPos.y;
          const mdz = this._moonPositions[i * 3 + 2] - this._scratchHandPos.z;
          if (mdx * mdx + mdy * mdy + mdz * mdz <= MOON_BUMP_RADIUS * MOON_BUMP_RADIUS) {
            this._moonCooldown[i] = MOON_BUMP_COOLDOWN;
            this._bumpBatch.push(i);
          }
        }

        if (this._fallCooldown <= 0) {
          const pdx = this._scratchHandPos.x - this._planetPositionArray[0];
          const pdy = this._scratchHandPos.y - this._planetPositionArray[1];
          const pdz = this._scratchHandPos.z - this._planetPositionArray[2];
          const distToCenter = Math.sqrt(pdx * pdx + pdy * pdy + pdz * pdz);
          if (distToCenter - PLANET_RADIUS <= SURFACE_TRIGGER_DISTANCE) {
            const inv = distToCenter > 1e-5 ? 1 / distToCenter : 0;
            this._dropPebble(this._stardustQueue.pop()!, pdx * inv, pdy * inv, pdz * inv);
            const velView = entity.getVectorView(CometBody, 'velocity') as Float32Array;
            this._fallCooldown = this._fallCooldownFor(
              Math.sqrt(velView[0] * velView[0] + velView[1] * velView[1] + velView[2] * velView[2]),
            );
            if (this._pendingCount === 0) break;
          }
        }
      }
    }
  }

  private _updatePlanetPosition(delta: number): void {
    this.camera.getWorldPosition(this._camPos);
    this.camera.getWorldDirection(this._camFwd);
    this._followTarget.copy(this._camPos).addScaledVector(this._camFwd, PLANET_FOLLOW_DISTANCE);

    const pull = 1 - Math.exp(-PLANET_FOLLOW_EASE_RATE * delta);
    this._planetPositionArray[0] += (this._followTarget.x - this._planetPositionArray[0]) * pull;
    this._planetPositionArray[1] += (this._followTarget.y - this._planetPositionArray[1]) * pull;
    this._planetPositionArray[2] += (this._followTarget.z - this._planetPositionArray[2]) * pull;
  }

  // Linearly ramps from FALL_COOLDOWN_SLOW down to FALL_COOLDOWN_FAST as the
  // triggering hand's speed goes from 0 to FALL_SPEED_FOR_FAST_COOLDOWN —
  // clamped at both ends, so drifting past top speed doesn't drop pebbles
  // faster than FALL_COOLDOWN_FAST allows.
  private _fallCooldownFor(speed: number): number {
    const t = Math.min(1, Math.max(0, speed / FALL_SPEED_FOR_FAST_COOLDOWN));
    return FALL_COOLDOWN_SLOW + (FALL_COOLDOWN_FAST - FALL_COOLDOWN_SLOW) * t;
  }

  private _updateMoons(delta: number): void {
    for (let i = 0; i < N_MOONS; i++) {
      this._moonAngle[i] += this._moonAngularSpeed[i] * delta;
      const cos = Math.cos(this._moonAngle[i]);
      const sin = Math.sin(this._moonAngle[i]);
      const r = this._moonRadius[i];
      this._moonPositions[i * 3] =
        this._planetPositionArray[0] + r * (cos * this._moonU[i * 3] + sin * this._moonW[i * 3]);
      this._moonPositions[i * 3 + 1] =
        this._planetPositionArray[1] + r * (cos * this._moonU[i * 3 + 1] + sin * this._moonW[i * 3 + 1]);
      this._moonPositions[i * 3 + 2] =
        this._planetPositionArray[2] + r * (cos * this._moonU[i * 3 + 2] + sin * this._moonW[i * 3 + 2]);

      if (this._moonCooldown[i] > 0) {
        this._moonCooldown[i] = Math.max(0, this._moonCooldown[i] - delta);
      }
    }
  }

  // Pops one item off the queue, assigns it to whichever coverage cell its
  // landing direction is nearest to, and — only the first time that cell is
  // ever hit — marks it colored and checks the win condition. A later
  // landing on an already-colored cell still visually falls/refreshes that
  // same permanent splat slot (see LaunchEvent's own comment) but doesn't
  // count toward coverage again. dirX/Y/Z default to straight "down" for
  // stop()'s force-drain, which has no real hand position to derive a
  // landing point from — any direction is fine there since the phase is
  // already ending.
  private _dropPebble(item: QueueItem, dirX = 0, dirY = -1, dirZ = 0): void {
    this._stardust.releaseCaptured(item.particleIndex);
    this._pendingCount--;

    let best = 0;
    let bestDot = -Infinity;
    for (let c = 0; c < MAX_SPLATS; c++) {
      const dot = dirX * CELL_DIRS[c * 3] + dirY * CELL_DIRS[c * 3 + 1] + dirZ * CELL_DIRS[c * 3 + 2];
      if (dot > bestDot) {
        bestDot = dot;
        best = c;
      }
    }

    if (!this._cellColored[best]) {
      this._cellColored[best] = 1;
      this._coloredCount++;
      if (this._coloredCount >= Math.ceil(MAX_SPLATS * COVERAGE_WIN_FRACTION)) {
        getGlobals(this.world).phaseComplete.value = true;
      }
    }

    this._launchBatch.push({ particleIndex: item.particleIndex, cellIndex: best, dirX, dirY, dirZ });
  }

  // Read-only accessors for PlanetSeedingVfxSystem — callers must not mutate.
  getPlanetPositions(): Float32Array {
    return this._planetPositionArray;
  }
  getMoonPositions(): Float32Array {
    return this._moonPositions;
  }
  // 0-1 fraction of coverage cells colored so far — drives the volatile-
  // gasses atmosphere glow's intensity (see PlanetSeedingVfxSystem).
  getCoverageFraction(): number {
    return this._coloredCount / MAX_SPLATS;
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
