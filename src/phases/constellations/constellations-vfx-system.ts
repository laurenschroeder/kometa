import {
  BufferAttribute,
  BufferGeometry,
  createSystem,
  DynamicDrawUsage,
  Points,
  ShaderMaterial,
} from '@iwsdk/core';
import { getGlobals } from '../../core/globals.js';
import { Phase } from '../../core/phase.js';
import { makeSparkleMaterial } from '../../vfx/shaders/sparkle-material.js';
import { PlanetSeedingVfxSystem } from '../planet-seeding/planet-seeding-vfx-system.js';
import { PEBBLE_TYPES } from '../pebbles/pebble-type.js';
import { ConstellationsSystem, N_TYPES } from './constellations-system.js';

const DOT_SIZE = 0.04;
const DOT_COLOR: [number, number, number] = [0.85, 0.9, 1.0];
const STAR_SIZE = 0.05;

// Renders ConstellationsSystem's simulation state: all 9 possible
// constellations' stars + touch-dot Points clouds are built once here (see
// ConstellationsSystem's own comment on why — this system is always-on and
// needs fixed geometry before that phase's play() ever determines which
// trio is active), only the active type's 3 are ever shown. Stars are
// tinted per pebble type (see pebble-type.ts) so the visual identity
// carries over from Chapter 2's colors. Not GameDirector-managed — like
// PlanetSeedingVfxSystem, the winning constellation's stars persist as
// permanent sky scenery once a winner is set, so this registers always-on
// and self-gates visibility via gamePhase. Resets when a fresh loop
// re-enters Stardust. Stars/dots are now anchored around the big Fate
// Events planet (see constellation-path.ts's placeConstellationAnchorsAroundPlanet)
// rather than free-floating in front of the player, so — same reasoning as
// FateEventVfxSystem's own _planetArrived gate — they stay hidden until
// PlanetSeedingVfxSystem's rotate/grow transition actually finishes
// bringing that planet into place; revealing them at their final
// planet-relative position while the planet is still mid-transition would
// show stars floating where the planet hasn't visually arrived yet.
export class ConstellationsVfxSystem extends createSystem({}) {
  private _constellations!: ConstellationsSystem;
  private _planetSeeding!: PlanetSeedingVfxSystem;
  private _starMats: ShaderMaterial[] = [];
  private _dotMat!: ShaderMaterial;
  // Reset to false each time Constellations begins (see _onPhaseChange),
  // flips true once update() sees the planet-growth transition finish.
  private _revealed = false;

  // All indexed [type][slot].
  private _starPoints: Points[][] = [];
  private _dotPoints: Points[][] = [];
  private _dotSizeAttrs: BufferAttribute[][] = [];
  private _dotSizeArrays: Float32Array[][] = [];

  init(): void {
    this._constellations = this.world.getSystem(ConstellationsSystem)!;
    // PlanetSeedingVfxSystem must be registered before this system (see
    // index.ts) so it already exists when this init() runs.
    this._planetSeeding = this.world.getSystem(PlanetSeedingVfxSystem)!;
    this._dotMat = makeSparkleMaterial({ color: DOT_COLOR });

    for (let type = 0; type < N_TYPES; type++) {
      const starColor = PEBBLE_TYPES[type]?.color ?? [1, 1, 1];
      const starMat = makeSparkleMaterial({ color: starColor, pointSizeFactor: 260 });
      this._starMats.push(starMat);

      const defs = this._constellations.getDefs(type);
      const starRow: Points[] = [];
      const dotRow: Points[] = [];
      const dotSizeAttrRow: BufferAttribute[] = [];
      const dotSizeArrRow: Float32Array[] = [];

      for (let slot = 0; slot < defs.length; slot++) {
        starRow.push(this._buildStars(type, slot, starMat));
        const dots = this._buildDots(type, slot);
        dotRow.push(dots.points);
        dotSizeAttrRow.push(dots.sizeAttr);
        dotSizeArrRow.push(dots.sizeArr);
      }
      this._starPoints.push(starRow);
      this._dotPoints.push(dotRow);
      this._dotSizeAttrs.push(dotSizeAttrRow);
      this._dotSizeArrays.push(dotSizeArrRow);
    }

    // signal.subscribe() fires immediately, so visibility is correct before
    // the first frame renders.
    this.cleanupFuncs.push(
      getGlobals(this.world).gamePhase.subscribe((phase) => this._onPhaseChange(phase)),
    );
  }

