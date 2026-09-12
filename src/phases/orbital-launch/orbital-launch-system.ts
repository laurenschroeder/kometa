import { AudioListener, createSystem, Vector3 } from '@iwsdk/core';
import { CometBody } from '../../comet/comet-body-component.js';
import { HandAnchor } from '../../comet/hand-anchor-component.js';
import {
  FINAL_CHOICE_MESSAGE,
  LAUNCH_BUILDUP_SEQUENCE,
  launchIntroMessage,
  orbitCommitMessage,
  unknownCommitMessage,
} from '../../core/notification-copy.js';
import { getGlobals } from '../../core/globals.js';
import { FADE_SECONDS, NotificationHudSystem } from '../../core/notification-hud-system.js';
import { OrbitalLaunchSynth } from '../../vfx/audio/orbital-launch-synth.js';
import { PLANET_RADIUS as SEEDING_PLANET_RADIUS } from '../planet-seeding/planet-seeding-system.js';
import { PlanetSeedingVfxSystem } from '../planet-seeding/planet-seeding-vfx-system.js';

// 45 degrees front-left/front-right — used both as the fixed placeholder
// direction before this system has ever played (see init()) and as the
// basis play() rotates the player's ACTUAL forward direction around to
// place both zones — see _placeZones(). Once placed, both zones are fixed
// in world space for the rest of the phase; they do NOT keep re-centering
// as the player turns their head afterward (a deliberate simplification —
// "the choices move out in front of you once, based on where you're
// currently facing," not a constantly-chasing HUD element).
export const ORBIT_DIR: [number, number, number] = [-Math.SQRT1_2, 0, -Math.SQRT1_2];
export const UNKNOWN_DIR: [number, number, number] = [Math.SQRT1_2, 0, -Math.SQRT1_2];
const CHOICE_ANGLE_RAD = Math.PI / 4; // 45°
const UP_AXIS = new Vector3(0, 1, 0);

// Zone-center distance from the player — reach-scale (comparable to
// PROXIMITY_RADIUS/NEAR_PLANET_RADIUS elsewhere; there's no locomotion, so
// both zones must be within arm's reach). The orbit zone doubles as exactly
// where Leg C settles the receded/shrunk planet (see play()) — the unknown
// zone marks empty space on the mirrored bearing to the front-right.
export const ARROW_DISTANCE = 0.9;
// Fixed placeholder height for the pre-play() init() default only (see
// ORBIT_DIR's own comment) — play() replaces both zones with the player's
// actual live head position/height at that moment.
export const ARROW_HEIGHT = 1.3;
export const ZONE_RADIUS = 0.35;
// How long the comet must stay continuously inside a zone before it
// actually commits — long enough that just swinging through on the way to
// somewhere else can't accidentally lock in a choice; leaving a zone resets
// its own charge to 0 immediately (see _updateCharge), so this is a true
// "hold it there," not a cumulative dwell timer. Bumped from 1.0 — a full
// 3s hold gives the zone's own scale/color ramp (see OrbitalLaunchVfxSystem)
// and the rising charge tone (see OrbitalLaunchSynth.playChargeStart) room
// to actually read as "a decision being made" rather than a near-instant
// flicker.
export const CHARGE_SECONDS = 3.0;

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

