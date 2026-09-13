import { createSystem, Vector3 } from '@iwsdk/core';
import { CometBody } from '../../comet/comet-body-component.js';
import { CapturedField, GatherableField, GatherHandInput } from '../../comet/gatherable-field.js';
import { HandAnchor } from '../../comet/hand-anchor-component.js';
import { getGlobals } from '../../core/globals.js';
import { NotificationHudSystem } from '../../core/notification-hud-system.js';
import { STARDUST_WIN_SEQUENCE } from '../../core/notification-copy.js';
import { scatterDisc, scatterGalaxyArm } from '../../vfx/geometry/pixel-swirl.js';

const N_STARDUST = 500;

// Three-swirl finale, replacing the old single-swirl two-stage design.
// Instead of one swirl appearing at a single 80%-gathered trigger, three
// independent gold pixel-CRT swirls (see StardustVfxSystem) reveal
// progressively as the main field fills — fanned left/center/right of
// wherever the player was facing when the phase started (see
// SWIRL_REVEAL_ANGLES_DEG/play()), rather than all stacked in the same
// forward spot. Gathering continues throughout — this isn't the end of the
// phase. Once all three have revealed, the finale proper begins: the
// COMBINED capture fraction across all three (or the extra-time timeout) is
// what fires STARDUST_WIN_SEQUENCE and ends the phase. See index.ts's
// Phase.Stardust timeoutSeconds (150) — the worst-case reveal/finale
// durations plus the notification sequence's own playback time need to fit
// comfortably inside that safety-net timeout.
const SWIRL_COUNT = 3;
// Fraction of N_STARDUST captured that reveals each swirl — index-matched
// against SWIRL_REVEAL_ANGLES_DEG below (center first, then left, then
// right), so the very first swirl still appears dead ahead, same as the old
// single-swirl behavior, before the fan opens up to the sides.
const SWIRL_REVEAL_THRESHOLDS = [0.5, 0.7, 0.8];
const SWIRL_REVEAL_ANGLES_DEG = [0, -45, 45];
// Safety net: if the player stalls below the last threshold, force-reveal
// every remaining swirl anyway rather than leaving the phase stuck at "2 of
// 3" forever.
const SWIRL_REVEAL_TIMEOUT_SECONDS = 60;
// Combined (summed across all three swirls) capture-fraction target once the
// last swirl has revealed — lower than the old single-swirl FINALE_TRIGGER_
// FRACTION (0.9) since there's 3x the swirl content to sweep through now.
const FINALE_TRIGGER_FRACTION = 0.7;
const FINALE_EXTRA_SECONDS = 40;

