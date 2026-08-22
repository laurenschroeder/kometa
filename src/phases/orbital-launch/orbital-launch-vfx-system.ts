import {
  CanvasTexture,
  createSystem,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SphereGeometry,
  Vector3,
} from '@iwsdk/core';
import { buildOrbitalArrow } from '../../vfx/geometry/orbital-arrow.js';
import { OrbitalLaunchSystem, ORBIT_DIR, UNKNOWN_DIR, ZONE_RADIUS } from './orbital-launch-system.js';

const ORBIT_COLOR = 0x4a9aff;
const UNKNOWN_COLOR = 0x7a3aff;

const LABEL_WIDTH = 0.28;
const LABEL_HEIGHT = 0.1;
const LABEL_GAP = 0.15; // above the zone sphere
const LABEL_CANVAS_W = 384;
const LABEL_CANVAS_H = 128;

const COUNTDOWN_PULSE_FREQ = 2.5;
const COUNTDOWN_PULSE_AMOUNT = 0.12;

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

interface Choice {
  arrow: Group;
  zone: Mesh;
  label: Mesh;
  center: Vector3;
}

// Renders OrbitalLaunchSystem's choice: two arrows (Orbit/The Great
// Unknown) with a visible touch zone and text label each. Director-managed
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

  init(): void {
    this._orbitalLaunch = this.world.getSystem(OrbitalLaunchSystem)!;
    this._camWorldPos = new Vector3();
    this._faceDir = new Vector3();
    this._zAxis = new Vector3(0, 0, 1);
    this._upAxis = new Vector3(0, 1, 0);

    this._orbit = this._buildChoice(ORBIT_DIR, ORBIT_COLOR, 'Orbit', this._orbitalLaunch.getOrbitZoneCenter());
    this._unknown = this._buildChoice(
      UNKNOWN_DIR,
      UNKNOWN_COLOR,
      'The Great Unknown',
      this._orbitalLaunch.getUnknownZoneCenter(),
    );
  }

  private _buildChoice(dir: [number, number, number], color: number, text: string, center: Vector3): Choice {
    const material = new MeshBasicMaterial({ color });
    const arrow = buildOrbitalArrow(material);
    arrow.position.copy(center);
    arrow.quaternion.setFromUnitVectors(this._upAxis, new Vector3(dir[0], dir[1], dir[2]));
    arrow.visible = false;
    this.world.createTransformEntity(arrow);

    const zoneMat = new MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.8 });
    const zone = new Mesh(new SphereGeometry(ZONE_RADIUS, 16, 12), zoneMat);
    zone.position.copy(center);
    zone.visible = false;
    this.world.createTransformEntity(zone);

    const texture = drawLabel(text);
    const labelMat = new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, side: DoubleSide });
    const label = new Mesh(new PlaneGeometry(LABEL_WIDTH, LABEL_HEIGHT), labelMat);
    label.position.copy(center).add(new Vector3(0, ZONE_RADIUS + LABEL_GAP, 0));
    label.visible = false;
    this.world.createTransformEntity(label);

    return { arrow, zone, label, center };
  }

  play(): void {
    super.play();
    this._lastState = null;
    for (const choice of [this._orbit, this._unknown]) {
      choice.arrow.visible = true;
      choice.zone.visible = true;
      choice.label.visible = true;
      choice.zone.scale.setScalar(1);
    }
  }

  stop(): void {
    super.stop();
    for (const choice of [this._orbit, this._unknown]) {
      choice.arrow.visible = false;
      choice.zone.visible = false;
      choice.label.visible = false;
    }
  }

  update(delta: number, time: number): void {
    const state = this._orbitalLaunch.getState();
    if (state !== this._lastState && state === 'committed') {
      const losing = this._orbitalLaunch.getChoice() === 'orbit' ? this._unknown : this._orbit;
      losing.arrow.visible = false;
      losing.zone.visible = false;
      losing.label.visible = false;
    }
    this._lastState = state;

    this.camera.getWorldPosition(this._camWorldPos);
    for (const choice of [this._orbit, this._unknown]) {
      if (!choice.label.visible) continue;
      this._faceDir.copy(this._camWorldPos).sub(choice.label.position).normalize();
      if (this._faceDir.lengthSq() > 0.0001) {
        choice.label.quaternion.setFromUnitVectors(this._zAxis, this._faceDir);
      }
    }

    if (state === 'committed') {
      const winning = this._orbitalLaunch.getChoice() === 'orbit' ? this._orbit : this._unknown;
      const pulse = 1 + Math.sin(time * COUNTDOWN_PULSE_FREQ * Math.PI * 2) * COUNTDOWN_PULSE_AMOUNT;
      winning.zone.scale.setScalar(pulse);
    }
  }
}
