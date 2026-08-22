import { ConeGeometry, CylinderGeometry, Group, Mesh, MeshBasicMaterial } from '@iwsdk/core';

const SHAFT_RADIUS = 0.012;
const SHAFT_LENGTH = 0.16;
const HEAD_RADIUS = 0.032;
const HEAD_LENGTH = 0.07;

// A simple directional arrow — shaft + cone head, group origin at the tail
// so a caller can point it via
// group.quaternion.setFromUnitVectors((0,1,0), direction). Same
// primitive-composition convention as placeholder-person.ts. `material` is
// shared/passed in (each of the two orbital-launch arrows gets its own
// distinctly-tinted material, built once by the caller).
export function buildOrbitalArrow(material: MeshBasicMaterial): Group {
  const group = new Group();

  const shaft = new Mesh(new CylinderGeometry(SHAFT_RADIUS, SHAFT_RADIUS, SHAFT_LENGTH, 8), material);
  shaft.position.set(0, SHAFT_LENGTH / 2, 0);
  group.add(shaft);

  const head = new Mesh(new ConeGeometry(HEAD_RADIUS, HEAD_LENGTH, 8), material);
  head.position.set(0, SHAFT_LENGTH + HEAD_LENGTH / 2, 0);
  group.add(head);

  return group;
}
