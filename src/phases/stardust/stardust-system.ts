import { createSystem, Vector3 } from '@iwsdk/core';
import { CometBody } from '../../comet/comet-body-component.js';
import { CapturedField, GatherableField, GatherHandInput } from '../../comet/gatherable-field.js';
import { HandAnchor } from '../../comet/hand-anchor-component.js';
import { getGlobals } from '../../core/globals.js';
import { NotificationHudSystem } from '../../core/notification-hud-system.js';
import { STARDUST_WIN_SEQUENCE } from '../../core/notification-copy.js';
import { scatterDisc, scatterGalaxyArm } from '../../vfx/geometry/pixel-swirl.js';

const N_STARDUST = 500;

// Two-stage finale, replacing the old single WIN_CAPTURE_COUNT (25%) instant
// trigger. Stage A: once EITHER condition is met, a single gold pixel-CRT
// "swirl" fades in front of the player (see StardustVfxSystem) and the
// pickup/catch sound switches to the square-wave PixelTwinkleSynth —
// gathering continues, this isn't the end of the phase. Stage B: the swirl
// is itself a second collectible GatherableField (see _buildSwirlField) —
// once EITHER its own capture fraction or the extra-time timeout is met, the
// existing STARDUST_WIN_SEQUENCE notifications fire and the phase ends. See
// index.ts's Phase.Stardust timeoutSeconds (bumped to 150) — both stages'
// worst-case durations plus the notification sequence's own playback time
// need to fit comfortably inside that safety-net timeout.
const SWIRL_TRIGGER_FRACTION = 0.8;
const SWIRL_TRIGGER_TIMEOUT_SECONDS = 60;
const FINALE_TRIGGER_FRACTION = 0.9;
const FINALE_EXTRA_SECONDS = 30;

// The swirl's own shape/spawn tuning — a small spiral-galaxy layout (same
// scatterGalaxyArm/scatterDisc math the old decorative swirl used, see
// pixel-swirl.ts) reused as a live GatherableField's spawnPoint instead of a
// static Points cloud, so its points can be attracted/captured exactly like
// the ambient stardust motes are. 90 points total — sized for "a satisfying
// sweep-through within Stage B's own timeout", not a dense decorative cloud.
const SWIRL_ARM_COUNT = 5;
const SWIRL_TURNS = 1.0;
const SWIRL_ARM_RADIUS = 0.35;
const SWIRL_ARM_POINT_COUNT = 70;
const SWIRL_CORE_RADIUS = 0.08;
const SWIRL_CORE_POINT_COUNT = 20;
const SWIRL_POINT_COUNT = SWIRL_ARM_POINT_COUNT + SWIRL_CORE_POINT_COUNT;
const SWIRL_SPREAD_FACTOR = 0.22;
const SWIRL_DEPTH_JITTER = 0.03;
// How far in front of the player's head the swirl appears — placed once, the
// instant Stage A triggers, same "front and center" framing the old 3-swirl
// version used for its own center swirl.
const SWIRL_FORWARD_DISTANCE = 1.2;

// Fired via GatherableField's onCapture/onAttractStart callbacks, drained
// each frame by StardustVfxSystem to trigger the catch/pickup twinkle
// sounds — same produce/drain shape PlanetSeedingSystem's own LaunchEvent/
// drainLaunchEvents() already establishes.
export interface CaptureEvent {
  x: number;
  y: number;
  z: number;
  speed: number;
}
export type AttractEvent = CaptureEvent;

