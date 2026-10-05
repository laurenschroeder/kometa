// Promo/cover-art renderer for Kometa. Not part of the game bundle — served
// by scripts/promo-art/render.mjs through a throwaway Vite server and driven
// headlessly, one page load per shot (the shot config arrives base64-encoded
// in ?shot=, and index.html seeds Math.random from it before this runs).
//
// Rebuilds the in-hand comet from the game's own pieces — the decal head
// shader + face textures, the three pebble-type materials, the radial
// age/spread field and trail sampler, the haze sprites — but posed by hand
// for a hero shot instead of driven by hand-tracking: the face turned to the
// camera, the tail laid out along an authored S-curve "swish", and a
// higher-detail head mesh so the silhouette holds up at poster size. Point
// sprite sizes are rescaled from the headset's pixel density to this
// render's (see PX) so gas puffs/haze/stars keep their in-game proportions.

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  Quaternion,
  Scene,
  ShaderMaterial,
  Texture,
  TextureLoader,
  Vector3,
  WebGLRenderer,
} from '@iwsdk/core';
import {
  DOME_EQUATOR,
  DOME_SKY,
  HAZE,
  HAZE_GAS,
  hexToRgb,
  COMET_HEAD,
  ORGANIC_MATTER,
  ORGANIC_PALETTE,
  SOUL_DUST,
  STARFIELD_COOL_WHITE,
  STARFIELD_WARM_WHITE,
  VOLATILE_GASSES,
  WHITE,
  RGB,
} from '../../../src/vfx/color/color-scheme.js';
import { loadFbxMeshesByName } from '../../../src/vfx/geometry/fbx-field-loader.js';
import { buildOrganicGeometry } from '../../../src/vfx/geometry/organic-rock-geometry.js';
import { generateRadialField } from '../../../src/vfx/particles/particle-field.js';
import { PEBBLE_MESH_SCALE, pebbleSizeFromSample } from '../../../src/vfx/particles/pebble-size.js';
import { sampleTrailOffset } from '../../../src/vfx/particles/trail-sampler.js';
import {
  GAS_CLOUD_COLOR,
  kOrganicRockMat,
  PEBBLE_ISLAND_MESH_NAMES,
  PEBBLE_ISLAND_MESH_URL,
  SOUL_ISLAND_PALETTE,
  SOUL_SIZE_MULTIPLIER,
} from '../../../src/vfx/shaders/pebble-material.js';
import { makePointSpriteMaterial } from '../../../src/vfx/shaders/point-sprite-material.js';
import { makeSparkleMaterial, makeSparkleMaterialVertexColor } from '../../../src/vfx/shaders/sparkle-material.js';
import {
  makeToonRimDecalMaterial,
  makeToonRimInstancedWigglyMaterial,
} from '../../../src/vfx/shaders/toon-rim-material.js';

interface TailParams {
  angle: number; // screen-space heading of the tail, degrees (0 = right, 90 = up)
  length: number; // meters along the trail
  depth: number; // 0..1 — how much of the tail recedes away from the camera
  swish: number; // lateral S-curve amplitude, meters
  waves: number; // half-waves along the tail
  phase: number; // radians
  spread: number; // multiplier on the game's radial spread
}

// One comet in the shot. A Shot is itself a Comet (single-comet shots put
// these fields at the top level); multi-comet shots list them in `comets`.
interface Comet {
  face: 0 | 1 | 2; // soul / organic / gas, same order as PEBBLE_TYPES
  counts: [number, number, number]; // soul / organic / gas pebbles in the tail
  camDist: number;
  head: [number, number]; // head center, NDC
  faceTurn: [number, number, number]; // yaw, pitch, roll (radians) away from facing the camera
  faceSize: number; // decal sizeMultiplier (the game uses 4)
  tail: TailParams;
}

