import { createComponent, createSystem, Types } from '@iwsdk/core';
import { GameDirectorSystem } from './game-director-system.js';
import { resetAchievements } from './achievement-store.js';
import { getGlobals } from './globals.js';
import { Phase } from './phase.js';
import { StartMenuSystem } from './start-menu-system.js';
import { PlanetSeedingSystem } from '../phases/planet-seeding/planet-seeding-system.js';

// MCP/agent-testing hook — NOT a player-facing feature (see PhaseMenuSystem
// for the actual in-headset dev menu, which needs real XR controller input
// to reach). This exists so an automated agent driving the game through the
// IWSDK MCP tools (which can set component fields directly but can't
// reliably simulate the flip-hold/5-tap gestures PhaseMenuSystem needs) can
// jump straight to any phase by writing this component's `target` field to a
// Phase value, e.g. via `ecs_set_component` on the singleton entity this
// creates. Cleared back to '' the instant the jump is applied, so setting
// the same phase twice in a row still re-triggers it. Same DEV_MENU_ENABLED
// gate as PhaseMenuSystem — never reachable in a production build.
export const DevJump = createComponent('DevJump', {
  target: { type: Types.String, default: '' },
  // Set true while Phase.Seeding is current to instantly color every
  // coverage cell and win the phase — see PlanetSeedingSystem.
  // devForceFullCoverage()'s own comment for why this exists (reproducing
  // Leg A's real, fully-planted cost from a dev-menu jump).
  forceSeedingWin: { type: Types.Boolean, default: false },
  // Set true to wipe persisted achievements/combos (same as the dev menu's
  // reset button) so unlock popups fire again on the next run.
  resetAchievements: { type: Types.Boolean, default: false },
});

const DEV_JUMP_ENABLED = import.meta.env.DEV;
// `?devjump=seeding,win,launch` — the same jumps as the component fields
// above, but from the URL, for a real headset the MCP tools can't drive.
// Steps run one per DEVJUMP_STEP_SECONDS, once the player enters XR (so
// Launch's zones get placed around the real head pose); `win` =
// forceSeedingWin, anything else is a Phase value.
const DEVJUMP_STEP_SECONDS = 1.5;
const URL_STEPS = DEV_JUMP_ENABLED
  ? (new URLSearchParams(location.search).get('devjump') ?? '').split(',').filter(Boolean)
  : [];

export class DevJumpSystem extends createSystem({
  jumps: { required: [DevJump] },
}) {
  private _director!: GameDirectorSystem;
  private _urlSteps = [...URL_STEPS];
  private _urlStepTimer = 0;

  init(): void {
    this._director = this.world.getSystem(GameDirectorSystem)!;
    const jumpEntity = this.world.createEntity().addComponent(DevJump);
    // Same fields, reachable from a remote DevTools session (Chrome remote
    // debugging over adb) on a real headset, where the MCP tools can't reach:
    // `__kometaDevJump({ target: 'launch' })`.
    if (DEV_JUMP_ENABLED) {
      // Raw world handle for remote profiling experiments.
      (globalThis as Record<string, unknown>).__kometaWorld = this.world;
      (globalThis as Record<string, unknown>).__kometaDevJump = (fields: Record<string, string | boolean>) => {
        for (const [key, value] of Object.entries(fields)) {
          jumpEntity.setValue(DevJump, key as 'target', value as string);
        }
      };
    }
  }

  update(delta: number): void {
    if (!DEV_JUMP_ENABLED) return;
    if (this._urlSteps.length > 0 && this.xrManager.isPresenting) {
      this._urlStepTimer += delta;
      if (this._urlStepTimer >= DEVJUMP_STEP_SECONDS) {
        this._urlStepTimer = 0;
        const step = this._urlSteps.shift()!;
        for (const entity of this.queries.jumps.entities) {
          if (step === 'win') entity.setValue(DevJump, 'forceSeedingWin', true);
          else entity.setValue(DevJump, 'target', step);
        }
      }
    }
    for (const entity of this.queries.jumps.entities) {
      const target = entity.getValue(DevJump, 'target') as string;
      if (!target) continue;
      entity.setValue(DevJump, 'target', '');
      if ((Object.values(Phase) as string[]).includes(target)) {
        // Hides the still-gating Start Menu panel (see StartMenuSystem) and
        // its own gamePhase-blurb suppression — a dev-jump never goes
        // through the Start button dwell-select that normally flips this.
        getGlobals(this.world).gameStarted.value = true;
        this.world.getSystem(StartMenuSystem)?.dismissForDevJump();
        this._director.jumpToPhase(target as Phase);
      } else {
        console.warn(`[DevJump] '${target}' is not a valid Phase.`);
      }
    }
    for (const entity of this.queries.jumps.entities) {
      if (!entity.getValue(DevJump, 'forceSeedingWin')) continue;
      entity.setValue(DevJump, 'forceSeedingWin', false);
      this.world.getSystem(PlanetSeedingSystem)?.devForceFullCoverage();
    }
    for (const entity of this.queries.jumps.entities) {
      if (!entity.getValue(DevJump, 'resetAchievements')) continue;
      entity.setValue(DevJump, 'resetAchievements', false);
      resetAchievements();
    }
  }
}
