import { BufferGeometry, Entity, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, Vector3, World } from '@iwsdk/core';
import { buildOrganicGeometry } from '../../vfx/geometry/organic-rock-geometry.js';
import {
  convertZUpToYUp,
  loadFbxAllMeshes,
  normalizeGeometryToUnitRadiusFromOrigin,
} from '../../vfx/geometry/fbx-field-loader.js';
import { makeToonRimInstancedDitherMaterial } from '../../vfx/shaders/toon-rim-material.js';
import { hexToRgb, ORGANIC_GLITTER_DARK, ORGANIC_GLITTER_LIGHT, ORGANIC_PALETTE, WHITE } from '../../vfx/color/color-scheme.js';
import { N_PLANETS, PLANET_RADIUS } from './planet-seeding-system.js';

// Bumped from 6, then 10x'd again to 100 for a visibly dense, fully-covered
// planet rather than a sparse handful of sprouts — trySpawn's hemisphere
// split below still gives both art-style halves their own even share of
// this larger pool.
const PER_PLANET_CAP = 100;
const POOL_SIZE = N_PLANETS * PER_PLANET_CAP;

// Art-style comparison: two real plant packs, one per planet hemisphere
// (split on each slot's own fixed direction — see fibonacciSphereDir and
// _slotIsFlower) — desertPlantsClean.fbx on the +X half, flowers.fbx on the
// -X half, so seeding either side during play grows that half's own style,
// side by side with the other for a direct look. Both load independently
// and fall back to the placeholder rock (see build()) until they resolve,
// same graceful-degradation idiom fbx-field-loader.ts's own callers already
// use. If one style loses, reverting to a single pack is just deleting its
// URL/MAX_COUNT consts + build()'s _slotIsFlower assignment.
//
// Replaces the original desertPlants.fbx (which wrapped its plants in a
// 'Layer_1' group and needed recenterAndGroundGeometry's bounding-box
// guesswork) with a re-exported pack whose 9 plants are direct children of
// the file's own root, each with its own origin re-placed at its base and
// rotation fixed in Blender before export — same "trust the authored
// origin" treatment as the flowers pack below, and now both packs share the
// same normalizeGeometryToUnitRadiusFromOrigin convention, so no per-pack
// size-compensation knob is needed between them anymore (see this file's
// old FLOWERS_SCALE_COMPENSATION, now removed). Verified by directly parsing
// the file: cactusTall/cactusTall2/cactusCreep/cactusLarge/plantSwirl all
// land within ~1.3% of true base-grounding after convertZUpToYUp; cactusBlob/
// cactusBlob2/cactusBlob3/plantSwirl2 sit somewhat higher (6-17% of their own
// height above their lowest vertex) — worth another origin pass in Blender
// for those four if they read as floating in headset, but not egregious
// enough to fall back to bounding-box regrounding for the whole pack.
const DESERT_PLANTS_URL = '/medium/desertPlantsClean.fbx';
const DESERT_PLANTS_MAX_COUNT = 9;
// This pack's own origin is deliberately placed at each plant's BASE —
// verified by directly parsing it: all 4 meshes ('cactus'/'sunflower'/
// 'flower'/'grass' — 'Layer_2' was renamed to 'sunflower') sit with local
// (0,0,0) at 0.6-1.1% of their own height above their lowest vertex, i.e.
// right on the sole. That's what lets this pack skip recenterAndGround
// Geometry's bounding-box guesswork entirely and trust the authored origin
// instead (see build()).
//
// The file also carries Blender's default 'Camera' and 'Light' nodes. Both
// are harmless here — loadFbxAllMeshes only collects Mesh nodes — but they
// do mean the export wasn't limited to just the plants.
const FLOWERS_URL = '/medium/flowersOriginAtBottom.fbx';
const FLOWERS_MAX_COUNT = 4;

// buildOrganicGeometry()'s unit-radius rock, scaled down to a small
// sprouting mound on Seeding's PLANET_RADIUS=0.11 planet (~0.03m diameter) —
// not person-shaped (see this class's own comment: no people during
// Seeding, that reveal now happens later — see FateEventVfxSystem's
// spin-driven civilization forming). Sprouts are parented under the
// planet's own (already PLANET_RADIUS-scaled) mesh entity — three.js
// compounds a child's local scale/position with its parent's, so both this
// target size and trySpawn's position below are pre-divided by PLANET_RADIUS
// to cancel that compounding back out to the intended absolute world size.
// Bumped 1.6x from the old rock-tuned size, then halved back down to 0.8x —
// the 1.6x size read as too large once seen in headset.
const GROWTH_TARGET_SCALE = (0.02 / PLANET_RADIUS) * 0.8;
// Second growth stage, same "starts small during Seeding, blooms bigger
// during the Seeding->Constellations spin" beat as the planet's own splats/
// moons (see planet-stain-material.ts's uFinalGrowT) — update() now
// interpolates every already-spawned sprout's target between these two
// based on live spin progress, instead of settling once at GROWTH_TARGET_
// SCALE and staying there forever.
const GROWTH_FINAL_SCALE = GROWTH_TARGET_SCALE * 2.5;
const GROWTH_EASE_RATE = 2.0; // 1/s exponential ease, same idiom as _easeCoverage

