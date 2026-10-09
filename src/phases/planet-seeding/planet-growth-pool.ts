import {
  BufferGeometry,
  DynamicDrawUsage,
  Entity,
  InstancedBufferAttribute,
  InstancedMesh,
  Quaternion,
  Vector3,
  World,
} from '@iwsdk/core';
import {
  convertZUpToYUp,
  loadFbxAllMeshes,
  normalizeGeometryToUnitRadiusFromOrigin,
} from '../../vfx/geometry/fbx-field-loader.js';
import { writeInstanceTRS } from '../../vfx/geometry/mesh-utils.js';
import { makeToonRimInstancedDitherMaterial } from '../../vfx/shaders/toon-rim-material.js';
import { hexToRgb, ORGANIC_GLITTER_DARK, ORGANIC_GLITTER_LIGHT, ORGANIC_PALETTE, WHITE } from '../../vfx/color/color-scheme.js';
import { MAX_SPLATS } from '../../vfx/shaders/planet-stain-material.js';
import { CELL_DIRS, PLANET_RADIUS } from './planet-seeding-system.js';

// One slot per grid cell (see planet-seeding-system.ts's CELL_DIRS) — a
// plant only ever grows exactly where its cell was colored during Seeding,
// so the pool is sized/positioned off that same fixed layout rather than an
// independent one. With only ever one planet, there's no per-planet
// indexing to do (see planet-seeding-system.ts's own N_PLANETS comment for
// why other files in this phase still carry that indirection — this one no
// longer needs to).
const POOL_SIZE = MAX_SPLATS;

// Two real plant packs. Which one(s) a given cell draws from depends on the
// playthrough's dominant pebble type (see activate()'s own `dominant`
// param): Organic keeps the original art-style comparison, split by
// hemisphere (each slot's own fixed CELL_DIRS direction — see
// _slotIsFlower) — desertPlantsClean.fbx on the +X half, flowers.fbx on the
// -X half, so filling in either side during play eventually blooms that
// half's own style, side by side with the other for a direct look. Soul
// commits the WHOLE grid to flowers.fbx only, and Gas the whole grid to
// desertPlantsClean.fbx only — no hemisphere split for either. Both packs
// still load unconditionally and independently, falling back to the
// placeholder rock (see build()) until they resolve, same graceful-
// degradation idiom fbx-field-loader.ts's own callers already use.
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

// Same 0=soul/1=organic/2=gas ordering as pebble-type.ts's PEBBLE_TYPES —
// each consuming file in this codebase keeps its own local copy of these
// (see fate-event-system.ts/fate-event-vfx-system.ts/earth-situations-vfx-
// system.ts) rather than a shared import, and this file follows the same
// convention. Only activate() below reads these.
const SOUL_DUST_TYPE = 0;
const VOLATILE_GASSES_TYPE = 2;

// buildOrganicGeometry()'s unit-radius rock, scaled down to a small
// sprouting mound on Seeding's PLANET_RADIUS=0.11 planet (~0.03m diameter) —
// not person-shaped (see this class's own comment: no people during
// Seeding, that reveal now happens later — see FateEventVfxSystem's
// spin-driven civilization forming). Sprouts are parented under the
// planet's own (already PLANET_RADIUS-scaled) mesh entity — three.js
// compounds a child's local scale/position with its parent's, so both this
// target size and activate()'s position below are pre-divided by
// PLANET_RADIUS to cancel that compounding back out to the intended
// absolute world size.
// Bumped 1.6x from the old rock-tuned size, then halved back down to 0.8x —
// the 1.6x size read as too large once seen in headset. Now also the size a
// plant POPS IN AT the instant its cell activates (see activate()), not an
// already-grown "small during Seeding" stage — plants no longer exist at
// all until Leg A begins.
const GROWTH_TARGET_SCALE = (0.02 / PLANET_RADIUS) * 0.8;
// Mature size, reached by the time Leg A's spin finishes — update() eases
// every activated slot's scale from GROWTH_TARGET_SCALE up to this across
// the live spin progress (see PlanetSpinTransition), the same "many years
// later" beat the planet's own splats/moons get (see planet-stain-
// material.ts's uFinalGrowT).
const GROWTH_FINAL_SCALE = GROWTH_TARGET_SCALE * 2.5;
// Slowed from 2.0 — at that rate scale caught up to grownTarget's slow
// 11s ramp almost instantly every frame, so the pop-in to GROWTH_TARGET_SCALE
// read as a quick snap rather than a plant actually growing.
const GROWTH_EASE_RATE = 0.5; // 1/s exponential ease, same idiom as _easeCoverage

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
// the built-in `instanceMatrix` attribute plus per-instance aBright/aTint/
// aTinted. Every plant of one species therefore shares ONE InstancedMesh (see
// PlantBucket) — one draw call per species instead of one per grid cell —
// with each cell's own position/orientation/growth scale baked into its
// instance matrix each frame (see PlanetGrowthPool.update) and its own color
// in aTint.
const SPROUT_BRIGHT = 0.7; // same base brightness OrganicScene's own instances use
// Same fixed 5-color set every other production organic surface draws from
// (see color-scheme.ts's ORGANIC_PALETTE) — setPlantInstanceAttrs picks one
// entry at random for callers that don't care which plant matches which
// cell (e.g. fate-events/seed-blossom.ts); this file's own activate() below
// instead uses the EXACT color PlanetSeedingSystem already rolled for that
// cell (see stampPlantAttrs), so a grown plant always matches its splat.
const PLANT_PALETTE = ORGANIC_PALETTE;

