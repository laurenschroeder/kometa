import { createSystem, VisibilityState } from '@iwsdk/core';
import { getGlobals } from './globals.js';
import { Phase } from './phase.js';
import { setTelemetryHold, track } from './telemetry.js';

// Turns the game's existing globals signals into analytics events (see
// telemetry.ts), so phase systems don't each need their own tracking calls.
// Purely subscription-driven — no update(), nothing per-frame. One-off
// moments that have no signal (achievement unlocks) call track() directly
// from their own owner instead.
//
// Phase events carry `run` (1-based count of Stardust entries since boot) so
// a festival headset handed between players can still be read run-by-run.
export class TelemetrySystem extends createSystem({}) {
  private _phaseEnteredAt = 0;
  private _run = 0;

  init(): void {
    const globals = getGlobals(this.world);

    // subscribe() fires once immediately with the boot state (NonImmersive),
    // so xr_exited is only tracked after a session has actually been entered.
    let wasInXR = false;
    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe((state) => {
        if (state === VisibilityState.Visible && !wasInXR) {
          wasInXR = true;
          track('xr_entered');
        } else if (state === VisibilityState.NonImmersive && wasInXR) {
          wasInXR = false;
          track('xr_exited');
        }
      }),
    );

    // Analytics wait out immersive play (see setTelemetryHold). Driven by the
    // XRSession's own events rather than world.visibilityState, which was
    // measured still reading Visible after a session had ended — leaving
    // events held until the page closed.
    const onSessionStart = () => {
      const session = this.xrManager.getSession();
      if (!session) return;
      setTelemetryHold(session.visibilityState === 'visible');
      session.addEventListener('visibilitychange', () => setTelemetryHold(session.visibilityState === 'visible'));
    };
    const onSessionEnd = () => setTelemetryHold(false);
    this.xrManager.addEventListener('sessionstart', onSessionStart);
    this.xrManager.addEventListener('sessionend', onSessionEnd);
    this.cleanupFuncs.push(() => {
      this.xrManager.removeEventListener('sessionstart', onSessionStart);
      this.xrManager.removeEventListener('sessionend', onSessionEnd);
    });

    this.cleanupFuncs.push(
      globals.gameStarted.subscribe((started) => {
        if (!started) return;
        track('game_started');
        this._enterPhase(globals.gamePhase.peek());
      }),
    );

    this.cleanupFuncs.push(
      globals.gamePhase.subscribe((phase) => {
        if (globals.gameStarted.peek()) this._enterPhase(phase);
      }),
    );

    this.cleanupFuncs.push(
      globals.phaseComplete.subscribe((complete) => {
        if (!complete || !globals.gameStarted.peek()) return;
        track('phase_completed', {
          phase: globals.gamePhase.peek(),
          seconds: this._secondsInPhase(),
          run: this._run,
        });
      }),
    );
  }

  private _enterPhase(phase: Phase): void {
    if (phase === Phase.Stardust) this._run++;
    this._phaseEnteredAt = performance.now();
    track('phase_entered', { phase, run: this._run });
  }

  private _secondsInPhase(): number {
    return Math.round((performance.now() - this._phaseEnteredAt) / 1000);
  }
}
