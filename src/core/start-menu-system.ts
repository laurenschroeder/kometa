import {
  createSystem,
  Entity,
  Follower,
  FollowBehavior,
  Object3D,
  PanelDocument,
  PanelUI,
  RayInteractable,
  UIKit,
} from '@iwsdk/core';
import type { UIKitDocument } from '@iwsdk/core';
import { ACHIEVEMENTS } from './achievement-list.js';
import { isUnlocked } from './achievement-store.js';
import { GameDirectorSystem } from './game-director-system.js';
import { getGlobals } from './globals.js';

// "A few seconds" of continuous hover before a dwell button fires — one
// easy constant to retune.
const DWELL_SECONDS = 1.8;

// Start no longer uses a dwell button — pinching with BOTH hands at once
// (select on controllers, pinch on hand tracking — same gesture
// CometHandoffSystem/PhaseMenuSystem already rely on, see their own
// comments) starts the game. Held briefly rather than firing instantly so a
// single-frame overlap between two otherwise-unrelated pinches can't
// false-trigger it.
const DOUBLE_PINCH_HOLD_SECONDS = 0.35;
// Gentle pulse on the hint text while waiting — same "flash while inviting
// interaction" idiom as ConstellationsVfxSystem's untouched-star flash.
const START_HINT_PULSE_FREQ = 0.6; // Hz
const START_HINT_MIN_OPACITY = 0.45;

interface DwellButtonEntry {
  fillEl: UIKit.Component<any>;
  action: () => void;
}

