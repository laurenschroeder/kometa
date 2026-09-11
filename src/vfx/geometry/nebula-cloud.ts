import { AdditiveBlending, BufferAttribute, BufferGeometry, Group, Points } from '@iwsdk/core';
import { makePointSpriteMaterial } from '../shaders/point-sprite-material.js';

const N_POINTS = 260;
// Big enough to visibly fill (and softly overflow) the orbital-launch choice
// zone's own wireframe sphere (ZONE_RADIUS=0.35 — see orbital-launch-
// system.ts) rather than reading as a small accent inside it.
const RADIUS = 0.32;
const MIN_SIZE = 0.05;
const MAX_SIZE = 0.14;
const MIN_BRIGHT = 0.35;
const MAX_BRIGHT = 0.9;

// A soft, additive-blended cloud of point sprites scattered through a
// roughly spherical volume — same camera-facing soft-point technique the
// comet's own haze/gas-cloud layers use (see point-sprite-material.ts).
// Used in place of an arrow for "The Great Unknown" launch choice: a
// directionless destination reads better as a drifting nebula than a
// pointed arrow, which (like Orbit's own arrow) implies a specific heading.
export function buildNebulaCloud(color: [number, number, number]): Group {
  const group = new Group();

  const positions = new Float32Array(N_POINTS * 3);
  const sizes = new Float32Array(N_POINTS);
  const bright = new Float32Array(N_POINTS);
  for (let i = 0; i < N_POINTS; i++) {
    // Uniform-in-volume sphere sample: uniform direction (theta/acos(2u-1))
    // + cube-root-scaled radius, so points don't visibly clump toward the
    // center the way a naive per-axis random cube or linear radius would.
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(Math.random() * 2 - 1);
    const r = RADIUS * Math.cbrt(Math.random());
    const sinPhi = Math.sin(phi);
    positions[i * 3] = r * sinPhi * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * sinPhi * Math.sin(theta);
    sizes[i] = MIN_SIZE + Math.random() * (MAX_SIZE - MIN_SIZE);
    bright[i] = MIN_BRIGHT + Math.random() * (MAX_BRIGHT - MIN_BRIGHT);
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(positions, 3));
  geo.setAttribute('aSize', new BufferAttribute(sizes, 1));
  geo.setAttribute('aBright', new BufferAttribute(bright, 1));

  const material = makePointSpriteMaterial({
    color,
    blending: AdditiveBlending,
    depthWrite: false,
    transparent: true,
  });
  const points = new Points(geo, material);
  points.frustumCulled = false;
  group.add(points);
  return group;
}
