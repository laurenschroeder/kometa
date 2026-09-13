import {
  createSystem,
  Entity,
  Follower,
  FollowBehavior,
  InputComponent,
  Object3D,
  PanelDocument,
  PanelUI,
  Quaternion,
  RayInteractable,
  Vector3,
} from '@iwsdk/core';
import type { UIKit, UIKitDocument } from '@iwsdk/core';
import { resetAchievements } from './achievement-store.js';
import { GameDirectorSystem } from './game-director-system.js';
import { getGlobals } from './globals.js';
import { Phase } from './phase.js';
import { NotificationHudSystem } from './notification-hud-system.js';

// Two independent ways to toggle the menu, either one works: holding the
// left controller's physical Menu button while the hand itself is flipped
// palm-up (like checking a watch), OR five quick left-hand selects in a row
// (the older gesture — restored as a reliable fallback since the flip+hold
// one hasn't been landing consistently for every controller/grip
// convention; see FLIP_UP_DOT_THRESHOLD's own "first-pass, expect to
// retune" caveat). Controller-only either way — hand tracking has no
// physical Menu button, and getSelectStart() only fires from an actual
// pinch/trigger edge, so the dev menu simply isn't reachable via hand
// tracking (acceptable for a debug-only feature).
const FLIP_HOLD_SECONDS = 1.0;
// Dot product of the grip's local "up" (back-of-hand) axis against world
// up — near 1 when held naturally (thumb-up), flips toward -1 when the palm
// rotates to face upward. First-pass number — expect to retune in-headset
// against the actual controller/hand grip convention.
const FLIP_UP_DOT_THRESHOLD = -0.5;

// Tap-count fallback — TAP_WINDOW_SECONDS is how long the player has, after
// each tap, to land the next one before the count resets back to 0.
const TAP_WINDOW_SECONDS = 0.45;
const TAPS_TO_TOGGLE = 5;

// Kill switch for the whole open-on-tap gesture. Tied to Vite's own
// dev/build distinction rather than a hand-maintained flag — `import.meta.
// env.DEV` is true under `vite`/`npm run dev` and false in any `vite build`
// output (what a Viverse/production build ships), so the menu is
// automatically unreachable once pushed live without needing to remember to
// flip anything by hand. The panel/systems below are still fully built
// either way, just never opened while this is false.
const DEV_MENU_ENABLED = import.meta.env.DEV;

const PHASE_BUTTONS: [buttonId: string, phase: Phase][] = [
  ['btn-stardust', Phase.Stardust],
  ['btn-pebbles', Phase.Pebbles],
  ['btn-seeding', Phase.Seeding],
  ['btn-constellations', Phase.Constellations],
  ['btn-fate-events', Phase.FateEvents],
  ['btn-launch', Phase.Launch],
  ['btn-finale', Phase.Finale],
  ['btn-art-test', Phase.ArtTest],
];

// Dev/debug menu: holding the left controller's Menu button while flipping
// that hand palm-up (see FLIP_HOLD_SECONDS/_isLeftHandFlipped), OR five
// quick left-hand selects in a row (see TAPS_TO_TOGGLE), toggles a
// wrist-height panel in front of the player with a button per phase,
// jumping straight there via GameDirectorSystem.jumpToPhase() rather than
// waiting on win conditions/timeouts.
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
  private _flipHoldElapsed = 0;
  private _scratchQuat!: Quaternion;
  private _scratchUp!: Vector3;
  private _tapCount = 0;
  private _tapWindowRemaining = 0;

  init(): void {
    // GameDirectorSystem must be registered before this system (see
    // index.ts) so it already exists when this init() runs.
    this._director = this.world.getSystem(GameDirectorSystem)!;
    this._scratchQuat = new Quaternion();
    this._scratchUp = new Vector3();

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
            // Clear first — see clearQueue()'s own comment — so the jump's
            // own phase-entry blurb (fired synchronously inside
            // jumpToPhase(), which sets globals.gamePhase) starts showing
            // immediately instead of queuing behind whatever was still
            // on-screen/pending from the phase you jumped FROM.
            this.world.getSystem(NotificationHudSystem)?.clearQueue();
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
    if (DEV_MENU_ENABLED) {
      const menuHeld = this.input.xr.gamepads.left?.getButtonPressed(InputComponent.Menu) ?? false;
      if (menuHeld && this._isLeftHandFlipped()) {
        this._flipHoldElapsed += delta;
        if (this._flipHoldElapsed >= FLIP_HOLD_SECONDS) {
          this._flipHoldElapsed = 0;
          this._setOpen(!this._open);
        }
      } else {
        this._flipHoldElapsed = 0;
      }

      // Fallback gesture — see this file's own top comment.
      if (this._tapCount > 0) {
        this._tapWindowRemaining -= delta;
        if (this._tapWindowRemaining <= 0) this._tapCount = 0;
      }
      if (this.input.xr.gamepads.left?.getSelectStart()) {
        this._tapCount++;
        this._tapWindowRemaining = TAP_WINDOW_SECONDS;
        if (this._tapCount >= TAPS_TO_TOGGLE) {
          this._tapCount = 0;
          this._setOpen(!this._open);
        }
      }
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

  // "Flipped" — the left hand/controller rotated palm-up, like checking a
  // watch — read from the grip space's own local "up" axis in world space
  // (near world-up when held naturally, flips toward world-down as the
  // wrist rotates). See FLIP_UP_DOT_THRESHOLD's own comment.
  private _isLeftHandFlipped(): boolean {
    const grip = this.player.gripSpaces.left;
    grip.getWorldQuaternion(this._scratchQuat);
    this._scratchUp.set(0, 1, 0).applyQuaternion(this._scratchQuat);
    return this._scratchUp.y < FLIP_UP_DOT_THRESHOLD;
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
