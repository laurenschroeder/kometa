import {
  AudioListener,
  BufferAttribute,
  BufferGeometry,
  createSystem,
  DynamicDrawUsage,
  Group,
  Mesh,
  Points,
  ShaderMaterial,
  Vector3,
} from '@iwsdk/core';
import type { ConstellationDef } from './constellation-set.js';
import { getGlobals } from '../../core/globals.js';
import { CONSTELLATIONS_PRE_HINT_TEXT } from '../../core/notification-copy.js';
import { NotificationHudSystem } from '../../core/notification-hud-system.js';
import { Phase } from '../../core/phase.js';
import { StarDronePool } from '../../vfx/audio/star-drone-pool.js';
import { TwinkleSynth } from '../../vfx/audio/twinkle-synth.js';
import {
  ANCHOR_SURFACE_OFFSET,
  CONSTELLATION_REACH_SHIFT,
  generateConstellationStrokeOffsets,
  placeConstellationAnchorsAroundPlanet,
  sampleSmoothPath,
} from '../../vfx/geometry/constellation-path.js';
import { randomUnitVector3 } from '../../vfx/geometry/mesh-utils.js';
import { buildStreakRibbonGeometry } from '../../vfx/geometry/streak-path.js';
import { makeSparkleMaterial, makeSparkleMaterialVertexColor } from '../../vfx/shaders/sparkle-material.js';
import { makeStreakRibbonMaterial } from '../../vfx/shaders/streak-ribbon-material.js';
import { FIELD_STAR, hexToRgb, UNTOUCHED_STAR } from '../../vfx/color/color-scheme.js';
import {
  INTERMEDIATE_PLANET_CENTER,
  INTERMEDIATE_PLANET_RADIUS,
} from '../planet-seeding/planet-spin-transition.js';
import { PlanetSeedingVfxSystem } from '../planet-seeding/planet-seeding-vfx-system.js';
import { PEBBLE_TYPES } from '../pebbles/pebble-type.js';
import { ConstellationsSystem, N_TYPES } from './constellations-system.js';

// Bumped from 0.05 — the interactive constellation stars read as much too
// small at arm's length; TOUCHED_SIZE_MULT still applies on top of this, so
// bumping this one constant makes both the untouched (flashing) and traced
// (lit/solid) states bigger, in the same proportion as before.
const STAR_SIZE = 0.15;
// Untouched stars pulse between a dim and a bright extreme rather than a
// continuous ambient twinkle (that's the shader's own built-in modulation,
// still layered on top) — a deliberate on/off "flash" reads as "not yet
// traced," distinct from a steady-lit traced star.
const FLASH_MIN = 0.15;
const FLASH_MAX = 1.0;
const FLASH_FREQUENCY = 0.7; // Hz, full dim-to-bright-to-dim cycles per second
// A traced star settles well past the flash's own peak brightness and grows
// noticeably bigger — "really bright and solid" needs to read as more than
// just "steady at the same brightness the flash already reached."
const TOUCHED_BRIGHT_TARGET = 1.6;
const TOUCHED_SIZE_MULT = 1.8;
// Exponential pull (same idiom as _coverage/_moonFadeScale elsewhere) easing
// a just-traced star from wherever its flash left it up to its bright/solid
// target — a quick "settling into light" rather than a hard snap.
const LIGHT_UP_EASE_RATE = 4;
// Every untouched star is this warm yellow (same hue as EarthSituationsVfx
// System's CROWN_COLOR), regardless of which pebble type its constellation
// belongs to — "not yet gathered" reads as one consistent color across the
// whole sky. Touching a star eases its color (same LIGHT_UP_EASE_RATE pull
// as its brightness/size) toward that constellation's actual pebble-type
// color (see _updateStarState) — "gathering" it is what reveals its true
// color.
const UNTOUCHED_STAR_COLOR: [number, number, number] = hexToRgb(UNTOUCHED_STAR);

// Non-interactive "other stars around" — pure background sky filler so the
// active constellation reads as picked out of a real starfield instead of
// floating alone. Built once (not per type/slot, unlike the interactive
// stars) and live-tracked against whichever anchor is currently active —
// purely decorative scatter, so the exact anchor identity doesn't matter,
// only its live position. Smaller, dimmer, and a fixed neutral color
// (distinct from the interactive stars' per-type tint) so the two read as
// clearly different things at a glance.
const FIELD_STAR_COUNT = 70;
const FIELD_STAR_SIZE = 0.022;
const FIELD_STAR_MIN_RADIUS = 0.3; // leaves room near the anchor for the constellation itself
const FIELD_STAR_MAX_RADIUS = 1.8;
const FIELD_STAR_COLOR: [number, number, number] = hexToRgb(FIELD_STAR);

