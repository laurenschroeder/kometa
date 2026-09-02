import {
  AudioListener,
  BufferAttribute,
  BufferGeometry,
  createSystem,
  DynamicDrawUsage,
  Points,
  ShaderMaterial,
  Vector3,
} from '@iwsdk/core';
import { getGlobals } from '../../core/globals.js';
import { Phase } from '../../core/phase.js';
import { StarDronePool } from '../../vfx/audio/star-drone-pool.js';
import { TwinkleSynth } from '../../vfx/audio/twinkle-synth.js';
import {
  ANCHOR_SURFACE_OFFSET,
  placeConstellationAnchorsAroundPlanet,
} from '../../vfx/geometry/constellation-path.js';
import { randomUnitVector3 } from '../../vfx/geometry/mesh-utils.js';
import { makeSparkleMaterial } from '../../vfx/shaders/sparkle-material.js';
import {
  INTERMEDIATE_PLANET_CENTER,
  INTERMEDIATE_PLANET_RADIUS,
} from '../planet-seeding/planet-spin-transition.js';
import { PlanetSeedingVfxSystem } from '../planet-seeding/planet-seeding-vfx-system.js';
import { PEBBLE_TYPES } from '../pebbles/pebble-type.js';
import { ConstellationsSystem, N_TYPES } from './constellations-system.js';

const STAR_SIZE = 0.05;
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
const FIELD_STAR_COLOR: [number, number, number] = [0.8, 0.85, 0.95];

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
// way, none are left playing. Stars are tinted per pebble type (see pebble-type.ts) so the visual
// identity carries over from Chapter 2's colors. Not GameDirector-managed —
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
export class ConstellationsVfxSystem extends createSystem({}) {
  private _constellations!: ConstellationsSystem;
  private _planetSeeding!: PlanetSeedingVfxSystem;
  private _starMats: ShaderMaterial[] = [];
  // Reset to false each time Constellations begins (see _onPhaseChange),
  // flips true once update() sees Leg A (the spin+recede transition) finish.
  private _revealed = false;

  // All indexed [type][slot].
  private _starPoints: Points[][] = [];
  private _starPosAttrs: BufferAttribute[][] = [];
  private _brightArrs: Float32Array[][] = [];
  private _brightAttrs: BufferAttribute[][] = [];
  private _sizeArrs: Float32Array[][] = [];
  private _sizeAttrs: BufferAttribute[][] = [];
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
    // PlanetSeedingVfxSystem must be registered before this system (see
    // index.ts) so it already exists when this init() runs.
    this._planetSeeding = this.world.getSystem(PlanetSeedingVfxSystem)!;

    // Same deterministic, pure function ConstellationsSystem.init() already
    // called to bake its own layouts against — recomputing it here (rather
    // than plumbing an accessor across systems) gets us the 3 baked anchors
    // needed to derive per-point offsets below.
    const bakedAnchors = placeConstellationAnchorsAroundPlanet(3, INTERMEDIATE_PLANET_CENTER, INTERMEDIATE_PLANET_RADIUS);
    const center = new Vector3(...INTERMEDIATE_PLANET_CENTER);
    this._anchorDir = bakedAnchors.map((a) => new Vector3(...a).sub(center).normalize());
    this._liveAnchor = bakedAnchors.map(() => new Vector3());
    this._scratchLiveCenter = new Vector3();

