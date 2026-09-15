import { createSystem, Entity, Object3D, Quaternion, Vector3 } from '@iwsdk/core';
import { AchievementSystem } from '../core/achievement-system.js';
import { CometBody } from './comet-body-component.js';
import { CometCaught } from './comet-event-tags.js';
import { HandAnchor, HandSide } from './hand-anchor-component.js';

// How long only one hand may be tracked before the comet drifts over to it —
// long enough that briefly dropping a hand out of the headset's view doesn't
// yank the comet around, short enough to feel responsive.
const PASSIVE_SWITCH_SECONDS = 2.0;
// How close the OTHER hand must be to the comet's current position to
// "catch" it when selecting — a toss/catch handoff, not a passive drift.
const CATCH_RADIUS = 0.25;

function otherHand(hand: string): string {
  return hand === HandSide.Right ? HandSide.Left : HandSide.Right;
}

// There is exactly one comet (see the single {CometBody, HandAnchor,
// CometTrail} entity created in index.ts) — it defaults to the right hand
// and switches which hand it follows in two ways:
//  1. Passive drift: if only one hand has live tracking for
//     PASSIVE_SWITCH_SECONDS, the comet eases over to it. CometPhysicsSystem
//     already re-reads HandAnchor.hand fresh every frame and its spring
//     never teleports, so flipping that value alone produces a smooth drift
//     for free — no interpolation needed here.
//  2. Toss/catch: bring the OTHER hand near the comet and select (trigger on
//     controllers, pinch on hand tracking — NOT squeeze: hand-tracking
//     profiles in this SDK never register an xr-standard-squeeze component,
//     so getButtonValue(Squeeze) is structurally always 0 for hands; select
//     is the one gesture guaranteed to exist on every profile, same reason
//     PhaseMenuSystem's dev-menu pinch already relies on it), and the comet
//     catches over to it immediately — a deliberate handoff, not a drift.
// Must run before CometPhysicsSystem (see priority in index.ts) so a switch
// decided this frame is what physics follows this same frame.
export class CometHandoffSystem extends createSystem({
  bodies: { required: [CometBody, HandAnchor] },
}) {
  private _entity: Entity | null = null;
  private _soloHandSeconds = 0;
  private _soloHandSide: string | null = null;

  private _gripPos!: Vector3;
  private _gripQuat!: Quaternion;
  private _palmOffset!: Vector3;
  private _cometPos!: Vector3;

  init(): void {
    this._gripPos = new Vector3();
    this._gripQuat = new Quaternion();
    this._palmOffset = new Vector3();
    this._cometPos = new Vector3();

    this.queries.bodies.subscribe(
      'qualify',
      (entity) => {
        this._entity = entity;
      },
      true,
    );
    this.queries.bodies.subscribe('disqualify', (entity) => {
      if (this._entity === entity) this._entity = null;
    });
  }

  update(delta: number): void {
    if (!this._entity) return;
    const entity = this._entity;
    // Clear last frame's edge tag before evaluating this frame's transitions
    // — same idiom CometPhysicsSystem uses for CometSnapped/CometReleased,
    // just owned here since this is the only place CometCaught is ever set.
    if (entity.hasComponent(CometCaught)) entity.removeComponent(CometCaught);
    const currentHand = entity.getValue(HandAnchor, 'hand') as string;

    const leftPresent = this.input.xr.gamepads.left !== undefined;
    const rightPresent = this.input.xr.gamepads.right !== undefined;

    let onlyPresent: string | null = null;
    if (leftPresent && !rightPresent) onlyPresent = HandSide.Left;
    else if (rightPresent && !leftPresent) onlyPresent = HandSide.Right;

    if (onlyPresent !== null && onlyPresent !== currentHand) {
      if (this._soloHandSide === onlyPresent) {
        this._soloHandSeconds += delta;
      } else {
        this._soloHandSide = onlyPresent;
        this._soloHandSeconds = 0;
      }
      if (this._soloHandSeconds >= PASSIVE_SWITCH_SECONDS) {
        this._switchTo(entity, onlyPresent);
        this._soloHandSeconds = 0;
        this._soloHandSide = null;
      }
      return;
    }
    this._soloHandSeconds = 0;
    this._soloHandSide = null;

    // Toss/catch: does the hand NOT currently holding the comet select
    // while close enough to reach it?
    const catcher = otherHand(currentHand);
    const catcherGamepad =
      catcher === HandSide.Right ? this.input.xr.gamepads.right : this.input.xr.gamepads.left;
    if (!catcherGamepad?.getSelecting()) return;

    const catcherGrip: Object3D =
      catcher === HandSide.Right ? this.player.gripSpaces.right : this.player.gripSpaces.left;
    catcherGrip.getWorldPosition(this._gripPos);

    const posView = entity.getVectorView(CometBody, 'position') as Float32Array;
    this._cometPos.fromArray(posView);

    if (this._gripPos.distanceToSquared(this._cometPos) <= CATCH_RADIUS * CATCH_RADIUS) {
      this._switchTo(entity, catcher);
      entity.addComponent(CometCaught);
      // Deliberate toss/catch only — NOT the passive-drift branch above
      // (which also calls _switchTo), since that isn't something the player
      // actually chose to do.
      this.world.getSystem(AchievementSystem)?.unlock('ambidextrous');
    }
  }

  private _switchTo(entity: Entity, hand: string): void {
    // Snap CometBody.prevHand to the new hand's current position so
    // CometPhysicsSystem's snap-grab velocity calc (handPos - prevHand)/dt
    // never sees a spurious jump between the old and new hand's positions —
    // cheap insurance in case a squeeze-triggered snap and a hand switch
    // ever land on the same frame, even though the switch triggers here are
    // select-driven, not squeeze-driven.
    const grip: Object3D = hand === HandSide.Right ? this.player.gripSpaces.right : this.player.gripSpaces.left;
    const palmOffsetZ = entity.getValue(HandAnchor, 'palmOffsetZ') as number;
    grip.getWorldPosition(this._gripPos);
    grip.getWorldQuaternion(this._gripQuat);
    this._palmOffset.set(0, 0, palmOffsetZ).applyQuaternion(this._gripQuat);
    this._gripPos.add(this._palmOffset);

    // Vec3 fields must be written via getVectorView, not setValue (setValue
    // throws for array/vector types) — same pattern CometPhysicsSystem
    // itself uses for this same field.
    const prevHandView = entity.getVectorView(CometBody, 'prevHand') as Float32Array;
    this._gripPos.toArray(prevHandView);
    entity.setValue(HandAnchor, 'hand', hand);
  }
}
