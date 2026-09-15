import { createSystem, Entity, Vector3 } from '@iwsdk/core';
import { CometBody } from '../../comet/comet-body-component.js';
import { CometTrail } from '../../comet/comet-trail-component.js';
import { CometTrailSystem } from '../../comet/comet-trail-system.js';
import { HandAnchor } from '../../comet/hand-anchor-component.js';
import { getGlobals } from '../../core/globals.js';
import { SEEDING_INTRO_TEXT } from '../../core/notification-copy.js';
import { NotificationHudSystem } from '../../core/notification-hud-system.js';
import { ORGANIC_PALETTE } from '../../vfx/color/color-scheme.js';
import { sampleTrailOffset } from '../../vfx/particles/trail-sampler.js';
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
// room of their own; ~3 feet gives a fuller view of the whole scene. Pulled
// in ~2 inches (to 0.85), then another ~3 inches (to 0.77) to sit closer to
// the head.
const PLANET_FOLLOW_DISTANCE = 0.77; // ~3 feet minus ~5 inches
// Deliberately slow — "very gentle," a loose float rather than a locked-to-
// view HUD element (contrast NotificationHudSystem's much tighter Follower
// settings). Slowed further from 1.0 (a ~1s time-constant, essentially
// arrived within a couple seconds) — Seeding's own entry notification
// (PebbleWeavingSystem's pebbleCompletionMessage, ~4.5s total on-screen:
// FADE_SECONDS*2 + its 3.5s holdSeconds) used to finish while the planet was
// already basically in place. At 0.08 the planet is only ~30% of the way to
// its resting spot by the time that message fades out — reads as "the
// planet is still drifting in" through the whole notification, not already
// arrived and waiting.
const PLANET_FOLLOW_EASE_RATE = 0.08;

