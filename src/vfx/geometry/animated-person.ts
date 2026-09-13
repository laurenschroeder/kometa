import {
  AnimationAction,
  AnimationClip,
  AnimationMixer,
  Bone,
  Box3,
  Group,
  LoopRepeat,
  Object3D,
  ShaderMaterial,
  SkinnedMesh,
  Vector3,
} from '@iwsdk/core';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { hexToRgb, PERSON_BODY } from '../color/color-scheme.js';

// Shared rig for every "human" figure in Fate Events (the crowd, the King,
// the graveyard bench NPC) — a single Mixamo-rigged, Mixamo-animated FBX
// (BreathingIdle.fbx), confirmed by directly parsing the file: one
// SkinnedMesh ('ProperPerson' — the same name/position as one of
// blobpeople.fbx's own meshes, i.e. this is that same person model, just
// auto-rigged+animated via Mixamo afterward), 28 bones, one AnimationClip
// (Mixamo always names it 'mixamo.com' regardless of which animation you
// actually downloaded — not literally 'BreathingIdle').
//
// UNLIKE every other FBX pack in this project (desertPlants/flowers/
// blobpeople — all authored Z-up, needing fbx-field-loader.ts's own
// convertZUpToYUp), this file's SkinnedMesh node already carries its OWN
// baked correction: directly inspecting it, the mesh's local transform is
// position=(402.6,59.8,1913.5), quaternion=(-0.707,0,0,0.707) — exactly a
// -90° rotation about X — scale=(100,100,100). Mixamo's export pipeline
// authored the skin geometry in one (small, Z-up, offset) space but placed
// the SKELETON directly in a second (already correctly Y-up, real-world-
// scaled) space, and baked that exact correction onto the mesh node so the
// two agree — confirmed empirically by comparing bone world positions
// (e.g. mixamorigHead ~1.1-1.5k units up on the Y axis) against the mesh's
// own raw un-transformed geometry bounds (~14 units tall on Z). This means
// the file is ALREADY correctly oriented once normal scene-graph transforms
// are applied — no manual axis conversion needed or wanted here. An earlier
// version of this file applied its own extra -90°-X rotation on top (the
// same convertZUpToYUp convention as the other packs), which double-rotated
// the mesh relative to its already-correct skeleton and effectively made
// every human figure invisible/broken.
const BREATHING_IDLE_URL = '/medium/BreathingIdle.fbx';

// Shared fixed body color for every human figure built from this rig — the
// crowd, the King, and the graveyard bench NPC (fate-event-vfx-system.ts /
// earth-situations-vfx-system.ts) all import this rather than each picking
// their own tint, replacing what used to be per-context colors (dominant-
// type mood tint for the crowd, a lavender KING_COLOR, a grey GRAVE_COLOR).
export const PERSON_BODY_COLOR: [number, number, number] = hexToRgb(PERSON_BODY);

// Standard Mixamo rig bone name — the existing "point up"/"wave" pose
// overrides (fate-event-vfx-system.ts) retarget onto this bone instead of
// PlaceholderPerson's old raw `rightArm` Mesh. Apply as an ADDITIVE rotation
// AFTER mixer.update() each frame (e.g. `bone.rotateX(extra)`, not
// `bone.rotation.set(...)`) so it layers on top of that frame's idle pose
// instead of fighting/overwriting it.
const RIGHT_ARM_BONE_NAME = 'mixamorigRightArm';
// The body's standing axis — used for horizontal centering, see
// AnimatedPersonTemplate's own comment on why the bounding box isn't.
const HIPS_BONE_NAME = 'mixamorigHips';

interface AnimatedPersonTemplate {
  root: Group; // raw FBXLoader output (SkinnedMesh + bone hierarchy) — never itself added to the scene, only ever cloned
  clip: AnimationClip; // immutable, addressed by bone NAME/track path — safe to share across every clone's own AnimationMixer, no per-instance copy needed
  // Measurements of the rig in its ANIMATED pose (the clip applied at t=0),
  // NOT its bind pose — these differ substantially and only the animated one
  // is ever actually seen. Confirmed by directly sampling this clip: in bind
  // pose the right toe sits at y=111.3 and the head tops out at y=1462.8,
  // but once the clip's own mixamorigHips.position track is applied the
  // whole character drops ~111 units, planting the toe at y=0.26 and the
  // head at ~1340. That's Mixamo's standard "in place, feet on the y=0
  // ground plane" export convention, and it OVERRIDES whatever origin the
  // source model was authored with (personmodel.fbx's own origin sits at
  // y=59.8, essentially at its soles — correctly placed, just not what the
  // animation ends up honoring). Grounding against bind-pose numbers is
  // what made figures float/sink depending on the scene.
  //
  // Height is a Y-extent, not a bounding-sphere radius — the pose holds the
  // arms out from the body, so a sphere fit to it would be inflated by the
  // arm-span and undersize the standing silhouette.
  //
  // Horizontal centering comes from the HIPS BONE rather than the bounding
  // box's own center: the box is arm-pose-dependent (an asymmetric or
  // one-arm-raised pose skews its center away from where the figure
  // actually stands), while the hips are the body's standing axis in any
  // pose. posedMinY grounds the feet to local Y=0, matching
  // PlaceholderPerson's own "origin at the feet" convention so both the
  // placeholder and the real rig drop into the same callers unchanged.
  posedHeight: number;
  posedMinY: number;
  posedHipsX: number;
  posedHipsZ: number;
}

