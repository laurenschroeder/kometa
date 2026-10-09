import {
  AdditiveBlending,
  AudioListener,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Entity,
  Group,
  Hovered,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  OctahedronGeometry,
  PlaneGeometry,
  Points,
  PokeInteractable,
  Pressed,
  ShaderMaterial,
  Vector3,
} from '@iwsdk/core';
import type { World } from '@iwsdk/core';
import { hexToRgb, STARDUST, UI_GOLD } from '../color/color-scheme.js';
import {
  centerAndNormalizeGeometryToUnitSize,
  convertZUpToYUp,
  FALLBACK_GEO,
  FALLBACK_MAT,
} from '../geometry/fbx-field-loader.js';
import { PERSON_BODY_COLOR } from '../geometry/animated-person.js';
import { randomUnitVector3 } from '../geometry/mesh-utils.js';
import { loadObjMeshGeometry } from '../geometry/obj-field-loader.js';
import { makeSparkleMaterial } from '../shaders/sparkle-material.js';
import { makeToonRimFlatMaterial, makeToonRimInstancedWigglyLiveRimMaterial } from '../shaders/toon-rim-material.js';
import { TwinkleSynth } from '../audio/twinkle-synth.js';
import { drawLabel } from '../textures/canvas-label.js';
import { getSharedAudioListener } from '../../vfx/audio/shared-audio-listener.js';

// Shared floating "poke and hold to fill" diamond button — the interaction
// model every player-facing menu in this game now uses (Start Menu's own
// Start/Achievements/Settings row, Settings' two toggles, the end-of-run
// choice) instead of ray-based click/hover. This experience gets handed
// between strangers at a festival, and a physical fingertip touch
// (PokeInteractable's own downRadius is ~2cm — the finger has to actually
// reach the surface, not just point a controller ray near it) is a much
// stronger accidental-trigger filter than raycasting ever was, which is why
// raycasting is no longer used anywhere in this project's player-facing UI.
export const DIAMOND_SIZE = 0.11;
export const CUBE_SPACING = 0.2;
export const CUBE_DISTANCE = 0.45;
export const CUBE_HEIGHT = -0.05;
// A single button pinned lower than the standard row (about 6 inches, 0.152 m)
// — still within reach but out of the way. Used by the achievements page's
// Back cube.
export const LOWER_CUBE_HEIGHT = CUBE_HEIGHT - 0.152;
const DEFAULT_HOLD_SECONDS = 0.7;
const FILL_MIN_SCALE = 0.16;
const FILL_MAX_SCALE = 0.92; // stays inside the wireframe outline
const FILL_BASE_OPACITY = 0.5;
const FILL_MAX_OPACITY = 1.0;
// 1/s exponential ease smoothing the visual toward the real (un-eased) hold
// ratio — an eased visual, un-eased trigger split, so the button always
// fires at exactly HOLD_SECONDS regardless of how the fill looks catching
// up to it.
const CHARGE_VISUAL_EASE_RATE = 8;
// 10% wider than the original 0.16 so longer labels (e.g. "Continue when
// Ready") fit — the label canvas is widened by the same factor (see
// LABEL_WIDTH_SCALE) so text isn't stretched.
const LABEL_WIDTH_SCALE = 1.265; // 1.1 widened another 15% — "Continue when Ready" still overflowed
const LABEL_WIDTH = 0.16 * LABEL_WIDTH_SCALE;
const LABEL_HEIGHT = 0.06;
const LABEL_GAP = 0.045; // above the diamond's own top vertex