// Ambient "shape traced out" line — the same continuous trace/fade/retrace
// loop as the art-test magic-stardust-sweep variant (makeStreakRibbonMaterial,
// waitSeconds left at its own default of 0 — no pause between fade and
// retrace), just with a near-uniform width (RIBBON_WIDTH_PROFILE) instead of
// that variant's tapered "shooting star" profile, since a constellation's
// traced outline should read as one consistent line weight rather than
// thin-to-thick-to-thin along its length.
const RIBBON_SEGMENTS = 120;
const RIBBON_WIDTH = 0.035;
const RIBBON_REVEAL_SECONDS = 2.6;
const RIBBON_FADE_SECONDS = 1.0;
const RIBBON_WAIT_SECONDS = 0;
const RIBBON_LOOP_DURATION = RIBBON_REVEAL_SECONDS + RIBBON_FADE_SECONDS;
const RIBBON_REVEAL_FRACTION = RIBBON_REVEAL_SECONDS / RIBBON_LOOP_DURATION;
// Full width through the middle, soft rounded taper only right at the two
// tips (first/last 6% of the curve) — reads as one consistent traced line
// rather than art-test's tapered "shooting star" ribbon.
function ribbonWidthProfile(t: number): number {
  return 0.25 + 0.75 * Math.min(1, Math.min(t, 1 - t) / 0.06);
}

// TwinkleSynth's playCatch() scales pitch/brightness off a "speed" it
// normally reads from the comet's swing — there's no equivalent concept for
// touching a star, so every touch just gets a fixed mid-range value for a
// consistently pretty (not speed-reactive) twinkle.
const TWINKLE_FIXED_SPEED = 1.1;

// Renders ConstellationsSystem's simulation state: all 9 possible
// constellations' stars are built once here (see ConstellationsSystem's own
// comment on why — this system is always-on and needs fixed geometry before
// that phase's play() ever determines which type/slot is active), only the
// active type's randomly-picked slot is ever shown. Stars double as both the
// visual shape AND the touch/trace targets (see constellation-path.ts).
// A separate, single shared field of smaller non-interactive background
// stars (see FIELD_STAR_COUNT) is layered in around whichever anchor is
// active, so the constellation reads as picked out of a real sky instead of
// floating alone. Each interactive star also carries its own quiet
// positional drone (see star-drone-pool.ts) from the moment it's revealed;
// touching it stops that one drone and plays a twinkle (TwinkleSynth, reused
// from Stardust) at its position — once every star's drone has stopped this
// way, none are left playing. Every star starts a uniform untouched yellow
// (see UNTOUCHED_STAR_COLOR) and eases to its constellation's own pebble
// type color (see pebble-type.ts) only once traced, so gathering visibly
// reveals the Chapter 2 color it carries. Not GameDirector-managed —
// like PlanetSeedingVfxSystem, a completed constellation's stars persist as
// permanent sky scenery, so this registers always-on and self-gates
// visibility via gamePhase. Resets when a fresh loop re-enters Stardust.
// Stars are anchored around the planet's INTERMEDIATE Constellations
// waypoint (see constellation-path.ts's placeConstellationAnchorsAroundPlanet
// and planet-spin-transition.ts) — they stay hidden until
// PlanetSeedingVfxSystem's Leg A (spin+recede) transition finishes bringing
// the planet into place (same reasoning as FateEventVfxSystem's own
// _planetArrived gate), and once revealed they track the planet's LIVE
// position/radius every frame (not a fixed baked layout) so a completed
// constellation's stars correctly follow through Leg B's later zoom into
// Fate Events too, instead of only matching one fixed final layout.
// Launch far-side placement: how far behind the planet's surface (from the
// player's view) the constellation's plane sits, and how far above the
// planet's center.
const FAR_SIDE_STANDOFF = 0.5;
const FAR_SIDE_HEIGHT = 0.1;

export class ConstellationsVfxSystem extends createSystem({}) {
  private _constellations!: ConstellationsSystem;
  private _planetSeeding!: PlanetSeedingVfxSystem;
  private _notifications!: NotificationHudSystem;
  // Single shared material for every interactive star across all 9
  // constellations — color used to be baked per-type (one material per
  // type), but now comes from each star's own aColor attribute instead (see
  // UNTOUCHED_STAR_COLOR/_updateStarState), so one material suffices.
  private _starMat!: ShaderMaterial;
  // Reset to false each time Constellations begins (see _onPhaseChange),
  // flips true once update() sees Leg A (the spin+recede transition) finish
  // AND the VISIT_STARS_TEXT hint has actually been shown (see the gate in
  // update() for why both are required).
  private _revealed = false;

