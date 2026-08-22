import { createSystem } from '@iwsdk/core';
import { getGlobals } from './globals.js';
import { nextPhase, Phase } from './phase.js';

// Structural subset of elics' System — local so definePhase() call sites
// don't have to fight System<S,Q> generics just to pass an instance in.
interface PhaseGatedSystem {
  play(): void;
  stop(): void;
}

export interface PhaseConfig {
  // play()'d on entering this phase, stop()'d on exiting it. Never include
  // the always-on comet/presentation systems here.
  systems: PhaseGatedSystem[];
  // Force-advance after N seconds of this phase's own elapsed time,
  // regardless of phaseComplete. Omit to rely purely on the win condition
  // (globals.phaseComplete, set by one of this phase's own systems).
  timeoutSeconds?: number;
}

// Cycles the game through Phase.PHASE_ORDER. A phase advances the instant
// EITHER globals.phaseComplete becomes true OR its own elapsed time reaches
// timeoutSeconds — whichever happens first. This system deliberately knows
// nothing about how any phase's win condition works, only that one shared
// boolean flips; timers exist purely so the ~10-15 minute target experience
// never stalls indefinitely on a phase the player can't or won't complete.
//
// Must be registered at priority 0 — lower than every phase-gated system —
// so a transition detected this frame's update() gates play()/stop() before
// those systems run later in the same tick (World.update() iterates systems
// in ascending priority order, checking isPaused live at call time).
export class GameDirectorSystem extends createSystem({}) {
  private _phases = new Map<Phase, PhaseConfig>();
  private _elapsedInPhase = 0;
  private _started = false;
  private _warnedMissing = new Set<Phase>();

  // Called from index.ts once per phase, in any order, after that phase's
  // own systems are registered — immediately stop()s them so call order
  // never matters. Only start() decides which phase is actually live.
  definePhase(phase: Phase, config: PhaseConfig): void {
    if (this._phases.has(phase)) {
      console.warn(`[GameDirector] '${phase}' already defined, ignoring.`);
      return;
    }
    this._phases.set(phase, config);
    for (const system of config.systems) system.stop();
  }

  // Call once, after every definePhase(), to enter globals.gamePhase's
  // current value (Phase.Stardust at a fresh boot).
  start(): void {
    if (this._started) return;
    this._started = true;
    this._elapsedInPhase = 0;
    const { gamePhase } = getGlobals(this.world);
    this._playPhase(gamePhase.value);
    console.info(`[GameDirector] started at '${gamePhase.value}'`);
  }

  update(delta: number): void {
    if (!this._started) return;
    const globals = getGlobals(this.world);
    const phase = globals.gamePhase.value;
    const config = this._phases.get(phase);
    if (!config) {
      if (!this._warnedMissing.has(phase)) {
        console.warn(`[GameDirector] no definePhase() for '${phase}' — it will never advance.`);
        this._warnedMissing.add(phase);
      }
      return;
    }

    this._elapsedInPhase += delta;
    const wonByCondition = globals.phaseComplete.value;
    const wonByTimeout =
      config.timeoutSeconds !== undefined && this._elapsedInPhase >= config.timeoutSeconds;

    if (wonByCondition || wonByTimeout) {
      this._transition(phase, nextPhase(phase), wonByCondition ? 'winCondition' : 'timeout');
    }
  }

  // Jump directly to an arbitrary phase, bypassing win condition/timeout —
  // e.g. a dev/debug menu. Runs the exact same stop/reset/play sequence as
  // an automatic transition, so play()/stop() gating and phaseComplete/timer
  // resets stay correct no matter how a transition was triggered.
  jumpToPhase(target: Phase): void {
    const { gamePhase } = getGlobals(this.world);
    const from = gamePhase.value;
    if (from === target) return;
    this._transition(from, target, 'manual');
  }

  private _transition(from: Phase, to: Phase, reason: 'winCondition' | 'timeout' | 'manual'): void {
    const globals = getGlobals(this.world);

    this._stopPhase(from);
    globals.phaseComplete.value = false;
    this._elapsedInPhase = 0;
    globals.gamePhase.value = to;
    this._playPhase(to);

    console.info(`[GameDirector] ${from} -> ${to} (${reason})`);
  }

  private _playPhase(phase: Phase): void {
    this._phases.get(phase)?.systems.forEach((s) => s.play());
  }

  private _stopPhase(phase: Phase): void {
    this._phases.get(phase)?.systems.forEach((s) => s.stop());
  }
}