// Stardust motes drawn around the diamond — same color/shader family as the
// Stardust phase's own ambient dust (see stardust-vfx-system.ts's
// STARDUST_COLOR/makeSparkleMaterial), reused here as this game's one
// "magic is happening" visual idiom rather than inventing a second one.
const STARDUST_COLOR: [number, number, number] = hexToRgb(STARDUST);
// Ambient shell: fades in on Hovered (finger closing in on the diamond),
// fades out otherwise. Same points double as the charge-up cluster — they
// draw inward toward center as a hold builds, then get hidden the instant a
// burst fires (see BURST_POINT_COUNT below) so the two effects never
// visually overlap.
const GLOW_POINT_COUNT = 16;
const GLOW_SHELL_RADIUS_MIN = 1.1; // x DIAMOND_SIZE
const GLOW_SHELL_RADIUS_MAX = 1.6;
const GLOW_CONVERGE_RADIUS = 0.15; // x DIAMOND_SIZE — how tight charge pulls them in
const GLOW_EASE_RATE = 6;
const GLOW_MAX_BRIGHT = 0.8;
const GLOW_POINT_SIZE = 0.01;
// One-shot radial burst on fire — a separate pool (not the ambient/converge
// shell above) since it needs to fully evacuate outward from empty space at
// the diamond's center rather than ease from wherever the ambient shell
// happened to be sitting. Exported (with BurstEffect below) so other
// "choice select" UI sharing this same charge-up idiom — e.g.
// PebbleChoiceBubbleSystem's continue bubble — can fire the exact same
// reaction instead of quietly completing with no payoff moment.
export const BURST_POINT_COUNT = 36;
export const BURST_DURATION = 0.55; // seconds
const BURST_SPEED_MIN = 0.6; // m/s
const BURST_SPEED_MAX = 1.3;
const BURST_DRAG_RATE = 2.2; // 1/s exponential velocity decay, same idiom as GatherableField's coast
const BURST_POINT_SIZE = 0.016;
// How long a caller should hold its own "just fired" report after the hold/
// dwell actually completes — the burst itself starts firing immediately
// (see BurstEffect.fire), but every existing caller (StartMenuSystem/
// EndRunMenuSystem, PebbleChoiceBubbleSystem) disables/hides/commits the
// instant it acts on "just fired", which used to cut the burst off
// practically before it started. This delay just postpones THAT action, not
// the burst — callers should keep counting it down even once input stops
// right after firing (see PokeCubeButton's own _pendingFireDelay for the
// pattern).
export const FIRE_ACTION_DELAY = BURST_DURATION * 0.75;

export interface PokeButtonOptions {
  holdSeconds?: number;
  // Uniform scale applied to the whole button (diamond, flourishes, label,
  // glow) — e.g. the wrist Continue button (ContinueButtonSystem) reuses this
  // prefab at a fraction of menu size.
  scale?: number;
}

// setLockedGlow(): how dim the fill/glow read while locked, at 0 and at 1
// (fully warmed) respectively — see PokeCubeButton.setLockedGlow.
const LOCKED_FILL_DIM_MIN = 0.25;
const LOCKED_FILL_DIM_MAX = 0.7;
const LOCKED_GLOW_MAX = 0.6;

// Lazily built once and shared by every PokeCubeButton in the game — one
// synth on the game-wide shared AudioListener (see shared-audio-listener.ts),
// not one per button.
// Exported so other choice-select UI sharing this same "magic" audio
// identity (e.g. PebbleChoiceBubbleSystem's own in-range chime) can reuse
// the exact same synth/listener instead of spinning up a second one.
let sharedTwinkleSynth: TwinkleSynth | null = null;
export function getSharedTwinkleSynth(world: World): TwinkleSynth {
  if (!sharedTwinkleSynth) {
    sharedTwinkleSynth = new TwinkleSynth();
    sharedTwinkleSynth.build(getSharedAudioListener(world), world.scene);
  }
  return sharedTwinkleSynth;
}

// Also shared across every button — plain color/blending config, no
// per-instance uniforms besides uTime (which every button's update() sets
// to its own running clock, harmless since it only drives a shared cosmetic
// twinkle phase, not per-button state).
let sharedGlowMaterial: ShaderMaterial | null = null;
function getSharedGlowMaterial(): ShaderMaterial {
  if (!sharedGlowMaterial) {
    sharedGlowMaterial = makeSparkleMaterial({ color: STARDUST_COLOR, blending: AdditiveBlending });
  }
  return sharedGlowMaterial;
}
// Exported (like getSharedGhostAccentMaterial) so any caller ticking its own
// BurstEffect — including PokeCubeButton itself and PebbleChoiceBubbleSystem
// — can keep this shared material's uTime fresh from its own running clock;
// harmless for two callers to both do it, same idiom the ghost material uses.
let sharedBurstMaterial: ShaderMaterial | null = null;
export function getSharedBurstMaterial(): ShaderMaterial {
  if (!sharedBurstMaterial) {
    sharedBurstMaterial = makeSparkleMaterial({ color: STARDUST_COLOR, blending: AdditiveBlending, spiky: true });
  }
  return sharedBurstMaterial;
}

// One-shot radial stardust burst + "catch" chime — the "fired" payoff every
// poke-and-hold button in this game plays, factored out of PokeCubeButton
// (which now just owns one as `this._burst`) so other charge-up UI sharing
// this same choice-select idiom (e.g. PebbleChoiceBubbleSystem's continue
// bubble) can fire the identical reaction instead of quietly completing.
export class BurstEffect {
  readonly points: Points;
  private _material: ShaderMaterial;
  private _vel: Vector3[] = [];
  private _active = false;
  private _elapsed = 0;

  constructor() {
    this._material = getSharedBurstMaterial();
    this.points = this._build();
  }

