import { createSystem, Vector3 } from '@iwsdk/core';
import type { StatefulGamepad } from '@iwsdk/core';
import { CometBody } from '../comet/comet-body-component.js';
import { CometCaught, CometReleased, CometSnapped } from '../comet/comet-event-tags.js';
import { HandAnchor, HandSide } from '../comet/hand-anchor-component.js';

// Flip on to log every fire (hand/pattern/intensity) via console.debug — the
// WebXR emulator can't produce real rumble, so this is how a trigger's
// timing/hand/pattern gets verified (via browser_get_console_logs) before a
// real-device pass. Same "module-level const toggle" idiom as
// HAND_PROGRESS_HUD_ENABLED (hand-progress-hud-system.ts).
const DEBUG_HAPTICS = false;

export enum HapticPattern {
  LightTick,
  MediumPulse,
  StrongPulse,
  ReleaseKick,
  CelebratoryBurst,
}

// Single tuning surface for every pattern's raw numbers — callers reference
// intent (LightTick/StrongPulse/...), never a magnitude/duration directly.
const PATTERN_TABLE: Record<HapticPattern, { intensity: number; durationMs: number }> = {
  [HapticPattern.LightTick]: { intensity: 0.25, durationMs: 35 },
  [HapticPattern.MediumPulse]: { intensity: 0.5, durationMs: 70 },
  [HapticPattern.StrongPulse]: { intensity: 0.85, durationMs: 110 },
  // Base value only — comet-release actually scales this by throw speed, see
  // the `released` query subscription below.
  [HapticPattern.ReleaseKick]: { intensity: 0.7, durationMs: 90 },
  [HapticPattern.CelebratoryBurst]: { intensity: 0.6, durationMs: 220 },
};

// Minimum re-trigger interval per pattern, keyed by `${hand}:${pattern}` at
// call time — without this, GatherableField's onAttractStart/onCapture
// callbacks (which can fire many times per second while sweeping through a
// dense field) would spam the actuator into a continuous buzz instead of
// discrete ticks.
const COOLDOWN_MS: Record<HapticPattern, number> = {
  [HapticPattern.LightTick]: 80,
  [HapticPattern.MediumPulse]: 150,
  [HapticPattern.StrongPulse]: 200,
  [HapticPattern.ReleaseKick]: 200,
  [HapticPattern.CelebratoryBurst]: 250,
};

// Release speed (m/s) that reads as "full" ReleaseKick intensity — mirrors
// the magnitude comet-physics-system.ts's own MOMENTUM_REFERENCE_SPEED uses
// for the same kind of speed-to-0-1 mapping, kept as a local constant rather
// than importing that (unexported) one so this file doesn't reach into
// physics internals for a tuning number.
const RELEASE_SPEED_REFERENCE = 3.0;
// Floor on the release intensity scale — even a near-stationary release
// should still read as a distinct "let go" tick, not fade to nothing.
const RELEASE_MIN_SCALE = 0.4;

// Rising-charge pulse cadence/intensity bounds — see
// startRisingCharge/updateRisingCharge. Interval shrinks and intensity grows
// as t01 approaches 1, so a held charge reads as mounting urgency rather
// than a flat metronome.
const CHARGE_MAX_INTERVAL_MS = 500;
const CHARGE_MIN_INTERVAL_MS = 80;
const CHARGE_MIN_INTENSITY = 0.15;
const CHARGE_MAX_INTENSITY = 0.7;
const CHARGE_PULSE_DURATION_MS = 30;

// Legacy (non-standard, but still present on some runtimes/older Quest
// browsers) haptics path — not in lib.dom.d.ts's Gamepad/GamepadHapticActuator
// typings, hence the local shape + cast in _fire below.
interface LegacyHapticActuator {
  pulse?: (value: number, duration: number) => Promise<boolean>;
}
interface LegacyGamepad {
  hapticActuators?: LegacyHapticActuator[];
}

