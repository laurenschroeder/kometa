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
  Vector4,
} from '@iwsdk/core';
import { getGlobals } from '../../core/globals.js';
import { Phase } from '../../core/phase.js';
import { buildOrganicGeometry } from '../../vfx/geometry/organic-rock-geometry.js';
import { PlanetSpinSynth } from '../../vfx/audio/planet-spin-synth.js';
import { kOrganicGlitterMat } from '../../vfx/shaders/pebble-material.js';
import { makePlanetStainMaterial, MAX_SPLATS } from '../../vfx/shaders/planet-stain-material.js';
import { makeToonRimFlatMaterial } from '../../vfx/shaders/toon-rim-material.js';
import { PEBBLE_MESH_SCALE, pebbleSizeFromSample } from '../../vfx/particles/pebble-size.js';
import { hexToRgb, MOON, PLANET_BASE } from '../../vfx/color/color-scheme.js';
import { CROWD_CAP_DIRECTION, PLANT_EXCLUSION_HALF_ANGLE } from '../fate-events/fate-event-system.js';
import { PlanetFateTransition } from './planet-fate-transition.js';
import { PlanetGrowthPool } from './planet-growth-pool.js';
import { PlanetLaunchTransition } from './planet-launch-transition.js';
import { PlanetSpinTransition, TOTAL_ROTATION_DELTA } from './planet-spin-transition.js';
import { CELL_DIRS, N_MOONS, PLANET_RADIUS, PlanetSeedingSystem } from './planet-seeding-system.js';

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
const SPLAT_FADE_EASE_RATE = 1.5; // 1/s — see _applyHumanZoneExclusion/_updateSplatFade
const BASE_COLOR: [number, number, number] = hexToRgb(PLANET_BASE);

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
const MOON_COLOR: [number, number, number] = hexToRgb(MOON);


