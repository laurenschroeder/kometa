import {
  BufferGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  Quaternion,
  Vector3,
  World,
} from '@iwsdk/core';
import { GatherState } from '../../comet/gatherable-field.js';
import { ORGANIC_PALETTE } from '../../vfx/color/color-scheme.js';
import { buildOrganicGeometry } from '../../vfx/geometry/organic-rock-geometry.js';
import { PEBBLE_MESH_SCALE, pebbleSizeFromSample } from '../../vfx/particles/pebble-size.js';
import { kOrganicGlitterMat } from '../../vfx/shaders/pebble-material.js';
import {
  loadDesertPlantGeos,
  loadFlowerPlantGeos,
  PLANT_DITHER_MAT,
  setPlantInstanceAttrs,
} from '../planet-seeding/planet-growth-pool.js';

// Organic's Beat 5 payoff, tail half — every seed riding the comet's tail
// blossoms into a small plant, one after another from the head of the tail
// back (sorted by capturedT), each with a burst of organic "magic dust"
// pebbles. The planet-side half (the organic decorations' own blossom pulse)
// stays in earth-situations-vfx-system.ts. Fits comfortably inside
// fate-event-system.ts's PAYOFF_HOLD_SECONDS (7s) so the last bloom lands
// before the player can launch away.
const BLOOM_STAGGER_SPAN = 3.0; // seconds from the first seed's bloom to the last's

const BURST_PER_SEED = 14;
const BURST_DURATION = 1.2; // seconds, one burst's full pop-out-and-fade
const BURST_RADIUS = 0.1; // meters, how far a dust pebble flies from its seed
const BURST_RISE = 0.03; // meters, gentle extra upward drift over the burst's life
const BURST_POP_IN = 0.12; // fraction of BURST_DURATION spent scaling up from 0
// Same size distribution the tail's own organic pebbles use (see
// pebble-size.ts), bumped so the burst reads as a burst rather than a few
// barely-visible specks.
const BURST_SIZE_MULTIPLIER = 1.8;
const BURST_TUMBLE = 6; // radians of spin over a dust pebble's life
const BURST_BRIGHT = 1.0; // vs. the tail pebbles' 0.7 — a little extra sparkle

// Plant packs are unit-radius from their base origin (see
// planet-growth-pool.ts), so this is roughly the plant's height in meters —
// about double SEED_SIZE, a "small version" rather than a full-sized plant.
const PLANT_SIZE = 0.07;
const PLANT_GROW_DURATION = 0.7;
const PLANT_SPIN_SPEED = 0.5; // rad/s around world up, so it doesn't sit dead still in the tail

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

// Overshoots past 1 before settling — reads as a springy "pop" into being.
function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const u = t - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
}

// Not a System — a plain pooled-effect class driven by explicit
// build()/trigger()/update()/reset() calls from FateEventVfxSystem, same
// idiom as PlanetGrowthPool/CrownRise. Slot i is seed i of FateEventSystem's
// seed GatherableField, so no free-list is needed. The seed meshes
// themselves stay owned by FateEventVfxSystem — update() reads each one's
// already-positioned trail location as its anchor and hides it once bloomed.
export class SeedBlossom {
  private _count = 0;
  private _onBloom!: (rank: number, total: number, position: Vector3) => void;

  private _plantMeshes: InstancedMesh[] = [];
  private _plantSpinPhase!: Float32Array;

  private _burstMesh!: InstancedMesh;
  private _burstDir!: Float32Array; // count*BURST_PER_SEED*3, unit direction
  private _burstAxis!: Float32Array; // count*BURST_PER_SEED*3, unit tumble axis
  private _burstSize!: Float32Array;

  // Seconds after trigger() each seed blooms — Infinity for a seed that
  // wasn't captured when the payoff started (never blooms).
  private _bloomDelay!: Float32Array;
  private _rank!: Uint8Array;
  private _bloomed!: Uint8Array;
  private _bloomTotal = 0;
  private _lastBloomDelay = 0;
  // -1 = not triggered this loop.
  private _elapsed = -1;

  private _zeroMat = new Matrix4().makeScale(0, 0, 0);
  private _scratchMat4 = new Matrix4();
  private _scratchPos = new Vector3();
  private _scratchAxis = new Vector3();
  private _scratchQuat = new Quaternion();
  private _scratchScale = new Vector3();

