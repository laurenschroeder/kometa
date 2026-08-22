import {
  AdditiveBlending,
  CanvasTexture,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  Vector3,
  World,
} from '@iwsdk/core';

const POOL_SIZE = 24;
const HEART_SIZE = 0.045;
const BURST_DURATION = 1.2; // seconds
const DRIFT_DISTANCE = 0.05; // meters, along the landing normal
const CANVAS_SIZE = 128;

function buildHeartTexture(): CanvasTexture {
  const s = CANVAS_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = s;
  const ctx = canvas.getContext('2d')!;

  // Classic heart silhouette: two bezier lobes meeting at a bottom point.
  const cx = s / 2;
  const top = s * 0.32;
  const bottom = s * 0.86;
  ctx.beginPath();
  ctx.moveTo(cx, bottom);
  ctx.bezierCurveTo(s * 0.02, s * 0.5, s * 0.08, top, cx, s * 0.42);
  ctx.bezierCurveTo(s * 0.92, top, s * 0.98, s * 0.5, cx, bottom);
  ctx.closePath();

  const gradient = ctx.createRadialGradient(cx, s * 0.5, 0, cx, s * 0.5, s * 0.55);
  gradient.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
  gradient.addColorStop(0.45, 'rgba(140, 170, 255, 0.85)');
  gradient.addColorStop(1, 'rgba(140, 170, 255, 0)');
  ctx.fillStyle = gradient;
  ctx.fill();

  return new CanvasTexture(canvas);
}

// Blue class's seeding flourish: "particles turn into hearts as they seed
// the planet with memories of loved ones" — a fleeting, emotional burst
// (appear -> hold -> fade), unlike green's permanent growth or red's
// permanent atmosphere. Not a System (no query/update-priority slot of its
// own needed) — a plain pooled-effect class driven by explicit spawn()/
// update()/reset() calls from PlanetSeedingVfxSystem's own landing/frame
// hooks, same idiom trail-sampler.ts/weave-path.ts use for reusable
// non-System logic. Fixed-capacity pool with a per-slot active flag (not
// swap-remove — each slot owns its own dedicated Mesh, unlike the shared-
// buffer Points cloud PlanetSeedingVfxSystem's dust motes use, so
// compacting would require also shuffling Mesh identities; POOL_SIZE=24 is
// small enough that a flat per-frame scan is negligible).
export class HeartBurstPool {
  private _meshes: Mesh[] = [];
  private _materials: MeshBasicMaterial[] = [];
  private _active = new Uint8Array(POOL_SIZE);

  private _posX = new Float32Array(POOL_SIZE);
  private _posY = new Float32Array(POOL_SIZE);
  private _posZ = new Float32Array(POOL_SIZE);
  private _dirX = new Float32Array(POOL_SIZE);
  private _dirY = new Float32Array(POOL_SIZE);
  private _dirZ = new Float32Array(POOL_SIZE);
  private _t = new Float32Array(POOL_SIZE);
  private _roll = new Float32Array(POOL_SIZE);

  private _camWorldPos = new Vector3();
  private _faceDir = new Vector3();
  private _zAxis = new Vector3(0, 0, 1);

  build(world: World): void {
    const texture = buildHeartTexture();
    const geo = new PlaneGeometry(HEART_SIZE, HEART_SIZE);
    for (let i = 0; i < POOL_SIZE; i++) {
      const material = new MeshBasicMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        blending: AdditiveBlending,
        opacity: 0,
      });
      const mesh = new Mesh(geo, material);
      mesh.name = `heart-burst-${i}`;
      mesh.visible = false;
      this._materials.push(material);
      this._meshes.push(mesh);
      world.createTransformEntity(mesh);
    }
  }

  spawn(x: number, y: number, z: number, dirX: number, dirY: number, dirZ: number): void {
    let slot = -1;
    for (let i = 0; i < POOL_SIZE; i++) {
      if (!this._active[i]) {
        slot = i;
        break;
      }
    }
    if (slot === -1) return; // cosmetic-only, no force-resolve needed
    this._active[slot] = 1;
    this._posX[slot] = x;
    this._posY[slot] = y;
    this._posZ[slot] = z;
    this._dirX[slot] = dirX;
    this._dirY[slot] = dirY;
    this._dirZ[slot] = dirZ;
    this._t[slot] = 0;
    this._roll[slot] = Math.random() * Math.PI * 2;
    this._meshes[slot].visible = true;
  }

  update(delta: number, camera: Object3D): void {
    camera.getWorldPosition(this._camWorldPos);

    for (let i = 0; i < POOL_SIZE; i++) {
      if (!this._active[i]) continue;

      const t = Math.min(1, this._t[i] + delta / BURST_DURATION);
      this._t[i] = t;

      const mesh = this._meshes[i];
      const popIn = Math.min(1, t / 0.18);
      const lateShrink = 1 - 0.15 * Math.max(0, (t - 0.6) / 0.4);
      mesh.scale.setScalar(popIn * lateShrink);
      const fade = 1 - Math.max(0, (t - 0.45) / 0.55);
      this._materials[i].opacity = fade;

      const drift = t * DRIFT_DISTANCE;
      const px = this._posX[i] + this._dirX[i] * drift;
      const py = this._posY[i] + this._dirY[i] * drift;
      const pz = this._posZ[i] + this._dirZ[i] * drift;
      mesh.position.set(px, py, pz);

      this._faceDir.copy(this._camWorldPos).sub(mesh.position).normalize();
      if (this._faceDir.lengthSq() > 0.0001) {
        mesh.quaternion.setFromUnitVectors(this._zAxis, this._faceDir);
      }
      mesh.rotateZ(this._roll[i]);

      if (t >= 1) {
        mesh.visible = false;
        this._active[i] = 0;
      }
    }
  }

  reset(): void {
    for (const mesh of this._meshes) mesh.visible = false;
    this._active.fill(0);
  }
}
