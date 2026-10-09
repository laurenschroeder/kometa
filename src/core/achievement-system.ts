import { AudioListener, createSystem, Vector3 } from '@iwsdk/core';
import { AchievementSynth } from '../vfx/audio/achievement-synth.js';
import { ACHIEVEMENTS } from './achievement-list.js';
import { unlockAchievement } from './achievement-store.js';
import { getGlobals } from './globals.js';
import { HapticPattern, HapticsSystem } from './haptics-system.js';
import { NotificationHudSystem } from './notification-hud-system.js';
import { track } from './telemetry.js';
import { getSharedAudioListener } from '../vfx/audio/shared-audio-listener.js';
import { devPerfMark } from './dev-perf-logger.js';

// A shared "unlock" service, not a self-driving one — every achievement in
// achievement-list.ts is now tied to a specific mission/gameplay outcome
// (see that file's own comment) rather than a generic "you reached the next
// phase," so there's no single gamePhase hook left to drive them all from
// here. Instead, whichever system owns that moment (StardustSystem,
// PebbleWeavingSystem, CometHandoffSystem, OrbitalLaunchSystem,
// FateEventSystem) calls unlock() directly via
// this.world.getSystem(AchievementSystem) the instant its own condition is
// met. Always-on (never GameDirector-managed) purely because it owns the
// audio listener/synth those callers share — same idiom as
// NotificationHudSystem.
export class AchievementSystem extends createSystem({}) {
  private _audioListener!: AudioListener;
  private _synth!: AchievementSynth;
  private _scratchPos!: Vector3;
  // Chimes are queued and played from update() a tick later rather than
  // inline: unlocks mostly fire on a phase-transition frame, and building
  // the chime's oscillator graph measured ~3.7ms on Quest.
  private _pendingChimes = 0;
  private _chimeSkipTicks = 0;

  init(): void {
    this._audioListener = getSharedAudioListener(this.world);
    this._synth = new AchievementSynth();
    this._synth.build(this._audioListener, this.scene);
    this._scratchPos = new Vector3();
  }

  // Idempotent (see unlockAchievement) — safe for a caller to call every
  // time its condition merely holds, not just the first time it becomes
  // true. Queues its popup via NotificationHudSystem.notify() same as any
  // other message, so it takes its turn in line rather than interrupting
  // whatever's already showing — each call site picks a moment where that
  // queuing reads as natural (bundled alongside a phase's own completion
  // message) rather than landing mid-cinematic.
  unlock(id: string): void {
    if (!unlockAchievement(id)) return;
    track('achievement_unlocked', { id });
    devPerfMark(`unlock:${id}`);
    const def = ACHIEVEMENTS.find((a) => a.id === id);
    if (!def) return;
    // notify() itself already self-mutes its box/chime when notifications
    // are off (see NotificationHudSystem's own _currentMuted) — this call
    // stays unconditional so the queue/hasShown() bookkeeping there is
    // unaffected. Only this achievement-specific jingle needs its own gate.
    this.world.getSystem(NotificationHudSystem)?.notify(`Achievement unlocked: ${def.title}`, 3.5);
    this.world.getSystem(HapticsSystem)?.pulseBoth(HapticPattern.CelebratoryBurst);
    if (!getGlobals(this.world).notificationsEnabled.peek()) return;
    this._queueChime();
  }

  // Same ascending chime as unlock() above, for a moment that deserves its
  // own "you did it" cue but isn't a tracked achievement (e.g.
  // StardustSystem/PebbleWeavingSystem's own win condition, which already
  // gets its own completion notification and doesn't need an
  // unlockAchievement() record on top of it) — no popup, no achievement id,
  // just the sound.
  playSuccessChime(): void {
    this._queueChime();
  }

  private _queueChime(): void {
    this._pendingChimes++;
    this._chimeSkipTicks = 1;
  }

  update(): void {
    if (this._pendingChimes === 0) return;
    if (this._chimeSkipTicks > 0) {
      this._chimeSkipTicks--;
      return;
    }
    this._pendingChimes--;
    // Not tied to any world location — just plays roughly where the player
    // is looking, same as the HUD notification it accompanies.
    this.camera.getWorldPosition(this._scratchPos);
    this._synth.playUnlock(this._scratchPos);
  }
}
