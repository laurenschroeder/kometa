import { BufferGeometry, Group, Mesh, Object3D } from '@iwsdk/core';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
// Box3 is a pure math class (no render/GL state, unlike Object3D/Material) —
// @iwsdk/core doesn't re-export three's math utility classes, and there's
// only ever one 'three' package resolved in this project (FBXLoader/
// OBJLoader below already import from it directly for the same reason:
// there's no @iwsdk/core wrapper for either loader), so this is the same
// Box3 class every other Three.js object in the app already uses under the
// hood — not a second parallel Three.js instance.
import { Box3, Sphere } from 'three';
import { buildOrganicGeometry } from './organic-rock-geometry.js';
import { makeToonRimFlatMaterial } from '../shaders/toon-rim-material.js';

// Warning-magenta rock — the classic "missing asset" convention — shown in
// place of any model (FBX or OBJ — see obj-field-loader.ts) ArtTestVfxSystem
// references that hasn't actually been dropped in / doesn't contain the
// expected geometry yet. Module-scope singletons: safe to share across
// every fallback instance in every field, same "shared decoration, never
// disposed" convention as pebble-material.ts's kOrganicGlitterMat/
// kSoulIslandMat/kGasCloudMat.
// Exported so obj-field-loader.ts reuses the exact same placeholder rather
// than building its own.
export const FALLBACK_GEO = buildOrganicGeometry();
export const FALLBACK_MAT = makeToonRimFlatMaterial([1.0, 0.0, 0.85]);

// Guessed at 0.01 (a common Blender/Maya centimeter-unit FBX export scale) —
// there's no way to know the real figure until an actual FBX lands in
// public/fbx/, so every buildFbxField() caller multiplies this against its
// own per-field base size. Expect to retune once real assets exist.
export const FBX_ASSUMED_SCALE = 0.01;

const loader = new FBXLoader();
// One shared load per URL — a scattered field clones the same template many
// times, so this is what stops that from re-fetching/re-parsing the file
// once per particle.
const templateCache = new Map<string, Promise<Group | null>>();

// Loads (and caches by URL) an FBX file's root Group. Resolves to null
// instead of rejecting on any failure (file not present on disk yet, parse
// error, ...) so callers can fall back to a placeholder rather than the
// whole level breaking — see buildFbxField below, and ArtTestVfxSystem's own
// comment for exactly which filenames under public/fbx/ are still pending.
function loadFbxTemplate(url: string): Promise<Group | null> {
  let promise = templateCache.get(url);
  if (!promise) {
    promise = loader
      .loadAsync(url)
      .then((group) => group as unknown as Group)
      .catch((err) => {
        console.warn(`[fbx-field-loader] '${url}' not available yet — showing a placeholder instead.`, err);
        return null;
      });
    templateCache.set(url, promise);
  }
  return promise;
}

export interface FbxFieldTransform {
  position: [number, number, number];
  scale: number;
}

// Uniform multiplier that would resize `template`'s own bounding-sphere
// radius to exactly `targetRadius` — for a loaded model whose native export
// scale is unknown (or, per hasVisibleGeometry-style callers, was never
// meant to be guessed at all — see obj-field-loader.ts's "same size" use).
// Falls back to 1 for a degenerate (zero-size) bounding sphere rather than
// dividing by zero.
export function computeFitScale(template: Object3D, targetRadius: number): number {
  const sphere = new Box3().setFromObject(template).getBoundingSphere(new Sphere());
  return sphere.radius > 1e-6 ? targetRadius / sphere.radius : 1;
}

