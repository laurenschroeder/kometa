import { montserrat } from '@pmndrs/msdfonts';
import { createSystem, Follower, FollowBehavior, Object3D, PanelDocument, PanelUI, UIKit } from '@iwsdk/core';
import type { UIKitDocument } from '@iwsdk/core';
import { getGlobals } from './globals.js';
import { NOTIFICATION_COPY } from './notification-copy.js';
import { Phase } from './phase.js';

// Stand-in for the requested Carrois Gothic SC: this project's panels
// render text via GPU bitmap-font (MSDF) atlases, which arbitrary web
// fonts can't be loaded into directly — they need a pre-generated MSDF
// atlas (image + JSON), normally produced by a Docker/Google-Fonts-API
// build step unavailable here. Montserrat (bold, geometric) is the closest
// bundled @pmndrs/msdfonts option to Carrois Gothic SC's sturdy, all-caps-
// friendly look. Swapping in a real Carrois Gothic SC atlas later means
// changing just this one import + registration.
const HUD_FONT_FAMILIES = { hud: montserrat };

// A `fontFamilies` value only takes effect if present at component
// construction time (setProperties() on an already-built Text/Container
// after the fact does not retroactively re-shape its glyphs) — so it has
// to be injected via defaultOverrides on a custom element, registered as a
// "kit" tag (see index.ts's features.spatialUI.kits) and used in
// ui/notification-hud.uikitml as <hudtext> instead of <span>.
export class HudText extends UIKit.Container {
  constructor(
    inputProperties?: ConstructorParameters<typeof UIKit.Container>[0],
    initialClasses?: ConstructorParameters<typeof UIKit.Container>[1],
    config?: ConstructorParameters<typeof UIKit.Container>[2],
  ) {
    super(inputProperties, initialClasses, {
      ...config,
      defaultOverrides: {
        fontFamilies: HUD_FONT_FAMILIES,
        fontFamily: 'hud',
        fontWeight: 'bold',
        ...config?.defaultOverrides,
      },
    });
  }

  // The uikitml interpreter builds each text node's displayed string from
  // `text.parentContainer.value.properties.value.text` when present (see
  // @pmndrs/uikitml's interpretElement), overriding the static markup
  // content — so setting `text` here retargets what's shown without
  // rebuilding the element, unlike fontFamilies above. `text` isn't part of
  // Container's declared properties type, hence the one cast, kept here
  // instead of at call sites.
  setText(text: string): void {
    this.setProperties({ text } as Record<string, unknown>);
  }
}

const HUD_BOX_ID = 'hud-box';
const HUD_TEXT_ID = 'hud-text';

// Exported so callers that need to know how long a queued notify() sequence
// actually takes on screen (fade-in + hold + fade-out per message, back to
// back) can compute it themselves — see OrbitalLaunchSystem's buildup timer.
export const FADE_SECONDS = 0.5;

enum FadeState {
  Idle,
  In,
  Hold,
  Out,
}

