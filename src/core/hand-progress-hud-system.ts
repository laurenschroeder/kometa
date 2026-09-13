import {
  createSystem,
  Entity,
  Object3D,
  PanelDocument,
  PanelUI,
  Quaternion,
  UIKit,
  Vector3,
} from '@iwsdk/core';
import type { UIKitDocument } from '@iwsdk/core';
import { CometBody } from '../comet/comet-body-component.js';
import { HandAnchor, HandSide } from '../comet/hand-anchor-component.js';
import { FateEventSystem } from '../phases/fate-events/fate-event-system.js';
import { OrbitalLaunchSystem } from '../phases/orbital-launch/orbital-launch-system.js';
import { PebbleWeavingSystem } from '../phases/pebbles/pebble-weaving-system.js';
import { PlanetSeedingSystem } from '../phases/planet-seeding/planet-seeding-system.js';
import { StardustSystem } from '../phases/stardust/stardust-system.js';
import { getGlobals } from './globals.js';
import { Phase } from './phase.js';

// Kill switch — flip to false to disable this whole HUD without ripping the
// feature out (the panel/systems below are still fully built either way,
// just never shown while this is false). The feature is otherwise
// self-contained to this one file plus ui/hand-progress.uikitml and its own
// registerSystem(HandProgressHudSystem) call in index.ts, so deleting all
// three is a clean, complete removal if it's ever cut for good rather than
// just toggled off.
export const HAND_PROGRESS_HUD_ENABLED = true;

// A fixed local-space offset off the grip rotates WITH the hand, so it
// reliably clears the hand mesh only for whatever one wrist roll happens to
// point that offset away from the palm — for every other roll it ends up
// pointing back into/behind the hand, invisible until the player happens to
// turn palm-up. Real wrist devices don't have this problem because you only
// ever look at them once you've already rolled your wrist to expose the
// back of your hand — so instead of a fixed offset, the panel's rise
// distance off the grip's own local up axis (see WRIST_UP_AXIS's own
// comment) is DRIVEN by how much that same "back of hand" axis currently
// faces the camera: barely raised at rest, rising into full view as the
// player rotates their wrist palm-away to actually check it.
const WRIST_UP_AXIS = new Vector3(0, 1, 0);
const WRIST_RISE_MIN = 0.03; // resting height — most wrist rolls, not being looked at
const WRIST_RISE_MAX = 0.11; // fully raised — palm rolled away, back of hand facing the player
// Small offset along the grip's local forward/back axis so the panel sits
// off the exact grip pivot (roughly wrist-ward) rather than centered in the
// palm.
const WRIST_FORWARD_OFFSET = -0.015;
// Fast catch-up ease (same "reads as locked, not laggy" idiom
// NotificationHudSystem's own Follower tuning uses) — smooths raw
// hand-tracking jitter without introducing visible lag as the off-hand
// moves around, and doubles as the ease on the rise amount itself so it
// glides up rather than snapping the instant the wrist rolls far enough.
const POSITION_EASE_RATE = 14;

const PHASES_WITH_PROGRESS = new Set<Phase>([
  Phase.Stardust,
  Phase.Pebbles,
  Phase.Seeding,
  Phase.FateEvents,
  Phase.Launch,
]);
// What each phase's bar actually measures — see this file's own class
// comment for the per-phase progress source.
const LABEL_BY_PHASE: Partial<Record<Phase, string>> = {
  [Phase.Stardust]: 'Stardust',
  [Phase.Pebbles]: 'Pebbles',
  [Phase.Seeding]: 'Surface Seeded',
  [Phase.FateEvents]: 'Collected',
  [Phase.Launch]: 'Destiny',
};

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