// How close a hand must get to the planet's own SURFACE (not center) to
// drop a pebble — simple proximity rather than any gesture requirement, so
// "get near it" is the whole mechanic. Bumped up from 8 inches (0.2) — the
// fall origin is sampled from the comet trail near the hand (see
// _sampleDropOrigin), so a tight trigger radius meant the
// hand (and thus the comet) was already right on top of the planet the
// moment a pebble launched, leaving barely any distance to actually fall.
// First tried 1.0 (~3.3ft), but that let a nearly-stationary hand keep
// triggering drops without ever needing to move around the surface — with a
// direction that barely changes, repeat drops kept re-coloring the SAME
// already-colored coverage cell (see _dropPebble) instead of spreading to
// new ones, so the finite stardust queue could run out (see _pendingCount)
// well before reaching COVERAGE_WIN_FRACTION, softlocking the phase until
// its timeoutSeconds safety net (index.ts) finally kicked in. 16 inches
// keeps a noticeably longer fall than the original 8 without losing the
// "orbit the surface to spread coverage" requirement that makes the queue
// budget actually sufficient to win.
const SURFACE_TRIGGER_DISTANCE = 0.4; // ~16 inches
// A falling pebble starts from its own spot on the comet's tail, which can
// trail behind the hand through the planet. A drop whose start is inside the
// planet (or within this of its surface) waits instead of spawning there —
// the tail position is re-checked next frame. See _sampleDropOrigin.
const ORIGIN_MIN_SURFACE_CLEARANCE = 0.02;
// Pacing between drops while a hand lingers within range — without this a
// stationary hand would dump the whole queue in one frame. Scaled by the
// hand's own speed (see _fallCooldownFor) rather than fixed, so orbiting the
// planet quickly seeds faster than just holding a hand still near it — a
// near-stationary hand drops at FALL_COOLDOWN_SLOW, ramping down to
// FALL_COOLDOWN_FAST once speed reaches FALL_SPEED_FOR_FAST_COOLDOWN.
// FAST bumped from 0.05 — that let a brisk swing drop pebbles up to 20/sec,
// which (combined with the old COVERAGE_WIN_FRACTION) let the phase finish
// almost instantly and read as chaotic rather than a gradual "watch the
// planet fill in" reveal. SLOW nudged up slightly to match.
const FALL_COOLDOWN_SLOW = 0.6;
const FALL_COOLDOWN_FAST = 0.18;
const FALL_SPEED_FOR_FAST_COOLDOWN = 2.0; // m/s — a brisk swing/orbit, not a full sprint
// The planet is a fixed grid of coverage cells (see CELL_DIRS) — winning
// means filling in (almost) every one, so the player visibly clears the
// whole grid rather than leaving scattered gaps. Bumped from 0.7 (itself
// bumped from 0.5 — see git history) now that each cell also doubles as a
// future plant's growth slot (see planet-growth-pool.ts's activate()): an
// uncolored cell would mean a bare gap in the "many years later" bloom, not
// just an incomplete stain. No longer a flat 1.0 — with MAX_SPLATS doubled
// to 80 (see planet-stain-material.ts) and UNCOLORED_BIAS_MIN_DOT tightened
// (below) so a landing actually lands near where the pebble fell, the very
// last cell or two can end up on a stretch of the sphere that's only ever
// briefly in reach as the ambient spin carries it past — requiring literally
// every cell made those last couple feel (and sometimes actually be) stuck.
// Leaving room for a couple of misses keeps "clear the whole grid" as the
// read without that endgame becoming a war of attrition against the spin's
// own timing.
const COVERAGE_WIN_FRACTION = (MAX_SPLATS - 2) / MAX_SPLATS;
// A repeat landing whose globally-nearest cell is already colored instead
// prefers the nearest still-UNCOLORED cell, as long as one exists within
// this angular range — see _dropPebble's own comment for why: without this,
// a hand orbiting in a narrow band keeps re-landing on the SAME
// already-colored nearest cell forever (its direction barely changes),
// draining the whole stardust queue while _coloredCount stays flat well
// short of COVERAGE_WIN_FRACTION — the phase then just sits there until the
// timeout safety net kicks in, reading as "stuck." Narrowed from 0.0 (a full
// hemisphere) to ~50°: at 0.0 a pebble could be sent to a cell up to 90° from
// where the hand dropped it, so the falling pebble and the dot it left
// stopped reading as cause and effect. First tried 35°, but combined with
// the doubled grid (MAX_SPLATS=80, so cells sit closer together) that made
// the last few stragglers hard to reach — 50° still keeps landings visually
// close to where the pebble fell while giving a scattered leftover cell a
// wider net to be caught by. A drop with nothing uncolored nearby now just
// refreshes the nearest cell; the ambient spin (SEEDING_SPIN_SPEED) keeps
// rotating leftover cells back into reach, and COVERAGE_WIN_FRACTION no
// longer requires literally every last one anyway.
const UNCOLORED_BIAS_MIN_DOT = Math.cos((50 * Math.PI) / 180);

