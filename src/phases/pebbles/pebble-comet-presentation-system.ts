import {
  AdditiveBlending,
  AssetManager,
  BufferAttribute,
  BufferGeometry,
  createSystem,
  DynamicDrawUsage,
  Entity,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  NearestFilter,
  Points,
  Quaternion,
  ShaderMaterial,
  Texture,
  Vector3,
} from '@iwsdk/core';
import { CometBody } from '../../comet/comet-body-component.js';
import { CometTrail } from '../../comet/comet-trail-component.js';
import { CometTrailSystem } from '../../comet/comet-trail-system.js';
import { buildOrganicGeometry } from '../../vfx/geometry/organic-rock-geometry.js';
import { generateRadialField, RadialField } from '../../vfx/particles/particle-field.js';
import { sampleTrailField, sampleTrailOffset } from '../../vfx/particles/trail-sampler.js';
import { makePointSpriteMaterial } from '../../vfx/shaders/point-sprite-material.js';
import { makeToonRimDecalMaterial, makeToonRimInstancedMaterial } from '../../vfx/shaders/toon-rim-material.js';

// ── chapter-2-specific tuning (unchanged from the original comet-system.ts) ─
const N_PEBBLES = 260;
const N_HAZE = 60;
const EXP_DECAY_P = 3.5;
const EXP_DECAY_H = 1.4;
const N_PEBBLE_VARIANTS = 6;
// pebSizes was originally tuned as a gl_PointSize screen-space pixel
// heuristic, not a world-space meter radius. Scaled down so pebbles read as
// small rocks rather than boulders crowding the head.
const PEBBLE_MESH_SCALE = 0.22;
// Head radius (real world-space meters) — smaller than the pebbles' largest
// near-head size so it reads as part of the rock cluster, not a big clean
// orb looming over it.
const HEAD_RADIUS = 0.024;
// Below this speed, velocity direction is noisy/undefined, so the head just
// holds its last orientation instead of snapping to an arbitrary default.
const FACING_SPEED_EPSILON_SQ = 0.0004;
// Speed-based face selection: slow cycles the first pair of textures at
// ~1.2 Hz, fast cycles the second pair at ~3 Hz (time * 2.0 in both cases —
// 0.5s per expression).
const FACE_CYCLE_SPEED_THRESHOLD = 1.5;

const PEBBLE_PALETTE = {
  bodyColorDark: [0.01, 0.02, 0.05] as [number, number, number],
  bodyColorLight: [0.05, 0.08, 0.14] as [number, number, number],
  rimColor: [1.0, 1.0, 1.0] as [number, number, number],
};
// Decal material only uses bodyColorDark + rimColor (no brightness mixing
// for the head), so bodyColorLight is unused here — duplicated to satisfy
// the shared palette shape rather than adding a second interface.
const HEAD_PALETTE = {
  bodyColorDark: [0.03, 0.05, 0.09] as [number, number, number],
  bodyColorLight: [0.03, 0.05, 0.09] as [number, number, number],
  rimColor: [1.0, 1.0, 1.0] as [number, number, number],
};
const HAZE_COLOR: [number, number, number] = [0.3, 0.55, 1.0];

// Precomputed once at module load — zero runtime cost, shared across every
// PebbleCometPresentationSystem-managed comet.
const kPebbleVariantGeos: BufferGeometry[] = Array.from({ length: N_PEBBLE_VARIANTS }, () =>
  buildOrganicGeometry(),
);
// Same wobbly rock shape/build as the pebbles (not a clean sphere) — the
// head's flat decal texture projection uses raw local position, not a UV
// atlas, so it tolerates this displacement fine, same as pebbles tolerate it
// with no texture at all.
const kHeadGeo = buildOrganicGeometry();

const kPebbleInstMat = makeToonRimInstancedMaterial(PEBBLE_PALETTE);
const kHazeMat = makePointSpriteMaterial({
  color: HAZE_COLOR,
  blending: AdditiveBlending,
  depthWrite: false,
  transparent: true,
});
function makeHeadMat(): ShaderMaterial {
  return makeToonRimDecalMaterial(HEAD_PALETTE);
}

