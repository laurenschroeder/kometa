import {
  BufferAttribute,
  BufferGeometry,
  Float32BufferAttribute,
  Vector3,
} from '@iwsdk/core';

// Merge duplicate-position vertices of a non-indexed geometry into an
// indexed one. IcosahedronGeometry (and similar procedural geometries) emit
// private per-triangle vertex copies, so computeVertexNormals() would only
// ever produce flat per-facet normals without this — smooth shading requires
// shared vertex slots across triangles.
export function mergeDuplicateVertices(geo: BufferGeometry): BufferGeometry {
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

export function randomUnitVector3(): Vector3 {
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
