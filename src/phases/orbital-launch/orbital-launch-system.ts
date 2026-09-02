import { AudioListener, createSystem, Vector3 } from '@iwsdk/core';
import { CometBody } from '../../comet/comet-body-component.js';
import { HandAnchor } from '../../comet/hand-anchor-component.js';
import { getGlobals } from '../../core/globals.js';
import {
  civilizationReflectionMessage,
  LAUNCH_BUILDUP_SEQUENCE,
  ORBIT_COMMIT_MESSAGE,
  UNKNOWN_COMMIT_MESSAGE,
} from '../../core/notification-copy.js';
import { FADE_SECONDS, NotificationHudSystem } from '../../core/notification-hud-system.js';
import { OrbitalLaunchSynth } from '../../vfx/audio/orbital-launch-synth.js';

// Direction from the player toward the big Fate Events planet — player
// origin is ~(0,·,0) and PLANET_CENTER is at x=0, so "toward the planet" is
// simply straight ahead (-Z), same convention FateEventSystem itself
// already bakes in via its own towardPlayer=(0,0,1) cap-scatter direction.
export const ORBIT_DIR: [number, number, number] = [0, 0, -1];
// ORBIT_DIR rotated -90° about Y (player's right) — arbitrary choice, flip
// the sign on both components to put it on the left instead.
export const UNKNOWN_DIR: [number, number, number] = [1, 0, 0];
// Zone-center distance from the player — reach-scale (comparable to
// PROXIMITY_RADIUS/NEAR_PLANET_RADIUS elsewhere), not "walk to the planet"
// (there's no locomotion; the planet's own near surface is ~0.6m away on a
// different bearing, well past ORBIT_DIR's reach).
export const ARROW_DISTANCE = 0.9;
export const ARROW_HEIGHT = 1.3;
export const ZONE_RADIUS = 0.35;
// Total on-screen time of one notify() call: fade-in + hold + fade-out,
// back to back with no gap between queued messages (see
// NotificationHudSystem._pump()/update()).
function notifyDuration(holdSeconds: number): number {
  return holdSeconds + FADE_SECONDS * 2;
}

// Half-angle of a generous "roughly looking toward it" cone — the detach
// shouldn't require the comet dead-center, just somewhere in front rather
// than behind/beside the player when it lets go.
const IN_VIEW_COS = Math.cos((55 * Math.PI) / 180);

// Floor on the speed used when snapping the detach direction to the
// camera's forward vector (see _detach) — a near-stationary swing should
// still visibly fly off rather than just sit there.
const MIN_DETACH_SPEED = 1.0;

export type LaunchChoice = 'orbit' | 'launch';
type LaunchState = 'choosing' | 'committed' | 'detached';

