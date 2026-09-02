import {
  AudioListener,
  BufferGeometry,
  createSystem,
  DynamicDrawUsage,
  Entity,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
} from '@iwsdk/core';
import { CometTrail } from '../../comet/comet-trail-component.js';
import { CometTrailSystem } from '../../comet/comet-trail-system.js';
import { GatherState } from '../../comet/gatherable-field.js';
import { HandAnchor } from '../../comet/hand-anchor-component.js';
import { PebbleSynth } from '../../vfx/audio/pebble-synth.js';
import { buildOrganicGeometry } from '../../vfx/geometry/organic-rock-geometry.js';
import { PEBBLE_MESH_SCALE } from '../../vfx/particles/pebble-size.js';
import { sampleTrailOffset } from '../../vfx/particles/trail-sampler.js';
import { kPebbleFieldTintedMat } from '../../vfx/shaders/pebble-material.js';
import { PEBBLE_TYPES } from './pebble-type.js';
import { PebbleWeavingSystem } from './pebble-weaving-system.js';

const N_PEBBLE_VARIANTS = 6;

// Own geometry variants rather than reusing
// PebbleCometPresentationSystem's kPebbleVariantGeos: each InstancedMesh's
// per-instance aBright/aTint/aTinted attributes are sized to that mesh's own
// instance count (210 pebbles here vs. 260 in the final body), so sharing a
// BufferGeometry across owners with different counts would mean one of them
// overwrites the other's instance attributes. The material
// (kPebbleFieldTintedMat) has no such per-owner state and is safe — and
// important — to share (PebbleCometPresentationSystem shares it too, giving
// the permanent body's own pebbles the same per-instance PEBBLE_TYPES
// coloring), so every pebble in the game renders with the exact same
// shader/palette.
const kFieldPebbleGeos: BufferGeometry[] = Array.from({ length: N_PEBBLE_VARIANTS }, () =>
  buildOrganicGeometry(),
);