  get active(): boolean {
    return this._active;
  }

  private _build(): Points {
    const geo = new BufferGeometry();
    const positions = new Float32Array(BURST_POINT_COUNT * 3);
    const sizes = new Float32Array(BURST_POINT_COUNT);
    const brights = new Float32Array(BURST_POINT_COUNT);
    const phases = new Float32Array(BURST_POINT_COUNT);
    for (let i = 0; i < BURST_POINT_COUNT; i++) {
      const dir = randomUnitVector3();
      const speed = BURST_SPEED_MIN + Math.random() * (BURST_SPEED_MAX - BURST_SPEED_MIN);
      this._vel.push(dir.multiplyScalar(speed));
      sizes[i] = BURST_POINT_SIZE * (0.7 + Math.random() * 0.6);
      phases[i] = Math.random() * Math.PI * 2;
    }
    geo.setAttribute('position', new BufferAttribute(positions, 3));
    geo.setAttribute('aSize', new BufferAttribute(sizes, 1));
    geo.setAttribute('aBright', new BufferAttribute(brights, 1));
    geo.setAttribute('aPhase', new BufferAttribute(phases, 1));
    const points = new Points(geo, this._material);
    points.visible = false;
    return points;
  }

  // Resets the pool to the given world position with fresh outward
  // velocities and plays the shared stardust "catch" chime there — call
  // whenever a hold/dwell completes, same moment PokeCubeButton's own
  // _fireBurst used to fire from.
  fire(world: World, worldPos: Vector3): void {
    this._active = true;
    this._elapsed = 0;

    const geo = this.points.geometry as BufferGeometry;
    const positions = geo.getAttribute('position') as BufferAttribute;
    const brights = geo.getAttribute('aBright') as BufferAttribute;
    for (let i = 0; i < BURST_POINT_COUNT; i++) {
      positions.setXYZ(i, 0, 0, 0);
      brights.setX(i, 1);
      const dir = randomUnitVector3();
      const speed = BURST_SPEED_MIN + Math.random() * (BURST_SPEED_MAX - BURST_SPEED_MIN);
      this._vel[i].copy(dir).multiplyScalar(speed);
    }
    positions.needsUpdate = true;
    brights.needsUpdate = true;
    this.points.visible = true;

    getSharedTwinkleSynth(world).playCatch(worldPos, 2.0);
  }

  // Call every frame while `active` — advances/fades the burst and hides it
  // again once BURST_DURATION elapses.
  update(delta: number): void {
    if (!this._active) return;
    this._elapsed += delta;
    const geo = this.points.geometry as BufferGeometry;
    const positions = geo.getAttribute('position') as BufferAttribute;
    const brights = geo.getAttribute('aBright') as BufferAttribute;
    const fadeT = Math.min(1, this._elapsed / BURST_DURATION);
    const fade = 1 - fadeT * fadeT; // ease-out fade, matches the outward-drag deceleration
    const drag = Math.exp(-BURST_DRAG_RATE * delta);
    for (let i = 0; i < BURST_POINT_COUNT; i++) {
      const vel = this._vel[i];
      positions.setXYZ(
        i,
        positions.getX(i) + vel.x * delta,
        positions.getY(i) + vel.y * delta,
        positions.getZ(i) + vel.z * delta,
      );
      vel.multiplyScalar(drag);
      brights.setX(i, fade);
    }
    positions.needsUpdate = true;
    brights.needsUpdate = true;

    if (this._elapsed >= BURST_DURATION) {
      this._active = false;
      this.points.visible = false;
    }
  }

  reset(): void {
    this._active = false;
    this._elapsed = 0;
    this.points.visible = false;
  }
}

