import {
  AudioListener,
  BufferAttribute,
  BufferGeometry,
  createSystem,
  DynamicDrawUsage,
  Entity,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Points,
  Quaternion,
  Vector3,
} from '@iwsdk/core';
import { CometTrail } from '../../comet/comet-trail-component.js';
import { CometTrailSystem } from '../../comet/comet-trail-system.js';
import { GatherState } from '../../comet/gatherable-field.js';
import { HandAnchor } from '../../comet/hand-anchor-component.js';
import { ORGANIC_PALETTE } from '../../vfx/color/color-scheme.js';
import { loadObjLargestIslands } from '../../vfx/geometry/obj-field-loader.js';
import { buildOrganicGeometry } from '../../vfx/geometry/organic-rock-geometry.js';
import { PEBBLE_MESH_SCALE } from '../../vfx/particles/pebble-size.js';
import { sampleTrailOffset } from '../../vfx/particles/trail-sampler.js';
import { PebbleSynth } from '../../vfx/audio/pebble-synth.js';
import { playPayoffChime } from '../../vfx/audio/payoff-chime.js';
import {
  kGasCloudMat,
  kOrganicGlitterMat,
  kSoulIslandMat,
  PEBBLE_ISLAND_OBJ_GROUPS,
  PEBBLE_ISLAND_OBJ_MAX_COUNT,
  PEBBLE_ISLAND_OBJ_URL,
  SOUL_SIZE_MULTIPLIER,
} from '../../vfx/shaders/pebble-material.js';
import { PEBBLE_TYPES } from './pebble-type.js';
import { PebbleWeavingSystem } from './pebble-weaving-system.js';

// PEBBLE_TYPES' own index order — soul dust (0), organic matter (1),
// volatile gasses (2) — doubles as this system's art-style dispatch key
// (see _setInstance): soul renders as translucent wiggly OBJ islands,
// organic as a glitter blue/green spectrum body on the same rock shape
// every pebble used to share, gas as little additive cloud puffs. A
// pebble's assignedType is fixed for its whole life (GatherableField never
// reassigns it — only `states[i]` changes as it's gathered/captured), so
// every bucket below is partitioned once at init() and never rebuilt.
const TYPE_SOUL = 0;
const TYPE_ORGANIC = 1;
const TYPE_GAS = 2;

// "Three paths call to you" intro beat — one positional chime per type, the
// instant that type's own TYPE_REVEAL_AT_SECONDS growth begins (see
// PebbleWeavingSystem.getTypeRevealProgress/getCallOrigin), placed at
// whichever of that type's spawn groups sits closest to forward. Same one-
// shot rig the swirl-arrival/Fate Events payoff cues reuse (see
// payoff-chime.ts); rising per type (soul, then organic, then gas, matching
// both TYPE_REVEAL_AT_SECONDS' order and the notification's own line order)
// so the third call reads as building on the first two, not a repeat.
const CALL_CHIME_BASE_FREQ = 300;
const CALL_CHIME_FREQ_STEP = 90;

const N_ORGANIC_VARIANTS = 6;
// Only organic-type pebbles use these now (previously shared by all three
// types) — see kOrganicGlitterMat.
const kOrganicGeos: BufferGeometry[] = Array.from({ length: N_ORGANIC_VARIANTS }, () => buildOrganicGeometry());

// Most organic pebbles stay at their normal sampled size, but a minority
// come out 2x or 3x — a few visibly bigger boulders scattered through the
// field read as size variety rather than every organic pebble being a
// uniform pile of similarly-sized rocks. Weights are relative, not
// fractions — pickOrganicSizeMultiplier below normalizes against their sum.
const ORGANIC_SIZE_TIERS: readonly [multiplier: number, weight: number][] = [
  [1, 100],
  [2, 20],
  [3, 6],
];
const ORGANIC_SIZE_TIER_WEIGHT_TOTAL = ORGANIC_SIZE_TIERS.reduce((sum, [, weight]) => sum + weight, 0);
function pickOrganicSizeMultiplier(): number {
  let roll = Math.random() * ORGANIC_SIZE_TIER_WEIGHT_TOTAL;
  for (const [multiplier, weight] of ORGANIC_SIZE_TIERS) {
    roll -= weight;
    if (roll <= 0) return multiplier;
  }
  return ORGANIC_SIZE_TIERS[0][0];
}

