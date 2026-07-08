import { createComponent, Types } from '@iwsdk/core';

// Config only — the actual trail history buffer is a Float32Array sized
// samples*stride*3, owned by CometTrailSystem in a Map keyed by entity.index
// (allocated on query qualify, freed on disqualify). A raw typed array isn't
// expressible as component field data, and per-entity variable-length
// buffers don't fit the fixed-width Vec3/Vec4 component model.
export const CometTrail = createComponent('CometTrail', {
  samples: { type: Types.Int32, default: 22 },
  stride: { type: Types.Int32, default: 2 },
});
