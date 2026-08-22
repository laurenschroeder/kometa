import { createSystem, Vector3 } from '@iwsdk/core';
import { CometBody } from '../../comet/comet-body-component.js';
import { HandAnchor } from '../../comet/hand-anchor-component.js';
import { getGlobals } from '../../core/globals.js';
import { placeDots, placePlanets } from '../../vfx/geometry/weave-path.js';
import { StardustSystem } from '../stardust/stardust-system.js';

// Dropped from 9 to 6 (about a third fewer) and the ring pulled in to
// match (was 1.3) — a smaller loop to walk, not just a sparser one at the
// old radius. Roughly preserves the old inter-planet spacing rather than
// leaving 9-planet-sized gaps between only 6 planets.
export const N_PLANETS = 6;
export const N_DOTS = 120;
// Halved again (was 0.9).
export const RING_RADIUS = 0.45;
export const RING_CENTER_Y = 1.2;
export const WEAVE_AMPLITUDE = 0.3;
export const PLANET_RADIUS = 0.11;
const DOT_TOUCH_RADIUS = 0.09;
// How close a hand must be to a planet for that planet to "accept" dust —
// deliberately larger than DOT_TOUCH_RADIUS (a general presence check, not
// a precise touch) but well under half the ~0.9m gap between neighboring
// planets, so mostly one planet is "near" at a time as the player walks
// the loop rather than several at once.
const NEAR_PLANET_RADIUS = 0.4;
// Minimum time between two dust landings on the SAME planet, only ticking
// down while a hand is near it — this is what makes seeding a slow,
// visible-per-planet trickle keyed to where the player actually is,
// instead of a global timer dumping dust everywhere at once.
const LAUNCH_COOLDOWN = 0.35;

interface QueueItem {
  particleIndex: number;
}

export interface LaunchEvent {
  particleIndex: number;
  targetPlanet: number;
}

