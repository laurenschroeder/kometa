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
  Vector3,
} from '@iwsdk/core';
import type { UIKitDocument } from '@iwsdk/core';
import { ACHIEVEMENTS, SECRET_DESCRIPTION, SECRET_TITLE } from './achievement-list.js';
import { cometsReleased, isUnlocked } from './achievement-store.js';
import { cometStats, fetchCometStats } from './community-stats.js';
import { GameDirectorSystem } from './game-director-system.js';
import { getGlobals } from './globals.js';
import { HapticPattern, HapticsSystem } from './haptics-system.js';
import { cometLeaderboard, platformUser, refreshLeaderboard } from './progress-sync.js';
import { track } from './telemetry.js';
import { cubeRowOffsets, CUBE_DISTANCE, CUBE_HEIGHT, LOWER_CUBE_HEIGHT, PokeCubeButton } from '../vfx/ui/poke-button.js';

// Start no longer uses a dwell button — pinching with BOTH hands at once
// (select on controllers, pinch on hand tracking — same gesture
// CometHandoffSystem/PhaseMenuSystem already rely on, see their own
// comments) starts the game. Held briefly rather than firing instantly so a
// single-frame overlap between two otherwise-unrelated pinches can't
// false-trigger it. Kept as a parallel fast-path alongside the Start cube
// below, not replaced by it.
const DOUBLE_PINCH_HOLD_SECONDS = 0.35;

// A fresh XR session (headset just donned, hand often still near the face)
// ignores all poke-hold accumulation for this long before any cube can
// start filling — not reset by showAgain(), since a player already
// mid-session choosing "Main Menu" doesn't need re-guarding. Shared across
// every cube row in this system (main/achievements/settings).
const IGNORE_POKE_SECONDS = 1.5;

const PANEL_OFFSET_Y = 0.15;
const PANEL_OFFSET_Z = -0.8;
const PANEL_MAX_HEIGHT = 0.6;
// The achievements page's own Back cube sits at the standard reachable
// CUBE_DISTANCE but lower than the other rows (LOWER_CUBE_HEIGHT, about 3
// inches), so it clears the taller four-column achievement list above it.

// Max rows the leaderboard page has markup for (lb-row-0..9 in
// ui/start-menu.uikitml).
const LEADERBOARD_ROWS = 10;

type MenuPage = 'main' | 'achievements' | 'settings' | 'leaderboard';

// Player display names come from VIVERSE and can contain anything, but the
// panel's MSDF font atlas only has printable ASCII — anything else would
// render as missing glyphs, so it's stripped (falling back to a neutral name).
function displayName(raw: string): string {
  const clean = raw.replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'Traveler';
  return clean.length > 24 ? `${clean.slice(0, 23)}-` : clean;
}