// Gameplay for the orbit-or-launch choice: the instant this phase begins,
// both zones are placed 45° left/right of wherever the player is currently
// facing, ARROW_DISTANCE away (see play()/_placeZones) — then stay fixed in
// world space for the rest of the phase (see OrbitalLaunchVfxSystem for the
// arrows/labels marking them). Holding the comet continuously inside one
// for CHARGE_SECONDS commits to that choice (see _updateCharge) — a
// deliberate "charge up," not an instant touch, so a comet just swinging
// past on its way elsewhere can't accidentally lock in a choice; stepping
// back out resets that zone's charge to 0. Once committed, the comet keeps
// behaving completely normally (still hand-tracked, still springs/snaps/
// throws) while the player is coached to swing it faster — detach is
// gated on BOTH the commit message AND the full LAUNCH_BUILDUP_SEQUENCE
// notification queue finishing playing out on the HUD (see notifyDuration/
// _commit, which sums every one of those messages' own on-screen time into
// _detachAtSeconds) AND the comet being somewhere in front of the player
// (IN_VIEW_COS) — regardless of how fast the comet actually ends up moving.
// Whatever the comet's raw swing velocity happened to be at that instant is
// NOT trusted for direction (a mid-swing sample can easily point sideways
// or backward even while the comet itself sits in front of the player) —
// _detach() snaps the direction to the camera's actual forward vector at
// that moment, keeping only the swing's speed, so the comet reliably flies
// off into the area the player is looking at rather than wherever the swing
// physics happened to be pointing. HandAnchor removal at that point is the
// entire detach mechanism (see CometAutopilotSystem, an always-on system
// that picks up driving the comet the instant it drops HandAnchor and
// excludes/re-includes it purely via that component's presence — it's also
// what reads the comet's velocity at that instant to carry momentum
// smoothly into orbit/launch). Pure simulation here: no mesh/entity
// creation happens in this file (see OrbitalLaunchVfxSystem).
export class OrbitalLaunchSystem extends createSystem({
  bodies: { required: [CometBody, HandAnchor] },
}) {
  private _state: LaunchState = 'choosing';
  private _choice: LaunchChoice | null = null;
  private _committedElapsed = 0;
  private _detachAtSeconds = 0;
  // Seconds continuously spent inside each zone this "choosing" spell — see
  // CHARGE_SECONDS. Read by OrbitalLaunchVfxSystem (getOrbit/UnknownCharge01)
  // to fill in the zone as a visible charge-up cue.
  private _orbitCharge = 0;
  private _unknownCharge = 0;
  // Which zone the charge-rise tone is currently voicing, if any — see
  // _updateChargeAudio(). Tracked separately from _orbitCharge/
  // _unknownCharge (which reset to 0 the instant a hand leaves) so the
  // audio only restarts/stops on an actual zone-entry/exit transition,
  // not every frame charge is accumulating.
  private _chargingZone: LaunchChoice | null = null;
  // Seconds since play(). Compared against _zonesReadyAtSeconds (see play())
  // to withhold both choice zones — not just their interactivity but their
  // visibility (see OrbitalLaunchVfxSystem.isReadyToChoose()) — until the
  // "you can choose your fate" blurb has actually finished its own on-screen
  // time, so the spheres don't appear before the player's even been told
  // what they're for.
  private _elapsed = 0;
  private _zonesReadyAtSeconds = 0;
  // GameDirectorSystem.definePhase() calls stop() on every phase system
  // immediately at registration time (a normalization step, before
  // director.start() has ever run) — without this guard, that boot-time
  // call would hit the same "never chose" fallback below and strip
  // HandAnchor from the comet before the game even starts.
  private _hasPlayed = false;

  private _orbitZoneCenter!: Vector3;
  private _unknownZoneCenter!: Vector3;
  // Direction each zone sits along, from wherever the player was facing
  // when play() placed them — read by OrbitalLaunchVfxSystem to orient each
  // arrow. Fixed once play() sets it, same as the zone centers themselves.
  private _orbitDirLive!: Vector3;
  private _unknownDirLive!: Vector3;
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
    this._orbitDirLive = new Vector3(...ORBIT_DIR);
    this._unknownDirLive = new Vector3(...UNKNOWN_DIR);
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
    this._orbitCharge = 0;
    this._unknownCharge = 0;
    this._chargingZone = null;
    this._synth.stopCharge();
    this._elapsed = 0;

    // Places both zones 45° left/right of wherever the player is actually
    // facing RIGHT NOW, ARROW_DISTANCE away — a one-time placement (see the
    // class comment); they stay put in world space from here on, unlike
    // Seeding's continuously head-following planet.
    this._placeZones();

    // The choice zones stay hidden (see isReadyToChoose(), read by
    // OrbitalLaunchVfxSystem) until this phase's own opening blurb has
    // finished its on-screen time — otherwise a player already standing at
    // a zone could commit before they've even been told what these spheres
    // are for. Fired directly here (not via NOTIFICATION_COPY[Phase.Launch],
    // which is empty) since the line itself is now per-type — see
    // launchIntroMessage's own comment.
    const dominantType = getGlobals(this.world).dominantPebbleType.peek();
    const launchBlurb = launchIntroMessage(dominantType);
    const notifications = this.world.getSystem(NotificationHudSystem);
    // A short, generic heads-up plays first (queued via plain notify(), so
    // it plays strictly before the per-type line below), then the actual
    // per-type explanation — zones wait for BOTH to finish their on-screen
    // time, not just the second one.
    notifications?.notify(FINAL_CHOICE_MESSAGE.text, FINAL_CHOICE_MESSAGE.holdSeconds);
    notifications?.notify(launchBlurb.text, launchBlurb.holdSeconds);
    this._zonesReadyAtSeconds = notifyDuration(FINAL_CHOICE_MESSAGE.holdSeconds) + notifyDuration(launchBlurb.holdSeconds);

    // Leg C: the planet recedes/shrinks away to exactly where the orbit
    // choice zone was just placed (see ORBIT_DIR's own comment) — fired
    // here, at phase start, so the transition (see planet-launch-
    // transition.ts's RECEDE_DURATION) has finished well before the player
    // could plausibly swing up to speed and detach.
    this.world
      .getSystem(PlanetSeedingVfxSystem)
      ?.startLaunchRecedeTransition(this._orbitZoneCenter, SEEDING_PLANET_RADIUS);
  }

  // Fallback for "player never chooses" or "never swings fast enough": if
  // the phase's timeoutSeconds fires before a real detach happens, force an
  // orbit and detach anyway — otherwise Finale's "watch your comet find its
  // place among the stars" plays over a comet that's still just following
  // your hand. Guarded by _hasPlayed so definePhase()'s boot-time stop()
  // (see the field comment above) is a genuine no-op.
  stop(): void {
    super.stop();
    this._synth.stopCharge();
    if (this._hasPlayed && this._state !== 'detached') {
      this._choice = this._choice ?? 'orbit';
      this._detach();
    }
  }

  update(delta: number): void {
    if (this._state === 'detached') return;

    this._elapsed += delta;
    if (this._state === 'committed') this._committedElapsed += delta;

    // Withhold both choice zones until the planet has actually finished
    // receding/shrinking into its left-side spot (Leg C — see play()'s
    // startLaunchRecedeTransition() call) AND the "you can choose your
    // fate" notification has finished being up (see _zonesReadyAtSeconds) —
    // otherwise a player already standing at the orbit zone could commit
    // before either zone visibly reads as "in its place" and ready, or
    // before they've even been told what these spheres are for. Checked
    // once per frame rather than per-hand below.
    const readyToChoose = this._state !== 'choosing' || this.isReadyToChoose();

    let inOrbitZone = false;
    let inUnknownZone = false;

    for (const entity of this.queries.bodies.entities) {
      const posView = entity.getVectorView(CometBody, 'position') as Float32Array;
      this._scratchPos.fromArray(posView);

      if (this._state === 'choosing') {
        if (!readyToChoose) continue;
        if (this._scratchPos.distanceToSquared(this._orbitZoneCenter) <= ZONE_RADIUS * ZONE_RADIUS) {
          inOrbitZone = true;
        } else if (this._scratchPos.distanceToSquared(this._unknownZoneCenter) <= ZONE_RADIUS * ZONE_RADIUS) {
          inUnknownZone = true;
        }
      } else if (this._state === 'committed') {
        if (this._committedElapsed >= this._detachAtSeconds && this._isCometInView(this._scratchPos)) {
          this._detach();
        }
      }
    }

    if (this._state === 'choosing') this._updateCharge(delta, inOrbitZone, inUnknownZone);
  }

  // One-time zone placement — 45° left/right of the player's forward
  // direction at the moment this is called, ARROW_DISTANCE away, using the
  // player's actual head position/height (not a fixed world Y). See the
  // class comment for why this only runs once (from play()) rather than
  // continuously re-centering every frame.
  private _placeZones(): void {
    this.camera.getWorldPosition(this._camPos);
    this.camera.getWorldDirection(this._camFwd);

    this._orbitDirLive.copy(this._camFwd).applyAxisAngle(UP_AXIS, CHOICE_ANGLE_RAD);
    this._unknownDirLive.copy(this._camFwd).applyAxisAngle(UP_AXIS, -CHOICE_ANGLE_RAD);

    this._orbitZoneCenter.copy(this._camPos).addScaledVector(this._orbitDirLive, ARROW_DISTANCE);
    this._unknownZoneCenter.copy(this._camPos).addScaledVector(this._unknownDirLive, ARROW_DISTANCE);
  }

  // Charges whichever zone the comet is currently inside toward
  // CHARGE_SECONDS, committing once it fills — stepping outside a zone (or
  // crossing straight into the other one) resets its charge to 0 rather
  // than letting partial dwell time carry over, so a comet just passing
  // through on a wide swing can't accidentally lock in a choice.
  private _updateCharge(delta: number, inOrbitZone: boolean, inUnknownZone: boolean): void {
    if (inOrbitZone) {
      this._unknownCharge = 0;
      this._orbitCharge += delta;
      this._updateChargeAudio('orbit');
      if (this._orbitCharge >= CHARGE_SECONDS) this._commit('orbit');
    } else if (inUnknownZone) {
      this._orbitCharge = 0;
      this._unknownCharge += delta;
      this._updateChargeAudio('launch');
      if (this._unknownCharge >= CHARGE_SECONDS) this._commit('launch');
    } else {
      this._orbitCharge = 0;
      this._unknownCharge = 0;
      this._updateChargeAudio(null);
    }
  }

  // Starts/stops OrbitalLaunchSynth's rising charge tone in step with which
  // zone (if any) is currently being held — a hard leave (or a switch
  // straight to the other zone) resets the audio feedback exactly like the
  // charge value itself resets to 0, per the same "stepping out means
  // starting over" rule _updateCharge already enforces.
  private _updateChargeAudio(zone: LaunchChoice | null): void {
    if (zone === this._chargingZone) {
      if (zone === 'orbit') this._synth.updateCharge(this.getOrbitCharge01(), this._orbitZoneCenter);
      else if (zone === 'launch') this._synth.updateCharge(this.getUnknownCharge01(), this._unknownZoneCenter);
      return;
    }
    this._chargingZone = zone;
    if (zone === null) {
      this._synth.stopCharge();
    } else if (zone === 'orbit') {
      this._synth.playChargeStart('orbit', this._orbitZoneCenter);
    } else {
      this._synth.playChargeStart('launch', this._unknownZoneCenter);
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
    this._orbitCharge = 0;
    this._unknownCharge = 0;
    this._chargingZone = null;
    // Hands off to playCommit's own chord below rather than fading out on
    // its own — a hard cut reads as "arrived," not "interrupted," right as
    // the commit chord takes over.
    this._synth.stopCharge();
    const notifications = this.world.getSystem(NotificationHudSystem);
    const dominantType = getGlobals(this.world).dominantPebbleType.peek();
    const { text, holdSeconds } =
      choice === 'orbit' ? orbitCommitMessage(dominantType) : unknownCommitMessage(dominantType);
    notifications?.notify(text, holdSeconds);
    // _scratchPos was just set to the comet's current position by update()'s
    // own per-entity loop, right before this was called.
    this._synth.playCommit(choice === 'orbit' ? 'orbit' : 'launch', this._scratchPos);
    // Detach is gated on every one of these (see notifyDuration) finishing
    // its own on-screen time — the "faster/keep going" buildup must fully
    // play out before the comet is allowed to leave, not just the initial
    // commit message.
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
  // Both gates for showing/using the choice zones — the planet's Leg C
  // recede/shrink has settled, AND the "you can choose your fate" blurb has
  // finished its own on-screen time (see _zonesReadyAtSeconds/play()). Read
  // by OrbitalLaunchVfxSystem to withhold the zones' visibility, not just
  // their interactivity (handled internally via update()'s own readyToChoose).
  isReadyToChoose(): boolean {
    return (
      this._elapsed >= this._zonesReadyAtSeconds &&
      (this.world.getSystem(PlanetSeedingVfxSystem)?.isLaunchTransitionSettled() ?? true)
    );
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
  getOrbitDirLive(): Vector3 {
    return this._orbitDirLive;
  }
  getUnknownDirLive(): Vector3 {
    return this._unknownDirLive;
  }
  // 0-1 charge-up progress for each zone — see CHARGE_SECONDS/_updateCharge.
  getOrbitCharge01(): number {
    return Math.min(1, this._orbitCharge / CHARGE_SECONDS);
  }
  getUnknownCharge01(): number {
    return Math.min(1, this._unknownCharge / CHARGE_SECONDS);
  }
}
