// One representative art image per game phase, for the pitch/art deck —
// selected by a shot's `scene` field (see shots.mjs's `phases` list) and
// built from the same game modules the comet hero shots use: the planet
// stain shader, the plant/crowd/crown FBX packs, the launch nebula and
// labels, the stardust sparkle and gold pixel-CRT swirl materials. Posed by
// hand for a still frame rather than driven by gameplay.
//
// The camera sits at the origin looking down -Z (main.ts's comet helpers
// assume that); the fate scene tilts it down toward the crowd instead.

import {
  AdditiveBlending,
  AnimationMixer,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Euler,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  Quaternion,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  Vector4,
  WebGLRenderer,
} from '@iwsdk/core';
import {
  hexToRgb,
  MOON,
  NAMED_RIM,
  ORBIT,
  ORGANIC_PALETTE,
  PLANET_BASE,
  RGB,
  STARDUST,
  SWIRL_GOLD,
  UNKNOWN,
} from '../../../src/vfx/color/color-scheme.js';
import {
  buildAnimatedPerson,
  loadAnimatedPersonTemplate,
  loadPersonClip,
  PERSON_BODY_COLOR,
} from '../../../src/vfx/geometry/animated-person.js';
import {
  centerAndNormalizeGeometryToUnitSize,
  loadFbxAllMeshes,
  loadFbxMeshesByName,
} from '../../../src/vfx/geometry/fbx-field-loader.js';
import { buildNebulaCloud } from '../../../src/vfx/geometry/nebula-cloud.js';
import { buildOrganicGeometry } from '../../../src/vfx/geometry/organic-rock-geometry.js';
import { PERSON_HEIGHT } from '../../../src/vfx/geometry/placeholder-person.js';
import { scatterDisc, scatterGalaxyArm } from '../../../src/vfx/geometry/pixel-swirl.js';
import { generateRadialField } from '../../../src/vfx/particles/particle-field.js';
import { sampleTrailOffset } from '../../../src/vfx/particles/trail-sampler.js';
import {
  GAS_CLOUD_COLOR,
  kOrganicRockMat,
  PEBBLE_ISLAND_MESH_NAMES,
  PEBBLE_ISLAND_MESH_URL,
  SOUL_ISLAND_PALETTE,
} from '../../../src/vfx/shaders/pebble-material.js';
import { makePixelCrtMaterial } from '../../../src/vfx/shaders/pixel-crt-material.js';
import { makePlanetStainMaterial, MAX_SPLATS } from '../../../src/vfx/shaders/planet-stain-material.js';
import { makePointSpriteMaterial } from '../../../src/vfx/shaders/point-sprite-material.js';
import { makeSparkleMaterial } from '../../../src/vfx/shaders/sparkle-material.js';
import {
  makeToonRimFlatMaterial,
  makeToonRimInstancedWigglyMaterial,
  makeToonRimSkinnedMaterial,
} from '../../../src/vfx/shaders/toon-rim-material.js';
import { drawLabel, fontReady } from '../../../src/vfx/textures/canvas-label.js';
import { buildKingCrownProp } from '../../../src/phases/fate-events/earth-situations-vfx-system.js';
import {
  loadDesertPlantGeos,
  loadFlowerPlantGeos,
  PLANT_DITHER_MAT,
} from '../../../src/phases/planet-seeding/planet-growth-pool.js';
import { CELL_DIRS } from '../../../src/phases/planet-seeding/planet-seeding-system.js';
import {
  addComet,
  addInstanceAttrs,
  buildBackground,
  buildStarfield,
  buildTrail,
  Comet,
  Shot,
  shot,
  TYPE_COLORS,
} from './main.js';

type SceneName = NonNullable<Shot['scene']>;

const STARDUST_RGB = hexToRgb(STARDUST);
const UP = new Vector3(0, 1, 0);

export async function buildPhaseScene(
  name: SceneName,
  scene: Scene,
  camera: PerspectiveCamera,
  renderer: WebGLRenderer,
  PX: number,
): Promise<void> {
  const builders: Record<SceneName, () => Promise<void>> = {
    stardust: () => buildStardust(scene, camera, PX),
    pebbles: () => buildPebbles(scene, camera, renderer, PX),
    seeding: () => buildSeeding(scene, camera, PX),
    fate: () => buildFate(scene, camera, renderer, PX),
    launch: () => buildLaunch(scene, camera, renderer, PX),
    flyaway: () => buildFlyaway(scene, camera, renderer, PX),
  };
  await builders[name]();
}

