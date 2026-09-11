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
import { getGlobals } from '../../core/globals.js';
import { Phase } from '../../core/phase.js';
import { buildBlueGreenPalette } from '../../vfx/color/blue-green-palette.js';
import { loadObjLargestIslands } from '../../vfx/geometry/obj-field-loader.js';
import { buildOrganicGeometry } from '../../vfx/geometry/organic-rock-geometry.js';
import { generateRadialField, RadialField } from '../../vfx/particles/particle-field.js';
import { PEBBLE_MESH_SCALE, pebbleSizeFromSample } from '../../vfx/particles/pebble-size.js';
import { SoulPackFlight } from '../../vfx/particles/soul-pack-flight.js';
import { sampleTrailField, sampleTrailOffset } from '../../vfx/particles/trail-sampler.js';
import {
  kGasCloudMat,
  kOrganicGlitterMat,
  kSoulIslandMat,
  PEBBLE_ISLAND_OBJ_GROUPS,
  PEBBLE_ISLAND_OBJ_MAX_COUNT,
  PEBBLE_ISLAND_OBJ_URL,
  SOUL_SIZE_MULTIPLIER,
} from '../../vfx/shaders/pebble-material.js';
import { makePointSpriteMaterial } from '../../vfx/shaders/point-sprite-material.js';
import { makeToonRimDecalMaterial } from '../../vfx/shaders/toon-rim-material.js';
import { PEBBLE_TYPES } from './pebble-type.js';

// ── chapter-2-specific tuning (unchanged from the original comet-system.ts) ─
const N_PEBBLES = 260;
const N_HAZE = 60;
const EXP_DECAY_P = 3.5;
const EXP_DECAY_H = 1.4;
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

// PEBBLE_TYPES' own index order doubles as the render-style dispatch key —
// see pebble-field-vfx-system.ts's identical convention.
const TYPE_SOUL = 0;
const TYPE_ORGANIC = 1;
const TYPE_GAS = 2;

// How many soul slots detach for Dog's completion payoff, and how much
// bigger they read while flying/visiting — see startSoulPackVisit and
// _placeInstancedPebbles's TYPE_SOUL branch.
const SOUL_PACK_SIZE = 6;
const SOUL_FLIGHT_SCALE_BOOST = 1.3;

const N_ORGANIC_VARIANTS = 6;
const ORGANIC_PALETTE = buildBlueGreenPalette();
const kOrganicGeos: BufferGeometry[] = Array.from({ length: N_ORGANIC_VARIANTS }, () => buildOrganicGeometry());

// A freshly constructed InstancedMesh's instanceMatrix buffer starts
// zero-filled (not identity) — that's already a safe, invisible-scale
// degenerate matrix, not the giant native-geometry-scale bug this mirrors
// the fix for elsewhere. This just makes that safety explicit instead of
// relying on the implicit three.js default, so nothing here ever renders at
// an unset/wrong size before the first real per-instance write (mirrors
// pebble-field-vfx-system.ts's own visibility-seeding fix for the same
// "async/rebuilt mesh shows before its real transform is known" hazard).
const ZERO_SCALE_MAT4 = new Matrix4().makeScale(0, 0, 0);
function zeroInstanceMatrices(mesh: InstancedMesh, count: number): void {
  for (let i = 0; i < count; i++) mesh.setMatrixAt(i, ZERO_SCALE_MAT4);
  mesh.instanceMatrix.needsUpdate = true;
}
// Fixed forever, independent of pebbleTypeWeights — every one of the
// N_PEBBLES slots has a permanent "home" local index in every type's
// structure (organic variant, soul island, gas point range), sized to worst
// case (as if every slot were that type). A weight change only flips which
// structure's home is actually drawn at real scale/brightness for a given
// slot (see _recomputeTypesForVisual) — no InstancedMesh/entity is ever
// destroyed or resized by a weight change, which is what lets
// _applyTypeWeights stay a cheap per-frame-safe operation despite firing on
// every dev-menu replay of Chapter 2, not just once per real playthrough.
const ORGANIC_VARIANT_CAPACITY = Math.ceil(N_PEBBLES / N_ORGANIC_VARIANTS);

const CLOUD_POINTS_PER_PEBBLE = 5;
const GAS_CLOUD_SPREAD_SCALE = 1.3;
// 10x the original 1.6 — for a soft additive bloom look instead of tight
// little dots.
const GAS_POINT_SIZE_FACTOR = 16;