// Renders PebbleWeavingSystem's ambient pebble field: ungathered pebbles at
// their live world position, captured ones riding the capturing hand's
// trail (same camera-relative trail-sampling technique the pebble body and
// stardust use). Unlike stardust's Points-based approach, a single set of
// InstancedMesh objects covers both states — every frame each instance's
// matrix is recomputed from whichever position source is current for that
// pebble, no separate ambient/captured mesh pools needed.
export class PebbleFieldVfxSystem extends createSystem({
  comets: { required: [CometTrail, HandAnchor] },
}) {
  private _pebbles!: PebbleWeavingSystem;
  private _trailSystem!: CometTrailSystem;
  private _sizes!: Float32Array;

  private _variant!: Uint8Array;
  private _localIdx!: Uint16Array;
  private _rot!: Quaternion[];
  private _meshes!: InstancedMesh[];
  private _meshEntities!: Entity[];
  private _tintAttrs!: InstancedBufferAttribute[];
  private _tintedAttrs!: InstancedBufferAttribute[];
  private _states!: Uint8Array;
  private _assignedType!: Uint8Array;

  private _camRight!: Vector3;
  private _camUp!: Vector3;
  private _camFwd!: Vector3;
  private _scratchPos!: Vector3;
  private _scratchScale!: Vector3;
  private _scratchMat4!: Matrix4;

  // Own AudioListener for the same reason StardustVfxSystem needs one — see
  // its identical comment: IWSDK's AudioSource/AudioUtils layer only plays
  // pre-loaded buffers, with no way to reach its AudioListener for
  // generative/synthesized audio.
  private _audioListener!: AudioListener;
  private _pebbleSynth!: PebbleSynth;
  private _scratchCapturePos!: Vector3;

  init(): void {
    // PebbleWeavingSystem/CometTrailSystem must be registered before this
    // system (see index.ts) so they already exist when this init() runs.
    this._pebbles = this.world.getSystem(PebbleWeavingSystem)!;
    this._trailSystem = this.world.getSystem(CometTrailSystem)!;
    this._sizes = this._pebbles.getSizes();

    this._audioListener = new AudioListener();
    this.player.head.add(this._audioListener);
    this._pebbleSynth = new PebbleSynth();
    this._pebbleSynth.build(this._audioListener, this.scene);
    this._scratchCapturePos = new Vector3();

    this._camRight = new Vector3();
    this._camUp = new Vector3();
    this._camFwd = new Vector3();
    this._scratchPos = new Vector3();
    this._scratchScale = new Vector3();
    this._scratchMat4 = new Matrix4();

    const n = this._pebbles.getParticleCount();
    this._variant = new Uint8Array(n);
    this._localIdx = new Uint16Array(n);
    this._rot = new Array(n);

    const bucketCounts = new Array<number>(N_PEBBLE_VARIANTS).fill(0);
    const rotAxis = new Vector3();
    for (let i = 0; i < n; i++) {
      const variant = i % N_PEBBLE_VARIANTS;
      this._variant[i] = variant;
      this._localIdx[i] = bucketCounts[variant]++;
      rotAxis.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
      this._rot[i] = new Quaternion().setFromAxisAngle(rotAxis, Math.random() * Math.PI * 2);
    }

    this._meshes = [];
    this._meshEntities = [];
    this._tintAttrs = [];
    this._tintedAttrs = [];
    for (let v = 0; v < N_PEBBLE_VARIANTS; v++) {
      const geo = kFieldPebbleGeos[v];
      geo.setAttribute('aBright', new InstancedBufferAttribute(new Float32Array(bucketCounts[v]).fill(0.7), 1));
      const tintAttr = new InstancedBufferAttribute(new Float32Array(bucketCounts[v] * 3), 3);
      const tintedAttr = new InstancedBufferAttribute(new Float32Array(bucketCounts[v]), 1);
      geo.setAttribute('aTint', tintAttr);
      geo.setAttribute('aTinted', tintedAttr);
      this._tintAttrs.push(tintAttr);
      this._tintedAttrs.push(tintedAttr);
      const mesh = new InstancedMesh(geo, kPebbleFieldTintedMat, bucketCounts[v]);
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.frustumCulled = false;
      this._meshEntities.push(this.world.createTransformEntity(mesh));
      this._meshes.push(mesh);
    }
  }

  play(): void {
    super.play();
    for (const mesh of this._meshes) mesh.visible = true;
  }

  stop(): void {
    super.stop();
    for (const mesh of this._meshes) mesh.visible = false;
  }

  update(): void {
    this._camRight.setFromMatrixColumn(this.camera.matrixWorld, 0);
    this._camUp.setFromMatrixColumn(this.camera.matrixWorld, 1);
    this._camFwd.setFromMatrixColumn(this.camera.matrixWorld, 2);

    const positions = this._pebbles.getPositions();
    this._states = this._pebbles.getStates();
    this._assignedType = this._pebbles.getAssignedType();
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

    for (const mesh of this._meshes) mesh.instanceMatrix.needsUpdate = true;
    for (const attr of this._tintAttrs) attr.needsUpdate = true;
    for (const attr of this._tintedAttrs) attr.needsUpdate = true;

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
    const variant = this._variant[i];
    const local = this._localIdx[i];
    this._scratchScale.setScalar(this._sizes[i] * PEBBLE_MESH_SCALE);
    this._scratchMat4.compose(pos, this._rot[i], this._scratchScale);
    this._meshes[variant].setMatrixAt(local, this._scratchMat4);

    // Fixed color from the moment a pebble spawns — see pebble-layout.ts's
    // assignPebbleSpawnPoint — not something that shifts as you approach it.
    const [r, g, b] = PEBBLE_TYPES[this._assignedType[i]].color;
    this._tintAttrs[variant].setXYZ(local, r, g, b);
    this._tintedAttrs[variant].setX(local, 1);
  }
}
