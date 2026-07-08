import {
  createSystem,
  Entity,
  InputComponent,
  Object3D,
  Quaternion,
  Vector3,
} from '@iwsdk/core';
import { getGlobals } from '../core/globals.js';
import { CometBody } from './comet-body-component.js';
import { CometReleased, CometSnapped } from './comet-event-tags.js';
import { HandAnchor, HandSide } from './hand-anchor-component.js';

// Speed (m/s) that reads as "full" momentum (1.0) on globals.cometMomentum —
// a tuning knob for audio/gameplay reactivity, not part of the physics model.
const MOMENTUM_REFERENCE_SPEED = 3.0;

// The reusable spring-joint mechanic — extracted from the original
// comet-system.ts prototype's _step(), generalized to run over any number of
// {CometBody, HandAnchor} entities instead of two hardcoded hands. Always
// registered, never phase-gated: every chapter recontextualizes this same
// physics by attaching CometBody with different tuning, not by duplicating it.
export class CometPhysicsSystem extends createSystem({
  bodies: { required: [CometBody, HandAnchor] },
}) {
  private _handPos!: Vector3;
  private _palmOffset!: Vector3;
  private _gripQuat!: Quaternion;
  private _anchor!: Vector3;
  private _spring!: Vector3;
  private _gravityVec!: Vector3;
  private _pos!: Vector3;
  private _vel!: Vector3;
  private _prevHand!: Vector3;

  init() {
    this._handPos = new Vector3();
    this._palmOffset = new Vector3();
    this._gripQuat = new Quaternion();
    this._anchor = new Vector3();
    this._spring = new Vector3();
    this._gravityVec = new Vector3();
    this._pos = new Vector3();
    this._vel = new Vector3();
    this._prevHand = new Vector3();
  }

  update(delta: number): void {
    let speedSqSum = 0;
    let count = 0;
    for (const entity of this.queries.bodies.entities) {
      speedSqSum += this._step(entity, delta);
      count++;
    }
    if (count > 0) {
      const globals = getGlobals(this.world);
      const avgSpeed = Math.sqrt(speedSqSum / count);
      globals.cometMomentum.value = Math.min(1, avgSpeed / MOMENTUM_REFERENCE_SPEED);
    }
  }

  private _step(entity: Entity, dt: number): number {
    // Clear last frame's edge tags before evaluating this frame's transitions
    // — keeps CometSnapped/CometReleased present for exactly one frame so
    // subscribers (achievements, audio) see a discrete edge, not a held state.
    if (entity.hasComponent(CometSnapped)) entity.removeComponent(CometSnapped);
    if (entity.hasComponent(CometReleased)) entity.removeComponent(CometReleased);

    const hand = entity.getValue(HandAnchor, 'hand');
    const palmOffsetZ = entity.getValue(HandAnchor, 'palmOffsetZ') as number;
    const grip: Object3D =
      hand === HandSide.Right ? this.player.gripSpaces.right : this.player.gripSpaces.left;
    const gamepad =
      hand === HandSide.Right ? this.input.xr.gamepads.right : this.input.xr.gamepads.left;
    const flexion = gamepad?.getButtonValue(InputComponent.Squeeze) ?? 0;

    grip.getWorldPosition(this._handPos);
    grip.getWorldQuaternion(this._gripQuat);
    this._palmOffset.set(0, 0, palmOffsetZ).applyQuaternion(this._gripQuat);
    this._handPos.add(this._palmOffset);

    const posView = entity.getVectorView(CometBody, 'position') as Float32Array;
    const velView = entity.getVectorView(CometBody, 'velocity') as Float32Array;
    const prevHandView = entity.getVectorView(CometBody, 'prevHand') as Float32Array;
    this._pos.fromArray(posView);
    this._vel.fromArray(velView);
    this._prevHand.fromArray(prevHandView);

    // Grip spaces resolve to world origin before an immersive session is
    // actually active — this system registers at world creation, well before
    // the user accepts the XR session, so the first real frame snaps
    // position/prevHand directly to the hand instead of springing up from
    // the origin default (see comet-system.ts history for the "flies in
    // from below" bug this avoids).
    const initialized = entity.getValue(CometBody, 'initialized');
    if (!initialized && this.world.session) {
      this._pos.copy(this._handPos);
      this._prevHand.copy(this._handPos);
      entity.setValue(CometBody, 'initialized', true);
    }

    const snapThreshold = entity.getValue(CometBody, 'snapThreshold') as number;
    const wasSnapped = entity.getValue(CometBody, 'wasSnapped') as boolean;

    if (flexion >= snapThreshold) {
      this._vel.copy(this._handPos).sub(this._prevHand);
      if (dt > 0) this._vel.divideScalar(dt);
      else this._vel.setScalar(0);
      this._pos.copy(this._handPos);
      this._prevHand.copy(this._handPos);
      if (!wasSnapped) entity.addComponent(CometSnapped);
      entity.setValue(CometBody, 'wasSnapped', true);
      this._writeBack(posView, velView, prevHandView);
      return this._vel.lengthSq();
    }

    if (wasSnapped) {
      const throwMult = entity.getValue(CometBody, 'throwMult') as number;
      this._vel.multiplyScalar(throwMult);
      entity.setValue(CometBody, 'wasSnapped', false);
      entity.addComponent(CometReleased);
    }
    this._prevHand.copy(this._handPos);

    const springStrength = entity.getValue(CometBody, 'springStrength') as number;
    const damping = entity.getValue(CometBody, 'damping') as number;
    const gravityScale = entity.getValue(CometBody, 'gravityScale') as number;

    const restOffset = gravityScale / Math.max(springStrength, 0.001);
    this._anchor.copy(this._handPos);
    this._anchor.y += restOffset;
    this._spring.copy(this._anchor).sub(this._pos).multiplyScalar(springStrength);
    this._gravityVec.set(0, -gravityScale, 0);
    this._vel.addScaledVector(this._spring, dt);
    this._vel.addScaledVector(this._gravityVec, dt);
    this._vel.multiplyScalar(Math.exp(-damping * dt));
    this._pos.addScaledVector(this._vel, dt);

    if (flexion > 0) {
      const t = flexion * flexion;
      this._pos.lerp(this._handPos, t);
      this._vel.multiplyScalar(1 - t);
    }

    this._writeBack(posView, velView, prevHandView);
    return this._vel.lengthSq();
  }

  private _writeBack(
    posView: Float32Array,
    velView: Float32Array,
    prevHandView: Float32Array,
  ): void {
    this._pos.toArray(posView);
    this._vel.toArray(velView);
    this._prevHand.toArray(prevHandView);
  }
}
