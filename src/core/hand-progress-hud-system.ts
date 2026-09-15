import {
  createSystem,
  Entity,
  Matrix4,
  Object3D,
  PanelDocument,
  PanelUI,
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
import type { HexColor } from '../vfx/color/color-scheme.js';
import {
  FATE_THRONE_DIALOGUE,
  MOON,
  ORBIT,
  PROGRESS_HALO_WARM,
  STARDUST,
  WHITE,
  lerpHex,
} from '../vfx/color/color-scheme.js';
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

// Anchored to the hand-tracking `wrist` joint when hands are tracked. The
// grip space's origin sits at the palm centroid, which is what kept putting
// this panel over the hand. In WebXR's joint/grip convention -Z points toward
// the fingers, so +Z runs back up the forearm toward the elbow.
//
// "On top of the wrist from whatever side you look": the lift direction is
// the wrist->camera vector with its along-forearm component removed, so the
// panel hovers on whichever side of the wrist faces the viewer — never
// behind the hand or arm, regardless of wrist roll or viewing angle.
const WRIST_TOWARD_ELBOW_OFFSET = 0.025; // up the forearm from the wrist joint, where a watch sits
const WRIST_LIFT_OFFSET = 0.055; // off the wrist's surface, toward the viewer
// Controllers have no wrist joint — approximate it this far back from the
// grip (palm) origin along the same +Z forearm axis.
const CONTROLLER_GRIP_TO_WRIST = 0.06;
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
// Small identity-color dot beside the label (purely decorative — the fill
// itself stays a plain neutral color regardless of phase). Pebbles gets
// neutral WHITE since that bar already carries its own three-color segment
// identity (see the showSegments branch in update()).
const GLYPH_COLOR_BY_PHASE: Partial<Record<Phase, HexColor>> = {
  [Phase.Stardust]: STARDUST,
  [Phase.Pebbles]: WHITE,
  [Phase.Seeding]: MOON,
  [Phase.FateEvents]: FATE_THRONE_DIALOGUE,
  [Phase.Launch]: ORBIT,
};

// Near-completion halo on the track border — plain white until the phase is
// mostly done, then eases toward PROGRESS_HALO_WARM over the last stretch.
const HALO_WARM_START_PERCENT = 85;
const HALO_BASE_COLOR: HexColor = '#ffffff';
const HALO_STEPS = 10; // quantized so the halo only writes ~10 times per ramp, not every frame

// Sparkle dots along the track, unlocked once overall progress passes their
// position and blinking gently after that — same sine-pulse idiom as
// StartMenuSystem's hint-text pulse, just three staggered instances so they
// don't blink in lockstep.
const SPARKLE_THRESHOLD_PERCENT = [20, 50, 80];
const SPARKLE_FREQ_HZ = [0.9, 1.3, 1.6];
const SPARKLE_PHASE = [0, 2.1, 4.4]; // radians, arbitrary stagger
const SPARKLE_MIN_OPACITY = 0.15;
const SPARKLE_MAX_OPACITY = 0.9;

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
//  - Pebbles: PebbleWeavingSystem.getTypeProgress01() per type, rendered as
//    three stacked color segments rather than getProgress01()'s single
//    combined fraction (see the segment-toggle block in update() below)
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
  private _pebblesFillEl: UIKit.Component<any> | null = null;
  private _segEls: (UIKit.Component<any> | null)[] = [null, null, null];
  private _labelEl: UIKit.Component<any> | null = null;
  private _glyphEl: UIKit.Component<any> | null = null;
  private _trackEl: UIKit.Component<any> | null = null;
  private _sparkleEls: (UIKit.Component<any> | null)[] = [null, null, null];
  private _lastLabel: string | null = null;
  private _lastFillPercent = -1;
  private _lastSegPercent: number[] = [-1, -1, -1];
  private _lastShowSegments: boolean | null = null;
  private _lastHaloStep = -1;
  private _sparkleUnlocked: boolean[] = [false, false, false];
  private _hasPosition = false;

  private _stardust!: StardustSystem;
  private _pebbles!: PebbleWeavingSystem;
  private _seeding!: PlanetSeedingSystem;
  private _fateEvents!: FateEventSystem;
  private _launch!: OrbitalLaunchSystem;

  private _scratchWristMat = new Matrix4();
  private _scratchWrist = new Vector3();
  private _scratchForearm = new Vector3();
  private _scratchToCam = new Vector3();
  private _scratchTarget = new Vector3();
  private _scratchCamPos = new Vector3();

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
        this._pebblesFillEl = doc.getElementById('wrist-bar-fill-pebbles');
        this._segEls = [
          doc.getElementById('wrist-bar-seg-0'),
          doc.getElementById('wrist-bar-seg-1'),
          doc.getElementById('wrist-bar-seg-2'),
        ];
        this._labelEl = doc.getElementById('wrist-label');
        this._glyphEl = doc.getElementById('wrist-phase-glyph');
        this._trackEl = doc.getElementById('wrist-bar-track');
        this._sparkleEls = [
          doc.getElementById('wrist-sparkle-0'),
          doc.getElementById('wrist-sparkle-1'),
          doc.getElementById('wrist-sparkle-2'),
        ];
      },
      true,
    );
  }

  update(delta: number, time: number): void {
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
    const side = offHand === HandSide.Right ? 'right' : 'left';
    const grip = this.player.gripSpaces[side];
    grip.updateWorldMatrix(true, false);
    this.camera.getWorldPosition(this._scratchCamPos);

    // Joint poses are filled relative to the same grip XRSpace that posed
    // `grip` (see XRHandVisualAdapter.update). Joint 0 is `wrist` — XRHand
    // iterates joints in XRHandJoint enum order.
    const xrInput = this.input.xr;
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

    // Pebbles gets a stacked, per-type fill (see PebbleWeavingSystem.
    // getTypeProgress01's own comment) instead of the single solid bar
    // every other phase uses — a running visual tally of the actual mix
    // gathered, not just an undifferentiated total.
    const showSegments = phase === Phase.Pebbles;
    if (showSegments !== this._lastShowSegments) {
      this._lastShowSegments = showSegments;
      this._fillEl?.setProperties({ display: showSegments ? 'none' : 'flex' });
      this._pebblesFillEl?.setProperties({ display: showSegments ? 'flex' : 'none' });
    }

    if (showSegments) {
      for (let type = 0; type < 3; type++) {
        const percent = Math.round(clamp01(this._pebbles.getTypeProgress01(type)) * 100);
        if (percent !== this._lastSegPercent[type]) {
          this._lastSegPercent[type] = percent;
          this._segEls[type]?.setProperties({ width: `${percent}%` });
        }
      }
    } else {
      const progress01 = clamp01(this._getProgress01(phase));
      const percent = Math.round(progress01 * 100);
      if (percent !== this._lastFillPercent) {
        this._lastFillPercent = percent;
        this._fillEl?.setProperties({ width: `${percent}%` });
      }
    }

    // Overall completion for this phase regardless of which fill variant is
    // showing — PebbleWeavingSystem.getProgress01() (see _getProgress01)
    // still returns its single combined fraction even while the bar itself
    // renders the three-type segment breakdown above.
    const overallPercent = Math.round(clamp01(this._getProgress01(phase)) * 100);

    const haloT = clamp01((overallPercent - HALO_WARM_START_PERCENT) / (100 - HALO_WARM_START_PERCENT));
    const haloStep = Math.round(haloT * HALO_STEPS);
    if (haloStep !== this._lastHaloStep) {
      this._lastHaloStep = haloStep;
      this._trackEl?.setProperties({
        borderColor: lerpHex(HALO_BASE_COLOR, PROGRESS_HALO_WARM, haloStep / HALO_STEPS),
      });
    }

    for (let i = 0; i < 3; i++) {
      const unlocked = overallPercent >= SPARKLE_THRESHOLD_PERCENT[i];
      if (unlocked) {
        this._sparkleUnlocked[i] = true;
        const blinkT = 0.5 + 0.5 * Math.sin(time * SPARKLE_FREQ_HZ[i] * Math.PI * 2 + SPARKLE_PHASE[i]);
        const opacity = SPARKLE_MIN_OPACITY + (SPARKLE_MAX_OPACITY - SPARKLE_MIN_OPACITY) * blinkT;
        this._sparkleEls[i]?.setProperties({ opacity });
      } else if (this._sparkleUnlocked[i]) {
        this._sparkleUnlocked[i] = false;
        this._sparkleEls[i]?.setProperties({ opacity: 0 });
      }
    }

    const label = LABEL_BY_PHASE[phase] ?? '';
    if (label !== this._lastLabel) {
      this._lastLabel = label;
      this._labelEl?.setProperties({ text: label } as Record<string, unknown>);
      this._glyphEl?.setProperties({ backgroundColor: GLYPH_COLOR_BY_PHASE[phase] ?? WHITE });
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
