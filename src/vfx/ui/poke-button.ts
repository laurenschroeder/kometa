import {
  BoxGeometry,
  Color,
  DoubleSide,
  Entity,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  PokeInteractable,
  Pressed,
} from '@iwsdk/core';
import type { World } from '@iwsdk/core';
import { drawLabel } from '../textures/canvas-label.js';

// Shared floating "poke and hold to fill" cube button — the interaction
// model every player-facing menu in this game now uses (Start Menu's own
// Start/Achievements/Settings row, Settings' two toggles, the end-of-run
// choice) instead of ray-based click/hover. This experience gets handed
// between strangers at a festival, and a physical fingertip touch
// (PokeInteractable's own downRadius is ~2cm — the finger has to actually
// reach the surface, not just point a controller ray near it) is a much
// stronger accidental-trigger filter than raycasting ever was, which is why
// raycasting is no longer used anywhere in this project's player-facing UI.
export const CUBE_SIZE = 0.11;
export const CUBE_SPACING = 0.2;
export const CUBE_DISTANCE = 0.45;
export const CUBE_HEIGHT = -0.05;
const DEFAULT_HOLD_SECONDS = 0.7;
const CUBE_ACCENT = 0x3f7fff; // matches ui/*.uikitml's old .dwell-fill blue
const CUBE_OUTLINE_OPACITY = 0.5;
const FILL_MIN_SCALE = 0.16;
const FILL_MAX_SCALE = 0.92; // stays inside the wireframe outline
const FILL_BASE_OPACITY = 0.5;
const FILL_MAX_OPACITY = 1.0;
// 1/s exponential ease smoothing the visual toward the real (un-eased) hold
// ratio — an eased visual, un-eased trigger split, so the button always
// fires at exactly HOLD_SECONDS regardless of how the fill looks catching
// up to it.
const CHARGE_VISUAL_EASE_RATE = 8;
const LABEL_WIDTH = 0.16;
const LABEL_HEIGHT = 0.06;
const LABEL_GAP = 0.045; // above the cube's own top face

export interface PokeButtonOptions {
  holdSeconds?: number;
}

// Centers `count` cubes CUBE_SPACING apart around local x=0 — the shared
// layout math every cube row (Start Menu's main/achievements/settings rows,
// EndRunMenuSystem's choice row) uses so spacing stays visually consistent
// everywhere.
export function cubeRowOffsets(count: number): number[] {
  const offsets: number[] = [];
  for (let i = 0; i < count; i++) offsets.push((i - (count - 1) / 2) * CUBE_SPACING);
  return offsets;
}

// One floating cube button, parented under a caller-supplied entity (a
// Follower-driven "menu root" — see StartMenuSystem/EndRunMenuSystem) so a
// whole row shares one Follower computation instead of each button
// computing its own. Needs its OWN entity, not a shared one, because
// PokeInteractable's BVH hit-testing covers an entity's whole child
// subtree — sharing one entity across several buttons would make poking
// ANY of them register as Pressed on all of them at once.
export class PokeCubeButton {
  readonly entity: Entity;
  readonly group: Group;
  private _fillMesh: Mesh;
  private _fillMaterial: MeshBasicMaterial;
  private _labelMesh: Mesh;
  private _labelMaterial: MeshBasicMaterial;
  private _baseColor: Color;
  private _chargedColor: Color;
  private _holdSeconds: number;
  private _holdElapsed = 0;
  private _chargeVisual = 0;
  private _fired = false;
  private _enabled = true;

