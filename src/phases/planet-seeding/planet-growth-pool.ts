import { BufferGeometry, Entity, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, Vector3, World } from '@iwsdk/core';
import { buildOrganicGeometry } from '../../vfx/geometry/organic-rock-geometry.js';
import {
  convertZUpToYUp,
  loadFbxAllMeshes,
  normalizeGeometryToUnitRadiusFromOrigin,
} from '../../vfx/geometry/fbx-field-loader.js';
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

// activate() fires all at once (see its own comment), but swapping every
// activated slot's placeholder rock geometry for its real plant mesh is NOT
// cheap — each swap clones a BufferGeometry (attribute arrays included) and
// disposes the old one's GPU resources. Doing all of that synchronously for
// every colored cell in one call (up to POOL_SIZE, currently 80) in the same
// frame startSpinTransition() fires is exactly the kind of one-frame CPU/GPU
// burst that reads as a hitch right as the spin begins — spreading it across
// a handful of frames instead is imperceptible (every slot still shows SOME
// plant immediately, just the rock placeholder for a few extra frames) and
// keeps any single frame's swap work small.
const GEOMETRY_SWAPS_PER_FRAME = 6;

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
export class PlanetGrowthPool {
  private _groups: Group[] = [];
  private _meshes: InstancedMesh[] = [];
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

  // Populated once each pack's own load resolves — empty until then, in
  // which case activate() just leaves that slot on its rock placeholder.
  private _desertGeos: BufferGeometry[] = [];
  private _flowerGeos: BufferGeometry[] = [];
  // Round-robin cursor per pack so consecutive activations on the same
  // hemisphere cycle through all its species rather than repeating one.
  private _desertNext = 0;
  private _flowerNext = 0;
  // Per-slot fixed hemisphere — ORGANIC_MATTER_TYPE's own art-style split
  // (see build()'s own comment); Soul/Gas ignore this and commit the whole
  // grid to one pack instead (see activate()). Index-aligned with
  // _groups/_meshes/CELL_DIRS.
  private _slotIsFlower: boolean[] = [];
  // Slots activate() has claimed but whose real-mesh geometry swap hasn't
  // happened yet — see GEOMETRY_SWAPS_PER_FRAME. FIFO, drained a few at a
  // time by update().
  private _pendingSwaps: { slot: number; useFlowers: boolean; color: [number, number, number] }[] = [];

  private _upAxis = new Vector3(0, 1, 0);
  private _identity = new Matrix4();

  // parentEntity is the planet's own transform entity (see
  // PlanetSeedingVfxSystem's _planetEntity) — sprouts are parented under it
  // (not the world root) so they inherit the planet's live position for
  // free as it eases around following the player's head, rather than each
  // needing its own per-frame re-derivation from a stale spawn-time
  // snapshot. Position/orientation are fixed from CELL_DIRS and set once
  // here — every slot lands on its grid point immediately, whether or not
  // it's ever actually activated.
  build(world: World, parentEntity: Entity): void {
    const dir = new Vector3();
    for (let i = 0; i < POOL_SIZE; i++) {
      const group = new Group();
      const geo = buildOrganicGeometry();
      const placeholderColor = PLANT_PALETTE[Math.floor(Math.random() * PLANT_PALETTE.length)];
      stampPlantAttrs(geo, placeholderColor);
      const mesh = new InstancedMesh(geo, PLANT_DITHER_MAT, 1);
      mesh.setMatrixAt(0, this._identity);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.frustumCulled = false;
      group.add(mesh);
      group.name = `growth-sprout-${i}`;
      group.scale.setScalar(0);
      group.visible = false;

      dir.set(CELL_DIRS[i * 3], CELL_DIRS[i * 3 + 1], CELL_DIRS[i * 3 + 2]);
      // Unit-direction local offset (NOT multiplied by PLANET_RADIUS) — the
      // parent mesh's own PLANET_RADIUS scale already stretches this out to
      // sit exactly on the surface; multiplying here too would compound and
      // land it deep inside the planet instead. SURFACE_LIFT nudges it out a
      // little further still — see its own comment.
      group.position.set(dir.x * SURFACE_LIFT, dir.y * SURFACE_LIFT, dir.z * SURFACE_LIFT);
      group.quaternion.setFromUnitVectors(this._upAxis, dir);
      this._slotIsFlower.push(dir.x < 0);

      this._groups.push(group);
      this._meshes.push(mesh);
      world.createTransformEntity(group, parentEntity);
    }

    // Both packs now trust their own authored origin instead of re-deriving
    // a ground point from the bounding box: normalizeGeometryToUnitRadius
    // FromOrigin scales AROUND local (0,0,0) and leaves it exactly where the
    // artist put it. convertZUpToYUp is still needed for both (verified: Z
    // is the tallest axis on every mesh in each pack, same as every other
    // FBX in the project).
    loadDesertPlantGeos().then((geos) => {
      this._desertGeos = geos;
    });
    loadFlowerPlantGeos().then((geos) => {
      this._flowerGeos = geos;
    });

    // PLANT_DITHER_MAT's shader has never actually been compiled yet at this
    // point — every slot above sits invisible (group.visible = false), and
    // three.js only compiles a material's program on its first real draw.
    // Without this, that first-ever compile happens the instant activate()
    // makes a slot visible (right as Leg A's spin starts, alongside "Many
    // years later" — see GEOMETRY_SWAPS_PER_FRAME's own comment on the
    // OTHER hitch already fixed at that same moment), which can itself
    // stall a frame by several/tens of ms. Pre-warming it here, at build()
    // time (game boot, minutes before Constellations is ever reached),
    // moves that one-time cost somewhere it can't be felt. Fire-and-forget —
    // nothing here depends on it finishing before build() returns.
    world.renderer.compileAsync(world.scene, world.camera).catch(() => {});
  }

