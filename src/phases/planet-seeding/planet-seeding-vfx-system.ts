import {
  AudioListener,
  AudioSource,
  AudioUtils,
  createSystem,
  DynamicDrawUsage,
  Entity,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  PlaybackMode,
  Quaternion,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from '@iwsdk/core';
import { CometBody } from '../../comet/comet-body-component.js';
import { CometTrail } from '../../comet/comet-trail-component.js';
import { CometTrailSystem } from '../../comet/comet-trail-system.js';
import { HandAnchor } from '../../comet/hand-anchor-component.js';
import { getGlobals } from '../../core/globals.js';
import { Phase } from '../../core/phase.js';
import { buildOrganicGeometry } from '../../vfx/geometry/organic-rock-geometry.js';
import { sampleTrailOffset } from '../../vfx/particles/trail-sampler.js';
import { PlanetSpinSynth } from '../../vfx/audio/planet-spin-synth.js';
import { makeAtmosphereGlowMaterial } from '../../vfx/shaders/atmosphere-glow-material.js';
import { kOrganicGlitterMat } from '../../vfx/shaders/pebble-material.js';
import { makePlanetStainMaterial, MAX_SPLATS } from '../../vfx/shaders/planet-stain-material.js';
import { makeToonRimFlatMaterial } from '../../vfx/shaders/toon-rim-material.js';
import { PEBBLE_MESH_SCALE, pebbleSizeFromSample } from '../../vfx/particles/pebble-size.js';
import { PEBBLE_TYPES } from '../pebbles/pebble-type.js';
import { StardustSystem } from '../stardust/stardust-system.js';
import { PlanetFateTransition } from './planet-fate-transition.js';
import { PlanetGrowthPool } from './planet-growth-pool.js';
import { PlanetLaunchTransition } from './planet-launch-transition.js';
import { PlanetSpinTransition } from './planet-spin-transition.js';
import { N_MOONS, PLANET_RADIUS, PlanetSeedingSystem } from './planet-seeding-system.js';

// Falling motes now render as actual organic-pebble meshes — same geometry/
// material AND size distribution the comet's own tail pebbles use
// (kOrganicGlitterMat + pebbleSizeFromSample()*PEBBLE_MESH_SCALE) — instead
// of the old tiny point-sprite dust (DUST_SIZE=0.03, a screen-space
// heuristic). See _launchQueued's spawn site for the actual per-mote size
// draw — a plausible (t, r) sample fed through the exact same sizing
// function the tail uses, not an independently-tuned constant.
// Bumped from 1.2 — pebbles now launch from much farther out (see
// SURFACE_TRIGGER_DISTANCE's own increase in planet-seeding-system.ts), so a
// slower fall keeps the motion readable as an actual fall rather than a
// quick snap to the surface.
const FLIGHT_DURATION = 2.2;
// Bumped from 16 — FLIGHT_DURATION nearly doubled, so at the fastest drop
// cooldown (planet-seeding-system.ts's FALL_COOLDOWN_FAST) many more motes
// are in the air at once; without headroom here they'd hit the "in-flight
// capacity exceeded" fallback (instant-land, no visible fall) far too often.
const MAX_INFLIGHT = 32;
const COVERAGE_EASE_RATE = 2.5;
const BASE_COLOR: [number, number, number] = [0.02, 0.03, 0.05];
const ATMOSPHERE_SCALE = PLANET_RADIUS * 1.35;

// The planet/moons are Chapter 3's own reveal — they shouldn't be visible
// while the player is still gathering stardust/pebbles, only from Seeding
// onward (same "hasn't formed yet" treatment PebbleCometPresentationSystem
// gives the comet body itself).
const PLANETS_HIDDEN_DURING = new Set<Phase>([Phase.Stardust, Phase.Pebbles]);

const MOON_VISUAL_RADIUS = 0.035;
const MOON_FLASH_SCALE = 1.6; // punch multiplier on bump, decays back to 1
const MOON_FLASH_DECAY_RATE = 9; // 1/s exponential decay
const MOON_FADE_EASE_RATE = 3; // 1/s, easing the fade-scale to 0 once the Fate transition starts
// Fixed blue-gray — no longer retinted to the dominant pebble type on
// entering Seeding (moons are decoration only, see MOON_BUMP_RADIUS's own
// comment in planet-seeding-system.ts; a neutral color reads better against
// the planet's own type-colored splats than matching them).
const MOON_COLOR: [number, number, number] = [0.55, 0.62, 0.7];

// Weighted-random draw from the comet's own captured pebble-type mix (see
// globals.pebbleTypeWeights, set by PebbleWeavingSystem's win condition) —
// used both to color an in-flight dust mote and, once it lands, the splat it
// leaves on the planet, so what's raining down and staining the surface
// visibly matches whatever colors the player actually gathered in Chapter 2,
// not a single flat "dominant" hue.
function pickWeightedPebbleColor(weights: [number, number, number]): [number, number, number] {
  const roll = Math.random();
  const w0 = weights[0];
  const w1 = w0 + weights[1];
  const type = roll < w0 ? 0 : roll < w1 ? 1 : 2;
  return PEBBLE_TYPES[type].color;
}

// Renders PlanetSeedingSystem's simulation state: the single planet that
// grows a colored "seeded" stain as stardust lands on it, the orbiting
// moons (bumping one triggers a burst of in-flight dust motes toward the
// planet — see _updateMoons()), and the flight/landing animation itself.
// Not GameDirector-managed — like PebbleCometPresentationSystem, the planet
// is meant to persist as permanent scenery from Seeding onward, so this
// system registers always-on and self-gates via gamePhase. Coverage/moon
// state resets when a fresh loop re-enters Stardust.
export class PlanetSeedingVfxSystem extends createSystem({
  hands: { required: [CometBody, CometTrail, HandAnchor] },
}) {
  private _planetSeeding!: PlanetSeedingSystem;
  private _stardust!: StardustSystem;
  private _trailSystem!: CometTrailSystem;
  private _handEntity: Entity | null = null;

  private _planetMesh!: Mesh;
  private _planetMaterial!: ShaderMaterial;
  private _planetEntity!: Entity;
  private _coverage = 0;
  private _coverageTarget = 0;
  // This frame's time, stashed so _applyLanding/_addSplat (called from
  // _advanceFlights/_launchQueued, neither of which receives time directly)
  // can stamp a splat's birth for the shader's grow-in animation.
  private _time = 0;

  // Class-specific seeding flourish (green=growth, red=atmosphere) — see
  // planet-growth-pool.ts and this file's own _buildAtmosphere(). Which one
  // actually activates is decided at trigger-time from
  // getGlobals(world).dominantPebbleType, not cached, since this system
  // boots (and builds it, always) before Pebbles has ever run. Still takes a
  // planet index/positions array (see planet-growth-pool.ts) — kept as-is
  // rather than rewritten, since with N_PLANETS pinned to 1 (see
  // planet-seeding-system.ts) it already works correctly called with index
  // 0, no internal changes needed. Souls (dominant===0) get no landing
  // flourish here anymore — see _applyLanding's own comment.
  private _growthPool!: PlanetGrowthPool;
  private _atmosphereMesh!: Mesh;
  private _atmosphereMaterial!: ShaderMaterial;

  // Three-leg journey from Seeding onward. Leg A (_spinTransition, see
  // planet-spin-transition.ts) fires at Seeding->Constellations: spins the
  // planet while receding it to an intermediate, still-reachable waypoint.
  // Leg B (_fateTransition — see planet-fate-transition.ts) fires at
  // Constellations->FateEvents: the grow/zoom-in to Fate Events' true
  // PLANET_CENTER/PLANET_RADIUS. Leg C (_launchTransition — see
  // planet-launch-transition.ts) fires at FateEvents->Launch: recedes and
  // shrinks the planet back down, off to the player's left, next to the
  // orbit choice. All three are always ticked in update() (a no-op once
  // settled/never started); _updatePlanetTransitions() decides each frame
  // which one's output actually drives _planetMesh, based on which (if any)
  // has been started, in C > B > A priority order.
  private _spinTransition!: PlanetSpinTransition;
  private _fateTransition!: PlanetFateTransition;
  private _launchTransition!: PlanetLaunchTransition;
  private _audioListener!: AudioListener;
  private _spinSynth!: PlanetSpinSynth;

  private _moonMeshes: Mesh[] = [];
  private _moonEntities: Entity[] = [];
  private _moonMaterial!: ShaderMaterial;
  // Per-moon "just bumped" pulse — set to 1 on a bump event, decays toward 0
  // every frame; scale = MOON_VISUAL_RADIUS * (1 + flash*(FLASH_SCALE-1)).
  private _moonFlash!: Float32Array;
  // Shared 1->0 scale multiplier, eased once the Fate transition starts —
  // all moons fade out together rather than traveling with the planet.
  private _moonFadeScale = 1;
  private _moonsFading = false;

  // Rewritten in full every frame from _flightColorR/G/B (see
  // _advanceFlights) — cheap at MAX_INFLIGHT's small size, and avoids having
  // to track partial per-slot dirtiness through the swap-remove below.
  private _dustTintAttr!: InstancedBufferAttribute;
  private _dustMesh!: InstancedMesh;
  private _dustEntity!: Entity;

  // In-flight dust motes — fixed-capacity, kept compact (swap-remove on
  // landing, see _advanceFlights loop) so rendering is always a plain
  // [0,_flightCount). Only one landing target now (the single planet), so
  // there's no per-mote target-planet index to track anymore.
  private _flightFromX!: Float32Array;
  private _flightFromY!: Float32Array;
  private _flightFromZ!: Float32Array;
  private _flightDirX!: Float32Array; // local-space unit landing direction
  private _flightDirY!: Float32Array;
  private _flightDirZ!: Float32Array;
  // Which coverage cell (see planet-seeding-system.ts's CELL_DIRS) this
  // mote's landing already claimed/refreshed — carried through to
  // _applyLanding/_addSplat, which write straight into that cell's own
  // permanent shader slot.
  private _flightCellIndex!: Uint8Array;
  // Picked once at launch (see pickWeightedPebbleColor) and carried through
  // to landing, so a mote's in-flight color matches the splat it leaves.
  private _flightColorR!: Float32Array;
  private _flightColorG!: Float32Array;
  private _flightColorB!: Float32Array;
  // Picked once at launch — fixed per-mote rotation/size, same idiom the
  // comet's own tail pebbles use, so a falling mote doesn't look like a
  // perfectly uniform, unrotated stamp.
  private _flightRotX!: Float32Array;
  private _flightRotY!: Float32Array;
  private _flightRotZ!: Float32Array;
  private _flightRotW!: Float32Array;
  private _flightScale!: Float32Array;
  private _flightT!: Float32Array;
  private _flightCount = 0;

  private _camRight!: Vector3;
  private _camUp!: Vector3;
  private _camFwd!: Vector3;
  private _scratchPos!: Vector3;
  private _scratchRotAxis!: Vector3;
  private _scratchDustPos!: Vector3;
  private _scratchDustQuat!: Quaternion;
  private _scratchDustScale!: Vector3;
  private _scratchMat4!: Matrix4;

  init(): void {
    this._planetSeeding = this.world.getSystem(PlanetSeedingSystem)!;
    this._stardust = this.world.getSystem(StardustSystem)!;
    this._trailSystem = this.world.getSystem(CometTrailSystem)!;

    this._camRight = new Vector3();
    this._camUp = new Vector3();
    this._camFwd = new Vector3();
    this._scratchPos = new Vector3();
    this._scratchRotAxis = new Vector3();
    this._scratchDustPos = new Vector3();
    this._scratchDustQuat = new Quaternion();
    this._scratchDustScale = new Vector3();
    this._scratchMat4 = new Matrix4();

    this.queries.hands.subscribe(
      'qualify',
      (entity) => {
        this._handEntity = entity;
      },
      true,
    );
    this.queries.hands.subscribe('disqualify', (entity) => {
      if (this._handEntity === entity) this._handEntity = null;
    });

    this._buildPlanet();
    this._buildAtmosphere();
    this._buildMoons();
    this._buildDustCloud();

    this._growthPool = new PlanetGrowthPool();
    this._growthPool.build(this.world, this._planetEntity);
    this._spinTransition = new PlanetSpinTransition();
    this._spinTransition.build(this._planetSeeding.getPlanetPositions());
    this._fateTransition = new PlanetFateTransition();
    this._fateTransition.build(this._planetSeeding.getPlanetPositions());
    this._launchTransition = new PlanetLaunchTransition();
    this._launchTransition.build(this._planetSeeding.getPlanetPositions(), PLANET_RADIUS);

    // Own AudioListener for the rev-up synth — same reason
    // StardustVfxSystem/PebbleFieldVfxSystem each need one: IWSDK's own
    // AudioSource/AudioUtils layer only plays pre-loaded buffers, with no
    // hook for generative/synthesized audio.
    this._audioListener = new AudioListener();
    this.player.head.add(this._audioListener);
    this._spinSynth = new PlanetSpinSynth();
    this._spinSynth.build(this._audioListener, this.scene);

    this._flightFromX = new Float32Array(MAX_INFLIGHT);
    this._flightFromY = new Float32Array(MAX_INFLIGHT);
    this._flightFromZ = new Float32Array(MAX_INFLIGHT);
    this._flightDirX = new Float32Array(MAX_INFLIGHT);
    this._flightDirY = new Float32Array(MAX_INFLIGHT);
    this._flightDirZ = new Float32Array(MAX_INFLIGHT);
    this._flightCellIndex = new Uint8Array(MAX_INFLIGHT);
    this._flightColorR = new Float32Array(MAX_INFLIGHT);
    this._flightColorG = new Float32Array(MAX_INFLIGHT);
    this._flightColorB = new Float32Array(MAX_INFLIGHT);
    this._flightRotX = new Float32Array(MAX_INFLIGHT);
    this._flightRotY = new Float32Array(MAX_INFLIGHT);
    this._flightRotZ = new Float32Array(MAX_INFLIGHT);
    this._flightRotW = new Float32Array(MAX_INFLIGHT).fill(1);
    this._flightScale = new Float32Array(MAX_INFLIGHT);
    this._flightT = new Float32Array(MAX_INFLIGHT);

    // signal.subscribe() fires immediately, so visibility/reset state is
    // correct before the first frame renders. Reset must run before the
    // visibility pass below it (a fresh Stardust entry clears _moonsFading,
    // which the visibility pass itself reads).
    this.cleanupFuncs.push(
      getGlobals(this.world).gamePhase.subscribe((phase) => {
        if (phase === Phase.Stardust) this._resetScene();

        const planetsVisible = !PLANETS_HIDDEN_DURING.has(phase);
        this._planetMesh.visible = planetsVisible;
        this._dustMesh.visible = planetsVisible;
        if (!this._moonsFading) {
          for (const mesh of this._moonMeshes) mesh.visible = planetsVisible;
        }
      }),
    );
  }

  private _buildAtmosphere(): void {
    const positions = this._planetSeeding.getPlanetPositions();
    const geo = new SphereGeometry(1, 24, 16);
    const mat = makeAtmosphereGlowMaterial();
    const mesh = new Mesh(geo, mat);
    mesh.name = 'atmosphere';
    mesh.position.set(positions[0], positions[1], positions[2]);
    mesh.scale.setScalar(ATMOSPHERE_SCALE);
    mesh.frustumCulled = false;
    mesh.visible = false;
    this._atmosphereMesh = mesh;
    this._atmosphereMaterial = mat;
    this.world.createTransformEntity(mesh);
  }

  private _buildPlanet(): void {
    const positions = this._planetSeeding.getPlanetPositions();

    // A fresh buildOrganicGeometry() call (not a shared instance) — same
    // technique the comet's pebbles/head use for their rocky look.
    const geo = buildOrganicGeometry();
    this._planetMaterial = makePlanetStainMaterial(BASE_COLOR);
    const mesh = new Mesh(geo, this._planetMaterial);
    mesh.position.set(positions[0], positions[1], positions[2]);
    mesh.scale.setScalar(PLANET_RADIUS);
    mesh.frustumCulled = false;
    const entity = this.world.createTransformEntity(mesh);
    entity.addComponent(AudioSource, {
      src: 'dustLand',
      positional: true,
      loop: false,
      playbackMode: PlaybackMode.Overlap,
    });
    this._planetMesh = mesh;
    this._planetEntity = entity;
  }

  private _buildMoons(): void {
    this._moonMaterial = makeToonRimFlatMaterial(MOON_COLOR);
    this._moonFlash = new Float32Array(N_MOONS);

    for (let i = 0; i < N_MOONS; i++) {
      const geo = buildOrganicGeometry();
      const mesh = new Mesh(geo, this._moonMaterial);
      mesh.scale.setScalar(MOON_VISUAL_RADIUS);
      mesh.frustumCulled = false;
      mesh.visible = false;
      const entity = this.world.createTransformEntity(mesh);
      entity.addComponent(AudioSource, {
        src: 'dustLand',
        positional: true,
        loop: false,
        playbackMode: PlaybackMode.Overlap,
      });
      this._moonMeshes.push(mesh);
      this._moonEntities.push(entity);
    }
  }

  private _buildDustCloud(): void {
    const geo = buildOrganicGeometry();
    geo.setAttribute('aBright', new InstancedBufferAttribute(new Float32Array(MAX_INFLIGHT).fill(0.7), 1));
    this._dustTintAttr = new InstancedBufferAttribute(new Float32Array(MAX_INFLIGHT * 3), 3);
    geo.setAttribute('aTint', this._dustTintAttr);
    geo.setAttribute('aTinted', new InstancedBufferAttribute(new Float32Array(MAX_INFLIGHT).fill(1), 1));

    this._dustMesh = new InstancedMesh(geo, kOrganicGlitterMat, MAX_INFLIGHT);
    this._dustMesh.name = 'seeding-falling-pebbles';
    this._dustMesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this._dustMesh.frustumCulled = false;
    this._dustMesh.count = 0;
    this._dustEntity = this.world.createTransformEntity(this._dustMesh);
  }

  private _resetScene(): void {
    this._coverage = 0;
    this._coverageTarget = 0;
    (this._planetMaterial.uniforms.uSplatBirth.value as number[]).fill(-1);
    this._flightCount = 0;
    this._dustMesh.count = 0;

    this._growthPool.reset();
    this._atmosphereMesh.visible = false;
    this._atmosphereMaterial.uniforms.uIntensity.value = 0;

    this._spinTransition.reset(this._planetSeeding.getPlanetPositions());
    this._fateTransition.reset(this._planetSeeding.getPlanetPositions());
    this._launchTransition.reset(this._planetSeeding.getPlanetPositions(), PLANET_RADIUS);
    this._spinSynth.stop();

    this._moonsFading = false;
    this._moonFadeScale = 1;
    this._moonFlash.fill(0);
    for (const mesh of this._moonMeshes) mesh.scale.setScalar(MOON_VISUAL_RADIUS);
  }

  // Called by ConstellationsSystem.play() — kicks off Leg A (the spin +
  // recede into the intermediate Constellations waypoint). Seeding's own
  // class-flourish decorations (atmosphere glow, grown-in sprouts) are
  // hidden here rather than carried along — see PlanetGrowthPool's own
  // comment on hidePlanet() for why — since this is the moment Seeding's
  // visual identity starts transforming away.
  startSpinTransition(): void {
    this._atmosphereMesh.visible = false;
    this._growthPool.hidePlanet(0);
    // Leg A must pick up from wherever the player actually left the planet
    // floating (see planet-seeding-system.ts's head-following), not the
    // stale spawn-point _spinTransition was built() with — see
    // syncCurrentState()'s own comment.
    this._spinTransition.syncCurrentState(this._planetSeeding.getPlanetPositions(), PLANET_RADIUS);
    this._spinTransition.start();
    this._spinSynth.start(this._spinTransition.getCurrentPosition());
  }

  isSpinTransitionActive(): boolean {
    return this._spinTransition.isActive();
  }
  // 0-1 raw progress through Leg A — drives FateEventVfxSystem's
  // spin-driven civilization-forming reveal.
  getSpinProgress(): number {
    return this._spinTransition.getProgress();
  }

  // Called by FateEventSystem.play() — the primary trigger (in normal play,
  // fired once Constellations ends) for Leg B, the final grow/zoom-in to
  // Fate Events' true PLANET_CENTER/PLANET_RADIUS. Also doubles as a
  // dev-menu-skip safety net: safe to call even if Leg A never ran, since
  // PlanetSpinTransition's getCurrentPosition/Radius always have a sane
  // default (see its own build()). syncCurrentState() is what makes Leg B
  // continue smoothly from wherever Leg A actually left the planet, rather
  // than snapshotting Leg B's own stale build()-time position.
  startFateEventsTransition(): void {
    this._fateTransition.syncCurrentState(
      this._spinTransition.getCurrentPosition(),
      this._spinTransition.getCurrentRadius(),
    );
    this._fateTransition.start();
  }

  isFateTransitionActive(): boolean {
    return this._fateTransition.isActive();
  }

  // Called by OrbitalLaunchSystem.play() — Leg C, the planet receding and
  // shrinking away as Launch begins. targetPos/targetRadius come from the
  // caller (its own left-side orbit-choice zone center, and Seeding's small
  // PLANET_RADIUS) rather than being owned here, since OrbitalLaunchSystem
  // is what actually knows where its choice zones live. Reads straight from
  // the mesh's own current live transform (not Leg B's transition object
  // directly) so this works correctly even on a dev-menu skip that jumped
  // straight to Launch, bypassing Legs A/B entirely.
  startLaunchRecedeTransition(targetPos: Vector3, targetRadius: number): void {
    this._launchTransition.syncCurrentState(this._planetMesh.position, this._planetMesh.scale.x);
    this._launchTransition.start(targetPos, targetRadius);
  }

  // True once Leg C has actually reached its target (started AND no longer
  // active) — read by OrbitalLaunchSystem to withhold the orbit/unknown
  // choice zones until the planet has visibly finished receding/shrinking
  // into its left-side spot, rather than letting a player standing right
  // there commit mid-animation.
  isLaunchTransitionSettled(): boolean {
    return this._launchTransition.hasStarted() && !this._launchTransition.isActive();
  }

  // Live world position/radius the planet mesh is CURRENTLY at — whichever
  // leg is driving it this frame (or its settled value between legs). Read
  // by ConstellationsVfxSystem/FateEventVfxSystem to keep stars/dots/people
  // correctly following the planet through both legs instead of only
  // matching one fixed final layout.
  getLivePlanetPosition(): Vector3 {
    return this._planetMesh.position;
  }
  getLivePlanetRadius(): number {
    return this._planetMesh.scale.x;
  }

  update(delta: number, time: number): void {
    this._time = time;
    // kOrganicGlitterMat is the shared singleton the comet's own tail
    // pebbles use too — its uTime is already kept fresh by
    // PebbleCometPresentationSystem, which is always-on.
    this._planetMaterial.uniforms.uTime.value = time;
    // 0 until Leg A (the spin+recede transition) starts, then ramps 0->1
    // across its own duration, staying 1 forever after — see
    // planet-stain-material.ts's own comment on uFinalGrowT for why this is
    // what makes every splat visibly bloom from tiny to full size exactly
    // during that transition, instead of reaching full size the instant it
    // lands during Seeding.
    this._planetMaterial.uniforms.uFinalGrowT.value = this._spinTransition.getProgress();

    this._camRight.setFromMatrixColumn(this.camera.matrixWorld, 0);
    this._camUp.setFromMatrixColumn(this.camera.matrixWorld, 1);
    this._camFwd.setFromMatrixColumn(this.camera.matrixWorld, 2);

    this._updateMoons(delta);
    this._launchQueued();
    this._advanceFlights(delta);
    this._easeCoverage(delta, time);
    this._growthPool.update(delta);
    this._updatePlanetTransitions(delta);
  }

  private _updateMoons(delta: number): void {
    const positions = this._planetSeeding.getMoonPositions();
    const flashPull = 1 - Math.exp(-MOON_FLASH_DECAY_RATE * delta);
    for (let i = 0; i < N_MOONS; i++) {
      this._moonFlash[i] += (0 - this._moonFlash[i]) * flashPull;
      const mesh = this._moonMeshes[i];
      mesh.position.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      const scale = MOON_VISUAL_RADIUS * (1 + this._moonFlash[i] * (MOON_FLASH_SCALE - 1)) * this._moonFadeScale;
      mesh.scale.setScalar(scale);
    }

    const bumps = this._planetSeeding.drainBumpEvents();
    for (const moon of bumps) {
      this._moonFlash[moon] = 1;
      AudioUtils.play(this._moonEntities[moon]);
    }

    if (!this._moonsFading && this._spinTransition.isActive()) {
      this._moonsFading = true;
    }
    if (this._moonsFading && this._moonFadeScale > 0) {
      const fadePull = 1 - Math.exp(-MOON_FADE_EASE_RATE * delta);
      this._moonFadeScale += (0 - this._moonFadeScale) * fadePull;
      if (this._moonFadeScale < 0.01) {
        this._moonFadeScale = 0;
        for (const mesh of this._moonMeshes) mesh.visible = false;
      }
    }
  }

  private _updatePlanetTransitions(delta: number): void {
    this._spinTransition.update(delta);
    this._fateTransition.update(delta);
    this._launchTransition.update(delta);

    if (this._spinTransition.isActive()) {
      this._spinSynth.update(this._spinTransition.getProgress(), this._spinTransition.getAngularSpeedNorm());
    }

    // Four states, in order: pure Seeding (no leg has ever started — the
    // mesh instead follows PlanetSeedingSystem's own live head-following
    // position every frame), Leg A (mid-spin, or settled at the
    // intermediate waypoint once it finishes), Leg B (zoom-in to Fate
    // Events, once triggered), Leg C (recede/shrink away for Launch, once
    // triggered — takes priority over everything once started, same as B
    // over A).
    const useLegC = this._launchTransition.hasStarted();
    const useLegB = !useLegC && this._fateTransition.hasStarted();
    const useLegA = !useLegC && !useLegB && this._spinTransition.hasStarted();
    let radius: number;
    if (useLegC) {
      this._planetMesh.position.copy(this._launchTransition.getCurrentPosition());
      radius = this._launchTransition.getCurrentRadius();
    } else if (useLegB) {
      this._planetMesh.position.copy(this._fateTransition.getCurrentPosition());
      radius = this._fateTransition.getCurrentRadius();
    } else if (useLegA) {
      this._planetMesh.position.copy(this._spinTransition.getCurrentPosition());
      radius = this._spinTransition.getCurrentRadius();
    } else {
      const live = this._planetSeeding.getPlanetPositions();
      this._planetMesh.position.set(live[0], live[1], live[2]);
      radius = PLANET_RADIUS;
    }
    this._planetMesh.scale.setScalar(radius);
    this._atmosphereMesh.position.copy(this._planetMesh.position);
    // Leg B/C never rotate (a "zoom in"/"recede," not a spin) — rotation
    // only ever comes from Leg A, holding its final settled angle once it
    // stops.
    this._planetMesh.rotation.y = this._spinTransition.getCurrentRotationY();
  }

  private _launchQueued(): void {
    const events = this._planetSeeding.drainLaunchEvents();
    if (events.length === 0) return;

    const dustField = this._stardust.getCapturedField();

    for (const ev of events) {
      const handEntity = this._handEntity;
      if (!handEntity) continue;
      const trail = this._trailSystem.getBuffer(handEntity);
      if (!trail) continue;
      const samples = handEntity.getValue(CometTrail, 'samples') as number;
      const stride = handEntity.getValue(CometTrail, 'stride') as number;

      // Origin ("falls from you") — same trail-sampling technique every
      // other flight-mote system here uses. The LANDING point/cell,
      // though, is authoritative from gameplay (ev.dirX/Y/Z/cellIndex,
      // computed in PlanetSeedingSystem from where the hand actually was
      // when it triggered), not re-derived from this sampled origin.
      sampleTrailOffset(
        trail,
        samples,
        stride,
        dustField.t[ev.particleIndex],
        dustField.dx[ev.particleIndex],
        dustField.dy[ev.particleIndex],
        dustField.dz[ev.particleIndex],
        this._camRight,
        this._camUp,
        this._camFwd,
        this._scratchPos,
      );

      const weights = getGlobals(this.world).pebbleTypeWeights.peek();
      const color = pickWeightedPebbleColor(weights);

      if (this._flightCount < MAX_INFLIGHT) {
        const slot = this._flightCount++;
        this._flightFromX[slot] = this._scratchPos.x;
        this._flightFromY[slot] = this._scratchPos.y;
        this._flightFromZ[slot] = this._scratchPos.z;
        this._flightDirX[slot] = ev.dirX;
        this._flightDirY[slot] = ev.dirY;
        this._flightDirZ[slot] = ev.dirZ;
        this._flightCellIndex[slot] = ev.cellIndex;
        this._flightColorR[slot] = color[0];
        this._flightColorG[slot] = color[1];
        this._flightColorB[slot] = color[2];
        this._scratchRotAxis
          .set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1)
          .normalize();
        this._scratchDustQuat.setFromAxisAngle(this._scratchRotAxis, Math.random() * Math.PI * 2);
        this._flightRotX[slot] = this._scratchDustQuat.x;
        this._flightRotY[slot] = this._scratchDustQuat.y;
        this._flightRotZ[slot] = this._scratchDustQuat.z;
        this._flightRotW[slot] = this._scratchDustQuat.w;
        // Same sizing function + world-space scale the tail's own organic
        // pebbles use (pebble-comet-presentation-system.ts) — a plausible
        // (t, r) sample rather than an independently-tuned range, so a
        // falling mote is never bigger than a pebble already riding the tail.
        this._flightScale[slot] = pebbleSizeFromSample(Math.random(), Math.random() * 2.5) * PEBBLE_MESH_SCALE;
        this._flightT[slot] = 0;
      } else {
        // In-flight capacity exceeded (only possible during a mass force-
        // drain at phase end) — resolve the landing immediately rather
        // than dropping the mote's effect on the planet.
        this._applyLanding(ev.cellIndex, ev.dirX, ev.dirY, ev.dirZ, color);
      }
    }
  }

  private _advanceFlights(delta: number): void {
    const planetPositions = this._planetSeeding.getPlanetPositions();
    const px = planetPositions[0];
    const py = planetPositions[1];
    const pz = planetPositions[2];

    let i = 0;
    while (i < this._flightCount) {
      const t = Math.min(1, this._flightT[i] + delta / FLIGHT_DURATION);
      this._flightT[i] = t;
      // Horizontal drift eases smoothly; vertical falls with an ease-IN
      // curve (starts slow, accelerates) — the classic "falling under
      // gravity" character — while still landing exactly on target at
      // t=1 regardless of the curve shape, since both axes interpolate
      // between the same two fixed endpoints.
      const easedXZ = t * t * (3 - 2 * t);
      const easedY = t * t;

      const landX = px + this._flightDirX[i] * PLANET_RADIUS;
      const landY = py + this._flightDirY[i] * PLANET_RADIUS;
      const landZ = pz + this._flightDirZ[i] * PLANET_RADIUS;

      this._scratchDustPos.set(
        this._flightFromX[i] + (landX - this._flightFromX[i]) * easedXZ,
        this._flightFromY[i] + (landY - this._flightFromY[i]) * easedY,
        this._flightFromZ[i] + (landZ - this._flightFromZ[i]) * easedXZ,
      );
      this._scratchDustQuat.set(this._flightRotX[i], this._flightRotY[i], this._flightRotZ[i], this._flightRotW[i]);
      this._scratchDustScale.setScalar(this._flightScale[i]);
      this._scratchMat4.compose(this._scratchDustPos, this._scratchDustQuat, this._scratchDustScale);
      this._dustMesh.setMatrixAt(i, this._scratchMat4);

      if (t >= 1) {
        this._applyLanding(this._flightCellIndex[i], this._flightDirX[i], this._flightDirY[i], this._flightDirZ[i], [
          this._flightColorR[i],
          this._flightColorG[i],
          this._flightColorB[i],
        ]);
        // Swap-remove: pull the last active slot into this one, don't
        // advance i (the swapped-in entry still needs processing).
        const last = this._flightCount - 1;
        this._flightFromX[i] = this._flightFromX[last];
        this._flightFromY[i] = this._flightFromY[last];
        this._flightFromZ[i] = this._flightFromZ[last];
        this._flightDirX[i] = this._flightDirX[last];
        this._flightDirY[i] = this._flightDirY[last];
        this._flightDirZ[i] = this._flightDirZ[last];
        this._flightCellIndex[i] = this._flightCellIndex[last];
        this._flightColorR[i] = this._flightColorR[last];
        this._flightColorG[i] = this._flightColorG[last];
        this._flightColorB[i] = this._flightColorB[last];
        this._flightRotX[i] = this._flightRotX[last];
        this._flightRotY[i] = this._flightRotY[last];
        this._flightRotZ[i] = this._flightRotZ[last];
        this._flightRotW[i] = this._flightRotW[last];
        this._flightScale[i] = this._flightScale[last];
        this._flightT[i] = this._flightT[last];
        this._flightCount--;
      } else {
        i++;
      }
    }

    for (let s = 0; s < this._flightCount; s++) {
      this._dustTintAttr.setXYZ(s, this._flightColorR[s], this._flightColorG[s], this._flightColorB[s]);
    }
    this._dustTintAttr.needsUpdate = true;

    this._dustMesh.count = this._flightCount;
    this._dustMesh.instanceMatrix.needsUpdate = true;
  }

  // Writes straight into cellIndex's own permanent slot — never a rotating
  // ring-buffer index — so an already-colored cell just gets its splat
  // refreshed (new color/regrown birth) rather than a DIFFERENT cell's
  // splat ever being evicted. See planet-stain-material.ts's own comment.
  private _addSplat(cellIndex: number, dirX: number, dirY: number, dirZ: number, color: [number, number, number]): void {
    const centers = this._planetMaterial.uniforms.uSplatCenter.value as Vector3[];
    const colors = this._planetMaterial.uniforms.uSplatColor.value as Vector3[];
    const births = this._planetMaterial.uniforms.uSplatBirth.value as number[];
    centers[cellIndex].set(dirX, dirY, dirZ);
    colors[cellIndex].set(color[0], color[1], color[2]);
    // Only stamp uSplatBirth the FIRST time this cell is colored (sentinel
    // -1 -> "not yet colored", see planet-stain-material.ts). A repeat
    // landing on an already-colored cell (very common — orbiting back over
    // ground you've already covered) still re-tints it, but used to also
    // reset uSplatBirth to "now," which restarts the shader's grow-in curve
    // (threshold eases back from a single point up to that stage's cap over
    // SPLAT_GROW_SECONDS) — a fully-grown patch would visibly shrink back
    // toward the near-black base color for that half-second before
    // regrowing, reading as the planet "going more black." Leaving an
    // already-born cell's birth time alone keeps it permanently at its
    // full-grown size.
    if (births[cellIndex] < 0) births[cellIndex] = this._time;
  }

  private _applyLanding(
    cellIndex: number,
    dirX: number,
    dirY: number,
    dirZ: number,
    color: [number, number, number],
  ): void {
    this._addSplat(cellIndex, dirX, dirY, dirZ, color);
    AudioUtils.play(this._planetEntity);

    // Class-specific flourish — green triggers once per landing; red is
    // purely coverage-driven (see _easeCoverage), since coverage was just
    // incremented above regardless of class. Souls no longer get a landing
    // flourish here — the heart-burst pool read as literal white hearts
    // raining onto the planet, which didn't fit the gentler "already with
    // you" reframing the Dog constellation got (see soul-pack-flight.ts).
    const dominant = getGlobals(this.world).dominantPebbleType.peek();
    if (dominant === 1) {
      this._growthPool.trySpawn(0, dirX, dirY, dirZ);
    }
  }

  private _easeCoverage(delta: number, time: number): void {
    const dominant = getGlobals(this.world).dominantPebbleType.peek();
    // Read live from gameplay's own coverage-cell count — see
    // PlanetSeedingSystem.getCoverageFraction() — rather than incrementing
    // a separate tally here, so this always exactly matches the same
    // number the win condition uses.
    this._coverageTarget = this._planetSeeding.getCoverageFraction();
    const pull = 1 - Math.exp(-COVERAGE_EASE_RATE * delta);
    if (this._coverage !== this._coverageTarget) {
      this._coverage += (this._coverageTarget - this._coverage) * pull;
    }

    // Once the planet has begun leaving Seeding (Leg A started — permanent,
    // even after that spin/recede finishes, see hasStarted()'s comment), its
    // atmosphere stays hidden regardless of coverage. Gated on Leg A (not
    // Leg B) since startSpinTransition() is what one-time-hides it now —
    // checking Leg B here would re-show it every frame through all of
    // Constellations, undoing that hide until Leg B finally starts.
    const showAtmosphere = this._planetMesh.visible && dominant === 2 && !this._spinTransition.hasStarted();
    this._atmosphereMesh.visible = showAtmosphere;
    if (showAtmosphere) {
      this._atmosphereMaterial.uniforms.uIntensity.value = this._coverage;
      this._atmosphereMaterial.uniforms.uTime.value = time;
    }
  }
}
