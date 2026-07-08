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
}

export function bootstrapGlobals(world: World): KometaGlobals {
  const globals = world.globals as unknown as KometaGlobals;
  globals.gamePhase = signal(Phase.Stardust);
  globals.phaseComplete = signal(false);
  globals.cometMomentum = signal(0);
  return globals;
}

export function getGlobals(world: World): KometaGlobals {
  return world.globals as unknown as KometaGlobals;
}
