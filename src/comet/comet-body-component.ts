import { createComponent, Types } from '@iwsdk/core';

// Per-hand comet physics state, plus the spring/gravity/snap-throw tuning
// params as component fields (not module constants) — this is what lets a
// later chapter recontextualize the same mechanic (e.g. a taut lasso-style
// spring for orbital launch) by configuring a different CometBody instance,
// without touching CometPhysicsSystem itself. Defaults match the original
// comet-system.ts prototype constants.
export const CometBody = createComponent('CometBody', {
  position: { type: Types.Vec3, default: [0, 0, 0] },
  velocity: { type: Types.Vec3, default: [0, 0, 0] },
  prevHand: { type: Types.Vec3, default: [0, 0, 0] },
  wasSnapped: { type: Types.Boolean, default: false },
  initialized: { type: Types.Boolean, default: false },
  springStrength: { type: Types.Float32, default: 8 },
  damping: { type: Types.Float32, default: 0.5 },
  gravityScale: { type: Types.Float32, default: 6 },
  snapThreshold: { type: Types.Float32, default: 0.85 },
  throwMult: { type: Types.Float32, default: 2.0 },
});
