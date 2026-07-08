import { AssetType, DomeGradient, SessionMode, World } from '@iwsdk/core';
import { CometBody } from './comet/comet-body-component.js';
import { CometReleased, CometSnapped } from './comet/comet-event-tags.js';
import { CometPhysicsSystem } from './comet/comet-physics-system.js';
import { CometTrail } from './comet/comet-trail-component.js';
import { CometTrailSystem } from './comet/comet-trail-system.js';
import { HandAnchor, HandSide } from './comet/hand-anchor-component.js';
import { bootstrapGlobals } from './core/globals.js';
import { PebbleCometPresentationSystem } from './phases/pebbles/pebble-comet-presentation-system.js';

World.create(document.getElementById('scene-container') as HTMLDivElement, {
  assets: {
    beepchat1: { url: '/textures/beepchat1.png', type: AssetType.Texture },
    beepchat2: { url: '/textures/beepchat2.png', type: AssetType.Texture },
    beepchat3: { url: '/textures/beepchat3.png', type: AssetType.Texture },
    beepchat4: { url: '/textures/beepchat4.png', type: AssetType.Texture },
    smile1: { url: '/textures/Sprite-0001.png', type: AssetType.Texture },
    smile2: { url: '/textures/Sprite-0002.png', type: AssetType.Texture },

  },
  xr: {
    sessionMode: SessionMode.ImmersiveVR,
    offer: 'always',
    features: { handTracking: true },
  },
  features: {
    locomotion: false,
    grabbing: false,
    physics: false,
    sceneUnderstanding: false,
  },
}).then((world) => {
  bootstrapGlobals(world);

  world.renderer.setClearColor(0x000000, 1.0);

  const root = world.activeLevel.value;
  for (const key of ['sky', 'equator', 'ground'] as const) {
    const v = root.getVectorView(DomeGradient, key) as Float32Array;
    v[0] = 0; v[1] = 0; v[2] = 0; v[3] = 1;
  }
  root.setValue(DomeGradient, '_needsUpdate', true);

  // Components must be registered before any system query references them
  // (query bitmasks are computed at registerSystem time) and before the
  // comet entities below add them.
  world
    .registerComponent(CometBody)
    .registerComponent(HandAnchor)
    .registerComponent(CometTrail)
    .registerComponent(CometSnapped)
    .registerComponent(CometReleased);

  // comet/ (physics + trail) is the reusable spring-joint mechanic, always
  // on. PebbleCometPresentationSystem is the persistent, ever-evolving comet
  // visual — also always on, never phase-gated (see plan doc). Priorities
  // follow the input(0-9)/simulation(10-19)/visual-sync(20-29) convention.
  world
    .registerSystem(CometPhysicsSystem, { priority: 10 })
    .registerSystem(CometTrailSystem, { priority: 15 })
    .registerSystem(PebbleCometPresentationSystem, { priority: 20 });

  const cometLeft = world.createEntity();
  cometLeft.addComponent(CometBody);
  cometLeft.addComponent(HandAnchor, { hand: HandSide.Left, palmOffsetZ: 0.08 });
  cometLeft.addComponent(CometTrail);

  const cometRight = world.createEntity();
  cometRight.addComponent(CometBody);
  cometRight.addComponent(HandAnchor, { hand: HandSide.Right, palmOffsetZ: 0.08 });
  cometRight.addComponent(CometTrail);
});
