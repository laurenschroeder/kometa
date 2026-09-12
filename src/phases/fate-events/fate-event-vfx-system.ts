import {
  AdditiveBlending,
  AudioListener,
  BufferGeometry,
  CanvasTexture,
  Color,
  createSystem,
  DoubleSide,
  Entity,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  Vector3,
} from '@iwsdk/core';
import { CometBody } from '../../comet/comet-body-component.js';
import { CometTrail } from '../../comet/comet-trail-component.js';
import { CometTrailSystem } from '../../comet/comet-trail-system.js';
import { GatherableField, GatherState } from '../../comet/gatherable-field.js';
import { getGlobals } from '../../core/globals.js';
import { Phase } from '../../core/phase.js';
import { playPayoffChime } from '../../vfx/audio/payoff-chime.js';
import { PebbleSynth } from '../../vfx/audio/pebble-synth.js';
import { buildIslandPerson, buildPlaceholderPerson, PERSON_HEIGHT } from '../../vfx/geometry/placeholder-person.js';
import { loadObjLargestIslands } from '../../vfx/geometry/obj-field-loader.js';
import { placePlanets } from '../../vfx/geometry/weave-path.js';
import { sampleTrailOffset } from '../../vfx/particles/trail-sampler.js';
import { kSoulIslandMat } from '../../vfx/shaders/pebble-material.js';
import { makeToonRimFlatMaterial } from '../../vfx/shaders/toon-rim-material.js';
import { ConstellationsSystem } from '../constellations/constellations-system.js';
import { PlanetSeedingVfxSystem } from '../planet-seeding/planet-seeding-vfx-system.js';
import { PEBBLE_TYPES } from '../pebbles/pebble-type.js';
import { EXPLAIN_FIGURE_INDEX, FateBeat, FateEventSystem, NAMED_FIGURE_COUNT } from './fate-event-system.js';

const JUMP_FREQUENCY = 5; // Hz
const JUMP_AMPLITUDE = 0.045; // scaled with PERSON_HEIGHT's 2.2x bump
const BOB_EASE_RATE = 6; // 1/s exponential ease, same idiom as PlanetSeedingVfxSystem's coverage ease

// Bumped from 0.14/0.07 (canvas 256x128) — long dialogue lines routinely
// wrapped to more lines than the old canvas had height for, clipping the
// bottom (or top) of the text. Canvas keeps the same aspect ratio as the
// plane so text isn't stretched.
const BUBBLE_WIDTH = 0.2;
const BUBBLE_HEIGHT = 0.13;
const BUBBLE_GAP = 0.03;
// Fast catch-up ease on top of FateEventSystem's own analytic fade-in/hold/
// fade-out curve (see getBubbleOpacity()) — the curve already does the real
// fading; this just smooths the snap-to-0 the instant a hand leaves.
const BUBBLE_EASE_RATE = 8;
const BUBBLE_CANVAS_W = 384;
const BUBBLE_CANVAS_H = 250;
const BUBBLE_LINE_HEIGHT = 34;

const SOUL_DUST_TYPE = 0;
const ORGANIC_MATTER_TYPE = 1;
const VOLATILE_GASSES_TYPE = 2;

// isFateTransitionActive() defaults to false before the transition has ever
// been started (not just once it's finished) — since this system is
// always-on and update() runs from world boot, checking that alone would
// read as "already arrived" on frame 1, long before Constellations ever
// kicks the transition off. Gating the arrival check on having reached at
// least Constellations closes that gap for the normal flow; a dev-menu jump
// straight to Fate Events (skipping Constellations) still works because
// FateEventSystem.play() re-triggers the transition itself and this set
// also covers Phase.FateEvents.
const PLANET_ARRIVAL_ELIGIBLE_FROM = new Set<Phase>([
  Phase.Constellations,
  Phase.FateEvents,
  Phase.Launch,
  Phase.Finale,
]);

// Beat 4's Soul ghosts / Organic seeds are a Fate-Events-onward mechanic —
// unlike the crowd/decorations above (which progressively form during
// Constellations' own spin, well before Fate Events begins), these two
// GatherableFields shouldn't render at all until Fate Events actually
// starts (see _updateCollectibles's `show` argument below).
const COLLECTIBLE_VISIBLE_FROM = new Set<Phase>([Phase.FateEvents, Phase.Launch, Phase.Finale]);

// Same reasoning/same phase set as PLANET_ARRIVAL_ELIGIBLE_FROM, guarding
// getSpinProgress() the same way — Leg A (the spin transition) only ever
// starts once Constellations begins, so reading its progress before that is
// meaningless (and, worse, this system's own update() runs from world boot,
// where a naive read could misread "never started" as "already at 0").
const SPIN_ELIGIBLE_FROM = PLANET_ARRIVAL_ELIGIBLE_FROM;

// Each person's threshold (i/N) across the Leg A spin's 0-1 progress at
// which it starts scaling in, plus how much of that range its own scale-in
// takes — a STAGGER_WINDOW < 1/N would leave gaps where nobody is actively
// growing; this is comfortably wide so the population reads as continuously
// forming rather than popping in discrete batches.
const STAGGER_WINDOW = 0.3;
const PERSON_SURFACE_OFFSET = 0; // people sit exactly on the surface, no clearance needed

// Real sculpted mesh fragments used as placeholder "characters" (standing
// in for humans, plants, etc — final crowd art isn't ready yet) instead of
// buildPlaceholderPerson's primitive box-person shapes. Same source OBJ/
// island-extraction ArtTestVfxSystem's own "8 islands" variants use (see
// that file's GHOST_OBJ_URL comment for why this one export has ~293
// disconnected sculpted pieces merged into two untagged groups) — no
// per-piece names/tags exist for a tool like Spatial Editor to hand-pick a
// specific one ahead of time, so which island lands on each figure is
// chosen from ISLAND_PRIORITY below (its facing is still randomized — see
// buildIslandPerson's own comment).
const PERSON_OBJ_URL = '/medium/virtualpebble_2026-09-03_13-09-21.obj';
const PERSON_OBJ_GROUPS = ['Layer_1', 'Layer_2'];
const PERSON_OBJ_MAX_COUNT = 8;
const PERSON_BODY_RADIUS = PERSON_HEIGHT / 2;
// Visually inspected once (see loadObjLargestIslands — this ranks the same
// 8 islands the same way every time for this fixed source OBJ): index 1 is
// the one distinctly dog-shaped island (a splayed four-limb silhouette),
// 2 and 6 read as the most humanoid (a head-and-shoulders silhouette, and a
// tapered standing silhouette, respectively), the rest are simple blobs.
// Ordered so the crowd's early/named slots preferentially land on the
// recognizable shapes rather than a blob, with blobs filling out the
// remainder (also standing in for "plants" per this file's own comment
// above) — cycles via `% islands.length` in _swapToIslandPeople for however
// many people actually exist.
const ISLAND_PRIORITY = [2, 6, 1, 0, 3, 4, 5, 7];

