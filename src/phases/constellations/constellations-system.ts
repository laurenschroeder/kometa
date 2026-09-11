import { createSystem, Vector3 } from '@iwsdk/core';
import { CometBody } from '../../comet/comet-body-component.js';
import { HandAnchor } from '../../comet/hand-anchor-component.js';
import { getGlobals } from '../../core/globals.js';
import {
  celestialSymbolFlavorMessage,
  celestialSymbolMessage,
  constellationSpottedMessage,
  kingRisingMessage,
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

// This phase stays open after the trace completes until globals.crownLanded
// flips true — set by EarthSituationsVfxSystem's universal crown-rise
// cinematic (see crown-rise.ts) the instant it attaches to the comet's
// head, ~30s after completion. celestialSymbolFlavorMessage's "this means
// something to them" myth-beat fires immediately at trace-completion
// instead (the same instant the crown starts rising), so the ~30s cinematic
// isn't silent — only celestialSymbolMessage's explicit "you are crowned"
// reveal and phaseComplete wait for crownLanded (via that notification's
// own onComplete — same idiom stardust-system.ts's win sequence uses), so
// that specific reveal always lands right as the crown does, not buried
// mid-cinematic. Deliberately not imported from earth-situations-
// vfx-system.ts/ghost-rise.ts/crown-rise.ts — this file only polls a
// globals signal, not the mechanic itself, so the two stay decoupled (same
// reasoning as globals.pairedPersonIndex/pairedPersonLine). index.ts's own
// Phase.Constellations timeoutSeconds (120) remains the safety net if the
// crown mechanic ever stalls.

// Gameplay for Chapter 2.5, staged around the planet at its INTERMEDIATE
// Constellations waypoint (Seeding runs first — see phase.ts's PHASE_ORDER —
// and this phase's own play() kicks off Leg A, the spin+recede transition
// that lands the planet there; see
// PlanetSeedingVfxSystem.startSpinTransition). The much bigger/farther zoom
// into the true Fate Events planet is Leg B, deferred until this phase ends
// (see FateEventSystem.play()). Which single constellation is available is
// picked from whichever pebble type was dominant in Chapter 2 (globals.
// dominantPebbleType) — each type maps to exactly one named constellation
// now (Dog/Tree/Crown, see constellation-set.ts), so play()'s random slot
// pick always lands on index 0. All 3 types' layouts are still generated
// once here in init(), not just the active type's, because
// ConstellationsVfxSystem is always-on (like PlanetSeedingVfxSystem) and
// needs fixed geometry to build its Points meshes against at ITS OWN init()
// time, well before this phase's play() ever runs (dominantPebbleType isn't
// known until Chapter 2 completes / this phase begins). The constellation's
// stars start flashing and must ALL be traced (any order) to complete it —
// tracing the last one flips _completed (see isComplete()), which is what
// drives EarthSituationsVfxSystem's crown-rise cinematic; only once that
// crown lands does this file set globals.celestialSymbol, fire the
// "celestial symbol" notification, and complete the phase (see this file's
// own top comment). Pure simulation here: no mesh/entity creation happens
// in this file (see ConstellationsVfxSystem), only layout math and
// touch-detection.
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
  // Guards celestialSymbolMessage/phaseComplete from firing more than once
  // per play() — set true the first update() tick that sees
  // globals.crownLanded true after _completed. isComplete() (which flips
  // immediately on the last star) still drives the completion payoff/hero
  // star reveal while the phase itself stays open until this fires.
  private _notifiedCompletion = false;
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
    this._notifiedCompletion = false;

    // Kicks off Leg A — the spin + recede into the intermediate waypoint
    // this phase's own anchors are staged around (see init()). Leg B (the
    // further zoom into the true Fate Events planet) is deferred until this
    // phase ends — see FateEventSystem.play().
    this._planetSeeding.startSpinTransition();
  }

  update(delta: number): void {
    if (this._completed) {
      // Trace already finished — wait for the crown cinematic to actually
      // land before revealing/advancing (see this file's own top comment).
      if (!this._notifiedCompletion && getGlobals(this.world).crownLanded.peek()) {
        this._notifiedCompletion = true;
        const def = CONSTELLATION_SETS[this._activeType][this._activeSlot];
        getGlobals(this.world).celestialSymbol.value = def.name;
        const { text, holdSeconds } = celestialSymbolMessage(def.name);
        // Same onComplete-gates-phaseComplete idiom stardust-system.ts's
        // win sequence uses — phaseComplete only flips once this exact
        // message has actually finished its own on-screen fade-out.
        this.world
          .getSystem(NotificationHudSystem)
          ?.notifyNext(text, holdSeconds, 0, undefined, () => {
            getGlobals(this.world).phaseComplete.value = true;
          });
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

        // Crown only — a mid-trace foreshadowing beat the instant the 3rd
        // star lands, well before the constellation (and the king's actual
        // death vignette in Fate Events) completes. See kingRisingMessage's
        // own comment.
        if (def.name === 'Crown' && this._tracedCount[this._activeType][this._activeSlot] === 3) {
          const { text, holdSeconds } = kingRisingMessage();
          notifications?.notify(text, holdSeconds);
        }

        if (this._tracedCount[this._activeType][this._activeSlot] >= def.starCount) {
          // celestialSymbolMessage (the "you are crowned" reveal) and
          // globals.celestialSymbol are still deferred to the crown
          // cinematic's landing — see the _completed branch above. The
          // flavor beat fires right here instead, though — the same
          // instant EarthSituationsVfxSystem's crown-rise cinematic begins
          // (see its own isComplete() edge) — so there's an immediate
          // acknowledgment as the crown starts forming, not just silence
          // for the ~30s until it lands.
          const flavor = celestialSymbolFlavorMessage(def.name);
          if (flavor) notifications?.notifyNext(flavor.text, flavor.holdSeconds);
          this._completed = true;
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
  // 0-1 live trace progress for the active constellation — read by
  // EarthSituationsVfxSystem to grow the King's tower one star at a time
  // (see its own _updateTowerHeight). Safe to call before play() ever runs
  // (defaults to type/slot 0, starCount is always > 0).
  getTracedFraction(): number {
    const starCount = CONSTELLATION_SETS[this._activeType][this._activeSlot].starCount;
    return this._tracedCount[this._activeType][this._activeSlot] / starCount;
  }
  isComplete(): boolean {
    return this._completed;
  }
}
