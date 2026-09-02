import {
  AudioListener,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  createSystem,
  Vector3,
} from '@iwsdk/core';
import { CometBody } from '../../comet/comet-body-component.js';
import { HandAnchor } from '../../comet/hand-anchor-component.js';
import { getGlobals } from '../../core/globals.js';
import { Phase } from '../../core/phase.js';
import { buildOrganicGeometry } from '../../vfx/geometry/organic-rock-geometry.js';
import { buildPlaceholderPerson, PERSON_HEIGHT } from '../../vfx/geometry/placeholder-person.js';
import { scatterOnSphereCap } from '../../vfx/geometry/sphere-scatter.js';
import { makeToonRimFlatMaterial } from '../../vfx/shaders/toon-rim-material.js';
import { GhostRise } from '../../vfx/particles/ghost-rise.js';
import { LocustPool } from '../../vfx/particles/locust-pool.js';
import { ConstellationsSystem } from '../constellations/constellations-system.js';
import { FATE_DIALOGUE } from './fate-dialogue.js';
import { FateEventSystem } from './fate-event-system.js';
import { PlanetSeedingVfxSystem } from '../planet-seeding/planet-seeding-vfx-system.js';

const DOG_COUNT = 4;
const PLANT_COUNT = 8;
const MACHINE_COUNT = 4;
const AMBIENT_LOCUST_COUNT = 4;

// Wider than FateEventSystem's own 28° people cap so decorations spread a
// bit around/among the crowd instead of exactly overlapping it.
const CAP_HALF_ANGLE = (34 * Math.PI) / 180;
const TOWARD_PLAYER = new Vector3(0, 0, 1);
const SURFACE_OFFSET = 0.01;

const STAGGER_WINDOW = 0.3; // same idiom/purpose as FateEventVfxSystem's own person stagger
const REVEAL_EASE_RATE = 3; // 1/s exponential ease toward the staggered target scale

const DOG_COLOR: [number, number, number] = [0.5, 0.35, 0.2];
const PLANT_COLOR: [number, number, number] = [0.35, 0.85, 0.4];
const MACHINE_COLOR = new Color(0.5, 0.52, 0.58);
const KING_COLOR: [number, number, number] = [0.75, 0.62, 0.85];
const CROWN_COLOR = new Color(1.0, 0.85, 0.2);
const TOWER_COLOR = new Color(0.45, 0.43, 0.4);

const TOWER_HEIGHT = 0.35;
const TOWER_RADIUS_TOP = 0.018;
const TOWER_RADIUS_BOTTOM = 0.032;
const KING_SCALE = 1.5;

const GHOST_COLOR_DOG: [number, number, number] = [0.75, 0.87, 1.0];
const GHOST_COLOR_HUMAN: [number, number, number] = [1.0, 1.0, 1.0];
const GHOST_COLOR_KING: [number, number, number] = [1.0, 0.86, 0.4];

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
  const { normals } = scatterOnSphereCap(count, ORIGIN, 1, TOWARD_PLAYER, CAP_HALF_ANGLE);
  const groups: Group[] = [];
  for (let i = 0; i < count; i++) {
    const group = buildOne();
    group.scale.setScalar(0);
    group.visible = false;
    groups.push(group);
  }
  return { groups, normals, scale: new Float32Array(count) };
}

const ORIGIN = new Vector3(0, 0, 0);