  build(world: World, count: number, onBloom: (rank: number, total: number, position: Vector3) => void): void {
    this._count = count;
    this._onBloom = onBloom;
    this._bloomDelay = new Float32Array(count).fill(Infinity);
    this._rank = new Uint8Array(count);
    this._bloomed = new Uint8Array(count);
    this._plantSpinPhase = new Float32Array(count);

    // PLANT_DITHER_MAT is instanced-only (see planet-growth-pool.ts), so each
    // plant is a single-instance InstancedMesh with an identity instance
    // matrix — the mesh's own transform carries position/scale/spin.
    const identity = new Matrix4();
    for (let i = 0; i < count; i++) {
      const geo = buildOrganicGeometry();
      setPlantInstanceAttrs(geo);
      const mesh = new InstancedMesh(geo, PLANT_DITHER_MAT, 1);
      mesh.setMatrixAt(0, identity);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.frustumCulled = false;
      mesh.visible = false;
      this._plantSpinPhase[i] = Math.random() * Math.PI * 2;
      this._plantMeshes.push(mesh);
      world.createTransformEntity(mesh);
    }

    // Swap placeholders for real plants from both packs as each resolves —
    // same graceful-degradation idiom as PlanetGrowthPool. Even slots draw
    // from the desert pack, odd from the flowers, so the tail shows a mix.
    const swapIn = (geos: readonly BufferGeometry[], parity: number): void => {
      if (geos.length === 0) return;
      for (let i = parity; i < count; i += 2) {
        const geo = geos[Math.floor(Math.random() * geos.length)].clone();
        setPlantInstanceAttrs(geo);
        this._plantMeshes[i].geometry.dispose();
        this._plantMeshes[i].geometry = geo;
      }
    };
    loadDesertPlantGeos().then((geos) => swapIn(geos, 0));
    loadFlowerPlantGeos().then((geos) => swapIn(geos, 1));

    const burstCount = count * BURST_PER_SEED;
    const burstGeo = buildOrganicGeometry();
    burstGeo.setAttribute('aBright', new InstancedBufferAttribute(new Float32Array(burstCount).fill(BURST_BRIGHT), 1));
    const tint = new Float32Array(burstCount * 3);
    for (let b = 0; b < burstCount; b++) {
      const [r, g, bl] = ORGANIC_PALETTE[Math.floor(Math.random() * ORGANIC_PALETTE.length)];
      tint[b * 3] = r;
      tint[b * 3 + 1] = g;
      tint[b * 3 + 2] = bl;
    }
    burstGeo.setAttribute('aTint', new InstancedBufferAttribute(tint, 3));
    burstGeo.setAttribute('aTinted', new InstancedBufferAttribute(new Float32Array(burstCount).fill(1), 1));
    // kOrganicGlitterMat's uTime is already kept fresh by the always-on
    // PebbleCometPresentationSystem.
    this._burstMesh = new InstancedMesh(burstGeo, kOrganicGlitterMat, burstCount);
    this._burstMesh.name = 'seed-blossom-burst';
    this._burstMesh.frustumCulled = false;
    this._burstMesh.visible = false;
    for (let b = 0; b < burstCount; b++) this._burstMesh.setMatrixAt(b, this._zeroMat);
    world.createTransformEntity(this._burstMesh);

    this._burstDir = new Float32Array(burstCount * 3);
    this._burstAxis = new Float32Array(burstCount * 3);
    this._burstSize = new Float32Array(burstCount);
    const v = new Vector3();
    for (let b = 0; b < burstCount; b++) {
      v.randomDirection();
      v.toArray(this._burstDir, b * 3);
      v.randomDirection();
      v.toArray(this._burstAxis, b * 3);
      this._burstSize[b] =
        pebbleSizeFromSample(Math.random(), Math.random() * 2.5) * PEBBLE_MESH_SCALE * BURST_SIZE_MULTIPLIER;
    }
  }

  isTriggered(): boolean {
    return this._elapsed >= 0;
  }

