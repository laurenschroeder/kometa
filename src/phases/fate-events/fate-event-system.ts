import { createSystem, Vector3 } from '@iwsdk/core';
import { CometBody } from '../../comet/comet-body-component.js';
import { HandAnchor } from '../../comet/hand-anchor-component.js';
import { getGlobals } from '../../core/globals.js';
import { scatterOnSphereCap } from '../../vfx/geometry/sphere-scatter.js';
import { PEBBLE_TYPES } from '../pebbles/pebble-type.js';
import { FateDialogueEntry, getFateDialogue } from './fate-dialogue.js';

export const PLANET_CENTER: [number, number, number] = [0, 1.3, -2.0];
export const PLANET_RADIUS = 1.4;
export const N_PEOPLE = 10;
// 28 degrees (was 45) — tighter cluster on the patch of surface most
// directly facing the player, instead of spreading wide enough that people
// near the cap's edge sit at a steep, foreshortened angle relative to the
// viewer and are easy to miss against the planet's curvature.
const CAP_HALF_ANGLE = (28 * Math.PI) / 180;
const PROXIMITY_RADIUS = 0.3;
// How long a person keeps its current dialogue line before cycling to the
// next one in its constellation's line array, while a hand stays near it.
const LINE_CYCLE_SECONDS = 3.2;
// Grace window before "near" -> "far" actually clears state, so brushing
// the proximity radius's edge doesn't flicker the jump/bubble on and off.
const LEAVE_GRACE_SECONDS = 0.4;
// Volatile gasses' index in PEBBLE_TYPES/dominantPebbleType — gates the
// ambient "big fire" effect (see fate-event-vfx-system.ts).
const VOLATILE_GASSES_TYPE = 2;

// Gameplay for Fate Events: a big planet appears near the player, populated
// with N_PEOPLE placeholder figures scattered across its near-facing surface
// (see sphere-scatter.ts — normals double as each figure's "up" direction).
// Whichever hand gets close to a person triggers that person to jump (see
// FateEventVfxSystem's per-frame bob easing, driven by getActiveMask() here)
// and show a speech bubble cycling through dialogue lines tied to whichever
// constellation the player became the celestial symbol of (globals.
// celestialSymbol) — see fate-dialogue.ts. Volatile-gasses winners also get
// an ambient "big fire" effect (globals.dominantPebbleType). Pure simulation
// here: no mesh/entity creation happens in this file (see
// FateEventVfxSystem), only surface layout math and proximity/dialogue
// state. This phase has no win condition — it ends purely by timeout (see
// index.ts), same as the empty stub it replaces.
export class FateEventSystem extends createSystem({
  hands: { required: [CometBody, HandAnchor] },
}) {
  private _surfacePositions!: Float32Array;
  private _normals!: Float32Array;

  private _active!: Uint8Array;
  private _awayTimer!: Float32Array;
  private _lineIndex!: Uint8Array;
  private _lineTimer!: Float32Array;

  private _dialogue!: FateDialogueEntry;
  private _color!: [number, number, number];
  private _showFire = false;

  private _scratchHandPos!: Vector3;

  init(): void {
    const center = new Vector3(...PLANET_CENTER);
    const towardPlayer = new Vector3(0, 0, 1);
    const { positions, normals } = scatterOnSphereCap(
      N_PEOPLE,
      center,
      PLANET_RADIUS,
      towardPlayer,
      CAP_HALF_ANGLE,
    );
    this._surfacePositions = positions;
    this._normals = normals;

    this._active = new Uint8Array(N_PEOPLE);
    this._awayTimer = new Float32Array(N_PEOPLE);
    this._lineIndex = new Uint8Array(N_PEOPLE);
    this._lineTimer = new Float32Array(N_PEOPLE);

    this._dialogue = getFateDialogue(null);
    this._color = PEBBLE_TYPES[0].color;

    this._scratchHandPos = new Vector3();
  }

  // celestialSymbol/dominantPebbleType were already set (Constellations/
  // Pebbles) well before this phase can ever be reached — safe to read
  // fresh here, same pattern ConstellationsSystem.play() uses.
  play(): void {
    super.play();
    const globals = getGlobals(this.world);
    const dominantType = globals.dominantPebbleType.peek();
    this._dialogue = getFateDialogue(globals.celestialSymbol.peek());
    this._color = this._dialogue.color ?? PEBBLE_TYPES[dominantType].color;
    this._showFire = dominantType === VOLATILE_GASSES_TYPE;

    this._active.fill(0);
    this._awayTimer.fill(0);
    this._lineIndex.fill(0);
    this._lineTimer.fill(0);
  }

  update(delta: number): void {
    for (const entity of this.queries.hands.entities) {
      const posView = entity.getVectorView(CometBody, 'position') as Float32Array;
      this._scratchHandPos.fromArray(posView);

      for (let i = 0; i < N_PEOPLE; i++) {
        const dx = this._surfacePositions[i * 3] - this._scratchHandPos.x;
        const dy = this._surfacePositions[i * 3 + 1] - this._scratchHandPos.y;
        const dz = this._surfacePositions[i * 3 + 2] - this._scratchHandPos.z;
        const near = dx * dx + dy * dy + dz * dz <= PROXIMITY_RADIUS * PROXIMITY_RADIUS;

        if (near) {
          if (!this._active[i]) {
            this._active[i] = 1;
            this._lineIndex[i] = 0;
            this._lineTimer[i] = 0;
          }
          this._awayTimer[i] = 0;
        } else if (this._active[i]) {
          this._awayTimer[i] += delta;
          if (this._awayTimer[i] >= LEAVE_GRACE_SECONDS) {
            this._active[i] = 0;
            this._lineIndex[i] = 0;
            this._lineTimer[i] = 0;
          }
        }
      }
    }

    const lineCount = this._dialogue.lines.length;
    for (let i = 0; i < N_PEOPLE; i++) {
      if (!this._active[i]) continue;
      this._lineTimer[i] += delta;
      if (this._lineTimer[i] >= LINE_CYCLE_SECONDS) {
        this._lineTimer[i] = 0;
        this._lineIndex[i] = (this._lineIndex[i] + 1) % lineCount;
      }
    }
  }

  // Read-only accessors for FateEventVfxSystem — callers must not mutate.
  getPlanetCenter(): [number, number, number] {
    return PLANET_CENTER;
  }
  getPlanetRadius(): number {
    return PLANET_RADIUS;
  }
  getPersonCount(): number {
    return N_PEOPLE;
  }
  getSurfacePositions(): Float32Array {
    return this._surfacePositions;
  }
  getNormals(): Float32Array {
    return this._normals;
  }
  // Drives both the jump animation and speech-bubble visibility.
  getActiveMask(): Uint8Array {
    return this._active;
  }
  getLineIndex(): Uint8Array {
    return this._lineIndex;
  }
  getDialogueLines(): readonly string[] {
    return this._dialogue.lines;
  }
  getPeopleColor(): [number, number, number] {
    return this._color;
  }
  getShowFire(): boolean {
    return this._showFire;
  }
}
