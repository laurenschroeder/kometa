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
  PLANET_CENTER,
  PLANET_RADIUS as FATE_PLANET_RADIUS,
} from '../fate-events/fate-event-system.js';
import { PlanetSeedingVfxSystem } from '../planet-seeding/planet-seeding-vfx-system.js';
import { CONSTELLATION_SETS, ConstellationDef } from './constellation-set.js';

export const N_TYPES = 3;
const DOT_TOUCH_RADIUS = 0.1;

// Gameplay for Chapter 2.5, now staged around the big Fate Events planet
// (Seeding runs first — see phase.ts's PHASE_ORDER — and this phase's own
// play() kicks off the same rotate/grow transition that used to wait until
// Fate Events itself; see PlanetSeedingVfxSystem.startFateEventsTransition).
// Which trio of constellations appears is picked from whichever pebble type
// was dominant in Chapter 2 (globals.dominantPebbleType) — but ALL 9
// possible constellations' layouts (3 types x 3 slots) are generated once
// here in init(), not just the active 3, because ConstellationsVfxSystem is
// always-on (like PlanetSeedingVfxSystem) and needs fixed geometry to build
// its Points meshes against at ITS OWN init() time, well before this
// phase's play() ever runs (dominantPebbleType isn't known until Chapter 2
// completes). Each constellation has its own independent winding path of
// touch dots (see constellation-path.ts) — the first one fully traced wins
// outright: it sets globals.celestialSymbol, fires the "celestial symbol"
// notification, and completes the phase, leaving the other two unfinished
// (same as any other phase's incomplete state on transition). Pure
// simulation here: no mesh/entity creation happens in this file (see
// ConstellationsVfxSystem), only layout math and touch-detection.
export class ConstellationsSystem extends createSystem({
  hands: { required: [CometBody, HandAnchor] },
}) {
  // All indexed [pebbleType][slot].
  private _starPositions!: Float32Array[][];
  private _dotPositions!: Float32Array[][];
  private _dotTouched!: Uint8Array[][];
  private _touchedCount!: number[][];
  private _startedNotified!: boolean[][];
  // Parallel to _touchedCount — dotCount per [type][slot], cached once at
  // init() for getRevealProgress()'s fraction math (FateEventVfxSystem reads
  // this every frame; cheaper than re-indexing CONSTELLATION_SETS there).
  private _dotCounts!: number[][];

  private _activeType = 0;
  private _winner: number | null = null;
  private _scratchHandPos!: Vector3;
  private _planetSeeding!: PlanetSeedingVfxSystem;

  init(): void {
    // PlanetSeedingVfxSystem must be registered before this system (see
    // index.ts) so it already exists when this init() runs.
    this._planetSeeding = this.world.getSystem(PlanetSeedingVfxSystem)!;
    this._scratchHandPos = new Vector3();

    const anchors = placeConstellationAnchorsAroundPlanet(3, PLANET_CENTER, FATE_PLANET_RADIUS);
    this._starPositions = [];
    this._dotPositions = [];
    this._dotTouched = [];
    this._touchedCount = [];
    this._startedNotified = [];
    this._dotCounts = [];
    for (let type = 0; type < N_TYPES; type++) {
      const defs = CONSTELLATION_SETS[type];
      const stars: Float32Array[] = [];
      const dots: Float32Array[] = [];
      const touched: Uint8Array[] = [];
      const counts: number[] = [];
      const notified: boolean[] = [];
      const dotCounts: number[] = [];
      for (let slot = 0; slot < defs.length; slot++) {
        const layout = generateConstellationLayout(defs[slot], anchors[slot]);
        stars.push(layout.starPositions);
        dots.push(layout.dotPositions);
        touched.push(new Uint8Array(defs[slot].dotCount));
        counts.push(0);
        notified.push(false);
        dotCounts.push(defs[slot].dotCount);
      }
      this._starPositions.push(stars);
      this._dotPositions.push(dots);
      this._dotTouched.push(touched);
      this._touchedCount.push(counts);
      this._startedNotified.push(notified);
      this._dotCounts.push(dotCounts);
    }
  }

  // dominantPebbleType was already set when Chapter 2 completed, well
  // before this transition — safe to read fresh here.
  play(): void {
    super.play();
    this._activeType = getGlobals(this.world).dominantPebbleType.peek();
    const defs = CONSTELLATION_SETS[this._activeType];
    for (let slot = 0; slot < defs.length; slot++) {
      this._dotTouched[this._activeType][slot].fill(0);
      this._touchedCount[this._activeType][slot] = 0;
      this._startedNotified[this._activeType][slot] = false;
    }
    this._winner = null;

    // Kicks off the same rotate/grow transition Fate Events used to trigger
    // — now this phase's own arrival is what grows the ring planet into the
    // big planet the constellations (and later, Fate Events' people) are
    // staged around. Safe to call again later from FateEventSystem.play()
    // (see its own comment) if this phase was skipped via the dev menu.
    this._planetSeeding.startFateEventsTransition();
  }

  update(): void {
    if (this._winner !== null) return;
    const defs = CONSTELLATION_SETS[this._activeType];
    const notifications = this.world.getSystem(NotificationHudSystem);

    for (const entity of this.queries.hands.entities) {
      const posView = entity.getVectorView(CometBody, 'position') as Float32Array;
      this._scratchHandPos.fromArray(posView);

      for (let slot = 0; slot < defs.length && this._winner === null; slot++) {
        const dots = this._dotPositions[this._activeType][slot];
        const touched = this._dotTouched[this._activeType][slot];
        const dotCount = defs[slot].dotCount;

        for (let d = 0; d < dotCount; d++) {
          if (touched[d]) continue;
          const dx = dots[d * 3] - this._scratchHandPos.x;
          const dy = dots[d * 3 + 1] - this._scratchHandPos.y;
          const dz = dots[d * 3 + 2] - this._scratchHandPos.z;
          if (dx * dx + dy * dy + dz * dz > DOT_TOUCH_RADIUS * DOT_TOUCH_RADIUS) continue;

          touched[d] = 1;
          this._touchedCount[this._activeType][slot]++;

          if (!this._startedNotified[this._activeType][slot]) {
            this._startedNotified[this._activeType][slot] = true;
            const { text, holdSeconds } = constellationSpottedMessage(defs[slot].name);
            notifications?.notify(text, holdSeconds);
          }

          if (this._touchedCount[this._activeType][slot] >= dotCount) {
            this._winner = slot;
            const { text, holdSeconds } = celestialSymbolMessage(defs[slot].name);
            notifications?.notify(text, holdSeconds);
            getGlobals(this.world).celestialSymbol.value = defs[slot].name;
            getGlobals(this.world).phaseComplete.value = true;
            break;
          }
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
  getDotPositions(type: number, slot: number): Float32Array {
    return this._dotPositions[type][slot];
  }
  getDotTouched(type: number, slot: number): Uint8Array {
    return this._dotTouched[type][slot];
  }
  getWinner(): number | null {
    return this._winner;
  }
  // 0-1 — how close the player is to winning ANY of the active type's 3
  // constellations (the leading one, not a sum/average — touching a couple
  // of dots on two different constellations shouldn't outpace real progress
  // on one). Stays at 1 once a winner is set, rather than snapping back to
  // 0 on the frame play() resets state for a fresh loop's next entry. Read
  // by FateEventVfxSystem to drive its progressive people reveal.
  getRevealProgress(): number {
    if (this._winner !== null) return 1;
    let maxT = 0;
    const counts = this._touchedCount[this._activeType];
    const dotCounts = this._dotCounts[this._activeType];
    for (let slot = 0; slot < counts.length; slot++) {
      const t = counts[slot] / dotCounts[slot];
      if (t > maxT) maxT = t;
    }
    return maxT;
  }
}
