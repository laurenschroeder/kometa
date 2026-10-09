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

// Writes position * rotation * uniform scale straight into an InstancedMesh's
// instanceMatrix array (same layout Matrix4.compose + setMatrixAt produce)
// from plain numbers. For per-frame hot loops: three's compose() is shared
// with IWSDK's getter-backed synced vectors, which leaves its property reads
// megamorphic — measured on Quest allocating a boxed number per float read
// (~2.6MB/s for the comet's pebbles alone, feeding GC pauses).
export function writeInstanceTRS(
  array: Float32Array,
  index: number,
  px: number,
  py: number,
  pz: number,
  qx: number,
  qy: number,
  qz: number,
  qw: number,
  scale: number,
): void {
  const x2 = qx + qx;
  const y2 = qy + qy;
  const z2 = qz + qz;
  const xx = qx * x2;
  const xy = qx * y2;
  const xz = qx * z2;
  const yy = qy * y2;
  const yz = qy * z2;
  const zz = qz * z2;
  const wx = qw * x2;
  const wy = qw * y2;
  const wz = qw * z2;
  const o = index * 16;
  array[o] = (1 - (yy + zz)) * scale;
  array[o + 1] = (xy + wz) * scale;
  array[o + 2] = (xz - wy) * scale;
  array[o + 3] = 0;
  array[o + 4] = (xy - wz) * scale;
  array[o + 5] = (1 - (xx + zz)) * scale;
  array[o + 6] = (yz + wx) * scale;
  array[o + 7] = 0;
  array[o + 8] = (xz + wy) * scale;
  array[o + 9] = (yz - wx) * scale;
  array[o + 10] = (1 - (xx + yy)) * scale;
  array[o + 11] = 0;
  array[o + 12] = px;
  array[o + 13] = py;
  array[o + 14] = pz;
  array[o + 15] = 1;
}