  // Ambient "shape traced out" ribbon — one shared material (color/timing
  // are the same for every constellation, and only one is ever visible at a
  // time, so no per-instance phase offset is needed the way art-test's own
  // multi-curve variant needed one). Geometry is built once per [type][slot]
  // in the SAME anchor-local offset space as the stars, then each frame only
  // the active slot's Mesh.position is updated to the live anchor — much
  // simpler than the stars' own per-vertex live-offset scheme, since this is
  // one rigid Mesh rather than a Points cloud representing many independent
  // things.
  private _ribbonMat!: ShaderMaterial;
  private _ribbonMeshes: Group[][] = [];

  // All indexed [type][slot].
  private _starPoints: Points[][] = [];
  private _starPosAttrs: BufferAttribute[][] = [];
  private _brightArrs: Float32Array[][] = [];
  private _brightAttrs: BufferAttribute[][] = [];
  private _sizeArrs: Float32Array[][] = [];
  private _sizeAttrs: BufferAttribute[][] = [];
  // Untouched until traced, then eases toward that constellation's own
  // pebble-type color — see UNTOUCHED_STAR_COLOR/_updateStarState.
  private _colorArrs: Float32Array[][] = [];
  private _colorAttrs: BufferAttribute[][] = [];
  // Per-star random flash-cycle offset (0-1), rolled once at build time, so
  // a slot's untouched stars don't all blink in lockstep.
  private _flashPhaseArrs: Float32Array[][] = [];
  // Each point's fixed offset from its (baked) anchor — see init(). Adding
  // the LIVE anchor position to these every frame is what makes stars
  // follow the planet instead of staying fixed at their baked positions.
  private _starOffsets: Float32Array[][] = [];
  // 3 anchors' fixed unit direction from INTERMEDIATE_PLANET_CENTER,
  // computed once in init() — the live anchor each frame is
  // liveCenter + anchorDir*(liveRadius + ANCHOR_SURFACE_OFFSET). Shared
  // across all 3 types (slot i's anchor is the same regardless of type).
  private _anchorDir!: Vector3[];
  private _liveAnchor!: Vector3[];
  private _scratchLiveCenter!: Vector3;
  // Launch: the constellation (and the hero star, which rides its centroid)
  // moves to the planet's far side as the planet repositions — see
  // _updateLiveAnchor. Yaw rotates the baked (world +Z-facing) plane to face
  // the player from there; 0 through Constellations/Fate Events.
  private _scratchHead = new Vector3();
  private _scratchFarAnchor = new Vector3();
  private _liveYaw = 0;
  private _yawCos = 1;
  private _yawSin = 0;

  // Background field stars — single shared cloud, not indexed by
  // type/slot (see FIELD_STAR_COUNT's own comment).
  private _fieldStarMat!: ShaderMaterial;
  private _fieldStarPoints!: Points;
  private _fieldStarPosAttr!: BufferAttribute;
  private _fieldStarOffsets!: Float32Array;

  // Per-star ambient drone (see star-drone-pool.ts) + the "pretty twinkle"
  // on touch (reuses Stardust's own TwinkleSynth). Own AudioListener, same
  // reason every other generative-audio VFX system in this codebase has one
  // — IWSDK's AudioSource/AudioUtils layer only plays pre-loaded buffers.
  private _audioListener!: AudioListener;
  private _dronePool!: StarDronePool;
  private _twinkleSynth!: TwinkleSynth;
  // Per-star touch-edge detection (indexed [type][slot], parallel to
  // _brightArrs) — distinct from ConstellationsSystem's own `traced` array,
  // which only tells us the CURRENT state, not the moment it just changed.
  private _wasTracedArrs: Uint8Array[][] = [];
  private _scratchTwinklePos!: Vector3;

