import {
  createSystem,
  Entity,
  Follower,
  FollowBehavior,
  Object3D,
  PanelDocument,
  PanelUI,
  RayInteractable,
} from '@iwsdk/core';
import type { UIKit, UIKitDocument } from '@iwsdk/core';
import { resetAchievements } from './achievement-store.js';
import { GameDirectorSystem } from './game-director-system.js';
import { getGlobals } from './globals.js';
import { Phase } from './phase.js';
import { NotificationHudSystem } from './notification-hud-system.js';

// How long the left-hand select must be held before the menu toggles —
// was instant-on-press (getSelectStart()), which was too easy to trigger by
// accident.
const MENU_HOLD_SECONDS = 1.5;

const PHASE_BUTTONS: [buttonId: string, phase: Phase][] = [
  ['btn-stardust', Phase.Stardust],
  ['btn-pebbles', Phase.Pebbles],
  ['btn-seeding', Phase.Seeding],
  ['btn-constellations', Phase.Constellations],
  ['btn-fate-events', Phase.FateEvents],
  ['btn-launch', Phase.Launch],
  ['btn-finale', Phase.Finale],
];

// Dev/debug menu: left-hand select (trigger on controllers, pinch on hand
// tracking — unused by any other mechanic today, see the "universal menu"
// discussion) toggles a wrist-height panel in front of the player with a
// button per phase, jumping straight there via GameDirectorSystem.
// jumpToPhase() rather than waiting on win conditions/timeouts.
export class PhaseMenuSystem extends createSystem({
  panel: { required: [PanelUI, PanelDocument] },
}) {
  private _director!: GameDirectorSystem;
  private _entity!: Entity;
  private _panelObject!: Object3D;
  private _open = false;
  private _speedEl: UIKit.Component<any> | null = null;
  private _avgSpeedEl: UIKit.Component<any> | null = null;
  private _speedSum = 0;
  private _speedSamples = 0;
  private _selectHoldSeconds = 0;
  private _selectTriggered = false;

  init(): void {
    // GameDirectorSystem must be registered before this system (see
    // index.ts) so it already exists when this init() runs.
    this._director = this.world.getSystem(GameDirectorSystem)!;

    // Average speed is scoped to "this phase" — reset on every transition,
    // regardless of whether the debug panel is open at the time.
    this.cleanupFuncs.push(
      getGlobals(this.world).gamePhase.subscribe(() => {
        this._speedSum = 0;
        this._speedSamples = 0;
      }),
    );

    const entity = this.world.createTransformEntity();
    this._entity = entity;
    // createTransformEntity() always attaches an Object3D (an empty one when
    // none is passed in), so this is never actually undefined at runtime.
    this._panelObject = entity.object3D!;
    this._panelObject.visible = false;

    entity.addComponent(PanelUI, { config: '/ui/phase-menu.json', maxWidth: 0.4, maxHeight: 0.5 });
    entity.addComponent(Follower, {
      target: this.player.head,
      offsetPosition: [0.15, -0.05, -0.5],
      behavior: FollowBehavior.PivotY,
    });
    // RayInteractable is deliberately NOT added here — InputSystem raycasts
    // against any RayInteractable entity regardless of Object3D.visible (it
    // doesn't check visibility at all), so if this were added unconditionally
    // the closed-but-still-tagged panel would silently sit in front of
    // whatever else the player is trying to click (this is exactly what
    // happened: the panel's offset [0.15,-0.05,-0.5] put it closer to the
    // camera than the Start Menu at [0,0,-0.8], intercepting its ray while
    // completely invisible). Add/remove it in lockstep with _setOpen below
    // instead.

    this.queries.panel.subscribe(
      'qualify',
      (panelEntity) => {
        // The query matches ANY [PanelUI, PanelDocument] entity in the
        // scene (start menu, notification HUD, ...), not just this
        // system's own — ignore every qualify event except the one for the
        // entity this system itself created. Without this, _speedEl/
        // _avgSpeedEl below get overwritten by whichever panel's document
        // qualifies last, usually landing on null (that panel has no
        // stat-comet-speed element) and silently no-oping forever.
        if (panelEntity.index !== entity.index) return;
        const doc = panelEntity.getValue(PanelDocument, 'document') as UIKitDocument;
        for (const [buttonId, phase] of PHASE_BUTTONS) {
          const button = doc.getElementById(buttonId);
          button?.addEventListener('click', () => {
            this._director.jumpToPhase(phase);
            this._setOpen(false);
          });
        }
        this._speedEl = doc.getElementById('stat-comet-speed');
        this._avgSpeedEl = doc.getElementById('stat-avg-speed');

        doc.getElementById('btn-reset-achievements')?.addEventListener('click', () => {
          resetAchievements();
          this.world.getSystem(NotificationHudSystem)?.notify('Achievements reset', 2);
        });

        const CLASS_BUTTONS: [buttonId: string, type: number, name: string][] = [
          ['btn-class-blue', 0, 'Blue'],
          ['btn-class-green', 1, 'Green'],
          ['btn-class-red', 2, 'Red'],
        ];
        for (const [buttonId, type, name] of CLASS_BUTTONS) {
          doc.getElementById(buttonId)?.addEventListener('click', () => {
            getGlobals(this.world).dominantPebbleType.value = type;
            this.world.getSystem(NotificationHudSystem)?.notify(`Class set to ${name}`, 2);
          });
        }
      },
      true,
    );
  }

  update(delta: number): void {
    if (this.input.xr.gamepads.left?.getSelecting()) {
      this._selectHoldSeconds += delta;
      if (!this._selectTriggered && this._selectHoldSeconds >= MENU_HOLD_SECONDS) {
        this._selectTriggered = true;
        this._setOpen(!this._open);
      }
    } else {
      this._selectHoldSeconds = 0;
      this._selectTriggered = false;
    }

    // Accumulate every frame regardless of panel visibility, so "average for
    // the phase" reflects the whole phase, not just time the panel was open.
    const speed = getGlobals(this.world).cometSpeed.peek();
    this._speedSum += speed;
    this._speedSamples++;

    if (this._open) {
      const avgSpeed = this._speedSamples > 0 ? this._speedSum / this._speedSamples : 0;
      this._speedEl?.setProperties({
        text: `Comet speed: ${speed.toFixed(2)} m/s`,
      } as Record<string, unknown>);
      this._avgSpeedEl?.setProperties({
        text: `Avg phase speed: ${avgSpeed.toFixed(2)} m/s`,
      } as Record<string, unknown>);
    }
  }

  private _setOpen(open: boolean): void {
    this._open = open;
    this._panelObject.visible = open;
    if (open) {
      this._entity.addComponent(RayInteractable);
    } else {
      this._entity.removeComponent(RayInteractable);
    }
  }
}