// ── Shared bits ───────────────────────────────────────────────────────────
function backdrop(scene: Scene, camera: PerspectiveCamera, PX: number, tint: RGB): void {
  scene.add(buildBackground(tint));
  scene.add(buildStarfield(camera, PX));
}

// The shot's comets with main.ts's single-comet defaults filled in — same
// merge main.ts does for multi-comet hero shots.
function cometsOf(): Comet[] {
  return (shot.comets ?? [shot]).map((c) => ({ ...shot, ...c, tail: { ...shot.tail, ...c.tail } }));
}

// NDC + distance → camera-space point (camera at origin, see file header).
function at(camera: PerspectiveCamera, x: number, y: number, dist: number): Vector3 {
  return new Vector3(x, y, 0.5).unproject(camera).normalize().multiplyScalar(dist);
}

interface SpriteCloud {
  positions: number[];
  sizes: number[];
  bright: number[];
  phases: number[];
}
const cloud = (): SpriteCloud => ({ positions: [], sizes: [], bright: [], phases: [] });

function cloudGeometry(c: SpriteCloud): BufferGeometry {
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(c.positions), 3));
  geo.setAttribute('aSize', new BufferAttribute(new Float32Array(c.sizes), 1));
  geo.setAttribute('aBright', new BufferAttribute(new Float32Array(c.bright), 1));
  geo.setAttribute('aPhase', new BufferAttribute(new Float32Array(c.phases), 1));
  return geo;
}

function sparkles(c: SpriteCloud, color: RGB, PX: number): Points {
  const mat = makeSparkleMaterial({ color, blending: AdditiveBlending, pointSizeFactor: 300 * PX });
  mat.uniforms.uTime.value = shot.time;
  const pts = new Points(cloudGeometry(c), mat);
  pts.frustumCulled = false;
  return pts;
}

function haze(c: SpriteCloud, color: RGB, PX: number, renderOrder = 1): Points {
  const mat = makePointSpriteMaterial({
    color,
    blending: AdditiveBlending,
    depthWrite: false,
    transparent: true,
    pointSizeFactor: 300 * PX,
  });
  const pts = new Points(cloudGeometry(c), mat);
  pts.frustumCulled = false;
  pts.renderOrder = renderOrder;
  return pts;
}