// A scattered field of clones of one FBX file, laid out at fixed transforms
// (position/scale only — this is a static art-comparison field, not a
// simulated one). Populates with a shared magenta placeholder rock
// immediately, so the field is visible/testable right away even with zero
// FBX assets present, then silently rebuilds every instance as a real clone
// of the loaded FBX the moment (if ever) it resolves. The returned Group
// must be added to the scene by the caller (e.g. via
// world.createTransformEntity) — this only builds content, same division of
// responsibility as buildOrganicGeometry()/buildPlaceholderPerson().
//
// targetRadius, if given, auto-scales the REAL loaded model (once it
// resolves) so its own bounding-sphere radius matches targetRadius exactly —
// see computeFitScale's own comment. Each transform's `scale` then applies
// on top as a per-instance size-variance multiplier (pass values centered
// around 1.0, e.g. 0.85-1.15), not the absolute size itself, when
// targetRadius is used. Without targetRadius, `scale` is the absolute size
// as before (multiplied against FBX_ASSUMED_SCALE by the caller, since the
// model's native export scale is otherwise unknown).
export function buildFbxField(
  url: string,
  transforms: readonly FbxFieldTransform[],
  targetRadius?: number,
): Group {
  const container = new Group();

  function populate(template: Group | null, fitScale: number): void {
    while (container.children.length > 0) container.remove(container.children[0]);
    for (const t of transforms) {
      const instance = template ? (template.clone() as Group) : new Mesh(FALLBACK_GEO, FALLBACK_MAT);
      instance.position.set(t.position[0], t.position[1], t.position[2]);
      instance.scale.setScalar(t.scale * fitScale);
      container.add(instance);
    }
  }

  // The placeholder rock (FALLBACK_GEO) already has a natural radius of
  // ~1 unit, so — unlike the real (as yet unknown-scale) model — its own
  // fit scale IS simply targetRadius directly, no bounding-sphere
  // measurement needed.
  populate(null, targetRadius ?? 1);
  loadFbxTemplate(url).then((template) => {
    if (!template) return;
    const fitScale = targetRadius !== undefined ? computeFitScale(template, targetRadius) : 1;
    populate(template, fitScale);
  });

  return container;
}

// Rescales `geo`'s vertices in place so its own bounding-sphere radius
// becomes exactly 1 — baked directly into the geometry (not a separate
// per-instance transform multiplier) so it drops straight into an
// InstancedMesh setup whose per-instance scale already assumes ~unit-radius
// geometry (see buildOrganicGeometry()'s own ~1-unit rocks, and
// earth-situations-vfx-system.ts's OrganicScene.baseScale, a small 0.02-0.04
// multiplier against exactly that assumption) — a raw model's native export
// scale is otherwise unknown/arbitrary. No-ops (leaves geo untouched) for a
// degenerate zero-size geometry rather than dividing by zero.
export function normalizeGeometryToUnitRadius(geo: BufferGeometry): void {
  geo.computeBoundingSphere();
  const radius = geo.boundingSphere?.radius ?? 0;
  if (radius < 1e-6) return;
  const scale = 1 / radius;
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(i, pos.getX(i) * scale, pos.getY(i) * scale, pos.getZ(i) * scale);
  }
  pos.needsUpdate = true;
  geo.computeBoundingSphere();
}

// Origin-relative counterpart to normalizeGeometryToUnitRadius above — for a
// pack whose artist has deliberately placed each mesh's local origin (0,0,0)
// at its own ground-contact point in Blender (Set Origin > Origin to 3D
// Cursor at the plant's base), rather than the older desertPlants.fbx/
// flowers.fbx packs whose vertex data carries an arbitrary baked
// scene-layout offset (see planet-growth-pool.ts's recenterAndGroundGeometry,
// which those packs still need). Measures "radius" as the farthest vertex
// distance FROM ORIGIN rather than computeBoundingSphere()'s own box-center —
// a plant's base sits at one extreme of its shape, not its geometric center,
// so box-center-relative scaling would size it inconsistently against its
// own base. The scale itself is applied around the origin (pos * scale, no
// recentering), so local (0,0,0) — the artist's chosen anchor — lands
// exactly on the surface wherever the caller places it, with no further
// recenter/reground step needed.
export function normalizeGeometryToUnitRadiusFromOrigin(geo: BufferGeometry): void {
  const pos = geo.getAttribute('position');
  let maxDistSq = 0;
  for (let i = 0; i < pos.count; i++) {
    const distSq = pos.getX(i) ** 2 + pos.getY(i) ** 2 + pos.getZ(i) ** 2;
    if (distSq > maxDistSq) maxDistSq = distSq;
  }
  if (maxDistSq < 1e-12) return;
  const scale = 1 / Math.sqrt(maxDistSq);
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(i, pos.getX(i) * scale, pos.getY(i) * scale, pos.getZ(i) * scale);
  }
  pos.needsUpdate = true;
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
}

