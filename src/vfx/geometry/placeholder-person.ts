import { BoxGeometry, BufferGeometry, CylinderGeometry, Group, Mesh, ShaderMaterial, SphereGeometry } from '@iwsdk/core';

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

// Where the invisible arm pivot (see buildIslandPerson) sits, as a fraction
// of bodyRadius — roughly shoulder height/width on the source figure.
const ARM_PIVOT_SPACING_FACTOR = 0.85;
const ARM_PIVOT_HEIGHT_FACTOR = 1.0;

// "Person made from one real OBJ mesh island" — same PlaceholderPerson shape
// (group origin at the feet, a `rightArm` Mesh exposed for the existing
// wave/point-up/war-pose animations) but standing in for
// buildPlaceholderPerson's primitive shapes with one real sculpted mesh
// fragment (see loadObjLargestIslands) — no second island glued on as a
// fake limb; each figure is just the one recognizable shape. `rightArm`
// still exists as a real Mesh (existing animation code rotates it) but is
// zero-scale and invisible — a pure pivot, not a rendered body part.
// Geometry is NOT mutated (no setAttribute calls — just this Mesh's own
// position/scale/rotation), so, unlike ArtTestVfxSystem's InstancedMesh
// consumers of the same cached islands, callers do NOT need to .clone()
// before use here — multiple people can safely share the same island
// BufferGeometry instance. Each island's own local origin is already
// re-centered to its geometric center (see extractMeshIslands), so
// `bodyRadius` (the island's own boundingSphere.radius) is enough to both
// auto-scale AND rest it exactly on the ground (position.y = the scaled
// radius).
export function buildIslandPerson(material: ShaderMaterial, bodyGeo: BufferGeometry, bodyRadius: number): PlaceholderPerson {
  const group = new Group();

  const bodyIslandRadius =
    bodyGeo.boundingSphere && bodyGeo.boundingSphere.radius > 1e-6 ? bodyGeo.boundingSphere.radius : 1;
  const body = new Mesh(bodyGeo, material);
  body.scale.setScalar(bodyRadius / bodyIslandRadius);
  body.position.set(0, bodyRadius, 0);
  // Random facing per figure — no authored/inspectable way to hand-pick a
  // "desired rotation" for these (see loadObjLargestIslands' own comment:
  // they're procedurally split out of one combined sculpt, not individually
  // authored/tagged assets a tool like Spatial Editor could list), so this
  // is a guess/randomize by design rather than an oversight.
  body.rotation.y = Math.random() * Math.PI * 2;
  group.add(body);

  // Invisible pivot — shares the body's own geometry (avoids allocating a
  // throwaway one per figure) but renders nothing, so existing rotation-only
  // pose animations keep working without adding a visible second shape.
  const rightArm = new Mesh(bodyGeo, material);
  rightArm.visible = false;
  rightArm.scale.setScalar(0);
  rightArm.position.set(bodyRadius * ARM_PIVOT_SPACING_FACTOR, bodyRadius * ARM_PIVOT_HEIGHT_FACTOR, 0);
  group.add(rightArm);

  return { group, rightArm };
}
