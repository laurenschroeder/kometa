import { BoxGeometry, CylinderGeometry, Group, Mesh, ShaderMaterial, SphereGeometry } from '@iwsdk/core';

// 2.2x the original size — at 0.6-1.4m viewing distance against a 1.4m
// planet, the original 9cm figures (with 5-7mm limbs) were only legible up
// close; this reads clearly as a standing figure from across the planet.
export const PERSON_HEIGHT = 0.2;

const LEG_RADIUS = 0.015;
const LEG_HEIGHT = 0.07;
const LEG_SPACING = 0.022;
const TORSO_WIDTH = 0.062;
const TORSO_HEIGHT = 0.08;
const TORSO_DEPTH = 0.035;
const ARM_RADIUS = 0.011;
const ARM_HEIGHT = 0.057;
const ARM_SPACING = 0.044;
const ARM_TILT = Math.PI / 12; // ~15 degrees, outward
const HEAD_RADIUS = 0.026;

export interface PlaceholderPerson {
  group: Group;
  // The right-arm Mesh, exposed separately so callers can rotate it for
  // one-off animations (e.g. pointing up at the comet) without disturbing
  // its resting pose — its own `rotation.z = ARM_TILT` local space is
  // preserved as the "arm down" rest orientation to return to.
  rightArm: Mesh;
}

// Placeholder "person made of basic shapes" — a blocky figure built from
// primitives, group origin at the feet so it can be dropped straight onto a
// world surface point (see sphere-scatter.ts). Geometry is built fresh per
// call (not shared) so a handful of figures don't look like literal clones;
// cost is negligible, these are a few primitives each, nothing like
// buildOrganicGeometry()'s displacement work. `material` is shared across
// every figure (and retinted live via its uBodyColor uniform — see
// makeToonRimFlatMaterial), not built per-figure here.
export function buildPlaceholderPerson(material: ShaderMaterial): PlaceholderPerson {
  const group = new Group();

  const legGeo = new CylinderGeometry(LEG_RADIUS, LEG_RADIUS, LEG_HEIGHT, 8);
  for (const side of [-1, 1]) {
    const leg = new Mesh(legGeo, material);
    leg.position.set(side * LEG_SPACING, LEG_HEIGHT / 2, 0);
    group.add(leg);
  }

  const torsoY = LEG_HEIGHT + TORSO_HEIGHT / 2;
  const torso = new Mesh(new BoxGeometry(TORSO_WIDTH, TORSO_HEIGHT, TORSO_DEPTH), material);
  torso.position.set(0, torsoY, 0);
  group.add(torso);

  const armY = LEG_HEIGHT + TORSO_HEIGHT - ARM_HEIGHT / 2;
  const armGeo = new CylinderGeometry(ARM_RADIUS, ARM_RADIUS, ARM_HEIGHT, 6);
  let rightArm!: Mesh;
  for (const side of [-1, 1]) {
    const arm = new Mesh(armGeo, material);
    arm.position.set(side * ARM_SPACING, armY, 0);
    arm.rotation.z = side * ARM_TILT;
    group.add(arm);
    if (side === 1) rightArm = arm;
  }

  const headY = LEG_HEIGHT + TORSO_HEIGHT + HEAD_RADIUS;
  const head = new Mesh(new SphereGeometry(HEAD_RADIUS, 8, 6), material);
  head.position.set(0, headY, 0);
  group.add(head);

  return { group, rightArm };
}