// Gameplay for Chapter 3: the stardust carried in from Chapter 1 (still
// riding the hand trails — see StardustVfxSystem's gamePhase-driven
// visibility) gets "spent" here, migrating onto 9 ring-arranged planets —
// one planet's queue at a time, only while a hand is near THAT planet, at
// a cooldown-limited trickle (see PlanetSeedingVfxSystem for the actual
// flight/landing animation and stain-growth effect). The player's own task
// this phase is tracing a dotted line that weaves over/under the planets
// by touch — a full loop traced is the win condition. Pure simulation
// here: no mesh or entity creation happens in this file (see
// PlanetSeedingVfxSystem), only ring/dot layout math, touch-detection, and
// the per-planet migration queues/cooldowns.
export class PlanetSeedingSystem extends createSystem({
  hands: { required: [CometBody, HandAnchor] },
}) {
  private _stardust!: StardustSystem;

  private _planetPositions!: Float32Array;
  private _dotPositions!: Float32Array;
  private _dotTouched!: Uint8Array;
  private _touchedCount = 0;

  // One migration queue per planet, built fresh every play() from whatever
  // stardust is currently captured (round-robin assigned across planets for
  // even distribution) — small (~N_STARDUST/9 each), rebuilt once per
  // phase entry, not a per-frame cost.
  private _planetQueues: QueueItem[][] = [];
  private _planetCooldown!: Float32Array;
  private _dustPerPlanet!: Uint8Array;
  private _pendingCount = 0;

  // Per-frame scratch — which planets a hand is currently near. Reset each
  // update(), not reallocated.
  private _nearPlanet!: Uint8Array;

  // This frame's drained launch events. Reassigned (not mutated in place)
  // only on frames where at least one launch actually happens — during
  // steady-state play this allocates nothing most frames; the one
  // exception is stop()'s force-drain, a single one-time per-phase-
  // transition burst, not a sustained per-frame cost.
  private _launchBatch: LaunchEvent[] = [];

  private _scratchHandPos!: Vector3;

  init(): void {
    this._stardust = this.world.getSystem(StardustSystem)!;

    this._planetPositions = placePlanets(N_PLANETS, RING_RADIUS, RING_CENTER_Y);
    this._dotPositions = placeDots(N_DOTS, {
      ringRadius: RING_RADIUS,
      centerY: RING_CENTER_Y,
      amplitude: WEAVE_AMPLITUDE,
      planetCount: N_PLANETS,
    });
    this._dotTouched = new Uint8Array(N_DOTS);

    this._planetQueues = Array.from({ length: N_PLANETS }, () => []);
    this._planetCooldown = new Float32Array(N_PLANETS);
    this._dustPerPlanet = new Uint8Array(N_PLANETS);
    this._nearPlanet = new Uint8Array(N_PLANETS);

    this._scratchHandPos = new Vector3();
  }

  // Rebuilds the per-planet migration queues from whatever stardust is
  // currently captured, and resets the dotted-line's touched state — a
  // fresh Seeding attempt every time this phase is (re-)entered.
  play(): void {
    super.play();
    this._dotTouched.fill(0);
    this._touchedCount = 0;
    this._planetCooldown.fill(0);
    for (const queue of this._planetQueues) queue.length = 0;

    const captured = this._stardust.getCapturedIndices();
    let q = 0;
    for (let i = 0; i < captured.length; i++, q++) {
      this._planetQueues[q % N_PLANETS].push({ particleIndex: captured[i] });
    }
    for (let p = 0; p < N_PLANETS; p++) this._dustPerPlanet[p] = this._planetQueues[p].length;
    this._pendingCount = q;
  }

  // Force-drains every planet's remaining queue in one synchronous pass, so
  // no captured stardust is ever orphaned mid-trail if the phase ends (by
  // timeout or win) before the player has visited every planet.
  // GameDirectorSystem calls stop() at priority 0, before any priority-30+
  // system runs that same frame, so this is safe/deterministic.
  stop(): void {
    super.stop();
    if (this._pendingCount === 0) return;
    for (let p = 0; p < N_PLANETS; p++) {
      const queue = this._planetQueues[p];
      while (queue.length > 0) this._launchFrom(p, queue.pop()!);
    }
    this._pendingCount = 0;
  }

  update(delta: number): void {
    this._nearPlanet.fill(0);

    for (const entity of this.queries.hands.entities) {
      const posView = entity.getVectorView(CometBody, 'position') as Float32Array;
      this._scratchHandPos.fromArray(posView);

      for (let d = 0; d < N_DOTS; d++) {
        if (this._dotTouched[d]) continue;
        const dx = this._dotPositions[d * 3] - this._scratchHandPos.x;
        const dy = this._dotPositions[d * 3 + 1] - this._scratchHandPos.y;
        const dz = this._dotPositions[d * 3 + 2] - this._scratchHandPos.z;
        if (dx * dx + dy * dy + dz * dz <= DOT_TOUCH_RADIUS * DOT_TOUCH_RADIUS) {
          this._dotTouched[d] = 1;
          this._touchedCount++;
        }
      }

      for (let p = 0; p < N_PLANETS; p++) {
        if (this._nearPlanet[p]) continue;
        const dx = this._planetPositions[p * 3] - this._scratchHandPos.x;
        const dy = this._planetPositions[p * 3 + 1] - this._scratchHandPos.y;
        const dz = this._planetPositions[p * 3 + 2] - this._scratchHandPos.z;
        if (dx * dx + dy * dy + dz * dz <= NEAR_PLANET_RADIUS * NEAR_PLANET_RADIUS) {
          this._nearPlanet[p] = 1;
        }
      }
    }

    if (this._touchedCount >= N_DOTS) {
      getGlobals(this.world).phaseComplete.value = true;
    }

    if (this._pendingCount > 0) {
      for (let p = 0; p < N_PLANETS; p++) {
        if (this._planetCooldown[p] > 0) {
          this._planetCooldown[p] = Math.max(0, this._planetCooldown[p] - delta);
        }
        if (!this._nearPlanet[p] || this._planetCooldown[p] > 0) continue;
        const queue = this._planetQueues[p];
        if (queue.length === 0) continue;
        this._launchFrom(p, queue.pop()!);
        this._planetCooldown[p] = LAUNCH_COOLDOWN;
        this._pendingCount--;
      }
    }
  }

  private _launchFrom(planet: number, item: QueueItem): void {
    this._stardust.releaseCaptured(item.particleIndex);
    this._launchBatch.push({ particleIndex: item.particleIndex, targetPlanet: planet });
  }

  // Read-only accessors for PlanetSeedingVfxSystem — callers must not mutate.
  getPlanetPositions(): Float32Array {
    return this._planetPositions;
  }
  getDotPositions(): Float32Array {
    return this._dotPositions;
  }
  getDotTouched(): Uint8Array {
    return this._dotTouched;
  }
  getDustPerPlanet(): Uint8Array {
    return this._dustPerPlanet;
  }
  // Returns this frame's accumulated launch events and clears the batch.
  drainLaunchEvents(): readonly LaunchEvent[] {
    if (this._launchBatch.length === 0) return this._launchBatch;
    const events = this._launchBatch;
    this._launchBatch = [];
    return events;
  }
}
