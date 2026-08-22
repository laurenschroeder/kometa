import { createSystem, Entity, Vector3 } from '@iwsdk/core';
import { getGlobals } from '../core/globals.js';
import { Phase } from '../core/phase.js';
import { PLANET_CENTER, PLANET_RADIUS } from '../phases/fate-events/fate-event-system.js';
import { OrbitalLaunchSystem } from '../phases/orbital-launch/orbital-launch-system.js';
import { CometBody } from './comet-body-component.js';
import { HandAnchor, HandSide } from './hand-anchor-component.js';

// Fallback angular speed when the comet had little/no tangential velocity
// at detach (see _onDetach) — same slow, majestic default the orbit always
// used before velocity continuity existed.
const ORBIT_ANGULAR_SPEED = 0.35; // rad/s — ~18s per revolution at fallback speed
// Floor on the angular speed actually derived from the comet's tangential
// velocity — a detach with barely-above-threshold speed shouldn't crawl.
const MIN_ORBIT_ANGULAR_SPEED = 0.15;
// Below this tangential speed, treat the detach velocity as "not really
// swinging along an orbit" and fall back to a default ring instead of
// trying to derive a plane/speed from noise.
const TANGENTIAL_SPEED_EPSILON = 0.05;
const ORBIT_RADIUS_MARGIN = 0.3; // keeps the orbit outside the planet's own mesh

const LAUNCH_INITIAL_SPEED = 1.5; // floor — a real swing at detach can exceed this
const LAUNCH_ACCEL = 0.8; // m/s^2
const LAUNCH_MAX_SPEED = 6.0;
const LAUNCH_SPEED_EPSILON = 0.05;

type AutopilotMode = 'orbit' | 'launch';