// Gates the whole game behind starting the experience: the Achievements
// button normally uses a dwell-select interaction (hold your hand/
// controller ray over it, no trigger press, and its fill bar grows over
// DWELL_SECONDS; reaching full fires the action) — currently disabled (see
// the qualify callback below), still wired for Back/page navigation. Start
// is now a two-handed pinch gesture instead of a button (see
// DOUBLE_PINCH_HOLD_SECONDS) — hands off to
// GameDirectorSystem.start() and flips globals.gameStarted (so
// NotificationHudSystem's phase blurbs can begin — see its own comments).
export class StartMenuSystem extends createSystem({
  panel: { required: [PanelUI, PanelDocument] },
}) {
  private _director!: GameDirectorSystem;
  private _entity!: Entity;
  private _panelObject!: Object3D;
  private _buttons = new Map<string, DwellButtonEntry>();
  private _hoveredId: string | null = null;
  private _dwellElapsed = 0;
  private _triggered = false;

  private _startHintEl: UIKit.Component<any> | null = null;
  private _startAction: (() => void) | null = null;
  private _pinchHoldSeconds = 0;
  private _startTriggered = false;

  init(): void {
    // GameDirectorSystem must be registered before this system (see
    // index.ts) so it already exists when this init() runs.
    this._director = this.world.getSystem(GameDirectorSystem)!;

    const entity = this.world.createTransformEntity();
    this._entity = entity;
    this._panelObject = entity.object3D!;
    this._panelObject.visible = true;

    entity.addComponent(PanelUI, { config: '/ui/start-menu.json', maxWidth: 0.7, maxHeight: 0.6 });
    // View-locked, same as NotificationHudSystem — this is the first thing
    // the player sees, so it shouldn't require hunting around for it.
    entity.addComponent(Follower, {
      target: this.player.head,
      offsetPosition: [0, 0, -0.8],
      behavior: FollowBehavior.FaceTarget,
      tolerance: 0.02,
      speed: 6,
      maxAngle: 10,
    });
    // Required for controller-ray/canvas-pointer hit-testing (see
    // PhaseMenuSystem for the same requirement).
    entity.addComponent(RayInteractable);

    this.queries.panel.subscribe(
      'qualify',
      (panelEntity) => {
        // The query matches ANY [PanelUI, PanelDocument] entity in the
        // scene, not just this system's own (same caveat as
        // NotificationHudSystem) — ignore every qualify event except this
        // system's own entity.
        if (panelEntity.index !== entity.index) return;
        const doc = panelEntity.getValue(PanelDocument, 'document') as UIKitDocument;

        this._startHintEl = doc.getElementById('start-hint');
        this._startAction = () => {
          this._director.start();
          getGlobals(this.world).gameStarted.value = true;
          this._panelObject.visible = false;
          entity.removeComponent(RayInteractable);
        };

        // Disabled for now (not deleted — see class comment): no hover/dwell
        // listeners registered, so it just sits there inert; dimmed so it
        // visibly reads as inactive instead of looking clickable and
        // silently doing nothing. Re-enable by restoring the
        // _registerButton(doc, 'btn-achievements', ...) call this replaced.
        doc.getElementById('btn-achievements')?.setProperties({ opacity: 0.35 });

        this._registerButton(doc, 'btn-back', 'fill-back', () => {
          this._setPage(doc, 'page-main');
        });
      },
      true,
    );
  }

  update(delta: number, time: number): void {
    if (this._hoveredId && !this._triggered) {
      const entry = this._buttons.get(this._hoveredId);
      if (entry) {
        this._dwellElapsed += delta;
        const t = Math.min(1, this._dwellElapsed / DWELL_SECONDS);
        entry.fillEl.setProperties({ width: `${t * 100}%` });

        if (t >= 1) {
          this._triggered = true;
          entry.action();
        }
      }
    }

    this._updateStartPinch(delta, time);
  }

  // Both hands pinching (select) at once, held briefly, starts the game —
  // see DOUBLE_PINCH_HOLD_SECONDS's own comment.
  private _updateStartPinch(delta: number, time: number): void {
    if (this._startTriggered || !this._startAction) return;

    if (this._startHintEl) {
      const pulse = 0.5 + 0.5 * Math.sin(time * START_HINT_PULSE_FREQ * Math.PI * 2);
      const opacity = START_HINT_MIN_OPACITY + (1 - START_HINT_MIN_OPACITY) * pulse;
      this._startHintEl.setProperties({ opacity } as Record<string, unknown>);
    }

    const leftPinching = this.input.xr.gamepads.left?.getSelecting() ?? false;
    const rightPinching = this.input.xr.gamepads.right?.getSelecting() ?? false;

    if (leftPinching && rightPinching) {
      this._pinchHoldSeconds += delta;
      if (this._pinchHoldSeconds >= DOUBLE_PINCH_HOLD_SECONDS) {
        this._startTriggered = true;
        this._startAction();
      }
    } else {
      this._pinchHoldSeconds = 0;
    }
  }

  private _registerButton(
    doc: UIKitDocument,
    buttonId: string,
    fillId: string,
    action: () => void,
  ): void {
    const button = doc.getElementById(buttonId);
    const fill = doc.getElementById(fillId);
    if (!button || !fill) return;

    this._buttons.set(buttonId, { fillEl: fill, action });

    button.addEventListener('pointerenter', () => {
      if (this._hoveredId === buttonId) return;
      this._resetFill(this._hoveredId);
      this._hoveredId = buttonId;
      this._dwellElapsed = 0;
      this._triggered = false;
    });
    button.addEventListener('pointerleave', () => {
      if (this._hoveredId !== buttonId) return;
      this._resetFill(buttonId);
      this._hoveredId = null;
      this._dwellElapsed = 0;
      this._triggered = false;
    });
  }

  private _resetFill(buttonId: string | null): void {
    if (!buttonId) return;
    this._buttons.get(buttonId)?.fillEl.setProperties({ width: '0%' });
  }

  private _setPage(doc: UIKitDocument, visibleId: 'page-main' | 'page-achievements'): void {
    doc
      .getElementById('page-main')
      ?.setProperties({ display: visibleId === 'page-main' ? 'flex' : 'none' });
    doc.getElementById('page-achievements')?.setProperties({
      display: visibleId === 'page-achievements' ? 'flex' : 'none',
    });
  }

  // Re-shows this panel after GameDirectorSystem.returnToMenu() — called by
  // EndRunMenuSystem's "Main Menu" choice, the only path that reaches this
  // screen a second time (a fresh page load already starts with the panel
  // visible). The panel is only ever hidden by btn-start, which lives on
  // page-main, so it's always already showing that page when this runs.
  // Resets the dwell state too, so a hover left over from before the panel
  // was hidden can't insta-trigger the moment it reappears.
  showAgain(): void {
    this._hoveredId = null;
    this._dwellElapsed = 0;
    this._triggered = false;
    this._pinchHoldSeconds = 0;
    this._startTriggered = false;
    this._panelObject.visible = true;
    this._entity.addComponent(RayInteractable);
  }

  private _refreshAchievementRows(doc: UIKitDocument): void {
    for (const def of ACHIEVEMENTS) {
      const statusEl = doc.getElementById(`ach-status-${def.id}`);
      if (!statusEl) continue;
      const unlocked = isUnlocked(def.id);
      statusEl.setProperties({
        text: unlocked ? 'Unlocked' : 'Locked',
        color: unlocked ? '#4ade80' : '#71717a',
      } as Record<string, unknown>);
    }
  }
}
