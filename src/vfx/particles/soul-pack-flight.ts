import { Vector3 } from '@iwsdk/core';

const OUTBOUND_DURATION = 2.0; // seconds, trail position -> first waypoint
const VISIT_DURATION = 5.0; // seconds, sweeping through all waypoints
const RETURN_DURATION = 2.0; // seconds, last-visited point -> live comet position
const ORBIT_RADIUS = 0.05; // meters, per-slot loose-cluster offset around the shared pack centroid during Visiting
const ORBIT_SPEED_MIN = 0.6;
const ORBIT_SPEED_MAX = 1.1; // rad/s, randomized per slot so the pack doesn't read as a rigid rotating ring

const enum FlightPhase {
  Idle,
  Outbound,
  Visiting,
  Return,
}

function smoothstep(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

// "A pack of soul pebbles detaches from the comet's tail, sweeps through
// every crowd waypoint, then returns" state machine — modeled directly on
// GhostRise's plain build()/trigger()/update()/reset() idiom, but drives N
// picked pebble SLOTS (indices into one comet's own N_PEBBLES) instead of
// one dedicated mesh. Owned one-per-CometVisual (see
// PebbleCometPresentationSystem._buildVisual), not a System — same
// single-journey-at-a-time discipline as GhostRise, just scoped per comet
// instead of globally (there's only ever one comet, so in practice this is
// still effectively single-instance).
export class SoulPackFlight {
  private _phase: FlightPhase = FlightPhase.Idle;
  private _t = 0; // 0..1 within the current phase
  private _slots: number[] = [];
  private _slotIndex = new Map<number, number>(); // slot -> index into the per-slot arrays below
  private _fromPositions: Vector3[] = []; // per-slot Outbound start, captured once at trigger()
  private _waypoints: Vector3[] = []; // shared, world-space (FateEventSystem.getSurfacePositions() subset)
  private _orbitPhase: number[] = [];
  private _orbitSpeed: number[] = [];
  private _returnFrom = new Vector3(); // pack centroid at the Visiting->Return handoff
  private _onComplete: (() => void) | null = null;

  private _scratchCentroid = new Vector3();

  trigger(
    slots: number[],
    fromPositions: Vector3[],
    waypoints: readonly Vector3[],
    onComplete?: () => void,
  ): void {
    if (this._phase !== FlightPhase.Idle) return; // one pack journey at a time
    this._slots = slots.slice();
    this._slotIndex.clear();
    this._fromPositions = fromPositions.map((v) => v.clone());
    this._waypoints = waypoints.map((v) => v.clone());
    this._orbitPhase = [];
    this._orbitSpeed = [];
    for (let i = 0; i < slots.length; i++) {
      this._slotIndex.set(slots[i], i);
      this._orbitPhase.push(Math.random() * Math.PI * 2);
      this._orbitSpeed.push(ORBIT_SPEED_MIN + Math.random() * (ORBIT_SPEED_MAX - ORBIT_SPEED_MIN));
    }
    this._phase = FlightPhase.Outbound;
    this._t = 0;
    this._onComplete = onComplete ?? null;
  }

  isActive(slot: number): boolean {
    return this._phase !== FlightPhase.Idle && this._slotIndex.has(slot);
  }

  // Advances the phase timer and (during Visiting) each slot's orbit angle.
  // Does NOT need cometPos itself — that's only consulted by getPosition()'s
  // Return-phase lerp, called separately per-slot by the caller with
  // whatever cometPos is current at that point in the frame.
  update(delta: number): void {
    if (this._phase === FlightPhase.Idle) return;

    if (this._phase === FlightPhase.Visiting) {
      for (let i = 0; i < this._orbitPhase.length; i++) {
        this._orbitPhase[i] += this._orbitSpeed[i] * delta;
      }
    }

    if (this._phase === FlightPhase.Outbound) {
      this._t = Math.min(1, this._t + delta / OUTBOUND_DURATION);
      if (this._t >= 1) {
        this._phase = FlightPhase.Visiting;
        this._t = 0;
      }
      return;
    }
    if (this._phase === FlightPhase.Visiting) {
      this._t = Math.min(1, this._t + delta / VISIT_DURATION);
      if (this._t >= 1) {
        this._centroidAt(1, this._returnFrom);
        this._phase = FlightPhase.Return;
        this._t = 0;
      }
      return;
    }
    // Return
    this._t = Math.min(1, this._t + delta / RETURN_DURATION);
    if (this._t >= 1) {
      const cb = this._onComplete;
      this.reset();
      cb?.();
    }
  }

  // Fills `out` with slot's current world position; returns false if the
  // slot isn't part of an active flight (caller should fall back to its own
  // normal trail-sampled position in that case).
  getPosition(slot: number, out: Vector3, cometPos: Vector3): boolean {
    const idx = this._slotIndex.get(slot);
    if (idx === undefined) return false;

    if (this._phase === FlightPhase.Outbound) {
      this._centroidAt(0, this._scratchCentroid);
      out.copy(this._fromPositions[idx]).lerp(this._scratchCentroid, smoothstep(this._t));
      return true;
    }
    if (this._phase === FlightPhase.Visiting) {
      this._centroidAt(this._t, this._scratchCentroid);
      out.set(
        this._scratchCentroid.x + Math.cos(this._orbitPhase[idx]) * ORBIT_RADIUS,
        this._scratchCentroid.y,
        this._scratchCentroid.z + Math.sin(this._orbitPhase[idx]) * ORBIT_RADIUS,
      );
      return true;
    }
    // Return — the pack converges to a point as it heads home, no orbit offset.
    out.copy(this._returnFrom).lerp(cometPos, smoothstep(this._t));
    return true;
  }

  reset(): void {
    this._phase = FlightPhase.Idle;
    this._slots = [];
    this._slotIndex.clear();
    this._t = 0;
    this._onComplete = null;
  }

  private _centroidAt(t: number, out: Vector3): void {
    const n = this._waypoints.length;
    if (n === 0) {
      out.set(0, 0, 0);
      return;
    }
    if (n === 1) {
      out.copy(this._waypoints[0]);
      return;
    }
    const seg = t * (n - 1);
    const i0 = Math.min(n - 2, Math.floor(seg));
    const i1 = i0 + 1;
    out.copy(this._waypoints[i0]).lerp(this._waypoints[i1], smoothstep(seg - i0));
  }
}