// Real modeled ornament — a flat decorative relief, used as the diamond's
// own front-face dressing: one copy stands for the TOP half (unrotated) and
// a second, rotated 180° about local Z (a true mirror through center, not
// just a translate), stands for the BOTTOM half, so the pair reads as one
// symmetric diamond-shaped flourish frame rather than a single lopsided
// ornament. Two such pairs exist per button (see _buildFlourishPanel) — one
// in front of the charging fill diamond, one further behind it — "two
// diamond panels" sandwiching the fill between them.
const FLOURISH_OBJ_URL = '/medium/flourish.obj';
const FLOURISH_OBJ_NAME = 'flourish';
// This pack reads Z-up when parsed raw (its Y extent is far thinner than its
// X/Z extents — the shallow-relief "thickness" axis — consistent with every
// other Blender Z-up pack in this codebase), so convertZUpToYUp's usual -90°
// about X is the starting-guess correction here, same as
// planet-growth-pool.ts's plant packs. NOT independently confirmed in
// headset yet — flag if it reads sideways/upside-down and try rotateX180
// instead (see that function's own comment for how crownForKing.fbx/
// skull.obj needed the full 180° instead of this file's usual -90°).
function normalizeFlourishGeometry(geo: BufferGeometry): void {
  convertZUpToYUp(geo);
  centerAndNormalizeGeometryToUnitSize(geo);
}
let flourishGeometryPromise: Promise<BufferGeometry | null> | null = null;
function loadFlourishGeometry(): Promise<BufferGeometry | null> {
  if (!flourishGeometryPromise) {
    flourishGeometryPromise = loadObjMeshGeometry(FLOURISH_OBJ_URL, FLOURISH_OBJ_NAME, normalizeFlourishGeometry);
  }
  return flourishGeometryPromise;
}
// Shared across every button's flourish ornament — same fixed black body
// color every human figure in this game uses (PERSON_BODY_COLOR), same
// toon-rim shader, so the button's accent props read as part of the same
// visual language as the crowd/King/bench rather than a UI-only style.
// Exported so other "choice" UI (e.g. PebbleChoiceBubbleSystem) can share the
// exact same shader instance for its own flourish halves rather than
// building a second identical one.
let sharedAccentMaterial: ShaderMaterial | null = null;
export function getSharedAccentMaterial(): ShaderMaterial {
  if (!sharedAccentMaterial) {
    sharedAccentMaterial = makeToonRimFlatMaterial(PERSON_BODY_COLOR);
  }
  return sharedAccentMaterial;
}

// The diamond's own outline shape (see the constructor) uses this instead —
// same black identity, but through makeToonRimInstancedWigglyLiveRimMaterial
// ("the ghost material": the exact shader/tuning fate-event-vfx-system.ts's
// Soul ghosts use, see its own _buildGhostMeshes — same amplitude/opacity)
// rather than the flat opaque accent material above, so the diamond itself
// reads as translucent and gently alive instead of a solid black shape.
// Requires an InstancedMesh (even at count=1 — same "one real instance,
// shared shader" idiom _buildGhostMeshes uses) since the wiggle/tint
// uniforms this shader reads are instance attributes, not plain uniforms.
const IDENTITY_MAT4 = new Matrix4();
// Exported so other "choice" UI (e.g. PebbleChoiceBubbleSystem's own ghost-
// diamond frame around its comet head, via buildGhostDiamondMesh below) can
// share the exact same shader instance and keep its uTime fresh themselves.
let sharedGhostAccentMaterial: ShaderMaterial | null = null;
export function getSharedGhostAccentMaterial(): ShaderMaterial {
  if (!sharedGhostAccentMaterial) {
    sharedGhostAccentMaterial = makeToonRimInstancedWigglyLiveRimMaterial(
      { bodyColorDark: PERSON_BODY_COLOR, bodyColorLight: PERSON_BODY_COLOR, rimColor: [1, 1, 1] },
      { amplitude: 0.19, opacity: 0.55 },
    );
  }
  return sharedGhostAccentMaterial;
}
// Stamps the fixed (never-animated-per-instance) attributes
// makeToonRimInstancedWigglyLiveRimMaterial's shader reads onto a
// single-instance geometry — same values fate-event-vfx-system.ts's
// stampSoulIslandInstanceAttrs uses for its own ghosts, except aWigglePhase
// (randomized per call so multiple diamonds sharing the one material above
// don't all wiggle in lockstep).
function stampGhostInstanceAttrs(geo: BufferGeometry): void {
  geo.setAttribute('aBright', new InstancedBufferAttribute(new Float32Array([0.7]), 1));
  geo.setAttribute('aTint', new InstancedBufferAttribute(new Float32Array(3), 3));
  geo.setAttribute('aTinted', new InstancedBufferAttribute(new Float32Array([0]), 1));
  geo.setAttribute('aWigglePhase', new InstancedBufferAttribute(new Float32Array([Math.random()]), 1));
}

// One ghost-translucent diamond (see getSharedGhostAccentMaterial's own
// comment), `radius` matching OctahedronGeometry's own radius param
// directly — for a caller that wants the exact same diamond-frame look this
// button's own outline uses but at its own size (e.g.
// PebbleChoiceBubbleSystem's frame around its comet head).
export function buildGhostDiamondMesh(radius: number): InstancedMesh {
  const geo = new OctahedronGeometry(radius, 0);
  stampGhostInstanceAttrs(geo);
  const mesh = new InstancedMesh(geo, getSharedGhostAccentMaterial(), 1);
  mesh.setMatrixAt(0, IDENTITY_MAT4);
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false;
  return mesh;
}