// Central haptics service — every VR-controller feedback moment in the game
// routes through here, same "shared service other systems call directly"
// shape as AchievementSystem, plus the same "subscribe to comet edge-tags"
// shape CometAudioSystem uses for CometSnapped/CometReleased/CometCaught (see
// comet-event-tags.ts). Always-on, never phase-gated — same reasoning as
// CometAudioSystem/AchievementSystem: this feedback applies throughout
// nearly every phase, not just one. Owns every raw tuning number
// (PATTERN_TABLE/COOLDOWN_MS above) so no phase file needs its own magic
// numbers, and owns the no-actuator/hand-tracking fallback (_fire bails
// silently whenever a hand has no gamepad at all, which is always true for
// hand-tracking profiles) so callers never need to guard for that
// themselves. Registered after CometAudioSystem (see index.ts) so this
// frame's CometSnapped/CometReleased/CometCaught tags are already in place.
export class HapticsSystem extends createSystem({
  snapped: { required: [CometBody, HandAnchor, CometSnapped] },
  released: { required: [CometBody, HandAnchor, CometReleased] },
  caught: { required: [CometBody, HandAnchor, CometCaught] },
}) {
  private _cooldowns = new Map<string, number>();
  // Next-allowed-fire time (performance.now() ms) per `${hand}:${key}`
  // rising-charge voice — see startRisingCharge/updateRisingCharge.
  private _chargeNextFire = new Map<string, number>();
  private _scratchVel!: Vector3;
  private _scratchLeftGrip!: Vector3;
  private _scratchRightGrip!: Vector3;

  init(): void {
    this._scratchVel = new Vector3();
    this._scratchLeftGrip = new Vector3();
    this._scratchRightGrip = new Vector3();

    this.queries.snapped.subscribe('qualify', (entity) => {
      const hand = entity.getValue(HandAnchor, 'hand') as string;
      this.pulse(hand, HapticPattern.StrongPulse);
    });
    this.queries.released.subscribe('qualify', (entity) => {
      const hand = entity.getValue(HandAnchor, 'hand') as string;
      const velView = entity.getVectorView(CometBody, 'velocity') as Float32Array;
      this._scratchVel.fromArray(velView);
      const speed = this._scratchVel.length();
      const scale = Math.max(RELEASE_MIN_SCALE, Math.min(1, speed / RELEASE_SPEED_REFERENCE));
      this.pulse(hand, HapticPattern.ReleaseKick, scale);
    });
    this.queries.caught.subscribe('qualify', (entity) => {
      const hand = entity.getValue(HandAnchor, 'hand') as string;
      this.pulse(hand, HapticPattern.StrongPulse);
    });
  }

  // One-shot pulse on `hand`, throttled per-pattern (see COOLDOWN_MS).
  // intensityScale multiplies the pattern's base intensity (clamped to 1) —
  // used by the comet-release edge above to scale with throw speed.
  pulse(hand: string, pattern: HapticPattern, intensityScale = 1): void {
    if (!this._checkCooldown(hand, pattern)) return;
    const gamepad = hand === HandSide.Right ? this.input.xr.gamepads.right : this.input.xr.gamepads.left;
    const { intensity, durationMs } = PATTERN_TABLE[pattern];
    const finalIntensity = Math.min(1, intensity * intensityScale);
    this._fire(gamepad, finalIntensity, durationMs);
    if (DEBUG_HAPTICS) {
      console.debug('[haptics] hand=%s pattern=%s intensity=%s', hand, HapticPattern[pattern], finalIntensity.toFixed(2));
    }
  }

  // Both hands at once — for moments with no single "owning" hand (start-menu
  // double-pinch, achievement unlock, constellation-complete).
  pulseBoth(pattern: HapticPattern, intensityScale = 1): void {
    this.pulse(HandSide.Left, pattern, intensityScale);
    this.pulse(HandSide.Right, pattern, intensityScale);
  }

  // Begins a continuous "charging up" feedback voice for `hand`/`key` (e.g.
  // orbital-launch's per-zone charge) — resets that voice's own cadence so
  // the very first updateRisingCharge call after this fires immediately
  // rather than waiting out whatever interval a stale entry left behind.
  startRisingCharge(hand: string, key: string): void {
    this._chargeNextFire.set(`${hand}:${key}`, 0);
  }

  // Call every frame while charging, with t01 the 0-1 progress toward
  // commit — fires a light pulse on its own rate-limited cadence (not every
  // call), interval shrinking and intensity rising as t01 approaches 1 (see
  // CHARGE_MIN/MAX_INTERVAL_MS/INTENSITY). No-op if startRisingCharge was
  // never called for this hand/key (nothing to update).
  updateRisingCharge(hand: string, key: string, t01: number): void {
    const stateKey = `${hand}:${key}`;
    if (!this._chargeNextFire.has(stateKey)) return;
    const now = performance.now();
    if (now < (this._chargeNextFire.get(stateKey) ?? 0)) return;
    const clamped = Math.min(1, Math.max(0, t01));
    const interval = CHARGE_MAX_INTERVAL_MS + (CHARGE_MIN_INTERVAL_MS - CHARGE_MAX_INTERVAL_MS) * clamped;
    this._chargeNextFire.set(stateKey, now + interval);
    const intensity = CHARGE_MIN_INTENSITY + (CHARGE_MAX_INTENSITY - CHARGE_MIN_INTENSITY) * clamped;
    const gamepad = hand === HandSide.Right ? this.input.xr.gamepads.right : this.input.xr.gamepads.left;
    this._fire(gamepad, intensity, CHARGE_PULSE_DURATION_MS);
    if (DEBUG_HAPTICS) {
      console.debug('[haptics] hand=%s pattern=charge key=%s intensity=%s', hand, key, intensity.toFixed(2));
    }
  }

  // Ends a rising-charge voice — call the instant a zone's charge resets to
  // 0 (hand left, or switched zones) so a stale cadence doesn't linger.
  stopRisingCharge(hand: string, key: string): void {
    this._chargeNextFire.delete(`${hand}:${key}`);
  }

  // Best-guess handedness for a poke-button press — PokeInteractable/Pressed
  // carry no pointer/hand info (confirmed against @iwsdk/core's own
  // state-tags.d.ts), so this compares worldPos (the button's own world
  // position at fire time) against both grip spaces and picks the nearer,
  // same controller-space distance check comet-physics-system.ts/
  // comet-handoff-system.ts already rely on elsewhere. Returns null (no
  // pulse) if the nearer hand has no live gamepad at all — a hand-tracking
  // poke has no controller to buzz.
  resolvePokeHand(worldPos: Vector3): string | null {
    this.player.gripSpaces.left.getWorldPosition(this._scratchLeftGrip);
    this.player.gripSpaces.right.getWorldPosition(this._scratchRightGrip);
    const nearer =
      this._scratchLeftGrip.distanceToSquared(worldPos) <= this._scratchRightGrip.distanceToSquared(worldPos)
        ? HandSide.Left
        : HandSide.Right;
    const gamepad = nearer === HandSide.Right ? this.input.xr.gamepads.right : this.input.xr.gamepads.left;
    return gamepad ? nearer : null;
  }

  private _checkCooldown(hand: string, pattern: HapticPattern): boolean {
    const key = `${hand}:${pattern}`;
    const now = performance.now();
    if (now < (this._cooldowns.get(key) ?? 0)) return false;
    this._cooldowns.set(key, now + COOLDOWN_MS[pattern]);
    return true;
  }

  // Tries the standard vibrationActuator.playEffect path first, falls back
  // to the legacy hapticActuators[0].pulse path some older/runtime-specific
  // gamepads still expose, and bails silently (no gamepad, hand-tracking, no
  // actuator on either path) or swallows a throw/rejection either way —
  // haptics must never be allowed to break gameplay.
  private _fire(gamepad: StatefulGamepad | undefined, intensity: number, durationMs: number): void {
    try {
      const raw = gamepad?.gamepad;
      if (!raw) return;
      const actuator = raw.vibrationActuator;
      if (actuator) {
        actuator
          .playEffect('dual-rumble', {
            duration: durationMs,
            strongMagnitude: intensity,
            weakMagnitude: intensity * 0.6,
          })
          .catch(() => {});
        return;
      }
      const legacy = (raw as unknown as LegacyGamepad).hapticActuators?.[0];
      legacy?.pulse?.(intensity, durationMs)?.catch?.(() => {});
    } catch {
      // Never let a haptics failure break gameplay.
    }
  }
}
