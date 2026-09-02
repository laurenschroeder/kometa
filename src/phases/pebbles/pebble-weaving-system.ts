import { createSystem, Vector3 } from '@iwsdk/core';
import { CometBody } from '../../comet/comet-body-component.js';
import { CapturedField, GatherableField, GatherHandInput } from '../../comet/gatherable-field.js';
import { HandAnchor } from '../../comet/hand-anchor-component.js';
import { getGlobals } from '../../core/globals.js';
import { NotificationHudSystem } from '../../core/notification-hud-system.js';
import { pebbleCompletionMessage } from '../../core/notification-copy.js';
import { samplePebbleSizes } from '../../vfx/particles/pebble-size.js';
import { assignPebbleSpawnPoint } from './pebble-layout.js';
import { PEBBLE_TYPES } from './pebble-type.js';

// Bumped from 150 — puts meaningfully more pebbles across the layout
// (WIN_CAPTURE_COUNT scales with it too, so the 35% capture ratio — and
// overall difficulty — stays the same; the field is just denser and easier
// to find pebbles in).
const N_PEBBLES_FIELD = 210;
const WIN_CAPTURE_COUNT = Math.ceil(N_PEBBLES_FIELD * 0.35);

// Drives the field's attraction-pull feel (slower comet movement = stronger
// pull) — no longer tied to pebble type, which is now assigned per-particle
// at spawn (see pebble-layout.ts's assignPebbleSpawnPoint).
const SLOW_SPEED = 0.5;
const FAST_SPEED = 1.5;

// Fired via GatherableField's onCapture/onAttractStart callbacks, drained
// each frame by PebbleFieldVfxSystem to trigger the catch/pickup pebble
// synth sounds — same produce/drain shape StardustSystem's own CaptureEvent/
// drainCaptureEvents() already establishes. `type` is the pebble's assigned
// type (see pebble-layout.ts) at the moment of the event, read from
// GatherableField.assignedType — this is what lets the synth pick the
// harsh/earthy/heavenly timbre per pebble.
export interface PebbleCaptureEvent {
  x: number;
  y: number;
  z: number;
  speed: number;
  type: number;
}
export type PebbleAttractEvent = PebbleCaptureEvent;

// Matches the eventual pebble body's own tail distribution (see
// PebbleCometPresentationSystem) rather than stardust's tighter one — these
// pebbles are the body's raw material, so they should already read as "part
// of the same tail" (both in spread and in size) once captured.
const CAPTURED_AGE_DECAY = 3.5;
const CAPTURED_SPREAD_BASE = 0.024;
const CAPTURED_SPREAD_GROWTH = 0.038;
const CAPTURED_DEPTH_RATIO = 1.6;

