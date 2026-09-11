import {
  CanvasTexture,
  Color,
  createSystem,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SphereGeometry,
  Vector3,
} from '@iwsdk/core';
import { buildNebulaCloud } from '../../vfx/geometry/nebula-cloud.js';
import { buildOrbitalArrow } from '../../vfx/geometry/orbital-arrow.js';
import { OrbitalLaunchSystem, ZONE_RADIUS } from './orbital-launch-system.js';

const ORBIT_COLOR = 0x4a9aff;
const UNKNOWN_COLOR = 0x7a3aff;
const UNKNOWN_COLOR_RGB: [number, number, number] = new Color(UNKNOWN_COLOR).toArray() as [number, number, number];
// Slow self-rotation so the nebula reads as a drifting cloud rather than a
// static prop — applied only to the Unknown choice's marker (see update()).
const NEBULA_SPIN_SPEED = 0.15; // rad/s

const LABEL_WIDTH = 0.28;
const LABEL_HEIGHT = 0.1;
const LABEL_GAP = 0.15; // above the zone sphere
const LABEL_CANVAS_W = 384;
const LABEL_CANVAS_H = 128;

const COUNTDOWN_PULSE_FREQ = 2.5;
const COUNTDOWN_PULSE_AMOUNT = 0.12;

// Charge-up cue while a zone is being held (see OrbitalLaunchSystem's
// CHARGE_SECONDS/getOrbit/UnknownCharge01) — the zone visibly grows,
// brightens, and shifts color toward white as it fills, so a decision
// visibly being made over CHARGE_SECONDS reads clearly rather than the zone
// just silently committing after a beat. Bumped up from 1.4/1.0 alongside
// CHARGE_SECONDS' own 1s->3s increase — a longer hold needed a more
// noticeable escalation to still feel like it's building toward something.
const CHARGE_MAX_SCALE = 1.6;
const CHARGE_BASE_OPACITY = 0.55;
const CHARGE_MAX_OPACITY = 1.0;
// 1/s exponential ease rate smoothing the visual toward the real charge
// value — charge itself still resets to 0 the instant a hand leaves the
// zone (see _updateCharge), this just keeps the *visual* from snapping.
const CHARGE_VISUAL_EASE_RATE = 6;

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawLabel(text: string): CanvasTexture {
  const w = LABEL_CANVAS_W;
  const h = LABEL_CANVAS_H;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const pad = 12;

  ctx.fillStyle = 'rgba(8, 8, 16, 0.82)';
  roundRectPath(ctx, pad, pad, w - pad * 2, h - pad * 2, 20);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.lineWidth = 3;
  roundRectPath(ctx, pad, pad, w - pad * 2, h - pad * 2, 20);
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 42px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2);

  return new CanvasTexture(canvas);
}

const LABEL_OFFSET_Y = ZONE_RADIUS + LABEL_GAP;

interface Choice {
  marker: Group;
  // Slow continuous self-rotation while visible — only the Unknown choice's
  // nebula wants this (see NEBULA_SPIN_SPEED); Orbit's arrow must keep
  // pointing exactly along liveDir every frame instead.
  spin: boolean;
  zone: Mesh;
  zoneMaterial: MeshBasicMaterial;
  label: Mesh;
  // Both live references into OrbitalLaunchSystem's own Vector3 fields
  // (same object identity every call, mutated in place there) — reading
  // them here each frame automatically reflects the zone's current
  // head-following position/orientation with no extra plumbing.
  center: Vector3;
  liveDir: Vector3;
  chargeVisual: number; // eased 0-1, see CHARGE_VISUAL_EASE_RATE
  // zoneMaterial.color lerps from baseColor toward chargedColor (white) as
  // chargeVisual rises — see update()'s charging block.
  baseColor: Color;
  chargedColor: Color;
}

// Renders OrbitalLaunchSystem's choice: Orbit's directional arrow and The
// Great Unknown's drifting purple nebula (see nebula-cloud.ts — a
// directionless destination reads better as a nebula than an arrow, which
// implies a specific heading), each with a visible touch zone and text
// label. Director-managed
// (both systems live in definePhase(Phase.Launch, ...)) since none of this
// should persist past the phase — unlike the big planet itself (see
// fate-event-vfx-system.ts's own persistence change), which stays visible
// throughout as the thing being oriented toward.
export class OrbitalLaunchVfxSystem extends createSystem({}) {
  private _orbitalLaunch!: OrbitalLaunchSystem;
  private _orbit!: Choice;
  private _unknown!: Choice;
  private _camWorldPos!: Vector3;
  private _faceDir!: Vector3;
  private _zAxis!: Vector3;
  private _upAxis!: Vector3;
  private _lastState: string | null = null;
  // Set true the first frame OrbitalLaunchSystem.isReadyToChoose() reports
  // ready — both zones stay fully hidden (arrow/zone/label) until then, see
  // play()/update() below.
  private _revealed = false;

  init(): void {
    this._orbitalLaunch = this.world.getSystem(OrbitalLaunchSystem)!;
    this._camWorldPos = new Vector3();
    this._faceDir = new Vector3();
    this._zAxis = new Vector3(0, 0, 1);
    this._upAxis = new Vector3(0, 1, 0);

    this._orbit = this._buildChoice(
      ORBIT_COLOR,
      'Orbit',
      this._orbitalLaunch.getOrbitZoneCenter(),
      this._orbitalLaunch.getOrbitDirLive(),
      () => buildOrbitalArrow(new MeshBasicMaterial({ color: ORBIT_COLOR })),
      false,
    );
    this._unknown = this._buildChoice(
      UNKNOWN_COLOR,
      'The Great Unknown',
      this._orbitalLaunch.getUnknownZoneCenter(),
      this._orbitalLaunch.getUnknownDirLive(),
      () => buildNebulaCloud(UNKNOWN_COLOR_RGB),
      true,
    );
  }