interface Shot extends Comet {
  name: string;
  w: number;
  h: number;
  ss: number; // supersample factor (downscaled by render.mjs)
  seed: number;
  comets?: Partial<Comet>[];
  fov: number;
  trueAspect: boolean; // letterbox the face art instead of squeezing it square
  gameFace: boolean; // reproduce the in-game head exactly: squeezed 4x decal, game blend, low-poly rock
  headScale: number; // head size vs. the game's HEAD_RADIUS (hero-shot license)
  gasBoost: number; // brightness multiplier on the additive gas puffs
  gasSize: number; // size multiplier on the gas puffs
  nebula: number;
  nebulaCenter: [number, number]; // uv
  glow: number;
  stars: number;
  hazeBoost: number;
  faceEdgeFade: number; // 0..1 how much the face fades out toward the silhouette
  faceGrain: number; // 0..1 stone speckle inside the face
  faceTint: number; // 0..1 pull the white toward warm stone
  bodyGrain: number; // 0..1 mottling on the dark body
  title: 'none' | 'top' | 'middle' | 'bottom';
  titleX: number; // horizontal center of the title lockup, 0..1 of width
  frame: boolean;
  time: number;
}

declare global {
  interface Window {
    __shot: Shot;
    __result?: string;
    __error?: string;
  }
}

const GAME_HEAD_RADIUS = 0.024; // pebble-comet-presentation-system.ts
const TRAIL_SAMPLES = 240;
// Approximate Quest 3 per-eye pixels-per-radian — every point-sprite factor
// in the game was tuned against this density.
const HEADSET_PX_PER_RADIAN = 1000;

const TYPE_COLORS: RGB[] = [hexToRgb(SOUL_DUST), hexToRgb(ORGANIC_MATTER), hexToRgb(VOLATILE_GASSES)];
const FACE_URLS = ['/textures/faceSoul.png', '/textures/faceOrganic.png', '/textures/faceGas.png'];

const shot = window.__shot;
const HEAD_RADIUS = GAME_HEAD_RADIUS * shot.headScale;
const W = shot.w * shot.ss;
const H = shot.h * shot.ss;

run().catch((err) => {
  console.error(err);
  window.__error = String(err?.stack ?? err);
});

async function run(): Promise<void> {
  const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H);
  document.body.appendChild(renderer.domElement);

  const scene = new Scene();
  const camera = new PerspectiveCamera(shot.fov, W / H, 0.002, 200);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();

  const PX = H / (2 * Math.tan((shot.fov * Math.PI) / 360)) / HEADSET_PX_PER_RADIAN;

  scene.add(buildBackground(TYPE_COLORS[shot.face]));
  scene.add(buildStarfield(camera, PX));

  const comets: Comet[] = shot.comets
    ? shot.comets.map((c) => ({ ...shot, ...c, tail: { ...shot.tail, ...c.tail } }))
    : [shot];
  for (const c of comets) {
    const headPos = new Vector3(c.head[0], c.head[1], 0.5).unproject(camera).normalize().multiplyScalar(c.camDist);
    const trail = buildTrail(c, headPos);
    scene.add(buildGlow(c, headPos, TYPE_COLORS[c.face]));
    const faceTex = await loadFace(FACE_URLS[c.face], renderer.capabilities.getMaxAnisotropy());
    scene.add(buildHead(c, headPos, faceTex));
    for (const obj of await buildTail(c, trail, headPos, PX)) scene.add(obj);
  }

  renderer.render(scene, camera);

  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const ctx = out.getContext('2d')!;
  ctx.drawImage(renderer.domElement, 0, 0);
  if (shot.frame) await drawFrame(ctx);
  if (shot.title !== 'none') await drawTitle(ctx);
  window.__result = out.toDataURL('image/png');
}