// X/Y aspect ratio baked into flourish.obj by normalizeFlourishGeometry
// above (measured directly from the source file: X range ~179, Y range
// ~103 once Z-up-corrected) — lets a caller pick `scale` from a desired
// on-screen WIDTH directly (see buildFlourishMesh) instead of re-deriving
// this ratio itself.
const FLOURISH_ASPECT_X = 1.74;
export function flourishScaleForWidth(width: number): number {
  return width / FLOURISH_ASPECT_X;
}

// One flourish half — `mirrored` rotates it 180° about local Z (a true
// mirror through its own center, not just a reposition), for the BOTTOM half
// of a symmetric pair (see poke-button's own top-of-file comment on the
// TOP/BOTTOM convention). Starts on FALLBACK_GEO/FALLBACK_MAT (this
// codebase's usual "missing asset" magenta placeholder), swapped in place
// for the real geometry/material the moment (if ever) loadFlourishGeometry
// resolves — same "instant placeholder, upgrade in place" idiom as
// earth-situations-vfx-system.ts's _buildCrownProp. Caller positions the
// returned mesh (this function only builds+orients it, doesn't place it —
// same division of responsibility as buildPlaceholderPerson/
// buildOrganicGeometry).
export function buildFlourishMesh(scale: number, mirrored: boolean): Mesh {
  const mesh = new Mesh(FALLBACK_GEO, FALLBACK_MAT);
  mesh.scale.setScalar(scale);
  if (mirrored) mesh.rotation.z = Math.PI;
  loadFlourishGeometry().then((geo) => {
    if (!geo) return;
    mesh.geometry = geo;
    mesh.material = getSharedAccentMaterial();
  });
  return mesh;
}

// Target on-screen WIDTH for the button's own flourish halves — roughly
// spans the diamond's own width (DIAMOND_SIZE * 0.62 is the underlying
// OctahedronGeometry's radius, i.e. half its front-face diagonal, so *2 is
// the full width) with the ornament flourishing a bit past the gem's own
// silhouette, matching the name. Starting guess; tune visually in-headset
// once the real model resolves.
const FLOURISH_SCALE = flourishScaleForWidth(DIAMOND_SIZE * 0.62 * 2 * 1.15);
// Front/back layer depth offsets (local Z) either side of the charging fill
// diamond at z=0 — "front" is toward the player, "back" further away. Sign
// assumes local +Z faces the player (three.js's usual "camera looks down
// -Z" convention applied to this button's own unrotated local space); flip
// both if the front panel reads as behind the fill once actually seen
// in-headset.
const FLOURISH_FRONT_Z = DIAMOND_SIZE * 0.22;
const FLOURISH_BACK_Z = -DIAMOND_SIZE * 0.4;

// Centers `count` cubes CUBE_SPACING apart around local x=0 — the shared
// layout math every cube row (Start Menu's main/achievements/settings rows,
// EndRunMenuSystem's choice row) uses so spacing stays visually consistent
// everywhere.
export function cubeRowOffsets(count: number): number[] {
  const offsets: number[] = [];
  for (let i = 0; i < count; i++) offsets.push((i - (count - 1) / 2) * CUBE_SPACING);
  return offsets;
}

// One floating diamond button, parented under a caller-supplied entity (a
// Follower-driven "menu root" — see StartMenuSystem/EndRunMenuSystem) so a
// whole row shares one Follower computation instead of each button
// computing its own. Needs its OWN entity, not a shared one, because
// PokeInteractable's BVH hit-testing covers an entity's whole child
// subtree — sharing one entity across several buttons would make poking
// ANY of them register as Pressed on all of them at once.
export class PokeCubeButton {
  readonly entity: Entity;
  readonly group: Group;
  private _world: World;
  private _fillMesh: Mesh;
  private _fillMaterial: MeshBasicMaterial;
  private _labelMesh: Mesh;
  private _labelMaterial: MeshBasicMaterial;
  private _baseColor: Color;
  private _chargedColor: Color;
  private _holdSeconds: number;
  private _holdElapsed = 0;
  private _chargeVisual = 0;
  private _fired = false;
  // >0 while the "just fired" report to the caller is being held back so
  // the burst gets a moment on screen first — see FIRE_ACTION_DELAY's own
  // comment. Deliberately separate from _fired/_holdElapsed, which reset the
  // instant the finger lifts (this keeps counting down regardless).
  private _pendingFireDelay = 0;
  private _enabled = true;
  // null = normal (unlocked) look; 0-1 = locked and dim, warming toward 1.
  private _lockedGlow: number | null = null;
  private _time = 0;

