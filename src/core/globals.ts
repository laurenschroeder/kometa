import { signal, Signal } from '@preact/signals-core';
import type { World } from '@iwsdk/core';
import { Phase } from './phase.js';

// Single typed source of truth for cross-system shared state, stored on
// world.globals (a plain object elics leaves untyped) so every system reads
// the same signals instead of each inventing its own polling/plumbing.
export interface KometaGlobals {
  gamePhase: Signal<Phase>;
  phaseComplete: Signal<boolean>;
  cometMomentum: Signal<number>;
  // Raw comet speed in m/s — unlike cometMomentum (clamped/normalized 0-1
  // against MOMENTUM_REFERENCE_SPEED), this preserves true magnitude above
  // that reference, so it's the one debug readouts should use.
  cometSpeed: Signal<number>;
  // Flips true once the Start Menu's Start button is dwell-selected — gates
  // NotificationHudSystem's phase-blurb triggers so they can't pop up while
  // the start menu is still on screen (gamePhase is already Stardust at
  // signal-creation time, well before GameDirectorSystem.start() is called).
  gameStarted: Signal<boolean>;
  // Which pebble type (see pebble-type.ts's 0=soul/1=organic/2=gas ids) was
  // dominant in Chapter 2 — written once by PebbleWeavingSystem's win
  // condition, read by ConstellationsSystem to pick which constellation set
  // to show. Also the natural hook for later ending-branch work.
  dominantPebbleType: Signal<number>;
  // Name of whichever constellation's path the player traced first in
  // Chapter 2.5 — set once by ConstellationsSystem, nothing downstream reads
  // it yet beyond that phase's own notification.
  celestialSymbol: Signal<string | null>;
  // Normalized (sum to 1) capture-proportion weights across PEBBLE_TYPES
  // (soul dust/organic matter/volatile gasses), set once by
  // PebbleWeavingSystem's win condition alongside dominantPebbleType. Read by
  // PebbleCometPresentationSystem to weighted-randomly assign each permanent
  // body pebble one of the three saturated PEBBLE_TYPES colors — a flat RGB
  // blend of all three (the earlier approach) collapses toward gray/white
  // whenever capture is roughly even, which read as the body losing its
  // color; per-pebble assignment keeps it visibly multi-colored like Chapter
  // 2's own field pebbles. Default is an even three-way split — only
  // relevant if the body becomes visible before Chapter 2 ever completes
  // (e.g. a dev-menu jump straight to Seeding).
  pebbleTypeWeights: Signal<[number, number, number]>;
  // Flips true the instant EarthSituationsVfxSystem's crown-rise mechanic
  // (see crown-rise.ts) attaches to the comet's head — ConstellationsSystem
  // polls this instead of a flat hold timer so celestialSymbolMessage/
  // phaseComplete can't fire until the ~30s crown cinematic has actually
  // finished. Routed through globals rather than a direct import so
  // constellations-system.ts stays decoupled from the crown's visual
  // mechanic. Reset to false in EarthSituationsVfxSystem._resetAll() on a
  // fresh Phase.Stardust loop.
  crownLanded: Signal<boolean>;
}

export function bootstrapGlobals(world: World): KometaGlobals {
  const globals = world.globals as unknown as KometaGlobals;
  globals.gamePhase = signal(Phase.Stardust);
  globals.phaseComplete = signal(false);
  globals.cometMomentum = signal(0);
  globals.cometSpeed = signal(0);
  globals.gameStarted = signal(false);
  globals.dominantPebbleType = signal(0);
  globals.celestialSymbol = signal(null);
  globals.pebbleTypeWeights = signal([1 / 3, 1 / 3, 1 / 3]);
  globals.crownLanded = signal(false);
  return globals;
}

export function getGlobals(world: World): KometaGlobals {
  return world.globals as unknown as KometaGlobals;
}
