import {
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
import { makeAtmosphereGlowMaterial } from '../../vfx/shaders/atmosphere-glow-material.js';
import { makePlanetStainMaterial } from '../../vfx/shaders/planet-stain-material.js';
import { makeSparkleMaterial } from '../../vfx/shaders/sparkle-material.js';
import { StardustSystem } from '../stardust/stardust-system.js';
import { PlanetFateTransition } from './planet-fate-transition.js';
import { PlanetGrowthPool } from './planet-growth-pool.js';
import { N_DOTS, N_PLANETS, PLANET_RADIUS, PlanetSeedingSystem } from './planet-seeding-system.js';

const DOT_COLOR: [number, number, number] = [0.65, 0.85, 1.0];
const DUST_COLOR: [number, number, number] = [1.0, 0.96, 0.82];
const DOT_SIZE = 0.035;
const DUST_SIZE = 0.03;
const FLIGHT_DURATION = 0.6;
const MAX_INFLIGHT = 16;
const COVERAGE_EASE_RATE = 2.5;
const BASE_COLOR: [number, number, number] = [0.02, 0.03, 0.05];
const ATMOSPHERE_SCALE = PLANET_RADIUS * 1.35;
// Minimum coverage for a planet to count as "seeded" when picking which one
// becomes the Fate Events planet — below this (including a dev-menu jump
// straight to Fate Events, which skips Seeding's gameplay entirely and
// leaves every planet at 0), fall back to a random pick instead.
const MIN_COVERAGE_FOR_SELECTION = 0.05;

// Planets are Chapter 3's own reveal — they shouldn't be visible while the
// player is still gathering stardust/pebbles, only from Seeding onward
// (same "hasn't formed yet" treatment PebbleCometPresentationSystem gives
// the comet body itself). Constellations now comes right after Seeding (see
// phase.ts's PHASE_ORDER) and is staged around the same planet as it grows
// into the Fate Events planet, so it must stay in the visible set, not the
// hidden one.
const PLANETS_HIDDEN_DURING = new Set<Phase>([Phase.Stardust, Phase.Pebbles]);

// 9 distinct hues spread across the wheel — "9 different worlds coming
// alive" rather than one flat seeded color repeated everywhere.
const STAIN_PALETTE: [number, number, number][] = Array.from({ length: N_PLANETS }, (_, i) =>
  hslToRgb(i / N_PLANETS, 0.65, 0.55),
);

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

// Renders PlanetSeedingSystem's simulation state: 9 persistent planet
// meshes that grow a colored "seeded" stain as stardust lands on them, the
// dotted weave-line's touch markers (Seeding-only), and the in-flight dust
// motes migrating from a hand's trail onto their assigned planet. Not
// GameDirector-managed — like PebbleCometPresentationSystem, planets are
// meant to persist as permanent scenery from Seeding onward, so this system
// registers always-on and self-gates only the dot markers' visibility via
// gamePhase. Coverage/dot state resets when a fresh loop re-enters Stardust.
export class PlanetSeedingVfxSystem extends createSystem({
  hands: { required: [CometBody, CometTrail, HandAnchor] },
}) {
  private _planetSeeding!: PlanetSeedingSystem;
  private _stardust!: StardustSystem;
  private _trailSystem!: CometTrailSystem;
  private _handEntity: Entity | null = null;

  private _planetMeshes: Mesh[] = [];
  private _planetMaterials: ShaderMaterial[] = [];
  private _planetEntities: Entity[] = [];
  private _coverage!: Float32Array;
  private _coverageTarget!: Float32Array;
  private _stainCenter!: Float32Array; // N_PLANETS*3, local-space unit direction
  private _stainSet!: Uint8Array;
  private _planetsVisible = false;

  // Class-specific seeding flourishes (blue=hearts, green=growth, red=
  // atmosphere) — see planet-growth-pool.ts/heart-burst-pool.ts and this
  // file's own _buildAtmospheres(). Which one actually activates is decided
  // at trigger-time from getGlobals(world).dominantPebbleType, not cached,
  // since this system boots (and builds all three, always) before Pebbles
  // has ever run.
  private _heartBursts!: HeartBurstPool;
  private _growthPool!: PlanetGrowthPool;
  private _atmosphereMeshes: Mesh[] = [];
  private _atmosphereMaterials: ShaderMaterial[] = [];

  // Drives the ring-rotate + scale-up transition into becoming the Fate
  // Events planet — see planet-fate-transition.ts. Always ticked in
  // update() (a no-op once settled/never started), with the live per-planet
  // transform it produces written into _planetMeshes every frame.
  private _fateTransition!: PlanetFateTransition;

  private _dotGeo!: BufferGeometry;
  private _dotSize!: Float32Array;
  private _dotPoints!: Points;
  private _dotEntity!: Entity;

  private _dustGeo!: BufferGeometry;
  private _dustPositions!: Float32Array;
  private _dustBright!: Float32Array;
  private _dustPoints!: Points;
  private _dustEntity!: Entity;
  private _dustMaterial!: ShaderMaterial;

  // In-flight dust motes — fixed-capacity, kept compact (swap-remove on
  // landing, see _update loop) so rendering is always a plain [0,_flightCount).
  private _flightFromX!: Float32Array;
  private _flightFromY!: Float32Array;
  private _flightFromZ!: Float32Array;
  private _flightDirX!: Float32Array; // local-space unit landing direction
  private _flightDirY!: Float32Array;
  private _flightDirZ!: Float32Array;
  private _flightTargetPlanet!: Uint8Array;
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

    this._buildPlanets();
    this._buildAtmospheres();
    this._buildDots();
    this._buildDustCloud();

    this._heartBursts = new HeartBurstPool();
    this._heartBursts.build(this.world);
    this._growthPool = new PlanetGrowthPool();
    this._growthPool.build(this.world, this._planetSeeding.getPlanetPositions());
    this._fateTransition = new PlanetFateTransition();
    this._fateTransition.build(this._planetSeeding.getPlanetPositions());

    this._flightFromX = new Float32Array(MAX_INFLIGHT);
    this._flightFromY = new Float32Array(MAX_INFLIGHT);
    this._flightFromZ = new Float32Array(MAX_INFLIGHT);
    this._flightDirX = new Float32Array(MAX_INFLIGHT);
    this._flightDirY = new Float32Array(MAX_INFLIGHT);
    this._flightDirZ = new Float32Array(MAX_INFLIGHT);
    this._flightTargetPlanet = new Uint8Array(MAX_INFLIGHT);
    this._flightT = new Float32Array(MAX_INFLIGHT);

    // signal.subscribe() fires immediately, so visibility/reset state is
    // correct before the first frame renders.
    this.cleanupFuncs.push(
      getGlobals(this.world).gamePhase.subscribe((phase) => {
        this._dotPoints.visible = phase === Phase.Seeding;
        const planetsVisible = !PLANETS_HIDDEN_DURING.has(phase);
        this._planetsVisible = planetsVisible;
        for (const mesh of this._planetMeshes) mesh.visible = planetsVisible;
        this._dustPoints.visible = planetsVisible;
        if (phase === Phase.Stardust) this._resetPlanets();
      }),
    );
  }

  private _buildAtmospheres(): void {
    const positions = this._planetSeeding.getPlanetPositions();
    for (let p = 0; p < N_PLANETS; p++) {
      const geo = new SphereGeometry(1, 24, 16);
      const mat = makeAtmosphereGlowMaterial();
      const mesh = new Mesh(geo, mat);
      mesh.name = `atmosphere-${p}`;
      mesh.position.set(positions[p * 3], positions[p * 3 + 1], positions[p * 3 + 2]);
      mesh.scale.setScalar(ATMOSPHERE_SCALE);
      mesh.frustumCulled = false;
      mesh.visible = false;
      this._atmosphereMeshes.push(mesh);
      this._atmosphereMaterials.push(mat);
      this.world.createTransformEntity(mesh);
    }
  }

  private _buildPlanets(): void {
    const positions = this._planetSeeding.getPlanetPositions();
    this._coverage = new Float32Array(N_PLANETS);
    this._coverageTarget = new Float32Array(N_PLANETS);
    this._stainCenter = new Float32Array(N_PLANETS * 3);
    this._stainSet = new Uint8Array(N_PLANETS);

    for (let p = 0; p < N_PLANETS; p++) {
      // A fresh buildOrganicGeometry() call per planet (not a single shared
      // instance) — same technique the comet's pebbles/head use for their
      // rocky look, but each of the 9 "worlds" gets its own random bump
      // field for visual variety rather than looking like 9 clones. Built
      // at buildOrganicGeometry's own unit radius (~1) and scaled down via
      // mesh.scale, same pattern PebbleCometPresentationSystem's head uses
      // (kHeadGeo + headMesh.scale.setScalar(HEAD_RADIUS)) — the stain
      // shader normalizes vLocalPos, so it's indifferent to this scale.
      const geo = buildOrganicGeometry();
      const mat = makePlanetStainMaterial(BASE_COLOR, STAIN_PALETTE[p]);
      const mesh = new Mesh(geo, mat);
      // Position/scale are driven every frame from _fateTransition's live
      // state (see _updateFateTransition) — these initial values just avoid
      // a one-frame flash at the origin before the first update() runs.
      mesh.position.set(positions[p * 3], positions[p * 3 + 1], positions[p * 3 + 2]);
      mesh.scale.setScalar(PLANET_RADIUS);
      mesh.frustumCulled = false;
      const entity = this.world.createTransformEntity(mesh);
      entity.addComponent(AudioSource, {
        src: 'dustLand',
        positional: true,
        loop: false,
        playbackMode: PlaybackMode.Overlap,
      });
      this._planetMeshes.push(mesh);
      this._planetMaterials.push(mat);
      this._planetEntities.push(entity);
    }
  }

  private _buildDots(): void {
    const dotPositions = this._planetSeeding.getDotPositions();
    this._dotSize = new Float32Array(N_DOTS).fill(DOT_SIZE);
    const bright = new Float32Array(N_DOTS).fill(0.85);
    const phase = new Float32Array(N_DOTS);
    for (let i = 0; i < N_DOTS; i++) phase[i] = Math.random();

    this._dotGeo = new BufferGeometry();
    // Zero-copy — dot positions never move once placed.
    this._dotGeo.setAttribute('position', new BufferAttribute(dotPositions, 3));
    const sizeAttr = new BufferAttribute(this._dotSize, 1);
    sizeAttr.setUsage(DynamicDrawUsage);
    this._dotGeo.setAttribute('aSize', sizeAttr);
    this._dotGeo.setAttribute('aBright', new BufferAttribute(bright, 1));
    this._dotGeo.setAttribute('aPhase', new BufferAttribute(phase, 1));

    const dotMat = makeSparkleMaterial({ color: DOT_COLOR });
    this._dotPoints = new Points(this._dotGeo, dotMat);
    this._dotPoints.frustumCulled = false;
    this._dotEntity = this.world.createTransformEntity(this._dotPoints);
  }

  private _buildDustCloud(): void {
    this._dustPositions = new Float32Array(MAX_INFLIGHT * 3);
    this._dustBright = new Float32Array(MAX_INFLIGHT).fill(0.9);
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
    this._dustGeo.setDrawRange(0, 0);

    this._dustMaterial = makeSparkleMaterial({ color: DUST_COLOR });
    this._dustPoints = new Points(this._dustGeo, this._dustMaterial);
    this._dustPoints.frustumCulled = false;
    this._dustEntity = this.world.createTransformEntity(this._dustPoints);
  }

  private _resetPlanets(): void {
    this._coverage.fill(0);
    this._coverageTarget.fill(0);
    this._stainSet.fill(0);
    for (const mat of this._planetMaterials) mat.uniforms.uCoverage.value = 0;
    this._flightCount = 0;
    this._dustGeo.setDrawRange(0, 0);

    this._heartBursts.reset();
    this._growthPool.reset();
    for (let p = 0; p < N_PLANETS; p++) {
      this._atmosphereMeshes[p].visible = false;
      this._atmosphereMaterials[p].uniforms.uIntensity.value = 0;
    }
    this._fateTransition.reset(this._planetSeeding.getPlanetPositions());
  }

  // Called by FateEventVfxSystem.play() — picks whichever planet was seeded
  // the most (falling back to random when nothing clears
  // MIN_COVERAGE_FOR_SELECTION, which covers both a genuine tie/no-signal
  // case and a dev-menu jump straight to Fate Events that skipped Seeding's
  // gameplay entirely) and kicks off the rotate/grow transition. The chosen
  // planet's own class-flourish decorations (atmosphere glow, grown-in
  // people) are hidden rather than carried along — see PlanetGrowthPool's
  // own comment on hidePlanet() for why.
  startFateEventsTransition(): void {
    let selected = -1;
    let bestCoverage = MIN_COVERAGE_FOR_SELECTION;
    for (let p = 0; p < N_PLANETS; p++) {
      if (this._coverage[p] > bestCoverage) {
        bestCoverage = this._coverage[p];
        selected = p;
      }
    }
    if (selected === -1) selected = Math.floor(Math.random() * N_PLANETS);

    this._atmosphereMeshes[selected].visible = false;
    this._growthPool.hidePlanet(selected);
    this._fateTransition.start(selected);
  }

  isFateTransitionActive(): boolean {
    return this._fateTransition.isActive();
  }

  update(delta: number, time: number): void {
    this._dotMaterialTime(time);

    const touched = this._planetSeeding.getDotTouched();
    for (let d = 0; d < N_DOTS; d++) {
      this._dotSize[d] = touched[d] ? 0 : DOT_SIZE;
    }
    (this._dotGeo.getAttribute('aSize') as BufferAttribute).needsUpdate = true;

    this._camRight.setFromMatrixColumn(this.camera.matrixWorld, 0);
    this._camUp.setFromMatrixColumn(this.camera.matrixWorld, 1);
    this._camFwd.setFromMatrixColumn(this.camera.matrixWorld, 2);

    this._launchQueued();
    this._advanceFlights(delta);
    this._easeCoverage(delta, time);
    this._heartBursts.update(delta, this.camera);
    this._growthPool.update(delta);
    this._updateFateTransition(delta);
  }

  private _updateFateTransition(delta: number): void {
    this._fateTransition.update(delta);
    const positions = this._fateTransition.getCurrentPositions();
    const radii = this._fateTransition.getCurrentRadii();
    for (let p = 0; p < N_PLANETS; p++) {
      this._planetMeshes[p].position.set(positions[p * 3], positions[p * 3 + 1], positions[p * 3 + 2]);
      this._planetMeshes[p].scale.setScalar(radii[p]);
    }
  }

  private _dotMaterialTime(time: number): void {
    (this._dotPoints.material as ShaderMaterial).uniforms.uTime.value = time;
    this._dustMaterial.uniforms.uTime.value = time;
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

      const px = planetPositions[ev.targetPlanet * 3];
      const py = planetPositions[ev.targetPlanet * 3 + 1];
      const pz = planetPositions[ev.targetPlanet * 3 + 2];
      let dx = this._scratchPos.x - px;
      let dy = this._scratchPos.y - py;
      let dz = this._scratchPos.z - pz;
      const len = Math.max(1e-5, Math.sqrt(dx * dx + dy * dy + dz * dz));
      dx /= len;
      dy /= len;
      dz /= len;

      if (this._flightCount < MAX_INFLIGHT) {
        const slot = this._flightCount++;
        this._flightFromX[slot] = this._scratchPos.x;
        this._flightFromY[slot] = this._scratchPos.y;
        this._flightFromZ[slot] = this._scratchPos.z;
        this._flightDirX[slot] = dx;
        this._flightDirY[slot] = dy;
        this._flightDirZ[slot] = dz;
        this._flightTargetPlanet[slot] = ev.targetPlanet;
        this._flightT[slot] = 0;
      } else {
        // In-flight capacity exceeded (only possible during a mass force-
        // drain at phase end) — resolve the landing immediately rather
        // than dropping the mote's effect on the planet.
        this._applyLanding(ev.targetPlanet, dx, dy, dz);
      }
    }
  }

  private _advanceFlights(delta: number): void {
    let i = 0;
    while (i < this._flightCount) {
      const t = Math.min(1, this._flightT[i] + delta / FLIGHT_DURATION);
      this._flightT[i] = t;
      const eased = t * t * (3 - 2 * t);

      const planet = this._flightTargetPlanet[i];
      const px = this._planetSeeding.getPlanetPositions()[planet * 3];
      const py = this._planetSeeding.getPlanetPositions()[planet * 3 + 1];
      const pz = this._planetSeeding.getPlanetPositions()[planet * 3 + 2];
      const landX = px + this._flightDirX[i] * PLANET_RADIUS;
      const landY = py + this._flightDirY[i] * PLANET_RADIUS;
      const landZ = pz + this._flightDirZ[i] * PLANET_RADIUS;

      this._dustPositions[i * 3] = this._flightFromX[i] + (landX - this._flightFromX[i]) * eased;
      this._dustPositions[i * 3 + 1] = this._flightFromY[i] + (landY - this._flightFromY[i]) * eased;
      this._dustPositions[i * 3 + 2] = this._flightFromZ[i] + (landZ - this._flightFromZ[i]) * eased;

      if (t >= 1) {
        this._applyLanding(planet, this._flightDirX[i], this._flightDirY[i], this._flightDirZ[i]);
        // Swap-remove: pull the last active slot into this one, don't
        // advance i (the swapped-in entry still needs processing).
        const last = this._flightCount - 1;
        this._flightFromX[i] = this._flightFromX[last];
        this._flightFromY[i] = this._flightFromY[last];
        this._flightFromZ[i] = this._flightFromZ[last];
        this._flightDirX[i] = this._flightDirX[last];
        this._flightDirY[i] = this._flightDirY[last];
        this._flightDirZ[i] = this._flightDirZ[last];
        this._flightTargetPlanet[i] = this._flightTargetPlanet[last];
        this._flightT[i] = this._flightT[last];
        this._flightCount--;
      } else {
        i++;
      }
    }

    this._dustGeo.setDrawRange(0, this._flightCount);
    (this._dustGeo.getAttribute('position') as BufferAttribute).needsUpdate = true;
  }

  private _applyLanding(planet: number, dirX: number, dirY: number, dirZ: number): void {
    if (!this._stainSet[planet]) {
      this._stainCenter[planet * 3] = dirX;
      this._stainCenter[planet * 3 + 1] = dirY;
      this._stainCenter[planet * 3 + 2] = dirZ;
      this._stainSet[planet] = 1;
      const uniform = this._planetMaterials[planet].uniforms.uStainCenter.value as Vector3;
      uniform.set(dirX, dirY, dirZ);
    }
    const dustPerPlanet = this._planetSeeding.getDustPerPlanet()[planet];
    this._coverageTarget[planet] += 1 / Math.max(1, dustPerPlanet);
    AudioUtils.play(this._planetEntities[planet]);

    // Class-specific flourish — blue/green trigger once per landing; red is
    // purely coverage-driven (see _easeCoverage), since coverage was just
    // incremented above regardless of class.
    const dominant = getGlobals(this.world).dominantPebbleType.peek();
    const planetPositions = this._planetSeeding.getPlanetPositions();
    if (dominant === 0) {
      const x = planetPositions[planet * 3] + dirX * PLANET_RADIUS;
      const y = planetPositions[planet * 3 + 1] + dirY * PLANET_RADIUS;
      const z = planetPositions[planet * 3 + 2] + dirZ * PLANET_RADIUS;
      this._heartBursts.spawn(x, y, z, dirX, dirY, dirZ);
    } else if (dominant === 1) {
      this._growthPool.trySpawn(planet, planetPositions, dirX, dirY, dirZ);
    }
  }

  private _easeCoverage(delta: number, time: number): void {
    const dominant = getGlobals(this.world).dominantPebbleType.peek();
    const selectedForFate = this._fateTransition.getSelectedPlanet();
    const pull = 1 - Math.exp(-COVERAGE_EASE_RATE * delta);
    for (let p = 0; p < N_PLANETS; p++) {
      if (this._coverage[p] !== this._coverageTarget[p]) {
        this._coverage[p] += (this._coverageTarget[p] - this._coverage[p]) * pull;
        this._planetMaterials[p].uniforms.uCoverage.value = this._coverage[p];
      }

      // The planet that's become (or is becoming) the Fate Events planet
      // keeps its atmosphere hidden regardless of coverage — see
      // startFateEventsTransition()'s one-time hide.
      const showAtmosphere = this._planetsVisible && dominant === 2 && p !== selectedForFate;
      this._atmosphereMeshes[p].visible = showAtmosphere;
      if (showAtmosphere) {
        this._atmosphereMaterials[p].uniforms.uIntensity.value = this._coverage[p];
        this._atmosphereMaterials[p].uniforms.uTime.value = time;
      }
    }
  }
}