  // Ambient glow / charge-converge shell.
  private _glowPoints: Points;
  private _glowMaterial: ShaderMaterial;
  private _glowBaseDir: Vector3[] = [];
  private _glowBright: Float32Array;
  private _glowVisual = 0;

  // One-shot burst pool.
  private _burst: BurstEffect;

  private _scratchWorldPos = new Vector3();

  constructor(
    world: World,
    parent: Entity,
    label: string,
    localOffset: [number, number, number],
    options?: PokeButtonOptions,
  ) {
    this._world = world;
    this._holdSeconds = options?.holdSeconds ?? DEFAULT_HOLD_SECONDS;
    // Build the shared fire chime now (buttons are constructed during
    // world setup, behind the loading screen) rather than lazily on the
    // first fire — its reverb impulse is generated sample-by-sample in JS,
    // which profiled as a visible hitch on the very first poke.
    getSharedTwinkleSynth(world);

    const group = new Group();
    group.position.set(...localOffset);
    if (options?.scale !== undefined) group.scale.setScalar(options.scale);
    this.group = group;
    this.entity = world.createTransformEntity(group, parent);
    this.entity.addComponent(PokeInteractable);

    // Gold now, not the old plain UI-blue (0x3f7fff, matched to
    // ui/*.uikitml's since-removed .dwell-fill CSS) — matches the flourish
    // ornamentation below (also UI_GOLD) so the charging square and its
    // decorative frame read as one consistent gold identity.
    this._baseColor = new Color(UI_GOLD);
    this._chargedColor = new Color(0xffffff);

    // Faceted diamond (an 8-face octahedron/bipyramid) — replaces the old
    // plain cube per the game's "poetic, minimal, organic" visual direction;
    // a gem/crystal shape reads much closer to that than a box. Translucent
    // black "ghost material" now (see getSharedGhostAccentMaterial's own
    // comment) instead of the old plain white wireframe MeshBasicMaterial or
    // the flat opaque accent material.
    group.add(buildGhostDiamondMesh(DIAMOND_SIZE * 0.62));

    this._fillMaterial = new MeshBasicMaterial({
      color: this._baseColor.clone(),
      transparent: true,
      opacity: FILL_BASE_OPACITY,
    });
    this._fillMesh = new Mesh(new OctahedronGeometry(DIAMOND_SIZE * 0.62, 0), this._fillMaterial);
    this._fillMesh.scale.setScalar(FILL_MIN_SCALE);
    group.add(this._fillMesh);

    // Two flourish-built diamond panels sandwiching the fill mesh above —
    // see FLOURISH_FRONT_Z/FLOURISH_BACK_Z's own comment for the depth
    // reasoning.
    group.add(this._buildFlourishPanel(FLOURISH_FRONT_Z));
    group.add(this._buildFlourishPanel(FLOURISH_BACK_Z));

    // No per-frame billboarding — every caller parents this under a root
    // that already faces the player via FollowBehavior.FaceTarget, so a
    // label at local identity rotation inherits that automatically.
    // forceSinglePass: three otherwise draws transparent DoubleSide materials
    // in two passes, flagging needsUpdate twice per object per frame — a full
    // program lookup each time (measured on Quest as ~5MB/s of garbage across
    // the game's flat label/billboard planes). A flat plane gains nothing
    // from the back-then-front pass split.
    this._labelMaterial = new MeshBasicMaterial({
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      forceSinglePass: true,
    });
    this._labelMesh = new Mesh(new PlaneGeometry(LABEL_WIDTH, LABEL_HEIGHT), this._labelMaterial);
    this._labelMesh.position.set(0, DIAMOND_SIZE / 2 + LABEL_GAP, 0);
    group.add(this._labelMesh);
    this.setLabel(label);

    this._glowMaterial = getSharedGlowMaterial();
    this._glowBright = new Float32Array(GLOW_POINT_COUNT);
    this._glowPoints = this._buildGlowPoints();
    group.add(this._glowPoints);

    this._burst = new BurstEffect();
    group.add(this._burst.points);

    // IWSDK's InputSystem builds a BVH for every mesh under an interactable
    // the frame it qualifies — skipped for geometry that already has one.
    // PokeInteractable was added above while the group was still empty, so
    // the real build used to land on the first setEnabled(true) mid-game
    // (measured on Quest: 22ms, the Continue button's unlock). Paid here,
    // behind the loading screen, instead.
    group.traverse((child) => {
      const geometry = (child as Mesh).isMesh ? (child as Mesh).geometry : null;
      if (geometry && !geometry.boundsTree) geometry.computeBoundsTree();
    });
  }

