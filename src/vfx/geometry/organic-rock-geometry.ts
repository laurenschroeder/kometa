import { BufferGeometry, IcosahedronGeometry, Vector3 } from '@iwsdk/core';
import { mergeDuplicateVertices, randomUnitVector3 } from './mesh-utils.js';

export interface OrganicGeometryParams {
  icoDetail?: number;
  displaceTerms?: number;
  freqMin?: number;
  freqMax?: number;
  ampMin?: number;
  ampMax?: number;
}

const DEFAULTS: Required<OrganicGeometryParams> = {
  icoDetail: 2,
  displaceTerms: 4,
  freqMin: 1.5,
  freqMax: 4.0,
  ampMin: 0.04,
  ampMax: 0.10,
};

// Generalized from the original comet-system.ts buildPebbleVariantGeometry.
// Precompute at module load (zero runtime cost) — every chapter that wants
// an organic rock/mote/debris shape calls this with its own params instead
// of re-deriving the sine-sum displacement technique.
//
// Each call gets its own random sine-sum "bump field" (dot product with a
// random axis stands in for a continuously-varying angle over the sphere,
// avoiding the axis-aligned artifacts a plain sin(x)/sin(y)/sin(z) sum would
// produce) so shapes read as irregular organic rocks instead of perfect
// spheres, with no runtime noise dependency or per-frame displacement cost.
export function buildOrganicGeometry(params: OrganicGeometryParams = {}): BufferGeometry {
  const p = { ...DEFAULTS, ...params };
  const base = new IcosahedronGeometry(1, p.icoDetail);
  const geo = mergeDuplicateVertices(base);

  const terms = Array.from({ length: p.displaceTerms }, () => ({
    axis: randomUnitVector3(),
    freq: p.freqMin + Math.random() * (p.freqMax - p.freqMin),
    phase: Math.random() * Math.PI * 2,
    amp: p.ampMin + Math.random() * (p.ampMax - p.ampMin),
  }));

  const pos = geo.getAttribute('position');
  const v = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
    let disp = 0;
    for (const t of terms) {
      disp += Math.sin(v.dot(t.axis) * t.freq + t.phase) * t.amp;
    }
    v.multiplyScalar(Math.max(0.3, 1 + disp));
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}
