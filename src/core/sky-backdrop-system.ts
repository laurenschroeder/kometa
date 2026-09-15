import {
  AdditiveBlending,
  createSystem,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Vector3,
} from '@iwsdk/core';
import { ConstellationsSystem } from '../phases/constellations/constellations-system.js';
import { buildHeroStarTexture } from '../vfx/textures/star-burst-texture.js';
import { getGlobals } from './globals.js';
import { Phase } from './phase.js';

// The hero star joins the winning constellation's own star cluster (see
// _updateHeroStarPosition) — that cluster lives at near-field range around
// the Fate Events planet (a few meters out), not out at StarfieldSystem's
// background-shell scale, so this is sized for close viewing rather than
// background scale.
const HERO_STAR_SIZE = 1.2; // meters
const HERO_FADE_RATE = 0.9; // 1/s exponential ease, ~2-3s to fully reveal

// A single "hero star" that stays hidden until the player completes their
// constellation, then fades in at that constellation's own star cluster (the
// "brightest star of what you've become"). The ambient background starfield/
// haze this used to also own has moved to StarfieldSystem — kept separate
// here since the hero star tracks game state (celestialSymbol) rather than
// being pure ambient dressing. Not GameDirector-managed — always-on and
// self-gated via gamePhase, same idiom as StarfieldSystem/PlanetSeedingVfxSystem.
export class SkyBackdropSystem extends createSystem({}) {
  private _constellations!: ConstellationsSystem;

  private _heroMesh!: Mesh;
  // Wraps _heroMesh purely so passthrough can hide it without touching the
  // mesh's own independent reveal-state .visible toggles below (Three.js
  // requires both parent AND self .visible true to render, so this composes
  // cleanly with _resetHeroStar()/_tryRevealHeroStar() rather than requiring
  // them to know about passthrough too).
  private _heroGroup!: Group;
  private _heroMaterial!: MeshBasicMaterial;
  private _heroRevealed = false;
  private _heroScale = 0;
  private _heroOpacity = 0;

  private _scratchCentroid = new Vector3();
  private _camWorldPos = new Vector3();
  private _faceDir = new Vector3();
  private _zAxis = new Vector3(0, 0, 1);

  init(): void {
    // Registered after ConstellationsSystem in index.ts so this lookup
    // resolves.
    this._constellations = this.world.getSystem(ConstellationsSystem)!;

    this._buildHeroStar();

    this.cleanupFuncs.push(
      getGlobals(this.world).gamePhase.subscribe((phase) => {
        if (phase === Phase.Stardust) this._resetHeroStar();
        // Checked fresh here (isComplete(), not a celestialSymbol change-
        // subscription) — on a repeat loop the player may win the SAME
        // constellation again, and a signal assignment that doesn't change
        // the value never notifies subscribers, so a change-subscription
        // would silently miss that case. FateEvents is the first phase
        // after Constellations, so isComplete() is already final by now.
        if (phase === Phase.FateEvents) this._tryRevealHeroStar();
      }),
    );

    // Hidden while passthrough is on — same reasoning as StarfieldSystem's
    // own stars.
    const globals = getGlobals(this.world);
    const applyPassthrough = (enabled: boolean) => {
      this._heroGroup.visible = !enabled;
    };
    applyPassthrough(globals.passthroughEnabled.peek());
    this.cleanupFuncs.push(globals.passthroughEnabled.subscribe(applyPassthrough));
  }

  private _buildHeroStar(): void {
    const texture = buildHeroStarTexture();
    const geo = new PlaneGeometry(1, 1);
    this._heroMaterial = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: AdditiveBlending,
      opacity: 0,
    });
    const mesh = new Mesh(geo, this._heroMaterial);
    mesh.visible = false;
    mesh.frustumCulled = false;
    this._heroMesh = mesh;
    const group = new Group();
    group.add(mesh);
    this._heroGroup = group;
    this.world.createTransformEntity(group);
  }

  private _resetHeroStar(): void {
    this._heroRevealed = false;
    this._heroScale = 0;
    this._heroOpacity = 0;
    this._heroMaterial.opacity = 0;
    this._heroMesh.visible = false;
  }

  private _tryRevealHeroStar(): void {
    if (this._heroRevealed || !this._constellations.isComplete()) return;
    this._heroMesh.visible = true;
    this._heroRevealed = true;
  }

  update(delta: number): void {
    this._updateHeroStar(delta);
  }

  private _updateHeroStar(delta: number): void {
    if (!this._heroMesh.visible) return;

    // Re-derived every frame rather than snapshotted once — the constellation
    // stars themselves keep moving for a while after this reveals (Leg B's
    // zoom into the true Fate Events planet starts the same moment FateEvents
    // begins), so a one-time position read would leave the hero star behind.
    // getStarPositions() returns the same Float32Array ConstellationsVfxSystem
    // mutates in place each frame (its own live-anchor offsets), so this
    // naturally tracks along with it — same "re-derive from live state" idiom
    // FateEventVfxSystem/ConstellationsVfxSystem already use elsewhere.
    const type = getGlobals(this.world).dominantPebbleType.peek();
    const slot = this._constellations.getActiveSlot();
    const stars = this._constellations.getStarPositions(type, slot);
    const count = stars.length / 3;
    this._scratchCentroid.set(0, 0, 0);
    for (let i = 0; i < count; i++) {
      this._scratchCentroid.x += stars[i * 3];
      this._scratchCentroid.y += stars[i * 3 + 1];
      this._scratchCentroid.z += stars[i * 3 + 2];
    }
    this._scratchCentroid.multiplyScalar(1 / count);
    this._heroMesh.position.copy(this._scratchCentroid);

    const pull = 1 - Math.exp(-HERO_FADE_RATE * delta);
    this._heroScale += (1 - this._heroScale) * pull;
    this._heroOpacity += (1 - this._heroOpacity) * pull;
    this._heroMesh.scale.setScalar(HERO_STAR_SIZE * this._heroScale);
    this._heroMaterial.opacity = this._heroOpacity;

    this.camera.getWorldPosition(this._camWorldPos);
    this._faceDir.copy(this._camWorldPos).sub(this._heroMesh.position).normalize();
    if (this._faceDir.lengthSq() > 0.0001) {
      this._heroMesh.quaternion.setFromUnitVectors(this._zAxis, this._faceDir);
    }
  }
}
