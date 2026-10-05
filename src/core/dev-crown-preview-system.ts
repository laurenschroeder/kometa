import {
  AnimationMixer,
  createComponent,
  createSystem,
  DoubleSide,
  Entity,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Types,
  Vector3,
} from '@iwsdk/core';
import { buildAnimatedPerson, loadAnimatedPersonTemplate, PERSON_BODY_COLOR } from '../vfx/geometry/animated-person.js';
import { PERSON_HEIGHT } from '../vfx/geometry/placeholder-person.js';
import { makeToonRimSkinnedMaterial } from '../vfx/shaders/toon-rim-material.js';
import { buildKingCrownProp } from '../phases/fate-events/earth-situations-vfx-system.js';

// MCP/agent-testing hook, same idea as DevJump — spawns an enlarged King
// (animated rig + the real crown prop, attached exactly the way
// EarthSituationsVfxSystem does it) right in front of the camera, shown from
// the front and both profiles against a plain backdrop, so crown placement
// (CROWN_FBX_OFFSET_Y/Z) can be checked with a single screenshot instead of
// playing through to the Gas "Throne" situation. Toggle via
// `ecs_set_component` on the singleton entity's `show` field. Dev builds only.
export const DevCrownPreview = createComponent('DevCrownPreview', {
  show: { type: Types.Boolean, default: false },
});

const DEV_CROWN_PREVIEW_ENABLED = import.meta.env.DEV;

const PREVIEW_SCALE = 4; // head-and-shoulders fill the view at PREVIEW_DISTANCE
const PREVIEW_DISTANCE = 1.4;
const PREVIEW_SPACING = 0.45;
// Yaw offsets from "facing the camera": front, left profile, right profile.
const PREVIEW_YAWS = [0, Math.PI / 2, -Math.PI / 2];

export class DevCrownPreviewSystem extends createSystem({
  previews: { required: [DevCrownPreview] },
}) {
  private _root: Entity | null = null;
  private _mixers: AnimationMixer[] = [];
  private _shown = false;
  private _building = false;

  init(): void {
    this.world.createEntity().addComponent(DevCrownPreview);
  }

  update(delta: number): void {
    if (!DEV_CROWN_PREVIEW_ENABLED) return;
    for (const entity of this.queries.previews.entities) {
      const show = entity.getValue(DevCrownPreview, 'show') as boolean;
      if (show !== this._shown) {
        this._shown = show;
        if (show) void this._build();
        else this._teardown();
      }
    }
    for (const mixer of this._mixers) mixer.update(delta);
  }

  private async _build(): Promise<void> {
    if (this._building) return;
    this._building = true;
    const template = await loadAnimatedPersonTemplate();
    this._building = false;
    if (!template) {
      console.warn('[DevCrownPreview] BreathingIdle.fbx unavailable.');
      return;
    }
    if (!this._shown) return;
    this._teardown();

    const camPos = new Vector3();
    const dir = new Vector3();
    this.world.camera.getWorldPosition(camPos);
    this.world.camera.getWorldDirection(dir);
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
    dir.normalize();
    const right = new Vector3(-dir.z, 0, dir.x);
    const faceCameraYaw = Math.atan2(-dir.x, -dir.z);

    const root = new Group();
    root.position.copy(camPos).addScaledVector(dir, PREVIEW_DISTANCE);
    const material = makeToonRimSkinnedMaterial(PERSON_BODY_COLOR);

    PREVIEW_YAWS.forEach((yaw, i) => {
      const animated = buildAnimatedPerson(template, material, PERSON_HEIGHT);
      animated.attachHeadProp(buildKingCrownProp());
      // Freeze on the same posed frame the rig's head-top offset was measured at.
      animated.idleAction.time = 0;
      animated.idleAction.paused = true;
      animated.mixer.update(0);
      this._mixers.push(animated.mixer);

      const fig = animated.group;
      fig.scale.setScalar(PREVIEW_SCALE);
      fig.rotation.y = faceCameraYaw + yaw;
      fig.position.copy(right).multiplyScalar((i - 1) * PREVIEW_SPACING);
      // Head top just below eye level, so head + crown sit mid-frame.
      fig.position.y = -PERSON_HEIGHT * PREVIEW_SCALE * 0.97;
      root.add(fig);
    });

    const backdrop = new Mesh(
      new PlaneGeometry(3, 2),
      new MeshBasicMaterial({ color: 0x8a8f99, side: DoubleSide }),
    );
    backdrop.position.copy(dir).multiplyScalar(0.5);
    backdrop.rotation.y = faceCameraYaw;
    root.add(backdrop);

    this._root = this.world.createTransformEntity(root, { parent: this.world.sceneEntity, persistent: true });
    console.info('[DevCrownPreview] shown — front, left profile, right profile.');
  }

  private _teardown(): void {
    this._mixers.length = 0;
    this._root?.dispose();
    this._root = null;
  }
}