// Local-space push straight out along the landing normal, on top of sitting
// exactly on the unit sphere. Now that the planet mesh itself is a perfect
// sphere (see planet-seeding-vfx-system.ts's _buildPlanet — ampMin/ampMax
// forced to 0), this only needs to be just barely past 1.0 to avoid z-
// fighting with the surface; it used to carry a much larger 1.5% margin as a
// safety buffer against that mesh's old sine-sum bump displacement, which
// could dip a given direction well below radius 1 and reclip a grounded
// plant back into the (then-lumpy) surface.
const SURFACE_LIFT = 1.002;

// PLANT_DITHER_MAT (below) is an INSTANCED shader — its vertex stage reads
// the built-in `instanceMatrix` attribute, which three.js only ever provides
// on an actual InstancedMesh, never a plain Mesh. Each sprout therefore gets
// its own single-instance (count=1) InstancedMesh rather than a plain Mesh —
// the parent Group still carries the sprout's real position/scale/rotation
// exactly as before, so the instance's own matrix is just a fixed identity,
// set once and left alone.
const SPROUT_BRIGHT = 0.7; // same base brightness OrganicScene's own instances use
// Same fixed 5-color set every other production organic surface draws from
// (see color-scheme.ts's ORGANIC_PALETTE) — each sprout picks one entry at
// random in setInstanceAttrs, instead of every plant sharing one flat green.
const PLANT_PALETTE = ORGANIC_PALETTE;

// Dedicated "shaded dither toon" material for growth-pool sprouts only — a
// visually distinct look from kOrganicGlitterMat's grainy/glitter sparkle
// (see pebble-material.ts), which stays exactly as-is for pebbles/comet/
// seeding dust. bodyColorDark/Light below are effectively decorative only:
// every sprout instance sets aTinted=1 (see setInstanceAttrs), so the
// fragment shader's own tint mix always resolves to the instance's aTint
// color regardless of these two values — kept dark to match the previous
// organic look's near-black undertone in case aTinted is ever dialed back.
const PLANT_DITHER_MAT = makeToonRimInstancedDitherMaterial({
  bodyColorDark: hexToRgb(ORGANIC_GLITTER_DARK),
  bodyColorLight: hexToRgb(ORGANIC_GLITTER_LIGHT),
  rimColor: hexToRgb(WHITE),
});

// Stamps the three per-instance attributes PLANT_DITHER_MAT requires onto a
// single-instance geometry. Needed on the initial placeholder rock AND again
// on every real plant geometry once swapped in (a fresh clone from
// loadFbxNamedGroupChildMeshes has no instance attributes of its own yet).
// Picks a fresh random palette color each call, so a slot's placeholder rock
// and its eventual real plant mesh don't have to match — no visible harm
// either way since the swap already replaces the whole geometry.
function setInstanceAttrs(geo: BufferGeometry): void {
  const [r, g, b] = PLANT_PALETTE[Math.floor(Math.random() * PLANT_PALETTE.length)];
  geo.setAttribute('aBright', new InstancedBufferAttribute(new Float32Array([SPROUT_BRIGHT]), 1));
  geo.setAttribute('aTint', new InstancedBufferAttribute(new Float32Array([r, g, b]), 3));
  geo.setAttribute('aTinted', new InstancedBufferAttribute(new Float32Array([1]), 1));
}

// Both plant packs were authored Z-up — confirmed by directly parsing both
// files with FBXLoader and checking bounding boxes: every single mesh's own
// Y extent is the thinnest of its three axes, Z consistently the tallest.
// convertZUpToYUp itself now lives in fbx-field-loader.ts (shared with
// fate-event-vfx-system.ts's blobpeople.fbx, authored the same way) — see its
// own comment there. Without this, each plant's short/thin axis pointed
// outward instead of its tall one — planted "sideways" relative to the
// surface, which is why they weren't reading as attached to the ground even
// once grounded on the (wrong) axis.

