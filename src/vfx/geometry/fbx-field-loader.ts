import { Group, Mesh, Object3D } from '@iwsdk/core';
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
// disposed" convention as pebble-material.ts's kPebbleFieldTintedMat.
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