export interface AnimatedPerson {
  // Public — position/quaternion/scale this exactly like
  // PlaceholderPerson.group; internally wraps a fixed recenter+scale
  // correction, so nothing the caller sets here fights that.
  group: Group;
  // Caller must call mixer.update(delta) every frame this figure is active.
  mixer: AnimationMixer;
  // The looping idle action already playing on `mixer` — exposed so a
  // caller can .stop()/.fadeOut() it when switching this instance onto a
  // different one-shot clip (e.g. the King's death — see
  // earth-situations-vfx-system.ts's loadPersonClip usage below).
  idleAction: AnimationAction;
  // null only if the rig's own bone naming ever changes — every current
  // clone of BreathingIdle.fbx has this bone.
  rightArmBone: Bone | null;
}

let templatePromise: Promise<AnimatedPersonTemplate | null> | null = null;
// Keyed by URL — for one-off clips played on the shared rig's own mixer
// (mixer.clipAction() binds by track/bone NAME, not object identity, so any
// Mixamo export sharing this rig's 'mixamorig...' bone naming can donate its
// clip here regardless of which FBX file it actually came from). Separate
// cache from templatePromise since these don't need the SkinnedMesh/pose
// measurements that loadAnimatedPersonTemplate extracts — just the clip.
const clipCache = new Map<string, Promise<AnimationClip | null>>();

// Loads (and caches) a single AnimationClip from a standalone Mixamo FBX
// export for use on an ALREADY-BUILT AnimatedPerson's own mixer/skeleton
// (see buildAnimatedPerson) — e.g. the King's DyingBackwards.fbx. Same
// graceful-degradation idiom as loadAnimatedPersonTemplate: resolves null
// instead of rejecting so a caller can just skip the one-shot clip (keeping
// whatever's already playing) if the file isn't available.
export function loadPersonClip(url: string): Promise<AnimationClip | null> {
  let promise = clipCache.get(url);
  if (!promise) {
    promise = new FBXLoader().loadAsync(url).then(
      (root) => {
        const clip = (root as unknown as { animations: AnimationClip[] }).animations[0];
        if (!clip) {
          console.warn(`[animated-person] '${url}' has no AnimationClip.`);
          return null;
        }
        return clip;
      },
      (err) => {
        console.warn(`[animated-person] '${url}' not available yet.`, err);
        return null;
      },
    );
    clipCache.set(url, promise);
  }
  return promise;
}

// Loads (and caches) the shared BreathingIdle rig — resolves to null instead
// of rejecting on any failure (file not present yet, missing skeleton/clip),
// same graceful-degradation idiom every other FBX consumer in this codebase
// uses, so callers keep whatever non-animated placeholder they already have.
export function loadAnimatedPersonTemplate(): Promise<AnimatedPersonTemplate | null> {
  if (!templatePromise) {
    templatePromise = new FBXLoader().loadAsync(BREATHING_IDLE_URL).then(
      (root) => {
        const clip = (root as unknown as { animations: AnimationClip[] }).animations[0];
        let skinned: SkinnedMesh | null = null;
        root.traverse((child) => {
          if (!skinned && (child as SkinnedMesh).isSkinnedMesh) skinned = child as SkinnedMesh;
        });
        if (!clip || !skinned) {
          console.warn(
            `[animated-person] '${BREATHING_IDLE_URL}' is missing its SkinnedMesh or AnimationClip — keeping the non-animated placeholder.`,
          );
          return null;
        }
        // Apply the clip at t=0 before measuring, so every number below
        // describes the pose that actually renders rather than the bind
        // pose (see the template's own comment — they differ by ~111
        // units of vertical drop on this rig). This mixer is throwaway;
        // each real instance builds its own against its own clone.
        const measureMixer = new AnimationMixer(root);
        measureMixer.clipAction(clip).play();
        measureMixer.update(0);
        root.updateMatrixWorld(true);

        // SkinnedMesh caches its own boundingBox and Box3.setFromObject
        // only computes it when null — so an already-computed bind-pose box
        // would be silently reused here. Clear it to force a recompute
        // against the posed skeleton. (Typed as non-nullable Box3 in
        // three's .d.ts, but null is exactly what its own computeBoundingBox
        // checks for and what a freshly constructed SkinnedMesh carries.)
        (skinned as SkinnedMesh).boundingBox = null as unknown as Box3;

        // WORLD-space box (post the mesh's own already-correct baked
        // transform — see this file's top comment) rather than the raw
        // local geometry box, which is in a different, pre-correction space
        // entirely and would give nonsense height/center numbers.
        const box = new Box3().setFromObject(root);

        // Hips drive horizontal centering (see the template's comment on
        // why the box's own center is unreliable for this). Falling back to
        // the box center keeps this working if the rig is ever renamed.
        const hips = root.getObjectByName(HIPS_BONE_NAME);
        const hipsWorld = new Vector3();
        if (hips) {
          hips.getWorldPosition(hipsWorld);
        } else {
          hipsWorld.set((box.min.x + box.max.x) / 2, 0, (box.min.z + box.max.z) / 2);
        }

        return {
          root: root as unknown as Group,
          clip,
          posedHeight: box.max.y - box.min.y,
          posedMinY: box.min.y,
          posedHipsX: hipsWorld.x,
          posedHipsZ: hipsWorld.z,
        };
      },
      (err) => {
        console.warn(`[animated-person] '${BREATHING_IDLE_URL}' not available yet — keeping the placeholder.`, err);
        return null;
      },
    );
  }
  return templatePromise;
}

