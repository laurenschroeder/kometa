import {
  BufferAttribute,
  BufferGeometry,
  createSystem,
  DynamicDrawUsage,
  Points,
  ShaderMaterial,
} from '@iwsdk/core';
import { randomUnitVector3 } from '../vfx/geometry/mesh-utils.js';
import { makeSparkleMaterialVertexColor } from '../vfx/shaders/sparkle-material.js';
import { hexToRgb, STARFIELD_COOL_WHITE, STARFIELD_WARM_WHITE } from '../vfx/color/color-scheme.js';
import { getGlobals } from './globals.js';
import { Phase } from './phase.js';

const BASE_COUNT = 800;
const FILL_COUNT = 2000;
const SHELL_MIN_RADIUS = 25;
const SHELL_MAX_RADIUS = 40;
// aSize stays in the same ballpark as other sparkle clouds (0.03-0.05
// elsewhere) — it's pointSizeFactor below, not aSize, that needs to grow to
// compensate for these points sitting ~15-30x farther out (25-40m here vs
// ~1-2m for nearby dust/star clouds) in makeSparkleMaterial's
// `aSize * factor / -mv.z` formula, so they read as small crisp pinpricks
// rather than either vanishing or ballooning into soft blobs.
const POINT_SIZE = 0.05;
const POINT_SIZE_FACTOR = 3500;
const FILL_EASE_RATE = 1.2; // 1/s, same exponential-pull idiom used elsewhere (e.g. _coverage)

const COOL_WHITE: [number, number, number] = hexToRgb(STARFIELD_COOL_WHITE);
const WARM_WHITE: [number, number, number] = hexToRgb(STARFIELD_WARM_WHITE);

function randomStarColor(): [number, number, number] {
  const t = Math.random();
  return [
    COOL_WHITE[0] + (WARM_WHITE[0] - COOL_WHITE[0]) * t,
    COOL_WHITE[1] + (WARM_WHITE[1] - COOL_WHITE[1]) * t,
    COOL_WHITE[2] + (WARM_WHITE[2] - COOL_WHITE[2]) * t,
  ];
}

interface StarCloud {
  points: Points;
  brightArr: Float32Array;
  brightAttr: BufferAttribute;
  targetBright: Float32Array;
}

// Distant, always-present background starfield — visible from world boot
// (the start menu's sky is already rendered by VirtualSkySystem, see its own
// class comment) straight through every phase, never GameDirector-managed. Two
// point clouds share one big spherical shell, re-centered on world.player
// every frame (see update()) rather than built once and left fixed in world
// space — StartMenuSystem's _recenterToHead() (fired both on Start and on
// every native WebXR reference-space 'reset', i.e. a system-level recenter)
// moves world.player around, and a shell that DIDN'T track it would appear
// to shift the opposite way relative to the viewer every time that fires —
// exactly the "starfield jumped a few feet" bug this fixes. Following the
// player's position (not rotation — the shell is symmetric, so spin doesn't
// matter) is a single Vector3 copy per cloud, cheap regardless of star
// count. A BASE layer that's always fully visible, and a denser FILL layer
// that eases in during Phase.Constellations (see FILL_EASE_RATE) so the sky
// visibly "fills in" around the player for that phase, easing back out once
// it ends. Both reuse makeSparkleMaterialVertexColor so per-star color can
// vary across a cool-to-warm white range instead of one flat hue.
export class StarfieldSystem extends createSystem({}) {
  private _material!: ShaderMaterial;
  private _base!: StarCloud;
  private _fill!: StarCloud;
  private _fillScalar = 0;
  private _fillTarget = 0;

  init(): void {
    this._material = makeSparkleMaterialVertexColor({ pointSizeFactor: POINT_SIZE_FACTOR });
    this._base = this._buildCloud(BASE_COUNT, 0.6, 1.0, /* startAtZero */ false);
    this._fill = this._buildCloud(FILL_COUNT, 0.4, 1.0, /* startAtZero */ true);

    this.cleanupFuncs.push(
      getGlobals(this.world).gamePhase.subscribe((phase) => {
        this._fillTarget = phase === Phase.Constellations ? 1 : 0;
      }),
    );

    // Hidden while passthrough is on — the point of passthrough is almost
    // certainly "let me see the real room clearly" (this experience is
    // handed between strangers at a festival, so there's practical/safety
    // value too, not just aesthetics), and a field of floating stars over
    // someone's living room undercuts that. Both clouds toggle together
    // (unlike SkyBackdropSystem's hero star, neither has its own independent
    // visibility state machine to preserve, so a direct .visible set on each
    // is simplest here).
    const globals = getGlobals(this.world);
    const applyPassthrough = (enabled: boolean) => {
      this._base.points.visible = !enabled;
      this._fill.points.visible = !enabled;
    };
    applyPassthrough(globals.passthroughEnabled.peek());
    this.cleanupFuncs.push(globals.passthroughEnabled.subscribe(applyPassthrough));
  }

  private _buildCloud(count: number, brightMin: number, brightMax: number, startAtZero: boolean): StarCloud {
    const positions = new Float32Array(count * 3);
    const sizeArr = new Float32Array(count);
    const colorArr = new Float32Array(count * 3);
    const phaseArr = new Float32Array(count);
    const brightArr = new Float32Array(count);
    const targetBright = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      const dir = randomUnitVector3();
      const r = SHELL_MIN_RADIUS + Math.random() * (SHELL_MAX_RADIUS - SHELL_MIN_RADIUS);
      positions[i * 3] = dir.x * r;
      positions[i * 3 + 1] = dir.y * r;
      positions[i * 3 + 2] = dir.z * r;

      sizeArr[i] = POINT_SIZE * (0.6 + Math.random() * 0.6);
      const [cr, cg, cb] = randomStarColor();
      colorArr[i * 3] = cr;
      colorArr[i * 3 + 1] = cg;
      colorArr[i * 3 + 2] = cb;
      phaseArr[i] = Math.random();

      const b = brightMin + Math.random() * (brightMax - brightMin);
      targetBright[i] = b;
      brightArr[i] = startAtZero ? 0 : b;
    }

    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(positions, 3));
    geo.setAttribute('aSize', new BufferAttribute(sizeArr, 1));
    geo.setAttribute('aColor', new BufferAttribute(colorArr, 3));
    geo.setAttribute('aPhase', new BufferAttribute(phaseArr, 1));
    const brightAttr = new BufferAttribute(brightArr, 1);
    brightAttr.setUsage(DynamicDrawUsage);
    geo.setAttribute('aBright', brightAttr);

    const points = new Points(geo, this._material);
    points.frustumCulled = false;
    this.world.createTransformEntity(points);

    return { points, brightArr, brightAttr, targetBright };
  }

  update(delta: number, time: number): void {
    this._material.uniforms.uTime.value = time;

    // Keep the shell centered on the player — see this class's own top
    // comment for why this can no longer assume world.player stays put.
    this._base.points.position.copy(this.player.position);
    this._fill.points.position.copy(this.player.position);

    if (Math.abs(this._fillScalar - this._fillTarget) > 1e-4) {
      const pull = 1 - Math.exp(-FILL_EASE_RATE * delta);
      this._fillScalar += (this._fillTarget - this._fillScalar) * pull;
      if (Math.abs(this._fillScalar - this._fillTarget) < 1e-4) this._fillScalar = this._fillTarget;

      const arr = this._fill.brightArr;
      const target = this._fill.targetBright;
      for (let i = 0; i < arr.length; i++) arr[i] = target[i] * this._fillScalar;
      this._fill.brightAttr.needsUpdate = true;
    }
  }
}