// Gameplay for Chapter 1: stardust motes fill the playspace; slow, deliberate
// comet movement within range pulls nearby motes in; once close enough a
// mote is "captured" and joins the comet's trail-following pool (rendered
// by StardustVfxSystem using the same trail-sampling technique the pebbles
// use — see CometTrailSystem/vfx/particles/trail-sampler.ts). Reads
// CometBody position/velocity directly so "the stardust follows the comet"
// reuses the exact same spring-physics anchor the rest of the comet uses.
// There's only ever one {CometBody, HandAnchor} entity (see
// comet/comet-handoff-system.ts) — the actual gather mechanic lives in
// comet/gatherable-field.ts, shared with Chapter 2's ambient pebble field.
export class StardustSystem extends createSystem({
  hands: { required: [CometBody, HandAnchor] },
}) {
  private _field!: GatherableField;
  private _hasWon = false;
  // Total elapsed seconds since play() — this system's own timer, distinct
  // from GameDirectorSystem's private phase-elapsed tracking, since the two
  // stage thresholds below need to check it independently of any single
  // director-level timeout.
  private _elapsed = 0;
  // Stage A reached (swirl visible, sound switched) — see
  // SWIRL_TRIGGER_FRACTION's own comment.
  private _swirling = false;
  // Seconds since Stage A triggered — gates Stage B's own timeout leg.
  private _swirlElapsed = 0;
  private _captureEvents: CaptureEvent[] = [];
  private _attractEvents: AttractEvent[] = [];

  // Built lazily the instant Stage A triggers (see _buildSwirlField) — its
  // spawnCenter needs the player's live head position/facing, only known at
  // that moment, not at init() time. null until then, and reset to null on
  // every play() so a fresh loop gets a freshly built swirl.
  private _swirlField: GatherableField | null = null;
  private _swirlCaptureEvents: CaptureEvent[] = [];
  private _swirlAttractEvents: AttractEvent[] = [];

  private _hand!: GatherHandInput;
  private _scratchVel!: Vector3;
  private _scratchSwirlCenter!: Vector3;
  private _scratchSwirlDir!: Vector3;

  init(): void {
    this._field = new GatherableField({
      count: N_STARDUST,
      spawnCenter: [0, 1.2, 0],
      spawnRadiusMin: 0.5,
      spawnRadiusMax: 1.8,
      attractRadius: 0.4,
      captureDistance: 0.05,
      attractRate: 3.0,
      // Distribution for newly captured stardust riding the comet's trail —
      // intentionally tighter than the eventual pebble tail (this is the
      // comet just forming, not yet grown).
      capturedAgeDecay: 3.0,
      capturedSpreadBase: 0.01,
      capturedSpreadGrowth: 0.02,
      capturedDepthRatio: 1.4,
      onCapture: (_index, x, y, z, speed) => {
        this._captureEvents.push({ x, y, z, speed });
      },
      onAttractStart: (_index, x, y, z, speed) => {
        this._attractEvents.push({ x, y, z, speed });
      },
    });

    this._hand = { position: new Vector3(), speed: 0, seen: false };
    this._scratchVel = new Vector3();
    this._scratchSwirlCenter = new Vector3();
    this._scratchSwirlDir = new Vector3();
  }

  // Converts one flat index (0..SWIRL_POINT_COUNT) into a spiral-galaxy
  // spawn point — arm points first, then a small core cluster — matching
  // GatherableFieldParams.spawnPoint's {dir, radiusT, type} contract (see
  // pebble-layout.ts's assignPebbleSpawnPoint for the established precedent
  // of converting a raw scattered position into that shape). type is unused
  // here (only one visual treatment), always 0.
  private _swirlSpawnPoint(index: number): { dir: Vector3; radiusT: number; type: number } {
    const p =
      index < SWIRL_ARM_POINT_COUNT
        ? scatterGalaxyArm(
            index % SWIRL_ARM_COUNT,
            SWIRL_ARM_COUNT,
            SWIRL_TURNS,
            SWIRL_ARM_RADIUS,
            SWIRL_SPREAD_FACTOR,
            SWIRL_DEPTH_JITTER,
          )
        : scatterDisc(SWIRL_CORE_RADIUS, SWIRL_DEPTH_JITTER);
    const r = Math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
    if (r < 1e-6) {
      return { dir: new Vector3(0, 0, 1), radiusT: 0, type: 0 };
    }
    return { dir: new Vector3(p[0] / r, p[1] / r, p[2] / r), radiusT: r / SWIRL_ARM_RADIUS, type: 0 };
  }

  // Builds the swirl as a second, independent GatherableField centered in
  // front of wherever the player's head happens to be facing the instant
  // Stage A triggers — same attract/capture tuning the main stardust field
  // already uses, and the exact same capturedAgeDecay/spread tuning for a
  // "just joined, still tight" trail look, so captured swirl points ride the
  // comet's tail the same way captured stardust already does.
  private _buildSwirlField(): void {
    this.camera.getWorldPosition(this._scratchSwirlCenter);
    this.camera.getWorldDirection(this._scratchSwirlDir);
    this._scratchSwirlCenter.addScaledVector(this._scratchSwirlDir, SWIRL_FORWARD_DISTANCE);

    this._swirlField = new GatherableField({
      count: SWIRL_POINT_COUNT,
      spawnCenter: [this._scratchSwirlCenter.x, this._scratchSwirlCenter.y, this._scratchSwirlCenter.z],
      spawnRadiusMin: 0,
      spawnRadiusMax: SWIRL_ARM_RADIUS,
      attractRadius: 0.4,
      captureDistance: 0.05,
      attractRate: 3.0,
      capturedAgeDecay: 3.0,
      capturedSpreadBase: 0.01,
      capturedSpreadGrowth: 0.02,
      capturedDepthRatio: 1.4,
      spawnPoint: (index) => this._swirlSpawnPoint(index),
      onCapture: (_index, x, y, z, speed) => {
        this._swirlCaptureEvents.push({ x, y, z, speed });
      },
      onAttractStart: (_index, x, y, z, speed) => {
        this._swirlAttractEvents.push({ x, y, z, speed });
      },
    });
  }

  // Own progress state resets on play() — GameDirectorSystem only resets
  // the shared phaseComplete signal, not each phase's internal state. This
  // is what gives a fresh stardust field every replay loop.
  play(): void {
    super.play();
    this._field.reset();
    this._hasWon = false;
    this._elapsed = 0;
    this._swirling = false;
    this._swirlElapsed = 0;
    this._swirlField = null;
    this._captureEvents.length = 0;
    this._attractEvents.length = 0;
    this._swirlCaptureEvents.length = 0;
    this._swirlAttractEvents.length = 0;
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
    if (this._swirlField) {
      this._swirlField.step(this._hand, delta);
    }

    this._elapsed += delta;
    const fraction = this._field.totalCaptured / N_STARDUST;

    if (!this._swirling) {
      if (fraction >= SWIRL_TRIGGER_FRACTION || this._elapsed >= SWIRL_TRIGGER_TIMEOUT_SECONDS) {
        this._swirling = true;
        this._swirlElapsed = 0;
        this._buildSwirlField();
      }
    } else if (!this._hasWon) {
      this._swirlElapsed += delta;
      const swirlFraction = this._swirlField!.totalCaptured / SWIRL_POINT_COUNT;
      if (swirlFraction >= FINALE_TRIGGER_FRACTION || this._swirlElapsed >= FINALE_EXTRA_SECONDS) {
        this._hasWon = true;
        const notifications = this.world.getSystem(NotificationHudSystem);
        const lastIndex = STARDUST_WIN_SEQUENCE.length - 1;
        STARDUST_WIN_SEQUENCE.forEach((entry, i) => {
          // Only the last message's onComplete flips phaseComplete — it fires
          // once that message has actually finished its own on-screen fade-
          // out, whatever else (e.g. Stardust's own still-playing intro
          // blurb) was already queued ahead of it. A hand-rolled duration
          // estimate can't know that, and previously let phaseComplete flip
          // — and GameDirector transition to Pebbles — before the win
          // sequence had actually been shown at all.
          const onComplete =
            i === lastIndex ? () => (getGlobals(this.world).phaseComplete.value = true) : undefined;
          notifications?.notify(entry.text, entry.holdSeconds, 0, undefined, onComplete);
        });
      }
    }
  }

  // Read by StardustVfxSystem to reveal the swirl finale visuals and swap
  // the pickup/catch sound to the square-wave synth (see
  // PixelTwinkleSynth) — level-triggered, no event needed since the VFX
  // system already polls this every frame for other state.
  isSwirling(): boolean {
    return this._swirling;
  }

  // Read-only accessors for StardustVfxSystem — no copying, callers must
  // not mutate.
  getPositions(): Float32Array {
    return this._field.positions;
  }
  getStates(): Uint8Array {
    return this._field.states;
  }
  getCapturedField(): CapturedField {
    return this._field.capturedField;
  }
  getCapturedIndices(): readonly number[] {
    return this._field.captured;
  }
  getParticleCount(): number {
    return N_STARDUST;
  }
  // Returns this frame's capture events and clears the queue — see
  // CaptureEvent.
  drainCaptureEvents(): readonly CaptureEvent[] {
    if (this._captureEvents.length === 0) return this._captureEvents;
    const events = this._captureEvents;
    this._captureEvents = [];
    return events;
  }
  // Returns this frame's pickup (Free -> Attracting) events and clears the
  // queue — see AttractEvent.
  drainAttractEvents(): readonly AttractEvent[] {
    if (this._attractEvents.length === 0) return this._attractEvents;
    const events = this._attractEvents;
    this._attractEvents = [];
    return events;
  }

  // Lets PlanetSeedingSystem "spend" already-gathered stardust — see
  // GatherableField.releaseCaptured for the exact contract.
  releaseCaptured(particleIndex: number): void {
    this._field.releaseCaptured(particleIndex);
  }

  // Read by StardustVfxSystem to render the swirl once it exists — null
  // until Stage A triggers (see _buildSwirlField), and again after every
  // play() until the next loop reaches Stage A.
  getSwirlField(): GatherableField | null {
    return this._swirlField;
  }
  getSwirlPointCount(): number {
    return SWIRL_POINT_COUNT;
  }
  // Same drain-and-clear contract as drainCaptureEvents/drainAttractEvents
  // above, for the swirl's own catch/pickup cues.
  drainSwirlCaptureEvents(): readonly CaptureEvent[] {
    if (this._swirlCaptureEvents.length === 0) return this._swirlCaptureEvents;
    const events = this._swirlCaptureEvents;
    this._swirlCaptureEvents = [];
    return events;
  }
  drainSwirlAttractEvents(): readonly AttractEvent[] {
    if (this._swirlAttractEvents.length === 0) return this._swirlAttractEvents;
    const events = this._swirlAttractEvents;
    this._swirlAttractEvents = [];
    return events;
  }
}