// A freshly constructed InstancedMesh's instanceMatrix buffer starts
// zero-filled (not identity) — already a safe, invisible-scale degenerate
// matrix, not giant native-geometry scale. This just makes that safety
// explicit instead of relying on the implicit three.js default, matching
// this file's own mesh.visible seeding fix for the same "mesh exists before
// its first real per-instance transform is known" hazard.
const ZERO_SCALE_MAT4 = new Matrix4().makeScale(0, 0, 0);
function zeroInstanceMatrices(mesh: InstancedMesh, count: number): void {
  for (let i = 0; i < count; i++) mesh.setMatrixAt(i, ZERO_SCALE_MAT4);
  mesh.instanceMatrix.needsUpdate = true;
}

const CLOUD_POINTS_PER_PEBBLE = 5;
// How far a gas pebble's cloud points spread from its own tracked position,
// relative to that pebble's own physical size — and how much bigger each
// individual point sprite renders than the equivalent solid pebble would,
// for a soft puffy read instead of a tight dot. Both guesses, easy to
// retune once seen in-headset.
const GAS_CLOUD_SPREAD_SCALE = 1.3;
// 10x the original 1.6 — for a soft additive bloom look instead of tight
// little dots.
const GAS_POINT_SIZE_FACTOR = 16;

// Renders PebbleWeavingSystem's ambient pebble field: ungathered pebbles at
// their live world position, captured ones riding the capturing hand's
// trail (same camera-relative trail-sampling technique the pebble body and
// stardust use). Every pebble occupies a fixed "field slot" index for its
// whole life; each frame every slot's position is recomputed from whichever
// source is current (live position or trail offset) and written into
// whichever of the three type-specific render structures below that slot
// was bucketed into at init.
export class PebbleFieldVfxSystem extends createSystem({
  comets: { required: [CometTrail, HandAnchor] },
}) {
  private _pebbles!: PebbleWeavingSystem;
  private _trailSystem!: CometTrailSystem;
  private _sizes!: Float32Array;
  private _assignedType!: Uint8Array;

  private _rot!: Quaternion[];
  private _states!: Uint8Array;
  // 0-1 grow-in progress per pebble type, recomputed once a frame (not
  // per-pebble) — see PebbleWeavingSystem.getTypeRevealProgress().
  private _typeReveal!: Float32Array;

  // Organic (type 1) — same 6-variant rock geometry every pebble used to
  // share, now exclusively organic, with kOrganicGlitterMat instead of the
  // old single tinted material.
  private _organicVariant!: Uint8Array;
  private _organicLocalIdx!: Uint16Array;
  private _organicTint!: Float32Array; // n*3, meaningful only where type===organic
  private _organicSizeMultiplier!: Float32Array; // 1/2/3, meaningful only where type===organic
  private _organicMeshes!: InstancedMesh[];
  private _organicMeshEntities!: Entity[];

  // Soul (type 0) — primitive-rock placeholder until loadObjLargestIslands
  // resolves, then per-island-bucketed wiggly InstancedMeshes.
  private _soulBucket!: Uint8Array; // which mesh in _soulMeshes, meaningful only where type===soul
  private _soulLocalIdx!: Uint16Array;
  private _soulExtraScale!: Float32Array; // 1 for the placeholder; 1/islandRadius once real islands load
  private _soulWigglePhase!: Float32Array;
  private _soulMeshes!: InstancedMesh[];
  private _soulMeshEntities!: Entity[];

  // Gas (type 2) — one shared Points cloud, CLOUD_POINTS_PER_PEBBLE points
  // per gas pebble.
  private _gasFlatOffset!: Int32Array; // n-sized, meaningful only where type===gas
  private _gasJitter!: Float32Array; // (gasCount*CLOUD_POINTS_PER_PEBBLE)*3, camera-relative (dx,dy,dz) per point
  private _gasBaseBright!: Float32Array;
  private _gasPoints!: Points;
  private _gasPositionAttr!: BufferAttribute;
  private _gasBrightAttr!: BufferAttribute;

  private _camRight!: Vector3;
  private _camUp!: Vector3;
  private _camFwd!: Vector3;
  private _scratchPos!: Vector3;
  private _scratchScale!: Vector3;
  private _scratchMat4!: Matrix4;
  private _scratchGasPos!: Vector3;

  // Own AudioListener for the same reason StardustVfxSystem needs one — see
  // its identical comment: IWSDK's AudioSource/AudioUtils layer only plays
  // pre-loaded buffers, with no way to reach its AudioListener for
  // generative/synthesized audio.
  private _audioListener!: AudioListener;
  private _pebbleSynth!: PebbleSynth;
  private _scratchCapturePos!: Vector3;
  // Per-type, whether that type's call chime has already fired this loop —
  // see CALL_CHIME_BASE_FREQ's own comment. Reset on play().
  private _typeCalled!: boolean[];
  private _scratchCallPos!: Vector3;

  init(): void {
    // PebbleWeavingSystem/CometTrailSystem must be registered before this
    // system (see index.ts) so they already exist when this init() runs.
    this._pebbles = this.world.getSystem(PebbleWeavingSystem)!;
    this._trailSystem = this.world.getSystem(CometTrailSystem)!;
    this._sizes = this._pebbles.getSizes();
    this._assignedType = this._pebbles.getAssignedType();
    this._typeReveal = new Float32Array(PEBBLE_TYPES.length);

    this._audioListener = new AudioListener();
    this.player.head.add(this._audioListener);
    this._pebbleSynth = new PebbleSynth();
    this._pebbleSynth.build(this._audioListener, this.scene);
    this._scratchCapturePos = new Vector3();
    this._typeCalled = new Array(PEBBLE_TYPES.length).fill(false);
    this._scratchCallPos = new Vector3();

    this._camRight = new Vector3();
    this._camUp = new Vector3();
    this._camFwd = new Vector3();
    this._scratchPos = new Vector3();
    this._scratchScale = new Vector3();
    this._scratchMat4 = new Matrix4();
    this._scratchGasPos = new Vector3();

    const n = this._pebbles.getParticleCount();
    this._rot = new Array(n);
    const rotAxis = new Vector3();
    for (let i = 0; i < n; i++) {
      rotAxis.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
      this._rot[i] = new Quaternion().setFromAxisAngle(rotAxis, Math.random() * Math.PI * 2);
    }

    this._buildOrganic(n);
    this._buildSoul(n);
    this._buildGas(n);
  }

  private _buildOrganic(n: number): void {
    this._organicVariant = new Uint8Array(n);
    this._organicLocalIdx = new Uint16Array(n);
    this._organicTint = new Float32Array(n * 3);
    this._organicSizeMultiplier = new Float32Array(n).fill(1);

    const bucketCounts = new Array<number>(N_ORGANIC_VARIANTS).fill(0);
    let ordinal = 0;
    for (let i = 0; i < n; i++) {
      if (this._assignedType[i] !== TYPE_ORGANIC) continue;
      const variant = ordinal % N_ORGANIC_VARIANTS;
      this._organicVariant[i] = variant;
      this._organicLocalIdx[i] = bucketCounts[variant]++;
      this._organicSizeMultiplier[i] = pickOrganicSizeMultiplier();
      const [r, g, b] = ORGANIC_PALETTE[Math.floor(Math.random() * ORGANIC_PALETTE.length)];
      this._organicTint[i * 3] = r;
      this._organicTint[i * 3 + 1] = g;
      this._organicTint[i * 3 + 2] = b;
      ordinal++;
    }

    this._organicMeshes = [];
    this._organicMeshEntities = [];
    for (let v = 0; v < N_ORGANIC_VARIANTS; v++) {
      const geo = kOrganicGeos[v];
      geo.setAttribute('aBright', new InstancedBufferAttribute(new Float32Array(bucketCounts[v]).fill(0.7), 1));
      const tintAttr = new InstancedBufferAttribute(new Float32Array(bucketCounts[v] * 3), 3);
      geo.setAttribute('aTint', tintAttr);
      geo.setAttribute('aTinted', new InstancedBufferAttribute(new Float32Array(bucketCounts[v]).fill(1), 1));
      const mesh = new InstancedMesh(geo, kOrganicGlitterMat, bucketCounts[v]);
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.frustumCulled = false;
      zeroInstanceMatrices(mesh, bucketCounts[v]);
      this._organicMeshEntities.push(this.world.createTransformEntity(mesh));
      this._organicMeshes.push(mesh);
    }
    // Tint is fixed for life — write it once here rather than every frame.
    for (let i = 0; i < n; i++) {
      if (this._assignedType[i] !== TYPE_ORGANIC) continue;
      const tintAttr = this._organicMeshes[this._organicVariant[i]].geometry.getAttribute(
        'aTint',
      ) as InstancedBufferAttribute;
      tintAttr.setXYZ(this._organicLocalIdx[i], this._organicTint[i * 3], this._organicTint[i * 3 + 1], this._organicTint[i * 3 + 2]);
      tintAttr.needsUpdate = true;
    }
  }

  private _buildSoul(n: number): void {
    this._soulBucket = new Uint8Array(n);
    this._soulLocalIdx = new Uint16Array(n);
    this._soulExtraScale = new Float32Array(n).fill(1);
    this._soulWigglePhase = new Float32Array(n);

    let soulCount = 0;
    for (let i = 0; i < n; i++) {
      if (this._assignedType[i] !== TYPE_SOUL) continue;
      this._soulLocalIdx[i] = soulCount++;
      this._soulBucket[i] = 0;
      this._soulWigglePhase[i] = Math.random();
    }

    const placeholderGeo = buildOrganicGeometry();
    placeholderGeo.setAttribute('aBright', new InstancedBufferAttribute(new Float32Array(soulCount).fill(0.7), 1));
    placeholderGeo.setAttribute('aTint', new InstancedBufferAttribute(new Float32Array(soulCount * 3), 3));
    placeholderGeo.setAttribute('aTinted', new InstancedBufferAttribute(new Float32Array(soulCount), 1));
    const phaseAttr = new InstancedBufferAttribute(new Float32Array(soulCount), 1);
    placeholderGeo.setAttribute('aWigglePhase', phaseAttr);
    for (let i = 0; i < n; i++) {
      if (this._assignedType[i] !== TYPE_SOUL) continue;
      phaseAttr.setX(this._soulLocalIdx[i], this._soulWigglePhase[i]);
    }
    const placeholder = new InstancedMesh(placeholderGeo, kSoulIslandMat, soulCount);
    placeholder.instanceMatrix.setUsage(DynamicDrawUsage);
    placeholder.frustumCulled = false;
    zeroInstanceMatrices(placeholder, soulCount);
    this._soulMeshEntities = [this.world.createTransformEntity(placeholder)];
    this._soulMeshes = [placeholder];

    loadObjLargestIslands(PEBBLE_ISLAND_OBJ_URL, PEBBLE_ISLAND_OBJ_GROUPS, PEBBLE_ISLAND_OBJ_MAX_COUNT).then(
      (islands) => {
        if (islands.length === 0) {
          console.warn(
            `[PebbleFieldVfxSystem] no mesh islands found under ${PEBBLE_ISLAND_OBJ_GROUPS.join('/')} in '${PEBBLE_ISLAND_OBJ_URL}' — keeping the primitive placeholder soul pebbles.`,
          );
          return;
        }
        for (const e of this._soulMeshEntities) {
          // The placeholder's own geometry (a one-off buildOrganicGeometry()
          // call) isn't shared with anything else, unlike kSoulIslandMat —
          // dispose it explicitly since e.destroy() alone would leak it
          // (e.dispose() isn't safe here, it would also free the SHARED
          // material).
          (e.object3D as InstancedMesh).geometry.dispose();
          e.destroy();
        }

        const assignedIsland = new Uint8Array(n);
        const bucketCounts = new Array<number>(islands.length).fill(0);
        for (let i = 0; i < n; i++) {
          if (this._assignedType[i] !== TYPE_SOUL) continue;
          const islandIdx = Math.floor(Math.random() * islands.length);
          assignedIsland[i] = islandIdx;
          this._soulBucket[i] = islandIdx;
          this._soulLocalIdx[i] = bucketCounts[islandIdx]++;
          const islandRadius =
            islands[islandIdx].boundingSphere && islands[islandIdx].boundingSphere!.radius > 1e-6
              ? islands[islandIdx].boundingSphere!.radius
              : 1;
          this._soulExtraScale[i] = 1 / islandRadius;
        }

        this._soulMeshes = [];
        this._soulMeshEntities = [];
        for (let islandIdx = 0; islandIdx < islands.length; islandIdx++) {
          const count = bucketCounts[islandIdx];
          if (count === 0) continue;
          // .clone() — loadObjLargestIslands caches and returns these SAME
          // geometry objects to every caller requesting this (url, groups,
          // count) key (art-test's own "8 islands" variants, Fate Events'
          // placeholder crowd, and this system all ask for the same 8
          // islands); setAttribute() below mutates the geometry directly, so
          // without cloning, each caller's per-instance buffers would stomp
          // on every other caller's already-built mesh sharing that object.
          const geo = islands[islandIdx].clone();
          geo.setAttribute('aBright', new InstancedBufferAttribute(new Float32Array(count).fill(0.7), 1));
          geo.setAttribute('aTint', new InstancedBufferAttribute(new Float32Array(count * 3), 3));
          geo.setAttribute('aTinted', new InstancedBufferAttribute(new Float32Array(count), 1));
          const islandPhaseAttr = new InstancedBufferAttribute(new Float32Array(count), 1);
          geo.setAttribute('aWigglePhase', islandPhaseAttr);
          for (let i = 0; i < n; i++) {
            if (this._assignedType[i] !== TYPE_SOUL || assignedIsland[i] !== islandIdx) continue;
            islandPhaseAttr.setX(this._soulLocalIdx[i], this._soulWigglePhase[i]);
          }
          const mesh = new InstancedMesh(geo, kSoulIslandMat, count);
          mesh.instanceMatrix.setUsage(DynamicDrawUsage);
          mesh.frustumCulled = false;
          zeroInstanceMatrices(mesh, count);
          // This async callback can resolve while the system is stopped (the
          // OBJ takes real time to load — the common case is it resolves
          // long before the player ever reaches Pebbles phase). A fresh Mesh
          // defaults to visible=true, and update() — which is what writes
          // each instance's real small-scale transform via setMatrixAt — only
          // runs while playing, so without this the mesh would sit fully
          // visible at its raw native OBJ scale and identity (origin)
          // transform until the next play()/stop() cycle: giant geometry in
          // the background of every phase before the player's first Pebbles
          // visit. play()/stop() already keep everything in _soulMeshes in
          // sync going forward — this just seeds the correct initial state.
          mesh.visible = !this.isPaused;
          this._soulMeshEntities.push(this.world.createTransformEntity(mesh));
          this._soulMeshes.push(mesh);
        }
      },
    );
  }

  private _buildGas(n: number): void {
    this._gasFlatOffset = new Int32Array(n).fill(-1);
    let gasCount = 0;
    for (let i = 0; i < n; i++) {
      if (this._assignedType[i] !== TYPE_GAS) continue;
      this._gasFlatOffset[i] = gasCount * CLOUD_POINTS_PER_PEBBLE;
      gasCount++;
    }

    const totalPoints = gasCount * CLOUD_POINTS_PER_PEBBLE;
    this._gasJitter = new Float32Array(totalPoints * 3);
    this._gasBaseBright = new Float32Array(totalPoints);
    const sizes = new Float32Array(totalPoints);
    const jitterDir = new Vector3();
    for (let i = 0; i < n; i++) {
      const base = this._gasFlatOffset[i];
      if (base < 0) continue;
      const spread = this._sizes[i] * GAS_CLOUD_SPREAD_SCALE;
      for (let k = 0; k < CLOUD_POINTS_PER_PEBBLE; k++) {
        const flat = base + k;
        jitterDir.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
        const mag = spread * Math.random();
        this._gasJitter[flat * 3] = jitterDir.x * mag;
        this._gasJitter[flat * 3 + 1] = jitterDir.y * mag;
        this._gasJitter[flat * 3 + 2] = jitterDir.z * mag;
        this._gasBaseBright[flat] = 0.4 + Math.random() * 0.6;
        sizes[flat] = this._sizes[i] * PEBBLE_MESH_SCALE * GAS_POINT_SIZE_FACTOR * (0.6 + Math.random() * 0.6);
      }
    }

    const geo = new BufferGeometry();
    const posAttr = new BufferAttribute(new Float32Array(totalPoints * 3), 3);
    posAttr.setUsage(DynamicDrawUsage);
    const brightAttr = new BufferAttribute(new Float32Array(totalPoints), 1);
    brightAttr.setUsage(DynamicDrawUsage);
    geo.setAttribute('position', posAttr);
    geo.setAttribute('aBright', brightAttr);
    geo.setAttribute('aSize', new BufferAttribute(sizes, 1));
    this._gasPositionAttr = posAttr;
    this._gasBrightAttr = brightAttr;
    this._gasPoints = new Points(geo, kGasCloudMat);
    this._gasPoints.frustumCulled = false;
    this.world.createTransformEntity(this._gasPoints);
  }

  play(): void {
    super.play();
    for (const mesh of this._organicMeshes) mesh.visible = true;
    for (const mesh of this._soulMeshes) mesh.visible = true;
    this._gasPoints.visible = true;
    this._typeCalled.fill(false);
  }

  stop(): void {
    super.stop();
    for (const mesh of this._organicMeshes) mesh.visible = false;
    for (const mesh of this._soulMeshes) mesh.visible = false;
    this._gasPoints.visible = false;
  }

  update(_delta: number, time: number): void {
    kSoulIslandMat.uniforms.uTime.value = time;
    kOrganicGlitterMat.uniforms.uTime.value = time;

    this._camRight.setFromMatrixColumn(this.camera.matrixWorld, 0);
    this._camUp.setFromMatrixColumn(this.camera.matrixWorld, 1);
    this._camFwd.setFromMatrixColumn(this.camera.matrixWorld, 2);

    const positions = this._pebbles.getPositions();
    this._states = this._pebbles.getStates();
    for (let t = 0; t < this._typeReveal.length; t++) {
      this._typeReveal[t] = this._pebbles.getTypeRevealProgress(t);
      if (!this._typeCalled[t] && this._typeReveal[t] > 0) {
        this._typeCalled[t] = true;
        this._pebbles.getCallOrigin(t, this._scratchCallPos);
        playPayoffChime(
          this._audioListener,
          this.scene,
          this._scratchCallPos,
          CALL_CHIME_BASE_FREQ + t * CALL_CHIME_FREQ_STEP,
        );
      }
    }
    const states = this._states;
    const n = this._pebbles.getParticleCount();
    for (let i = 0; i < n; i++) {
      if (states[i] === GatherState.Captured) continue;
      this._scratchPos.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      this._setInstance(i, this._scratchPos);
    }

    for (const entity of this.queries.comets.entities) {
      const trail = this._trailSystem.getBuffer(entity);
      if (!trail) continue;
      const samples = entity.getValue(CometTrail, 'samples') as number;
      const stride = entity.getValue(CometTrail, 'stride') as number;
      const indices = this._pebbles.getCapturedIndices();
      const field = this._pebbles.getCapturedField();

      for (const i of indices) {
        sampleTrailOffset(
          trail,
          samples,
          stride,
          field.t[i],
          field.dx[i],
          field.dy[i],
          field.dz[i],
          this._camRight,
          this._camUp,
          this._camFwd,
          this._scratchPos,
        );
        this._setInstance(i, this._scratchPos);
      }
    }

    for (const mesh of this._organicMeshes) mesh.instanceMatrix.needsUpdate = true;
    for (const mesh of this._soulMeshes) mesh.instanceMatrix.needsUpdate = true;
    this._gasPositionAttr.needsUpdate = true;
    this._gasBrightAttr.needsUpdate = true;

    for (const ev of this._pebbles.drainAttractEvents()) {
      this._scratchCapturePos.set(ev.x, ev.y, ev.z);
      this._pebbleSynth.playPickup(ev.type, this._scratchCapturePos, ev.speed);
    }
    for (const ev of this._pebbles.drainCaptureEvents()) {
      this._scratchCapturePos.set(ev.x, ev.y, ev.z);
      this._pebbleSynth.playCatch(ev.type, this._scratchCapturePos, ev.speed);
    }
  }

  private _setInstance(i: number, pos: Vector3): void {
    const type = this._assignedType[i];
    const reveal = this._typeReveal[type];
    if (type === TYPE_ORGANIC) {
      this._scratchScale.setScalar(this._sizes[i] * PEBBLE_MESH_SCALE * reveal * this._organicSizeMultiplier[i]);
      this._scratchMat4.compose(pos, this._rot[i], this._scratchScale);
      this._organicMeshes[this._organicVariant[i]].setMatrixAt(this._organicLocalIdx[i], this._scratchMat4);
    } else if (type === TYPE_SOUL) {
      this._scratchScale.setScalar(
        this._sizes[i] * PEBBLE_MESH_SCALE * reveal * this._soulExtraScale[i] * SOUL_SIZE_MULTIPLIER,
      );
      this._scratchMat4.compose(pos, this._rot[i], this._scratchScale);
      this._soulMeshes[this._soulBucket[i]].setMatrixAt(this._soulLocalIdx[i], this._scratchMat4);
    } else {
      const base = this._gasFlatOffset[i];
      const posArr = this._gasPositionAttr.array as Float32Array;
      const brightArr = this._gasBrightAttr.array as Float32Array;
      for (let k = 0; k < CLOUD_POINTS_PER_PEBBLE; k++) {
        const flat = base + k;
        this._scratchGasPos
          .copy(pos)
          .addScaledVector(this._camRight, this._gasJitter[flat * 3])
          .addScaledVector(this._camUp, this._gasJitter[flat * 3 + 1])
          .addScaledVector(this._camFwd, this._gasJitter[flat * 3 + 2]);
        posArr[flat * 3] = this._scratchGasPos.x;
        posArr[flat * 3 + 1] = this._scratchGasPos.y;
        posArr[flat * 3 + 2] = this._scratchGasPos.z;
        brightArr[flat] = this._gasBaseBright[flat] * reveal;
      }
    }
  }
}