// PebbleSynth.playPickup() normally scales its tone off swing speed — there's
// no equivalent for a person activating, so every activation just gets a
// fixed mid-range value for a consistent little "voice" blip.
const VOICE_BLIP_FIXED_SPEED = 1.1;

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function smoothstep(t: number): number {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
}

// Per-constellation "situation" animation layered on top of the base
// bob/bubble behavior above — see EarthSituationsVfxSystem for the
// non-person-attached half of this same feature (ambient decorations,
// ghost-rise/soul-pack mechanics, dialogue pairing). This stays here because
// it directly manipulates this system's own person arm meshes.
const POINT_UP_DURATION = 4; // seconds organic matter's "point at the comet" pose holds
const POINT_UP_EASE_RATE = 5;
// A fixed "arm raised up and forward" pose rather than a true bearing-aimed
// one — buildPlaceholderPerson's arms rotate around their own center (no
// shoulder pivot), so aiming precisely at the comet would look like the arm
// floating/clipping through the torso rather than a believable point.
const POINT_UP_ROTATION_X = -1.3;

// Gas's Beat 2.5 (Ambient) crowd reaction — see earth-situations-vfx-
// system.ts's own top comment for the full 0-10s sub-beat breakdown; this
// file owns the two sub-beats that manipulate person arm/orientation
// (watching/waving 0-3s, turning to face the player 8-10s), since it's what
// already owns those meshes. The 3-8s death itself is earth-situations-vfx-
// system.ts's own (it owns the king/tower/ghost).
const GAS_WATCH_DURATION = 3;
const GAS_WAVE_ROTATION_X = -0.9;
const GAS_WAVE_FREQ = 2; // Hz
const GAS_WAVE_AMPLITUDE = 0.35; // radians, side-to-side
const GAS_TURN_START = 8;
const GAS_TURN_DURATION = 2;
const GAS_TURN_ANGLE = Math.PI * 0.85; // most of a half-turn, world-space yaw

// Beat 4 — Gas's "symbol added to your tail" flourish. A simpler, inline
// version of the plan's own suggested standalone pooled class: with exactly
// N_PEOPLE (10) possible symbols and each person visitable only once, a
// person's own index already IS a stable, unique ring slot — no separate
// pool/allocation bookkeeping needed, just per-person flight state.
// SIZE bumped 5x and FLIGHT_DURATION correspondingly slowed (0.6 -> 3.0) —
// the original flight read as a blink-and-you-miss-it flick; RING_RADIUS
// widened to match so five-times-bigger icons don't overlap once attached.
const SKULL_FLIGHT_DURATION = 3.0;
const SKULL_RING_RADIUS = 0.12;
const SKULL_SIZE = 0.15;
const SKULL_CANVAS_SIZE = 96;

const enum SkullState {
  Hidden,
  Flying,
  Attached,
}

// Warm gold outline (vs. the crowd's default white rim) — the only visual
// cue that a figure is one of the two named ones, alongside the name shown
// in its speech bubble (see _drawBubbleText's caller).
const NAMED_RIM_COLOR: [number, number, number] = [1, 0.85, 0.45];

const N_FIRE_QUADS = 8;
const FIRE_RING_RADIUS = 0.4;
const FIRE_RING_Y_OFFSET = -0.15; // below the planet's lowest point
const FIRE_QUAD_W = 0.15;
const FIRE_QUAD_H = 0.2;
const FIRE_FLICKER_FREQ = 3;
const FIRE_BOB_FREQ = 0.8;
const FIRE_BOB_AMP = 0.03;
const FIRE_CANVAS_SIZE = 128;