  init(): void {
    this._constellations = this.world.getSystem(ConstellationsSystem)!;
    // PlanetSeedingVfxSystem/NotificationHudSystem must be registered before
    // this system (see index.ts) so they already exist when this init() runs.
    this._planetSeeding = this.world.getSystem(PlanetSeedingVfxSystem)!;
    this._notifications = this.world.getSystem(NotificationHudSystem)!;

    // Same deterministic, pure function ConstellationsSystem.init() already
    // called to bake its own layouts against — recomputing it here (rather
    // than plumbing an accessor across systems) gets us the same baked
    // anchor(s) needed to derive per-point offsets below. count=1 (not the
    // old 3) — see ConstellationsSystem's own matching comment; this MUST
    // stay in sync with that call site since both need the exact same
    // anchor position.
    const planetAnchors = placeConstellationAnchorsAroundPlanet(1, INTERMEDIATE_PLANET_CENTER, INTERMEDIATE_PLANET_RADIUS);
    const center = new Vector3(...INTERMEDIATE_PLANET_CENTER);
    this._anchorDir = planetAnchors.map((a) => new Vector3(...a).sub(center).normalize());
    const bakedAnchors = planetAnchors.map(
      (a): [number, number, number] => [
        a[0] + CONSTELLATION_REACH_SHIFT[0],
        a[1] + CONSTELLATION_REACH_SHIFT[1],
        a[2] + CONSTELLATION_REACH_SHIFT[2],
      ],
    );
    this._liveAnchor = bakedAnchors.map(() => new Vector3());
    this._scratchLiveCenter = new Vector3();

    this._starMat = makeSparkleMaterialVertexColor({ pointSizeFactor: 260 });
    this._ribbonMat = makeStreakRibbonMaterial({
      color: UNTOUCHED_STAR_COLOR,
      loopDurationSeconds: RIBBON_LOOP_DURATION,
      revealFraction: RIBBON_REVEAL_FRACTION,
      waitSeconds: RIBBON_WAIT_SECONDS,
    });

    for (let type = 0; type < N_TYPES; type++) {
      const defs = this._constellations.getDefs(type);
      const pointsRow: Points[] = [];
      const posAttrRow: BufferAttribute[] = [];
      const brightArrRow: Float32Array[] = [];
      const brightAttrRow: BufferAttribute[] = [];
      const sizeArrRow: Float32Array[] = [];
      const sizeAttrRow: BufferAttribute[] = [];
      const colorArrRow: Float32Array[] = [];
      const colorAttrRow: BufferAttribute[] = [];
      const flashPhaseRow: Float32Array[] = [];
      const offsetRow: Float32Array[] = [];
      const wasTracedRow: Uint8Array[] = [];
      const ribbonRow: Group[] = [];

      for (let slot = 0; slot < defs.length; slot++) {
        const anchor = bakedAnchors[slot];
        const built = this._buildStars(type, slot, this._starMat);
        pointsRow.push(built.points);
        posAttrRow.push(built.posAttr);
        brightArrRow.push(built.brightArr);
        brightAttrRow.push(built.brightAttr);
        sizeArrRow.push(built.sizeArr);
        sizeAttrRow.push(built.sizeAttr);
        colorArrRow.push(built.colorArr);
        colorAttrRow.push(built.colorAttr);
        flashPhaseRow.push(built.flashPhaseArr);
        const localOffset = this._computeOffsets(built.posAttr.array as Float32Array, anchor);
        offsetRow.push(localOffset);
        wasTracedRow.push(new Uint8Array(defs[slot].starCount));
        ribbonRow.push(this._buildRibbon(localOffset, defs[slot], this._anchorDir[slot]));
      }
      this._starPoints.push(pointsRow);
      this._starPosAttrs.push(posAttrRow);
      this._brightArrs.push(brightArrRow);
      this._brightAttrs.push(brightAttrRow);
      this._sizeArrs.push(sizeArrRow);
      this._sizeAttrs.push(sizeAttrRow);
      this._colorArrs.push(colorArrRow);
      this._colorAttrs.push(colorAttrRow);
      this._ribbonMeshes.push(ribbonRow);
      this._flashPhaseArrs.push(flashPhaseRow);
      this._starOffsets.push(offsetRow);
      this._wasTracedArrs.push(wasTracedRow);
    }

    this._buildFieldStars(bakedAnchors[0]);

    // _starMat/_ribbonMat/_fieldStarMat's shaders have never actually been
    // compiled yet — every mesh above sits invisible (visible = false) until
    // _applyVisibility/_revealed flips it right as Phase.Constellations
    // actually starts, alongside "Many years later." Without this, that
    // first-ever compile happens synchronously at exactly that moment,
    // which is the stutter reported there. Pre-warming here at build time
    // (Seeding, well before Constellations is reached) moves that one-time
    // cost somewhere it can't be felt — same fix already applied to
    // planet-growth-pool.ts's own plant shader for the same reason.
    this.world.renderer.compileAsync(this.world.scene, this.world.camera).catch(() => {});

    this._audioListener = new AudioListener();
    this.player.head.add(this._audioListener);
    this._dronePool = new StarDronePool();
    this._dronePool.build(this._audioListener, this.scene);
    this._twinkleSynth = new TwinkleSynth();
    this._twinkleSynth.build(this._audioListener, this.scene);
    this._scratchTwinklePos = new Vector3();

    // signal.subscribe() fires immediately, so visibility is correct before
    // the first frame renders.
    this.cleanupFuncs.push(
      getGlobals(this.world).gamePhase.subscribe((phase) => this._onPhaseChange(phase)),
    );
  }

