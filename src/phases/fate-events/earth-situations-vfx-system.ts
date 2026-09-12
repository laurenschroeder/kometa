import {
  AnimationMixer,
  AssetManager,
  AudioListener,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Entity,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  LoopRepeat,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  createSystem,
  Vector3,
} from '@iwsdk/core';
import { CometBody } from '../../comet/comet-body-component.js';
import { getGlobals } from '../../core/globals.js';
import { Phase } from '../../core/phase.js';
import { playPayoffChime } from '../../vfx/audio/payoff-chime.js';
import { buildBlueGreenPalette } from '../../vfx/color/blue-green-palette.js';
import { buildOrganicGeometry } from '../../vfx/geometry/organic-rock-geometry.js';
import { buildPlaceholderPerson, PERSON_HEIGHT } from '../../vfx/geometry/placeholder-person.js';
import { scatterOnSphereCap } from '../../vfx/geometry/sphere-scatter.js';
import { kOrganicGlitterMat } from '../../vfx/shaders/pebble-material.js';
import { makeToonRimFlatMaterial } from '../../vfx/shaders/toon-rim-material.js';
import { CrownRise } from '../../vfx/particles/crown-rise.js';
import { ConstellationsSystem } from '../constellations/constellations-system.js';
import { FATE_DIALOGUE } from '../../core/notification-copy.js';
import { CROWD_CAP_DIRECTION, FateBeat, FateEventSystem } from './fate-event-system.js';
import { PebbleCometPresentationSystem } from '../pebbles/pebble-comet-presentation-system.js';
import { PEBBLE_TYPES } from '../pebbles/pebble-type.js';
import { PlanetSeedingVfxSystem } from '../planet-seeding/planet-seeding-vfx-system.js';

const DOG_COUNT = 4;
const MACHINE_COUNT = 4;
const VOLATILE_GASSES_TYPE = 2;
const ORGANIC_MATTER_TYPE = 1;

// Wider than FateEventSystem's own 34° people cap so decorations spread a
// bit around/among the crowd instead of exactly overlapping it.
const CAP_HALF_ANGLE = (40 * Math.PI) / 180;
const SURFACE_OFFSET = 0.01;

const STAGGER_WINDOW = 0.3; // same idiom/purpose as FateEventVfxSystem's own person stagger
const REVEAL_EASE_RATE = 3; // 1/s exponential ease toward the staggered target scale

const DOG_COLOR: [number, number, number] = [0.5, 0.35, 0.2];
const MACHINE_COLOR = new Color(0.5, 0.52, 0.58);
const KING_COLOR: [number, number, number] = [0.75, 0.62, 0.85];
const CROWN_COLOR = new Color(1.0, 0.85, 0.2);
const TOWER_COLOR = new Color(0.45, 0.43, 0.4);
const GRAVE_COLOR = new Color(0.4, 0.4, 0.42);

// Halved from 0.35/0.018/0.032/1.5 — the king+tower was reading too large
// against the rest of the crowd/decorations once it actually showed up.
const TOWER_HEIGHT = 0.175;
const TOWER_RADIUS_TOP = 0.009;
const TOWER_RADIUS_BOTTOM = 0.016;
const KING_SCALE = 0.75;

// Crown constellation only (see _updateTowerHeight): the tower starts a
// sliver tall (not literally 0 — a zero-height cylinder reads as broken/
// flickery) and grows toward full height as the player traces each of the
// constellation's stars, reaching full height right as the last star
// completes — just ahead of the Gas Ambient vignette's own death beat.
const TOWER_MIN_HEIGHT_FRACTION = 0.12;
const TOWER_GROWTH_EASE_RATE = 2.5; // 1/s exponential ease toward the live target

// Gas's Beat 2.5 (Ambient) vignette — the king's death used to fire the
// instant the Crown constellation completed (during Constellations, well
// before Fate Events even began); it now waits for FateEventSystem's own
// Ambient beat and plays across three timed sub-beats summing to
// AMBIENT_BEAT_SECONDS (10s, see fate-event-system.ts): 0-3s the crowd holds
// a watching/waving pose (see fate-event-vfx-system.ts's own
// _updateGasWatchPose), 3-8s the king topples and his ghost rises (this
// file), 8-10s the crowd turns to face the player (also fate-event-vfx-
// system.ts). GAS_DEATH_START/DURATION below are this file's own slice of
// that timeline.
const GAS_DEATH_START_SECONDS = 3;
const KING_COLLAPSE_DURATION = 3.5; // stretched from the old immediate-trigger 1.6s to fill the 5s death sub-beat
const KING_TOPPLE_ANGLE = (100 * Math.PI) / 180; // past horizontal, reads as a genuine fall

// Soul's Beat 2.5 graveyard — grave markers + one seated, idly-bobbing bench
// figure watching a grave, positioned from FateEventSystem's own canonical
// graveyard layout (see getGraveyardNormals) so the static dressing here and
// Beat 4's actual ghost collectibles (fate-event-vfx-system.ts) land on the
// same spots instead of two independent scatters.
const GRAVE_WIDTH = 0.03;
const GRAVE_HEIGHT = 0.045;
const GRAVE_DEPTH = 0.012;
const BENCH_SCALE = 0.7;

// "Explorable" organic scene — lots of small plant/animal decorations, same
// shared instanced material the organic pebbles use (kOrganicGlitterMat),
// each with a small continuous idle animation (sway for plants, bob for
// animals). Built as InstancedMesh per shape variant (same architecture
// PebbleCometPresentationSystem uses for its own organic pebbles) rather
// than this file's older per-Group-Mesh DecorationSet pattern below, since
// kOrganicGlitterMat needs per-instance aBright/aTint/aTinted attributes an
// individually-scattered Mesh can't provide.
const ORGANIC_DECORATION_COUNT = 28;
const N_ORGANIC_DECORATION_VARIANTS = 4; // variants 0-1 = plant, 2-3 = animal
const ORGANIC_MIN_SCALE = 0.02;
const ORGANIC_MAX_SCALE = 0.04;
const ORGANIC_SWAY_FREQ = 0.9; // Hz, plant variants
const ORGANIC_SWAY_AMPLITUDE = 0.18; // radians
const ORGANIC_BOB_FREQ = 1.6; // Hz, animal variants
const ORGANIC_BOB_AMPLITUDE = 0.01; // meters, along the surface normal