// Gameplay for Chapter 2: the ambient pebbles hidden away during Chapter 1
// (see the HIDDEN_DURING_PHASES note in pebble-comet-presentation-system.ts)
// fill the playspace here instead, gathered the exact same way stardust
// was — slow, deliberate comet movement within range pulls nearby pebbles
// in, capturing them into the comet's trail-following pool once close
// enough. Reuses comet/gatherable-field.ts wholesale; only the counts and
// captured-trail distribution differ from Chapter 1 (tuned to match the
// eventual pebble body's own tail spread — see PebbleCometPresentationSystem
// — since this is literally gathering that body's raw material). The
// pebble/head body itself stays hidden throughout this phase; only
// PebbleFieldVfxSystem's ambient pebbles are visible.
export class PebbleWeavingSystem extends createSystem({
  hands: { required: [CometBody, HandAnchor] },
}) {
  private _field!: GatherableField;
  private _sizes!: Float32Array;
  private _hasWon = false;
  private _captureEvents: PebbleCaptureEvent[] = [];
  private _attractEvents: PebbleAttractEvent[] = [];

  private _hand!: GatherHandInput;
  private _scratchVel!: Vector3;

  init(): void {
    this._field = new GatherableField({
      count: N_PEBBLES_FIELD,
      spawnCenter: [0, 1.2, 0],
      spawnRadiusMin: 0.5,
      spawnRadiusMax: 1.8,
      attractRadius: 0.4,
      captureDistance: 0.05,
      slowSpeed: SLOW_SPEED,
      fastSpeed: FAST_SPEED,
      attractRate: 3.0,
      capturedAgeDecay: CAPTURED_AGE_DECAY,
      capturedSpreadBase: CAPTURED_SPREAD_BASE,
      capturedSpreadGrowth: CAPTURED_SPREAD_GROWTH,
      capturedDepthRatio: CAPTURED_DEPTH_RATIO,
      spawnPoint: assignPebbleSpawnPoint,
      // this._field isn't assigned until the constructor call below
      // returns, but that's fine — these callbacks only ever fire later
      // (during a future update()'s this._field.step()), by which point
      // the assignment has long since completed.
      onCapture: (index, x, y, z, speed) => {
        this._captureEvents.push({ x, y, z, speed, type: this._field.assignedType[index] });
      },
      onAttractStart: (index, x, y, z, speed) => {
        this._attractEvents.push({ x, y, z, speed, type: this._field.assignedType[index] });
      },
    });

    // Sized from the same distribution as the final body's own pebbles (see
    // vfx/particles/pebble-size.ts) so each ambient pebble is already the
    // size it will be once captured — fixed per field slot for the whole
    // phase (not re-sampled per capture), since which pebbles happen to be
    // "near-head-sized" vs. "tail-sized" is cosmetic variety, not something
    // that needs to persist a specific identity through capture.
    this._sizes = samplePebbleSizes(
      N_PEBBLES_FIELD,
      CAPTURED_AGE_DECAY,
      CAPTURED_SPREAD_BASE,
      CAPTURED_SPREAD_GROWTH,
      CAPTURED_DEPTH_RATIO,
    );

    this._hand = { position: new Vector3(), speed: 0, seen: false };
    this._scratchVel = new Vector3();
  }

  // Own progress state resets on play() — GameDirectorSystem only resets
  // the shared phaseComplete signal, not each phase's internal state. This
  // is what gives a fresh pebble field every replay loop.
  play(): void {
    super.play();
    this._field.reset();
    this._hasWon = false;
    this._captureEvents.length = 0;
    this._attractEvents.length = 0;
  }

  update(delta: number): void {
    this._hand.seen = false;
    for (const entity of this.queries.hands.entities) {
      const posView = entity.getVectorView(CometBody, 'position') as Float32Array;
      const velView = entity.getVectorView(CometBody, 'velocity') as Float32Array;
      this._scratchVel.fromArray(velView);
      this._hand.position.fromArray(posView);
      this._hand.speed = this._scratchVel.length();
      this._hand.seen = true;
    }

    this._field.step(this._hand, delta);

    if (!this._hasWon && this._field.totalCaptured >= WIN_CAPTURE_COUNT) {
      this._hasWon = true;
      getGlobals(this.world).phaseComplete.value = true;

      const counts = this._field.getTypeCounts();
      let dominant = 0;
      for (let t = 1; t < counts.length; t++) {
        if (counts[t] > counts[dominant]) dominant = t;
      }
      getGlobals(this.world).dominantPebbleType.value = dominant;

      // Normalized capture-proportion weights across the three types —
      // PebbleCometPresentationSystem reads this to weighted-randomly assign
      // each permanent body pebble one of the three saturated PEBBLE_TYPES
      // colors, so whatever mix you gathered here persists as part of the
      // comet (visibly multi-colored, not flattened into one blended
      // average) for the rest of the game instead of vanishing when this
      // phase ends.
      const total = counts.reduce((sum, c) => sum + c, 0) || 1;
      const weights: [number, number, number] = [counts[0] / total, counts[1] / total, counts[2] / total];
      getGlobals(this.world).pebbleTypeWeights.value = weights;

      const { text, holdSeconds } = pebbleCompletionMessage(PEBBLE_TYPES[dominant].name);
      this.world.getSystem(NotificationHudSystem)?.notify(text, holdSeconds);
    }
  }

  // Read-only accessors for PebbleFieldVfxSystem — no copying, callers must
  // not mutate.
  getPositions(): Float32Array {
    return this._field.positions;
  }
  getStates(): Uint8Array {
    return this._field.states;
  }
  getSizes(): Float32Array {
    return this._sizes;
  }
  getCapturedField(): CapturedField {
    return this._field.capturedField;
  }
  getCapturedIndices(): readonly number[] {
    return this._field.captured;
  }
  getParticleCount(): number {
    return N_PEBBLES_FIELD;
  }
  // Per-particle type, assigned at spawn and valid for every particle
  // regardless of state (not just once Captured) — for PebbleFieldVfxSystem's
  // per-instance coloring.
  getAssignedType(): Uint8Array {
    return this._field.assignedType;
  }

  // Returns this frame's capture events and clears the queue — see
  // PebbleCaptureEvent.
  drainCaptureEvents(): readonly PebbleCaptureEvent[] {
    if (this._captureEvents.length === 0) return this._captureEvents;
    const events = this._captureEvents;
    this._captureEvents = [];
    return events;
  }
  // Returns this frame's pickup (Free -> Attracting) events and clears the
  // queue — see PebbleAttractEvent.
  drainAttractEvents(): readonly PebbleAttractEvent[] {
    if (this._attractEvents.length === 0) return this._attractEvents;
    const events = this._attractEvents;
    this._attractEvents = [];
    return events;
  }
}