// A view-locked HUD (Follower on world.player.head, tight tolerance/fast
// speed so it reads as "locked" rather than a lagging wrist panel like
// PhaseMenuSystem's) that flashes a short instructional blurb at the start
// of every phase, then gently fades away — a one-shot "here's what to do"
// cue, not a persistent status readout. Also doubles as the general-purpose
// unlock-popup HUD (see notify()) for AchievementSystem. Always-on (never
// GameDirector-managed): reacts to globals.gamePhase directly, gated on
// globals.gameStarted so nothing pops up while the Start Menu is still on
// screen (gamePhase is already Stardust well before the game is started).
export class NotificationHudSystem extends createSystem({
  panel: { required: [PanelUI, PanelDocument] },
}) {
  private _doc: UIKitDocument | null = null;
  private _boxEl: UIKit.Container | null = null;
  private _textEl: HudText | null = null;
  private _active = false;
  private _state = FadeState.Idle;
  private _elapsed = 0;
  private _holdSeconds = 0;
  private _queue: { text: string; holdSeconds: number }[] = [];
  private _bootTriggered = false;

  init(): void {
    const entity = this.world.createTransformEntity();
    const panelObject = entity.object3D!;
    panelObject.visible = true;

    entity.addComponent(PanelUI, {
      config: '/ui/notification-hud.json',
      maxWidth: 0.6,
      maxHeight: 0.2,
    });
    // Tight tolerance + fast speed (vs. PhaseMenuSystem's default wrist-
    // panel lag) so this reads as "locked to your view" rather than a
    // world object that gently catches up to you.
    entity.addComponent(Follower, {
      target: this.player.head,
      offsetPosition: [0, -0.22, -0.6],
      behavior: FollowBehavior.FaceTarget,
      tolerance: 0.02,
      speed: 6,
      maxAngle: 10,
    });

    this.queries.panel.subscribe(
      'qualify',
      (panelEntity) => {
        // The query matches ANY [PanelUI, PanelDocument] entity in the
        // scene (welcome panel, phase-menu panel, ...), not just this
        // system's own — ignore every qualify event except the one for the
        // entity this system itself created.
        if (panelEntity.index !== entity.index) return;
        this._doc = panelEntity.getValue(PanelDocument, 'document') as UIKitDocument;
        this._boxEl = this._doc.getElementById(HUD_BOX_ID) as UIKit.Container | null;
        this._textEl = this._doc.getElementById(HUD_TEXT_ID) as HudText | null;
        this._maybeTriggerBoot();
      },
      true,
    );

    this.cleanupFuncs.push(
      getGlobals(this.world).gamePhase.subscribe((phase) => {
        if (getGlobals(this.world).gameStarted.peek()) this._triggerPhase(phase);
      }),
    );
    // The panel's JSON loads asynchronously and gameStarted flips true from
    // a separate system (StartMenuSystem) at an unrelated time — whichever
    // of the two becomes ready last is what actually fires the very first
    // phase's blurb, so both paths call the same idempotent helper.
    this.cleanupFuncs.push(
      getGlobals(this.world).gameStarted.subscribe(() => this._maybeTriggerBoot()),
    );
  }

  private _maybeTriggerBoot(): void {
    if (this._bootTriggered) return;
    if (!this._boxEl || !this._textEl) return;
    if (!getGlobals(this.world).gameStarted.peek()) return;
    this._bootTriggered = true;
    this._triggerPhase(getGlobals(this.world).gamePhase.peek());
  }

  private _triggerPhase(phase: Phase): void {
    const sequence = NOTIFICATION_COPY[phase];
    if (!sequence) return;
    for (const entry of sequence) this.notify(entry.text, entry.holdSeconds);
  }

  // Public entry point for anything that wants a message on this HUD —
  // phase blurbs (above) and achievement-unlock popups (AchievementSystem)
  // both funnel through here. Queues if a message is already showing so a
  // burst of unlocks doesn't clobber what's currently on screen.
  notify(text: string, holdSeconds: number): void {
    this._queue.push({ text, holdSeconds });
    if (this._state === FadeState.Idle) this._pump();
  }

  private _pump(): void {
    if (!this._boxEl || !this._textEl) return;
    const next = this._queue.shift();
    if (!next) return;

    this._textEl.setText(next.text);
    this._holdSeconds = next.holdSeconds;
    this._state = FadeState.In;
    this._elapsed = 0;
    this._active = true;
    this._setBoxVisible(true, 0);
  }

  update(delta: number): void {
    if (this._state === FadeState.Idle || !this._active || !this._boxEl) return;

    this._elapsed += delta;

    if (this._state === FadeState.In) {
      const t = Math.min(1, this._elapsed / FADE_SECONDS);
      this._setOpacity(t);
      if (t >= 1) {
        this._state = FadeState.Hold;
        this._elapsed = 0;
      }
    } else if (this._state === FadeState.Hold) {
      if (this._elapsed >= this._holdSeconds) {
        this._state = FadeState.Out;
        this._elapsed = 0;
      }
    } else if (this._state === FadeState.Out) {
      const t = Math.min(1, this._elapsed / FADE_SECONDS);
      this._setOpacity(1 - t);
      if (t >= 1) {
        this._setBoxVisible(false, 0);
        this._active = false;
        this._state = FadeState.Idle;
        this._pump();
      }
    }
  }

  private _setOpacity(opacity: number): void {
    this._boxEl!.setProperties({ opacity });
  }

  private _setBoxVisible(visible: boolean, opacity: number): void {
    this._boxEl!.setProperties({
      display: visible ? 'flex' : 'none',
      opacity,
    });
  }
}
