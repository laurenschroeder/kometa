import {
  DomeGradient,
  SessionMode,
  World,
} from '@iwsdk/core';
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
  world.renderer.setClearColor(0x000000, 1.0);

  const root = world.activeLevel.value;
  for (const key of ['sky', 'equator', 'ground'] as const) {
    const v = root.getVectorView(DomeGradient, key) as Float32Array;
    v[0] = 0; v[1] = 0; v[2] = 0; v[3] = 1;
  }
  root.setValue(DomeGradient, '_needsUpdate', true);

  world.registerSystem(CometSystem);
});
