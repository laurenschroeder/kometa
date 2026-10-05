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
import { buildKingCrownProp, EarthSituationsVfxSystem } from '../phases/fate-events/earth-situations-vfx-system.js';
import { getFaceTextures, HEAD_RADIUS, kHeadGeo, makeHeadMat } from '../phases/pebbles/pebble-comet-presentation-system.js';
import { CROWN_HEAD_OFFSET_Y, CrownRise, TIARA_RADIUS } from '../vfx/particles/crown-rise.js';
import { getSharedAudioListener } from '../vfx/audio/shared-audio-listener.js';

// MCP/agent-testing hook, same idea as DevJump — spawns an enlarged King
// (animated rig + the real crown prop, attached exactly the way
// EarthSituationsVfxSystem does it) right in front of the camera, shown from
// the front and both profiles against a plain backdrop, so crown placement
// (CROWN_FBX_OFFSET_Y/Z) can be checked with a single screenshot instead of
// playing through to the Gas "Throne" situation. Toggle via
// `ecs_set_component` on the singleton entity's `show` field. Dev builds only.
//
// Set `override` true to drive the crown mesh's head-bone-local offset (real
// meters, same space as CROWN_FBX_OFFSET_X/Y/Z) live from offsetX/Y/Z — tune
// without a reload, then copy the numbers back into
// earth-situations-vfx-system.ts.
export const DevCrownPreview = createComponent('DevCrownPreview', {
  show: { type: Types.Boolean, default: false },
  override: { type: Types.Boolean, default: false },
  offsetX: { type: Types.Float32, default: 0 },
  offsetY: { type: Types.Float32, default: 0 },
  offsetZ: { type: Types.Float32, default: 0 },
  // Comet's crown (CrownRise). `cometShow` spawns an enlarged stand-in comet
  // head (real head geometry/material) wearing a real CrownRise crown,
  // attached, against the same backdrop. cometRadius/cometOffsetY override
  // CrownRise's tiaraRadius/headOffsetY live (0 = keep the code's default).
  // `cometCrown` (cleared once applied) snaps the in-game comet's own crown
  // onto its head with the same overrides.
  cometShow: { type: Types.Boolean, default: false },
  cometCrown: { type: Types.Boolean, default: false },
  // Replays the real crown rise → travel → land onto the live comet
  // (~26s + the land gate). Cleared once applied.
  cometRise: { type: Types.Boolean, default: false },
  cometRadius: { type: Types.Float32, default: 0 },
  cometOffsetY: { type: Types.Float32, default: 0 },
});

const DEV_CROWN_PREVIEW_ENABLED = import.meta.env.DEV;

const PREVIEW_SCALE = 4; // head-and-shoulders fill the view at PREVIEW_DISTANCE
const PREVIEW_DISTANCE = 1.4;
const PREVIEW_SPACING = 0.45;
// Yaw offsets from "facing the camera": front, left profile, right profile.
const PREVIEW_YAWS = [0, Math.PI / 2, -Math.PI / 2];
// Comet head is only HEAD_RADIUS (2.4cm) — blow it up so it fills the view.
const COMET_PREVIEW_SCALE = 10;
const COMET_PREVIEW_COLOR: [number, number, number] = [1, 0.85, 0.2];

