import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  createSystem,
  DoubleSide,
  DynamicDrawUsage,
  InputComponent,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Quaternion,
  SphereGeometry,
  Vector3,
} from '@iwsdk/core';

interface CometState {
  pos: Vector3;
  vel: Vector3;
  prevHand: Vector3;
  wasSnapped: boolean;
}

const SPHERE_RADIUS   = 0.055;
const SPRING_STRENGTH = 8;
const DAMPING         = 0.5;
const GRAVITY_SCALE   = 6;
const SNAP_THRESHOLD  = 0.85;
const THROW_MULT      = 2.0;
const PALM_OFFSET_Z   = 0.08;

// 3-D fire tube: 8-sided rings along the trail
const TUBE_SIDES   = 8;
const TUBE_SAMPLES = 18;
const TUBE_STRIDE  = 2;
const TUBE_TOTAL   = TUBE_SAMPLES * TUBE_STRIDE;
const TUBE_RADIUS  = 0.075;

// ─── face texture ────────────────────────────────────────────────────────────

function buildFaceTexture(): CanvasTexture {
  const S = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#FFEE99';
  ctx.beginPath();
  ctx.arc(S / 2, S / 2, S / 2 - 3, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = '#1C0E00';
  ctx.lineWidth = 13;
  ctx.lineCap = 'round';

  for (const ex of [85, 171]) {
    const ey = 102, es = 20;
    ctx.beginPath();
    ctx.moveTo(ex - es, ey - es); ctx.lineTo(ex + es, ey + es);
    ctx.moveTo(ex + es, ey - es); ctx.lineTo(ex - es, ey + es);
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.arc(S / 2, 150, 56, 0.07 * Math.PI, 0.93 * Math.PI);
  ctx.stroke();

  return new CanvasTexture(canvas);
}

// ─── head sphere ─────────────────────────────────────────────────────────────
// Face texture maps to the sphere's local +X axis (UV centre = phi=π = +X in
// Three.js SphereGeometry). We orient the sphere each frame so +X faces the
// camera, giving a proper 3D sphere with a readable face from every angle.

function buildHead(faceTexture: CanvasTexture): Mesh {
  return new Mesh(
    new SphereGeometry(SPHERE_RADIUS, 24, 16),
    new MeshBasicMaterial({ map: faceTexture }),
  );
}

// ─── fire tube geometry ───────────────────────────────────────────────────────

function buildFireTube(): [Mesh, Float32Array, Float32Array, BufferAttribute, BufferAttribute] {
  const vCount = TUBE_SAMPLES * TUBE_SIDES;
  const positions = new Float32Array(vCount * 3);
  const colors    = new Float32Array(vCount * 3);

  // Index buffer: two triangles per quad, TUBE_SIDES quads per ring segment
  const triCount = (TUBE_SAMPLES - 1) * TUBE_SIDES * 2;
  const indices  = new Uint16Array(triCount * 3);
  let  idx = 0;
  for (let i = 0; i < TUBE_SAMPLES - 1; i++) {
    for (let j = 0; j < TUBE_SIDES; j++) {
      const a = i * TUBE_SIDES + j;
      const b = i * TUBE_SIDES + (j + 1) % TUBE_SIDES;
      const c = (i + 1) * TUBE_SIDES + j;
      const d = (i + 1) * TUBE_SIDES + (j + 1) % TUBE_SIDES;
      indices[idx++] = a; indices[idx++] = b; indices[idx++] = c;
      indices[idx++] = b; indices[idx++] = d; indices[idx++] = c;
    }
  }

  // BufferAttribute with direct reference so writes to positions/colors
  // immediately affect the GPU-uploaded array (Float32BufferAttribute copies)
  const posAttr = new BufferAttribute(positions, 3);
  const colAttr = new BufferAttribute(colors, 3);
  posAttr.setUsage(DynamicDrawUsage);
  colAttr.setUsage(DynamicDrawUsage);

  const geo = new BufferGeometry();
  geo.setIndex(new BufferAttribute(indices, 1));
  geo.setAttribute('position', posAttr);
  geo.setAttribute('color', colAttr);

  const mat = new MeshBasicMaterial({
    vertexColors: true,
    side: DoubleSide,
    blending: AdditiveBlending,
    depthWrite: false,
    transparent: true,
  });

  const mesh = new Mesh(geo, mat);
  mesh.frustumCulled = false;
  return [mesh, positions, colors, posAttr, colAttr];
}

// ─── system ──────────────────────────────────────────────────────────────────

export class CometSystem extends createSystem({}) {
  private _left!: CometState;
  private _right!: CometState;

  private _handPos!: Vector3;
  private _palmOffset!: Vector3;
  private _gripQuat!: Quaternion;
  private _anchor!: Vector3;
  private _spring!: Vector3;
  private _gravityVec!: Vector3;
  // Tube frame vectors
  private _tangent!: Vector3;
  private _tubeRight!: Vector3;
  private _tubeUp!: Vector3;
  private _refVec!: Vector3;
  // Head orientation toward camera
  private _xAxis!: Vector3;
  private _camWorldPos!: Vector3;
  private _faceDir!: Vector3;

  private _leftHead!: Mesh;
  private _rightHead!: Mesh;

  private _leftFire!: Mesh;
  private _rightFire!: Mesh;
  private _leftFirePos!: Float32Array;
  private _rightFirePos!: Float32Array;
  private _leftFireCol!: Float32Array;
  private _rightFireCol!: Float32Array;
  private _leftFirePA!: BufferAttribute;
  private _rightFirePA!: BufferAttribute;
  private _leftFireCA!: BufferAttribute;
  private _rightFireCA!: BufferAttribute;

  private _leftTrail!: Float32Array;
  private _rightTrail!: Float32Array;

  init() {
    this._handPos    = new Vector3();
    this._palmOffset = new Vector3();
    this._gripQuat   = new Quaternion();
    this._anchor     = new Vector3();
    this._spring     = new Vector3();
    this._gravityVec = new Vector3(0, -GRAVITY_SCALE, 0);
    this._tangent    = new Vector3();
    this._tubeRight  = new Vector3();
    this._tubeUp     = new Vector3();
    this._refVec     = new Vector3();
    this._xAxis      = new Vector3(1, 0, 0);
    this._camWorldPos = new Vector3();
    this._faceDir    = new Vector3();

    const start = new Vector3(0, 1.5, 0);
    const mkState = (): CometState => ({
      pos: start.clone(), vel: new Vector3(),
      prevHand: start.clone(), wasSnapped: false,
    });
    this._left  = mkState();
    this._right = mkState();

    this._leftTrail  = new Float32Array(TUBE_TOTAL * 3);
    this._rightTrail = new Float32Array(TUBE_TOTAL * 3);
    for (let i = 0; i < TUBE_TOTAL; i++) {
      this._leftTrail[i * 3]      = this._rightTrail[i * 3]      = start.x;
      this._leftTrail[i * 3 + 1]  = this._rightTrail[i * 3 + 1]  = start.y;
      this._leftTrail[i * 3 + 2]  = this._rightTrail[i * 3 + 2]  = start.z;
    }

    const tex = buildFaceTexture();
    this._leftHead  = buildHead(tex);
    this._rightHead = buildHead(tex);
    this.world.createTransformEntity(this._leftHead);
    this.world.createTransformEntity(this._rightHead);

    const [lFire, lPos, lCol, lPA, lCA] = buildFireTube();
    const [rFire, rPos, rCol, rPA, rCA] = buildFireTube();
    this._leftFire  = lFire;  this._rightFire  = rFire;
    this._leftFirePos  = lPos;   this._rightFirePos  = rPos;
    this._leftFireCol  = lCol;   this._rightFireCol  = rCol;
    this._leftFirePA   = lPA;    this._rightFirePA   = rPA;
    this._leftFireCA   = lCA;    this._rightFireCA   = rCA;
    this.world.createTransformEntity(this._leftFire);
    this.world.createTransformEntity(this._rightFire);
  }

  update(delta: number, time: number) {
    const lFlex = this.input.xr.gamepads.left?.getButtonValue(InputComponent.Squeeze)  ?? 0;
    const rFlex = this.input.xr.gamepads.right?.getButtonValue(InputComponent.Squeeze) ?? 0;

    this._step(this._left,  this.player.gripSpaces.left,  lFlex, delta);
    this._step(this._right, this.player.gripSpaces.right, rFlex, delta);

    this._pushTrail(this._leftTrail,  this._left.pos);
    this._pushTrail(this._rightTrail, this._right.pos);

    this._leftHead.position.copy(this._left.pos);
    this._rightHead.position.copy(this._right.pos);

    // Orient each sphere so its local +X (where the face texture is centered)
    // points toward the camera — gives a readable 3D sphere face from any angle
    this.camera.getWorldPosition(this._camWorldPos);
    this._faceDir.copy(this._camWorldPos).sub(this._leftHead.position).normalize();
    if (this._faceDir.lengthSq() > 0.0001)
      this._leftHead.quaternion.setFromUnitVectors(this._xAxis, this._faceDir);
    this._faceDir.copy(this._camWorldPos).sub(this._rightHead.position).normalize();
    if (this._faceDir.lengthSq() > 0.0001)
      this._rightHead.quaternion.setFromUnitVectors(this._xAxis, this._faceDir);

    this._buildTube(this._leftTrail,  this._leftFirePos,  this._leftFireCol,  this._leftFirePA,  this._leftFireCA,  time);
    this._buildTube(this._rightTrail, this._rightFirePos, this._rightFireCol, this._rightFirePA, this._rightFireCA, time);
  }

  private _pushTrail(buf: Float32Array, pos: Vector3): void {
    buf.copyWithin(3, 0, (TUBE_TOTAL - 1) * 3);
    buf[0] = pos.x;
    buf[1] = pos.y;
    buf[2] = pos.z;
  }

  private _buildTube(
    trail: Float32Array, verts: Float32Array, colors: Float32Array,
    pa: BufferAttribute, ca: BufferAttribute, time: number,
  ): void {
    for (let i = 0; i < TUBE_SAMPLES; i++) {
      const t  = i / (TUBE_SAMPLES - 1);
      const ti = i * TUBE_STRIDE * 3;

      const cx = trail[ti], cy = trail[ti + 1], cz = trail[ti + 2];

      // Tangent from neighboring trail samples
      const pi = Math.max(0, i - 1) * TUBE_STRIDE * 3;
      const ni = Math.min(TUBE_SAMPLES - 1, i + 1) * TUBE_STRIDE * 3;
      this._tangent.set(
        trail[pi] - trail[ni],
        trail[pi + 1] - trail[ni + 1],
        trail[pi + 2] - trail[ni + 2],
      );
      const tLen = this._tangent.length();
      if (tLen < 0.0001) {
        this._tangent.set(0, 1, 0);
      } else {
        this._tangent.divideScalar(tLen);
      }

      // Perpendicular frame: avoid degenerate cross when tangent ≈ world-up
      this._refVec.set(Math.abs(this._tangent.y) < 0.9 ? 0 : 1, Math.abs(this._tangent.y) < 0.9 ? 1 : 0, 0);
      this._tubeRight.crossVectors(this._tangent, this._refVec).normalize();
      this._tubeUp.crossVectors(this._tubeRight, this._tangent).normalize();

      // Fire color: yellow head → orange → dark tail
      const b = Math.pow(1 - t, 1.2);
      const r = b;
      const g = b * Math.max(0, 0.72 - t * 0.75);

      for (let j = 0; j < TUBE_SIDES; j++) {
        const angle = (j / TUBE_SIDES) * Math.PI * 2;

        // Radius with per-vertex organic noise for flame shape
        const baseR = TUBE_RADIUS * Math.pow(1 - t, 0.5);
        const noise = Math.sin(angle * 1.5 + time * 8 + t * Math.PI * 4) * baseR * 0.45;
        const radius = Math.max(0, baseR + noise);

        const ca2 = Math.cos(angle);
        const sa  = Math.sin(angle);

        const vi = (i * TUBE_SIDES + j) * 3;
        verts[vi]     = cx + (this._tubeRight.x * ca2 + this._tubeUp.x * sa) * radius;
        verts[vi + 1] = cy + (this._tubeRight.y * ca2 + this._tubeUp.y * sa) * radius;
        verts[vi + 2] = cz + (this._tubeRight.z * ca2 + this._tubeUp.z * sa) * radius;

        colors[vi]     = r;
        colors[vi + 1] = g;
        colors[vi + 2] = 0;
      }
    }

    pa.needsUpdate = true;
    ca.needsUpdate = true;
  }

  private _step(state: CometState, grip: Object3D, flexion: number, dt: number): void {
    grip.getWorldPosition(this._handPos);
    grip.getWorldQuaternion(this._gripQuat);
    this._palmOffset.set(0, 0, PALM_OFFSET_Z).applyQuaternion(this._gripQuat);
    this._handPos.add(this._palmOffset);

    if (flexion >= SNAP_THRESHOLD) {
      state.vel.copy(this._handPos).sub(state.prevHand);
      if (dt > 0) state.vel.divideScalar(dt); else state.vel.setScalar(0);
      state.pos.copy(this._handPos);
      state.prevHand.copy(this._handPos);
      state.wasSnapped = true;
      return;
    }

    if (state.wasSnapped) { state.vel.multiplyScalar(THROW_MULT); state.wasSnapped = false; }

    state.prevHand.copy(this._handPos);

    const restOffset = GRAVITY_SCALE / Math.max(SPRING_STRENGTH, 0.001);
    this._anchor.copy(this._handPos);
    this._anchor.y += restOffset;

    this._spring.copy(this._anchor).sub(state.pos).multiplyScalar(SPRING_STRENGTH);
    state.vel.addScaledVector(this._spring, dt);
    state.vel.addScaledVector(this._gravityVec, dt);
    state.vel.multiplyScalar(Math.exp(-DAMPING * dt));
    state.pos.addScaledVector(state.vel, dt);

    if (flexion > 0) {
      const t = flexion * flexion;
      state.pos.lerp(this._handPos, t);
      state.vel.multiplyScalar(1 - t);
    }
  }
}
