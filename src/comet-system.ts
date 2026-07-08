// Luminous pebble comet — inspired by the butterfly reference.
// Each pebble is a smooth sphere sprite with rim lighting: near-black body,
// neon blue-white edge glow. Per-particle brightness creates hazy shades.
// A second large-particle haze layer provides the soft atmospheric cloud.
import {
  AdditiveBlending,
  AssetManager,
  BufferAttribute,
  BufferGeometry,
  createSystem,
  DynamicDrawUsage,
  Float32BufferAttribute,
  IcosahedronGeometry,
  InputComponent,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  NearestFilter,
  Object3D,
  Points,
  Quaternion,
  ShaderMaterial,
  Texture,
  Vector3,
} from '@iwsdk/core';

interface CometState {
  pos: Vector3;
  vel: Vector3;
  prevHand: Vector3;
  wasSnapped: boolean;
  initialized: boolean;
}

// ── physics ────────────────────────────────────────────────────────────────
const SPRING_STRENGTH = 8;
const DAMPING = 0.5;
const GRAVITY_SCALE = 6;
const SNAP_THRESHOLD = 0.85;
const THROW_MULT = 2.0;
const PALM_OFFSET_Z = 0.08;

// ── trail ──────────────────────────────────────────────────────────────────
const TRAIL_STRIDE = 2;
const TRAIL_SAMPLES = 22;
const TRAIL_TOTAL = TRAIL_SAMPLES * TRAIL_STRIDE;

// ── particle counts ─────────────────────────────────────────────────────────
const N_PEBBLES = 260;   // main rim-lit pebbles
const N_HAZE = 60;    // large soft haze for atmospheric glow
const EXP_DECAY_P = 3.5;
const EXP_DECAY_H = 1.4;

// ── 3D pebble geometry ───────────────────────────────────────────────────────
const N_PEBBLE_VARIANTS = 6;
const PEBBLE_ICO_DETAIL = 2;
const PEBBLE_DISPLACE_TERMS = 4;
// pebSizes was originally tuned as a gl_PointSize screen-space pixel heuristic,
// not a world-space meter radius. Used as a literal mesh scale at 1.0, pebbles
// near the head (largest, densest) become bigger than their own placement
// spread and bury the face pebble entirely. Scaled down so they read as small
// pebbles rather than boulders crowding the head.
const PEBBLE_MESH_SCALE = 0.22;

// Head sphere radius (real world-space meters) — smaller than the pebbles'
// largest near-head size so it reads as part of the rock cluster rather than
// a big clean orb looming over it.
const HEAD_RADIUS = 0.024;

// Merge duplicate-position vertices of a non-indexed geometry into an indexed
// one. IcosahedronGeometry emits private per-triangle vertex copies, so
// computeVertexNormals() would only ever produce flat per-facet normals
// without this — smooth shading requires shared vertex slots across triangles.
function mergeDuplicateVertices(geo: BufferGeometry): BufferGeometry {
  const srcPos = geo.getAttribute('position');
  const keyToIndex = new Map<string, number>();
  const positions: number[] = [];
  const remap = new Uint32Array(srcPos.count);

  for (let i = 0; i < srcPos.count; i++) {
    const x = srcPos.getX(i), y = srcPos.getY(i), z = srcPos.getZ(i);
    const key = `${x.toFixed(5)}|${y.toFixed(5)}|${z.toFixed(5)}`;
    let idx = keyToIndex.get(key);
    if (idx === undefined) {
      idx = positions.length / 3;
      keyToIndex.set(key, idx);
      positions.push(x, y, z);
    }
    remap[i] = idx;
  }

  const srcIndex = geo.getIndex();
  const triCount = srcIndex ? srcIndex.count : srcPos.count;
  const indices = new Uint32Array(triCount);
  for (let i = 0; i < triCount; i++) {
    indices[i] = remap[srcIndex ? srcIndex.getX(i) : i];
  }

  const out = new BufferGeometry();
  out.setAttribute('position', new Float32BufferAttribute(positions, 3));
  out.setIndex(new BufferAttribute(indices, 1));
  return out;
}