// Dedicated "shaded dither toon" material for growth-pool sprouts only — a
// visually distinct look from kOrganicGlitterMat's grainy/glitter sparkle
// (see pebble-material.ts), which stays exactly as-is for pebbles/comet/
// seeding dust. bodyColorDark/Light below are effectively decorative only:
// every sprout instance sets aTinted=1 (see stampPlantAttrs), so the
// fragment shader's own tint mix always resolves to the instance's aTint
// color regardless of these two values — kept dark to match the previous
// organic look's near-black undertone in case aTinted is ever dialed back.
// Exported for fate-events/seed-blossom.ts's tail plants, so they match the
// planet's own sprouts.
export const PLANT_DITHER_MAT = makeToonRimInstancedDitherMaterial({
  bodyColorDark: hexToRgb(ORGANIC_GLITTER_DARK),
  bodyColorLight: hexToRgb(ORGANIC_GLITTER_LIGHT),
  rimColor: hexToRgb(WHITE),
});

// Stamps the three per-instance attributes PLANT_DITHER_MAT requires onto a
// single-instance geometry, given an EXACT color — needed on the initial
// placeholder rock AND again on every real plant geometry once swapped in (a
// fresh clone from loadFbxAllMeshes has no instance attributes of its own).
function stampPlantAttrs(geo: BufferGeometry, color: readonly [number, number, number]): void {
  const [r, g, b] = color;
  geo.setAttribute('aBright', new InstancedBufferAttribute(new Float32Array([SPROUT_BRIGHT]), 1));
  geo.setAttribute('aTint', new InstancedBufferAttribute(new Float32Array([r, g, b]), 3));
  geo.setAttribute('aTinted', new InstancedBufferAttribute(new Float32Array([1]), 1));
}

// Same as stampPlantAttrs, but picks a fresh random palette color each call
// instead of taking one explicitly — for callers with no specific per-cell
// color to match (currently just fate-events/seed-blossom.ts's tail plants).
export function setPlantInstanceAttrs(geo: BufferGeometry): void {
  stampPlantAttrs(geo, PLANT_PALETTE[Math.floor(Math.random() * PLANT_PALETTE.length)]);
}

