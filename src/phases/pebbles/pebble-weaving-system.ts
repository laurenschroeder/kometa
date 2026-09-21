import { createSystem, Vector3 } from '@iwsdk/core';
import { AchievementSystem } from '../../core/achievement-system.js';
import { CometBody } from '../../comet/comet-body-component.js';
import { CapturedField, GatherableField, GatherHandInput } from '../../comet/gatherable-field.js';
import { HandAnchor, HandSide } from '../../comet/hand-anchor-component.js';
import { getGlobals } from '../../core/globals.js';
import { HapticPattern, HapticsSystem } from '../../core/haptics-system.js';
import { NotificationHudSystem } from '../../core/notification-hud-system.js';
import { PEBBLE_TYPE_REVEAL_SECONDS, pebbleCompletionMessage } from '../../core/notification-copy.js';
import { samplePebbleSizes } from '../../vfx/particles/pebble-size.js';
import { assignPebbleSpawnPoint, closestGroupOriginForType } from './pebble-layout.js';
import { PEBBLE_TYPE_HEX, PEBBLE_TYPES } from './pebble-type.js';

// Bumped from 150 — puts meaningfully more pebbles across the layout, the
// field is just denser and easier to find pebbles in.
const N_PEBBLES_FIELD = 210;
// Floor below which the wrist Continue button (ContinueButtonSystem) stays
// locked — completion is player-triggered (poking that button, see
// index.ts's Pebbles PhaseConfig.continue), not an automatic count-based win,
// so this only guards against continuing before the player has sampled a
// meaningful mix. About 5% of the field, a sixth of the old
// hard-coded WIN_CAPTURE_COUNT (53) this replaces.
export const MIN_BUBBLE_PEBBLES = 13;

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