// ── Trail ──────────────────────────────────────────────────────────────────
// Camera sits at the origin with identity orientation, so camera space is
// world space: +X right, +Y up, +Z toward the viewer. Sample 0 is the head;
// the tail heads off along `angle` in the screen plane while receding by
// `depth`, with a sine swish perpendicular to it that grows from the head
// outward (the head end stays anchored, the tip whips the furthest).
function buildTrail(c: Comet, headPos: Vector3): Float32Array {
  const { angle, length, depth, swish, waves, phase } = c.tail;
  const a = (angle * Math.PI) / 180;
  const axis = new Vector3(Math.cos(a) * (1 - depth), Math.sin(a) * (1 - depth), -depth).normalize();
  const perp = new Vector3(-Math.sin(a), Math.cos(a), 0);
  const trail = new Float32Array(TRAIL_SAMPLES * 3);
  const p = new Vector3();
  for (let i = 0; i < TRAIL_SAMPLES; i++) {
    const s = i / (TRAIL_SAMPLES - 1);
    const lateral = swish * Math.pow(s, 0.85) * (Math.sin(waves * Math.PI * s + phase) - Math.sin(phase) * (1 - s));
    p.copy(headPos).addScaledVector(axis, s * length).addScaledVector(perp, lateral);
    trail[i * 3] = p.x;
    trail[i * 3 + 1] = p.y;
    trail[i * 3 + 2] = p.z;
  }
  return trail;
}