// Even 360° coverage guarantee: rather than only growing wherever stardust
// actually happened to land (which could leave most of the planet bare
// depending on how/where the player moved their hand), each pool slot gets
// its own FIXED, evenly-distributed direction around the whole sphere
// (poles included) via the standard Fibonacci-sphere lattice — trySpawn()
// just activates the next slot in this pre-planned layout (see build()),
// still triggered by real landing events so growth still tracks how much
// the player has actually seeded, but no longer placed at the exact spot
// that triggered it.
function fibonacciSphereDir(index: number, count: number): Vector3 {
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const y = count > 1 ? 1 - (index / (count - 1)) * 2 : 0; // 1 -> -1 pole to pole
  const radiusAtY = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = goldenAngle * index;
  return new Vector3(Math.cos(theta) * radiusAtY, y, Math.sin(theta) * radiusAtY);
}

// Seeding's own "cause life to grow" flourish — no longer Organic-only
// (the bees in earth-situations-vfx-system.ts are the one thing still
// unique to that class): every landing, regardless of dominant type,
// activates the next slot in a fixed, evenly-distributed layout around the
// WHOLE planet (see fibonacciSphereDir), capped per planet (an
// "established little colony," not unbounded clutter at this tiny scale),
// permanent — riding along with the planet through Constellations/Fate
// Events/Launch, not reset or hidden once Seeding ends (see
// PlanetSeedingVfxSystem.startSpinTransition's own comment). Deliberately
// NOT person-shaped — Seeding shouldn't show people; the actual
// Fate Events civilization only starts forming later, during the
// Seeding->Constellations spin transition (see FateEventVfxSystem). Not a
// System — a plain pooled-effect class driven by explicit
// trySpawn()/update()/reset() calls from PlanetSeedingVfxSystem, same idiom
// as HeartBurstPool. Fixed slots (planet*PER_PLANET_CAP + localIndex), no
// free-list needed: a planet's count only ever grows within a single
// Seeding attempt, and reset() zeroes every planet's count together on a
// fresh loop.
export class PlanetGrowthPool {
  private _groups: Group[] = [];
  private _meshes: InstancedMesh[] = [];
  private _scale = new Float32Array(POOL_SIZE);
  // 1 once trySpawn() has actually claimed a slot — distinct from _scale
  // reaching 0, since a spawned-but-not-yet-eased-up sprout also has scale
  // 0 for a moment. update() only advances slots this is set for.
  private _spawned = new Uint8Array(POOL_SIZE);
  private _countPerPlanet = new Uint8Array(N_PLANETS);

  // Populated once each pack's own load resolves — empty until then, in
  // which case trySpawn() just leaves that slot on its rock placeholder.
  private _desertGeos: BufferGeometry[] = [];
  private _flowerGeos: BufferGeometry[] = [];
  // Round-robin cursor per pack so consecutive spawns on the same
  // hemisphere cycle through all its species rather than repeating one.
  private _desertNext = 0;
  private _flowerNext = 0;
  // Per-slot fixed direction/style — see fibonacciSphereDir's own comment.
  // Index-aligned with _groups/_meshes.
  private _slotDir: Vector3[] = [];
  private _slotIsFlower: boolean[] = [];

  private _upAxis = new Vector3(0, 1, 0);
  private _identity = new Matrix4();

  // parentEntity is the planet's own transform entity (see
  // PlanetSeedingVfxSystem's _planetEntity) — sprouts are parented under it
  // (not the world root) so they inherit the planet's live position for
  // free as it eases around following the player's head, rather than each
  // needing its own per-frame re-derivation from a stale spawn-time
  // snapshot. positions set below are therefore LOCAL to the planet, not
  // world-absolute.
  build(world: World, parentEntity: Entity): void {
    for (let planet = 0; planet < N_PLANETS; planet++) {
      for (let local = 0; local < PER_PLANET_CAP; local++) {
        const group = new Group();
        const geo = buildOrganicGeometry();
        setInstanceAttrs(geo);
        const mesh = new InstancedMesh(geo, PLANT_DITHER_MAT, 1);
        mesh.setMatrixAt(0, this._identity);
        mesh.instanceMatrix.needsUpdate = true;
        mesh.frustumCulled = false;
        group.add(mesh);
        group.name = `growth-sprout-${planet}-${local}`;
        group.scale.setScalar(0);
        group.visible = false;
        this._groups.push(group);
        this._meshes.push(mesh);
        const dir = fibonacciSphereDir(local, PER_PLANET_CAP);
        this._slotDir.push(dir);
        this._slotIsFlower.push(dir.x < 0);
        world.createTransformEntity(group, parentEntity);
      }
    }

    // Both packs now trust their own authored origin instead of re-deriving
    // a ground point from the bounding box: normalizeGeometryToUnitRadius
    // FromOrigin scales AROUND local (0,0,0) and leaves it exactly where the
    // artist put it. convertZUpToYUp is still needed for both (verified: Z
    // is the tallest axis on every mesh in each pack, same as every other
    // FBX in the project).
    loadFbxAllMeshes(DESERT_PLANTS_URL, DESERT_PLANTS_MAX_COUNT, normalizeGeometryToUnitRadiusFromOrigin).then(
      (geos) => {
        for (const geo of geos) convertZUpToYUp(geo);
        this._desertGeos = geos;
      },
    );
    loadFbxAllMeshes(FLOWERS_URL, FLOWERS_MAX_COUNT, normalizeGeometryToUnitRadiusFromOrigin).then((geos) => {
      for (const geo of geos) convertZUpToYUp(geo);
      this._flowerGeos = geos;
    });
  }

