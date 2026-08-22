import {
  createSystem,
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

interface DwellButtonEntry {
  fillEl: UIKit.Component<any>;
  action: () => void;
}

// Gates the whole game behind Start/Achievements dwell-select buttons: hold
// your hand/controller ray over a button (no trigger press) and its fill
// bar grows over DWELL_SECONDS; reaching full fires the action. Start hands
// off to GameDirectorSystem.start() and flips globals.gameStarted (so
// NotificationHudSystem's phase blurbs can begin — see its own comments);
// Achievements swaps to a locked/unlocked list read from achievement-store.
export class StartMenuSystem extends createSystem({
  panel: { required: [PanelUI, PanelDocument] },
}) {
  private _director!: GameDirectorSystem;
  private _panelObject!: Object3D;
  private _buttons = new Map<string, DwellButtonEntry>();
  private _hoveredId: string | null = null;
  private _dwellElapsed = 0;
  private _triggered = false;

  init(): void {
    // GameDirectorSystem must be registered before this system (see
    // index.ts) so it already exists when this init() runs.
    this._director = this.world.getSystem(GameDirectorSystem)!;

    const entity = this.world.createTransformEntity();
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

        this._registerButton(doc, 'btn-start', 'fill-start', () => {
          this._director.start();
          getGlobals(this.world).gameStarted.value = true;
          this._panelObject.visible = false;
          entity.removeComponent(RayInteractable);
        });
        this._registerButton(doc, 'btn-achievements', 'fill-achievements', () => {
          this._refreshAchievementRows(doc);
          this._setPage(doc, 'page-achievements');
        });
        this._registerButton(doc, 'btn-back', 'fill-back', () => {
          this._setPage(doc, 'page-main');
        });
      },
      true,
    );
  }

  update(delta: number): void {
    if (!this._hoveredId || this._triggered) return;
    const entry = this._buttons.get(this._hoveredId);
    if (!entry) return;

    this._dwellElapsed += delta;
    const t = Math.min(1, this._dwellElapsed / DWELL_SECONDS);
    entry.fillEl.setProperties({ width: `${t * 100}%` });

    if (t >= 1) {
      this._triggered = true;
      entry.action();
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
