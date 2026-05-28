import {
  Color,
  createSystem,
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

const SPHERE_RADIUS   = 0.04;
const HALO_SCALE      = 2.2;
const SPRING_STRENGTH = 8;
const DAMPING         = 0.5;
const GRAVITY_SCALE   = 6;
const SNAP_THRESHOLD  = 0.85;
const THROW_MULT      = 2.0;
const PALM_OFFSET_Z   = 0.08;

// Trail: 12 visible dots sampled every 3 frames = ~0.5s of history
const TRAIL_DOTS   = 12;
const TRAIL_STRIDE = 3;
const TRAIL_TOTAL  = TRAIL_DOTS * TRAIL_STRIDE;

function buildSphere(): Mesh {
  const core = new Mesh(
    new SphereGeometry(SPHERE_RADIUS, 16, 12),
    new MeshBasicMaterial({ color: 0xfff0a0 }),
  );
  core.add(new Mesh(
    new SphereGeometry(SPHERE_RADIUS * HALO_SCALE, 16, 12),
    new MeshBasicMaterial({ color: 0xffcc44, transparent: true, opacity: 0.15 }),
  ));
  return core;
}

function buildTrailDots(startPos: Vector3): [Mesh[], Float32Array] {
  const buf = new Float32Array(TRAIL_TOTAL * 3);
  for (let i = 0; i < TRAIL_TOTAL; i++) {
    buf[i * 3]     = startPos.x;
    buf[i * 3 + 1] = startPos.y;
    buf[i * 3 + 2] = startPos.z;
  }

  const dots: Mesh[] = [];
  for (let i = 0; i < TRAIL_DOTS; i++) {
    const t = i / (TRAIL_DOTS - 1);
    const b = (1 - t) ** 1.3;
    const r = SPHERE_RADIUS * 0.55 * (1 - t * 0.65);
    const dot = new Mesh(
      new SphereGeometry(r, 8, 6),
      new MeshBasicMaterial({ color: new Color(b, b * 0.82, b * 0.28) }),
    );
    dots.push(dot);
  }
  return [dots, buf];
}

export class CometSystem extends createSystem({}) {
  private _left!: CometState;
  private _right!: CometState;

  // Pre-allocated scratch vectors — no allocations in update()
  private _handPos!: Vector3;
  private _palmOffset!: Vector3;
  private _gripQuat!: Quaternion;
  private _anchor!: Vector3;
  private _spring!: Vector3;
  private _gravityVec!: Vector3;

  private _leftSphere!: Mesh;
  private _rightSphere!: Mesh;
  private _leftDots!: Mesh[];
  private _rightDots!: Mesh[];
  private _leftTrailBuf!: Float32Array;
  private _rightTrailBuf!: Float32Array;

  init() {
    this._handPos    = new Vector3();
    this._palmOffset = new Vector3();
    this._gripQuat   = new Quaternion();
    this._anchor     = new Vector3();
    this._spring     = new Vector3();
    this._gravityVec = new Vector3(0, -GRAVITY_SCALE, 0);

    const start = new Vector3(0, 1.5, 0);
    const mkState = (): CometState => ({
      pos: start.clone(), vel: new Vector3(),
      prevHand: start.clone(), wasSnapped: false,
    });
    this._left  = mkState();
    this._right = mkState();

    this._leftSphere  = buildSphere();
    this._rightSphere = buildSphere();
    this.world.createTransformEntity(this._leftSphere);
    this.world.createTransformEntity(this._rightSphere);

    const [lDots, lBuf] = buildTrailDots(start);
    const [rDots, rBuf] = buildTrailDots(start);
    this._leftDots  = lDots;
    this._rightDots = rDots;
    this._leftTrailBuf  = lBuf;
    this._rightTrailBuf = rBuf;
    for (const dot of [...lDots, ...rDots]) {
      this.world.createTransformEntity(dot);
    }
  }

  update(delta: number) {
    const lFlex = this.input.xr.gamepads.left?.getButtonValue(InputComponent.Squeeze)  ?? 0;
    const rFlex = this.input.xr.gamepads.right?.getButtonValue(InputComponent.Squeeze) ?? 0;

    this._step(this._left,  this.player.gripSpaces.left,  lFlex, delta);
    this._step(this._right, this.player.gripSpaces.right, rFlex, delta);

    this._leftSphere.position.copy(this._left.pos);
    this._rightSphere.position.copy(this._right.pos);

    this._updateTrail(this._leftTrailBuf,  this._leftDots,  this._left.pos);
    this._updateTrail(this._rightTrailBuf, this._rightDots, this._right.pos);
  }

  private _updateTrail(buf: Float32Array, dots: Mesh[], pos: Vector3): void {
    buf.copyWithin(3, 0, (TRAIL_TOTAL - 1) * 3);
    buf[0] = pos.x;
    buf[1] = pos.y;
    buf[2] = pos.z;
    for (let i = 0; i < TRAIL_DOTS; i++) {
      const idx = i * TRAIL_STRIDE * 3;
      dots[i].position.set(buf[idx], buf[idx + 1], buf[idx + 2]);
    }
  }

  private _step(state: CometState, grip: Object3D, flexion: number, dt: number): void {
    grip.getWorldPosition(this._handPos);
    grip.getWorldQuaternion(this._gripQuat);
    this._palmOffset.set(0, 0, PALM_OFFSET_Z).applyQuaternion(this._gripQuat);
    this._handPos.add(this._palmOffset);

    // Full squeeze: snap comet to hand and track hand velocity for throw
    if (flexion >= SNAP_THRESHOLD) {
      state.vel.copy(this._handPos).sub(state.prevHand);
      if (dt > 0) state.vel.divideScalar(dt); else state.vel.setScalar(0);
      state.pos.copy(this._handPos);
      state.prevHand.copy(this._handPos);
      state.wasSnapped = true;
      return;
    }

    // First frame after release: inherit hand velocity × throw multiplier
    if (state.wasSnapped) {
      state.vel.multiplyScalar(THROW_MULT);
      state.wasSnapped = false;
    }

    state.prevHand.copy(this._handPos);

    // Spring anchor floats above hand by restOffset so gravity cancels
    // spring force at equilibrium — comet hangs at hand height when still
    const restOffset = GRAVITY_SCALE / Math.max(SPRING_STRENGTH, 0.001);
    this._anchor.copy(this._handPos);
    this._anchor.y += restOffset;

    this._spring.copy(this._anchor).sub(state.pos).multiplyScalar(SPRING_STRENGTH);
    state.vel.addScaledVector(this._spring, dt);
    state.vel.addScaledVector(this._gravityVec, dt);
    state.vel.multiplyScalar(Math.exp(-DAMPING * dt));
    state.pos.addScaledVector(state.vel, dt);

    // Partial squeeze: soft pull toward hand (quadratic ease)
    if (flexion > 0) {
      const t = flexion * flexion;
      state.pos.lerp(this._handPos, t);
      state.vel.multiplyScalar(1 - t);
    }
  }
}
