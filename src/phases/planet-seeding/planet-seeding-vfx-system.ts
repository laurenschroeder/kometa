import {
  AudioListener,
  AudioSource,
  AudioUtils,
  BufferAttribute,
  BufferGeometry,
  createSystem,
  DynamicDrawUsage,
  Entity,
  Mesh,
  PlaybackMode,
  Points,
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
import { HeartBurstPool } from '../../vfx/particles/heart-burst-pool.js';
import { sampleTrailOffset } from '../../vfx/particles/trail-sampler.js';
import { PlanetSpinSynth } from '../../vfx/audio/planet-spin-synth.js';
import { makeAtmosphereGlowMaterial } from '../../vfx/shaders/atmosphere-glow-material.js';
import { makePlanetStainMaterial, MAX_SPLATS } from '../../vfx/shaders/planet-stain-material.js';
import { makeSparkleMaterialVertexColor } from '../../vfx/shaders/sparkle-material.js';
import { makeToonRimFlatMaterial } from '../../vfx/shaders/toon-rim-material.js';
import { PEBBLE_TYPES } from '../pebbles/pebble-type.js';
import { StardustSystem } from '../stardust/stardust-system.js';
import { PlanetFateTransition } from './planet-fate-transition.js';
import { PlanetGrowthPool } from './planet-growth-pool.js';
import { PlanetSpinTransition } from './planet-spin-transition.js';
import { N_MOONS, PLANET_RADIUS, PlanetSeedingSystem } from './planet-seeding-system.js';

const DUST_SIZE = 0.03;
const FLIGHT_DURATION = 0.6;
const MAX_INFLIGHT = 16;
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
  // Ring buffer over the planet material's uSplatCenter/uSplatColor/
  // uSplatBirth uniform arrays (see planet-stain-material.ts) — each landing
  // writes one slot and advances the index, wrapping once MAX_SPLATS is
  // reached (oldest splat quietly stops being drawn, replaced by the newest).
  private _splatWriteIdx = 0;
  private _splatCount = 0;
  // This frame's time, stashed so _applyLanding/_addSplat (called from
  // _advanceFlights/_launchQueued, neither of which receives time directly)
  // can stamp a splat's birth for the shader's grow-in animation.
  private _time = 0;

  // Class-specific seeding flourishes (blue=hearts, green=growth, red=
  // atmosphere) — see planet-growth-pool.ts/heart-burst-pool.ts and this
  // file's own _buildAtmosphere(). Which one actually activates is decided
  // at trigger-time from getGlobals(world).dominantPebbleType, not cached,
  // since this system boots (and builds all three, always) before Pebbles
  // has ever run. Both pools still take a planet index/positions array (see
  // planet-growth-pool.ts) — kept as-is rather than rewritten, since with
  // N_PLANETS pinned to 1 (see planet-seeding-system.ts) they already work
  // correctly called with index 0, no internal changes needed.
  private _heartBursts!: HeartBurstPool;
  private _growthPool!: PlanetGrowthPool;
  private _atmosphereMesh!: Mesh;
  private _atmosphereMaterial!: ShaderMaterial;

  // Two-leg journey from Seeding to Fate Events. Leg A (_spinTransition, see
  // planet-spin-transition.ts) fires at Seeding->Constellations: spins the
  // planet while receding it to an intermediate, still-reachable waypoint.
  // Leg B (_fateTransition, unchanged from before — see
  // planet-fate-transition.ts) now fires later, at Constellations->
  // FateEvents: the final grow/zoom-in to Fate Events' true PLANET_CENTER/
  // PLANET_RADIUS. Both are always ticked in update() (a no-op once settled/
  // never started); _updatePlanetTransitions() decides each frame which
  // one's output actually drives _planetMesh, based on whether Leg B has
  // been started yet.
  private _spinTransition!: PlanetSpinTransition;
  private _fateTransition!: PlanetFateTransition;
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

  private _dustGeo!: BufferGeometry;
  private _dustPositions!: Float32Array;
  private _dustBright!: Float32Array;
  // Rewritten in full every frame from _flightColorR/G/B (see
  // _advanceFlights) — cheap at MAX_INFLIGHT's small size, and avoids having
  // to track partial per-slot dirtiness through the swap-remove below.
  private _dustColorArr!: Float32Array;
  private _dustColorAttr!: BufferAttribute;
  private _dustPoints!: Points;
  private _dustEntity!: Entity;
  private _dustMaterial!: ShaderMaterial;

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
  // Picked once at launch (see pickWeightedPebbleColor) and carried through
  // to landing, so a mote's in-flight color matches the splat it leaves.
  private _flightColorR!: Float32Array;
  private _flightColorG!: Float32Array;
  private _flightColorB!: Float32Array;
  private _flightT!: Float32Array;
  private _flightCount = 0;

  private _camRight!: Vector3;
  private _camUp!: Vector3;
  private _camFwd!: Vector3;
  private _scratchPos!: Vector3;

  init(): void {
    this._planetSeeding = this.world.getSystem(PlanetSeedingSystem)!;
    this._stardust = this.world.getSystem(StardustSystem)!;
    this._trailSystem = this.world.getSystem(CometTrailSystem)!;

    this._camRight = new Vector3();
    this._camUp = new Vector3();
    this._camFwd = new Vector3();
    this._scratchPos = new Vector3();

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

    this._heartBursts = new HeartBurstPool();
    this._heartBursts.build(this.world);
    this._growthPool = new PlanetGrowthPool();
    this._growthPool.build(this.world, this._planetSeeding.getPlanetPositions());
    this._spinTransition = new PlanetSpinTransition();
    this._spinTransition.build(this._planetSeeding.getPlanetPositions());
    this._fateTransition = new PlanetFateTransition();
    this._fateTransition.build(this._planetSeeding.getPlanetPositions());

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
    this._flightColorR = new Float32Array(MAX_INFLIGHT);
    this._flightColorG = new Float32Array(MAX_INFLIGHT);
    this._flightColorB = new Float32Array(MAX_INFLIGHT);
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
        this._dustPoints.visible = planetsVisible;
        if (!this._moonsFading) {
          for (const mesh of this._moonMeshes) mesh.visible = planetsVisible;
        }

        if (phase === Phase.Seeding) {
          // dominantPebbleType is final by now (Pebbles precedes Seeding —
          // see phase.ts's PHASE_ORDER) — retint the moons to match (a live
          // uniform, no rebuild needed). The planet's own surface no longer
          // needs a rebuild-on-entry: its splat colors are live per-landing
          // uniforms (see planet-stain-material.ts), not a single baked
          // dominant hue.
          const dominant = getGlobals(this.world).dominantPebbleType.peek();
          (this._moonMaterial.uniforms.uBodyColor.value as Vector3).set(...PEBBLE_TYPES[dominant].color);
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
    const dominant = getGlobals(this.world).dominantPebbleType.peek();
    this._moonMaterial = makeToonRimFlatMaterial(PEBBLE_TYPES[dominant].color);
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
    this._dustPositions = new Float32Array(MAX_INFLIGHT * 3);
    this._dustBright = new Float32Array(MAX_INFLIGHT).fill(0.9);
    this._dustColorArr = new Float32Array(MAX_INFLIGHT * 3);
    const size = new Float32Array(MAX_INFLIGHT).fill(DUST_SIZE);
    const phase = new Float32Array(MAX_INFLIGHT);
    for (let i = 0; i < MAX_INFLIGHT; i++) phase[i] = Math.random();

    this._dustGeo = new BufferGeometry();
    const posAttr = new BufferAttribute(this._dustPositions, 3);
    posAttr.setUsage(DynamicDrawUsage);
    this._dustGeo.setAttribute('position', posAttr);
    this._dustGeo.setAttribute('aSize', new BufferAttribute(size, 1));
    this._dustGeo.setAttribute('aBright', new BufferAttribute(this._dustBright, 1));
    this._dustGeo.setAttribute('aPhase', new BufferAttribute(phase, 1));
    this._dustColorAttr = new BufferAttribute(this._dustColorArr, 3);
    this._dustColorAttr.setUsage(DynamicDrawUsage);
    this._dustGeo.setAttribute('aColor', this._dustColorAttr);
    this._dustGeo.setDrawRange(0, 0);

    this._dustMaterial = makeSparkleMaterialVertexColor({});
    this._dustPoints = new Points(this._dustGeo, this._dustMaterial);
    this._dustPoints.frustumCulled = false;
    this._dustEntity = this.world.createTransformEntity(this._dustPoints);
  }

  private _resetScene(): void {
    this._coverage = 0;
    this._coverageTarget = 0;
    this._splatWriteIdx = 0;
    this._splatCount = 0;
    this._planetMaterial.uniforms.uSplatCount.value = 0;
    this._flightCount = 0;
    this._dustGeo.setDrawRange(0, 0);

    this._heartBursts.reset();
    this._growthPool.reset();
    this._atmosphereMesh.visible = false;
    this._atmosphereMaterial.uniforms.uIntensity.value = 0;

    this._spinTransition.reset(this._planetSeeding.getPlanetPositions());
    this._fateTransition.reset(this._planetSeeding.getPlanetPositions());
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
    this._dustMaterial.uniforms.uTime.value = time;
    this._planetMaterial.uniforms.uTime.value = time;

    this._camRight.setFromMatrixColumn(this.camera.matrixWorld, 0);
    this._camUp.setFromMatrixColumn(this.camera.matrixWorld, 1);
    this._camFwd.setFromMatrixColumn(this.camera.matrixWorld, 2);

    this._updateMoons(delta);
    this._launchQueued();
    this._advanceFlights(delta);
    this._easeCoverage(delta, time);
    this._heartBursts.update(delta, this.camera);
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

    if (this._spinTransition.isActive()) {
      this._spinSynth.update(this._spinTransition.getProgress(), this._spinTransition.getAngularSpeedNorm());
    }

    // Leg B's output only takes over once it's actually been triggered
    // (Constellations->FateEvents) — until then the mesh follows Leg A
    // (mid-spin, or settled at the intermediate waypoint once it finishes).
    const useLegB = this._fateTransition.hasStarted();
    const pos = useLegB ? this._fateTransition.getCurrentPosition() : this._spinTransition.getCurrentPosition();
    const radius = useLegB ? this._fateTransition.getCurrentRadius() : this._spinTransition.getCurrentRadius();
    this._planetMesh.position.copy(pos);
    this._planetMesh.scale.setScalar(radius);
    // Leg B never rotates (a "zoom in," not a spin) — rotation only ever
    // comes from Leg A, holding its final settled angle once it stops.
    this._planetMesh.rotation.y = this._spinTransition.getCurrentRotationY();
  }

  private _launchQueued(): void {
    const events = this._planetSeeding.drainLaunchEvents();
    if (events.length === 0) return;

    const dustField = this._stardust.getCapturedField();
    const planetPositions = this._planetSeeding.getPlanetPositions();

    for (const ev of events) {
      const handEntity = this._handEntity;
      if (!handEntity) continue;
      const trail = this._trailSystem.getBuffer(handEntity);
      if (!trail) continue;
      const samples = handEntity.getValue(CometTrail, 'samples') as number;
      const stride = handEntity.getValue(CometTrail, 'stride') as number;

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

      const px = planetPositions[0];
      const py = planetPositions[1];
      const pz = planetPositions[2];
      let dx = this._scratchPos.x - px;
      let dy = this._scratchPos.y - py;
      let dz = this._scratchPos.z - pz;
      const len = Math.max(1e-5, Math.sqrt(dx * dx + dy * dy + dz * dz));
      dx /= len;
      dy /= len;
      dz /= len;

      const weights = getGlobals(this.world).pebbleTypeWeights.peek();
      const color = pickWeightedPebbleColor(weights);

      if (this._flightCount < MAX_INFLIGHT) {
        const slot = this._flightCount++;
        this._flightFromX[slot] = this._scratchPos.x;
        this._flightFromY[slot] = this._scratchPos.y;
        this._flightFromZ[slot] = this._scratchPos.z;
        this._flightDirX[slot] = dx;
        this._flightDirY[slot] = dy;
        this._flightDirZ[slot] = dz;
        this._flightColorR[slot] = color[0];
        this._flightColorG[slot] = color[1];
        this._flightColorB[slot] = color[2];
        this._flightT[slot] = 0;
      } else {
        // In-flight capacity exceeded (only possible during a mass force-
        // drain at phase end) — resolve the landing immediately rather
        // than dropping the mote's effect on the planet.
        this._applyLanding(dx, dy, dz, color);
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
      const eased = t * t * (3 - 2 * t);

      const landX = px + this._flightDirX[i] * PLANET_RADIUS;
      const landY = py + this._flightDirY[i] * PLANET_RADIUS;
      const landZ = pz + this._flightDirZ[i] * PLANET_RADIUS;

      this._dustPositions[i * 3] = this._flightFromX[i] + (landX - this._flightFromX[i]) * eased;
      this._dustPositions[i * 3 + 1] = this._flightFromY[i] + (landY - this._flightFromY[i]) * eased;
      this._dustPositions[i * 3 + 2] = this._flightFromZ[i] + (landZ - this._flightFromZ[i]) * eased;

      if (t >= 1) {
        this._applyLanding(this._flightDirX[i], this._flightDirY[i], this._flightDirZ[i], [
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
        this._flightColorR[i] = this._flightColorR[last];
        this._flightColorG[i] = this._flightColorG[last];
        this._flightColorB[i] = this._flightColorB[last];
        this._flightT[i] = this._flightT[last];
        this._flightCount--;
      } else {
        i++;
      }
    }

    for (let s = 0; s < this._flightCount; s++) {
      this._dustColorArr[s * 3] = this._flightColorR[s];
      this._dustColorArr[s * 3 + 1] = this._flightColorG[s];
      this._dustColorArr[s * 3 + 2] = this._flightColorB[s];
    }
    this._dustColorAttr.needsUpdate = true;

    this._dustGeo.setDrawRange(0, this._flightCount);
    (this._dustGeo.getAttribute('position') as BufferAttribute).needsUpdate = true;
  }

  private _addSplat(dirX: number, dirY: number, dirZ: number, color: [number, number, number]): void {
    const idx = this._splatWriteIdx;
    const centers = this._planetMaterial.uniforms.uSplatCenter.value as Vector3[];
    const colors = this._planetMaterial.uniforms.uSplatColor.value as Vector3[];
    const births = this._planetMaterial.uniforms.uSplatBirth.value as number[];
    centers[idx].set(dirX, dirY, dirZ);
    colors[idx].set(color[0], color[1], color[2]);
    births[idx] = this._time;
    this._splatWriteIdx = (idx + 1) % MAX_SPLATS;
    this._splatCount = Math.min(MAX_SPLATS, this._splatCount + 1);
    this._planetMaterial.uniforms.uSplatCount.value = this._splatCount;
  }

  private _applyLanding(
    dirX: number,
    dirY: number,
    dirZ: number,
    color: [number, number, number],
  ): void {
    this._addSplat(dirX, dirY, dirZ, color);
    const total = this._planetSeeding.getTotalStardust();
    this._coverageTarget += 1 / Math.max(1, total);
    AudioUtils.play(this._planetEntity);

    // Class-specific flourish — blue/green trigger once per landing; red is
    // purely coverage-driven (see _easeCoverage), since coverage was just
    // incremented above regardless of class.
    const dominant = getGlobals(this.world).dominantPebbleType.peek();
    const planetPositions = this._planetSeeding.getPlanetPositions();
    if (dominant === 0) {
      const x = planetPositions[0] + dirX * PLANET_RADIUS;
      const y = planetPositions[1] + dirY * PLANET_RADIUS;
      const z = planetPositions[2] + dirZ * PLANET_RADIUS;
      this._heartBursts.spawn(x, y, z, dirX, dirY, dirZ);
    } else if (dominant === 1) {
      this._growthPool.trySpawn(0, planetPositions, dirX, dirY, dirZ);
    }
  }

  private _easeCoverage(delta: number, time: number): void {
    const dominant = getGlobals(this.world).dominantPebbleType.peek();
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