  // Scattered once around one of the baked anchors (any of the 3 works —
  // this is pure random filler, not tied to a specific slot's identity) and
  // then live-tracked each frame against whichever anchor is actually
  // active (see update()), same "fixed local offset + live anchor" idiom as
  // the interactive stars.
  private _buildFieldStars(anchor: readonly [number, number, number]): void {
    this._fieldStarMat = makeSparkleMaterial({ color: FIELD_STAR_COLOR, pointSizeFactor: 220 });

    const positions = new Float32Array(FIELD_STAR_COUNT * 3);
    const sizeArr = new Float32Array(FIELD_STAR_COUNT);
    const brightArr = new Float32Array(FIELD_STAR_COUNT);
    const phaseArr = new Float32Array(FIELD_STAR_COUNT);
    this._fieldStarOffsets = new Float32Array(FIELD_STAR_COUNT * 3);

    for (let i = 0; i < FIELD_STAR_COUNT; i++) {
      const dir = randomUnitVector3();
      const r = FIELD_STAR_MIN_RADIUS + Math.random() * (FIELD_STAR_MAX_RADIUS - FIELD_STAR_MIN_RADIUS);
      this._fieldStarOffsets[i * 3] = dir.x * r;
      this._fieldStarOffsets[i * 3 + 1] = dir.y * r;
      this._fieldStarOffsets[i * 3 + 2] = dir.z * r;
      positions[i * 3] = anchor[0] + this._fieldStarOffsets[i * 3];
      positions[i * 3 + 1] = anchor[1] + this._fieldStarOffsets[i * 3 + 1];
      positions[i * 3 + 2] = anchor[2] + this._fieldStarOffsets[i * 3 + 2];

      sizeArr[i] = FIELD_STAR_SIZE * (0.6 + Math.random() * 0.7);
      brightArr[i] = 0.35 + Math.random() * 0.4;
      phaseArr[i] = Math.random();
    }

    const geo = new BufferGeometry();
    this._fieldStarPosAttr = new BufferAttribute(positions, 3);
    this._fieldStarPosAttr.setUsage(DynamicDrawUsage);
    geo.setAttribute('position', this._fieldStarPosAttr);
    geo.setAttribute('aSize', new BufferAttribute(sizeArr, 1));
    geo.setAttribute('aBright', new BufferAttribute(brightArr, 1));
    geo.setAttribute('aPhase', new BufferAttribute(phaseArr, 1));

    this._fieldStarPoints = new Points(geo, this._fieldStarMat);
    this._fieldStarPoints.frustumCulled = false;
    this._fieldStarPoints.visible = false;
    this.world.createTransformEntity(this._fieldStarPoints);
  }

  // world - anchor, per point — a fixed local offset (see
  // generateConstellationLayout: each point is anchor + a fixed shape
  // offset, independent of the planet's own radius) that liveAnchor + this
  // reconstructs every frame.
  private _computeOffsets(positions: Float32Array, anchor: readonly [number, number, number]): Float32Array {
    const offsets = new Float32Array(positions.length);
    for (let i = 0; i < positions.length; i += 3) {
      offsets[i] = positions[i] - anchor[0];
      offsets[i + 1] = positions[i + 1] - anchor[1];
      offsets[i + 2] = positions[i + 2] - anchor[2];
    }
    return offsets;
  }

  // Builds one ribbon Mesh tracing a smooth curve through localOffset's own
  // points (the SAME anchor-relative offsets the stars use — see
  // _computeOffsets) — geometry is built once in this local space and never
  // touched again; live anchor tracking (see update()) just moves the whole
  // Mesh's own .position each frame, no per-vertex rewrite needed the way
  // the stars' Points cloud requires.
  private _buildRibbon(localOffset: Float32Array, def: ConstellationDef, awayDir: Vector3): Group {
    // Authored strokes when the shape has them (each its own ribbon so
    // separate loops aren't joined); otherwise one curve through the stars.
    const strokes = generateConstellationStrokeOffsets(def, awayDir) ?? [localOffset];
    const group = new Group();
    for (const stroke of strokes) {
      const localPoints: Vector3[] = [];
      for (let i = 0; i < stroke.length; i += 3) {
        localPoints.push(new Vector3(stroke[i], stroke[i + 1], stroke[i + 2]));
      }
      const curve = sampleSmoothPath(localPoints, RIBBON_SEGMENTS);
      const mesh = new Mesh(buildStreakRibbonGeometry(curve, RIBBON_WIDTH, ribbonWidthProfile), this._ribbonMat);
      mesh.frustumCulled = false;
      group.add(mesh);
    }
    group.visible = false;
    this.world.createTransformEntity(group);
    return group;
  }