    for (let type = 0; type < N_TYPES; type++) {
      const starColor = PEBBLE_TYPES[type]?.color ?? [1, 1, 1];
      const starMat = makeSparkleMaterial({ color: starColor, pointSizeFactor: 260 });
      this._starMats.push(starMat);

      const defs = this._constellations.getDefs(type);
      const pointsRow: Points[] = [];
      const posAttrRow: BufferAttribute[] = [];
      const brightArrRow: Float32Array[] = [];
      const brightAttrRow: BufferAttribute[] = [];
      const sizeArrRow: Float32Array[] = [];
      const sizeAttrRow: BufferAttribute[] = [];
      const flashPhaseRow: Float32Array[] = [];
      const offsetRow: Float32Array[] = [];
      const wasTracedRow: Uint8Array[] = [];

      for (let slot = 0; slot < defs.length; slot++) {
        const anchor = bakedAnchors[slot];
        const built = this._buildStars(type, slot, starMat);
        pointsRow.push(built.points);
        posAttrRow.push(built.posAttr);
        brightArrRow.push(built.brightArr);
        brightAttrRow.push(built.brightAttr);
        sizeArrRow.push(built.sizeArr);
        sizeAttrRow.push(built.sizeAttr);
        flashPhaseRow.push(built.flashPhaseArr);
        offsetRow.push(this._computeOffsets(built.posAttr.array as Float32Array, anchor));
        wasTracedRow.push(new Uint8Array(defs[slot].starCount));
      }
      this._starPoints.push(pointsRow);
      this._starPosAttrs.push(posAttrRow);
      this._brightArrs.push(brightArrRow);
      this._brightAttrs.push(brightAttrRow);
      this._sizeArrs.push(sizeArrRow);
      this._sizeAttrs.push(sizeAttrRow);
      this._flashPhaseArrs.push(flashPhaseRow);
      this._starOffsets.push(offsetRow);
      this._wasTracedArrs.push(wasTracedRow);
    }

    this._buildFieldStars(bakedAnchors[0]);

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
  // generateConstellationLayout: each point is anchor + a random local
  // scatter, independent of the planet's own radius) that liveAnchor + this
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

    const flashPhaseArr = new Float32Array(count);
    for (let i = 0; i < count; i++) flashPhaseArr[i] = Math.random();
    geo.setAttribute('aPhase', new BufferAttribute(flashPhaseArr, 1));

    const points = new Points(geo, mat);
    points.frustumCulled = false;
    points.visible = false;
    this.world.createTransformEntity(points);
    return { points, posAttr, brightArr, brightAttr, sizeArr, sizeAttr, flashPhaseArr };
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
    if (phase === Phase.Stardust) this._resetAll();
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
        this._wasTracedArrs[type][slot].fill(0);
      }
    }
    this._dronePool.stopAll();
  }

  update(delta: number, time: number): void {
    for (const mat of this._starMats) mat.uniforms.uTime.value = time;
    this._fieldStarMat.uniforms.uTime.value = time;

    const phase = getGlobals(this.world).gamePhase.peek();
    const dominant = getGlobals(this.world).dominantPebbleType.peek();
    const activeSlot = this._constellations.getActiveSlot();
    this._updateLiveAnchor(activeSlot);
    this._applyLiveOffsets(this._starOffsets[dominant][activeSlot], this._starPosAttrs[dominant][activeSlot], this._liveAnchor[activeSlot]);
    this._applyLiveOffsets(this._fieldStarOffsets, this._fieldStarPosAttr, this._liveAnchor[activeSlot]);

    const activePositions = this._starPosAttrs[dominant][activeSlot].array as Float32Array;
    const def = this._constellations.getDefs(dominant)[activeSlot];

    if (!this._revealed && phase === Phase.Constellations && !this._planetSeeding.isSpinTransitionActive()) {
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
    const flashPhaseArr = this._flashPhaseArrs[dominant][activeSlot];
    const pull = 1 - Math.exp(-LIGHT_UP_EASE_RATE * delta);

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
      } else {
        const t = 0.5 + 0.5 * Math.sin(time * FLASH_FREQUENCY * Math.PI * 2 + flashPhaseArr[s] * Math.PI * 2);
        brightArr[s] = FLASH_MIN + (FLASH_MAX - FLASH_MIN) * t;
        sizeArr[s] = STAR_SIZE;
      }
    }
    brightAttr.needsUpdate = true;
    sizeAttr.needsUpdate = true;
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
  }

  private _applyLiveOffsets(offsets: Float32Array, attr: BufferAttribute, anchor: Vector3): void {
    const positions = attr.array as Float32Array;
    for (let i = 0; i < positions.length; i += 3) {
      positions[i] = offsets[i] + anchor.x;
      positions[i + 1] = offsets[i + 1] + anchor.y;
      positions[i + 2] = offsets[i + 2] + anchor.z;
    }
    attr.needsUpdate = true;
  }
}