  // One diamond panel: two flourish halves (see buildFlourishMesh) at a
  // shared depth (`zOffset`), placed symmetrically above/below local y=0 so
  // the pair reads as one diamond-shaped ornament.
  private _buildFlourishPanel(zOffset: number): Group {
    const panel = new Group();
    panel.position.z = zOffset;

    const top = buildFlourishMesh(FLOURISH_SCALE, false);
    top.position.y = FLOURISH_SCALE * 0.5;
    panel.add(top);

    const bottom = buildFlourishMesh(FLOURISH_SCALE, true);
    bottom.position.y = -FLOURISH_SCALE * 0.5;
    panel.add(bottom);

    return panel;
  }

  private _buildGlowPoints(): Points {
    const geo = new BufferGeometry();
    const positions = new Float32Array(GLOW_POINT_COUNT * 3);
    const sizes = new Float32Array(GLOW_POINT_COUNT);
    const phases = new Float32Array(GLOW_POINT_COUNT);
    for (let i = 0; i < GLOW_POINT_COUNT; i++) {
      const dir = randomUnitVector3();
      this._glowBaseDir.push(dir);
      const r = (GLOW_SHELL_RADIUS_MIN + Math.random() * (GLOW_SHELL_RADIUS_MAX - GLOW_SHELL_RADIUS_MIN)) * DIAMOND_SIZE;
      positions[i * 3] = dir.x * r;
      positions[i * 3 + 1] = dir.y * r;
      positions[i * 3 + 2] = dir.z * r;
      sizes[i] = GLOW_POINT_SIZE * (0.7 + Math.random() * 0.6);
      phases[i] = Math.random() * Math.PI * 2;
    }
    geo.setAttribute('position', new BufferAttribute(positions, 3));
    geo.setAttribute('aSize', new BufferAttribute(sizes, 1));
    geo.setAttribute('aBright', new BufferAttribute(this._glowBright, 1));
    geo.setAttribute('aPhase', new BufferAttribute(phases, 1));
    const points = new Points(geo, this._glowMaterial);
    points.visible = false;
    return points;
  }

  // Redraws this button's own label texture — for buttons whose text
  // reflects live state (e.g. Settings' "Passthrough: Off"/"On" toggles)
  // rather than a fixed action name. Square corners (radius 0) — this
  // template's own diamond/flourish shapes are all pure 90°, so the label
  // card matches instead of using drawLabel's default rounded look.
  setLabel(text: string): void {
    const oldTexture = this._labelMaterial.map;
    this._labelMaterial.map = drawLabel(text, 0, LABEL_WIDTH_SCALE);
    this._labelMaterial.needsUpdate = true;
    oldTexture?.dispose();
  }

  // Call every frame. pokeReady gates whether a hold can even start
  // accumulating (e.g. a caller's own settling guard — see
  // StartMenuSystem's IGNORE_POKE_SECONDS). Returns true once, FIRE_ACTION_
  // DELAY seconds after the hold actually completes (see that constant's own
  // comment) — every existing caller disables/hides this button (or its
  // whole row) the instant it sees true, so this delay is what lets the
  // burst actually read on screen before that happens.
  update(delta: number, pokeReady: boolean): boolean {
    this._time += delta;
    this._glowMaterial.uniforms.uTime.value = this._time;
    getSharedBurstMaterial().uniforms.uTime.value = this._time;
    getSharedGhostAccentMaterial().uniforms.uTime.value = this._time;

    const pressed = this._enabled && pokeReady && this.entity.hasComponent(Pressed);
    if (pressed) {
      this._holdElapsed += delta;
    } else {
      this._holdElapsed = 0;
      this._fired = false;
    }

    const target = Math.min(1, this._holdElapsed / this._holdSeconds);
    const pull = 1 - Math.exp(-CHARGE_VISUAL_EASE_RATE * delta);
    this._chargeVisual += (target - this._chargeVisual) * pull;

    this._fillMesh.scale.setScalar(FILL_MIN_SCALE + this._chargeVisual * (FILL_MAX_SCALE - FILL_MIN_SCALE));
    this._fillMaterial.color.copy(this._baseColor).lerp(this._chargedColor, this._chargeVisual);
    const lockedDim =
      this._lockedGlow === null
        ? 1
        : LOCKED_FILL_DIM_MIN + this._lockedGlow * (LOCKED_FILL_DIM_MAX - LOCKED_FILL_DIM_MIN);
    this._fillMaterial.opacity =
      (FILL_BASE_OPACITY + this._chargeVisual * (FILL_MAX_OPACITY - FILL_BASE_OPACITY)) * lockedDim;

    // Stardust glow: eases in on Hovered (finger closing in) OR while
    // actively charging, whichever calls for more — charging always wins
    // once it exceeds plain hover-proximity brightness, so the buildup
    // reads as a continuation of the same glow rather than a separate cue.
    const hovered = this._enabled && this.entity.hasComponent(Hovered);
    const lockedGlowTarget = this._lockedGlow === null ? 0 : this._lockedGlow * LOCKED_GLOW_MAX;
    const glowTarget = Math.max(hovered ? 1 : 0, this._chargeVisual, lockedGlowTarget);
    this._glowVisual += (glowTarget - this._glowVisual) * (1 - Math.exp(-GLOW_EASE_RATE * delta));
    this._updateGlowPoints();

    if (this._burst.active) this._burst.update(delta);

    if (!this._fired && this._enabled && pokeReady && this._holdElapsed >= this._holdSeconds) {
      this._fired = true;
      this._glowPoints.visible = false;
      this.group.getWorldPosition(this._scratchWorldPos);
      this._burst.fire(this._world, this._scratchWorldPos);
      this._pendingFireDelay = FIRE_ACTION_DELAY;
    }

    if (this._pendingFireDelay > 0) {
      this._pendingFireDelay -= delta;
      if (this._pendingFireDelay <= 0) {
        this._pendingFireDelay = 0;
        return true;
      }
    }
    return false;
  }