// ── Head ───────────────────────────────────────────────────────────────────
async function loadFace(url: string, anisotropy: number): Promise<Texture> {
  const tex: Texture<HTMLImageElement | HTMLCanvasElement> = await new TextureLoader().loadAsync(url);
  const img = tex.image as HTMLImageElement;
  // The source PNGs are Blender viewport grabs — scrub the stray 3D-cursor
  // gizmo / properties-panel corner so they can't show up at poster size.
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext('2d')!;
  g.drawImage(img, 0, 0);
  const scrub: Record<string, [number, number, number][]> = {
    '/textures/faceSoul.png': [],
    '/textures/faceOrganic.png': [[1245 / 1926, 490 / 1477, 0.022]],
    '/textures/faceGas.png': [[255 / 1999, 172 / 1178, 0.02]],
  };
  g.globalCompositeOperation = 'destination-out';
  for (const [u, v, r] of scrub[url]) {
    g.beginPath();
    g.arc(u * c.width, v * c.height, r * c.width, 0, Math.PI * 2);
    g.fill();
  }
  if (url.endsWith('faceSoul.png')) g.fillRect(c.width * 0.955, 0, c.width * 0.045, c.height * 0.24);
  // The decal shader maps the image onto a square patch of the head, which
  // squeezes these ~1.5:1 faces horizontally. Letterboxing onto a square,
  // transparent canvas keeps the art at its true proportions (faceSize then
  // controls how wide it spreads across the head).
  let finalCanvas = c;
  if (shot.trueAspect && !shot.gameFace) {
    const side = Math.max(c.width, c.height);
    finalCanvas = document.createElement('canvas');
    finalCanvas.width = side;
    finalCanvas.height = side;
    finalCanvas.getContext('2d')!.drawImage(c, (side - c.width) / 2, (side - c.height) / 2);
  }
  tex.image = finalCanvas;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

function buildHead(c: Comet, headPos: Vector3, faceTex: Texture): Mesh {
  const mat = makeToonRimDecalMaterial(
    { bodyColorDark: hexToRgb(COMET_HEAD), bodyColorLight: hexToRgb(COMET_HEAD), rimColor: hexToRgb(WHITE) },
    shot.gameFace ? 4 : c.faceSize, // 4 = makeHeadMat(4) in pebble-comet-presentation-system.ts
    // The game's own carved-stone face mode (all zeros = the original flat
    // look). Defaults in shots.mjs mirror HEAD_ROCKY_FACE in the game.
    { faceGrain: shot.faceGrain, faceTint: shot.faceTint, faceEdgeFade: shot.faceEdgeFade, bodyGrain: shot.bodyGrain },
  );
  mat.uniforms.uFaceTex.value = faceTex;
  if (shot.gameFace) {
    // Exactly the game's kHeadGeo: default (low-poly, lumpier) organic rock.
    const head = new Mesh(buildOrganicGeometry(), mat);
    orientHead(c, head, headPos);
    return head;
  }
  // Same sine-sum rock as the game's kHeadGeo, tessellated finer and with
  // gentler bumps so the face reads clearly at poster size.
  const geo = buildOrganicGeometry({ icoDetail: 5, ampMin: 0.025, ampMax: 0.055 });
  const head = new Mesh(geo, mat);
  orientHead(c, head, headPos);
  return head;
}

function orientHead(c: Comet, head: Mesh, headPos: Vector3): void {
  head.position.copy(headPos);
  head.scale.setScalar(HEAD_RADIUS);

  // The decal projects along local X and reads upright when viewed from +X
  // with local -Y as screen-up — build that basis toward the camera, then
  // apply the shot's yaw/pitch/roll so the face can glance off-axis.
  const [yaw, pitch, roll] = c.faceTurn;
  const worldUp = new Vector3(0, 1, 0);
  const x = new Vector3().sub(headPos).normalize();
  const right = new Vector3().crossVectors(x, worldUp).normalize();
  x.applyAxisAngle(worldUp, yaw).applyAxisAngle(right, pitch);
  const y = worldUp.clone().addScaledVector(x, -worldUp.dot(x)).normalize().negate();
  y.applyAxisAngle(x, roll);
  const z = new Vector3().crossVectors(x, y);
  head.quaternion.setFromRotationMatrix(new Matrix4().makeBasis(x, y, z));
}

// ── Tail ───────────────────────────────────────────────────────────────────
async function buildTail(c: Comet, trail: Float32Array, headPos: Vector3, PX: number) {
  const objects: (Mesh | Points)[] = [];
  const [nSoul, nOrganic, nGas] = c.counts;
  const n = nSoul + nOrganic + nGas;
  const spread = c.tail.spread;

  const field = generateRadialField({
    count: n,
    ageDecay: 3.5,
    spreadBase: 0.024 * spread,
    spreadGrowth: 0.038 * spread,
    depthRatio: 1.6,
  });

  // Shuffle type assignment so every type spreads along the whole tail.
  const types: number[] = [];
  for (let i = 0; i < nSoul; i++) types.push(0);
  for (let i = 0; i < nOrganic; i++) types.push(1);
  for (let i = 0; i < nGas; i++) types.push(2);
  for (let i = types.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [types[i], types[j]] = [types[j], types[i]];
  }

  const right = new Vector3(1, 0, 0);
  const up = new Vector3(0, 1, 0);
  const fwd = new Vector3(0, 0, 1);
  const pos = new Vector3();
  const headDir = headPos.clone().normalize();
  const headAngle = Math.atan2(HEAD_RADIUS, c.camDist) * 1.25;

  const place = (i: number, extraRadius: number): Vector3 => {
    sampleTrailOffset(trail, TRAIL_SAMPLES, 1, field.t[i], field.dx[i], field.dy[i], field.dz[i], right, up, fwd, pos);
    // Never let a pebble sit in front of the face — push anything inside
    // the head's on-screen disk back behind it.
    const ang = pos.clone().normalize().angleTo(headDir);
    if (ang < headAngle + extraRadius / c.camDist && -pos.z < -headPos.z + HEAD_RADIUS * 1.2) {
      const behind = -headPos.z + HEAD_RADIUS * (1.6 + Math.random());
      pos.multiplyScalar(behind / -pos.z);
    }
    return pos;
  };

  const rot = new Quaternion();
  const axis = new Vector3();
  const scale = new Vector3();
  const m = new Matrix4();
  const randRot = () => {
    axis.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
    return rot.setFromAxisAngle(axis, Math.random() * Math.PI * 2);
  };

  // Organic — palette-tinted rocks, 6 shape variants, using the game's own
  // shared organic pebble material.
  const organicIdx = types.map((t, i) => (t === 1 ? i : -1)).filter((i) => i >= 0);
  if (organicIdx.length) {
    const mat = kOrganicRockMat;
    const variants = 6;
    for (let v = 0; v < variants; v++) {
      const mine = organicIdx.filter((_, k) => k % variants === v);
      if (!mine.length) continue;
      const geo = buildOrganicGeometry({ icoDetail: 3 });
      addInstanceAttrs(geo, mine.length, (k, tint) => {
        const c = ORGANIC_PALETTE[Math.floor(Math.random() * ORGANIC_PALETTE.length)];
        tint.setXYZ(k, c[0], c[1], c[2]);
      }, 1);
      const mesh = new InstancedMesh(geo, mat, mine.length);
      mine.forEach((i, k) => {
        const size = pebbleSizeFromSample(field.t[i], field.r[i]) * PEBBLE_MESH_SCALE * 0.8;
        place(i, size);
        m.compose(pos, randRot(), scale.setScalar(size));
        mesh.setMatrixAt(k, m);
      });
      mesh.frustumCulled = false;
      objects.push(mesh);
    }
  }

  // Soul — translucent wiggly islands from blobpeople.fbx.
  const soulIdx = types.map((t, i) => (t === 0 ? i : -1)).filter((i) => i >= 0);
  if (soulIdx.length) {
    const mat = makeToonRimInstancedWigglyMaterial(SOUL_ISLAND_PALETTE, { amplitude: 0.19, opacity: 0.55 });
    mat.uniforms.uTime.value = shot.time;
    const islands = (await loadFbxMeshesByName(PEBBLE_ISLAND_MESH_URL, PEBBLE_ISLAND_MESH_NAMES)).filter(
      (g): g is BufferGeometry => g !== null,
    );
    if (!islands.length) islands.push(buildOrganicGeometry({ icoDetail: 3 }));
    islands.forEach((island, b) => {
      const mine = soulIdx.filter((_, k) => k % islands.length === b);
      if (!mine.length) return;
      const geo = island.clone();
      addInstanceAttrs(geo, mine.length, () => {}, 0);
      const phase = new Float32Array(mine.length).map(() => Math.random());
      geo.setAttribute('aWigglePhase', new InstancedBufferAttribute(phase, 1));
      const mesh = new InstancedMesh(geo, mat, mine.length);
      mine.forEach((i, k) => {
        const size = pebbleSizeFromSample(field.t[i], field.r[i]) * PEBBLE_MESH_SCALE * SOUL_SIZE_MULTIPLIER;
        place(i, size);
        m.compose(pos, randRot(), scale.setScalar(size));
        mesh.setMatrixAt(k, m);
      });
      mesh.frustumCulled = false;
      mesh.renderOrder = 2;
      objects.push(mesh);
    });
  }

  // Gas — 5 additive puffs per pebble, jittered in camera space.
  const gasIdx = types.map((t, i) => (t === 2 ? i : -1)).filter((i) => i >= 0);
  if (gasIdx.length) {
    const per = 5;
    const count = gasIdx.length * per;
    const positions = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const bright = new Float32Array(count);
    const dir = new Vector3();
    gasIdx.forEach((i, k) => {
      const size = pebbleSizeFromSample(field.t[i], field.r[i]);
      place(i, size * PEBBLE_MESH_SCALE);
      for (let j = 0; j < per; j++) {
        const f = k * per + j;
        dir.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
        const mag = size * 1.3 * Math.random();
        positions[f * 3] = pos.x + dir.x * mag;
        positions[f * 3 + 1] = pos.y + dir.y * mag;
        positions[f * 3 + 2] = pos.z + dir.z * mag;
        sizes[f] = size * PEBBLE_MESH_SCALE * 16 * shot.gasSize * (0.6 + Math.random() * 0.6);
        bright[f] = (0.4 + Math.random() * 0.6) * shot.gasBoost;
      }
    });
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(positions, 3));
    geo.setAttribute('aSize', new BufferAttribute(sizes, 1));
    geo.setAttribute('aBright', new BufferAttribute(bright, 1));
    const mat = makePointSpriteMaterial({
      color: GAS_CLOUD_COLOR,
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
      pointSizeFactor: 300 * PX,
    });
    const pts = new Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = 3;
    objects.push(pts);
  }

  // Haze — big dim soft blobs billowing along the whole tail.
  {
    const nHaze = 90;
    const hazeField = generateRadialField({
      count: nHaze,
      ageDecay: 1.4,
      spreadBase: 0.02 * spread,
      spreadGrowth: 0.06 * spread,
      depthRatio: 1.4,
    });
    const positions = new Float32Array(nHaze * 3);
    const sizes = new Float32Array(nHaze);
    const bright = new Float32Array(nHaze);
    for (let i = 0; i < nHaze; i++) {
      sampleTrailOffset(trail, TRAIL_SAMPLES, 1, hazeField.t[i], hazeField.dx[i], hazeField.dy[i], hazeField.dz[i], right, up, fwd, pos);
      positions.set([pos.x, pos.y, pos.z], i * 3);
      sizes[i] = (0.05 + Math.random() * 0.06) * spread;
      bright[i] = (0.04 + Math.random() * 0.1) * (1 - hazeField.t[i]) * shot.hazeBoost;
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(positions, 3));
    geo.setAttribute('aSize', new BufferAttribute(sizes, 1));
    geo.setAttribute('aBright', new BufferAttribute(bright, 1));
    const mat = makePointSpriteMaterial({
      color: hexToRgb(c.face === 2 ? HAZE_GAS : HAZE),
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
      pointSizeFactor: 300 * PX,
    });
    const pts = new Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = 1;
    objects.push(pts);
  }

  return objects;
}

