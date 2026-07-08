import { createComponent } from '@iwsdk/core';

// One-frame tags added by CometPhysicsSystem on the snap/release edge, same
// lifecycle idiom as the built-in Pressed component — any system (audio,
// achievements) can query/subscribe('qualify', ...) on these without coupling
// to physics internals. CometPhysicsSystem removes each tag the frame after
// it adds it.
export const CometSnapped = createComponent('CometSnapped', {}, '');
export const CometReleased = createComponent('CometReleased', {}, '');
