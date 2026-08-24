import { createSystem } from '@iwsdk/core';
import { ACHIEVEMENTS } from './achievement-list.js';
import { unlockAchievement } from './achievement-store.js';
import { getGlobals } from './globals.js';
import { NotificationHudSystem } from './notification-hud-system.js';
import { Phase } from './phase.js';

// Keyed by the phase just entered — entering Pebbles means Stardust was just
// completed, and so on. Purely gamePhase-driven per the current scope (no
// access to any gameplay phase system's internals); a future granular
// milestone achievement doesn't need to touch this system at all — it can
// call unlockAchievement() directly from wherever that moment happens.
const PHASE_COMPLETION_ACHIEVEMENT: Partial<Record<Phase, string>> = {
  [Phase.Pebbles]: 'first-light',
  [Phase.Seeding]: 'pebble-pusher',
  [Phase.Constellations]: 'world-seeder',
  [Phase.Launch]: 'brace-for-impact',
  [Phase.Finale]: 'among-the-stars',
};

// Always-on (never GameDirector-managed), like NotificationHudSystem —
// watches globals.gamePhase for phase-completion achievements and detects a
// full Finale -> Stardust loop for the "full-circle" achievement.
export class AchievementSystem extends createSystem({}) {
  private _prevPhase: Phase | null = null;

  init(): void {
    this.cleanupFuncs.push(
      getGlobals(this.world).gamePhase.subscribe((phase) => this._onPhaseChange(phase)),
    );
  }

  private _onPhaseChange(phase: Phase): void {
    const prev = this._prevPhase;
    this._prevPhase = phase;
    // Ignore the immediate-fire on subscribe (boot into Stardust isn't a
    // completion of anything).
    if (prev === null) return;

    const completionId = PHASE_COMPLETION_ACHIEVEMENT[phase];
    if (completionId) this._tryUnlock(completionId);

    if (prev === Phase.Finale && phase === Phase.Stardust) {
      this._tryUnlock('full-circle');
    }
  }

  private _tryUnlock(id: string): void {
    if (!unlockAchievement(id)) return;
    const def = ACHIEVEMENTS.find((a) => a.id === id);
    if (!def) return;
    this.world
      .getSystem(NotificationHudSystem)
      ?.notify(`Achievement unlocked: ${def.title}`, 3.5);
  }
}