// A couple of real (Quill-authored) bee models hovering over the organic
// scene — everything else in this file is placeholder procedural geometry,
// but this asset was small enough (276 verts) to use directly. Deliberately
// just a small fixed count, not scattered/instanced like ORGANIC_DECORATION_
// COUNT above: each bee is its own Mesh with baked-morph-target wing-flap
// animation (glTF export of Quill's vertex-cache bake, no skeleton), which
// can't ride InstancedMesh the way the procedural decorations do — every
// extra copy is a full extra draw call + its own per-vertex morph-blend
// cost, so this stays a small flourish, not a swarm.
const BEE_COUNT = 2;
// The source model's raw bounding box is ~0.58 x 0.43 x 0.79 units (Quill's
// own scene scale, unrelated to this game's meters) — this scales its
// longest axis down to roughly 3cm, in line with the organic decorations'
// own ORGANIC_MIN_SCALE/MAX_SCALE range.
const BEE_MODEL_SCALE = 0.045;
const BEE_ORBIT_RADIUS = 0.06;
const BEE_ORBIT_SPEED = 0.8; // rad/s
const BEE_HOVER_HEIGHT = 0.05; // above the organic decorations' own surface reach

// Beat 5 (Payoff) — Organic's "seeds blossom into their plants" is a
// staggered scale-overshoot pulse layered on top of the organic scene's own
// reveal scale (not a replacement for it), same smoothstep-envelope idiom
// used everywhere else in this file.
const BLOSSOM_STAGGER_SPAN = 2.5; // seconds across which each plant's own pulse starts, staggered by index
const BLOSSOM_PULSE_DURATION = 1.2; // seconds, one instance's own rise-and-settle
const BLOSSOM_SCALE_BUMP = 0.6; // peak fractional size increase mid-pulse

// Beat 5 — Gas's "SKULL = COMET" banner rises from just above the tower and
// holds. Simple canvas-texture billboard, same construction idiom as
// FateEventVfxSystem's own speech bubbles/fire quads — not PanelUI, which is
// for interactive panels, the wrong tool for a static in-world graphic.
const BANNER_WIDTH = 0.3;
const BANNER_HEIGHT = 0.09;
const BANNER_RISE_DURATION = 4;
const BANNER_CANVAS_W = 512;
const BANNER_CANVAS_H = 160;
// "SKULL = mini comet" — the comet half is a small drawn glyph (bright core
// + trailing red-dust specks), not text, so it actually reads as the thing
// blamed for the king's death rather than a literal word.
const BANNER_COMET_TAIL_SPECKS = 10;

// Same phase-eligibility guard idiom used throughout this phase (see
// PLANET_ARRIVAL_ELIGIBLE_FROM/SPIN_ELIGIBLE_FROM in fate-event-vfx-system.ts)
// — this system's own update() runs from world boot, so reading
// getSpinProgress() before Leg A has ever started would misread "never
// started" as "already at 0" instead of just staying gated off.
const SITUATION_ELIGIBLE_FROM = new Set<Phase>([
  Phase.Constellations,
  Phase.FateEvents,
  Phase.Launch,
  Phase.Finale,
]);

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}
function smoothstep(t: number): number {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
}

interface DecorationSet {
  groups: Group[];
  normals: Float32Array;
  scale: Float32Array;
}

function buildDecorationSet(count: number, buildOne: () => Group): DecorationSet {
  const { normals } = scatterOnSphereCap(count, ORIGIN, 1, CROWD_CAP_DIRECTION, CAP_HALF_ANGLE);
  return buildDecorationSetFromNormals(normals, buildOne);
}

// Same shape as buildDecorationSet above, but takes an already-computed unit
// normals array instead of generating its own scatter — used for the
// graveyard, whose positions must match FateEventSystem's own canonical
// layout (see getGraveyardNormals) rather than an independent one.
function buildDecorationSetFromNormals(normals: Float32Array, buildOne: () => Group): DecorationSet {
  const count = normals.length / 3;
  const groups: Group[] = [];
  for (let i = 0; i < count; i++) {
    const group = buildOne();
    group.scale.setScalar(0);
    group.visible = false;
    groups.push(group);
  }
  return { groups, normals, scale: new Float32Array(count) };
}

interface OrganicScene {
  meshes: InstancedMesh[];
  variantOf: Uint8Array; // ORGANIC_DECORATION_COUNT — which mesh
  localOf: Uint16Array; // instance index within that mesh
  isAnimal: Uint8Array; // 0 = plant (sway), 1 = animal (bob)
  normals: Float32Array; // ORGANIC_DECORATION_COUNT*3, fixed forever
  baseScale: Float32Array; // ORGANIC_DECORATION_COUNT*3, non-uniform per-decoration scale
  phase: Float32Array; // ORGANIC_DECORATION_COUNT, idle-anim phase offset
  scale: Float32Array; // ORGANIC_DECORATION_COUNT, current staggered-reveal scale [0,1]
}

const ORIGIN = new Vector3(0, 0, 0);