  private _buildStars(
    type: number,
    slot: number,
    mat: ShaderMaterial,
  ): {
    points: Points;
    posAttr: BufferAttribute;
    brightArr: Float32Array;
    brightAttr: BufferAttribute;
    sizeArr: Float32Array;
    sizeAttr: BufferAttribute;
    colorArr: Float32Array;
    colorAttr: BufferAttribute;
    flashPhaseArr: Float32Array;
  } {
    const positions = this._constellations.getStarPositions(type, slot);
    const count = positions.length / 3;
    const geo = new BufferGeometry();
    const posAttr = new BufferAttribute(positions, 3);
    posAttr.setUsage(DynamicDrawUsage);
    geo.setAttribute('position', posAttr);

    const sizeArr = new Float32Array(count).fill(STAR_SIZE);
    const sizeAttr = new BufferAttribute(sizeArr, 1);
    sizeAttr.setUsage(DynamicDrawUsage);
    geo.setAttribute('aSize', sizeAttr);

    const brightArr = new Float32Array(count);
    const brightAttr = new BufferAttribute(brightArr, 1);
    brightAttr.setUsage(DynamicDrawUsage);
    geo.setAttribute('aBright', brightAttr);

    // Starts yellow (untouched) for every star — see UNTOUCHED_STAR_COLOR.
    const colorArr = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      colorArr[i * 3] = UNTOUCHED_STAR_COLOR[0];
      colorArr[i * 3 + 1] = UNTOUCHED_STAR_COLOR[1];
      colorArr[i * 3 + 2] = UNTOUCHED_STAR_COLOR[2];
    }
    const colorAttr = new BufferAttribute(colorArr, 3);
    colorAttr.setUsage(DynamicDrawUsage);
    geo.setAttribute('aColor', colorAttr);

    const flashPhaseArr = new Float32Array(count);
    for (let i = 0; i < count; i++) flashPhaseArr[i] = Math.random();
    geo.setAttribute('aPhase', new BufferAttribute(flashPhaseArr, 1));