  // dirX/dirY/dirZ from the actual landing are no longer used for
  // placement (see fibonacciSphereDir's own comment on why) — only the
  // landing EVENT matters here, to decide whether another slot activates.
  trySpawn(planet: number): boolean {
    const localIndex = this._countPerPlanet[planet];
    if (localIndex >= PER_PLANET_CAP) return false;
    this._countPerPlanet[planet] = localIndex + 1;

    const slot = planet * PER_PLANET_CAP + localIndex;
    const group = this._groups[slot];
    const dir = this._slotDir[slot];
    // Unit-direction local offset (NOT multiplied by PLANET_RADIUS) — the
    // parent mesh's own PLANET_RADIUS scale already stretches this out to
    // sit exactly on the surface; multiplying here too would compound and
    // land it deep inside the planet instead. SURFACE_LIFT nudges it out a
    // little further still — see its own comment.
    group.position.set(dir.x * SURFACE_LIFT, dir.y * SURFACE_LIFT, dir.z * SURFACE_LIFT);
    group.quaternion.setFromUnitVectors(this._upAxis, dir);
    group.visible = true;
    this._scale[slot] = 0;
    this._spawned[slot] = 1;

    // Hemisphere split for the art-style comparison — see this file's own
    // top comment. Whichever pack has actually resolved by the time this
    // particular slot activates supplies the mesh; each slot gets its own
    // clone (never the cache's shared instance directly) since
    // PLANT_DITHER_MAT's per-instance attributes live ON the geometry —
    // two InstancedMeshes sharing one geometry object would also share
    // (and clobber) each other's aTint/aBright/aTinted.
    const useFlowers = this._slotIsFlower[slot];
    const pack = useFlowers ? this._flowerGeos : this._desertGeos;
    if (pack.length > 0) {
      const idx = useFlowers ? this._flowerNext++ : this._desertNext++;
      const geo = pack[idx % pack.length].clone();
      setInstanceAttrs(geo);
      this._meshes[slot].geometry = geo;
    }
    return true;
  }

  // spinProgress is PlanetSpinTransition.getProgress() (0 through Seeding,
  // ramping 0->1 across the Seeding->Constellations spin, holding 1 after)
  // — every already-spawned sprout's target scale rides that same curve
  // from GROWTH_TARGET_SCALE up to GROWTH_FINAL_SCALE, so sprouts planted
  // during Seeding visibly bloom bigger exactly during the spin, the same
  // beat the planet's own splats/moons already get.
  update(delta: number, spinProgress: number): void {
    const pull = 1 - Math.exp(-GROWTH_EASE_RATE * delta);
    const target = GROWTH_TARGET_SCALE + (GROWTH_FINAL_SCALE - GROWTH_TARGET_SCALE) * spinProgress;
    for (let i = 0; i < POOL_SIZE; i++) {
      if (!this._spawned[i] || this._scale[i] === target) continue;
      this._scale[i] += (target - this._scale[i]) * pull;
      this._groups[i].scale.setScalar(this._scale[i]);
    }
  }

  reset(): void {
    for (let i = 0; i < POOL_SIZE; i++) {
      this._groups[i].visible = false;
      this._groups[i].scale.setScalar(0);
      this._scale[i] = 0;
    }
    this._spawned.fill(0);
    this._countPerPlanet.fill(0);
    this._desertNext = 0;
    this._flowerNext = 0;
  }
}