// Soft additive bloom disc facing the camera — a type-colored "aura" behind
// a cluster/planet so it separates from the night sky (main.ts's buildGlow,
// generalized to any size/position).
function glow(pos: Vector3, size: number, color: RGB, strength: number): Mesh {
  const quad = new Mesh(
    new PlaneGeometry(size, size),
    new ShaderMaterial({
      vertexShader: `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: `
        varying vec2 vUv;
        void main() {
          float r = length(vUv - 0.5) * 2.0;
          float a = exp(-r * r * 4.0) * 0.6 + exp(-r * 7.0) * 0.4;
          gl_FragColor = vec4(vec3(${color[0]}, ${color[1]}, ${color[2]}) * a * ${strength.toFixed(4)}, 1.0);
        }
      `,
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
    }),
  );
  quad.position.copy(pos);
  quad.lookAt(0, 0, 0);
  quad.renderOrder = -10;
  return quad;
}

// nebula-cloud.ts's cloud, with its sprite size rescaled from headset pixel
// density to this render's (its material bakes the factor in at build time).
function nebulaCloud(color: RGB, PX: number): Group {
  const group = buildNebulaCloud(color);
  const pts = group.children[0] as Points;
  pts.material = makePointSpriteMaterial({
    color,
    blending: AdditiveBlending,
    depthWrite: false,
    transparent: true,
    pointSizeFactor: 300 * PX,
  });
  return group;
}

function randomUnit(): Vector3 {
  return new Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
}

function randomRot(q: Quaternion): Quaternion {
  return q.setFromAxisAngle(randomUnit(), Math.random() * Math.PI * 2);
}

// Pose a figure standing on a sphere: +Y along the surface normal, then
// yawed about that normal so its +Z (Mixamo forward) faces `lookAt`.
function standOnSphere(obj: Object3D, center: Vector3, radius: number, normal: Vector3, lookAt: Vector3): void {
  obj.position.copy(center).addScaledVector(normal, radius);
  const toTarget = lookAt.clone().sub(obj.position);
  toTarget.addScaledVector(normal, -toTarget.dot(normal)).normalize();
  const x = new Vector3().crossVectors(normal, toTarget).normalize();
  obj.quaternion.setFromRotationMatrix(new Matrix4().makeBasis(x, normal, toTarget));
}

// ── Planet ────────────────────────────────────────────────────────────────
// The game's planet exactly: a perfect-sphere organic rock with the stain
// shader, every grid cell colored and fully bloomed (uFinalGrowT = 1, the
// post-spin "many years later" state) in ORGANIC_PALETTE — which is what
// PlanetSeedingSystem rolls each landing's color from. `skip(dir)` leaves a
// cell bare (Fate Events fades the stains out under the crowd).
function buildPlanet(skip: (dir: Vector3) => boolean = () => false): { mesh: Mesh; colors: RGB[] } {
  const mat = makePlanetStainMaterial(hexToRgb(PLANET_BASE));
  mat.uniforms.uTime.value = 100;
  mat.uniforms.uFinalGrowT.value = 1;
  const centers = mat.uniforms.uSplatCenterBirth.value as Vector4[];
  const fades = mat.uniforms.uSplatColorFade.value as Vector4[];
  const colors: RGB[] = [];
  const dir = new Vector3();
  for (let i = 0; i < MAX_SPLATS; i++) {
    dir.set(CELL_DIRS[i * 3], CELL_DIRS[i * 3 + 1], CELL_DIRS[i * 3 + 2]);
    const c = ORGANIC_PALETTE[Math.floor(Math.random() * ORGANIC_PALETTE.length)];
    colors.push(c);
    if (skip(dir)) continue;
    centers[i].set(dir.x, dir.y, dir.z, 0);
    fades[i].set(c[0], c[1], c[2], 0);
  }
  const mesh = new Mesh(buildOrganicGeometry({ icoDetail: 5, ampMin: 0, ampMax: 0 }), mat);
  return { mesh, colors };
}

// Plants on every grid cell (planet-growth-pool.ts's layout: one per
// CELL_DIRS slot), parented under the unit-radius planet mesh. Organic's
// hemisphere split — desert pack on +X, flowers on -X — or one pack for the
// whole grid. `scale` is in planet radii (the pool's GROWTH_FINAL_SCALE).
async function addPlants(
  planet: Mesh,
  colors: RGB[],
  scale: number,
  pack: 'split' | 'desert' | 'flowers',
  skip: (dir: Vector3) => boolean = () => false,
): Promise<void> {
  const [desert, flowers] = await Promise.all([loadDesertPlantGeos(), loadFlowerPlantGeos()]);
  const slots: { dir: Vector3; color: RGB; flower: boolean }[] = [];
  for (let i = 0; i < MAX_SPLATS; i++) {
    const dir = new Vector3(CELL_DIRS[i * 3], CELL_DIRS[i * 3 + 1], CELL_DIRS[i * 3 + 2]);
    if (skip(dir)) continue;
    const flower = pack === 'flowers' || (pack === 'split' && dir.x < 0);
    slots.push({ dir, color: colors[i], flower });
  }
  const groups: [BufferGeometry[], typeof slots][] = [
    [desert, slots.filter((s) => !s.flower)],
    [flowers, slots.filter((s) => s.flower)],
  ];
  const m = new Matrix4();
  const q = new Quaternion();
  const spin = new Quaternion();
  const pos = new Vector3();
  const s = new Vector3();
  for (const [geos, mine] of groups) {
    if (!geos.length || !mine.length) continue;
    geos.forEach((source, g) => {
      const own = mine.filter((_, k) => k % geos.length === g);
      if (!own.length) return;
      const geo = source.clone();
      const tint = new Float32Array(own.length * 3);
      own.forEach((slot, k) => tint.set(slot.color, k * 3));
      geo.setAttribute('aBright', new InstancedBufferAttribute(new Float32Array(own.length).fill(0.7), 1));
      geo.setAttribute('aTint', new InstancedBufferAttribute(tint, 3));
      geo.setAttribute('aTinted', new InstancedBufferAttribute(new Float32Array(own.length).fill(1), 1));
      const mesh = new InstancedMesh(geo, PLANT_DITHER_MAT, own.length);
      own.forEach((slot, k) => {
        pos.copy(slot.dir).multiplyScalar(1.002);
        q.setFromUnitVectors(UP, slot.dir).multiply(spin.setFromAxisAngle(UP, Math.random() * Math.PI * 2));
        m.compose(pos, q, s.setScalar(scale * (0.8 + Math.random() * 0.4)));
        mesh.setMatrixAt(k, m);
      });
      mesh.frustumCulled = false;
      planet.add(mesh);
    });
  }
}

// ── 1. Stardust ───────────────────────────────────────────────────────────
// The comet before it has a body: a tight clump of captured cream stardust
// riding the hand, trailing a sparkle tail, with ungathered motes drifting
// all around and the gold pixel-CRT swirl (the phase's finale) behind.
async function buildStardust(scene: Scene, camera: PerspectiveCamera, PX: number): Promise<void> {
  backdrop(scene, camera, PX, STARDUST_RGB);

  const [c] = cometsOf();
  const headPos = at(camera, c.head[0], c.head[1], c.camDist);
  const trail = buildTrail(c, headPos);
  scene.add(glow(headPos.clone().multiplyScalar(1.05), 0.2, STARDUST_RGB, 0.3));

  const right = new Vector3(1, 0, 0);
  const up = new Vector3(0, 1, 0);
  const fwd = new Vector3(0, 0, 1);
  const p = new Vector3();

  // Captured clump + tail — the game's own captured-field shape (see
  // StardustSystem.getCapturedField) sampled along the trail.
  const n = 750;
  const field = generateRadialField({ count: n, ageDecay: 6, spreadBase: 0.01, spreadGrowth: 0.045, depthRatio: 1.6 });
  const clump = cloud();
  for (let i = 0; i < n; i++) {
    sampleTrailOffset(trail, 240, 1, field.t[i], field.dx[i], field.dy[i], field.dz[i], right, up, fwd, p);
    clump.positions.push(p.x, p.y, p.z);
    clump.sizes.push((0.011 + Math.random() * 0.016) * (1 - field.t[i] * 0.3));
    clump.bright.push(0.4 + Math.random() * 0.5);
    clump.phases.push(Math.random());
  }
  scene.add(sparkles(clump, STARDUST_RGB, PX));

  // Ungathered ambient motes, near and far.
  const ambient = cloud();
  for (let i = 0; i < 420; i++) {
    const d = 0.35 + Math.pow(Math.random(), 0.7) * 3.2;
    const v = at(camera, Math.random() * 2.2 - 1.1, Math.random() * 2.2 - 1.1, d);
    ambient.positions.push(v.x, v.y, v.z);
    ambient.sizes.push(d > 2.4 ? 0.09 : d < 0.8 ? 0.028 : 0.05);
    ambient.bright.push(0.5 + Math.random() * 0.5);
    ambient.phases.push(Math.random());
  }
  scene.add(sparkles(ambient, STARDUST_RGB, PX));

  // Gold swirl — StardustSystem's galaxy-arm layout, tilted toward camera.
  const swirl = cloud();
  const swirlCenter = at(camera, 0.5, 0.3, 1.15);
  const tilt = new Quaternion().setFromAxisAngle(new Vector3(1, 0.2, 0).normalize(), -0.75);
  for (let i = 0; i < 260; i++) {
    const pt = i < 200 ? scatterGalaxyArm(i % 5, 5, 1.0, 0.35, 0.22, 0.03) : scatterDisc(0.08, 0.03);
    p.set(pt[0], pt[1], pt[2]).applyQuaternion(tilt).add(swirlCenter);
    swirl.positions.push(p.x, p.y, p.z);
    swirl.sizes.push(0.03);
    swirl.bright.push(0.6 + Math.random() * 0.4);
    swirl.phases.push(Math.random());
  }
  const crt = makePixelCrtMaterial({ color: hexToRgb(SWIRL_GOLD), blending: AdditiveBlending, pointSizeFactor: 260 * PX });
  crt.uniforms.uTime.value = shot.time;
  const swirlPts = new Points(cloudGeometry(swirl), crt);
  swirlPts.frustumCulled = false;
  scene.add(swirlPts);
  scene.add(glow(swirlCenter, 0.9, hexToRgb(SWIRL_GOLD), 0.2));
}

// ── 2. Pebbles ────────────────────────────────────────────────────────────
// The three paths: a cluster of each pebble type floating in its own part of
// the sky — soul's translucent wiggly islands, organic's dithered rocks, and
// gas's additive red puffs — with the newly formed comet in the foreground.
async function buildPebbles(scene: Scene, camera: PerspectiveCamera, renderer: WebGLRenderer, PX: number): Promise<void> {
  backdrop(scene, camera, PX, [0.55, 0.55, 0.6]);

  const clusters: { type: 0 | 1 | 2; ndc: [number, number]; dist: number; count: number }[] = [
    { type: 0, ndc: [-0.58, 0.28], dist: 1.25, count: 60 },
    { type: 1, ndc: [0.02, 0.42], dist: 1.45, count: 80 },
    { type: 2, ndc: [0.6, 0.22], dist: 1.25, count: 70 },
  ];
  const islands = (await loadFbxMeshesByName(PEBBLE_ISLAND_MESH_URL, PEBBLE_ISLAND_MESH_NAMES)).filter(
    (g): g is BufferGeometry => g !== null,
  );
  const m = new Matrix4();
  const q = new Quaternion();
  const s = new Vector3();
  const p = new Vector3();

  for (const cl of clusters) {
    const center = at(camera, cl.ndc[0], cl.ndc[1], cl.dist);
    const spot = (): Vector3 => {
      // Denser toward the middle, like a group's cone seen end-on.
      const r = 0.26 * Math.pow(Math.random(), 0.6);
      return p.copy(randomUnit()).multiply(new Vector3(1.2, 0.8, 1)).multiplyScalar(r).add(center);
    };
    scene.add(glow(center, 1.0, TYPE_COLORS[cl.type], 0.16));

    if (cl.type === 1) {
      for (let v = 0; v < 6; v++) {
        const count = Math.ceil(cl.count / 6);
        const geo = buildOrganicGeometry({ icoDetail: 3 });
        addInstanceAttrs(geo, count, (k, tint) => {
          const c = ORGANIC_PALETTE[Math.floor(Math.random() * ORGANIC_PALETTE.length)];
          tint.setXYZ(k, c[0], c[1], c[2]);
        }, 1);
        const mesh = new InstancedMesh(geo, kOrganicRockMat, count);
        for (let k = 0; k < count; k++) {
          const big = Math.random() < 0.15 ? 2 : 1;
          m.compose(spot(), randomRot(q), s.setScalar((0.008 + Math.random() * 0.01) * big));
          mesh.setMatrixAt(k, m);
        }
        mesh.frustumCulled = false;
        scene.add(mesh);
      }
    } else if (cl.type === 0) {
      const mat = makeToonRimInstancedWigglyMaterial(SOUL_ISLAND_PALETTE, { amplitude: 0.19, opacity: 0.55 });
      mat.uniforms.uTime.value = shot.time;
      const geos = islands.length ? islands : [buildOrganicGeometry({ icoDetail: 3 })];
      geos.forEach((island) => {
        const count = Math.ceil(cl.count / geos.length);
        const geo = island.clone();
        addInstanceAttrs(geo, count, () => {}, 0);
        geo.setAttribute('aWigglePhase', new InstancedBufferAttribute(new Float32Array(count).map(() => Math.random()), 1));
        const mesh = new InstancedMesh(geo, mat, count);
        for (let k = 0; k < count; k++) {
          m.compose(spot(), randomRot(q), s.setScalar(0.014 + Math.random() * 0.014));
          mesh.setMatrixAt(k, m);
        }
        mesh.frustumCulled = false;
        mesh.renderOrder = 2;
        scene.add(mesh);
      });
    } else {
      const puffs = cloud();
      for (let k = 0; k < cl.count; k++) {
        const base = spot().clone();
        const size = 0.012 + Math.random() * 0.012;
        for (let j = 0; j < 5; j++) {
          const d = randomUnit().multiplyScalar(size * 1.3 * Math.random());
          puffs.positions.push(base.x + d.x, base.y + d.y, base.z + d.z);
          puffs.sizes.push(size * 16 * 0.5 * (0.6 + Math.random() * 0.6));
          puffs.bright.push((0.4 + Math.random() * 0.6) * 0.5);
          puffs.phases.push(0);
        }
      }
      scene.add(haze(puffs, GAS_CLOUD_COLOR, PX, 3));
    }
  }

  // The comet in front, tail sweeping toward the clusters it's gathering.
  for (const c of cometsOf()) await addComet(scene, camera, renderer, c, PX);
}

// ── 3. Seeding ────────────────────────────────────────────────────────────
// The grown planet: every seeded cell bloomed into a plant (organic's
// desert-vs-flowers hemisphere split), the six moons on their tilted rings,
// and a last few stardust motes falling onto the surface.
async function buildSeeding(scene: Scene, camera: PerspectiveCamera, PX: number): Promise<void> {
  backdrop(scene, camera, PX, TYPE_COLORS[1]);
  const R = 0.11;
  const center = at(camera, 0.0, -0.02, 0.62);
  scene.add(glow(center.clone().multiplyScalar(1.15), 0.9, TYPE_COLORS[1], 0.22));

  const { mesh: planet, colors } = buildPlanet();
  planet.position.copy(center);
  planet.scale.setScalar(R);
  // Tip the planet so the camera sees its upper hemisphere and both halves of
  // the split (desert +X / flowers -X).
  planet.quaternion.setFromEuler(new Euler(0.5, -0.25, 0.1));
  scene.add(planet);
  await addPlants(planet, colors, (0.02 / R) * 0.8 * 2.5, 'split');

  // Moons — PlanetSeedingSystem's 3 tilted rings x 2.
  const moonMat = makeToonRimFlatMaterial(hexToRgb(MOON));
  const radii = [0.22, 0.3, 0.38];
  const tilts = [-35, 0, 35];
  const viewTilt = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 1.25);
  for (let ring = 0; ring < 3; ring++) {
    const tq = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), (tilts[ring] * Math.PI) / 180).premultiply(viewTilt);
    for (let k = 0; k < 2; k++) {
      const a = k * Math.PI + ring * 1.3 + 1.5;
      const moon = new Mesh(buildOrganicGeometry(), moonMat);
      moon.scale.setScalar(0.035);
      moon.position.set(Math.cos(a) * radii[ring], 0, Math.sin(a) * radii[ring]).applyQuaternion(tq).add(center);
      scene.add(moon);
    }
  }

  // Stardust falling in toward the surface.
  const dust = cloud();
  for (let i = 0; i < 26; i++) {
    const dir = randomUnit();
    if (dir.z < -0.2) dir.z = -dir.z;
    const d = R * (1.15 + Math.pow(Math.random(), 1.5) * 2.2);
    const v = center.clone().addScaledVector(dir, d);
    dust.positions.push(v.x, v.y, v.z);
    dust.sizes.push(0.05 + Math.random() * 0.04);
    dust.bright.push(0.6 + Math.random() * 0.4);
    dust.phases.push(Math.random());
  }
  scene.add(sparkles(dust, STARDUST_RGB, PX));
}

// ── 4. Fate Events (gas) ──────────────────────────────────────────────────
// Close over the zoomed-in planet's crowd cap on a volatile-gasses run: the
// crowned King at the center, his angry / grieving cast gathered around him
// in two rings (each a gold-rimmed "named" figure with its flourish marker
// floating overhead), desert plants beyond, the gas comet glowing above.
async function buildFate(scene: Scene, camera: PerspectiveCamera, renderer: WebGLRenderer, PX: number): Promise<void> {
  // FateEventSystem's planet, in head-relative space (head ~1.6m up).
  const R = 1.4;
  const center = new Vector3(0, -0.45 - 1.6, -1.15);
  const cap = new Vector3(0, 0.95, 0.2).normalize();
  const capPoint = center.clone().addScaledVector(cap, R);
  // Low over the surface, looking across the cap so the figures stand
  // against the sky.
  camera.position.copy(capPoint).add(new Vector3(0, 0.45, 1.55));
  camera.lookAt(capPoint.x, capPoint.y + 0.2, capPoint.z);
  camera.updateMatrixWorld();
  backdrop(scene, camera, PX, TYPE_COLORS[2]);

  const capAngle = (d: Vector3) => d.angleTo(cap);
  // The game fades stains/plants out under the whole crowd; kept tighter
  // here so the ground around them still reads as a living planet.
  const plantSkip = (d: Vector3) => capAngle(d) < (26 * Math.PI) / 180;
  const { mesh: planet, colors } = buildPlanet((d) => capAngle(d) < (9 * Math.PI) / 180);
  planet.position.copy(center);
  planet.scale.setScalar(R);
  scene.add(planet);
  // Gas commits the whole grid to the desert pack (planet-growth-pool.ts).
  await addPlants(planet, colors, ((0.02 / 0.11) * 0.8 * 2.5 * 0.11) / R * 2.2, 'desert', plantSkip);

  // The cap's tangent frame — `fwdT` points toward the camera along the
  // surface, `sideT` across.
  const toCam = camera.position.clone().sub(capPoint);
  const fwdT = toCam.addScaledVector(cap, -toCam.dot(cap)).normalize();
  const sideT = new Vector3().crossVectors(cap, fwdT).normalize();
  const dirAt = (angle: number, around: number): Vector3 => {
    const tangent = fwdT.clone().multiplyScalar(Math.cos(around)).addScaledVector(sideT, Math.sin(around));
    return cap.clone().multiplyScalar(Math.cos(angle)).addScaledVector(tangent, Math.sin(angle)).normalize();
  };

  const template = await loadAnimatedPersonTemplate();
  if (!template) throw new Error('BreathingIdle rig failed to load');
  const poses = await Promise.all(
    ['/medium/AngryGesture.fbx', '/medium/Angry.fbx', '/medium/AngryPoint.fbx', '/medium/SittingDisbelief.fbx'].map(loadPersonClip),
  );
  const markerGeo = (await loadFbxAllMeshes('/medium/flourish.fbx', 1, centerAndNormalizeGeometryToUnitSize))[0] ?? null;
  const namedRim = hexToRgb(NAMED_RIM);
  const kingPos = capPoint.clone();
  const mixers: AnimationMixer[] = [];

  // King, crowned, facing the camera.
  const king = buildAnimatedPerson(template, makeToonRimSkinnedMaterial(PERSON_BODY_COLOR), PERSON_HEIGHT);
  standOnSphere(king.group, center, R, cap, camera.position);
  king.attachHeadProp(buildKingCrownProp());
  scene.add(king.group);
  mixers.push(king.mixer);

  // Two staggered rows around him (THRONE_FRONT/BACK_ARC_ANGLE), the near
  // side left open so the King reads.
  const ring: [number, number, number][] = [
    [22, 1.45, 0], [22, -1.45, 1], [22, 2.6, 3], [22, -2.6, 2],
    [36, 0.95, 3], [36, -0.95, 0], [38, 2.05, 1], [38, -2.05, 2], [40, 3.14, 0],
  ];
  for (const [deg, around, pose] of ring) {
    const dir = dirAt(((deg * Math.PI) / 180) * 0.55, around);
    const person = buildAnimatedPerson(template, makeToonRimSkinnedMaterial(PERSON_BODY_COLOR, namedRim), PERSON_HEIGHT);
    // Face the King, some turned a little toward the player.
    const look = kingPos.clone().lerp(camera.position, Math.random() * 0.35);
    standOnSphere(person.group, center, R, dir, look);
    const clip = poses[pose];
    if (clip) {
      person.idleAction.stop();
      const action = person.mixer.clipAction(clip);
      action.play();
      action.time = Math.random() * clip.duration;
    }
    scene.add(person.group);
    mixers.push(person.mixer);

    if (markerGeo) {
      const marker = new Mesh(markerGeo, makeToonRimFlatMaterial(PERSON_BODY_COLOR, namedRim));
      marker.scale.setScalar(0.14 * (2 / 3));
      marker.position.copy(person.group.position).addScaledVector(dir, PERSON_HEIGHT * 1.35);
      marker.lookAt(camera.position);
      scene.add(marker);
    }
  }
  for (const mixer of mixers) mixer.update(0);

  // The gas comet hanging overhead, tail trailing off behind the planet.
  const [c] = cometsOf();
  // Comet helpers assume an origin camera — render it in a camera-local group.
  const local = new Scene();
  const localCam = camera.clone();
  localCam.position.set(0, 0, 0);
  localCam.quaternion.identity();
  localCam.updateMatrixWorld();
  await addComet(local, localCam, renderer, c, PX);
  const holder = new Group();
  holder.position.copy(camera.position);
  holder.quaternion.copy(camera.quaternion);
  while (local.children.length) holder.add(local.children[0]);
  scene.add(holder);
}

// ── 5. Launch ─────────────────────────────────────────────────────────────
// The choice: Orbit (blue wireframe zone, beside the now-small home planet)
// or The Great Unknown (purple wireframe zone holding its drifting nebula),
// each labeled the way the game labels them, with the comet between them.
async function buildLaunch(scene: Scene, camera: PerspectiveCamera, renderer: WebGLRenderer, PX: number): Promise<void> {
  backdrop(scene, camera, PX, hexToRgb(UNKNOWN));
  await fontReady.catch(() => {});

  const ZONE_RADIUS = 0.35;
  const orbitC = at(camera, -0.5, 0.12, 1.75);
  const unknownC = at(camera, 0.5, 0.12, 1.75);

  // Home planet, receded and shrunk beside the Orbit zone (Leg C).
  const { mesh: planet, colors } = buildPlanet();
  const planetPos = orbitC.clone().add(new Vector3(-0.05, -0.02, 0.02));
  planet.position.copy(planetPos);
  planet.scale.setScalar(0.16);
  planet.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), 0.4);
  scene.add(planet);
  await addPlants(planet, colors, (0.02 / 0.11) * 0.8 * 2.5, 'desert');

  const nebula = nebulaCloud(hexToRgb(UNKNOWN), PX);
  nebula.position.copy(unknownC);
  scene.add(nebula);
  scene.add(glow(unknownC, 1.4, hexToRgb(UNKNOWN), 0.22));
  scene.add(glow(orbitC, 1.4, hexToRgb(ORBIT), 0.16));

  for (const [c, color, text] of [
    [orbitC, ORBIT, 'Orbit'],
    [unknownC, UNKNOWN, 'The Great Unknown'],
  ] as const) {
    const zone = new Mesh(
      new SphereGeometry(ZONE_RADIUS, 16, 12),
      new MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.55 }),
    );
    zone.position.copy(c);
    zone.rotation.set(0.25, 0.4, 0);
    scene.add(zone);
    const label = new Mesh(
      // Same card as OrbitalLaunchVfxSystem's (LABEL_WIDTH_SCALE 1.4), shown 1.35x.
      new PlaneGeometry(0.42 * 1.4 * 1.35, 0.15 * 1.35),
      new MeshBasicMaterial({ map: drawLabel(text, 0, 1.4), transparent: true, depthWrite: false, side: DoubleSide }),
    );
    label.position.set(c.x, c.y + ZONE_RADIUS + 0.17, c.z);
    label.quaternion.copy(camera.quaternion);
    scene.add(label);
  }

  for (const c of cometsOf()) await addComet(scene, camera, renderer, c, PX);
}

// ── 6. Fly away ───────────────────────────────────────────────────────────
// Released: the comet heads off into the unknown, glancing back, its tail
// streaming toward us past the home planet it leaves behind.
async function buildFlyaway(scene: Scene, camera: PerspectiveCamera, renderer: WebGLRenderer, PX: number): Promise<void> {
  backdrop(scene, camera, PX, TYPE_COLORS[shot.face]);

  const { mesh: planet, colors } = buildPlanet();
  const planetPos = at(camera, -0.68, -0.62, 1.3);
  planet.position.copy(planetPos);
  planet.scale.setScalar(0.15);
  planet.quaternion.setFromAxisAngle(new Vector3(1, 0.3, 0).normalize(), 0.55);
  scene.add(planet);
  scene.add(glow(planetPos.clone().multiplyScalar(1.1), 0.9, TYPE_COLORS[1], 0.12));
  await addPlants(planet, colors, (0.02 / 0.11) * 0.8 * 2.5, 'split');

  // Purple nebula far off where it's headed.
  const far = nebulaCloud(hexToRgb(UNKNOWN), PX);
  far.position.copy(at(camera, 0.5, 0.42, 6));
  far.scale.setScalar(4);
  scene.add(far);
  scene.add(glow(far.position, 6, hexToRgb(UNKNOWN), 0.18));

  await addComet(scene, camera, renderer, shot, PX);
}