// When each pebble type visually pops into the field — paced against the
// Pebbles-intro HUD notification's own per-line timing (see
// notification-copy.ts's PEBBLE_INTRO_* constants): each path's line fades in,
// then that path's pebbles appear a couple of seconds later. Cosmetic sync
// (gameplay/VFX stay decoupled, same reasoning as ConstellationsSystem's own
// COMPLETION_HOLD_SECONDS); PebbleFieldVfxSystem reads getTypeRevealProgress()
// every frame to scale each pebble in.
const TYPE_REVEAL_AT_SECONDS = PEBBLE_TYPE_REVEAL_SECONDS;
const TYPE_REVEAL_GROW_SECONDS = 0.5;

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}
function smoothstep(t: number): number {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
}

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
  // GameDirectorSystem.definePhase() calls stop() on every phase system
  // immediately at registration time (a normalization step, before
  // director.start() has ever run) — without this guard, that boot-time call
  // would hit stop()'s own "never chose" fallback and force-complete the
  // phase before the game even starts. Same idiom as OrbitalLaunchSystem's
  // own _hasPlayed guard.
  private _hasPlayed = false;
  private _captureEvents: PebbleCaptureEvent[] = [];
  private _attractEvents: PebbleAttractEvent[] = [];
  // Seconds since this phase's own play() — drives getTypeRevealProgress()
  // below, see TYPE_REVEAL_AT_SECONDS's own comment.
  private _elapsed = 0;

  // Which hand currently holds the comet, refreshed each update() before
  // this._field.step() runs — read by the onCapture/onAttractStart closures
  // below (both fired synchronously from inside that same step() call) so
  // they know which controller to buzz.
  private _currentHand: string = HandSide.Left;
  private _hand!: GatherHandInput;
  private _scratchVel!: Vector3;
  // Camera forward captured once at play() — see getCallOrigin(), used to
  // place the "three paths call to you" intro chimes (PebbleFieldVfxSystem)
  // at whichever group of each type actually sits closest to forward,
  // rather than re-sampling forward (and getting a different answer) each
  // time one fires.
  private _refForward!: Vector3;

  init(): void {
    this._field = new GatherableField({
      count: N_PEBBLES_FIELD,
      spawnCenter: [0, 1.2, 0],
      spawnRadiusMin: 0.5,
      spawnRadiusMax: 1.8,
      // Lowered from 0.4 — that let a hand just passing near a group
      // auto-vacuum whatever was nearby regardless of type, more than the
      // "get close to the type you want" feel this phase is going for.
      attractRadius: 0.22,
      // Bumped from 0.05 — with attractRadius already tightened to 0.22
      // (above) and attractRate's exponential pull only closing ~3%/frame,
      // a pebble being reeled in often couldn't close the gap from the edge
      // of attractRadius down to the old, much smaller captureDistance
      // before a normal swinging/walking motion carried the hand back
      // outside attractRadius first — reverting it to Free (a "drop") before
      // it ever sealed. Widening just the capture target (not attractRadius
      // itself, which stays at its deliberately tightened value) gives the
      // pull enough slack to actually finish landing a catch.
      captureDistance: 0.09,
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
        this.world.getSystem(HapticsSystem)?.pulse(this._currentHand, HapticPattern.MediumPulse);
      },
      onAttractStart: (index, x, y, z, speed) => {
        this._attractEvents.push({ x, y, z, speed, type: this._field.assignedType[index] });
        this.world.getSystem(HapticsSystem)?.pulse(this._currentHand, HapticPattern.LightTick);
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
    this._refForward = new Vector3();
  }

  // Own progress state resets on play() — GameDirectorSystem only resets
  // the shared phaseComplete signal, not each phase's internal state. This
  // is what gives a fresh pebble field every replay loop.
  play(): void {
    super.play();
    this._hasPlayed = true;
    this._field.reset();
    this._hasWon = false;
    this._captureEvents.length = 0;
    this._attractEvents.length = 0;
    this._elapsed = 0;
    this.camera.getWorldDirection(this._refForward);
  }

  // Fallback for "player never presses Continue" — if the phase's
  // timeoutSeconds fires before the player pokes the wrist Continue
  // button, force completion anyway so the game
  // doesn't stall. Guarded by _hasPlayed so definePhase()'s boot-time stop()
  // (see that field's own comment) is a genuine no-op. Passes `true` — see
  // triggerCompletion's own comment on why the timeout path must not queue
  // the deferred phaseComplete flip the normal path uses.
  stop(): void {
    super.stop();
    if (this._hasPlayed && !this._hasWon) this.triggerCompletion(true);
  }

  update(delta: number): void {
    this._elapsed += delta;
    this._hand.seen = false;
    for (const entity of this.queries.hands.entities) {
      const posView = entity.getVectorView(CometBody, 'position') as Float32Array;
      const velView = entity.getVectorView(CometBody, 'velocity') as Float32Array;
      this._scratchVel.fromArray(velView);
      this._hand.position.fromArray(posView);
      this._hand.speed = this._scratchVel.length();
      this._hand.seen = true;
      this._currentHand = entity.getValue(HandAnchor, 'hand') as string;
    }

    this._field.step(this._hand, delta);
  }

  // Fires the phase's actual completion — dominant-type/weight bookkeeping,
  // achievement unlocks, the completion notification, and (once that
  // notification finishes) the phaseComplete signal. Previously ran
  // automatically once a hard-coded pebble count was reached; now called
  // externally by the wrist Continue button the moment the player presses
  // the bubble (or, as a fallback, from this system's own stop() if the
  // phase times out before that happens). Idempotent via _hasWon.
  //
  // `fromTimeout` skips the deferred phaseComplete flip: GameDirectorSystem
  // already decided to advance the instant it called stop() (that's what a
  // timeout IS, see game-director-system.ts's own wonByTimeout check), and
  // by the time this method's own notify() callback would fire a few
  // seconds later, globals.gamePhase has already moved on to Seeding —
  // setting phaseComplete=true at that point was flipping SEEDING's own
  // completion flag almost immediately after it started, skipping it
  // entirely. The normal (bubble-commit) path still needs the flip, since
  // there gamePhase hasn't changed yet when triggerCompletion() runs.
  triggerCompletion(fromTimeout = false): void {
    if (this._hasWon) return;
    this._hasWon = true;
    // A "you gathered enough" success cue — 'true-believer'/'perfect-
    // balance' below only unlock under stricter, mutually-exclusive
    // conditions, so most wins otherwise played no sound at all.
    this.world.getSystem(AchievementSystem)?.playSuccessChime();

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
    getGlobals(this.world).pebbleTypeCounts.value = [counts[0], counts[1], counts[2]];
    getGlobals(this.world).pebbleTypeWeights.value = weights;

    // Mutually exclusive by construction — a dominant share this high
    // can't also be this evenly split — so at most one of these fires.
    const achievements = this.world.getSystem(AchievementSystem);
    if (weights[dominant] >= 0.9) {
      achievements?.unlock('true-believer');
    } else if (Math.max(...weights) - Math.min(...weights) <= 0.1) {
      achievements?.unlock('perfect-balance');
    }

    const { text, holdSeconds } = pebbleCompletionMessage(PEBBLE_TYPES[dominant].name);
    // phaseComplete only flips once this message has actually finished
    // its own on-screen time (fade-in + hold + fade-out) — previously set
    // the instant the win condition was reached, well before notify() was
    // even called, so GameDirectorSystem could already be transitioning
    // to Seeding before the player had any real chance to read this,
    // reading as the notification getting cut off.
    this.world
      .getSystem(NotificationHudSystem)
      ?.notify(text, holdSeconds, 0, undefined, () => {
        if (!fromTimeout) getGlobals(this.world).phaseComplete.value = true;
      });
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
  // Seconds since this phase's play() — the same clock the intro's line and
  // reveal timings (notification-copy.ts's PEBBLE_INTRO_*) are measured on.
  getElapsed(): number {
    return this._elapsed;
  }
  // 0-1 grow-in progress for a pebble type — see TYPE_REVEAL_AT_SECONDS.
  getTypeRevealProgress(type: number): number {
    return smoothstep((this._elapsed - TYPE_REVEAL_AT_SECONDS[type]) / TYPE_REVEAL_GROW_SECONDS);
  }
  // World-space point to play that type's "call" chime from — see
  // pebble-layout.ts's closestGroupOriginForType and PebbleFieldVfxSystem's
  // own use of this alongside getTypeRevealProgress.
  getCallOrigin(type: number, out: Vector3): Vector3 {
    return closestGroupOriginForType(type, this._refForward, out);
  }
  // 0-1 progress toward the choice bubble becoming available for
  // HandProgressHudSystem's wrist bar — fraction of MIN_BUBBLE_PEBBLES
  // gathered so far, not a fixed completion target (there isn't one anymore;
  // completion is the player's own call via the Continue button). Pins
  // at 1 once the floor is cleared and stays there for however much longer
  // the player keeps gathering before choosing to finish.
  getProgress01(): number {
    return Math.min(1, this._field.totalCaptured / MIN_BUBBLE_PEBBLES);
  }
  // Per-type live capture count as its own fraction of MIN_BUBBLE_PEBBLES —
  // for HandProgressHudSystem's wrist bar, which during Pebbles renders
  // three stacked segments (one per PEBBLE_TYPES color) instead of one
  // solid fill, so the bar reads as a running tally of the actual mix
  // gathered so far rather than just an undifferentiated total. Each segment
  // clips at 1 independently once past the floor, so unlike before the three
  // fractions no longer necessarily sum to exactly getProgress01()'s value.
  getTypeProgress01(type: number): number {
    return Math.min(1, this._field.getTypeCounts()[type] / MIN_BUBBLE_PEBBLES);
  }
  // Live per-type capture counts, for the former choice bubble's own
  // "who's currently ahead" recolor and its MIN_BUBBLE_PEBBLES-floor gate —
  // no copying, callers must not mutate.
  getTypeCounts(): readonly number[] {
    return this._field.getTypeCounts();
  }

  // Color of the pebble type captured most so far (ties go to the lower id,
  // matching triggerCompletion's dominant pick); null before any capture.
  getDominantColorHex(): string | null {
    const counts = this._field.getTypeCounts();
    let dominant = 0;
    for (let t = 1; t < counts.length; t++) if (counts[t] > counts[dominant]) dominant = t;
    return counts[dominant] > 0 ? PEBBLE_TYPE_HEX[dominant] : null;
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
