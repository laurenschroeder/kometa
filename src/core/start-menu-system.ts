import {
  createSystem,
  Entity,
  Euler,
  Follower,
  FollowBehavior,
  Object3D,
  PanelDocument,
  PanelUI,
  Quaternion,
  UIKit,
  Vector3,
} from '@iwsdk/core';
import type { UIKitDocument } from '@iwsdk/core';
import { ACHIEVEMENTS } from './achievement-list.js';
import { isUnlocked } from './achievement-store.js';
import { GameDirectorSystem } from './game-director-system.js';
import { getGlobals } from './globals.js';
import { cubeRowOffsets, CUBE_DISTANCE, CUBE_HEIGHT, PokeCubeButton } from '../vfx/ui/poke-button.js';

// Start no longer uses a dwell button — pinching with BOTH hands at once
// (select on controllers, pinch on hand tracking — same gesture
// CometHandoffSystem/PhaseMenuSystem already rely on, see their own
// comments) starts the game. Held briefly rather than firing instantly so a
// single-frame overlap between two otherwise-unrelated pinches can't
// false-trigger it. Kept as a parallel fast-path alongside the Start cube
// below, not replaced by it.
const DOUBLE_PINCH_HOLD_SECONDS = 0.35;
// Gentle pulse on the hint text while waiting — same "flash while inviting
// interaction" idiom as ConstellationsVfxSystem's untouched-star flash.
const START_HINT_PULSE_FREQ = 0.6; // Hz
const START_HINT_MIN_OPACITY = 0.45;

// A fresh XR session (headset just donned, hand often still near the face)
// ignores all poke-hold accumulation for this long before any cube can
// start filling — not reset by showAgain(), since a player already
// mid-session choosing "Main Menu" doesn't need re-guarding. Shared across
// every cube row in this system (main/achievements/settings).
const IGNORE_POKE_SECONDS = 1.5;

type MenuPage = 'main' | 'achievements' | 'settings';

interface CubeRow {
  rootEntity: Entity;
  rootObject: Object3D;
  buttons: PokeCubeButton[];
}