  private _buildChoice(
    color: number,
    text: string,
    center: Vector3,
    liveDir: Vector3,
    buildMarker: () => Group,
    spin: boolean,
  ): Choice {
    const marker = buildMarker();
    marker.position.copy(center);
    marker.quaternion.setFromUnitVectors(this._upAxis, liveDir);
    marker.visible = false;
    this.world.createTransformEntity(marker);

    const zoneMat = new MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: CHARGE_BASE_OPACITY });
    const zone = new Mesh(new SphereGeometry(ZONE_RADIUS, 16, 12), zoneMat);
    zone.position.copy(center);
    zone.visible = false;
    this.world.createTransformEntity(zone);

    const texture = drawLabel(text);
    const labelMat = new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, side: DoubleSide });
    const label = new Mesh(new PlaneGeometry(LABEL_WIDTH, LABEL_HEIGHT), labelMat);
    label.position.set(center.x, center.y + LABEL_OFFSET_Y, center.z);
    label.visible = false;
    this.world.createTransformEntity(label);

    return {
      marker,
      spin,
      zone,
      zoneMaterial: zoneMat,
      label,
      center,
      liveDir,
      chargeVisual: 0,
      baseColor: zoneMat.color.clone(),
      chargedColor: zoneMat.color.clone().lerp(new Color(1, 1, 1), 0.85),
    };
  }

  play(): void {
    super.play();
    this._lastState = null;
    this._revealed = false;
    for (const choice of [this._orbit, this._unknown]) {
      // Hidden until _revealed flips true in update() below (see
      // isReadyToChoose()'s own comment) — not shown immediately on phase
      // entry like every other one-shot VFX reveal here.
      choice.marker.visible = false;
      choice.zone.visible = false;
      choice.label.visible = false;
      choice.zone.scale.setScalar(1);
      choice.zoneMaterial.opacity = CHARGE_BASE_OPACITY;
      choice.zoneMaterial.color.copy(choice.baseColor);
      choice.chargeVisual = 0;
    }
  }

  stop(): void {
    super.stop();
    for (const choice of [this._orbit, this._unknown]) {
      choice.marker.visible = false;
      choice.zone.visible = false;
      choice.label.visible = false;
    }
  }

  update(delta: number, time: number): void {
    const state = this._orbitalLaunch.getState();

    if (!this._revealed && (state !== 'choosing' || this._orbitalLaunch.isReadyToChoose())) {
      this._revealed = true;
      for (const choice of [this._orbit, this._unknown]) {
        choice.marker.visible = true;
        choice.zone.visible = true;
        choice.label.visible = true;
      }
    }

    if (state !== this._lastState && state === 'committed') {
      const losing = this._orbitalLaunch.getChoice() === 'orbit' ? this._unknown : this._orbit;
      losing.marker.visible = false;
      losing.zone.visible = false;
      losing.label.visible = false;
    }
    this._lastState = state;

    // center/liveDir are live references into OrbitalLaunchSystem's own
    // fields, which _placeZones() sets ONCE when the phase begins (not
    // continuously — see that class's own comment) — re-applying them here
    // every frame is what picks up that one-time placement (init()'s own
    // _buildChoice call ran with only the pre-play() placeholder values),
    // and is otherwise a harmless no-op once they've settled.
    for (const choice of [this._orbit, this._unknown]) {
      choice.marker.position.copy(choice.center);
      if (choice.spin) {
        // Directionless — a slow continuous drift instead of tracking
        // liveDir every frame like Orbit's arrow does below.
        choice.marker.rotateY(NEBULA_SPIN_SPEED * delta);
      } else {
        choice.marker.quaternion.setFromUnitVectors(this._upAxis, choice.liveDir);
      }
      choice.zone.position.copy(choice.center);
      choice.label.position.set(choice.center.x, choice.center.y + LABEL_OFFSET_Y, choice.center.z);
    }

    this.camera.getWorldPosition(this._camWorldPos);
    for (const choice of [this._orbit, this._unknown]) {
      if (!choice.label.visible) continue;
      this._faceDir.copy(this._camWorldPos).sub(choice.label.position).normalize();
      if (this._faceDir.lengthSq() > 0.0001) {
        choice.label.quaternion.setFromUnitVectors(this._zAxis, this._faceDir);
      }
    }

    if (state === 'choosing') {
      const pull = 1 - Math.exp(-CHARGE_VISUAL_EASE_RATE * delta);
      const targets: [Choice, number][] = [
        [this._orbit, this._orbitalLaunch.getOrbitCharge01()],
        [this._unknown, this._orbitalLaunch.getUnknownCharge01()],
      ];
      for (const [choice, target] of targets) {
        choice.chargeVisual += (target - choice.chargeVisual) * pull;
        choice.zone.scale.setScalar(1 + choice.chargeVisual * (CHARGE_MAX_SCALE - 1));
        choice.zoneMaterial.opacity =
          CHARGE_BASE_OPACITY + choice.chargeVisual * (CHARGE_MAX_OPACITY - CHARGE_BASE_OPACITY);
        choice.zoneMaterial.color.copy(choice.baseColor).lerp(choice.chargedColor, choice.chargeVisual);
      }
    } else if (state === 'committed') {
      const winning = this._orbitalLaunch.getChoice() === 'orbit' ? this._orbit : this._unknown;
      const pulse = 1 + Math.sin(time * COUNTDOWN_PULSE_FREQ * Math.PI * 2) * COUNTDOWN_PULSE_AMOUNT;
      winning.zone.scale.setScalar(pulse);
    }
  }
}