// A small wrist-mounted progress bar, worn on whichever hand ISN'T currently
// holding the comet (see CometHandoffSystem for how that hand can change
// mid-phase) — always visible somewhere in view without occupying the hand
// actually doing the swinging. Shows one phase-specific completion metric,
// each read live from that phase's own gameplay system rather than
// duplicating any win-condition math here:
//  - Stardust: StardustSystem.getProgress01() (gather + swirl stages)
//  - Pebbles: PebbleWeavingSystem.getProgress01() (fraction of WIN_CAPTURE_COUNT)
//  - Seeding: PlanetSeedingSystem.getProgress01() (fraction of the coverage win threshold)
//  - Fate Events: FateEventSystem.getCollectProgress01() (Beat 4's per-type visit/capture metric)
//  - Launch: OrbitalLaunchSystem.getDestinyProgress01() (live charge-up, same value driving the zone's own scale ramp)
// Hidden entirely outside those five phases (Constellations has no single
// gatherable-style metric, Finale/ArtTest aren't relevant) and before the
// game has actually started. Always-on (never GameDirector-managed) so it
// can freely read across phase boundaries, same idiom as
// NotificationHudSystem/AchievementSystem.
export class HandProgressHudSystem extends createSystem({
  panel: { required: [PanelUI, PanelDocument] },
  comet: { required: [CometBody, HandAnchor] },
}) {
  private _entity!: Entity;
  private _panelObject!: Object3D;
  private _fillEl: UIKit.Component<any> | null = null;
  private _labelEl: UIKit.Component<any> | null = null;
  private _lastLabel: string | null = null;
  private _lastFillPercent = -1;
  private _hasPosition = false;

  private _stardust!: StardustSystem;
  private _pebbles!: PebbleWeavingSystem;
  private _seeding!: PlanetSeedingSystem;
  private _fateEvents!: FateEventSystem;
  private _launch!: OrbitalLaunchSystem;

  private _scratchGripPos = new Vector3();
  private _scratchGripQuat = new Quaternion();
  private _scratchOffset = new Vector3();
  private _scratchForward = new Vector3();
  private _scratchTarget = new Vector3();
  private _scratchCamPos = new Vector3();
  private _scratchBackOfHand = new Vector3();
  private _scratchToCam = new Vector3();

  init(): void {
    // Every phase system this looks up must already be registered (see
    // index.ts) by the time this system's own init() runs.
    this._stardust = this.world.getSystem(StardustSystem)!;
    this._pebbles = this.world.getSystem(PebbleWeavingSystem)!;
    this._seeding = this.world.getSystem(PlanetSeedingSystem)!;
    this._fateEvents = this.world.getSystem(FateEventSystem)!;
    this._launch = this.world.getSystem(OrbitalLaunchSystem)!;

    const entity = this.world.createTransformEntity();
    this._entity = entity;
    this._panelObject = entity.object3D!;
    this._panelObject.visible = false;

    entity.addComponent(PanelUI, { config: '/ui/hand-progress.json', maxWidth: 0.16, maxHeight: 0.05 });

    this.queries.panel.subscribe(
      'qualify',
      (panelEntity) => {
        // The query matches ANY [PanelUI, PanelDocument] entity in the scene,
        // not just this system's own — same guard every other panel system
        // here uses.
        if (panelEntity.index !== entity.index) return;
        const doc = panelEntity.getValue(PanelDocument, 'document') as UIKitDocument;
        this._fillEl = doc.getElementById('wrist-bar-fill');
        this._labelEl = doc.getElementById('wrist-label');
      },
      true,
    );
  }

  update(delta: number): void {
    if (!HAND_PROGRESS_HUD_ENABLED) {
      this._panelObject.visible = false;
      return;
    }

    const globals = getGlobals(this.world);
    const phase = globals.gamePhase.peek();

    if (!globals.gameStarted.peek() || !PHASES_WITH_PROGRESS.has(phase)) {
      this._panelObject.visible = false;
      this._hasPosition = false;
      return;
    }

    let cometHand: string | null = null;
    for (const entity of this.queries.comet.entities) {
      cometHand = entity.getValue(HandAnchor, 'hand') as string;
    }
    if (!cometHand) {
      this._panelObject.visible = false;
      this._hasPosition = false;
      return;
    }

    const offHand = cometHand === HandSide.Right ? HandSide.Left : HandSide.Right;
    const grip = offHand === HandSide.Right ? this.player.gripSpaces.right : this.player.gripSpaces.left;
    grip.getWorldPosition(this._scratchGripPos);
    grip.getWorldQuaternion(this._scratchGripQuat);
    this.camera.getWorldPosition(this._scratchCamPos);

    // How much the grip's local "back of hand" axis (see WRIST_UP_AXIS's own
    // comment/PhaseMenuSystem's matching flip-detection) currently faces the
    // camera — 1 when the player has rolled their wrist palm-away to look at
    // it head-on, down toward 0 (clamped, since a negative dot just means
    // "palm is facing the player instead") the rest of the time.
    this._scratchBackOfHand.copy(WRIST_UP_AXIS).applyQuaternion(this._scratchGripQuat);
    this._scratchToCam.copy(this._scratchCamPos).sub(this._scratchGripPos).normalize();
    const facing = clamp01(this._scratchBackOfHand.dot(this._scratchToCam));

    const rise = WRIST_RISE_MIN + facing * (WRIST_RISE_MAX - WRIST_RISE_MIN);
    this._scratchOffset.copy(this._scratchBackOfHand).multiplyScalar(rise);
    this._scratchForward.set(0, 0, WRIST_FORWARD_OFFSET).applyQuaternion(this._scratchGripQuat);
    this._scratchTarget.copy(this._scratchGripPos).add(this._scratchOffset).add(this._scratchForward);

    if (!this._hasPosition) {
      this._panelObject.position.copy(this._scratchTarget);
      this._hasPosition = true;
    } else {
      const pull = 1 - Math.exp(-POSITION_EASE_RATE * delta);
      this._panelObject.position.lerp(this._scratchTarget, pull);
    }

    // Billboard toward the camera — same "readable regardless of how the
    // wrist happens to be turned" reasoning every other HUD/bubble element
    // in this codebase already uses, rather than rigidly rotating with the
    // hand's own (often awkward, mid-swing) orientation.
    this._panelObject.lookAt(this._scratchCamPos);
    this._panelObject.visible = true;

    const progress01 = clamp01(this._getProgress01(phase));
    const percent = Math.round(progress01 * 100);
    if (percent !== this._lastFillPercent) {
      this._lastFillPercent = percent;
      this._fillEl?.setProperties({ width: `${percent}%` });
    }

    const label = LABEL_BY_PHASE[phase] ?? '';
    if (label !== this._lastLabel) {
      this._lastLabel = label;
      this._labelEl?.setProperties({ text: label } as Record<string, unknown>);
    }
  }

  private _getProgress01(phase: Phase): number {
    switch (phase) {
      case Phase.Stardust:
        return this._stardust.getProgress01();
      case Phase.Pebbles:
        return this._pebbles.getProgress01();
      case Phase.Seeding:
        return this._seeding.getProgress01();
      case Phase.FateEvents:
        return this._fateEvents.getCollectProgress01();
      case Phase.Launch:
        return this._launch.getDestinyProgress01();
      default:
        return 0;
    }
  }
}
