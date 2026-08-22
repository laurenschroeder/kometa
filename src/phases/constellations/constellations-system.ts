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
  placeConstellationAnchors,
} from '../../vfx/geometry/constellation-path.js';
import { CONSTELLATION_SETS, ConstellationDef } from './constellation-set.js';

export const N_TYPES = 3;
// Close enough that even the far edge of the largest constellation's spread
// (see constellation-set.ts's spreadRadius) stays within a reach-and-lean
// distance — was 2.6, way past arm's reach with no locomotion to close the
// gap.
export const ANCHOR_RADIUS = 1.0;
export const ANCHOR_CENTER_Y = 1.3;
const DOT_TOUCH_RADIUS = 0.1;

// Gameplay for the new Chapter 2.5: which trio of constellations appears is
// picked from whichever pebble type was dominant in Chapter 2
// (globals.dominantPebbleType) — but ALL 9 possible constellations' layouts
// (3 types x 3 slots) are generated once here in init(), not just the
// active 3, because ConstellationsVfxSystem is always-on (like
// PlanetSeedingVfxSystem) and needs fixed geometry to build its Points
// meshes against at ITS OWN init() time, well before this phase's play()
// ever runs (dominantPebbleType isn't known until Chapter 2 completes).
// Each constellation has its own independent winding path of touch dots
// (see constellation-path.ts) — the first one fully traced wins outright:
// it sets globals.celestialSymbol, fires the "celestial symbol"
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

  private _activeType = 0;
  private _winner: number | null = null;
  private _scratchHandPos!: Vector3;

  init(): void {
    this._scratchHandPos = new Vector3();

    const anchors = placeConstellationAnchors(3, ANCHOR_RADIUS, ANCHOR_CENTER_Y);
    this._starPositions = [];
    this._dotPositions = [];
    this._dotTouched = [];
    this._touchedCount = [];
    this._startedNotified = [];
    for (let type = 0; type < N_TYPES; type++) {
      const defs = CONSTELLATION_SETS[type];
      const stars: Float32Array[] = [];
      const dots: Float32Array[] = [];
      const touched: Uint8Array[] = [];
      const counts: number[] = [];
      const notified: boolean[] = [];
      for (let slot = 0; slot < defs.length; slot++) {
        const layout = generateConstellationLayout(defs[slot], anchors[slot]);
        stars.push(layout.starPositions);
        dots.push(layout.dotPositions);
        touched.push(new Uint8Array(defs[slot].dotCount));
        counts.push(0);
        notified.push(false);
      }
      this._starPositions.push(stars);
      this._dotPositions.push(dots);
      this._dotTouched.push(touched);
      this._touchedCount.push(counts);
      this._startedNotified.push(notified);
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
}
