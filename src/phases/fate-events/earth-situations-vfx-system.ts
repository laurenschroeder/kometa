import {
  AnimationAction,
  AnimationClip,
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
  LoopOnce,
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
import { playKingDeathTone } from '../../vfx/audio/king-death-tone.js';
import { playKingHorn } from '../../vfx/audio/king-horn.js';
import { playPayoffChime } from '../../vfx/audio/payoff-chime.js';
import { buildOrganicGeometry } from '../../vfx/geometry/organic-rock-geometry.js';
import { buildPlaceholderPerson, PERSON_HEIGHT } from '../../vfx/geometry/placeholder-person.js';
import {
  buildAnimatedPerson,
  loadAnimatedPersonTemplate,
  loadPersonClip,
  PERSON_BODY_COLOR,
} from '../../vfx/geometry/animated-person.js';
import { scatterOnSphereCap } from '../../vfx/geometry/sphere-scatter.js';
import { kOrganicGlitterMat } from '../../vfx/shaders/pebble-material.js';
import { makeToonRimSkinnedMaterial } from '../../vfx/shaders/toon-rim-material.js';
import { CrownRise } from '../../vfx/particles/crown-rise.js';
import { ConstellationsSystem } from '../constellations/constellations-system.js';
import { CROWN, GRAVE, ORGANIC_PALETTE } from '../../vfx/color/color-scheme.js';
import { CROWD_CAP_DIRECTION, FateBeat, FateEventSystem } from './fate-event-system.js';
import { PEBBLE_TYPES } from '../pebbles/pebble-type.js';
import { PlanetSeedingVfxSystem } from '../planet-seeding/planet-seeding-vfx-system.js';

const VOLATILE_GASSES_TYPE = 2;
const ORGANIC_MATTER_TYPE = 1;

// Wider than FateEventSystem's own 34° people cap so decorations spread a
// bit around/among the crowd instead of exactly overlapping it.
const CAP_HALF_ANGLE = (40 * Math.PI) / 180;
const SURFACE_OFFSET = 0.01;

const STAGGER_WINDOW = 0.3; // same idiom/purpose as FateEventVfxSystem's own person stagger
const REVEAL_EASE_RATE = 3; // 1/s exponential ease toward the staggered target scale

const CROWN_COLOR = new Color(CROWN);
// The King's own worn crown prop — a low band plus evenly-spaced spikes
// around the rim, all as fractions of PERSON_HEIGHT (same "authored as
// ratios, not raw meters" convention placeholder-person.ts's own proportions
// use) so it stays sized correctly relative to the figure if PERSON_HEIGHT
// ever changes again. Previously a single bare cone, which read as more of
// a party hat than a crown.
const CROWN_SPIKE_COUNT = 5;
const CROWN_BAND_RADIUS = PERSON_HEIGHT * 0.11;
const CROWN_BAND_HEIGHT = PERSON_HEIGHT * 0.05;
const CROWN_SPIKE_RADIUS = PERSON_HEIGHT * 0.025;
const CROWN_SPIKE_HEIGHT = PERSON_HEIGHT * 0.09;
// Band sinks slightly below the head-top reference point (attachHeadProp's
// wrapper origin / the placeholder-body offset below) rather than balancing
// entirely above it, so it reads as resting ON the head, not floating just
// past the crown of the skull.
const CROWN_EMBED = CROWN_BAND_HEIGHT * 0.3;
const GRAVE_COLOR = new Color(GRAVE);

const KING_SCALE = 0.75;

// Gas's Beat 2.5 (Ambient) vignette — the king's death used to fire the
// instant the Throne constellation completed (during Constellations, well
// before Fate Events even began); it now waits for FateEventSystem's own
// Ambient beat and plays across three timed sub-beats summing to
// AMBIENT_BEAT_SECONDS (10s, see fate-event-system.ts): 0-3s the crowd holds
// a watching/waving pose (see fate-event-vfx-system.ts's own
// _updateGasWatchPose), 3-8s the king topples and his ghost rises (this
// file), 8-10s the crowd turns to face the player (also fate-event-vfx-
// system.ts). GAS_DEATH_START/DURATION below are this file's own slice of
// that timeline.
const GAS_DEATH_START_SECONDS = 3;
// Real death animation — plays once in place on the ground (its own bone
// motion carries the "falling backward" topple), then holds its final
// "laying on his back" pose for good (LoopOnce + clampWhenFinished, see
// _triggerKingDeath) rather than looping back to standing — there's no
// tower/height to drop from anymore (the King now stands directly on the
// ground, like every other figure), so once the topple finishes there's
// nothing left to animate. KING_TOPPLE_ANGLE below is the fallback-only
// root-rotation hack, used in place of the real clip's own pose if it
// somehow isn't available.
const KING_DYING_URL = '/medium/DyingBackwards.fbx';
// Fallback-only from here down: used in place of the real clip's own
// duration/pose if KING_DYING_URL fails to load (graceful degradation, same
// idiom as every other FBX consumer in this codebase).
const KING_FALLBACK_ANIM_DURATION = 1.5;
const KING_TOPPLE_ANGLE = (100 * Math.PI) / 180; // past horizontal, reads as a genuine fall

// Soul's Beat 2.5 graveyard — grave markers + one seated, idly-bobbing bench
// figure watching a grave, positioned from FateEventSystem's own canonical
// graveyard layout (see getGraveyardNormals) so the static dressing here and
// Beat 4's actual ghost collectibles (fate-event-vfx-system.ts) land on the
// same spots instead of two independent scatters.
// Doubled from 0.03/0.045/0.012 — read as too small next to the crowd/bench.
const GRAVE_WIDTH = 0.06;
const GRAVE_HEIGHT = 0.09;
const GRAVE_DEPTH = 0.024;
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

// Beat 5 — Gas's "COMET = SKULL" banner rises above the crowd and holds.
// Simple canvas-texture billboard, same construction idiom as
// FateEventVfxSystem's own speech bubbles/fire quads — not PanelUI, which is
// for interactive panels, the wrong tool for a static in-world graphic.
const BANNER_WIDTH = 0.3;
const BANNER_HEIGHT = 0.09;
const BANNER_RISE_DURATION = 4;
// How far above its starting point the banner rises — used to be pegged to
// the (now-removed) tower's own height; a plain fixed height reads the same
// without needing a tower to measure off of.
const BANNER_RISE_HEIGHT = 0.31;
const BANNER_CANVAS_W = 512;
const BANNER_CANVAS_H = 160;
// "mini comet = SKULL" — the comet half is a small drawn glyph (bright core
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
  // Set once every item has actually settled at scale 0 while hidden — see
  // _updateSet's own early-out comment. Cleared the instant `show` goes
  // true again so a freshly-revealing set still runs its per-instance work.
  atRest: boolean;
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
  return { groups, normals, scale: new Float32Array(count), atRest: false };
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
  atRest: boolean; // see DecorationSet.atRest's own comment — same idiom
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
// self-gated via gamePhase, never GameDirector-managed — the Shepherd/Throne
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

  private _organicScene!: OrganicScene;
  // See BEE_COUNT's own comment — a couple of real animated models, not
  // part of OrganicScene's InstancedMesh/procedural setup.
  private _bees: { root: Group; mixer: AnimationMixer; angleOffset: number }[] = [];
  // Orthonormal basis around CROWD_CAP_DIRECTION, computed once in
  // _buildBees() — the plane the bees' small hover-circle is drawn in.
  private _beeTangentA = new Vector3();
  private _beeTangentB = new Vector3();
  private _king!: DecorationSet;
  private _kingBody!: Group; // the king's own figure, stays visible lying down once he dies
  // Both null until the shared BreathingIdle rig resolves (see
  // _swapKingToAnimated/_swapBenchToAnimated) — the King's own topple
  // (_kingBody.rotation.x, below) is a plain ROOT rotation on this same
  // group either way, so it needs no change once the swap happens.
  private _kingMixer: AnimationMixer | null = null;
  private _benchMixer: AnimationMixer | null = null;
  // DyingBackwards.fbx's own clip, loaded once (see _buildKing) —
  // null until it resolves, or forever if it fails to load (see
  // _triggerKingDeath's fallback path). idleAction is the King's own
  // BreathingIdle loop, captured from _swapKingToAnimated so death can stop
  // it; dyingAction is created lazily the instant death actually triggers.
  private _kingDyingClip: AnimationClip | null = null;
  private _kingIdleAction: AnimationAction | null = null;
  private _kingDyingAction: AnimationAction | null = null;
  // Whichever figure (placeholder, then the swapped-in animated rig) is
  // CURRENTLY the King's/bench's own body visual — tracked so the later
  // swap can remove exactly that one child. The bench figure has no
  // sibling but is handled the same way for consistency.
  private _kingBodyVisual!: Group;
  // The crown prop currently worn — a fresh one is built for the placeholder
  // body (a plain child of kingBody, no bone to ride yet) and swapped for
  // another fresh one rigidly attached to the real rig's own head bone once
  // it loads (see _swapKingToAnimated/AnimatedPerson.attachHeadProp) rather
  // than trying to re-parent the same instance — its wrapper math only
  // applies once a head bone actually exists.
  private _kingCrown!: Group;
  private _kingMaterial!: ReturnType<typeof makeToonRimSkinnedMaterial>;
  private _benchBodyVisual!: Group;
  private _benchMaterial!: ReturnType<typeof makeToonRimSkinnedMaterial>;
  private _graveyard!: DecorationSet;
  private _graveyardBench!: DecorationSet;

  // The king's death sequence, once triggered — see _triggerKingDeath/
  // _updatePendingCollapse. animDuration is the real DyingBackwards clip's
  // own duration (or KING_FALLBACK_ANIM_DURATION if that clip never loaded),
  // useClipPose says whether the clip itself is driving the topple pose
  // (true) or the old root-rotation hack is (false, fallback only). Null
  // when idle.
  private _pendingCollapse: { kind: 'king'; elapsed: number; animDuration: number; useClipPose: boolean } | null =
    null;
  // One-shot guard — Gas's death vignette fires once per play() the instant
  // FateEventSystem's Ambient beat crosses GAS_DEATH_START_SECONDS.
  private _gasVignetteTriggered = false;
  // One-shot guard — the ominous warning horn (see _updateGasHorn) fires
  // once per play() the instant the Ambient beat itself begins, GAS_DEATH_
  // START_SECONDS before the actual death trigger above.
  private _gasHornTriggered = false;

  // Universal payoff (see crown-rise.ts's own class comment) — plays on
  // EVERY constellation completion.
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

  private _wasComplete = false;
  private _cometEntity: Entity | null = null;

  private _upAxis = new Vector3(0, 1, 0);
  private _scratchNormal = new Vector3();
  private _scratchCenter = new Vector3();
  private _scratchGhostOrigin = new Vector3();
  private _scratchCrownOrigin = new Vector3();
  private _scratchDeathTonePos = new Vector3();
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
    // PlanetSeedingVfxSystem/ConstellationsSystem/FateEventSystem must be
    // registered before this system (see index.ts) so they already exist
    // when this init() runs.
    this._constellations = this.world.getSystem(ConstellationsSystem)!;
    this._planetSeeding = this.world.getSystem(PlanetSeedingVfxSystem)!;
    this._fateEvents = this.world.getSystem(FateEventSystem)!;

    this._buildOrganicScene();
    this._buildBees();
    this._buildKing();
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
    const palette = ORGANIC_PALETTE;
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

    this._organicScene = {
      meshes,
      variantOf,
      localOf,
      isAnimal,
      normals,
      baseScale,
      phase,
      scale: new Float32Array(n),
      atRest: false,
    };
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

  // A fresh crown Group — band + rim spikes, local origin at the band's
  // own bottom edge so a caller positioning/parenting this at "top of head"
  // gets a crown that visibly rests there (see CROWN_EMBED). Built fresh
  // per call (not shared) since the placeholder and the real rig each need
  // their own instance — see _kingCrown's own comment.
  private _buildCrownProp(): Group {
    const group = new Group();
    const material = new MeshBasicMaterial({ color: CROWN_COLOR });

    const band = new Mesh(new CylinderGeometry(CROWN_BAND_RADIUS, CROWN_BAND_RADIUS * 1.08, CROWN_BAND_HEIGHT, 10), material);
    band.position.y = CROWN_BAND_HEIGHT / 2 - CROWN_EMBED;
    group.add(band);

    const spikeGeo = new ConeGeometry(CROWN_SPIKE_RADIUS, CROWN_SPIKE_HEIGHT, 6);
    const spikeY = CROWN_BAND_HEIGHT - CROWN_EMBED + CROWN_SPIKE_HEIGHT / 2;
    for (let i = 0; i < CROWN_SPIKE_COUNT; i++) {
      const angle = (i / CROWN_SPIKE_COUNT) * Math.PI * 2;
      const spike = new Mesh(spikeGeo, material);
      spike.position.set(Math.cos(angle) * CROWN_BAND_RADIUS * 0.85, spikeY, Math.sin(angle) * CROWN_BAND_RADIUS * 0.85);
      group.add(spike);
    }

    return group;
  }

  private _buildKing(): void {
    // Same shared black outline material every human figure now uses (see
    // animated-person.ts's PERSON_BODY_COLOR) — the King's own lavender
    // KING_COLOR identity is gone, per the same "black center" look applied
    // across the crowd/King/bench.
    this._kingMaterial = makeToonRimSkinnedMaterial(PERSON_BODY_COLOR);

    // The King must be front-and-center (his death is a key beat the player
    // needs to actually see) rather than buildDecorationSet's usual random
    // point somewhere within the cap — bypass it and build straight off a
    // single fixed normal at CROWD_CAP_DIRECTION itself (already a unit
    // vector) instead. fate-event-system.ts's own ambient crowd scatter
    // carves an exclusion cone out around this same direction (see its
    // KING_EXCLUSION_HALF_ANGLE) so people land behind/to the side of him,
    // not on top of him.
    const kingNormals = new Float32Array([CROWD_CAP_DIRECTION.x, CROWD_CAP_DIRECTION.y, CROWD_CAP_DIRECTION.z]);
    this._king = buildDecorationSetFromNormals(kingNormals, () => {
      const group = new Group();

      // Stands directly on the ground now — no more tower pedestal (see
      // this file's own top-level comments on why it was removed).
      const kingBody = new Group();
      kingBody.scale.setScalar(KING_SCALE);

      // Non-animated primitive placeholder immediately; swapped for the
      // shared animated rig once BreathingIdle.fbx resolves (see
      // _swapKingToAnimated) — tracked via _kingBodyVisual (not "clear
      // every child") since the crown below is a permanent sibling that
      // must survive the swap.
      this._kingBodyVisual = buildPlaceholderPerson(this._kingMaterial).group;
      kingBody.add(this._kingBodyVisual);

      // No head bone to ride yet (see attachHeadProp) — plain child of
      // kingBody at a fixed offset, same as before, just for this short
      // placeholder window until the real rig loads.
      this._kingCrown = this._buildCrownProp();
      this._kingCrown.position.y = PERSON_HEIGHT;
      kingBody.add(this._kingCrown);
      group.add(kingBody);
      this._kingBody = kingBody;

      return group;
    });
    this._registerSet(this._king);

    loadAnimatedPersonTemplate().then((template) => this._swapKingToAnimated(template));
    loadPersonClip(KING_DYING_URL).then((clip) => {
      this._kingDyingClip = clip;
    });
  }

  private _swapKingToAnimated(template: Awaited<ReturnType<typeof loadAnimatedPersonTemplate>>): void {
    if (!template) {
      console.warn("[EarthSituationsVfxSystem] BreathingIdle.fbx unavailable — keeping the King's primitive placeholder figure.");
      return;
    }
    this._kingBody.remove(this._kingBodyVisual);
    const animated = buildAnimatedPerson(template, this._kingMaterial, PERSON_HEIGHT);
    this._kingBodyVisual = animated.group;
    this._kingBody.add(this._kingBodyVisual);
    this._kingMixer = animated.mixer;
    this._kingIdleAction = animated.idleAction;

    // Placeholder crown was a fixed-offset child of kingBody (no bone to
    // ride yet) — swap it for a fresh one rigidly attached to the real
    // rig's own head bone, so it tracks the idle animation's head bob
    // instead of staying at an offset tuned for the primitive placeholder's
    // proportions (see AnimatedPerson.attachHeadProp's own comment).
    this._kingBody.remove(this._kingCrown);
    this._kingCrown = this._buildCrownProp();
    animated.attachHeadProp(this._kingCrown);
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

    this._benchMaterial = makeToonRimSkinnedMaterial(PERSON_BODY_COLOR);
    this._graveyardBench = buildDecorationSet(1, () => {
      const group = new Group();
      this._benchBodyVisual = buildPlaceholderPerson(this._benchMaterial).group;
      this._benchBodyVisual.scale.setScalar(BENCH_SCALE);
      group.add(this._benchBodyVisual);
      return group;
    });
    this._registerSet(this._graveyardBench);

    loadAnimatedPersonTemplate().then((template) => this._swapBenchToAnimated(template));
  }

  private _swapBenchToAnimated(template: Awaited<ReturnType<typeof loadAnimatedPersonTemplate>>): void {
    if (!template) {
      console.warn('[EarthSituationsVfxSystem] BreathingIdle.fbx unavailable — keeping the bench NPC\'s primitive placeholder figure.');
      return;
    }
    const wrapper = this._benchBodyVisual.parent!;
    wrapper.remove(this._benchBodyVisual);
    const animated = buildAnimatedPerson(template, this._benchMaterial, PERSON_HEIGHT);
    animated.group.scale.setScalar(BENCH_SCALE);
    this._benchBodyVisual = animated.group;
    wrapper.add(this._benchBodyVisual);
    this._benchMixer = animated.mixer;
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

  // Same "drawn directly on the canvas" reasoning as _drawMiniComet above —
  // see _buildBanner's own comment for why this replaced a plain
  // fillText('☠', ...) call. Cranium + jaw in the banner's own ink color,
  // eye sockets/nasal cavity/teeth cut back to (approximately) the
  // banner's own background color so they read as sockets rather than a
  // separate drawn shape.
  private _drawSkull(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number): void {
    ctx.fillStyle = '#ffdede';
    ctx.beginPath();
    ctx.arc(cx, cy - radius * 0.15, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx - radius * 0.55, cy + radius * 0.15);
    ctx.quadraticCurveTo(cx, cy + radius * 1.05, cx + radius * 0.55, cy + radius * 0.15);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = 'rgba(20, 4, 4, 0.88)';
    ctx.beginPath();
    ctx.arc(cx - radius * 0.38, cy - radius * 0.1, radius * 0.28, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx + radius * 0.38, cy - radius * 0.1, radius * 0.28, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx, cy + radius * 0.05);
    ctx.lineTo(cx - radius * 0.12, cy + radius * 0.32);
    ctx.lineTo(cx + radius * 0.12, cy + radius * 0.32);
    ctx.closePath();
    ctx.fill();
    for (let i = -1; i <= 1; i++) {
      ctx.fillRect(
        cx + i * radius * 0.22 - radius * 0.03,
        cy + radius * 0.55,
        radius * 0.06,
        radius * 0.22,
      );
    }
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
    // "comet = SKULL" — comet glyph first (reads left-to-right as "this is
    // what caused this"), skull last. Both are drawn directly on the
    // canvas (see _drawMiniComet/_drawSkull) rather than typed as text —
    // the skull specifically USED to be a plain fillText('☠', ...) call,
    // but a Unicode glyph is only as good as whatever font the browser
    // happens to resolve 'sans-serif' to, and it was silently rendering as
    // nothing (missing-glyph) in at least this environment — same "drawn
    // object, not a font's problem" reasoning the comet glyph already used.
    this._drawMiniComet(ctx, BANNER_CANVAS_W * 0.2, BANNER_CANVAS_H / 2, BANNER_CANVAS_H * 0.18);
    ctx.font = 'bold 56px sans-serif';
    ctx.fillText('=', BANNER_CANVAS_W * 0.46, BANNER_CANVAS_H / 2);
    this._drawSkull(ctx, BANNER_CANVAS_W * 0.74, BANNER_CANVAS_H / 2, BANNER_CANVAS_H * 0.24);

    const texture = new CanvasTexture(canvas);
    const geo = new PlaneGeometry(BANNER_WIDTH, BANNER_HEIGHT);
    const material = new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, side: DoubleSide });
    const mesh = new Mesh(geo, material);
    mesh.visible = false;
    this._bannerMesh = mesh;
    this.world.createTransformEntity(mesh);
  }

  update(delta: number, time: number): void {
    // Advances the King's/bench's own idle-breathing animation once the
    // shared rig has resolved (null until then) — cheap for two figures,
    // always safe regardless of current visibility, same reasoning as
    // _updateBees' own mixer.update() call.
    this._kingMixer?.update(delta);
    this._benchMixer?.update(delta);

    const globals = getGlobals(this.world);
    const phase = globals.gamePhase.peek();
    const dominant = globals.dominantPebbleType.peek();
    const name = this._constellations.getActiveName();

    this._scratchCenter.copy(this._planetSeeding.getLivePlanetPosition());
    const reach = this._planetSeeding.getLivePlanetRadius() + SURFACE_OFFSET;
    // Past Constellations every decoration set is always fully revealed —
    // Leg A is long over by then, so getSpinProgress() already returns 1 in
    // normal play and this max() changes nothing. It only matters on a
    // dev-menu jump straight to Fate Events (Leg A never ran, so
    // PlanetSpinTransition.getProgress() reports 0 for "never started"),
    // which would otherwise leave the King/tower/machines/graveyard/organic
    // scene all scaled to 0. Same fix fate-event-vfx-system.ts's own crowd
    // applies to its spinProgress read.
    const rawSpinProgress = SITUATION_ELIGIBLE_FROM.has(phase) ? this._planetSeeding.getSpinProgress() : 0;
    const spinProgress =
      phase === Phase.Constellations ? rawSpinProgress : Math.max(rawSpinProgress, SITUATION_ELIGIBLE_FROM.has(phase) ? 1 : 0);
    // Every decoration in this file (King/tower, graveyard/bench, dogs,
    // machines, organic scene, bees) was tuned in absolute meters against
    // Fate Events' own settled PLANET_RADIUS — correct only once the live
    // planet has actually reached that radius. This system is visible from
    // Phase.Constellations onward (see SITUATION_ELIGIBLE_FROM/VISIBLE at
    // the top of the file), well before Fate Events' Zoom beat ever runs —
    // during Constellations the live planet sits at PlanetSpinTransition's
    // much smaller INTERMEDIATE_PLANET_RADIUS, and during Launch it's
    // shrinking/receding again, so without this correction every fixed-size
    // figure read as wildly too big relative to whatever planet was
    // actually on screen. Same fix fate-event-vfx-system.ts's own crowd
    // already applies to its group scale (see its own radiusScale) — 1.0
    // exactly once the live radius matches Fate Events' settled size.
    const radiusScale = this._planetSeeding.getLivePlanetRadius() / this._fateEvents.getPlanetRadius();

    const showOrganicScene = dominant === 1;
    const showKing = dominant === 2 && name === 'Throne';
    const showGraveyard = dominant === 0;

    this._updateOrganicScene(showOrganicScene, spinProgress, delta, this._scratchCenter, reach, time, radiusScale);
    this._updateBees(showOrganicScene, this._scratchCenter, reach, delta, time, radiusScale);
    this._updateSet(this._king, showKing, spinProgress, delta, this._scratchCenter, reach, radiusScale);
    this._updateSet(this._graveyard, showGraveyard, spinProgress, delta, this._scratchCenter, reach, radiusScale);
    this._updateSet(
      this._graveyardBench,
      showGraveyard,
      spinProgress,
      delta,
      this._scratchCenter,
      reach,
      radiusScale,
    );

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
      this._onCompletion(reach);
    }

    this._updatePendingCollapse(delta);
    if (phase === Phase.FateEvents && dominant === VOLATILE_GASSES_TYPE) {
      this._updateGasHorn();
      this._updateGasVignette(delta);
    }
    if (phase === Phase.FateEvents || phase === Phase.Launch || phase === Phase.Finale) {
      this._updatePayoff(delta, dominant, reach, radiusScale);
    }
  }

  // Fires exactly once per play() the instant FateEventSystem's own Ambient
  // beat begins (see this file's own top comment for the full 0-10s sub-beat
  // breakdown) — an ominous horn blast from the king's own tower, GAS_DEATH_
  // START_SECONDS before _updateGasVignette below actually triggers his
  // death, so the player gets a "something bad is coming" warning cue during
  // the crowd's 0-3s watching/waving pose rather than the death landing with
  // no lead-up.
  private _updateGasHorn(): void {
    if (this._gasHornTriggered) return;
    if (this._fateEvents.getBeat() !== FateBeat.Ambient) return;
    this._gasHornTriggered = true;
    this._king.groups[0]?.getWorldPosition(this._scratchDeathTonePos);
    playKingHorn(this._audioListener, this.scene, this._scratchDeathTonePos);
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
    this._triggerKingDeath();
  }

  // Switches the King from his idle loop onto DyingBackwards.fbx (one-shot,
  // held on its final frame — see LoopOnce/clampWhenFinished below), if that
  // clip actually loaded; otherwise falls back to the old root-rotation
  // topple hack in _updatePendingCollapse so death still reads even without
  // the real animation. Either way, _updatePendingCollapse takes over from
  // here to drop the king's root from the tower to the ground once the
  // topple pose is showing.
  private _triggerKingDeath(): void {
    this._king.groups[0]?.getWorldPosition(this._scratchDeathTonePos);
    playKingDeathTone(this._audioListener, this.scene, this._scratchDeathTonePos);

    const clip = this._kingDyingClip;
    const useClipPose = !!(clip && this._kingMixer && this._kingIdleAction);
    this._pendingCollapse = {
      kind: 'king',
      elapsed: 0,
      animDuration: useClipPose ? clip!.duration : KING_FALLBACK_ANIM_DURATION,
      useClipPose,
    };
    this._kingBody.rotation.x = 0; // clean slate for the fallback path below; a no-op if the real clip is driving the pose instead

    if (useClipPose) {
      this._kingIdleAction!.stop();
      const dyingAction = this._kingMixer!.clipAction(clip!);
      dyingAction.reset();
      dyingAction.setLoop(LoopOnce, 1);
      dyingAction.clampWhenFinished = true;
      dyingAction.play();
      this._kingDyingAction = dyingAction;
    }
  }

  // Advances the King's death sequence (see _triggerKingDeath): while
  // collapse.elapsed is still within animDuration, either the real clip is
  // playing (useClipPose — nothing else to drive, this._kingMixer?.update()
  // in update() above already advances it) or the fallback root-rotation
  // topple is. Once animDuration has elapsed the pose is locked in for good
  // (holding on DyingBackwards' final frame, or the fallback's
  // fully-toppled rotation) — he stays visible lying there on the ground
  // afterward rather than disappearing (no more separate rising-ghost
  // hand-off; that doubled up on the universal CrownRise payoff — see
  // _onCompletion — which already does the same "something rises and lands
  // on the comet" beat).
  private _updatePendingCollapse(delta: number): void {
    const collapse = this._pendingCollapse;
    if (!collapse) return;
    collapse.elapsed += delta;

    if (collapse.elapsed < collapse.animDuration) {
      if (!collapse.useClipPose) {
        const t = clamp01(collapse.elapsed / collapse.animDuration);
        this._kingBody.rotation.x = -smoothstep(t) * KING_TOPPLE_ANGLE;
      }
      return;
    }

    // Topple's finished — no tower to drop from anymore (he was already
    // standing on the ground), so just hold here for good. The real clip's
    // own LoopOnce/clampWhenFinished (see _triggerKingDeath) already keeps
    // it locked on its final frame; the fallback's rotation.x is likewise
    // just left at whatever the loop above last set it to (full
    // KING_TOPPLE_ANGLE) since nothing touches it past this point.
    this._pendingCollapse = null;
    // See globals.ts's own comment — FateEventVfxSystem polls this to
    // switch the ambient crowd onto their "sitting disbelief" reaction.
    getGlobals(this.world).kingDeathComplete.value = true;
  }

  private _updateSet(
    set: DecorationSet,
    show: boolean,
    spinProgress: number,
    delta: number,
    center: Vector3,
    reach: number,
    radiusScale: number,
  ): void {
    if (show) {
      set.atRest = false;
    } else if (set.atRest) {
      // Already fully hidden and settled at scale 0 — every item below
      // would just recompute the exact same "stay at 0" result forever,
      // so skip the whole per-instance pass (trig included) instead of
      // paying for it every single frame regardless of whether this set
      // is even relevant to the current playthrough (e.g. the organic
      // scene's own decorations still running full-tilt during a Gas run).
      return;
    }

    const pull = 1 - Math.exp(-REVEAL_EASE_RATE * delta);
    const count = set.groups.length;
    let allSettled = true;
    for (let i = 0; i < count; i++) {
      const target = show ? smoothstep(clamp01((spinProgress - i / count) / STAGGER_WINDOW)) : 0;
      set.scale[i] += (target - set.scale[i]) * pull;
      const group = set.groups[i];
      group.visible = set.scale[i] > 0.001;
      if (group.visible) allSettled = false;
      // radiusScale is applied on this outer group's own scale only — every
      // absolute-meter dimension inside it (tower height, King/bench body
      // height, grave stone size, ...) is authored in this group's LOCAL
      // space, so it shrinks/grows with the group for free once this one
      // multiply is here; no need to separately touch each child.
      group.scale.setScalar(set.scale[i] * radiusScale);

      const nx = set.normals[i * 3];
      const ny = set.normals[i * 3 + 1];
      const nz = set.normals[i * 3 + 2];
      group.position.set(center.x + nx * reach, center.y + ny * reach, center.z + nz * reach);
      this._scratchNormal.set(nx, ny, nz);
      group.quaternion.setFromUnitVectors(this._upAxis, this._scratchNormal);
    }
    if (!show && allSettled) set.atRest = true;
  }

  // Small hover-circle above the organic decorations, in the plane
  // perpendicular to CROWD_CAP_DIRECTION (see _buildBees' tangent basis).
  // Mixer only advances while shown — frozen wings while hidden are never
  // seen, and it saves the (tiny) per-frame update cost.
  private _updateBees(
    show: boolean,
    center: Vector3,
    reach: number,
    delta: number,
    time: number,
    radiusScale: number,
  ): void {
    for (const bee of this._bees) {
      bee.root.visible = show;
      if (!show) continue;
      bee.mixer.update(delta);
      // Bees are independent top-level entities, not children of a
      // DecorationSet group — unlike _updateSet's figures, there's no
      // parent scale to inherit radiusScale from for free, so the model
      // scale and every absolute-meter offset below are reasserted with it
      // directly, every frame.
      bee.root.scale.setScalar(BEE_MODEL_SCALE * radiusScale);

      const angle = time * BEE_ORBIT_SPEED + bee.angleOffset;
      this._scratchBeePos
        .copy(center)
        .addScaledVector(CROWD_CAP_DIRECTION, reach + BEE_HOVER_HEIGHT * radiusScale)
        .addScaledVector(this._beeTangentA, Math.cos(angle) * BEE_ORBIT_RADIUS * radiusScale)
        .addScaledVector(this._beeTangentB, Math.sin(angle) * BEE_ORBIT_RADIUS * radiusScale);
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
    radiusScale: number,
  ): void {
    const scene = this._organicScene;
    // Same early-out idiom as _updateSet's own atRest — see its comment.
    // Organic's own decorations otherwise ran this full per-instance pass
    // (including per-mesh setMatrixAt calls) every frame even while fully
    // hidden and settled, e.g. for the whole rest of a Soul/Gas run.
    if (show) {
      scene.atRest = false;
    } else if (scene.atRest) {
      return;
    }

    const pull = 1 - Math.exp(-REVEAL_EASE_RATE * delta);
    const n = ORGANIC_DECORATION_COUNT;
    // Beat 5 payoff pulse — see BLOSSOM_* constants. Zero (no pulse) unless
    // _updatePayoff has actually triggered it this play().
    const blossomActive = this._payoffTriggered && ORGANIC_MATTER_TYPE === this._lastPayoffDominant;
    let allSettled = true;
    for (let i = 0; i < n; i++) {
      const target = show ? smoothstep(clamp01((spinProgress - i / n) / STAGGER_WINDOW)) : 0;
      scene.scale[i] += (target - scene.scale[i]) * pull;
      if (scene.scale[i] > 0.001) allSettled = false;

      const nx = scene.normals[i * 3];
      const ny = scene.normals[i * 3 + 1];
      const nz = scene.normals[i * 3 + 2];
      this._scratchNormal.set(nx, ny, nz);
      this._scratchOrganicQuat.setFromUnitVectors(this._upAxis, this._scratchNormal);

      let bob = 0;
      if (scene.isAnimal[i]) {
        bob =
          Math.max(0, Math.sin(time * ORGANIC_BOB_FREQ * Math.PI * 2 + scene.phase[i])) *
          ORGANIC_BOB_AMPLITUDE *
          radiusScale;
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
        scene.baseScale[i * 3] * scene.scale[i] * pulse * radiusScale,
        scene.baseScale[i * 3 + 1] * scene.scale[i] * pulse * radiusScale,
        scene.baseScale[i * 3 + 2] * scene.scale[i] * pulse * radiusScale,
      );
      this._scratchMat4.compose(this._scratchOrganicPos, this._scratchOrganicQuat, this._scratchOrganicScale);
      scene.meshes[scene.variantOf[i]].setMatrixAt(scene.localOf[i], this._scratchMat4);
    }
    for (const mesh of scene.meshes) mesh.instanceMatrix.needsUpdate = true;
    if (!show && allSettled) scene.atRest = true;
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
  private _updatePayoff(delta: number, dominant: number, reach: number, radiusScale: number): void {
    const beat = this._fateEvents.getBeat();
    if (!this._payoffTriggered) {
      if (beat !== FateBeat.Payoff) return;
      this._payoffTriggered = true;
      this._payoffElapsed = 0;
      this._lastPayoffDominant = dominant;
      if (dominant === VOLATILE_GASSES_TYPE) {
        this._bannerMesh.visible = true;
      }
      playPayoffChime(this._audioListener, this.scene, this._scratchCenter, 420);
    }
    this._payoffElapsed += delta;

    if (dominant === VOLATILE_GASSES_TYPE && this._bannerMesh.visible) {
      // Recomputed every frame from the LIVE planet center/reach/radiusScale
      // (all passed in fresh each call), not just once at trigger time — the
      // banner used to freeze at its trigger-time world position, visibly
      // detaching from the planet as it kept moving (following the player,
      // then receding for Launch) instead of staying anchored to "the
      // earth." Standalone Mesh, not a DecorationSet child — its own
      // absolute BANNER_WIDTH/HEIGHT geometry and the fixed-meter offsets
      // below need radiusScale applied directly (same reasoning as
      // _updateBees).
      this._bannerMesh.scale.setScalar(radiusScale);
      this._scratchBannerPos
        .copy(this._scratchCenter)
        .addScaledVector(CROWD_CAP_DIRECTION, reach + 0.02 * radiusScale);
      const t = smoothstep(clamp01(this._payoffElapsed / BANNER_RISE_DURATION));
      this._bannerMesh.position.copy(this._scratchBannerPos);
      this._bannerMesh.position.y += BANNER_RISE_HEIGHT * radiusScale * t;
      this.camera.getWorldPosition(this._scratchBannerFace);
      this._scratchBannerFace.sub(this._bannerMesh.position).normalize();
      if (this._scratchBannerFace.lengthSq() > 0.0001) {
        this._bannerMesh.quaternion.setFromUnitVectors(this._zAxis, this._scratchBannerFace);
      }
    }
  }

  private _onCompletion(reach: number): void {
    const globals = getGlobals(this.world);

    // Universal payoff — every constellation's completion sends the crown
    // up, regardless of name, colored to match this playthrough's dominant
    // pebble type.
    const dominant = globals.dominantPebbleType.peek();
    // Rotated off CROWD_CAP_DIRECTION, away from the player along the same
    // tangent the crowd's own semicircle scatter uses (see sphere-scatter.ts's
    // scatterSemicircleAroundPoint — _beeTangentA is that same "away from
    // camera" direction, already computed once in _buildBees()), rather than
    // dead-center — dead-center is exactly the King's own live standing
    // point (same center+CROWD_CAP_DIRECTION*reach formula _updateSet uses
    // for him), so the crown used to visibly rise right out of/through his
    // body instead of the ground behind him.
    const behindAngle = (14 * Math.PI) / 180;
    this._scratchNormal
      .copy(CROWD_CAP_DIRECTION)
      .multiplyScalar(Math.cos(behindAngle))
      .addScaledVector(this._beeTangentA, Math.sin(behindAngle))
      .normalize();
    this._scratchCrownOrigin.copy(this._scratchCenter).addScaledVector(this._scratchNormal, reach);
    this._crown.trigger(this._scratchCrownOrigin, PEBBLE_TYPES[dominant].color);

    // Crown's king-death vignette no longer fires here — see
    // _updateGasVignette, gated on FateEventSystem's own Ambient beat.
  }

  private _resetAll(): void {
    for (const set of [this._king, this._graveyard, this._graveyardBench]) {
      set.scale.fill(0);
      for (const group of set.groups) group.visible = false;
    }
    this._organicScene.scale.fill(0);
    this._kingBody.visible = true;
    this._kingBody.rotation.x = 0;
    this._pendingCollapse = null;
    this._gasVignetteTriggered = false;
    this._gasHornTriggered = false;
    // Undo _triggerKingDeath's animation swap so a fresh loop shows the king
    // alive/breathing again instead of frozen on DyingBackwards' last frame.
    if (this._kingDyingAction) {
      this._kingDyingAction.stop();
      this._kingDyingAction = null;
    }
    if (this._kingIdleAction) {
      this._kingIdleAction.reset();
      this._kingIdleAction.play();
    }
    this._crown.reset();
    this._crownWasAttached = false;
    this._wasComplete = false;
    this._payoffTriggered = false;
    this._payoffElapsed = 0;
    this._lastPayoffDominant = -1;
    this._bannerMesh.visible = false;

    getGlobals(this.world).crownLanded.value = false;
    getGlobals(this.world).kingDeathComplete.value = false;
  }
}