// Per-constellation "situation on Earth" — ambient decorations that build in
// on the planet during Leg A's spin (same window FateEventVfxSystem's own
// people progressively appear in, driven by the same
// PlanetSeedingVfxSystem.getSpinProgress()), plus each name's one-shot
// completion payoff (see ConstellationsSystem.isComplete()'s edge below) and
// Fate Events' own beat-gated vignettes (Gas's king death, Beat 5's
// per-type payoff — see FateEventSystem.getBeat()). Dispatch is keyed off
// ConstellationsSystem.getActiveName() (available from spin-start, unlike
// globals.celestialSymbol which only resolves once traced). Always-on and
// self-gated via gamePhase, never GameDirector-managed — the Dog/Crown
// mechanics persist a permanent comet attachment/state straight through Fate
// Events/Launch/Finale, so this can't be phase-gated the way FateEventSystem's
// own simulation is. All geometry here is a simple placeholder pass, swapped
// for real 3D assets later.
export class EarthSituationsVfxSystem extends createSystem({
  // CometBody only (no HandAnchor) — the crown must keep tracking the comet
  // straight through Orbital Launch's detach, which strips HandAnchor from
  // the entity the instant it flies off on its own (see
  // orbital-launch-system.ts/comet-autopilot-system.ts). Requiring
  // HandAnchor here made the crown freeze in place the moment the player
  // launched, since the entity silently stopped matching this query.
  comets: { required: [CometBody] },
}) {
  private _constellations!: ConstellationsSystem;
  private _planetSeeding!: PlanetSeedingVfxSystem;
  private _fateEvents!: FateEventSystem;
  private _pebbleComet!: PebbleCometPresentationSystem;

  private _dogs!: DecorationSet;
  private _organicScene!: OrganicScene;
  // See BEE_COUNT's own comment — a couple of real animated models, not
  // part of OrganicScene's InstancedMesh/procedural setup.
  private _bees: { root: Group; mixer: AnimationMixer; angleOffset: number }[] = [];
  // Orthonormal basis around CROWD_CAP_DIRECTION, computed once in
  // _buildBees() — the plane the bees' small hover-circle is drawn in.
  private _beeTangentA = new Vector3();
  private _beeTangentB = new Vector3();
  private _machines!: DecorationSet;
  private _king!: DecorationSet;
  private _kingBody!: Group; // the king's own figure, hidden separately once he dies
  private _towerMesh!: Mesh; // the King set's own tower — grows with trace progress, see _updateTowerHeight
  // Current eased 0-1 tower-height fraction — starts (and resets) at
  // TOWER_MIN_HEIGHT_FRACTION, eases toward however many of the Crown
  // constellation's stars are currently traced, independent of the King
  // set's own pop-in reveal (_updateSet's group-level scale) — the two
  // compose rather than conflict.
  private _towerHeightFraction = 0;
  private _graveyard!: DecorationSet;
  private _graveyardBench!: DecorationSet;

  // "What happens" beat between the king's Ambient-beat death trigger and
  // his ghost actually rising — see KING_COLLAPSE_DURATION's comment. Null
  // when idle.
  private _pendingCollapse: { kind: 'king'; elapsed: number } | null = null;
  // One-shot guard — Gas's death vignette fires once per play() the instant
  // FateEventSystem's Ambient beat crosses GAS_DEATH_START_SECONDS.
  private _gasVignetteTriggered = false;

  // Universal payoff (see crown-rise.ts's own class comment) — plays on
  // EVERY constellation completion, in addition to whichever name-specific
  // special case (Dog soul-pack) also fires from the same isComplete() edge
  // below.
  private _crown!: CrownRise;
  private _crownWasAttached = false;
  private _audioListener!: AudioListener;

  // Beat 5 (Payoff) — one-shot guard + per-type state. Organic's blossom
  // pulse is folded into _updateOrganicScene (see BLOSSOM_* constants);
  // Gas's banner rises via _bannerMesh below. Soul's own payoff (ghosts
  // dancing in the tail) lives in fate-event-vfx-system.ts, which owns that
  // rendering — this system only needs to know payoff started, for the
  // shared chime.
  private _payoffTriggered = false;
  private _payoffElapsed = 0;
  private _bannerMesh!: Mesh;
  private _bannerEndY = 0;

  private _wasComplete = false;
  private _cometEntity: Entity | null = null;

  private _upAxis = new Vector3(0, 1, 0);
  private _scratchNormal = new Vector3();
  private _scratchCenter = new Vector3();
  private _scratchGhostOrigin = new Vector3();
  private _scratchCrownOrigin = new Vector3();
  private _scratchCometPos = new Vector3();
  private _scratchOrganicPos = new Vector3();
  private _scratchOrganicScale = new Vector3();
  private _scratchOrganicQuat = new Quaternion();
  private _scratchBeePos = new Vector3();
  private _scratchBeeLookAt = new Vector3();
  private _scratchSwayQuat = new Quaternion();
  private _scratchMat4 = new Matrix4();
  private _scratchBannerPos = new Vector3();
  private _scratchBannerFace = new Vector3();
  private _zAxis = new Vector3(0, 0, 1);

  init(): void {
    // PlanetSeedingVfxSystem/ConstellationsSystem/FateEventSystem/
    // PebbleCometPresentationSystem must be registered before this system
    // (see index.ts) so they already exist when this init() runs.
    this._constellations = this.world.getSystem(ConstellationsSystem)!;
    this._planetSeeding = this.world.getSystem(PlanetSeedingVfxSystem)!;
    this._fateEvents = this.world.getSystem(FateEventSystem)!;
    this._pebbleComet = this.world.getSystem(PebbleCometPresentationSystem)!;

    this._buildDogs();
    this._buildOrganicScene();
    this._buildBees();
    this._buildMachines();
    this._buildKingTower();
    this._buildGraveyardScene();

    // Own AudioListener, same reason every other generative-audio VFX
    // system here has one (IWSDK's AudioSource/AudioUtils layer is
    // buffer-only). Passed into CrownRise, which owns its own ascension/
    // settle sounds since they're entirely driven by its own state machine,
    // and reused directly for Beat 5's shared payoff chime.
    this._audioListener = new AudioListener();
    this.player.head.add(this._audioListener);

    this._crown = new CrownRise();
    this._crown.build(this.world, this._audioListener, this.scene);
    this._buildBanner();

    this.cleanupFuncs.push(
      getGlobals(this.world).gamePhase.subscribe((phase) => {
        // Also reset on entering Constellations itself, not just Stardust —
        // a normal full loop already resets via Stardust well before this
        // fires again, so that's redundant there, but a debug-menu jump
        // straight to Constellations (skipping Stardust/Pebbles/Seeding
        // entirely — see phase-menu-system.ts) would otherwise leave the
        // PREVIOUS test's crown stuck in its Attached state; since
        // CrownRise.trigger() no-ops unless idle, no new crown would ever
        // rise on that test's own completion. Constellations' own entry is
        // always the correct "fresh attempt starting" moment regardless of
        // which phase was active before it.
        if (phase === Phase.Stardust || phase === Phase.Constellations) this._resetAll();
      }),
    );
  }

  private _registerSet(set: DecorationSet): void {
    for (const group of set.groups) this.world.createTransformEntity(group);
  }

  private _buildDogs(): void {
    const material = makeToonRimFlatMaterial(DOG_COLOR);
    this._dogs = buildDecorationSet(DOG_COUNT, () => {
      const group = new Group();
      const mesh = new Mesh(buildOrganicGeometry(), material);
      mesh.scale.set(1.5, 0.85, 2.1);
      mesh.scale.multiplyScalar(0.035);
      group.add(mesh);
      return group;
    });
    this._registerSet(this._dogs);
  }

  private _buildOrganicScene(): void {
    const n = ORGANIC_DECORATION_COUNT;
    const { normals } = scatterOnSphereCap(n, ORIGIN, 1, CROWD_CAP_DIRECTION, CAP_HALF_ANGLE);
    const variantOf = new Uint8Array(n);
    const localOf = new Uint16Array(n);
    const isAnimal = new Uint8Array(n);
    const baseScale = new Float32Array(n * 3);
    const phase = new Float32Array(n);
    const bucketCounts = new Array<number>(N_ORGANIC_DECORATION_VARIANTS).fill(0);

    for (let i = 0; i < n; i++) {
      const variant = i % N_ORGANIC_DECORATION_VARIANTS;
      variantOf[i] = variant;
      localOf[i] = bucketCounts[variant]++;
      const animal = variant >= N_ORGANIC_DECORATION_VARIANTS / 2 ? 1 : 0;
      isAnimal[i] = animal;
      phase[i] = Math.random() * Math.PI * 2;
      const s = ORGANIC_MIN_SCALE + Math.random() * (ORGANIC_MAX_SCALE - ORGANIC_MIN_SCALE);
      if (animal) {
        // Elongated silhouette from the same rock generator — same
        // non-uniform-scale trick _buildDogs uses to fake a different
        // shape without a different geometry function.
        baseScale[i * 3] = s * 1.4;
        baseScale[i * 3 + 1] = s * 0.8;
        baseScale[i * 3 + 2] = s * 1.9;
      } else {
        baseScale[i * 3] = s;
        baseScale[i * 3 + 1] = s * 1.3; // plants read a bit taller than wide
        baseScale[i * 3 + 2] = s;
      }
    }

    const meshes: InstancedMesh[] = [];
    const palette = buildBlueGreenPalette();
    for (let v = 0; v < N_ORGANIC_DECORATION_VARIANTS; v++) {
      const count = bucketCounts[v];
      const isAnimalVariant = v >= N_ORGANIC_DECORATION_VARIANTS / 2;
      const geo = buildOrganicGeometry(isAnimalVariant ? { ampMin: 0.03, ampMax: 0.06 } : {});
      geo.setAttribute('aBright', new InstancedBufferAttribute(new Float32Array(count).fill(0.7), 1));
      geo.setAttribute('aTint', new InstancedBufferAttribute(new Float32Array(count * 3), 3));
      geo.setAttribute('aTinted', new InstancedBufferAttribute(new Float32Array(count).fill(1), 1));
      const mesh = new InstancedMesh(geo, kOrganicGlitterMat, count);
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.frustumCulled = false;
      this.world.createTransformEntity(mesh);
      meshes.push(mesh);
    }
    for (let i = 0; i < n; i++) {
      const [r, g, b] = palette[Math.floor(Math.random() * palette.length)];
      const tintAttr = meshes[variantOf[i]].geometry.getAttribute('aTint') as InstancedBufferAttribute;
      tintAttr.setXYZ(localOf[i], r, g, b);
    }
    for (const mesh of meshes) (mesh.geometry.getAttribute('aTint') as InstancedBufferAttribute).needsUpdate = true;

    this._organicScene = { meshes, variantOf, localOf, isAnimal, normals, baseScale, phase, scale: new Float32Array(n) };
  }

  // See BEE_COUNT's own comment. AssetManager.getGLTF() clones the Object3D
  // graph fresh per call (geometry/materials/animations stay shared per its
  // own doc comment), so each bee gets its own scene graph + AnimationMixer
  // but no duplicated GPU buffer data between the two copies.
  private _buildBees(): void {
    // Orthonormal basis around CROWD_CAP_DIRECTION — picks whichever of
    // world-up/world-right isn't nearly parallel to it as the seed for the
    // cross products, so this stays correct even if CROWD_CAP_DIRECTION
    // itself ever changes from its current (0,1,0).
    const arbitrary = Math.abs(CROWD_CAP_DIRECTION.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
    this._beeTangentA.crossVectors(CROWD_CAP_DIRECTION, arbitrary).normalize();
    this._beeTangentB.crossVectors(CROWD_CAP_DIRECTION, this._beeTangentA).normalize();

    for (let i = 0; i < BEE_COUNT; i++) {
      const gltf = AssetManager.getGLTF('beeFlying');
      if (!gltf) continue;
      const root = gltf.scene as Group;
      root.scale.setScalar(BEE_MODEL_SCALE);
      root.visible = false;
      this.world.createTransformEntity(root);

      const mixer = new AnimationMixer(root);
      const clip = gltf.animations[0];
      if (clip) {
        const action = mixer.clipAction(clip);
        action.setLoop(LoopRepeat, Infinity);
        // Offset each bee's own clip start time so a pair doesn't flap in
        // lockstep.
        action.time = Math.random() * clip.duration;
        action.play();
      }
      this._bees.push({ root, mixer, angleOffset: (i / BEE_COUNT) * Math.PI * 2 + Math.random() * 0.5 });
    }
  }

  private _buildMachines(): void {
    const material = new MeshBasicMaterial({ color: MACHINE_COLOR });
    this._machines = buildDecorationSet(MACHINE_COUNT, () => {
      const group = new Group();
      const body = new Mesh(buildOrganicGeometry({ ampMin: 0.02, ampMax: 0.04 }), material);
      body.scale.set(0.03, 0.025, 0.03);
      group.add(body);
      const antenna = new Mesh(new CylinderGeometry(0.003, 0.003, 0.05, 6), material);
      antenna.position.y = 0.035;
      group.add(antenna);
      return group;
    });
    this._registerSet(this._machines);
  }

  private _buildKingTower(): void {
    const towerMaterial = new MeshBasicMaterial({ color: TOWER_COLOR });
    const kingMaterial = makeToonRimFlatMaterial(KING_COLOR);

    this._king = buildDecorationSet(1, () => {
      const group = new Group();
      const tower = new Mesh(
        new CylinderGeometry(TOWER_RADIUS_TOP, TOWER_RADIUS_BOTTOM, TOWER_HEIGHT, 8),
        towerMaterial,
      );
      tower.position.y = TOWER_HEIGHT / 2;
      group.add(tower);
      this._towerMesh = tower;

      const { group: kingBody } = buildPlaceholderPerson(kingMaterial);
      kingBody.position.y = TOWER_HEIGHT;
      kingBody.scale.setScalar(KING_SCALE);
      const crown = new Mesh(new ConeGeometry(0.014, 0.022, 6), new MeshBasicMaterial({ color: CROWN_COLOR }));
      crown.position.y = PERSON_HEIGHT + 0.015;
      kingBody.add(crown);
      group.add(kingBody);
      this._kingBody = kingBody;

      return group;
    });
    this._registerSet(this._king);
  }

  // Grave markers (small headstones) at FateEventSystem's own canonical
  // graveyard layout, plus one seated bench figure watching a grave — Soul
  // type's Beat 2.5 vignette. Static dressing only; Beat 4's actual ghost
  // collectibles (rendered off the same GatherableField/normals) live in
  // fate-event-vfx-system.ts.
  private _buildGraveyardScene(): void {
    const material = new MeshBasicMaterial({ color: GRAVE_COLOR });
    this._graveyard = buildDecorationSetFromNormals(this._fateEvents.getGraveyardNormals(), () => {
      const group = new Group();
      const stone = new Mesh(new CylinderGeometry(GRAVE_WIDTH / 2, GRAVE_WIDTH / 2, GRAVE_HEIGHT, 6), material);
      stone.position.y = GRAVE_HEIGHT / 2;
      stone.scale.z = GRAVE_DEPTH / GRAVE_WIDTH;
      group.add(stone);
      return group;
    });
    this._registerSet(this._graveyard);

    const benchMaterial = makeToonRimFlatMaterial(GRAVE_COLOR.toArray() as [number, number, number]);
    this._graveyardBench = buildDecorationSet(1, () => {
      const group = new Group();
      const { group: person } = buildPlaceholderPerson(benchMaterial);
      person.scale.setScalar(BENCH_SCALE);
      group.add(person);
      return group;
    });
    this._registerSet(this._graveyardBench);
  }

  // Draws a small "comet" glyph directly on the banner canvas — a bright
  // core plus a trail of fading red dust specks, same radial-gradient
  // language buildFireTexture() already uses for this phase's other red
  // flourish, so "the comet" reads as an actual drawn object, not a word.
  private _drawMiniComet(ctx: CanvasRenderingContext2D, cx: number, cy: number, coreRadius: number): void {
    for (let i = BANNER_COMET_TAIL_SPECKS; i >= 1; i--) {
      const t = i / BANNER_COMET_TAIL_SPECKS;
      const x = cx - coreRadius * 6 * t;
      const y = cy + Math.sin(t * Math.PI * 1.5) * coreRadius * 0.5;
      const r = Math.max(1, coreRadius * (1 - t * 0.7) * (0.6 + Math.random() * 0.4));
      const alpha = (1 - t) * 0.8;
      ctx.fillStyle = `rgba(255, ${80 + Math.floor(60 * (1 - t))}, ${50 + Math.floor(40 * (1 - t))}, ${alpha})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreRadius);
    gradient.addColorStop(0, 'rgba(255, 240, 200, 1)');
    gradient.addColorStop(0.5, 'rgba(255, 120, 60, 0.9)');
    gradient.addColorStop(1, 'rgba(200, 30, 10, 0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(cx, cy, coreRadius, 0, Math.PI * 2);
    ctx.fill();
  }

  private _buildBanner(): void {
    const canvas = document.createElement('canvas');
    canvas.width = BANNER_CANVAS_W;
    canvas.height = BANNER_CANVAS_H;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'rgba(20, 4, 4, 0.88)';
    ctx.fillRect(0, 0, BANNER_CANVAS_W, BANNER_CANVAS_H);
    ctx.strokeStyle = 'rgba(255, 120, 100, 0.7)';
    ctx.lineWidth = 6;
    ctx.strokeRect(6, 6, BANNER_CANVAS_W - 12, BANNER_CANVAS_H - 12);

    ctx.fillStyle = '#ffdede';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 72px sans-serif';
    ctx.fillText('☠', BANNER_CANVAS_W * 0.2, BANNER_CANVAS_H / 2);
    ctx.font = 'bold 56px sans-serif';
    ctx.fillText('=', BANNER_CANVAS_W * 0.46, BANNER_CANVAS_H / 2);
    this._drawMiniComet(ctx, BANNER_CANVAS_W * 0.74, BANNER_CANVAS_H / 2, BANNER_CANVAS_H * 0.18);

    const texture = new CanvasTexture(canvas);
    const geo = new PlaneGeometry(BANNER_WIDTH, BANNER_HEIGHT);
    const material = new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, side: DoubleSide });
    const mesh = new Mesh(geo, material);
    mesh.visible = false;
    this._bannerMesh = mesh;
    this.world.createTransformEntity(mesh);
  }

  update(delta: number, time: number): void {
    const globals = getGlobals(this.world);
    const phase = globals.gamePhase.peek();
    const dominant = globals.dominantPebbleType.peek();
    const name = this._constellations.getActiveName();

    this._scratchCenter.copy(this._planetSeeding.getLivePlanetPosition());
    const reach = this._planetSeeding.getLivePlanetRadius() + SURFACE_OFFSET;
    const spinProgress = SITUATION_ELIGIBLE_FROM.has(phase) ? this._planetSeeding.getSpinProgress() : 0;

    const showDogs = dominant === 0 && name === 'Dog';
    const showOrganicScene = dominant === 1;
    const showMachines = dominant === 2;
    const showKing = dominant === 2 && name === 'Crown';
    const showGraveyard = dominant === 0;

    this._updateSet(this._dogs, showDogs, spinProgress, delta, this._scratchCenter, reach);
    this._updateOrganicScene(showOrganicScene, spinProgress, delta, this._scratchCenter, reach, time);
    this._updateBees(showOrganicScene, this._scratchCenter, reach, delta, time);
    this._updateSet(this._machines, showMachines, spinProgress, delta, this._scratchCenter, reach);
    this._updateSet(this._king, showKing, spinProgress, delta, this._scratchCenter, reach);
    this._updateTowerHeight(showKing, delta);
    this._updateSet(this._graveyard, showGraveyard, spinProgress, delta, this._scratchCenter, reach);
    this._updateSet(this._graveyardBench, showGraveyard, spinProgress, delta, this._scratchCenter, reach);

    for (const entity of this.queries.comets.entities) {
      this._cometEntity = entity;
      const posView = entity.getVectorView(CometBody, 'position') as Float32Array;
      this._scratchCometPos.fromArray(posView);
      this._crown.update(delta, this._scratchCometPos);
      break; // exactly one comet entity, see comet-handoff-system.ts
    }

    if (!this._crownWasAttached && this._crown.isAttached()) {
      this._crownWasAttached = true;
      // Read by ConstellationsSystem to gate celestialSymbolMessage/
      // phaseComplete on the crown cinematic actually finishing — see
      // globals.ts's own comment on crownLanded.
      globals.crownLanded.value = true;
    }

    if (this._constellations.isComplete() && !this._wasComplete) {
      this._wasComplete = true;
      this._onCompletion(name, reach);
    }

    this._updatePendingCollapse(delta);
    if (phase === Phase.FateEvents && dominant === VOLATILE_GASSES_TYPE) {
      this._updateGasVignette(delta);
    }
    if (phase === Phase.FateEvents || phase === Phase.Launch || phase === Phase.Finale) {
      this._updatePayoff(delta, dominant, reach);
    }
  }

  // Fires exactly once per play() the instant FateEventSystem's own Ambient
  // beat crosses GAS_DEATH_START_SECONDS (see this file's own top comment
  // for the full 0-10s sub-beat breakdown) — moved here from the old
  // instant-on-constellation-completion trigger.
  private _updateGasVignette(delta: number): void {
    if (this._gasVignetteTriggered) return;
    if (
      this._fateEvents.getBeat() !== FateBeat.Ambient ||
      this._fateEvents.getBeatElapsed() < GAS_DEATH_START_SECONDS
    ) {
      return;
    }
    this._gasVignetteTriggered = true;
    this._pendingCollapse = { kind: 'king', elapsed: 0 };
  }

  // Advances the King-topple beat (see KING_COLLAPSE_DURATION's comment) —
  // once it finishes, just hides the body. Used to also hand off to a
  // rising "ghost" that traveled to and attached on the comet, but that
  // doubled up on the universal CrownRise payoff (see _onCompletion) that
  // already does the same "something rises and lands on the comet" beat, so
  // it was dropped — the king's death now just ends with his body toppling
  // and disappearing, no separate flying orb.
  private _updatePendingCollapse(delta: number): void {
    const collapse = this._pendingCollapse;
    if (!collapse) return;
    collapse.elapsed += delta;

    const t = clamp01(collapse.elapsed / KING_COLLAPSE_DURATION);
    this._kingBody.rotation.x = -smoothstep(t) * KING_TOPPLE_ANGLE;
    if (t >= 1) {
      this._kingBody.visible = false;
      this._pendingCollapse = null;
    }
  }

  // Crown constellation only — grows the tower's own height (independent of
  // the King set's group-level pop-in scale from _updateSet above) from
  // TOWER_MIN_HEIGHT_FRACTION toward however many of the constellation's
  // stars are currently traced, so the tower visibly rises one star at a
  // time instead of appearing at full height the instant the King set pops
  // in. Not folded into _updateSet's generic DecorationSet loop since this
  // needs a single King-only mesh's own live progress source
  // (ConstellationsSystem.getTracedFraction), not spinProgress. Scaling the
  // tower mesh's own Y (not the whole group, which already carries
  // _updateSet's own uniform pop-in scale — the two compose rather than
  // conflict) requires re-deriving position.y alongside scale.y so the
  // base stays pinned to the ground instead of shrinking toward the
  // cylinder's center; kingBody rides the current height so he stands on
  // top of however tall the tower currently is, not floating above it.
  private _updateTowerHeight(showKing: boolean, delta: number): void {
    const target = showKing
      ? TOWER_MIN_HEIGHT_FRACTION + (1 - TOWER_MIN_HEIGHT_FRACTION) * this._constellations.getTracedFraction()
      : TOWER_MIN_HEIGHT_FRACTION;
    const pull = 1 - Math.exp(-TOWER_GROWTH_EASE_RATE * delta);
    this._towerHeightFraction += (target - this._towerHeightFraction) * pull;

    this._towerMesh.scale.y = this._towerHeightFraction;
    this._towerMesh.position.y = (TOWER_HEIGHT * this._towerHeightFraction) / 2;
    this._kingBody.position.y = TOWER_HEIGHT * this._towerHeightFraction;
  }

  private _updateSet(
    set: DecorationSet,
    show: boolean,
    spinProgress: number,
    delta: number,
    center: Vector3,
    reach: number,
  ): void {
    const pull = 1 - Math.exp(-REVEAL_EASE_RATE * delta);
    const count = set.groups.length;
    for (let i = 0; i < count; i++) {
      const target = show ? smoothstep(clamp01((spinProgress - i / count) / STAGGER_WINDOW)) : 0;
      set.scale[i] += (target - set.scale[i]) * pull;
      const group = set.groups[i];
      group.visible = set.scale[i] > 0.001;
      group.scale.setScalar(set.scale[i]);

      const nx = set.normals[i * 3];
      const ny = set.normals[i * 3 + 1];
      const nz = set.normals[i * 3 + 2];
      group.position.set(center.x + nx * reach, center.y + ny * reach, center.z + nz * reach);
      this._scratchNormal.set(nx, ny, nz);
      group.quaternion.setFromUnitVectors(this._upAxis, this._scratchNormal);
    }
  }

  // Small hover-circle above the organic decorations, in the plane
  // perpendicular to CROWD_CAP_DIRECTION (see _buildBees' tangent basis).
  // Mixer only advances while shown — frozen wings while hidden are never
  // seen, and it saves the (tiny) per-frame update cost.
  private _updateBees(show: boolean, center: Vector3, reach: number, delta: number, time: number): void {
    for (const bee of this._bees) {
      bee.root.visible = show;
      if (!show) continue;
      bee.mixer.update(delta);

      const angle = time * BEE_ORBIT_SPEED + bee.angleOffset;
      this._scratchBeePos
        .copy(center)
        .addScaledVector(CROWD_CAP_DIRECTION, reach + BEE_HOVER_HEIGHT)
        .addScaledVector(this._beeTangentA, Math.cos(angle) * BEE_ORBIT_RADIUS)
        .addScaledVector(this._beeTangentB, Math.sin(angle) * BEE_ORBIT_RADIUS);
      bee.root.position.copy(this._scratchBeePos);

      // Face the direction of travel around the circle (the orbit's own
      // tangent) rather than leaving the model in its authored orientation.
      this._scratchBeeLookAt
        .copy(this._scratchBeePos)
        .addScaledVector(this._beeTangentA, -Math.sin(angle))
        .addScaledVector(this._beeTangentB, Math.cos(angle));
      bee.root.lookAt(this._scratchBeeLookAt);
    }
  }

  private _updateOrganicScene(
    show: boolean,
    spinProgress: number,
    delta: number,
    center: Vector3,
    reach: number,
    time: number,
  ): void {
    const scene = this._organicScene;
    const pull = 1 - Math.exp(-REVEAL_EASE_RATE * delta);
    const n = ORGANIC_DECORATION_COUNT;
    // Beat 5 payoff pulse — see BLOSSOM_* constants. Zero (no pulse) unless
    // _updatePayoff has actually triggered it this play().
    const blossomActive = this._payoffTriggered && ORGANIC_MATTER_TYPE === this._lastPayoffDominant;
    for (let i = 0; i < n; i++) {
      const target = show ? smoothstep(clamp01((spinProgress - i / n) / STAGGER_WINDOW)) : 0;
      scene.scale[i] += (target - scene.scale[i]) * pull;

      const nx = scene.normals[i * 3];
      const ny = scene.normals[i * 3 + 1];
      const nz = scene.normals[i * 3 + 2];
      this._scratchNormal.set(nx, ny, nz);
      this._scratchOrganicQuat.setFromUnitVectors(this._upAxis, this._scratchNormal);

      let bob = 0;
      if (scene.isAnimal[i]) {
        bob = Math.max(0, Math.sin(time * ORGANIC_BOB_FREQ * Math.PI * 2 + scene.phase[i])) * ORGANIC_BOB_AMPLITUDE;
      } else {
        const sway = Math.sin(time * ORGANIC_SWAY_FREQ * Math.PI * 2 + scene.phase[i]) * ORGANIC_SWAY_AMPLITUDE;
        this._scratchSwayQuat.setFromAxisAngle(this._scratchNormal, sway);
        this._scratchOrganicQuat.multiply(this._scratchSwayQuat);
      }

      let pulse = 1;
      if (blossomActive) {
        const localT = clamp01(
          (this._payoffElapsed - (i / n) * BLOSSOM_STAGGER_SPAN) / BLOSSOM_PULSE_DURATION,
        );
        if (localT > 0 && localT < 1) pulse = 1 + Math.sin(localT * Math.PI) * BLOSSOM_SCALE_BUMP;
      }

      this._scratchOrganicPos.set(
        center.x + nx * (reach + bob),
        center.y + ny * (reach + bob),
        center.z + nz * (reach + bob),
      );
      this._scratchOrganicScale.set(
        scene.baseScale[i * 3] * scene.scale[i] * pulse,
        scene.baseScale[i * 3 + 1] * scene.scale[i] * pulse,
        scene.baseScale[i * 3 + 2] * scene.scale[i] * pulse,
      );
      this._scratchMat4.compose(this._scratchOrganicPos, this._scratchOrganicQuat, this._scratchOrganicScale);
      scene.meshes[scene.variantOf[i]].setMatrixAt(scene.localOf[i], this._scratchMat4);
    }
    for (const mesh of scene.meshes) mesh.instanceMatrix.needsUpdate = true;
  }

  // Beat 5 — fires once per play() the instant FateEventSystem enters
  // FateBeat.Payoff, then drives whichever per-type visual actually needs
  // continuous updating (Organic's blossom pulse is handled inline in
  // _updateOrganicScene above via _payoffElapsed; Gas's banner rises here;
  // Soul has nothing to drive in this file — its dancing-ghost payoff lives
  // in fate-event-vfx-system.ts, which owns that rendering). Runs across
  // FateEvents/Launch/Finale (not just FateEvents) so the payoff keeps
  // playing after phaseComplete fires and the player departs, same
  // precedent as CrownRise/GhostRise persisting past their own phase.
  private _lastPayoffDominant = -1;
  private _updatePayoff(delta: number, dominant: number, reach: number): void {
    const beat = this._fateEvents.getBeat();
    if (!this._payoffTriggered) {
      if (beat !== FateBeat.Payoff) return;
      this._payoffTriggered = true;
      this._payoffElapsed = 0;
      this._lastPayoffDominant = dominant;
      if (dominant === VOLATILE_GASSES_TYPE) {
        this._bannerMesh.visible = true;
        this._scratchBannerPos.copy(this._scratchCenter).addScaledVector(CROWD_CAP_DIRECTION, reach + 0.02);
        this._bannerMesh.position.copy(this._scratchBannerPos);
        this._bannerEndY = this._scratchBannerPos.y + TOWER_HEIGHT + 0.05;
      }
      playPayoffChime(this._audioListener, this.scene, this._scratchCenter, 420);
    }
    this._payoffElapsed += delta;

    if (dominant === VOLATILE_GASSES_TYPE && this._bannerMesh.visible) {
      const t = clamp01(this._payoffElapsed / BANNER_RISE_DURATION);
      this._bannerMesh.position.y = this._scratchBannerPos.y + (this._bannerEndY - this._scratchBannerPos.y) * smoothstep(t);
      this.camera.getWorldPosition(this._scratchBannerFace);
      this._scratchBannerFace.sub(this._bannerMesh.position).normalize();
      if (this._scratchBannerFace.lengthSq() > 0.0001) {
        this._bannerMesh.quaternion.setFromUnitVectors(this._zAxis, this._scratchBannerFace);
      }
    }
  }

  private _onCompletion(name: string, reach: number): void {
    const globals = getGlobals(this.world);

    // Universal payoff — every constellation's completion sends the crown
    // up, regardless of name, colored to match this playthrough's dominant
    // pebble type. Unconditional, alongside (not replacing) the name-
    // specific branches below.
    const dominant = globals.dominantPebbleType.peek();
    this._scratchCrownOrigin.copy(this._scratchCenter).addScaledVector(CROWD_CAP_DIRECTION, reach);
    this._crown.trigger(this._scratchCrownOrigin, PEBBLE_TYPES[dominant].color);

    if (name === 'Dog') {
      // Kept: a private "paired" line for one crowd member, same as before
      // — the dog itself no longer dies for this (see below), but this
      // small personal beat is cheap and still lands well alongside the
      // pack visiting everyone.
      const pairedIndex = Math.floor(Math.random() * Math.max(1, this._fateEvents.getVisiblePeopleCount()));
      globals.pairedPersonIndex.value = pairedIndex;
      globals.pairedPersonLine.value = FATE_DIALOGUE.Dog.pairedLine ?? null;

      // The dog's soul was already quietly riding in the comet's tail this
      // whole game — no new death, no ghost-rise. Completion just reveals
      // it: a small pack of already-captured soul pebbles detaches, flies
      // down, gently visits every person in the crowd, then returns.
      const positions = this._fateEvents.getSurfacePositions();
      const n = this._fateEvents.getVisiblePeopleCount();
      const waypoints: Vector3[] = [];
      for (let i = 0; i < n; i++) {
        waypoints.push(new Vector3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]));
      }
      if (this._cometEntity) this._pebbleComet.startSoulPackVisit(this._cometEntity, waypoints);
    }
    // Crown's king-death vignette no longer fires here — see
    // _updateGasVignette, gated on FateEventSystem's own Ambient beat.
  }

  private _resetAll(): void {
    for (const set of [this._dogs, this._machines, this._king, this._graveyard, this._graveyardBench]) {
      set.scale.fill(0);
      for (const group of set.groups) group.visible = false;
    }
    this._organicScene.scale.fill(0);
    this._kingBody.visible = true;
    this._kingBody.rotation.x = 0;
    this._towerHeightFraction = TOWER_MIN_HEIGHT_FRACTION;
    this._towerMesh.scale.y = TOWER_MIN_HEIGHT_FRACTION;
    this._towerMesh.position.y = (TOWER_HEIGHT * TOWER_MIN_HEIGHT_FRACTION) / 2;
    this._kingBody.position.y = TOWER_HEIGHT * TOWER_MIN_HEIGHT_FRACTION;
    this._pendingCollapse = null;
    this._gasVignetteTriggered = false;
    this._crown.reset();
    this._crownWasAttached = false;
    this._wasComplete = false;
    this._payoffTriggered = false;
    this._payoffElapsed = 0;
    this._lastPayoffDominant = -1;
    this._bannerMesh.visible = false;

    const globals = getGlobals(this.world);
    globals.pairedPersonIndex.value = null;
    globals.pairedPersonLine.value = null;
    globals.crownLanded.value = false;
  }
}
