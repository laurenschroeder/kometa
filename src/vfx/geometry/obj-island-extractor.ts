import { BufferAttribute, BufferGeometry } from '@iwsdk/core';
import { mergeDuplicateVertices } from './mesh-utils.js';

// Splits `geo` into its disconnected mesh islands (via union-find over
// shared-position vertices — same merge technique mesh-utils.ts's own
// mergeDuplicateVertices uses) and returns EVERY island as its own
// standalone, independently-indexed, re-centered, normal-computed
// BufferGeometry — largest (by triangle count) first. For a single combined
// export where dozens of separate sculpted pieces were merged into one
// g-group with no per-object tagging (e.g. this project's own
// virtualpebble_*.obj — checked directly: Layer_1 alone splits into 190
// disconnected pieces), so a caller can single out just the biggest few
// without needing the source file re-exported with real per-object groups.
// Each returned geometry carries its own triangle count in
// userData.islandTriangleCount — obj-field-loader.ts's
// loadObjLargestIslands() reads this to rank candidates pulled from
// multiple source geometries (e.g. two different g-groups) against each
// other, not just within one.
export function extractMeshIslands(geo: BufferGeometry): BufferGeometry[] {
  const merged = mergeDuplicateVertices(geo);
  const index = merged.getIndex()!;
  const position = merged.getAttribute('position');
  const vertCount = position.count;

  const parent = new Int32Array(vertCount);
  for (let i = 0; i < vertCount; i++) parent[i] = i;
  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  const triCount = index.count / 3;
  for (let t = 0; t < triCount; t++) {
    const a = index.getX(t * 3);
    const b = index.getX(t * 3 + 1);
    const c = index.getX(t * 3 + 2);
    union(a, b);
    union(a, c);
  }

  const triByRoot = new Map<number, number[]>();
  for (let t = 0; t < triCount; t++) {
    const root = find(index.getX(t * 3));
    let list = triByRoot.get(root);
    if (!list) {
      list = [];
      triByRoot.set(root, list);
    }
    list.push(t);
  }

  const islands = [...triByRoot.values()]
    .sort((a, b) => b.length - a.length)
    .map((triList) => {
      const positions: number[] = [];
      const remap = new Map<number, number>();
      const newIndex: number[] = [];
      for (const t of triList) {
        for (let k = 0; k < 3; k++) {
          const vi = index.getX(t * 3 + k);
          let newIdx = remap.get(vi);
          if (newIdx === undefined) {
            newIdx = positions.length / 3;
            remap.set(vi, newIdx);
            positions.push(position.getX(vi), position.getY(vi), position.getZ(vi));
          }
          newIndex.push(newIdx);
        }
      }
      const out = new BufferGeometry();
      out.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
      out.setIndex(newIndex);
      out.computeVertexNormals();
      // Re-centered so each island's own local origin sits at its own
      // geometric center — a raw export position could be anywhere in the
      // combined model's world space, and callers place these via their
      // own per-instance transforms.
      out.center();
      out.computeBoundingSphere();
      out.userData.islandTriangleCount = triList.length;
      return out;
    });

  return islands;
}
