import { createSystem, Entity, Follower, FollowBehavior, Object3D, PanelDocument, PanelUI } from '@iwsdk/core';
import { GameDirectorSystem } from '../../core/game-director-system.js';
import { getGlobals } from '../../core/globals.js';
import { finaleMessage } from '../../core/notification-copy.js';
import { NotificationHudSystem } from '../../core/notification-hud-system.js';
import { Phase } from '../../core/phase.js';
import { StartMenuSystem } from '../../core/start-menu-system.js';
import { OrbitalLaunchSystem } from '../orbital-launch/orbital-launch-system.js';
import { cubeRowOffsets, CUBE_DISTANCE, CUBE_HEIGHT, PokeCubeButton } from '../../vfx/ui/poke-button.js';

// How long to let Finale's own payoff (CometAutopilotSystem's orbit/launch,
// still always-on and driving the comet through this whole phase) read
// before interrupting it with the end-of-run choice — long enough to
// actually watch the comet settle into orbit or fly off, not an instant
// pop-up the moment Finale's own entry blurb finishes.
// Trimmed by 4s from an original 10 — the finale meaning/name notification
// this triggers was landing too late relative to the rest of the sequence.
const END_RUN_DELAY_SECONDS = 6;

// Phase-gated (see index.ts's Phase.Finale definePhase — play()/stop()'d
// alongside FinaleSystem itself, which no longer carries a timeoutSeconds:
// this system is what actually ends the run now). Once Finale has had time
// to read, fires the "time's up" HUD notification and reveals a two-choice
// row of floating poke-cubes (same interaction model as StartMenuSystem —
// see its own class comment on why raycasting isn't used anywhere in this
// project's player-facing UI): "Make a New Comet" restarts the loop
// immediately (GameDirectorSystem.jumpToPhase — the same mechanism the old
// auto-timeout used to reach Stardust), "Main Menu" backs all the way out
// to the Start Menu (GameDirectorSystem.returnToMenu(), a parked "not
// started" state) instead of looping automatically — the player always
// gets to choose now. The flat UIKit panel remains only for the closing
// line's READ-ONLY text — nothing on it is clickable.
export class EndRunMenuSystem extends createSystem({
  panel: { required: [PanelUI, PanelDocument] },
}) {
  private _director!: GameDirectorSystem;
  private _panelObject!: Object3D;
  private _cubeRootObject!: Object3D;
  private _newCometButton!: PokeCubeButton;
  private _mainMenuButton!: PokeCubeButton;
  private _elapsed = 0;
  private _shown = false;
  // Bumped on every play()/stop() so a finale message's onComplete from an
  // earlier run can't reveal the panel during a later one.
  private _runToken = 0;

  init(): void {
    // GameDirectorSystem must be registered before this system (see
    // index.ts) so it already exists when this init() runs.
    this._director = this.world.getSystem(GameDirectorSystem)!;

    const entity = this.world.createTransformEntity();
    this._panelObject = entity.object3D!;
    this._panelObject.visible = false;

    entity.addComponent(PanelUI, { config: '/ui/end-run-menu.json', maxWidth: 0.6, maxHeight: 0.4 });
    // View-locked below NotificationHudSystem's own blurb position
    // ([0,-0.22,-0.6]) so the "time's up" notification and this menu don't
    // visually overlap when they appear together.
    entity.addComponent(Follower, {
      target: this.player.head,
      offsetPosition: [0, -0.5, -0.8],
      behavior: FollowBehavior.FaceTarget,
      tolerance: 0.02,
      speed: 6,
      maxAngle: 10,
    });

    const cubeRootEntity = this.world.createTransformEntity();
    this._cubeRootObject = cubeRootEntity.object3D!;
    this._cubeRootObject.visible = false;
    cubeRootEntity.addComponent(Follower, {
      target: this.player.head,
      offsetPosition: [0, CUBE_HEIGHT, -CUBE_DISTANCE],
      behavior: FollowBehavior.FaceTarget,
      tolerance: 0.02,
      speed: 6,
      maxAngle: 10,
    });
    const offsets = cubeRowOffsets(2);
    this._newCometButton = new PokeCubeButton(this.world, cubeRootEntity, 'Make a New Comet', [offsets[0], 0, 0]);
    this._mainMenuButton = new PokeCubeButton(this.world, cubeRootEntity, 'Main Menu', [offsets[1], 0, 0]);
    this._newCometButton.setEnabled(false);
    this._mainMenuButton.setEnabled(false);
  }

  play(): void {
    super.play();
    this._elapsed = 0;
    this._shown = false;
    this._runToken++;
    this._panelObject.visible = false;
    this._cubeRootObject.visible = false;
    this._newCometButton.setEnabled(false);
    this._mainMenuButton.setEnabled(false);
  }

  stop(): void {
    super.stop();
    this._runToken++;
    this._panelObject.visible = false;
    this._cubeRootObject.visible = false;
    this._newCometButton.setEnabled(false);
    this._mainMenuButton.setEnabled(false);
  }

  update(delta: number): void {
    if (!this._shown) {
      this._elapsed += delta;
      if (this._elapsed < END_RUN_DELAY_SECONDS) return;

      this._shown = true;
      const notifications = this.world.getSystem(NotificationHudSystem);
      // A closing name for the comet, folded together with what that identity
      // means given whichever path was actually chosen at Launch — see
      // finaleMessage's own comment. The end-run panel waits for the last of
      // these to finish fading out (its onComplete) — the queue is FIFO, so by
      // then every notification queued ahead of it has played too.
      const globals = getGlobals(this.world);
      // getChoice() can still be null on a dev-menu skip that jumped straight
      // to Finale without ever passing through Launch — OrbitalLaunchSystem's
      // own update() falls back to 'orbit' the same way once a choice is
      // actually required, so mirror that default here too.
      const choice = this.world.getSystem(OrbitalLaunchSystem)?.getChoice() ?? 'orbit';
      const nameMsgs = finaleMessage(globals.dominantPebbleType.peek(), globals.celestialSymbol.peek(), choice);
      if (!notifications || nameMsgs.length === 0) {
        this._reveal();
        return;
      }
      const token = this._runToken;
      nameMsgs.forEach((msg, i) => {
        const onComplete =
          i === nameMsgs.length - 1
            ? () => {
                if (token === this._runToken) this._reveal();
              }
            : undefined;
        notifications.notify(msg.text, msg.holdSeconds, msg.delaySeconds ?? 0, msg.lineColors, onComplete);
      });
      return;
    }

    if (!this._cubeRootObject.visible) return;
    // pokeReady is always true here, unlike StartMenuSystem's own settling
    // guard — by the time this menu can even appear, the player has already
    // been actively playing for a full run, so there's no "just donned the
    // headset" moment to guard against.
    if (this._newCometButton.update(delta, true)) {
      this._director.jumpToPhase(Phase.Stardust);
    }
    if (this._mainMenuButton.update(delta, true)) {
      this._director.returnToMenu();
      this.world.getSystem(NotificationHudSystem)?.resetBootTrigger();
      this.world.getSystem(StartMenuSystem)?.showAgain();
    }
  }

  private _reveal(): void {
    this._panelObject.visible = true;
    this._cubeRootObject.visible = true;
    this._newCometButton.setEnabled(true);
    this._mainMenuButton.setEnabled(true);
  }
}
