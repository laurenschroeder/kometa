import {
  AdditiveBlending,
  BackSide,
  BufferGeometry,
  DomeGradient,
  Float32BufferAttribute,
  Mesh,
  MeshBasicMaterial,
  Points,
  PointsMaterial,
  SessionMode,
  SphereGeometry,
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
  world.renderer.setClearColor(0x00020a, 1.0);

  // Dark void sky for VR mode
  const root = world.activeLevel.value;
  for (const key of ['sky', 'equator', 'ground'] as const) {
    const v = root.getVectorView(DomeGradient, key) as Float32Array;
    v[0] = 0.01; v[1] = 0.01; v[2] = 0.03; v[3] = 1;
  }
  root.setValue(DomeGradient, '_needsUpdate', true);

  // ── Dark night overlay ────────────────────────────────────────────────
  // A semi-transparent dark dome rendered on the inside surface darkens
  // the AR passthrough to a night-sky feel without fully blocking it.
  const dome = new Mesh(
    new SphereGeometry(500, 32, 16),
    new MeshBasicMaterial({
      color: 0x00020a,
      transparent: true,
      opacity: 0.93,
      side: BackSide,
      depthTest: false,   // always renders regardless of depth buffer
      depthWrite: false,
    }),
  );
  dome.renderOrder = -100; // draw first so everything else layers on top
  world.createTransformEntity(dome);

  // ── Star field ────────────────────────────────────────────────────────
  const STARS = 2000;
  const pos = new Float32Array(STARS * 3);
  const col = new Float32Array(STARS * 3);
  for (let i = 0; i < STARS; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi   = Math.acos(2 * Math.random() - 1);
    const r     = 45 + Math.random() * 10;
    pos[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
    pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    pos[i * 3 + 2] = r * Math.cos(phi);
    const b    = 0.35 + Math.random() * 0.65;
    const cool = Math.random();
    col[i * 3]     = b * (1 - cool * 0.15);
    col[i * 3 + 1] = b * 0.93;
    col[i * 3 + 2] = b * (0.85 + cool * 0.15);
  }
  const starGeo = new BufferGeometry();
  starGeo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  starGeo.setAttribute('color',    new Float32BufferAttribute(col, 3));
  starGeo.computeBoundingSphere();
  world.createTransformEntity(new Points(
    starGeo,
    new PointsMaterial({
      size: 0.35,
      sizeAttenuation: true,
      vertexColors: true,
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
    }),
  ));

  world.registerSystem(CometSystem);
});