// Per-constellation "situation on Earth" — ambient decorations that build in
// on the planet during Leg A's spin (same window FateEventVfxSystem's own
// people progressively appear in, driven by the same
// PlanetSeedingVfxSystem.getSpinProgress()), plus each name's one-shot
// completion payoff (see ConstellationsSystem.isComplete()'s edge below).
// Dispatch is keyed off ConstellationsSystem.getActiveName() (available
// from spin-start, unlike globals.celestialSymbol which only resolves once
// traced) — soul dust/volatile gasses switch on the exact name, organic
// matter is deliberately uniform across all 3 of its names (see the plan
// doc — Bird/Giraffe/Tree already have distinct Fate Events flavor via
// fate-dialogue.ts and don't need separate ambient/complete treatment).
// Always-on and self-gated via gamePhase, never GameDirector-managed — the
// Dog/Human/Crown ghost mechanic (see ghost-rise.ts) persists a permanent
// comet attachment straight through Fate Events/Launch/Finale, so this
// can't be phase-gated the way FateEventSystem's own simulation is. All
// geometry here is a simple placeholder pass, swapped for real 3D assets
// later.
export class EarthSituationsVfxSystem extends createSystem({
  comets: { required: [CometBody, HandAnchor] },
}) {
  private _constellations!: ConstellationsSystem;
  private _planetSeeding!: PlanetSeedingVfxSystem;
  private _fateEvents!: FateEventSystem;

  private _dogs!: DecorationSet;
  private _plants!: DecorationSet;
  private _machines!: DecorationSet;
  private _king!: DecorationSet;
  private _kingBody!: Group; // the king's own figure, hidden separately once he dies

  private _ghost!: GhostRise;
  private _locusts!: LocustPool;
  private _locustNormal!: Float32Array;
  private _audioListener!: AudioListener;

  private _wasComplete = false;

  private _upAxis = new Vector3(0, 1, 0);
  private _scratchNormal = new Vector3();
  private _scratchCenter = new Vector3();
  private _scratchLocustAnchor = new Vector3();
  private _scratchGhostOrigin = new Vector3();
  private _scratchCometPos = new Vector3();

  init(): void {
    // PlanetSeedingVfxSystem/ConstellationsSystem/FateEventSystem must be
    // registered before this system (see index.ts) so they already exist
    // when this init() runs.
    this._constellations = this.world.getSystem(ConstellationsSystem)!;
    this._planetSeeding = this.world.getSystem(PlanetSeedingVfxSystem)!;
    this._fateEvents = this.world.getSystem(FateEventSystem)!;

    this._buildDogs();
    this._buildPlants();
    this._buildMachines();
    this._buildKingTower();

    // Own AudioListener, same reason every other generative-audio VFX
    // system here has one (IWSDK's AudioSource/AudioUtils layer is
    // buffer-only). Passed into GhostRise, which owns the ascension/settle
    // sounds since they're entirely driven by its own state machine.
    this._audioListener = new AudioListener();
    this.player.head.add(this._audioListener);

    this._ghost = new GhostRise();
    this._ghost.build(this.world, this._audioListener, this.scene);
    this._locusts = new LocustPool();
    this._locusts.build(this.world);
    this._locustNormal = scatterOnSphereCap(1, ORIGIN, 1, TOWARD_PLAYER, CAP_HALF_ANGLE).normals;

    this.cleanupFuncs.push(
      getGlobals(this.world).gamePhase.subscribe((phase) => {
        if (phase === Phase.Stardust) this._resetAll();
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

  private _buildPlants(): void {
    const material = makeToonRimFlatMaterial(PLANT_COLOR);
    this._plants = buildDecorationSet(PLANT_COUNT, () => {
      const group = new Group();
      const mesh = new Mesh(buildOrganicGeometry(), material);
      mesh.scale.setScalar(0.025 + Math.random() * 0.015);
      group.add(mesh);
      return group;
    });
    this._registerSet(this._plants);
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

  update(delta: number, time: number): void {
    const globals = getGlobals(this.world);
    const phase = globals.gamePhase.peek();
    const dominant = globals.dominantPebbleType.peek();
    const name = this._constellations.getActiveName();

    this._scratchCenter.copy(this._planetSeeding.getLivePlanetPosition());
    const reach = this._planetSeeding.getLivePlanetRadius() + SURFACE_OFFSET;
    const spinProgress = SITUATION_ELIGIBLE_FROM.has(phase) ? this._planetSeeding.getSpinProgress() : 0;

    const showDogs = dominant === 0 && name === 'Dog';
    const showPlants = dominant === 1;
    const showMachines = dominant === 2;
    const showKing = dominant === 2 && name === 'Crown';
    const showLocustSwarm = dominant === 2 && name === 'Locust';

    this._updateSet(this._dogs, showDogs, spinProgress, delta, this._scratchCenter, reach);
    this._updateSet(this._plants, showPlants, spinProgress, delta, this._scratchCenter, reach);
    this._updateSet(this._machines, showMachines, spinProgress, delta, this._scratchCenter, reach);
    this._updateSet(this._king, showKing, spinProgress, delta, this._scratchCenter, reach);

    if (showLocustSwarm && spinProgress > 0.1) this._locusts.revealUpTo(AMBIENT_LOCUST_COUNT);
    const lnx = this._locustNormal[0];
    const lny = this._locustNormal[1];
    const lnz = this._locustNormal[2];
    this._scratchLocustAnchor.set(
      this._scratchCenter.x + lnx * reach,
      this._scratchCenter.y + lny * reach,
      this._scratchCenter.z + lnz * reach,
    );
    this._locusts.update(time, this._scratchLocustAnchor);

    for (const entity of this.queries.comets.entities) {
      const posView = entity.getVectorView(CometBody, 'position') as Float32Array;
      this._scratchCometPos.fromArray(posView);
      this._ghost.update(delta, this._scratchCometPos);
      break; // exactly one comet entity, see comet-handoff-system.ts
    }

    if (this._constellations.isComplete() && !this._wasComplete) {
      this._wasComplete = true;
      this._onCompletion(name);
    }
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

  private _onCompletion(name: string): void {
    const globals = getGlobals(this.world);

    if (name === 'Dog' || name === 'Human') {
      const pairedIndex = Math.floor(Math.random() * Math.max(1, this._fateEvents.getVisiblePeopleCount()));
      globals.pairedPersonIndex.value = pairedIndex;
      globals.pairedPersonLine.value = FATE_DIALOGUE[name].pairedLine ?? null;

      if (name === 'Dog') {
        this._ghost.trigger(this._dogs.groups[0].position, GHOST_COLOR_DOG);
        this._dogs.groups[0].visible = false; // that dog's body is gone, only its ghost remains
      } else {
        const positions = this._fateEvents.getSurfacePositions();
        this._scratchGhostOrigin.set(
          positions[pairedIndex * 3],
          positions[pairedIndex * 3 + 1],
          positions[pairedIndex * 3 + 2],
        );
        this._ghost.trigger(this._scratchGhostOrigin, GHOST_COLOR_HUMAN);
      }
    } else if (name === 'Crown') {
      this._ghost.trigger(this._king.groups[0].position, GHOST_COLOR_KING);
      this._kingBody.visible = false; // the king's body is gone, tower stands empty
    } else if (name === 'Locust') {
      this._locusts.revealUpTo(99); // "the locusts multiply" — reveal the rest of the pool
    }
  }

  private _resetAll(): void {
    for (const set of [this._dogs, this._plants, this._machines, this._king]) {
      set.scale.fill(0);
      for (const group of set.groups) group.visible = false;
    }
    this._kingBody.visible = true;
    this._ghost.reset();
    this._locusts.reset();
    this._wasComplete = false;

    const globals = getGlobals(this.world);
    globals.pairedPersonIndex.value = null;
    globals.pairedPersonLine.value = null;
  }
}