function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

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
  // Two alternative rows for the achievements page — the Leaderboard cube
  // only exists once leaderboard data has actually loaded (see _activeRow),
  // so on any failure (or a host without a leaderboard) the page looks
  // exactly as it did before the leaderboard existed.
  private _achievementsRow!: CubeRow;
  private _achievementsLeaderboardRow!: CubeRow;
  private _leaderboardRow!: CubeRow;
  private _settingsRow!: CubeRow;
  private _startButton!: PokeCubeButton;
  private _achievementsButton!: PokeCubeButton;
  private _settingsButton!: PokeCubeButton;
  private _passthroughButton!: PokeCubeButton;
  private _notificationsButton!: PokeCubeButton;

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
  private _scratchPokePos = new Vector3();

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

    entity.addComponent(PanelUI, { config: '/ui/start-menu.json', maxWidth: 1.0, maxHeight: PANEL_MAX_HEIGHT });
    // View-locked, same as NotificationHudSystem — this is the first thing
    // the player sees, so it shouldn't require hunting around for it.
    entity.addComponent(Follower, {
      target: this.player.head,
      // Raised above eye height (vs. the cube rows' own CUBE_HEIGHT, which
      // sits slightly below) so the title/hint text clears the nearer
      // poke-cube row instead of being visually crowded by it.
      offsetPosition: [0, PANEL_OFFSET_Y, PANEL_OFFSET_Z],
      behavior: FollowBehavior.FaceTarget,
      tolerance: 0.02,
      speed: 6,
      maxAngle: 10,
    });

    // Lowered (same LOWER_CUBE_HEIGHT as the achievements/leaderboard rows)
    // so the cubes' labels sit clear below the title panel instead of
    // covering its bottom edge — where the shared comet-count lines live.
    this._mainRow = this._buildCubeRow(['Achievements', 'Start', 'Settings'], [0, LOWER_CUBE_HEIGHT, -CUBE_DISTANCE]);
    [this._achievementsButton, this._startButton, this._settingsButton] = this._mainRow.buttons;

    // Same distance as every other row, but lower — see the comment above
    // PANEL_MAX_HEIGHT.
    this._achievementsRow = this._buildCubeRow(['Back'], [0, LOWER_CUBE_HEIGHT, -CUBE_DISTANCE]);
    this._achievementsRow.rootObject.visible = false;
    for (const button of this._achievementsRow.buttons) button.setEnabled(false);
    this._achievementsLeaderboardRow = this._buildCubeRow(['Leaderboard', 'Back'], [0, LOWER_CUBE_HEIGHT, -CUBE_DISTANCE]);
    this._achievementsLeaderboardRow.rootObject.visible = false;
    for (const button of this._achievementsLeaderboardRow.buttons) button.setEnabled(false);
    // Same lowered spot — the leaderboard list is as tall as the
    // achievements one.
    this._leaderboardRow = this._buildCubeRow(['Back'], [0, LOWER_CUBE_HEIGHT, -CUBE_DISTANCE]);
    this._leaderboardRow.rootObject.visible = false;
    for (const button of this._leaderboardRow.buttons) button.setEnabled(false);

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

        // Shared comet count / own count / own rank under the title — each
        // line only appears once its own data exists (see
        // _refreshCommunityLines). Subscribed only once the document exists,
        // since the lines live in it.
        const refreshLines = () => this._refreshCommunityLines(doc);
        this.cleanupFuncs.push(cometStats.subscribe(refreshLines));
        this.cleanupFuncs.push(cometsReleased.subscribe(refreshLines));
        this.cleanupFuncs.push(
          cometLeaderboard.subscribe(() => {
            refreshLines();
            // Leaderboard data arriving (or refreshing) while the player is
            // already on a page that depends on it — re-open in place so the
            // Leaderboard cube appears / the rows update.
            if (this._page === 'achievements' || this._page === 'leaderboard') this._openPage(this._page);
          }),
        );

        this._startAction = () => {
          this._recenterToHead();
          this._director.start();
          getGlobals(this.world).gameStarted.value = true;
          this._hideAll();
        };
      },
      true,
    );
  }

  private _allRows(): CubeRow[] {
    return [
      this._mainRow,
      this._achievementsRow,
      this._achievementsLeaderboardRow,
      this._leaderboardRow,
      this._settingsRow,
    ];
  }

  private _hideAll(): void {
    this._panelObject.visible = false;
    for (const row of this._allRows()) {
      row.rootObject.visible = false;
      for (const button of row.buttons) button.setEnabled(false);
    }
  }

  // DevJumpSystem (MCP test hook) skips the Start button, so without this the
  // cube rows' flourish meshes (12 x ~8.9K tris) stay drawn in front of the
  // player for the whole test — inflating any perf reading taken after a
  // dev-jump. Same hide the real Start press does.
  dismissForDevJump(): void {
    this._hideAll();
  }

  // Builds one Follower-driven row of poke-cubes, centered around local
  // x=0 (see cubeRowOffsets) — the same shared layout, at the same standard
  // CUBE_HEIGHT/CUBE_DISTANCE spot, every screen in this menu uses (main/
  // achievements/settings), just with a different button count/labels each
  // time — see `offsetPosition`'s own default. Overridable, but nothing
  // currently overrides it (the achievements row's Back cube used to, see
  // git history, until that read as too far to comfortably reach).
  private _buildCubeRow(
    labels: string[],
    offsetPosition: [number, number, number] = [0, CUBE_HEIGHT, -CUBE_DISTANCE],
  ): CubeRow {
    const rootEntity = this.world.createTransformEntity();
    const rootObject = rootEntity.object3D!;
    rootEntity.addComponent(Follower, {
      target: this.player.head,
      offsetPosition,
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
      if (this._startAction && this._firedPoke(this._startButton, delta, pokeReady)) this._startAction();
      if (this._firedPoke(this._achievementsButton, delta, pokeReady)) this._openPage('achievements');
      if (this._firedPoke(this._settingsButton, delta, pokeReady)) this._openPage('settings');
    } else if (this._page === 'achievements') {
      const row = this._activeRow();
      if (row === this._achievementsLeaderboardRow) {
        if (this._firedPoke(row.buttons[0], delta, pokeReady)) this._openPage('leaderboard');
        else if (this._firedPoke(row.buttons[1], delta, pokeReady)) this._openPage('main');
      } else if (this._firedPoke(row.buttons[0], delta, pokeReady)) {
        this._openPage('main');
      }
    } else if (this._page === 'leaderboard') {
      if (this._firedPoke(this._leaderboardRow.buttons[0], delta, pokeReady)) this._openPage('achievements');
    } else if (this._page === 'settings') {
      if (this._firedPoke(this._passthroughButton, delta, pokeReady)) {
        const globals = getGlobals(this.world);
        globals.passthroughEnabled.value = !globals.passthroughEnabled.value;
        this._passthroughButton.setLabel(this._passthroughLabel(globals.passthroughEnabled.value));
      }
      if (this._firedPoke(this._notificationsButton, delta, pokeReady)) {
        const globals = getGlobals(this.world);
        globals.notificationsEnabled.value = !globals.notificationsEnabled.value;
        this._notificationsButton.setLabel(this._notificationsLabel(globals.notificationsEnabled.value));
      }
      if (this._firedPoke(this._settingsRow.buttons[2], delta, pokeReady)) this._openPage('main');
    }

    this._updateStartPinch(delta);
  }

  // Runs a poke-cube button's own update() and, on the exact frame it fires,
  // buzzes whichever controller poked it — see HapticsSystem.resolvePokeHand
  // for how "whichever" is guessed (PokeInteractable/Pressed carry no
  // pointer/hand info of their own).
  private _firedPoke(button: PokeCubeButton, delta: number, pokeReady: boolean): boolean {
    const fired = button.update(delta, pokeReady);
    if (fired) {
      button.group.getWorldPosition(this._scratchPokePos);
      const haptics = this.world.getSystem(HapticsSystem);
      const hand = haptics?.resolvePokeHand(this._scratchPokePos);
      if (hand) haptics?.pulse(hand, HapticPattern.MediumPulse);
    }
    return fired;
  }

  private _activeRow(): CubeRow {
    if (this._page === 'achievements') {
      return cometLeaderboard.peek() ? this._achievementsLeaderboardRow : this._achievementsRow;
    }
    if (this._page === 'leaderboard') return this._leaderboardRow;
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
  // see DOUBLE_PINCH_HOLD_SECONDS's own comment. Kept as a parallel fast
  // path even though its on-screen hint text was removed (per direct
  // feedback — the poke-and-hold Start cube is the discoverable path now).
  private _updateStartPinch(delta: number): void {
    if (this._startTriggered || !this._startAction || this._page !== 'main') return;

    const leftPinching = this.input.xr.gamepads.left?.getSelecting() ?? false;
    const rightPinching = this.input.xr.gamepads.right?.getSelecting() ?? false;

    if (leftPinching && rightPinching) {
      this._pinchHoldSeconds += delta;
      if (this._pinchHoldSeconds >= DOUBLE_PINCH_HOLD_SECONDS) {
        this._startTriggered = true;
        this.world.getSystem(HapticsSystem)?.pulseBoth(HapticPattern.MediumPulse);
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
    const previousPage = this._page;
    this._page = page;
    const doc = this._doc();
    doc?.getElementById('page-main')?.setProperties({ display: page === 'main' ? 'flex' : 'none' });
    doc?.getElementById('page-achievements')?.setProperties({ display: page === 'achievements' ? 'flex' : 'none' });
    doc?.getElementById('page-settings')?.setProperties({ display: page === 'settings' ? 'flex' : 'none' });
    doc?.getElementById('page-leaderboard')?.setProperties({ display: page === 'leaderboard' ? 'flex' : 'none' });

    const activeRow = this._activeRow();
    for (const row of this._allRows()) {
      const active = row === activeRow;
      row.rootObject.visible = active;
      for (const button of row.buttons) {
        button.setEnabled(active);
        if (active) button.reset();
      }
    }

    if (page === 'achievements' && doc) this._refreshAchievementRows(doc);
    if (page === 'leaderboard' && doc) this._refreshLeaderboardRows(doc);
    // Not on an in-place re-open (data refresh while already viewing it).
    if (page === 'leaderboard' && previousPage !== 'leaderboard') track('leaderboard_opened');
  }

  // Each line is independent and hidden whenever its own data is missing —
  // a failed shared-count fetch hides only that line, a failed rank lookup
  // only drops the "#rank" suffix, and so on. Runs only when one of the
  // underlying signals changes, never per-frame.
  private _refreshCommunityLines(doc: UIKitDocument): void {
    const setLine = (id: string, text: string | null) => {
      doc.getElementById(id)?.setProperties({
        display: text ? 'flex' : 'none',
        ...(text ? { text } : {}),
      } as Record<string, unknown>);
    };

    const stats = cometStats.peek();
    setLine(
      'community-total',
      stats ? `${formatCount(stats.total)} ${stats.total === 1 ? 'comet' : 'comets'} released` : null,
    );
    // Drifted comets (timed out without choosing) end up orbiting, so they
    // read as orbit here — kept separate only in the stored data.
    setLine(
      'community-split',
      stats
        ? `${formatCount(stats.orbit + stats.drifted)} into orbit and ${formatCount(stats.launch)} into the unknown`
        : null,
    );

    const mine = cometsReleased.peek();
    setLine(
      'community-me',
      mine > 0
        ? `You released ${formatCount(mine)} ${mine === 1 ? 'comet' : 'comets'}`
        : null,
    );
  }

  private _refreshLeaderboardRows(doc: UIKitDocument): void {
    const view = cometLeaderboard.peek();
    const entries = view?.entries ?? [];
    for (let i = 0; i < LEADERBOARD_ROWS; i++) {
      const entry = entries[i];
      doc.getElementById(`lb-row-${i}`)?.setProperties({ display: entry ? 'flex' : 'none' });
      if (!entry) continue;
      doc.getElementById(`lb-rank-${i}`)?.setProperties({ text: `#${entry.rank}` } as Record<string, unknown>);
      doc.getElementById(`lb-name-${i}`)?.setProperties({ text: displayName(entry.name) } as Record<string, unknown>);
      doc.getElementById(`lb-value-${i}`)?.setProperties({ text: formatCount(entry.value) } as Record<string, unknown>);
    }

    const me = view?.me;
    doc.getElementById('lb-me')?.setProperties({
      display: me ? 'flex' : 'none',
      ...(me ? { text: `You are #${formatCount(me.rank)} with ${formatCount(me.value)}` } : {}),
    } as Record<string, unknown>);
    // Only for guests, and only alongside a leaderboard that did load.
    doc.getElementById('lb-hint')?.setProperties({ display: view && platformUser.peek() === null ? 'flex' : 'none' });
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
    // A run just ended — pick up this player's own new comet and everyone
    // else's since boot. Both are fire-and-forget and never reject.
    void fetchCometStats();
    void refreshLeaderboard();
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
      if (def.secret) {
        doc.getElementById(`ach-title-${def.id}`)?.setProperties({
          text: unlocked ? def.title : SECRET_TITLE,
        } as Record<string, unknown>);
        doc.getElementById(`ach-desc-${def.id}`)?.setProperties({
          text: unlocked ? def.description : SECRET_DESCRIPTION,
        } as Record<string, unknown>);
      }
    }
  }
}
