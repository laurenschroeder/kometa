import { createComponent, Types } from '@iwsdk/core';

export const HandSide = { Left: 'left', Right: 'right' } as const;

// Which grip space a CometBody entity should track. CometPhysicsSystem
// resolves this to this.player.gripSpaces.left/right each frame — an
// Object3D can't be stored directly as component data.
export const HandAnchor = createComponent('HandAnchor', {
  hand: { type: Types.Enum, enum: HandSide, default: HandSide.Left },
  palmOffsetZ: { type: Types.Float32, default: 0.08 },
});
