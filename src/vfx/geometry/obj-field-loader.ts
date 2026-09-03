import { BufferGeometry, Group, Mesh, Object3D } from '@iwsdk/core';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { computeFitScale, FALLBACK_GEO, FALLBACK_MAT, type FbxFieldTransform } from './fbx-field-loader.js';
import { extractMeshIslands } from './obj-island-extractor.js';

const loader = new OBJLoader();
// One shared load per URL — same reasoning as fbx-field-loader.ts's own
// cache.
const fileCache = new Map<string, Promise<Group | null>>();

function loadObjFile(url: string): Promise<Group | null> {
  let promise = fileCache.get(url);
  if (!promise) {
    promise = loader
      .loadAsync(url)
      .then((group) => group as unknown as Group)
      .catch((err) => {
        console.warn(`[obj-field-loader] '${url}' failed to load — showing a placeholder instead.`, err);
        return null;
      });
    fileCache.set(url, promise);
  }
  return promise;
}

// True if `obj` (or any descendant) is a Mesh with at least one vertex —
// an OBJ `g`/`o` group declaration with no faces under it (e.g. an export
// where that layer's geometry was never actually included) still shows up
// as a named Object3D/Group, just an empty one, so a plain "was it found"
// check isn't enough on its own.
function hasVisibleGeometry(obj: Object3D): boolean {
  let found = false;
  obj.traverse((child) => {
    if (found || !(child instanceof Mesh)) return;
    const posAttr = child.geometry.getAttribute('position');
    if (posAttr && posAttr.count > 0) found = true;
  });
  return found;
}

// Loads `url` once (an OBJ that may contain several named `g`/`o` groups —
// three.js's OBJLoader creates one child Object3D per such declaration,
// named accordingly), pulls out JUST the descendant named `groupName`, and
// builds a scattered field of clones of that one subtree — for a multi-part
// export where only one named layer should actually populate a field.
// Same "magenta placeholder until real geometry is available" fallback
// behavior as buildFbxField, EXTENDED to also fall back when the named
// group is found but empty (has no faces) — not just when the whole file
// fails to load — since that's exactly the state an in-progress/partial
// export can be in.
//
// targetRadius, if given, auto-scales the REAL loaded geometry (once found)
// so its own bounding-sphere radius matches targetRadius exactly — for "make
// this the same size as the other pebbles" callers who don't know (and
// shouldn't have to guess) the source file's native export scale. Each
// transform's own `scale` still applies on top as a per-instance size-
// variance multiplier (so callers should pass values centered around 1.0,
// e.g. 0.85-1.15, not an absolute size) rather than being the absolute size
// itself. The fallback placeholder ignores targetRadius and just uses each
// transform's scale directly against its own already-reasonably-sized rock
// geometry.
export function buildObjNamedGroupField(
  url: string,
  groupName: string,
  transforms: readonly FbxFieldTransform[],
  targetRadius?: number,
): Group {
  const container = new Group();

  function populate(template: Object3D | null, fitScale: number): void {
    while (container.children.length > 0) container.remove(container.children[0]);
    for (const t of transforms) {
      const instance = template ? (template.clone() as Object3D) : new Mesh(FALLBACK_GEO, FALLBACK_MAT);
      instance.position.set(t.position[0], t.position[1], t.position[2]);
      instance.scale.setScalar(t.scale * fitScale);
      container.add(instance);
    }
  }

  // The placeholder rock (FALLBACK_GEO) already has a natural radius of
  // ~1 unit, so — unlike the real (as yet unmeasured) model — its own fit
  // scale IS simply targetRadius directly, no bounding-sphere measurement
  // needed.
  populate(null, targetRadius ?? 1);
  loadObjFile(url).then((root) => {
    if (!root) return;
    const found = root.getObjectByName(groupName);
    if (!found || !hasVisibleGeometry(found)) {
      console.warn(
        `[obj-field-loader] '${groupName}' not found (or has no faces) in '${url}' — keeping the placeholder. ` +
          `Re-export the OBJ with that layer's geometry included to pick this up.`,
      );
      return;
    }
    const fitScale = targetRadius !== undefined ? computeFitScale(found, targetRadius) : 1;
    populate(found, fitScale);
  });

  return container;
}

// One cached extraction per (url, group list, count) — the union-find pass
// over tens of thousands of faces is real work, no reason to redo it if two
// callers ask for the same thing.
const islandCache = new Map<string, Promise<BufferGeometry[]>>();

// Loads `url`, pulls every Mesh under each named group in `groupNames`
// (three.js's OBJLoader creates one child Object3D per `g`/`o`
// declaration), splits ALL of them into their disconnected mesh islands
// (see extractMeshIslands — for an export where many separate sculpted
// pieces got merged into a couple of g-groups with no per-piece tagging),
// ranks every island found across every requested group against each other
// by triangle count, and resolves to the `maxCount` largest overall.
// Resolves to [] (never rejects) if the file fails to load or none of the
// named groups exist/have faces — callers decide what "no islands found"
// means for them (e.g. ArtTestVfxSystem falls back to its usual magenta
// placeholder rock).
export function loadObjLargestIslands(
  url: string,
  groupNames: readonly string[],
  maxCount: number,
): Promise<BufferGeometry[]> {
  const key = `${url}|${groupNames.join(',')}|${maxCount}`;
  let promise = islandCache.get(key);
  if (!promise) {
    promise = loadObjFile(url).then((root) => {
      if (!root) return [];
      const sourceGeos: BufferGeometry[] = [];
      for (const name of groupNames) {
        const found = root.getObjectByName(name);
        if (!found) continue;
        found.traverse((child) => {
          if (child instanceof Mesh) sourceGeos.push(child.geometry as BufferGeometry);
        });
      }
      const allIslands = sourceGeos.flatMap((geo) => extractMeshIslands(geo));
      allIslands.sort(
        (a, b) => (b.userData.islandTriangleCount as number) - (a.userData.islandTriangleCount as number),
      );
      return allIslands.slice(0, maxCount);
    });
    islandCache.set(key, promise);
  }
  return promise;
}
