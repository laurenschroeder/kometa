import { Vector3 } from '@iwsdk/core';
import { randomUnitVector3 } from '../vfx/geometry/mesh-utils.js';
import { sampleRadialPoint } from '../vfx/particles/particle-field.js';

// 1/s exponential decay applied to a particle's last-known attraction
// velocity once it stops being pulled (left attractRadius, or the hand
// dropped out) without reaching captureDistance — a slow coast-out instead
// of freezing in place the instant the lerp toward the hand stops running.
const COAST_DECAY_RATE = 2.0;
// Below this speed the residual drift is imperceptible — snap to exactly 0
// rather than lerping forever.
const COAST_STOP_SPEED_SQ = 0.0001; // (0.01 m/s)^2

// Plain (not const) enum — const enums don't survive esbuild's single-file
// transpilation (used by Vite), which isolatedModules is set to catch.
export enum GatherState {
  Free = 0,
  Attracting = 1,
  Captured = 2,
}

export interface GatherHandInput {
  position: Vector3;
  speed: number;
  seen: boolean;
}

export interface CapturedField {
  t: Float32Array;
  dx: Float32Array;
  dy: Float32Array;
  dz: Float32Array;
}

export interface GatherableFieldParams {
  count: number;
  // Spawn shell around the player — a comfortable arm's-reach-and-beyond
  // volume so gathering means actually moving around, not just standing still.
  spawnCenter: [number, number, number];
  spawnRadiusMin: number;
  spawnRadiusMax: number;
  // The comet "notices" a particle within this radius; attraction strength
  // then scales by how slow it's moving, rewarding gentle, deliberate
  // gestures over fast grabbing.
  attractRadius: number;
  captureDistance: number;
  slowSpeed: number; // m/s — at or below this, full attraction strength
  fastSpeed: number; // m/s — at or above this, ~no attraction
  attractRate: number; // 1/s exponential approach rate at full strength
  // Distribution for a newly captured particle riding the comet's trail (see
  // vfx/particles/trail-sampler.ts) — how "far back" and spread out it lands.
  capturedAgeDecay: number;
  capturedSpreadBase: number;
  capturedSpreadGrowth: number;
  capturedDepthRatio: number;
  // Optional: fully overrides per-particle spawn direction/radius/type
  // generation, called once per particle at construction time instead of
  // the default uniform-random-direction (randomUnitVector3()) + uniform
  // radius path — for fields whose type needs to depend on WHERE a
  // particle spawns (e.g. Pebbles' angular red-ring/patch layout, where
  // direction and color are decided together; see pebble-layout.ts).
  // radiusT is 0-1, mapped the same way the default path already does (0 at
  // spawnRadiusMin, 1 at spawnRadiusMax). assignedType is set from `type`
  // once, permanently — unlike the plain-radius case there's no per-loop
  // re-derivation to do, since direction/type are fixed together at spawn.
  // Omit for fields that don't need typed/directional particles (e.g.
  // Stardust) — assignedType stays unused zeros and costs nothing extra.
  spawnPoint?: (index: number) => { dir: Vector3; radiusT: number; type: number };
  // Optional: fired the instant a particle crosses captureDistance, with its
  // world position and the hand's speed at that moment (e.g. for a per-catch
  // sound/VFX cue). Omit for fields that don't need this.
  onCapture?: (index: number, x: number, y: number, z: number, speed: number) => void;
  // Optional: fired the instant a particle transitions Free -> Attracting
  // (e.g. for a quiet "you've picked this one up" cue). Omit for fields
  // that don't need this.
  onAttractStart?: (index: number, x: number, y: number, z: number, speed: number) => void;
}

// The "ambient collectible" mechanic shared by every gather-based chapter: N
// particles scattered in a shell around the player; the comet (there's only
// one — see comet/comet-handoff-system.ts) pulls nearby particles in within
// attractRadius, strength scaling down as its speed increases; once within
// captureDistance a particle is "captured" and assigned a random spot in the
// comet's trail-riding field, reusing the same distribution math the pebble
// body's tail uses. First built for Chapter 1 (stardust motes), reused
// as-is for Chapter 2 (ambient pebbles) — only the counts/spawn volume/visual
// differ; the gather physics itself never does. Not an ECS System itself
// (systems can't be parameterized per phase) — each phase's own gameplay
// system owns one instance and drives it from its query/update().
export class GatherableField {
  readonly positions: Float32Array; // count*3, world position while Free/Attracting
  readonly states: Uint8Array; // count, GatherState
  readonly capturedT: Float32Array;
  readonly capturedDX: Float32Array;
  readonly capturedDY: Float32Array;
  readonly capturedDZ: Float32Array;
  readonly captured: number[] = []; // field-slot indices, in capture order
  // Assigned once per particle (see params.spawnPoint) — valid for every
  // particle regardless of state, not just once Captured, so a VFX layer
  // can color the whole ambient field from the moment it spawns.
  readonly assignedType: Uint8Array;

