// Luminous pebble comet — inspired by the butterfly reference.
// Each pebble is a smooth sphere sprite with rim lighting: near-black body,
// neon blue-white edge glow. Per-particle brightness creates hazy shades.
// A second large-particle haze layer provides the soft atmospheric cloud.
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  createSystem,
  DynamicDrawUsage,
  Float32BufferAttribute,
  InputComponent,
  NormalBlending,
  Object3D,
  Points,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from '@iwsdk/core';

interface CometState {
  pos: Vector3;
  vel: Vector3;
  prevHand: Vector3;
  wasSnapped: boolean;
}

// ── physics ────────────────────────────────────────────────────────────────
const SPRING_STRENGTH = 8;
const DAMPING         = 0.5;
const GRAVITY_SCALE   = 6;
const SNAP_THRESHOLD  = 0.85;
const THROW_MULT      = 2.0;
const PALM_OFFSET_Z   = 0.08;

// ── trail ──────────────────────────────────────────────────────────────────
const TRAIL_STRIDE  = 2;
const TRAIL_SAMPLES = 22;
const TRAIL_TOTAL   = TRAIL_SAMPLES * TRAIL_STRIDE;

// ── particle counts ─────────────────────────────────────────────────────────
const N_PEBBLES = 260;   // main rim-lit pebbles
const N_HAZE    = 60;    // large soft haze for atmospheric glow
const EXP_DECAY_P = 3.5;
const EXP_DECAY_H = 1.4;

// ── shaders ─────────────────────────────────────────────────────────────────

const SHARED_VERT = `
  attribute float aSize;
  attribute float aBright;
  varying   float vBright;
  void main() {
    vBright = aBright;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (300.0 / -mv.z);
    gl_Position  = projectionMatrix * mv;
  }
`;

// Pebble: solid dark body with neon blue-white rim glow.
// A slight sinusoidal edge wobble gives the handdrawn organic outline.
const PEBBLE_FRAG = `
  varying float vBright;
  void main() {
    vec2  uv  = gl_PointCoord - 0.5;

    // Slight irregular edge — a gentle wobble makes the outline feel hand-drawn
    float angle   = atan(uv.y, uv.x);
    float wobble  = sin(angle * 5.0 + 0.8) * 0.025 + sin(angle * 3.0 + 2.1) * 0.018;
    float r       = length(uv) + wobble;

    if (r > 0.54) discard;

    // Stark white outline band at the silhouette edge
    if (r > 0.41) {
      float outline = smoothstep(0.54, 0.47, r) * smoothstep(0.41, 0.46, r);
      gl_FragColor  = vec4(1.0, 1.0, 1.0, outline);
      return;
    }

    // Interior: sphere normal + rim lighting
    float r2 = dot(uv, uv);
    float z  = sqrt(max(0.0, 0.25 - r2));
    vec3  n  = normalize(vec3(uv.x * 2.0, -uv.y * 2.0, z));

    float rim = 1.0 - max(0.0, z * 2.0);
    rim = pow(rim, 1.6);

    float glow    = rim * vBright;
    vec3  darkCol = vec3(0.0,  0.02, 0.08);
    vec3  glowCol = vec3(0.60, 0.85, 1.00);
    glowCol = mix(glowCol, vec3(1.0, 0.97, 1.0), vBright * rim * rim);

    vec3  col   = mix(darkCol, glowCol, glow);
    float alpha = smoothstep(0.41, 0.22, r);

    gl_FragColor = vec4(col, alpha);
  }
`;

// Haze: large soft circular disc, additive, very dim blue-white.
// Multiple overlapping haze sprites bloom into the atmospheric cloud.
const HAZE_FRAG = `
  varying float vBright;
  void main() {
    vec2  uv = gl_PointCoord - 0.5;
    float r  = length(uv);
    if (r > 0.5) discard;
    float a  = smoothstep(0.5, 0.0, r) * vBright;
    gl_FragColor = vec4(0.30, 0.55, 1.0, a);
  }
`;