// Each swirl's own shape/spawn tuning — a small spiral-galaxy layout (same
// scatterGalaxyArm/scatterDisc math the old decorative swirl used, see
// pixel-swirl.ts) reused as a live GatherableField's spawnPoint instead of a
// static Points cloud, so its points can be attracted/captured exactly like
// the ambient stardust motes are. 90 points per swirl — sized for "a
// satisfying sweep-through," not a dense decorative cloud.
const SWIRL_ARM_COUNT = 5;
const SWIRL_TURNS = 1.0;
const SWIRL_ARM_RADIUS = 0.35;
const SWIRL_ARM_POINT_COUNT = 70;
const SWIRL_CORE_RADIUS = 0.08;
const SWIRL_CORE_POINT_COUNT = 20;
const SWIRL_POINT_COUNT = SWIRL_ARM_POINT_COUNT + SWIRL_CORE_POINT_COUNT;
const SWIRL_SPREAD_FACTOR = 0.22;
const SWIRL_DEPTH_JITTER = 0.03;
// How far from the player's head each swirl appears, along its own fanned
// angle off the shared reference forward captured at play() — see
// SWIRL_REVEAL_ANGLES_DEG.
const SWIRL_FORWARD_DISTANCE = 1.2;
const UP_AXIS = new Vector3(0, 1, 0);

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
  // from GameDirectorSystem's private phase-elapsed tracking, since the
  // reveal timeout/finale window below need to check it independently of
  // any single director-level timeout.
  private _elapsed = 0;
  // Seconds since the LAST swirl revealed — gates the finale's own timeout
  // leg (see FINALE_EXTRA_SECONDS). Only advances once every swirl exists.
  private _finaleElapsed = 0;
  private _captureEvents: CaptureEvent[] = [];
  private _attractEvents: AttractEvent[] = [];

  // Index-matched against SWIRL_REVEAL_THRESHOLDS/SWIRL_REVEAL_ANGLES_DEG.
  // Each field is built lazily the instant its own threshold is crossed (see
  // _buildSwirlField) — its spawnCenter needs the reference forward captured
  // at play() time, only known once the phase actually starts. All null
  // again on every fresh play().
  private _swirlFields: (GatherableField | null)[] = [null, null, null];
  private _swirlRevealed: boolean[] = [false, false, false];
  private _swirlCaptureEvents: CaptureEvent[][] = [[], [], []];
  private _swirlAttractEvents: AttractEvent[][] = [[], [], []];

  private _hand!: GatherHandInput;
  private _scratchVel!: Vector3;
  private _scratchSwirlCenter!: Vector3;
  private _scratchSwirlDir!: Vector3;
  // Reference position/forward captured once at play() — every swirl's fan
  // angle is measured off this SAME shared reference (not re-sampled at each
  // swirl's own reveal moment), so all three read as one coherent left/
  // center/right fan rather than three independently-aimed spots.
  private _refPos!: Vector3;
  private _refForward!: Vector3;

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
    this._refPos = new Vector3();
    this._refForward = new Vector3();
  }

  // Converts one flat index (0..SWIRL_POINT_COUNT) into a spiral-galaxy
  // spawn point — arm points first, then a small core cluster — matching
  // GatherableFieldParams.spawnPoint's {dir, radiusT, type} contract (see
  // pebble-layout.ts's assignPebbleSpawnPoint for the established precedent
  // of converting a raw scattered position into that shape). type is unused
  // here (only one visual treatment), always 0. Shared by every swirl — the
  // shape is identical, only spawnCenter (see _buildSwirlField) differs.
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

  // Builds swirl `slot` as its own independent GatherableField, centered
  // along its fanned angle (SWIRL_REVEAL_ANGLES_DEG[slot]) off the shared
  // reference forward captured at play() — same attract/capture tuning the
  // main stardust field already uses, and the exact same capturedAgeDecay/
  // spread tuning for a "just joined, still tight" trail look, so captured
  // swirl points ride the comet's tail the same way captured stardust does.
  private _buildSwirlField(slot: number): void {
    const angleRad = (SWIRL_REVEAL_ANGLES_DEG[slot] * Math.PI) / 180;
    this._scratchSwirlDir.copy(this._refForward).applyAxisAngle(UP_AXIS, angleRad);
    this._scratchSwirlCenter.copy(this._refPos).addScaledVector(this._scratchSwirlDir, SWIRL_FORWARD_DISTANCE);

    this._swirlFields[slot] = new GatherableField({
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
        this._swirlCaptureEvents[slot].push({ x, y, z, speed });
      },
      onAttractStart: (_index, x, y, z, speed) => {
        this._swirlAttractEvents[slot].push({ x, y, z, speed });
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
    this._finaleElapsed = 0;
    this._swirlFields = [null, null, null];
    this._swirlRevealed = [false, false, false];
    this._captureEvents.length = 0;
    this._attractEvents.length = 0;
    for (const arr of this._swirlCaptureEvents) arr.length = 0;
    for (const arr of this._swirlAttractEvents) arr.length = 0;

    this.camera.getWorldPosition(this._refPos);
    this.camera.getWorldDirection(this._refForward);
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
    for (const field of this._swirlFields) {
      field?.step(this._hand, delta);
    }

    this._elapsed += delta;
    const fraction = this._field.totalCaptured / N_STARDUST;
    const forceReveal = this._elapsed >= SWIRL_REVEAL_TIMEOUT_SECONDS;
    for (let slot = 0; slot < SWIRL_COUNT; slot++) {
      if (!this._swirlRevealed[slot] && (fraction >= SWIRL_REVEAL_THRESHOLDS[slot] || forceReveal)) {
        this._swirlRevealed[slot] = true;
        this._buildSwirlField(slot);
      }
    }

    const allRevealed = this._swirlRevealed.every(Boolean);
    if (allRevealed && !this._hasWon) {
      this._finaleElapsed += delta;
      let totalCaptured = 0;
      for (const field of this._swirlFields) {
        totalCaptured += field?.totalCaptured ?? 0;
      }
      const combinedFraction = totalCaptured / (SWIRL_COUNT * SWIRL_POINT_COUNT);
      if (combinedFraction >= FINALE_TRIGGER_FRACTION || this._finaleElapsed >= FINALE_EXTRA_SECONDS) {
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

  // Read by StardustVfxSystem to swap the pickup/catch sound to the
  // square-wave synth (see PixelTwinkleSynth) — true from the moment the
  // FIRST swirl reveals, level-triggered, no event needed since the VFX
  // system already polls this every frame for other state.
  isSwirling(): boolean {
    return this._swirlRevealed[0];
  }
  // 0-1 overall phase progress for HandProgressHudSystem's wrist bar —
  // gathering toward the last swirl's own reveal threshold fills the first
  // half, the finale (combined capture across all three swirls) fills the
  // second, so the bar reads as one continuous gauge across both stretches
  // instead of resetting/jumping as each swirl appears.
  getProgress01(): number {
    // Win is declared once the COMBINED swirl fraction crosses
    // FINALE_TRIGGER_FRACTION (0.7) or the finale timeout fires — neither
    // means every last point has actually been swept up, so without this
    // the bar would read some partial value (and only creep slowly toward
    // 100 as remaining points trickle in during the win-sequence
    // notification) right as the player is told they're done. Snap to 100
    // the instant that sequence starts instead.
    if (this._hasWon) return 1;
    const lastThreshold = SWIRL_REVEAL_THRESHOLDS[SWIRL_REVEAL_THRESHOLDS.length - 1];
    const gatherProgress = Math.min(1, this._field.totalCaptured / N_STARDUST / lastThreshold);
    if (!this._swirlRevealed.every(Boolean)) return gatherProgress * 0.5;
    let totalCaptured = 0;
    for (const field of this._swirlFields) {
      totalCaptured += field?.totalCaptured ?? 0;
    }
    const finaleProgress = Math.min(1, totalCaptured / (SWIRL_COUNT * SWIRL_POINT_COUNT));
    return 0.5 + finaleProgress * 0.5;
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

  // How many swirls exist total — StardustVfxSystem iterates 0..this count
  // rather than hardcoding SWIRL_COUNT itself.
  getSwirlCount(): number {
    return SWIRL_COUNT;
  }
  // Read by StardustVfxSystem to render swirl `slot` once it exists — null
  // until that slot's own reveal threshold is crossed (see
  // _buildSwirlField), and again after every play() until the next loop
  // reaches it.
  getSwirlField(slot: number): GatherableField | null {
    return this._swirlFields[slot];
  }
  getSwirlPointCount(): number {
    return SWIRL_POINT_COUNT;
  }
  // Same drain-and-clear contract as drainCaptureEvents/drainAttractEvents
  // above, for swirl `slot`'s own catch/pickup cues.
  drainSwirlCaptureEvents(slot: number): readonly CaptureEvent[] {
    const events = this._swirlCaptureEvents[slot];
    if (events.length === 0) return events;
    this._swirlCaptureEvents[slot] = [];
    return events;
  }
  drainSwirlAttractEvents(slot: number): readonly AttractEvent[] {
    const events = this._swirlAttractEvents[slot];
    if (events.length === 0) return events;
    this._swirlAttractEvents[slot] = [];
    return events;
  }
}