// Very slow ambient turn of the planet while seeding. Owned here rather than
// by PlanetSeedingVfxSystem because cells/splats live in the planet's
// rotating local frame — the hand's world-space direction has to be
// un-rotated by this same angle before picking the nearest cell, or dots
// appear far from where their pebbles actually landed.
const SEEDING_SPIN_SPEED = 0.16; // rad/s — a full turn every ~39s

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
// planet's fixed "grid": one cell per future plant. A landing is assigned to
// whichever cell direction it's nearest to; once a cell has received one
// landing it's permanently "colored" (see PlanetSeedingSystem.play()/
// _dropPebble) and never reassigned to a different cell — this is what keeps
// a colored patch from ever disappearing, unlike the old shader ring-buffer
// design. Count must match planet-stain-material.ts's MAX_SPLATS (the
// shader's uniform arrays are sized to it, one permanent slot per cell).
// Exported so planet-growth-pool.ts's own grid of plant slots lines up
// EXACTLY with these same cells — every splat that lands during Seeding
// grows into a plant at the very same point once Leg A's spin begins (see
// PlanetGrowthPool.activate()), not just a nearby approximation.
export function buildFibonacciSphere(count: number): Float32Array {
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
export const CELL_DIRS = buildFibonacciSphere(MAX_SPLATS);

interface QueueItem {
  particleIndex: number;
  // True only for entries padded in by play()'s dev-menu safety net below —
  // no real captured stardust backs this landing, so _dropPebble must skip
  // releaseCaptured() for it (particleIndex is just 0, a harmless valid read
  // index for _sampleDropOrigin's fall-origin trail sample — not a real
  // field-slot index to release).
  synthetic?: boolean;
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
  // World-space start of the fall — this pebble's tail position at drop time,
  // guaranteed outside the planet (see ORIGIN_MIN_SURFACE_CLEARANCE).
  originX: number;
  originY: number;
  originZ: number;
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
// orbit and flash when bumped, but are decoration only. The planet is a
// fixed grid of coverage cells (CELL_DIRS) doubling as future plant slots —
// every landing snaps to its nearest cell and colors it with that landing's
// own freshly-rolled color (see _cellColor/getCellColors()) — a repeat
// landing on an already-colored cell re-rolls and overwrites it. The phase
// completes once every cell has
// been colored (see COVERAGE_WIN_FRACTION/getCoverageFraction) — not simply
// once the stardust queue empties, so a player can run out of captured
// stardust before finishing (the phase's own timeoutSeconds in index.ts is
// the safety net for that). The plants themselves don't grow until later
// (see PlanetGrowthPool.activate(), fired once Leg A's spin begins) — Seeding
// only ever shows the colored grid filling in. Pure simulation here: no mesh
// or entity creation happens in this file (see PlanetSeedingVfxSystem), only
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
  private _spinAngle = 0;

  // Which of CELL_DIRS' coverage cells have been colored — see _dropPebble.
  private _cellColored!: Uint8Array;
  private _coloredCount = 0;
  // Each cell's own future-plant color (see color-scheme.ts's
  // ORGANIC_PALETTE) — rolled fresh per LANDING in _dropPebble, not upfront
  // per cell, so the spot a pebble lands on is colored by that pebble's own
  // (freshly-rolled) color rather than a color the grid already decided on
  // before any pebble ever fell. A second landing on an already-colored
  // cell overwrites it with its own new roll — see _dropPebble's own
  // comment. Whatever color a cell holds at the moment Leg A begins (its
  // LAST landing's color) is what that cell's plant grows in as (see
  // getCellColors()); uncolored cells' entries are never read.
  private _cellColor!: Float32Array;

  // This frame's drained launch/bump events. Reassigned (not mutated in
  // place) only on frames where something actually happens — steady-state
  // play allocates nothing most frames; the one exception is stop()'s
  // force-drain, a single one-time per-phase-transition burst.
  private _launchBatch: LaunchEvent[] = [];
  private _bumpBatch: number[] = [];

  private _scratchHandPos!: Vector3;
  private _trailSystem!: CometTrailSystem;
  private _notifications!: NotificationHudSystem;
  private _scratchOrigin!: Vector3;
  private _basisRight!: Vector3;
  private _basisUp!: Vector3;
  private _basisBack!: Vector3;

  init(): void {
    this._stardust = this.world.getSystem(StardustSystem)!;
    this._trailSystem = this.world.getSystem(CometTrailSystem)!;
    this._notifications = this.world.getSystem(NotificationHudSystem)!;
    this._scratchOrigin = new Vector3();
    this._basisRight = new Vector3();
    this._basisUp = new Vector3();
    this._basisBack = new Vector3();

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
    this._cellColor = new Float32Array(MAX_SPLATS * 3);
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
    this._spinAngle = 0;
    this._stardustQueue.length = 0;
    this._cellColored.fill(0);
    this._coloredCount = 0;
    this._cellColor.fill(0); // harmless — only ever read for cells _dropPebble has actually colored

    const captured = this._stardust.getCapturedIndices();
    for (let i = 0; i < captured.length; i++) {
      this._stardustQueue.push({ particleIndex: captured[i] });
    }
    // Dev-menu safety net: jumping straight to Seeding (skipping Stardust
    // entirely — see phase-menu-system.ts) leaves getCapturedIndices() at or
    // near empty, since nothing was ever actually gathered. Without this,
    // the phase silently stalls after whatever tiny handful of real
    // stardust exists runs out — well short of COVERAGE_WIN_FRACTION — and
    // just sits there until the timeout safety net eventually fires,
    // reading as "stuck" rather than an expected consequence of skipping
    // Stardust. Pad up to a normal-playthrough-sized queue with synthetic
    // entries so the phase stays winnable even when jumped to directly.
    const minQueue = Math.ceil(MAX_SPLATS * COVERAGE_WIN_FRACTION) + 15;
    while (this._stardustQueue.length < minQueue) {
      this._stardustQueue.push({ particleIndex: 0, synthetic: true });
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
    while (this._stardustQueue.length > 0) {
      this._dropPebble(this._stardustQueue.pop()!, 0, -1, 0, null);
    }
    this._pendingCount = 0;
  }

  update(delta: number): void {
    this._updatePlanetPosition(delta);
    this._updateMoons(delta);
    this._spinAngle += SEEDING_SPIN_SPEED * delta;

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
          if (
            distToCenter - PLANET_RADIUS <= SURFACE_TRIGGER_DISTANCE &&
            this._sampleDropOrigin(entity, this._stardustQueue[this._stardustQueue.length - 1])
          ) {
            const inv = distToCenter > 1e-5 ? 1 / distToCenter : 0;
            // Inverse of the mesh's rotation.y — see SEEDING_SPIN_SPEED.
            const cos = Math.cos(this._spinAngle);
            const sin = Math.sin(this._spinAngle);
            const wx = pdx * inv;
            const wz = pdz * inv;
            this._dropPebble(
              this._stardustQueue.pop()!,
              wx * cos - wz * sin,
              pdy * inv,
              wx * sin + wz * cos,
              this._scratchOrigin,
            );
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

    // Held at PLANET_INITIAL_POSITION (not easing toward the player at all)
    // until SEEDING_INTRO_TEXT has actually been shown — without this, the
    // planet started floating in the instant Phase.Seeding began, which
    // could already have it well on its way (or fully arrived, depending on
    // whatever was ahead of this text in the notification queue) before the
    // player was ever actually told to go find it, instead of the "planet
    // coming into view" beat reading as a reaction to that line.
    if (!this._notifications.hasShown(SEEDING_INTRO_TEXT)) return;

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
  // same permanent splat slot (see LaunchEvent's own comment) AND re-rolls
  // its color (see _cellColor's own comment) but doesn't count toward
  // coverage again. dirX/Y/Z (the player's actual, imprecise landing point
  // — used only to pick the nearest cell below) are straight "down" for
  // stop()'s force-drain, which has no real hand position to derive a
  // landing point from — any direction is fine there since the phase is
  // already ending. origin (the fall's world start, see _sampleDropOrigin) is
  // null there too, which skips queuing the falling-mote animation — see
  // stop()'s own comment for why.
  private _dropPebble(item: QueueItem, dirX: number, dirY: number, dirZ: number, origin: Vector3 | null): void {
    if (!item.synthetic) this._stardust.releaseCaptured(item.particleIndex);
    this._pendingCount--;

    let best = 0;
    let bestDot = -Infinity;
    let bestUncolored = -1;
    let bestUncoloredDot = -Infinity;
    for (let c = 0; c < MAX_SPLATS; c++) {
      const dot = dirX * CELL_DIRS[c * 3] + dirY * CELL_DIRS[c * 3 + 1] + dirZ * CELL_DIRS[c * 3 + 2];
      if (dot > bestDot) {
        bestDot = dot;
        best = c;
      }
      if (!this._cellColored[c] && dot > bestUncoloredDot) {
        bestUncoloredDot = dot;
        bestUncolored = c;
      }
    }
    // Prefer a nearby still-uncolored cell over the globally-nearest one
    // once that nearest cell is already colored — see UNCOLORED_BIAS_MIN_DOT's
    // own comment. The splat itself still visually lands at the real dirX/Y/Z
    // (below), just recorded under a different permanent slot.
    const target = bestUncolored >= 0 && bestUncoloredDot >= UNCOLORED_BIAS_MIN_DOT ? bestUncolored : best;

    if (!this._cellColored[target]) {
      this._cellColored[target] = 1;
      this._coloredCount++;
      if (this._coloredCount >= Math.ceil(MAX_SPLATS * COVERAGE_WIN_FRACTION)) {
        getGlobals(this.world).phaseComplete.value = true;
      }
    }

    // Never let the player get soft-locked out of finishing a nearly-
    // complete grid just because the queue ran dry — see this file's own
    // extensive history of chasing this exact "stuck in Seeding" failure
    // mode (COVERAGE_WIN_FRACTION/UNCOLORED_BIAS_MIN_DOT above). Those
    // reduce how OFTEN a landing is wasted re-coloring an already-colored
    // cell, but can't guarantee it never happens — a real playthrough can
    // still burn through its whole captured-stardust queue with a few
    // uncolored cells left, at which point update()'s own
    // `if (this._pendingCount > 0)` gate shuts off ALL further interaction
    // until the 240s phase timeout eventually bails the player out. Topping
    // the queue back up here, the instant it would otherwise hit zero short
    // of the win threshold, keeps the phase always finishable through
    // normal play. Gated on `origin` (non-null only for a real live drop,
    // see this method's own param comment) so stop()'s synchronous
    // force-drain — which already only runs once the phase is ending,
    // whether by this same win condition or by timeout — never sees its
    // own `while (this._stardustQueue.length > 0)` loop fed new entries and
    // spun forever.
    if (origin && this._pendingCount === 0 && this._coloredCount < Math.ceil(MAX_SPLATS * COVERAGE_WIN_FRACTION)) {
      const refill = 15;
      for (let i = 0; i < refill; i++) this._stardustQueue.push({ particleIndex: 0, synthetic: true });
      this._pendingCount = refill;
    }

    // This landing's own color — freshly rolled every time, including a
    // repeat landing on an already-colored cell, which overwrites whatever
    // color was there before with this one (see _cellColor's own comment).
    const [r, g, b] = ORGANIC_PALETTE[Math.floor(Math.random() * ORGANIC_PALETTE.length)];
    this._cellColor[target * 3] = r;
    this._cellColor[target * 3 + 1] = g;
    this._cellColor[target * 3 + 2] = b;

    // The pebble's actual fall target/splat center SNAPS to the cell's own
    // fixed grid direction (not the player's imprecise raw landing dir) —
    // "land in one of the spots where a plant will be," literally: every
    // dust mote visibly converges on and lands exactly on its grid point,
    // never a few degrees off to one side of it. Skipped for a force-drain
    // (see stop()) — that dumps the WHOLE remaining queue in one
    // synchronous pass, and PlanetSeedingVfxSystem's own fall animation
    // takes FLIGHT_DURATION (2.2s) per mote, which used to visibly bleed
    // into the very next phase: Constellations' own Leg A "rev up" spin
    // starts in this same frame (ConstellationsSystem.play(), called
    // right after this stop()), so a big leftover queue read as motes
    // still raining onto a planet that was already rising and spinning
    // away — easy to mistake for something spawning in that shouldn't be.
    // The cell is still colored/counted above either way — only the
    // falling-mote visual is skipped.
    if (origin) {
      this._launchBatch.push({
        particleIndex: item.particleIndex,
        cellIndex: target,
        dirX: CELL_DIRS[target * 3],
        dirY: CELL_DIRS[target * 3 + 1],
        dirZ: CELL_DIRS[target * 3 + 2],
        originX: origin.x,
        originY: origin.y,
        originZ: origin.z,
      });
    }
  }

  // Fills _scratchOrigin with where `item` currently rides on the comet's
  // tail (the same camera-relative trail sampling every captured-mote pool
  // uses) and returns false if that spot is inside the planet — see
  // ORIGIN_MIN_SURFACE_CLEARANCE.
  private _sampleDropOrigin(entity: Entity, item: QueueItem): boolean {
    const trail = this._trailSystem.getBuffer(entity);
    if (!trail) return false;
    const field = this._stardust.getCapturedField();
    const camMatrix = this.camera.matrixWorld;
    this._basisRight.setFromMatrixColumn(camMatrix, 0);
    this._basisUp.setFromMatrixColumn(camMatrix, 1);
    this._basisBack.setFromMatrixColumn(camMatrix, 2);
    sampleTrailOffset(
      trail,
      entity.getValue(CometTrail, 'samples') as number,
      entity.getValue(CometTrail, 'stride') as number,
      field.t[item.particleIndex],
      field.dx[item.particleIndex],
      field.dy[item.particleIndex],
      field.dz[item.particleIndex],
      this._basisRight,
      this._basisUp,
      this._basisBack,
      this._scratchOrigin,
    );
    const ox = this._scratchOrigin.x - this._planetPositionArray[0];
    const oy = this._scratchOrigin.y - this._planetPositionArray[1];
    const oz = this._scratchOrigin.z - this._planetPositionArray[2];
    const minDist = PLANET_RADIUS + ORIGIN_MIN_SURFACE_CLEARANCE;
    return ox * ox + oy * oy + oz * oz > minDist * minDist;
  }

  // Read-only accessors for PlanetSeedingVfxSystem — callers must not mutate.
  getPlanetPositions(): Float32Array {
    return this._planetPositionArray;
  }
  // Ambient seeding spin (radians about Y) — the planet mesh's rotation.y
  // while seeding, and the frame cell/landing directions are expressed in.
  getSpinAngle(): number {
    return this._spinAngle;
  }
  getMoonPositions(): Float32Array {
    return this._moonPositions;
  }
  // 0-1 fraction of coverage cells colored so far — drives the volatile-
  // gasses atmosphere glow's intensity (see PlanetSeedingVfxSystem).
  getCoverageFraction(): number {
    return this._coloredCount / MAX_SPLATS;
  }
  // 0-1 overall phase progress for HandProgressHudSystem's wrist bar —
  // normalized against the actual win threshold (COVERAGE_WIN_FRACTION of
  // MAX_SPLATS), unlike getCoverageFraction above, so this reaches exactly
  // 1.0 right as the phase completes rather than plateauing at ~0.7.
  getProgress01(): number {
    return Math.min(1, this._coloredCount / Math.ceil(MAX_SPLATS * COVERAGE_WIN_FRACTION));
  }
  // Which grid cells have been colored so far — read once by
  // PlanetGrowthPool.activate() at Leg A's start to decide which of its own
  // (identically-indexed) plant slots actually grow. Read-only for callers.
  getColoredMask(): Uint8Array {
    return this._cellColored;
  }
  // Every cell's current future-plant color (see _cellColor's own comment —
  // whatever its LAST landing rolled), flat MAX_SPLATS*3 RGB — read by
  // PlanetSeedingVfxSystem (to tint a landing's dust mote/splat) and
  // PlanetGrowthPool (to tint the plant that eventually grows there).
  // Read-only for callers.
  getCellColors(): Float32Array {
    return this._cellColor;
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