  private _updateGlowPoints(): void {
    const visible = this._glowVisual > 0.01;
    this._glowPoints.visible = visible && !this._burst.active;
    if (!visible) return;

    const positions = (this._glowPoints.geometry as BufferGeometry).getAttribute('position') as BufferAttribute;
    // Converge from the idle shell radius down toward GLOW_CONVERGE_RADIUS
    // as charge builds — same "pull toward a point" idiom as
    // GatherableField's own exponential attract-ease, just applied to a
    // radius instead of a position.
    const radiusT = this._chargeVisual; // 0 = idle shell, 1 = fully converged
    for (let i = 0; i < GLOW_POINT_COUNT; i++) {
      const dir = this._glowBaseDir[i];
      const shellR =
        (GLOW_SHELL_RADIUS_MIN + ((i / GLOW_POINT_COUNT) * (GLOW_SHELL_RADIUS_MAX - GLOW_SHELL_RADIUS_MIN))) *
        DIAMOND_SIZE;
      const r = shellR + (GLOW_CONVERGE_RADIUS * DIAMOND_SIZE - shellR) * radiusT;
      positions.setXYZ(i, dir.x * r, dir.y * r, dir.z * r);
      this._glowBright[i] = GLOW_MAX_BRIGHT * this._glowVisual;
    }
    positions.needsUpdate = true;
    (this._glowPoints.geometry as BufferGeometry).getAttribute('aBright').needsUpdate = true;
  }

  // Clears hold/charge state and snaps the fill back to its resting
  // visual — call when re-showing a button after it (or its whole menu)
  // was hidden, so a stale hold from before doesn't carry over or
  // instantly re-fire the moment it's visible/pokeable again.
  reset(): void {
    this._holdElapsed = 0;
    this._chargeVisual = 0;
    this._fired = false;
    this._pendingFireDelay = 0;
    this._fillMesh.scale.setScalar(FILL_MIN_SCALE);
    this._fillMaterial.opacity = FILL_BASE_OPACITY;
    this._fillMaterial.color.copy(this._baseColor);
    this._glowVisual = 0;
    this._glowPoints.visible = false;
    this._burst.reset();
  }

  // Overrides the resting fill color (gold by default). Pass null to restore
  // gold. Takes effect on the next update() (or reset()).
  setBaseColor(hex: string | null): void {
    this._baseColor.set(hex ?? UI_GOLD);
  }

  // Locked look: a dim fill and a faint ambient glow that warms as `t01`
  // approaches 1 (a "something is about to happen" cue, no bar/numbers).
  // Pass null to return to the normal look. Purely visual — pair with
  // setEnabled() to actually gate poking.
  setLockedGlow(t01: number | null): void {
    this._lockedGlow = t01 === null ? null : Math.min(1, Math.max(0, t01));
  }

  // Adds/removes PokeInteractable to match — mirrors how this codebase used
  // to add/remove RayInteractable alongside a panel's own visibility, so an
  // invisible/inactive button never keeps hit-testing.
  setEnabled(enabled: boolean): void {
    if (enabled === this._enabled) return;
    this._enabled = enabled;
    if (enabled) {
      if (!this.entity.hasComponent(PokeInteractable)) this.entity.addComponent(PokeInteractable);
    } else {
      if (this.entity.hasComponent(PokeInteractable)) this.entity.removeComponent(PokeInteractable);
      this.reset();
    }
  }
}
