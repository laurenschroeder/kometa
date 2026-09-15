import { createSystem, Matrix4, Quaternion, Vector3 } from '@iwsdk/core';
import { AchievementSystem } from '../../core/achievement-system.js';
import { CometBody } from '../../comet/comet-body-component.js';
import { CapturedField, GatherableField, GatherHandInput } from '../../comet/gatherable-field.js';
import { HandAnchor } from '../../comet/hand-anchor-component.js';
import { getGlobals } from '../../core/globals.js';
import { NotificationHudSystem } from '../../core/notification-hud-system.js';
import { STARDUST_INTRO_TEXT, STARDUST_WIN_SEQUENCE } from '../../core/notification-copy.js';
import { scatterDisc, scatterGalaxyArm } from '../../vfx/geometry/pixel-swirl.js';

const N_STARDUST = 500;

// Three-swirl finale: once the main field is SWIRL_FIRST_REVEAL_FRACTION
// gathered, three gold pixel-CRT swirls (see StardustVfxSystem) arrive one
// after another on a fixed timer (SWIRL_REVEAL_DELAYS_SECONDS), fanned
// center/left/right of wherever the player was facing when the phase started
// (see SWIRL_REVEAL_ANGLES_DEG/play()). Each is rotated to face the player's
// head at the moment it appears, then stays fixed — not billboarded after
// that. Gathering continues throughout; once all three exist, the COMBINED
// capture fraction across them (or the extra-time timeout) fires
// STARDUST_WIN_SEQUENCE and ends the phase. See index.ts's Phase.Stardust
// timeoutSeconds (150) — the worst-case reveal/finale durations plus the
// notification sequence's own playback time need to fit inside it.
const SWIRL_COUNT = 3;
const SWIRL_FIRST_REVEAL_FRACTION = 0.5;
// Seconds after the reveal sequence starts that each swirl appears —
// index-matched against SWIRL_REVEAL_ANGLES_DEG (center, then left, then right).
const SWIRL_REVEAL_DELAYS_SECONDS = [0, 3, 6];
const SWIRL_REVEAL_ANGLES_DEG = [0, -45, 45];
// Safety net: if the player stalls below SWIRL_FIRST_REVEAL_FRACTION, start
// the reveal sequence anyway rather than leaving the phase stuck.
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
  // See STARDUST_INTRO_TEXT's own comment — the intro notification holds
  // (a generous 60s fallback cap, not the real hold time) until the player
  // actually gathers their first stardust, dismissed here exactly once.
  private _introDismissed = false;

  // Index-matched against SWIRL_REVEAL_DELAYS_SECONDS/SWIRL_REVEAL_ANGLES_DEG.
  // Each field is built lazily the moment its own reveal time arrives (see
  // _buildSwirlField) — its spawnCenter needs the reference forward captured
  // at play(), and its facing needs the player's head at reveal time. All
  // null again on every fresh play().
  private _swirlFields: (GatherableField | null)[] = [null, null, null];
  private _swirlRevealed: boolean[] = [false, false, false];
  // this._elapsed when the reveal sequence started (first swirl appeared);
  // -1 until then. See SWIRL_REVEAL_DELAYS_SECONDS.
  private _firstSwirlRevealAt = -1;
  private _swirlCaptureEvents: CaptureEvent[][] = [[], [], []];
  private _swirlAttractEvents: AttractEvent[][] = [[], [], []];

  private _hand!: GatherHandInput;
  private _scratchVel!: Vector3;
  private _scratchSwirlCenter!: Vector3;
  private _scratchSwirlDir!: Vector3;
  private _scratchCamPos!: Vector3;
  private _scratchSwirlMat!: Matrix4;
  // Facing rotation for the swirl currently being built — read by
  // _swirlSpawnPoint, which GatherableField's constructor calls synchronously.
  private _swirlFacing!: Quaternion;
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
    this._scratchCamPos = new Vector3();
    this._scratchSwirlMat = new Matrix4();
    this._swirlFacing = new Quaternion();
    this._refPos = new Vector3();
    this._refForward = new Vector3();
  }

  // Converts one flat index (0..SWIRL_POINT_COUNT) into a spiral-galaxy
  // spawn point — arm points first, then a small core cluster — matching
  // GatherableFieldParams.spawnPoint's {dir, radiusT, type} contract (see
  // pebble-layout.ts's assignPebbleSpawnPoint for the established precedent
  // of converting a raw scattered position into that shape). type is unused
  // here (only one visual treatment), always 0. Shared by every swirl — the
  // shape is identical, only spawnCenter and facing (see _buildSwirlField)
  // differ.
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
    const dir = new Vector3(p[0] / r, p[1] / r, p[2] / r).applyQuaternion(this._swirlFacing);
    return { dir, radiusT: r / SWIRL_ARM_RADIUS, type: 0 };
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
    // The galaxy shape lies in its local XY plane; aim local Z at the
    // player's head as it is right now, keeping world up as up — a one-time
    // billboard rotation baked into the spawn positions.
    this.camera.getWorldPosition(this._scratchCamPos);
    this._scratchSwirlMat.lookAt(this._scratchSwirlCenter, this._scratchCamPos, UP_AXIS);
    this._swirlFacing.setFromRotationMatrix(this._scratchSwirlMat);

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
    this._introDismissed = false;
    this._elapsed = 0;
    this._finaleElapsed = 0;
    this._swirlFields = [null, null, null];
    this._swirlRevealed = [false, false, false];
    this._firstSwirlRevealAt = -1;
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

    if (!this._introDismissed && this._field.totalCaptured > 0) {
      this._introDismissed = true;
      this.world.getSystem(NotificationHudSystem)?.dismissByText(STARDUST_INTRO_TEXT);
    }

    this._elapsed += delta;
    const fraction = this._field.totalCaptured / N_STARDUST;
    if (
      this._firstSwirlRevealAt < 0 &&
      (fraction >= SWIRL_FIRST_REVEAL_FRACTION || this._elapsed >= SWIRL_REVEAL_TIMEOUT_SECONDS)
    ) {
      this._firstSwirlRevealAt = this._elapsed;
    }
    if (this._firstSwirlRevealAt >= 0) {
      const sinceFirst = this._elapsed - this._firstSwirlRevealAt;
      for (let slot = 0; slot < SWIRL_COUNT; slot++) {
        if (this._swirlRevealed[slot] || sinceFirst < SWIRL_REVEAL_DELAYS_SECONDS[slot]) continue;
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
        // A "you gathered enough" success cue, distinct from 'full-sweep'
        // below — that achievement only unlocks on a literal 100% capture,
        // so a normal (70%+) win otherwise played no sound at all.
        this.world.getSystem(AchievementSystem)?.playSuccessChime();
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
            i === lastIndex
              ? () => {
                  // Checked here, not at the FINALE_TRIGGER_FRACTION(0.7)
                  // threshold above — gathering keeps running the whole time
                  // this win-sequence notification plays out (see this
                  // update()'s own field.step() calls, unguarded by
                  // _hasWon), so a player who keeps sweeping during those
                  // ~9-13s can still reach every last mote before the phase
                  // actually ends.
                  let finalCaptured = 0;
                  for (const field of this._swirlFields) finalCaptured += field?.totalCaptured ?? 0;
                  if (finalCaptured >= SWIRL_COUNT * SWIRL_POINT_COUNT) {
                    this.world.getSystem(AchievementSystem)?.unlock('full-sweep');
                  }
                  getGlobals(this.world).phaseComplete.value = true;
                }
              : undefined;
          notifications?.notify(entry.text, entry.holdSeconds, 0, undefined, onComplete);
        });
      }
    }
  }

  // Read by StardustVfxSystem to swap the pickup/catch sound to the
  // glittery/magical/fizzy synth (see SwirlSynth) — true from the moment the
  // FIRST swirl reveals, level-triggered, no event needed since the VFX
  // system already polls this every frame for other state.
  isSwirling(): boolean {
    return this._swirlRevealed[0];
  }
  // 0-1 overall phase progress for HandProgressHudSystem's wrist bar —
  // gathering toward the swirl reveal threshold fills the first
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
    const gatherProgress = Math.min(1, this._field.totalCaptured / N_STARDUST / SWIRL_FIRST_REVEAL_FRACTION);
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