// Decal material only uses bodyColorDark + rimColor (no brightness mixing
// for the head), so bodyColorLight is unused here — duplicated to satisfy
// the shared palette shape rather than adding a second interface.
const HEAD_PALETTE = {
  bodyColorDark: [0.03, 0.05, 0.09] as [number, number, number],
  bodyColorLight: [0.03, 0.05, 0.09] as [number, number, number],
  rimColor: [1.0, 1.0, 1.0] as [number, number, number],
};
const HAZE_COLOR: [number, number, number] = [0.3, 0.55, 1.0];
// Warm red/orange, same family as GAS_CLOUD_COLOR — the trail reads as
// visibly ominous for the whole rest of the playthrough once gas locks in
// as dominant, not just during Fate Events (see the dominantPebbleType
// subscribe below, mirroring the head's own retint-on-lock-in pattern).
const HAZE_COLOR_GAS: [number, number, number] = [0.95, 0.35, 0.18];

// Precomputed once at module load — zero runtime cost, shared across every
// PebbleCometPresentationSystem-managed comet.
const kHeadGeo = buildOrganicGeometry();

const kHazeMat = makePointSpriteMaterial({
  color: HAZE_COLOR,
  blending: AdditiveBlending,
  depthWrite: false,
  transparent: true,
});
function makeHeadMat(): ShaderMaterial {
  return makeToonRimDecalMaterial(HEAD_PALETTE);
}

// Maps a pebble's fixed random roll (see CometVisual.pebbleTypeRoll) to one
// of the three type indices, weighted by the current globals.pebbleTypeWeights
// split — same technique a loot table uses to pick from weighted buckets.
function typeForRoll(roll: number, weights: [number, number, number]): number {
  const w0 = weights[0];
  const w1 = w0 + weights[1];
  return roll < w0 ? TYPE_SOUL : roll < w1 ? TYPE_ORGANIC : TYPE_GAS;
}

interface CometVisual {
  pebbleField: RadialField;
  pebbleSizes: Float32Array;
  pebbleRot: Quaternion[];
  // Each pebble's fixed random roll in [0, 1) — see typeForRoll. Combined
  // with the CURRENT globals.pebbleTypeWeights, decides pebbleType.
  pebbleTypeRoll: Float32Array;
  // Current type per slot (0/1/2) — recomputed by _recomputeTypesForVisual
  // whenever pebbleTypeWeights changes; only this + the per-slot
  // scale/brightness values (not any mesh's existence or instance count)
  // ever change on a weight update.
  pebbleType: Uint8Array;

  // Organic (type 1) — fixed home per slot: variant = i % 6, local = floor(i/6).
  organicPaletteColor: Float32Array; // n*3, fixed forever, independent of weights
  organicMeshes: InstancedMesh[];
  organicMeshEntities: Entity[];

  // Soul (type 0) — fixed home per slot, but the mapping itself is
  // recomputed exactly once, whenever the real OBJ islands finish loading
  // (soulBucket/soulLocal go from "1 placeholder bucket" to "N islands").
  soulBucket: Uint8Array;
  soulLocal: Uint16Array;
  soulExtraScale: Float32Array; // 1 until islands load, then 1/islandRadius per slot
  soulWigglePhase: Float32Array;
  soulMeshes: InstancedMesh[];
  soulMeshEntities: Entity[];
  // Guards the async loadObjLargestIslands().then() callback against this
  // visual having been destroyed (comet entity disqualified) while the
  // (shared, cached) load was still in flight.
  destroyed: boolean;
  // Dog constellation's completion payoff — a small pack of already-captured
  // soul slots detaches from the trail, visits the crowd, then returns (see
  // startSoulPackVisit/_placeInstancedPebbles's TYPE_SOUL branch).
  soulFlight: SoulPackFlight;

  // Gas (type 2) — fixed home per slot: points [i*5, i*5+5).
  gasPoints: Points;
  gasPositionAttr: BufferAttribute;
  gasBrightAttr: BufferAttribute;
  gasJitter: Float32Array; // (N_PEBBLES*CLOUD_POINTS_PER_PEBBLE)*3, fixed forever
  gasBaseBright: Float32Array; // same length, fixed forever

