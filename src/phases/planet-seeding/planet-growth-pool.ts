import { Group, ShaderMaterial, Vector3, World } from '@iwsdk/core';
import { PEBBLE_TYPES } from '../pebbles/pebble-type.js';
import { buildPlaceholderPerson } from '../../vfx/geometry/placeholder-person.js';
import { makeToonRimFlatMaterial } from '../../vfx/shaders/toon-rim-material.js';
import { N_PLANETS, PLANET_RADIUS } from './planet-seeding-system.js';

const PER_PLANET_CAP = 6;
const POOL_SIZE = N_PLANETS * PER_PLANET_CAP;

// PERSON_HEIGHT (0.2) was tuned for Fate Events' ~1.4-radius planet; scaled
// down here so a full-grown figure reads as a small resident on Seeding's
// much smaller PLANET_RADIUS=0.11 planets (~0.032m tall, ~15% of a
// planet's diameter) rather than a giant looming over it.
const GROWTH_TARGET_SCALE = 0.16;
const GROWTH_EASE_RATE = 2.0; // 1/s exponential ease, same idiom as _easeCoverage

// Green class's seeding flourish: "cause life to grow" — tiny
// buildPlaceholderPerson() figures pop up and permanently grow at each
// landing spot, capped per planet (an "established little colony," not
// unbounded clutter at this tiny scale). Not a System — a plain pooled-
// effect class driven by explicit trySpawn()/update()/reset() calls from
// PlanetSeedingVfxSystem, same idiom as HeartBurstPool. Fixed slots
// (planet*PER_PLANET_CAP + localIndex), no free-list needed: a planet's
// count only ever grows within a single Seeding attempt, and reset()
// zeroes every planet's count together on a fresh loop.
export class PlanetGrowthPool {
  private _material!: ShaderMaterial;
  private _groups: Group[] = [];
  private _scale = new Float32Array(POOL_SIZE);
  private _targetScale = new Float32Array(POOL_SIZE);
  private _countPerPlanet = new Uint8Array(N_PLANETS);

  private _upAxis = new Vector3(0, 1, 0);
  private _dirVec = new Vector3();

  build(world: World, planetPositions: Float32Array): void {
    this._material = makeToonRimFlatMaterial(PEBBLE_TYPES[1].color);

    for (let planet = 0; planet < N_PLANETS; planet++) {
      for (let local = 0; local < PER_PLANET_CAP; local++) {
        const group = buildPlaceholderPerson(this._material);
        group.name = `growth-person-${planet}-${local}`;
        group.position.set(planetPositions[planet * 3], planetPositions[planet * 3 + 1], planetPositions[planet * 3 + 2]);
        group.scale.setScalar(0);
        group.visible = false;
        this._groups.push(group);
        world.createTransformEntity(group);
      }
    }
  }

  trySpawn(
    planet: number,
    planetPositions: Float32Array,
    dirX: number,
    dirY: number,
    dirZ: number,
  ): boolean {
    const localIndex = this._countPerPlanet[planet];
    if (localIndex >= PER_PLANET_CAP) return false;
    this._countPerPlanet[planet] = localIndex + 1;

    const slot = planet * PER_PLANET_CAP + localIndex;
    const group = this._groups[slot];
    group.position.set(
      planetPositions[planet * 3] + dirX * PLANET_RADIUS,
      planetPositions[planet * 3 + 1] + dirY * PLANET_RADIUS,
      planetPositions[planet * 3 + 2] + dirZ * PLANET_RADIUS,
    );
    this._dirVec.set(dirX, dirY, dirZ);
    group.quaternion.setFromUnitVectors(this._upAxis, this._dirVec);
    group.visible = true;
    this._scale[slot] = 0;
    this._targetScale[slot] = GROWTH_TARGET_SCALE;
    return true;
  }

  update(delta: number): void {
    const pull = 1 - Math.exp(-GROWTH_EASE_RATE * delta);
    for (let i = 0; i < POOL_SIZE; i++) {
      if (this._scale[i] === this._targetScale[i]) continue;
      this._scale[i] += (this._targetScale[i] - this._scale[i]) * pull;
      this._groups[i].scale.setScalar(this._scale[i]);
    }
  }

  // Called when a planet is selected to become the Fate Events planet (see
  // PlanetFateTransition) — its grown-in figures don't travel with it, they
  // just disappear. One-way: no un-hide, since by the time this fires that
  // loop's Seeding gameplay is already over (reset() on the next loop
  // clears everything properly anyway).
  hidePlanet(planet: number): void {
    const base = planet * PER_PLANET_CAP;
    for (let local = 0; local < PER_PLANET_CAP; local++) {
      this._groups[base + local].visible = false;
    }
  }

  reset(): void {
    for (let i = 0; i < POOL_SIZE; i++) {
      this._groups[i].visible = false;
      this._groups[i].scale.setScalar(0);
      this._scale[i] = 0;
      this._targetScale[i] = 0;
    }
    this._countPerPlanet.fill(0);
  }
}