// Renders PlanetSeedingSystem's simulation state: the single planet that
// grows a colored "seeded" stain as stardust lands on it, the orbiting
// moons (bumping one triggers a burst of in-flight dust motes toward the
// planet — see _updateMoons()), and the flight/landing animation itself.
// Not GameDirector-managed — like PebbleCometPresentationSystem, the planet
// is meant to persist as permanent scenery from Seeding onward, so this
// system registers always-on and self-gates via gamePhase. Coverage/moon
// state resets when a fresh loop re-enters Stardust.
export class PlanetSeedingVfxSystem extends createSystem({
}) {
  private _planetSeeding!: PlanetSeedingSystem;

  private _planetMesh!: Mesh;
  private _planetMaterial!: ShaderMaterial;
  private _planetEntity!: Entity;
  // This frame's time, stashed so _applyLanding/_addSplat (called from
  // _advanceFlights/_launchQueued, neither of which receives time directly)
  // can stamp a splat's birth for the shader's grow-in animation.
  private _time = 0;

  // Class-specific seeding flourish (green=growth — see planet-growth-
  // pool.ts). Souls (dominant===0) get no landing flourish here anymore —
  // see _applyLanding's own comment. Gas's own atmosphere-glow flourish was
  // removed (used to show a red Fresnel glow ring around the planet).
  private _growthPool!: PlanetGrowthPool;

  // Which CELL_DIRS slots fall inside Fate Events' crowd footprint (see
  // _applyHumanZoneExclusion) — decided once, the instant Leg A's spin
  // settles. _splatFade eases each slot's stain color toward invisible
  // (1) or back toward visible (0, never actually needed in practice since
  // this only ever turns on) at SPLAT_FADE_EASE_RATE, mirroring
  // uSplatColorFade[i].w every frame; the growth pool handles its own plant's fade
  // internally (see PlanetGrowthPool.excludeSlot).
  private _humanZoneMask = new Uint8Array(MAX_SPLATS);
  private _splatFade = new Float32Array(MAX_SPLATS);
  private _scratchCellDir!: Vector3;
  private _yAxis!: Vector3;

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
  // Looked up once at launch from the target cell's own fixed color (see
  // _launchQueued) and carried through to landing, so a mote's in-flight
  // color matches the splat it leaves.
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

  private _scratchRotAxis!: Vector3;
  private _scratchDustPos!: Vector3;
  private _scratchDustQuat!: Quaternion;
  private _scratchDustScale!: Vector3;
  private _scratchMat4!: Matrix4;

  init(): void {
    this._planetSeeding = this.world.getSystem(PlanetSeedingSystem)!;

    this._scratchRotAxis = new Vector3();
    this._scratchDustPos = new Vector3();
    this._scratchDustQuat = new Quaternion();
    this._scratchDustScale = new Vector3();
    this._scratchMat4 = new Matrix4();
    this._scratchCellDir = new Vector3();
    this._yAxis = new Vector3(0, 1, 0);

    this._buildPlanet();
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

  private _buildPlanet(): void {
    const positions = this._planetSeeding.getPlanetPositions();

    // A fresh buildOrganicGeometry() call (not a shared instance) — same
    // technique the comet's pebbles/head use for their rocky look.
    //
    // icoDetail 4 instead of the default 2 — 5120 triangles rather than 320
    // (each detail level quadruples: 20/80/320/1280/5120). The default is
    // tuned for pebbles a few centimetres across, where 320 triangles reads
    // as smooth; this same geometry is the PLANET, scaled up to
    // PLANET_RADIUS and eventually filling the view during Fate Events, so
    // at 320 its silhouette and the faceting across its terminator were
    // clearly visible. Only this one mesh pays the cost (the moons, dust
    // cloud, and growth-pool sprouts below all keep the cheap default), so
    // it's ~5k extra triangles once, not per instance.
    //
    // ampMin/ampMax forced to 0 — a perfect sphere rather than the default
    // sine-sum bump displacement (±4-10% of radius per term, several terms
    // summed). Everything planted on this surface (growth-pool flowers/
    // plants, Fate Events' crowd/graves/King/dogs/organic decorations) picks
    // its position as center + normal*radius, which only lands exactly on
    // the true surface if the surface really is that idealized sphere —
    // against the old bumpy geometry, a direction that happened to dip or
    // bulge relative to the sine-sum noise would plant something visibly
    // floating or sunk in, which is what made some flowers read as not
    // attached to the ground. PlanetSeedingSystem's own gameplay landing
    // check (distToCenter - PLANET_RADIUS) already treated the planet as a
    // perfect sphere regardless of this mesh's actual displaced shape, so
    // flattening it here just brings the visual in line with logic that was
    // already assuming it.
    const geo = buildOrganicGeometry({ icoDetail: 4, ampMin: 0, ampMax: 0 });
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
    // kOrganicGlitterMat's fragment shader caps the tint blend at
    // vTinted*0.35 (see makeToonRimInstancedGrainyMaterial) — plenty subtle
    // for the tail's own pebbles, but it left these motes reading as
    // generic organic rock with barely a hint of the color they're about to
    // land as, so the mote-color/patch-color relationship (see
    // _launchQueued's cellColors lookup — they DO already carry the exact
    // same RGB) never actually read on screen. 1/0.35 here (only on this
    // mesh's own attribute buffer, not the shared material, so every other
    // consumer of kOrganicGlitterMat — the tail, seed-blossom's burst, etc.
    // — is untouched) cancels that 0.35 out, so a falling mote shows its
    // landing cell's true color at full strength, same as the splat and the
    // eventual plant.
    geo.setAttribute('aTinted', new InstancedBufferAttribute(new Float32Array(MAX_INFLIGHT).fill(1 / 0.35), 1));

    this._dustMesh = new InstancedMesh(geo, kOrganicGlitterMat, MAX_INFLIGHT);
    this._dustMesh.name = 'seeding-falling-pebbles';
    this._dustMesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this._dustMesh.frustumCulled = false;
    this._dustMesh.count = 0;
    this._dustEntity = this.world.createTransformEntity(this._dustMesh);
  }

  private _resetScene(): void {
    for (const v of this._planetMaterial.uniforms.uSplatCenterBirth.value as Vector4[]) v.w = -1;
    for (const v of this._planetMaterial.uniforms.uSplatColorFade.value as Vector4[]) v.w = 0;
    this._humanZoneMask.fill(0);
    this._splatFade.fill(0);
    this._flightCount = 0;
    this._dustMesh.count = 0;

    this._growthPool.reset();

    this._spinTransition.reset(this._planetSeeding.getPlanetPositions());
    this._fateTransition.reset(this._planetSeeding.getPlanetPositions());
    this._launchTransition.reset(this._planetSeeding.getPlanetPositions(), PLANET_RADIUS);
    this._spinSynth.stop();
    this._planetMesh.rotation.y = 0;

    this._moonsFading = false;
    this._moonFadeScale = 1;
    this._moonFlash.fill(0);
    for (const mesh of this._moonMeshes) mesh.scale.setScalar(MOON_VISUAL_RADIUS);
  }

  // Called by ConstellationsSystem.play() — kicks off Leg A (the spin +
  // recede into the intermediate Constellations waypoint). The grown-in
  // sprouts are deliberately NOT hidden here — they're
  // parented under this same planet entity (see PlanetGrowthPool.build())
  // and meant to persist and keep growing (see its own GROWTH_FINAL_SCALE)
  // as permanent scenery straight through Constellations/Fate Events/
  // Launch, riding along with every leg exactly like the moons/splats do.
  startSpinTransition(): void {
    // Leg A must pick up from wherever the player actually left the planet
    // floating (see planet-seeding-system.ts's head-following), not the
    // stale spawn-point _spinTransition was built() with — see
    // syncCurrentState()'s own comment. Same for rotation, via the slow
    // ambient turn Seeding itself was already doing — see
    // syncCurrentRotation()'s own comment.
    this._spinTransition.syncCurrentState(this._planetSeeding.getPlanetPositions(), PLANET_RADIUS);
    this._spinTransition.syncCurrentRotation(this._planetSeeding.getSpinAngle());
    this._spinTransition.start();
    this._spinSynth.start(this._spinTransition.getCurrentPosition());
    // Decide which cells fall under Fate Events' crowd BEFORE activate()
    // grows anything — see _applyHumanZoneExclusion's own comment for why
    // this has to happen now, using a PREDICTED final rotation, rather than
    // waiting until the spin actually settles: waiting meant every excluded
    // cell fully grew its plant over the whole spin and then popped/shrank
    // away the instant Leg A finished, instead of simply never growing.
    this._applyHumanZoneExclusion(this._planetSeeding.getSpinAngle() + TOTAL_ROTATION_DELTA);
    // "Many years later" — every cell PlanetSeedingSystem actually colored
    // during Seeding now grows its own plant, in that cell's own fixed
    // color, over the course of this same spin (see PlanetGrowthPool.
    // activate()/update()) — except a cell _applyHumanZoneExclusion just
    // excluded above, which activate() still marks colored/spawned (so it
    // stays consistent bookkeeping) but PlanetGrowthPool.update() then
    // holds at scale 0 forever instead of growing it. Dominant type decides
    // which plant pack(s) supply the mesh — see activate()'s own comment.
    this._growthPool.activate(
      this._planetSeeding.getColoredMask(),
      this._planetSeeding.getCellColors(),
      getGlobals(this.world).dominantPebbleType.peek(),
    );
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
  // Fate Events' true PLANET_CENTER/PLANET_RADIUS, shifted by driftX/driftZ
  // (how far the player has actually wandered from world origin — see
  // FateEventSystem.play()'s own comment) rather than the raw constants, so
  // the grow-in lands in front of wherever the player really is without
  // ever moving their camera to match it. Also doubles as a dev-menu-skip
  // safety net: safe to call even if Leg A never ran, since
  // PlanetSpinTransition's getCurrentPosition/Radius always have a sane
  // default (see its own build()). syncCurrentState() is what makes Leg B
  // continue smoothly from wherever Leg A actually left the planet, rather
  // than snapshotting Leg B's own stale build()-time position.
  startFateEventsTransition(driftX = 0, driftZ = 0): void {
    this._fateTransition.syncCurrentState(
      this._spinTransition.getCurrentPosition(),
      this._spinTransition.getCurrentRadius(),
    );
    this._fateTransition.start(driftX, driftZ);
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

    this._updateMoons(delta);
    this._launchQueued();
    this._advanceFlights(delta);
    this._growthPool.update(delta, this._spinTransition.getProgress());
    this._updatePlanetTransitions(delta);
    this._updateSplatFade(delta);
  }

  // Eases every excluded cell's stain color out to nothing (see
  // _applyHumanZoneExclusion) — a no-op loop at MAX_SPLATS' small size
  // until that method actually marks something.
  private _updateSplatFade(delta: number): void {
    const pull = 1 - Math.exp(-SPLAT_FADE_EASE_RATE * delta);
    const colorFades = this._planetMaterial.uniforms.uSplatColorFade.value as Vector4[];
    for (let i = 0; i < MAX_SPLATS; i++) {
      const target = this._humanZoneMask[i] ? 1 : 0;
      if (this._splatFade[i] === target) continue;
      this._splatFade[i] += (target - this._splatFade[i]) * pull;
      colorFades[i].w = this._splatFade[i];
    }
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

  // Fate Events' people/King (see fate-event-system.ts) render at fixed
  // WORLD-space directions around CROWD_CAP_DIRECTION, independent of this
  // mesh's own rotation — but PlanetGrowthPool's sprouts are parented under
  // this mesh, in LOCAL directions (CELL_DIRS) that spin along with it
  // during Leg A. The two only line up in world space once the mesh's
  // rotation is known — called from startSpinTransition(), BEFORE
  // activate() ever grows anything, with the PREDICTED final rotation
  // (current angle + PlanetSpinTransition.TOTAL_ROTATION_DELTA, a fixed
  // constant regardless of what that current angle happens to be — see its
  // own comment) rather than waiting for the spin to actually finish and
  // reading it live: waiting meant every excluded cell fully grew its
  // plant over the whole ~11s spin and then popped/shrank away the instant
  // it settled, instead of simply never growing in the first place (it
  // also doubled as a rapid handful of neighboring plants all popping at
  // once, easy to misread as a rendering glitch). For every cell, rotate
  // its fixed local CELL_DIRS direction by the given (predicted) rotation
  // to get its actual final world direction, and if that falls within
  // PLANT_EXCLUSION_HALF_ANGLE of CROWD_CAP_DIRECTION (the same footprint
  // the crowd itself renders within), mark it excluded — PlanetGrowthPool
  // then holds that slot's plant at scale 0 forever (see its own
  // excludeSlot()) instead of growing it, and update() below holds its
  // stain splat's color fade at 1 (invisible) the same way, so a plant
  // never grows there and its ground stain fades out over the same window
  // the rest of the grid is blooming, rather than the two ever visibly
  // overlapping.
  private _applyHumanZoneExclusion(rotY: number): void {
    const minDot = Math.cos(PLANT_EXCLUSION_HALF_ANGLE);
    for (let i = 0; i < MAX_SPLATS; i++) {
      this._scratchCellDir.set(CELL_DIRS[i * 3], CELL_DIRS[i * 3 + 1], CELL_DIRS[i * 3 + 2]);
      this._scratchCellDir.applyAxisAngle(this._yAxis, rotY);
      if (this._scratchCellDir.dot(CROWD_CAP_DIRECTION) >= minDot) {
        this._humanZoneMask[i] = 1;
        this._growthPool.excludeSlot(i);
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
      // Leg B/C never rotate on their own (a "zoom in"/"recede," not a
      // spin) — rotation just holds Leg A's final settled angle.
      this._planetMesh.rotation.y = this._spinTransition.getCurrentRotationY();
    } else if (useLegB) {
      this._planetMesh.position.copy(this._fateTransition.getCurrentPosition());
      radius = this._fateTransition.getCurrentRadius();
      this._planetMesh.rotation.y = this._spinTransition.getCurrentRotationY();
    } else if (useLegA) {
      this._planetMesh.position.copy(this._spinTransition.getCurrentPosition());
      radius = this._spinTransition.getCurrentRadius();
      this._planetMesh.rotation.y = this._spinTransition.getCurrentRotationY();
    } else {
      // Pure Seeding — no leg has ever started. The mesh follows
      // PlanetSeedingSystem's live head-following position and its slow
      // ambient spin (owned there so landing cells can be picked in this
      // same rotating frame — see its getSpinAngle()).
      const live = this._planetSeeding.getPlanetPositions();
      this._planetMesh.position.set(live[0], live[1], live[2]);
      radius = PLANET_RADIUS;
      this._planetMesh.rotation.y = this._planetSeeding.getSpinAngle();
    }
    this._planetMesh.scale.setScalar(radius);
  }

  private _launchQueued(): void {
    const events = this._planetSeeding.drainLaunchEvents();
    if (events.length === 0) return;

    // Every cell's fixed future-plant color (see planet-seeding-system.ts's
    // own _cellColor) — a landing's dust mote and the splat it leaves both
    // take THIS cell's color now, not an independently-rolled one, so what
    // falls and what stains always match the plant that will eventually
    // grow there.
    const cellColors = this._planetSeeding.getCellColors();

    for (const ev of events) {
      // Origin and landing cell are both authoritative from gameplay —
      // PlanetSeedingSystem only drops a pebble once its tail position is
      // outside the planet (see its _sampleDropOrigin).
      const color: [number, number, number] = [
        cellColors[ev.cellIndex * 3],
        cellColors[ev.cellIndex * 3 + 1],
        cellColors[ev.cellIndex * 3 + 2],
      ];

      if (this._flightCount < MAX_INFLIGHT) {
        const slot = this._flightCount++;
        this._flightFromX[slot] = ev.originX;
        this._flightFromY[slot] = ev.originY;
        this._flightFromZ[slot] = ev.originZ;
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
    // The mesh's own transform, not PlanetSeedingSystem's position: landing
    // dirs are in the mesh's local (spinning) frame, so a mote has to chase
    // its cell as the planet turns — including a mote still in the air when
    // Leg A takes over the planet's position/rotation/scale.
    const px = this._planetMesh.position.x;
    const py = this._planetMesh.position.y;
    const pz = this._planetMesh.position.z;
    const landRadius = this._planetMesh.scale.x;
    const cosRot = Math.cos(this._planetMesh.rotation.y);
    const sinRot = Math.sin(this._planetMesh.rotation.y);

    let i = 0;
    while (i < this._flightCount) {
      const t = Math.min(1, this._flightT[i] + delta / FLIGHT_DURATION);
      this._flightT[i] = t;
      // Sweep eases smoothly; the radius descent uses an ease-IN curve
      // (starts slow, accelerates) — the classic "falling under gravity"
      // character — while still landing exactly on target at t=1 regardless
      // of the curve shape, since both interpolate between the same two
      // fixed endpoints.
      const easedSweep = t * t * (3 - 2 * t);
      const easedRadius = t * t;

      // Direction + radius from the planet's CURRENT center, not a
      // straight-line lerp between the two endpoint world positions — a
      // straight line from an off-surface origin to a landing point on the
      // far side of the sphere cuts straight through the planet's interior
      // whenever the two are more than a modest angle apart (this used to
      // happen often, since the fall origin is sampled from the comet's
      // trail, not from directly above the landing cell). Slerping the
      // unit DIRECTION from origin to landing while separately easing the
      // RADIUS down from the origin's own distance to exactly PLANET_RADIUS
      // keeps every intermediate point on or outside the sphere (both
      // endpoints already satisfy that, and the radius eases monotonically
      // between them) — the mote arcs around the surface instead of
      // clipping through it.
      let fromDX = this._flightFromX[i] - px;
      let fromDY = this._flightFromY[i] - py;
      let fromDZ = this._flightFromZ[i] - pz;
      const rawFromRadius = Math.sqrt(fromDX * fromDX + fromDY * fromDY + fromDZ * fromDZ);
      const invFromRadius = rawFromRadius > 1e-5 ? 1 / rawFromRadius : 0;
      // A trail sample that starts inside the planet would otherwise begin
      // the whole path under the surface.
      const fromRadius = Math.max(rawFromRadius, landRadius);
      fromDX *= invFromRadius;
      fromDY *= invFromRadius;
      fromDZ *= invFromRadius;

      const localX = this._flightDirX[i];
      const localZ = this._flightDirZ[i];
      const toDX = localX * cosRot + localZ * sinRot;
      const toDY = this._flightDirY[i];
      const toDZ = -localX * sinRot + localZ * cosRot;

      const dot = Math.min(1, Math.max(-1, fromDX * toDX + fromDY * toDY + fromDZ * toDZ));
      const angle = Math.acos(dot);
      let dirX: number, dirY: number, dirZ: number;
      if (angle < 1e-4) {
        dirX = toDX;
        dirY = toDY;
        dirZ = toDZ;
      } else {
        const sinAngle = Math.sin(angle);
        const scaleFrom = Math.sin((1 - easedSweep) * angle) / sinAngle;
        const scaleTo = Math.sin(easedSweep * angle) / sinAngle;
        dirX = fromDX * scaleFrom + toDX * scaleTo;
        dirY = fromDY * scaleFrom + toDY * scaleTo;
        dirZ = fromDZ * scaleFrom + toDZ * scaleTo;
      }

      const radius = fromRadius + (landRadius - fromRadius) * easedRadius;
      this._scratchDustPos.set(px + dirX * radius, py + dirY * radius, pz + dirZ * radius);
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
    const centerBirth = (this._planetMaterial.uniforms.uSplatCenterBirth.value as Vector4[])[cellIndex];
    const colorFade = (this._planetMaterial.uniforms.uSplatColorFade.value as Vector4[])[cellIndex];
    centerBirth.x = dirX;
    centerBirth.y = dirY;
    centerBirth.z = dirZ;
    colorFade.x = color[0];
    colorFade.y = color[1];
    colorFade.z = color[2];
    // Only stamp the birth time (w) the FIRST time this cell is colored (sentinel
    // -1 -> "not yet colored", see planet-stain-material.ts). A repeat
    // landing on an already-colored cell (very common — orbiting back over
    // ground you've already covered) still re-tints it, but used to also
    // reset the birth time to "now," which restarts the shader's grow-in curve
    // (threshold eases back from a single point up to that stage's cap over
    // SPLAT_GROW_SECONDS) — a fully-grown patch would visibly shrink back
    // toward the near-black base color for that half-second before
    // regrowing, reading as the planet "going more black." Leaving an
    // already-born cell's birth time alone keeps it permanently at its
    // full-grown size.
    if (centerBirth.w < 0) centerBirth.w = this._time;
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

    // No growth-pool flourish here anymore — plants no longer grow during
    // Seeding at all (see PlanetGrowthPool's own class comment); the grid
    // only ever colors in here, and every colored cell blooms into a real
    // plant later, in one batch, once Leg A's spin begins (see
    // startSpinTransition()).
  }
}
