import { DomeGradient, SessionMode, World } from '@iwsdk/core';
import { CometSystem } from './comet-system.js';

World.create(document.getElementById('scene-container') as HTMLDivElement, {
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
  // Override the default sky to deep space black
  const root = world.activeLevel.value;
  const black = [0, 0, 0, 1] as const;
  for (const key of ['sky', 'equator', 'ground'] as const) {
    const view = root.getVectorView(DomeGradient, key) as Float32Array;
    view[0] = black[0]; view[1] = black[1]; view[2] = black[2]; view[3] = black[3];
  }
  root.setValue(DomeGradient, '_needsUpdate', true);

  world.registerSystem(CometSystem);
});
