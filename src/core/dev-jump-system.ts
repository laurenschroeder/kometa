import { createComponent, createSystem, Types } from '@iwsdk/core';
import { GameDirectorSystem } from './game-director-system.js';
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
});

const DEV_JUMP_ENABLED = import.meta.env.DEV;

export class DevJumpSystem extends createSystem({
  jumps: { required: [DevJump] },
}) {
  private _director!: GameDirectorSystem;

  init(): void {
    this._director = this.world.getSystem(GameDirectorSystem)!;
    this.world.createEntity().addComponent(DevJump);
  }

  update(): void {
    if (!DEV_JUMP_ENABLED) return;
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
  }
}
