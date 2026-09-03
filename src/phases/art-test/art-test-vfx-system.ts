import {
  AdditiveBlending,
  AssetManager,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  createSystem,
  DoubleSide,
  Follower,
  FollowBehavior,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Points,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from '@iwsdk/core';
import { CometBody } from '../../comet/comet-body-component.js';
import { HandAnchor } from '../../comet/hand-anchor-component.js';
import { randomUnitVector3 } from '../../vfx/geometry/mesh-utils.js';
import { loadObjLargestIslands } from '../../vfx/geometry/obj-field-loader.js';
import { buildOrganicGeometry } from '../../vfx/geometry/organic-rock-geometry.js';
import {
  buildStreakRibbonGeometry,
  sampleSwooshCurve,
  SwooshCurveParams,
} from '../../vfx/geometry/streak-path.js';
import { PEBBLE_MESH_SCALE, pebbleSizeFromSample } from '../../vfx/particles/pebble-size.js';
import { makeGhostWiggleMaterial } from '../../vfx/shaders/ghost-wiggle-material.js';
import { makePointSpriteMaterial } from '../../vfx/shaders/point-sprite-material.js';
import { makeSparkleMaterial, makeSparkleTexturedMaterial } from '../../vfx/shaders/sparkle-material.js';
import { makeStreakRibbonMaterial } from '../../vfx/shaders/streak-ribbon-material.js';
import {
  makeToonRimAlphaDecalMaterial,
  makeToonRimInstancedGrainyMaterial,
  makeToonRimInstancedTintedMaterial,
} from '../../vfx/shaders/toon-rim-material.js';
import { STARDUST_COLOR } from '../stardust/stardust-vfx-system.js';
import { PEBBLE_TYPES } from '../pebbles/pebble-type.js';
import { ART_TEST_VARIANT_LABELS, ArtTestSystem } from './art-test-system.js';

// Where every variant scatters — a comfortable "stand here and look around"
// volume, same philosophy as StardustSystem's own spawn volume.
const FIELD_CENTER: [number, number, number] = [0, 1.4, -1.4];
const FIELD_MIN_RADIUS = 0.4;
const FIELD_MAX_RADIUS = 1.6;

const STARDUST_POINT_COUNT = 240; // variant 1 (point sprites — cheap, matches the real field's density)

const PEBBLES_PER_TYPE = 30; // x3 types = 90, shared layout across the pebble variants for a fair comparison
// Real in-game pebble size — same formula PebbleFieldVfxSystem itself uses
// (PEBBLE_MESH_SCALE * pebbleSizeFromSample), sampled at one representative
// mid-tail point, rather than an art-test-only "make it easier to see"
// blow-up. buildOrganicGeometry()'s own natural radius is ~1 unit, so this
// doubles directly as the mesh's world-space scale.
const PEBBLE_RADIUS = PEBBLE_MESH_SCALE * pebbleSizeFromSample(0.4, 0.8);
const HAZE_RADIUS = PEBBLE_RADIUS * 4;
// Plain black body, crisp white rim outline, no tint — shared by the black
// + magical haze pebbles and the OBJ islands pebbles (see their own
// builders) so "the same shader" is literally true, not just visually
// similar.
const BLACK_RIM_PALETTE = {
  bodyColorDark: [0.015, 0.015, 0.018] as [number, number, number],
  bodyColorLight: [0.04, 0.04, 0.05] as [number, number, number],
  rimColor: [1, 1, 1] as [number, number, number],
};
// "More organic, minimal, dark, grainy/sparkly" — see
// makeToonRimInstancedGrainyMaterial's own comment for the shader side of
// this. Dark enough that vTint's 0.35-strength wash and the sparkle flecks
// (not this base color) are what actually carries each pebble's RGB hue.
const RGB_PEBBLE_PALETTE = {
  bodyColorDark: [0.018, 0.018, 0.022] as [number, number, number],
  bodyColorLight: [0.045, 0.045, 0.055] as [number, number, number],
  rimColor: [1, 1, 1] as [number, number, number],
};

// The OBJ this project has actually been given — see obj-island-extractor.ts
// / loadObjLargestIslands. Its 'Layer_1'/'Layer_2' groups have no
// per-object tagging, just ~293 sculpted pieces merged together (checked
// directly via connected-components analysis: Layer_1 alone is 190
// disconnected pieces, Layer_2 is 103) — OBJ_ISLANDS_MAX_COUNT is how many
// of the overall biggest ones (by triangle count) get extracted and
// randomly used, per the user's own choice over building all ~293 or
// hand-picking a curated subset.
const GHOST_OBJ_URL = '/medium/virtualpebble_2026-09-03_13-09-21.obj';
const OBJ_ISLANDS_GROUPS = ['Layer_1', 'Layer_2'];
const OBJ_ISLANDS_MAX_COUNT = 8;
// 3x the other pebble variants' PEBBLE_RADIUS — was 4x (doubled from an
// original 2x), scaled back down to 0.75 of that.
const OBJ_ISLANDS_PEBBLE_RADIUS = PEBBLE_RADIUS * 4 * 0.75;

// Real, already-available texture assets (see index.ts's AssetManifest) —
// unlike the FBX/OBJ variants above, these load immediately, no placeholder
// needed.
const FABRIC_GHOST_KEYS = ['fabricGhost1', 'fabricGhost2', 'fabricGhost3', 'fabricGhost4'];
// Fixed, not PEBBLE_RADIUS-derived — these are their own billboard sprite,
// not meant to shrink/grow along with the rock pebbles' own real-world size.
const GHOST_BILLBOARD_SIZE = 0.025; // 1/3 of the previous 0.075
// No longer tied to _pebbleLayout()'s soul-slot count (was fixed at 30 —
// PEBBLES_PER_TYPE) — its own scatter, sized independently so "more of
// them" doesn't need touching the shared pebble layout other variants rely
// on for a fair comparison.
const GHOST_BILLBOARD_COUNT = 90;
// Both scaled down relative to GHOST_BILLBOARD_SIZE (0.025) — at the old
// values (0.03 bob, 0.02 wiggle) each was comparable to the sprite's own
// size, which read as a big bounce and an outright stretch/skew rather than
// a gentle bob and a subtle wave.
const GHOST_BOB_AMPLITUDE = 0.01;
const GHOST_BOB_FREQ = 1.1; // Hz — gentle, not a bounce
// Vertex-shader wiggle (see ghost-wiggle-material.ts) — tapered so the
// "head" (top of the billboard) stays put and the "tail" (bottom) waves,
// classic ghost-sheet motion.
const GHOST_WIGGLE_AMPLITUDE = 0.004;
const GHOST_WIGGLE_FREQUENCY = 6.0;
const GHOST_WIGGLE_SPEED = 2.2;

// Real organic-rock pebbles with a fabric-ghost texture decal-projected onto
// their front face — same technique/shader family as the comet head's own
// beepchat/smile faces (see makeToonRimAlphaDecalMaterial's own comment).
// 1.5x PEBBLE_RADIUS (same base size as the normal pebble variants, just
// scaled up) rather than a fully separate size constant.
const GHOST_DECAL_PEBBLE_SCALE = 1.5;
const GHOST_DECAL_BODY_COLOR: [number, number, number] = [0.02, 0.02, 0.02];

const STAR_ILLUSTRATION_KEY = 'starIllustration';
const STAR_ILLUSTRATION_COUNT = 600; // "lots of them"
const STAR_ILLUSTRATION_SIZE = 0.018; // 1/5 of the previous 0.09
// Every other star (i % 2 === 0 — an even split, not random, so it's
// consistent frame to frame and playthrough to playthrough) also gets a
// soft point-sprite halo layered behind it, using the exact same shader/
// color variant 1's "current stardust" field uses (makeSparkleMaterial) —
// that procedural core+glint shape is what actually reads as "blooming";
// the illustrated PNG alone has no soft falloff of its own.
const STAR_BLOOM_SIZE = STAR_ILLUSTRATION_SIZE * 2.5;

// Variant 11 — "magic stardust sweep": a glowing spiral-into-sweep ribbon
// (see streak-path.ts) with fine-grain sparkle dust haloed around it and
// descending drip trails, after a reference image of swirling light streaks
// dripping stardust. A cool white-blue rather than STARDUST_COLOR — a
// distinct "magic" palette, not meant to look like the game's real ambient
// stardust.
const STREAK_COLOR: [number, number, number] = [0.72, 0.85, 1.0];
const STREAK_SEGMENTS = 140;
const STREAK_MAX_WIDTH = 0.05;
const STREAK_HALO_COUNT = 450; // per curve — the fine-grain dust cloud around each streak
const STREAK_HALO_JITTER = 0.1;
const STREAK_HALO_SIZE = 0.01; // fine grain, much smaller than the stardust variants' own motes
const STREAK_DRIP_COLUMNS = 9; // per curve, spaced along the tail half where it's swept out and descending
const STREAK_DRIP_LENGTH = 7; // motes per column
const STREAK_DRIP_SPACING = 0.05;
const STREAK_DRIP_JITTER = 0.012;
const STREAK_DRIP_SIZE = 0.009;

const LABEL_WIDTH = 0.5;
const LABEL_HEIGHT = 0.12;
const LABEL_CANVAS_W = 640;
const LABEL_CANVAS_H = 160;

// Your actual comet body is hidden for the whole Art Test phase (see
// PebbleCometPresentationSystem's own HIDDEN_DURING_PHASES) — each variant
// instead gets a small stand-in "test comet" built from that variant's own
// exact material/geometry, tracking your live hand position every frame (see
// _updateTestComet), so "what would my comet look like made of this" reads
// directly rather than needing to compare a separate static field to your
// real comet. A tight scatter of TEST_COMET_COUNT pieces around the hand,
// not a full trail — simplest version that still reads as "a comet," per
// the user's own call over a more faithful trail-sampled reconstruction.
const TEST_COMET_COUNT = 5;
const TEST_COMET_CLUSTER_RADIUS = 0.05;

function scatterPoint(): [number, number, number] {
  const dir = randomUnitVector3();
  const r = FIELD_MIN_RADIUS + Math.random() * (FIELD_MAX_RADIUS - FIELD_MIN_RADIUS);
  return [
    FIELD_CENTER[0] + dir.x * r,
    FIELD_CENTER[1] + dir.y * r,
    FIELD_CENTER[2] + dir.z * r,
  ];
}

function clusterOffset(): Vector3 {
  const dir = randomUnitVector3();
  return dir.multiplyScalar(Math.random() * TEST_COMET_CLUSTER_RADIUS);
}

function drawVariantLabel(ctx: CanvasRenderingContext2D, text: string): void {
  const w = LABEL_CANVAS_W;
  const h = LABEL_CANVAS_H;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(8, 8, 16, 0.82)';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, w - 4, h - 4);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 40px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2);
}

// A set of individually-billboarded (camera-facing, computed fresh every
// frame — unlike Points sprites, a Mesh plane doesn't auto-face the camera)
// Mesh instances, optionally bobbing gently up/down. Only ArtTestVfxSystem's
// two texture-based variants (soul-pebble ghosts, star illustration) need
// this — every other variant is fully static once built.
interface BillboardSet {
  group: Group;
  meshes: Mesh[];
  basePos: Vector3[];
  phase: Float32Array; // per-instance offset so bobbing/twinkling isn't in lockstep
  bobAmplitude: number; // 0 disables bobbing entirely
  bobFreq: number;
}

// One per variant (see TEST_COMET_COUNT's own comment) — `group` is
// positioned at the live hand each frame in _updateTestComet;
// `billboardMeshes` (a subset of group's descendants, may be empty) are the
// ones that also need re-facing the camera every frame, same idea as
// BillboardSet but relative to a moving parent instead of a fixed field.
interface TestComet {
  group: Group;
  billboardMeshes: Mesh[];
}

// Renders ArtTestSystem's currently-selected variant (see getVariant()) —
// every variant is built once here at init() (all of them at once, only one
// shown at a time via .visible, same "build everything once, toggle
// visibility" idiom ConstellationsVfxSystem uses for its 9 constellations)
// since none of this is simulated or interactive — it's a static side-by-
// side art comparison, not gameplay (two variants do animate in place —
// gentle bobbing/billboard-facing — see BillboardSet, but that's still not
// simulation state ArtTestSystem needs to know about). Director-managed
// (both this and ArtTestSystem live in definePhase(Phase.ArtTest, ...)) so
// nothing here exists/renders outside that dev-only phase.
export class ArtTestVfxSystem extends createSystem({
  hands: { required: [CometBody, HandAnchor] },
}) {
  private _artTest!: ArtTestSystem;
  private _variantGroups: Group[] = [];
  private _lastVariant = -1;

  // See TestComet's own comment.
  private _testComets: Group[] = [];
  private _testCometBillboardMeshes: Mesh[][] = [];
  private _scratchHandPos!: Vector3;
  private _scratchWorldPos!: Vector3;

  // Materials whose uTime uniform needs updating every frame for their own
  // built-in animation (sparkle twinkle, ghost wiggle) — collected as
  // they're built rather than hardcoded per variant.
  private _timeUniformMats: ShaderMaterial[] = [];

  private _labelCanvas!: HTMLCanvasElement;
  private _labelCtx!: CanvasRenderingContext2D;
  private _labelTexture!: CanvasTexture;
  private _labelMesh!: Mesh;

  // See BillboardSet's own comment — only the ghost-pebble and star-
  // illustration variants populate this.
  private _billboardSets: BillboardSet[] = [];
  private _camWorldPos!: Vector3;
  private _faceDir!: Vector3;
  private _zAxis!: Vector3;

  init(): void {
    this._artTest = this.world.getSystem(ArtTestSystem)!;
    this._camWorldPos = new Vector3();
    this._faceDir = new Vector3();
    this._zAxis = new Vector3(0, 0, 1);
    this._scratchHandPos = new Vector3();
    this._scratchWorldPos = new Vector3();

    this._variantGroups = [
      this._buildStardustCurrent(),
      this._buildPebblesCurrent(),
      this._buildPebblesBlackHaze(),
      this._buildSoulGhostBillboards(),
      this._buildStarIllustrationBillboards(),
      this._buildPebblesObjIslands(),
      this._buildPebblesGhostDecal(),
      this._buildMagicStardustSweep(),
    ];
    for (const group of this._variantGroups) {
      group.visible = false;
      this.world.createTransformEntity(group);
    }

    // Index-aligned with _variantGroups above — same order.
    const testComets: TestComet[] = [
      this._buildTestCometStardustCurrent(),
      this._buildTestCometPebblesCurrent(),
      this._buildTestCometPebblesBlackHaze(),
      this._buildTestCometGhostBillboard(),
      this._buildTestCometStarIllustration(),
      this._buildTestCometObjIslands(),
      this._buildTestCometGhostDecal(),
      this._buildTestCometMagicStardustSweep(),
    ];
    this._testComets = testComets.map((tc) => tc.group);
    this._testCometBillboardMeshes = testComets.map((tc) => tc.billboardMeshes);
    for (const comet of this._testComets) {
      comet.visible = false;
      this.world.createTransformEntity(comet);
    }

    this._buildLabel();
  }

  play(): void {
    super.play();
    this._lastVariant = -1; // force a visibility/label refresh on the first frame
    this._labelMesh.visible = true;
  }

  stop(): void {
    super.stop();
    for (const comet of this._testComets) comet.visible = false;
    for (const group of this._variantGroups) group.visible = false;
    this._labelMesh.visible = false;
  }

  update(_delta: number, time: number): void {
    for (const mat of this._timeUniformMats) mat.uniforms.uTime.value = time;
    this._updateBillboards(time);

    const variant = this._artTest.getVariant();
    if (variant !== this._lastVariant) {
      this._lastVariant = variant;
      for (let i = 0; i < this._variantGroups.length; i++) {
        this._variantGroups[i].visible = i === variant;
        this._testComets[i].visible = i === variant;
      }
      drawVariantLabel(this._labelCtx, `${variant + 1}/${this._variantGroups.length} — ${ART_TEST_VARIANT_LABELS[variant]}`);
      this._labelTexture.needsUpdate = true;
    }

    this._updateTestComet(variant);
  }

  // Tracks the current variant's test comet to the live hand position every
  // frame, and re-faces any of its billboarded pieces toward the camera —
  // same technique _updateBillboards uses for the static fields, just
  // relative to a moving parent (the test comet's own group, whose position
  // IS the live hand position) rather than a fixed world position.
  private _updateTestComet(variant: number): void {
    let handFound = false;
    for (const entity of this.queries.hands.entities) {
      const posView = entity.getVectorView(CometBody, 'position') as Float32Array;
      this._scratchHandPos.fromArray(posView);
      handFound = true;
      break; // exactly one comet entity, see comet-handoff-system.ts
    }
    if (!handFound) return;

    const comet = this._testComets[variant];
    comet.position.copy(this._scratchHandPos);

    const billboardMeshes = this._testCometBillboardMeshes[variant];
    if (billboardMeshes.length === 0) return;
    this.camera.getWorldPosition(this._camWorldPos);
    for (const mesh of billboardMeshes) {
      this._scratchWorldPos.copy(mesh.position).add(comet.position);
      this._faceDir.copy(this._camWorldPos).sub(this._scratchWorldPos).normalize();
      if (this._faceDir.lengthSq() > 0.0001) {
        mesh.quaternion.setFromUnitVectors(this._zAxis, this._faceDir);
      }
    }
  }

  // Bobs (if bobAmplitude > 0) and re-faces every mesh in every visible
  // BillboardSet toward the camera — skipped entirely for a hidden set, so
  // this only ever does real work for whichever billboard variant (if any)
  // is currently on screen.
  private _updateBillboards(time: number): void {
    let any = false;
    for (const set of this._billboardSets) {
      if (!set.group.visible) continue;
      any = true;
      break;
    }
    if (!any) return;

    this.camera.getWorldPosition(this._camWorldPos);
    for (const set of this._billboardSets) {
      if (!set.group.visible) continue;
      for (let i = 0; i < set.meshes.length; i++) {
        const mesh = set.meshes[i];
        if (set.bobAmplitude > 0) {
          const bob = Math.sin(time * set.bobFreq * Math.PI * 2 + set.phase[i]) * set.bobAmplitude;
          mesh.position.set(set.basePos[i].x, set.basePos[i].y + bob, set.basePos[i].z);
        }
        this._faceDir.copy(this._camWorldPos).sub(mesh.position).normalize();
        if (this._faceDir.lengthSq() > 0.0001) {
          mesh.quaternion.setFromUnitVectors(this._zAxis, this._faceDir);
        }
      }
    }
  }

  private _buildLabel(): void {
    this._labelCanvas = document.createElement('canvas');
    this._labelCanvas.width = LABEL_CANVAS_W;
    this._labelCanvas.height = LABEL_CANVAS_H;
    this._labelCtx = this._labelCanvas.getContext('2d')!;
    this._labelTexture = new CanvasTexture(this._labelCanvas);

    const mat = new MeshBasicMaterial({
      map: this._labelTexture,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    });
    this._labelMesh = new Mesh(new PlaneGeometry(LABEL_WIDTH, LABEL_HEIGHT), mat);
    this._labelMesh.visible = false;
    const entity = this.world.createTransformEntity(this._labelMesh);
    // View-locked above NotificationHudSystem's own spot so the two never
    // overlap.
    entity.addComponent(Follower, {
      target: this.player.head,
      offsetPosition: [0, 0.35, -0.6],
      behavior: FollowBehavior.FaceTarget,
      tolerance: 0.02,
      speed: 6,
      maxAngle: 10,
    });
  }

  // Used by variant 9's own placeholder/real-island buckets — builds one
  // InstancedMesh from a list of entries using the given geometry, with
  // random rotation and a radius*0.85-1.15 size variance per instance.
  // Plain black + white rim (BLACK_RIM_PALETTE, see _buildPebblesObjIslands)
  // — aTinted stays 0, no per-entry color. `radius` is a uniform multiplier
  // against the geometry's own natural unit scale — pass
  // OBJ_ISLANDS_PEBBLE_RADIUS directly for buildOrganicGeometry() (already
  // ~1-unit radius), or a computed fit scale for a geometry whose real-world
  // size isn't already known (see _buildPebblesObjIslands).
  private _buildTintedInstancedMesh(
    entries: { position: [number, number, number]; type: number }[],
    geo: BufferGeometry,
    material: ShaderMaterial,
    radius: number,
  ): InstancedMesh {
    const n = entries.length;
    geo.setAttribute('aBright', new InstancedBufferAttribute(new Float32Array(n).fill(0.7), 1));
    geo.setAttribute('aTint', new InstancedBufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('aTinted', new InstancedBufferAttribute(new Float32Array(n), 1));

    const mesh = new InstancedMesh(geo, material, n);
    const mat4 = new Matrix4();
    const quat = new Quaternion();
    const scale = new Vector3();
    const pos = new Vector3();
    const axis = new Vector3();
    for (let i = 0; i < n; i++) {
      const e = entries[i];
      pos.set(e.position[0], e.position[1], e.position[2]);
      axis.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
      quat.setFromAxisAngle(axis, Math.random() * Math.PI * 2);
      scale.setScalar(radius * (0.85 + Math.random() * 0.3));
      mat4.compose(pos, quat, scale);
      mesh.setMatrixAt(i, mat4);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    return mesh;
  }

  // Variant 1 — exact visual parity with StardustVfxSystem's own ambient
  // field: same color, same sparkle shader, just a static scatter instead
  // of a live gather simulation.
  private _buildStardustCurrent(): Group {
    const n = STARDUST_POINT_COUNT;
    const positions = new Float32Array(n * 3);
    const sizes = new Float32Array(n).fill(0.05);
    const bright = new Float32Array(n);
    const phase = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = scatterPoint();
      positions[i * 3] = p[0];
      positions[i * 3 + 1] = p[1];
      positions[i * 3 + 2] = p[2];
      bright[i] = 0.6 + Math.random() * 0.4;
      phase[i] = Math.random();
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(positions, 3));
    geo.setAttribute('aSize', new BufferAttribute(sizes, 1));
    geo.setAttribute('aBright', new BufferAttribute(bright, 1));
    geo.setAttribute('aPhase', new BufferAttribute(phase, 1));

    const mat = makeSparkleMaterial({ color: STARDUST_COLOR, blending: AdditiveBlending });
    this._timeUniformMats.push(mat);
    const points = new Points(geo, mat);
    points.frustumCulled = false;

    const group = new Group();
    group.add(points);
    return group;
  }

  // Shared across the pebble variants so they all place pebbles at the exact
  // same 90 spots (30 per PEBBLE_TYPES color) — a fair side-by-side
  // comparison of material/shape treatment, not layout.
  private _pebbleLayout(): { position: [number, number, number]; type: number }[] {
    const layout: { position: [number, number, number]; type: number }[] = [];
    for (let type = 0; type < PEBBLE_TYPES.length; type++) {
      for (let i = 0; i < PEBBLES_PER_TYPE; i++) {
        layout.push({ position: scatterPoint(), type });
      }
    }
    return layout;
  }

  // Variant 4 — the game's RGB pebble palette (blue/green/red), rendered
  // "more organic, minimal, dark, grainy/sparkly" (see
  // RGB_PEBBLE_PALETTE/makeToonRimInstancedGrainyMaterial) rather than the
  // real field's own bright saturated toon-rim look — a dedicated art-test
  // material, not kPebbleFieldTintedMat, so the production pebble field's
  // actual appearance is untouched.
  private _buildPebblesCurrent(): Group {
    const layout = this._pebbleLayout();
    const n = layout.length;
    const geo = buildOrganicGeometry();
    geo.setAttribute('aBright', new InstancedBufferAttribute(new Float32Array(n).fill(0.7), 1));
    const tintAttr = new InstancedBufferAttribute(new Float32Array(n * 3), 3);
    const tintedAttr = new InstancedBufferAttribute(new Float32Array(n).fill(1), 1);
    geo.setAttribute('aTint', tintAttr);
    geo.setAttribute('aTinted', tintedAttr);

    const grainyMat = makeToonRimInstancedGrainyMaterial(RGB_PEBBLE_PALETTE);
    this._timeUniformMats.push(grainyMat);
    const mesh = new InstancedMesh(geo, grainyMat, n);
    const mat4 = new Matrix4();
    const quat = new Quaternion();
    const scale = new Vector3();
    const pos = new Vector3();
    const axis = new Vector3();
    for (let i = 0; i < n; i++) {
      const t = layout[i];
      pos.set(t.position[0], t.position[1], t.position[2]);
      axis.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
      quat.setFromAxisAngle(axis, Math.random() * Math.PI * 2);
      scale.setScalar(PEBBLE_RADIUS * (0.85 + Math.random() * 0.3));
      mat4.compose(pos, quat, scale);
      mesh.setMatrixAt(i, mat4);
      const [r, g, b] = PEBBLE_TYPES[t.type].color;
      tintAttr.setXYZ(i, r, g, b);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;

    const group = new Group();
    group.add(mesh);
    return group;
  }

  // Variant 5 — the same rock shape/silhouette as variant 4, but the body
  // itself is near-black (a SEPARATE material instance from
  // kPebbleFieldTintedMat, with aTinted left at 0 so the tint blend never
  // kicks in — every instance is just its own flat dark body/light-mix,
  // no per-type recoloring). Color is communicated entirely by a second,
  // larger additive point-sprite "haze" layered at each pebble's position
  // in that pebble's own PEBBLE_TYPES color instead — one Points cloud per
  // color (point-sprite materials bake one fixed color per material, see
  // point-sprite-material.ts), so 3 clouds total.
  private _buildPebblesBlackHaze(): Group {
    const layout = this._pebbleLayout();
    const n = layout.length;

    const blackMat = makeToonRimInstancedTintedMaterial(BLACK_RIM_PALETTE);
    const geo = buildOrganicGeometry();
    geo.setAttribute('aBright', new InstancedBufferAttribute(new Float32Array(n).fill(0.7), 1));
    geo.setAttribute('aTint', new InstancedBufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('aTinted', new InstancedBufferAttribute(new Float32Array(n), 1)); // stays 0 — pure black body

    const bodyMesh = new InstancedMesh(geo, blackMat, n);
    const mat4 = new Matrix4();
    const quat = new Quaternion();
    const scale = new Vector3();
    const pos = new Vector3();
    const axis = new Vector3();
    for (let i = 0; i < n; i++) {
      const t = layout[i];
      pos.set(t.position[0], t.position[1], t.position[2]);
      axis.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
      quat.setFromAxisAngle(axis, Math.random() * Math.PI * 2);
      scale.setScalar(PEBBLE_RADIUS * (0.85 + Math.random() * 0.3));
      mat4.compose(pos, quat, scale);
      bodyMesh.setMatrixAt(i, mat4);
    }
    bodyMesh.instanceMatrix.needsUpdate = true;
    bodyMesh.frustumCulled = false;

    const group = new Group();
    group.add(bodyMesh);

    for (let type = 0; type < PEBBLE_TYPES.length; type++) {
      const typeLayout = layout.filter((t) => t.type === type);
      const hazePositions = new Float32Array(typeLayout.length * 3);
      const hazeSizes = new Float32Array(typeLayout.length).fill(HAZE_RADIUS);
      const hazeBright = new Float32Array(typeLayout.length).fill(0.8);
      for (let i = 0; i < typeLayout.length; i++) {
        hazePositions[i * 3] = typeLayout[i].position[0];
        hazePositions[i * 3 + 1] = typeLayout[i].position[1];
        hazePositions[i * 3 + 2] = typeLayout[i].position[2];
      }
      const hazeGeo = new BufferGeometry();
      hazeGeo.setAttribute('position', new BufferAttribute(hazePositions, 3));
      hazeGeo.setAttribute('aSize', new BufferAttribute(hazeSizes, 1));
      hazeGeo.setAttribute('aBright', new BufferAttribute(hazeBright, 1));
      const hazeMat = makePointSpriteMaterial({
        color: PEBBLE_TYPES[type].color,
        blending: AdditiveBlending,
        pointSizeFactor: 260,
      });
      const hazePoints = new Points(hazeGeo, hazeMat);
      hazePoints.frustumCulled = false;
      group.add(hazePoints);
    }

    return group;
  }

  // Rendered as camera-facing billboarded quads, scattered on their own
  // (GHOST_BILLBOARD_COUNT, in the same FIELD_CENTER volume every other
  // variant uses — not tied to the shared pebble layout, so its count can
  // change independently) and textured with one of the 4 real fabricghosts
  // PNGs (round-robin, so all 4 get roughly even use), gently bobbing
  // up/down — see BillboardSet/_updateBillboards. Stays fully transparent
  // (alpha from the PNG via the shader below) and runs through
  // makeGhostWiggleMaterial — a vertex-shader wave tapered so the sprite's
  // top stays anchored and its bottom billows, reading as ghost-sheet
  // motion. One shared material per texture (4 total, matching
  // FABRIC_GHOST_KEYS) — its uTime uniform is what _timeUniformMats drives.
  private _buildSoulGhostBillboards(): Group {
    const geo = new PlaneGeometry(GHOST_BILLBOARD_SIZE, GHOST_BILLBOARD_SIZE);
    const materials = FABRIC_GHOST_KEYS.map((key) => {
      const mat = makeGhostWiggleMaterial({
        texture: AssetManager.getTexture(key)!,
        amplitude: GHOST_WIGGLE_AMPLITUDE,
        frequency: GHOST_WIGGLE_FREQUENCY,
        speed: GHOST_WIGGLE_SPEED,
      });
      this._timeUniformMats.push(mat);
      return mat;
    });

    const group = new Group();
    const meshes: Mesh[] = [];
    const basePos: Vector3[] = [];
    const phase = new Float32Array(GHOST_BILLBOARD_COUNT);
    for (let i = 0; i < GHOST_BILLBOARD_COUNT; i++) {
      const mesh = new Mesh(geo, materials[i % materials.length]);
      const p = scatterPoint();
      mesh.position.set(p[0], p[1], p[2]);
      group.add(mesh);
      meshes.push(mesh);
      basePos.push(new Vector3(p[0], p[1], p[2]));
      phase[i] = Math.random() * Math.PI * 2;
    }

    this._billboardSets.push({
      group,
      meshes,
      basePos,
      phase,
      bobAmplitude: GHOST_BOB_AMPLITUDE,
      bobFreq: GHOST_BOB_FREQ,
    });
    return group;
  }

  // Variant 8 — same stardust scatter volume as variant 1, but each mote is
  // an individually camera-facing billboarded quad (see BillboardSet/
  // _updateBillboards) textured with the real starillustration.webp image,
  // through a shader that layers the same "generative sparkle" twinkle
  // modulation on top of it (see makeSparkleTexturedMaterial) rather than
  // drawing the procedural core+glint shape variant 1's Points use. One
  // shared material (one shader compile) across every instance; each
  // instance's own PlaneGeometry carries a fixed-per-quad aPhase value so
  // they don't all twinkle in lockstep. No bobbing — not asked for here,
  // unlike variant 7. Every other star also gets a soft additive point-
  // sprite halo behind it — see STAR_BLOOM_SIZE's own comment — built as
  // one shared Points cloud (not per-star) using the same makeSparkleMaterial
  // shader/color variant 1's field uses, so half the stars visibly bloom
  // and half stay flat, for a direct side-by-side within the one variant.
  private _buildStarIllustrationBillboards(): Group {
    const mat = makeSparkleTexturedMaterial({
      texture: AssetManager.getTexture(STAR_ILLUSTRATION_KEY)!,
      blending: AdditiveBlending,
    });
    this._timeUniformMats.push(mat);

    const group = new Group();
    const meshes: Mesh[] = [];
    const basePos: Vector3[] = [];
    const phase = new Float32Array(STAR_ILLUSTRATION_COUNT);
    const bloomPositions: [number, number, number][] = [];
    for (let i = 0; i < STAR_ILLUSTRATION_COUNT; i++) {
      const geo = new PlaneGeometry(STAR_ILLUSTRATION_SIZE, STAR_ILLUSTRATION_SIZE);
      const phaseValue = Math.random() * Math.PI * 2;
      geo.setAttribute('aPhase', new BufferAttribute(new Float32Array(4).fill(phaseValue), 1));

      const mesh = new Mesh(geo, mat);
      const p = scatterPoint();
      mesh.position.set(p[0], p[1], p[2]);
      group.add(mesh);
      meshes.push(mesh);
      basePos.push(new Vector3(p[0], p[1], p[2]));
      phase[i] = phaseValue;
      if (i % 2 === 0) bloomPositions.push(p);
    }

    // bobAmplitude 0 — _updateBillboards still re-faces every mesh toward
    // the camera each frame, just skips the position bob.
    this._billboardSets.push({ group, meshes, basePos, phase, bobAmplitude: 0, bobFreq: 0 });

    // The bloom halo — a single shared Points cloud (not billboarded
    // individually; point sprites are already inherently camera-facing) at
    // exactly the bloomPositions subset's own positions, rendered behind
    // the textured quads via additive blending so it reads as a soft glow
    // radiating from underneath them.
    const bloomN = bloomPositions.length;
    const bloomPosArr = new Float32Array(bloomN * 3);
    const bloomSize = new Float32Array(bloomN).fill(STAR_BLOOM_SIZE);
    const bloomBright = new Float32Array(bloomN);
    const bloomPhase = new Float32Array(bloomN);
    for (let i = 0; i < bloomN; i++) {
      bloomPosArr[i * 3] = bloomPositions[i][0];
      bloomPosArr[i * 3 + 1] = bloomPositions[i][1];
      bloomPosArr[i * 3 + 2] = bloomPositions[i][2];
      bloomBright[i] = 0.7 + Math.random() * 0.3;
      bloomPhase[i] = Math.random();
    }
    const bloomGeo = new BufferGeometry();
    bloomGeo.setAttribute('position', new BufferAttribute(bloomPosArr, 3));
    bloomGeo.setAttribute('aSize', new BufferAttribute(bloomSize, 1));
    bloomGeo.setAttribute('aBright', new BufferAttribute(bloomBright, 1));
    bloomGeo.setAttribute('aPhase', new BufferAttribute(bloomPhase, 1));
    const bloomMat = makeSparkleMaterial({ color: STARDUST_COLOR, blending: AdditiveBlending });
    this._timeUniformMats.push(bloomMat);
    const bloomPoints = new Points(bloomGeo, bloomMat);
    bloomPoints.frustumCulled = false;
    group.add(bloomPoints);

    return group;
  }

  // Variant 9 — every pebble slot (same shared 90-spot layout as 4/5/6)
  // randomly gets one of OBJ_ISLANDS_MAX_COUNT biggest disconnected mesh
  // pieces found inside the ghost OBJ's Layer_1/Layer_2 groups (see that
  // constant's own comment — no per-object tagging in the export, just
  // ~293 sculpted pieces merged into two groups). Same plain black + white
  // rim shader as the black + magical haze pebbles (BLACK_RIM_PALETTE),
  // no tint. Shows a black-rim organic-rock placeholder as variant 4 until
  // the extraction (a real async pass over tens of thousands of faces)
  // resolves, then rebuilds as one InstancedMesh per island shape actually
  // drawn this playthrough — random per-slot assignment, bucketed — each
  // auto-fit to OBJ_ISLANDS_PEBBLE_RADIUS via that island's own bounding
  // sphere (see loadObjLargestIslands).
  private _buildPebblesObjIslands(): Group {
    const layout = this._pebbleLayout();
    const group = new Group();
    const blackMat = makeToonRimInstancedTintedMaterial(BLACK_RIM_PALETTE);

    const placeholder = this._buildTintedInstancedMesh(
      layout,
      buildOrganicGeometry(),
      blackMat,
      OBJ_ISLANDS_PEBBLE_RADIUS,
    );
    group.add(placeholder);

    loadObjLargestIslands(GHOST_OBJ_URL, OBJ_ISLANDS_GROUPS, OBJ_ISLANDS_MAX_COUNT).then((islands) => {
      if (islands.length === 0) {
        console.warn(
          `[ArtTestVfxSystem] no mesh islands found under ${OBJ_ISLANDS_GROUPS.join('/')} in '${GHOST_OBJ_URL}' — keeping the placeholder pebble field.`,
        );
        return;
      }
      group.remove(placeholder);

      const assigned = layout.map(() => Math.floor(Math.random() * islands.length));
      for (let islandIdx = 0; islandIdx < islands.length; islandIdx++) {
        const bucket = layout.filter((_, i) => assigned[i] === islandIdx);
        if (bucket.length === 0) continue;
        const island = islands[islandIdx];
        const islandRadius = island.boundingSphere && island.boundingSphere.radius > 1e-6 ? island.boundingSphere.radius : 1;
        group.add(
          this._buildTintedInstancedMesh(bucket, island, blackMat, OBJ_ISLANDS_PEBBLE_RADIUS / islandRadius),
        );
      }
    });

    return group;
  }

  // Variant 10 — same shared 90-spot layout as 4/5/6/9 (type isn't used for
  // color here — every pebble is the same near-black body), each an
  // individual Mesh (own randomized rock shape + rotation, not instanced —
  // decal materials can't vary per-instance within one InstancedMesh draw)
  // with one of the 4 fabricghosts PNGs projected onto its front face via
  // makeToonRimAlphaDecalMaterial — round-robin, so only 4 materials total
  // are actually built and shared across the 90 meshes. "Front face" is
  // fixed in the pebble's own local space (a random per-pebble rotation),
  // not billboarded toward the camera — same as the comet head's own decal,
  // which is fixed to the body's local +X rather than turning to face the
  // player.
  private _buildPebblesGhostDecal(): Group {
    const layout = this._pebbleLayout();
    const materials = FABRIC_GHOST_KEYS.map((key) => {
      const mat = makeToonRimAlphaDecalMaterial({
        bodyColorDark: GHOST_DECAL_BODY_COLOR,
        bodyColorLight: GHOST_DECAL_BODY_COLOR,
        rimColor: [1, 1, 1],
      });
      mat.uniforms.uDecalTex.value = AssetManager.getTexture(key)!;
      return mat;
    });

    const group = new Group();
    const quat = new Quaternion();
    const axis = new Vector3();
    for (let i = 0; i < layout.length; i++) {
      const mesh = new Mesh(buildOrganicGeometry(), materials[i % materials.length]);
      const p = layout[i].position;
      mesh.position.set(p[0], p[1], p[2]);
      axis.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
      quat.setFromAxisAngle(axis, Math.random() * Math.PI * 2);
      mesh.quaternion.copy(quat);
      mesh.scale.setScalar(PEBBLE_RADIUS * GHOST_DECAL_PEBBLE_SCALE * (0.85 + Math.random() * 0.3));
      group.add(mesh);
    }
    return group;
  }

  // Variant 11 — see STREAK_COLOR's own comment. Two intertwined
  // spiral-into-sweep ribbons (slightly offset centers/turns/drift
  // directions so they don't perfectly overlap), each with its own fine-
  // grain sparkle halo scattered along its length and a handful of
  // descending drip columns hanging off its tail — the halo/drip point
  // clouds are pooled across both curves into one Points object apiece
  // (not one pair per curve) since nothing about them needs to be toggled
  // independently.
  private _buildMagicStardustSweep(): Group {
    const group = new Group();

    const curveDefs: SwooshCurveParams[] = [
      {
        center: [FIELD_CENTER[0] - 0.15, FIELD_CENTER[1] + 0.25, FIELD_CENTER[2]],
        startRadius: 0.5,
        turns: 2.6,
        dropHeight: 1.1,
        sweepLength: 1.3,
        driftDir: [0.9, -0.25, 0.15],
        wobble: 0.05,
      },
      {
        center: [FIELD_CENTER[0] + 0.1, FIELD_CENTER[1] + 0.05, FIELD_CENTER[2] - 0.1],
        startRadius: 0.35,
        turns: 1.9,
        dropHeight: 0.85,
        sweepLength: 1.5,
        driftDir: [-0.9, -0.3, 0.3],
        wobble: 0.04,
      },
    ];

    const ribbonMat = makeStreakRibbonMaterial({ color: STREAK_COLOR });
    this._timeUniformMats.push(ribbonMat);

    const haloPositions: number[] = [];
    const dripPositions: number[] = [];
    const dripBright: number[] = [];

    for (const def of curveDefs) {
      const curvePoints = sampleSwooshCurve(def, STREAK_SEGMENTS);
      const ribbonMesh = new Mesh(buildStreakRibbonGeometry(curvePoints, STREAK_MAX_WIDTH), ribbonMat);
      group.add(ribbonMesh);

      for (let i = 0; i < STREAK_HALO_COUNT; i++) {
        const p = curvePoints[Math.floor(Math.random() * curvePoints.length)];
        const off = randomUnitVector3().multiplyScalar(Math.random() * STREAK_HALO_JITTER);
        haloPositions.push(p.x + off.x, p.y + off.y, p.z + off.z);
      }

      // Anchored along the tail half of the curve, where it's swept out and
      // descending — that's where the reference image's drips hang from,
      // not off the tight opening loop.
      for (let c = 0; c < STREAK_DRIP_COLUMNS; c++) {
        const t = 0.5 + (c / (STREAK_DRIP_COLUMNS - 1)) * 0.48;
        const anchor = curvePoints[Math.floor(t * (curvePoints.length - 1))];
        for (let k = 0; k < STREAK_DRIP_LENGTH; k++) {
          const jx = (Math.random() * 2 - 1) * STREAK_DRIP_JITTER;
          const jz = (Math.random() * 2 - 1) * STREAK_DRIP_JITTER;
          dripPositions.push(
            anchor.x + jx,
            anchor.y - k * STREAK_DRIP_SPACING - Math.random() * STREAK_DRIP_SPACING * 0.4,
            anchor.z + jz,
          );
          dripBright.push(Math.max(0.05, 1 - k / STREAK_DRIP_LENGTH));
        }
      }
    }

    const haloN = haloPositions.length / 3;
    const haloBright = new Float32Array(haloN);
    const haloPhase = new Float32Array(haloN);
    for (let i = 0; i < haloN; i++) {
      haloBright[i] = 0.5 + Math.random() * 0.5;
      haloPhase[i] = Math.random();
    }
    const haloGeo = new BufferGeometry();
    haloGeo.setAttribute('position', new BufferAttribute(new Float32Array(haloPositions), 3));
    haloGeo.setAttribute('aSize', new BufferAttribute(new Float32Array(haloN).fill(STREAK_HALO_SIZE), 1));
    haloGeo.setAttribute('aBright', new BufferAttribute(haloBright, 1));
    haloGeo.setAttribute('aPhase', new BufferAttribute(haloPhase, 1));
    const haloMat = makeSparkleMaterial({ color: STREAK_COLOR, blending: AdditiveBlending });
    this._timeUniformMats.push(haloMat);
    const haloPoints = new Points(haloGeo, haloMat);
    haloPoints.frustumCulled = false;
    group.add(haloPoints);

    const dripN = dripPositions.length / 3;
    const dripPhase = new Float32Array(dripN);
    for (let i = 0; i < dripN; i++) dripPhase[i] = Math.random();
    const dripGeo = new BufferGeometry();
    dripGeo.setAttribute('position', new BufferAttribute(new Float32Array(dripPositions), 3));
    dripGeo.setAttribute('aSize', new BufferAttribute(new Float32Array(dripN).fill(STREAK_DRIP_SIZE), 1));
    dripGeo.setAttribute('aBright', new BufferAttribute(new Float32Array(dripBright), 1));
    dripGeo.setAttribute('aPhase', new BufferAttribute(dripPhase, 1));
    const dripMat = makeSparkleMaterial({ color: STREAK_COLOR, blending: AdditiveBlending });
    this._timeUniformMats.push(dripMat);
    const dripPoints = new Points(dripGeo, dripMat);
    dripPoints.frustumCulled = false;
    group.add(dripPoints);

    return group;
  }

  // ── Test comets — see TestComet's own comment. One small builder per
  // variant, each reusing that variant's exact material-construction
  // technique at TEST_COMET_COUNT scale instead of a full field scatter,
  // clustered around the origin (comet.position, set every frame in
  // _updateTestComet, supplies the actual world placement).

  private _buildTestCometStardustCurrent(): TestComet {
    const n = TEST_COMET_COUNT;
    const positions = new Float32Array(n * 3);
    const sizes = new Float32Array(n).fill(0.05);
    const bright = new Float32Array(n);
    const phase = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const o = clusterOffset();
      positions[i * 3] = o.x;
      positions[i * 3 + 1] = o.y;
      positions[i * 3 + 2] = o.z;
      bright[i] = 0.6 + Math.random() * 0.4;
      phase[i] = Math.random();
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(positions, 3));
    geo.setAttribute('aSize', new BufferAttribute(sizes, 1));
    geo.setAttribute('aBright', new BufferAttribute(bright, 1));
    geo.setAttribute('aPhase', new BufferAttribute(phase, 1));
    const mat = makeSparkleMaterial({ color: STARDUST_COLOR, blending: AdditiveBlending });
    this._timeUniformMats.push(mat);
    const points = new Points(geo, mat);
    points.frustumCulled = false;
    const group = new Group();
    group.add(points);
    return { group, billboardMeshes: [] };
  }

  private _buildTestCometPebblesCurrent(): TestComet {
    const n = TEST_COMET_COUNT;
    const geo = buildOrganicGeometry();
    geo.setAttribute('aBright', new InstancedBufferAttribute(new Float32Array(n).fill(0.7), 1));
    const tintAttr = new InstancedBufferAttribute(new Float32Array(n * 3), 3);
    geo.setAttribute('aTint', tintAttr);
    geo.setAttribute('aTinted', new InstancedBufferAttribute(new Float32Array(n).fill(1), 1));
    const grainyMat = makeToonRimInstancedGrainyMaterial(RGB_PEBBLE_PALETTE);
    this._timeUniformMats.push(grainyMat);
    const mesh = new InstancedMesh(geo, grainyMat, n);
    const mat4 = new Matrix4();
    const quat = new Quaternion();
    const scale = new Vector3();
    const axis = new Vector3();
    for (let i = 0; i < n; i++) {
      const o = clusterOffset();
      axis.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
      quat.setFromAxisAngle(axis, Math.random() * Math.PI * 2);
      scale.setScalar(PEBBLE_RADIUS * (0.85 + Math.random() * 0.3));
      mat4.compose(o, quat, scale);
      mesh.setMatrixAt(i, mat4);
      const [r, g, b] = PEBBLE_TYPES[i % PEBBLE_TYPES.length].color;
      tintAttr.setXYZ(i, r, g, b);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    const group = new Group();
    group.add(mesh);
    return { group, billboardMeshes: [] };
  }

  private _buildTestCometPebblesBlackHaze(): TestComet {
    const n = TEST_COMET_COUNT;
    const blackMat = makeToonRimInstancedTintedMaterial(BLACK_RIM_PALETTE);
    const geo = buildOrganicGeometry();
    geo.setAttribute('aBright', new InstancedBufferAttribute(new Float32Array(n).fill(0.7), 1));
    geo.setAttribute('aTint', new InstancedBufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('aTinted', new InstancedBufferAttribute(new Float32Array(n), 1));

    const bodyMesh = new InstancedMesh(geo, blackMat, n);
    const offsets: Vector3[] = [];
    const mat4 = new Matrix4();
    const quat = new Quaternion();
    const scale = new Vector3();
    const axis = new Vector3();
    for (let i = 0; i < n; i++) {
      const o = clusterOffset();
      offsets.push(o);
      axis.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
      quat.setFromAxisAngle(axis, Math.random() * Math.PI * 2);
      scale.setScalar(PEBBLE_RADIUS * (0.85 + Math.random() * 0.3));
      mat4.compose(o, quat, scale);
      bodyMesh.setMatrixAt(i, mat4);
    }
    bodyMesh.instanceMatrix.needsUpdate = true;
    bodyMesh.frustumCulled = false;

    const group = new Group();
    group.add(bodyMesh);

    const hazePositions = new Float32Array(n * 3);
    const hazeSizes = new Float32Array(n).fill(HAZE_RADIUS);
    const hazeBright = new Float32Array(n).fill(0.8);
    for (let i = 0; i < n; i++) {
      hazePositions[i * 3] = offsets[i].x;
      hazePositions[i * 3 + 1] = offsets[i].y;
      hazePositions[i * 3 + 2] = offsets[i].z;
    }
    const hazeGeo = new BufferGeometry();
    hazeGeo.setAttribute('position', new BufferAttribute(hazePositions, 3));
    hazeGeo.setAttribute('aSize', new BufferAttribute(hazeSizes, 1));
    hazeGeo.setAttribute('aBright', new BufferAttribute(hazeBright, 1));
    // One representative color (rather than 3 clouds for just 5 points) —
    // matches "one dominant color" the way a real post-Seeding comet reads.
    const hazeMat = makePointSpriteMaterial({
      color: PEBBLE_TYPES[0].color,
      blending: AdditiveBlending,
      pointSizeFactor: 260,
    });
    const hazePoints = new Points(hazeGeo, hazeMat);
    hazePoints.frustumCulled = false;
    group.add(hazePoints);
    return { group, billboardMeshes: [] };
  }

  private _buildTestCometGhostBillboard(): TestComet {
    const n = TEST_COMET_COUNT;
    const geo = new PlaneGeometry(GHOST_BILLBOARD_SIZE, GHOST_BILLBOARD_SIZE);
    const materials = FABRIC_GHOST_KEYS.map((key) => {
      const mat = makeGhostWiggleMaterial({
        texture: AssetManager.getTexture(key)!,
        amplitude: GHOST_WIGGLE_AMPLITUDE,
        frequency: GHOST_WIGGLE_FREQUENCY,
        speed: GHOST_WIGGLE_SPEED,
      });
      this._timeUniformMats.push(mat);
      return mat;
    });
    const group = new Group();
    const billboardMeshes: Mesh[] = [];
    for (let i = 0; i < n; i++) {
      const mesh = new Mesh(geo, materials[i % materials.length]);
      mesh.position.copy(clusterOffset());
      group.add(mesh);
      billboardMeshes.push(mesh);
    }
    return { group, billboardMeshes };
  }

  private _buildTestCometStarIllustration(): TestComet {
    const n = TEST_COMET_COUNT;
    const mat = makeSparkleTexturedMaterial({
      texture: AssetManager.getTexture(STAR_ILLUSTRATION_KEY)!,
      blending: AdditiveBlending,
    });
    this._timeUniformMats.push(mat);
    const group = new Group();
    const billboardMeshes: Mesh[] = [];
    for (let i = 0; i < n; i++) {
      const geo = new PlaneGeometry(STAR_ILLUSTRATION_SIZE, STAR_ILLUSTRATION_SIZE);
      const phaseValue = Math.random() * Math.PI * 2;
      geo.setAttribute('aPhase', new BufferAttribute(new Float32Array(4).fill(phaseValue), 1));
      const mesh = new Mesh(geo, mat);
      mesh.position.copy(clusterOffset());
      group.add(mesh);
      billboardMeshes.push(mesh);
    }
    return { group, billboardMeshes };
  }

  // Placeholder (black + white rim rock) until the real islands resolve,
  // exactly like the field variant — then swapped to one randomly-picked
  // island's real geometry, auto-fit to OBJ_ISLANDS_PEBBLE_RADIUS via its
  // own bounding sphere. Same BLACK_RIM_PALETTE shader as
  // _buildPebblesObjIslands, no tint.
  private _buildTestCometObjIslands(): TestComet {
    const n = TEST_COMET_COUNT;
    const group = new Group();
    const blackMat = makeToonRimInstancedTintedMaterial(BLACK_RIM_PALETTE);

    const buildMesh = (geo: BufferGeometry, radiusMultiplier: number): InstancedMesh => {
      geo.setAttribute('aBright', new InstancedBufferAttribute(new Float32Array(n).fill(0.7), 1));
      geo.setAttribute('aTint', new InstancedBufferAttribute(new Float32Array(n * 3), 3));
      geo.setAttribute('aTinted', new InstancedBufferAttribute(new Float32Array(n), 1));
      const mesh = new InstancedMesh(geo, blackMat, n);
      const mat4 = new Matrix4();
      const quat = new Quaternion();
      const scale = new Vector3();
      const axis = new Vector3();
      for (let i = 0; i < n; i++) {
        const o = clusterOffset();
        axis.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
        quat.setFromAxisAngle(axis, Math.random() * Math.PI * 2);
        scale.setScalar(OBJ_ISLANDS_PEBBLE_RADIUS * radiusMultiplier * (0.85 + Math.random() * 0.3));
        mat4.compose(o, quat, scale);
        mesh.setMatrixAt(i, mat4);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.frustumCulled = false;
      return mesh;
    };

    const placeholder = buildMesh(buildOrganicGeometry(), 1);
    group.add(placeholder);

    loadObjLargestIslands(GHOST_OBJ_URL, OBJ_ISLANDS_GROUPS, OBJ_ISLANDS_MAX_COUNT).then((islands) => {
      if (islands.length === 0) return;
      group.remove(placeholder);
      const island = islands[Math.floor(Math.random() * islands.length)];
      const islandRadius = island.boundingSphere && island.boundingSphere.radius > 1e-6 ? island.boundingSphere.radius : 1;
      group.add(buildMesh(island, 1 / islandRadius));
    });

    return { group, billboardMeshes: [] };
  }

  private _buildTestCometGhostDecal(): TestComet {
    const n = TEST_COMET_COUNT;
    const materials = FABRIC_GHOST_KEYS.map((key) => {
      const mat = makeToonRimAlphaDecalMaterial({
        bodyColorDark: GHOST_DECAL_BODY_COLOR,
        bodyColorLight: GHOST_DECAL_BODY_COLOR,
        rimColor: [1, 1, 1],
      });
      mat.uniforms.uDecalTex.value = AssetManager.getTexture(key)!;
      return mat;
    });
    const group = new Group();
    const quat = new Quaternion();
    const axis = new Vector3();
    for (let i = 0; i < n; i++) {
      const mesh = new Mesh(buildOrganicGeometry(), materials[i % materials.length]);
      mesh.position.copy(clusterOffset());
      axis.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
      quat.setFromAxisAngle(axis, Math.random() * Math.PI * 2);
      mesh.quaternion.copy(quat);
      mesh.scale.setScalar(PEBBLE_RADIUS * GHOST_DECAL_PEBBLE_SCALE * (0.85 + Math.random() * 0.3));
      group.add(mesh);
    }
    return { group, billboardMeshes: [] };
  }

  // A single small spiral-into-sweep ribbon (same technique as the field
  // variant, scaled way down) wound tightly around the origin — comet.
  // position (set every frame in _updateTestComet) supplies the actual
  // world placement — with a smaller fine-grain halo and no drip columns
  // (there's no "tail half far from the loop" at this scale for them to
  // meaningfully hang off of).
  private _buildTestCometMagicStardustSweep(): TestComet {
    const def: SwooshCurveParams = {
      center: [0, 0.02, 0],
      startRadius: 0.05,
      turns: 2.2,
      dropHeight: 0.09,
      sweepLength: 0.1,
      driftDir: [0.9, -0.3, 0.2],
      wobble: 0.006,
    };
    const curvePoints = sampleSwooshCurve(def, 60);
    const ribbonMat = makeStreakRibbonMaterial({ color: STREAK_COLOR });
    this._timeUniformMats.push(ribbonMat);
    const group = new Group();
    group.add(new Mesh(buildStreakRibbonGeometry(curvePoints, STREAK_MAX_WIDTH * 0.3), ribbonMat));

    const haloCount = 60;
    const haloPositions = new Float32Array(haloCount * 3);
    const haloBright = new Float32Array(haloCount);
    const haloPhase = new Float32Array(haloCount);
    for (let i = 0; i < haloCount; i++) {
      const p = curvePoints[Math.floor(Math.random() * curvePoints.length)];
      const off = randomUnitVector3().multiplyScalar(Math.random() * STREAK_HALO_JITTER * 0.3);
      haloPositions[i * 3] = p.x + off.x;
      haloPositions[i * 3 + 1] = p.y + off.y;
      haloPositions[i * 3 + 2] = p.z + off.z;
      haloBright[i] = 0.5 + Math.random() * 0.5;
      haloPhase[i] = Math.random();
    }
    const haloGeo = new BufferGeometry();
    haloGeo.setAttribute('position', new BufferAttribute(haloPositions, 3));
    haloGeo.setAttribute('aSize', new BufferAttribute(new Float32Array(haloCount).fill(STREAK_HALO_SIZE * 0.6), 1));
    haloGeo.setAttribute('aBright', new BufferAttribute(haloBright, 1));
    haloGeo.setAttribute('aPhase', new BufferAttribute(haloPhase, 1));
    const haloMat = makeSparkleMaterial({ color: STREAK_COLOR, blending: AdditiveBlending });
    this._timeUniformMats.push(haloMat);
    const haloPoints = new Points(haloGeo, haloMat);
    haloPoints.frustumCulled = false;
    group.add(haloPoints);

    return { group, billboardMeshes: [] };
  }
}