    const points = new Points(geo, mat);
    points.frustumCulled = false;
    points.visible = false;
    this.world.createTransformEntity(points);
    return { points, posAttr, brightArr, brightAttr, sizeArr, sizeAttr, colorArr, colorAttr, flashPhaseArr };
  }

  // dominantPebbleType was already set when Chapter 2 completed, well
  // before any Constellations transition — safe to read fresh here, same
  // reasoning as ConstellationsSystem.play().
  private _onPhaseChange(phase: Phase): void {
    if (phase === Phase.Constellations) {
      // Reset here (synchronous, before ConstellationsSystem.play() — which
      // fires later in the same GameDirector transition — actually kicks
      // off the planet-growth transition) so update()'s later-frame check
      // can't see a stale "not active" false positive from a previous run.
      this._revealed = false;
    }
    this._applyVisibility(phase);
    // Also reset on entering Constellations itself, not just Stardust — a
    // normal full loop already resets via Stardust well before this fires
    // again, but a debug-menu jump straight to Constellations (skipping
    // Stardust/Pebbles/Seeding — see phase-menu-system.ts) would otherwise
    // leave the previous test's star brightness/color/traced-drone state
    // stale until _updateStarState's per-frame untouched-branch overwrite
    // quietly self-corrected it — this makes the reset immediate and
    // explicit instead of relying on that.
    if (phase === Phase.Stardust || phase === Phase.Constellations) this._resetAll();
  }

  // Whether the active constellation's stars are actually visible right now
  // — used by ConstellationsSystem to gate hand-touch/"spied" detection so a
  // player can't trigger the spied notification while the stars are still
  // hidden/mid-reveal (see this file's own _revealed/_applyVisibility).
  isRevealed(): boolean {
    return this._revealed;
  }

  private _applyVisibility(phase: Phase): void {
    const active = phase === Phase.Constellations && this._revealed;
    const dominant = getGlobals(this.world).dominantPebbleType.peek();
    const activeSlot = this._constellations.getActiveSlot();
    const completed = this._constellations.isComplete();

    for (let type = 0; type < N_TYPES; type++) {
      for (let slot = 0; slot < this._starPoints[type].length; slot++) {
        const isActiveSlot = type === dominant && slot === activeSlot;
        this._starPoints[type][slot].visible = isActiveSlot && (active || completed);
        // Keeps looping (trace/fade/wait/repeat) for as long as the stars
        // themselves stay visible, including after completion — a completed
        // constellation persists as permanent sky scenery, and the ambient
        // trace is a nice ongoing touch rather than something gameplay-gated.
        this._ribbonMeshes[type][slot].visible = isActiveSlot && (active || completed);
      }
    }
    this._fieldStarPoints.visible = active || completed;
  }

  private _resetAll(): void {
    for (let type = 0; type < N_TYPES; type++) {
      for (let slot = 0; slot < this._brightArrs[type].length; slot++) {
        this._brightArrs[type][slot].fill(0);
        this._brightAttrs[type][slot].needsUpdate = true;
        this._sizeArrs[type][slot].fill(STAR_SIZE);
        this._sizeAttrs[type][slot].needsUpdate = true;
        const colorArr = this._colorArrs[type][slot];
        for (let i = 0; i < colorArr.length; i += 3) {
          colorArr[i] = UNTOUCHED_STAR_COLOR[0];
          colorArr[i + 1] = UNTOUCHED_STAR_COLOR[1];
          colorArr[i + 2] = UNTOUCHED_STAR_COLOR[2];
        }
        this._colorAttrs[type][slot].needsUpdate = true;
        this._wasTracedArrs[type][slot].fill(0);
      }
    }
    this._dronePool.stopAll();
  }

  update(delta: number, time: number): void {
    this._starMat.uniforms.uTime.value = time;
    this._fieldStarMat.uniforms.uTime.value = time;
    this._ribbonMat.uniforms.uTime.value = time;

    const phase = getGlobals(this.world).gamePhase.peek();
    const dominant = getGlobals(this.world).dominantPebbleType.peek();
    const activeSlot = this._constellations.getActiveSlot();
    this._updateLiveAnchor(activeSlot);
    this._applyLiveOffsets(this._starOffsets[dominant][activeSlot], this._starPosAttrs[dominant][activeSlot], this._liveAnchor[activeSlot]);
    this._applyLiveOffsets(this._fieldStarOffsets, this._fieldStarPosAttr, this._liveAnchor[activeSlot]);
    // Only the active slot's ribbon is ever visible (see _applyVisibility) —
    // its geometry is fixed local-space, so tracking the live anchor is just
    // moving the whole Mesh, not rewriting per-vertex positions like the
    // stars/field stars above.
    this._ribbonMeshes[dominant][activeSlot].position.copy(this._liveAnchor[activeSlot]);
    this._ribbonMeshes[dominant][activeSlot].rotation.y = this._liveYaw;

    const activePositions = this._starPosAttrs[dominant][activeSlot].array as Float32Array;
    const def = this._constellations.getDefs(dominant)[activeSlot];

    // Gated on BOTH the spin/recede transition having settled AND the
    // message right before the "why not visit those nearby stars" hint
    // having finished — the constellation appears first, and the hint
    // (VISIT_STARS_TEXT) follows a couple of seconds later (see its
    // delaySeconds in notification-copy.ts), so the hint points at
    // something already visible.
    if (
      !this._revealed &&
      phase === Phase.Constellations &&
      !this._planetSeeding.isSpinTransitionActive() &&
      this._notifications.hasFinished(CONSTELLATIONS_PRE_HINT_TEXT)
    ) {
      this._revealed = true;
      this._applyVisibility(phase);
      // Positions above are already this frame's live ones, so the drones'
      // very first position is correct from the start rather than one frame
      // stale.
      this._dronePool.startAll(def.starCount, activePositions);
    }
    if (this._revealed) this._dronePool.updatePositions(activePositions, def.starCount);

    this._updateStarState(dominant, activeSlot, activePositions, delta, time);

    // A just-completed constellation should snap to visible immediately
    // (not wait for the next gamePhase transition) so its last star lighting
    // up and the whole shape persisting read as the same beat.
    if (this._constellations.isComplete() && !this._starPoints[dominant][activeSlot].visible) {
      this._starPoints[dominant][activeSlot].visible = true;
      this._fieldStarPoints.visible = true;
      // Every star should already have stopped its own drone individually
      // on touch (see _updateStarState) — this is just a belt-and-suspenders
      // guarantee that "collecting all stars stops all drones" holds even if
      // completion was reached some other way (e.g. a dev-menu force).
      this._dronePool.stopAll();
    }
  }

  private _updateStarState(
    dominant: number,
    activeSlot: number,
    positions: Float32Array,
    delta: number,
    time: number,
  ): void {
    const def = this._constellations.getDefs(dominant)[activeSlot];
    const traced = this._constellations.getStarTraced(dominant, activeSlot);
    const wasTraced = this._wasTracedArrs[dominant][activeSlot];
    const brightArr = this._brightArrs[dominant][activeSlot];
    const brightAttr = this._brightAttrs[dominant][activeSlot];
    const sizeArr = this._sizeArrs[dominant][activeSlot];
    const sizeAttr = this._sizeAttrs[dominant][activeSlot];
    const colorArr = this._colorArrs[dominant][activeSlot];
    const colorAttr = this._colorAttrs[dominant][activeSlot];
    const flashPhaseArr = this._flashPhaseArrs[dominant][activeSlot];
    const pull = 1 - Math.exp(-LIGHT_UP_EASE_RATE * delta);
    // The color a touched star eases toward — see UNTOUCHED_STAR_COLOR.
    const targetColor = PEBBLE_TYPES[dominant]?.color ?? UNTOUCHED_STAR_COLOR;

    for (let s = 0; s < def.starCount; s++) {
      if (traced[s]) {
        if (!wasTraced[s]) {
          wasTraced[s] = 1;
          this._dronePool.stop(s);
          this._scratchTwinklePos.set(positions[s * 3], positions[s * 3 + 1], positions[s * 3 + 2]);
          this._twinkleSynth.playCatch(this._scratchTwinklePos, TWINKLE_FIXED_SPEED);
        }
        brightArr[s] += (TOUCHED_BRIGHT_TARGET - brightArr[s]) * pull;
        sizeArr[s] += (STAR_SIZE * TOUCHED_SIZE_MULT - sizeArr[s]) * pull;
        colorArr[s * 3] += (targetColor[0] - colorArr[s * 3]) * pull;
        colorArr[s * 3 + 1] += (targetColor[1] - colorArr[s * 3 + 1]) * pull;
        colorArr[s * 3 + 2] += (targetColor[2] - colorArr[s * 3 + 2]) * pull;
      } else {
        const t = 0.5 + 0.5 * Math.sin(time * FLASH_FREQUENCY * Math.PI * 2 + flashPhaseArr[s] * Math.PI * 2);
        brightArr[s] = FLASH_MIN + (FLASH_MAX - FLASH_MIN) * t;
        sizeArr[s] = STAR_SIZE;
        colorArr[s * 3] = UNTOUCHED_STAR_COLOR[0];
        colorArr[s * 3 + 1] = UNTOUCHED_STAR_COLOR[1];
        colorArr[s * 3 + 2] = UNTOUCHED_STAR_COLOR[2];
      }
    }
    brightAttr.needsUpdate = true;
    sizeAttr.needsUpdate = true;
    colorAttr.needsUpdate = true;
  }

  // Recomputes one slot's live anchor from the planet's LIVE position/
  // radius — only the active slot needs this each frame (the other 8
  // constellations are never displayed this loop, so leaving their arrays
  // stale is harmless). Zero-allocation: reuses _liveAnchor/
  // _scratchLiveCenter, only touches Float32Arrays/Vector3s.
  private _updateLiveAnchor(activeSlot: number): void {
    this._scratchLiveCenter.copy(this._planetSeeding.getLivePlanetPosition());
    const liveRadius = this._planetSeeding.getLivePlanetRadius();
    this._liveAnchor[activeSlot]
      .copy(this._anchorDir[activeSlot])
      .multiplyScalar(liveRadius + ANCHOR_SURFACE_OFFSET)
      .add(this._scratchLiveCenter);
    this._liveAnchor[activeSlot].x += CONSTELLATION_REACH_SHIFT[0];
    this._liveAnchor[activeSlot].y += CONSTELLATION_REACH_SHIFT[1];
    this._liveAnchor[activeSlot].z += CONSTELLATION_REACH_SHIFT[2];

    // Launch (Leg C): swing around to the far side of the planet — behind it
    // as seen from the player, no reach shift, plane turned to face them.
    // Eased in by Leg C's own progress so it travels with the receding planet
    // instead of popping.
    const t = this._planetSeeding.getLaunchProgress();
    const w = t * t * (3 - 2 * t);
    this._liveYaw = 0;
    if (w > 0) {
      const c = this._scratchLiveCenter;
      this.camera.getWorldPosition(this._scratchHead);
      let dx = c.x - this._scratchHead.x;
      let dz = c.z - this._scratchHead.z;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len > 1e-4) {
        dx /= len;
        dz /= len;
      } else {
        dx = 0;
        dz = -1;
      }
      const behind = liveRadius + FAR_SIDE_STANDOFF;
      this._scratchFarAnchor.set(c.x + dx * behind, c.y + FAR_SIDE_HEIGHT, c.z + dz * behind);
      this._liveAnchor[activeSlot].lerp(this._scratchFarAnchor, w);
      this._liveYaw = w * Math.atan2(-dx, -dz);
    }
    this._yawCos = Math.cos(this._liveYaw);
    this._yawSin = Math.sin(this._liveYaw);
  }

  private _applyLiveOffsets(offsets: Float32Array, attr: BufferAttribute, anchor: Vector3): void {
    const positions = attr.array as Float32Array;
    for (let i = 0; i < positions.length; i += 3) {
      const ox = offsets[i];
      const oz = offsets[i + 2];
      positions[i] = ox * this._yawCos + oz * this._yawSin + anchor.x;
      positions[i + 1] = offsets[i + 1] + anchor.y;
      positions[i + 2] = -ox * this._yawSin + oz * this._yawCos + anchor.z;
    }
    attr.needsUpdate = true;
  }
}
