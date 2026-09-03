import { createSystem, Vector3 } from '@iwsdk/core';
import { CometBody } from '../../comet/comet-body-component.js';
import { HandAnchor } from '../../comet/hand-anchor-component.js';
import { getGlobals } from '../../core/globals.js';
import {
  celestialSymbolMessage,
  constellationSpottedMessage,
} from '../../core/notification-copy.js';
import { NotificationHudSystem } from '../../core/notification-hud-system.js';
import {
  generateConstellationLayout,
  placeConstellationAnchorsAroundPlanet,
} from '../../vfx/geometry/constellation-path.js';
import {
  INTERMEDIATE_PLANET_CENTER,
  INTERMEDIATE_PLANET_RADIUS,
} from '../planet-seeding/planet-spin-transition.js';
import { PlanetSeedingVfxSystem } from '../planet-seeding/planet-seeding-vfx-system.js';
import { CONSTELLATION_SETS, ConstellationDef } from './constellation-set.js';

export const N_TYPES = 3;
const TOUCH_RADIUS = 0.1;

// How long this phase stays open after the trace completes, before flipping
// globals.phaseComplete — sized to let each name's own completion payoff
// actually play out (see EarthSituationsVfxSystem._onCompletion/GhostRise)
// instead of the very next frame yanking the player into Fate Events
// mid-animation. Dog/Human/Crown trigger the ghost-rise mechanic (a King-
// fall/Dog-collapse prelude for Crown/Dog, then ~4.4s of rise+travel);
// Locust reveals its swarm almost instantly; the remaining names (Bird/
// Giraffe/Horn/Tree/Bow and Arrow) have no completion payoff at all, so
// DEFAULT is just long enough to read celestialSymbolMessage's own banner
// (see notification-copy.ts) before moving on. All bumped up from their
// original values — the whole Constellations-onward stretch was reading as
// too fast-paced, so each hold now carries a couple extra seconds of buffer
// on top of its own animation length, not just the bare minimum. Deliberately
// not imported from earth-situations-vfx-system.ts/ghost-rise.ts — this file
// only needs a hold duration, not the mechanic itself, so the two stay
// decoupled (same reasoning as globals.pairedPersonIndex/pairedPersonLine).
const COMPLETION_HOLD_SECONDS: Record<string, number> = {
  Crown: 6.8,
  Dog: 6.4,
  Human: 5.8,
  Locust: 4.5,
};
const DEFAULT_COMPLETION_HOLD_SECONDS = 6.0;