  private readonly _params: GatherableFieldParams;
  private readonly _spawnPos: Float32Array;
  private readonly _spawnRadiusT: Float32Array; // count, normalized 0-1 spawn distance
  private readonly _scratchPos = new Vector3();
  private readonly _typeCounts: number[] = [0, 0, 0];
  // Last-known velocity while Attracting — carried forward as a decaying
  // coast once a particle stops being pulled without reaching
  // captureDistance (see COAST_DECAY_RATE above).
  private readonly _velX: Float32Array;
  private readonly _velY: Float32Array;
  private readonly _velZ: Float32Array;

  constructor(params: GatherableFieldParams) {
    this._params = params;
    const n = params.count;
    this.positions = new Float32Array(n * 3);
    this._spawnPos = new Float32Array(n * 3);
    this._spawnRadiusT = new Float32Array(n);
    this.states = new Uint8Array(n);
    this.capturedT = new Float32Array(n);
    this.capturedDX = new Float32Array(n);
    this.capturedDY = new Float32Array(n);
    this.capturedDZ = new Float32Array(n);
    this.assignedType = new Uint8Array(n);
    this._velX = new Float32Array(n);
    this._velY = new Float32Array(n);
    this._velZ = new Float32Array(n);

    const [cx, cy, cz] = params.spawnCenter;
    const radiusRange = params.spawnRadiusMax - params.spawnRadiusMin;
    const dir = new Vector3();
    for (let i = 0; i < n; i++) {
      let r: number;
      if (params.spawnPoint) {
        const sp = params.spawnPoint(i);
        dir.copy(sp.dir);
        r = params.spawnRadiusMin + sp.radiusT * radiusRange;
        this._spawnRadiusT[i] = sp.radiusT;
        this.assignedType[i] = sp.type;
      } else {
        dir.copy(randomUnitVector3());
        r = params.spawnRadiusMin + Math.random() * radiusRange;
        this._spawnRadiusT[i] = (r - params.spawnRadiusMin) / Math.max(1e-6, radiusRange);
      }
      this._spawnPos[i * 3] = cx + dir.x * r;
      this._spawnPos[i * 3 + 1] = cy + dir.y * r;
      this._spawnPos[i * 3 + 2] = cz + dir.z * r;
    }
    this.reset();
  }

  get count(): number {
    return this._params.count;
  }

  get capturedField(): CapturedField {
    return { t: this.capturedT, dx: this.capturedDX, dy: this.capturedDY, dz: this.capturedDZ };
  }

  get totalCaptured(): number {
    return this.captured.length;
  }

  // Per-type capture tally (index = spawnPoint's type value) — only
  // meaningful when spawnPoint is provided.
  getTypeCounts(): readonly number[] {
    return this._typeCounts;
  }

  // Resets every particle back to its spawn position/Free state and clears
  // the captured pool — called from a phase system's play() so each replay
  // loop starts from a clean field. assignedType is untouched here when
  // spawnPoint was used (it was set once, permanently, in the constructor,
  // coupled to that particle's fixed direction) — fields that don't use
  // spawnPoint never had a typed assignedType to begin with, so there's
  // nothing to re-derive.
  reset(): void {
    this.positions.set(this._spawnPos);
    this.states.fill(GatherState.Free);
    this.captured.length = 0;
    this._typeCounts.fill(0);
    this._velX.fill(0);
    this._velY.fill(0);
    this._velZ.fill(0);
    if (!this._params.spawnPoint) {
      this.assignedType.fill(0);
    }
  }

  // Single comet, single hand input — see comet/comet-handoff-system.ts for
  // how "which hand" is decided; this class doesn't care, it just gets
  // wherever the comet currently is.
  step(hand: GatherHandInput, delta: number): void {
    for (let i = 0; i < this._params.count; i++) {
      if (this.states[i] === GatherState.Captured) continue;
      this._stepParticle(i, hand, delta);
    }
  }