  // Blooms only seeds actually Captured (riding the tail) — ordered head of
  // the tail first (smallest capturedT) so the blossom ripples back along it.
  trigger(capturedT: Float32Array, states: Uint8Array): void {
    const order: number[] = [];
    for (let i = 0; i < this._count; i++) if (states[i] === GatherState.Captured) order.push(i);
    order.sort((a, b) => capturedT[a] - capturedT[b]);

    this._bloomDelay.fill(Infinity);
    this._bloomed.fill(0);
    const n = order.length;
    for (let r = 0; r < n; r++) {
      const i = order[r];
      this._bloomDelay[i] = n > 1 ? (r / (n - 1)) * BLOOM_STAGGER_SPAN : 0;
      this._rank[i] = r;
    }
    this._bloomTotal = n;
    this._lastBloomDelay = n > 1 ? BLOOM_STAGGER_SPAN : 0;
    this._elapsed = 0;
    this._burstMesh.visible = n > 0;
  }

  // Must run AFTER the seed meshes (`anchors`) have been positioned on the
  // trail this frame — reads their position, and hides each one once bloomed.
  update(delta: number, anchors: readonly Mesh[], show: boolean): void {
    if (this._elapsed < 0) return;
    if (!show) {
      this._hideAll();
      return;
    }
    this._elapsed += delta;
    const burstLive = this._burstMesh.visible;

    for (let i = 0; i < this._count; i++) {
      const plant = this._plantMeshes[i];
      const local = this._elapsed - this._bloomDelay[i]; // -Infinity for never-blooming seeds
      if (!(local >= 0)) {
        plant.visible = false;
        continue;
      }
      const anchor = anchors[i];
      if (!this._bloomed[i]) {
        this._bloomed[i] = 1;
        this._onBloom(this._rank[i], this._bloomTotal, anchor.position);
      }
      anchor.visible = false;

      plant.visible = true;
      plant.position.copy(anchor.position);
      plant.rotation.set(0, this._plantSpinPhase[i] + local * PLANT_SPIN_SPEED, 0);
      plant.scale.setScalar(PLANT_SIZE * easeOutBack(clamp01(local / PLANT_GROW_DURATION)));

      if (!burstLive) continue;
      const bt = local / BURST_DURATION;
      for (let k = 0; k < BURST_PER_SEED; k++) {
        const b = i * BURST_PER_SEED + k;
        if (bt >= 1) {
          this._burstMesh.setMatrixAt(b, this._zeroMat);
          continue;
        }
        const spread = 1 - (1 - bt) * (1 - bt) * (1 - bt); // ease-out: fast pop, soft settle
        this._scratchPos
          .fromArray(this._burstDir, b * 3)
          .multiplyScalar(BURST_RADIUS * spread)
          .add(anchor.position);
        this._scratchPos.y += BURST_RISE * bt;
        this._scratchAxis.fromArray(this._burstAxis, b * 3);
        this._scratchQuat.setFromAxisAngle(this._scratchAxis, bt * BURST_TUMBLE);
        const popIn = clamp01(bt / BURST_POP_IN);
        const fadeOut = 1 - clamp01((bt - 0.4) / 0.6);
        this._scratchScale.setScalar(this._burstSize[b] * popIn * fadeOut);
        this._scratchMat4.compose(this._scratchPos, this._scratchQuat, this._scratchScale);
        this._burstMesh.setMatrixAt(b, this._scratchMat4);
      }
    }

    if (burstLive) {
      this._burstMesh.instanceMatrix.needsUpdate = true;
      if (this._elapsed > this._lastBloomDelay + BURST_DURATION) this._burstMesh.visible = false;
    }
  }

  // Cheap no-op when nothing's been triggered, so callers can invoke it
  // every frame outside the payoff (same as _payoffChimePlayed's reset).
  reset(): void {
    if (this._elapsed < 0) return;
    this._elapsed = -1;
    this._bloomed.fill(0);
    this._bloomDelay.fill(Infinity);
    for (let b = 0; b < this._count * BURST_PER_SEED; b++) this._burstMesh.setMatrixAt(b, this._zeroMat);
    this._burstMesh.instanceMatrix.needsUpdate = true;
    this._hideAll();
  }

  private _hideAll(): void {
    for (const plant of this._plantMeshes) plant.visible = false;
    this._burstMesh.visible = false;
  }
}