  // Fired once by PlanetSeedingVfxSystem.startSpinTransition() — grows a
  // real plant at every cell PlanetSeedingSystem actually colored during
  // Seeding (coloredMask/cellColors, straight from its own getColoredMask()/
  // getCellColors()), in that cell's own fixed color, and leaves every
  // uncolored cell's slot alone (hidden, scale 0, forever — Seeding's win
  // condition already requires the WHOLE grid colored, see
  // COVERAGE_WIN_FRACTION, so in normal play this should mean every slot;
  // this still degrades gracefully for a dev-menu skip that jumped into
  // Seeding and left early with gaps). `dominant` (globals.dominantPebbleType,
  // read by the caller) decides which pack(s) supply the mesh — see this
  // file's own top comment: Organic keeps the hemisphere-split art
  // comparison, Soul/Gas each commit the whole grid to a single pack.
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

      // Whichever pack has actually resolved by now supplies the mesh — see
      // GEOMETRY_SWAPS_PER_FRAME's own comment on why the actual clone/
      // dispose is deferred to update() instead of happening right here.
      const useFlowers =
        dominant === SOUL_DUST_TYPE ? true : dominant === VOLATILE_GASSES_TYPE ? false : this._slotIsFlower[slot];
      const pack = useFlowers ? this._flowerGeos : this._desertGeos;
      if (pack.length > 0) {
        // group.visible deliberately NOT set here — see _drainPendingSwaps,
        // which flips it on in lockstep with the same GEOMETRY_SWAPS_PER_FRAME
        // throttle instead of all ~POOL_SIZE slots turning visible (each its
        // own InstancedMesh draw call, doubled under stereo XR rendering) in
        // this one synchronous frame. That used to undo the whole point of
        // throttling the geometry swap: the swap was spread out, but the
        // sudden burst of new draw calls right as the spin starts wasn't.
        this._pendingSwaps.push({ slot, useFlowers, color });
      } else {
        // Pack not resolved yet (very unlikely this late — both start
        // loading back in build(), well before Seeding even begins) — at
        // least recolor the placeholder rock in place so it matches its
        // splat instead of showing its random build()-time color. Cheap
        // (no clone/dispose), so no need to defer this branch or its
        // visibility.
        stampPlantAttrs(this._meshes[slot].geometry as BufferGeometry, color);
        this._groups[slot].visible = true;
      }
    }
  }

  // Drains a few queued real-mesh swaps (see _pendingSwaps/
  // GEOMETRY_SWAPS_PER_FRAME) every frame instead of all at once.
  private _drainPendingSwaps(): void {
    for (let n = 0; n < GEOMETRY_SWAPS_PER_FRAME && this._pendingSwaps.length > 0; n++) {
      const { slot, useFlowers, color } = this._pendingSwaps.shift()!;
      const pack = useFlowers ? this._flowerGeos : this._desertGeos;
      // Each slot gets its own clone (never the cache's shared instance
      // directly) since PLANT_DITHER_MAT's per-instance attributes live ON
      // the geometry — two InstancedMeshes sharing one geometry object
      // would also share (and clobber) each other's aTint/aBright/aTinted.
      const idx = useFlowers ? this._flowerNext++ : this._desertNext++;
      const geo = pack[idx % pack.length].clone();
      stampPlantAttrs(geo, color);
      this._meshes[slot].geometry.dispose();
      this._meshes[slot].geometry = geo;
      // Reveal exactly when the real mesh lands — see activate()'s own
      // comment on why this moved here instead of all slots going visible
      // together the instant activate() runs.
      this._groups[slot].visible = true;
    }
  }

  // spinProgress is PlanetSpinTransition.getProgress() (0 before Leg A,
  // ramping 0->1 across it, holding 1 after) — every activated slot's
  // target scale rides that same curve from GROWTH_TARGET_SCALE up to
  // GROWTH_FINAL_SCALE, so every plant grows in lockstep with the spin, the
  // same beat the planet's own splats/moons already get.
  update(delta: number, spinProgress: number): void {
    this._drainPendingSwaps();
    const pull = 1 - Math.exp(-GROWTH_EASE_RATE * delta);
    const grownTarget = GROWTH_TARGET_SCALE + (GROWTH_FINAL_SCALE - GROWTH_TARGET_SCALE) * spinProgress;
    for (let i = 0; i < POOL_SIZE; i++) {
      if (!this._spawned[i]) continue;
      const target = this._excluded[i] ? 0 : grownTarget;
      if (this._scale[i] === target) continue;
      this._scale[i] += (target - this._scale[i]) * pull;
      this._groups[i].scale.setScalar(this._scale[i]);
    }
  }

  // Called once by PlanetSeedingVfxSystem._applyHumanZoneExclusion, right
  // as Leg A's spin settles — see that method's own comment for why the
  // exclusion decision can't be made any earlier than that.
  excludeSlot(index: number): void {
    this._excluded[index] = 1;
  }

  reset(): void {
    for (let i = 0; i < POOL_SIZE; i++) {
      this._groups[i].visible = false;
      this._groups[i].scale.setScalar(0);
      this._scale[i] = 0;
    }
    this._spawned.fill(0);
    this._excluded.fill(0);
    this._desertNext = 0;
    this._flowerNext = 0;
    this._pendingSwaps.length = 0;
  }
}