function randomUnitVector3(): Vector3 {
  let x = 0, y = 0, z = 0, lenSq = 0;
  do {
    x = Math.random() * 2 - 1;
    y = Math.random() * 2 - 1;
    z = Math.random() * 2 - 1;
    lenSq = x * x + y * y + z * z;
  } while (lenSq > 1 || lenSq < 1e-6);
  const len = Math.sqrt(lenSq);
  return new Vector3(x / len, y / len, z / len);
}

// Precomputed once at module load — zero runtime cost. Each variant gets its
// own random sine-sum "bump field" (dot product with a random axis stands in
// for a continuously-varying angle over the sphere, avoiding the axis-aligned
// artifacts a plain sin(x)/sin(y)/sin(z) sum would produce) so pebbles read as
// irregular organic rocks instead of perfect spheres, without a runtime noise
// dependency or per-frame displacement cost.
function buildPebbleVariantGeometry(): BufferGeometry {
  const base = new IcosahedronGeometry(1, PEBBLE_ICO_DETAIL);
  const geo = mergeDuplicateVertices(base);

  const terms = Array.from({ length: PEBBLE_DISPLACE_TERMS }, () => ({
    axis: randomUnitVector3(),
    freq: 1.5 + Math.random() * 2.5,
    phase: Math.random() * Math.PI * 2,
    amp: 0.04 + Math.random() * 0.06,
  }));

  const pos = geo.getAttribute('position');
  const p = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.set(pos.getX(i), pos.getY(i), pos.getZ(i));
    let disp = 0;
    for (const t of terms) {
      disp += Math.sin(p.dot(t.axis) * t.freq + t.phase) * t.amp;
    }
    p.multiplyScalar(Math.max(0.3, 1 + disp));
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

const kPebbleVariantGeos: BufferGeometry[] = Array.from(
  { length: N_PEBBLE_VARIANTS },
  buildPebbleVariantGeometry,
);

// Same wobbly rock shape/build as the pebbles (not a clean sphere) — the
// head's flat decal texture projection uses raw local position, not a UV
// atlas, so it tolerates this displacement fine, same as pebbles tolerate it
// with no texture at all.
const kHeadGeo = buildPebbleVariantGeometry();

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

// Pebble (3D instanced rock): solid dark body with neon blue-white rim glow,
// driven by real geometry normals instead of a fake flat-quad reconstruction.
// instanceMatrix must be declared and applied manually — three.js only
// auto-injects that transform into built-in ShaderLib templates via
// #include <instancing_vertex>, not into a from-scratch custom shader like
// this one.
const PEBBLE_INST_VERT = `
  // instanceMatrix is auto-declared by three.js for InstancedMesh (prepended
  // to the vertex shader prefix) — declaring it again here causes a redefinition
  // error. It still must be applied manually below; only the declaration is automatic.
  attribute float aBright;
  varying   float vBright;
  varying   vec3  vViewNormal;
  varying   vec3  vViewDir;
  varying   vec3  vLocalPos;

  void main() {
    vBright = aBright;
    vLocalPos = position;
    vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);

    // Per-pebble scale is uniform (x==y==z), so mat3(instanceMatrix) rotates
    // normals correctly without needing a full inverse-transpose.
    mat3 instanceNormalMatrix = mat3(instanceMatrix);
    vViewNormal = normalize(normalMatrix * instanceNormalMatrix * normal);
    vViewDir    = normalize(-mvPosition.xyz);

    gl_Position = projectionMatrix * mvPosition;
  }
`;

// Toon-style: flat near-black body, no continuous gradient, with a thin
// wobbly white line traced at the true silhouette edge. The wobble is a
// function of local (pre-instance-transform) surface position rather than
// screen space, so the hand-drawn irregularity stays fixed to each rock's
// own surface instead of swimming as the camera or pebble moves.
const PEBBLE_INST_FRAG = `
  varying float vBright;
  varying vec3  vViewNormal;
  varying vec3  vViewDir;
  varying vec3  vLocalPos;

  void main() {
    vec3  n     = normalize(vViewNormal);
    vec3  v     = normalize(vViewDir);
    float ndotv = max(0.0, dot(n, v));

    float wobble = sin(vLocalPos.x * 6.0 + vLocalPos.y * 4.0 + 3.1) * 0.05
                 + sin(vLocalPos.y * 5.0 - vLocalPos.z * 3.0 + 1.4) * 0.035;
    float edge    = (1.0 - ndotv) + wobble;
    float outline = smoothstep(0.60, 0.78, edge);

    vec3 bodyCol = mix(vec3(0.01, 0.02, 0.05), vec3(0.05, 0.08, 0.14), vBright);
    vec3 col     = mix(bodyCol, vec3(1.0), outline);
    gl_FragColor = vec4(col, 1.0);
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

// Head (3D real geometry, like the pebbles): a real sphere mesh, rotated each
// frame to keep its textured "front" facing the camera (same technique as the
// archived src/comets/fire-emoji-comet.ts). Same toon rim/outline treatment
// as the pebbles. The face texture is NOT sampled via the sphere's built-in
// equirectangular UV — that wraps the flat 2D image around the whole globe,
// so only a narrow, heavily-stretched sliver of it would show on the visible
// cap. Instead it's projected flatly onto the front-facing cap using local
// Y/Z (perpendicular to the local +X "forward" axis the head is rotated
// around), replicating the flat gl_PointCoord decal the old billboard used.
const HEAD_VERT = `
  varying vec3 vViewNormal;
  varying vec3 vViewDir;
  varying vec3 vLocalPos;
  varying vec2 vDecalUV;

  void main() {
    vLocalPos = position;
    vDecalUV = vec2(0.5 + position.z * 0.5, 0.5 - position.y * 0.5);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vViewNormal = normalize(normalMatrix * normal);
    vViewDir    = normalize(-mvPosition.xyz);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const HEAD_FRAG = `
  uniform sampler2D uFaceTex;
  varying vec3 vViewNormal;
  varying vec3 vViewDir;
  varying vec3 vLocalPos;
  varying vec2 vDecalUV;

  void main() {
    vec3  n     = normalize(vViewNormal);
    vec3  v     = normalize(vViewDir);
    float ndotv = max(0.0, dot(n, v));

    float wobble = sin(vLocalPos.x * 6.0 + vLocalPos.y * 4.0 + 3.1) * 0.05
                 + sin(vLocalPos.y * 5.0 - vLocalPos.z * 3.0 + 1.4) * 0.035;
    float edge    = (1.0 - ndotv) + wobble;
    float outline = smoothstep(0.60, 0.78, edge);

    // Sample beepchat face via the flat front-projected decal UV
    vec4  face   = texture2D(uFaceTex, vDecalUV);
    float luma   = dot(face.rgb, vec3(0.299, 0.587, 0.114));
    float isFace = 1.0 - smoothstep(0.12, 0.38, luma);
    vec3  bodyCol = vec3(0.03, 0.05, 0.09);
    vec3  col     = mix(bodyCol, vec3(0.90, 0.97, 1.00), isFace * 0.96);

    col = mix(col, vec3(1.0), outline);
    gl_FragColor = vec4(col, 1.0);
  }
`;

// Opaque, real depth-tested geometry — pebbles solidly occlude one another
// instead of alpha-blending through each other like the old point sprites.
const kPebbleInstMat = new ShaderMaterial({
  vertexShader: PEBBLE_INST_VERT, fragmentShader: PEBBLE_INST_FRAG,
  depthWrite: true, transparent: false,
});
function makeHeadMat(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uFaceTex: { value: null } },
    vertexShader: HEAD_VERT,
    fragmentShader: HEAD_FRAG,
    depthWrite: true,
    transparent: false,
  });
}
const kHazeMat = new ShaderMaterial({
  vertexShader: SHARED_VERT, fragmentShader: HAZE_FRAG,
  blending: AdditiveBlending, depthWrite: false, transparent: true,
});