  hazeField: RadialField;
  hazePositions: Float32Array;
  hazePositionAttr: BufferAttribute;
  hazePoints: Points;
  hazePointsEntity: Entity;

  headMesh: Mesh;
  headMat: ShaderMaterial;
  headMeshEntity: Entity;
  faceTextures: Texture[];
}

// Phases where the pebble/head body hasn't "formed" yet and stays hidden —
// Stardust (gathering motes) and Pebbles (gathering the ambient pebble
// field itself, see pebble-field-system.ts) both collect raw material for
// this body before it's earned; it becomes visible from Seeding onward.
// Also hidden during Phase.ArtTest — that dev sandbox renders its own
// stand-in "test comet" built from whichever variant is showing (see
// ArtTestVfxSystem), so the real body would just visually double up with it.
const HIDDEN_DURING_PHASES = new Set<Phase>([Phase.Stardust, Phase.Pebbles, Phase.ArtTest]);

// The preserved visual from the original comet-system.ts prototype —
// toon-shaded instanced pebbles + haze + face-decal head — rewired onto the
// generic CometBody/CometTrail components instead of owning private
// left/right state. The system itself always keeps running (position/
// rotation tracking never stops, matching the spring-physics comet being
// always-on) — only the meshes' visibility is gated per HIDDEN_DURING_PHASES.
// Not managed via GameDirectorSystem's play()/stop() (that would mean
// listing this same system in every non-hidden phase config) — it reads
// globals.gamePhase directly instead, since the rule is naturally expressed
// that way.
export class PebbleCometPresentationSystem extends createSystem({
  comets: { required: [CometBody, CometTrail] },
}) {
  private _visuals = new Map<number, CometVisual>();
  private _trailSystem!: CometTrailSystem;
  private _visible = true;

  private _camRight!: Vector3;
  private _camUp!: Vector3;
  private _camFwd!: Vector3;
  private _faceDir!: Vector3;
  private _xAxis!: Vector3;
  private _scratchOffset!: Vector3;
  private _scratchGasPos!: Vector3;
  private _scratchMat4!: Matrix4;
  private _scratchScale!: Vector3;
  private _scratchCometPos!: Vector3;

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
    this._scratchGasPos = new Vector3();
    this._scratchMat4 = new Matrix4();
    this._scratchScale = new Vector3();
    this._scratchCometPos = new Vector3();

    // signal.subscribe() fires immediately with the current value, so
    // _visible is correct before any visuals exist to apply it to.
    this.cleanupFuncs.push(
      getGlobals(this.world).gamePhase.subscribe((phase) => {
        this._visible = !HIDDEN_DURING_PHASES.has(phase);
        this._applyVisibility();

        if (phase === Phase.Seeding) {
          // Retint every comet head from HEAD_PALETTE's near-black default
          // to the player's majority pebble color, right as the body first
          // becomes visible — same "retint on Seeding entry" pattern
          // PlanetSeedingVfxSystem uses for the moons. Unrelated to the
          // pebble-body art-style split above — the head is always the same
          // decal mesh regardless of type.
          const dominant = getGlobals(this.world).dominantPebbleType.peek();
          const color = PEBBLE_TYPES[dominant].color;
          for (const visual of this._visuals.values()) {
            (visual.headMat.uniforms.uBodyColor.value as Vector3).set(...color);
          }
        }
      }),
    );

    // Live for the whole playthrough, independent of gamePhase — retints
    // the shared haze material's uColor uniform the moment gas locks in as
    // dominant (safe to mutate live: there's only ever one active comet per
    // playthrough, see comet-handoff-system.ts).
    this.cleanupFuncs.push(
      getGlobals(this.world).dominantPebbleType.subscribe((dominant) => {
        const color = dominant === TYPE_GAS ? HAZE_COLOR_GAS : HAZE_COLOR;
        (kHazeMat.uniforms.uColor.value as Vector3).set(...color);
      }),
    );

    this.queries.comets.subscribe('qualify', (entity) => this._buildVisual(entity), true);
    this.queries.comets.subscribe('disqualify', (entity) => this._destroyVisual(entity));
    this.cleanupFuncs.push(() => this._visuals.clear());

    // The body is built (and its type buckets initialized from whichever
    // pebbleTypeWeights value exists at the time — see _buildVisual) at
    // boot, long before Chapter 2's win condition ever sets a real value —
    // this is what re-buckets every pebble once that value lands, and any
    // later change (e.g. a dev-menu replay of Chapter 2). Body stays hidden
    // throughout Chapter 2 itself (see HIDDEN_DURING_PHASES), so there's no
    // visible pop.
    this.cleanupFuncs.push(
      getGlobals(this.world).pebbleTypeWeights.subscribe((weights) => this._applyTypeWeights(weights)),
    );
  }

  private _applyTypeWeights(weights: [number, number, number]): void {
    for (const visual of this._visuals.values()) this._recomputeTypesForVisual(visual, weights);
  }

  // Recomputes which type each of the N_PEBBLES slots currently is, then
  // clears every slot's visibility (scale 0 for organic/soul, brightness 0
  // for gas) across ALL three structures before letting the new assignment
  // stand — the very next update() frame's normal per-slot trail-position
  // loop repopulates real scale/brightness for whichever structure is now
  // active per slot (see _placeInstancedPebbles). This is what makes a
  // weight change safe without ever destroying/resizing a mesh: a slot that
  // just stopped being (say) organic would otherwise keep showing its stale
  // last-real-scale organic instance forever, since _placeInstancedPebbles
  // only ever writes to the CURRENTLY active structure per slot.
  private _recomputeTypesForVisual(visual: CometVisual, weights: [number, number, number]): void {
    for (let i = 0; i < N_PEBBLES; i++) visual.pebbleType[i] = typeForRoll(visual.pebbleTypeRoll[i], weights);

    this._scratchScale.setScalar(0);
    for (let i = 0; i < N_PEBBLES; i++) {
      this._scratchMat4.compose(this._scratchOffset, visual.pebbleRot[i], this._scratchScale);
      const organicVariant = i % N_ORGANIC_VARIANTS;
      const organicLocal = Math.floor(i / N_ORGANIC_VARIANTS);
      visual.organicMeshes[organicVariant].setMatrixAt(organicLocal, this._scratchMat4);
      visual.soulMeshes[visual.soulBucket[i]].setMatrixAt(visual.soulLocal[i], this._scratchMat4);
    }
    for (const mesh of visual.organicMeshes) mesh.instanceMatrix.needsUpdate = true;
    for (const mesh of visual.soulMeshes) mesh.instanceMatrix.needsUpdate = true;

    const brightArr = visual.gasBrightAttr.array as Float32Array;
    brightArr.fill(0);
    visual.gasBrightAttr.needsUpdate = true;
  }

  private _applyVisibility(): void {
    for (const visual of this._visuals.values()) {
      for (const mesh of visual.organicMeshes) mesh.visible = this._visible;
      for (const mesh of visual.soulMeshes) mesh.visible = this._visible;
      visual.gasPoints.visible = this._visible;
      visual.hazePoints.visible = this._visible;
      visual.headMesh.visible = this._visible;
    }
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
    const pebbleRot: Quaternion[] = new Array(N_PEBBLES);
    const rotAxisScratch = new Vector3();
    for (let i = 0; i < N_PEBBLES; i++) {
      // Larger pebbles near the dense head, tiny ones toward the tail.
      pebbleSizes[i] = pebbleSizeFromSample(pebbleField.t[i], pebbleField.r[i]);
      rotAxisScratch.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
      pebbleRot[i] = new Quaternion().setFromAxisAngle(rotAxisScratch, Math.random() * Math.PI * 2);
    }

    const pebbleTypeRoll = new Float32Array(N_PEBBLES);
    for (let i = 0; i < N_PEBBLES; i++) pebbleTypeRoll[i] = Math.random();

    const organicPaletteColor = new Float32Array(N_PEBBLES * 3);
    for (let i = 0; i < N_PEBBLES; i++) {
      const [r, g, b] = ORGANIC_PALETTE[Math.floor(Math.random() * ORGANIC_PALETTE.length)];
      organicPaletteColor[i * 3] = r;
      organicPaletteColor[i * 3 + 1] = g;
      organicPaletteColor[i * 3 + 2] = b;
    }

    const organicMeshes: InstancedMesh[] = [];
    const organicMeshEntities: Entity[] = [];
    for (let v = 0; v < N_ORGANIC_VARIANTS; v++) {
      const geo = kOrganicGeos[v];
      geo.setAttribute(
        'aBright',
        new InstancedBufferAttribute(new Float32Array(ORGANIC_VARIANT_CAPACITY).fill(0.7), 1),
      );
      const tintAttr = new InstancedBufferAttribute(new Float32Array(ORGANIC_VARIANT_CAPACITY * 3), 3);
      geo.setAttribute('aTint', tintAttr);
      geo.setAttribute('aTinted', new InstancedBufferAttribute(new Float32Array(ORGANIC_VARIANT_CAPACITY).fill(1), 1));
      const mesh = new InstancedMesh(geo, kOrganicGlitterMat, ORGANIC_VARIANT_CAPACITY);
      mesh.name = `comet-organic-${v}`;
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.frustumCulled = false;
      zeroInstanceMatrices(mesh, ORGANIC_VARIANT_CAPACITY);
      organicMeshEntities.push(this.world.createTransformEntity(mesh));
      organicMeshes.push(mesh);
    }
    for (let i = 0; i < N_PEBBLES; i++) {
      const variant = i % N_ORGANIC_VARIANTS;
      const local = Math.floor(i / N_ORGANIC_VARIANTS);
      const tintAttr = organicMeshes[variant].geometry.getAttribute('aTint') as InstancedBufferAttribute;
      tintAttr.setXYZ(local, organicPaletteColor[i * 3], organicPaletteColor[i * 3 + 1], organicPaletteColor[i * 3 + 2]);
    }
    for (const mesh of organicMeshes) (mesh.geometry.getAttribute('aTint') as InstancedBufferAttribute).needsUpdate = true;

    const soulWigglePhase = new Float32Array(N_PEBBLES);
    for (let i = 0; i < N_PEBBLES; i++) soulWigglePhase[i] = Math.random();
    const soulBucket = new Uint8Array(N_PEBBLES); // all 0 — one placeholder bucket
    const soulLocal = new Uint16Array(N_PEBBLES);
    for (let i = 0; i < N_PEBBLES; i++) soulLocal[i] = i;
    const soulExtraScale = new Float32Array(N_PEBBLES).fill(1);
    const placeholderGeo = buildOrganicGeometry();
    placeholderGeo.setAttribute('aBright', new InstancedBufferAttribute(new Float32Array(N_PEBBLES).fill(0.7), 1));
    placeholderGeo.setAttribute('aTint', new InstancedBufferAttribute(new Float32Array(N_PEBBLES * 3), 3));
    placeholderGeo.setAttribute('aTinted', new InstancedBufferAttribute(new Float32Array(N_PEBBLES), 1));
    const placeholderPhaseAttr = new InstancedBufferAttribute(soulWigglePhase.slice(), 1);
    placeholderGeo.setAttribute('aWigglePhase', placeholderPhaseAttr);
    const soulPlaceholder = new InstancedMesh(placeholderGeo, kSoulIslandMat, N_PEBBLES);
    soulPlaceholder.name = 'comet-soul-placeholder';
    soulPlaceholder.instanceMatrix.setUsage(DynamicDrawUsage);
    soulPlaceholder.frustumCulled = false;
    zeroInstanceMatrices(soulPlaceholder, N_PEBBLES);
    const soulMeshEntities = [this.world.createTransformEntity(soulPlaceholder)];
    const soulMeshes = [soulPlaceholder];

    const gasJitter = new Float32Array(N_PEBBLES * CLOUD_POINTS_PER_PEBBLE * 3);
    const gasBaseBright = new Float32Array(N_PEBBLES * CLOUD_POINTS_PER_PEBBLE);
    const gasSizes = new Float32Array(N_PEBBLES * CLOUD_POINTS_PER_PEBBLE);
    const jitterDir = new Vector3();
    for (let i = 0; i < N_PEBBLES; i++) {
      const spread = pebbleSizes[i] * GAS_CLOUD_SPREAD_SCALE;
      for (let k = 0; k < CLOUD_POINTS_PER_PEBBLE; k++) {
        const flat = i * CLOUD_POINTS_PER_PEBBLE + k;
        jitterDir.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
        const mag = spread * Math.random();
        gasJitter[flat * 3] = jitterDir.x * mag;
        gasJitter[flat * 3 + 1] = jitterDir.y * mag;
        gasJitter[flat * 3 + 2] = jitterDir.z * mag;
        gasBaseBright[flat] = 0.4 + Math.random() * 0.6;
        gasSizes[flat] = pebbleSizes[i] * PEBBLE_MESH_SCALE * GAS_POINT_SIZE_FACTOR * (0.6 + Math.random() * 0.6);
      }
    }
    const gasGeo = new BufferGeometry();
    const gasPosAttr = new BufferAttribute(new Float32Array(N_PEBBLES * CLOUD_POINTS_PER_PEBBLE * 3), 3);
    gasPosAttr.setUsage(DynamicDrawUsage);
    const gasBrightAttr = new BufferAttribute(new Float32Array(N_PEBBLES * CLOUD_POINTS_PER_PEBBLE), 1);
    gasBrightAttr.setUsage(DynamicDrawUsage);
    gasGeo.setAttribute('position', gasPosAttr);
    gasGeo.setAttribute('aBright', gasBrightAttr);
    gasGeo.setAttribute('aSize', new BufferAttribute(gasSizes, 1));
    const gasPoints = new Points(gasGeo, kGasCloudMat);
    gasPoints.name = 'comet-gas-clouds';
    gasPoints.frustumCulled = false;
    this.world.createTransformEntity(gasPoints);

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
    hazePoints.visible = this._visible;
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
    headMesh.name = 'comet-head';
    headMesh.scale.setScalar(HEAD_RADIUS);
    headMesh.frustumCulled = false;
    headMesh.visible = this._visible;
    const headMeshEntity = this.world.createTransformEntity(headMesh);

    for (const mesh of organicMeshes) mesh.visible = this._visible;
    for (const mesh of soulMeshes) mesh.visible = this._visible;
    gasPoints.visible = this._visible;

    const visual: CometVisual = {
      pebbleField,
      pebbleSizes,
      pebbleRot,
      pebbleTypeRoll,
      pebbleType: new Uint8Array(N_PEBBLES),
      organicPaletteColor,
      organicMeshes,
      organicMeshEntities,
      soulBucket,
      soulLocal,
      soulExtraScale,
      soulWigglePhase,
      soulMeshes,
      soulMeshEntities,
      destroyed: false,
      soulFlight: new SoulPackFlight(),
      gasPoints,
      gasPositionAttr: gasPosAttr,
      gasBrightAttr,
      gasJitter,
      gasBaseBright,
      hazeField,
      hazePositions,
      hazePositionAttr,
      hazePoints,
      hazePointsEntity,
      headMesh,
      headMat,
      headMeshEntity,
      faceTextures,
    };
    this._visuals.set(entity.index, visual);

    const initialWeights = getGlobals(this.world).pebbleTypeWeights.peek();
    this._recomputeTypesForVisual(visual, initialWeights);

    loadObjLargestIslands(PEBBLE_ISLAND_OBJ_URL, PEBBLE_ISLAND_OBJ_GROUPS, PEBBLE_ISLAND_OBJ_MAX_COUNT).then(
      (islands) => {
        if (visual.destroyed) return;
        if (islands.length === 0) {
          console.warn(
            `[PebbleCometPresentationSystem] no mesh islands found under ${PEBBLE_ISLAND_OBJ_GROUPS.join('/')} in '${PEBBLE_ISLAND_OBJ_URL}' — keeping the primitive placeholder soul pebbles.`,
          );
          return;
        }
        for (const e of visual.soulMeshEntities) {
          // Same reasoning as pebble-field-vfx-system.ts's identical swap:
          // the placeholder's own geometry isn't shared with anything else,
          // unlike kSoulIslandMat — dispose it explicitly (e.dispose()
          // isn't safe here, it would also free the SHARED material).
          (e.object3D as InstancedMesh).geometry.dispose();
          e.destroy();
        }

        const islandCount = islands.length;
        const capacity = Math.ceil(N_PEBBLES / islandCount);
        const newMeshes: InstancedMesh[] = [];
        const newEntities: Entity[] = [];
        for (let islandIdx = 0; islandIdx < islandCount; islandIdx++) {
          // .clone() — loadObjLargestIslands caches and returns these SAME
          // geometry objects to every caller requesting this (url, groups,
          // count) key (art-test's own "8 islands" variants, Fate Events'
          // placeholder crowd, and pebble-field-vfx-system.ts all ask for
          // the same 8 islands); setAttribute() below mutates the geometry
          // directly, so without cloning, each caller's per-instance
          // buffers would stomp on every other caller's already-built mesh
          // sharing that object.
          const geo = islands[islandIdx].clone();
          geo.setAttribute('aBright', new InstancedBufferAttribute(new Float32Array(capacity).fill(0.7), 1));
          geo.setAttribute('aTint', new InstancedBufferAttribute(new Float32Array(capacity * 3), 3));
          geo.setAttribute('aTinted', new InstancedBufferAttribute(new Float32Array(capacity), 1));
          geo.setAttribute('aWigglePhase', new InstancedBufferAttribute(new Float32Array(capacity), 1));
          const mesh = new InstancedMesh(geo, kSoulIslandMat, capacity);
          mesh.name = `comet-soul-island-${islandIdx}`;
          mesh.instanceMatrix.setUsage(DynamicDrawUsage);
          mesh.frustumCulled = false;
          zeroInstanceMatrices(mesh, capacity);
          mesh.visible = this._visible;
          newEntities.push(this.world.createTransformEntity(mesh));
          newMeshes.push(mesh);
        }

        for (let i = 0; i < N_PEBBLES; i++) {
          const islandIdx = i % islandCount;
          const local = Math.floor(i / islandCount);
          visual.soulBucket[i] = islandIdx;
          visual.soulLocal[i] = local;
          const islandRadius =
            islands[islandIdx].boundingSphere && islands[islandIdx].boundingSphere!.radius > 1e-6
              ? islands[islandIdx].boundingSphere!.radius
              : 1;
          visual.soulExtraScale[i] = 1 / islandRadius;
          const phaseAttr = newMeshes[islandIdx].geometry.getAttribute('aWigglePhase') as InstancedBufferAttribute;
          phaseAttr.setX(local, visual.soulWigglePhase[i]);
        }
        for (const mesh of newMeshes) {
          (mesh.geometry.getAttribute('aWigglePhase') as InstancedBufferAttribute).needsUpdate = true;
        }

        visual.soulMeshes = newMeshes;
        visual.soulMeshEntities = newEntities;
        // Re-clear + reassign so soul slots (now living at new
        // mesh/local-index homes) get a correct scale on the very next
        // frame instead of showing whatever stale matrix the fresh
        // InstancedMeshes happen to start with.
        this._recomputeTypesForVisual(visual, getGlobals(this.world).pebbleTypeWeights.peek());
      },
    );
  }

  private _destroyVisual(entity: Entity): void {
    const visual = this._visuals.get(entity.index);
    if (!visual) return;
    visual.destroyed = true;
    // organicMeshes share kOrganicGeos (module-scope, every comet's own
    // organic buckets reuse the same 6 geometries) — destroy() only, same
    // as the shared materials (kOrganicGlitterMat/kSoulIslandMat/
    // kGasCloudMat/kHazeMat), so we don't free GPU resources still in use
    // elsewhere. soulMeshes' geometry is NOT shared (either the
    // placeholder's own buildOrganicGeometry() call, or this visual's own
    // .clone() of an island — see _buildVisual) — dispose it explicitly
    // first, same reasoning as the placeholder-swap callback above.
    // headMat is the one truly per-visual resource, safe to dispose
    // directly.
    for (const e of visual.organicMeshEntities) e.destroy();
    for (const e of visual.soulMeshEntities) {
      (e.object3D as InstancedMesh).geometry.dispose();
      e.destroy();
    }
    visual.hazePointsEntity.destroy();
    visual.headMeshEntity.destroy();
    visual.headMat.dispose();
    this._visuals.delete(entity.index);
  }

  // Dog constellation's completion payoff (see EarthSituationsVfxSystem.
  // _onCompletion) — picks a handful of this comet's currently-soul-type
  // slots, captures where they currently ride the trail, and hands them to
  // that visual's own SoulPackFlight to detach/visit/return. No-ops quietly
  // if the comet has no visual yet or currently has no trail buffer
  // (shouldn't happen by the time Fate Events completes, but this mirrors
  // every other trail consumer's own `if (!trail) continue/return` guard).
  startSoulPackVisit(entity: Entity, targetPositions: readonly Vector3[], onComplete?: () => void): void {
    const visual = this._visuals.get(entity.index);
    if (!visual) return;
    const trail = this._trailSystem.getBuffer(entity);
    if (!trail) return;
    const samples = entity.getValue(CometTrail, 'samples') as number;
    const stride = entity.getValue(CometTrail, 'stride') as number;

    const candidates: number[] = [];
    for (let i = 0; i < N_PEBBLES; i++) if (visual.pebbleType[i] === TYPE_SOUL) candidates.push(i);
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    const picked = candidates.slice(0, Math.min(SOUL_PACK_SIZE, candidates.length));
    if (picked.length === 0) return;

    const fromPositions = picked.map((i) => {
      const out = new Vector3();
      sampleTrailOffset(
        trail,
        samples,
        stride,
        visual.pebbleField.t[i],
        visual.pebbleField.dx[i],
        visual.pebbleField.dy[i],
        visual.pebbleField.dz[i],
        this._camRight,
        this._camUp,
        this._camFwd,
        out,
      );
      return out;
    });
    visual.soulFlight.trigger(picked, fromPositions, targetPositions, onComplete);
  }

  update(delta: number, time: number): void {
    kSoulIslandMat.uniforms.uTime.value = time;
    kOrganicGlitterMat.uniforms.uTime.value = time;

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
      this._scratchCometPos.fromArray(posView);
      visual.soulFlight.update(delta);

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
    const { pebbleField, pebbleSizes, pebbleRot, pebbleType, organicMeshes, soulMeshes, soulBucket, soulLocal, soulExtraScale } =
      visual;
    const posArr = visual.gasPositionAttr.array as Float32Array;
    const brightArr = visual.gasBrightAttr.array as Float32Array;

    for (let i = 0; i < N_PEBBLES; i++) {
      const type = pebbleType[i];
      const inFlight = type === TYPE_SOUL && visual.soulFlight.isActive(i);
      if (inFlight) {
        visual.soulFlight.getPosition(i, this._scratchOffset, this._scratchCometPos);
      } else {
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
      }

      if (type === TYPE_ORGANIC) {
        this._scratchScale.setScalar(pebbleSizes[i] * PEBBLE_MESH_SCALE);
        this._scratchMat4.compose(this._scratchOffset, pebbleRot[i], this._scratchScale);
        organicMeshes[i % N_ORGANIC_VARIANTS].setMatrixAt(Math.floor(i / N_ORGANIC_VARIANTS), this._scratchMat4);
      } else if (type === TYPE_SOUL) {
        // A visibly bigger boost while visiting the crowd — cheap "these
        // pebbles are doing something special" cue, no extra per-instance
        // tint attribute bookkeeping needed.
        const flightBoost = inFlight ? SOUL_FLIGHT_SCALE_BOOST : 1;
        this._scratchScale.setScalar(
          pebbleSizes[i] * PEBBLE_MESH_SCALE * soulExtraScale[i] * SOUL_SIZE_MULTIPLIER * flightBoost,
        );
        this._scratchMat4.compose(this._scratchOffset, pebbleRot[i], this._scratchScale);
        soulMeshes[soulBucket[i]].setMatrixAt(soulLocal[i], this._scratchMat4);
      } else {
        const base = i * CLOUD_POINTS_PER_PEBBLE;
        for (let k = 0; k < CLOUD_POINTS_PER_PEBBLE; k++) {
          const flat = base + k;
          this._scratchGasPos
            .copy(this._scratchOffset)
            .addScaledVector(this._camRight, visual.gasJitter[flat * 3])
            .addScaledVector(this._camUp, visual.gasJitter[flat * 3 + 1])
            .addScaledVector(this._camFwd, visual.gasJitter[flat * 3 + 2]);
          posArr[flat * 3] = this._scratchGasPos.x;
          posArr[flat * 3 + 1] = this._scratchGasPos.y;
          posArr[flat * 3 + 2] = this._scratchGasPos.z;
          brightArr[flat] = visual.gasBaseBright[flat];
        }
      }
    }
    for (const mesh of organicMeshes) mesh.instanceMatrix.needsUpdate = true;
    for (const mesh of soulMeshes) mesh.instanceMatrix.needsUpdate = true;
    visual.gasPositionAttr.needsUpdate = true;
    visual.gasBrightAttr.needsUpdate = true;
  }
}