const kPebbleMat = new ShaderMaterial({
  vertexShader: SHARED_VERT, fragmentShader: PEBBLE_FRAG,
  blending: NormalBlending, depthWrite: false, transparent: true,
});
const kHazeMat = new ShaderMaterial({
  vertexShader: SHARED_VERT, fragmentShader: HAZE_FRAG,
  blending: AdditiveBlending, depthWrite: false, transparent: true,
});

// ── geometry builder ────────────────────────────────────────────────────────

function buildGeo(sizes: Float32Array, brights: Float32Array): BufferGeometry {
  const geo = new BufferGeometry();
  geo.setAttribute('aSize',   new Float32BufferAttribute(sizes,  1));
  geo.setAttribute('aBright', new Float32BufferAttribute(brights, 1));
  return geo;
}

// ── system ───────────────────────────────────────────────────────────────────

export class CometSystem extends createSystem({}) {
  private _left!: CometState;
  private _right!: CometState;

  private _handPos!: Vector3;
  private _palmOffset!: Vector3;
  private _gripQuat!: Quaternion;
  private _anchor!: Vector3;
  private _spring!: Vector3;
  private _gravityVec!: Vector3;
  private _camRight!: Vector3;
  private _camUp!: Vector3;
  private _camFwd!: Vector3;

  // Static per-particle seeds
  private _pebT!: Float32Array;
  private _pebDX!: Float32Array;
  private _pebDY!: Float32Array;
  private _pebDZ!: Float32Array;
  private _hazT!: Float32Array;
  private _hazDX!: Float32Array;
  private _hazDY!: Float32Array;
  private _hazDZ!: Float32Array;

  // Dynamic position buffers
  private _lPebPos!: Float32Array; private _rPebPos!: Float32Array;
  private _lPebPA!: BufferAttribute; private _rPebPA!: BufferAttribute;
  private _lHazPos!: Float32Array;  private _rHazPos!: Float32Array;
  private _lHazPA!: BufferAttribute; private _rHazPA!: BufferAttribute;

  private _leftTrail!: Float32Array;
  private _rightTrail!: Float32Array;

