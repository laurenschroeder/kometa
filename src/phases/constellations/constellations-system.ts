import { createSystem, Vector3 } from '@iwsdk/core';
import { CometBody } from '../../comet/comet-body-component.js';
import { HandAnchor } from '../../comet/hand-anchor-component.js';
import { getGlobals } from '../../core/globals.js';
import { Phase } from '../../core/phase.js';
import {
  celestialSymbolFlavorMessage,
  celestialSymbolMessage,
  constellationSpottedMessage,
  kingRisingMessage,
  VISIT_STARS_TEXT,
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
// head, ~30s after completion — so the player watches the whole crown
// travel to and land on the comet before moving on to Fate Events. Both
// notifications, though, fire together immediately at trace-completion:
// celestialSymbolFlavorMessage's "this means something to them" myth-beat,
// then celestialSymbolMessage's explicit "you are crowned" reveal right
// after it — no longer held back until the crown actually lands, since
// that made the reveal feel disconnected from the moment that actually
// earned it (finishing the trace). Only phaseComplete itself still waits
// for crownLanded (see the _completed branch below). Deliberately not
// imported from earth-situations-vfx-system.ts/ghost-rise.ts/crown-rise.ts
// — this file only polls a globals signal, not the mechanic itself, so the
// two stay decoupled. index.ts's own Phase.Constellations timeoutSeconds
// (120) remains the safety net if the crown mechanic ever stalls.

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
  // Guards phaseComplete from firing more than once per play() — set true
  // the first update() tick that sees globals.crownLanded true after
  // _completed. isComplete() (which flips immediately on the last star)
  // still drives the completion payoff/hero star reveal while the phase
  // itself stays open until this fires. The "you are crowned" notification
  // no longer waits on this — see the trace-completion block in update().
  private _notifiedCompletion = false;
  // Text of the "you are crowned" reveal, captured at fire time so update()'s
  // crownLanded edge can dismiss this exact notification (see
  // celestialSymbolMessage's own comment: it holds generously long and is
  // meant to be actively cut short here, not to fade out on its own timer).
  private _crownedMessageText: string | null = null;
  private _scratchHandPos!: Vector3;
  private _planetSeeding!: PlanetSeedingVfxSystem;

  init(): void {
    // PlanetSeedingVfxSystem must be registered before this system (see
    // index.ts) so it already exists when this init() runs.
    this._planetSeeding = this.world.getSystem(PlanetSeedingVfxSystem)!;
    this._scratchHandPos = new Vector3();

    // Every type's CONSTELLATION_SETS entry is exactly 1 def now (see its own
    // comment) — passing count=1 here (not the old 3) makes this land on
    // placeConstellationAnchorsAroundPlanet's own count===1 special case,
    // which centers the anchor straight ahead of the player (0° azimuth)
    // instead of the leftmost of 3 anchors (-30°). With 3, every type's
    // slot-0 def always resolved to that same off-center anchor — the
    // active constellation was ALWAYS placed to one side, requiring the
    // player to turn to reach it, regardless of which type was active.
    const anchors = placeConstellationAnchorsAroundPlanet(1, INTERMEDIATE_PLANET_CENTER, INTERMEDIATE_PLANET_RADIUS);
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

    // This system is phase-gated (play()/stop()'d only when the game
    // director actually enters/exits Phase.Constellations — see
    // game-director-system.ts), unlike the always-on VFX/situation systems
    // that read isComplete()/getStarTraced() and already reset themselves
    // the instant a fresh loop re-enters Phase.Stardust (see e.g.
    // earth-situations-vfx-system.ts/constellations-vfx-system.ts's own
    // gamePhase subscriptions). A jump straight from Finale back to Stardust
    // (EndRunMenuSystem's "Make a New Comet") passes through several phases
    // before this system's own play() would next run and clear last loop's
    // _completed/_starTraced — leaving isComplete() stuck true and the just-
    // finished constellation still reading as fully traced in the meantime,
    // which made EarthSituationsVfxSystem's isComplete() edge (_wasComplete,
    // reset already at Stardust) fire immediately, replaying the crown-rise
    // cinematic before the player had done anything in the new loop. Clears
    // progress the moment Stardust is (re-)entered — the same "fresh loop
    // starting" signal every other reset-on-restart system already keys off
    // — so downstream isComplete() reads are never stale. play() below still
    // clears the same state again once this phase's own turn actually comes
    // around; that's redundant, not conflicting.
    this.cleanupFuncs.push(
      getGlobals(this.world).gamePhase.subscribe((phase) => {
        if (phase === Phase.Stardust) this._resetProgress();
      }),
    );

    // Keeps _activeType/_activeSlot mirroring globals.dominantPebbleType at
    // all times, not just from this system's own play() (which normally sets
    // them the same way — see play() below — right before Constellations
    // actually begins). In real play this is redundant: dominantPebbleType
    // is already fixed by the time play() runs. It matters for a dev-menu
    // jump straight to Phase.FateEvents (skipping Constellations' own play()
    // entirely) with a class picked via the dev menu's colored buttons —
    // without this, _activeType/_activeSlot stay stuck at their construction
    // default (0, i.e. 'Dog'), so getActiveName() would report the wrong
    // constellation regardless of which type was actually picked, breaking
    // any name-gated Fate Events content (e.g. earth-situations-vfx-system.
    // ts's showKing, which requires name === 'Crown'). _activeSlot is always
    // 0 either way — every type has exactly one def, see CONSTELLATION_SETS.
    this.cleanupFuncs.push(
      getGlobals(this.world).dominantPebbleType.subscribe((type) => {
        this._activeType = type;
        this._activeSlot = 0;
      }),
    );
  }

  private _resetProgress(): void {
    for (let type = 0; type < N_TYPES; type++) {
      for (let slot = 0; slot < this._starTraced[type].length; slot++) {
        this._starTraced[type][slot].fill(0);
        this._tracedCount[type][slot] = 0;
        this._startedNotified[type][slot] = false;
      }
    }
    this._completed = false;
    this._notifiedCompletion = false;
    this._crownedMessageText = null;
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
    this._crownedMessageText = null;

    // Kicks off Leg A — the spin + recede into the intermediate waypoint
    // this phase's own anchors are staged around (see init()). Leg B (the
    // further zoom into the true Fate Events planet) is deferred until this
    // phase ends — see FateEventSystem.play().
    this._planetSeeding.startSpinTransition();
  }

  update(delta: number): void {
    if (this._completed) {
      // Trace already finished (the "you are crowned" reveal already fired
      // back when it did — see below) — wait for the crown cinematic to
      // actually land before advancing to Fate Events (see this file's own
      // top comment).
      if (!this._notifiedCompletion && getGlobals(this.world).crownLanded.peek()) {
        this._notifiedCompletion = true;
        // The "you are crowned" reveal (celestialSymbolMessage) holds
        // generously long specifically so it stays up for this whole
        // cinematic instead of fading on its own — cut it short right here,
        // the instant the crown actually lands, rather than let it linger
        // into Fate Events.
        if (this._crownedMessageText) {
          this.world.getSystem(NotificationHudSystem)?.dismissByText(this._crownedMessageText);
        }
        getGlobals(this.world).phaseComplete.value = true;
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
          // The phase-entry "why not visit those nearby stars" blurb is
          // only meant to stay up until this exact moment — see its own
          // comment in notification-copy.ts.
          notifications?.dismissByText(VISIT_STARS_TEXT);
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
          // Both notifications fire right here, together, the same instant
          // the trace finishes (and EarthSituationsVfxSystem's crown-rise
          // cinematic begins — see its own isComplete() edge) — no longer
          // waiting on the crown to actually land (see this file's own top
          // comment). notifyNext unshifts, so calling celestialSymbolMessage
          // FIRST then celestialSymbolFlavorMessage SECOND is what makes the
          // flavor line end up displaying first, the reveal right after it.
          getGlobals(this.world).celestialSymbol.value = def.name;
          const { text, holdSeconds } = celestialSymbolMessage(def.name);
          this._crownedMessageText = text;
          notifications?.notifyNext(text, holdSeconds);

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