// Shared by every FBX pack authored Z-up (confirmed per-pack by directly
// parsing the file with FBXLoader and checking bounding boxes: Z consistently
// the tallest of a mesh's three axes, Y the thinnest) — three.js's own
// FBXLoader does NOT apply any automatic up-axis conversion (checked its
// source directly — it never reads GlobalSettings' UpAxis at all), so raw
// positions/normals stay exactly as authored. Rotates -90° about X —
// (x,y,z) -> (x,z,-y) — so "tall" ends up along local +Y, matching every
// other Y-up assumption in this codebase (e.g. planet-growth-pool.ts's
// build() aligning local +Y with a surface normal). Originally private to
// planet-growth-pool.ts's own two plant packs; moved here once
// fate-event-vfx-system.ts's blobpeople.fbx needed the exact same conversion,
// rather than duplicating it a second time.
export function convertZUpToYUp(geo: BufferGeometry): void {
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const z = pos.getZ(i);
    pos.setY(i, z);
    pos.setZ(i, -y);
  }
  pos.needsUpdate = true;
  const normal = geo.getAttribute('normal');
  if (normal) {
    for (let i = 0; i < normal.count; i++) {
      const ny = normal.getY(i);
      const nz = normal.getZ(i);
      normal.setY(i, nz);
      normal.setZ(i, -ny);
    }
    normal.needsUpdate = true;
  }
}

// One cached load per (url, group name, count) — same reasoning as
// obj-field-loader.ts's own caches: no reason to re-walk the same subtree if
// two callers ask for the same thing.
const groupChildMeshCache = new Map<string, Promise<BufferGeometry[]>>();

// Loads `url`, finds the descendant named `groupName`, and returns the
// geometry of each individual Mesh child found under it — UNLIKE
// obj-field-loader.ts's loadObjLargestIslands, this does NOT split anything
// via union-find: an FBX group can (and, per this project's own
// desertPlants.fbx > Meshes > Layer_1, does) already contain several
// separately-authored, individually-named meshes as direct children — e.g.
// cactusTall/cactusBlob/plantSwirl/etc — so each one is already its own
// usable shape with no extraction needed. Each returned geometry is a clone
// (so mutating it, e.g. via normalizeGeometryToUnitRadius, never touches the
// shared cached FBX template) rescaled to unit bounding-sphere radius so
// callers can drop them straight into an InstancedMesh alongside procedural
// geometry with no extra fit-scale math. Resolves to [] (never rejects, and
// logs the names actually found in the file to help correct a wrong guess)
// if the file fails to load or the named group doesn't exist — callers keep
// whatever placeholder they already have. `maxCount` caps how many distinct
// meshes are returned (in whatever order they appear in the file); pass a
// generous number to get all of them.
function collectAndNormalizeMeshes(
  root: Object3D,
  maxCount: number,
  normalize: (geo: BufferGeometry) => void,
): BufferGeometry[] {
  const geos: BufferGeometry[] = [];
  root.traverse((child) => {
    if (child instanceof Mesh) geos.push(child.geometry as BufferGeometry);
  });
  if (geos.length === 0) return [];
  const top = geos.slice(0, maxCount).map((geo) => geo.clone());
  for (const geo of top) normalize(geo);
  return top;
}

// `normalize` defaults to the box-center-relative normalizeGeometryToUnitRadius
// (existing behavior, unchanged for desertPlants.fbx/flowers.fbx) — pass
// normalizeGeometryToUnitRadiusFromOrigin for a pack whose origins are
// already correctly placed at each plant's own base, so callers can skip
// planet-growth-pool.ts's recenterAndGroundGeometry entirely for it.
export function loadFbxNamedGroupChildMeshes(
  url: string,
  groupName: string,
  maxCount: number,
  normalize: (geo: BufferGeometry) => void = normalizeGeometryToUnitRadius,
): Promise<BufferGeometry[]> {
  const key = `${url}|${groupName}|${maxCount}|${normalize === normalizeGeometryToUnitRadius ? 'box' : 'origin'}`;
  let promise = groupChildMeshCache.get(key);
  if (!promise) {
    promise = loadFbxTemplate(url).then((root) => {
      if (!root) return [];
      const found = root.getObjectByName(groupName);
      if (!found) {
        const names: string[] = [];
        root.traverse((child) => {
          if (child.name) names.push(child.name);
        });
        console.warn(
          `[fbx-field-loader] group '${groupName}' not found in '${url}' — keeping the placeholder. ` +
            `Names actually present in the file: ${names.slice(0, 40).join(', ') || '(none named)'}`,
        );
        return [];
      }
      const top = collectAndNormalizeMeshes(found, maxCount, normalize);
      if (top.length === 0) {
        console.warn(`[fbx-field-loader] '${groupName}' in '${url}' has no mesh children — keeping the placeholder.`);
      }
      return top;
    });
    groupChildMeshCache.set(key, promise);
  }
  return promise;
}