// Gameplay for the orbit-or-launch choice: two zones sit ARROW_DISTANCE
// from the player along ORBIT_DIR/UNKNOWN_DIR (see
// OrbitalLaunchVfxSystem for the arrows/labels marking them). Touching
// either commits to that choice; the comet keeps behaving completely
// normally (still hand-tracked, still springs/snaps/throws) while the
// player is coached to swing it faster — once the commit +
// LAUNCH_BUILDUP_SEQUENCE notification queue finishes playing out on the
// HUD (see notifyDuration/_commit) AND the comet is somewhere in front of
// the player (IN_VIEW_COS), detach fires — regardless of how fast the comet
// actually ends up moving. Whatever the comet's raw swing velocity happened
// to be at that instant is NOT trusted for direction (a mid-swing sample
// can easily point sideways or backward even while the comet itself sits in
// front of the player) — _detach() snaps the direction to the camera's
// actual forward vector at that moment, keeping only the swing's speed, so
// the comet reliably flies off into the area the player is looking at
// rather than wherever the swing physics happened to be pointing. HandAnchor
// removal at that point is the entire detach mechanism (see
// CometAutopilotSystem, an always-on system that picks up driving the comet
// the instant it drops HandAnchor and excludes/re-includes it purely via
// that component's presence — it's also what reads the comet's velocity at
// that instant to carry momentum smoothly into orbit/launch). Pure
// simulation here: no mesh/entity creation happens in this file (see
// OrbitalLaunchVfxSystem).
export class OrbitalLaunchSystem extends createSystem({
  bodies: { required: [CometBody, HandAnchor] },
}) {
  private _state: LaunchState = 'choosing';
  private _choice: LaunchChoice | null = null;
  private _committedElapsed = 0;
  private _detachAtSeconds = 0;
  // GameDirectorSystem.definePhase() calls stop() on every phase system
  // immediately at registration time (a normalization step, before
  // director.start() has ever run) — without this guard, that boot-time
  // call would hit the same "never chose" fallback below and strip
  // HandAnchor from the comet before the game even starts.
  private _hasPlayed = false;

  private _orbitZoneCenter!: Vector3;
  private _unknownZoneCenter!: Vector3;
  private _scratchPos!: Vector3;
  private _scratchVel!: Vector3;
  private _camPos!: Vector3;
  private _camFwd!: Vector3;
  private _toComet!: Vector3;

  private _audioListener!: AudioListener;
  private _synth!: OrbitalLaunchSynth;

  init(): void {
    this._audioListener = new AudioListener();
    this.player.head.add(this._audioListener);
    this._synth = new OrbitalLaunchSynth();
    this._synth.build(this._audioListener, this.scene);

    this._orbitZoneCenter = new Vector3(
      ORBIT_DIR[0] * ARROW_DISTANCE,
      ARROW_HEIGHT,
      ORBIT_DIR[2] * ARROW_DISTANCE,
    );
    this._unknownZoneCenter = new Vector3(
      UNKNOWN_DIR[0] * ARROW_DISTANCE,
      ARROW_HEIGHT,
      UNKNOWN_DIR[2] * ARROW_DISTANCE,
    );
    this._scratchPos = new Vector3();
    this._scratchVel = new Vector3();
    this._camPos = new Vector3();
    this._camFwd = new Vector3();
    this._toComet = new Vector3();
  }

  play(): void {
    super.play();
    this._hasPlayed = true;
    this._state = 'choosing';
    this._choice = null;
    this._committedElapsed = 0;

    // Retrospective "what you leave behind" beat, fired the instant Launch
    // begins (i.e. right as Fate Events ends, however it ended) — queues
    // alongside (order relative to NOTIFICATION_COPY[Phase.Launch]'s own
    // blurb isn't guaranteed, but NotificationHudSystem.notify() queues
    // rather than interrupts, so both always play back to back either way).
    const celestialSymbol = getGlobals(this.world).celestialSymbol.peek();
    const { text, holdSeconds } = civilizationReflectionMessage(celestialSymbol);
    this.world.getSystem(NotificationHudSystem)?.notify(text, holdSeconds);
  }

  // Fallback for "player never chooses" or "never swings fast enough": if
  // the phase's timeoutSeconds fires before a real detach happens, force an
  // orbit and detach anyway — otherwise Finale's "watch your comet find its
  // place among the stars" plays over a comet that's still just following
  // your hand. Guarded by _hasPlayed so definePhase()'s boot-time stop()
  // (see the field comment above) is a genuine no-op.
  stop(): void {
    super.stop();
    if (this._hasPlayed && this._state !== 'detached') {
      this._choice = this._choice ?? 'orbit';
      this._detach();
    }
  }

  update(delta: number): void {
    if (this._state === 'detached') return;

    if (this._state === 'committed') this._committedElapsed += delta;

    for (const entity of this.queries.bodies.entities) {
      const posView = entity.getVectorView(CometBody, 'position') as Float32Array;
      this._scratchPos.fromArray(posView);

      if (this._state === 'choosing') {
        if (this._scratchPos.distanceToSquared(this._orbitZoneCenter) <= ZONE_RADIUS * ZONE_RADIUS) {
          this._commit('orbit');
        } else if (this._scratchPos.distanceToSquared(this._unknownZoneCenter) <= ZONE_RADIUS * ZONE_RADIUS) {
          this._commit('launch');
        }
      } else if (this._state === 'committed') {
        if (this._committedElapsed >= this._detachAtSeconds && this._isCometInView(this._scratchPos)) {
          this._detach();
        }
      }
    }
  }

  // Roughly "is the comet somewhere in front of the player right now" —
  // a generous cone (IN_VIEW_COS), not a precise frustum check.
  private _isCometInView(cometPos: Vector3): boolean {
    this.camera.getWorldPosition(this._camPos);
    this.camera.getWorldDirection(this._camFwd);
    this._toComet.copy(cometPos).sub(this._camPos);
    if (this._toComet.lengthSq() < 1e-6) return true;
    this._toComet.normalize();
    return this._toComet.dot(this._camFwd) >= IN_VIEW_COS;
  }

  private _commit(choice: LaunchChoice): void {
    this._choice = choice;
    this._state = 'committed';
    this._committedElapsed = 0;
    const notifications = this.world.getSystem(NotificationHudSystem);
    const { text, holdSeconds } = choice === 'orbit' ? ORBIT_COMMIT_MESSAGE : UNKNOWN_COMMIT_MESSAGE;
    notifications?.notify(text, holdSeconds);
    // _scratchPos was just set to the comet's current position by update()'s
    // own per-entity loop, right before this was called.
    this._synth.playCommit(choice === 'orbit' ? 'orbit' : 'launch', this._scratchPos);
    let detachAt = notifyDuration(holdSeconds);
    for (const entry of LAUNCH_BUILDUP_SEQUENCE) {
      notifications?.notify(entry.text, entry.holdSeconds);
      detachAt += notifyDuration(entry.holdSeconds);
    }
    this._detachAtSeconds = detachAt;
  }

  private _detach(): void {
    this._state = 'detached';
    // Direction comes from where the player is actually looking right now,
    // not from the comet's raw swing velocity (see class comment) — this
    // runs both from the normal in-view detach above and from stop()'s
    // timeout fallback, so it's computed fresh here rather than reused from
    // _isCometInView.
    this.camera.getWorldDirection(this._camFwd);
    for (const entity of this.queries.bodies.entities) {
      const posView = entity.getVectorView(CometBody, 'position') as Float32Array;
      this._scratchPos.fromArray(posView);
      const velView = entity.getVectorView(CometBody, 'velocity') as Float32Array;
      this._scratchVel.fromArray(velView);
      const speed = Math.max(this._scratchVel.length(), MIN_DETACH_SPEED);
      this._scratchVel.copy(this._camFwd).multiplyScalar(speed);
      this._scratchVel.toArray(velView);
      entity.removeComponent(HandAnchor);
    }
    this._synth.playDetach(this._scratchPos);
  }

  // Read-only accessors for OrbitalLaunchVfxSystem/CometAutopilotSystem.
  getState(): LaunchState {
    return this._state;
  }
  getChoice(): LaunchChoice | null {
    return this._choice;
  }
  getOrbitZoneCenter(): Vector3 {
    return this._orbitZoneCenter;
  }
  getUnknownZoneCenter(): Vector3 {
    return this._unknownZoneCenter;
  }
}