  private _buildStars(type: number, slot: number, mat: ShaderMaterial): Points {
    const positions = this._constellations.getStarPositions(type, slot);
    const count = positions.length / 3;
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(positions, 3));
    geo.setAttribute('aSize', new BufferAttribute(new Float32Array(count).fill(STAR_SIZE), 1));
    geo.setAttribute('aBright', new BufferAttribute(new Float32Array(count).fill(0.9), 1));
    const phaseAttr = new Float32Array(count);
    for (let i = 0; i < count; i++) phaseAttr[i] = Math.random();
    geo.setAttribute('aPhase', new BufferAttribute(phaseAttr, 1));

    const points = new Points(geo, mat);
    points.frustumCulled = false;
    points.visible = false;
    this.world.createTransformEntity(points);
    return points;
  }

  private _buildDots(
    type: number,
    slot: number,
  ): { points: Points; sizeAttr: BufferAttribute; sizeArr: Float32Array } {
    const positions = this._constellations.getDotPositions(type, slot);
    const count = positions.length / 3;
    const sizeArr = new Float32Array(count).fill(DOT_SIZE);
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(positions, 3));
    const sizeAttr = new BufferAttribute(sizeArr, 1);
    sizeAttr.setUsage(DynamicDrawUsage);
    geo.setAttribute('aSize', sizeAttr);
    geo.setAttribute('aBright', new BufferAttribute(new Float32Array(count).fill(0.85), 1));
    const phaseAttr = new Float32Array(count);
    for (let i = 0; i < count; i++) phaseAttr[i] = Math.random();
    geo.setAttribute('aPhase', new BufferAttribute(phaseAttr, 1));

    const points = new Points(geo, this._dotMat);
    points.frustumCulled = false;
    points.visible = false;
    this.world.createTransformEntity(points);
    return { points, sizeAttr, sizeArr };
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
    const winner = this._constellations.getWinner();

    for (let type = 0; type < N_TYPES; type++) {
      const isActiveType = type === dominant;
      for (let slot = 0; slot < this._starPoints[type].length; slot++) {
        this._starPoints[type][slot].visible = isActiveType && (active || winner === slot);
        this._dotPoints[type][slot].visible = isActiveType && active;
      }
    }
  }

  private _resetAll(): void {
    for (let type = 0; type < N_TYPES; type++) {
      for (let slot = 0; slot < this._dotSizeArrays[type].length; slot++) {
        this._dotSizeArrays[type][slot].fill(DOT_SIZE);
        this._dotSizeAttrs[type][slot].needsUpdate = true;
      }
    }
  }

  update(_delta: number, time: number): void {
    for (const mat of this._starMats) mat.uniforms.uTime.value = time;
    this._dotMat.uniforms.uTime.value = time;

    const phase = getGlobals(this.world).gamePhase.peek();
    if (!this._revealed && phase === Phase.Constellations && !this._planetSeeding.isFateTransitionActive()) {
      this._revealed = true;
      this._applyVisibility(phase);
    }

    const dominant = getGlobals(this.world).dominantPebbleType.peek();
    const defs = this._constellations.getDefs(dominant);
    for (let slot = 0; slot < defs.length; slot++) {
      const touched = this._constellations.getDotTouched(dominant, slot);
      const sizeArr = this._dotSizeArrays[dominant][slot];
      let changed = false;
      for (let d = 0; d < touched.length; d++) {
        const target = touched[d] ? 0 : DOT_SIZE;
        if (sizeArr[d] !== target) {
          sizeArr[d] = target;
          changed = true;
        }
      }
      if (changed) this._dotSizeAttrs[dominant][slot].needsUpdate = true;
    }
  }
}