export class DevCrownPreviewSystem extends createSystem({
  previews: { required: [DevCrownPreview] },
}) {
  private _root: Entity | null = null;
  private _mixers: AnimationMixer[] = [];
  private _crowns: Group[] = [];
  private _shown = false;
  private _building = false;
  // Built once on first cometShow and then only hidden/repositioned —
  // CrownRise owns its own transform entity, so it's never torn down.
  private _cometRoot: Group | null = null;
  private _cometCrown: CrownRise | null = null;
  private _cometShown = false;
  private _zero = new Vector3();

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
      if (entity.getValue(DevCrownPreview, 'override')) {
        const x = entity.getValue(DevCrownPreview, 'offsetX') as number;
        const y = entity.getValue(DevCrownPreview, 'offsetY') as number;
        const z = entity.getValue(DevCrownPreview, 'offsetZ') as number;
        // children[0] is the loaded FBX mesh once it resolves (or the
        // procedural fallback's band before then).
        for (const crown of this._crowns) crown.children[0]?.position.set(x, y, z);
      }
      const cometShow = entity.getValue(DevCrownPreview, 'cometShow') as boolean;
      if (cometShow !== this._cometShown) {
        this._cometShown = cometShow;
        if (cometShow) this._showComet();
        else if (this._cometRoot) this._cometRoot.visible = false;
      }
      if (this._cometShown && this._cometCrown) {
        const r = entity.getValue(DevCrownPreview, 'cometRadius') as number;
        const y = entity.getValue(DevCrownPreview, 'cometOffsetY') as number;
        const crown = this._cometCrown;
        const nextR = r > 0 ? r : TIARA_RADIUS;
        const nextY = y > 0 ? y : CROWN_HEAD_OFFSET_Y;
        if (nextR !== crown.tiaraRadius || nextY !== crown.headOffsetY) {
          crown.tiaraRadius = nextR;
          crown.headOffsetY = nextY;
          crown.devAttachNow(COMET_PREVIEW_COLOR);
        }
        crown.update(delta, this._zero);
      }
      if (entity.getValue(DevCrownPreview, 'cometRise')) {
        entity.setValue(DevCrownPreview, 'cometRise', false);
        this.world.getSystem(EarthSituationsVfxSystem)?.devReplayCometCrownRise();
      }
      if (entity.getValue(DevCrownPreview, 'cometCrown')) {
        entity.setValue(DevCrownPreview, 'cometCrown', false);
        this.world
          .getSystem(EarthSituationsVfxSystem)
          ?.devAttachCometCrown(
            entity.getValue(DevCrownPreview, 'cometRadius') as number,
            entity.getValue(DevCrownPreview, 'cometOffsetY') as number,
          );
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
      const crown = buildKingCrownProp();
      animated.attachHeadProp(crown);
      this._crowns.push(crown);
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

  private _showComet(): void {
    if (!this._cometRoot) {
      const root = new Group();
      root.scale.setScalar(COMET_PREVIEW_SCALE);

      const headMat = makeHeadMat(4);
      headMat.uniforms.uFaceTex.value = getFaceTextures()[0];
      const head = new Mesh(kHeadGeo, headMat);
      head.scale.setScalar(HEAD_RADIUS);
      root.add(head);

      const crown = new CrownRise();
      crown.build(this.world, getSharedAudioListener(this.world), this.scene);
      // Local (0, headOffsetY, 0) under the scaled root — see update()'s
      // crown.update(delta, zero).
      crown.devGroup.name = 'dev-preview-comet-crown';
      root.add(crown.devGroup);
      crown.devAttachNow(COMET_PREVIEW_COLOR);

      const backdrop = new Mesh(new PlaneGeometry(0.3, 0.2), new MeshBasicMaterial({ color: 0x8a8f99, side: DoubleSide }));
      backdrop.position.z = -0.08;
      root.add(backdrop);

      this.world.createTransformEntity(root, { parent: this.world.sceneEntity, persistent: true });
      this._cometRoot = root;
      this._cometCrown = crown;
    }

    const camPos = new Vector3();
    const dir = new Vector3();
    this.world.camera.getWorldPosition(camPos);
    this.world.camera.getWorldDirection(dir);
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
    dir.normalize();
    const root = this._cometRoot;
    root.position.copy(camPos).addScaledVector(dir, PREVIEW_DISTANCE);
    // Head + crown centered at eye level.
    root.position.y -= HEAD_RADIUS * COMET_PREVIEW_SCALE;
    root.rotation.y = Math.atan2(-dir.x, -dir.z);
    root.visible = true;
    // Pick up whatever crown geometry has loaded since the first build.
    this._cometCrown!.devAttachNow(COMET_PREVIEW_COLOR);
    console.info('[DevCrownPreview] comet shown.');
  }

  private _teardown(): void {
    this._mixers.length = 0;
    this._crowns.length = 0;
    this._root?.dispose();
    this._root = null;
  }
}