  init() {
    this._handPos    = new Vector3();
    this._palmOffset = new Vector3();
    this._gripQuat   = new Quaternion();
    this._anchor     = new Vector3();
    this._spring     = new Vector3();
    this._gravityVec = new Vector3(0, -GRAVITY_SCALE, 0);
    this._camRight   = new Vector3();
    this._camUp      = new Vector3();
    this._camFwd     = new Vector3();

    const start = new Vector3(0, 1.5, 0);
    const mkState = (): CometState => ({
      pos: start.clone(), vel: new Vector3(),
      prevHand: start.clone(), wasSnapped: false,
    });
    this._left  = mkState();
    this._right = mkState();

    this._leftTrail  = new Float32Array(TRAIL_TOTAL * 3);
    this._rightTrail = new Float32Array(TRAIL_TOTAL * 3);
    for (let i = 0; i < TRAIL_TOTAL; i++) {
      this._leftTrail[i*3]   = this._rightTrail[i*3]   = start.x;
      this._leftTrail[i*3+1] = this._rightTrail[i*3+1] = start.y;
      this._leftTrail[i*3+2] = this._rightTrail[i*3+2] = start.z;
    }

    // ── Pebble distribution ────────────────────────────────────────────────
    this._pebT  = new Float32Array(N_PEBBLES);
    this._pebDX = new Float32Array(N_PEBBLES);
    this._pebDY = new Float32Array(N_PEBBLES);
    this._pebDZ = new Float32Array(N_PEBBLES);
    const pebSizes  = new Float32Array(N_PEBBLES);
    const pebBright = new Float32Array(N_PEBBLES);

    for (let i = 0; i < N_PEBBLES; i++) {
      const t = Math.min(1.0, -Math.log(1.0 - Math.random() * 0.9999) / EXP_DECAY_P);
      this._pebT[i] = t;

      const angle  = Math.random() * Math.PI * 2;
      const r      = Math.sqrt(-2.0 * Math.log(1.0 - Math.random() * 0.9999));
      const spread = 0.008 + t * 0.038;
      this._pebDX[i] = Math.cos(angle) * r * spread;
      this._pebDY[i] = Math.sin(angle) * r * spread;
      // Depth offset: same Gaussian magnitude as lateral, gives true 3-D scatter
      this._pebDZ[i] = (Math.random() - 0.5) * r * spread * 1.6;

      // Larger pebbles near the dense head, tiny ones toward the tail
      pebSizes[i]  = Math.max(0.006, (0.038 - t * 0.020) * (1.0 - Math.min(r, 2.5) * 0.08));
      // Brightness: mix of bright glowing and dim shadowy pebbles for hazy variety
      pebBright[i] = 0.25 + Math.random() * 0.75;
    }

    // ── Haze distribution ──────────────────────────────────────────────────
    this._hazT  = new Float32Array(N_HAZE);
    this._hazDX = new Float32Array(N_HAZE);
    this._hazDY = new Float32Array(N_HAZE);
    this._hazDZ = new Float32Array(N_HAZE);
    const hazSizes  = new Float32Array(N_HAZE);
    const hazBright = new Float32Array(N_HAZE);

    for (let i = 0; i < N_HAZE; i++) {
      const t = Math.min(1.0, -Math.log(1.0 - Math.random() * 0.9999) / EXP_DECAY_H);
      this._hazT[i] = t;

      const angle  = Math.random() * Math.PI * 2;
      const r      = Math.sqrt(-2.0 * Math.log(1.0 - Math.random() * 0.9999));
      const spread = 0.020 + t * 0.060;
      this._hazDX[i] = Math.cos(angle) * r * spread;
      this._hazDY[i] = Math.sin(angle) * r * spread;
      this._hazDZ[i] = (Math.random() - 0.5) * r * spread * 1.4;

      hazSizes[i]  = 0.050 + Math.random() * 0.060;            // large soft blobs
      hazBright[i] = (0.04 + Math.random() * 0.10) * (1 - t); // very dim, fades with t
    }

    // ── GPU geometry ───────────────────────────────────────────────────────
    const lPebGeo = buildGeo(pebSizes, pebBright);
    const rPebGeo = buildGeo(pebSizes, pebBright);
    this._lPebPos = new Float32Array(N_PEBBLES * 3);
    this._rPebPos = new Float32Array(N_PEBBLES * 3);
    this._lPebPA  = new BufferAttribute(this._lPebPos, 3);
    this._rPebPA  = new BufferAttribute(this._rPebPos, 3);
    this._lPebPA.setUsage(DynamicDrawUsage);
    this._rPebPA.setUsage(DynamicDrawUsage);
    lPebGeo.setAttribute('position', this._lPebPA);
    rPebGeo.setAttribute('position', this._rPebPA);
    const lPebPts = new Points(lPebGeo, kPebbleMat);
    const rPebPts = new Points(rPebGeo, kPebbleMat);
    lPebPts.frustumCulled = false;
    rPebPts.frustumCulled = false;
    this.world.createTransformEntity(lPebPts);
    this.world.createTransformEntity(rPebPts);

    const lHazGeo = buildGeo(hazSizes, hazBright);
    const rHazGeo = buildGeo(hazSizes, hazBright);
    this._lHazPos = new Float32Array(N_HAZE * 3);
    this._rHazPos = new Float32Array(N_HAZE * 3);
    this._lHazPA  = new BufferAttribute(this._lHazPos, 3);
    this._rHazPA  = new BufferAttribute(this._rHazPos, 3);
    this._lHazPA.setUsage(DynamicDrawUsage);
    this._rHazPA.setUsage(DynamicDrawUsage);
    lHazGeo.setAttribute('position', this._lHazPA);
    rHazGeo.setAttribute('position', this._rHazPA);
    const lHazPts = new Points(lHazGeo, kHazeMat);
    const rHazPts = new Points(rHazGeo, kHazeMat);
    lHazPts.frustumCulled = false;
    rHazPts.frustumCulled = false;
    this.world.createTransformEntity(lHazPts);
    this.world.createTransformEntity(rHazPts);
  }