  private _stepParticle(i: number, hand: GatherHandInput, delta: number): void {
    const p = this._params;
    this._scratchPos.set(this.positions[i * 3], this.positions[i * 3 + 1], this.positions[i * 3 + 2]);

    if (!hand.seen || this._scratchPos.distanceToSquared(hand.position) > p.attractRadius * p.attractRadius) {
      this.states[i] = GatherState.Free;
      this._coast(i, delta);
      return;
    }

    if (this.states[i] !== GatherState.Attracting) {
      // Edge, not level-triggered — fires once per Free->Attracting
      // transition (e.g. a quiet "pickup" cue), not every frame a particle
      // continues to be pulled. A particle that drifts free and gets
      // re-attracted later fires this again, same as a fresh pickup.
      p.onAttractStart?.(i, this.positions[i * 3], this.positions[i * 3 + 1], this.positions[i * 3 + 2], hand.speed);
    }
    this.states[i] = GatherState.Attracting;
    // Slower comet movement = stronger pull — rewards gentle, deliberate
    // gestures over fast grabbing. (Type is no longer derived from this —
    // see assignedType/params.spawnPoint above.)
    const slowness = 1.0 - smoothstep(p.slowSpeed, p.fastSpeed, hand.speed);
    const pull = 1.0 - Math.exp(-p.attractRate * slowness * delta);
    const oldX = this._scratchPos.x;
    const oldY = this._scratchPos.y;
    const oldZ = this._scratchPos.z;
    this._scratchPos.lerp(hand.position, pull);
    this.positions[i * 3] = this._scratchPos.x;
    this.positions[i * 3 + 1] = this._scratchPos.y;
    this.positions[i * 3 + 2] = this._scratchPos.z;

    // Remember this frame's motion as a velocity — if the pull ends before
    // capture (hand pulls away, or moves out of range next frame), _coast()
    // picks this up and eases it out instead of the particle freezing dead
    // the instant it stops being lerped toward the hand.
    if (delta > 1e-5) {
      const invDelta = 1 / delta;
      this._velX[i] = (this._scratchPos.x - oldX) * invDelta;
      this._velY[i] = (this._scratchPos.y - oldY) * invDelta;
      this._velZ[i] = (this._scratchPos.z - oldZ) * invDelta;
    }

    if (this._scratchPos.distanceToSquared(hand.position) <= p.captureDistance * p.captureDistance) {
      this._capture(i);
      p.onCapture?.(i, this.positions[i * 3], this.positions[i * 3 + 1], this.positions[i * 3 + 2], hand.speed);
    }
  }

  // Carries a Free particle's last Attracting-frame velocity forward,
  // decaying it exponentially, instead of the position simply staying put
  // (Free particles have no motion of their own otherwise) — a slow
  // deceleration rather than an instant stop when attraction ends short of
  // capture.
  private _coast(i: number, delta: number): void {
    const vx = this._velX[i];
    const vy = this._velY[i];
    const vz = this._velZ[i];
    if (vx * vx + vy * vy + vz * vz < COAST_STOP_SPEED_SQ) {
      this._velX[i] = 0;
      this._velY[i] = 0;
      this._velZ[i] = 0;
      return;
    }

    this.positions[i * 3] += vx * delta;
    this.positions[i * 3 + 1] += vy * delta;
    this.positions[i * 3 + 2] += vz * delta;

    const decay = Math.exp(-COAST_DECAY_RATE * delta);
    this._velX[i] = vx * decay;
    this._velY[i] = vy * decay;
    this._velZ[i] = vz * decay;
  }

  private _capture(i: number): void {
    const p = this._params;
    this.states[i] = GatherState.Captured;
    const sample = sampleRadialPoint(p.capturedAgeDecay, p.capturedSpreadBase, p.capturedSpreadGrowth, p.capturedDepthRatio);
    this.capturedT[i] = sample.t;
    this.capturedDX[i] = sample.dx;
    this.capturedDY[i] = sample.dy;
    this.capturedDZ[i] = sample.dz;
    if (this._params.spawnPoint) {
      this._typeCounts[this.assignedType[i]] = (this._typeCounts[this.assignedType[i]] ?? 0) + 1;
    }
    this.captured.push(i);
  }

  // Detaches a captured particle from the trail-riding render pool — for a
  // later phase "spending" already-gathered particles on something else
  // (e.g. stardust migrating onto a planet in Chapter 3). states[i] stays
  // Captured and capturedT/DX/DY/DZ[i] stay valid/frozen; the caller is
  // expected to already know that data if it still needs it (e.g. to
  // compute the particle's last on-trail position as a flight start point)
  // before calling this. particleIndex is a field slot index, not a
  // position within captured, hence indexOf + splice rather than a direct
  // splice(particleIndex, 1).
  releaseCaptured(particleIndex: number): void {
    const pos = this.captured.indexOf(particleIndex);
    if (pos !== -1) this.captured.splice(pos, 1);
  }
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