// loadFbxAllMeshes' cache hands every caller the SAME geometry objects, and
// convertZUpToYUp rewrites positions in place — so the conversion has to
// happen exactly once per pack, here, rather than in each consumer's own
// .then() (a second consumer, fate-events/seed-blossom.ts, would otherwise
// rotate them twice).
const plantPackCache = new Map<string, Promise<BufferGeometry[]>>();
function loadConvertedPlantPack(url: string, maxCount: number): Promise<BufferGeometry[]> {
  let promise = plantPackCache.get(url);
  if (!promise) {
    promise = loadFbxAllMeshes(url, maxCount, normalizeGeometryToUnitRadiusFromOrigin).then((geos) => {
      for (const geo of geos) convertZUpToYUp(geo);
      return geos;
    });
    plantPackCache.set(url, promise);
  }
  return promise;
}
export function loadDesertPlantGeos(): Promise<BufferGeometry[]> {
  return loadConvertedPlantPack(DESERT_PLANTS_URL, DESERT_PLANTS_MAX_COUNT);
}
export function loadFlowerPlantGeos(): Promise<BufferGeometry[]> {
  return loadConvertedPlantPack(FLOWERS_URL, FLOWERS_MAX_COUNT);
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

// One species' shared draw call — see the PLANT_DITHER_MAT comment above.
// `used` instances are live (mesh.count), the rest of the capacity is never
// drawn. aTint/aBright/aTinted live on the (per-bucket cloned) geometry.
interface PlantBucket {
  mesh: InstancedMesh;
  capacity: number;
  used: number;
  tint: Float32Array;
  tintAttr: InstancedBufferAttribute;
}

// Seeding's own "cause life to grow" flourish — no longer Organic-only (the
// bees in earth-situations-vfx-system.ts are the one thing still unique to
// that class). Seeding itself only colors the grid (see
// planet-seeding-system.ts) — no plant ever appears there. Once Leg A's spin
// begins, activate() looks at exactly which cells got colored and grows a
// real plant at each one, in that cell's own pre-rolled color, so the
// "many years later" reveal reads as the colored grid itself sprouting to
// life rather than a separate, disconnected bloom. Permanent once grown —
// riding along with the planet through Constellations/Fate Events/Launch,
// not reset or hidden once Seeding ends (see
// PlanetSeedingVfxSystem.startSpinTransition's own comment). Deliberately
// NOT person-shaped — Seeding shouldn't show people; the actual Fate Events
// civilization only starts forming later, during this same spin transition
// (see FateEventVfxSystem). Not a System — a plain pooled-effect class
// driven by explicit build()/activate()/update()/reset() calls from
// PlanetSeedingVfxSystem, same idiom as HeartBurstPool. Fixed slots
// (one per CELL_DIRS cell), no free-list needed: activate() only ever runs
// once per play(), and reset() zeroes every slot together on a fresh loop.
//
// Rendering: every plant species (one per mesh in each FBX pack) is a single
// InstancedMesh (a PlantBucket) parented under the planet, so the whole grid
// costs one draw call per species (~13 at most) rather than one per cell.
// A slot is just an instance index into its bucket; its growth is written
// into that instance's matrix each frame.
export class PlanetGrowthPool {
  private _scale = new Float32Array(POOL_SIZE);
  // 1 once activate() has claimed this slot (its cell was colored) —
  // distinct from _scale reaching 0, since a just-activated sprout also has
  // scale 0 for a moment. update() only advances slots this is set for.
  private _spawned = new Uint8Array(POOL_SIZE);
  // 1 for a slot PlanetSeedingVfxSystem has marked as falling inside Fate
  // Events' crowd area (see its own _applyHumanZoneExclusion) — update()
  // eases these back down to scale 0 instead of toward the normal growth
  // target, so any plant already grown there quietly shrinks away to make
  // room for a person instead of popping out instantly.
  private _excluded = new Uint8Array(POOL_SIZE);

  // Fixed per-slot placement, derived once from CELL_DIRS in build().
  private _slotPos: Vector3[] = [];
  private _slotQuat: Quaternion[] = [];
  // Per-slot fixed hemisphere — ORGANIC_MATTER_TYPE's own art-style split
  // (see this file's top comment); Soul/Gas ignore this and commit the whole
  // grid to one pack instead (see activate()).
  private _slotIsFlower: boolean[] = [];

  // Populated once each pack's own load resolves — empty until then.
  private _desertBuckets: PlantBucket[] = [];
  private _flowerBuckets: PlantBucket[] = [];
  // Round-robin cursor per pack so consecutive activations on the same
  // hemisphere cycle through all its species rather than repeating one.
  private _desertNext = 0;
  private _flowerNext = 0;
  // Which bucket/instance each slot landed in (null until _assign succeeds).
  private _slotBucket: (PlantBucket | null)[] = new Array(POOL_SIZE).fill(null);
  private _slotInstance = new Int16Array(POOL_SIZE);
  // Slots activate() claimed whose pack hadn't resolved yet — assigned as
  // soon as it does (very unlikely this late; both start loading in build()).
  private _unassigned: { slot: number; useFlowers: boolean; color: [number, number, number] }[] = [];

  private _upAxis = new Vector3(0, 1, 0);

  // parentEntity is the planet's own transform entity (see
  // PlanetSeedingVfxSystem's _planetEntity) — the buckets are parented under
  // it (not the world root) so they inherit the planet's live position/
  // rotation for free as it eases around, rather than each needing its own
  // per-frame re-derivation. Slot position/orientation are fixed from
  // CELL_DIRS.
  build(world: World, parentEntity: Entity): void {
    const dir = new Vector3();
    for (let i = 0; i < POOL_SIZE; i++) {
      dir.set(CELL_DIRS[i * 3], CELL_DIRS[i * 3 + 1], CELL_DIRS[i * 3 + 2]);
      // Unit-direction local offset (NOT multiplied by PLANET_RADIUS) — the
      // parent mesh's own PLANET_RADIUS scale already stretches this out to
      // sit exactly on the surface; multiplying here too would compound and
      // land it deep inside the planet instead. SURFACE_LIFT nudges it out a
      // little further still — see its own comment.
      this._slotPos.push(new Vector3(dir.x * SURFACE_LIFT, dir.y * SURFACE_LIFT, dir.z * SURFACE_LIFT));
      this._slotQuat.push(new Quaternion().setFromUnitVectors(this._upAxis, dir));
      this._slotIsFlower.push(dir.x < 0);
    }

    // Both packs trust their own authored origin instead of re-deriving a
    // ground point from the bounding box: normalizeGeometryToUnitRadius
    // FromOrigin scales AROUND local (0,0,0) and leaves it exactly where the
    // artist put it. convertZUpToYUp is still needed for both (verified: Z
    // is the tallest axis on every mesh in each pack, same as every other
    // FBX in the project).
    loadDesertPlantGeos().then((geos) => {
      this._desertBuckets = this._buildBuckets(world, parentEntity, geos);
      this._assignPending();
    });
    loadFlowerPlantGeos().then((geos) => {
      this._flowerBuckets = this._buildBuckets(world, parentEntity, geos);
      this._assignPending();
    });
  }

  private _buildBuckets(world: World, parentEntity: Entity, geos: BufferGeometry[]): PlantBucket[] {
    const capacity = Math.ceil(POOL_SIZE / Math.max(1, geos.length));
    const buckets: PlantBucket[] = [];
    for (const source of geos) {
      // .clone() — loadConvertedPlantPack's cache hands every caller the
      // SAME geometry objects (fate-events/seed-blossom.ts shares them), and
      // the per-instance attributes set below live ON the geometry.
      const geo = source.clone();
      const tint = new Float32Array(capacity * 3);
      const tintAttr = new InstancedBufferAttribute(tint, 3);
      tintAttr.setUsage(DynamicDrawUsage);
      geo.setAttribute('aBright', new InstancedBufferAttribute(new Float32Array(capacity).fill(SPROUT_BRIGHT), 1));
      geo.setAttribute('aTint', tintAttr);
      geo.setAttribute('aTinted', new InstancedBufferAttribute(new Float32Array(capacity).fill(1), 1));

      const mesh = new InstancedMesh(geo, PLANT_DITHER_MAT, capacity);
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.name = 'growth-plants';
      mesh.visible = false;
      world.createTransformEntity(mesh, parentEntity);
      buckets.push({ mesh, capacity, used: 0, tint, tintAttr });
    }

    // PLANT_DITHER_MAT's shader has never actually been compiled yet at this
    // point, and three.js only compiles a material's program on its first
    // real draw — which would stall a frame right as Leg A's spin starts
    // (see activate()). compile() traverses only visible objects
    // synchronously, so flipping visibility on for that one call and
    // straight back off warms the program at load time instead, minutes
    // before Constellations is ever reached.
    for (const b of buckets) b.mesh.visible = true;
    world.renderer.compileAsync(world.scene, world.camera).catch(() => {});
    for (const b of buckets) b.mesh.visible = b.used > 0;
    return buckets;
  }

  // Fired once by PlanetSeedingVfxSystem.startSpinTransition() — grows a
  // real plant at every cell PlanetSeedingSystem actually colored during
  // Seeding (coloredMask/cellColors, straight from its own getColoredMask()/
  // getCellColors()), in that cell's own fixed color, and leaves every
  // uncolored cell's slot alone (never drawn — Seeding's win condition
  // already requires the WHOLE grid colored, see COVERAGE_WIN_FRACTION, so in
  // normal play this should mean every slot; this still degrades gracefully
  // for a dev-menu skip that jumped into Seeding and left early with gaps).
  // `dominant` (globals.dominantPebbleType, read by the caller) decides which
  // pack(s) supply the mesh — see this file's own top comment: Organic keeps
  // the hemisphere-split art comparison, Soul/Gas each commit the whole grid
  // to a single pack.
  activate(coloredMask: Uint8Array, cellColors: Float32Array, dominant: number): void {
    for (let slot = 0; slot < POOL_SIZE; slot++) {
      if (!coloredMask[slot]) continue;
      this._spawned[slot] = 1;
      this._scale[slot] = 0;

      const color: [number, number, number] = [
        cellColors[slot * 3],
        cellColors[slot * 3 + 1],
        cellColors[slot * 3 + 2],
      ];
      const useFlowers =
        dominant === SOUL_DUST_TYPE ? true : dominant === VOLATILE_GASSES_TYPE ? false : this._slotIsFlower[slot];
      if (!this._assign(slot, useFlowers, color)) this._unassigned.push({ slot, useFlowers, color });
    }
  }

  // Claims the next instance in the next-in-rotation bucket of the wanted
  // pack. Returns false if that pack hasn't resolved yet. The instance
  // starts at scale 0 (matrix written here) so nothing pops in before
  // update() eases it up.
  private _assign(slot: number, useFlowers: boolean, color: readonly [number, number, number]): boolean {
    const buckets = useFlowers ? this._flowerBuckets : this._desertBuckets;
    if (buckets.length === 0) return false;
    const idx = useFlowers ? this._flowerNext++ : this._desertNext++;
    const bucket = buckets[idx % buckets.length];
    if (bucket.used >= bucket.capacity) return true; // full (shouldn't happen) — skip this plant
    const inst = bucket.used++;
    bucket.tint[inst * 3] = color[0];
    bucket.tint[inst * 3 + 1] = color[1];
    bucket.tint[inst * 3 + 2] = color[2];
    bucket.tintAttr.needsUpdate = true;
    this._slotBucket[slot] = bucket;
    this._slotInstance[slot] = inst;
    bucket.mesh.count = bucket.used;
    bucket.mesh.visible = true;
    this._writeInstance(slot, 0);
    return true;
  }

  private _assignPending(): void {
    if (this._unassigned.length === 0) return;
    this._unassigned = this._unassigned.filter((u) => !this._assign(u.slot, u.useFlowers, u.color));
  }

  private _writeInstance(slot: number, scale: number): void {
    const bucket = this._slotBucket[slot];
    if (!bucket) return;
    // Direct write, not compose() + setMatrixAt() — see writeInstanceTRS.
    const pos = this._slotPos[slot];
    const quat = this._slotQuat[slot];
    writeInstanceTRS(
      bucket.mesh.instanceMatrix.array as Float32Array,
      this._slotInstance[slot],
      pos.x, pos.y, pos.z,
      quat.x, quat.y, quat.z, quat.w,
      scale,
    );
    bucket.mesh.instanceMatrix.needsUpdate = true;
  }

  // spinProgress is PlanetSpinTransition.getProgress() (0 before Leg A,
  // ramping 0->1 across it, holding 1 after) — every activated slot's
  // target scale rides that same curve from GROWTH_TARGET_SCALE up to
  // GROWTH_FINAL_SCALE, so every plant grows in lockstep with the spin, the
  // same beat the planet's own splats/moons already get.
  update(delta: number, spinProgress: number): void {
    const pull = 1 - Math.exp(-GROWTH_EASE_RATE * delta);
    const grownTarget = GROWTH_TARGET_SCALE + (GROWTH_FINAL_SCALE - GROWTH_TARGET_SCALE) * spinProgress;
    for (let i = 0; i < POOL_SIZE; i++) {
      if (!this._spawned[i]) continue;
      const target = this._excluded[i] ? 0 : grownTarget;
      const diff = target - this._scale[i];
      if (diff === 0) continue;
      // Snap once close enough — the exponential ease otherwise never lands
      // exactly, which would rewrite (and re-upload) every matrix forever.
      this._scale[i] = Math.abs(diff) < 1e-6 ? target : this._scale[i] + diff * pull;
      this._writeInstance(i, this._scale[i]);
    }
  }

  // Called once by PlanetSeedingVfxSystem._applyHumanZoneExclusion, right
  // as Leg A's spin settles — see that method's own comment for why the
  // exclusion decision can't be made any earlier than that.
  excludeSlot(index: number): void {
    this._excluded[index] = 1;
  }

  reset(): void {
    for (const b of [...this._desertBuckets, ...this._flowerBuckets]) {
      b.used = 0;
      b.mesh.count = 0;
      b.mesh.visible = false;
    }
    this._slotBucket.fill(null);
    this._scale.fill(0);
    this._spawned.fill(0);
    this._excluded.fill(0);
    this._desertNext = 0;
    this._flowerNext = 0;
    this._unassigned.length = 0;
  }
}