// Gates the whole game behind starting the experience. Every player-facing
// button in this menu (Start/Achievements/Settings, Settings' own two
// toggles, Achievements'/Settings' Back) is a floating poke-and-hold cube
// (see poke-button.ts) rather than a ray-hover/click UI element —
// raycasting is no longer used anywhere in this project's player-facing UI,
// since this experience gets handed between strangers at a festival and a
// physical touch is a much stronger accidental-trigger filter than a
// controller ray or hover ever was. Start is also reachable via the
// pre-existing two-handed pinch gesture (DOUBLE_PINCH_HOLD_SECONDS), kept
// working unchanged as a parallel path. The flat UIKit panel remains only
// for READ-ONLY text (title, pinch-hint, the achievement list) — nothing on
// it is clickable anymore. Starting hands off to GameDirectorSystem.start()
// and flips globals.gameStarted (so NotificationHudSystem's phase blurbs
// can begin — see its own comments).
export class StartMenuSystem extends createSystem({
  panel: { required: [PanelUI, PanelDocument] },
}) {
  private _director!: GameDirectorSystem;
  private _entity!: Entity;
  private _panelObject!: Object3D;
  private _page: MenuPage = 'main';

  private _mainRow!: CubeRow;
  private _achievementsRow!: CubeRow;
  private _settingsRow!: CubeRow;
  private _startButton!: PokeCubeButton;
  private _achievementsButton!: PokeCubeButton;
  private _settingsButton!: PokeCubeButton;
  private _passthroughButton!: PokeCubeButton;
  private _notificationsButton!: PokeCubeButton;

  private _startHintEl: UIKit.Component<any> | null = null;
  private _startAction: (() => void) | null = null;
  private _pinchHoldSeconds = 0;
  private _startTriggered = false;
  // Set once inside the panel's own qualify callback below — stored rather
  // than re-fetched via entity.getValue(PanelDocument, 'document') on every
  // _openPage() call, since the panel's JSON loads asynchronously and the
  // main row's cubes are poke-active from construction (before that load
  // necessarily finishes), so a re-fetch could race a PanelDocument
  // component that isn't attached yet.
  private _docRef: UIKitDocument | null = null;

  // See IGNORE_POKE_SECONDS — starts counting immediately at init() (so
  // browser/dev testing without a real XR session isn't permanently locked
  // out), and re-arms on every real 'sessionstart' (so a freshly-donned
  // headset always gets the settling window, including re-entries).
  private _pokeGateActive = true;
  private _pokeGateElapsed = 0;

  private _scratchQuat = new Quaternion();
  private _scratchEuler = new Euler();
  private _scratchCamPos = new Vector3();

  init(): void {
    // GameDirectorSystem must be registered before this system (see
    // index.ts) so it already exists when this init() runs.
    this._director = this.world.getSystem(GameDirectorSystem)!;

    // A system-level recenter (e.g. long-pressing the Meta button) resets
    // the XR runtime's own reference space to the player's CURRENT physical
    // position/orientation — it has no idea this app also maintains its own
    // world.player offset (see _recenterToHead's own comment), so without
    // this the two compound: world.player still carries whatever offset was
    // computed back when Start was pressed, now applied on top of a
    // reference space that just moved out from under it, producing exactly
    // the "big jump" a mid-game system recenter caused. Re-running the same
    // recenter math on the WebXR reference space's own 'reset' event drops
    // that stale offset and recomputes it fresh against wherever the player
    // actually is right now, instead of leaving it stacked. The reference
    // space only exists once a session is live, and three.js can hand out a
    // new instance per session, so this re-attaches on every 'sessionstart'
    // rather than trying to grab it once up front.
    this.xrManager.addEventListener('sessionstart', () => {
      this.xrManager.getReferenceSpace()?.addEventListener('reset', () => this._recenterToHead());
      this._pokeGateActive = true;
      this._pokeGateElapsed = 0;
    });

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

    this._mainRow = this._buildCubeRow(['Achievements', 'Start', 'Settings']);
    [this._achievementsButton, this._startButton, this._settingsButton] = this._mainRow.buttons;

    this._achievementsRow = this._buildCubeRow(['Back']);
    this._achievementsRow.rootObject.visible = false;
    for (const button of this._achievementsRow.buttons) button.setEnabled(false);

    const globals = getGlobals(this.world);
    this._settingsRow = this._buildCubeRow([
      this._passthroughLabel(globals.passthroughEnabled.peek()),
      this._notificationsLabel(globals.notificationsEnabled.peek()),
      'Back',
    ]);
    this._settingsRow.rootObject.visible = false;
    [this._passthroughButton, this._notificationsButton] = this._settingsRow.buttons;
    for (const button of this._settingsRow.buttons) button.setEnabled(false);

    this.queries.panel.subscribe(
      'qualify',
      (panelEntity) => {
        // The query matches ANY [PanelUI, PanelDocument] entity in the
        // scene, not just this system's own (same caveat as
        // NotificationHudSystem) — ignore every qualify event except this
        // system's own entity.
        if (panelEntity.index !== entity.index) return;
        const doc = panelEntity.getValue(PanelDocument, 'document') as UIKitDocument;
        this._docRef = doc;

        this._startHintEl = doc.getElementById('start-hint');
        this._startAction = () => {
          this._recenterToHead();
          this._director.start();
          getGlobals(this.world).gameStarted.value = true;
          this._panelObject.visible = false;
          for (const row of [this._mainRow, this._achievementsRow, this._settingsRow]) {
            row.rootObject.visible = false;
            for (const button of row.buttons) button.setEnabled(false);
          }
        };
      },
      true,
    );
  }

  // Builds one Follower-driven row of poke-cubes, centered around local
  // x=0 (see cubeRowOffsets) — the same shared layout every screen in this
  // menu uses (main/achievements/settings), just with a different button
  // count/labels each time.
  private _buildCubeRow(labels: string[]): CubeRow {
    const rootEntity = this.world.createTransformEntity();
    const rootObject = rootEntity.object3D!;
    rootEntity.addComponent(Follower, {
      target: this.player.head,
      offsetPosition: [0, CUBE_HEIGHT, -CUBE_DISTANCE],
      behavior: FollowBehavior.FaceTarget,
      tolerance: 0.02,
      speed: 6,
      maxAngle: 10,
    });

    const offsets = cubeRowOffsets(labels.length);
    const buttons = labels.map(
      (label, i) => new PokeCubeButton(this.world, rootEntity, label, [offsets[i], 0, 0]),
    );

    return { rootEntity, rootObject, buttons };
  }

  update(delta: number, time: number): void {
    if (this._pokeGateActive) this._pokeGateElapsed += delta;
    const pokeReady = this._pokeGateElapsed >= IGNORE_POKE_SECONDS;

    // Only the active page's row needs update() — inactive rows are already
    // hidden/disabled/reset by _openPage()'s own setEnabled(false), which
    // snaps their fill to 0 synchronously, so there's nothing left for a
    // hidden button's own update() to do.
    if (this._page === 'main') {
      if (this._startAction && this._startButton.update(delta, pokeReady)) this._startAction();
      if (this._achievementsButton.update(delta, pokeReady)) this._openPage('achievements');
      if (this._settingsButton.update(delta, pokeReady)) this._openPage('settings');
    } else if (this._page === 'achievements') {
      if (this._achievementsRow.buttons[0].update(delta, pokeReady)) this._openPage('main');
    } else if (this._page === 'settings') {
      if (this._passthroughButton.update(delta, pokeReady)) {
        const globals = getGlobals(this.world);
        globals.passthroughEnabled.value = !globals.passthroughEnabled.value;
        this._passthroughButton.setLabel(this._passthroughLabel(globals.passthroughEnabled.value));
      }
      if (this._notificationsButton.update(delta, pokeReady)) {
        const globals = getGlobals(this.world);
        globals.notificationsEnabled.value = !globals.notificationsEnabled.value;
        this._notificationsButton.setLabel(this._notificationsLabel(globals.notificationsEnabled.value));
      }
      if (this._settingsRow.buttons[2].update(delta, pokeReady)) this._openPage('main');
    }

    this._updateStartPinch(delta, time);
  }

  private _activeRow(): CubeRow {
    if (this._page === 'achievements') return this._achievementsRow;
    if (this._page === 'settings') return this._settingsRow;
    return this._mainRow;
  }

  private _passthroughLabel(enabled: boolean): string {
    return `Passthrough: ${enabled ? 'On' : 'Off'}`;
  }
  private _notificationsLabel(enabled: boolean): string {
    return `Notifications: ${enabled ? 'On' : 'Off'}`;
  }

  // Both hands pinching (select) at once, held briefly, starts the game —
  // see DOUBLE_PINCH_HOLD_SECONDS's own comment.
  private _updateStartPinch(delta: number, time: number): void {
    if (this._startTriggered || !this._startAction || this._page !== 'main') return;

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

  // Re-anchors world.player (the XR origin every other transform in this
  // game is ultimately relative to) so the camera's CURRENT world position/
  // yaw becomes the new logical origin/forward — every hardcoded scene
  // position (the Seeding planet, Fate Events' PLANET_CENTER, the swirl's
  // "in front of you" spawn, etc.) is built assuming a player facing -Z at
  // the origin, so this is what lines that up with wherever the player is
  // actually standing/facing, rather than wherever they happened to be when
  // the page loaded. Two call sites: once when Start is triggered (before
  // GameDirectorSystem's own director.start() ever runs), and again on
  // every native WebXR reference-space 'reset' event (see init()'s
  // sessionstart listener) — a system-level recenter mid-game moves the
  // physical reference frame out from under whatever offset this last
  // computed, so it needs to be recomputed fresh, not just once at Start.
  // Not itself a native WebXR reference-space reset — just this app's own
  // world.player realignment. Works identically in NonImmersive browser
  // mode too (harmless there — just re-zeroes whatever render.camera's
  // initial framing left it at).
  private _recenterToHead(): void {
    const player = this.player;
    const camera = this.camera;

    camera.getWorldQuaternion(this._scratchQuat);
    this._scratchEuler.setFromQuaternion(this._scratchQuat, 'YXZ');
    player.rotation.y -= this._scratchEuler.y;
    player.updateMatrixWorld(true);

    camera.getWorldPosition(this._scratchCamPos);
    player.position.x -= this._scratchCamPos.x;
    player.position.z -= this._scratchCamPos.z;
    player.updateMatrixWorld(true);
  }

  // Three-way page switch — swaps both the flat panel's active <div> (text
  // only: title/hint on main, title+list on achievements, title on
  // settings) and which cube row is visible/pokeable.
  private _openPage(page: MenuPage): void {
    this._page = page;
    const doc = this._doc();
    doc?.getElementById('page-main')?.setProperties({ display: page === 'main' ? 'flex' : 'none' });
    doc?.getElementById('page-achievements')?.setProperties({ display: page === 'achievements' ? 'flex' : 'none' });
    doc?.getElementById('page-settings')?.setProperties({ display: page === 'settings' ? 'flex' : 'none' });

    for (const row of [this._mainRow, this._achievementsRow, this._settingsRow]) {
      const active = row === this._activeRow();
      row.rootObject.visible = active;
      for (const button of row.buttons) {
        button.setEnabled(active);
        if (active) button.reset();
      }
    }

    if (page === 'achievements' && doc) this._refreshAchievementRows(doc);
  }

  private _doc(): UIKitDocument | null {
    return this._docRef;
  }

  // Re-shows this panel after GameDirectorSystem.returnToMenu() — called by
  // EndRunMenuSystem's "Main Menu" choice, the only path that reaches this
  // screen a second time (a fresh page load already starts with the panel
  // visible). Resets pinch/page state, not the poke-settling gate (see
  // IGNORE_POKE_SECONDS's own comment) — a player already mid-session
  // choosing this doesn't need re-guarding.
  showAgain(): void {
    this._pinchHoldSeconds = 0;
    this._startTriggered = false;
    this._panelObject.visible = true;
    this._openPage('main');
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
