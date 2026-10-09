import { Object3D } from '@iwsdk/core';

// IWSDK replaces every entity object's position/quaternion/scale with
// "synced" subclasses whose x/y/z are per-instance accessor closures over the
// entity's Transform typed arrays (see attachToEntity in @iwsdk/core). Those
// share three's Vector3/Quaternion code paths with plain objects, which
// leaves Matrix4.compose() megamorphic — and in that state V8 boxes every
// float it reads. Object3D.updateMatrix() runs compose() for every
// auto-updating object every frame, so on Quest this alone measured ~5MB/s of
// garbage, surfacing as 25-55ms GC pauses.
//
// This replaces updateMatrix() with the same math in plain numbers: entity
// objects read their Transform views directly (the source of truth the synced
// vectors already write through to), every other object reads its own plain
// fields — each from a call site that only ever sees one object shape.
// Behaviour is identical to three's version (compose + matrixWorldNeedsUpdate).

type SyncedObject3D = Object3D & {
  positionView?: Float32Array;
  quaternionView?: Float32Array;
  scaleView?: Float32Array;
};
type PlainQuaternion = { _x: number; _y: number; _z: number; _w: number };

function writeTRS(
  te: number[],
  px: number,
  py: number,
  pz: number,
  qx: number,
  qy: number,
  qz: number,
  qw: number,
  sx: number,
  sy: number,
  sz: number,
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
  te[0] = (1 - (yy + zz)) * sx;
  te[1] = (xy + wz) * sx;
  te[2] = (xz - wy) * sx;
  te[3] = 0;
  te[4] = (xy - wz) * sy;
  te[5] = (1 - (xx + zz)) * sy;
  te[6] = (yz + wx) * sy;
  te[7] = 0;
  te[8] = (xz + wy) * sz;
  te[9] = (yz - wx) * sz;
  te[10] = (1 - (xx + yy)) * sz;
  te[11] = 0;
  te[12] = px;
  te[13] = py;
  te[14] = pz;
  te[15] = 1;
}

function updateFromViews(object: SyncedObject3D, p: Float32Array): void {
  const q = object.quaternionView!;
  const s = object.scaleView!;
  writeTRS(object.matrix.elements, p[0], p[1], p[2], q[0], q[1], q[2], q[3], s[0], s[1], s[2]);
}

function updateFromFields(object: Object3D): void {
  const p = object.position;
  const q = object.quaternion as unknown as PlainQuaternion;
  const s = object.scale;
  writeTRS(object.matrix.elements, p.x, p.y, p.z, q._x, q._y, q._z, q._w, s.x, s.y, s.z);
}

let installed = false;

export function installFastMatrixUpdate(): void {
  if (installed) return;
  installed = true;
  Object3D.prototype.updateMatrix = function (this: Object3D): void {
    const views = (this as SyncedObject3D).positionView;
    if (views !== undefined) updateFromViews(this, views);
    else updateFromFields(this);
    this.matrixWorldNeedsUpdate = true;
  };
}