function addInstanceAttrs(
  geo: BufferGeometry,
  count: number,
  setTint: (k: number, tint: InstancedBufferAttribute) => void,
  tinted: number,
): void {
  const tint = new InstancedBufferAttribute(new Float32Array(count * 3), 3);
  for (let k = 0; k < count; k++) setTint(k, tint);
  geo.setAttribute('aBright', new InstancedBufferAttribute(new Float32Array(count).fill(0.7), 1));
  geo.setAttribute('aTint', tint);
  geo.setAttribute('aTinted', new InstancedBufferAttribute(new Float32Array(count).fill(tinted), 1));
}

// ── Backdrop ───────────────────────────────────────────────────────────────
// Full-screen gradient in the game's own dome colors, plus a faint fbm
// nebula wash in the face type's identity color.
function buildBackground(typeColor: RGB): Mesh {
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const [sr, sg, sb] = hexToRgb(DOME_SKY);
  const [er, eg, eb] = hexToRgb(DOME_EQUATOR);
  const mat = new ShaderMaterial({
    uniforms: {
      uAspect: { value: W / H },
      uNebula: { value: shot.nebula },
      uCenter: { value: shot.nebulaCenter },
      uSeed: { value: (shot.seed % 97) * 1.37 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = position.xy * 0.5 + 0.5;
        gl_Position = vec4(position.xy, 0.99999, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uAspect;
      uniform float uNebula;
      uniform vec2 uCenter;
      uniform float uSeed;
      varying vec2 vUv;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
      }
      float fbm(vec2 p) {
        float v = 0.0, a = 0.5;
        for (int i = 0; i < 6; i++) { v += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; }
        return v;
      }
      void main() {
        vec3 sky = mix(vec3(${er}, ${eg}, ${eb}), vec3(${sr}, ${sg}, ${sb}), smoothstep(0.0, 1.0, vUv.y));
        vec2 p = vec2((vUv.x - uCenter.x) * uAspect, vUv.y - uCenter.y);
        float r = length(p);
        vec2 q = p * 2.2 + uSeed;
        float warp = fbm(q + fbm(q * 1.7 + 3.0) * 1.6);
        float cloud = smoothstep(0.35, 0.95, warp) * exp(-r * r * 2.2);
        float wisps = pow(smoothstep(0.45, 1.0, fbm(q * 3.1 - 5.0)), 2.0) * exp(-r * 1.6);
        vec3 tint = vec3(${typeColor[0]}, ${typeColor[1]}, ${typeColor[2]});
        vec3 col = sky + tint * (cloud * 0.22 + wisps * 0.12) * uNebula
                 + vec3(0.06, 0.08, 0.16) * exp(-r * r * 1.5) * uNebula;
        // gentle vignette
        vec2 vq = vUv - 0.5;
        col *= 1.0 - dot(vq, vq) * 0.9;
        // dither against banding once downsampled to 8-bit
        col += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  return mesh;
}

function buildStarfield(camera: PerspectiveCamera, PX: number): Points {
  const count = Math.round(2600 * shot.stars);
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const colors = new Float32Array(count * 3);
  const phases = new Float32Array(count);
  const bright = new Float32Array(count);
  const cool = hexToRgb(STARFIELD_COOL_WHITE);
  const warm = hexToRgb(STARFIELD_WARM_WHITE);
  const v = new Vector3();
  for (let i = 0; i < count; i++) {
    v.set(Math.random() * 2.2 - 1.1, Math.random() * 2.2 - 1.1, 0.5).unproject(camera).normalize();
    v.multiplyScalar(25 + Math.random() * 15);
    positions.set([v.x, v.y, v.z], i * 3);
    // Mostly faint pinpricks, a few brighter ones.
    const big = Math.pow(Math.random(), 6);
    sizes[i] = 0.05 * (0.35 + Math.random() * 0.45 + big * 1.4);
    const t = Math.random();
    colors.set([cool[0] + (warm[0] - cool[0]) * t, cool[1] + (warm[1] - cool[1]) * t, cool[2] + (warm[2] - cool[2]) * t], i * 3);
    phases[i] = Math.random();
    bright[i] = 0.25 + Math.random() * 0.6 + big * 0.5;
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(positions, 3));
  geo.setAttribute('aSize', new BufferAttribute(sizes, 1));
  geo.setAttribute('aColor', new BufferAttribute(colors, 3));
  geo.setAttribute('aPhase', new BufferAttribute(phases, 1));
  geo.setAttribute('aBright', new BufferAttribute(bright, 1));
  const mat = makeSparkleMaterialVertexColor({ pointSizeFactor: 3500 * PX * 0.55, blending: AdditiveBlending });
  mat.uniforms.uTime.value = shot.time;
  const pts = new Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = -900;

  // A handful of spiky "hero" stars (sparkle-material.ts's spiky look).
  const nHero = Math.round(7 * shot.stars);
  const hPos = new Float32Array(nHero * 3);
  const hSize = new Float32Array(nHero);
  const hBright = new Float32Array(nHero);
  const hPhase = new Float32Array(nHero).fill(0.25);
  for (let i = 0; i < nHero; i++) {
    v.set(Math.random() * 1.9 - 0.95, Math.random() * 1.9 - 0.95, 0.5).unproject(camera).normalize().multiplyScalar(30);
    hPos.set([v.x, v.y, v.z], i * 3);
    hSize[i] = 0.25 + Math.random() * 0.35;
    hBright[i] = 0.6 + Math.random() * 0.4;
  }
  const hGeo = new BufferGeometry();
  hGeo.setAttribute('position', new BufferAttribute(hPos, 3));
  hGeo.setAttribute('aSize', new BufferAttribute(hSize, 1));
  hGeo.setAttribute('aBright', new BufferAttribute(hBright, 1));
  hGeo.setAttribute('aPhase', new BufferAttribute(hPhase, 1));
  const hMat = makeSparkleMaterial({
    color: hexToRgb(STARFIELD_WARM_WHITE),
    spiky: true,
    blending: AdditiveBlending,
    pointSizeFactor: 3500 * PX * 0.55,
  });
  hMat.uniforms.uTime.value = 0;
  const hero = new Points(hGeo, hMat);
  hero.frustumCulled = false;
  hero.renderOrder = -899;
  pts.add(hero);
  return pts;
}

// Soft type-colored bloom just behind the head so the dark navy body
// separates from the night sky.
function buildGlow(c: Comet, headPos: Vector3, typeColor: RGB): Mesh {
  const mat = new ShaderMaterial({
    uniforms: { uStrength: { value: shot.glow } },
    vertexShader: `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: `
      uniform float uStrength;
      varying vec2 vUv;
      void main() {
        float r = length(vUv - 0.5) * 2.0;
        float a = exp(-r * r * 5.0) * 0.55 + exp(-r * 9.0) * 0.45;
        gl_FragColor = vec4(vec3(${typeColor[0]}, ${typeColor[1]}, ${typeColor[2]}) * a * uStrength, 1.0);
      }
    `,
    blending: AdditiveBlending,
    depthWrite: false,
    transparent: true,
  });
  const size = HEAD_RADIUS * 9;
  const mesh = new Mesh(new PlaneGeometry(size, size), mat);
  mesh.position.copy(headPos).multiplyScalar(1 + (HEAD_RADIUS * 1.5) / c.camDist);
  mesh.lookAt(0, 0, 0);
  mesh.renderOrder = -10;
  return mesh;
}

// ── 2D overlays (title lockup + frame) ───────────────────────────────────
async function loadFonts(): Promise<void> {
  const faces = [
    new FontFace('ImperialScript', 'url(/fonts/ImperialScript-Regular.ttf)'),
    new FontFace('CarroisGothicSC', 'url(/fonts/CarroisGothicSC-Regular.ttf)'),
  ];
  for (const f of faces) document.fonts.add(await f.load());
}

// Mirrors index.html's #kometa-panel: a script "K" at 2.625x the hud-font
// "OMETA", both centered on one line, then the tagline + studio credit.
async function drawTitle(ctx: CanvasRenderingContext2D): Promise<void> {
  await loadFonts();
  const portrait = H > W * 1.1;
  const landscape = W > H * 1.1;
  const m = Math.min(W, H);
  const S = m * (portrait ? 0.13 : landscape ? 0.11 : 0.1);
  const K = S * 2.625;
  // Sized so the tagline stays inside the frame's corner flourishes.
  const cy = shot.title === 'top' ? H * 0.2 : shot.title === 'middle' ? H * 0.42 : H * (portrait ? 0.76 : 0.7);
  const cx = W * shot.titleX;

  ctx.save();
  ctx.fillStyle = '#fffae2';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
  ctx.shadowBlur = S * 0.35;

  ctx.font = `${K}px ImperialScript`;
  const kW = ctx.measureText('K').width;
  ctx.font = `bold ${S}px CarroisGothicSC`;
  const restW = ctx.measureText('OMETA').width;
  const x0 = cx - (kW + restW) / 2;
  ctx.font = `${K}px ImperialScript`;
  ctx.fillText('K', x0, cy);
  ctx.font = `bold ${S}px CarroisGothicSC`;
  ctx.fillText('OMETA', x0 + kW, cy + S * 0.06);

  const tag = m * (landscape ? 0.03 : 0.026);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#d4d4d8';
  ctx.shadowBlur = tag * 0.6;
  ctx.font = `${tag}px CarroisGothicSC`;
  ctx.letterSpacing = `${tag * 0.14}px`;
  const tagY = cy + K * 0.4;
  ctx.fillText('AN EXPERIENCE OF STARDUST AND FATE', cx, tagY);
  // Studio credit — a quiet byline, smaller and dimmer than the tagline.
  ctx.font = `${tag * 0.8}px CarroisGothicSC`;
  ctx.letterSpacing = `${tag * 0.8 * 0.12}px`;
  ctx.fillStyle = '#9a9aa2';
  ctx.fillText('by Virtual Pebble Studio', cx, tagY + tag * 1.6);
  ctx.restore();
}

// Thin white border with the corner.png swirl at each corner — the game's
// own panel/button framing language.
async function drawFrame(ctx: CanvasRenderingContext2D): Promise<void> {
  const img = new Image();
  img.src = '/textures/corner.png';
  await img.decode();
  const inset = Math.min(W, H) * 0.035;
  const line = Math.max(2, Math.min(W, H) * 0.0025);
  const c = Math.min(W, H) * 0.11;
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.lineWidth = line;
  ctx.strokeRect(inset, inset, W - inset * 2, H - inset * 2);
  const corners: [number, number, number][] = [
    [inset, H - inset - c, 0],
    [inset, inset, 90],
    [W - inset - c, inset, 180],
    [W - inset - c, H - inset - c, 270],
  ];
  for (const [x, y, deg] of corners) {
    ctx.save();
    ctx.translate(x + c / 2, y + c / 2);
    ctx.rotate((deg * Math.PI) / 180);
    ctx.drawImage(img, -c / 2, -c / 2, c, c);
    ctx.restore();
  }
  ctx.restore();
}
