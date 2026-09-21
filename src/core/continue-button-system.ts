import { createSystem, Entity, FollowBehavior, Follower, Pressed, Vector3 } from '@iwsdk/core';
import { getSharedTwinkleSynth, PokeCubeButton } from '../vfx/ui/poke-button.js';
import { GameDirectorSystem } from './game-director-system.js';
import { getGlobals } from './globals.js';
import { HapticPattern, HapticsSystem } from './haptics-system.js';
import { CONTINUE_NOTIFICATIONS_ENABLED, CONTINUE_READY_TEXT } from './notification-copy.js';
import { NOTIFICATION_HUD_OFFSET, NotificationHudSystem } from './notification-hud-system.js';
import type { Phase } from './phase.js';

// Kill switch — flip to false to disable the Continue button (and
// re-enable HAND_PROGRESS_HUD_ENABLED in hand-progress-hud-system.ts to
// switch back to the old progress bar). Phases still advance via their own
// timeouts either way.
export const CONTINUE_BUTTON_ENABLED = true;

// Size multiplier on the shared PokeCubeButton (1 = same size as the menu
// buttons). Smaller than menu size so its label clears the notification box
// above it.
const BUTTON_SCALE = 0.7;
// Pinned in view directly below the notification box: same distance, and this
// much lower than the box (metres; 0.18 is about 7 inches) — the button's
// label sits above its diamond, so it needs the extra room to stay clear of
// the box. Tune this to move the button up/down.
const BUTTON_BELOW_NOTIFICATION = 0.18;
const HOLD_SECONDS = 1.8;
// The button pops up head-locked, in front of the player's face, right when a
// phase's readiness hits 1 — i.e. usually mid-gameplay with a hand (or the
// comet) already swinging through that space. Poking is ignored for this long
// after it appears, AND until no finger/controller is touching it, so a hand
// that happened to be there can't start the hold — the player has to
// deliberately reach in afterward.
const ARM_DELAY_SECONDS = 1.5;
const CHIME_SPEED = 1.5;

type ContinueState = 'locked' | 'ready' | 'done';

// A "Continue" diamond pinned in view just below the notification box. Each
// phase opts in through PhaseConfig.continue: the button stays hidden until
// that phase's readiness reaches 1, then pops up with a chime + haptic pulse
// (+ an optional HUD line, see CONTINUE_NOTIFICATIONS_ENABLED). Poked and held like every other PokeCubeButton; pressing runs the
// phase's own onContinue. Always-on (never GameDirector-managed), same idiom
// as NotificationHudSystem.
export class ContinueButtonSystem extends createSystem({}) {
  private _director!: GameDirectorSystem;
  private _root!: Entity;
  private _button!: PokeCubeButton;
  private _state: ContinueState = 'locked';
  private _armed = false;
  private _sinceUnlock = 0;
  private _lastPhase: Phase | null = null;
  private _scratchPos = new Vector3();

  init(): void {
    // GameDirectorSystem must be registered before this system (see index.ts).
    this._director = this.world.getSystem(GameDirectorSystem)!;

    this._root = this.world.createTransformEntity();
    this._root.object3D!.visible = false;
    this._root.addComponent(Follower, {
      target: this.player.head,
      offsetPosition: [
        NOTIFICATION_HUD_OFFSET[0],
        NOTIFICATION_HUD_OFFSET[1] - BUTTON_BELOW_NOTIFICATION,
        NOTIFICATION_HUD_OFFSET[2],
      ],
      behavior: FollowBehavior.FaceTarget,
      tolerance: 0.02,
      speed: 6,
      maxAngle: 10,
    });
    this._button = new PokeCubeButton(this.world, this._root, 'Continue when Ready', [0, 0, 0], {
      holdSeconds: HOLD_SECONDS,
      scale: BUTTON_SCALE,
    });
    this._button.setEnabled(false);
  }

  update(delta: number): void {
    if (!CONTINUE_BUTTON_ENABLED) {
      this._hide();
      return;
    }

    const globals = getGlobals(this.world);
    const phase = globals.gamePhase.peek();
    if (phase !== this._lastPhase) {
      this._lastPhase = phase;
      this._resetState();
    }

    const config = this._director.getContinueConfig(phase);
    if (!globals.gameStarted.peek() || !config || this._state === 'done') {
      if (!globals.gameStarted.peek() || !config) this._resetState();
      this._hide();
      return;
    }

    // Hidden entirely until the phase says the player may continue.
    if (this._state === 'locked') {
      if (config.getReadiness01() < 1) {
        this._hide();
        return;
      }
      this._unlock();
    }
    this._root.object3D!.visible = true;
    this._button.setBaseColor(config.getColorHex?.() ?? null);

    if (!this._armed) {
      this._sinceUnlock += delta;
      if (this._sinceUnlock >= ARM_DELAY_SECONDS && !this._button.entity.hasComponent(Pressed)) this._armed = true;
    }
    const fired = this._button.update(delta, this._state === 'ready' && this._armed);
    if (fired) {
      this._state = 'done';
      this._hide();
      config.onContinue();
    }
  }

  private _unlock(): void {
    this._state = 'ready';
    this._armed = false;
    this._sinceUnlock = 0;
    this._button.setEnabled(true);

    this._root.object3D!.getWorldPosition(this._scratchPos);
    getSharedTwinkleSynth(this.world).playCatch(this._scratchPos, CHIME_SPEED);
    this.world.getSystem(HapticsSystem)?.pulseBoth(HapticPattern.MediumPulse);
    if (CONTINUE_NOTIFICATIONS_ENABLED) {
      this.world.getSystem(NotificationHudSystem)?.notify(CONTINUE_READY_TEXT, 6);
    }
  }

  // Back to the dim locked look — on every phase change and whenever the
  // game returns to the menu, so a stale ready/done state never carries over.
  private _resetState(): void {
    if (this._state === 'locked') return;
    this._state = 'locked';
    this._button.setEnabled(false);
    this._button.reset();
  }

  private _hide(): void {
    this._root.object3D!.visible = false;
    this._button.setEnabled(false);
  }
}