// Drives the comet once it's detached from the player's hand — see
// OrbitalLaunchSystem, which removes HandAnchor from the comet entity once
// the player commits to a choice and has swung it up to speed. Always-on
// and never phase-gated: this must keep running through Finale (and
// beyond, until a fresh loop resets it), not freeze the instant
// Phase.Launch ends (GameDirectorSystem pauses phase-gated systems'
// update() the moment their phase isn't active — a phase-gated version of
// this system would stop driving the comet right when Finale's "watch your
// comet find its place among the stars" needs it most).
//
// The query itself is the detach signal: the comet enters this system's
// match set the instant HandAnchor is removed (the same instant it drops
// out of CometPhysicsSystem/CometHandoffSystem's queries, both of which
// require HandAnchor — see those files), and leaves it the instant
// HandAnchor is re-added on loop reset below. No custom tag/flag needed.
export class CometAutopilotSystem extends createSystem({
  comets: { required: [CometBody], excluded: [HandAnchor] },
}) {
  private _orbitalLaunch!: OrbitalLaunchSystem;
  private _entity: Entity | null = null;
  private _mode: AutopilotMode | null = null;

  // orbit state — captured once at detach (from the comet's actual
  // position + velocity, see _onDetach), then just advances _orbitAngle.
  // U/W span whichever orbital plane the swing's tangential velocity
  // implied ("any diameter of the planet that makes sense"), not a fixed
  // horizontal ring: U is the radial direction at detach, W the tangential
  // direction — pos = center + radius*(cos(angle)*U + sin(angle)*W), so at
  // angle=0 this exactly reproduces the detach position, and its derivative
  // exactly reproduces the detach velocity's direction/magnitude.
  private _orbitU!: Vector3;
  private _orbitW!: Vector3;
  private _orbitRadius = 0;
  private _orbitAngularSpeed = 0;
  private _orbitAngle = 0;

  // launch state — captured once at detach, then just ramps _launchSpeed
  // from wherever the comet's actual speed already was.
  private _launchDir!: Vector3;
  private _launchSpeed = 0;

  private _scratchPos!: Vector3;
  private _scratchVel!: Vector3;
  private _scratchRadial!: Vector3;
  private _scratchTangent!: Vector3;
  private _upAxis!: Vector3;

  init(): void {
    this._orbitalLaunch = this.world.getSystem(OrbitalLaunchSystem)!;
    this._orbitU = new Vector3();
    this._orbitW = new Vector3();
    this._launchDir = new Vector3();
    this._scratchPos = new Vector3();
    this._scratchVel = new Vector3();
    this._scratchRadial = new Vector3();
    this._scratchTangent = new Vector3();
    this._upAxis = new Vector3(0, 1, 0);

    this.queries.comets.subscribe(
      'qualify',
      (entity) => {
        this._entity = entity;
        this._onDetach(entity);
      },
      true,
    );
    this.queries.comets.subscribe('disqualify', (entity) => {
      if (this._entity === entity) {
        this._entity = null;
        this._mode = null;
      }
    });

    // Re-attaches the comet to hand control the instant we enter any phase
    // that isn't Finale. This isn't just the natural end-of-loop Finale ->
    // Stardust boundary — the dev/debug menu can jump directly to ANY
    // phase in ANY order (see PhaseMenuSystem), and every phase except
    // Finale needs a hand-tracked comet to function (even Launch itself:
    // its own bodies query requires HandAnchor just to detect the player
    // touching a choice zone). Without this being phase-agnostic, jumping
    // away from Launch — or back into it — after a previous detach left
    // the comet permanently hand-less in whatever phase you landed on.
    //
    // Re-adding HandAnchor alone isn't sufficient — three CometBody fields
    // survive untouched across a detach/re-attach and would otherwise
    // corrupt CometPhysicsSystem's resume: `initialized` must go back to
    // false so its hand-snap-on-first-frame branch fires again instead of
    // spring-simulating from wherever autopilot left the comet; `wasSnapped`
    // must go back to false or the very next frame takes the "release"
    // branch and multiplies leftover orbit/launch velocity by throwMult
    // before the spring even engages; `velocity` must be zeroed or a
    // launch's several-m/s outward velocity gets additively integrated on
    // top of the fresh spring physics and only decays at
    // exp(-damping*dt)/frame — a visible off-course drift.
    this.cleanupFuncs.push(
      getGlobals(this.world).gamePhase.subscribe((phase) => {
        if (phase === Phase.Finale || !this._entity) return;
        const entity = this._entity;
        entity.addComponent(HandAnchor, { hand: HandSide.Right, palmOffsetZ: 0.08 });
        entity.setValue(CometBody, 'initialized', false);
        entity.setValue(CometBody, 'wasSnapped', false);
        const velView = entity.getVectorView(CometBody, 'velocity') as Float32Array;
        velView[0] = 0;
        velView[1] = 0;
        velView[2] = 0;
      }),
    );
  }

  private _onDetach(entity: Entity): void {
    const posView = entity.getVectorView(CometBody, 'position') as Float32Array;
    const velView = entity.getVectorView(CometBody, 'velocity') as Float32Array;
    this._scratchPos.fromArray(posView);
    this._scratchVel.fromArray(velView);
    this._mode = this._orbitalLaunch.getChoice() === 'launch' ? 'launch' : 'orbit';

    if (this._mode === 'orbit') {
      this._scratchRadial.set(
        this._scratchPos.x - PLANET_CENTER[0],
        this._scratchPos.y - PLANET_CENTER[1],
        this._scratchPos.z - PLANET_CENTER[2],
      );
      this._orbitRadius = Math.max(this._scratchRadial.length(), PLANET_RADIUS + ORBIT_RADIUS_MARGIN);
      this._orbitU.copy(this._scratchRadial).normalize();

      // Tangential component of the detach velocity: the part perpendicular
      // to the radial direction — this is what "smoothly connects" into a
      // circular orbit (any purely radial component can't be honored by a
      // fixed-radius circle, so it's dropped rather than distorting the
      // orbit).
      const radialSpeed = this._scratchVel.dot(this._orbitU);
      this._scratchTangent.copy(this._scratchVel).addScaledVector(this._orbitU, -radialSpeed);
      const tangentialSpeed = this._scratchTangent.length();

      if (tangentialSpeed >= TANGENTIAL_SPEED_EPSILON) {
        this._orbitW.copy(this._scratchTangent).normalize();
        this._orbitAngularSpeed = Math.max(tangentialSpeed / this._orbitRadius, MIN_ORBIT_ANGULAR_SPEED);
      } else {
        // Barely-there swing at detach — fall back to a default horizontal
        // ring (same behavior the orbit always had before velocity
        // continuity existed) rather than deriving a plane from noise.
        this._orbitW.crossVectors(this._upAxis, this._orbitU);
        if (this._orbitW.lengthSq() < 1e-6) this._orbitW.set(1, 0, 0);
        else this._orbitW.normalize();
        this._orbitAngularSpeed = ORBIT_ANGULAR_SPEED;
      }
      this._orbitAngle = 0;
    } else {
      const speed = this._scratchVel.length();
      if (speed >= LAUNCH_SPEED_EPSILON) {
        this._launchDir.copy(this._scratchVel).normalize();
        this._launchSpeed = Math.max(speed, LAUNCH_INITIAL_SPEED);
      } else {
        // No real swing at detach — fall back to straight outward from the
        // planet (same default the launch always had before).
        this._launchDir
          .set(
            this._scratchPos.x - PLANET_CENTER[0],
            this._scratchPos.y - PLANET_CENTER[1],
            this._scratchPos.z - PLANET_CENTER[2],
          )
          .normalize();
        this._launchSpeed = LAUNCH_INITIAL_SPEED;
      }
    }
  }

  update(delta: number): void {
    if (!this._entity || !this._mode) return;
    const posView = this._entity.getVectorView(CometBody, 'position') as Float32Array;
    const velView = this._entity.getVectorView(CometBody, 'velocity') as Float32Array;

    if (this._mode === 'orbit') {
      this._orbitAngle += this._orbitAngularSpeed * delta;
      const cos = Math.cos(this._orbitAngle);
      const sin = Math.sin(this._orbitAngle);
      const u = this._orbitU;
      const w = this._orbitW;
      const r = this._orbitRadius;
      posView[0] = PLANET_CENTER[0] + r * (cos * u.x + sin * w.x);
      posView[1] = PLANET_CENTER[1] + r * (cos * u.y + sin * w.y);
      posView[2] = PLANET_CENTER[2] + r * (cos * u.z + sin * w.z);
      const tangentialMag = r * this._orbitAngularSpeed;
      velView[0] = tangentialMag * (-sin * u.x + cos * w.x);
      velView[1] = tangentialMag * (-sin * u.y + cos * w.y);
      velView[2] = tangentialMag * (-sin * u.z + cos * w.z);
    } else {
      this._launchSpeed = Math.min(this._launchSpeed + LAUNCH_ACCEL * delta, LAUNCH_MAX_SPEED);
      posView[0] += this._launchDir.x * this._launchSpeed * delta;
      posView[1] += this._launchDir.y * this._launchSpeed * delta;
      posView[2] += this._launchDir.z * this._launchSpeed * delta;
      velView[0] = this._launchDir.x * this._launchSpeed;
      velView[1] = this._launchDir.y * this._launchSpeed;
      velView[2] = this._launchDir.z * this._launchSpeed;
    }
  }
}
