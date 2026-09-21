import { Matrix4, Object3D, Vector3 } from '@iwsdk/core';
import type { World } from '@iwsdk/core';
import { HandSide } from '../comet/hand-anchor-component.js';

// Anchored to the hand-tracking `wrist` joint when hands are tracked. The
// grip space's origin sits at the palm centroid, which is what kept putting
// wrist-worn UI over the hand. In WebXR's joint/grip convention -Z points
// toward the fingers, so +Z runs back up the forearm toward the elbow.
//
// "On top of the wrist from whatever side you look": the lift direction is
// the wrist->camera vector with its along-forearm component removed, so the
// object hovers on whichever side of the wrist faces the viewer — never
// behind the hand or arm, regardless of wrist roll or viewing angle.
const WRIST_TOWARD_ELBOW_OFFSET = 0.025; // up the forearm from the wrist joint, where a watch sits
const WRIST_LIFT_OFFSET = 0.055; // off the wrist's surface, toward the viewer
// Controllers have no wrist joint — approximate it this far back from the
// grip (palm) origin along the same +Z forearm axis.
const CONTROLLER_GRIP_TO_WRIST = 0.06;
// Fast catch-up ease (same "reads as locked, not laggy" idiom
// NotificationHudSystem's own Follower tuning uses) — smooths raw
// hand-tracking jitter without introducing visible lag as the hand moves
// around, and doubles as the ease on the rise amount itself so it glides up
// rather than snapping the instant the wrist rolls far enough.
const POSITION_EASE_RATE = 14;

// Shared by every wrist-worn element (HandProgressHudSystem's bar,
// ContinueButtonSystem's button) so they all sit in exactly the same spot.
export class WristAnchor {
  private _hasPosition = false;
  private _scratchWristMat = new Matrix4();
  private _scratchWrist = new Vector3();
  private _scratchForearm = new Vector3();
  private _scratchToCam = new Vector3();
  private _scratchTarget = new Vector3();
  private _scratchCamPos = new Vector3();

  // Call when the owner hides, so the next show snaps to the wrist instead
  // of easing in from wherever it was last.
  reset(): void {
    this._hasPosition = false;
  }

  // Eases `object` toward the wrist of the `side` hand and billboards it
  // toward the camera — same "readable regardless of how the wrist happens
  // to be turned" reasoning every other HUD/bubble element here uses, rather
  // than rigidly rotating with the hand's own (often awkward, mid-swing)
  // orientation.
  update(world: World, handSide: string, delta: number, object: Object3D): void {
    const side = handSide === HandSide.Right ? 'right' : 'left';
    const grip = world.player.gripSpaces[side];
    grip.updateWorldMatrix(true, false);
    world.camera.getWorldPosition(this._scratchCamPos);

    // Joint poses are filled relative to the same grip XRSpace that posed
    // `grip` (see XRHandVisualAdapter.update). Joint 0 is `wrist` — XRHand
    // iterates joints in XRHandJoint enum order.
    const xrInput = world.input.xr;
    const joints = xrInput.visualAdapters.hand[side].jointTransforms;
    if (joints && xrInput.isPrimary('hand', side)) {
      this._scratchWristMat.fromArray(joints, 0).premultiply(grip.matrixWorld);
      this._scratchWrist.setFromMatrixPosition(this._scratchWristMat);
      this._scratchForearm.setFromMatrixColumn(this._scratchWristMat, 2).normalize();
    } else {
      this._scratchForearm.setFromMatrixColumn(grip.matrixWorld, 2).normalize();
      this._scratchWrist
        .setFromMatrixPosition(grip.matrixWorld)
        .addScaledVector(this._scratchForearm, CONTROLLER_GRIP_TO_WRIST);
    }

    this._scratchToCam.subVectors(this._scratchCamPos, this._scratchWrist);
    this._scratchToCam.addScaledVector(this._scratchForearm, -this._scratchToCam.dot(this._scratchForearm));
    if (this._scratchToCam.lengthSq() < 1e-8) this._scratchToCam.set(0, 1, 0);
    else this._scratchToCam.normalize();

    this._scratchTarget
      .copy(this._scratchWrist)
      .addScaledVector(this._scratchForearm, WRIST_TOWARD_ELBOW_OFFSET)
      .addScaledVector(this._scratchToCam, WRIST_LIFT_OFFSET);

    if (!this._hasPosition) {
      object.position.copy(this._scratchTarget);
      this._hasPosition = true;
    } else {
      const pull = 1 - Math.exp(-POSITION_EASE_RATE * delta);
      object.position.lerp(this._scratchTarget, pull);
    }

    object.lookAt(this._scratchCamPos);
  }
}