// Beat 4's Soul ghosts / Organic seeds — both rendered as a handful of
// small glowing spheres (placeholder fidelity, same "simple primitive"
// treatment as everything else in this phase) driven by FateEventSystem's
// own GatherableField instances (see getGraveyardField/getSeedField).
// Free/Attracting particles sit at the field's own live positions; Captured
// ones ride the comet's trail like every other gathered thing in this
// codebase (see trail-sampler.ts). Soul's own Beat 5 payoff ("ghosts dance
// together in your tail") is layered onto the captured ones' trail position
// here too, once FateEventSystem enters FateBeat.Payoff.
// Bumped from 0.025/0.012 — at the old size these were nearly impossible to
// spot scattered across the graveyard/organic cap's actual physical extent
// (PLANET_RADIUS=1.4, CAP_HALF_ANGLE~34-40°  a roughly meter-wide region),
// especially buried among ~28-30 similarly small static decorations; the
// Beat 4 quest read as invisible/broken rather than just small. Paired with
// COLLECTIBLE_PULSE below so the still-uncaptured ones visibly stand out
// from the static scenery around them instead of just being bigger dots.
const GHOST_SIZE = 0.045;
// Ghost spheres render with kSoulIslandMat itself (see _buildGhostMeshes)
// instead of their own flat color constant now — the exact same translucent
// wiggly blue material real soul-dust pebbles use (pebble-material.ts's
// SOUL_ISLAND_PALETTE), so Beat 4's collectibles read as literally made of
// soul dust rather than a separately-tuned glow.
const IDENTITY_MAT4 = new Matrix4();
const SEED_SIZE = 0.035;
const SEED_COLOR: [number, number, number] = [0.55, 0.4, 0.22];
const COLLECTIBLE_PULSE_FREQ = 1.2; // Hz — "come find me" glow, Free/Attracting only
const COLLECTIBLE_PULSE_AMPLITUDE = 0.2; // fractional size swing
const DANCE_FREQ = 1.4; // Hz
const DANCE_AMPLITUDE = 0.025; // meters, in camera-right/up space

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (current && ctx.measureText(test).width > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function buildFireTexture(): CanvasTexture {
  const s = FIRE_CANVAS_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = s;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(s / 2, s * 0.6, 0, s / 2, s * 0.6, s / 2);
  gradient.addColorStop(0, 'rgba(255, 240, 180, 0.95)');
  gradient.addColorStop(0.4, 'rgba(255, 140, 40, 0.85)');
  gradient.addColorStop(0.75, 'rgba(200, 30, 10, 0.4)');
  gradient.addColorStop(1, 'rgba(200, 30, 10, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, s, s);
  return new CanvasTexture(canvas);
}

function buildSkullTexture(): CanvasTexture {
  const s = SKULL_CANVAS_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = s;
  const ctx = canvas.getContext('2d')!;
  ctx.font = `${s * 0.8}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('☠', s / 2, s / 2 + s * 0.05);
  return new CanvasTexture(canvas);
}

// Renders FateEventSystem's simulation state: the big planet's N
// placeholder people (bobbing when their proximity-triggered "active" state
// is on), their per-person speech bubbles (canvas-texture quads,
// billboarded toward the camera, redrawn only when their dialogue line
// actually changes), Beat 3's single forced explainer line, Beat 4's
// per-type collectible flourish (Gas's skull symbols, Soul's ghosts/
// Organic's seeds), and — only when the dominant type was volatile gasses —
// a small ring of ambient flame quads below the planet. Always-on and
// self-gated via gamePhase (like ConstellationsVfxSystem/
// PlanetSeedingVfxSystem), NOT director-managed: the civilization now forms
// progressively DURING Leg A (the Seeding->Constellations spin transition —
// see PlanetSeedingVfxSystem.getSpinProgress(), read in update()), fully
// formed by the time the spin stops and well before Constellations' own
// gameplay is won — so this system's own visibility can't be tied to Fate
// Events' play()/stop() the way it used to be. People/bubbles/fire also
// track the planet's LIVE position/radius every frame (not a fixed baked
// layout) so they correctly follow through Leg B's later zoom into Fate
// Events too. FateEventSystem itself stays director-managed — its
// proximity/dialogue simulation only runs during Phase.FateEvents, same as
// always.
export class FateEventVfxSystem extends createSystem({
  // CometBody only (no HandAnchor) — Beat 4/5's skull symbols and dancing
  // ghosts need to keep tracking the comet past Orbital Launch's detach,
  // which strips HandAnchor from the entity (see earth-situations-vfx-
  // system.ts's own matching comment on this exact bug).
  comets: { required: [CometBody] },
}) {
  private _fateEvents!: FateEventSystem;
  private _planetSeeding!: PlanetSeedingVfxSystem;
  private _constellations!: ConstellationsSystem;
  private _trailSystem!: CometTrailSystem;
  // Fire stays hidden until PlanetSeedingVfxSystem's Leg B (the final
  // grow/zoom-in — see planet-fate-transition.ts) finishes bringing the
  // planet to its true Fate Events PLANET_CENTER/PLANET_RADIUS — revealing
  // it earlier would show fire around a planet that hasn't visually arrived
  // at its final interaction size/position yet. Renamed from
  // _revealedAfterTransition since it now also gates fire, independent of
  // the people-forming timing (see SPIN_ELIGIBLE_FROM/getSpinProgress()
  // below for that).
  private _planetArrived = false;

  private _peopleMaterial!: ReturnType<typeof makeToonRimFlatMaterial>;
  // Own material instances for the two named figures (gold rim instead of
  // the crowd's default white) — makeToonRimFlatMaterial's uBodyColor is a
  // live uniform, but rim color is baked in at construction, so they can't
  // just share _peopleMaterial with a per-instance tint override.
  private _namedMaterials: ReturnType<typeof makeToonRimFlatMaterial>[] = [];
  private _personGroups: Group[] = [];
  private _personEntities: Entity[] = [];
  private _rightArms: Mesh[] = [];
  private _armRestZ!: Float32Array;
  private _bobPhase!: Float32Array;
  private _bobAmp!: Float32Array;
  // Each person's own fixed surface-normal orientation, captured once at
  // build time — Gas's Beat 2.5 "turn to face the player" (see
  // _gasTurnAmount) yaws AWAY from this base each frame rather than
  // accumulating rotation onto a mutating quaternion.
  private _baseQuats: Quaternion[] = [];

  // Per-constellation situation state — see the constants block above.
  private _pointUpTimer = 0;
  private _wasComplete = false;

  private _bubbleMeshes: Mesh[] = [];
  private _bubbleEntities: Entity[] = [];
  private _bubbleCtxs: CanvasRenderingContext2D[] = [];
  private _bubbleTextures: CanvasTexture[] = [];
  private _bubbleOpacity!: Float32Array;
  private _lastLineIndex!: Int16Array;
  private _explainerDrawn = false;

  private _fireMeshes: Mesh[] = [];
  private _fireEntities: Entity[] = [];
  private _firePositions!: Float32Array;
  private _firePhase!: Float32Array;

  // Beat 4 — Gas's skull-symbol flight (see SkullState/SKULL_* constants).
  private _skullMeshes: Mesh[] = [];
  private _skullState!: Uint8Array;
  private _skullT!: Float32Array;
  private _skullFromX!: Float32Array;
  private _skullFromY!: Float32Array;
  private _skullFromZ!: Float32Array;
  private _wasVisited!: Uint8Array;

  // Beat 4 — Soul's ghosts / Organic's seeds (see GHOST_*/SEED_* constants).
  private _ghostMeshes: Mesh[] = [];
  private _seedMeshes: Mesh[] = [];

  private _camWorldPos!: Vector3;
  private _faceDir!: Vector3;
  private _upAxis!: Vector3;
  private _zAxis!: Vector3;
  private _normalVec!: Vector3;
  private _scratchPos!: Vector3;
  private _scratchLiveCenter!: Vector3;
  private _scratchYawQuat!: Quaternion;
  private _camRight!: Vector3;
  private _camUp!: Vector3;
  private _camFwd!: Vector3;
  private _scratchTrailPos!: Vector3;
  private _scratchCometPos!: Vector3;

  // "Voice" blip on activation — reuses PebbleSynth's own red/harsh,
  // green/earthy, blue/heavenly character split (see pebble-synth.ts)
  // rather than inventing a new synth, tying Chapter 2's identity through to
  // Fate Events.
  private _audioListener!: AudioListener;
  private _voiceSynth!: PebbleSynth;
  private _wasActive!: Uint8Array;
  private _payoffChimePlayed = false;

  init(): void {
    this._fateEvents = this.world.getSystem(FateEventSystem)!;
    this._planetSeeding = this.world.getSystem(PlanetSeedingVfxSystem)!;
    // ConstellationsSystem/CometTrailSystem must be registered before this
    // system (see index.ts) so they already exist when this init() runs.
    this._constellations = this.world.getSystem(ConstellationsSystem)!;
    this._trailSystem = this.world.getSystem(CometTrailSystem)!;

    this._camWorldPos = new Vector3();
    this._faceDir = new Vector3();
    this._upAxis = new Vector3(0, 1, 0);
    this._zAxis = new Vector3(0, 0, 1);
    this._normalVec = new Vector3();
    this._scratchPos = new Vector3();
    this._scratchLiveCenter = new Vector3();
    this._scratchYawQuat = new Quaternion();
    this._camRight = new Vector3();
    this._camUp = new Vector3();
    this._camFwd = new Vector3();
    this._scratchTrailPos = new Vector3();
    this._scratchCometPos = new Vector3();

    this._audioListener = new AudioListener();
    this.player.head.add(this._audioListener);
    this._voiceSynth = new PebbleSynth();
    this._voiceSynth.build(this._audioListener, this.scene);
    this._wasActive = new Uint8Array(this._fateEvents.getPersonCount());
    this._wasVisited = new Uint8Array(this._fateEvents.getPersonCount());
    this._skullState = new Uint8Array(this._fateEvents.getPersonCount());
    this._skullT = new Float32Array(this._fateEvents.getPersonCount());
    this._skullFromX = new Float32Array(this._fateEvents.getPersonCount());
    this._skullFromY = new Float32Array(this._fateEvents.getPersonCount());
    this._skullFromZ = new Float32Array(this._fateEvents.getPersonCount());

    this._buildPeople();
    this._buildBubbles();
    this._buildFire();
    this._buildSkulls();
    this._buildGhostMeshes(this._ghostMeshes, this._fateEvents.getGraveyardField().count);
    this._buildCollectibleMeshes(this._seedMeshes, SEED_SIZE, SEED_COLOR, this._fateEvents.getSeedField().count);

    // signal.subscribe() fires immediately, so state is correct before the
    // first frame renders (same idiom ConstellationsVfxSystem/
    // PlanetSeedingVfxSystem use for their own gamePhase gating).
    this.cleanupFuncs.push(
      getGlobals(this.world).gamePhase.subscribe((phase) => this._onPhaseChange(phase)),
    );
  }

  private _onPhaseChange(phase: Phase): void {
    if (phase === Phase.Constellations) {
      // The dialogue-specific mood color (if any) isn't resolved until a
      // constellation is actually won — fall back to the dominant type's
      // color for however long people are progressively appearing here.
      const dominant = getGlobals(this.world).dominantPebbleType.peek();
      const color = PEBBLE_TYPES[dominant].color;
      (this._peopleMaterial.uniforms.uBodyColor.value as Vector3).set(color[0], color[1], color[2]);
      for (const mat of this._namedMaterials) (mat.uniforms.uBodyColor.value as Vector3).set(color[0], color[1], color[2]);
    } else if (phase === Phase.FateEvents) {
      // celestialSymbol is resolved by now — pick up the real (possibly
      // dialogue-overridden) color, and reveal bubbles: people are already
      // visible from Constellations, this just adds the interactive layer.
      const color = this._fateEvents.getPeopleColor();
      (this._peopleMaterial.uniforms.uBodyColor.value as Vector3).set(color[0], color[1], color[2]);
      for (const mat of this._namedMaterials) (mat.uniforms.uBodyColor.value as Vector3).set(color[0], color[1], color[2]);
      for (const mesh of this._bubbleMeshes) mesh.visible = true;
    } else if (phase === Phase.Stardust) {
      this._resetAll();
    }
  }

  private _resetAll(): void {
    this._planetArrived = false;
    for (let i = 0; i < this._personGroups.length; i++) {
      const group = this._personGroups[i];
      group.visible = false;
      group.scale.setScalar(0);
      group.rotation.z = 0;
      if (this._baseQuats[i]) group.quaternion.copy(this._baseQuats[i]);
    }
    for (let i = 0; i < this._rightArms.length; i++) {
      this._rightArms[i].rotation.set(0, 0, this._armRestZ[i]);
    }
    for (const mesh of this._bubbleMeshes) mesh.visible = false;
    for (const mesh of this._fireMeshes) mesh.visible = false;
    for (const mesh of this._skullMeshes) mesh.visible = false;
    for (const mesh of this._ghostMeshes) mesh.visible = false;
    for (const mesh of this._seedMeshes) mesh.visible = false;
    this._wasActive.fill(0);
    this._wasVisited.fill(0);
    this._skullState.fill(SkullState.Hidden);
    this._bubbleOpacity.fill(0);
    this._lastLineIndex.fill(-1);
    this._bobAmp.fill(0);
    this._pointUpTimer = 0;
    this._wasComplete = false;
    this._explainerDrawn = false;
    this._payoffChimePlayed = false;
  }

  private _buildPeople(): void {
    const count = this._fateEvents.getPersonCount();
    const positions = this._fateEvents.getSurfacePositions();
    const normals = this._fateEvents.getNormals();

    // dominantPebbleType isn't known this early (world boot, well before
    // Pebbles completes) either way — this is just a harmless placeholder
    // until _onPhaseChange sets the real color on entering Constellations;
    // people stay hidden until then regardless.
    const initialDominant = getGlobals(this.world).dominantPebbleType.peek();
    this._peopleMaterial = makeToonRimFlatMaterial(PEBBLE_TYPES[initialDominant].color);
    for (let i = 0; i < NAMED_FIGURE_COUNT; i++) {
      this._namedMaterials.push(makeToonRimFlatMaterial(PEBBLE_TYPES[initialDominant].color, NAMED_RIM_COLOR));
    }
    this._bobPhase = new Float32Array(count);
    this._bobAmp = new Float32Array(count);
    this._armRestZ = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      this._bobPhase[i] = Math.random() * Math.PI * 2;
      const material = i < NAMED_FIGURE_COUNT ? this._namedMaterials[i] : this._peopleMaterial;
      const { group, rightArm } = buildPlaceholderPerson(material);
      group.position.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      this._normalVec.set(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]);
      group.quaternion.setFromUnitVectors(this._upAxis, this._normalVec);
      group.visible = false;
      this._personGroups.push(group);
      this._rightArms.push(rightArm);
      this._armRestZ[i] = rightArm.rotation.z;
      this._baseQuats.push(group.quaternion.clone());
      this._personEntities.push(this.world.createTransformEntity(group));
    }

    loadObjLargestIslands(PERSON_OBJ_URL, PERSON_OBJ_GROUPS, PERSON_OBJ_MAX_COUNT).then((islands) =>
      this._swapToIslandPeople(islands),
    );
  }

  // Rebuilds every person's group in place (same Entity, same position/
  // orientation logic already applied in _buildPeople) once the real mesh
  // islands have loaded — until then the primitive placeholder figures built
  // above keep showing, same "placeholder until real geometry resolves"
  // idiom obj-field-loader.ts's own callers use.
  private _swapToIslandPeople(islands: BufferGeometry[]): void {
    if (islands.length === 0) {
      console.warn(
        `[FateEventVfxSystem] no mesh islands found under ${PERSON_OBJ_GROUPS.join('/')} in '${PERSON_OBJ_URL}' — keeping the primitive placeholder figures.`,
      );
      return;
    }
    for (let i = 0; i < this._personGroups.length; i++) {
      const group = this._personGroups[i];
      while (group.children.length > 0) group.remove(group.children[0]);

      const material = i < NAMED_FIGURE_COUNT ? this._namedMaterials[i] : this._peopleMaterial;
      const islandIdx = ISLAND_PRIORITY[i % ISLAND_PRIORITY.length] % islands.length;
      const bodyGeo = islands[islandIdx];
      const { rightArm } = buildIslandPerson(material, bodyGeo, PERSON_BODY_RADIUS);
      // buildIslandPerson returns its own fresh Group, but this system keeps
      // one long-lived Group per person (its own Entity, already positioned/
      // oriented above) — reparent its two meshes into that instead of
      // swapping in a whole new Group/Entity.
      const built = rightArm.parent!;
      while (built.children.length > 0) group.add(built.children[0]);
      this._rightArms[i] = rightArm;
      this._armRestZ[i] = rightArm.rotation.z;
    }
  }

  private _buildBubbles(): void {
    const count = this._fateEvents.getPersonCount();
    this._bubbleOpacity = new Float32Array(count);
    this._lastLineIndex = new Int16Array(count).fill(-1);

    const geo = new PlaneGeometry(BUBBLE_WIDTH, BUBBLE_HEIGHT);
    for (let i = 0; i < count; i++) {
      const canvas = document.createElement('canvas');
      canvas.width = BUBBLE_CANVAS_W;
      canvas.height = BUBBLE_CANVAS_H;
      const ctx = canvas.getContext('2d')!;
      const texture = new CanvasTexture(canvas);
      const material = new MeshBasicMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        opacity: 0,
      });
      const mesh = new Mesh(geo, material);
      mesh.visible = false;
      this._bubbleCtxs.push(ctx);
      this._bubbleTextures.push(texture);
      this._bubbleMeshes.push(mesh);
      this._bubbleEntities.push(this.world.createTransformEntity(mesh));
    }
  }

  private _buildFire(): void {
    const [px, , pz] = this._fateEvents.getPlanetCenter();
    const fireY = this._fateEvents.getPlanetCenter()[1] - this._fateEvents.getPlanetRadius() + FIRE_RING_Y_OFFSET;
    const ring = placePlanets(N_FIRE_QUADS, FIRE_RING_RADIUS, fireY);
    this._firePositions = ring;
    this._firePhase = new Float32Array(N_FIRE_QUADS);

    const geo = new PlaneGeometry(FIRE_QUAD_W, FIRE_QUAD_H);
    const texture = buildFireTexture();
    for (let i = 0; i < N_FIRE_QUADS; i++) {
      this._firePositions[i * 3] += px;
      this._firePositions[i * 3 + 2] += pz;
      this._firePhase[i] = Math.random() * Math.PI * 2;

      const material = new MeshBasicMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        blending: AdditiveBlending,
      });
      const mesh = new Mesh(geo, material);
      mesh.position.set(this._firePositions[i * 3], this._firePositions[i * 3 + 1], this._firePositions[i * 3 + 2]);
      mesh.visible = false;
      this._fireMeshes.push(mesh);
      this._fireEntities.push(this.world.createTransformEntity(mesh));
    }
  }

  private _buildSkulls(): void {
    const count = this._fateEvents.getPersonCount();
    const geo = new PlaneGeometry(SKULL_SIZE, SKULL_SIZE);
    const texture = buildSkullTexture();
    for (let i = 0; i < count; i++) {
      const material = new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, side: DoubleSide });
      const mesh = new Mesh(geo, material);
      mesh.visible = false;
      this._skullMeshes.push(mesh);
      this.world.createTransformEntity(mesh);
    }
  }

  // Beat 4's Soul ghosts, one InstancedMesh (count=1) per slot rather than a
  // real Mesh — kSoulIslandMat's shader is instanced-only (its vertex stage
  // reads `instanceMatrix` directly and needs aBright/aTint/aTinted/
  // aWigglePhase attributes, see toon-rim-material.ts), so a plain Mesh
  // can't use it. Each instance's transform stays identity forever — this
  // file's existing _updateCollectibles already drives per-ghost position/
  // scale through the mesh's own Object3D transform (InstancedMesh extends
  // Mesh), which composes on top of that identity instance untouched.
  // aTinted stays 0 and aTint stays black, same as every real soul-dust
  // pebble (see pebble-field-vfx-system.ts's own TYPE_SOUL branch) — no
  // per-ghost recolor, just the material's own SOUL_ISLAND_PALETTE body/rim.
  private _buildGhostMeshes(target: Mesh[], count: number): void {
    for (let i = 0; i < count; i++) {
      const geo = new SphereGeometry(GHOST_SIZE, 8, 6);
      geo.setAttribute('aBright', new InstancedBufferAttribute(new Float32Array([0.7]), 1));
      geo.setAttribute('aTint', new InstancedBufferAttribute(new Float32Array(3), 3));
      geo.setAttribute('aTinted', new InstancedBufferAttribute(new Float32Array([0]), 1));
      geo.setAttribute('aWigglePhase', new InstancedBufferAttribute(new Float32Array([Math.random()]), 1));
      const mesh = new InstancedMesh(geo, kSoulIslandMat, 1);
      mesh.setMatrixAt(0, IDENTITY_MAT4);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.frustumCulled = false;
      mesh.visible = false;
      target.push(mesh);
      this.world.createTransformEntity(mesh);
    }
  }

  // Shared builder for Organic's seeds — a handful of small glowing additive
  // spheres, one per collectible slot (see this file's own top comment).
  private _buildCollectibleMeshes(target: Mesh[], size: number, color: [number, number, number], count: number): void {
    const material = new MeshBasicMaterial({
      color: new Color(color[0], color[1], color[2]),
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const geo = new SphereGeometry(size, 8, 6);
    for (let i = 0; i < count; i++) {
      const mesh = new Mesh(geo, material);
      mesh.visible = false;
      target.push(mesh);
      this.world.createTransformEntity(mesh);
    }
  }

  update(delta: number, time: number): void {
    const phase = getGlobals(this.world).gamePhase.peek();
    const dominant = getGlobals(this.world).dominantPebbleType.peek();

    if (this._constellations.isComplete() && !this._wasComplete) {
      this._wasComplete = true;
      if (dominant === ORGANIC_MATTER_TYPE) this._pointUpTimer = POINT_UP_DURATION;
    }

    const positions = this._fateEvents.getSurfacePositions();
    const normals = this._fateEvents.getNormals();
    const count = this._fateEvents.getPersonCount();
    // Re-derive every person's world position from its fixed normal (see
    // scatterOnSphereCap — radius/center-independent by construction) plus
    // the planet's LIVE position/radius, so people correctly follow through
    // both Leg A (spin+recede) and Leg B (final zoom-in) instead of only
    // matching one fixed final layout. Cheap at N_PEOPLE=10 — always safe to
    // run, even before either transition has started (harmless, since
    // nobody's visible yet).
    this._updateLivePositions(positions, normals, count);

    if (
      !this._planetArrived &&
      PLANET_ARRIVAL_ELIGIBLE_FROM.has(phase) &&
      !this._planetSeeding.isFateTransitionActive()
    ) {
      this._planetArrived = true;
      const showFire = this._fateEvents.getShowFire();
      for (const mesh of this._fireMeshes) mesh.visible = showFire;
    }

    // Core-narrative trim: the ambient CROWD is disabled for Soul/Organic —
    // their Beat 4 quests are the graveyard ghosts / seed field, not
    // visiting people, so a whole crowd was pure (distracting) flavor there.
    // Gas keeps its full crowd since visiting everyone IS that type's actual
    // Beat 4 mechanic. Soul/Organic still keep exactly ONE figure visible
    // (EXPLAIN_FIGURE_INDEX, via maxVisible=1 below) — the player still
    // needs someone to actually deliver Beat 3's "here's what these ghosts/
    // seeds are" line before Collect starts, just not a whole crowd around
    // them. The underlying simulation (FateEventSystem's active/visited/
    // dialogue state) keeps running untouched either way — this only gates
    // the VISUAL layer (meshes/ambient bubbles/voice blips below) so the
    // dialogue system stays intact as a backup to re-enable later.
    const peopleEnabled = dominant === VOLATILE_GASSES_TYPE;
    // Lightweight "society" cap per dominant type (see fate-event-system.ts's
    // VISIBLE_PEOPLE_BY_TYPE) — a sparser ghost-town read for volatile
    // gasses, denser for organics. Read live every frame rather than cached,
    // same reasoning as FateEventSystem.getVisiblePeopleCount() itself.
    const maxVisible = peopleEnabled ? this._fateEvents.getVisiblePeopleCount() : 1;

    // Civilization forms DURING Leg A (see SPIN_ELIGIBLE_FROM/
    // getSpinProgress()) — each person has its own staggered threshold
    // across the 0-1 spin progress so the population grows in one-by-one
    // rather than popping in all at once, easing scale via smoothstep
    // rather than a hard visibility toggle. Monotonic within a loop (see
    // PlanetSpinTransition.getProgress()), so no separate clamping needed
    // to prevent regression once fully formed.
    const spinProgress = SPIN_ELIGIBLE_FROM.has(phase) ? this._planetSeeding.getSpinProgress() : 0;
    // 1.0 at Fate Events' own full PLANET_RADIUS, shrinking in lockstep the
    // rest of the time — keeps the crowd correctly sized relative to the
    // planet through Leg A's smaller intermediate radius and Leg C's later
    // recede/shrink for Launch, not just fixed at their Fate-Events-tuned
    // absolute size forever once formed.
    const radiusScale = this._planetSeeding.getLivePlanetRadius() / this._fateEvents.getPlanetRadius();
    const beat = this._fateEvents.getBeat();
    const gasTurn = dominant === VOLATILE_GASSES_TYPE && phase === Phase.FateEvents ? this._gasTurnAmount(beat) : 0;
    for (let i = 0; i < this._personGroups.length; i++) {
      const group = this._personGroups[i];
      if (i >= maxVisible) {
        group.visible = false;
        continue;
      }
      const t = clamp01((spinProgress - i / this._personGroups.length) / STAGGER_WINDOW);
      const formed = smoothstep(t);
      group.visible = formed > 0;
      group.scale.setScalar(formed * radiusScale);

      if (gasTurn > 0) {
        this._scratchYawQuat.setFromAxisAngle(this._upAxis, gasTurn * GAS_TURN_ANGLE);
        group.quaternion.multiplyQuaternions(this._scratchYawQuat, this._baseQuats[i]);
      } else if (!group.quaternion.equals(this._baseQuats[i])) {
        group.quaternion.copy(this._baseQuats[i]);
      }
    }

    this.camera.getWorldPosition(this._camWorldPos);
    this._camRight.setFromMatrixColumn(this.camera.matrixWorld, 0);
    this._camUp.setFromMatrixColumn(this.camera.matrixWorld, 1);
    this._camFwd.setFromMatrixColumn(this.camera.matrixWorld, 2);

    const active = this._fateEvents.getActiveMask();
    const lineIndex = this._fateEvents.getLineIndex();

    const bobPull = 1 - Math.exp(-BOB_EASE_RATE * delta);
    const bubblePull = 1 - Math.exp(-BUBBLE_EASE_RATE * delta);
    // Livelier idle bob for organics, sluggish for a gasses "ghost town" —
    // see fate-event-system.ts's BOB_FREQUENCY_MULT_BY_TYPE.
    const bobFrequency = JUMP_FREQUENCY * this._fateEvents.getBobFrequencyMultiplier();
    const jumpAmplitude = JUMP_AMPLITUDE;
    const isExplain = phase === Phase.FateEvents && beat === FateBeat.Explain;

    for (let i = 0; i < count; i++) {
      this._normalVec.set(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]);

      const targetAmp = active[i] ? jumpAmplitude : 0;
      this._bobAmp[i] += (targetAmp - this._bobAmp[i]) * bobPull;
      const bobOffset =
        this._bobAmp[i] * Math.max(0, Math.sin(time * bobFrequency * Math.PI * 2 + this._bobPhase[i]));

      this._scratchPos.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      const group = this._personGroups[i];
      group.position.copy(this._scratchPos).addScaledVector(this._normalVec, bobOffset);

      if (active[i]) {
        if (!this._wasActive[i]) {
          this._wasActive[i] = 1;
          if (peopleEnabled) this._voiceSynth.playPickup(dominant, this._scratchPos, VOICE_BLIP_FIXED_SPEED);
        }
      } else {
        this._wasActive[i] = 0;
      }

      // Not gated on peopleEnabled — the explainer figure is the ONE person
      // Soul/Organic keep visible (see maxVisible above), specifically so
      // this line still shows for them, not just Gas's full crowd.
      const isExplainerFigure = isExplain && i === EXPLAIN_FIGURE_INDEX;
      const bubbleMesh = this._bubbleMeshes[i];
      const targetOpacity = isExplainerFigure
        ? this._fateEvents.getExplainerOpacity()
        : peopleEnabled && active[i]
          ? this._fateEvents.getBubbleOpacity(i)
          : 0;
      this._bubbleOpacity[i] += (targetOpacity - this._bubbleOpacity[i]) * bubblePull;
      (bubbleMesh.material as MeshBasicMaterial).opacity = this._bubbleOpacity[i];

      if (isExplainerFigure) {
        if (!this._explainerDrawn) {
          this._explainerDrawn = true;
          this._drawBubbleText(i, this._fateEvents.getExplainerText());
          this._lastLineIndex[i] = -1; // force a redraw once Collect's own ambient line takes back over
        }
      } else if (active[i] && this._lastLineIndex[i] !== lineIndex[i]) {
        this._lastLineIndex[i] = lineIndex[i];
        // getLineText already routes through getDialogueLinesFor for
        // non-featured figures (see fate-event-system.ts), so the
        // paired-ghost override still applies — the two featured figures'
        // own arc just takes priority.
        const text = this._fateEvents.getLineText(i);
        this._drawBubbleText(i, text);
      }
      if (!isExplain) this._explainerDrawn = false;

      bubbleMesh.position
        .copy(this._scratchPos)
        .addScaledVector(this._normalVec, PERSON_HEIGHT + BUBBLE_GAP + bobOffset);
      this._faceDir.copy(this._camWorldPos).sub(bubbleMesh.position).normalize();
      if (this._faceDir.lengthSq() > 0.0001) {
        bubbleMesh.quaternion.setFromUnitVectors(this._zAxis, this._faceDir);
      }
    }

    this._updateSituations(count, dominant, delta, time, phase, beat);
    this._updateFire(time);

    for (const entity of this.queries.comets.entities) {
      const posView = entity.getVectorView(CometBody, 'position') as Float32Array;
      this._scratchCometPos.fromArray(posView);
      this._updateSkulls(delta, dominant, phase);

      const trail = this._trailSystem.getBuffer(entity);
      if (trail) {
        const samples = entity.getValue(CometTrail, 'samples') as number;
        const stride = entity.getValue(CometTrail, 'stride') as number;
        const dancing = beat === FateBeat.Payoff && dominant === SOUL_DUST_TYPE;
        this._updateCollectibles(
          this._ghostMeshes,
          this._fateEvents.getGraveyardField(),
          dominant === SOUL_DUST_TYPE && COLLECTIBLE_VISIBLE_FROM.has(phase),
          trail,
          samples,
          stride,
          dancing,
          time,
        );
        this._updateCollectibles(
          this._seedMeshes,
          this._fateEvents.getSeedField(),
          dominant === ORGANIC_MATTER_TYPE && COLLECTIBLE_VISIBLE_FROM.has(phase),
          trail,
          samples,
          stride,
          false,
          time,
        );
      }
      break; // exactly one comet entity, see comet-handoff-system.ts
    }

    if (beat === FateBeat.Payoff && dominant === SOUL_DUST_TYPE && !this._payoffChimePlayed) {
      this._payoffChimePlayed = true;
      playPayoffChime(this._audioListener, this.scene, this._scratchCometPos, 520);
    }
    if (beat !== FateBeat.Payoff) this._payoffChimePlayed = false;
  }

  // 0-1 — how far into Gas's Beat 2.5 "turn to face the player" sub-beat
  // (8-10s) we are; 0 before it starts, holds at 1 for the rest of the
  // phase once it finishes (Explain/Collect/Payoff) rather than reverting —
  // see this file's own GAS_TURN_* comment.
  private _gasTurnAmount(beat: FateBeat): number {
    if (beat === FateBeat.Zoom) return 0;
    if (beat === FateBeat.Ambient) {
      return smoothstep(clamp01((this._fateEvents.getBeatElapsed() - GAS_TURN_START) / GAS_TURN_DURATION));
    }
    return 1;
  }

  // Organic matter's one-shot "point at the comet" pose, and Gas's Beat 2.5
  // watching/waving pose (0-3s of Ambient — see GAS_WATCH_DURATION's own
  // comment). A separate pass over the crowd is simplest to reason about
  // here; N_PEOPLE=10 makes it negligible.
  private _updateSituations(
    count: number,
    dominant: number,
    delta: number,
    time: number,
    phase: Phase,
    beat: FateBeat,
  ): void {
    if (this._pointUpTimer > 0) this._pointUpTimer = Math.max(0, this._pointUpTimer - delta);
    const pointUpActive = dominant === ORGANIC_MATTER_TYPE && this._pointUpTimer > 0;
    const gasWatchActive =
      dominant === VOLATILE_GASSES_TYPE &&
      phase === Phase.FateEvents &&
      beat === FateBeat.Ambient &&
      this._fateEvents.getBeatElapsed() < GAS_WATCH_DURATION;

    const armPull = 1 - Math.exp(-POINT_UP_EASE_RATE * delta);
    for (let i = 0; i < count; i++) {
      const arm = this._rightArms[i];
      const rest = this._armRestZ[i];

      let targetX = 0;
      let targetZ = rest;
      if (pointUpActive) {
        targetX = POINT_UP_ROTATION_X;
        targetZ = rest * 0.2;
      } else if (gasWatchActive) {
        targetX = GAS_WAVE_ROTATION_X;
        targetZ = rest * 0.3 + Math.sin(time * GAS_WAVE_FREQ * Math.PI * 2 + i) * GAS_WAVE_AMPLITUDE;
      }
      arm.rotation.x += (targetX - arm.rotation.x) * armPull;
      arm.rotation.z += (targetZ - arm.rotation.z) * armPull;
    }
  }

  // Beat 4 — edge-detects a person's visited flip and flies their skull icon
  // to the comet, then holds it at a small fixed per-person ring slot (see
  // this file's own top comment on why person-index alone is a stable ring
  // slot here).
  private _updateSkulls(delta: number, dominant: number, phase: Phase): void {
    const visited = this._fateEvents.getVisitedMask();
    const count = this._fateEvents.getPersonCount();
    const gasActive = dominant === VOLATILE_GASSES_TYPE && phase === Phase.FateEvents;

    for (let i = 0; i < count; i++) {
      if (gasActive && visited[i] && !this._wasVisited[i]) {
        this._wasVisited[i] = 1;
        this._skullState[i] = SkullState.Flying;
        this._skullT[i] = 0;
        const group = this._personGroups[i];
        this._skullFromX[i] = group.position.x;
        this._skullFromY[i] = group.position.y + PERSON_HEIGHT;
        this._skullFromZ[i] = group.position.z;
      }

      const mesh = this._skullMeshes[i];
      if (this._skullState[i] === SkullState.Hidden) {
        mesh.visible = false;
        continue;
      }
      mesh.visible = true;

      if (this._skullState[i] === SkullState.Flying) {
        this._skullT[i] = Math.min(1, this._skullT[i] + delta / SKULL_FLIGHT_DURATION);
        const t = smoothstep(this._skullT[i]);
        const angle = (i / count) * Math.PI * 2;
        const targetX = this._scratchCometPos.x + Math.cos(angle) * SKULL_RING_RADIUS;
        const targetY = this._scratchCometPos.y;
        const targetZ = this._scratchCometPos.z + Math.sin(angle) * SKULL_RING_RADIUS;
        mesh.position.set(
          this._skullFromX[i] + (targetX - this._skullFromX[i]) * t,
          this._skullFromY[i] + (targetY - this._skullFromY[i]) * t,
          this._skullFromZ[i] + (targetZ - this._skullFromZ[i]) * t,
        );
        if (this._skullT[i] >= 1) this._skullState[i] = SkullState.Attached;
      } else {
        const angle = (i / count) * Math.PI * 2;
        mesh.position.set(
          this._scratchCometPos.x + Math.cos(angle) * SKULL_RING_RADIUS,
          this._scratchCometPos.y,
          this._scratchCometPos.z + Math.sin(angle) * SKULL_RING_RADIUS,
        );
      }
      this._faceDir.copy(this._camWorldPos).sub(mesh.position).normalize();
      if (this._faceDir.lengthSq() > 0.0001) mesh.quaternion.setFromUnitVectors(this._zAxis, this._faceDir);
    }
  }

  // Shared Beat-4 renderer for a GatherableField-backed collectible (Soul's
  // ghosts / Organic's seeds) — Free/Attracting particles sit at the field's
  // own live positions; Captured ones ride the comet's trail exactly like
  // every other gathered thing in this codebase (see trail-sampler.ts).
  // `dance`, when true (Soul's own Beat 5 payoff only), layers a small
  // per-ghost sinusoidal offset in camera-right/up space onto the captured
  // position so they read as dancing together in the tail.
  private _updateCollectibles(
    meshes: Mesh[],
    field: GatherableField,
    show: boolean,
    trail: Float32Array,
    samples: number,
    stride: number,
    dance: boolean,
    time: number,
  ): void {
    if (!show) {
      for (const mesh of meshes) mesh.visible = false;
      return;
    }
    const { positions, states, capturedField } = field;
    for (let i = 0; i < meshes.length; i++) {
      const mesh = meshes[i];
      mesh.visible = true;
      if (states[i] === GatherState.Captured) {
        sampleTrailOffset(
          trail,
          samples,
          stride,
          capturedField.t[i],
          capturedField.dx[i],
          capturedField.dy[i],
          capturedField.dz[i],
          this._camRight,
          this._camUp,
          this._camFwd,
          this._scratchTrailPos,
        );
        if (dance) {
          const phase = i * 1.7;
          this._scratchTrailPos.addScaledVector(
            this._camRight,
            Math.sin(time * DANCE_FREQ * Math.PI * 2 + phase) * DANCE_AMPLITUDE,
          );
          this._scratchTrailPos.addScaledVector(
            this._camUp,
            Math.cos(time * DANCE_FREQ * Math.PI * 2 + phase * 1.3) * DANCE_AMPLITUDE,
          );
        }
        mesh.position.copy(this._scratchTrailPos);
        mesh.scale.setScalar(1);
      } else {
        mesh.position.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
        // Still out on the surface (Free/Attracting) — pulse so it reads as
        // an active collectible against the static decorations around it.
        mesh.scale.setScalar(1 + Math.sin(time * COLLECTIBLE_PULSE_FREQ * Math.PI * 2 + i * 0.7) * COLLECTIBLE_PULSE_AMPLITUDE);
      }
    }
  }

  private _updateLivePositions(positions: Float32Array, normals: Float32Array, count: number): void {
    this._scratchLiveCenter.copy(this._planetSeeding.getLivePlanetPosition());
    const liveReach = this._planetSeeding.getLivePlanetRadius() + PERSON_SURFACE_OFFSET;
    for (let i = 0; i < count; i++) {
      positions[i * 3] = this._scratchLiveCenter.x + normals[i * 3] * liveReach;
      positions[i * 3 + 1] = this._scratchLiveCenter.y + normals[i * 3 + 1] * liveReach;
      positions[i * 3 + 2] = this._scratchLiveCenter.z + normals[i * 3 + 2] * liveReach;
    }
  }

  private _updateFire(time: number): void {
    for (let i = 0; i < N_FIRE_QUADS; i++) {
      const mesh = this._fireMeshes[i];
      if (!mesh.visible) continue;
      const phase = this._firePhase[i];
      const flicker = 1 + Math.sin(time * FIRE_FLICKER_FREQ + phase) * 0.15;
      mesh.scale.setScalar(flicker);
      const bob = Math.sin(time * FIRE_BOB_FREQ + phase) * FIRE_BOB_AMP;
      mesh.position.set(
        this._firePositions[i * 3],
        this._firePositions[i * 3 + 1] + bob,
        this._firePositions[i * 3 + 2],
      );
      this._faceDir.copy(this._camWorldPos).sub(mesh.position).normalize();
      if (this._faceDir.lengthSq() > 0.0001) {
        mesh.quaternion.setFromUnitVectors(this._zAxis, this._faceDir);
      }
    }
  }

  private _drawBubbleText(i: number, text: string): void {
    const ctx = this._bubbleCtxs[i];
    const w = BUBBLE_CANVAS_W;
    const h = BUBBLE_CANVAS_H;
    const pad = 10;
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = 'rgba(8, 8, 16, 0.82)';
    roundRectPath(ctx, pad, pad, w - pad * 2, h - pad * 2, 18);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.lineWidth = 3;
    roundRectPath(ctx, pad, pad, w - pad * 2, h - pad * 2, 18);
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 30px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lines = wrapLines(ctx, text, w - pad * 4);
    const totalHeight = lines.length * BUBBLE_LINE_HEIGHT;
    let y = h / 2 - totalHeight / 2 + BUBBLE_LINE_HEIGHT / 2;
    for (const line of lines) {
      ctx.fillText(line, w / 2, y);
      y += BUBBLE_LINE_HEIGHT;
    }

    this._bubbleTextures[i].needsUpdate = true;
  }
}