interface CometVisual {
  pebbleField: RadialField;
  pebbleSizes: Float32Array;
  pebbleVariant: Uint8Array;
  pebbleLocalIdx: Uint16Array;
  pebbleRot: Quaternion[];
  pebbleMeshes: InstancedMesh[];

  pebbleMeshEntities: Entity[];

  hazeField: RadialField;
  hazePositions: Float32Array;
  hazePositionAttr: BufferAttribute;
  hazePointsEntity: Entity;

  headMesh: Mesh;
  headMat: ShaderMaterial;
  headMeshEntity: Entity;
  faceTextures: Texture[];
}

// The preserved visual from the original comet-system.ts prototype —
// toon-shaded instanced pebbles + haze + face-decal head — rewired onto the
// generic CometBody/CometTrail components instead of owning private
// left/right state. Always registered, never phase-gated: per the confirmed
// design decision, this IS the comet throughout the whole experience: later
// chapters layer their own extra VFX around it rather than replacing it.
export class PebbleCometPresentationSystem extends createSystem({
  comets: { required: [CometBody, CometTrail] },
}) {
  private _visuals = new Map<number, CometVisual>();
  private _trailSystem!: CometTrailSystem;

  private _camRight!: Vector3;
  private _camUp!: Vector3;
  private _camFwd!: Vector3;
  private _faceDir!: Vector3;
  private _xAxis!: Vector3;
  private _scratchOffset!: Vector3;
  private _scratchMat4!: Matrix4;
  private _scratchScale!: Vector3;

  init(): void {
    // CometTrailSystem must be registered before this system (see index.ts)
    // so it already exists in the world when this init() runs.
    this._trailSystem = this.world.getSystem(CometTrailSystem)!;

    this._camRight = new Vector3();
    this._camUp = new Vector3();
    this._camFwd = new Vector3();
    this._faceDir = new Vector3();
    this._xAxis = new Vector3(1, 0, 0);
    this._scratchOffset = new Vector3();
    this._scratchMat4 = new Matrix4();
    this._scratchScale = new Vector3();

    this.queries.comets.subscribe('qualify', (entity) => this._buildVisual(entity), true);
    this.queries.comets.subscribe('disqualify', (entity) => this._destroyVisual(entity));
    this.cleanupFuncs.push(() => this._visuals.clear());
  }

  private _buildVisual(entity: Entity): void {
    const pebbleField = generateRadialField({
      count: N_PEBBLES,
      ageDecay: EXP_DECAY_P,
      // Base offset raised from 0.008 so near-head pebbles keep some
      // clearance from the head instead of clustering directly on top of it.
      spreadBase: 0.024,
      spreadGrowth: 0.038,
      depthRatio: 1.6,
    });

    const pebbleSizes = new Float32Array(N_PEBBLES);
    const pebbleVariant = new Uint8Array(N_PEBBLES);
    const pebbleLocalIdx = new Uint16Array(N_PEBBLES);
    const pebbleRot: Quaternion[] = new Array(N_PEBBLES);
    const pebBright = new Float32Array(N_PEBBLES);
    const bucketBright: number[][] = Array.from({ length: N_PEBBLE_VARIANTS }, () => []);
    const rotAxisScratch = new Vector3();

    for (let i = 0; i < N_PEBBLES; i++) {
      const t = pebbleField.t[i];
      const r = pebbleField.r[i];
      // Larger pebbles near the dense head, tiny ones toward the tail.
      pebbleSizes[i] = Math.max(0.006, (0.038 - t * 0.02) * (1.0 - Math.min(r, 2.5) * 0.08));
      // Brightness: mix of bright glowing and dim shadowy pebbles for hazy variety.
      pebBright[i] = 0.25 + Math.random() * 0.75;

      const variant = i % N_PEBBLE_VARIANTS;
      pebbleVariant[i] = variant;
      pebbleLocalIdx[i] = bucketBright[variant].length;
      bucketBright[variant].push(pebBright[i]);

      rotAxisScratch
        .set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1)
        .normalize();
      pebbleRot[i] = new Quaternion().setFromAxisAngle(rotAxisScratch, Math.random() * Math.PI * 2);
    }

    // One InstancedMesh per rock-shape variant. aBright is written onto the
    // shared module-scope variant geometry here — safe as long as every
    // qualifying comet entity uses the same N_PEBBLE_VARIANTS bucket sizes
    // (true today: all comets share identical distribution parameters).
    const pebbleMeshes: InstancedMesh[] = [];
    const pebbleMeshEntities: Entity[] = [];
    for (let v = 0; v < N_PEBBLE_VARIANTS; v++) {
      const geo = kPebbleVariantGeos[v];
      geo.setAttribute('aBright', new InstancedBufferAttribute(new Float32Array(bucketBright[v]), 1));

      const count = bucketBright[v].length;
      const mesh = new InstancedMesh(geo, kPebbleInstMat, count);
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.frustumCulled = false;
      pebbleMeshEntities.push(this.world.createTransformEntity(mesh));
      pebbleMeshes.push(mesh);
    }

    const hazeField = generateRadialField({
      count: N_HAZE,
      ageDecay: EXP_DECAY_H,
      spreadBase: 0.02,
      spreadGrowth: 0.06,
      depthRatio: 1.4,
    });
    const hazeSizes = new Float32Array(N_HAZE);
    const hazeBright = new Float32Array(N_HAZE);
    for (let i = 0; i < N_HAZE; i++) {
      hazeSizes[i] = 0.05 + Math.random() * 0.06; // large soft blobs
      hazeBright[i] = (0.04 + Math.random() * 0.1) * (1 - hazeField.t[i]); // very dim, fades with age
    }
    const hazeGeo = new BufferGeometry();
    hazeGeo.setAttribute('aSize', new BufferAttribute(hazeSizes, 1));
    hazeGeo.setAttribute('aBright', new BufferAttribute(hazeBright, 1));
    const hazePositions = new Float32Array(N_HAZE * 3);
    const hazePositionAttr = new BufferAttribute(hazePositions, 3);
    hazePositionAttr.setUsage(DynamicDrawUsage);
    hazeGeo.setAttribute('position', hazePositionAttr);
    const hazePoints = new Points(hazeGeo, kHazeMat);
    hazePoints.frustumCulled = false;
    const hazePointsEntity = this.world.createTransformEntity(hazePoints);

    // Face textures (already resolved by the AssetManifest in index.ts).
    // NOTE: preserved exactly as the original prototype — the array pulls
    // beepchat3/4 + smile1/2, not beepchat1/2, despite the speed-cycling
    // comment below implying a "slow" pair vs a "fast" pair; this is
    // pre-existing behavior carried over verbatim, not a new choice.
    const faceTextures = ['beepchat3', 'beepchat4', 'smile1', 'smile2'].map((k) => {
      const tex = AssetManager.getTexture(k)!;
      tex.magFilter = NearestFilter;
      tex.minFilter = NearestFilter;
      return tex;
    });

    const headMat = makeHeadMat();
    headMat.uniforms.uFaceTex.value = faceTextures[0];
    const headMesh = new Mesh(kHeadGeo, headMat);
    headMesh.scale.setScalar(HEAD_RADIUS);
    headMesh.frustumCulled = false;
    const headMeshEntity = this.world.createTransformEntity(headMesh);

    this._visuals.set(entity.index, {
      pebbleField,
      pebbleSizes,
      pebbleVariant,
      pebbleLocalIdx,
      pebbleRot,
      pebbleMeshes,
      pebbleMeshEntities,
      hazeField,
      hazePositions,
      hazePositionAttr,
      hazePointsEntity,
      headMesh,
      headMat,
      headMeshEntity,
      faceTextures,
    });
  }

  private _destroyVisual(entity: Entity): void {
    const visual = this._visuals.get(entity.index);
    if (!visual) return;
    // Geometries/kPebbleInstMat/kHazeMat are module-scope singletons shared
    // across every comet — destroy() (not dispose()) so we don't free GPU
    // resources still in use elsewhere. headMat is the one truly per-visual
    // resource, safe to dispose directly.
    for (const e of visual.pebbleMeshEntities) e.destroy();
    visual.hazePointsEntity.destroy();
    visual.headMeshEntity.destroy();
    visual.headMat.dispose();
    this._visuals.delete(entity.index);
  }

  update(_delta: number, time: number): void {
    this._camRight.setFromMatrixColumn(this.camera.matrixWorld, 0);
    this._camUp.setFromMatrixColumn(this.camera.matrixWorld, 1);
    this._camFwd.setFromMatrixColumn(this.camera.matrixWorld, 2);

    for (const entity of this.queries.comets.entities) {
      const visual = this._visuals.get(entity.index);
      if (!visual) continue;

      const trail = this._trailSystem.getBuffer(entity);
      if (!trail) continue;
      const samples = entity.getValue(CometTrail, 'samples') as number;
      const stride = entity.getValue(CometTrail, 'stride') as number;

      const posView = entity.getVectorView(CometBody, 'position') as Float32Array;
      const velView = entity.getVectorView(CometBody, 'velocity') as Float32Array;

      // Head tracks current position, rotated to keep its textured front
      // facing the direction of travel (velocity) rather than the camera.
      visual.headMesh.position.fromArray(posView);
      const velLenSq = velView[0] * velView[0] + velView[1] * velView[1] + velView[2] * velView[2];
      if (velLenSq > FACING_SPEED_EPSILON_SQ) {
        this._faceDir.fromArray(velView).normalize();
        visual.headMesh.quaternion.setFromUnitVectors(this._xAxis, this._faceDir);
        // Decal faces backwards/upside-down relative to this alignment
        // alone — correct with an extra 180° roll about the local Z (side) axis.
        visual.headMesh.rotateZ(Math.PI);
      }

      const speed = Math.sqrt(velLenSq);
      const cycleIdx = Math.floor(time * 2.0) % 2;
      const faceIdx = speed >= FACE_CYCLE_SPEED_THRESHOLD ? 2 + cycleIdx : cycleIdx;
      visual.headMat.uniforms.uFaceTex.value = visual.faceTextures[faceIdx];

      this._placeInstancedPebbles(trail, samples, stride, visual);
      sampleTrailField(
        trail,
        samples,
        stride,
        visual.hazeField,
        this._camRight,
        this._camUp,
        this._camFwd,
        visual.hazePositions,
        this._scratchOffset,
      );
      visual.hazePositionAttr.needsUpdate = true;
    }
  }

  private _placeInstancedPebbles(
    trail: Float32Array,
    samples: number,
    stride: number,
    visual: CometVisual,
  ): void {
    const { pebbleField, pebbleSizes, pebbleRot, pebbleVariant, pebbleLocalIdx, pebbleMeshes } = visual;
    for (let i = 0; i < N_PEBBLES; i++) {
      sampleTrailOffset(
        trail,
        samples,
        stride,
        pebbleField.t[i],
        pebbleField.dx[i],
        pebbleField.dy[i],
        pebbleField.dz[i],
        this._camRight,
        this._camUp,
        this._camFwd,
        this._scratchOffset,
      );
      this._scratchScale.setScalar(pebbleSizes[i] * PEBBLE_MESH_SCALE);
      this._scratchMat4.compose(this._scratchOffset, pebbleRot[i], this._scratchScale);
      pebbleMeshes[pebbleVariant[i]].setMatrixAt(pebbleLocalIdx[i], this._scratchMat4);
    }
    for (const mesh of pebbleMeshes) mesh.instanceMatrix.needsUpdate = true;
  }
}