  update(delta: number) {
    const lFlex = this.input.xr.gamepads.left?.getButtonValue(InputComponent.Squeeze)  ?? 0;
    const rFlex = this.input.xr.gamepads.right?.getButtonValue(InputComponent.Squeeze) ?? 0;

    this._step(this._left,  this.player.gripSpaces.left,  lFlex, delta);
    this._step(this._right, this.player.gripSpaces.right, rFlex, delta);

    this._pushTrail(this._leftTrail,  this._left.pos);
    this._pushTrail(this._rightTrail, this._right.pos);

    this._camRight.setFromMatrixColumn(this.camera.matrixWorld, 0);
    this._camUp.setFromMatrixColumn(this.camera.matrixWorld, 1);
    this._camFwd.setFromMatrixColumn(this.camera.matrixWorld, 2);

    this._place(this._leftTrail,  this._pebT, this._pebDX, this._pebDY, this._pebDZ, N_PEBBLES, this._lPebPos, this._lPebPA);
    this._place(this._rightTrail, this._pebT, this._pebDX, this._pebDY, this._pebDZ, N_PEBBLES, this._rPebPos, this._rPebPA);
    this._place(this._leftTrail,  this._hazT, this._hazDX, this._hazDY, this._hazDZ, N_HAZE,    this._lHazPos, this._lHazPA);
    this._place(this._rightTrail, this._hazT, this._hazDX, this._hazDY, this._hazDZ, N_HAZE,    this._rHazPos, this._rHazPA);
  }

  private _pushTrail(buf: Float32Array, pos: Vector3): void {
    buf.copyWithin(3, 0, (TRAIL_TOTAL - 1) * 3);
    buf[0] = pos.x; buf[1] = pos.y; buf[2] = pos.z;
  }

  private _place(
    trail: Float32Array,
    tArr: Float32Array, dxArr: Float32Array, dyArr: Float32Array, dzArr: Float32Array, n: number,
    pos: Float32Array, pa: BufferAttribute,
  ): void {
    const cr = this._camRight, cu = this._camUp, cf = this._camFwd;
    for (let i = 0; i < n; i++) {
      const si = Math.min(TRAIL_SAMPLES - 1, Math.floor(tArr[i] * TRAIL_SAMPLES));
      const ti = si * TRAIL_STRIDE * 3;
      const bx = trail[ti], by = trail[ti+1], bz = trail[ti+2];
      const dx = dxArr[i], dy = dyArr[i], dz = dzArr[i];
      pos[i*3]   = bx + cr.x * dx + cu.x * dy + cf.x * dz;
      pos[i*3+1] = by + cr.y * dx + cu.y * dy + cf.y * dz;
      pos[i*3+2] = bz + cr.z * dx + cu.z * dy + cf.z * dz;
    }
    pa.needsUpdate = true;
  }

  private _step(state: CometState, grip: Object3D, flexion: number, dt: number): void {
    grip.getWorldPosition(this._handPos);
    grip.getWorldQuaternion(this._gripQuat);
    this._palmOffset.set(0, 0, PALM_OFFSET_Z).applyQuaternion(this._gripQuat);
    this._handPos.add(this._palmOffset);

    if (flexion >= SNAP_THRESHOLD) {
      state.vel.copy(this._handPos).sub(state.prevHand);
      if (dt > 0) state.vel.divideScalar(dt); else state.vel.setScalar(0);
      state.pos.copy(this._handPos); state.prevHand.copy(this._handPos);
      state.wasSnapped = true; return;
    }
    if (state.wasSnapped) { state.vel.multiplyScalar(THROW_MULT); state.wasSnapped = false; }
    state.prevHand.copy(this._handPos);

    const restOffset = GRAVITY_SCALE / Math.max(SPRING_STRENGTH, 0.001);
    this._anchor.copy(this._handPos); this._anchor.y += restOffset;
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