// Builds one independent, playing instance from an already-resolved
// template (see loadAnimatedPersonTemplate) — clones via SkeletonUtils
// (a plain Object3D/geometry .clone() does NOT correctly relink a
// SkinnedMesh's Skeleton to its own cloned bones; SkeletonUtils.clone does),
// so every figure gets its own independent skeleton/mixer state despite
// sharing one shared template and one shared AnimationClip.
//
// Recenter + scale live on an INNER group nested inside the returned
// (identity) outer `group`, rather than baked onto the outer group directly
// — the outer group is what callers freely position/rotate/scale per-figure
// (crowd placement, King's own topple rotation, ...); baking the fixed
// correction onto that same group would get overwritten the first time a
// caller sets its transform. No rotation is applied here — the rig is
// already correctly oriented once cloned (see this file's own top comment);
// only a translate (recenter horizontal footprint + ground the feet) and a
// uniform scale (bindHeight -> targetHeight) are needed.
export function buildAnimatedPerson(
  template: AnimatedPersonTemplate,
  material: ShaderMaterial,
  targetHeight: number,
): AnimatedPerson {
  const clonedRoot = cloneSkeleton(template.root) as unknown as Object3D;

  let skinned: SkinnedMesh | null = null;
  clonedRoot.traverse((child) => {
    if (!skinned && (child as SkinnedMesh).isSkinnedMesh) skinned = child as SkinnedMesh;
  });
  if (skinned) {
    (skinned as SkinnedMesh).material = material;
    (skinned as SkinnedMesh).frustumCulled = false;
  }

  const scale = template.posedHeight > 1e-6 ? targetHeight / template.posedHeight : 1;

  const inner = new Group();
  inner.scale.setScalar(scale);
  // Puts the posed figure's feet exactly on local y=0 with its standing axis
  // over local (0, z=0) — so the returned outer group behaves identically to
  // PlaceholderPerson's own "origin at the feet" group, and every existing
  // caller (surface placement + setFromUnitVectors(+Y, surfaceNormal)) keeps
  // working untouched. For this particular Mixamo export all three of these
  // are near zero anyway (feet already land at y~0.26, hips at x~-8.9/z~-8.6
  // out of a ~1340-unit-tall rig); computing them explicitly rather than
  // assuming the convention keeps this correct if the clip is ever swapped
  // for another Mixamo animation with a different root height.
  inner.position.set(-scale * template.posedHipsX, -scale * template.posedMinY, -scale * template.posedHipsZ);
  inner.add(clonedRoot);

  const outer = new Group();
  outer.add(inner);

  const mixer = new AnimationMixer(clonedRoot);
  const action = mixer.clipAction(template.clip);
  action.setLoop(LoopRepeat, Infinity);
  action.play();
  // Random phase into the clip's own loop — every instance otherwise starts
  // at exactly t=0 the same tick it's built, so a whole crowd built together
  // (see fate-event-vfx-system.ts's per-person build loop) would breathe in
  // perfect unison instead of reading as independent figures. Harmless for
  // the single King/graveyard-bench instances (earth-situations-vfx-
  // system.ts) too — nothing else for a lone figure to be "in sync" with.
  action.time = Math.random() * template.clip.duration;

  const rightArmBone = (clonedRoot.getObjectByName(RIGHT_ARM_BONE_NAME) as Bone | undefined) ?? null;

  return { group: outer, mixer, idleAction: action, rightArmBone };
}
