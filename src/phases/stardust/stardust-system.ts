import { createSystem, Vector3 } from '@iwsdk/core';
import { CometBody } from '../../comet/comet-body-component.js';
import { CapturedField, GatherableField, GatherHandInput } from '../../comet/gatherable-field.js';
import { HandAnchor } from '../../comet/hand-anchor-component.js';
import { getGlobals } from '../../core/globals.js';
import { NotificationHudSystem } from '../../core/notification-hud-system.js';
import { STARDUST_WIN_SEQUENCE } from '../../core/notification-copy.js';

const N_STARDUST = 500;
const WIN_CAPTURE_COUNT = Math.ceil(N_STARDUST * 0.35);

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
  private _captureEvents: CaptureEvent[] = [];
  private _attractEvents: AttractEvent[] = [];

  private _hand!: GatherHandInput;
  private _scratchVel!: Vector3;

  init(): void {
    this._field = new GatherableField({
      count: N_STARDUST,
      spawnCenter: [0, 1.2, 0],
      spawnRadiusMin: 0.5,
      spawnRadiusMax: 1.8,
      attractRadius: 0.4,
      captureDistance: 0.05,
      slowSpeed: 0.5,
      fastSpeed: 1.5,
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
  }

  // Own progress state resets on play() — GameDirectorSystem only resets
  // the shared phaseComplete signal, not each phase's internal state. This
  // is what gives a fresh stardust field every replay loop.
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
      const notifications = this.world.getSystem(NotificationHudSystem);
      for (const entry of STARDUST_WIN_SEQUENCE) {
        notifications?.notify(entry.text, entry.holdSeconds);
      }
    }
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
}