  constructor(
    world: World,
    parent: Entity,
    label: string,
    localOffset: [number, number, number],
    options?: PokeButtonOptions,
  ) {
    this._holdSeconds = options?.holdSeconds ?? DEFAULT_HOLD_SECONDS;

    const group = new Group();
    group.position.set(...localOffset);
    this.group = group;
    this.entity = world.createTransformEntity(group, parent);
    this.entity.addComponent(PokeInteractable);

    this._baseColor = new Color(CUBE_ACCENT);
    this._chargedColor = new Color(0xffffff);

    const outlineMaterial = new MeshBasicMaterial({
      color: 0xffffff,
      wireframe: true,
      transparent: true,
      opacity: CUBE_OUTLINE_OPACITY,
    });
    group.add(new Mesh(new BoxGeometry(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE), outlineMaterial));

    this._fillMaterial = new MeshBasicMaterial({
      color: this._baseColor.clone(),
      transparent: true,
      opacity: FILL_BASE_OPACITY,
    });
    this._fillMesh = new Mesh(new BoxGeometry(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE), this._fillMaterial);
    this._fillMesh.scale.setScalar(FILL_MIN_SCALE);
    group.add(this._fillMesh);

    // No per-frame billboarding — every caller parents this under a root
    // that already faces the player via FollowBehavior.FaceTarget, so a
    // label at local identity rotation inherits that automatically.
    this._labelMaterial = new MeshBasicMaterial({ transparent: true, depthWrite: false, side: DoubleSide });
    this._labelMesh = new Mesh(new PlaneGeometry(LABEL_WIDTH, LABEL_HEIGHT), this._labelMaterial);
    this._labelMesh.position.set(0, CUBE_SIZE / 2 + LABEL_GAP, 0);
    group.add(this._labelMesh);
    this.setLabel(label);
  }

  // Redraws this button's own label texture — for buttons whose text
  // reflects live state (e.g. Settings' "Passthrough: Off"/"On" toggles)
  // rather than a fixed action name.
  setLabel(text: string): void {
    const oldTexture = this._labelMaterial.map;
    this._labelMaterial.map = drawLabel(text);
    this._labelMaterial.needsUpdate = true;
    oldTexture?.dispose();
  }

  // Call every frame. pokeReady gates whether a hold can even start
  // accumulating (e.g. a caller's own settling guard — see
  // StartMenuSystem's IGNORE_POKE_SECONDS). Returns true on the exact frame
  // the hold completes, so callers fire their own action then.
  update(delta: number, pokeReady: boolean): boolean {
    const pressed = this._enabled && pokeReady && this.entity.hasComponent(Pressed);
    if (pressed) {
      this._holdElapsed += delta;
    } else {
      this._holdElapsed = 0;
      this._fired = false;
    }

    const target = Math.min(1, this._holdElapsed / this._holdSeconds);
    const pull = 1 - Math.exp(-CHARGE_VISUAL_EASE_RATE * delta);
    this._chargeVisual += (target - this._chargeVisual) * pull;

    this._fillMesh.scale.setScalar(FILL_MIN_SCALE + this._chargeVisual * (FILL_MAX_SCALE - FILL_MIN_SCALE));
    this._fillMaterial.color.copy(this._baseColor).lerp(this._chargedColor, this._chargeVisual);
    this._fillMaterial.opacity = FILL_BASE_OPACITY + this._chargeVisual * (FILL_MAX_OPACITY - FILL_BASE_OPACITY);

    if (!this._fired && this._enabled && pokeReady && this._holdElapsed >= this._holdSeconds) {
      this._fired = true;
      return true;
    }
    return false;
  }

  // Clears hold/charge state and snaps the fill back to its resting
  // visual — call when re-showing a button after it (or its whole menu)
  // was hidden, so a stale hold from before doesn't carry over or
  // instantly re-fire the moment it's visible/pokeable again.
  reset(): void {
    this._holdElapsed = 0;
    this._chargeVisual = 0;
    this._fired = false;
    this._fillMesh.scale.setScalar(FILL_MIN_SCALE);
    this._fillMaterial.opacity = FILL_BASE_OPACITY;
    this._fillMaterial.color.copy(this._baseColor);
  }

  // Adds/removes PokeInteractable to match — mirrors how this codebase used
  // to add/remove RayInteractable alongside a panel's own visibility, so an
  // invisible/inactive button never keeps hit-testing.
  setEnabled(enabled: boolean): void {
    if (enabled === this._enabled) return;
    this._enabled = enabled;
    if (enabled) {
      if (!this.entity.hasComponent(PokeInteractable)) this.entity.addComponent(PokeInteractable);
    } else {
      if (this.entity.hasComponent(PokeInteractable)) this.entity.removeComponent(PokeInteractable);
      this.reset();
    }
  }
}
