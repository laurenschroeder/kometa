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
import type { UIKitDocument } from '@iwsdk/core';
import { GameDirectorSystem } from '../../core/game-director-system.js';
import { getGlobals } from '../../core/globals.js';
import { cometNameMessage, END_RUN_MESSAGE } from '../../core/notification-copy.js';
import { NotificationHudSystem } from '../../core/notification-hud-system.js';
import { Phase } from '../../core/phase.js';
import { StartMenuSystem } from '../../core/start-menu-system.js';

// How long to let Finale's own payoff (CometAutopilotSystem's orbit/launch,
// still always-on and driving the comet through this whole phase) read
// before interrupting it with the end-of-run choice — long enough to
// actually watch the comet settle into orbit or fly off, not an instant
// pop-up the moment Finale's own entry blurb finishes.
const END_RUN_DELAY_SECONDS = 10;

// Phase-gated (see index.ts's Phase.Finale definePhase — play()/stop()'d
// alongside FinaleSystem itself, which no longer carries a timeoutSeconds:
// this system is what actually ends the run now). Once Finale has had time
// to read, fires the "time's up" HUD notification and reveals a two-choice
// panel: "Make a New Comet" restarts the loop immediately
// (GameDirectorSystem.jumpToPhase — the same mechanism the old auto-timeout
// used to reach Stardust), "Main Menu" backs all the way out to the Start
// Menu (GameDirectorSystem.returnToMenu(), a parked "not started" state)
// instead of looping automatically — the player always gets to choose now.
export class EndRunMenuSystem extends createSystem({
  panel: { required: [PanelUI, PanelDocument] },
}) {
  private _director!: GameDirectorSystem;
  private _entity!: Entity;
  private _panelObject!: Object3D;
  private _elapsed = 0;
  private _shown = false;

  init(): void {
    // GameDirectorSystem must be registered before this system (see
    // index.ts) so it already exists when this init() runs.
    this._director = this.world.getSystem(GameDirectorSystem)!;

    const entity = this.world.createTransformEntity();
    this._entity = entity;
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

    this.queries.panel.subscribe(
      'qualify',
      (panelEntity) => {
        // The query matches ANY [PanelUI, PanelDocument] entity in the
        // scene, not just this system's own — ignore every qualify event
        // except this system's own entity (same caveat as every other
        // panel system in this codebase).
        if (panelEntity.index !== entity.index) return;
        const doc = panelEntity.getValue(PanelDocument, 'document') as UIKitDocument;

        doc.getElementById('btn-new-comet')?.addEventListener('click', () => {
          this._director.jumpToPhase(Phase.Stardust);
        });
        doc.getElementById('btn-main-menu')?.addEventListener('click', () => {
          this._director.returnToMenu();
          this.world.getSystem(NotificationHudSystem)?.resetBootTrigger();
          this.world.getSystem(StartMenuSystem)?.showAgain();
        });
      },
      true,
    );
  }

  play(): void {
    super.play();
    this._elapsed = 0;
    this._shown = false;
    this._panelObject.visible = false;
    if (this._entity.hasComponent(RayInteractable)) this._entity.removeComponent(RayInteractable);
  }

  stop(): void {
    super.stop();
    this._panelObject.visible = false;
    if (this._entity.hasComponent(RayInteractable)) this._entity.removeComponent(RayInteractable);
  }

  update(delta: number): void {
    if (this._shown) return;
    this._elapsed += delta;
    if (this._elapsed < END_RUN_DELAY_SECONDS) return;

    this._shown = true;
    const notifications = this.world.getSystem(NotificationHudSystem);
    // A closing name for the comet, queued right before the practical
    // "time is done" cue — see cometNameMessage's own comment.
    const globals = getGlobals(this.world);
    const nameMsg = cometNameMessage(globals.dominantPebbleType.peek(), globals.celestialSymbol.peek());
    notifications?.notify(nameMsg.text, nameMsg.holdSeconds);
    notifications?.notify(END_RUN_MESSAGE.text, END_RUN_MESSAGE.holdSeconds);
    this._panelObject.visible = true;
    this._entity.addComponent(RayInteractable);
  }
}