// ── geometry builder ────────────────────────────────────────────────────────

function buildGeo(sizes: Float32Array, brights: Float32Array): BufferGeometry {
  const geo = new BufferGeometry();
  geo.setAttribute('aSize', new Float32BufferAttribute(sizes, 1));
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
  private _pebSizes!: Float32Array;
  private _pebVariant!: Uint8Array;
  private _pebLocalIdx!: Uint16Array;
  private _pebRot!: Quaternion[];
  private _hazT!: Float32Array;
  private _hazDX!: Float32Array;
  private _hazDY!: Float32Array;
  private _hazDZ!: Float32Array;

  // Head (1 real sphere mesh per comet, rotated to face direction of travel)
  private _lHeadMesh!: Mesh; private _rHeadMesh!: Mesh;
  private _lHeadMat!: ShaderMaterial; private _rHeadMat!: ShaderMaterial;
  private _beepchat!: Texture[];
  private _faceDir!: Vector3;
  private _xAxis!: Vector3;

  // Pebbles: one InstancedMesh per rock-shape variant, per comet
  private _lPebMeshes!: InstancedMesh[]; private _rPebMeshes!: InstancedMesh[];
  private _lHazPos!: Float32Array; private _rHazPos!: Float32Array;
  private _lHazPA!: BufferAttribute; private _rHazPA!: BufferAttribute;

  private _leftTrail!: Float32Array;
  private _rightTrail!: Float32Array;

  // Placement scratch (kept separate from _step's physics scratch)
  private _scratchMat4!: Matrix4;
  private _scratchPos!: Vector3;
  private _scratchScale!: Vector3;

  init() {
    this._handPos = new Vector3();
    this._palmOffset = new Vector3();
    this._gripQuat = new Quaternion();
    this._anchor = new Vector3();
    this._spring = new Vector3();
    this._gravityVec = new Vector3(0, -GRAVITY_SCALE, 0);
    this._camRight = new Vector3();
    this._camUp = new Vector3();
    this._camFwd = new Vector3();
    this._scratchMat4 = new Matrix4();
    this._scratchPos = new Vector3();
    this._scratchScale = new Vector3();

    // No hardcoded start position — pos/prevHand/trail are all snapped to the
    // real hand position the first time _step() runs (see `initialized`
    // below), whether that's in 2D browser mode or after XR session start.
    // This avoids the comet spawning far from the controllers and flying in
    // with a big spring-driven velocity spike.
    const mkState = (): CometState => ({
      pos: new Vector3(), vel: new Vector3(),
      prevHand: new Vector3(), wasSnapped: false, initialized: false,
    });
    this._left = mkState();
    this._right = mkState();

    this._leftTrail = new Float32Array(TRAIL_TOTAL * 3);
    this._rightTrail = new Float32Array(TRAIL_TOTAL * 3);

    // ── Pebble distribution ────────────────────────────────────────────────
    this._pebT = new Float32Array(N_PEBBLES);
    this._pebDX = new Float32Array(N_PEBBLES);
    this._pebDY = new Float32Array(N_PEBBLES);
    this._pebDZ = new Float32Array(N_PEBBLES);
    this._pebSizes = new Float32Array(N_PEBBLES);
    this._pebVariant = new Uint8Array(N_PEBBLES);
    this._pebLocalIdx = new Uint16Array(N_PEBBLES);
    this._pebRot = new Array(N_PEBBLES);
    const pebBright = new Float32Array(N_PEBBLES);
    // Round-robin variant assignment, bucketed so each variant's brightness
    // attribute (and InstancedMesh instance count) can be built directly below.
    const bucketBright: number[][] = Array.from({ length: N_PEBBLE_VARIANTS }, () => []);
    const rotAxisScratch = new Vector3();

    for (let i = 0; i < N_PEBBLES; i++) {
      const t = Math.min(1.0, -Math.log(1.0 - Math.random() * 0.9999) / EXP_DECAY_P);
      this._pebT[i] = t;

      const angle = Math.random() * Math.PI * 2;
      const r = Math.sqrt(-2.0 * Math.log(1.0 - Math.random() * 0.9999));
      // Base offset raised from 0.008 so near-head pebbles keep some clearance
      // from the head pebble instead of clustering directly on top of it.
      const spread = 0.024 + t * 0.038;
      this._pebDX[i] = Math.cos(angle) * r * spread;
      this._pebDY[i] = Math.sin(angle) * r * spread;
      // Depth offset: same Gaussian magnitude as lateral, gives true 3-D scatter
      this._pebDZ[i] = (Math.random() - 0.5) * r * spread * 1.6;

      // Larger pebbles near the dense head, tiny ones toward the tail
      this._pebSizes[i] = Math.max(0.006, (0.038 - t * 0.020) * (1.0 - Math.min(r, 2.5) * 0.08));
      // Brightness: mix of bright glowing and dim shadowy pebbles for hazy variety
      pebBright[i] = 0.25 + Math.random() * 0.75;

      const variant = i % N_PEBBLE_VARIANTS;
      this._pebVariant[i] = variant;
      this._pebLocalIdx[i] = bucketBright[variant].length;
      bucketBright[variant].push(pebBright[i]);

      rotAxisScratch.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
      this._pebRot[i] = new Quaternion().setFromAxisAngle(rotAxisScratch, Math.random() * Math.PI * 2);
    }

    // ── Haze distribution ──────────────────────────────────────────────────
    this._hazT = new Float32Array(N_HAZE);
    this._hazDX = new Float32Array(N_HAZE);
    this._hazDY = new Float32Array(N_HAZE);
    this._hazDZ = new Float32Array(N_HAZE);
    const hazSizes = new Float32Array(N_HAZE);
    const hazBright = new Float32Array(N_HAZE);

    for (let i = 0; i < N_HAZE; i++) {
      const t = Math.min(1.0, -Math.log(1.0 - Math.random() * 0.9999) / EXP_DECAY_H);
      this._hazT[i] = t;

      const angle = Math.random() * Math.PI * 2;
      const r = Math.sqrt(-2.0 * Math.log(1.0 - Math.random() * 0.9999));
      const spread = 0.020 + t * 0.060;
      this._hazDX[i] = Math.cos(angle) * r * spread;
      this._hazDY[i] = Math.sin(angle) * r * spread;
      this._hazDZ[i] = (Math.random() - 0.5) * r * spread * 1.4;

      hazSizes[i] = 0.050 + Math.random() * 0.060;            // large soft blobs
      hazBright[i] = (0.04 + Math.random() * 0.10) * (1 - t); // very dim, fades with t
    }

    // ── GPU geometry ───────────────────────────────────────────────────────
    // One InstancedMesh per rock-shape variant, per comet. aBright is written
    // onto the shared module-scope variant geometry here — safe as long as
    // CometSystem is registered exactly once (true today, see src/index.ts).
    this._lPebMeshes = []; this._rPebMeshes = [];
    for (let v = 0; v < N_PEBBLE_VARIANTS; v++) {
      const geo = kPebbleVariantGeos[v];
      geo.setAttribute('aBright', new InstancedBufferAttribute(new Float32Array(bucketBright[v]), 1));

      const count = bucketBright[v].length;
      const lMesh = new InstancedMesh(geo, kPebbleInstMat, count);
      const rMesh = new InstancedMesh(geo, kPebbleInstMat, count);
      lMesh.instanceMatrix.setUsage(DynamicDrawUsage);
      rMesh.instanceMatrix.setUsage(DynamicDrawUsage);
      lMesh.frustumCulled = false;
      rMesh.frustumCulled = false;
      this.world.createTransformEntity(lMesh);
      this.world.createTransformEntity(rMesh);
      this._lPebMeshes.push(lMesh);
      this._rPebMeshes.push(rMesh);
    }

    const lHazGeo = buildGeo(hazSizes, hazBright);
    const rHazGeo = buildGeo(hazSizes, hazBright);
    this._lHazPos = new Float32Array(N_HAZE * 3);
    this._rHazPos = new Float32Array(N_HAZE * 3);
    this._lHazPA = new BufferAttribute(this._lHazPos, 3);
    this._rHazPA = new BufferAttribute(this._rHazPos, 3);
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

    // Load beepchat face textures (already resolved by AssetManifest)
    this._beepchat = ['beepchat3', 'beepchat4', 'smile1', 'smile2']
      .map(k => {
        const t = AssetManager.getTexture(k)!;
        t.magFilter = NearestFilter;
        t.minFilter = NearestFilter;
        return t;
      });

    // Head — one real sphere mesh per comet, per-comet material so each can
    // show a different beepchat frame. Rotated in update() to face direction
    // of travel rather than the camera.
    this._faceDir = new Vector3();
    this._xAxis = new Vector3(1, 0, 0);

    this._lHeadMat = makeHeadMat();
    this._rHeadMat = makeHeadMat();
    this._lHeadMat.uniforms.uFaceTex.value = this._beepchat[0];
    this._rHeadMat.uniforms.uFaceTex.value = this._beepchat[0];

    this._lHeadMesh = new Mesh(kHeadGeo, this._lHeadMat);
    this._rHeadMesh = new Mesh(kHeadGeo, this._rHeadMat);
    this._lHeadMesh.scale.setScalar(HEAD_RADIUS);
    this._rHeadMesh.scale.setScalar(HEAD_RADIUS);
    this._lHeadMesh.frustumCulled = false;
    this._rHeadMesh.frustumCulled = false;
    this.world.createTransformEntity(this._lHeadMesh);
    this.world.createTransformEntity(this._rHeadMesh);
  }

  update(delta: number, time: number) {
    const lFlex = this.input.xr.gamepads.left?.getButtonValue(InputComponent.Squeeze) ?? 0;
    const rFlex = this.input.xr.gamepads.right?.getButtonValue(InputComponent.Squeeze) ?? 0;

    const lWasInit = this._left.initialized;
    const rWasInit = this._right.initialized;
    this._step(this._left, this.player.gripSpaces.left, lFlex, delta);
    this._step(this._right, this.player.gripSpaces.right, rFlex, delta);
    // First real frame of hand tracking: snap the whole trail history to the
    // hand too, so the tail doesn't stretch in from the placeholder (0,0,0).
    if (!lWasInit && this._left.initialized) this._resetTrail(this._leftTrail, this._left.pos);
    if (!rWasInit && this._right.initialized) this._resetTrail(this._rightTrail, this._right.pos);

    this._pushTrail(this._leftTrail, this._left.pos);
    this._pushTrail(this._rightTrail, this._right.pos);

    this._camRight.setFromMatrixColumn(this.camera.matrixWorld, 0);
    this._camUp.setFromMatrixColumn(this.camera.matrixWorld, 1);
    this._camFwd.setFromMatrixColumn(this.camera.matrixWorld, 2);

    // Head tracks current position, rotated to keep its textured front facing
    // the direction of travel (velocity) rather than the camera. Below a tiny
    // speed threshold velocity direction is noisy/undefined, so the last
    // orientation is simply held rather than snapping to an arbitrary default.
    this._lHeadMesh.position.copy(this._left.pos);
    this._rHeadMesh.position.copy(this._right.pos);
    if (this._left.vel.lengthSq() > 0.0004) {
      this._faceDir.copy(this._left.vel).normalize();
      this._lHeadMesh.quaternion.setFromUnitVectors(this._xAxis, this._faceDir);
      // Decal faces backwards/upside-down relative to this alignment alone —
      // correct with an extra 180° roll about the local Z (side) axis.
      this._lHeadMesh.rotateZ(Math.PI);
    }
    if (this._right.vel.lengthSq() > 0.0004) {
      this._faceDir.copy(this._right.vel).normalize();
      this._rHeadMesh.quaternion.setFromUnitVectors(this._xAxis, this._faceDir);
      this._rHeadMesh.rotateZ(Math.PI);
    }

    // Speed-based face selection:
    //   slow (< 1.5 m/s): cycle beepchat 1↔2 at ~1.2 Hz
    //   fast (>= 1.5 m/s): cycle beepchat 3↔4 at ~3 Hz
    // 0.5 m/s threshold — easy to reach with any movement
    // Both cycles: 0.5 s per expression (time * 2.0)
    const THRESH = 1.5;
    const lSpeed = this._left.vel.length();
    const rSpeed = this._right.vel.length();
    const lIdx = lSpeed >= THRESH ? 2 + (Math.floor(time * 2.0) % 2)
      : Math.floor(time * 2.0) % 2;
    const rIdx = rSpeed >= THRESH ? 2 + (Math.floor(time * 2.0) % 2)
      : Math.floor(time * 2.0) % 2;
    this._lHeadMat.uniforms.uFaceTex.value = this._beepchat[lIdx];
    this._rHeadMat.uniforms.uFaceTex.value = this._beepchat[rIdx];

    this._placeInstanced(this._leftTrail, this._pebT, this._pebDX, this._pebDY, this._pebDZ, this._lPebMeshes);
    this._placeInstanced(this._rightTrail, this._pebT, this._pebDX, this._pebDY, this._pebDZ, this._rPebMeshes);
    this._place(this._leftTrail, this._hazT, this._hazDX, this._hazDY, this._hazDZ, N_HAZE, this._lHazPos, this._lHazPA);
    this._place(this._rightTrail, this._hazT, this._hazDX, this._hazDY, this._hazDZ, N_HAZE, this._rHazPos, this._rHazPA);
  }

  private _pushTrail(buf: Float32Array, pos: Vector3): void {
    buf.copyWithin(3, 0, (TRAIL_TOTAL - 1) * 3);
    buf[0] = pos.x; buf[1] = pos.y; buf[2] = pos.z;
  }

  private _resetTrail(buf: Float32Array, pos: Vector3): void {
    for (let i = 0; i < TRAIL_TOTAL; i++) {
      buf[i * 3] = pos.x; buf[i * 3 + 1] = pos.y; buf[i * 3 + 2] = pos.z;
    }
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
      const bx = trail[ti], by = trail[ti + 1], bz = trail[ti + 2];
      const dx = dxArr[i], dy = dyArr[i], dz = dzArr[i];
      pos[i * 3] = bx + cr.x * dx + cu.x * dy + cf.x * dz;
      pos[i * 3 + 1] = by + cr.y * dx + cu.y * dy + cf.y * dz;
      pos[i * 3 + 2] = bz + cr.z * dx + cu.z * dy + cf.z * dz;
    }
    pa.needsUpdate = true;
  }

  private _placeInstanced(
    trail: Float32Array,
    tArr: Float32Array, dxArr: Float32Array, dyArr: Float32Array, dzArr: Float32Array,
    meshes: InstancedMesh[],
  ): void {
    const cr = this._camRight, cu = this._camUp, cf = this._camFwd;
    for (let i = 0; i < N_PEBBLES; i++) {
      const si = Math.min(TRAIL_SAMPLES - 1, Math.floor(tArr[i] * TRAIL_SAMPLES));
      const ti = si * TRAIL_STRIDE * 3;
      const bx = trail[ti], by = trail[ti + 1], bz = trail[ti + 2];
      const dx = dxArr[i], dy = dyArr[i], dz = dzArr[i];
      this._scratchPos.set(
        bx + cr.x * dx + cu.x * dy + cf.x * dz,
        by + cr.y * dx + cu.y * dy + cf.y * dz,
        bz + cr.z * dx + cu.z * dy + cf.z * dz,
      );
      this._scratchScale.setScalar(this._pebSizes[i] * PEBBLE_MESH_SCALE);
      this._scratchMat4.compose(this._scratchPos, this._pebRot[i], this._scratchScale);
      meshes[this._pebVariant[i]].setMatrixAt(this._pebLocalIdx[i], this._scratchMat4);
    }
    for (let v = 0; v < meshes.length; v++) meshes[v].instanceMatrix.needsUpdate = true;
  }

  private _step(state: CometState, grip: Object3D, flexion: number, dt: number): void {
    grip.getWorldPosition(this._handPos);
    grip.getWorldQuaternion(this._gripQuat);
    this._palmOffset.set(0, 0, PALM_OFFSET_Z).applyQuaternion(this._gripQuat);
    this._handPos.add(this._palmOffset);

    // Grip spaces resolve to world origin (0,0,0) before an immersive session
    // is actually active — CometSystem registers immediately at world
    // creation, well before the user accepts the XR session, so the very
    // first _step() call would otherwise latch onto that origin default and
    // then have to spring all the way up to real hand height once tracking
    // begins (the "flies in from below" symptom). visibilityState doesn't
    // distinguish this (it's already "visible" for the 2D fallback canvas
    // too) — world.session is undefined until a real XRSession exists, which
    // is the correct signal to gate on.
    if (!state.initialized && this.world.session) {
      // Equilibrium of the spring/gravity balance below settles at exactly
      // hand height (the restOffset added to the anchor exists precisely to
      // cancel gravity's pull back down to this height) — so spawning here
      // needs no extra offset to avoid a visible settle.
      state.pos.copy(this._handPos);
      state.prevHand.copy(this._handPos);
      state.initialized = true;
    }

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