// Same as loadFbxNamedGroupChildMeshes, but for files with no single
// wrapping group node to search under — the individual meshes are direct
// children of the FBX's own root instead (confirmed this is the actual
// shape of flowers.fbx via a direct FBXLoader parse: its root's own
// children are named 'grass'/'Layer_2'/'flower'/'cactus', not a further
// 'Layer_1' descendant containing them — 'Layer_2' here is just one mesh's
// own arbitrary name, not a grouping convention). Otherwise identical
// behavior/caching/fallback to loadFbxNamedGroupChildMeshes.
const allMeshCache = new Map<string, Promise<BufferGeometry[]>>();
// See loadFbxNamedGroupChildMeshes's own comment on `normalize`'s default/
// origin-trusting alternative.
export function loadFbxAllMeshes(
  url: string,
  maxCount: number,
  normalize: (geo: BufferGeometry) => void = normalizeGeometryToUnitRadius,
): Promise<BufferGeometry[]> {
  const key = `${url}|${maxCount}|${normalize === normalizeGeometryToUnitRadius ? 'box' : 'origin'}`;
  let promise = allMeshCache.get(key);
  if (!promise) {
    promise = loadFbxTemplate(url).then((root) => {
      if (!root) return [];
      const top = collectAndNormalizeMeshes(root, maxCount, normalize);
      if (top.length === 0) {
        console.warn(`[fbx-field-loader] '${url}' has no mesh children at all — keeping the placeholder.`);
      }
      return top;
    });
    allMeshCache.set(key, promise);
  }
  return promise;
}

// Unlike loadFbxAllMeshes/loadFbxNamedGroupChildMeshes (which grab "however
// many mesh children are present, in file order"), this picks out SPECIFIC
// named meshes from anywhere in the file's hierarchy — for a pack like
// blobpeople.fbx that bundles many unrelated shapes (several blob-people
// variants, a handful of ghosts, a stray test pebble, ...) as siblings in one
// file, where a caller wants only a few of them by name. Resolves one
// geometry per entry in `names`, in the SAME order, with `null` for any name
// not found (case-sensitive exact match first, falling back to a
// case-insensitive match — artist-authored names and calling code routinely
// only differ in casing) — never rejects, so a caller can keep whatever
// placeholder it already has for just the missing slot(s) instead of losing
// the whole set over one typo. Logs every name actually present in the file
// once, the first time anything requested comes back missing.
const namedMeshCache = new Map<string, Promise<(BufferGeometry | null)[]>>();
export function loadFbxMeshesByName(
  url: string,
  names: readonly string[],
  normalize: (geo: BufferGeometry) => void = normalizeGeometryToUnitRadius,
): Promise<(BufferGeometry | null)[]> {
  const key = `${url}|${names.join(',')}|${normalize === normalizeGeometryToUnitRadius ? 'box' : 'origin'}`;
  let promise = namedMeshCache.get(key);
  if (!promise) {
    promise = loadFbxTemplate(url).then((root) => {
      if (!root) return names.map(() => null);
      const byName = new Map<string, Mesh>();
      const byLowerName = new Map<string, Mesh>();
      root.traverse((child) => {
        if (child instanceof Mesh && child.name) {
          byName.set(child.name, child);
          byLowerName.set(child.name.toLowerCase(), child);
        }
      });
      let anyMissing = false;
      const result = names.map((name) => {
        const mesh = byName.get(name) ?? byLowerName.get(name.toLowerCase());
        if (!mesh) {
          anyMissing = true;
          return null;
        }
        const geo = (mesh.geometry as BufferGeometry).clone();
        normalize(geo);
        return geo;
      });
      if (anyMissing) {
        console.warn(
          `[fbx-field-loader] one or more of [${names.join(', ')}] not found in '${url}' — keeping the placeholder ` +
            `for that slot. Names actually present in the file: ${Array.from(byName.keys()).slice(0, 60).join(', ') || '(none named)'}`,
        );
      }
      return result;
    });
    namedMeshCache.set(key, promise);
  }
  return promise;
}