// Gameplay for Chapter 2.5, staged around the planet at its INTERMEDIATE
// Constellations waypoint (Seeding runs first — see phase.ts's PHASE_ORDER —
// and this phase's own play() kicks off Leg A, the spin+recede transition
// that lands the planet there; see
// PlanetSeedingVfxSystem.startSpinTransition). The much bigger/farther zoom
// into the true Fate Events planet is Leg B, deferred until this phase ends
// (see FateEventSystem.play()). Which trio of constellations is available is
// picked from whichever pebble type was dominant in Chapter 2 (globals.
// dominantPebbleType); within that trio, play() picks ONE slot at random —
// only that single constellation is ever simulated or shown this
// playthrough, no more racing all 3. ALL 9 possible constellations' layouts
// (3 types x 3 slots) are still generated once here in init(), not just the
// active type's 3, because ConstellationsVfxSystem is always-on (like
// PlanetSeedingVfxSystem) and needs fixed geometry to build its Points
// meshes against at ITS OWN init() time, well before this phase's play()
// ever runs (dominantPebbleType/the random slot pick aren't known until
// Chapter 2 completes / this phase begins). Each constellation's stars start
// flashing and must ALL be traced (any order) to complete it — tracing the
// last one sets globals.celestialSymbol, fires the "celestial symbol"
// notification, and completes the phase. Pure simulation here: no mesh/
// entity creation happens in this file (see ConstellationsVfxSystem), only
// layout math and touch-detection.
export class ConstellationsSystem extends createSystem({
  hands: { required: [CometBody, HandAnchor] },
}) {
  // All indexed [pebbleType][slot].
  private _starPositions!: Float32Array[][];
  private _starTraced!: Uint8Array[][];
  private _tracedCount!: number[][];
  private _startedNotified!: boolean[][];

  private _activeType = 0;
  private _activeSlot = 0;
  private _completed = false;
  // Counts down once _completed flips true (see COMPLETION_HOLD_SECONDS) —
  // globals.phaseComplete isn't set until this reaches 0, so isComplete()
  // (which flips immediately) can still drive the completion payoff/hero
  // star reveal while the phase itself stays open a little longer.
  private _completionHoldRemaining = 0;
  private _scratchHandPos!: Vector3;
  private _planetSeeding!: PlanetSeedingVfxSystem;

  init(): void {
    // PlanetSeedingVfxSystem must be registered before this system (see
    // index.ts) so it already exists when this init() runs.
    this._planetSeeding = this.world.getSystem(PlanetSeedingVfxSystem)!;
    this._scratchHandPos = new Vector3();

    const anchors = placeConstellationAnchorsAroundPlanet(3, INTERMEDIATE_PLANET_CENTER, INTERMEDIATE_PLANET_RADIUS);
    // Away-from-planet unit direction per anchor — passed to
    // generateConstellationLayout so it can constrain every control point's
    // scatter to the outward hemisphere (see that function's own comment for
    // why this guarantees no star can ever end up inside the planet, even as
    // its live radius grows through Leg B). Same derivation
    // ConstellationsVfxSystem uses for its own _anchorDir.
    const center = new Vector3(...INTERMEDIATE_PLANET_CENTER);
    const awayDirs = anchors.map((a) => new Vector3(...a).sub(center).normalize());
    this._starPositions = [];
    this._starTraced = [];
    this._tracedCount = [];
    this._startedNotified = [];
    for (let type = 0; type < N_TYPES; type++) {
      const defs = CONSTELLATION_SETS[type];
      const stars: Float32Array[] = [];
      const traced: Uint8Array[] = [];
      const counts: number[] = [];
      const notified: boolean[] = [];
      for (let slot = 0; slot < defs.length; slot++) {
        const layout = generateConstellationLayout(defs[slot], anchors[slot], awayDirs[slot]);
        stars.push(layout.starPositions);
        traced.push(new Uint8Array(defs[slot].starCount));
        counts.push(0);
        notified.push(false);
      }
      this._starPositions.push(stars);
      this._starTraced.push(traced);
      this._tracedCount.push(counts);
      this._startedNotified.push(notified);
    }
  }

  // dominantPebbleType was already set when Chapter 2 completed, well
  // before this transition — safe to read fresh here.
  play(): void {
    super.play();
    this._activeType = getGlobals(this.world).dominantPebbleType.peek();
    const defs = CONSTELLATION_SETS[this._activeType];
    this._activeSlot = Math.floor(Math.random() * defs.length);
    this._starTraced[this._activeType][this._activeSlot].fill(0);
    this._tracedCount[this._activeType][this._activeSlot] = 0;
    this._startedNotified[this._activeType][this._activeSlot] = false;
    this._completed = false;
    this._completionHoldRemaining = 0;

    // Kicks off Leg A — the spin + recede into the intermediate waypoint
    // this phase's own anchors are staged around (see init()). Leg B (the
    // further zoom into the true Fate Events planet) is deferred until this
    // phase ends — see FateEventSystem.play().
    this._planetSeeding.startSpinTransition();
  }

  update(delta: number): void {
    if (this._completed) {
      // Trace already finished — just count down the hold before actually
      // flipping the phase-complete flag (see COMPLETION_HOLD_SECONDS).
      if (this._completionHoldRemaining > 0) {
        this._completionHoldRemaining -= delta;
        if (this._completionHoldRemaining <= 0) {
          getGlobals(this.world).phaseComplete.value = true;
        }
      }
      return;
    }
    const def = CONSTELLATION_SETS[this._activeType][this._activeSlot];
    const notifications = this.world.getSystem(NotificationHudSystem);
    const stars = this._starPositions[this._activeType][this._activeSlot];
    const traced = this._starTraced[this._activeType][this._activeSlot];

    for (const entity of this.queries.hands.entities) {
      if (this._completed) break;
      const posView = entity.getVectorView(CometBody, 'position') as Float32Array;
      this._scratchHandPos.fromArray(posView);

      for (let s = 0; s < def.starCount; s++) {
        if (traced[s]) continue;
        const dx = stars[s * 3] - this._scratchHandPos.x;
        const dy = stars[s * 3 + 1] - this._scratchHandPos.y;
        const dz = stars[s * 3 + 2] - this._scratchHandPos.z;
        if (dx * dx + dy * dy + dz * dz > TOUCH_RADIUS * TOUCH_RADIUS) continue;

        traced[s] = 1;
        this._tracedCount[this._activeType][this._activeSlot]++;

        if (!this._startedNotified[this._activeType][this._activeSlot]) {
          this._startedNotified[this._activeType][this._activeSlot] = true;
          // notifyNext (not notify) — this is a direct reaction to the
          // player just touching their first star, so it should play next
          // rather than getting stuck behind the phase-entry blurb and/or
          // an achievement popup that may already be queued ahead of it
          // (both non-urgent, generic copy).
          const { text, holdSeconds } = constellationSpottedMessage(def.name);
          notifications?.notifyNext(text, holdSeconds);
        }

        if (this._tracedCount[this._activeType][this._activeSlot] >= def.starCount) {
          this._completed = true;
          this._completionHoldRemaining = COMPLETION_HOLD_SECONDS[def.name] ?? DEFAULT_COMPLETION_HOLD_SECONDS;
          // Same reasoning as constellationSpottedMessage above — the
          // culminating narrative beat, shouldn't get buried in a backlog.
          const { text, holdSeconds } = celestialSymbolMessage(def.name);
          notifications?.notifyNext(text, holdSeconds);
          getGlobals(this.world).celestialSymbol.value = def.name;
          break;
        }
      }
    }
  }

  // Read-only accessors for ConstellationsVfxSystem — callers must not
  // mutate. type/slot indices match CONSTELLATION_SETS.
  getDefs(type: number): readonly ConstellationDef[] {
    return CONSTELLATION_SETS[type];
  }
  getStarPositions(type: number, slot: number): Float32Array {
    return this._starPositions[type][slot];
  }
  getStarTraced(type: number, slot: number): Uint8Array {
    return this._starTraced[type][slot];
  }
  getActiveSlot(): number {
    return this._activeSlot;
  }
  // Available from play() onward (Leg A's spin start) — unlike
  // globals.celestialSymbol, which stays null until the constellation is
  // actually traced. EarthSituationsVfxSystem needs the name this early to
  // gate ambient scene-setting during the spin, well before completion.
  getActiveName(): string {
    return CONSTELLATION_SETS[this._activeType][this._activeSlot].name;
  }
  isComplete(): boolean {
    return this._completed;
  }
}
